#!/usr/bin/env python3
"""Mutations sur le serveur, le magasin de réparations et le client HTTP : voir lib.py (même principe, sans navigateur).

  python3 tests/mutation/mut_node.py              toutes
  python3 tests/mutation/mut_node.py jeton retry  seulement celles dont le nom contient un de ces mots
  python3 tests/mutation/mut_node.py --anchors    vérifie que chaque ancre existe encore
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run_node

V, APP, UNIT, SRV = "server/lib/validate.mjs", "server/app.mjs", "tests/unit", "server/test"
REPO, HTTP, STORE, CLIENT = "server/repo.mjs", "server/lib/http.mjs", "src/js/modules/repair-store.js", "src/js/modules/api-client.js"
CFN = "infra/pixcar-api.yaml"
BUILD, LEGAL = "scripts/build.mjs", "src/partials/legal.html"
M = [
 # ---- validation des déclarations
 ("price: under 1 € accepted (the database refuses it)", V, "price < PRICE_MIN ||", "price <= 0 ||", SRV, ["validate"]),
 ("price: no upper bound", V, "price > PRICE_MAX)", "price > PRICE_MAX * 10)", SRV, ["validate"]),
 ("date in the future accepted", V, "else if (date > today)", "else if (false)", SRV, ["validate"]),
 ("rating 0 accepted", V, "rating < 1 || rating > 5", "rating < 0 || rating > 5", SRV, ["validate"]),
 ("plate format not checked", V, "if (!PLATE_RE.test(plate)) bad(", "if (false) bad(", SRV, ["validate"]),
 ("control characters kept in the comment", V, 'body.comment.replace(CONTROL, "").trim()', "body.comment.trim()", SRV, ["validate"]),
 ("model year after the repair date accepted", V, "else if (isRealDate(date) && year > +date.slice(0, 4))", "else if (false)", SRV, ["validate"]),
 ("identifier not required to be a UUID v4", V, "-4[0-9a-f]{3}-[89ab]", "-[0-9a-f]{4}-[89ab]", SRV, ["validate"]),
 # ---- écriture, lecture et suppression
 ("delete: any token deletes", REPO, "AND delete_token_hash = $2 RETURNING id", "AND ($2::text IS NOT NULL) RETURNING id", SRV, ["api"]),
 ("replay: any token is recognised", REPO, "if (known) return known.delete_token_hash === ctx.tokenHash ?", "if (known) return true ?", SRV, ["api"]),
 ("per-address limit off by one", REPO, "if (perIp.n >= ctx.limitPerHour)", "if (perIp.n > ctx.limitPerHour)", SRV, ["api"]),
 ("global limit off by one", REPO, "if (global.n >= ctx.limitGlobalPerMinute)", "if (global.n > ctx.limitGlobalPerMinute)", SRV, ["api"]),
 ("moderation never triggers (needs 500 declarations)", REPO, 'if (n < 5) return "approved";', 'if (n < 500) return "approved";', SRV, ["api"]),
 ("moderation ignores prices far below the median", REPO, "(priceCents < med / 3 || priceCents > med * 3)", "(priceCents > med * 3)", SRV, ["api"]),
 ("pending and rejected declarations are listed", REPO, "WHERE r.status = 'approved' AND g.area_y BETWEEN $1 AND $2", "WHERE g.area_y BETWEEN $1 AND $2", SRV, ["api"]),
 ("no cap on declarations per garage and service", REPO, "export const MAX_PER_GARAGE_SERVICE = 30;", "export const MAX_PER_GARAGE_SERVICE = 3000;", SRV, ["api"]),
 ("plate hash differs from the one forget computes", APP, "hmac(config.plateSecret, v.plate)", 'hmac(config.plateSecret, v.plate + "!")', SRV, ["moderate"]),
 ("a refused value counts as a database failure", APP, "if (isDataError(e)) {\n          failures = 0;", "if (false) {\n          failures = 0;", SRV, ["api"]),
 ("a refused value is a retried 503 instead of a final 422", APP, 'const isDataError = (e) => /^(22|23)/.test(String((e && e.code) || ""));', "const isDataError = (e) => false;", SRV, ["api"]),
 ("any radius accepted", APP, "if (!RADII_KM.includes(radius))", "if (false)", SRV, ["api"]),
 ("wrong token says 403 instead of 404", APP, 'headers: { "cache-control": "no-store" } }) : apiError(404,', 'headers: { "cache-control": "no-store" } }) : apiError(403,', SRV, ["api"]),
 ("client address read from the left of X-Forwarded-For", APP, "return hops[hops.length - mode];", "return hops[0];", SRV, ["api"]),
 ("Turnstile skipped even with a secret", APP, 'if (!config.turnstileSecret) return "ok";', 'return "ok";', SRV, ["api"]),
 ("stale copy never served when the database is down", APP, "if (hit && now() - hit.at < AREA_STALE_MS) {", "if (false) {", SRV, ["api"]),
 ("readyz answers 200 when the database is down", APP, 'json(503, { ok: false, db: "down" }', 'json(200, { ok: false, db: "down" }', SRV, ["api"]),
 ("readyz answers 200 while draining", APP, "if (draining) return json(503,", "if (false) return json(503,", SRV, ["api", "index"]),
 ("no stale-if-error on area reads", APP, "stale-while-revalidate=300, stale-if-error=86400", "stale-while-revalidate=300", SRV, ["api"]),
 ("ETag never matches (no 304)", HTTP, 'if (request.headers.get("if-none-match") === etag)', "if (false)", SRV, ["api", "index"]),
 ("any origin allowed by CORS", HTTP, 'if (origin && (allowed.includes("*") || allowed.includes(origin))) {', "if (origin) {", SRV, ["api"]),
 ("compression off", "server/lib/compress.mjs", "if (alreadyEncoded || body.length < 1024 || !COMPRESSIBLE.test(type)) return null;", "return null;", SRV, ["index", "compress", "lambda"]),
 ("weak secret accepted in production", "server/config.mjs", "if (v && v.length >= 16) return v;", "if (v && v.length >= 1) return v;", SRV, ["config"]),
 # ---- Aurora DSQL (pilote, migrations, rôle de base)
 ("DSQL: connections live past the 60-minute limit", "server/db.mjs", "maxLifetimeSeconds: 50 * 60, ", "", SRV, ["dsql"]),
 ("DSQL: a conflict of optimistic concurrency is not replayed", "server/db.mjs", "if (!isConflict(e) || attempt >= retries) throw e;", "throw e;", SRV, ["dsql"]),
 ("DSQL: a schema conflict (OC001) is not recognised", "server/db.mjs", r"/\b(OC000|OC001)\b/", r"/\b(OC000)\b/", SRV, ["dsql"]),
 ("DSQL migration: indexes are not asynchronous", "server/lib/sql.mjs", "INDEX ASYNC IF NOT EXISTS ${m[2]}", "INDEX IF NOT EXISTS ${m[2]}", SRV, ["dsql"]),
 ("DSQL migration: DESC kept in the index columns", "server/lib/sql.mjs", r'.replace(/\s+(ASC|DESC)\b/gi, "")', r'.replace(/\s+(ASC)\b/gi, "")', SRV, ["dsql"]),
 ("DSQL migration: the index build is not waited for", "server/migrate.mjs", "if (jobId) await waitForJob(", "if (false) await waitForJob(", SRV, ["dsql"]),
 ("DSQL migration: the wait for an index logs every second", "server/migrate.mjs", "if (job && job.status !== announced) log(", "if (job) log(", SRV, ["dsql"]),
 ("DSQL migration: a failed index build is ignored", "server/migrate.mjs", 'if (job && job.status === "failed") throw', "if (false) throw", SRV, ["dsql"]),
 ("DSQL role: any IAM role ARN accepted", "server/migrate.mjs", "if (!/^arn:aws:iam::", "if (false && /^arn:aws:iam::", SRV, ["dsql"]),
 ("DSQL role: a refused step is reported without its name", "server/migrate.mjs", "new Error(`${label} : ${e.message}`)", "new Error(e.message)", SRV, ["dsql"]),
 ("DSQL role: an existing link is granted again", "server/migrate.mjs", "if (linked) steps.push(", "if (false) steps.push(", SRV, ["dsql"]),
 ("DSQL role: any link of the role counts, whatever its IAM role", "server/migrate.mjs", "WHERE pg_role_name = $1 AND arn = $2", "WHERE pg_role_name = $1 AND $2 = $2", SRV, ["dsql"]),
 # ---- fonction Lambda et opérations
 ("Lambda: the visitor's X-Forwarded-For is trusted", "server/lambda.mjs", "!CLIENT_ADDRESS_HEADERS.has(name.toLowerCase())", "true", SRV, ["lambda"]),
 ("Lambda: the address reported by API Gateway is ignored", "server/lambda.mjs", "remoteIp: event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp", "remoteIp: undefined", SRV, ["lambda"]),
 ("Lambda: a base64 request body is not decoded", "server/lambda.mjs", 'event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body', "event.body", SRV, ["lambda"]),
 ("Lambda: a failed start is kept for good", "server/lambda.mjs", "starting = null; // un démarrage raté se réessaie à l'invocation suivante", "", SRV, ["lambda"]),
 ("ops: any property name is an operation", "server/ops.mjs", "if (!Object.hasOwn(operations, String(op)))", "if (false)", SRV, ["ops"]),
 ("ops: approve accepts any string as an identifier", "server/ops.mjs", 'approve: (e) => withDb((db) => runModerate(["approve", ...list(e.ids, "ids", isUuid)], db)),', 'approve: (e) => withDb((db) => runModerate(["approve", ...list(e.ids, "ids", () => true)], db)),', SRV, ["ops"]),
 # ---- modèle CloudFormation (contrat avec le code, droits, suppression de la base)
 ("infra: the API role can administer the database", CFN, 'Action: "dsql:DbConnect", Resource', 'Action: "dsql:DbConnectAdmin", Resource', SRV, ["infra"]),
 ("infra: the database is deleted with the stack", CFN, "    Type: AWS::DSQL::Cluster\n    DeletionPolicy: Retain\n", "    Type: AWS::DSQL::Cluster\n    DeletionPolicy: Delete\n", SRV, ["infra"]),
 ("infra: deletion protection is off", CFN, "DeletionProtectionEnabled: true", "DeletionProtectionEnabled: false", SRV, ["infra"]),
 ("infra: the gateway's address is read from a header (TRUST_PROXY=1)", CFN, 'TRUST_PROXY: "0"', 'TRUST_PROXY: "1"', SRV, ["infra"]),
 ("infra: the plate secret sits in the function configuration", CFN, '          REQUEST_TIMEOUT_MS: "10000"', '          PLATE_PEPPER: "0123456789abcdef0123"\n          REQUEST_TIMEOUT_MS: "10000"', SRV, ["infra"]),
 ("infra: the API role reads every parameter under the prefix", CFN, '${AWS::AccountId}:parameter${SsmPrefix}IP_PEPPER"', '${AWS::AccountId}:parameter${SsmPrefix}*"', SRV, ["infra"]),
 ("infra: the function gives up before the gateway", CFN, "      Timeout: 15\n", "      Timeout: 5\n", SRV, ["infra"]),
 ("infra: the daily maintenance calls an unknown operation", CFN, """Input: '{"op":"purge"}'""", """Input: '{"op":"clean"}'""", SRV, ["infra"]),
 ("infra: the API function points to another handler", CFN, "Handler: api.handler", "Handler: index.handler", SRV, ["infra"]),
 ("infra: the scheduler may invoke any function", CFN, 'Action: "lambda:InvokeFunction", Resource: !GetAtt OpsFunction.Arn }', 'Action: "lambda:InvokeFunction", Resource: "*" }', SRV, ["infra"]),
 ("infra: the operations function runs with the API role", CFN, "Role: !GetAtt OpsRole.Arn", "Role: !GetAtt ApiRole.Arn", SRV, ["infra"]),
 ("infra: the database role of the API is bound to the operations role", CFN, "API_ROLE_ARN: !GetAtt ApiRole.Arn", "API_ROLE_ARN: !GetAtt OpsRole.Arn", SRV, ["infra"]),
 ("infra: the operations function looks for migrations elsewhere than in the package", CFN, "MIGRATIONS_DIR: /var/task/db/migrations", "MIGRATIONS_DIR: /var/db/migrations", SRV, ["infra"]),
 ("infra: a parameter nobody reads", CFN, "ThrottlingBurstLimit: !Ref ThrottleBurst", "ThrottlingBurstLimit: 100", SRV, ["infra"]),
 ("infra: an unconditional output reads a conditional resource", CFN, "  CustomDomainTarget:\n    Condition: HasDomain\n", "  CustomDomainTarget:\n", SRV, ["infra"]),
 ("infra: the backup vault is deleted with the stack", CFN, "    Type: AWS::Backup::BackupVault\n    Condition: HasBackup\n    DeletionPolicy: Retain\n", "    Type: AWS::Backup::BackupVault\n    Condition: HasBackup\n    DeletionPolicy: Delete\n", SRV, ["infra"]),
 ("infra: recovery points are kept one day whatever the parameter says", CFN, "Lifecycle: { DeleteAfterDays: !Ref BackupRetentionDays }", "Lifecycle: { DeleteAfterDays: 1 }", SRV, ["infra"]),
 ("infra: the backup selection protects another resource than the database", CFN, "Resources: [!GetAtt Cluster.ResourceArn]", "Resources: [!GetAtt ApiFunction.Arn]", SRV, ["infra"]),
 ("infra: any service can assume the backup role", CFN, "Principal: { Service: backup.amazonaws.com }", 'Principal: { Service: "*" }', SRV, ["infra"]),
 ("infra: the backup runs weekly, not daily", CFN, 'Default: "cron(30 2 * * ? *)"', 'Default: "cron(30 2 ? * MON *)"', SRV, ["infra"]),
 ("infra: backups are off unless asked for", CFN, "    Default: 30\n    AllowedValues: [0, 7, 14, 30, 35, 60, 90, 180, 365]", "    Default: 0\n    AllowedValues: [0, 7, 14, 30, 35, 60, 90, 180, 365]", SRV, ["infra"]),
 ("infra: a backup resource exists whatever the retention", CFN, "  BackupSelection:\n    Type: AWS::Backup::BackupSelection\n    Condition: HasBackup\n", "  BackupSelection:\n    Type: AWS::Backup::BackupSelection\n", SRV, ["infra"]),
 # ---- mentions légales : texte, durées annoncées, garde du build
 ("legal: the API can be opened to the public without the notice", BUILD, 'if ((apiBase || analytics || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")', "if (false)", SRV, ["legal"]),
 ("legal: the trial switch is always on", BUILD, '(apiBase || analytics || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1"', "(apiBase || analytics || mapbox) && false", SRV, ["legal"]),
 ("legal: an incomplete file builds the window anyway", BUILD, "if (problems.length) {\n    if ((apiBase", "if (false) {\n    if ((apiBase", SRV, ["legal"]),
 ("legal: any contact is accepted", BUILD, 'if (filled("contact") && !', 'if (false && !', SRV, ["legal"]),
 ("legal: a retention that is not a whole number of months is accepted", BUILD, 'if (filled("repairRetentionMonths") && !(', 'if (false && !(', SRV, ["legal"]),
 ("legal: the editor's text is inserted as HTML", BUILD, "return esc(String(config[k]).trim());", "return String(config[k]).trim();", SRV, ["legal"]),
 ("legal: an unknown variable in the text is left blank", BUILD, "if (!LEGAL_FIELDS.includes(k)) throw", "if (false) throw", SRV, ["legal"]),
 ("legal: the link of the declaration form is shown without the API too", BUILD, "linkDialog: '<p class=\"dlg-note\" data-store-only=\"remote\">", "linkDialog: '<p class=\"dlg-note\">", SRV, ["legal"]),
 ("legal: the link at the bottom of the panel opens nothing", BUILD, "data-open-legal>Confidentialité et mentions légales", ">Confidentialité et mentions légales", SRV, ["legal"]),
 ("legal: the link of the sources opens nothing", BUILD, "data-open-legal>Lire la politique", ">Lire la politique", SRV, ["legal"]),
 ("legal: the text announces another retention for IP fingerprints", LEGAL, "Empreintes d'adresses IP&nbsp;: 30 jours", "Empreintes d'adresses IP&nbsp;: 90 jours", SRV, ["legal"]),
 ("legal: the text announces another retention for backups", LEGAL, "Sauvegardes de la base&nbsp;: 30 jours", "Sauvegardes de la base&nbsp;: 7 jours", SRV, ["legal"]),
 ("legal: the code purges the write log later than announced", REPO, "FROM write_log WHERE at < now() - interval '30 days'", "FROM write_log WHERE at < now() - interval '60 days'", SRV, ["legal"]),
 ("legal: the page contacts a service the text does not name", BUILD, '"https://query.wikidata.org"];', '"https://query.wikidata.org", "https://nouveau.exemple.test"];', SRV, ["legal"]),
 ("legal: the text no longer names a mirror the page still queries", LEGAL, "(overpass-api.de, OpenStreetMap France)", "(overpass-api.de)", SRV, ["legal"]),
 # ---- conservation des déclarations (durée annoncée = durée appliquée)
 ("retention: the purge never deletes declarations", REPO, "repairs: cutoff ? await deleteInBatches", "repairs: false ? await deleteInBatches", SRV, ["repo-portable"]),
 ("retention: the cutoff is inverted (the recent declarations go)", REPO, "WHERE created_at < $2::timestamptz LIMIT $1", "WHERE created_at > $2::timestamptz LIMIT $1", SRV, ["repo-portable"]),
 ("retention: zero months deletes everything", REPO, "if (!Number.isInteger(months) || months <= 0) return null;", "if (!Number.isInteger(months) || months < 0) return null;", SRV, ["repo-portable"]),
 ("retention: a month is 28 days", REPO, "d.setUTCMonth(d.getUTCMonth() - months);", "d.setTime(d.getTime() - months * 28 * 86400000);", SRV, ["repo-portable"]),
 ("retention: the operations function ignores the setting", "server/ops.mjs", "purge({ repairRetentionMonths: repairRetentionMonths(env) })", "purge({ repairRetentionMonths: 0 })", SRV, ["ops"]),
 ("retention: the server maintenance ignores the setting", APP, "repo.purge({ repairRetentionMonths: config.repairRetentionMonths })", "repo.purge()", SRV, ["api"]),
 ("retention: the server keeps declarations 36 months by default", "server/config.mjs", "int(env.REPAIR_RETENTION_MONTHS, 24, 0)", "int(env.REPAIR_RETENTION_MONTHS, 36, 0)", SRV, ["config", "legal"]),
 ("retention: the stack keeps declarations 12 months by default", CFN, "    Default: 24\n    MinValue: 0\n    MaxValue: 120", "    Default: 12\n    MinValue: 0\n    MaxValue: 120", SRV, ["legal"]),
 ("retention: the operations function does not receive the setting", CFN, "          REPAIR_RETENTION_MONTHS: !Ref RepairRetentionMonths\n", "", SRV, ["infra"]),
 ("retention: the notice announces 36 months", "src/legal.json", '"repairRetentionMonths": 24', '"repairRetentionMonths": 36', SRV, ["legal"]),
 ("ops: MIGRATIONS_DIR is ignored (the bundle looks for db/migrations next to itself)", "server/ops.mjs", "env.MIGRATIONS_DIR || MIGRATIONS_DIR", "MIGRATIONS_DIR", SRV, ["ops"]),
 # ---- SQL portable (PostgreSQL = DSQL)
 ("purge stops after one batch", REPO, "if (rowCount < PURGE_BATCH) break;", "break;", SRV, ["repo-portable"]),
 ("median of an even count reads one value", REPO, "n % 2 ? 1 : 2", "1", SRV, ["repo-portable"]),
 ("the exact day is published instead of the month", REPO, "month: String(r.day).slice(0, 7)", "month: String(r.day)", SRV, ["repo-portable", "api"]),
 # ---- relais Overpass
 ("stale Overpass copy served for 7 hours instead of 7 days", "server/lib/overpass.mjs", "staleSeconds = 7 * 24 * 3600,", "staleSeconds = 7 * 3600,", SRV, ["overpass"]),
 ("no cap on simultaneous upstream requests", "server/lib/overpass.mjs", "maxConcurrent = 4,", "maxConcurrent = 4000,", SRV, ["overpass"]),
 ("upstream misses not limited per visitor", "server/lib/overpass.mjs", "(onMiss && !onMiss())", "false", SRV, ["overpass", "api"]),
 # ---- magasin de réparations (page)
 ("give-up delay shortened to 7 hours", STORE, "const GIVE_UP_MS = 7 * 864e5;", "const GIVE_UP_MS = 7 * 864e3;", UNIT, ["repair-store"]),
 ("429 retried after one second", STORE, "Math.max(60, res.retryAfter || 0)", "Math.max(1, res.retryAfter || 0)", UNIT, ["repair-store"]),
 ("rows saved before the API are uploaded", STORE, 'r.sync = "local"; // enregistrées avant l\'API', 'r.sync = "pending"; // enregistrées avant l\'API', UNIT, ["repair-store"]),
 ("duplicate: the local copy is kept", STORE, "own.splice(own.indexOf(row), 1);", "", UNIT, ["repair-store"]),
 ("undo of a deletion does not post again", STORE, 'if (row.sync === "pending" && !hasOp("post", row.id)) enqueue({ op: "post", id: row.id });', "", UNIT, ["repair-store"]),
 ("deleting a sent row does not queue a DELETE", STORE, 'if (!neverSent(post)) enqueue({ op: "delete", id, token: row.deleteToken });', "", UNIT, ["repair-store"]),
 ("saved areas never expire (7 days → 7 minutes)", STORE, "const AREA_MAX_AGE_MS = 7 * 864e5;", "const AREA_MAX_AGE_MS = 7 * 6e4;", UNIT, ["repair-store"]),
 ("back-off ceiling removed", STORE, "const BACKOFF_MAX_MS = 15 * 60_000;", "const BACKOFF_MAX_MS = 15 * 60_000_000;", UNIT, ["repair-store"]),
 ("429 treated as a final refusal", STORE, 'if (res.status === 429 || res.kind === "network" || res.kind === "timeout" || res.status >= 500) {', 'if (res.kind === "network" || res.kind === "timeout" || res.status >= 500) {', UNIT, ["repair-store"]),
 # ---- client HTTP
 ("circuit breaker needs 30 failures", CLIENT, "breaker = { threshold: 3, cooldownMs: 30_000 }", "breaker = { threshold: 30, cooldownMs: 30_000 }", UNIT, ["api-client"]),
 ("500 retried like 502/503/504", CLIENT, "const RETRYABLE_STATUS = new Set([502, 503, 504]);", "const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);", UNIT, ["api-client"]),
 ("Retry-After not capped", CLIENT, 'Math.min(60, Number(res.headers.get("retry-after")) || 0)', 'Math.min(6000, Number(res.headers.get("retry-after")) || 0)', UNIT, ["api-client"]),
 ("a success does not reset the failure count", CLIENT, "failures = 0; // le serveur répond : un 4xx est notre erreur, pas la sienne", "", UNIT, ["api-client"]),
 ("cookies sent to the API", CLIENT, 'credentials: "omit"', 'credentials: "include"', UNIT, ["api-client"]),
]
run_node(M, 56)
