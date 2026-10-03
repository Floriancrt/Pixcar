// Applique les fichiers db/migrations/NNN_nom.sql pas encore appliqués, dans l'ordre.
//  - PostgreSQL / PGlite : chaque fichier dans UNE transaction ; sûr si plusieurs instances démarrent en même temps (verrou consultatif).
//  - Aurora DSQL : une instruction de structure par transaction (règle de DSQL), « CREATE INDEX ASYNC » dont on attend la fin (le
//    dédoublonnage repose sur un index unique : il doit être prêt avant la première écriture), instructions relançables sans erreur
//    (IF NOT EXISTS) si une migration a été interrompue en route. Pas de verrou : ne lancer qu'une migration à la fois.
//   DATABASE_URL=postgres://… node server/migrate.mjs
//   DSQL_ENDPOINT=xxxx.dsql.eu-north-1.on.aws node server/migrate.mjs      (identifiants AWS du shell ; rôle « admin »)
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, withRetry } from "./db.mjs";
import { isIndexStatement, splitStatements, toDsqlStatement } from "./lib/sql.mjs";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
export const APP_TABLES = ["garages", "repairs", "write_log", "upstream_cache"];

export async function migrate(db, dir = MIGRATIONS_DIR, log = () => {}, { pollMs = 1000, timeoutMs = 600_000 } = {}) {
  // une session dédiée : le verrou est pris et rendu sur la même connexion, et aucun délai de requête ne coupe une migration longue
  return db.session(async (s) => {
    await s.lock(727_274);
    try {
      await s.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await s.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
      const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
      const applied = [];
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(join(dir, file), "utf8");
        if (db.kind === "dsql") {
          await applyOnDsql(s, sql, log, { pollMs, timeoutMs });
          await s.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        } else {
          await s.tx(async (t) => {
            await t.exec(sql);
            await t.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
          });
        }
        log(`migration appliquée : ${file}`);
        applied.push(file);
      }
      return applied;
    } finally {
      await s.unlock(727_274);
    }
  });
}

async function applyOnDsql(s, sql, log, { pollMs, timeoutMs }) {
  for (const raw of splitStatements(sql)) {
    const statement = toDsqlStatement(raw);
    if (isIndexStatement(statement)) {
      const { rows } = await withRetry(() => s.query(statement)); // renvoie job_id (rien si l'index existe déjà)
      const jobId = rows && rows[0] && rows[0].job_id;
      if (jobId) await waitForJob(s, jobId, { pollMs, timeoutMs }, log);
    } else {
      await withRetry(() => s.exec(statement));
    }
  }
}

// Attend la fin d'une construction d'index asynchrone (sys.jobs : submitted → processing → completed | failed).
export async function waitForJob(s, jobId, { pollMs = 1000, timeoutMs = 600_000, wait = sleep } = {}, log = () => {}) {
  const t0 = Date.now();
  let unseen = 0;
  let announced = "";
  for (;;) {
    const { rows } = await s.query("SELECT status, details FROM sys.jobs WHERE job_id = $1", [jobId]);
    const job = rows[0];
    if (job && job.status === "completed") return;
    if (job && job.status === "failed") throw new Error(`construction d'index échouée (${jobId}) : ${job.details || "sans détail"} — supprimer l'index (DROP INDEX) puis relancer`);
    if (!job && ++unseen > 30) throw new Error(`tâche d'index ${jobId} introuvable dans sys.jobs`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`construction d'index trop longue (${jobId})`);
    if (job && job.status !== announced) log(`index en construction (${(announced = job.status)})…`); // une ligne par changement d'état, pas une par seconde
    await wait(pollMs);
  }
}

// Rôle de base à moindre privilège pour l'API (DSQL) : AWS recommande de ne pas faire tourner l'application sous « admin ».
// À lancer sous « admin », APRÈS les migrations (GRANT exige que les tables existent) ; relançable sans erreur.
// Le rôle IAM est celui de la fonction de l'API ; la base ne lui accorde que le strict nécessaire sur les tables de l'application.
export async function ensureRuntimeRole(db, { role = "pixcar_api", iamRoleArn, tables = APP_TABLES } = {}, log = () => {}) {
  if (db.kind !== "dsql") return { skipped: "rôles de base réservés à Aurora DSQL" };
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`nom de rôle invalide : ${role}`);
  if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/.test(String(iamRoleArn || ""))) throw new Error("ARN du rôle IAM de l'API invalide ou absent");
  for (const t of tables) if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`nom de table invalide : ${t}`);
  return db.session(async (s) => {
    const steps = [];
    // ignore(e) renvoie la note à consigner quand l'échec est acceptable (rien sinon) ; toute autre erreur nomme l'étape qui l'a causée
    const run = async (label, sql, ignore = () => "") => {
      try {
        await withRetry(() => s.exec(sql));
        steps.push(`${label} : fait`);
      } catch (e) {
        const note = ignore(e);
        if (!note) throw Object.assign(new Error(`${label} : ${e.message}`), { code: e.code, cause: e });
        steps.push(`${label} : ${note}`);
      }
    };
    const already = (e) => (e.code === "42710" || /already|exists/i.test(e.message) ? "déjà en place" : "");
    await run("création du rôle", `CREATE ROLE ${role} WITH LOGIN`, already);
    // Le lien existe-t-il déjà ? Vue documentée de DSQL (sys.iam_pg_role_mappings : arn, pg_role_name). Si elle manque ou change,
    // on tente le lien quand même et on tolère « déjà en place » : cette vérification ne sert qu'à ne pas dépendre du texte d'une erreur.
    const linked = await Promise.resolve()
      .then(() => s.query("SELECT 1 AS ok FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2", [role, iamRoleArn]))
      .then((r) => r.rows.length > 0, () => false);
    if (linked) steps.push("lien avec le rôle IAM : déjà en place");
    else await run("lien avec le rôle IAM", `AWS IAM GRANT ${role} TO '${iamRoleArn}'`, already);
    // Pas de « GRANT USAGE ON SCHEMA public » : la documentation de DSQL le montre pour un schéma créé par l'utilisateur, mais pour
    // « public » (schéma système) la vraie base répond « feature not supported on system entity » (constaté le 3 octobre 2026), et le
    // rôle accède aux tables sans lui (essai de bout en bout réussi : scripts/smoke-api.mjs sur l'API déployée).
    await run("droits sur les tables", `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(", ")} TO ${role}`);
    steps.forEach((m) => log(m));
    return steps;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dsql = process.env.DSQL_ENDPOINT ? { endpoint: process.env.DSQL_ENDPOINT, user: process.env.DSQL_USER || "admin" } : null;
  const db = await createDb({ url: process.env.DATABASE_URL || "", dsql, log: console.error });
  try {
    const applied = await migrate(db, MIGRATIONS_DIR, console.log);
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : "base à jour");
    if (dsql && process.env.API_ROLE_ARN) await ensureRuntimeRole(db, { iamRoleArn: process.env.API_ROLE_ARN }, console.log);
  } finally {
    await db.close();
  }
}
