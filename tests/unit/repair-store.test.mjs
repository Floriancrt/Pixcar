// Stockage des réparations : mode local (tout reste dans le navigateur) et mode distant (API + base, file d'envoi hors ligne).
// Réseau, horloge, minuteries et stockage simulés ; le client HTTP réel est testé à part (api-client.test.mjs).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cellOf } from "../../server/lib/geo.mjs";
import { KEYS, areaQuery, createStore, fromApi, jsonStorage, normalizeStored, toApi } from "../../src/js/modules/repair-store.js";

// ---------------------------------------------------------------- outils
function fakeLocalStorage(initial = {}, { failWrites = false } = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => void m.delete(k),
  };
}
const read = (ls, key) => JSON.parse(ls.getItem(key) || "null");
const ok = (status = 200, data = {}) => ({ ok: true, status, data, kind: "ok", retryAfter: 0 });
const fail = (status, data, retryAfter = 0) => ({ ok: false, status, data, kind: status >= 500 ? "server" : "client", retryAfter });
const NETWORK = { ok: false, status: 0, data: null, kind: "network", retryAfter: 0 };
const TIMEOUT = { ok: false, status: 0, data: null, kind: "timeout", retryAfter: 0 };
const CIRCUIT = { ok: false, status: 0, data: null, kind: "circuit", retryAfter: 30 };

function fakeClient(handler = () => ok(201, { status: "approved" })) {
  const client = {
    calls: [],
    resets: 0,
    state: "closed",
    reset() {
      client.resets++;
    },
    async request(method, path, opts = {}) {
      const call = { method, path, ...opts };
      client.calls.push(call);
      return handler(call, client.calls.length);
    },
  };
  return client;
}

// Un magasin avec horloge, minuteries et identifiants déterministes
function make({ remote = true, ls = fakeLocalStorage(), client = fakeClient() } = {}) {
  const clock = { t: Date.parse("2026-10-02T10:00:00Z") };
  const timers = [];
  let n = 0;
  const store = createStore({
    apiBase: remote ? "https://api.test" : "",
    storage: jsonStorage(ls),
    client: remote ? client : undefined,
    now: () => clock.t,
    random: () => 0.5, // gigue neutre
    setTimer: (fn, ms) => timers.push({ fn, ms, at: clock.t + ms }) && timers.length,
    clearTimer: () => {},
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    newSecret: () => `${"ab".repeat(23)}${String(n).padStart(2, "0")}`,
  });
  const events = [];
  store.on((e) => events.push(e));
  return { store, ls, client, clock, timers, events, notices: () => events.filter((e) => e.type === "notice") };
}
const row = (over = {}) => ({ garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: 45.7347, lon: 4.9128, chainId: "norauto", model: "Peugeot 208", immat: "EZ-108-BC", year: 2019, rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-12", comment: "Très bien", ...over });
const MIN = 60_000;

// ================================================================ mode local
describe("local mode (no API configured)", () => {
  test("rows() is one live array; add and remove change it in place and persist under jg.repairs.v1", () => {
    const { store, ls, events } = make({ remote: false });
    const live = store.rows();
    assert.deepEqual(live, []);
    const r = store.add(row());
    assert.equal(store.rows(), live, "le même tableau, jamais remplacé");
    assert.equal(live.length, 1);
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(r.createdAt);
    assert.equal(read(ls, KEYS.rows).length, 1);
    assert.ok(!("deleteToken" in r) && !("sync" in r), "pas de jeton ni d'état d'envoi en mode local");
    const undone = store.remove(r.id);
    assert.deepEqual([live.length, read(ls, KEYS.rows).length, undone.index], [0, 0, 0]);
    store.restore(undone);
    assert.deepEqual([live.length, read(ls, KEYS.rows)[0].id], [1, r.id]);
    assert.deepEqual(events.map((e) => e.type), ["rows", "rows", "rows"]);
  });

  test("nothing is ever sent: no client, load / flush / preload do nothing", async () => {
    const { store, events } = make({ remote: false });
    store.add(row());
    assert.deepEqual(await store.load({ lat: 45.7, lon: 4.9, km: 10 }), { changed: false, source: "none" });
    assert.equal(store.preload({ lat: 45.7, lon: 4.9, km: 10 }), false);
    await store.flush();
    assert.equal(store.status().mode, "local");
    assert.equal(store.status().queued, 0);
    assert.ok(events.every((e) => e.type === "rows"));
  });

  test("undo puts a deleted declaration back at its place, in the middle of others too", () => {
    const { store } = make({ remote: false });
    const [a, b, c] = ["A", "B", "C"].map((n) => store.add(row({ garageName: n })));
    const gone = store.remove(b.id);
    assert.deepEqual(store.rows().map((r) => r.garageName), ["A", "C"]);
    store.restore(gone);
    assert.deepEqual(store.rows().map((r) => r.garageName), ["A", "B", "C"]);
    assert.equal(store.remove("inconnu"), null);
    assert.equal(store.restore(gone), gone.row, "restaurer deux fois ne duplique pas");
    assert.equal(store.rows().length, 3);
  });

  test("a browser that refuses to store does not break anything: the rows stay in memory", () => {
    const { store } = make({ remote: false, ls: fakeLocalStorage({}, { failWrites: true }) });
    store.add(row());
    assert.equal(store.rows().length, 1);
    assert.equal(store.storageWorks(), false);
  });
});

describe("what was stored is checked on load", () => {
  test("invalid rows are dropped, invalid plates and years removed, the old « plate » field migrated (and saved), old keys deleted", () => {
    const stored = [
      row({ id: "ok" }),
      row({ id: "plaque", immat: "<img src=x>", year: "abc" }),
      row({ id: "an", immat: "ez-108-bc", year: 1800 }),
      row({ id: "m1", model: "", plate: "AA-111-AA", immat: "EZ-108-BC", year: 2019 }),
      row({ id: "m2", model: "Dacia Sandero", plate: "AA-111-AA" }),
      { id: "x" },
      null,
      row({ id: "sans-prix", price: "59" }),
      row({ id: "mauvaise-date", date: "12/09/2026" }),
    ];
    const ls = fakeLocalStorage({ [KEYS.rows]: stored, "jg.platemodels.v1": "{}", "jg.plateapi.v1": "{}" });
    const { store } = make({ remote: false, ls });
    const by = Object.fromEntries(store.rows().map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(by).sort(), ["an", "m1", "m2", "ok", "plaque"]);
    assert.ok(!("immat" in by.plaque) && !("year" in by.plaque));
    assert.ok(!("immat" in by.an) && !("year" in by.an));
    assert.equal(by.m1.model, "Dacia Sandero", "le modèle de la plaque est repris");
    assert.ok(Object.values(by).every((r) => !("plate" in r)));
    assert.equal(by.m1.immat, "EZ-108-BC", "la nouvelle plaque et l'année survivent à la migration");
    assert.ok(read(ls, KEYS.rows).every((r) => !("plate" in r)), "la migration est enregistrée");
    assert.equal(ls.getItem("jg.platemodels.v1"), null);
    assert.equal(ls.getItem("jg.plateapi.v1"), null);
  });

  test("garbage in storage is ignored", () => {
    assert.deepEqual(normalizeStored("pas un tableau").rows, []);
    assert.deepEqual(normalizeStored(null).rows, []);
    const { store } = make({ remote: false, ls: fakeLocalStorage({ [KEYS.rows]: "{pas du json" }) });
    assert.deepEqual(store.rows(), []);
  });
});

describe("vehicle memory (survives cancelling or deleting a declaration)", () => {
  test("remembers the last vehicles, most recent first, one entry per plate, five at most", () => {
    const { store } = make({ remote: false });
    for (const [i, plate] of ["AA-111-AA", "BB-222-BB", "CC-333-CC", "DD-444-DD", "EE-555-EE", "FF-666-FF"].entries()) store.add(row({ immat: plate, model: `Modèle ${i}`, year: 2000 + i }));
    store.add(row({ immat: "CC-333-CC", model: "Modèle 2 bis", year: 2002 }));
    const v = store.vehicles();
    assert.equal(v.length, 5);
    assert.deepEqual(v.map((x) => x.plate), ["CC-333-CC", "FF-666-FF", "EE-555-EE", "DD-444-DD", "BB-222-BB"]);
    assert.equal(v[0].model, "Modèle 2 bis");
  });
  test("deleting every declaration keeps the vehicle", () => {
    const { store } = make({ remote: false });
    const r = store.add(row());
    store.remove(r.id);
    assert.equal(store.rows().length, 0);
    assert.deepEqual(store.vehicles().map((v) => [v.model, v.plate, v.year]), [["Peugeot 208", "EZ-108-BC", 2019]]);
  });
  test("seeded from the declarations already stored (oldest first), and then persisted on its own", () => {
    const ls = fakeLocalStorage({ [KEYS.rows]: [row({ id: "1", createdAt: "2026-01-01T00:00:00Z", model: "Renault Clio", immat: "AA-111-AA" }), row({ id: "2", createdAt: "2026-06-01T00:00:00Z", model: "Peugeot 208" })] });
    const { store } = make({ remote: false, ls });
    assert.deepEqual(store.vehicles().map((v) => v.model), ["Peugeot 208", "Renault Clio"]);
    assert.equal(read(ls, KEYS.vehicles).length, 2);
    const again = make({ remote: false, ls }).store;
    again.add(row({ model: "Dacia Duster", immat: "ZZ-999-ZZ" }));
    assert.equal(again.vehicles()[0].model, "Dacia Duster");
  });
  test("a declaration without a model is not remembered", () => {
    const { store } = make({ remote: false });
    store.add(row({ model: "", immat: undefined }));
    assert.deepEqual(store.vehicles(), []);
  });
});

// ================================================================ conversions
describe("toApi / fromApi / areaQuery", () => {
  test("a page row becomes the request body (without page-only fields)", () => {
    const body = toApi({ ...row({ id: "i", deleteToken: "t".repeat(32), createdAt: "x", sync: "pending" }) });
    assert.deepEqual(body, {
      id: "i", deleteToken: "t".repeat(32),
      garage: { id: "osm:node/1022", name: "Norauto Bron", addr: "98 rue Marcel Mérieux, 69100 Bron", lat: 45.7347, lon: 4.9128, chainId: "norauto" },
      area: { lat: 45.7347, lon: 4.9128 },
      serviceId: "vidange", price: 59.9, date: "2026-09-12", rating: 4, comment: "Très bien",
      vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" },
    });
  });
  test("a garage typed by hand gets a clean id and the search position; ids the API does not know become custom ones", () => {
    const hand = toApi(row({ garageId: "custom:garage-du-coin", garageName: "Garage du Coin", lat: null, lon: null, area: { lat: 45.7, lon: 4.8 } }));
    assert.deepEqual([hand.garage.id, hand.garage.lat, hand.garage.lon, hand.area], ["custom:garage-du-coin", null, null, { lat: 45.7, lon: 4.8 }]);
    const long = toApi(row({ garageId: "custom:" + "a-".repeat(60), garageName: "Établissement Müller & Fils — Réparations toutes marques " + "x".repeat(100), lat: null, lon: null }));
    assert.match(long.garage.id, /^custom:[a-z0-9-]{1,80}$/);
    assert.ok(!long.garage.id.endsWith("-"));
    assert.ok(long.garage.name.length <= 120);
    const ct = toApi(row({ garageId: "ct:12345", garageName: "Contrôle Auto 69" }));
    assert.equal(ct.garage.id, "custom:controle-auto-69");
    assert.equal(ct.garage.lat, 45.7347, "sa position reste connue");
    assert.equal(toApi(row({ chainId: "Norauto!" })).garage.chainId, "");
    assert.equal(toApi(row({ lat: null, lon: null })).area, undefined, "sans position ni point de recherche, l'API réclamera « area »");
  });
  test("an API answer becomes shared rows, month → first day; everything suspicious is skipped", () => {
    const rows = fromApi({
      garages: [
        { id: "osm:node/1", name: "Norauto", addr: "1 rue X", lat: 45.7, lon: 4.8, chainId: "norauto", repairs: [
          { id: "a", serviceId: "vidange", price: 59.9, month: "2026-09", rating: 4, model: "Clio", year: 2019 },
          { id: "b", serviceId: "vidange", price: -5, month: "2026-09", rating: 4, model: "x", year: 2019 },
          { id: "c", serviceId: "vidange", price: 60, month: "septembre", rating: 4, model: "x", year: 2019 },
          { id: "d", serviceId: "vidange", price: 61, month: "2026-08", rating: 9, model: "<img>", year: 1800 },
          null,
        ] },
        { id: 12, name: "pas valide", repairs: [] },
        null,
      ],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: "a", garageId: "osm:node/1", garageName: "Norauto", garageAddr: "1 rue X", lat: 45.7, lon: 4.8, chainId: "norauto", model: "Clio", year: 2019, rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-01", shared: true });
    assert.equal(rows[1].rating, 0, "une note hors 1-5 devient « non notée »");
    assert.equal(rows[1].year, undefined);
    assert.deepEqual(fromApi(null), []);
    assert.deepEqual(fromApi({ garages: "x" }), []);
  });
  test("the area asked for is the CENTRE of the 0.05° cell, so every visitor of a district shares one cache entry; the server finds the same cell", () => {
    const a = areaQuery(45.7347, 4.9128, 10), b = areaQuery(45.7301, 4.9101, 10);
    assert.equal(a.query, b.query);
    assert.equal(a.key, "45.725,4.925,10");
    for (const [lat, lon] of [[45.7347, 4.9128], [48.8566, 2.3522], [-20.8823, 55.4504], [14.6415, -61.0242], [0, 0], [-0.01, -0.01], [43.2965, 5.3698]]) {
      const q = areaQuery(lat, lon, 5);
      const [la, lo] = q.key.split(",").map(Number);
      assert.deepEqual(cellOf(la, lo), cellOf(lat, lon), `${lat},${lon}`);
    }
  });
  test("the radius is rounded up to one the API offers", () => {
    for (const [km, want] of [[1, 3], [3, 3], [4, 5], [7, 10], [10, 10], [25, 30], [50, 50], [100, 50]]) assert.equal(areaQuery(45.7, 4.9, km).key.split(",")[2], String(want), `${km} km`);
  });
});

// ================================================================ mode distant
describe("remote mode: declaring", () => {
  test("a new declaration is visible at once, gets a UUID and a secret, and is sent in the background", async () => {
    const { store, client, ls, events } = make();
    const r = store.add(row());
    assert.equal(store.rows().length, 1, "visible avant même la fin de l'envoi");
    assert.equal(r.sync, "pending");
    assert.match(r.deleteToken, /^[0-9a-f]{48}$/);
    await store.flush();
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].method, "POST");
    assert.equal(client.calls[0].path, "/v1/repairs");
    assert.equal(client.calls[0].body.id, r.id);
    assert.equal(client.calls[0].body.deleteToken, r.deleteToken);
    assert.equal(client.calls[0].body.vehicle.plate, "EZ-108-BC");
    assert.equal(r.sync, "synced");
    assert.deepEqual(read(ls, KEYS.outbox), []);
    assert.equal(read(ls, KEYS.rows)[0].sync, "synced");
    assert.equal(store.status().pending, 0);
    assert.deepEqual(events.filter((e) => e.type === "row"), [{ type: "row", id: r.id }], "l'étiquette « en attente » doit pouvoir être mise à jour");
  });

  test("a declaration held for review is flagged, and still visible to its author", async () => {
    const { store } = make({ client: fakeClient(() => ok(201, { status: "pending" })) });
    const r = store.add(row({ price: 900 }));
    await store.flush();
    assert.deepEqual([r.sync, r.review], ["synced", "pending"]);
  });

  test("API down: the declaration stays, the user is told once, and it goes out later with a growing delay", async () => {
    let up = false;
    const { store, client, clock, notices, ls } = make({ client: fakeClient(() => (up ? ok(201) : NETWORK)) });
    const r = store.add(row());
    await store.flush();
    assert.equal(r.sync, "pending");
    assert.equal(store.status().pending, 1);
    assert.deepEqual(notices().map((n) => n.kind), ["queued"]);
    const op = read(ls, KEYS.outbox)[0];
    assert.equal(op.tries, 1);
    assert.equal(op.next, clock.t + 15_000, "premier délai : 15 s");
    await store.flush(); // trop tôt : rien ne part
    assert.equal(client.calls.length, 1);
    clock.t += 15_001;
    await store.flush();
    assert.equal(client.calls.length, 2);
    assert.equal(read(ls, KEYS.outbox)[0].next, clock.t + 30_000, "puis 30 s");
    clock.t += 30_001;
    await store.flush();
    assert.equal(read(ls, KEYS.outbox)[0].next, clock.t + 60_000, "puis 60 s");
    assert.deepEqual(notices().map((n) => n.kind), ["queued"], "on ne prévient qu'une fois");
    up = true;
    clock.t += 60_001;
    await store.flush();
    assert.equal(r.sync, "synced");
    assert.equal(store.status().pending, 0);
  });

  test("the delay stops growing at 15 minutes; 429 waits at least a minute; a timeout or 5xx is retried like a network failure", async () => {
    const answers = [fail(503), TIMEOUT, NETWORK, NETWORK, NETWORK, NETWORK, NETWORK, NETWORK];
    const { store, clock, ls } = make({ client: fakeClient(() => answers.shift()) });
    store.add(row());
    const delays = [];
    for (let i = 0; i < 8; i++) {
      await store.flush();
      delays.push(read(ls, KEYS.outbox)[0].next - clock.t);
      clock.t += delays.at(-1) + 1;
    }
    assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    const limited = make({ client: fakeClient(() => fail(429, { error: { code: "rate_limited" } }, 5)) });
    limited.store.add(row());
    await limited.store.flush();
    assert.equal(read(limited.ls, KEYS.outbox)[0].next - limited.clock.t, 60_000);
    const longer = make({ client: fakeClient(() => fail(429, {}, 600)) });
    longer.store.add(row());
    await longer.store.flush();
    assert.equal(read(longer.ls, KEYS.outbox)[0].next - longer.clock.t, 600_000, "le délai demandé par le serveur, s'il est plus long");
  });

  test("the queue survives a reload: pending declarations are sent when the page comes back", async () => {
    const ls = fakeLocalStorage();
    let up = false;
    const first = make({ ls, client: fakeClient(() => (up ? ok(201) : NETWORK)) });
    const r = first.store.add(row());
    await first.store.flush();
    const second = make({ ls, client: fakeClient(() => ok(201)) });
    assert.equal(second.store.rows()[0].id, r.id);
    assert.equal(second.store.rows()[0].sync, "pending");
    assert.equal(second.store.status().pending, 1);
    second.clock.t = first.clock.t + 20_000;
    await second.store.flush();
    assert.equal(second.client.calls.length, 1);
    assert.equal(second.client.calls[0].body.id, r.id);
    assert.equal(second.store.rows()[0].sync, "synced");
  });

  test("the circuit breaker open: no attempt is used up, the user is told once, the loop stops", async () => {
    const { store, client, notices, ls, clock } = make({ client: fakeClient(() => CIRCUIT) });
    store.add(row());
    store.add(row({ garageName: "Autre", price: 70 }));
    await store.flush();
    assert.equal(client.calls.length, 1, "inutile d'insister sur les suivantes");
    const [op] = read(ls, KEYS.outbox);
    assert.equal(op.tries, 0);
    assert.equal(op.next, clock.t + 30_000);
    assert.deepEqual(notices().map((n) => n.kind), ["queued"]);
  });

  test("permanent refusals: 422 keeps the row on this device (never shared) and says why; a duplicate removes the copy; nothing is retried", async () => {
    const refused = make({ client: fakeClient(() => fail(422, { error: { code: "validation", fields: { price: "x" } } })) });
    const r = refused.store.add(row());
    await refused.store.flush();
    assert.equal(r.sync, "local");
    assert.equal(refused.store.rows().length, 1);
    assert.deepEqual(refused.notices().map((n) => [n.kind, n.fields]), [["rejected", { price: "x" }]]);
    assert.deepEqual(read(refused.ls, KEYS.outbox), []);
    await refused.store.flush();
    assert.equal(refused.client.calls.length, 1);

    const dup = make({ client: fakeClient(() => fail(409, { error: { code: "duplicate" } })) });
    dup.store.add(row());
    await dup.store.flush();
    assert.equal(dup.store.rows().length, 0, "la première déclaration compte déjà, la copie ferait double emploi");
    assert.deepEqual(dup.notices().map((n) => n.kind), ["duplicate"]);
    assert.deepEqual(read(dup.ls, KEYS.rows), []);

    for (const status of [400, 403, 413, 415]) {
      const m = make({ client: fakeClient(() => fail(status, { error: { code: "x" } })) });
      const x = m.store.add(row());
      await m.store.flush();
      assert.deepEqual([x.sync, m.notices()[0].kind], ["local", "rejected"], String(status));
    }
  });

  test("an id already taken by someone else (a 1 in 2¹²² event) gets a fresh id and secret and is sent again", async () => {
    let first = true;
    const { store, client, timers } = make({ client: fakeClient(() => (first ? ((first = false), fail(409, { error: { code: "id_conflict" } })) : ok(201))) });
    const r = store.add(row());
    const oldId = r.id;
    await store.flush();
    assert.notEqual(r.id, oldId);
    assert.equal(timers.at(-1).ms, 0, "un nouvel essai est demandé tout de suite");
    await store.flush();
    assert.equal(client.calls[1].body.id, r.id);
    assert.equal(r.sync, "synced");
  });

  test("declarations stored before the API existed are never sent: they stay on this device", async () => {
    const legacy = row({ id: "ancienne" });
    const ls = fakeLocalStorage({ [KEYS.rows]: [legacy] });
    const { store, client } = make({ ls });
    assert.equal(store.rows()[0].sync, "local");
    store.attach({ addEventListener() {}, document: { addEventListener() {}, hidden: false } });
    await store.flush();
    assert.equal(client.calls.length, 0);
    const added = store.add(row());
    await store.flush();
    assert.deepEqual(client.calls.map((c) => c.body.id), [added.id]);
    const gone = store.remove("ancienne");
    await store.flush();
    assert.equal(client.calls.length, 1, "retirer une ancienne ne demande rien au serveur");
    assert.equal(gone.row.id, "ancienne");
  });

  test("giving up: a declaration that could not leave for 7 days stays on this device, and the user is told", async () => {
    const { store, clock, notices, ls } = make({ client: fakeClient(() => NETWORK) });
    const r = store.add(row());
    await store.flush();
    clock.t += 7 * 864e5 + 1000;
    await store.flush();
    assert.equal(r.sync, "local");
    assert.deepEqual(read(ls, KEYS.outbox), []);
    assert.deepEqual(notices().map((n) => n.kind), ["queued", "gaveup"]);
  });
});

describe("remote mode: removing and undoing", () => {
  test("removing a synced declaration asks the server with its secret; « not found » counts as done; a failure is retried", async () => {
    let step = 0;
    const { store, client, clock, ls } = make({ client: fakeClient((c) => (c.method === "POST" ? ok(201) : ++step === 1 ? NETWORK : ok(404, { error: { code: "not_found" } }))) });
    const r = store.add(row());
    await store.flush();
    const gone = store.remove(r.id);
    await store.flush();
    assert.equal(client.calls.at(-1).method, "DELETE");
    assert.equal(client.calls.at(-1).path, `/v1/repairs/${r.id}`);
    assert.equal(client.calls.at(-1).headers["x-delete-token"], r.deleteToken);
    assert.equal(read(ls, KEYS.outbox).length, 1, "échec réseau : la suppression reste en file");
    assert.equal(store.rows().length, 0, "mais elle est déjà visible dans la page");
    clock.t += 15_001;
    await store.flush();
    assert.deepEqual(read(ls, KEYS.outbox), []);
    assert.equal(gone.row.id, r.id);
  });

  test("removing a declaration that never left (breaker open): no POST, no DELETE, nothing left in the queue", async () => {
    const { store, client } = make({ client: fakeClient(() => CIRCUIT) });
    const r = store.add(row());
    await store.flush();
    const sent = client.calls.length;
    assert.equal(store.status().queued, 1);
    store.remove(r.id);
    await store.flush();
    assert.equal(client.calls.length, sent, "la déclaration n'est jamais partie : rien à retirer chez le serveur");
    assert.equal(store.status().queued, 0);
    assert.equal(store.rows().length, 0);
  });

  test("removing a declaration whose first send failed (outcome unknown) sends a DELETE and cancels the POST", async () => {
    let n = 0;
    const { store, client, clock, ls } = make({ client: fakeClient((c) => (++n === 1 ? TIMEOUT : c.method === "DELETE" ? ok(404) : ok(201))) });
    const r = store.add(row());
    await store.flush();
    assert.equal(read(ls, KEYS.outbox)[0].op, "post");
    store.remove(r.id);
    assert.deepEqual(read(ls, KEYS.outbox).map((o) => o.op), ["delete"]);
    await store.flush();
    clock.t += 1; // la suppression est prête tout de suite
    await store.flush();
    assert.equal(client.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(client.calls.filter((c) => c.method === "DELETE").length, 1);
    assert.deepEqual(read(ls, KEYS.outbox), []);
  });

  test("undo after the removal reached the server's side: the same declaration is posted again, same id and same secret", async () => {
    const { store, client, ls } = make({ client: fakeClient((c) => (c.method === "POST" ? ok(201) : NETWORK)) });
    const r = store.add(row());
    await store.flush();
    const first = store.remove(r.id);
    await store.flush(); // le DELETE part (et échoue : on ignore s'il est arrivé)
    assert.equal(client.calls.at(-1).method, "DELETE");
    store.restore(first);
    assert.equal(store.rows().length, 1);
    assert.equal(r.sync, "pending", "la suppression est peut-être arrivée : on redépose");
    assert.deepEqual(read(ls, KEYS.outbox).map((o) => o.op), ["post"]);
    await store.flush();
    const last = client.calls.at(-1);
    assert.deepEqual([last.method, last.body.id, last.body.deleteToken], ["POST", r.id, r.deleteToken]);
    assert.equal(r.sync, "synced");
  });

  test("undo of a removal that is still queued (not sent) simply cancels it", async () => {
    const { store, client } = make({ client: fakeClient(() => ok(201)) });
    const r = store.add(row());
    await store.flush();
    client.request = async (...a) => (client.calls.push({ method: a[0] }), CIRCUIT); // disjoncteur ouvert : la suppression ne part pas
    const gone = store.remove(r.id);
    await store.flush();
    const calls = client.calls.length;
    store.restore(gone);
    assert.deepEqual([store.rows().length, r.sync, store.status().queued], [1, "synced", 0]);
    await store.flush();
    assert.equal(client.calls.length, calls, "rien n'est envoyé : la déclaration n'a jamais quitté le serveur");
  });

  test("removing while the declaration is being sent: the DELETE follows the POST, and the row does not come back", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const seen = [];
    const { store } = make({ client: fakeClient(async (c) => (seen.push(c.method), c.method === "POST" ? (await gate, ok(201)) : ok(204))) });
    const r = store.add(row());
    await Promise.resolve(); // le POST est parti
    assert.deepEqual(seen, ["POST"]);
    store.remove(r.id);
    release();
    await store.flush();
    await store.flush();
    assert.deepEqual(seen, ["POST", "DELETE"]);
    assert.equal(store.rows().length, 0);
    assert.equal(store.status().queued, 0);
  });

  test("operations on one declaration keep their order even when the first is waiting for its retry", async () => {
    let n = 0;
    const { store, client, clock } = make({ client: fakeClient((c) => (c.method === "POST" && ++n === 1 ? NETWORK : ok(201))) });
    const r = store.add(row());
    await store.flush(); // POST échoué, en attente
    const other = store.add(row({ garageName: "Autre garage", price: 80 }));
    await store.flush();
    assert.equal(other.sync, "synced", "une autre déclaration n'est pas retenue par celle qui attend");
    assert.equal(r.sync, "pending");
    clock.t += 15_001;
    await store.flush();
    assert.equal(r.sync, "synced");
  });
});

describe("remote mode: reading what others declared", () => {
  const AREA = { v: 1, garages: [{ id: "osm:node/1022", name: "Norauto Bron", addr: "98 rue X", lat: 45.73, lon: 4.91, chainId: "norauto", repairs: [{ id: "s1", serviceId: "vidange", price: 71, month: "2026-08", rating: 5, model: "Renault Clio", year: 2018 }, { id: "s2", serviceId: "vidange", price: 80, month: "2026-07", rating: 3, model: "Dacia Sandero", year: 2020 }] }] };

  test("load asks for the centre of the cell, adds the rows as shared ones, and tells whether anything changed", async () => {
    const { store, client, events } = make({ client: fakeClient(() => ok(200, AREA)) });
    const out = await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.deepEqual([out.changed, out.source], [true, "network"]);
    assert.equal(client.calls[0].path, "/v1/repairs?lat=45.725&lon=4.925&radius=10");
    assert.equal(store.rows().length, 2);
    assert.ok(store.rows().every((r) => r.shared === true));
    assert.equal(store.status().api, "ok");
    const before = events.length;
    const again = await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.equal(again.changed, false, "même réponse : rien à réafficher");
    assert.ok(!events.slice(before).some((e) => e.type === "rows"));
  });

  test("a declaration of this browser and the same one coming back from the API count once (the browser's copy, with its secret, wins)", async () => {
    const mine = "00000000-0000-4000-8000-000000000001";
    const area = JSON.parse(JSON.stringify(AREA));
    area.garages[0].repairs.push({ id: mine, serviceId: "vidange", price: 59.9, month: "2026-09", rating: 4, model: "Peugeot 208", year: 2019 });
    const { store } = make({ client: fakeClient((c) => (c.method === "POST" ? ok(201) : ok(200, area))) });
    const own = store.add(row());
    assert.equal(own.id, mine);
    await store.flush();
    await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.equal(store.rows().filter((r) => r.id === mine).length, 1);
    assert.equal(store.rows().find((r) => r.id === mine).shared, undefined);
    assert.equal(store.rows().length, 3);
  });

  test("when the API fails the last good answer for that area is served, flagged stale; without one the state is « down »", async () => {
    let up = true;
    const { store, ls } = make({ client: fakeClient(() => (up ? ok(200, AREA) : NETWORK)) });
    await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.equal(Object.keys(read(ls, KEYS.area)).length, 1);
    up = false;
    const stale = await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.deepEqual([stale.source, stale.stale], ["cache", true]);
    assert.equal(store.status().api, "stale");
    assert.equal(store.rows().length, 2, "les réparations restent affichées");
    const other = await store.load({ lat: 43.3, lon: 5.4, km: 10 });
    assert.deepEqual([other.source, other.changed], ["none", false]);
    assert.equal(store.status().api, "down");
  });

  test("a copy older than a week is not served; at most six areas are kept", async () => {
    const { store, ls, clock, client } = make({ client: fakeClient(() => ok(200, AREA)) });
    for (let i = 0; i < 8; i++) {
      clock.t += 1000;
      await store.load({ lat: 40 + i, lon: 3, km: 10 });
    }
    assert.equal(Object.keys(read(ls, KEYS.area)).length, 6);
    client.request = async () => NETWORK;
    clock.t += 8 * 864e5;
    assert.equal((await store.load({ lat: 47, lon: 3, km: 10 })).source, "none");
  });

  test("preload serves the saved answer synchronously, so the very first render already includes it", async () => {
    const ls = fakeLocalStorage();
    const first = make({ ls, client: fakeClient(() => ok(200, AREA)) });
    await first.store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    const second = make({ ls, client: fakeClient(() => NETWORK) });
    assert.equal(second.store.rows().length, 0);
    assert.equal(second.store.preload({ lat: 45.7347, lon: 4.9128, km: 10 }), true);
    assert.equal(second.store.rows().length, 2);
    assert.equal(second.store.preload({ lat: 10, lon: 10, km: 10 }), false);
  });

  test("tampered area data in storage cannot inject anything", async () => {
    const ls = fakeLocalStorage({ [KEYS.area]: { "45.725,4.925,10": { at: Date.parse("2026-10-02T09:59:00Z"), body: { garages: [{ id: "osm:node/1", name: "<img src=x onerror=alert(1)>", repairs: [{ id: "x", serviceId: "vidange", price: "gratuit", month: "2026-09" }, { id: "y", serviceId: "vidange", price: 50, month: "2026-09", rating: 4, model: "A".repeat(500) }] }] } } } });
    const { store } = make({ ls });
    store.preload({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.equal(store.rows().length, 1);
    assert.equal(store.rows()[0].model.length, 60);
  });

  test("shared rows never reach vehicle memory or the list of own declarations", async () => {
    const { store } = make({ client: fakeClient(() => ok(200, AREA)) });
    await store.load({ lat: 45.7347, lon: 4.9128, km: 10 });
    assert.deepEqual(store.vehicles(), []);
    assert.deepEqual(store.own(), []);
  });
});

describe("remote mode: wiring to the page", () => {
  const fakeWindow = () => {
    const w = { handlers: {}, document: { hidden: true, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }, addEventListener(t, f) { this.handlers[t] = f; } };
    return w;
  };
  test("when the network comes back the breaker is reset and the queue goes out at once; coming back to the tab does the same", async () => {
    let up = false;
    const { store, client, clock } = make({ client: fakeClient(() => (up ? ok(201) : NETWORK)) });
    const r = store.add(row());
    await store.flush();
    const w = fakeWindow();
    store.attach(w);
    up = true;
    await w.handlers.online();
    await store.flush();
    assert.equal(client.resets, 1);
    assert.equal(r.sync, "synced", "sans attendre la fin du délai");
    // retour sur l'onglet
    up = false;
    const r2 = store.add(row({ garageName: "B" }));
    await store.flush();
    up = true;
    clock.t += 15_001;
    w.document.hidden = false;
    await w.document.handlers.visibilitychange();
    await store.flush();
    assert.equal(r2.sync, "synced");
  });
  test("a hidden tab does not wake the queue", async () => {
    const { store, client } = make({ client: fakeClient(() => NETWORK) });
    const w = fakeWindow();
    store.attach(w);
    const calls = client.calls.length;
    await w.document.handlers.visibilitychange();
    assert.equal(client.calls.length, calls);
  });
  test("a retry is scheduled at the earliest due time", async () => {
    const { store, timers } = make({ client: fakeClient(() => NETWORK) });
    store.add(row());
    await store.flush();
    assert.equal(timers.at(-1).ms, 15_000);
  });
  test("status() reports what the page needs to inform the visitor", async () => {
    const { store } = make({ client: fakeClient(() => NETWORK) });
    assert.deepEqual(store.status(), { mode: "remote", api: "unknown", pending: 0, queued: 0, circuit: "closed" });
    store.add(row());
    await store.flush();
    assert.equal(store.status().pending, 1);
    assert.equal(store.status().queued, 1);
  });
});
