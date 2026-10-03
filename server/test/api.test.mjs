// API des réparations : écriture, lecture, suppression, limites, modération, pannes. Base réelle (PGlite), application réelle.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { sha256, toHex } from "../lib/crypto.mjs";
import { ORIGIN, get, isoDay, makeApp, repair } from "./helpers.mjs";

const area = "lat=45.7347&lon=4.9128&radius=10";
const post = (t, r, o) => t.call("POST", "/v1/repairs", { body: r, ...o });
const list = async (t, q = area) => get(await t.call("GET", `/v1/repairs?${q}`));
const rowCount = async (t, sql = "SELECT count(*)::int AS n FROM repairs") => (await t.db.query(sql)).rows[0].n;

describe("POST /v1/repairs", () => {
  let t;
  before(async () => (t = await makeApp()));
  after(() => t.close());
  beforeEach(() => t.reset());

  test("accepts a valid declaration: 201, never cached, readable by the allowed origin", async () => {
    const r = repair();
    const res = await post(t, r, { origin: ORIGIN });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: r.id, status: "approved" });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await rowCount(t), 1);
  });

  test("sending the same declaration again is a harmless replay (200, nothing written, not counted by the limiter)", async () => {
    const r = repair();
    await post(t, r);
    const again = await post(t, r);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { id: r.id, status: "approved", replayed: true });
    assert.equal(await rowCount(t), 1);
    assert.equal(await rowCount(t, "SELECT count(*)::int AS n FROM write_log"), 1);
  });

  test("the same id with another delete token is refused (nobody can take over someone else's id)", async () => {
    const r = repair();
    await post(t, r);
    const res = await post(t, { ...r, deleteToken: "f".repeat(32) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "id_conflict");
  });

  test("the same plate, garage, service and day cannot be declared twice; another day can", async () => {
    const a = repair();
    await post(t, a);
    const dup = await post(t, repair({ vehicle: a.vehicle }));
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error.code, "duplicate");
    const otherDay = await post(t, repair({ vehicle: a.vehicle, date: isoDay(20) }));
    assert.equal(otherDay.status, 201);
    const otherService = await post(t, repair({ vehicle: a.vehicle, serviceId: "revision" }));
    assert.equal(otherService.status, 201);
  });

  const bad = [
    ["id", { id: "pas-un-uuid" }],
    ["id", { id: "11111111-1111-1111-8111-111111111111" }], // pas la version 4
    ["deleteToken", { deleteToken: "court" }],
    ["deleteToken", { deleteToken: "z".repeat(32) }],
    ["serviceId", { serviceId: "inconnue" }],
    ["price", { price: 0 }],
    ["price", { price: 20001 }],
    ["price", { price: "59,90" }],
    ["price", { price: null }],
    ["rating", { rating: 0 }],
    ["rating", { rating: 6 }],
    ["rating", { rating: 4.5 }],
    ["date", { date: isoDay(-3) }], // dans le futur
    ["date", { date: "2026-02-30" }],
    ["date", { date: "1989-12-31" }],
    ["date", { date: "12/09/2026" }],
    ["comment", { comment: "x".repeat(501) }],
    ["garage.id", { garage: { id: "n'importe quoi", name: "Norauto" } }],
    ["garage.name", { garage: { id: "osm:node/1", name: "N", lat: 45, lon: 4 } }],
    ["garage.lat", { garage: { id: "osm:node/1", name: "Norauto", lat: 45 } }],
    ["garage.lat", { garage: { id: "osm:node/1", name: "Norauto", lat: 91, lon: 4 } }],
    ["area", { garage: { id: "custom:garage-du-coin", name: "Garage du Coin" }, area: {} }],
    ["vehicle.model", { vehicle: { model: "x", year: 2019, plate: "EZ-108-BC" } }],
    ["vehicle.year", { vehicle: { model: "Clio", year: 1949, plate: "EZ-108-BC" } }],
    ["vehicle.year", { vehicle: { model: "Clio", year: 2019.5, plate: "EZ-108-BC" } }],
    ["vehicle.plate", { vehicle: { model: "Clio", year: 2019, plate: "1234 AB 56" } }],
    ["vehicle.plate", { vehicle: { model: "Clio", year: 2019, plate: "<img src=x>" } }],
  ];
  for (const [field, patch] of bad)
    test(`422 on an invalid ${field} (${JSON.stringify(patch).slice(0, 50)})`, async () => {
      const res = await post(t, repair(patch));
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.error.code, "validation");
      assert.ok(field in body.error.fields, `champ « ${field} » attendu dans ${JSON.stringify(body.error.fields)}`);
      assert.equal(await rowCount(t), 0);
    });

  test("the vehicle year cannot follow the repair date", async () => {
    const res = await post(t, repair({ vehicle: { model: "Clio", year: new Date().getFullYear(), plate: "EZ-108-BC" }, date: isoDay(400) }));
    assert.equal(res.status, 422);
    assert.ok("vehicle.year" in (await res.json()).error.fields);
  });

  test("a garage typed by hand (no position) is accepted when the search position is given", async () => {
    const r = repair({ garage: { id: "custom:garage-du-coin", name: "Garage du Coin", addr: "" }, area: { lat: 45.74, lon: 4.91 } });
    assert.equal((await post(t, r)).status, 201);
    const out = await list(t);
    assert.deepEqual(out.json.garages.map((g) => g.id), ["custom:garage-du-coin"]);
  });

  test("the body must be JSON, small and readable", async () => {
    assert.equal((await t.call("POST", "/v1/repairs", { body: "texte", headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await t.call("POST", "/v1/repairs", { body: "{pas du json" })).status, 400);
    assert.equal((await t.call("POST", "/v1/repairs", { body: JSON.stringify(repair({ comment: "é".repeat(5000) })) })).status, 413);
    assert.equal((await t.call("POST", "/v1/repairs", { body: "[]" })).status, 422);
    assert.equal((await t.call("POST", "/v1/repairs", { body: "null" })).status, 422);
  });

  test("the plate and the visitor's address are never stored in clear; the delete token only as a hash", async () => {
    const r = repair({ vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" } });
    await post(t, r, { ip: "198.51.100.77" });
    const everything = JSON.stringify([
      (await t.db.query("SELECT * FROM repairs")).rows,
      (await t.db.query("SELECT * FROM garages")).rows,
      (await t.db.query("SELECT * FROM write_log")).rows,
      (await t.db.query("SELECT * FROM upstream_cache")).rows,
    ]);
    assert.ok(!everything.includes("EZ-108-BC") && !everything.includes("EZ108BC"), "plaque en clair");
    assert.ok(!everything.includes("198.51.100.77"), "adresse IP en clair");
    assert.ok(!everything.includes(r.deleteToken), "jeton en clair");
    const row = (await t.db.query("SELECT plate_hmac, delete_token_hash FROM repairs")).rows[0];
    assert.equal(row.plate_hmac.length, 32);
    assert.equal(toHex(row.delete_token_hash), toHex(await sha256(r.deleteToken)));
  });

  test("a date « today » in the visitor's time zone (up to UTC+14) is not in the future", async () => {
    const local = await makeApp({ now: () => Date.parse("2026-10-02T23:30:00Z") });
    try {
      assert.equal((await post(local, repair({ date: "2026-10-03" }))).status, 201); // déjà le 3 à Paris, à Auckland…
      const res = await post(local, repair({ date: "2026-10-04" }));
      assert.equal(res.status, 422);
    } finally {
      await local.close();
    }
  });
});

describe("limits", () => {
  test("a visitor is limited per hour, replays do not count, another visitor is not affected", async () => {
    const t = await makeApp({ config: { writeLimitPerHour: 3 } });
    try {
      const first = repair();
      for (const r of [first, repair(), repair()]) assert.equal((await post(t, r, { ip: "198.51.100.1" })).status, 201);
      const blocked = await post(t, repair(), { ip: "198.51.100.1" });
      assert.equal(blocked.status, 429);
      assert.equal((await blocked.json()).error.code, "rate_limited");
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
      assert.equal((await post(t, first, { ip: "198.51.100.1" })).status, 200, "un rejeu n'est pas une nouvelle déclaration");
      assert.equal((await post(t, repair(), { ip: "198.51.100.2" })).status, 201);
      assert.equal(await rowCount(t), 4);
    } finally {
      await t.close();
    }
  });

  test("a global ceiling per minute protects the database from a distributed flood", async () => {
    const t = await makeApp({ config: { writeLimitGlobalPerMinute: 2 } });
    try {
      assert.equal((await post(t, repair(), { ip: "198.51.100.1" })).status, 201);
      assert.equal((await post(t, repair(), { ip: "198.51.100.2" })).status, 201);
      assert.equal((await post(t, repair(), { ip: "198.51.100.3" })).status, 429);
    } finally {
      await t.close();
    }
  });

  test("the visitor's address comes from the socket unless proxies are trusted: a spoofed X-Forwarded-For buys nothing", async () => {
    const direct = await makeApp({ config: { writeLimitPerHour: 1, trustProxy: 0 } });
    try {
      assert.equal((await post(direct, repair(), { ip: "198.51.100.1", headers: { "x-forwarded-for": "1.1.1.1" } })).status, 201);
      assert.equal((await post(direct, repair(), { ip: "198.51.100.1", headers: { "x-forwarded-for": "2.2.2.2" } })).status, 429);
    } finally {
      await direct.close();
    }
    const proxied = await makeApp({ config: { writeLimitPerHour: 1, trustProxy: 1 } });
    try {
      // un relais de confiance ajoute l'adresse réelle à DROITE : ce que le client écrit avant elle ne compte pas
      assert.equal((await post(proxied, repair(), { ip: "10.0.0.1", headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } })).status, 201);
      assert.equal((await post(proxied, repair(), { ip: "10.0.0.1", headers: { "x-forwarded-for": "8.8.8.8, 1.1.1.1" } })).status, 429);
      assert.equal((await post(proxied, repair(), { ip: "10.0.0.1", headers: { "x-forwarded-for": "9.9.9.9, 2.2.2.2" } })).status, 201);
    } finally {
      await proxied.close();
    }
  });

  test("a relay header with TRUST_PROXY=0 is reported once (every visitor would share one rate limit); no warning when it is set or when there is no relay", async () => {
    const logs = [];
    const direct = await makeApp({ config: { trustProxy: 0 }, log: (o) => logs.push(o) });
    try {
      await direct.call("GET", `/v1/repairs?${area}`, { ip: "10.0.0.1" });
      assert.equal(logs.filter((l) => l.level === "warn").length, 0, "rien à signaler sans en-tête de relais");
      for (const header of [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }, { "cf-connecting-ip": "3.3.3.3" }])
        await direct.call("GET", `/v1/repairs?${area}`, { ip: "10.0.0.1", headers: header });
      const warns = logs.filter((l) => l.level === "warn");
      assert.equal(warns.length, 1);
      assert.match(warns[0].msg, /TRUST_PROXY/);
    } finally {
      await direct.close();
    }
    logs.length = 0;
    const proxied = await makeApp({ config: { trustProxy: 1 }, log: (o) => logs.push(o) });
    try {
      await proxied.call("GET", `/v1/repairs?${area}`, { ip: "10.0.0.1", headers: { "x-forwarded-for": "1.1.1.1" } });
      assert.equal(logs.filter((l) => l.level === "warn").length, 0);
    } finally {
      await proxied.close();
    }
  });

  test("reads are limited per visitor too (last line of defence when no CDN is in front)", async () => {
    const t = await makeApp({ config: { readLimitPerMinute: 3 } });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await t.call("GET", `/v1/repairs?${area}`, { ip: "198.51.100.9" })).status, 200);
      const res = await t.call("GET", `/v1/repairs?${area}`, { ip: "198.51.100.9" });
      assert.equal(res.status, 429);
      assert.ok(res.headers.get("retry-after"));
      assert.equal((await t.call("GET", `/v1/repairs?${area}`, { ip: "198.51.100.10" })).status, 200);
    } finally {
      await t.close();
    }
  });
});

describe("moderation", () => {
  test("a price far from what is declared nearby waits for review; it is listed once approved", async () => {
    const t = await makeApp();
    try {
      for (let i = 0; i < 6; i++) await post(t, repair({ price: 60 + i }), { ip: `198.51.100.${i + 1}` });
      const high = repair({ price: 900 }), low = repair({ price: 5 }), fine = repair({ price: 80 });
      assert.deepEqual(await (await post(t, high, { ip: "198.51.100.50" })).json(), { id: high.id, status: "pending" });
      assert.equal((await (await post(t, low, { ip: "198.51.100.51" })).json()).status, "pending");
      assert.equal((await (await post(t, fine, { ip: "198.51.100.52" })).json()).status, "approved");
      const ids = (await list(t)).json.garages[0].repairs.map((x) => x.id);
      assert.ok(ids.includes(fine.id) && !ids.includes(high.id) && !ids.includes(low.id));
      assert.equal((await t.app.repo.listPending()).length, 2);
      assert.ok(await t.app.repo.setStatus(high.id, "approved"));
      // (la copie de 10 s d'une zone masquerait le changement : on lit en base)
      const area2 = await t.app.repo.listArea({ lat: 45.7347, lon: 4.9128, radiusKm: 10 });
      assert.ok(area2.garages[0].repairs.some((x) => x.id === high.id));
    } finally {
      await t.close();
    }
  });

  test("with too little data nothing waits, and moderation can be switched off", async () => {
    const t = await makeApp();
    try {
      assert.equal((await (await post(t, repair({ price: 5000 }))).json()).status, "approved");
    } finally {
      await t.close();
    }
    const off = await makeApp({ config: { moderation: "off" } });
    try {
      for (let i = 0; i < 6; i++) await post(off, repair({ price: 60 }), { ip: `198.51.100.${i + 1}` });
      assert.equal((await (await post(off, repair({ price: 900 }), { ip: "198.51.100.40" })).json()).status, "approved");
    } finally {
      await off.close();
    }
  });
});

describe("anti-bot (Cloudflare Turnstile, optional)", () => {
  const verify = (answers) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: String(init.body) });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer), { status: 200 });
    };
    return { fetchImpl, calls };
  };
  test("without the secret configured the header is not required", async () => {
    const t = await makeApp();
    try {
      assert.equal((await post(t, repair())).status, 201);
    } finally {
      await t.close();
    }
  });
  test("with the secret: no token or a refused token → 403; a good token → 201; a verification outage → 503 (retry later)", async () => {
    const { fetchImpl, calls } = verify([{ success: false }, { success: true }, new Error("réseau")]);
    const t = await makeApp({ config: { turnstileSecret: "s3cret-s3cret-s3cret" }, fetchImpl });
    try {
      assert.equal((await post(t, repair())).status, 403);
      assert.equal(calls.length, 0, "sans jeton on n'appelle même pas Cloudflare");
      assert.equal((await post(t, repair(), { headers: { "x-turnstile-token": "mauvais" } })).status, 403);
      assert.equal((await post(t, repair(), { headers: { "x-turnstile-token": "bon" } })).status, 201);
      const out = await post(t, repair(), { headers: { "x-turnstile-token": "bon" } });
      assert.equal(out.status, 503);
      assert.ok(out.headers.get("retry-after"));
      assert.match(calls[0].url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
      assert.match(calls[1].body, /secret=s3cret-s3cret-s3cret/);
      assert.match(calls[1].body, /response=bon/);
      assert.match(calls[1].body, /remoteip=203\.0\.113\.7/);
    } finally {
      await t.close();
    }
  });
});

describe("GET /v1/repairs", () => {
  let t, clock = Date.parse("2026-10-02T10:00:00Z");
  before(async () => (t = await makeApp({ now: () => clock })));
  after(() => t.close());
  beforeEach(async () => {
    clock += 20_000; // la copie de 10 s d'une zone ne doit pas survivre d'un test à l'autre
    await t.reset();
  });

  test("returns what is declared around the point, grouped by garage, with public fields only", async () => {
    const r = repair();
    await post(t, r);
    const out = await list(t);
    assert.equal(out.status, 200);
    assert.equal(out.json.v, 1);
    assert.equal(out.json.radius, 10);
    assert.equal(out.json.truncated, false);
    assert.deepEqual(out.json.garages, [
      {
        id: "osm:node/1022", name: "Norauto Bron", addr: "98 rue Marcel Mérieux, 69100 Bron", lat: 45.7347, lon: 4.9128, chainId: "norauto",
        repairs: [{ id: r.id, serviceId: "vidange", price: 59.9, month: r.date.slice(0, 7), rating: 4, model: "Peugeot 208", year: 2019 }],
      },
    ]);
    for (const secret of ["Très bien", r.vehicle.plate, r.deleteToken, "comment", "plate", "deleteToken", "created"]) assert.ok(!out.text.includes(secret), `« ${secret} » ne doit jamais sortir`);
    assert.ok(!out.text.includes(r.date), "seul le mois est public");
  });

  test("is cacheable by the CDN and revalidated cheaply", async () => {
    await post(t, repair());
    const res = await t.call("GET", `/v1/repairs?${area}`);
    assert.equal(res.headers.get("cache-control"), "public, max-age=30, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400");
    const etag = res.headers.get("etag");
    assert.match(etag, /^W\/"[0-9a-f]{24}"$/);
    await res.text();
    const again = await t.call("GET", `/v1/repairs?${area}`, { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
  });

  for (const [why, q] of [
    ["lat missing", "lon=4.9&radius=10"],
    ["lon missing", "lat=45.7&radius=10"],
    ["lat empty", "lat=&lon=4.9&radius=10"],
    ["lat not a number", "lat=abc&lon=4.9&radius=10"],
    ["lat out of range", "lat=91&lon=4.9&radius=10"],
    ["radius missing", "lat=45.7&lon=4.9"],
    ["radius not offered by the page", "lat=45.7&lon=4.9&radius=7"],
  ])
    test(`400 when ${why}`, async () => {
      const res = await t.call("GET", `/v1/repairs?${q}`);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, "bad_request");
    });

  test("only the neighbourhood is returned: a garage 150 km away is not", async () => {
    await post(t, repair());
    await post(t, repair({ garage: { id: "osm:node/9", name: "Garage de Paris", addr: "", lat: 48.85, lon: 2.35, chainId: "" }, area: { lat: 48.85, lon: 2.35 } }));
    assert.deepEqual((await list(t)).json.garages.map((g) => g.id), ["osm:node/1022"]);
    assert.deepEqual((await list(t, "lat=48.85&lon=2.35&radius=10")).json.garages.map((g) => g.id), ["osm:node/9"]);
    assert.deepEqual((await list(t, "lat=43.3&lon=5.4&radius=50")).json.garages, []);
  });

  test("the response only depends on the 0.05° cell: nearby points share it (cache keys stay few)", async () => {
    await post(t, repair());
    const a = await list(t, "lat=45.7347&lon=4.9128&radius=10");
    const b = await list(t, "lat=45.7301&lon=4.9101&radius=10");
    assert.deepEqual(a.json.cell, b.json.cell);
    assert.equal(a.json.garages.length, b.json.garages.length);
  });

  test("at most 30 repairs per garage and service, the most recent ones", async () => {
    await post(t, repair({ date: isoDay(1) }));
    await t.db.query(
      `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, delete_token_hash)
       SELECT gen_random_uuid(), 'osm:node/1022', 'vidange', 5000 + i, DATE '2025-01-01' + i, 4, 'Clio', 2018, decode(repeat('ab', 32), 'hex') FROM generate_series(1, 40) AS i`,
    );
    const rows = (await list(t)).json.garages[0].repairs;
    assert.equal(rows.length, 30);
    assert.ok(rows.some((x) => x.price === 59.9), "la plus récente (hier) fait partie des 30");
    const months = rows.map((x) => x.month);
    assert.deepEqual(months, [...months].sort().reverse(), "classées de la plus récente à la plus ancienne");
  });

  test("pending and rejected declarations are never public", async () => {
    const r = repair();
    await post(t, r);
    await t.db.query("UPDATE repairs SET status = 'pending'");
    assert.deepEqual((await t.app.repo.listArea({ lat: 45.7347, lon: 4.9128, radiusKm: 10 })).garages, []);
    await t.db.query("UPDATE repairs SET status = 'rejected'");
    assert.deepEqual((await t.app.repo.listArea({ lat: 45.7347, lon: 4.9128, radiusKm: 10 })).garages, []);
  });

  test("CORS: allowed origins only, preflight included", async () => {
    const ok = await t.call("GET", `/v1/repairs?${area}`, { origin: ORIGIN });
    assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(ok.headers.get("access-control-expose-headers"), /retry-after/i, "la page doit pouvoir lire Retry-After");
    assert.match(ok.headers.get("vary"), /Origin/);
    const other = await t.call("GET", `/v1/repairs?${area}`, { origin: "https://evil.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre = await t.call("OPTIONS", "/v1/repairs", { origin: ORIGIN, headers: { "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
    assert.match(pre.headers.get("access-control-allow-headers"), /x-delete-token/i);
    assert.match(pre.headers.get("access-control-allow-headers"), /content-type/i);
  });
});

describe("in-instance copy of an area (the database is read once per 10 s and per area)", () => {
  test("a new declaration shows up after the copy expires, not before", async () => {
    let clock = Date.parse("2026-10-02T10:00:00Z");
    const t = await makeApp({ now: () => clock });
    try {
      assert.equal((await list(t)).json.garages.length, 0);
      await post(t, repair({ date: "2026-09-20" }));
      assert.equal((await list(t)).json.garages.length, 0, "la copie de 10 s est encore valable");
      clock += 11_000;
      assert.equal((await list(t)).json.garages.length, 1);
    } finally {
      await t.close();
    }
  });
});

describe("DELETE /v1/repairs/:id", () => {
  let t;
  before(async () => (t = await makeApp()));
  after(() => t.close());
  beforeEach(() => t.reset());
  const del = (id, token, o) => t.call("DELETE", `/v1/repairs/${id}`, { headers: token ? { "x-delete-token": token } : {}, ...o });

  test("the author removes it with the token; a second call finds nothing (idempotent); the same declaration can be posted again (undo)", async () => {
    const r = repair();
    await post(t, r);
    assert.equal((await del(r.id, r.deleteToken)).status, 204);
    assert.equal(await rowCount(t), 0);
    assert.equal((await del(r.id, r.deleteToken)).status, 404);
    assert.equal((await post(t, r)).status, 201, "annuler la suppression = reposter la même déclaration");
  });

  test("a wrong token, no token or a malformed id look exactly like « not found »", async () => {
    const r = repair();
    await post(t, r);
    const wrong = await del(r.id, "0".repeat(32));
    const none = await del(r.id, "");
    const junk = await del("nimporte-quoi", r.deleteToken);
    const unknown = await del("11111111-1111-4111-8111-111111111111", r.deleteToken);
    for (const res of [wrong, none, junk, unknown]) {
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "not_found");
    }
    assert.equal(await rowCount(t), 1);
  });

  test("the declaration is gone from the public listing once the copy expires", async () => {
    let clock = Date.parse("2026-10-02T10:00:00Z");
    const local = await makeApp({ now: () => clock });
    try {
      const r = repair({ date: "2026-09-20" });
      await post(local, r);
      assert.equal((await list(local)).json.garages.length, 1);
      await local.call("DELETE", `/v1/repairs/${r.id}`, { headers: { "x-delete-token": r.deleteToken } });
      clock += 11_000;
      assert.equal((await list(local)).json.garages.length, 0);
    } finally {
      await local.close();
    }
  });
});

describe("liveness, readiness, routing", () => {
  test("/healthz answers without touching the database; /readyz tells whether the database answers; draining is announced", async () => {
    const t = await makeApp();
    assert.equal((await t.call("GET", "/healthz")).status, 200);
    const ready = await t.call("GET", "/readyz");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, db: "up" });
    t.app.drain();
    const draining = await t.call("GET", "/readyz");
    assert.equal(draining.status, 503);
    assert.equal((await draining.json()).draining, true);
    await t.close();
    assert.equal((await t.call("GET", "/healthz")).status, 200, "le processus est vivant même sans base");
    const down = await t.call("GET", "/readyz");
    assert.equal(down.status, 503);
    assert.equal(down.headers.get("cache-control"), "no-store");
  });

  test("unknown routes and methods get a JSON answer, and every answer carries a request id", async () => {
    const t = await makeApp();
    try {
      const nf = await t.call("GET", "/v1/nimporte");
      assert.equal(nf.status, 404);
      assert.equal((await nf.json()).error.code, "not_found");
      const bad = await t.call("PUT", "/v1/repairs");
      assert.equal(bad.status, 405);
      assert.match(bad.headers.get("allow"), /GET/);
      assert.match(nf.headers.get("x-request-id"), /^[\w.-]{8,64}$/);
      const echoed = await t.call("GET", "/healthz", { headers: { "x-request-id": "abcdef0123456789" } });
      assert.equal(echoed.headers.get("x-request-id"), "abcdef0123456789");
    } finally {
      await t.close();
    }
  });
});

describe("when the database fails", () => {
  test("reads fall back to the last good answer (up to 1 h), then fail fast with Retry-After; writes say 503; liveness stays up", async () => {
    let clock = Date.parse("2026-10-02T10:00:00Z");
    const t = await makeApp({ now: () => clock });
    await post(t, repair({ date: "2026-09-20" }));
    const good = await list(t);
    assert.equal(good.json.garages.length, 1);
    clock += 11_000;
    await t.db.close(); // la base disparaît
    const stale = await t.call("GET", `/v1/repairs?${area}`);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-pixcar-stale"), "1");
    assert.deepEqual((await stale.json()).garages, good.json.garages);
    const write = await post(t, repair({ date: "2026-09-21" }));
    assert.equal(write.status, 503);
    assert.ok(write.headers.get("retry-after"));
    assert.equal((await write.json()).error.code, "unavailable");
    clock += 3600_000; // plus de copie récente
    const gone = await t.call("GET", `/v1/repairs?${area}`);
    assert.equal(gone.status, 503);
    assert.equal(gone.headers.get("cache-control"), "no-store");
    assert.equal((await t.call("GET", "/healthz")).status, 200);
  });

  test("once the breaker is open the database is not even tried (fast answers), and it is probed again after the cool-down", async () => {
    let clock = Date.parse("2026-10-02T10:00:00Z");
    const t = await makeApp({ now: () => clock });
    let calls = 0;
    const real = t.app.repo.listArea;
    t.app.repo.listArea = async (...a) => {
      calls++;
      throw new Error("connexion refusée");
    };
    for (let i = 0; i < 4; i++) assert.equal((await t.call("GET", `/v1/repairs?lat=45.${i}&lon=4.9&radius=10`, { ip: `198.51.100.${i}` })).status, 503);
    const before = calls;
    assert.equal((await t.call("GET", `/v1/repairs?lat=45.5&lon=4.9&radius=10`)).status, 503);
    assert.equal(calls, before, "disjoncteur ouvert : aucune tentative");
    clock += 6000;
    t.app.repo.listArea = real;
    assert.equal((await t.call("GET", `/v1/repairs?lat=45.5&lon=4.9&radius=10`)).status, 200, "la base est sondée de nouveau et le service reprend");
    await t.close();
  });

  test("a value the database refuses (constraint) is a 422 that is not retried, and never counts as a database failure", async () => {
    const logs = [];
    const t = await makeApp({ log: (o) => logs.push(o) });
    try {
      const real = t.db.tx;
      t.db.tx = async () => {
        throw Object.assign(new Error('new row for relation "repairs" violates check constraint "repairs_price_cents_check"'), { code: "23514" });
      };
      for (let i = 0; i < 8; i++) {
        const res = await post(t, repair(), { ip: `198.51.100.${i + 1}` });
        assert.equal(res.status, 422, "refusé pour de bon : le navigateur ne doit pas réessayer");
        assert.equal((await res.json()).error.code, "validation");
      }
      assert.ok(logs.some((l) => l.level === "error" && l.code === "23514"), "l'incident est journalisé pour qu'on corrige la validation");
      t.db.tx = real;
      // huit refus de données plus tard la base n'est PAS écartée : une déclaration valide passe, une lecture aussi
      assert.equal((await post(t, repair(), { ip: "198.51.100.50" })).status, 201);
      assert.equal((await t.call("GET", `/v1/repairs?${area}`, { ip: "198.51.100.51" })).status, 200);
    } finally {
      await t.close();
    }
  });

  test("a real database failure stays a 503 (the client will retry) and does count for the breaker", async () => {
    const t = await makeApp();
    try {
      const real = t.db.tx;
      t.db.tx = async () => {
        throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
      };
      for (let i = 0; i < 4; i++) {
        const res = await post(t, repair(), { ip: `198.51.100.${i + 1}` });
        assert.equal(res.status, 503);
        assert.ok(res.headers.get("retry-after"));
      }
      t.db.tx = real;
      assert.equal((await post(t, repair(), { ip: "198.51.100.50" })).status, 503, "disjoncteur ouvert après quatre pannes");
    } finally {
      await t.close();
    }
  });

  test("an unexpected error is a 500 without any detail, and is logged with the request id", async () => {
    const logs = [];
    const t = await makeApp({ log: (o) => logs.push(o) });
    try {
      t.app.overpass.get = () => {
        throw new Error("détail interne confidentiel");
      };
      const res = await t.call("GET", "/v1/overpass?data=x", { headers: { "x-request-id": "req-0123456789" } });
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.ok(!text.includes("confidentiel") && !text.includes("at "), "ni message interne ni trace");
      assert.equal(JSON.parse(text).error.code, "internal");
      assert.ok(logs.some((l) => l.level === "error" && l.id === "req-0123456789" && /confidentiel/.test(l.error)));
    } finally {
      await t.close();
    }
  });
});
