// Schéma SQL : migrations rejouables, et contraintes qui tiennent même si l'API se trompait.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { migrate } from "../migrate.mjs";
import { freshDb } from "./helpers.mjs";

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
    const spy = { ...db, lock: async (id) => calls.push("lock"), unlock: async () => calls.push("unlock") };
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int > 0 THEN decode(repeat('ab', $9::int), 'hex') END, decode(repeat('cd', $10::int), 'hex'), $11, $12)`,
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
