// Opérations d'exploitation de l'API Pixcar sur AWS, invoquées avec « aws lambda invoke » : la base Aurora DSQL n'est joignable que
// depuis AWS (le protocole PostgreSQL ne passe pas par les proxys HTTPS), et les droits d'administration restent dans AWS (rôle IAM de
// cette fonction : dsql:DbConnectAdmin), pas sur un poste de travail. Liste fermée d'opérations : jamais de SQL libre.
//
//   {"op":"migrate"}                      applique les migrations, puis crée / met à jour le rôle de base de l'API et ses droits
//   {"op":"stats"}                        nombre de déclarations par état
//   {"op":"list"}                         déclarations en attente de relecture (commentaires compris)
//   {"op":"approve","ids":["…"]}          rend publiques ces déclarations      ("reject" : ne sont jamais renvoyées)
//   {"op":"forget","plates":["AB-123-CD"]}  efface TOUTES les déclarations de ces plaques
//   {"op":"purge"}                        entretien (journal > 30 jours, cache Overpass > 14 jours, garages sans réparation > 7 jours)
//   {"op":"selfcheck"}                    rejoue sur la vraie base tout ce que demande l'application (voir selfcheck.mjs)
//   {"op":"whoami"}                       rôle de base et type de base utilisés
import { createDb } from "./db.mjs";
import { jsonLog } from "./lib/log.mjs";
import { readSecrets } from "./lib/secrets.mjs";
import { isUuid } from "./lib/validate.mjs";
import { MIGRATIONS_DIR, ensureRuntimeRole, migrate } from "./migrate.mjs";
import { moderate } from "./moderate.mjs";
import { createRepo } from "./repo.mjs";
import { selfcheck } from "./selfcheck.mjs";

const MAX_ITEMS = 50;
const list = (value, what, valid) => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) throw new Error(`« ${what} » : une liste de 1 à ${MAX_ITEMS} éléments est attendue`);
  for (const v of value) if (typeof v !== "string" || !valid(v)) throw new Error(`« ${what} » : valeur refusée (${JSON.stringify(v).slice(0, 40)})`);
  return value;
};

export function createOps({ openDb, env = process.env, log = () => {} }) {
  const withDb = async (fn) => {
    const db = await openDb();
    try {
      return await fn(db);
    } finally {
      await db.close().catch(() => {});
    }
  };
  const runModerate = (args, db, plateSecret = "") => {
    const lines = [];
    const push = (x) => lines.push(typeof x === "string" ? x : JSON.stringify(x));
    return moderate(args, { db, plateSecret, out: push, err: push }).then((code) => ({ code, lines }));
  };

  const operations = {
    migrate: () =>
      withDb(async (db) => {
        const applied = await migrate(db, env.MIGRATIONS_DIR || MIGRATIONS_DIR, (m) => log({ level: "info", msg: m }));
        const role = await ensureRuntimeRole(db, { iamRoleArn: env.API_ROLE_ARN }, (m) => log({ level: "info", msg: m }));
        return { applied, role };
      }),
    stats: () => withDb((db) => runModerate(["stats"], db)),
    list: () => withDb((db) => runModerate(["list"], db)),
    approve: (e) => withDb((db) => runModerate(["approve", ...list(e.ids, "ids", isUuid)], db)),
    reject: (e) => withDb((db) => runModerate(["reject", ...list(e.ids, "ids", isUuid)], db)),
    forget: (e) =>
      withDb(async (db) => {
        const plates = list(e.plates, "plates", (p) => p.length <= 20);
        const secrets = await readSecrets(env, { names: ["PLATE_PEPPER"] }); // seul le secret des plaques sert ici
        return runModerate(["forget", ...plates], db, secrets.PLATE_PEPPER || env.PLATE_PEPPER || "");
      }),
    purge: () => withDb(async (db) => ({ deleted: await createRepo(db).purge() })),
    selfcheck: () => withDb((db) => selfcheck(db, { log: (m) => log({ level: "info", msg: m }) })),
    whoami: () => withDb(async (db) => ({ db: db.kind, role: (await db.query("SELECT current_user AS who")).rows[0].who })),
  };

  return async (event) => {
    const op = event && event.op;
    try {
      if (!Object.hasOwn(operations, String(op))) throw new Error(`opération inconnue : ${JSON.stringify(op)} (${Object.keys(operations).join(", ")})`);
      log({ level: "info", msg: "opération", op });
      const out = await operations[op](event);
      return { ok: out.ok === undefined ? true : out.ok, op, ...out };
    } catch (e) {
      log({ level: "error", msg: "opération en échec", op, error: e.message });
      return { ok: false, op, error: e.message };
    }
  };
}

// Démarrage réel : la fonction se connecte à Aurora DSQL sous le rôle « admin » (une seule connexion suffit).
export const handler = createOps({
  openDb: () => {
    if (!process.env.DSQL_ENDPOINT) throw new Error("DSQL_ENDPOINT absent");
    return createDb({ dsql: { endpoint: process.env.DSQL_ENDPOINT, user: "admin", max: 1 }, log: (m) => console.error(m) });
  },
  log: jsonLog(process.env.LOG_LEVEL),
});
