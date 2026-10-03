// Le modèle CloudFormation (infra/pixcar-api.yaml) et le code ne se contredisent pas : variables lues par l'application, secrets
// hors de la configuration des fonctions, droits IAM au plus juste, délais qui s'emboîtent, base qu'on ne supprime pas par erreur.
// Ce test ne remplace ni cfn-lint ni cfn-guard (schéma des ressources, règles de sécurité) : il vérifie le contrat propre à Pixcar.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadConfig } from "../config.mjs";
import { readSecrets } from "../lib/secrets.mjs";
import { createOps } from "../ops.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(join(ROOT, "infra/pixcar-api.yaml"), "utf8");

// Les fonctions courtes de CloudFormation (!Ref, !Sub…) deviennent la forme longue (Ref, Fn::Sub…) que lit l'API.
const FUNCTIONS = ["Sub", "If", "Equals", "Not", "And", "Or", "Join", "Select", "Split", "FindInMap", "Base64", "GetAZs", "ImportValue", "Cidr", "Length"];
const customTags = [
  { tag: "!Ref", resolve: (s) => ({ Ref: s }) },
  { tag: "!Condition", resolve: (s) => ({ Condition: s }) },
  { tag: "!GetAtt", resolve: (s) => ({ "Fn::GetAtt": s.split(/\.(.*)/s).slice(0, 2) }) },
  { tag: "!GetAtt", collection: "seq", resolve: (q) => ({ "Fn::GetAtt": q.toJSON() }) },
  ...FUNCTIONS.flatMap((f) => [
    { tag: `!${f}`, resolve: (s) => ({ [`Fn::${f}`]: s }) },
    { tag: `!${f}`, collection: "seq", resolve: (q) => ({ [`Fn::${f}`]: q.toJSON() }) },
  ]),
];
const t = parse(text, { customTags });
const R = t.Resources;
const PSEUDO = new Set(["AWS::AccountId", "AWS::Region", "AWS::StackName", "AWS::Partition", "AWS::URLSuffix", "AWS::NoValue", "AWS::StackId"]);

function scan(node, found = { refs: new Set(), attrs: new Set(), conditions: new Set() }) {
  if (Array.isArray(node)) node.forEach((n) => scan(n, found));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "Ref") found.refs.add(v);
      else if (k === "Fn::GetAtt") found.attrs.add(v[0]);
      else if (k === "Fn::If") found.conditions.add(v[0]);
      else if (k === "Condition" && typeof v === "string") found.conditions.add(v);
      else if (k === "Fn::Sub") for (const m of String(Array.isArray(v) ? v[0] : v).matchAll(/\$\{([^}!]+)\}/g)) found.refs.add(m[1].split(".")[0]);
      scan(v, found);
    }
  }
  return found;
}

// valeur d'une variable d'environnement telle que la fonction la recevrait (paramètres à leur valeur par défaut)
const ENDPOINT = "abc123def456.dsql.eu-north-1.on.aws";
const API_ROLE_ARN = "arn:aws:iam::123456789012:role/pixcar-ApiRole-1A2B3C4D5E6F";
const ATTRIBUTES = { "Cluster.Endpoint": ENDPOINT, "ApiRole.Arn": API_ROLE_ARN };
function valueOf(node) {
  if (typeof node === "string") return node;
  if (node && node.Ref) {
    const p = t.Parameters[node.Ref];
    assert.ok(p && p.Default !== undefined, `« ${node.Ref} » n'a pas de valeur par défaut`);
    return String(p.Default);
  }
  const attribute = node && node["Fn::GetAtt"] && node["Fn::GetAtt"].join(".");
  if (attribute && ATTRIBUTES[attribute]) return ATTRIBUTES[attribute];
  throw new Error("valeur d'environnement inconnue du test : " + JSON.stringify(node));
}
const environment = (id) => Object.fromEntries(Object.entries(R[id].Properties.Environment.Variables).map(([k, v]) => [k, valueOf(v)]));
const statements = (role) => R[role].Properties.Policies.flatMap((p) => p.PolicyDocument.Statement);
const actions = (role) => new Set(statements(role).flatMap((s) => [].concat(s.Action)));
const secretNames = (role) =>
  statements(role)
    .filter((s) => s.Sid && /Secret/.test(s.Sid))
    .flatMap((s) => [].concat(s.Resource))
    .map((r) => String(r["Fn::Sub"]).replace(/^.*parameter\$\{SsmPrefix\}/, ""))
    .sort();
const sourceNames = () => {
  const names = new Set();
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "test") visit(join(dir, e.name));
      else if (e.name.endsWith(".mjs")) for (const m of readFileSync(join(dir, e.name), "utf8").matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
    }
  };
  visit(join(ROOT, "server"));
  return names;
};

describe("CloudFormation template (infra/pixcar-api.yaml)", () => {
  test("it is a template CloudFormation accepts inline, labelled with the toolkit marker", () => {
    assert.equal(t.AWSTemplateFormatVersion, "2010-09-09");
    assert.ok(Buffer.byteLength(text) < 51_200, "au-delà, il faudrait le déposer dans S3");
    assert.ok(Buffer.byteLength(t.Description) < 1024);
    assert.match(t.Metadata.AWSToolsMetrics.AWSAgentToolkit, /^aws-cloudformation@\d+$/);
    for (const id of ["Cluster", "ApiRole", "OpsRole", "ApiFunction"]) {
      const ctx = R[id].Metadata && R[id].Metadata["com.aws.cloudformation.Context"];
      assert.ok(ctx && ctx.why && Array.isArray(ctx.must) && ctx.must.length, `${id} : pourquoi et contraintes à conserver`);
    }
  });

  test("every reference resolves, no parameter is dead, nothing unconditional depends on a conditional resource", () => {
    const known = new Set([...Object.keys(t.Parameters), ...Object.keys(R), ...PSEUDO]);
    const used = new Set();
    for (const section of ["Conditions", "Resources", "Outputs"]) {
      const found = scan(t[section]);
      for (const ref of found.refs) assert.ok(known.has(ref), `${section} : « ${ref} » n'existe pas`);
      for (const attr of found.attrs) assert.ok(R[attr], `${section} : GetAtt sur « ${attr} », qui n'est pas une ressource`);
      for (const c of found.conditions) assert.ok(t.Conditions[c], `${section} : condition « ${c} » inconnue`);
      for (const ref of found.refs) used.add(ref);
    }
    for (const p of Object.keys(t.Parameters)) assert.ok(used.has(p), `paramètre « ${p} » inutilisé`);
    const elements = [...Object.entries(R), ...Object.entries(t.Outputs)];
    for (const [id, el] of elements) {
      const found = scan(el);
      for (const ref of [...found.refs, ...found.attrs, ...[].concat(el.DependsOn || [])]) {
        if (R[ref] && R[ref].Condition) assert.equal(el.Condition, R[ref].Condition, `« ${id} » dépend de « ${ref} » (conditionnelle) sans la même condition`);
      }
    }
  });

  test("the two functions run the package that scripts/build-lambda.mjs produces: same code, runtime of the build target, handlers api / ops", () => {
    const build = readFileSync(join(ROOT, "scripts/build-lambda.mjs"), "utf8");
    const [api, ops] = [R.ApiFunction.Properties, R.OpsFunction.Properties];
    assert.equal(api.Runtime, `nodejs${build.match(/target: "node(\d+)"/)[1]}.x`);
    assert.equal(ops.Runtime, api.Runtime);
    assert.deepEqual([api.Architectures, ops.Architectures], [["arm64"], ["arm64"]]);
    const handlers = build.match(/handlers: \{ api: "([^"]+)", ops: "([^"]+)" \}/);
    assert.deepEqual([api.Handler, ops.Handler], [handlers[1], handlers[2]]);
    assert.deepEqual(api.Code, ops.Code);
    assert.deepEqual(api.Code, { S3Bucket: { Ref: "CodeBucket" }, S3Key: { Ref: "CodeKey" } });
    assert.deepEqual([api.Role, ops.Role], [{ "Fn::GetAtt": ["ApiRole", "Arn"] }, { "Fn::GetAtt": ["OpsRole", "Arn"] }]);
    // Lambda décompresse l'archive dans /var/task ; la fonction d'opérations y lit les migrations que le paquet embarque
    assert.ok(build.includes('"db/migrations"'));
    assert.equal(environment("OpsFunction").MIGRATIONS_DIR, "/var/task/db/migrations");
    assert.equal(environment("OpsFunction").API_ROLE_ARN, API_ROLE_ARN, "« migrate » lie au rôle de base pixcar_api le rôle IAM de l'API, pas un autre");
  });

  test("timeouts nest: the application answers (10 s) before the gateway gives up (12 s), the function outlives the gateway but not its 30 s ceiling", () => {
    const appMs = loadConfig({ ...environment("ApiFunction"), PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20) }).requestTimeoutMs;
    const gatewayMs = R.ApiIntegration.Properties.TimeoutInMillis;
    assert.ok(appMs < gatewayMs && gatewayMs <= R.ApiFunction.Properties.Timeout * 1000 && gatewayMs <= 30_000, `${appMs} / ${gatewayMs} / ${R.ApiFunction.Properties.Timeout} s`);
    assert.ok(R.OpsFunction.Properties.Timeout >= 120 && R.OpsFunction.Properties.Timeout <= 900, "la migration attend les index asynchrones de DSQL");
  });

  test("the API function boots in production with this environment plus the two secrets, and only reads settings the code knows", () => {
    const env = environment("ApiFunction");
    const config = loadConfig({ ...env, PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20) });
    assert.equal(config.production, true);
    assert.equal(config.trustProxy, 0, "l'adresse du visiteur vient de la passerelle, jamais d'un en-tête");
    assert.deepEqual(config.dsql, { endpoint: ENDPOINT, user: "pixcar_api", max: 2 });
    assert.equal(config.databaseUrl, "");
    assert.deepEqual(config.allowedOrigins, ["https://pixcar.fr", "https://www.pixcar.fr"]);
    assert.throws(() => loadConfig(env), /PLATE_PEPPER/, "sans SSM, la fonction refuse de démarrer au lieu d'inventer un secret");
    const read = sourceNames();
    for (const id of ["ApiFunction", "OpsFunction"]) {
      for (const name of Object.keys(R[id].Properties.Environment.Variables)) assert.ok(read.has(name), `${id} : « ${name} » n'est lu nulle part dans server/`);
    }
  });

  test("no secret, token or connection string sits in a function's configuration (visible in the Lambda console and in CloudFormation)", () => {
    for (const id of ["ApiFunction", "OpsFunction"]) {
      for (const name of Object.keys(R[id].Properties.Environment.Variables)) assert.ok(!/PEPPER|SECRET|TOKEN|PASSWORD|DATABASE_URL|ACCESS_KEY/i.test(name), `${id} : ${name}`);
    }
    for (const [name, p] of Object.entries(t.Parameters)) assert.ok(!/PEPPER|SECRET|TOKEN|PASSWORD/i.test(name) && !p.NoEcho, `paramètre ${name}`);
  });

  test("IAM at the narrowest: the API connects as a plain database role and reads exactly the secrets the code asks SSM for", async () => {
    assert.deepEqual([...actions("ApiRole")].sort(), ["dsql:DbConnect", "logs:CreateLogStream", "logs:PutLogEvents", "ssm:GetParameters"]);
    assert.deepEqual([...actions("OpsRole")].sort(), ["dsql:DbConnectAdmin", "logs:CreateLogStream", "logs:PutLogEvents", "ssm:GetParameters"]);
    for (const role of ["ApiRole", "OpsRole", "SchedulerRole"]) for (const s of statements(role)) assert.ok(![].concat(s.Resource).includes("*") && s.Effect === "Allow", `${role} : ${JSON.stringify(s).slice(0, 80)}`);
    let asked = [];
    await readSecrets({ SSM_PREFIX: "/p/" }, { client: { SSMClient: class { send(c) { asked = c.input.Names; return { Parameters: asked.map((n) => ({ Name: n, Value: "x" })) }; } }, GetParametersCommand: class { constructor(input) { this.input = input; } } } });
    assert.deepEqual(secretNames("ApiRole"), asked.map((n) => n.slice("/p/".length)).sort());
    assert.deepEqual(secretNames("OpsRole"), ["PLATE_PEPPER"], "l'opération « forget » ne lit que le secret des plaques");
    const trust = (role) => R[role].Properties.AssumeRolePolicyDocument.Statement.map((s) => s.Principal.Service);
    assert.deepEqual([trust("ApiRole"), trust("OpsRole"), trust("SchedulerRole")], [["lambda.amazonaws.com"], ["lambda.amazonaws.com"], ["scheduler.amazonaws.com"]]);
    assert.ok(R.SchedulerRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["aws:SourceAccount"]);
    assert.deepEqual(statements("SchedulerRole").map((s) => [s.Action, s.Resource]), [["lambda:InvokeFunction", { "Fn::GetAtt": ["OpsFunction", "Arn"] }]]);
  });

  test("the database survives a deleted stack: retained, replaced-then-retained, and protected against deletion", () => {
    assert.equal(R.Cluster.Type, "AWS::DSQL::Cluster");
    assert.deepEqual([R.Cluster.DeletionPolicy, R.Cluster.UpdateReplacePolicy, R.Cluster.Properties.DeletionProtectionEnabled], ["Retain", "Retain", true]);
  });

  test("the gateway hands the function the version 2.0 event (it carries the visitor's address), one route, one stage, global throttling", () => {
    assert.deepEqual([R.HttpApi.Properties.ProtocolType, R.ApiIntegration.Properties.IntegrationType, R.ApiIntegration.Properties.PayloadFormatVersion], ["HTTP", "AWS_PROXY", "2.0"]);
    assert.deepEqual([R.DefaultRoute.Properties.RouteKey, R.DefaultStage.Properties.StageName], ["$default", "$default"]);
    assert.deepEqual(Object.keys(R.DefaultStage.Properties.DefaultRouteSettings).sort(), ["ThrottlingBurstLimit", "ThrottlingRateLimit"]);
    const permission = R.ApiInvokePermission.Properties;
    assert.equal(permission.Principal, "apigateway.amazonaws.com");
    assert.match(permission.SourceArn["Fn::Sub"], /:execute-api:.*\$\{HttpApi\}\/\*$/);
  });

  test("the daily maintenance calls an operation that exists, as the scheduler role, on the operations function", () => {
    const { Target } = R.PurgeSchedule.Properties;
    const wanted = JSON.parse(Target.Input).op;
    assert.deepEqual([Target.Arn, Target.RoleArn], [{ "Fn::GetAtt": ["OpsFunction", "Arn"] }, { "Fn::GetAtt": ["SchedulerRole", "Arn"] }]);
    return createOps({ openDb: () => assert.fail("pas de base ici") })({ op: "?" }).then((r) => assert.ok(r.error.includes(`${wanted},`) || r.error.includes(`, ${wanted}`) || r.error.endsWith(wanted + ")"), r.error));
  });

  test("parameters: each default meets its own constraints; physical names carry the stack name; every alarm notifies the topic", () => {
    for (const [name, p] of Object.entries(t.Parameters)) {
      if (p.Default === undefined) continue;
      const d = String(p.Default);
      if (p.AllowedPattern && d !== "") assert.match(d, new RegExp(p.AllowedPattern), name);
      if (p.AllowedValues) assert.ok(p.AllowedValues.map(String).includes(d), name);
      if (p.MinValue !== undefined) assert.ok(Number(d) >= p.MinValue, name);
      if (p.MaxLength !== undefined) assert.ok(d.length <= p.MaxLength, name);
    }
    const named = { "AWS::Lambda::Function": "FunctionName", "AWS::Logs::LogGroup": "LogGroupName", "AWS::SNS::Topic": "TopicName", "AWS::Scheduler::Schedule": "Name" };
    for (const [id, r] of Object.entries(R)) if (named[r.Type]) assert.match(r.Properties[named[r.Type]]["Fn::Sub"], /\$\{AWS::StackName\}/, id);
    assert.equal(R.ApiLogGroup.Properties.LogGroupName["Fn::Sub"], "/aws/lambda/" + R.ApiFunction.Properties.FunctionName["Fn::Sub"]);
    assert.equal(R.OpsLogGroup.Properties.LogGroupName["Fn::Sub"], "/aws/lambda/" + R.OpsFunction.Properties.FunctionName["Fn::Sub"]);
    const alarms = Object.entries(R).filter(([, r]) => r.Type === "AWS::CloudWatch::Alarm");
    assert.ok(alarms.length >= 3);
    for (const [id, a] of alarms) assert.deepEqual([a.Condition, a.Properties.AlarmActions], ["HasAlarmEmail", [{ Ref: "AlarmTopic" }]], id);
  });
});
