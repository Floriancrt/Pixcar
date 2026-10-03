// Le SQL de repo.mjs doit donner les mêmes résultats que l'ancien (percentile_cont, to_char, extract, row_number, DELETE en bloc) tout en
// restant dans ce que DSQL accepte. Ces tests comparent à des références calculées autrement : percentile_cont de PostgreSQL pour la
// médiane, une horloge arbitraire pour les délais, des dizaines de milliers de lignes pour les purges par lots.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { migrate } from "../migrate.mjs";
import { PURGE_BATCH, createRepo, decideStatus } from "../repo.mjs";
import { freshDb } from "./helpers.mjs";

const hex64 = (n) => String(n).padStart(2, "0").repeat(32).slice(0, 64);

describe("repo.mjs portable SQL", () => {
  let db, repo;
  before(async () => {
    db = await freshDb();
    await migrate(db);
    repo = createRepo(db);
  });
  after(() => db.close());

  test("the median used for moderation equals percentile_cont(0.5), whatever the parity and the data", async () => {
    await db.query("TRUNCATE repairs, garages, write_log CASCADE");
    await db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('osm:node/7', 'Garage', 10, 20)");
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 24; round++) {
      await db.query("DELETE FROM repairs");
      const n = 5 + Math.floor(rnd() * 26); // 5 à 30 : pairs et impairs
      const prices = Array.from({ length: n }, () => 100 + Math.floor(rnd() * rnd() * 400000));
      for (let i = 0; i < n; i++) {
        await db.query(
          `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash)
           VALUES (gen_random_uuid(), 'osm:node/7', 'vidange', $1, DATE '2026-01-01', 4, 'Clio', 2018, $2, $3)`,
          [prices[i], hex64(i + 1), hex64(i + 50)],
        );
      }
      const ref = Number((await db.query("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) AS med FROM repairs")).rows[0].med);
      const sorted = [...prices].sort((a, b) => a - b);
      const mine = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      assert.equal(mine, ref, `médiane (n=${n})`);
      for (const probe of [Math.floor(ref / 3) - 1, Math.ceil(ref / 3) + 1, Math.floor(ref * 3) - 1, Math.ceil(ref * 3) + 1, Math.round(ref)]) {
        if (probe < 100) continue;
        const expected = probe < ref / 3 || probe > ref * 3 ? "pending" : "approved";
        assert.equal(await decideStatus(db, "vidange", probe, 10, 20), expected, `n=${n} médiane=${ref} prix=${probe}`);
      }
    }
  });

  test("fewer than five declarations: always accepted, whatever the price", async () => {
    await db.query("DELETE FROM repairs");
    for (let i = 0; i < 4; i++) {
      await db.query(
        `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash)
         VALUES (gen_random_uuid(), 'osm:node/7', 'vidange', 5000, DATE '2026-01-01', 4, 'Clio', 2018, $1, $2)`,
        [hex64(i + 1), hex64(i + 50)],
      );
    }
    assert.equal(await decideStatus(db, "vidange", 2000000, 10, 20), "approved");
  });

  test("the public listing carries the month only, never the day, and exactly the documented fields", async () => {
    await db.query("DELETE FROM repairs");
    await db.query(
      `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash, comment)
       VALUES ('11111111-1111-4111-8111-111111111111', 'osm:node/7', 'vidange', 5990, DATE '2026-09-12', 4, 'Clio', 2018, $1, $2, 'secret')`,
      [hex64(1), hex64(2)],
    );
    const { y, x } = { y: 10, x: 20 };
    const lat = (y + 0.5) * 0.05 - 90, lon = (x + 0.5) * 0.05 - 180;
    const area = await repo.listArea({ lat, lon, radiusKm: 3 });
    const r = area.garages[0].repairs[0];
    assert.deepEqual(Object.keys(r).sort(), ["id", "model", "month", "price", "rating", "serviceId", "year"]);
    assert.equal(r.month, "2026-09");
    assert.ok(!JSON.stringify(area).includes("2026-09-12") && !JSON.stringify(area).includes("secret"));
  });

  test("a visitor over the write limit is told when the oldest entry leaves the sliding hour", async () => {
    await db.query("DELETE FROM write_log");
    await db.query("INSERT INTO write_log (ip_hash, at) SELECT $1, now() - interval '50 minutes' + (i || ' seconds')::interval FROM generate_series(1, 10) AS i", [hex64(9)]);
    const v = { id: "22222222-2222-4222-8222-222222222222", garage: { id: "osm:node/7", name: "Garage", addr: "", lat: null, lon: null, chainId: "" }, pos: { lat: 45, lon: 4 }, serviceId: "vidange", priceCents: 5000, date: "2026-09-12", rating: 4, comment: "", model: "Clio", year: 2018 };
    const out = await repo.insertRepair(v, { tokenHash: hex64(3), plateHash: hex64(4), ipHash: hex64(9), limitPerHour: 10, limitGlobalPerMinute: 1000, moderate: false });
    assert.equal(out.kind, "limited");
    assert.ok(Math.abs(out.retryAfter - 600) <= 3, "≈ 10 minutes : " + out.retryAfter);
  });

  test("an Overpass answer reports its age in seconds", async () => {
    await db.query("DELETE FROM upstream_cache");
    await db.query("INSERT INTO upstream_cache (key, body, fetched_at) VALUES ('k', '{\"a\":1}'::jsonb, now() - interval '2 hours')");
    const got = await repo.getUpstream("k");
    assert.deepEqual(got.body, { a: 1 });
    assert.ok(Math.abs(got.ageSeconds - 7200) <= 3, String(got.ageSeconds));
    assert.equal(await repo.getUpstream("absent"), null);
  });

  test("purge works in batches (DSQL accepts 3 000 rows per transaction), keeps what is recent and what is used", async () => {
    await db.query("TRUNCATE repairs, garages, write_log, upstream_cache CASCADE");
    await db.query("INSERT INTO write_log (ip_hash, at) SELECT $1, now() - interval '40 days' FROM generate_series(1, 2500)", [hex64(1)]);
    await db.query("INSERT INTO write_log (ip_hash, at) SELECT $1, now() - interval '1 day' FROM generate_series(1, 5)", [hex64(2)]);
    await db.query("INSERT INTO upstream_cache (key, body, fetched_at) SELECT 'old' || i, '{}'::jsonb, now() - interval '20 days' FROM generate_series(1, 1500) AS i");
    await db.query("INSERT INTO upstream_cache (key, body) VALUES ('fresh', '{}'::jsonb)");
    await db.query("INSERT INTO garages (id, name, area_y, area_x, created_at) VALUES ('osm:node/1', 'Vide ancien', 1, 1, now() - interval '30 days'), ('osm:node/2', 'Utilisé ancien', 1, 1, now() - interval '30 days'), ('osm:node/3', 'Vide récent', 1, 1, now())");
    await db.query(
      `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash)
       VALUES (gen_random_uuid(), 'osm:node/2', 'vidange', 5000, DATE '2026-01-01', 4, 'Clio', 2018, $1, $2)`,
      [hex64(5), hex64(6)],
    );
    let deletes = 0;
    const counting = { ...db, query: (text, params) => { if (/^DELETE FROM write_log/.test(text)) deletes++; return db.query(text, params); } };
    const out = await createRepo(counting).purge();
    assert.deepEqual(out, { writeLog: 2500, upstreamCache: 1500, repairs: 0, garages: 1 });
    assert.equal(deletes, Math.ceil(2500 / PURGE_BATCH), "trois passes de 1 000, 1 000 et 500 lignes");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM write_log")).rows[0].n, 5);
    assert.deepEqual((await db.query("SELECT key FROM upstream_cache")).rows.map((r) => r.key), ["fresh"]);
    assert.deepEqual((await db.query("SELECT id FROM garages ORDER BY id")).rows.map((r) => r.id), ["osm:node/2", "osm:node/3"]);
    assert.deepEqual(await createRepo(db).purge(), { writeLog: 0, upstreamCache: 0, repairs: 0, garages: 0 }, "relançable sans effet");
  });

  test("retention purge: declarations older than the chosen number of months go, in batches and whatever their status; the others stay; 0 keeps everything", async () => {
    await db.query("TRUNCATE repairs, garages, write_log, upstream_cache CASCADE");
    await db.query("INSERT INTO garages (id, name, area_y, area_x) VALUES ('osm:node/9', 'Garage', 1, 1)");
    const insert = (n, months, status) =>
      db.query(
        `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash, status, created_at)
         SELECT gen_random_uuid(), 'osm:node/9', 'vidange', 5000, DATE '2024-01-01', 4, 'Clio', 2018,
                md5($4 || i::text) || md5($4 || (i + 1)::text), md5($4 || i::text) || md5($4 || (i + 7)::text), $3, now() - ($2::int * interval '1 month')
         FROM generate_series(1, $1::int) AS i`,
        [n, months, status, `${status}${months}`],
      );
    await insert(1200, 30, "approved");
    await insert(10, 26, "rejected");
    await insert(10, 25, "pending");
    await insert(7, 23, "approved");
    const count = async () => (await db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n;
    let deletes = 0;
    const counting = { ...db, query: (text, params) => { if (/^DELETE FROM repairs/.test(text)) deletes++; return db.query(text, params); } };
    assert.equal((await createRepo(counting).purge({ repairRetentionMonths: 0 })).repairs, 0);
    assert.equal(await count(), 1227, "0 : tout est gardé");
    const fixedNow = () => Date.now();
    const out = await createRepo(counting).purge({ repairRetentionMonths: 24, now: fixedNow });
    assert.equal(out.repairs, 1220, "30, 26 et 25 mois : approuvées, rejetées et en attente");
    assert.equal(deletes, 2, "deux passes : 1 000 puis 220 lignes");
    assert.equal(await count(), 7, "celles de 23 mois restent");
    assert.deepEqual((await createRepo(db).purge({ repairRetentionMonths: 24 })).repairs, 0, "relançable sans effet");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM garages")).rows[0].n, 1, "le garage garde ses déclarations récentes : il reste");
    // le calcul de la date limite suit le calendrier (et l'horloge qu'on lui donne)
    await db.query("TRUNCATE repairs CASCADE");
    await db.query(
      `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash, created_at)
       VALUES (gen_random_uuid(), 'osm:node/9', 'vidange', 5000, DATE '2024-01-01', 4, 'Clio', 2018, $1, $2, TIMESTAMPTZ '2024-10-14 12:00:00+00'),
              (gen_random_uuid(), 'osm:node/9', 'freins', 5000, DATE '2024-01-01', 4, 'Clio', 2018, $3, $4, TIMESTAMPTZ '2024-10-16 12:00:00+00')`,
      [hex64(1), hex64(2), hex64(3), hex64(4)],
    );
    const clock = () => Date.parse("2026-10-15T12:00:00Z"); // 24 mois avant : le 15 octobre 2024
    assert.equal((await createRepo(db).purge({ repairRetentionMonths: 24, now: clock })).repairs, 1, "celle du 14 octobre 2024 part, celle du 16 reste");
  });
});
