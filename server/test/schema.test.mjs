// Schéma SQL : migrations rejouables, et contraintes qui tiennent même si l'API se trompait.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createDb } from "../db.mjs";
import { migrate } from "../migrate.mjs";
import { REAL_PG, freshDb } from "./helpers.mjs";

describe("migrations", () => {
  test("applied once, in order; running again does nothing", async () => {
    const db = await freshDb();
    try {
      assert.deepEqual(await migrate(db), ["001_init.sql"]);
      assert.deepEqual(await migrate(db), []);
      const done = (await db.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version);
      assert.deepEqual(done, ["001_init.sql"]);
    } finally {
      await db.close();
    }
  });

  test("a failing migration is rolled back entirely and releases the lock; the next ones are not applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-mig-"));
    await writeFile(join(dir, "001_ok.sql"), "CREATE TABLE a (x int);");
    await writeFile(join(dir, "002_bad.sql"), "CREATE TABLE b (x int); INSERT INTO table_inexistante VALUES (1);");
    await writeFile(join(dir, "003_never.sql"), "CREATE TABLE c (x int);");
    const db = await freshDb();
    const calls = [];
    const spy = { ...db, session: (fn) => db.session((s) => fn({ ...s, lock: async () => { calls.push("lock"); await s.lock(1); }, unlock: async () => { calls.push("unlock"); await s.unlock(1); } })) };
    try {
      await assert.rejects(() => migrate(spy, dir), /table_inexistante/);
      assert.deepEqual(calls, ["lock", "unlock"]);
      const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name);
      assert.ok(tables.includes("a") && !tables.includes("b") && !tables.includes("c"), tables.join());
      assert.deepEqual((await db.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version), ["001_ok.sql"]);
    } finally {
      await db.close();
    }
  });
});

// Ce qui ne se vérifie que sur un vrai serveur : plusieurs instances qui démarrent ensemble, verrou rendu, délais d'attente.
describe("migrations on a real PostgreSQL", { skip: !REAL_PG && "TEST_DATABASE_URL non défini" }, () => {
  const LOCK = 727_274;
  const free = async (db) => (await db.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK])).rows[0].ok && (await db.query("SELECT pg_advisory_unlock($1)", [LOCK]), true);

  test("four instances starting together: one applies, the others wait and find nothing to do; the lock is free afterwards", async () => {
    const first = await freshDb();
    const others = await Promise.all([1, 2, 3].map(() => createDb({ url: REAL_PG })));
    try {
      const results = await Promise.all([first, ...others].map((d) => migrate(d)));
      assert.deepEqual(results.map((r) => r.length).sort(), [0, 0, 0, 1], JSON.stringify(results));
      assert.equal(await free(first), true, "le verrou doit être rendu");
      assert.deepEqual((await first.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version), ["001_init.sql"]);
    } finally {
      await Promise.all([first, ...others].map((d) => d.close()));
    }
  });

  test("the lock lives on the session's own connection, whatever the pool is doing meanwhile", async () => {
    const db = await freshDb();
    try {
      await db.session(async (a) => {
        const mine = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await a.lock(LOCK);
        const busy = await Promise.all(Array.from({ length: 8 }, () => db.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.05)")));
        assert.ok(busy.every((r) => r.rows[0].pid !== mine), "le pool n'utilise jamais la connexion de la session");
        const holders = (await db.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted", [LOCK])).rows.map((r) => r.pid);
        assert.deepEqual(holders, [mine]);
        assert.equal((await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, mine);
        await a.unlock(LOCK);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1", [LOCK])).rows[0].n, 0);
      });
    } finally {
      await db.close();
    }
  });

  test("a failing migration leaves the lock free for the next instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-mig-"));
    await writeFile(join(dir, "001_bad.sql"), "SELECT 1/0;");
    const db = await freshDb();
    try {
      await assert.rejects(() => migrate(db, dir), /division by zero/);
      assert.equal(await free(db), true);
    } finally {
      await db.close();
    }
  });

  test("a migration longer than the 5 s query timeout of the pool is not cut", { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-mig-"));
    await writeFile(join(dir, "001_slow.sql"), "SELECT pg_sleep(5.5); CREATE TABLE slow_done (x int);");
    const db = await freshDb();
    try {
      assert.deepEqual(await migrate(db, dir), ["001_slow.sql"]);
      await assert.rejects(() => db.query("SELECT pg_sleep(5.5)"), /statement timeout|timed out/i, "le pool, lui, coupe bien les requêtes trop longues");
    } finally {
      await db.close();
    }
  });
});

describe("constraints (last line of defence)", () => {
  let db;
  before(async () => {
    db = await freshDb();
    await migrate(db);
    await db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('osm:node/1', 'Norauto', 1, 1)");
  });
  after(() => db.close());
  const ok = { id: "11111111-1111-4111-8111-111111111111", garage_id: "osm:node/1", service_id: "vidange", price_cents: 5990, repaired_on: "2026-09-12", rating: 4, vehicle_model: "Clio", vehicle_year: 2019, plate: 32, token: 32, status: "approved", comment: "" };
  const insert = (over = {}) => {
    const v = { ...ok, ...over };
    return db.query(
      `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash, status, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int > 0 THEN repeat('ab', $9::int) END, repeat('cd', $10::int), $11, $12)`,
      [v.id, v.garage_id, v.service_id, v.price_cents, v.repaired_on, v.rating, v.vehicle_model, v.vehicle_year, v.plate, v.token, v.status, v.comment],
    );
  };
  test("a valid row goes in", async () => {
    await insert();
    await db.query("DELETE FROM repairs");
  });
  for (const [why, over] of [
    ["price below 1 €", { price_cents: 99 }],
    ["price above 20 000 €", { price_cents: 2000001 }],
    ["rating 0", { rating: 0 }],
    ["rating 6", { rating: 6 }],
    ["date before 1990", { repaired_on: "1989-12-31" }],
    ["model of one character", { vehicle_model: "x" }],
    ["model year 1949", { vehicle_year: 1949 }],
    ["plate hash of the wrong size", { plate: 31 }],
    ["delete-token hash of the wrong size", { token: 16 }],
    ["unknown status", { status: "weird" }],
    ["comment above 500 characters", { comment: "x".repeat(501) }],
    ["a garage that does not exist", { garage_id: "osm:node/404" }],
  ])
    test(`refuses ${why}`, async () => {
      await assert.rejects(() => insert(over), (e) => /violates|constraint/i.test(e.message));
    });
  test("refuses the same plate / garage / service / day twice, but lets a rejected one be re-declared", async () => {
    await insert();
    await assert.rejects(() => insert({ id: "22222222-2222-4222-8222-222222222222" }), /duplicate|unique/i);
    await db.query("UPDATE repairs SET status = 'rejected'");
    await insert({ id: "33333333-3333-4333-8333-333333333333" });
    await db.query("DELETE FROM repairs");
  });
  test("refuses a garage with an impossible position or a too-short id", async () => {
    await assert.rejects(() => db.query("INSERT INTO garages (id, name, lat, lon, area_y, area_x) VALUES ('osm:node/2', 'X garage', 91, 0, 1, 1)"), /violates|constraint/i);
    await assert.rejects(() => db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('ab', 'X garage', 1, 1)"), /violates|constraint/i);
  });
  test("deleting a garage removes its repairs", async () => {
    await insert();
    await db.query("DELETE FROM garages WHERE id = 'osm:node/1'");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n, 0);
  });
});
