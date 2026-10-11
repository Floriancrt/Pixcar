#!/usr/bin/env node
// Charge dans la base de l'API les contacts PRIVÉS des garages (fichier de scripts/garages/build.py --contacts-out), par lots, via la fonction
// d'opérations (op « import-contacts »), puis retire ceux que ce chargement complet n'a pas réécrits (op « prune-contacts »).
//
//   node scripts/pro/push-contacts.mjs private/contacts.jsonl [--function pixcar-ops] [--profile pixcar] [--region eu-north-1]
//                                      [--batch 500] [--no-prune] [--dry-run]
//
// Utilise la CLI AWS du poste (aws lambda invoke) : aucune donnée de contact n'est écrite ailleurs que dans des fichiers temporaires
// lisibles par le seul utilisateur, effacés aussitôt ; rien n'est affiché d'autre que des nombres.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function readContacts(file) {
  const text = await readFile(file, "utf8");
  const rows = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${file}, ligne ${i + 1} : JSON illisible`);
    }
  });
  return rows;
}

// invoke(payload) → réponse de la fonction d'opérations ({ ok, … }). Renvoie le bilan ; lève une erreur au premier lot refusé (rien n'est
// retiré dans ce cas : les lignes déjà écrites restent, le chargement suivant les réécrira).
export async function pushContacts({ rows, invoke, importId, batch = 500, prune = true, log = () => {} }) {
  if (!rows.length) throw new Error("aucun contact à charger");
  let written = 0, rejected = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const out = await invoke({ op: "import-contacts", importId, rows: rows.slice(i, i + batch) });
    if (!out || !out.ok) throw new Error(`lot ${i / batch + 1} refusé : ${(out && out.error) || "réponse vide"}`);
    written += out.written;
    rejected += out.rejected;
    log(`lot ${i / batch + 1}/${Math.ceil(rows.length / batch)} : ${out.written} écrits, ${out.rejected} écartés`);
  }
  let removed = null;
  if (prune) {
    const out = await invoke({ op: "prune-contacts", importId });
    if (!out || !out.ok) throw new Error(`retrait des anciens contacts refusé : ${(out && out.error) || "réponse vide"}`);
    removed = out.removed;
  }
  return { importId, written, rejected, removed };
}

function awsInvoker({ fn, profile, region }) {
  return async (payload) => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-contacts-"));
    try {
      const inFile = join(dir, "in.json");
      const outFile = join(dir, "out.json");
      await writeFile(inFile, JSON.stringify(payload), { mode: 0o600 });
      const args = ["lambda", "invoke", "--function-name", fn, "--cli-binary-format", "raw-in-base64-out", "--cli-read-timeout", "310", "--payload", `fileb://${inFile}`, outFile];
      if (profile) args.push("--profile", profile);
      if (region) args.push("--region", region);
      await run("aws", args, { maxBuffer: 1 << 20 });
      return JSON.parse(await readFile(outFile, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--no-prune", "--dry-run"].includes(args[i - 1])));
  if (!file) {
    console.error("usage : node scripts/pro/push-contacts.mjs <contacts.jsonl> [--function pixcar-ops] [--profile p] [--region r] [--batch 500] [--no-prune] [--dry-run]");
    process.exit(2);
  }
  const rows = await readContacts(file);
  const importId = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  if (args.includes("--dry-run")) {
    console.log(`${rows.length} garages, ${rows.filter((r) => r.emails && r.emails.length).length} avec e-mail, ${rows.filter((r) => (r.phones || []).some((p) => /^\+33[67]/.test(p))).length} avec portable, ${rows.filter((r) => r.web).length} avec site ; rien n'est envoyé.`);
    process.exit(0);
  }
  const invoke = awsInvoker({ fn: opt("--function", "pixcar-ops"), profile: opt("--profile", process.env.AWS_PROFILE || ""), region: opt("--region", process.env.AWS_REGION || "eu-north-1") });
  try {
    const out = await pushContacts({ rows, invoke, importId, batch: Number(opt("--batch", 500)), prune: !args.includes("--no-prune"), log: (m) => console.log(m) });
    console.log(`chargement ${out.importId} : ${out.written} écrits, ${out.rejected} écartés${out.removed === null ? "" : `, ${out.removed} anciens retirés`}.`);
  } catch (e) {
    console.error("échec : " + e.message);
    process.exit(1);
  }
}
