// Espace Pro, « Vos premiers prix » : prix annoncés par un garage vérifié (saisie, relecture, confirmation), prix payés par ses clients
// retrouvés par la règle de rapprochement de la page, lecture publique (badge, prix annoncés) et visites comptées. Base réelle (PGlite).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { ORIGIN, makeApp, repair } from "./helpers.mjs";
import { createOps } from "../ops.mjs";

const HERE = { lat: 43.2174, lon: 1.1014 }; // Cazères
const north = (m, p = HERE) => ({ lat: p.lat + m / 111_320, lon: p.lon });
const DUPONT = "aaaaaaaa-0000-4000-8000-000000000001";
const PETIT = "aaaaaaaa-0000-4000-8000-000000000008";
const ALONE = "aaaaaaaa-0000-4000-8000-000000000009";
const CONTACTS = [
  { id: DUPONT, name: "Garage Dupont", pc: "31220", ...HERE, emails: ["contact@garage-dupont.fr"] },
  { id: PETIT, name: "Garage Petit", pc: "31220", ...north(60), emails: ["petit@garage-petit.fr"] },
  { id: ALONE, name: "Atelier du Moulin", pc: "31220", ...north(3000), emails: ["moulin@exemple.fr"] },
];

describe("Espace Pro : prix annoncés, tableau de bord, lecture publique", () => {
  let t, clock;
  const as = (who) => ({ "x-pro-dev-account": who });
  const call = (who, method, path, body, extra = {}) => t.call(method, path, { body, headers: who ? as(who) : {}, ...extra });
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers });
  const put = (who, garage, service, body) => call(who, "PUT", `/v1/pro/garages/${garage}/prices/${service}`, body).then(json);
  // rattachement vérifié posé directement en base : la vérification elle-même est testée dans pro.test.mjs
  const own = (who, garageId) =>
    t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $4, 'c•••••@garage-dupont.fr', now())",
      [crypto.randomUUID(), "dev-" + who, garageId, "a".repeat(64)],
    );
  const declare = (garage, serviceId, price) => t.call("POST", "/v1/repairs", { body: repair({ garage, area: { lat: garage.lat, lon: garage.lon }, serviceId, price }), origin: ORIGIN });

  before(async () => {
    clock = { offset: 0 };
    t = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", WRITE_LIMIT_PER_HOUR: "1000" }, now: () => Date.now() + clock.offset });
  });
  after(() => t.close());
  beforeEach(async () => {
    clock.offset = 0;
    await t.reset();
    const { rows, rejected } = parseContactRows(CONTACTS);
    assert.equal(rejected, 0);
    await t.app.pro.repo.upsertContacts(rows, "test-1");
  });

  test("the dashboard and the price routes answer only for a garage verified on THIS account (404 otherwise, without saying whether it exists)", async () => {
    await own("alice", DUPONT);
    assert.equal((await json(await call(null, "GET", `/v1/pro/garages/${DUPONT}`))).status, 401);
    for (const who of ["bob", "alice"]) {
      const target = who === "bob" ? DUPONT : PETIT; // bob : garage d'un autre ; alice : garage qu'elle n'a pas
      for (const [method, path, body] of [
        ["GET", `/v1/pro/garages/${target}`],
        ["PUT", `/v1/pro/garages/${target}/prices/vidange`, { kind: "fixed", price: 89 }],
        ["DELETE", `/v1/pro/garages/${target}/prices/vidange`],
        ["POST", `/v1/pro/garages/${target}/confirm`],
      ]) {
        const r = await json(await call(who, method, path, body));
        assert.equal(r.status, 404, `${who} ${method} ${path}`);
        assert.equal(r.body.error.code, "not_found");
      }
    }
    assert.equal((await json(await call("alice", "GET", "/v1/pro/garages/pas-un-id!"))).status, 404);
    const me = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.deepEqual(me.body.garage, { id: DUPONT, name: "Garage Dupont", addr: "", verifiedAt: me.body.garage.verifiedAt, holderName: "Camille Durand" });
    assert.deepEqual([me.body.prices, me.body.paid, me.body.visits], [[], {}, { views: { recent: 0, previous: 0 }, calls: { recent: 0, previous: 0 } }]);
  });

  test("a price is validated (catalogue service, kind, euros with 2 decimals, no price « on quote », known vehicles and inclusions), saved and replaced", async () => {
    await own("alice", DUPONT);
    const bad = async (service, body, field) => {
      const r = await put("alice", DUPONT, service, body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(r.body.error.field, field, JSON.stringify(r.body));
    };
    await bad("ct", { kind: "fixed", price: 70 }, "service"); // contrôle technique : prix officiels, pas d'annonce
    await bad("autre", { kind: "fixed", price: 70 }, "service");
    await bad("vidange", { kind: "promo", price: 70 }, "kind");
    await bad("vidange", { kind: "fixed" }, "price");
    await bad("vidange", { kind: "fixed", price: 0.5 }, "price");
    await bad("vidange", { kind: "fixed", price: 89.999 }, "price");
    await bad("vidange", { kind: "fixed", price: "89" }, "price");
    await bad("diag", { kind: "quote", price: 40 }, "price");
    await bad("vidange", { kind: "fixed", price: 89, vehicles: ["tank"] }, "vehicles");
    await bad("vidange", { kind: "fixed", price: 89, includes: ["cafe"] }, "includes");
    assert.equal((await json(await call("alice", "PUT", `/v1/pro/garages/${DUPONT}/prices/vidange`, "{pas du json"))).status, 400);

    const ok = await put("alice", DUPONT, "vidange", { kind: "fixed", price: 89, vehicles: ["compact", "city", "city"], includes: ["labour", "parts"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(
      { ...ok.body, confirmedAt: 0, staleAt: 0, updatedAt: 0 },
      { service: "vidange", kind: "fixed", price: 89, vehicles: ["city", "compact"], includes: ["parts", "labour"], status: "published", state: "ok", confirmedAt: 0, staleAt: 0, updatedAt: 0 },
    );
    const months = (new Date(ok.body.staleAt) - new Date(ok.body.confirmedAt)) / 864e5;
    assert.ok(months >= 181 && months <= 184, "ancien 6 mois après la confirmation : " + months);
    const all = await put("alice", DUPONT, "vidange", { kind: "from", price: 99.5, vehicles: ["city", "compact", "sedan", "suv", "van"] });
    assert.deepEqual([all.body.kind, all.body.price, all.body.vehicles, all.body.includes], ["from", 99.5, [], []], "tous les véhicules : liste vide");
    const quote = await put("alice", DUPONT, "diag", { kind: "quote" });
    assert.deepEqual([quote.status, quote.body.price, quote.body.status], [200, null, "published"]);
    const dash = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.deepEqual(dash.body.prices.map((p) => [p.service, p.kind, p.price]), [["diag", "quote", null], ["vidange", "from", 99.5]]);
  });

  test("the paid prices of the garage come from declarations on the garage the page shows: the OpenStreetMap one with the same name nearby, or the table's own id", async () => {
    await own("alice", DUPONT);
    const osm = { id: "osm:node/42", name: "GARAGE DUPONT", addr: "", ...north(40), chainId: "" }; // même garage, vu par OpenStreetMap
    const ovt = { id: "custom:ovt-" + DUPONT.replace(/-/g, ""), name: "Garage Dupont", addr: "", ...HERE, chainId: "" }; // lieu de la table sans OSM
    const other = { id: "osm:node/43", name: "Carrosserie Martin", addr: "", ...north(50), chainId: "" }; // voisin, autre nom
    const petit = { id: "osm:node/44", name: "Garage Petit", addr: "", ...north(70), chainId: "" }; // proche de Dupont, mais c'est Garage Petit
    for (const p of [80, 90, 100]) assert.equal((await declare(osm, "vidange", p)).status, 201);
    assert.equal((await declare(ovt, "vidange", 70)).status, 201);
    assert.equal((await declare(ovt, "clim", 65)).status, 201);
    assert.equal((await declare(other, "vidange", 500)).status, 201);
    assert.equal((await declare(petit, "vidange", 400)).status, 201);
    const dash = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.deepEqual(dash.body.paid, { vidange: { median: 85, n: 4 }, clim: { median: 65, n: 1 } });
  });

  test("a price far from what customers paid in the area (over 3 times or under a third of the median) waits for review and is not public; « confirm all » renews the others", async () => {
    await own("alice", DUPONT);
    for (const [i, p] of [60, 62, 64, 66, 68].entries()) assert.equal((await declare({ id: `osm:node/${70 + i}`, name: `Garage ${i}`, addr: "", ...north(500 * (i + 1)), chainId: "" }, "vidange", p)).status, 201);
    const far = await put("alice", DUPONT, "vidange", { kind: "fixed", price: 300 });
    assert.deepEqual([far.body.status, far.body.state], ["review", "review"]);
    assert.equal((await put("alice", DUPONT, "clim", { kind: "fixed", price: 69 })).body.status, "published", "pas assez de prix payés : publié");
    assert.equal((await put("alice", DUPONT, "plaq_av", { kind: "from", price: 119 })).body.status, "published");
    const pub = await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`));
    assert.deepEqual(pub.body.garages[0].prices.map((p) => p.service), ["clim", "plaq_av"], "le prix en relecture n'est pas public");
    await t.db.query("UPDATE pro_prices SET confirmed_at = now() - interval '200 days'");
    const before = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.deepEqual(before.body.prices.map((p) => p.state), ["stale", "stale", "review"]);
    const conf = await json(await call("alice", "POST", `/v1/pro/garages/${DUPONT}/confirm`));
    assert.deepEqual([conf.status, conf.body], [200, { confirmed: 3 }]);
    const afterwards = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.deepEqual(afterwards.body.prices.map((p) => p.state), ["ok", "ok", "review"]);
    assert.equal((await json(await call("alice", "DELETE", `/v1/pro/garages/${DUPONT}/prices/clim`))).status, 204);
    assert.equal((await json(await call("alice", "DELETE", `/v1/pro/garages/${DUPONT}/prices/clim`))).status, 404);
  });

  test("a price is « due » in the 30 days before it turns old, then « old » (marked on Pixcar) — measured against the API clock", async () => {
    await own("alice", DUPONT);
    await put("alice", DUPONT, "vidange", { kind: "fixed", price: 89 });
    clock.offset = 165 * 864e5;
    assert.equal((await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`))).body.prices[0].state, "due");
    assert.equal((await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`))).body.garages[0].prices[0].stale, false);
    clock.offset = 200 * 864e5;
    assert.equal((await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`))).body.garages[0].prices[0].stale, true);
  });

  test("public read: verified garages only, published prices only, the documented fields only; ids are checked; closed when the Pro space is", async () => {
    await own("alice", DUPONT);
    await put("alice", DUPONT, "vidange", { kind: "fixed", price: 89, vehicles: ["city"], includes: ["parts", "labour"] });
    const r = await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT},${PETIT},${DUPONT.toUpperCase()}`, undefined, { origin: ORIGIN }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "public, max-age=60");
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
    const today = new Date().toISOString().slice(0, 10);
    // annoncer un prix coche la prestation dans « Mon garage » : le comparateur l'apprend aussi
    assert.deepEqual(r.body, {
      garages: [{ id: DUPONT, verified: true, prices: [{ service: "vidange", kind: "fixed", price: 89, vehicles: ["city"], includes: ["parts", "labour"], updated: today, stale: false }], services: { offered: ["vidange"] } }],
    });
    assert.ok(!JSON.stringify(r.body).includes("dev-alice") && !JSON.stringify(r.body).includes("Camille"), "ni compte ni nom");
    for (const q of ["", "?ids=", "?ids=x!y", "?ids=" + Array.from({ length: 101 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",")])
      assert.equal((await json(await call(null, "GET", "/v1/pro/public/garages" + q))).status, 400, q);
    assert.equal((await json(await call(null, "POST", `/v1/pro/public/garages?ids=${DUPONT}`, {}))).status, 405);
    const off = await makeApp();
    try {
      assert.equal((await off.call("GET", `/v1/pro/public/garages?ids=${DUPONT}`)).status, 404);
    } finally {
      await off.close();
    }
  });

  test("visits: a visitor counts once a day per garage and kind, only for a verified garage; the dashboard shows the last 30 days and the 30 before", async () => {
    await own("alice", DUPONT);
    const visit = (garageId, kind, ip = "198.51.100.1") => t.call("POST", "/v1/pro/public/visits", { body: { garageId, kind }, ip }).then(json);
    assert.equal((await visit(DUPONT, "view")).status, 204);
    await visit(DUPONT, "view"); // même visiteur, même jour
    await visit(DUPONT, "view", "198.51.100.2");
    await visit(DUPONT, "call");
    await visit(DUPONT.toUpperCase(), "call", "198.51.100.3");
    assert.equal((await visit(PETIT, "view")).status, 204, "garage non vérifié : réponse identique, rien de compté");
    for (const body of [{ garageId: DUPONT, kind: "like" }, { garageId: "x", kind: "view" }, {}])
      assert.equal((await json(await t.call("POST", "/v1/pro/public/visits", { body }))).status, 422, JSON.stringify(body));
    const rows = (await t.db.query("SELECT garage_id, kind, day::text AS day, visitor FROM pro_visits ORDER BY kind")).rows;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.garage_id === DUPONT && /^[0-9a-f]{64}$/.test(r.visitor)), "empreinte, jamais l'adresse");
    assert.ok(!JSON.stringify(rows).includes("198.51.100"));
    await t.db.query("INSERT INTO pro_visits (garage_id, day, kind, visitor) VALUES ($1, (now() - interval '40 days')::date, 'view', $2), ($1, (now() - interval '75 days')::date, 'view', $3)", [DUPONT, "b".repeat(64), "c".repeat(64)]);
    const dash = await json(await call("alice", "GET", `/v1/pro/garages/${DUPONT}`));
    assert.deepEqual(dash.body.visits, { views: { recent: 2, previous: 1 }, calls: { recent: 2, previous: 0 } });
    const purged = await t.app.maintenance();
    assert.equal(purged.proVisits, 1, "plus de 60 jours : purgé");
  });

  test("revoking a verified garage (op pro-revoke) removes its prices: the next owner starts afresh, and nothing stays public", async () => {
    await own("alice", DUPONT);
    await put("alice", DUPONT, "vidange", { kind: "fixed", price: 89 });
    assert.equal(await t.app.pro.repo.revoke(DUPONT), 1);
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM pro_prices")).rows[0].n, 0);
    assert.deepEqual((await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`))).body, { garages: [] });
  });

  test("operations: list the prices waiting for review (op pro-prices), publish or reject one (op pro-price); bad arguments are refused", async () => {
    await own("alice", DUPONT);
    for (const [i, p] of [60, 62, 64, 66, 68].entries()) await declare({ id: `osm:node/${80 + i}`, name: `Garage ${i}`, addr: "", ...north(500 * (i + 1)), chainId: "" }, "vidange", p);
    await put("alice", DUPONT, "vidange", { kind: "fixed", price: 300 });
    const ops = createOps({ openDb: async () => ({ ...t.db, close: async () => {} }), env: {} });
    const list = await ops({ op: "pro-prices" });
    assert.equal(list.ok, true);
    assert.deepEqual(list.review.map((p) => [p.garageId, p.garageName, p.serviceId, p.kind, p.price]), [[DUPONT, "Garage Dupont", "vidange", "fixed", 300]]);
    assert.equal((await ops({ op: "pro-price", garageId: DUPONT, serviceId: "vidange", status: "deleted" })).ok, false);
    assert.equal((await ops({ op: "pro-price", garageId: "x", serviceId: "vidange", status: "published" })).ok, false);
    assert.deepEqual(await ops({ op: "pro-price", garageId: DUPONT, serviceId: "vidange", status: "published" }), { ok: true, op: "pro-price", updated: true });
    assert.equal((await json(await call(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`))).body.garages[0].prices[0].price, 300);
    assert.deepEqual((await ops({ op: "pro-prices" })).review, []);
  });

  test("CORS lets the pro page send PUT (prices) with its bearer token", async () => {
    const r = await t.app.fetch(new Request("http://api.test/v1/pro/garages/x/prices/vidange", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PUT" } }));
    assert.equal(r.status, 204);
    assert.match(r.headers.get("access-control-allow-methods"), /\bPUT\b/);
    assert.match(r.headers.get("access-control-allow-headers"), /\bauthorization\b/);
  });
});
