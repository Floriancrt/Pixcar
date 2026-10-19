// Calendrier avancé (docs/calendrier-avance.md, lot 3a) : assistant et fiches, activation avec les rendez-vous déjà pris, réservation
// selon les ressources (horaires, demande, code, confirmation automatique), libération, déplacement, concurrence, retour au mode simple,
// isolation entre garages, et le parcours complet : recherche sur Pixcar → réservation → validation → calendrier du garage.
// Base réelle (PGlite), horloge de l'application fixée : lundi 19 octobre 2026, 10:00 à Paris.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { makeApp } from "./helpers.mjs";
import { parisInstant } from "../../src/js/shared/rdv.js";

const HERE = { lat: 43.2174, lon: 1.1014 };
const DUPONT = "aaaaaaaa-0000-4000-8000-000000000001";
const PETIT = "aaaaaaaa-0000-4000-8000-000000000008";
const CONTACTS = [
  { id: DUPONT, name: "Garage Dupont", addr: "12 rue de l'Exemple", pc: "31220", ...HERE, emails: ["contact@garage-dupont.fr"], phones: ["+33561000001"] },
  { id: PETIT, name: "Garage Petit", addr: "3 avenue du Test", pc: "31220", lat: HERE.lat + 0.01, lon: HERE.lon, emails: ["petit@garage-petit.fr"] },
];
const H = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: H, tu: H, we: H, th: H, fr: H };
const SLOT = { name: "Entretien courant", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] };
const at = (iso, hhmm) => parisInstant(iso, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const MONDAY = at("2026-10-19", "10:00");
const WED = "2026-10-21";

describe("Calendrier avancé", () => {
  let t;
  let clock = MONDAY;
  let ipN = 0;
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) });
  const proOf = (garage) => (method, path, body, who = garage === DUPONT ? "alice" : "bob") =>
    t.call(method, `/v1/pro/garages/${garage}${path}`, { body, headers: who ? { "x-pro-dev-account": who } : {} }).then(json);
  const pro = proOf(DUPONT);
  const pub = (method, path, body, { token } = {}) => t.call(method, path, { body, headers: token ? { "x-rdv-token": token } : {}, ip: `198.51.100.${(ipN++ % 200) + 1}` }).then(json);
  const outbox = () => t.app.pro.senders.outbox;
  const mails = (re) => outbox().filter((m) => m.channel === "rdv" && re.test(m.subject));
  const lastCode = (to) => {
    const m = outbox().filter((x) => x.channel === "rdv" && x.target === to && /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };
  const own = (who, garageId) =>
    t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $4, 'c•••@x.fr', now())",
      [crypto.randomUUID(), "dev-" + who, garageId, "a".repeat(64)],
    );
  const count = async (sql, params = []) => (await t.db.query(sql, params)).rows[0].n;

  // garage ouvert en mode simple (lot 2) : horaires, prestations faites, adresse vérifiée, un créneau, rendez-vous ouverts
  async function openGarage(p = pro, garage = DUPONT, who = "alice") {
    await own(who, garage);
    assert.equal((await p("PUT", "/profile", { hours: WEEK })).status, 200);
    for (const [s, m] of [["vidange", 45], ["plaq_av", 90], ["clim", 45], ["distribution", 270]]) assert.equal((await p("PUT", `/services/${s}`, { offered: true, minutes: m })).status, 200);
    const email = `atelier@${garage === DUPONT ? "garage-dupont" : "garage-petit"}.fr`;
    assert.equal((await p("POST", "/rdv/notify", { email })).status, 200);
    assert.equal((await p("POST", "/rdv/notify/code", { code: lastCode(email) })).status, 200);
    assert.equal((await p("POST", "/rdv/slots", SLOT)).status, 200);
    assert.equal((await p("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status, 200);
  }
  // l'assistant : compétences proposées, un mécanicien (Paul, entretien et freinage), un pont, accueil à 0 min
  async function setUp(p = pro) {
    const s = (await p("POST", "/rdv/calendar/start")).body;
    const skill = (label) => s.skills.find((k) => k.label === label).id;
    assert.equal((await p("PUT", "/rdv/calendar/settings", { receptionMin: 0, returnMin: 15, step: 3 })).status, 200);
    const paul = (await p("POST", "/rdv/calendar/staff", { name: "Paul", skills: [skill("Entretien courant"), skill("Freinage")] })).body.saved;
    const lift = (await p("POST", "/rdv/calendar/resources", { name: "Pont n°1", type: "lift" })).body.saved;
    return { s, skill, paul, lift };
  }
  const activate = async (p = pro, body) => {
    const r = await p("POST", "/rdv/calendar/activate", body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const booking = (over = {}) => ({ garageId: DUPONT, services: [{ id: "plaq_av", qty: 1 }], day: WED, time: "09:00", name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC", ...over });
  async function sendRequest(over = {}) {
    const b = booking(over);
    const r = await pub("POST", "/v1/rdv/requests", b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = await pub("POST", `/v1/rdv/requests/${r.body.id}/code`, { code: lastCode(b.email) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return { id: r.body.id, token: c.body.token, view: c.body };
  }
  const times = async (services = "plaq_av", extra = "") => pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=${services}${extra}`);
  const timesOn = (r, day = WED) => ((r.body.days || []).find((d) => d.day === day) || { times: [] }).times.map((x) => x.t);

  before(async () => {
    t = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", RDV_ENABLED: "1", READ_LIMIT_PER_MINUTE: "100000", WRITE_LIMIT_PER_HOUR: "1000" }, now: () => clock });
  });
  after(() => t.close());
  beforeEach(async () => {
    clock = MONDAY;
    outbox().length = 0;
    await t.reset();
    const { rows } = parseContactRows(CONTACTS);
    await t.app.pro.repo.upsertContacts(rows, "test-1");
  });

  test("the wizard: proposed skills and requirements, mechanics and posts, validation, readiness before activation", async () => {
    await openGarage();
    let s = (await pro("GET", "/rdv/calendar")).body;
    assert.deepEqual([s.mode, s.started, s.staff, s.services.map((x) => x.id)], ["simple", false, [], ["vidange", "clim", "plaq_av", "distribution"]]);
    assert.equal((await pro("POST", "/rdv/calendar/activate")).body.error.code, "not_started");
    s = (await pro("POST", "/rdv/calendar/start")).body;
    assert.equal(s.started, true);
    assert.equal(s.skills.length, 8);
    assert.deepEqual(s.skills.slice(0, 2).map((k) => k.label), ["Entretien courant", "Freinage"]);
    const plaq = s.services.find((x) => x.id === "plaq_av").req;
    assert.deepEqual([plaq.labour, plaq.shared, plaq.stations, plaq.skills], [90, 15, ["lift"], [s.skills[1].id]], "valeurs initiales depuis Mon garage");
    assert.equal(s.services.find((x) => x.id === "distribution").req.parts, true);
    assert.equal(s.readiness.ok, false);
    assert.match(s.readiness.problems[0].text, /au moins un mécanicien/);
    assert.equal((await pro("POST", "/rdv/calendar/start")).body.skills.length, 8, "relancer ne double rien");
    // validations
    assert.equal((await pro("POST", "/rdv/calendar/staff", { name: "P" })).body.error.field, "name");
    assert.equal((await pro("POST", "/rdv/calendar/staff", { name: "Paul", skills: ["11111111-0000-4000-8000-000000000001"] })).body.error.field, "skills");
    assert.equal((await pro("POST", "/rdv/calendar/resources", { name: "Pont", type: "rocket" })).body.error.field, "type");
    assert.equal((await pro("PUT", "/rdv/calendar/services/plaq_av", { labour: 60, immob: 30 })).body.error.field, "immob");
    assert.equal((await pro("PUT", "/rdv/calendar/services/embrayage", { labour: 60 })).body.error.code, "not_offered");
    assert.equal((await pro("PUT", "/rdv/calendar/settings", { loadPct: 30 })).status, 422);
    // un mécanicien et un pont : prêt
    const { paul, lift } = await setUp();
    s = (await pro("GET", "/rdv/calendar")).body;
    assert.equal(s.step, 3);
    assert.deepEqual(s.staff.map((m) => [m.id, m.name, m.active, m.skills.length]), [[paul, "Paul", true, 2]]);
    assert.deepEqual(s.resources.map((x) => [x.id, x.type]), [[lift, "lift"]]);
    assert.equal(s.readiness.ok, true);
    assert.deepEqual(s.readiness.ready, ["vidange", "plaq_av"]);
    assert.match(s.readiness.problems.find((p) => p.service === "clim").text, /Recharge de climatisation : aucun mécanicien/);
    assert.match(s.readiness.problems.find((p) => p.service === "distribution").text, /aucun mécanicien actif n'a les compétences/);
    // une absence se saisit en jours ou en heures, et se relit telle quelle
    s = (await pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: paul, kind: "training", first: "2026-10-23", from: "14:00", to: "18:00", label: "Formation clim" })).body;
    assert.deepEqual(s.staff[0].unavail.map((u) => [u.first, u.last, u.from, u.to, u.text]), [["2026-10-23", "2026-10-23", "14:00", "18:00", "Formation clim : ven. 23 oct. (14:00–18:00)"]]);
    assert.equal((await pro("DELETE", `/rdv/calendar/unavail/${s.staff[0].unavail[0].id}`)).body.staff[0].unavail.length, 0);
    // tant que le mode simple reste actif, les horaires viennent des créneaux
    assert.deepEqual(timesOn(await times()), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30"]);
  });

  test("12. activation keeps the appointments already taken (affected to the workshop), and back to simple keeps them too", async () => {
    await openGarage();
    const before = await sendRequest({ time: "08:00", services: [{ id: "vidange", qty: 1 }] }); // mode simple : créneau
    const { paul, lift } = await setUp();
    const check = (await pro("POST", "/rdv/calendar/check")).body;
    assert.deepEqual(check.placed.map((p) => [p.id, p.staff, p.posts]), [[before.id, ["Paul"], ["Pont n°1"]]]);
    const s = await activate();
    assert.equal(s.mode, "advanced");
    assert.equal(s.placed, 1);
    assert.deepEqual(s.conflicts, []);
    const row = (await t.db.query("SELECT status, day::text AS day, start_min, slot_id FROM rdv_requests WHERE id = $1", [before.id])).rows[0];
    assert.deepEqual([row.status, row.day, row.start_min], ["pending", WED, 480], "rien n'a bougé");
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_assignments WHERE request_id = $1", [before.id]), 2, "Paul et le pont");
    // l'agenda du garage le montre
    const ag = (await pro("GET", `/rdv/calendar/agenda?from=${WED}&to=${WED}`)).body;
    assert.deepEqual(ag.appointments.map((a) => [a.id, a.plan.map((x) => x.name).sort()]), [[before.id, ["Paul", "Pont n°1"]]]);
    // retour au mode simple : la demande garde son créneau ; les horaires reviennent des créneaux
    const back = await pro("POST", "/rdv/calendar/simple");
    assert.equal(back.status, 200);
    assert.equal(back.body.mode, "simple");
    assert.equal((await t.db.query("SELECT slot_id FROM rdv_requests WHERE id = $1", [before.id])).rows[0].slot_id, row.slot_id);
    // une demande prise en mode avancé, hors de tout créneau (l'après-midi), bloque le retour au simple
    await activate();
    const late = await sendRequest({ time: "14:00", email: "b@example.com" });
    const no = await pro("POST", "/rdv/calendar/simple");
    assert.equal(no.status, 409);
    assert.deepEqual(no.body.error.failed.map((f) => f.id), [late.id]);
    assert.match(no.body.error.failed[0].reasons[0], /Aucun créneau de la semaine type/);
    assert.equal((await pro("GET", "/rdv/calendar")).body.mode, "advanced", "rien n'a changé");
    // un créneau l'après-midi : le retour au simple rattache la demande
    await pro("POST", "/rdv/slots", { ...SLOT, name: "Après-midi", start: "14:00", end: "18:00" });
    assert.equal((await pro("POST", "/rdv/calendar/simple")).status, 200);
    assert.notEqual((await t.db.query("SELECT slot_id FROM rdv_requests WHERE id = $1", [late.id])).rows[0].slot_id, "00000000-0000-0000-0000-000000000000");
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_requests WHERE status = 'pending'"), 2);
    void paul, lift;
  });

  test("activation waits when an appointment finds no room, and accepts a manual placement", async () => {
    await openGarage();
    const a = await sendRequest({ time: "08:00", services: [{ id: "vidange", qty: 1 }] });
    const { s, skill } = await setUp();
    // Paul ne fait plus que les plaquettes : la vidange déjà prise ne trouve personne
    const paul = s.staff?.[0]?.id || (await pro("GET", "/rdv/calendar")).body.staff[0].id;
    await pro("PUT", `/rdv/calendar/staff/${paul}`, { name: "Paul", services: ["plaq_av"], skills: [skill("Freinage")] });
    const no = await pro("POST", "/rdv/calendar/activate");
    assert.equal(no.status, 409);
    assert.equal(no.body.error.code, "unplaced");
    assert.deepEqual(no.body.error.failed.map((f) => f.id), [a.id]);
    assert.match(no.body.error.failed[0].reasons[0], /Aucun mécanicien actif ne peut faire Vidange/);
    assert.equal((await pro("GET", "/rdv/calendar")).body.mode, "simple");
    // Léa la prend : placement manuel
    const lea = (await pro("POST", "/rdv/calendar/staff", { name: "Léa", skills: [skill("Entretien courant")] })).body.saved;
    const lift = (await pro("GET", "/rdv/calendar")).body.resources[0].id;
    const ok = await activate(pro, { placements: [{ requestId: a.id, staff: [lea], station: lift }] });
    assert.equal(ok.mode, "advanced");
    const rows = (await t.db.query("SELECT target_id, fixed FROM rdv_assignments WHERE request_id = $1 ORDER BY role", [a.id])).rows;
    assert.deepEqual(rows.map((r) => [r.target_id, r.fixed]), [[lea, true], [lift, true]]);
  });

  test("1, 2, 8 and the full journey: found on Pixcar, booked on real resources, accepted, shown in the garage's calendar; a cancellation frees the lift", async () => {
    await openGarage();
    const { paul, lift } = await setUp();
    await activate();
    // recherche sur Pixcar : la fiche publique annonce les prestations prises en ligne
    const g = (await pub("GET", `/v1/pro/public/garages?ids=${DUPONT}`)).body.garages[0];
    assert.deepEqual(g.rdv, { services: ["vidange", "plaq_av"] }, "pas la distribution : personne n'a la compétence");
    // horaires : selon Paul et le pont (pas les créneaux) ; restitution annoncée
    let r = await times();
    assert.equal(r.status, 200);
    assert.equal(r.body.auto, false);
    assert.equal(r.body.needVehicle, false);
    assert.deepEqual(timesOn(r).slice(0, 3), ["08:00", "08:30", "09:00"]);
    assert.ok(timesOn(r).includes("16:30") && !timesOn(r).includes("17:00"), "jusqu'à 16:30 (1 h 30 avant 18:00)");
    assert.deepEqual(r.body.days.find((d) => d.day === WED).times.find((x) => x.t === "09:00"), { t: "09:00", end: "10:45" });
    // 1. réservation
    const one = await sendRequest();
    assert.equal(one.view.status, "pending");
    assert.equal(one.view.when.back, "10:45");
    const plan = (await t.db.query("SELECT target_id, role, starts_at FROM rdv_assignments WHERE request_id = $1 ORDER BY role", [one.id])).rows;
    assert.deepEqual(plan.map((p) => [p.target_id, p.role]), [[paul, "labour"], [lift, "station"]]);
    assert.equal(new Date(plan[0].starts_at).getTime(), at(WED, "09:00"));
    const wo = (await t.db.query("SELECT status, work_start, return_at, labour_min FROM rdv_work_orders WHERE request_id = $1", [one.id])).rows[0];
    assert.deepEqual([wo.status, new Date(wo.return_at).getTime(), wo.labour_min], ["planned", at(WED, "10:45"), 90]);
    const garageMail = mails(/^Nouvelle demande/).at(-1);
    assert.match(garageMail.text, /Affecté à Paul · Pont n°1/);
    // 2. le même horaire n'est plus proposé ; le prendre quand même est refusé
    r = await times();
    assert.ok(!timesOn(r).includes("09:00") && !timesOn(r).includes("10:00") && timesOn(r).includes("10:30"));
    const dup = await pub("POST", "/v1/rdv/requests", booking({ email: "b@example.com", time: "09:30" }));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "time_taken");
    // validation par le garage, puis le calendrier
    const list = (await pro("GET", "/rdv/requests?view=todo")).body.requests;
    assert.deepEqual(list[0].plan, { staff: ["Paul"], posts: ["Pont n°1"], fixed: false, proposed: false });
    assert.equal((await pro("POST", `/rdv/requests/${one.id}/accept`)).status, 200);
    const ag = (await pro("GET", `/rdv/calendar/agenda?from=${WED}&to=${WED}`)).body.appointments;
    assert.deepEqual(ag.map((a) => [a.status, a.when.start, a.client, a.work.labour, a.plan.length]), [["confirmed", "09:00", "Julien Roux", 90, 2]]);
    // 8. le client annule : le pont et Paul sont libérés, l'horaire revient
    assert.equal((await pub("POST", "/v1/rdv/me/cancel", { reason: "unable" }, { token: one.token })).status, 200);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_assignments WHERE request_id = $1", [one.id]), 0);
    assert.ok(timesOn(await times()).includes("09:00"));
    // un refus libère aussi
    const two = await sendRequest({ email: "c@example.com" });
    assert.equal((await pro("POST", `/rdv/requests/${two.id}/decline`, { reason: "full" })).status, 200);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_assignments WHERE request_id = $1", [two.id]), 0);
  });

  test("automatic confirmation per service, vehicle type asked only when durations depend on it, drop-off with a return time", async () => {
    await openGarage();
    const { s, skill, paul } = await setUp();
    await pro("PUT", `/rdv/calendar/staff/${paul}`, { name: "Paul", skills: [skill("Entretien courant"), skill("Freinage"), skill("Distribution")] });
    await pro("PUT", "/rdv/calendar/services/vidange", { labour: 45, shared: 10, immob: 45, skills: [skill("Entretien courant")], stations: ["lift"], auto: true });
    await pro("PUT", "/rdv/calendar/services/plaq_av", { labour: 90, shared: 15, skills: [skill("Freinage")], stations: ["lift"], vehicles: { suv: { labour: 120 } } });
    await activate();
    // confirmation immédiate
    let r = await times("vidange");
    assert.equal(r.body.auto, true);
    const v = await sendRequest({ services: [{ id: "vidange", qty: 1 }], time: "08:00" });
    assert.equal(v.view.status, "confirmed");
    assert.equal(mails(/^Confirmé :/).length, 1);
    assert.equal(mails(/^Nouveau rendez-vous confirmé/).length, 1);
    assert.equal(mails(/^Nouvelle demande/).length, 0);
    assert.match(mails(/^Confirmé :/)[0].html, /Rendez-vous confirmé/);
    assert.deepEqual((await pub("GET", `/v1/pro/public/garages?ids=${DUPONT}`)).body.garages[0].rdv, { services: ["vidange", "plaq_av", "distribution"], auto: ["vidange"] }, "la fiche publique sait ce qui se confirme aussitôt");
    // une prestation manuelle dans la demande : manuelle
    assert.equal((await times("vidange,plaq_av", "&vehicle=city")).body.auto, false);
    // type de véhicule
    r = await times("plaq_av");
    assert.deepEqual([r.body.needVehicle, r.body.days.length, r.body.vehicles.map((x) => x.id)], [true, 0, ["city", "compact", "sedan", "suv", "van"]]);
    const noVehicle = await pub("POST", "/v1/rdv/requests", booking({ email: "x@example.com", time: "10:00" }));
    assert.equal(noVehicle.body.error.field, "vehicle");
    const suv = await times("plaq_av", "&vehicle=suv");
    assert.ok(timesOn(suv).includes("16:00") && !timesOn(suv).includes("16:30"), "2 h pour un SUV");
    const booked = await sendRequest({ email: "s@example.com", time: "14:00", vehicle: "suv" });
    assert.equal(booked.view.when.back, "16:15");
    assert.equal((await t.db.query("SELECT vehicle FROM rdv_work_orders WHERE request_id = $1", [booked.id])).rows[0].vehicle, "suv");
    // dépôt : distribution (4 h, pièces : 48 h de délai)
    r = await times("distribution");
    assert.equal(r.body.days[0].day, "2026-10-22", "pièces : jeudi au plus tôt");
    assert.deepEqual(r.body.days[0].times[0], { t: "08:00", drop: true, until: "09:00", end: "15:45" }, "4 h 30 : 9:00–12:00 puis 14:00–15:30, rendue 15:45");
    void s;
  });

  test("9. moving: conflict explained with alternatives, confirmation before changing the time, client told with a new agenda file; reassigning at the same time is silent", async () => {
    await openGarage();
    const { skill, paul, lift } = await setUp();
    const lea = (await pro("POST", "/rdv/calendar/staff", { name: "Léa", skills: [skill("Freinage")] })).body.saved;
    const lift2 = (await pro("POST", "/rdv/calendar/resources", { name: "Pont n°2", type: "lift" })).body.saved;
    await activate();
    const a = await sendRequest({ time: "08:00" });
    const b = await sendRequest({ time: "10:00", email: "b@example.com" });
    await pro("POST", `/rdv/requests/${a.id}/accept`);
    outbox().length = 0;
    // b sur Paul à 8:30 : Paul tient a jusqu'à 9:30
    const who = (await t.db.query("SELECT target_id FROM rdv_assignments WHERE request_id = $1 AND role = 'labour'", [a.id])).rows[0].target_id;
    let r = await pro("POST", `/rdv/requests/${b.id}/move`, { day: WED, time: "08:30", staff: [who] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "conflict");
    assert.match(r.body.error.reasons.join(" "), /(Paul|Léa) : déjà occupé de 8:00 à 9:30/);
    assert.deepEqual(r.body.error.alternatives[0], { day: WED, time: "09:30", label: "mer. 21 oct. à 9:30", back: "11:15" });
    // un autre horaire : il faut confirmer (le client sera prévenu)
    r = await pro("POST", `/rdv/requests/${b.id}/move`, { day: WED, time: "14:00" });
    assert.equal(r.body.error.code, "confirm");
    assert.match(r.body.error.message, /mercredi 21 octobre à 14:00/);
    r = await pro("POST", `/rdv/requests/${b.id}/move`, { day: WED, time: "14:00", confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.when.start, "14:00");
    const moved = mails(/^Nouvel horaire/);
    assert.equal(moved.length, 1);
    assert.match(moved[0].attachments[0].content, /SEQUENCE:\d+/);
    assert.match(moved[0].attachments[0].content, /DTSTART:20261021T120000Z/);
    // réaffecter à la même heure, sur l'autre pont avec l'autre mécanicien : pas d'e-mail
    const other = who === paul ? lea : paul;
    r = await pro("POST", `/rdv/requests/${a.id}/move`, { day: WED, time: "08:00", staff: [other], station: lift2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(mails(/^Nouvel horaire/).length, 1);
    const rows = (await t.db.query("SELECT target_id, fixed FROM rdv_assignments WHERE request_id = $1 ORDER BY role", [a.id])).rows;
    assert.deepEqual(rows.map((x) => [x.target_id, x.fixed]), [[other, true], [lift2, true]]);
    void lift;
    // une absence sur un rendez-vous affecté : signalée, rien n'est déplacé
    const s = (await pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: other, kind: "absence", first: WED })).body;
    assert.deepEqual(s.touched, [a.id]);
    assert.deepEqual(s.conflicts.map((c) => [c.id, c.reasons[0]]), [[a.id, `${other === paul ? "Paul" : "Léa"} : indisponible (absence).`]]);
    assert.equal((await t.db.query("SELECT start_min FROM rdv_requests WHERE id = $1", [a.id])).rows[0].start_min, 480);
    // supprimer un mécanicien engagé : refusé (désactiver reste possible)
    assert.equal((await pro("DELETE", `/rdv/calendar/staff/${other}`)).body.error.code, "in_use");
    // en mode simple, pas de déplacement contrôlé
    assert.equal((await pro("POST", "/rdv/calendar/simple")).status, 409, "b à 14:00 n'entre dans aucun créneau");
  });

  test("10. two clients on the last lift at the same time: one gets it, the other is told and offered the free times", async () => {
    await openGarage();
    await setUp();
    await activate();
    const a = await pub("POST", "/v1/rdv/requests", booking({ email: "a@example.com" }));
    const b = await pub("POST", "/v1/rdv/requests", booking({ email: "b@example.com" }));
    assert.deepEqual([a.status, b.status], [201, 201]);
    const [x, y] = await Promise.all([
      pub("POST", `/v1/rdv/requests/${a.body.id}/code`, { code: lastCode("a@example.com") }),
      pub("POST", `/v1/rdv/requests/${b.body.id}/code`, { code: lastCode("b@example.com") }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const lost = x.status === 409 ? x : y;
    assert.equal(lost.body.error.code, "time_taken");
    assert.ok(!lost.body.error.days.find((d) => d.day === WED).times.some((t2) => t2.t === "09:00"));
    assert.equal(await count("SELECT count(DISTINCT request_id)::int AS n FROM rdv_assignments"), 1);
  });

  test("13. isolation: another garage never reads nor touches this calendar, and cannot use its mechanics, posts or requests", async () => {
    await openGarage();
    const { paul, lift } = await setUp();
    await activate();
    const a = await sendRequest();
    const bob = proOf(PETIT);
    assert.equal((await pro("GET", "/rdv/calendar", undefined, "bob")).status, 404, "autre compte sur ce garage");
    assert.equal((await pro("PUT", `/rdv/calendar/staff/${paul}`, { name: "X" }, null)).status, 401);
    await own("bob", PETIT);
    await bob("POST", "/rdv/calendar/start");
    assert.equal((await bob("GET", "/rdv/calendar")).body.staff.length, 0);
    assert.equal((await bob("PUT", `/rdv/calendar/staff/${paul}`, { name: "Volé" })).status, 404);
    assert.equal((await bob("DELETE", `/rdv/calendar/resources/${lift}`)).status, 404);
    assert.equal((await bob("POST", "/rdv/calendar/unavail", { target: "staff", targetId: paul, kind: "leave", first: WED })).body.error.field, "targetId");
    assert.equal((await bob("POST", `/rdv/requests/${a.id}/move`, { day: WED, time: "14:00", confirm: true })).status, 404);
    assert.equal((await bob("GET", `/rdv/calendar/agenda?from=${WED}&to=${WED}`)).body.appointments.length, 0);
    assert.equal((await pro("GET", "/rdv/calendar")).body.staff[0].name, "Paul");
    assert.equal((await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Réunion", day: WED, time: "16:00", to: "17:00", staff: [paul] })).status, 201);
    assert.equal((await bob("GET", `/rdv/calendar/agenda?from=${WED}&to=${WED}`)).body.blocks.length, 0);
    // le retrait du rattachement efface tout le calendrier du garage
    const out = await t.app.pro.rdv.repo.cal.revoke(DUPONT);
    assert.ok(out >= 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_staff WHERE garage_id = $1", [DUPONT]), 0);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_blocks WHERE garage_id = $1", [DUPONT]), 0);
  });

  test("lot 3b · internal blocks: a phone booking and a blocked slot take their resources; conflicts explained; moved, flagged, deleted; kept like requests", async () => {
    await openGarage();
    const { paul, lift } = await setUp();
    await activate();
    const THU = "2026-10-22";
    // rendez-vous pris au téléphone : Paul et le pont, mercredi de 8:00 à 9:30 (restitution 9:45)
    const job = await pro("POST", "/rdv/calendar/blocks", { kind: "job", label: "M. Martin (tél.)", services: [{ id: "plaq_av" }], day: WED, time: "08:00" });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.ok(!timesOn(await times()).includes("08:00") && !timesOn(await times()).includes("09:00") && timesOn(await times()).includes("09:30"), "Paul et le pont sont pris de 8:00 à 9:30");
    // un créneau bloqué qui chevauche : refusé, avec la cause ; un autre, libre : accepté
    const clash = await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Réunion", day: WED, time: "09:00", to: "10:00", staff: [paul] });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, "conflict");
    assert.match(clash.body.error.message, /^Paul : déjà occupé/);
    const hold = await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Livraison pièces", day: WED, time: "14:00", to: "15:00", resources: [lift] });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    assert.ok(!timesOn(await times()).includes("14:00"), "pont pris de 14:00 à 15:00");
    assert.equal((await pub("POST", "/v1/rdv/requests", booking({ time: "14:00" }))).body.error.code, "time_taken", "un client ne prend pas un créneau bloqué");
    // le planning de la période
    const ag = (await pro("GET", `/rdv/calendar/agenda?from=${WED}&to=${THU}`)).body;
    assert.equal(ag.blocks.length, 2);
    const j = ag.blocks.find((k) => k.kind === "job");
    assert.deepEqual([j.label, j.when.start, j.when.end, j.services[0].id, j.fixed], ["M. Martin (tél.)", "08:00", "09:45", "plaq_av", false]);
    assert.deepEqual(j.plan.map((a) => a.name).sort(), ["Paul", "Pont n°1"]);
    assert.deepEqual(ag.blocks.find((k) => k.kind === "hold").plan.map((a) => [a.name, a.role]), [["Pont n°1", "station"]]);
    assert.deepEqual(ag.days, [{ day: WED, open: H }, { day: THU, open: H }]);
    assert.deepEqual([ag.staff.map((m) => m.name), ag.resources.map((x) => x.name), ag.today], [["Paul"], ["Pont n°1"], "2026-10-19"]);
    assert.ok(ag.services.some((x) => x.id === "plaq_av" && x.byVehicle === false));
    // déplacé au jeudi : mercredi 8:00 redevient libre, jeudi 8:00 ne l'est plus
    const moved = await pro("PUT", `/rdv/calendar/blocks/${job.body.saved}`, { kind: "job", label: "M. Martin (tél.)", services: [{ id: "plaq_av" }], day: THU, time: "08:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(timesOn(await times()).includes("08:00") && !timesOn(await times(), THU).includes("08:00"));
    // une absence de Paul jeudi : le bloc est signalé en conflit, rien n'est déplacé
    const un = await pro("POST", "/rdv/calendar/unavail", { target: "staff", targetId: paul, kind: "training", first: THU });
    assert.equal(un.status, 200);
    const flagged = (await pro("GET", `/rdv/calendar/agenda?from=${THU}&to=${THU}`)).body;
    assert.deepEqual(flagged.conflicts.map((c) => [c.id, c.block]), [[job.body.saved, true]]);
    assert.equal(flagged.blocks[0].when.start, "08:00");
    assert.equal((await pro("DELETE", `/rdv/calendar/unavail/${un.body.saved}`)).status, 200);
    // contrôles des données reçues
    for (const [body, field] of [
      [{ kind: "rdv", label: "Essai", day: WED, time: "15:00" }, "kind"],
      [{ kind: "job", label: "M", services: [{ id: "plaq_av" }], day: WED, time: "15:00" }, "label"],
      [{ kind: "job", label: "Essai", services: [], day: WED, time: "15:00" }, "services"],
      [{ kind: "job", label: "Essai", services: [{ id: "vidange" }], day: WED, time: "15:00", vehicle: "camion" }, "vehicle"],
      [{ kind: "job", label: "Essai", services: [{ id: "plaq_av" }], day: "2026-10-19", time: "08:00" }, "time"],
      [{ kind: "job", label: "Essai", services: [{ id: "plaq_av" }], day: WED, time: "15:02" }, "time"],
      [{ kind: "hold", label: "Essai", day: WED, time: "15:00", to: "14:00", staff: [paul] }, "to"],
      [{ kind: "hold", label: "Essai", day: WED, time: "15:00", to: "16:00" }, "staff"],
      [{ kind: "hold", label: "Essai", day: WED, time: "15:00", to: "16:00", staff: ["aaaaaaaa-0000-4000-8000-000000000099"] }, "staff"],
    ])
      assert.equal((await pro("POST", "/rdv/calendar/blocks", body)).body.error.field, field, JSON.stringify(body));
    // un autre garage n'y touche pas ; supprimé : le pont redevient libre ; une seconde fois : introuvable
    await own("bob", PETIT);
    assert.equal((await proOf(PETIT)("DELETE", `/rdv/calendar/blocks/${hold.body.saved}`)).status, 404);
    assert.equal((await proOf(PETIT)("PUT", `/rdv/calendar/blocks/${hold.body.saved}`, { kind: "hold", label: "Volé", day: WED, time: "16:00", to: "17:00", resources: [lift] })).status, 409, "PETIT est en mode simple");
    assert.equal((await pro("DELETE", `/rdv/calendar/blocks/${hold.body.saved}`)).status, 200);
    assert.equal((await pro("DELETE", `/rdv/calendar/blocks/${hold.body.saved}`)).status, 404);
    assert.ok(timesOn(await times()).includes("14:00"));
    assert.ok((await t.app.pro.rdv.repo.cal.history(DUPONT)).every((h) => !/Martin|Livraison/.test(h.detail)), "l'historique ne garde pas le libellé");
    // conservation : libellé effacé 30 jours après le jour, ligne et affectations effacées après 24 mois
    clock = at("2026-11-25", "10:00");
    assert.equal((await t.app.pro.rdv.repo.cal.purge()).calBlocksAnonymized, 1);
    assert.equal((await t.db.query("SELECT label FROM rdv_blocks")).rows[0].label, "");
    clock = at("2028-11-25", "10:00");
    const p2 = await t.app.pro.rdv.repo.cal.purge();
    assert.deepEqual([p2.calBlocks, p2.calBlockAssignments], [1, 2]);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_assignments WHERE block_id IS NOT NULL"), 0);
  });

  test("routes: methods, unknown paths, the agenda range", async () => {
    await openGarage();
    assert.equal((await pro("DELETE", "/rdv/calendar")).status, 405);
    assert.equal((await pro("GET", "/rdv/calendar/start")).status, 405);
    assert.equal((await pro("GET", "/rdv/calendar/nope")).status, 404);
    assert.equal((await pro("PUT", "/rdv/calendar/staff/pas-un-id", { name: "Paul" })).status, 404);
    assert.equal((await pro("GET", "/rdv/calendar/agenda?from=2026-10-21&to=2027-01-21")).status, 400);
    assert.equal((await pro("POST", "/rdv/requests/aaaaaaaa-0000-4000-8000-0000000000ff/move", { day: WED, time: "08:00" })).status, 404);
    assert.equal((await pro("POST", "/rdv/requests/aaaaaaaa-0000-4000-8000-0000000000ff/move", { day: "demain" })).status, 422);
  });
});
