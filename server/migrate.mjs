// Applique les fichiers db/migrations/NNN_nom.sql pas encore appliqués, dans l'ordre, chacun dans une transaction.
// Sûr à relancer, et sûr si plusieurs instances démarrent en même temps (verrou consultatif PostgreSQL).
//   DATABASE_URL=postgres://… node server/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.mjs";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

export async function migrate(db, dir = MIGRATIONS_DIR, log = () => {}) {
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
        await s.tx(async (t) => {
          await t.exec(sql);
          await t.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        });
        log(`migration appliquée : ${file}`);
        applied.push(file);
      }
      return applied;
    } finally {
      await s.unlock(727_274);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await createDb({ url: process.env.DATABASE_URL || "", log: console.error });
  try {
    const applied = await migrate(db, MIGRATIONS_DIR, console.log);
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : "base à jour");
  } finally {
    await db.close();
  }
}
