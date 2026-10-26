#!/usr/bin/env node
// Déploie l'API Pixcar sur sa pile CloudFormation dans l'ordre qui ne casse rien (docs/exploitation.md, « Déploiement automatique de
// l'API »). Lancé par .github/workflows/deploy-api.yml ; marche aussi à la main avec des identifiants AWS.
//   node scripts/deploy-api.mjs package [--out dist-lambda]
//       construit le paquet deux fois (scripts/build-lambda.mjs), refuse si les deux archives diffèrent, garde la première dans --out ;
//       écrit file=, hash= et md5= dans $GITHUB_OUTPUT quand il existe.
//   node scripts/deploy-api.mjs deploy --zip <archive> [--stack pixcar] [--region eu-north-1] [--summary <fichier>] [--no-smoke]
//       1. dépose l'archive dans le bucket du code (paramètre CodeBucket de la pile) si elle n'y est pas ;
//       2. la fonction d'opérations seule passe au nouveau code (OpsCodeKey), puis {"op":"migrate"} et {"op":"selfcheck"} : l'API publique
//          n'a pas encore bougé ; un auto-contrôle en échec rend aux opérations leur code d'avant et arrête tout ;
//       3. l'API passe au nouveau code (CodeKey), puis scripts/smoke-api.mjs sur son adresse (sortie ApiUrl) ; en échec, les deux
//          fonctions reprennent leur code d'avant (les migrations restent : elles n'ajoutent que ce que l'ancien code ignore).
//       Chaque changement passe par un jeu de modifications relu avant d'être exécuté : modèle actuel, seulement la fonction attendue,
//       modifiée sans remplacement ; sinon il est supprimé sans avoir rien changé.
// AWS par la ligne de commande « aws » et les identifiants de l'environnement (dans GitHub Actions : le rôle d'infra/pixcar-deploy.yaml).
// Code de sortie : 0 déployé ou déjà en service, 1 échec (retour arrière fait quand il y avait de quoi), 2 ligne de commande incorrecte.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = /^pixcar-lambda-[0-9a-f]{16}\.zip$/;
// états d'une pile sur lesquels on peut lancer une mise à jour
const STABLE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]);
const NOTHING_TO_DO = /didn't contain changes|No updates are to be performed/i;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (buf) => createHash("md5").update(buf).digest("hex");

// « aws … --region … --output json » ; l'erreur reprend ce que la ligne de commande a écrit
export function awsCli({ region, run = runCommand }) {
  return async (args) => {
    const out = await run("aws", [...args, "--region", region, "--output", "json"]);
    return out.trim() ? JSON.parse(out) : {};
  };
}
function runCommand(cmd, args) {
  return new Promise((ok, ko) =>
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) => (e ? ko(new Error(`${cmd} ${args.slice(0, 2).join(" ")} : ${String(stderr || e.message).trim()}`)) : ok(stdout))),
  );
}

// la fonction d'opérations, appelée comme dans la console (réponse lue dans un fichier, délai de lecture > ses 300 s)
export function opsInvoker({ aws, functionName }) {
  return async (payload) => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-ops-"));
    const out = join(dir, "out.json");
    try {
      const meta = await aws(["lambda", "invoke", "--function-name", functionName, "--cli-binary-format", "raw-in-base64-out", "--cli-read-timeout", "330", "--payload", JSON.stringify(payload), out]);
      const body = JSON.parse(await readFile(out, "utf8"));
      if (meta.FunctionError) throw new Error(`la fonction d'opérations a planté (${meta.FunctionError}) : ${body.errorMessage || JSON.stringify(body)}`);
      return body;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function describeStack(aws, stack) {
  const { Stacks } = await aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  const s = Stacks && Stacks[0];
  if (!s) throw new Error(`pile ${stack} introuvable`);
  return {
    status: s.StackStatus,
    params: Object.fromEntries((s.Parameters || []).map((p) => [p.ParameterKey, p.ParameterValue === undefined ? "" : p.ParameterValue])),
    outputs: Object.fromEntries((s.Outputs || []).map((o) => [o.OutputKey, o.OutputValue])),
  };
}

// dépose l'archive si elle n'y est pas ; même nom = même contenu (le nom vient de l'empreinte), sauf si la taille dit le contraire
async function ensurePackage({ aws, bucket, key, zip }) {
  const body = await readFile(zip);
  let remote = null;
  try {
    remote = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key]);
  } catch (e) {
    if (!/\(404\)|Not Found|NoSuchKey/i.test(e.message)) throw e;
  }
  if (remote) {
    if (Number(remote.ContentLength) !== body.length) throw new Error(`${key} est déjà dans ${bucket} avec une autre taille (${remote.ContentLength} octets, ${body.length} ici) : rien n'est déployé`);
    return "déjà dans le bucket";
  }
  const put = await aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", zip]);
  const etag = String(put.ETag || "").replace(/"/g, "");
  if (etag && etag !== md5(body)) throw new Error(`dépôt de ${key} : empreinte MD5 reçue par S3 (${etag}) différente de celle de l'archive (${md5(body)})`);
  return "déposé";
}

function changeText(c) {
  return `${c.Action} ${c.LogicalResourceId} (${c.ResourceType}${c.Replacement && c.Replacement !== "False" ? `, remplacement : ${c.Replacement}` : ""})`;
}

// Change des paramètres de la pile, modèle actuel gardé ; n'exécute le jeu de modifications que s'il ne touche que les fonctions attendues.
export async function changeParameters({ aws, stack, sleep = realSleep, log = () => {}, now = Date.now }, current, changes, expected, label) {
  for (const k of Object.keys(changes)) if (!Object.hasOwn(current, k)) throw new Error(`la pile ${stack} n'a pas de paramètre ${k} : mettre d'abord à jour son modèle (docs/exploitation.md)`);
  const parameters = Object.keys(current).map((k) => (Object.hasOwn(changes, k) ? { ParameterKey: k, ParameterValue: changes[k] } : { ParameterKey: k, UsePreviousValue: true }));
  const name = `deploy-${label}-${now()}`;
  const { Id } = await aws(["cloudformation", "create-change-set", "--stack-name", stack, "--change-set-name", name, "--change-set-type", "UPDATE", "--use-previous-template", "--capabilities", "CAPABILITY_IAM", "--parameters", JSON.stringify(parameters)]);
  const drop = () => aws(["cloudformation", "delete-change-set", "--change-set-name", Id]).catch(() => {});
  let cs;
  for (let i = 0; ; i++) {
    cs = await aws(["cloudformation", "describe-change-set", "--change-set-name", Id]);
    if (cs.Status === "CREATE_COMPLETE" || cs.Status === "FAILED") break;
    if (i >= 100) {
      await drop();
      throw new Error(`jeu de modifications ${name} toujours en préparation (${cs.Status}) : abandonné`);
    }
    await sleep(3000);
  }
  if (cs.Status === "FAILED") {
    await drop();
    if (NOTHING_TO_DO.test(cs.StatusReason || "")) return { changed: false, resources: [] };
    throw new Error(`jeu de modifications refusé par CloudFormation : ${cs.StatusReason}`);
  }
  const list = (cs.Changes || []).map((c) => c.ResourceChange || {});
  const ok = (c) => c.Action === "Modify" && expected.includes(c.LogicalResourceId) && c.ResourceType === "AWS::Lambda::Function" && c.Replacement === "False";
  if (!list.length || !list.every(ok)) {
    await drop();
    throw new Error(`jeu de modifications inattendu, supprimé sans être exécuté (attendu : ${expected.join(", ")} modifiée sans remplacement) : ${list.map(changeText).join(" ; ") || "aucun changement"}`);
  }
  log(`  jeu de modifications ${name} : ${list.map(changeText).join(" ; ")}`);
  const since = now();
  await aws(["cloudformation", "execute-change-set", "--change-set-name", Id]);
  let st;
  for (let i = 0; ; i++) {
    st = await describeStack(aws, stack);
    if (!/_IN_PROGRESS$/.test(st.status)) break;
    if (i >= 360) throw new Error(`pile ${stack} toujours en cours de mise à jour (${st.status}) après 30 minutes`);
    await sleep(5000);
  }
  if (st.status !== "UPDATE_COMPLETE") {
    const { StackEvents = [] } = await aws(["cloudformation", "describe-stack-events", "--stack-name", stack]).catch(() => ({}));
    const why = StackEvents.filter((e) => /FAILED$/.test(e.ResourceStatus || "") && e.ResourceStatusReason && Date.parse(e.Timestamp) >= since - 60_000)
      .slice(0, 3)
      .map((e) => `${e.LogicalResourceId} : ${e.ResourceStatusReason}`);
    throw new Error(`mise à jour de la pile en échec (${st.status})${why.length ? ` — ${why.join(" ; ")}` : ""}`);
  }
  return { changed: true, resources: list.map((c) => c.LogicalResourceId), params: st.params, outputs: st.outputs };
}

// Le déploiement entier. aws, ops et smoke sont injectables (tests) ; renvoie le compte rendu, ou lève une erreur qui le porte (e.report).
export async function deploy({ zip, stack = "pixcar", aws, ops, smoke, sleep = realSleep, log = () => {}, now = Date.now, runSmoke = true }) {
  const key = basename(zip);
  if (!PACKAGE.test(key)) throw new Error(`« ${key} » : une archive de scripts/build-lambda.mjs est attendue (pixcar-lambda-<16 chiffres hexadécimaux>.zip)`);
  const report = { key, stack, steps: [], rolledBack: [] };
  const step = (text) => {
    report.steps.push(text);
    log(text);
  };
  const ctx = { aws, stack, sleep, log, now };
  try {
    const st = await describeStack(aws, stack);
    if (!STABLE.has(st.status)) throw new Error(`pile ${stack} dans l'état ${st.status} : rien n'est lancé tant qu'elle n'est pas stable`);
    if (!Object.hasOwn(st.params, "OpsCodeKey")) throw new Error(`la pile ${stack} n'a pas encore le paramètre OpsCodeKey : mettre une fois à jour son modèle (infra/pixcar-api.yaml, docs/exploitation.md)`);
    for (const out of ["OpsFunctionName", "ApiUrl"]) if (!st.outputs[out]) throw new Error(`sortie ${out} absente de la pile ${stack}`);
    const before = { api: st.params.CodeKey, opsParam: st.params.OpsCodeKey };
    const opsBefore = before.opsParam || before.api;
    report.before = { api: before.api, ops: opsBefore };
    if (before.api === key && opsBefore === key) {
      report.status = "unchanged";
      step(`Déjà en service : ${key} (API et opérations). Rien à faire.`);
      return report;
    }
    const callOps = ops || opsInvoker({ aws, functionName: st.outputs.OpsFunctionName });
    let params = st.params;

    step(`Paquet ${key} : ${await ensurePackage({ aws, bucket: st.params.CodeBucket, key, zip })} (${st.params.CodeBucket}).`);

    const revertOps = async () => {
      if (params.OpsCodeKey === before.opsParam) return;
      const r = await changeParameters(ctx, params, { OpsCodeKey: before.opsParam }, ["OpsFunction"], "revert-ops");
      params = r.params || params;
      report.rolledBack.push(`opérations : ${opsBefore}`);
    };
    const revertApi = async () => {
      if (params.CodeKey === before.api) return;
      const r = await changeParameters(ctx, params, { CodeKey: before.api }, ["ApiFunction"], "revert-api");
      params = r.params || params;
      report.rolledBack.push(`API : ${before.api}`);
    };

    // 1. opérations d'abord : migration et auto-contrôle avec le nouveau code, l'API publique encore sur l'ancien
    if (opsBefore !== key) {
      const r = await changeParameters(ctx, params, { OpsCodeKey: key }, ["OpsFunction"], "ops");
      params = r.params || { ...params, OpsCodeKey: key };
      step(`Fonction d'opérations : ${opsBefore} → ${key}.`);
    }
    try {
      const m = await callOps({ op: "migrate" });
      if (!m || m.ok !== true) throw new Error(`migration en échec : ${(m && m.error) || JSON.stringify(m)}`);
      report.migrations = m.applied || [];
      step(`Migration : ${report.migrations.length ? report.migrations.join(", ") : "rien à appliquer"}.`);
      const c = await callOps({ op: "selfcheck" });
      const failed = ((c && c.checks) || []).filter((x) => !x.ok).map((x) => `${x.name} (${x.detail})`);
      report.selfcheck = c ? { passed: c.passed, total: c.total } : null;
      if (!c || c.ok !== true || c.passed !== c.total) throw new Error(`auto-contrôle en échec (${c ? `${c.passed}/${c.total}` : "pas de réponse"})${failed.length ? ` : ${failed.slice(0, 3).join(" ; ")}` : c && c.error ? ` : ${c.error}` : ""}`);
      step(`Auto-contrôle sur la base : ${c.passed}/${c.total}.`);
    } catch (e) {
      await revertOps();
      throw e;
    }

    // 2. l'API, puis l'essai de bout en bout sur son adresse
    if (before.api !== key) {
      const r = await changeParameters(ctx, params, { CodeKey: key }, ["ApiFunction"], "api");
      params = r.params || { ...params, CodeKey: key };
      step(`API : ${before.api} → ${key}.`);
    }
    if (runSmoke) {
      const s = await smoke(st.outputs.ApiUrl);
      const bad = ((s && s.steps) || []).filter((x) => !x.ok).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`);
      report.smoke = s ? { ok: !!s.ok, passed: (s.steps || []).filter((x) => x.ok).length, total: (s.steps || []).length } : null;
      if (!s || !s.ok) {
        await revertApi();
        await revertOps();
        throw new Error(`essai de bout en bout en échec sur ${st.outputs.ApiUrl}${bad.length ? ` : ${bad.slice(0, 3).join(" ; ")}` : ""}`);
      }
      step(`Essai de bout en bout (${st.outputs.ApiUrl}) : ${report.smoke.passed}/${report.smoke.total}.`);
    }
    report.status = "deployed";
    return report;
  } catch (e) {
    report.status = "failed";
    report.error = e.message;
    e.report = report;
    throw e;
  }
}

export function summaryMarkdown(r) {
  const lines = [`## Déploiement de l'API (${r.stack})`, ""];
  const head = { deployed: "✅ Déployé", unchanged: "✅ Déjà en service", failed: "❌ Échec" }[r.status] || r.status;
  lines.push(`**${head}** — paquet \`${r.key}\``, "");
  for (const s of r.steps) lines.push(`- ${s}`);
  if (r.error) lines.push(`- **Erreur** : ${r.error}`);
  if (r.rolledBack && r.rolledBack.length) lines.push(`- Retour arrière fait : ${r.rolledBack.join(" ; ")}.`);
  if (r.before && r.status !== "unchanged") lines.push("", `Avant ce déploiement : API \`${r.before.api}\`, opérations \`${r.before.ops}\`. Pour y revenir à la main : paramètres CodeKey et OpsCodeKey de la pile (docs/exploitation.md).`);
  return lines.join("\n") + "\n";
}

// construit deux fois et compare : un paquet qui ne se reconstruit pas à l'identique n'est pas déployé
export async function packageTwice({ out, build }) {
  const tmp = await mkdtemp(join(tmpdir(), "pixcar-pkg-"));
  try {
    const a = await build({ out: join(tmp, "a") });
    const b = await build({ out: join(tmp, "b") });
    const [x, y] = [await readFile(a.zip), await readFile(b.zip)];
    if (a.file !== b.file || !x.equals(y)) throw new Error(`deux constructions différentes (${a.file}, ${b.file}) : paquet non reproductible, rien n'est déployé`);
    await mkdir(out, { recursive: true });
    await copyFile(a.zip, join(out, a.file));
    return { file: a.file, hash: a.hash, bytes: x.length, md5: md5(x), zip: join(out, a.file) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, out: "dist-lambda", zip: "", stack: "pixcar", region: "eu-north-1", summary: "", smoke: true, bad: "" };
  if (cmd !== "package" && cmd !== "deploy") o.bad = "commande attendue : package ou deploy";
  const value = (i, name) => (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : ((o.bad ||= `${name} attend une valeur`), ""));
  for (let i = 0; i < rest.length && !o.bad; i++) {
    const a = rest[i];
    if (a === "--out") o.out = value(i++, a);
    else if (a === "--zip") o.zip = value(i++, a);
    else if (a === "--stack") o.stack = value(i++, a);
    else if (a === "--region") o.region = value(i++, a);
    else if (a === "--summary") o.summary = value(i++, a);
    else if (a === "--no-smoke") o.smoke = false;
    else o.bad = `option inconnue : ${a}`;
  }
  if (!o.bad && cmd === "deploy" && !o.zip) o.bad = "deploy demande --zip <archive>";
  if (!o.bad && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) o.bad = `région inattendue : ${o.region}`;
  return o;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.bad) {
    console.error(`${o.bad}\nusage : node scripts/deploy-api.mjs package [--out dist-lambda]\n        node scripts/deploy-api.mjs deploy --zip <archive> [--stack pixcar] [--region eu-north-1] [--summary <fichier>] [--no-smoke]`);
    process.exit(2);
  }
  if (o.cmd === "package") {
    const { buildLambda } = await import("./build-lambda.mjs");
    const p = await packageTwice({ out: resolve(o.out), build: (opts) => buildLambda(opts) });
    console.log(`${p.file}  ${(p.bytes / 1024).toFixed(0)} Ko  MD5 ${p.md5}  (deux constructions identiques)\n→ ${p.zip}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `file=${p.file}\nhash=${p.hash}\nmd5=${p.md5}\n`);
  } else {
    const { smoke } = await import("./smoke-api.mjs");
    const aws = awsCli({ region: o.region });
    let report;
    try {
      report = await deploy({ zip: resolve(o.zip), stack: o.stack, aws, smoke: (base) => smoke(base, { log: (l) => console.log(`    ${l}`) }), log: console.log, runSmoke: o.smoke });
    } catch (e) {
      report = e.report || { key: basename(o.zip), stack: o.stack, steps: [], status: "failed", error: e.message };
      console.error(`ÉCHEC : ${e.message}`);
    }
    if (o.summary) await appendFile(o.summary, summaryMarkdown(report));
    process.exit(report.status === "failed" ? 1 : 0);
  }
}
