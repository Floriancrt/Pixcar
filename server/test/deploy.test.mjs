// Déploiement automatique de l'API (docs/exploitation.md) : le rôle que GitHub prend (infra/pixcar-deploy.yaml), le workflow
// (.github/workflows/deploy-api.yml) et le script qui déploie (scripts/deploy-api.mjs), rejoué contre une fausse AWS : ordre des
// étapes, jeux de modifications relus avant exécution, retours arrière. Rien ne parle au vrai AWS ici.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse } from "yaml";
import { awsCli, changeParameters, deploy, opsInvoker, packageTwice, parseArgs, summaryMarkdown } from "../../scripts/deploy-api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FUNCTIONS = ["Sub", "If", "Equals", "Not", "And", "Or", "Join", "Select", "Split"];
const customTags = [
  { tag: "!Ref", resolve: (s) => ({ Ref: s }) },
  { tag: "!Condition", resolve: (s) => ({ Condition: s }) },
  { tag: "!GetAtt", resolve: (s) => ({ "Fn::GetAtt": s.split(/\.(.*)/s).slice(0, 2) }) },
  ...FUNCTIONS.flatMap((f) => [
    { tag: `!${f}`, resolve: (s) => ({ [`Fn::${f}`]: s }) },
    { tag: `!${f}`, collection: "seq", resolve: (q) => ({ [`Fn::${f}`]: q.toJSON() }) },
  ]),
];
const yaml = (file) => parse(readFileSync(join(ROOT, file), "utf8"), { customTags });
const sub = (node, values) => String(node["Fn::Sub"]).replace(/\$\{([\w:]+)\}/g, (m, k) => (k in values ? values[k] : m));

describe("the role GitHub takes (infra/pixcar-deploy.yaml)", () => {
  const t = yaml("infra/pixcar-deploy.yaml");
  const api = yaml("infra/pixcar-api.yaml");
  const role = t.Resources.DeployRole.Properties;
  const statements = role.Policies.flatMap((p) => p.PolicyDocument.Statement);
  const defaults = Object.fromEntries(Object.entries(t.Parameters).map(([k, p]) => [k, p.Default]));
  const values = { ...defaults, CodeBucket: "pixcar-code-essai", "AWS::Partition": "aws", "AWS::Region": "eu-north-1", "AWS::AccountId": "123456789012" };

  test("only the production environment of the Pixcar repository, through GitHub's identity provider, may take it", () => {
    assert.match(t.Metadata.AWSToolsMetrics.AWSAgentToolkit, /^aws-cloudformation@\d+$/);
    assert.ok(Buffer.byteLength(t.Description) < 1024);
    const trust = role.AssumeRolePolicyDocument.Statement;
    assert.equal(trust.length, 1);
    assert.equal(trust[0].Action, "sts:AssumeRoleWithWebIdentity");
    assert.deepEqual(Object.keys(trust[0].Condition), ["StringEquals"], "aucun joker (StringLike) dans la condition");
    const cond = trust[0].Condition.StringEquals;
    assert.equal(cond["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
    assert.equal(sub(cond["token.actions.githubusercontent.com:sub"], values), "repo:Floriancrt/Pixcar:environment:production");
    assert.deepEqual(trust[0].Principal.Federated, { "Fn::If": ["CreateOidcProvider", { Ref: "GitHubOidcProvider" }, { Ref: "ExistingOidcProviderArn" }] });
    const provider = t.Resources.GitHubOidcProvider;
    assert.equal(provider.Condition, "CreateOidcProvider");
    assert.equal(provider.Properties.Url, "https://token.actions.githubusercontent.com");
    assert.deepEqual(provider.Properties.ClientIdList, ["sts.amazonaws.com"]);
    assert.ok(role.MaxSessionDuration <= 3600);
  });

  test("its rights stop at the package, the API stack's change sets and its two functions: no wildcard action, nothing on the database or the secrets", () => {
    const actions = statements.flatMap((s) => [].concat(s.Action));
    for (const a of actions) assert.ok(!a.includes("*"), a);
    assert.ok(!actions.some((a) => /^(dsql|ssm|secretsmanager|kms|sts|cloudformation:UpdateStack|cloudformation:Delete(Stack)?$)/.test(a)), actions.join(", "));
    assert.deepEqual(actions.filter((a) => a.startsWith("iam:")), ["iam:PassRole"]);
    for (const s of statements) {
      assert.equal(s.Effect, "Allow");
      for (const r of [].concat(s.Resource)) {
        assert.ok(r && r["Fn::Sub"], `${s.Sid} : ressource nommée`);
        const arn = sub(r, values);
        assert.match(arn, /^arn:aws:/, s.Sid);
        assert.ok(arn.includes(":stack/pixcar/") || arn.includes(":changeSet/deploy-") || arn.includes(":::pixcar-code-essai") || /:function:pixcar-(api|ops)$/.test(arn) || /:role\/pixcar-(Api|Ops)Role-\*$/.test(arn), `${s.Sid} : ${arn}`);
      }
    }
    const by = (sid) => statements.find((s) => s.Sid === sid);
    assert.deepEqual(by("KeepTheFunctionsRoles").Condition, { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } });
    assert.deepEqual([].concat(by("MigrateAndSelfcheck").Resource).map((r) => sub(r, values)), ["arn:aws:lambda:eu-north-1:123456789012:function:pixcar-ops"]);
    assert.ok([].concat(by("UpdateFunctionsThroughTheStack").Action).includes("lambda:UpdateFunctionCode"));
    assert.equal(sub(by("UploadPackage").Resource, values), "arn:aws:s3:::pixcar-code-essai/pixcar-lambda-*.zip");
    // les jeux de modifications : ceux du script (nom « deploy-… »), sans nouveau modèle déposé dans S3
    assert.deepEqual(by("ChangeApiStackParameters").Condition, { StringLike: { "cloudformation:ChangeSetName": "deploy-*" }, Null: { "cloudformation:TemplateUrl": "true" } });
  });

  test("the names it trusts are those the API stack gives its functions and roles", () => {
    assert.deepEqual([api.Resources.ApiFunction.Properties.FunctionName, api.Resources.OpsFunction.Properties.FunctionName], [{ "Fn::Sub": "${AWS::StackName}-api" }, { "Fn::Sub": "${AWS::StackName}-ops" }]);
    for (const id of ["ApiRole", "OpsRole"]) assert.equal(api.Resources[id].Properties.RoleName, undefined, `${id} : nom donné par CloudFormation (<pile>-${id}-…)`);
    assert.deepEqual(api.Outputs.OpsFunctionName.Value, { Ref: "OpsFunction" });
    assert.ok(api.Outputs.ApiUrl);
    assert.match(t.Outputs.DeployRoleArn.Description, /AWS_DEPLOY_ROLE_ARN/);
  });
});

describe("the workflow (.github/workflows/deploy-api.yml)", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/deploy-api.yml"), "utf8");
  const w = parse(text);
  const on = w.on || w[true]; // « on » se lit true en YAML 1.1
  const { build: b, deploy: d } = w.jobs;

  test("it runs on main, for every file the Lambda package is built from", async () => {
    assert.deepEqual(on.push.branches, ["main"]);
    assert.ok(Object.hasOwn(on, "workflow_dispatch"));
    const r = await build({ entryPoints: ["server/lambda.mjs", "server/ops.mjs", "server/cognito-email.mjs"].map((f) => join(ROOT, f)), absWorkingDir: ROOT, bundle: true, platform: "node", format: "esm", target: "node22", write: false, metafile: true, external: ["@electric-sql/pglite", "pg-native"], logLevel: "silent", outdir: "/tmp/pixcar-deploy-test" });
    const covered = (f) => on.push.paths.some((p) => (p.endsWith("/**") ? f.startsWith(p.slice(0, -2)) : f === p));
    const sources = Object.keys(r.metafile.inputs).filter((f) => !f.startsWith("node_modules/"));
    assert.ok(sources.length > 20);
    for (const f of sources) assert.ok(covered(f), `${f} entre dans le paquet mais ne déclenche pas le workflow`);
    for (const f of ["db/migrations/009_atelier.sql", "package-lock.json", "scripts/build-lambda.mjs", "scripts/deploy-api.mjs", ".github/workflows/deploy-api.yml"]) assert.ok(covered(f), f);
  });

  test("tests and package without any AWS right; the deployment waits for the production environment and takes the role through OIDC, no key stored", () => {
    assert.deepEqual(w.permissions, { contents: "read" });
    assert.equal(b.permissions, undefined);
    assert.ok(b.steps.some((s) => /npm run -s test:unit && npm run -s test:server/.test(s.run || "")));
    assert.ok(b.steps.some((s) => /deploy-api\.mjs package/.test(s.run || "")));
    assert.equal(d.needs, "build");
    assert.equal(d.if, "needs.build.outputs.changed == 'true'");
    assert.equal(d.environment.name, "production");
    assert.deepEqual(d.permissions, { contents: "read", "id-token": "write" });
    assert.deepEqual(d.concurrency, { group: "deploy-api", "cancel-in-progress": false });
    const creds = d.steps.find((s) => String(s.uses || "").startsWith("aws-actions/configure-aws-credentials@"));
    assert.equal(creds.with["role-to-assume"], "${{ vars.AWS_DEPLOY_ROLE_ARN }}");
    assert.equal(creds.with["aws-region"], "eu-north-1");
    assert.ok(!/secrets\.|aws-access-key-id|aws-secret-access-key/.test(text), "aucune clé AWS dans les secrets");
    const upload = b.steps.find((s) => String(s.uses || "").startsWith("actions/upload-artifact@"));
    const download = d.steps.find((s) => String(s.uses || "").startsWith("actions/download-artifact@"));
    assert.equal(upload.with.name, download.with.name);
    const run = d.steps.at(-1).run;
    assert.match(run, /node scripts\/deploy-api\.mjs deploy --zip "dist-lambda\/\$FILE" --stack pixcar --region eu-north-1 --summary "\$GITHUB_STEP_SUMMARY"/);
    assert.equal(d.steps.at(-1).env.FILE, "${{ needs.build.outputs.file }}");
    for (const s of [...b.steps, ...d.steps]) if (s.uses) assert.match(s.uses, /@v\d+$/, `${s.uses} : version fixée`);
  });
});

// ---- une fausse AWS : la pile, son bucket, ses jeux de modifications, ses événements
const KEY_OLD = "pixcar-lambda-d657cc183ab85893.zip";
const KEY_NEW = "pixcar-lambda-58f88d3380662216.zip";
class FakeAws {
  constructor({ params = {}, status = "UPDATE_COMPLETE", objects = {}, extraChange = null, failExecute = false, pending = 1 } = {}) {
    this.stack = { status, params: { CodeBucket: "pixcar-code-essai", CodeKey: KEY_OLD, OpsCodeKey: "", RdvEnabled: "true", ...params } };
    this.objects = new Map(Object.entries(objects));
    this.changeSets = new Map();
    this.calls = [];
    this.history = [];
    Object.assign(this, { extraChange, failExecute, pending, polls: 0 });
  }
  resolved(p) {
    return { ApiFunction: p.CodeKey, OpsFunction: p.OpsCodeKey || p.CodeKey };
  }
  opt(args, name) {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  }
  async call(args) {
    const verb = `${args[0]} ${args[1]}`;
    this.calls.push(verb);
    switch (verb) {
      case "cloudformation describe-stacks": {
        if (/_IN_PROGRESS$/.test(this.stack.status) && this.polls-- <= 0) this.finish();
        const { status, params } = this.stack;
        return { Stacks: [{ StackStatus: status, Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })), Outputs: [{ OutputKey: "OpsFunctionName", OutputValue: "pixcar-ops" }, { OutputKey: "ApiUrl", OutputValue: "https://abc.execute-api.eu-north-1.amazonaws.com" }] }] };
      }
      case "s3api head-object": {
        const o = this.objects.get(this.opt(args, "--key"));
        if (!o) throw new Error("aws s3api head-object : An error occurred (404) when calling the HeadObject operation: Not Found");
        return { ContentLength: o.size };
      }
      case "s3api put-object": {
        const body = await readFile(this.opt(args, "--body"));
        this.objects.set(this.opt(args, "--key"), { size: body.length });
        return { ETag: `"${createHash("md5").update(body).digest("hex")}"` };
      }
      case "cloudformation create-change-set": {
        assert.ok(args.includes("--use-previous-template"));
        const name = this.opt(args, "--change-set-name");
        const next = { ...this.stack.params };
        for (const p of JSON.parse(this.opt(args, "--parameters"))) if (!p.UsePreviousValue) next[p.ParameterKey] = p.ParameterValue;
        const [a, b] = [this.resolved(this.stack.params), this.resolved(next)];
        const changes = Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => ({ ResourceChange: { Action: "Modify", LogicalResourceId: k, ResourceType: "AWS::Lambda::Function", Replacement: "False" } }));
        if (this.extraChange) changes.push({ ResourceChange: this.extraChange });
        const id = `arn:aws:cloudformation:eu-north-1:123456789012:changeSet/${name}/1`;
        this.changeSets.set(id, { name, next, changes, left: this.pending, deleted: false, executed: false });
        return { Id: id };
      }
      case "cloudformation describe-change-set": {
        const cs = this.changeSets.get(this.opt(args, "--change-set-name"));
        if (cs.left-- > 0) return { Status: "CREATE_PENDING" };
        if (!cs.changes.length) return { Status: "FAILED", StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set." };
        return { Status: "CREATE_COMPLETE", Changes: cs.changes };
      }
      case "cloudformation delete-change-set":
        this.changeSets.get(this.opt(args, "--change-set-name")).deleted = true;
        return {};
      case "cloudformation execute-change-set": {
        const cs = this.changeSets.get(this.opt(args, "--change-set-name"));
        cs.executed = true;
        this.running = cs;
        this.stack.status = "UPDATE_IN_PROGRESS";
        this.polls = 1;
        return {};
      }
      case "cloudformation describe-stack-events":
        return { StackEvents: [{ LogicalResourceId: "ApiFunction", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "User is not authorized to perform: lambda:UpdateFunctionCode", Timestamp: new Date().toISOString() }] };
      default:
        throw new Error(`appel inattendu : ${args.join(" ")}`);
    }
  }
  finish() {
    if (this.failExecute) {
      this.stack.status = "UPDATE_ROLLBACK_COMPLETE";
      return;
    }
    this.stack.params = this.running.next;
    this.stack.status = "UPDATE_COMPLETE";
    this.history.push({ ...this.resolved(this.stack.params) });
  }
}

const SELFCHECK = { ok: true, op: "selfcheck", db: "dsql", passed: 32, total: 32, checks: [] };
function harness(o = {}) {
  const aws = new FakeAws(o.aws);
  const opsCalls = [];
  const smokeCalls = [];
  const ops = async (payload) => {
    opsCalls.push(payload.op);
    // la migration et l'auto-contrôle tournent pendant que l'API est encore sur l'ancien code
    assert.equal(aws.resolved(aws.stack.params).ApiFunction, o.apiDuringOps || KEY_OLD);
    if (payload.op === "migrate") return o.migrate || { ok: true, op: "migrate", applied: ["009_atelier.sql"], role: {} };
    return o.selfcheck || SELFCHECK;
  };
  const smoke = async (base) => {
    smokeCalls.push(base);
    return o.smoke || { ok: true, steps: Array.from({ length: 13 }, (_, i) => ({ name: `étape ${i}`, ok: true })) };
  };
  let clock = Date.now();
  const run = (extra = {}) => deploy({ zip: o.zip || zipPath, stack: "pixcar", aws: (a) => aws.call(a), ops, smoke, sleep: async () => {}, now: () => (clock += 1000), ...extra });
  return { aws, opsCalls, smokeCalls, run };
}

let dir, zipPath;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixcar-deploy-"));
  zipPath = join(dir, KEY_NEW);
  await writeFile(zipPath, Buffer.from("paquet d'essai"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("scripts/deploy-api.mjs against a fake AWS", () => {
  test("operations first (migrate, then selfcheck, API untouched), then the API and the end-to-end check; only change sets that modify the expected function run", async () => {
    const h = harness();
    const r = await h.run();
    assert.equal(r.status, "deployed");
    assert.deepEqual(h.opsCalls, ["migrate", "selfcheck"]);
    assert.deepEqual(h.smokeCalls, ["https://abc.execute-api.eu-north-1.amazonaws.com"]);
    assert.deepEqual(h.aws.history, [{ ApiFunction: KEY_OLD, OpsFunction: KEY_NEW }, { ApiFunction: KEY_NEW, OpsFunction: KEY_NEW }]);
    assert.deepEqual(h.aws.stack.params, { CodeBucket: "pixcar-code-essai", CodeKey: KEY_NEW, OpsCodeKey: KEY_NEW, RdvEnabled: "true" }, "les autres paramètres gardent leur valeur");
    assert.ok(h.aws.objects.has(KEY_NEW), "paquet déposé");
    assert.deepEqual([...h.aws.changeSets.values()].map((c) => [c.name.replace(/-\d+$/, ""), c.executed, c.deleted]), [["deploy-ops", true, false], ["deploy-api", true, false]]);
    assert.deepEqual(r.migrations, ["009_atelier.sql"]);
    assert.deepEqual(r.selfcheck, { passed: 32, total: 32 });
    assert.deepEqual(r.smoke, { ok: true, passed: 13, total: 13 });
    const md = summaryMarkdown(r);
    assert.match(md, /✅ Déployé/);
    assert.match(md, new RegExp(`${KEY_OLD}.*${KEY_NEW}`));
    assert.match(md, /Auto-contrôle sur la base : 32\/32/);
  });

  test("already running this package: nothing is uploaded, no change set, no operation", async () => {
    const h = harness({ aws: { params: { CodeKey: KEY_NEW, OpsCodeKey: "" } } });
    const r = await h.run();
    assert.equal(r.status, "unchanged");
    assert.deepEqual(h.aws.calls, ["cloudformation describe-stacks"]);
    assert.deepEqual(h.opsCalls, []);
    assert.match(summaryMarkdown(r), /Déjà en service/);
  });

  test("a failing selfcheck gives the operations their previous code back and never touches the API", async () => {
    const h = harness({ selfcheck: { ok: false, op: "selfcheck", passed: 31, total: 32, checks: [{ name: "Gestion d'atelier", ok: false, detail: "colonne absente" }] } });
    await assert.rejects(h.run(), (e) => {
      assert.match(e.message, /auto-contrôle en échec \(31\/32\) : Gestion d'atelier \(colonne absente\)/);
      assert.deepEqual(e.report.rolledBack, [`opérations : ${KEY_OLD}`]);
      assert.equal(e.report.status, "failed");
      return true;
    });
    assert.deepEqual(h.aws.stack.params.OpsCodeKey, "", "OpsCodeKey revient à sa valeur d'avant (vide = celle de l'API)");
    assert.deepEqual(h.aws.history.at(-1), { ApiFunction: KEY_OLD, OpsFunction: KEY_OLD });
    assert.ok(!h.aws.history.some((x) => x.ApiFunction === KEY_NEW));
    assert.deepEqual(h.smokeCalls, []);
  });

  test("a failed migration stops before the selfcheck, operations rolled back", async () => {
    const h = harness({ migrate: { ok: false, op: "migrate", error: "relation inconnue" } });
    await assert.rejects(h.run(), /migration en échec : relation inconnue/);
    assert.deepEqual(h.opsCalls, ["migrate"]);
    assert.deepEqual(h.aws.history.at(-1), { ApiFunction: KEY_OLD, OpsFunction: KEY_OLD });
  });

  test("a failing end-to-end check puts both functions back on the previous package", async () => {
    const h = harness({ smoke: { ok: false, steps: [{ name: "/readyz", ok: true }, { name: "déclaration", ok: false, detail: "500" }] } });
    await assert.rejects(h.run(), (e) => {
      assert.match(e.message, /essai de bout en bout en échec .* : déclaration \(500\)/);
      assert.deepEqual(e.report.rolledBack, [`API : ${KEY_OLD}`, `opérations : ${KEY_OLD}`]);
      return true;
    });
    assert.deepEqual(h.aws.history.at(-1), { ApiFunction: KEY_OLD, OpsFunction: KEY_OLD });
    assert.deepEqual(h.aws.stack.params.CodeKey, KEY_OLD);
  });

  test("an unexpected change (another resource, or a replacement) is deleted without being executed", async () => {
    for (const extra of [
      { Action: "Modify", LogicalResourceId: "ApiRole", ResourceType: "AWS::IAM::Role", Replacement: "False" },
      { Action: "Modify", LogicalResourceId: "OpsFunction", ResourceType: "AWS::Lambda::Function", Replacement: "True" },
    ]) {
      const h = harness({ aws: { extraChange: extra } });
      await assert.rejects(h.run(), /jeu de modifications inattendu, supprimé sans être exécuté/);
      const [cs] = [...h.aws.changeSets.values()];
      assert.deepEqual([cs.executed, cs.deleted], [false, true]);
      assert.deepEqual(h.aws.history, []);
      assert.deepEqual(h.opsCalls, []);
    }
  });

  test("a stack update CloudFormation rolls back is reported with the reason", async () => {
    const h = harness({ aws: { failExecute: true } });
    await assert.rejects(h.run(), /mise à jour de la pile en échec \(UPDATE_ROLLBACK_COMPLETE\) — ApiFunction : User is not authorized to perform: lambda:UpdateFunctionCode/);
    assert.deepEqual(h.opsCalls, []);
  });

  test("refusals before anything changes: stack busy, template without OpsCodeKey, same name with another size, a file that is not a package", async () => {
    const busy = harness({ aws: { status: "UPDATE_IN_PROGRESS" } });
    busy.aws.polls = Infinity;
    await assert.rejects(busy.run(), /dans l'état UPDATE_IN_PROGRESS/);
    const old = harness();
    delete old.aws.stack.params.OpsCodeKey;
    await assert.rejects(old.run(), /n'a pas encore le paramètre OpsCodeKey/);
    const clash = harness({ aws: { objects: { [KEY_NEW]: { size: 3 } } } });
    await assert.rejects(clash.run(), /déjà dans pixcar-code-essai avec une autre taille/);
    for (const h of [busy, old, clash]) assert.ok(!h.aws.calls.includes("cloudformation create-change-set"));
    await assert.rejects(harness({ zip: join(dir, "paquet.zip") }).run(), /une archive de scripts\/build-lambda\.mjs est attendue/);
  });

  test("the package already uploaded with the same size is not uploaded again; the API alone moves when the operations already run it", async () => {
    const h = harness({ aws: { params: { OpsCodeKey: KEY_NEW }, objects: { [KEY_NEW]: { size: Buffer.byteLength("paquet d'essai") } } } });
    const r = await h.run();
    assert.equal(r.status, "deployed");
    assert.ok(!h.aws.calls.includes("s3api put-object"));
    assert.deepEqual([...h.aws.changeSets.values()].map((c) => c.name.replace(/-\d+$/, "")), ["deploy-api"]);
    assert.deepEqual(h.opsCalls, ["migrate", "selfcheck"], "migration et auto-contrôle rejoués avant que l'API ne change");
  });

  test("changeParameters: every other parameter keeps its previous value; nothing to change is not an error", async () => {
    const aws = new FakeAws();
    let sent;
    const spy = async (a) => {
      if (a[1] === "create-change-set") sent = JSON.parse(a[a.indexOf("--parameters") + 1]);
      return aws.call(a);
    };
    const r = await changeParameters({ aws: spy, stack: "pixcar", sleep: async () => {} }, aws.stack.params, { CodeKey: KEY_OLD }, ["ApiFunction"], "noop");
    assert.deepEqual(r, { changed: false, resources: [] });
    assert.deepEqual(sent, [
      { ParameterKey: "CodeBucket", UsePreviousValue: true },
      { ParameterKey: "CodeKey", ParameterValue: KEY_OLD },
      { ParameterKey: "OpsCodeKey", UsePreviousValue: true },
      { ParameterKey: "RdvEnabled", UsePreviousValue: true },
    ]);
    assert.ok([...aws.changeSets.values()][0].deleted, "le jeu vide est supprimé");
  });
});

describe("scripts/deploy-api.mjs plumbing", () => {
  test("aws calls carry the region and JSON output; the operations function is read from its response file", async () => {
    const seen = [];
    const aws = awsCli({ region: "eu-north-1", run: async (cmd, args) => (seen.push([cmd, ...args]), '{"a":1}') });
    assert.deepEqual(await aws(["sts", "get-caller-identity"]), { a: 1 });
    assert.deepEqual(seen[0], ["aws", "sts", "get-caller-identity", "--region", "eu-north-1", "--output", "json"]);
    let args;
    const invoke = opsInvoker({
      functionName: "pixcar-ops",
      aws: async (a) => {
        args = a;
        await writeFile(a.at(-1), JSON.stringify({ ok: true, op: "selfcheck", passed: 1, total: 1 }));
        return { StatusCode: 200 };
      },
    });
    assert.deepEqual(await invoke({ op: "selfcheck" }), { ok: true, op: "selfcheck", passed: 1, total: 1 });
    assert.deepEqual(args.slice(0, 8), ["lambda", "invoke", "--function-name", "pixcar-ops", "--cli-binary-format", "raw-in-base64-out", "--cli-read-timeout", "330"]);
    assert.equal(args[args.indexOf("--payload") + 1], '{"op":"selfcheck"}');
    const crash = opsInvoker({ functionName: "pixcar-ops", aws: async (a) => (await writeFile(a.at(-1), '{"errorMessage":"Task timed out"}'), { StatusCode: 200, FunctionError: "Unhandled" }) });
    await assert.rejects(crash({ op: "migrate" }), /a planté \(Unhandled\) : Task timed out/);
  });

  test("the package is built twice and kept only if both archives are identical", async () => {
    const out = join(dir, "out");
    let n = 0;
    const fake = (differ) => async ({ out: o }) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(o, { recursive: true });
      const file = differ ? `pixcar-lambda-000000000000000${n}.zip` : KEY_NEW;
      await writeFile(join(o, file), `contenu ${differ ? n : 0}`);
      n++;
      return { zip: join(o, file), file, hash: file.slice(14, 30) };
    };
    const p = await packageTwice({ out, build: fake(false) });
    assert.deepEqual([p.file, p.hash, p.bytes], [KEY_NEW, "58f88d3380662216", 9]);
    assert.equal(await readFile(join(out, KEY_NEW), "utf8"), "contenu 0");
    await assert.rejects(packageTwice({ out, build: fake(true) }), /deux constructions différentes/);
  });

  test("command line", () => {
    assert.equal(parseArgs(["deploy", "--zip", "x.zip"]).bad, "");
    assert.equal(parseArgs(["deploy"]).bad, "deploy demande --zip <archive>");
    assert.equal(parseArgs(["deploy", "--zip"]).bad, "--zip attend une valeur");
    assert.equal(parseArgs(["deploy", "--zip", "x.zip", "--region", "Paris"]).bad, "région inattendue : Paris");
    assert.equal(parseArgs(["publish"]).bad, "commande attendue : package ou deploy");
    assert.deepEqual(parseArgs(["deploy", "--zip", "x.zip", "--no-smoke", "--stack", "essai"]).smoke, false);
    assert.equal(parseArgs(["package", "--out", "d"]).out, "d");
  });
});
