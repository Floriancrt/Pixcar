// Espace Pro, « Mon garage » (docs/rendez-vous.md, lot 1) : fiche déclarée (site, e-mail, horaires), changements de nom, d'adresse et de
// téléphone relus par Pixcar, prestations faites ou non et leur temps moyen (privé), registre officiel, lecture publique. Base réelle (PGlite).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { ORIGIN, makeApp } from "./helpers.mjs";
import { createOps } from "../ops.mjs";

const HERE = { lat: 43.2174, lon: 1.1014 }; // Cazères
const DUPONT = "aaaaaaaa-0000-4000-8000-000000000001";
const PETIT = "aaaaaaaa-0000-4000-8000-000000000008";
const CONTACTS = [
  { id: DUPONT, name: "Garage Dupont", addr: "12 rue de l'Exemple", pc: "31220", ...HERE, emails: ["contact@garage-dupont.fr"], phones: ["+33561000001"] },
  { id: PETIT, name: "Garage Petit", pc: "31220", lat: HERE.lat + 0.001, lon: HERE.lon, emails: ["petit@garage-petit.fr"] },
];
const SIRET = "73282932000074";
const REGISTRY = { [SIRET]: { siret: SIRET, name: "Garage Dupont", company: "DUPONT AUTOMOBILES", addr: "12 RUE DE L'EXEMPLE 31220 CAZERES", naf: "45.20A", active: true, lat: HERE.lat, lon: HERE.lon, pc: "31220" } };
const HOURS = { mo: [["08:00", "12:00"], ["14:00", "18:30"]], tu: [["08:00", "12:00"], ["14:00", "18:30"]], sa: [["08:00", "12:00"]] };

describe("Espace Pro : Mon garage", () => {
  let t, registry;
  const as = (who) => ({ "x-pro-dev-account": who });
  const call = (who, method, path, body, extra = {}) => t.call(method, path, { body, headers: who ? as(who) : {}, ...extra });
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers });
  const req = (who, method, path, body) => call(who, method, path, body).then(json);
  const own = (who, garageId) =>
    t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, $4, 'verified', 'email', 'Camille Durand', 'manager', $5, 'c•••••@garage-dupont.fr', now())",
      [crypto.randomUUID(), "dev-" + who, garageId, SIRET, "a".repeat(64)],
    );
  const G = `/v1/pro/garages/${DUPONT}`;
  const ops = () => createOps({ openDb: async () => ({ ...t.db, close: async () => {} }), env: {} });
  const publicOf = async (id = DUPONT) => (await req(null, "GET", `/v1/pro/public/garages?ids=${id}`)).body.garages[0];

  before(async () => {
    registry = { fail: false, calls: 0 };
    t = await makeApp({
      env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", WRITE_LIMIT_PER_HOUR: "1000" },
      proOptions: {
        sirene: async (siret) => {
          registry.calls++;
          if (registry.fail) throw new Error("injoignable");
          return REGISTRY[siret] || null;
        },
      },
    });
  });
  after(() => t.close());
  beforeEach(async () => {
    registry.fail = false;
    await t.reset();
    const { rows, rejected } = parseContactRows(CONTACTS);
    assert.equal(rejected, 0);
    await t.app.pro.repo.upsertContacts(rows, "test-1");
  });

  test("every route answers only for a garage verified on THIS account (401 without an account, 404 otherwise); wrong methods get 405", async () => {
    await own("alice", DUPONT);
    const routes = [
      ["GET", "/profile"],
      ["PUT", "/profile", { website: "garage-dupont.fr" }],
      ["POST", "/changes", { field: "name", value: "Dupont Auto" }],
      ["DELETE", "/changes/11111111-1111-4111-8111-111111111111"],
      ["PUT", "/services/vidange", { offered: true, minutes: 45 }],
      ["GET", "/registry"],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await req(null, method, G + path, body)).status, 401, `${method} ${path} sans compte`);
      const r = await req("bob", method, G + path, body);
      assert.equal(r.status, 404, `${method} ${path} par un autre compte`);
      assert.equal(r.body.error.code, "not_found");
      assert.equal((await req("alice", method, `/v1/pro/garages/${PETIT}${path}`, body)).status, 404, `${method} ${path} sur un garage non rattaché`);
    }
    for (const [method, path] of [["POST", "/profile"], ["DELETE", "/profile"], ["PUT", "/registry"], ["GET", "/changes"], ["PUT", "/changes/x"], ["GET", "/services/vidange"]]) {
      const r = await req("alice", method, G + path, method === "GET" ? undefined : {});
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.ok(r.headers.get("allow"), `${method} ${path} : en-tête Allow`);
    }
    assert.equal((await req("alice", "GET", G + "/services")).status, 404);
    assert.equal((await req("alice", "GET", "/v1/pro/garages/pas-un-id!/profile")).status, 404);
  });

  test("the profile starts empty: the public data of the garage (never its private verification contacts), nothing declared, the 17 services undecided", async () => {
    await own("alice", DUPONT);
    const r = await req("alice", "GET", G + "/profile");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(r.body.garage, { id: DUPONT, name: "Garage Dupont", addr: "12 rue de l'Exemple", pc: "31220" });
    assert.deepEqual(r.body.profile, { name: "", addr: null, phone: "", website: "", email: "", hours: null, updatedAt: null });
    assert.deepEqual(r.body.changes, []);
    assert.equal(r.body.services.length, 17);
    assert.ok(!r.body.services.some((s) => s.service === "ct"), "contrôle technique exclu");
    assert.ok(r.body.services.every((s) => s.offered === null && s.minutes === null));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes("contact@garage-dupont.fr") && !text.includes("561000001"), "les contacts privés ne sortent jamais");
  });

  test("site, displayed e-mail and opening hours are validated, normalised and published at once; absent fields stay as they are, empty ones clear", async () => {
    await own("alice", DUPONT);
    const ok = await req("alice", "PUT", G + "/profile", { website: "Garage-Dupont.fr", email: " Atelier@Garage-Dupont.FR ", hours: HOURS });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.website, "https://garage-dupont.fr/");
    assert.equal(ok.body.email, "atelier@garage-dupont.fr");
    assert.deepEqual(ok.body.hours, HOURS);
    const bad = async (body, field) => {
      const r = await req("alice", "PUT", G + "/profile", body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(r.body.error.field, field, JSON.stringify(r.body));
    };
    await bad({ website: "javascript:alert(1)" }, "website");
    await bad({ website: "https://user:pass@garage-dupont.fr" }, "website");
    await bad({ website: "pas un site" }, "website");
    await bad({ website: "http://localhost" }, "website");
    await bad({ email: "atelier@" }, "email");
    await bad({ email: "a..b@garage.fr" }, "email");
    await bad({ hours: { mo: [["08:00", "12:00"], ["11:00", "18:00"]] } }, "hours"); // chevauchement
    await bad({ hours: { mo: [["14:00", "18:00"], ["08:00", "12:00"]] } }, "hours"); // désordre
    await bad({ hours: { mo: [["08:00", "10:00"], ["10:30", "12:00"], ["14:00", "18:00"]] } }, "hours"); // trois plages
    await bad({ hours: { mo: [["08:10", "12:00"]] } }, "hours"); // pas au quart d'heure
    await bad({ hours: { mo: [["12:00", "08:00"]] } }, "hours");
    await bad({ hours: { mo: [["25:00", "26:00"]] } }, "hours");
    await bad({ hours: { monday: [["08:00", "12:00"]] } }, "hours");
    await bad({ hours: [] }, "hours");
    await bad({ name: "Dupont Auto" }, "name"); // nom, adresse, téléphone : par une demande de changement
    assert.equal((await req("alice", "PUT", G + "/profile", {})).status, 422);
    assert.equal((await req("alice", "PUT", G + "/profile", [1])).status, 422);
    // une saisie partielle ne touche pas au reste ; une valeur vide efface
    const part = await req("alice", "PUT", G + "/profile", { email: "" });
    assert.deepEqual([part.body.website, part.body.email, part.body.hours], ["https://garage-dupont.fr/", "", HOURS]);
    const cleared = await req("alice", "PUT", G + "/profile", { website: "", hours: null });
    assert.deepEqual([cleared.body.website, cleared.body.hours], ["", null]);
    const day = await req("alice", "PUT", G + "/profile", { hours: { su: [["00:00", "24:00"]] } });
    assert.equal(day.status, 200, "un jour entier se déclare de 00:00 à 24:00");
  });

  test("name, address and phone go through a review: one pending change per field (a new one replaces it), cancellable, invisible to the public until approved", async () => {
    await own("alice", DUPONT);
    const post = (field, value) => req("alice", "POST", G + "/changes", { field, value });
    for (const [field, value] of [
      ["website", "x.fr"],
      ["name", "x"],
      ["name", "1234"],
      ["addr", { street: "12 rue X", pc: "3122", city: "Cazères" }],
      ["addr", "12 rue X, 31220 Cazères"],
      ["phone", "12"],
      ["phone", "05 61 00 00 01 ou 06 00 00 00 00"],
    ]) {
      const r = await post(field, value);
      assert.equal(r.status, 422, JSON.stringify([field, value]));
    }
    const name = await post("name", "  Dupont   Automobiles ");
    assert.equal(name.status, 201);
    assert.deepEqual([name.body.field, name.body.value, name.body.status], ["name", "Dupont Automobiles", "pending"]);
    const phone1 = await post("phone", "05 61 00 00 02");
    const phone2 = await post("phone", "+33 5 61 00 00 03");
    assert.equal(phone2.body.value, "+33561000003");
    const addr = await post("addr", { street: "14 rue de l'Exemple", pc: "31220", city: "Cazères" });
    assert.deepEqual(addr.body.value, { street: "14 rue de l'Exemple", pc: "31220", city: "Cazères" });
    const listed = (await req("alice", "GET", G + "/profile")).body.changes;
    assert.deepEqual(listed.map((c) => [c.field, c.status]).sort(), [["addr", "pending"], ["name", "pending"], ["phone", "pending"]], "le premier changement de téléphone est remplacé");
    assert.ok(!listed.some((c) => c.id === phone1.body.id));
    assert.equal((await t.db.query("SELECT status FROM pro_profile_changes WHERE id = $1", [phone1.body.id])).rows[0].status, "cancelled");
    // rien de public avant la relecture
    assert.equal((await publicOf()).profile, undefined);
    // annulation
    assert.equal((await req("alice", "DELETE", `${G}/changes/${addr.body.id}`)).status, 204);
    assert.equal((await req("alice", "DELETE", `${G}/changes/${addr.body.id}`)).status, 404, "déjà annulé");
    assert.equal((await req("alice", "DELETE", `${G}/changes/pas-un-uuid`)).status, 404);
    await own("bob", PETIT);
    assert.equal((await req("bob", "DELETE", `/v1/pro/garages/${PETIT}/changes/${name.body.id}`)).status, 404, "le changement d'un autre garage");
  });

  test("operations: the pending changes are listed with the current and the requested value; approve publishes, reject keeps the reason for the garage", async () => {
    await own("alice", DUPONT);
    const name = (await req("alice", "POST", G + "/changes", { field: "name", value: "Dupont Automobiles" })).body;
    const phone = (await req("alice", "POST", G + "/changes", { field: "phone", value: "05 61 00 00 02" })).body;
    const addr = (await req("alice", "POST", G + "/changes", { field: "addr", value: { street: "14 rue de l'Exemple", pc: "31220", city: "Cazères" } })).body;
    const o = ops();
    const list = await o({ op: "pro-changes" });
    assert.equal(list.ok, true, list.error);
    assert.deepEqual(
      list.review.map((c) => [c.field, c.garageName, c.current, c.requested]).sort(),
      [
        ["addr", "Garage Dupont", "12 rue de l'Exemple", "14 rue de l'Exemple, 31220 Cazères"],
        ["name", "Garage Dupont", "Garage Dupont", "Dupont Automobiles"],
        ["phone", "Garage Dupont", "(données publiques)", "05 61 00 00 02"],
      ],
    );
    assert.ok(!JSON.stringify(list).includes("contact@garage-dupont.fr"), "jamais les contacts privés");
    for (const bad of [{ op: "pro-change", id: "x", decision: "approve" }, { op: "pro-change", id: name.id, decision: "maybe" }, { op: "pro-change", id: name.id, decision: "reject" }, { op: "pro-change", id: name.id, decision: "reject", reason: "x".repeat(301) }])
      assert.equal((await o(bad)).ok, false, JSON.stringify(bad));
    assert.deepEqual(await o({ op: "pro-change", id: name.id, decision: "approve" }), { ok: true, op: "pro-change", decided: "approved" });
    assert.deepEqual(await o({ op: "pro-change", id: addr.id, decision: "approve" }), { ok: true, op: "pro-change", decided: "approved" });
    assert.deepEqual(await o({ op: "pro-change", id: phone.id.toUpperCase(), decision: "reject", reason: "  Ce numéro n'est pas celui de l'établissement.  " }), { ok: true, op: "pro-change", decided: "rejected" });
    assert.equal((await o({ op: "pro-change", id: name.id, decision: "approve" })).ok, false, "déjà décidé");
    const r = (await req("alice", "GET", G + "/profile")).body;
    assert.equal(r.profile.name, "Dupont Automobiles");
    assert.deepEqual(r.profile.addr, { street: "14 rue de l'Exemple", pc: "31220", city: "Cazères" });
    assert.equal(r.profile.phone, "");
    const rejected = r.changes.find((c) => c.field === "phone");
    assert.deepEqual([rejected.status, rejected.reason], ["rejected", "Ce numéro n'est pas celui de l'établissement."]);
    assert.ok(r.changes.find((c) => c.field === "name").decidedAt);
    // le tableau de bord et le comparateur prennent le nom et l'adresse relus
    const dash = (await req("alice", "GET", G)).body.garage;
    assert.deepEqual([dash.name, dash.addr], ["Dupont Automobiles", "14 rue de l'Exemple, 31220 Cazères"]);
    assert.deepEqual((await publicOf()).profile, { name: "Dupont Automobiles", addr: { street: "14 rue de l'Exemple", pc: "31220", city: "Cazères" } });
    // redemander la valeur déjà publiée ne sert à rien
    assert.equal((await req("alice", "POST", G + "/changes", { field: "name", value: "Dupont  Automobiles" })).body.error.code, "unchanged");
    assert.deepEqual((await o({ op: "pro-changes" })).review, []);
  });

  test("services: offered or not, an average time from 15 min to 8 h by quarter hours; unticking removes the announced price, announcing a price ticks the service", async () => {
    await own("alice", DUPONT);
    const put = (service, body) => req("alice", "PUT", `${G}/services/${service}`, body);
    const ok = await put("vidange", { offered: true, minutes: 45 });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { service: "vidange", offered: true, minutes: 45, priceRemoved: false });
    for (const [service, body, field] of [
      ["ct", { offered: true, minutes: 30 }, "service"],
      ["autre", { offered: true }, "service"],
      ["vidange", { offered: "oui" }, "offered"],
      ["vidange", { offered: true, minutes: 10 }, "minutes"],
      ["vidange", { offered: true, minutes: 50 }, "minutes"],
      ["vidange", { offered: true, minutes: 495 }, "minutes"],
      ["vidange", { offered: true, minutes: "45" }, "minutes"],
      ["vidange", { offered: true, minutes: 45.5 }, "minutes"],
    ]) {
      const r = await put(service, body);
      assert.equal(r.status, 422, JSON.stringify([service, body]));
      assert.equal(r.body.error.field, field);
    }
    assert.deepEqual((await put("montage", { offered: true, minutes: null })).body.minutes, null, "temps à saisir plus tard");
    assert.equal((await put("geo_4", { offered: false })).status, 200);
    // un prix annoncé coche la prestation sans toucher à son temps
    await req("alice", "PUT", `${G}/prices/clim`, { kind: "fixed", price: 69 });
    await put("vidange", { offered: true, minutes: 60 });
    await req("alice", "PUT", `${G}/prices/vidange`, { kind: "fixed", price: 89 });
    const services = new Map((await req("alice", "GET", G + "/profile")).body.services.map((s) => [s.service, s]));
    assert.deepEqual(services.get("clim"), { service: "clim", offered: true, minutes: null });
    assert.deepEqual(services.get("vidange"), { service: "vidange", offered: true, minutes: 60 });
    assert.deepEqual(services.get("geo_4"), { service: "geo_4", offered: false, minutes: null });
    assert.equal(services.get("revision").offered, null);
    // décocher retire le prix annoncé
    const off = await put("clim", { offered: false, minutes: null });
    assert.equal(off.body.priceRemoved, true);
    assert.deepEqual((await req("alice", "GET", G)).body.prices.map((p) => p.service), ["vidange"]);
    // public : faites / pas faites, jamais les temps moyens
    const pub = await publicOf();
    assert.deepEqual(pub.services, { offered: ["montage", "vidange"], notOffered: ["clim", "geo_4"] });
    assert.ok(!JSON.stringify(pub).includes("minutes") && !JSON.stringify(pub).includes("60"), JSON.stringify(pub));
  });

  test("public read: only the published fields of a verified garage, nothing for a garage that is not (or no longer) verified", async () => {
    await own("alice", DUPONT);
    await req("alice", "PUT", G + "/profile", { website: "garage-dupont.fr", email: "atelier@garage-dupont.fr", hours: HOURS });
    const pub = await publicOf();
    assert.deepEqual(pub.profile, { website: "https://garage-dupont.fr/", email: "atelier@garage-dupont.fr", hours: HOURS });
    assert.equal(pub.services, undefined, "le garage n'a rien dit de ses prestations");
    // un profil sans garage vérifié ne sort pas
    await t.db.query("INSERT INTO pro_profiles (garage_id, website, account_id) VALUES ($1, 'https://petit.fr/', 'dev-x')", [PETIT]);
    assert.deepEqual((await req(null, "GET", `/v1/pro/public/garages?ids=${PETIT}`)).body, { garages: [] });
    // le retrait du rattachement emporte la fiche, les changements et les prestations
    await req("alice", "POST", G + "/changes", { field: "name", value: "Dupont Automobiles" });
    await req("alice", "PUT", `${G}/services/vidange`, { offered: true, minutes: 45 });
    assert.equal(await t.app.pro.repo.revoke(DUPONT), 1);
    for (const table of ["pro_profile_changes", "pro_services"]) assert.equal((await t.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM pro_profiles WHERE garage_id = $1", [DUPONT])).rows[0].n, 0);
    assert.deepEqual((await req(null, "GET", `/v1/pro/public/garages?ids=${DUPONT}`)).body, { garages: [] });
  });

  test("registry: the establishment of the verified claim, with the label of its activity; a registry that does not answer gives 503, a vanished SIRET 404", async () => {
    await own("alice", DUPONT);
    const r = await req("alice", "GET", G + "/registry");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { siret: SIRET, name: "Garage Dupont", company: "DUPONT AUTOMOBILES", addr: "12 RUE DE L'EXEMPLE 31220 CAZERES", naf: "45.20A", nafLabel: "Entretien et réparation de véhicules automobiles légers", active: true });
    const calls = registry.calls;
    await req("alice", "GET", G + "/registry");
    assert.equal(registry.calls, calls, "lecture gardée 10 minutes");
    await t.db.query("UPDATE pro_claims SET siret = '35600000000048' WHERE garage_id = $1", [DUPONT]);
    assert.equal((await req("alice", "GET", G + "/registry")).body.error.code, "siret_not_found");
    await t.db.query("UPDATE pro_claims SET siret = '44306184100047' WHERE garage_id = $1", [DUPONT]);
    registry.fail = true;
    const down = await req("alice", "GET", G + "/registry");
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, "sirene_unavailable");
  });

  test("maintenance erases the decided or cancelled changes after 90 days and keeps the pending ones", async () => {
    await own("alice", DUPONT);
    const a = (await req("alice", "POST", G + "/changes", { field: "name", value: "Dupont Automobiles" })).body;
    await req("alice", "DELETE", `${G}/changes/${a.id}`);
    await req("alice", "POST", G + "/changes", { field: "phone", value: "05 61 00 00 02" });
    await t.db.query("UPDATE pro_profile_changes SET created_at = now() - interval '200 days', decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE now() - interval '100 days' END");
    const purged = await t.app.maintenance();
    assert.equal(purged.proChanges, 1);
    assert.deepEqual((await t.db.query("SELECT field, status FROM pro_profile_changes")).rows, [{ field: "phone", status: "pending" }]);
  });

  test("CORS lets the pro page send PUT, POST and DELETE on the new routes", async () => {
    for (const method of ["PUT", "POST", "DELETE"]) {
      const r = await t.app.fetch(new Request(`http://api.test${G}/profile`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": method } }));
      assert.equal(r.status, 204);
      assert.match(r.headers.get("access-control-allow-methods"), new RegExp(`\\b${method}\\b`));
    }
  });
});
