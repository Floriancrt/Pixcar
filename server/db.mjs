// Accès à la base : PostgreSQL (pg) en production, PGlite (un vrai PostgreSQL embarqué, sans installation) pour le
// développement et les tests. Même interface : query(texte, paramètres) → { rows, rowCount }, tx(fn), exec(sql), close().
// Les paramètres sont toujours passés à part ($1, $2…) : jamais de valeur collée dans le texte SQL.

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
    return {
      kind: "postgres",
      ...wrap(pool),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn(wrap(client));
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      lock: (id) => pool.query("SELECT pg_advisory_lock($1)", [id]),
      unlock: (id) => pool.query("SELECT pg_advisory_unlock($1)", [id]),
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
  return {
    kind: "pglite",
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    lock: async () => {},
    unlock: async () => {},
    close: () => lite.close(),
  };
}
