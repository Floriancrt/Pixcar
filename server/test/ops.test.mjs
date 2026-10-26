// server/ops.mjs : les opérations d'exploitation invoquées dans AWS (migrations, modération, effacement, entretien, auto-contrôle).
// Sur PGlite ou PostgreSQL ici ; sur Aurora DSQL, c'est cette même fonction qui est invoquée dans AWS.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createOps } from "../ops.mjs";
import { hmac, toHex } from "../lib/crypto.mjs";
import { createRepo } from "../repo.mjs";
import { freshDb } from "./helpers.mjs";

describe("operations (Lambda « ops »)", () => {
  let db, ops, logged;
  const PEPPER = "pepper-for-tests-0123456789";
  before(async () => {
    db = await freshDb();
    logged = [];
    // la base survit entre les invocations (en vrai chaque invocation ouvre et ferme sa connexion)
    ops = createOps({ openDb: async () => ({ ...db, close: async () => {} }), env: { PLATE_PEPPER: PEPPER, IP_PEPPER: "ip-pepper-for-tests-0123456789" }, log: (l) => logged.push(l) });
  });
  after(() => db.close());

  test("an unknown operation, or none, is refused with the list of the known ones — never any free SQL", async () => {
    for (const bad of [{ op: "sql", sql: "DROP TABLE repairs" }, { op: "__proto__" }, { op: "constructor" }, {}, null]) {
      const out = await ops(bad);
      assert.equal(out.ok, false);
      assert.match(out.error, /opération inconnue.*migrate.*selfcheck/);
    }
  });

  test("migrate applies the migrations once (nothing the second time); the database role is a DSQL matter and is skipped elsewhere", async () => {
    const first = await ops({ op: "migrate" });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.applied, ["001_init.sql", "002_pro.sql", "003_pro_prices.sql", "004_pro_garage.sql", "005_rdv.sql", "006_calendar.sql", "007_calendar_blocks.sql", "008_pro_prefs.sql", "009_atelier.sql"]);
    assert.ok(first.role.skipped);
    assert.deepEqual((await ops({ op: "migrate" })).applied, []);
  });

  test("whoami, stats, list, purge answer", async () => {
    assert.equal((await ops({ op: "whoami" })).ok, true);
    const stats = await ops({ op: "stats" });
    assert.equal(stats.code, 0);
    assert.ok(Array.isArray(stats.lines));
    assert.equal((await ops({ op: "list" })).lines[0], "Rien en attente.");
    assert.deepEqual((await ops({ op: "purge" })).deleted, { writeLog: 0, upstreamCache: 0, repairs: 0, garages: 0, proEvents: 0, proClaims: 0, proVisits: 0, proChanges: 0, rdvDrafts: 0, rdvAnonymized: 0, rdvOld: 0, rdvEvents: 0, rdvMails: 0, calHistory: 0, calAssignments: 0, calWorkOrders: 0, calBlocksAnonymized: 0, calBlocks: 0, calBlockAssignments: 0 });
  });

  test("purge erases the declarations older than REPAIR_RETENTION_MONTHS (24 months when it is not set), and keeps the others", async () => {
    await db.query("TRUNCATE repairs, garages, write_log CASCADE");
    await db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('osm:node/5', 'Garage', 1, 1)");
    const insert = (months, c) =>
      db.query(
        `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash, created_at)
         VALUES (gen_random_uuid(), 'osm:node/5', 'vidange', 5000, DATE '2024-01-01', 4, 'Clio', 2018, $1, $2, now() - ($3::int * interval '1 month'))`,
        [c.repeat(64), (c === "a" ? "1" : c === "b" ? "2" : "3").repeat(64), months],
      );
    await insert(30, "a");
    await insert(13, "b");
    await insert(2, "c");
    const count = async () => (await db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n;
    const purgeWith = (env) => createOps({ openDb: async () => ({ ...db, close: async () => {} }), env })({ op: "purge" });
    assert.equal((await purgeWith({ REPAIR_RETENTION_MONTHS: "0" })).deleted.repairs, 0);
    assert.equal(await count(), 3, "0 : tout est gardé");
    assert.equal((await purgeWith({})).deleted.repairs, 1, "24 mois par défaut : celle de 30 mois part");
    assert.equal(await count(), 2);
    assert.equal((await purgeWith({ REPAIR_RETENTION_MONTHS: "12" })).deleted.repairs, 1, "12 mois : celle de 13 mois part");
    assert.equal(await count(), 1);
    const wrong = await purgeWith({ REPAIR_RETENTION_MONTHS: "deux ans" });
    assert.equal(wrong.ok, false, "une valeur absurde est refusée, pas ignorée");
    assert.equal(await count(), 1);
    await db.query("TRUNCATE repairs, garages, write_log CASCADE"); // les tests suivants repartent d'une base vide
  });

  test("approve / reject take real identifiers only, at most 50, as a list", async () => {
    for (const ids of [undefined, [], "x", ["pas-un-uuid"], [12], Array(51).fill("11111111-1111-4111-8111-111111111111")]) {
      const out = await ops({ op: "approve", ids });
      assert.equal(out.ok, false, JSON.stringify(ids));
      assert.match(out.error, /ids/);
    }
    const out = await ops({ op: "reject", ids: ["11111111-1111-4111-8111-111111111111"] });
    assert.equal(out.ok, true);
    assert.match(out.lines[0], /introuvable/);
  });

  test("forget erases every declaration of a plate with the plate secret, and checks its input", async () => {
    await db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('osm:node/1', 'Garage', 1, 1)");
    const plateHash = toHex(await hmac(PEPPER, "EZ-108-BC"));
    await createRepo(db).insertRepair(
      { id: "33333333-3333-4333-8333-333333333333", garage: { id: "osm:node/1", name: "Garage", addr: "", lat: null, lon: null, chainId: "" }, pos: { lat: 1, lon: 1 }, serviceId: "vidange", priceCents: 5000, date: "2026-09-12", rating: 4, comment: "", model: "Clio", year: 2018 },
      { tokenHash: "a".repeat(64), plateHash, ipHash: "b".repeat(64), limitPerHour: 10, limitGlobalPerMinute: 100, moderate: false },
    );
    const out = await ops({ op: "forget", plates: ["ez 108 bc"] });
    assert.equal(out.ok, true, out.error);
    assert.match(out.lines[0], /1 déclaration\(s\) supprimée\(s\)/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n, 0);
    for (const plates of [undefined, [], ["x".repeat(21)], [5]]) assert.equal((await ops({ op: "forget", plates })).ok, false);
    assert.equal((await ops({ op: "forget", plates: ["pas une plaque"] })).ok, false);
  });

  test("selfcheck runs the whole scenario on the database and reports every line", async () => {
    const out = await ops({ op: "selfcheck" });
    assert.equal(out.ok, true, JSON.stringify(out.checks.filter((c) => !c.ok)));
    assert.equal(out.passed, out.total);
    assert.ok(out.total >= 18);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM garages WHERE id LIKE 'custom:selfcheck-%'")).rows[0].n, 0, "aucune donnée d'essai ne reste");
  });

  test("import-contacts writes a batch (rows checked one by one), prune-contacts removes what a complete load did not rewrite", async () => {
    const row = (n, over = {}) => ({ id: `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Garage ${n}`, lat: 43.2 + n / 1000, lon: 1.1, emails: [`g${n}@garage${n}.fr`], ...over });
    const first = await ops({ op: "import-contacts", importId: "load-1", rows: [row(1), row(2), row(3), { id: "x", name: "?" }] });
    assert.deepEqual([first.ok, first.written, first.rejected], [true, 3, 1]);
    // second chargement complet : le garage 3 a disparu, le 2 a changé d'adresse
    assert.equal((await ops({ op: "import-contacts", importId: "load-2", rows: [row(1), row(2, { emails: ["nouveau@garage2.fr"] })] })).written, 2);
    const pruned = await ops({ op: "prune-contacts", importId: "load-2" });
    assert.deepEqual([pruned.ok, pruned.removed, pruned.kept], [true, 1, 2]);
    const left = (await db.query("SELECT garage_id, emails FROM garage_contacts ORDER BY garage_id")).rows;
    assert.deepEqual(left.map((r) => r.emails), [["g1@garage1.fr"], ["nouveau@garage2.fr"]]);
    // un chargement partiel ne peut pas effacer le reste
    await ops({ op: "import-contacts", importId: "load-3", rows: [row(9)] });
    const refused = await ops({ op: "prune-contacts", importId: "load-3" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /moins de la moitié/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM garage_contacts")).rows[0].n, 3);
    for (const bad of [{ importId: "load 4" }, { importId: "load-4", rows: [] }, { importId: "load-4", rows: Array(501).fill(row(1)) }, { importId: "x".repeat(41), rows: [row(1)] }])
      assert.equal((await ops({ op: "import-contacts", ...bad })).ok, false, JSON.stringify(bad).slice(0, 60));
    await db.exec("TRUNCATE garage_contacts");
  });

  test("pro-stats, pro-claims and pro-revoke: a verified link can be withdrawn, and the target is never shown", async () => {
    const id = "bbbbbbbb-0000-4000-8000-0000000000aa";
    await db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), 'acc-1', $1, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', NULL, $2, 'c•••••@garage.fr', now())",
      [id, "a".repeat(64)],
    );
    assert.deepEqual((await ops({ op: "pro-stats" })).claims, { verified: 1 });
    const listed = await ops({ op: "pro-claims", garageId: id });
    assert.equal(listed.claims.length, 1);
    assert.equal(listed.claims[0].account_id, "acc-1");
    assert.ok(!("target" in listed.claims[0]) && !("target_hash" in listed.claims[0]));
    assert.equal((await ops({ op: "pro-revoke", garageId: id })).revoked, 1);
    assert.equal((await ops({ op: "pro-revoke", garageId: id })).revoked, 0);
    assert.equal((await ops({ op: "pro-claims", garageId: "pas un id" })).ok, false);
    await db.exec("TRUNCATE pro_claims, pro_events");
  });

  test("a failing operation is reported in the answer (ok: false), not thrown at the platform", async () => {
    const broken = createOps({ openDb: async () => { throw new Error("base injoignable"); }, env: {}, log: (l) => logged.push(l) });
    const out = await broken({ op: "stats" });
    assert.deepEqual([out.ok, out.op, out.error], [false, "stats", "base injoignable"]);
    assert.ok(logged.some((l) => l.level === "error" && l.op === "stats"));
  });
});

describe("operations: where the migrations come from", () => {
  test("MIGRATIONS_DIR points « migrate » at another folder (the bundled function cannot find db/migrations from its own location)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixcar-migrations-"));
    const db = await freshDb();
    try {
      await writeFile(join(dir, "001_probe.sql"), "CREATE TABLE IF NOT EXISTS probe_table (id integer PRIMARY KEY);\n");
      const out = await createOps({ openDb: async () => ({ ...db, close: async () => {} }), env: { MIGRATIONS_DIR: dir } })({ op: "migrate" });
      assert.equal(out.ok, true, out.error);
      assert.deepEqual(out.applied, ["001_probe.sql"]);
      assert.equal((await db.query("SELECT to_regclass('probe_table') AS t")).rows[0].t, "probe_table");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
