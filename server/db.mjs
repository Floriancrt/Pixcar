// Accès à la base : PostgreSQL (pg) en production classique, Amazon Aurora DSQL (connecteur officiel AWS : jeton IAM, TLS vérifié)
// sur AWS, PGlite (un vrai PostgreSQL embarqué, sans installation) pour le développement et les tests. Même interface :
// query(texte, paramètres) → { rows, rowCount }, tx(fn), exec(sql), session(fn), close(). Les paramètres sont toujours passés à
// part ($1, $2…) : jamais de valeur collée dans le texte SQL.
//
// session(fn) : une connexion dédiée, SANS délai de requête, pour l'administration (migrations). Sur PostgreSQL un verrou
// consultatif appartient à la connexion qui l'a pris : il faut le prendre et le rendre sur la même, ce que le pool ne garantit pas.
// DSQL n'a pas de verrous : lock/unlock n'y font rien (les migrations ne se lancent que d'un seul endroit).
//
// DSQL : concurrence optimiste. Deux transactions qui touchent la même ligne ne s'attendent pas : la seconde reçoit SQLSTATE 40001
// (OC000 conflit de données, OC001 structure modifiée) au moment de valider. query() et tx() la rejouent donc d'elles-mêmes : les
// fonctions passées à tx() doivent pouvoir être rejouées sans effet de bord hors de la base.
import { setTimeout as sleep } from "node:timers/promises";

export const isConflict = (e) => !!e && (e.code === "40001" || /\b(OC000|OC001)\b/.test(String(e.message || "")));

/** Rejoue fn tant qu'elle échoue sur un conflit de concurrence optimiste (attente exponentielle avec gigue). */
export async function withRetry(fn, { retries = 4, baseMs = 8, maxMs = 250, wait = sleep, onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!isConflict(e) || attempt >= retries) throw e;
      onRetry(e, attempt + 1);
      await wait(Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() / 2));
    }
  }
}

const wrapClient = (client) => ({
  query: (text, params) => client.query(text, params).then(({ rows, rowCount }) => ({ rows, rowCount })),
  exec: (sql) => client.query(sql).then(() => undefined),
});

async function inTransaction(client, fn) {
  try {
    await client.query("BEGIN");
    const out = await fn(wrapClient(client));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// Une base à pool de connexions (pg ou DSQL). `retry` : options de withRetry, ou null pour ne rien rejouer.
export function poolDb(pool, { kind, retry = null, session } = {}) {
  const run = retry ? (fn) => withRetry(fn, retry) : (fn) => fn();
  const direct = wrapClient(pool);
  return {
    kind,
    query: (text, params) => run(() => direct.query(text, params)),
    exec: (sql) => run(() => direct.exec(sql)),
    tx: (fn) =>
      run(async () => {
        const client = await pool.connect();
        try {
          return await inTransaction(client, fn);
        } finally {
          client.release();
        }
      }),
    session,
    close: () => pool.end(),
  };
}

export async function createDb({ url = "", dsql = null, dataDir, log = () => {} } = {}) {
  if (dsql && dsql.endpoint) return createDsqlDb(dsql, log);
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000, // pas d'attente interminable quand la base ne répond plus
      statement_timeout: 5_000,
      query_timeout: 6_000,
    });
    pool.on("error", (e) => log("pg: connexion inactive perdue : " + e.message));
    return poolDb(pool, {
      kind: "postgres",
      async session(fn) {
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
        client.on("error", (e) => log("pg: session d'administration perdue : " + e.message));
        await client.connect();
        try {
          await client.query("SET lock_timeout = '120s'"); // l'attente d'un verrou (autre instance qui migre) est bornée
          return await fn({
            ...wrapClient(client),
            tx: (f) => inTransaction(client, f),
            lock: (id) => client.query("SELECT pg_advisory_lock($1)", [id]).then(() => undefined),
            unlock: (id) => client.query("SELECT pg_advisory_unlock($1)", [id]).then(() => undefined),
          });
        } finally {
          await client.end().catch(() => {});
        }
      },
    });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite(dataDir);
  await lite.waitReady;
  const wrap = (c) => ({
    query: (text, params) => c.query(text, params).then(({ rows, affectedRows }) => ({ rows, rowCount: affectedRows ?? rows.length })),
    exec: (sql) => c.exec(sql).then(() => undefined),
  });
  const db = {
    kind: "pglite",
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    close: () => lite.close(),
  };
  // un seul processus et une seule connexion : pas de concurrence entre instances, donc pas de verrou à prendre
  db.session = (fn) => fn({ ...db, lock: async () => {}, unlock: async () => {} });
  return db;
}

// Amazon Aurora DSQL. dsql : { endpoint, user = "admin", max = 2 } (connector : injection pour les tests).
//  - user « admin » : migrations et rôles (IAM dsql:DbConnectAdmin). Un autre nom : rôle de base à moindre privilège (dsql:DbConnect).
//  - peu de connexions par instance (Lambda : une requête à la fois) ; DSQL ferme toute connexion au bout de 60 minutes : le pool
//    les renouvelle avant (50 min ; le connecteur prend 55 min par défaut, écrit ici pour ne pas dépendre de ce défaut).
//    Le connecteur impose aussi TLS avec contrôle du certificat (ssl.rejectUnauthorized = true par défaut).
async function createDsqlDb({ endpoint, user = "admin", max = 2, connector }, log) {
  const { AuroraDSQLPool, AuroraDSQLClient } = connector || (await import("@aws/aurora-dsql-node-postgres-connector"));
  const common = { host: endpoint, user, database: "postgres", connectionTimeoutMillis: 5_000 };
  const pool = new AuroraDSQLPool({ ...common, max, idleTimeoutMillis: 30_000, maxLifetimeSeconds: 50 * 60, query_timeout: 9_000 });
  pool.on("error", (e) => log("dsql: connexion inactive perdue : " + e.message));
  const retry = { onRetry: (e, n) => log(`dsql: conflit de concurrence (${e.code || "40001"}), nouvelle tentative ${n}`) };
  return poolDb(pool, {
    kind: "dsql",
    retry,
    async session(fn) {
      const client = new AuroraDSQLClient(common);
      client.on("error", (e) => log("dsql: session d'administration perdue : " + e.message));
      await client.connect();
      try {
        return await fn({
          ...wrapClient(client),
          tx: (f) => withRetry(() => inTransaction(client, f), retry),
          lock: async () => {},
          unlock: async () => {},
        });
      } finally {
        await client.end().catch(() => {});
      }
    },
  });
}
