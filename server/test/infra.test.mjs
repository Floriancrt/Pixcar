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
// paramètres changés pour un essai (valeur par défaut sinon)
let overrides = {};
// condition évaluée avec les paramètres à leur valeur par défaut (ou ceux de « overrides »)
function holds(node) {
  if (node && node.Condition) return holds(t.Conditions[node.Condition]);
  if (node && node["Fn::Not"]) return !holds(node["Fn::Not"][0]);
  if (node && node["Fn::And"]) return node["Fn::And"].every(holds);
  if (node && node["Fn::Or"]) return node["Fn::Or"].some(holds);
  if (node && node["Fn::Equals"]) return valueOf(node["Fn::Equals"][0]) === valueOf(node["Fn::Equals"][1]);
  throw new Error("condition inconnue du test : " + JSON.stringify(node));
}
function valueOf(node) {
  if (typeof node === "string") return node;
  if (node && node["Fn::If"]) return valueOf(holds({ Condition: node["Fn::If"][0] }) ? node["Fn::If"][1] : node["Fn::If"][2]);
  if (node && typeof node["Fn::Sub"] === "string") return node["Fn::Sub"].replace(/\$\{(\w+)\}/g, (m, k) => valueOf({ Ref: k }));
  if (node && node.Ref && Object.hasOwn(overrides, node.Ref)) return overrides[node.Ref];
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
// ressource conditionnelle (Fn::If) évaluée avec les paramètres de l'essai ; AWS::NoValue = pas de ressource
const pick = (r) => (r && r["Fn::If"] ? (holds({ Condition: r["Fn::If"][0] }) ? r["Fn::If"][1] : r["Fn::If"][2]) : r);
const secretNames = (role) =>
  statements(role)
    .filter((s) => s.Sid && /Secret/.test(s.Sid))
    .flatMap((s) => [].concat(s.Resource))
    .map(pick)
    .filter((r) => !(r && r.Ref === "AWS::NoValue"))
    .map((r) => String(r["Fn::Sub"]).replace(/^.*parameter\$\{SsmPrefix\}/, ""))
    .sort();
const fakeSsm = (seen) => ({ SSMClient: class { send(c) { seen.names = c.input.Names; return { Parameters: seen.names.map((n) => ({ Name: n, Value: "x" })) }; } }, GetParametersCommand: class { constructor(input) { this.input = input; } } });
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
    // une condition en implique une autre si c'est la même, ou une conjonction (Fn::And) qui la contient
    const implies = (c, needed) => c === needed || (!!c && !!t.Conditions[c]["Fn::And"] && t.Conditions[c]["Fn::And"].some((x) => x.Condition && implies(x.Condition, needed)));
    const elements = [...Object.entries(R), ...Object.entries(t.Outputs)];
    for (const [id, el] of elements) {
      const found = scan(el);
      for (const ref of [...found.refs, ...found.attrs, ...[].concat(el.DependsOn || [])]) {
        if (R[ref] && R[ref].Condition) assert.ok(implies(el.Condition, R[ref].Condition), `« ${id} » dépend de « ${ref} » (conditionnelle) sans une condition qui l'implique`);
      }
    }
  });

  test("the two functions run the package that scripts/build-lambda.mjs produces: same code (unless a deployment moves the operations first), runtime of the build target, handlers api / ops", () => {
    const build = readFileSync(join(ROOT, "scripts/build-lambda.mjs"), "utf8");
    const [api, ops] = [R.ApiFunction.Properties, R.OpsFunction.Properties];
    assert.equal(api.Runtime, `nodejs${build.match(/target: "node(\d+)"/)[1]}.x`);
    assert.equal(ops.Runtime, api.Runtime);
    assert.deepEqual([api.Architectures, ops.Architectures], [["arm64"], ["arm64"]]);
    const handlers = build.match(/handlers: \{ api: "([^"]+)", ops: "([^"]+)"/);
    assert.deepEqual([api.Handler, ops.Handler], [handlers[1], handlers[2]]);
    assert.deepEqual(api.Code, { S3Bucket: { Ref: "CodeBucket" }, S3Key: { Ref: "CodeKey" } });
    assert.deepEqual(ops.Code.S3Bucket, api.Code.S3Bucket);
    // OpsCodeKey vide (valeur par défaut, et toute pile d'avant) : l'archive de l'API ; rempli : la sienne (scripts/deploy-api.mjs)
    assert.deepEqual(pick(ops.Code.S3Key), { Ref: "CodeKey" });
    try {
      overrides = { OpsCodeKey: "pixcar-lambda-0123456789abcdef.zip" };
      assert.deepEqual(pick(ops.Code.S3Key), { Ref: "OpsCodeKey" });
    } finally {
      overrides = {};
    }
    const pattern = new RegExp(t.Parameters.OpsCodeKey.AllowedPattern);
    assert.ok(pattern.test("") && pattern.test("pixcar-lambda-0123456789abcdef.zip") && !pattern.test("x.tar"));
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
    for (const role of ["ApiRole", "OpsRole", "SchedulerRole"])
      for (const s of statements(role).map(pick).filter((x) => !(x && x.Ref === "AWS::NoValue"))) assert.ok(![].concat(s.Resource).includes("*") && s.Effect === "Allow", `${role} : ${JSON.stringify(s).slice(0, 80)}`);
    let asked = [];
    await readSecrets({ SSM_PREFIX: "/p/" }, { client: { SSMClient: class { send(c) { asked = c.input.Names; return { Parameters: asked.map((n) => ({ Name: n, Value: "x" })) }; } }, GetParametersCommand: class { constructor(input) { this.input = input; } } } });
    assert.deepEqual(secretNames("ApiRole"), asked.map((n) => n.slice("/p/".length)).sort());
    assert.deepEqual(secretNames("OpsRole"), ["PLATE_PEPPER"], "l'opération « forget » ne lit que le secret des plaques");
    const trust = (role) => R[role].Properties.AssumeRolePolicyDocument.Statement.map((s) => s.Principal.Service);
    assert.deepEqual([trust("ApiRole"), trust("OpsRole"), trust("SchedulerRole")], [["lambda.amazonaws.com"], ["lambda.amazonaws.com"], ["scheduler.amazonaws.com"]]);
    assert.ok(R.SchedulerRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["aws:SourceAccount"]);
    assert.deepEqual(statements("SchedulerRole").map(pick).filter((s) => !(s && s.Ref === "AWS::NoValue")).map((s) => [s.Action, s.Resource]), [["lambda:InvokeFunction", { "Fn::GetAtt": ["OpsFunction", "Arn"] }]], "rendez-vous fermés : la planification n'appelle que la fonction d'opérations");
  });

  test("the database survives a deleted stack: retained, replaced-then-retained, and protected against deletion", () => {
    assert.equal(R.Cluster.Type, "AWS::DSQL::Cluster");
    assert.deepEqual([R.Cluster.DeletionPolicy, R.Cluster.UpdateReplacePolicy, R.Cluster.Properties.DeletionProtectionEnabled], ["Retain", "Retain", true]);
  });

  test("backups: one daily plan keeps the database's recovery points for the chosen number of days, in a vault the stack never deletes, under a role only AWS Backup can assume", () => {
    const ids = ["BackupVault", "BackupPlan", "BackupRole", "BackupSelection"];
    // 0 jour = pas de sauvegarde ; tout ce qui s'y rapporte tombe avec la condition, sorties comprises
    assert.deepEqual(t.Conditions.HasBackup, { "Fn::Not": [{ "Fn::Equals": [{ Ref: "BackupRetentionDays" }, "0"] }] });
    for (const id of ids) assert.equal(R[id].Condition, "HasBackup", id);
    for (const name of ["BackupVaultName", "BackupRoleArn"]) assert.equal(t.Outputs[name].Condition, "HasBackup", name);
    // 30 jours par défaut : la durée annoncée dans la politique de confidentialité ; 0 reste permis (sans sauvegarde)
    const days = t.Parameters.BackupRetentionDays;
    assert.equal(days.Default, 30);
    assert.ok(days.AllowedValues.includes(0) && days.AllowedValues.includes(days.Default));
    // le coffre contient les points de restauration : conservé à la suppression comme au remplacement
    assert.deepEqual([R.BackupVault.DeletionPolicy, R.BackupVault.UpdateReplacePolicy], ["Retain", "Retain"]);
    // un plan, une règle : tous les jours, vers ce coffre, conservée le nombre de jours du paramètre
    const rules = R.BackupPlan.Properties.BackupPlan.BackupPlanRule;
    assert.equal(rules.length, 1);
    const [rule] = rules;
    assert.deepEqual([rule.TargetBackupVault, rule.ScheduleExpression, rule.Lifecycle], [{ Ref: "BackupVault" }, { Ref: "BackupSchedule" }, { DeleteAfterDays: { Ref: "BackupRetentionDays" } }]);
    assert.match(t.Parameters.BackupSchedule.Default, /^cron\(\d{1,2} \d{1,2} \* \* \? \*\)$/, "une fois par jour, tous les jours");
    // contraintes d'AWS Backup : lancement dans une fenêtre d'au moins 60 minutes, achèvement au moins 60 minutes plus tard
    assert.ok(rule.StartWindowMinutes >= 60 && rule.CompletionWindowMinutes >= rule.StartWindowMinutes + 60, `${rule.StartWindowMinutes} / ${rule.CompletionWindowMinutes}`);
    // la sélection : le cluster de la pile (pas un autre), ce plan, ce rôle
    const selection = R.BackupSelection.Properties;
    assert.deepEqual(selection.BackupPlanId, { "Fn::GetAtt": ["BackupPlan", "BackupPlanId"] });
    assert.deepEqual(selection.BackupSelection.IamRoleArn, { "Fn::GetAtt": ["BackupRole", "Arn"] });
    assert.deepEqual(selection.BackupSelection.Resources, [{ "Fn::GetAtt": ["Cluster", "ResourceArn"] }]);
    // le rôle : AWS Backup seul peut le prendre ; les deux stratégies gérées (sauvegarde, restauration), aucune stratégie en ligne
    const role = R.BackupRole.Properties;
    assert.deepEqual(role.AssumeRolePolicyDocument.Statement.map((s) => [s.Effect, s.Principal.Service, s.Action]), [["Allow", "backup.amazonaws.com", "sts:AssumeRole"]]);
    assert.equal(role.Policies, undefined);
    assert.deepEqual(role.ManagedPolicyArns.map((a) => a["Fn::Sub"].replace(/^.*policy\//, "")), ["service-role/AWSBackupServiceRolePolicyForBackup", "service-role/AWSBackupServiceRolePolicyForRestores"]);
    // noms physiques : ceux de la pile (plusieurs piles dans un projet ne se marchent pas dessus)
    for (const name of [R.BackupVault.Properties.BackupVaultName, R.BackupPlan.Properties.BackupPlan.BackupPlanName, selection.BackupSelection.SelectionName]) assert.match(name["Fn::Sub"], /^\$\{AWS::StackName\}-/);
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
    // chaque alarme n'existe qu'avec le courriel d'alarme (HasAlarmEmail, ou une conjonction qui le contient) et prévient le sujet
    const withEmail = (c) => c === "HasAlarmEmail" || (!!t.Conditions[c]["Fn::And"] && t.Conditions[c]["Fn::And"].some((x) => x.Condition === "HasAlarmEmail"));
    for (const [id, a] of alarms) {
      assert.ok(withEmail(a.Condition), id);
      assert.deepEqual(a.Properties.AlarmActions, [{ Ref: "AlarmTopic" }], id);
    }
  });
});

describe("Rendez-vous en ligne in the API template", () => {
  const POOL = "eu-north-1_AbCdEf123", CLIENT = "3n4b5c6d7e8f9g0h1i2j3k4l5m";
  const boot = (over) => {
    overrides = over;
    try {
      return loadConfig({ ...environment("ApiFunction"), PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20) });
    } finally {
      overrides = {};
    }
  };
  const schedulerTargets = (over) => {
    overrides = over;
    try {
      return statements("SchedulerRole").map(pick).filter((x) => !(x && x.Ref === "AWS::NoValue")).map((x) => x.Resource["Fn::GetAtt"][0]);
    } finally {
      overrides = {};
    }
  };
  test("closed by default and without the Pro space; opened, the function boots with the sender and the site address", () => {
    assert.equal(boot({}).rdv.enabled, false);
    assert.equal(boot({ RdvEnabled: "true" }).rdv.enabled, false, "sans Espace Pro, rien n'ouvre");
    const on = boot({ RdvEnabled: "true", ProUserPoolId: POOL, ProClientId: CLIENT });
    assert.deepEqual([on.rdv.enabled, on.rdv.emailFrom, on.rdv.siteUrl], [true, "Pixcar <rendez-vous@pixcar.fr>", "https://pixcar.fr"]);
  });
  test("the hourly task exists only when open: at hh:05 Paris time, on the API function, with an input only a direct invocation can carry", async () => {
    const s = R.RdvSchedule;
    assert.equal(s.Condition, "HasRdv");
    assert.deepEqual(t.Conditions.HasRdv, { "Fn::And": [{ Condition: "HasPro" }, { "Fn::Equals": [{ Ref: "RdvEnabled" }, "true"] }] });
    assert.equal(s.Properties.ScheduleExpression, "cron(5 * * * ? *)");
    assert.equal(s.Properties.ScheduleExpressionTimezone, "Europe/Paris");
    assert.deepEqual([s.Properties.Target.Arn, s.Properties.Target.RoleArn], [{ "Fn::GetAtt": ["ApiFunction", "Arn"] }, { "Fn::GetAtt": ["SchedulerRole", "Arn"] }]);
    const { isTick } = await import("../lambda.mjs");
    const input = JSON.parse(s.Properties.Target.Input);
    assert.equal(isTick(input), true);
    assert.equal(isTick({ ...input, requestContext: {} }), false, "un événement de la passerelle n'est jamais la tâche");
    assert.deepEqual(schedulerTargets({}), ["OpsFunction"]);
    assert.deepEqual(schedulerTargets({ RdvEnabled: "true", ProUserPoolId: POOL, ProClientId: CLIENT }), ["OpsFunction", "ApiFunction"]);
    assert.ok(t.Rules.RdvNeedsMail, "SES en mode test ne peut pas écrire aux automobilistes : la pile le refuse");
  });
});

describe("Espace Pro in the templates (infra/pixcar-api.yaml, infra/pixcar-pro.yaml)", () => {
  const POOL = "eu-north-1_AbCdEf123", CLIENT = "3n4b5c6d7e8f9g0h1i2j3k4l5m";
  const NOTIFY = "arn:aws:sms-voice:eu-north-1:123456789012:notify-configuration/nc-0123456789";
  const boot = (over) => {
    overrides = over;
    try {
      return loadConfig({ ...environment("ApiFunction"), PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20) });
    } finally {
      overrides = {};
    }
  };

  test("closed by default; with the pool and the client it opens for e-mail only; with Notify, SMS too — and the function still boots in production", () => {
    assert.equal(boot({}).pro.enabled, false);
    const mail = boot({ ProUserPoolId: POOL, ProClientId: CLIENT });
    assert.deepEqual([mail.pro.enabled, mail.pro.userPoolId, mail.pro.clientId, mail.pro.sender, mail.pro.emailFrom], [true, POOL, CLIENT, "aws", "Pixcar <verification@pixcar.fr>"]);
    assert.deepEqual(mail.pro.channels, ["email", "email_domain"]);
    const sms = boot({ ProUserPoolId: POOL, ProClientId: CLIENT, ProNotifyConfigurationArn: NOTIFY });
    assert.deepEqual([sms.pro.channels, sms.pro.notifyConfigurationId], [["email", "email_domain", "sms"], NOTIFY]);
    assert.equal(boot({ ProUserPoolId: POOL }).pro.enabled, false, "sans client, rien n'ouvre");
  });

  test("sending rights only when the Pro space is open: one SES identity, one Notify configuration, never « * »", () => {
    const p = R.ApiProSendPolicy;
    assert.equal(p.Condition, "HasPro");
    assert.deepEqual(p.Properties.RoleName, { Ref: "ApiRole" });
    const [mail, sandbox, sms] = p.Properties.PolicyDocument.Statement;
    assert.deepEqual([mail.Action, mail.Resource], ["ses:SendEmail", { "Fn::Sub": "arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:identity/${ProEmailDomain}" }]);
    // mode test de SES seulement : les identités vérifiées du compte (destinataires), rien hors de SES, rien hors du compte
    assert.equal(sandbox["Fn::If"][0], "HasProSesSandbox");
    assert.deepEqual([sandbox["Fn::If"][1].Action, sandbox["Fn::If"][1].Resource, sandbox["Fn::If"][2]], ["ses:SendEmail", { "Fn::Sub": "arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:identity/*" }, { Ref: "AWS::NoValue" }]);
    assert.deepEqual(t.Conditions.HasProSesSandbox, { "Fn::And": [{ Condition: "HasPro" }, { "Fn::Equals": [{ Ref: "ProSesSandbox" }, "true"] }] });
    assert.equal(t.Parameters.ProSesSandbox.Default, "false", "hors mode test par défaut : le droit élargi est un choix explicite");
    assert.equal(sms["Fn::If"][0], "HasProSms");
    assert.deepEqual([sms["Fn::If"][1].Action, sms["Fn::If"][1].Resource, sms["Fn::If"][2]], ["sms-voice:SendNotifyTextMessage", { Ref: "ProNotifyConfigurationArn" }, { Ref: "AWS::NoValue" }]);
    assert.ok(!actions("ApiRole").has("ses:SendEmail"), "pas dans la politique permanente du rôle");
  });

  test("e-mails through Scaleway: the function boots with the provider and the project, and may read the Scaleway key — only then", async () => {
    const SCW = "0b2c8f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    overrides = { ProUserPoolId: POOL, ProClientId: CLIENT, ProEmailProvider: "scaleway", ProScwProjectId: SCW };
    try {
      const env = environment("ApiFunction");
      const c = loadConfig({ ...env, PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20), SCW_SECRET_KEY: "k".repeat(30) });
      assert.deepEqual([c.pro.enabled, c.pro.emailProvider, c.pro.scwProjectId], [true, "scaleway", SCW]);
      const seen = {};
      await readSecrets({ ...env, SSM_PREFIX: "/p/" }, { client: fakeSsm(seen) });
      assert.deepEqual(secretNames("ApiRole"), seen.names.map((n) => n.slice("/p/".length)).sort(), "droits SSM = secrets que le code demande");
      assert.ok(secretNames("ApiRole").includes("SCW_SECRET_KEY"));
    } finally {
      overrides = {};
    }
    assert.ok(!secretNames("ApiRole").includes("SCW_SECRET_KEY"), "par défaut (SES) : aucun droit sur la clé Scaleway");
    assert.equal(t.Parameters.ProEmailProvider.Default, "ses");
    assert.deepEqual(t.Rules.ScalewayNeedsProject.RuleCondition, { "Fn::Equals": [{ Ref: "ProEmailProvider" }, "scaleway"] });
  });

  test("the contested-garage alarm counts exactly the log line the API writes, and only exists when the Pro space and alarm e-mails do", async () => {
    const pro = readFileSync(join(ROOT, "server/pro.mjs"), "utf8");
    assert.match(pro, /event: "pro_contested"/);
    assert.equal(R.ProContestedMetric.Properties.FilterPattern, '"pro_contested"');
    assert.deepEqual(R.ProContestedMetric.Properties.LogGroupName, { Ref: "ApiLogGroup" });
    assert.deepEqual([R.ProContestedMetric.Condition, R.ProContestedAlarm.Condition], ["HasPro", "HasProAlarm"]);
    assert.deepEqual(t.Conditions.HasProAlarm, { "Fn::And": [{ Condition: "HasPro" }, { Condition: "HasAlarmEmail" }] });
    const m = R.ProContestedMetric.Properties.MetricTransformations[0];
    assert.deepEqual([R.ProContestedAlarm.Properties.Namespace, R.ProContestedAlarm.Properties.MetricName], [m.MetricNamespace, m.MetricName]);
    // réputation d'envoi SES (dossier de sortie du mode test) : seuils sous les niveaux d'examen d'AWS (5 % de rebonds, 0,1 % de plaintes)
    for (const [id, metric, max] of [["SesBounceRateAlarm", "Reputation.BounceRate", 0.05], ["SesComplaintRateAlarm", "Reputation.ComplaintRate", 0.001]]) {
      const a = R[id].Properties;
      assert.equal(R[id].Condition, "HasProAlarm", id);
      assert.deepEqual([a.Namespace, a.MetricName, a.ComparisonOperator, a.TreatMissingData], ["AWS/SES", metric, "GreaterThanThreshold", "notBreaching"], id);
      assert.ok(a.Threshold > 0 && a.Threshold < max, id);
      assert.equal(a.Dimensions, undefined, id);
    }
  });

  test("the Pro stack: passwordless accounts (Essentials, e-mail code sent through SES), a public client with two flows, nothing deleted with the stack", () => {
    const text = readFileSync(join(ROOT, "infra/pixcar-pro.yaml"), "utf8");
    const p = parse(text, { customTags });
    const P = p.Resources;
    assert.match(p.Metadata.AWSToolsMetrics.AWSAgentToolkit, /^aws-cloudformation@\d+$/);
    assert.ok(Buffer.byteLength(text) < 51_200 && Buffer.byteLength(p.Description) < 1024);
    for (const id of ["EmailIdentity", "UserPool"]) assert.deepEqual([P[id].DeletionPolicy, P[id].UpdateReplacePolicy], ["Retain", "Retain"], id);
    const pool = P.UserPool.Properties;
    assert.equal(P.UserPool.Condition, "HasAccounts");
    assert.equal(pool.UserPoolTier, "ESSENTIALS");
    assert.ok(pool.Policies.SignInPolicy.AllowedFirstAuthFactors.includes("EMAIL_OTP"));
    assert.deepEqual([pool.UsernameAttributes, pool.AutoVerifiedAttributes, pool.DeletionProtection], [["email"], ["email"], "ACTIVE"]);
    assert.equal(pool.EmailConfiguration.EmailSendingAccount, "DEVELOPER", "code e-mail de connexion : Cognito exige SES");
    assert.match(pool.EmailConfiguration.SourceArn["Fn::Sub"], /:identity\/\$\{EmailDomain\}$/);
    const client = P.UserPoolClient.Properties;
    assert.deepEqual([client.GenerateSecret, client.ExplicitAuthFlows, client.EnableTokenRevocation], [false, ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], true]);
    assert.equal(P.UserPoolClient.Condition, "HasAccounts");
    for (const out of ["UserPoolId", "UserPoolClientId"]) assert.equal(p.Outputs[out].Condition, "HasAccounts", out);
    assert.equal(p.Parameters.CreateAccounts.Default, "false", "premier déploiement : l'identité SES seule");
  });

  test("the Pro stack, Cognito's codes through Scaleway: off by default; then a KMS key, a function of the package, the narrowest role, only the pool may call it", () => {
    const text = readFileSync(join(ROOT, "infra/pixcar-pro.yaml"), "utf8");
    const p = parse(text, { customTags });
    const P = p.Resources;
    for (const id of ["CognitoEmailKey", "CognitoEmailLogGroup", "CognitoEmailRole", "CognitoEmailFunction", "CognitoEmailPermission", "CognitoEmailInvokeConfig"]) assert.equal(P[id].Condition, "HasCustomSender", id);
    assert.deepEqual([p.Parameters.CodeKey.Default, p.Parameters.ScwProjectId.Default], ["", ""], "sans paramètres, Cognito envoie par SES comme avant");
    const set = (ref) => ({ "Fn::Not": [{ "Fn::Equals": [{ Ref: ref }, ""] }] });
    assert.deepEqual(p.Conditions.HasCustomSender, { "Fn::And": [{ Condition: "HasAccounts" }, set("CodeKey"), set("ScwProjectId")] });
    assert.ok(p.Rules.SenderNeedsCode, "un projet Scaleway sans paquet Lambda est refusé au déploiement");
    // le groupe : déclencheur « custom email sender » (V1_0) et clé KMS de la pile, seulement avec la condition
    const lc = P.UserPool.Properties.LambdaConfig["Fn::If"];
    assert.deepEqual(lc, ["HasCustomSender", { CustomEmailSender: { LambdaArn: { "Fn::GetAtt": ["CognitoEmailFunction", "Arn"] }, LambdaVersion: "V1_0" }, KMSKeyID: { "Fn::GetAtt": ["CognitoEmailKey", "Arn"] } }, { Ref: "AWS::NoValue" }]);
    // la fonction : même archive, point d'entrée du build, variables que le code lit ; la clé Scaleway reste dans SSM
    const fn = P.CognitoEmailFunction.Properties;
    const build = readFileSync(join(ROOT, "scripts/build-lambda.mjs"), "utf8");
    assert.equal(fn.Handler, build.match(/cognitoEmail: "([^"]+)"/)[1]);
    assert.equal(fn.Runtime, `nodejs${build.match(/target: "node(\d+)"/)[1]}.x`);
    assert.deepEqual(fn.Code, { S3Bucket: { Ref: "CodeBucket" }, S3Key: { Ref: "CodeKey" } });
    const code = readFileSync(join(ROOT, "server/cognito-email.mjs"), "utf8") + readFileSync(join(ROOT, "server/lib/secrets.mjs"), "utf8");
    for (const v of ["KEY_ARN", "SSM_PREFIX", "SCW_PROJECT_ID", "SCW_REGION", "EMAIL_FROM", "CONTACT", "LOG_LEVEL"]) {
      assert.ok(Object.hasOwn(fn.Environment.Variables, v), v);
      assert.ok(code.includes(`env.${v}`), `${v} lu par la fonction`);
    }
    assert.deepEqual(fn.Environment.Variables.EMAIL_FROM, { Ref: "CognitoEmailFrom" });
    for (const name of Object.keys(fn.Environment.Variables)) assert.ok(!/PEPPER|SECRET|TOKEN|PASSWORD|ACCESS_KEY/i.test(name), name);
    // rôle : son journal, le déchiffrement par la clé de la pile, la clé Scaleway dans SSM — rien d'autre, jamais « * »
    const st = P.CognitoEmailRole.Properties.Policies.flatMap((x) => x.PolicyDocument.Statement);
    assert.deepEqual(st.map((s) => [].concat(s.Action).join(",")).sort(), ["kms:Decrypt", "logs:CreateLogStream,logs:PutLogEvents", "ssm:GetParameters"]);
    assert.deepEqual(st.find((s) => s.Action === "kms:Decrypt").Resource, { "Fn::GetAtt": ["CognitoEmailKey", "Arn"] });
    assert.match(st.find((s) => s.Action === "ssm:GetParameters").Resource["Fn::Sub"], /:parameter\$\{SsmPrefix\}SCW_SECRET_KEY$/);
    for (const s of st) assert.ok(s.Effect === "Allow" && ![].concat(s.Resource).includes("*"), s.Sid);
    // clé : symétrique, rotation ; Cognito chiffre pour ce compte seulement ; sinon l'administration du compte
    const key = P.CognitoEmailKey.Properties;
    assert.deepEqual([key.KeySpec, key.KeyUsage, key.EnableKeyRotation], ["SYMMETRIC_DEFAULT", "ENCRYPT_DECRYPT", true]);
    assert.equal(key.KeyPolicy.Statement.length, 2);
    const cognito = key.KeyPolicy.Statement.find((s) => s.Principal.Service === "cognito-idp.amazonaws.com");
    assert.deepEqual([cognito.Action, cognito.Condition], [["kms:Encrypt", "kms:GenerateDataKey"], { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } }]);
    // seul le groupe d'utilisateurs de la pile peut appeler la fonction
    const perm = P.CognitoEmailPermission.Properties;
    assert.deepEqual([perm.Principal, perm.SourceArn, perm.SourceAccount], ["cognito-idp.amazonaws.com", { "Fn::GetAtt": ["UserPool", "Arn"] }, { Ref: "AWS::AccountId" }]);
    // appel asynchrone : deux nouvelles tentatives au plus, jamais un code de plus de 5 minutes
    const retry = P.CognitoEmailInvokeConfig;
    assert.equal(retry.Condition, "HasCustomSender");
    assert.deepEqual([retry.Properties.FunctionName, retry.Properties.Qualifier, retry.Properties.MaximumRetryAttempts], [{ Ref: "CognitoEmailFunction" }, "$LATEST", 2]);
    assert.ok(retry.Properties.MaximumEventAgeInSeconds >= 60 && retry.Properties.MaximumEventAgeInSeconds <= 300);
    // une panne ne s'affiche pas sur la page : alarme dès la première erreur de la fonction, vers le sujet donné ; rien sans sujet
    const alarm = P.CognitoEmailErrorsAlarm;
    assert.equal(alarm.Condition, "HasSenderAlarm");
    assert.deepEqual(p.Conditions.HasSenderAlarm, { "Fn::And": [{ Condition: "HasCustomSender" }, set("AlarmTopicArn")] });
    assert.equal(p.Parameters.AlarmTopicArn.Default, "");
    const a = alarm.Properties;
    assert.deepEqual([a.Namespace, a.MetricName, a.Dimensions, a.Statistic], ["AWS/Lambda", "Errors", [{ Name: "FunctionName", Value: { Ref: "CognitoEmailFunction" } }], "Sum"]);
    assert.deepEqual([a.Threshold, a.ComparisonOperator, a.TreatMissingData, a.AlarmActions], [1, "GreaterThanOrEqualToThreshold", "notBreaching", [{ Ref: "AlarmTopicArn" }]]);
    assert.match("arn:aws:sns:eu-north-1:123456789012:pixcar-alarms", new RegExp(p.Parameters.AlarmTopicArn.AllowedPattern));
  });
});
