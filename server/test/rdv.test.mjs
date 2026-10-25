// Rendez-vous en ligne (docs/rendez-vous.md, lot 2) : disponibilités du garage, horaires proposés, demande avec code, décisions du garage,
// suivi par lien personnel, tâche horaire (expiration à midi, pause automatique, rappel, relance), fermetures, effacement des données.
// Base réelle (PGlite), horloge de l'application fixée : lundi 19 octobre 2026, 10:00 à Paris.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { createHandler } from "../lambda.mjs";
import { ORIGIN, makeApp } from "./helpers.mjs";
import { parisInstant } from "../../src/js/shared/rdv.js";

const HERE = { lat: 43.2174, lon: 1.1014 }; // Cazères
const DUPONT = "aaaaaaaa-0000-4000-8000-000000000001";
const PETIT = "aaaaaaaa-0000-4000-8000-000000000008";
const CONTACTS = [
  { id: DUPONT, name: "Garage Dupont", addr: "12 rue de l'Exemple", pc: "31220", ...HERE, emails: ["contact@garage-dupont.fr"], phones: ["+33561000001"] },
  { id: PETIT, name: "Garage Petit", addr: "3 avenue du Test", pc: "31220", lat: HERE.lat + 0.01, lon: HERE.lon, emails: ["petit@garage-petit.fr"] },
];
const WEEK = { mo: [["08:00", "12:00"], ["14:00", "18:00"]], tu: [["08:00", "12:00"], ["14:00", "18:00"]], we: [["08:00", "12:00"], ["14:00", "18:00"]], th: [["08:00", "12:00"], ["14:00", "18:00"]], fr: [["08:00", "12:00"], ["14:00", "18:00"]] };
const SLOT = { name: "Entretien courant", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] };
const at = (iso, hhmm) => parisInstant(iso, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const MONDAY = at("2026-10-19", "10:00");

describe("Rendez-vous en ligne", () => {
  let t;
  let clock = MONDAY;
  const logs = [];
  let ipN = 0;
  const as = (who) => ({ "x-pro-dev-account": who });
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), headers: res.headers });
  const pro = (method, path, body, who = "alice") => t.call(method, `/v1/pro/garages/${DUPONT}${path}`, { body, headers: who ? as(who) : {} }).then(json);
  const pub = (method, path, body, { token, ip } = {}) => t.call(method, path, { body, headers: token ? { "x-rdv-token": token } : {}, ip: ip || `198.51.100.${(ipN++ % 200) + 1}` }).then(json);
  const outbox = () => t.app.pro.senders.outbox;
  const mails = (kind) => outbox().filter((m) => m.channel === "rdv" && (!kind || m.subject.includes(kind)));
  const lastCode = (to) => {
    const m = outbox().filter((x) => x.channel === "rdv" && x.target === to && /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };
  const tokenIn = (m, kind) => (new RegExp(`#${kind}=([A-Za-z0-9_-]{43})`).exec(m.text) || [])[1];
  const own = (who, garageId) =>
    t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $4, 'c•••@x.fr', now())",
      [crypto.randomUUID(), "dev-" + who, garageId, "a".repeat(64)],
    );

  // Garage prêt : horaires, temps moyens, adresse de notification vérifiée, un créneau, rendez-vous ouverts (délai minimum : aucun)
  async function openGarage({ slot = SLOT, settings = {} } = {}) {
    await own("alice", DUPONT);
    assert.equal((await pro("PUT", "/profile", { hours: WEEK })).status, 200);
    for (const [s, m] of [["vidange", 45], ["plaq_av", 60], ["montage", 30], ["distribution", 270]]) assert.equal((await pro("PUT", `/services/${s}`, { offered: true, minutes: m })).status, 200);
    assert.equal((await pro("POST", "/rdv/notify", { email: "Atelier@Garage-Dupont.fr" })).status, 200);
    assert.equal((await pro("POST", "/rdv/notify/code", { code: lastCode("atelier@garage-dupont.fr") })).status, 200);
    assert.equal((await pro("POST", "/rdv/slots", slot)).status, 200);
    const r = await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0, ...settings });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  const booking = (over = {}) => ({
    garageId: DUPONT,
    services: [{ id: "vidange", qty: 1 }],
    day: "2026-10-21",
    time: "08:00",
    name: "Julien Roux",
    email: "julien.roux@example.com",
    phone: "06 39 98 12 34",
    car: "Peugeot 208",
    year: 2019,
    plate: "EZ-108-BC",
    message: "Un bruit au freinage.",
    remindPrice: true,
    ...over,
  });
  // une demande jusqu'à son envoi au garage : renvoie { id, token (suivi) }
  async function sendRequest(over = {}) {
    const b = booking(over);
    const r = await pub("POST", "/v1/rdv/requests", b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = await pub("POST", `/v1/rdv/requests/${r.body.id}/code`, { code: lastCode(b.email) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return { id: r.body.id, token: c.body.token, view: c.body };
  }

  before(async () => {
    t = await makeApp({
      env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", RDV_ENABLED: "1", READ_LIMIT_PER_MINUTE: "100000", WRITE_LIMIT_PER_HOUR: "1000" },
      now: () => clock,
      log: (l) => logs.push(l),
    });
  });
  after(() => t.close());
  beforeEach(async () => {
    clock = MONDAY;
    outbox().length = 0;
    logs.length = 0;
    await t.reset();
    const { rows } = parseContactRows(CONTACTS);
    await t.app.pro.repo.upsertContacts(rows, "test-1");
  });

  test("garage routes answer only for a garage verified on this account; wrong methods get 405; the token header passes CORS", async () => {
    await own("alice", DUPONT);
    for (const [method, path, body] of [["GET", "/rdv"], ["PUT", "/rdv/settings", { holidays: false }], ["POST", "/rdv/slots", SLOT], ["POST", "/rdv/closures", { first: "2026-11-02" }], ["POST", "/rdv/notify", { email: "a@b.fr" }], ["GET", "/rdv/requests?view=todo"]]) {
      assert.equal((await pro(method, path, body, null)).status, 401, `${method} ${path} sans compte`);
      assert.equal((await pro(method, path, body, "bob")).status, 404, `${method} ${path} autre compte`);
    }
    for (const [method, path] of [["POST", "/rdv"], ["GET", "/rdv/settings"], ["GET", "/rdv/slots"], ["GET", "/rdv/notify"], ["POST", "/rdv/requests"]]) assert.equal((await pro(method, path, method === "GET" ? undefined : {})).status, 405, `${method} ${path}`);
    const pre = await t.call("OPTIONS", "/v1/rdv/me", { origin: ORIGIN });
    assert.match(pre.headers.get("access-control-allow-headers"), /x-rdv-token/);
  });

  test("opening needs hours, a verified notification address and a slot; the agenda says what is missing", async () => {
    await own("alice", DUPONT);
    let a = await pro("GET", "/rdv");
    assert.equal(a.status, 200);
    assert.deepEqual([a.body.enabled, a.body.open, a.body.missing], [false, false, ["hours", "notify", "slots"]]);
    assert.deepEqual(a.body.settings, { minDelayH: 24, horizonDays: 28, stepMin: 30, holidays: true });
    assert.deepEqual(a.body.holidays.map((h) => h.day), ["2026-11-01", "2026-11-11", "2026-12-25"]);
    let r = await pro("PUT", "/rdv/settings", { enabled: true });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error.missing, ["hours", "notify", "slots"]);
    // un créneau demande les horaires d'ouverture, et des prestations faites avec un temps moyen
    assert.equal((await pro("POST", "/rdv/slots", SLOT)).body.error.field, "hours");
    await pro("PUT", "/profile", { hours: WEEK });
    assert.equal((await pro("POST", "/rdv/slots", SLOT)).body.error.field, "services");
    await pro("PUT", "/services/vidange", { offered: true, minutes: 45 });
    await pro("PUT", "/services/plaq_av", { offered: true, minutes: 60 });
    assert.equal((await pro("POST", "/rdv/slots", { ...SLOT, days: ["sa"] })).body.error.field, "days");
    a = (await pro("POST", "/rdv/slots", SLOT)).body;
    assert.equal(a.slots.length, 1);
    assert.deepEqual(a.slots[0], { id: a.slots[0].id, name: "Entretien courant", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] });
    assert.deepEqual(a.missing, ["notify"]);
    // adresse de notification : un code envoyé à cette adresse, vérifié
    r = await pro("POST", "/rdv/notify", { email: "pas une adresse" });
    assert.equal(r.status, 422);
    r = await pro("POST", "/rdv/notify", { email: "atelier@garage-dupont.fr" });
    assert.equal(r.status, 200);
    assert.equal((await pro("POST", "/rdv/notify", { email: "atelier@garage-dupont.fr" })).status, 429, "un nouveau code 60 s après le précédent");
    const code = lastCode("atelier@garage-dupont.fr");
    const wrong = code === "000000" ? "111111" : "000000";
    r = await pro("POST", "/rdv/notify/code", { code: wrong });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.attemptsLeft, 4);
    a = (await pro("POST", "/rdv/notify/code", { code })).body;
    assert.equal(a.notify.email, "atelier@garage-dupont.fr");
    assert.deepEqual(a.missing, []);
    a = (await pro("PUT", "/rdv/settings", { enabled: true, stepMin: 15 })).body;
    assert.deepEqual([a.enabled, a.open, a.settings.stepMin], [true, true, 15]);
    // créneaux : modification, suppression, 20 au plus
    const id = a.slots[0].id;
    assert.equal((await pro("PUT", `/rdv/slots/${id}`, { ...SLOT, capacity: 3 })).body.slots[0].capacity, 3);
    assert.equal((await pro("PUT", "/rdv/slots/11111111-1111-4111-8111-111111111111", SLOT)).status, 404);
    for (let i = 0; i < 19; i++) assert.equal((await pro("POST", "/rdv/slots", SLOT)).status, 200);
    assert.equal((await pro("POST", "/rdv/slots", SLOT)).status, 409);
    assert.equal((await pro("DELETE", `/rdv/slots/${id}`)).body.slots.length, 19);
  });

  test("free times: after the garage's deadline, every step, within the slot; deadline said in French; public list flags the services", async () => {
    await openGarage();
    let r = await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`);
    assert.equal(r.status, 200);
    assert.equal(r.body.deadlineText, "mardi 20 octobre à 12:00");
    assert.equal(r.body.garage.name, "Garage Dupont");
    assert.deepEqual(r.body.services, [{ id: "vidange", qty: 1, label: "Vidange (huile + filtre)" }]);
    assert.equal(r.body.days[0].day, "2026-10-21");
    assert.equal(r.body.days[0].label, "mer. 21 oct.");
    assert.deepEqual(r.body.days[0].times.map((x) => x.t), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]);
    assert.ok(r.body.days.every((d) => d.day <= "2026-11-15"));
    assert.ok(!r.body.days.some((d) => d.day === "2026-11-11"), "11 novembre férié");
    assert.equal((await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=clim`)).status, 404, "prestation sans temps moyen");
    assert.equal((await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=montage`)).status, 404, "prestation absente des créneaux");
    assert.equal((await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=zzz`)).status, 400);
    assert.equal((await pub("GET", `/v1/rdv/garages/${PETIT}/times?services=vidange`)).status, 404, "garage non vérifié");
    const g = (await pub("GET", `/v1/pro/public/garages?ids=${DUPONT}`)).body.garages[0];
    assert.deepEqual(g.rdv, { services: ["vidange", "plaq_av"] });
    // fermé : plus d'horaires, plus d'étiquette
    await pro("PUT", "/rdv/settings", { enabled: false });
    assert.equal((await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`)).status, 404);
    assert.equal((await pub("GET", `/v1/pro/public/garages?ids=${DUPONT}`)).body.garages[0].rdv, undefined);
  });

  test("a request: code by e-mail first, nothing sent before; the right code sends it to the garage, with a tracking link", async () => {
    await openGarage();
    outbox().length = 0; // le code de l'adresse de notification du garage
    const b = booking();
    let r = await pub("POST", "/v1/rdv/requests", { ...b, email: "pas-une-adresse" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.field, "email");
    for (const [k, v] of [["phone", "12"], ["car", "x"], ["year", 1900], ["plate", "AB123"], ["message", "x".repeat(501)], ["time", "8h"], ["services", [{ id: "vidange", qty: 2 }]]])
      assert.equal((await pub("POST", "/v1/rdv/requests", { ...b, [k]: v })).body.error.field, k, k);
    // immatriculation obligatoire : absente, vide, plaque étrangère sans la case, case qui n'est pas un booléen
    for (const over of [{ plate: undefined }, { plate: "  " }, { plate: "GE 123456" }, { plate: "GE 123456", plateForeign: "oui" }, { plate: "ABCDEFGHIJ", plateForeign: true }]) {
      const e = (await pub("POST", "/v1/rdv/requests", { ...b, ...over })).body.error;
      assert.deepEqual([e.code, e.field], ["validation", "plate"], JSON.stringify(over));
    }
    assert.match((await pub("POST", "/v1/rdv/requests", { ...b, plate: "" })).body.error.message, /^Indiquez l'immatriculation/);
    assert.equal((await pub("POST", "/v1/rdv/requests", { ...b, time: "08:15" })).body.error.code, "time_taken", "pas un horaire proposé");
    r = await pub("POST", "/v1/rdv/requests", b);
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.email, r.body.expiresInSeconds, r.body.resendInSeconds], ["julien.roux@example.com", 600, 60]);
    assert.equal(mails().length, 1, "seul le code est parti");
    assert.match(mails()[0].subject, /^Pixcar : votre code \d{6}$/);
    assert.match(mails()[0].text, /Garage Dupont/);
    assert.equal(mails()[0].from, "Pixcar <rendez-vous@pixcar.fr>");
    const id = r.body.id;
    const code = lastCode(b.email);
    let c = await pub("POST", `/v1/rdv/requests/${id}/code`, { code: code === "000000" ? "111111" : "000000" });
    assert.equal(c.status, 422);
    assert.equal(c.body.error.attemptsLeft, 4);
    assert.equal((await pub("POST", `/v1/rdv/requests/${id}/resend`)).status, 429, "60 s entre deux codes");
    c = await pub("POST", `/v1/rdv/requests/${id}/code`, { code });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.status, "pending");
    assert.match(c.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(c.body.deadlineText, "mardi 20 octobre à 12:00");
    assert.equal(c.body.when.label, "mercredi 21 octobre à 8:00");
    assert.equal(c.body.canCancel, true);
    assert.equal((await pub("POST", `/v1/rdv/requests/${id}/code`, { code })).status, 409, "déjà envoyée");
    // e-mails : accusé à l'automobiliste, nouvelle demande au garage (réponse possible au client)
    const sent = mails("Demande envoyée")[0];
    assert.equal(sent.target, "julien.roux@example.com");
    assert.match(sent.subject, /^Demande envoyée à Garage Dupont : mercredi 21 octobre à 8:00$/);
    assert.equal(tokenIn(sent, "c"), c.body.token);
    assert.match(sent.html, /Suivre ou annuler ma demande/);
    const neu = mails("Nouvelle demande")[0];
    assert.equal(neu.target, "atelier@garage-dupont.fr");
    assert.equal(neu.replyTo, "julien.roux@example.com");
    assert.match(neu.text, /Julien Roux/);
    assert.match(neu.text, /06 39 98 12 34 · julien\.roux@example\.com/);
    assert.match(neu.text, /Répondez avant mardi 20 octobre à 12:00/);
    assert.match(neu.text, /encore 1 place sur 2 à cette heure/);
    assert.ok(tokenIn(neu, "g"));
    assert.ok(!neu.html.includes("<script"), "HTML sans script");
    // le suivi : jeton dans l'en-tête seulement
    assert.equal((await pub("GET", "/v1/rdv/me")).status, 404);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: "x".repeat(43) })).status, 404);
    const me = await pub("GET", "/v1/rdv/me", undefined, { token: c.body.token });
    assert.equal(me.status, 200);
    assert.deepEqual([me.body.status, me.body.car.model, me.body.garage.name, me.body.sentText], ["pending", "Peugeot 208", "Garage Dupont", "lundi 19 octobre"]);
    // la place est prise : une seule reste à 8:00
    r = await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`);
    assert.equal(r.body.days[0].times[0].t, "08:00");
  });

  test("plates: an old FNI plate and a foreign plate (when said so) are accepted, kept in 9 characters and shown to the garage", async () => {
    await openGarage();
    const fni = await sendRequest({ plate: "1234 ab 31", email: "fni@example.com" });
    const foreign = await sendRequest({ plate: "KA-AB 1234", plateForeign: true, email: "ka@example.com", time: "08:30" });
    const rows = (await t.db.query("SELECT id, plate FROM rdv_requests WHERE id = ANY($1)", [[fni.id, foreign.id]])).rows;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.plate])), { [fni.id]: "1234AB31", [foreign.id]: "KAAB1234" });
    const toGarage = mails("Nouvelle demande").filter((m) => m.target === "atelier@garage-dupont.fr");
    assert.ok(toGarage.some((m) => /1234AB31/.test(m.text)) && toGarage.some((m) => /KAAB1234/.test(m.text)), "la plaque est dans l'e-mail du garage");
  });

  test("limits: one pending request per e-mail and garage, codes per address and per connection; the trap field sends nothing", async () => {
    await openGarage();
    await sendRequest();
    const again = await pub("POST", "/v1/rdv/requests", booking({ time: "09:00" }));
    assert.equal(again.status, 201);
    const c = await pub("POST", `/v1/rdv/requests/${again.body.id}/code`, { code: lastCode("julien.roux@example.com") });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, "too_many_pending");
    // champ piège : semble partir, rien n'est enregistré ni envoyé
    const before = mails().length;
    const trap = await pub("POST", "/v1/rdv/requests", booking({ email: "robot@example.com", website: "http://spam.example" }));
    assert.equal(trap.status, 201);
    assert.equal(mails().length, before);
    assert.equal((await pub("POST", `/v1/rdv/requests/${trap.body.id}/code`, { code: "123456" })).status, 404);
    // 5 codes par heure depuis une même connexion
    const cfg = t.config.rdv;
    for (let i = 0; i < 5; i++) assert.equal((await pub("POST", "/v1/rdv/requests", booking({ email: `p${i}@example.com` }), { ip: "192.0.2.50" })).status, 201);
    const sixth = await pub("POST", "/v1/rdv/requests", booking({ email: "p9@example.com" }), { ip: "192.0.2.50" });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error.scope, "ip_hour");
    // 5 codes par jour vers une même adresse
    for (let i = 0; i < 4; i++) await pub("POST", "/v1/rdv/requests", booking({ email: "same@example.com" }));
    assert.equal((await pub("POST", "/v1/rdv/requests", booking({ email: "same@example.com" }))).status, 201);
    assert.equal((await pub("POST", "/v1/rdv/requests", booking({ email: "same@example.com" }))).body.error.scope, "email");
    assert.equal(cfg.codesPerEmailPerDay, 5);
  });

  test("the last place: the second request is told the time was taken and may choose another with the same code", async () => {
    await openGarage({ slot: { ...SLOT, capacity: 1 } });
    const a = await pub("POST", "/v1/rdv/requests", booking({ email: "a@example.com" }));
    const b = await pub("POST", "/v1/rdv/requests", booking({ email: "b@example.com" }));
    assert.equal(b.status, 201, "un brouillon ne retient pas l'horaire");
    assert.equal((await pub("POST", `/v1/rdv/requests/${a.body.id}/code`, { code: lastCode("a@example.com") })).status, 200);
    const code = lastCode("b@example.com");
    let c = await pub("POST", `/v1/rdv/requests/${b.body.id}/code`, { code });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, "time_taken");
    assert.equal(c.body.error.days[0].times[0].t, "09:00"); // 8:00–8:45 est pris, 8:30 le chevaucherait
    c = await pub("POST", `/v1/rdv/requests/${b.body.id}/code`, { code, day: "2026-10-21", time: "09:00" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.when.start, "09:00");
  });

  test("the garage accepts, declines (reason required) or cancels (reason required); the client is told, with an agenda file", async () => {
    await openGarage();
    const one = await sendRequest();
    const two = await sendRequest({ email: "sophie@example.com", name: "Sophie Bernard", time: "10:00", remindPrice: false });
    let list = await pro("GET", "/rdv/requests?view=todo");
    assert.equal(list.status, 200);
    assert.equal(list.body.todo, 2);
    assert.deepEqual(list.body.requests.map((x) => x.client.name), ["Julien Roux", "Sophie Bernard"]);
    assert.deepEqual(list.body.requests[0].slot, { name: "Entretien courant", capacity: 2, left: 1 });
    assert.equal(list.body.requests[0].message, "Un bruit au freinage.");
    assert.equal((await pro("GET", "/rdv/requests?view=zzz")).status, 400);
    assert.equal((await pro("GET", "")).body.rdv.todo, 2, "compteur du tableau de bord");
    // accepter
    let r = await pro("POST", `/rdv/requests/${one.id}/accept`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "confirmed");
    assert.equal((await pro("POST", `/rdv/requests/${one.id}/accept`)).status, 409);
    const conf = mails("Confirmé")[0];
    assert.match(conf.subject, /^Confirmé : mercredi 21 octobre à 8:00 chez Garage Dupont$/);
    assert.equal(conf.attachments[0].type, "text/calendar");
    assert.match(conf.attachments[0].content, /DTSTART:20261021T060000Z/);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: one.token })).body.status, "confirmed");
    // refuser : motif obligatoire
    assert.equal((await pro("POST", `/rdv/requests/${two.id}/decline`, {})).status, 422);
    assert.equal((await pro("POST", `/rdv/requests/${two.id}/decline`, { reason: "zzz" })).status, 422);
    r = await pro("POST", `/rdv/requests/${two.id}/decline`, { reason: "full", note: "Appelez-nous pour un autre horaire." });
    assert.equal(r.body.status, "declined");
    const dec = mails("ne peut pas vous recevoir")[0];
    assert.equal(dec.target, "sophie@example.com");
    assert.match(dec.text, /pas de place à cet horaire/);
    assert.match(dec.text, /Appelez-nous pour un autre horaire/);
    // annuler un rendez-vous confirmé : motif, client prévenu, compté comme sans réponse
    assert.equal((await pro("POST", `/rdv/requests/${one.id}/cancel`, {})).status, 422);
    r = await pro("POST", `/rdv/requests/${one.id}/cancel`, { reason: "workshop" });
    assert.equal(r.body.status, "cancelled");
    assert.match(mails("annulé par Garage Dupont")[0].text, /imprévu à l'atelier/);
    list = await pro("GET", "/rdv/requests?view=past");
    assert.deepEqual(list.body.requests.map((x) => x.status).sort(), ["cancelled", "declined"]);
    assert.equal((await pro("GET", "/rdv")).body.settings.minDelayH, 0);
  });

  test("the garage's page from the e-mail: no login, limited to that request, until the deadline", async () => {
    await openGarage();
    await sendRequest();
    const g = tokenIn(mails("Nouvelle demande")[0], "g");
    let r = await pub("GET", "/v1/rdv/action", undefined, { token: g });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.open, r.body.client.name, r.body.garage.name], [true, "Julien Roux", "Garage Dupont"]);
    assert.equal((await pub("POST", "/v1/rdv/action/decline", {}, { token: g })).status, 422);
    r = await pub("POST", "/v1/rdv/action/accept", undefined, { token: g });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.status, r.body.open], ["confirmed", false]);
    // le jeton de l'automobiliste n'ouvre pas la page du garage, et inversement
    const c = tokenIn(mails("Demande envoyée")[0], "c");
    assert.equal((await pub("GET", "/v1/rdv/action", undefined, { token: c })).status, 404);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: g })).status, 404);
  });

  test("the client cancels until the appointment; the garage is told and the time is free again", async () => {
    await openGarage({ slot: { ...SLOT, capacity: 1 } });
    const one = await sendRequest();
    let times = (await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`)).body.days[0].times.map((x) => x.t);
    assert.ok(!times.includes("08:00"));
    const r = await pub("POST", "/v1/rdv/me/cancel", { reason: "unable" }, { token: one.token });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.status, r.body.canCancel], ["cancelled", false]);
    const g = mails("Annulé par le client")[0];
    assert.equal(g.target, "atelier@garage-dupont.fr");
    assert.match(g.text, /Empêchement/);
    times = (await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`)).body.days[0].times.map((x) => x.t);
    assert.ok(times.includes("08:00"));
    assert.equal((await pub("POST", "/v1/rdv/me/cancel", {}, { token: one.token })).status, 409);
  });

  test("hourly task: unanswered requests expire at noon (client told, other garages offered); the third in a row pauses the garage", async () => {
    await openGarage();
    // un autre garage, à 1 km, qui prend la vidange en ligne : proposé dans l'e-mail d'expiration
    await own("pierre", PETIT);
    const asP = (m, p, b) => t.call(m, `/v1/pro/garages/${PETIT}${p}`, { body: b, headers: as("pierre") }).then(json);
    await asP("PUT", "/profile", { hours: WEEK });
    await asP("PUT", "/services/vidange", { offered: true, minutes: 30 });
    await asP("POST", "/rdv/notify", { email: "petit@garage-petit.fr" });
    await asP("POST", "/rdv/notify/code", { code: lastCode("petit@garage-petit.fr") });
    await asP("POST", "/rdv/slots", { ...SLOT, services: ["vidange"] });
    await asP("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 });
    const reqs = [];
    for (const [i, time] of ["08:00", "08:00", "09:00"].entries()) reqs.push(await sendRequest({ email: `c${i}@example.com`, time }));
    clock = at("2026-10-20", "11:59");
    let out = await t.app.rdvTick();
    assert.equal(out.expired, 0);
    clock = at("2026-10-20", "12:05");
    // avant la tâche, une demande dont l'heure limite est passée ne peut plus être acceptée
    assert.equal((await pro("POST", `/rdv/requests/${reqs[0].id}/accept`)).body.error.status, "expired");
    out = await t.app.rdvTick();
    assert.equal(out.expired, 3);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: reqs[0].token })).body.status, "expired");
    const exp = mails("n'a pas pu répondre");
    assert.equal(exp.length, 3);
    assert.match(exp[0].text, /Garage Petit \(1,1 km/);
    assert.match(exp[0].text, /jeu\. 22 oct\. dès 8:00/); // demandé maintenant, l'autre garage répondrait d'ici mercredi midi
    const paused = mails("en pause");
    assert.equal(paused.length, 1);
    assert.equal(paused[0].target, "atelier@garage-dupont.fr");
    let a = (await pro("GET", "/rdv")).body;
    assert.deepEqual([a.enabled, a.paused, a.open], [true, true, false]);
    assert.equal((await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`)).status, 404);
    // rouvrir lève la pause
    a = (await pro("PUT", "/rdv/settings", { enabled: true })).body;
    assert.deepEqual([a.paused, a.open], [false, true]);
    assert.equal((await t.app.rdvTick()).expired, 0, "rien à refaire");
  });

  test("hourly task: reminder the day before from 12:05, price follow-up the day after from 10:05 when asked, once each", async () => {
    await openGarage();
    const one = await sendRequest();
    const two = await sendRequest({ email: "b@example.com", remindPrice: false, time: "09:00" });
    await pro("POST", `/rdv/requests/${one.id}/accept`);
    await pro("POST", `/rdv/requests/${two.id}/accept`);
    clock = at("2026-10-20", "11:00");
    assert.equal((await t.app.rdvTick()).reminded, 0);
    clock = at("2026-10-20", "12:05");
    assert.equal((await t.app.rdvTick()).reminded, 2);
    assert.equal((await t.app.rdvTick()).reminded, 0);
    assert.match(mails("Rappel").find((m) => m.target === "julien.roux@example.com").subject, /^Rappel : demain 8:00, Vidange \(huile \+ filtre\) chez Garage Dupont$/);
    clock = at("2026-10-22", "09:00");
    assert.equal((await t.app.rdvTick()).followedUp, 0);
    clock = at("2026-10-22", "10:05");
    assert.equal((await t.app.rdvTick()).followedUp, 1, "seulement si la case était cochée");
    assert.equal((await t.app.rdvTick()).followedUp, 0);
    const f = mails("Combien avez-vous payé")[0];
    assert.equal(f.target, "julien.roux@example.com");
    assert.equal(tokenIn(f, "c"), one.token);
  });

  test("a closure cancels the requests of the period (client told) and removes its days", async () => {
    await openGarage();
    const one = await sendRequest();
    const r = await pro("POST", "/rdv/closures", { first: "2026-10-21", last: "2026-10-21", label: "Inventaire" });
    assert.equal(r.status, 200);
    assert.equal(r.body.cancelled, 1);
    assert.deepEqual(r.body.closures.map((c) => [c.first, c.last, c.label]), [["2026-10-21", "2026-10-21", "Inventaire"]]);
    assert.match(mails("Rendez-vous annulé")[0].text, /le garage sera fermé ce jour-là/);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: one.token })).body.cancelledBy, "closure");
    const days = (await pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`)).body.days.map((d) => d.day);
    assert.ok(!days.includes("2026-10-21") && days.includes("2026-10-22"));
    assert.equal((await pro("POST", "/rdv/closures", { first: "2026-10-01", last: "2026-10-02" })).status, 422);
    assert.equal((await pro("DELETE", `/rdv/closures/${r.body.closures[0].id}`)).body.closures.length, 0);
  });

  test("retention: contact details erased 30 days after the appointment (7 after a refusal); the link stops working", async () => {
    await openGarage();
    const one = await sendRequest();
    const two = await sendRequest({ email: "b@example.com", time: "09:00" });
    await pro("POST", `/rdv/requests/${one.id}/accept`);
    await pro("POST", `/rdv/requests/${two.id}/decline`, { reason: "parts" });
    clock = at("2026-10-27", "10:00"); // refus il y a 8 jours
    let out = await t.app.maintenance();
    assert.equal(out.rdvAnonymized, 1);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: two.token })).status, 404);
    assert.equal((await pub("GET", "/v1/rdv/me", undefined, { token: one.token })).status, 200);
    clock = at("2026-11-21", "10:00"); // rendez-vous il y a 31 jours
    out = await t.app.maintenance();
    assert.equal(out.rdvAnonymized, 1);
    const row = (await t.db.query("SELECT name, email, phone, car, plate, message, client_token_hash, anonymized_at, status FROM rdv_requests WHERE id = $1", [one.id])).rows[0];
    assert.deepEqual([row.name, row.email, row.phone, row.car, row.plate, row.message, row.client_token_hash, row.status], ["", "", "", "", "", "", null, "confirmed"]);
    assert.ok(row.anonymized_at);
  });

  test("the scheduled event runs the hourly task through the API function; a gateway request never does", async () => {
    await openGarage();
    const handler = createHandler({ getApp: async () => t.app });
    const out = await handler({ pixcar: "rdv-tick" });
    assert.deepEqual(Object.keys(out).sort(), ["expired", "followedUp", "mails", "reminded"]);
    const http = await handler({ pixcar: "rdv-tick", requestContext: { http: { method: "GET", sourceIp: "203.0.113.1" } }, rawPath: "/healthz", headers: {} });
    assert.equal(http.statusCode, 200);
  });
});

describe("Rendez-vous en ligne fermés (RDV_ENABLED absent)", () => {
  let t;
  before(async () => {
    t = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1" } });
  });
  after(() => t.close());
  test("public routes and garage routes answer 404 rdv_disabled; the public list has no rdv field; the task does nothing", async () => {
    const r = await t.call("GET", `/v1/rdv/garages/${DUPONT}/times?services=vidange`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, "rdv_disabled");
    await t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, 'dev-alice', $2, '73282932000074', 'verified', 'email', 'C D', 'manager', $3, 'x', now())",
      [crypto.randomUUID(), DUPONT, "a".repeat(64)],
    );
    const g = await t.call("GET", `/v1/pro/garages/${DUPONT}/rdv`, { headers: { "x-pro-dev-account": "alice" } });
    assert.equal(g.status, 404);
    assert.deepEqual(await t.app.rdvTick(), { skipped: "rendez-vous en ligne fermés" });
  });
});
