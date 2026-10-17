// Opérations d'exploitation de l'API Pixcar sur AWS, invoquées avec « aws lambda invoke » : la base Aurora DSQL n'est joignable que
// depuis AWS (le protocole PostgreSQL ne passe pas par les proxys HTTPS), et les droits d'administration restent dans AWS (rôle IAM de
// cette fonction : dsql:DbConnectAdmin), pas sur un poste de travail. Liste fermée d'opérations : jamais de SQL libre.
//
//   {"op":"migrate"}                      applique les migrations, puis crée / met à jour le rôle de base de l'API et ses droits
//   {"op":"stats"}                        nombre de déclarations par état
//   {"op":"list"}                         déclarations en attente de relecture (commentaires compris)
//   {"op":"approve","ids":["…"]}          rend publiques ces déclarations      ("reject" : ne sont jamais renvoyées)
//   {"op":"forget","plates":["AB-123-CD"]}  efface TOUTES les déclarations de ces plaques
//   {"op":"purge"}                        entretien (journal > 30 jours, cache Overpass > 14 jours, déclarations plus vieilles que REPAIR_RETENTION_MONTHS,
//                                         garages sans réparation > 7 jours)
//   {"op":"selfcheck"}                    rejoue sur la vraie base tout ce que demande l'application (voir selfcheck.mjs)
//   {"op":"whoami"}                       rôle de base et type de base utilisés
// Espace Pro (contacts privés des garages, voir scripts/pro/push-contacts.mjs) :
//   {"op":"import-contacts","importId":"2026-10-11T08-00","rows":[…]}   écrit un lot de contacts (500 au plus), validés un par un
//   {"op":"prune-contacts","importId":"…"}                              retire les contacts que ce chargement complet n'a pas réécrits
//                                                                        (refusé si ce chargement compte moins de la moitié des lignes)
//   {"op":"pro-stats"}                                                  demandes par état, nombre de garages avec contacts
//   {"op":"pro-claims","garageId":"…"}                                  demandes et rattachement d'un garage (jamais la cible en clair)
//   {"op":"pro-revoke","garageId":"…"}                                  retire le rattachement vérifié d'un garage (vérification contestée) et ses prix
//   {"op":"pro-prices"}                                                 prix annoncés en attente de relecture (très éloignés des prix payés du secteur)
//   {"op":"pro-price","garageId":"…","serviceId":"…","status":"published"}  publie (« published ») ou refuse (« rejected ») un prix relu
//   {"op":"pro-changes"}                                                changements de nom, d'adresse ou de téléphone en attente de relecture
//   {"op":"pro-change","id":"…","decision":"approve"}                   publie un changement relu ; « reject » le refuse, avec « reason »
//                                                                        (300 caractères au plus, montré au garagiste)
import { repairRetentionMonths } from "./config.mjs";
import { createDb } from "./db.mjs";
import { jsonLog } from "./lib/log.mjs";
import { readSecrets } from "./lib/secrets.mjs";
import { isUuid } from "./lib/validate.mjs";
import { MIGRATIONS_DIR, ensureRuntimeRole, migrate } from "./migrate.mjs";
import { moderate } from "./moderate.mjs";
import { createRepo } from "./repo.mjs";
import { IMPORT_BATCH_MAX, createProRepo } from "./pro-repo.mjs";
import { parseContactRows } from "./lib/contact.mjs";
import { selfcheck } from "./selfcheck.mjs";
import { addrText, phoneText } from "../src/js/shared/garage-profile.js";

const MAX_ITEMS = 50;
const list = (value, what, valid) => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) throw new Error(`« ${what} » : une liste de 1 à ${MAX_ITEMS} éléments est attendue`);
  for (const v of value) if (typeof v !== "string" || !valid(v)) throw new Error(`« ${what} » : valeur refusée (${JSON.stringify(v).slice(0, 40)})`);
  return value;
};

const importIdOf = (v) => {
  if (typeof v !== "string" || !/^[\w.:-]{1,40}$/.test(v)) throw new Error("« importId » : identifiant du chargement attendu (lettres, chiffres, . : - _ ; 40 au plus)");
  return v;
};
const garageIdOf = (v) => {
  if (typeof v !== "string" || !/^[0-9a-f-]{8,40}$/.test(v)) throw new Error("« garageId » : identifiant Overture attendu");
  return v;
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
    purge: () =>
      withDb(async (db) => ({ deleted: { ...(await createRepo(db).purge({ repairRetentionMonths: repairRetentionMonths(env) })), ...(await createProRepo(db).purge()) } })),
    selfcheck: () => withDb((db) => selfcheck(db, { log: (m) => log({ level: "info", msg: m }) })),
    whoami: () => withDb(async (db) => ({ db: db.kind, role: (await db.query("SELECT current_user AS who")).rows[0].who })),
    "import-contacts": (e) => {
      const importId = importIdOf(e.importId);
      if (!Array.isArray(e.rows) || !e.rows.length || e.rows.length > IMPORT_BATCH_MAX) throw new Error(`« rows » : une liste de 1 à ${IMPORT_BATCH_MAX} contacts est attendue`);
      const { rows, rejected } = parseContactRows(e.rows);
      return withDb(async (db) => ({ written: await createProRepo(db).upsertContacts(rows, importId), rejected }));
    },
    "prune-contacts": (e) => {
      const importId = importIdOf(e.importId);
      return withDb(async (db) => {
        const repo = createProRepo(db);
        const { total, kept } = await repo.contactStats(importId);
        if (!kept || kept * 2 < total) throw new Error(`chargement ${importId} : ${kept} lignes sur ${total} ; moins de la moitié, suppression refusée (chargement incomplet ?)`);
        return { removed: await repo.pruneContacts(importId), kept };
      });
    },
    "pro-stats": () => withDb((db) => createProRepo(db).proStats()),
    "pro-claims": (e) => withDb(async (db) => ({ claims: await createProRepo(db).claimsOfGarage(garageIdOf(e.garageId)) })),
    "pro-revoke": (e) => withDb(async (db) => ({ revoked: await createProRepo(db).revoke(garageIdOf(e.garageId)) })),
    "pro-prices": () =>
      withDb(async (db) => ({
        review: (await createProRepo(db).pricesToReview()).map((p) => ({ garageId: p.garage_id, garageName: p.garage_name || "", serviceId: p.service_id, kind: p.kind, price: p.price_cents === null ? null : p.price_cents / 100, updatedAt: p.updated_at })),
      })),
    "pro-changes": () =>
      withDb(async (db) => ({
        review: (await createProRepo(db).changesToReview()).map((c) => {
          const now = c.field === "addr" ? (c.street ? addrText(c) : c.garage_addr || "") : c.field === "name" ? c.profile_name || c.garage_name || "" : c.phone ? phoneText(c.phone) : "(données publiques)";
          const asked = c.field === "addr" ? addrText(JSON.parse(c.value)) : c.field === "phone" ? phoneText(c.value) : c.value;
          return { id: c.id, garageId: c.garage_id, garageName: c.garage_name || "", field: c.field, current: now, requested: asked, createdAt: c.created_at };
        }),
      })),
    "pro-change": (e) => {
      if (typeof e.id !== "string" || !isUuid(e.id)) throw new Error("« id » : identifiant du changement attendu (op « pro-changes »)");
      if (e.decision !== "approve" && e.decision !== "reject") throw new Error("« decision » : « approve » ou « reject »");
      const reason = e.reason === undefined ? "" : e.reason;
      if (typeof reason !== "string" || reason.length > 300) throw new Error("« reason » : texte de 300 caractères au plus");
      if (e.decision === "reject" && !reason.trim()) throw new Error("« reason » : un motif est demandé pour un refus (il est montré au garagiste)");
      return withDb(async (db) => {
        const out = await createProRepo(db).decideChange({ id: e.id.toLowerCase(), decision: e.decision, reason: e.decision === "reject" ? reason.trim() : "" });
        if (out.kind === "not_found") throw new Error("aucun changement en attente avec cet identifiant");
        return { decided: out.kind };
      });
    },
    "pro-price": (e) => {
      const garageId = garageIdOf(e.garageId);
      if (typeof e.serviceId !== "string" || !/^[a-z0-9_]{2,40}$/.test(e.serviceId)) throw new Error("« serviceId » : identifiant de prestation attendu");
      if (e.status !== "published" && e.status !== "rejected") throw new Error("« status » : « published » ou « rejected »");
      return withDb(async (db) => ({ updated: await createProRepo(db).setPriceStatus(garageId, e.serviceId, e.status) }));
    },
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
