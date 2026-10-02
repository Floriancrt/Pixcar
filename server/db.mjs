// Accès à la base : PostgreSQL (pg) en production, PGlite (un vrai PostgreSQL embarqué, sans installation) pour le
// développement et les tests. Même interface : query(texte, paramètres) → { rows, rowCount }, tx(fn), exec(sql),
// session(fn), close(). Les paramètres sont toujours passés à part ($1, $2…) : jamais de valeur collée dans le texte SQL.
//
// session(fn) : une connexion dédiée, SANS délai de requête, pour l'administration (migrations). Un verrou consultatif
// appartient à la connexion qui l'a pris : il faut le prendre et le rendre sur la même, ce que le pool ne garantit pas.

export async function createDb({ url = "", dataDir, log = () => {} } = {}) {
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
    const wrap = (client) => ({
      query: (text, params) => client.query(text, params).then(({ rows, rowCount }) => ({ rows, rowCount })),
      exec: (sql) => client.query(sql).then(() => undefined),
    });
    const transaction = async (client, fn) => {
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      }
    };
    return {
      kind: "postgres",
      ...wrap(pool),
      async tx(fn) {
        const client = await pool.connect();
        try {
          return await transaction(client, fn);
        } finally {
          client.release();
        }
      },
      async session(fn) {
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
        client.on("error", (e) => log("pg: session d'administration perdue : " + e.message));
        await client.connect();
        try {
          await client.query("SET lock_timeout = '120s'"); // l'attente d'un verrou (autre instance qui migre) est bornée
          return await fn({
            ...wrap(client),
            tx: (f) => transaction(client, f),
            lock: (id) => client.query("SELECT pg_advisory_lock($1)", [id]).then(() => undefined),
            unlock: (id) => client.query("SELECT pg_advisory_unlock($1)", [id]).then(() => undefined),
          });
        } finally {
          await client.end().catch(() => {});
        }
      },
      close: () => pool.end(),
    };
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
