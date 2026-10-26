// Gestion d'atelier (docs/gestion-atelier.md, P0) : rendez-vous saisis par le garage et créneaux bloqués dans le calcul par créneaux
// (capacité sur toute la durée, créneau plein à confirmer, blocage de tout l'atelier, reprise d'une création), champs du client gardés
// et effacés à 30 jours, états d'intervention et déplacement sans le calcul par ressources, modules et dépendances, bascule entre les
// deux calculs avec les rendez-vous saisis. Base réelle (PGlite), horloge fixée : lundi 19 octobre 2026, 10:00 à Paris.
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
// une place à la fois, le matin
const SLOT = { name: "Entretien courant", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] };
const at = (iso, hhmm) => parisInstant(iso, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const MONDAY = at("2026-10-19", "10:00");
const WED = "2026-10-21";
const THU = "2026-10-22";

describe("Gestion d'atelier", () => {
  let t;
  let clock = MONDAY;
  let ipN = 0;
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) });
  const proOf = (garage) => (method, path, body, who = garage === DUPONT ? "alice" : "bob") =>
    t.call(method, `/v1/pro/garages/${garage}${path}`, { body, headers: who ? { "x-pro-dev-account": who } : {} }).then(json);
  const pro = proOf(DUPONT);
  const pub = (method, path, body) => t.call(method, path, { body, ip: `198.51.100.${(ipN++ % 200) + 1}` }).then(json);
  const outbox = () => t.app.pro.senders.outbox;
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
  async function openGarage(p = pro, garage = DUPONT, who = "alice") {
    await own(who, garage);
    assert.equal((await p("PUT", "/profile", { hours: WEEK })).status, 200);
    for (const [s, m] of [["vidange", 45], ["plaq_av", 90]]) assert.equal((await p("PUT", `/services/${s}`, { offered: true, minutes: m })).status, 200);
    const email = `atelier@${garage === DUPONT ? "garage-dupont" : "garage-petit"}.fr`;
    assert.equal((await p("POST", "/rdv/notify", { email })).status, 200);
    assert.equal((await p("POST", "/rdv/notify/code", { code: lastCode(email) })).status, 200);
    assert.equal((await p("POST", "/rdv/slots", SLOT)).status, 200);
    assert.equal((await p("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status, 200);
  }
  const booking = (over = {}) => ({ garageId: DUPONT, services: [{ id: "plaq_av", qty: 1 }], day: WED, time: "09:00", name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC", ...over });
  async function sendRequest(over = {}) {
    const b = booking(over);
    const r = await pub("POST", "/v1/rdv/requests", b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = await pub("POST", `/v1/rdv/requests/${r.body.id}/code`, { code: lastCode(b.email) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return r.body.id;
  }
  const times = async (services = "vidange") => pub("GET", `/v1/rdv/garages/${DUPONT}/times?services=${services}`);
  const timesOn = (r, day = WED) => ((r.body.days || []).find((d) => d.day === day) || { times: [] }).times.map((x) => x.t);
  const agenda = async (from = WED, to = from) => (await pro("GET", `/rdv/calendar/agenda?from=${from}&to=${to}`)).body;
  const phoneJob = (over = {}) => ({ kind: "job", client: "M. Martin", phone: "06 12 34 56 78", car: "Renault Clio", plate: "ab-123-cd", services: [{ id: "vidange" }], day: WED, time: "09:00", minutes: 60, channel: "phone", note: "Pneus dans le coffre", ...over });

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

  test("slot calculation · a booking taken by phone takes its slot place for its whole duration; full asks first; a creation replayed is not doubled", async () => {
    await openGarage();
    assert.ok(timesOn(await times()).includes("09:00"));
    const ref = crypto.randomUUID();
    const job = await pro("POST", "/rdv/calendar/blocks", { ...phoneJob(), ref });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.saved, ref, "l'identifiant choisi par l'écran");
    // une place, prise de 9:00 à 10:00 : la vidange (45 min) ne se réserve plus à 8:30, 9:00, 9:30 ; 8:00 et 10:00 restent
    const free = timesOn(await times());
    assert.ok(free.includes("08:00") && free.includes("10:00") && !free.includes("08:30") && !free.includes("09:00") && !free.includes("09:30"), free.join(" "));
    assert.equal((await pub("POST", "/v1/rdv/requests", booking({ services: [{ id: "vidange", qty: 1 }], time: "09:00" }))).body.error.code, "time_taken", "un client ne prend pas la place");
    // la même création rejouée (double clic, reprise réseau) : le même rendez-vous, pas un second
    const again = await pro("POST", "/rdv/calendar/blocks", { ...phoneJob(), ref });
    assert.deepEqual([again.status, again.body], [200, { saved: ref, replay: true }]);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_blocks"), 1);
    // ce que montre l'agenda
    const ag = await agenda();
    assert.equal(ag.engine, "slots");
    assert.deepEqual(ag.services.map((x) => [x.id, x.minutes]), [["vidange", 45], ["plaq_av", 90]]);
    assert.deepEqual(ag.slots.map((x) => [x.name, x.capacity]), [["Entretien courant", 1]]);
    const k = ag.blocks[0];
    assert.deepEqual(
      [k.label, k.client, k.car, k.plate, k.phone, k.note, k.channel, k.minutes, k.back, k.slot, k.when.start, k.when.end, k.plan, k.work],
      ["M. Martin", "M. Martin", "Renault Clio", "AB-123-CD", "+33612345678", "Pneus dans le coffre", "phone", 60, null, "Entretien courant", "09:00", "10:00", [], null],
    );
    assert.equal(typeof ag.free[WED], "number");
    assert.ok(ag.free[WED] > 0 && ag.free[WED] < 8, JSON.stringify(ag.free));
    // un second rendez-vous dans la place prise : la cause, d'autres heures du jour ; rien n'est écrit sans confirmation
    const second = phoneJob({ client: "Mme Durand", car: "", plate: "", phone: "", note: "", time: "09:30", minutes: 30 });
    const full = await pro("POST", "/rdv/calendar/blocks", second);
    assert.deepEqual([full.status, full.body.error.code], [409, "full"]);
    assert.match(full.body.error.message, /^« Entretien courant » est complet à 9:30 : 1 voiture déjà prévue pour 1 place\. Enregistrez quand même, ou choisissez une autre heure\.$/);
    assert.deepEqual(full.body.error.alternatives.map((x) => x.time), ["08:30", "10:00", "10:15"]);
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_blocks"), 1);
    const forced = await pro("POST", "/rdv/calendar/blocks", { ...second, confirm: true });
    assert.equal(forced.status, 201, JSON.stringify(forced.body));
    assert.equal((await agenda()).blocks.find((b) => b.id === forced.body.saved).slot, "Entretien courant", "compté quand même dans son créneau");
    // une modification qui ne change ni l'heure ni la durée ne redemande pas
    assert.equal((await pro("PUT", `/rdv/calendar/blocks/${forced.body.saved}`, { ...second, client: "Mme Durand-Roux" })).status, 200);
    // déplacé par glisser-déposer (jour et heure seulement) : les données du client restent ; la place se libère mercredi, se prend jeudi
    const moved = await pro("PUT", `/rdv/calendar/blocks/${ref}`, { kind: "job", services: [{ id: "vidange" }], day: THU, time: "08:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const th = (await agenda(THU)).blocks[0];
    assert.deepEqual([th.client, th.phone, th.plate, th.note, th.minutes, th.channel], ["M. Martin", "+33612345678", "AB-123-CD", "Pneus dans le coffre", 60, "phone"]);
    assert.ok(!timesOn(await times(), THU).includes("08:00") && timesOn(await times(), THU).includes("09:00"));
    assert.ok(timesOn(await times()).includes("08:30") && !timesOn(await times()).includes("09:00"), "mercredi : reste Mme Durand de 9:30 à 10:00");
  });

  test("slot calculation · the whole workshop blocked: no online time during it; a booking already there is kept after confirmation; no mechanic or post to pick", async () => {
    await openGarage();
    assert.equal((await pro("POST", "/rdv/calendar/blocks", phoneJob())).status, 201);
    const hold = await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Livraison pièces", day: WED, time: "11:00", to: "12:00" });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    const free = timesOn(await times());
    assert.ok(free.includes("10:00") && !free.includes("10:30") && !free.includes("11:00"), free.join(" "));
    const ag = await agenda();
    assert.deepEqual(ag.blocks.filter((k) => k.kind === "hold").map((k) => [k.label, k.whole, k.plan.length]), [["Livraison pièces", true, 0]]);
    // une plage qui chevauche un rendez-vous déjà là : il reste ; le garage confirme
    const meet = { kind: "hold", label: "Réunion", day: WED, time: "09:00", to: "09:30" };
    const ask = await pro("POST", "/rdv/calendar/blocks", meet);
    assert.deepEqual([ask.status, ask.body.error.code, ask.body.error.count], [409, "overlap", 1]);
    assert.match(ask.body.error.message, /^Un rendez-vous est déjà prévu pendant cette plage \(9:00\) : il reste à sa place\. Bloquez quand même/);
    assert.equal((await pro("POST", "/rdv/calendar/blocks", { ...meet, confirm: true })).status, 201);
    assert.equal((await agenda()).blocks.filter((k) => k.kind === "job").length, 1);
    // en calcul par créneaux, ni mécanicien ni poste ne se choisissent
    const a = await pro("POST", "/rdv/calendar/blocks", { ...meet, time: "15:00", to: "16:00", staff: ["aaaaaaaa-0000-4000-8000-000000000099"] });
    assert.deepEqual([a.status, a.body.error.field], [422, "staff"]);
    assert.match(a.body.error.message, /demande le calcul par ressources/);
    const b = await pro("POST", "/rdv/calendar/blocks", phoneJob({ time: "15:00", station: "aaaaaaaa-0000-4000-8000-000000000099" }));
    assert.deepEqual([b.status, b.body.error.field], [422, "staff"]);
    // un rendez-vous ne devient pas un créneau bloqué
    const jobId = (await agenda()).blocks.find((k) => k.kind === "job").id;
    assert.equal((await pro("PUT", `/rdv/calendar/blocks/${jobId}`, { ...meet, time: "16:00", to: "17:00" })).body.error.field, "kind");
  });

  test("slot calculation · what the garage types is checked; client data is erased 30 days after the day; history keeps none", async () => {
    await openGarage();
    for (const [over, field] of [
      [{ client: "M", car: "" }, "label"],
      [{ phone: "appeler le soir" }, "phone"],
      [{ phone: "06 1" }, "phone"],
      [{ plate: "AB_123" }, "plate"],
      [{ minutes: 7 }, "minutes"],
      [{ minutes: 0 }, "minutes"],
      [{ back: "08:30" }, "back"],
      [{ back: "09:30" }, "back"],
      [{ channel: "fax" }, "channel"],
      [{ services: [{ id: "embrayage" }] }, "services"],
      [{ note: "x".repeat(301) }, "note"],
      [{ car: "x".repeat(41) }, "car"],
    ]) {
      const r = await pro("POST", "/rdv/calendar/blocks", phoneJob(over));
      assert.deepEqual([r.status, r.body.error.field], [422, field], JSON.stringify(over));
    }
    assert.match((await pro("POST", "/rdv/calendar/blocks", phoneJob({ back: "09:30" }))).body.error.message, /après la fin des travaux \(10:00\)/);
    // le véhicule seul suffit ; restitution choisie, gardée par l'agenda ; sans durée : le temps moyen de Mon garage
    const r = await pro("POST", "/rdv/calendar/blocks", phoneJob({ client: "", minutes: null, back: "17:00", channel: "walkin" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const k = (await agenda()).blocks[0];
    assert.deepEqual([k.label, k.client, k.minutes, k.back, k.when.end, k.channel], ["Renault Clio", "", 45, "17:00", "17:00", "walkin"]);
    assert.ok((await t.app.pro.rdv.repo.cal.history(DUPONT)).every((h) => !/Martin|Clio|06 12|612345678|AB-123/.test(h.detail)));
    clock = at("2026-11-21", "10:00");
    assert.equal((await t.app.pro.rdv.repo.cal.purge()).calBlocksAnonymized, 1);
    assert.deepEqual((await t.db.query("SELECT label, car, plate, phone, note FROM rdv_blocks")).rows[0], { label: "", car: null, plate: null, phone: null, note: null });
  });

  test("slot calculation · interventions follow their states; a Pixcar booking is moved with the client told, even into a full slot after confirmation", async () => {
    await openGarage();
    const id = await sendRequest({ time: "08:00", services: [{ id: "vidange", qty: 1 }] });
    assert.equal((await pro("POST", `/rdv/requests/${id}/accept`)).status, 200);
    const job = (await pro("POST", "/rdv/calendar/blocks", phoneJob({ day: THU, time: "08:00" }))).body.saved;
    // déplacer : le client est prévenu, après confirmation ; vers une place prise, le garage le sait avant de confirmer
    let r = await pro("POST", `/rdv/requests/${id}/move`, { day: WED, time: "10:30" });
    assert.deepEqual([r.status, r.body.error.code], [409, "confirm"]);
    assert.match(r.body.error.message, /^Le client sera prévenu par e-mail du nouvel horaire : mercredi 21 octobre à 10:30 \(restitution prévue vers 11:15\)\. Confirmez le déplacement\.$/);
    r = await pro("POST", `/rdv/requests/${id}/move`, { day: THU, time: "08:30" });
    assert.deepEqual([r.status, r.body.error.code, r.body.error.full], [409, "confirm", true]);
    assert.match(r.body.error.message, /^« Entretien courant » est complet à 8:30 : 1 voiture déjà prévue pour 1 place\. Le client sera prévenu/);
    outbox().length = 0;
    r = await pro("POST", `/rdv/requests/${id}/move`, { day: THU, time: "08:30", confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ag = await agenda(THU);
    assert.deepEqual(ag.appointments.map((a) => [a.id, a.when.start, a.when.end]), [[id, "08:30", "09:15"]]);
    await t.app.pro.rdv.drain();
    assert.ok(outbox().some((m) => m.target === "julien.roux@example.com" && /^Nouvel horaire/.test(m.subject)));
    assert.deepEqual([(r = await pro("POST", `/rdv/requests/${id}/move`, { day: THU, time: "10:00", staff: ["aaaaaaaa-0000-4000-8000-000000000099"] })).status, r.body.error.code], [409, "simple_mode"]);
    assert.deepEqual([(r = await pro("POST", `/rdv/requests/${id}/move`, { day: "2026-10-19", time: "08:00", confirm: true })).status, r.body.error.code], [409, "conflict"]);
    // le jour venu : voiture reçue, en cours, prête (client prévenu), restituée ; le rendez-vous saisi aussi
    clock = at(THU, "08:20");
    for (const s of ["received", "in_progress"]) assert.equal((r = await pro("POST", `/rdv/calendar/work/${job}`, { status: s })).status, 200, JSON.stringify(r.body));
    for (const s of ["received", "in_progress", "done"]) assert.equal((r = await pro("POST", `/rdv/calendar/work/${id}`, { status: s })).status, 200, JSON.stringify(r.body));
    assert.equal(r.body.notified, true);
    const day = await agenda(THU);
    assert.deepEqual([day.blocks[0].work.status, day.appointments[0].work.status], ["in_progress", "done"]);
    // commencée, l'intervention ne se déplace plus
    assert.equal((await pro("PUT", `/rdv/calendar/blocks/${job}`, { kind: "job", services: [{ id: "vidange" }], day: THU, time: "14:00" })).body.error.code, "started");
  });

  test("two phone bookings at once for the last place: one is saved, the other is told the slot is full", async () => {
    await openGarage();
    const rs = await Promise.all([pro("POST", "/rdv/calendar/blocks", phoneJob()), pro("POST", "/rdv/calendar/blocks", phoneJob({ client: "Mme Durand" }))]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(rs.find((r) => r.status === 409).body.error.code, "full");
    assert.equal(await count("SELECT count(*)::int AS n FROM rdv_blocks"), 1);
  });

  test("modules: all on by default, dependencies checked, kept apart from the resource wizard, locked by the resource calculation and back on with it", async () => {
    await openGarage();
    let s = (await pro("GET", "/rdv/calendar")).body;
    assert.deepEqual(s.modules, { staff: true, equip: true, track: true, load: true, stats: false });
    assert.deepEqual((await pro("GET", "")).body.rdv.modules, s.modules);
    s = (await pro("PUT", "/rdv/calendar/settings", { modules: { track: false } })).body;
    assert.deepEqual([s.modules.track, s.started], [false, false], "l'assistant du calcul par ressources n'est pas ouvert pour autant");
    for (const bad of [{ staff: false, equip: false }, { stats: true }, { foo: true }, { track: "non" }, ["track"]]) {
      const r = await pro("PUT", "/rdv/calendar/settings", { modules: bad });
      assert.deepEqual([r.status, r.body.error.field], [422, "modules"], JSON.stringify(bad));
    }
    s = (await pro("PUT", "/rdv/calendar/settings", { modules: { staff: false, equip: false, load: false } })).body;
    assert.deepEqual(s.modules, { staff: false, equip: false, track: false, load: false, stats: false });
    assert.deepEqual((await pro("GET", "")).body.rdv.modules, s.modules);
    assert.ok((await t.app.pro.rdv.repo.cal.history(DUPONT)).some((h) => h.detail === "Modules : Mécaniciens coupé, Ponts et équipements coupé, Charge et capacité coupé."));
    // passage au calcul par ressources : mécaniciens et équipements reviennent, et ne se coupent plus
    const st = (await pro("POST", "/rdv/calendar/start")).body;
    const skill = (label) => st.skills.find((k) => k.label === label).id;
    await pro("POST", "/rdv/calendar/staff", { name: "Paul", skills: [skill("Entretien courant"), skill("Freinage")] });
    await pro("POST", "/rdv/calendar/resources", { name: "Pont n°1", type: "lift" });
    assert.equal((await pro("POST", "/rdv/calendar/activate")).status, 200);
    s = (await pro("GET", "/rdv/calendar")).body;
    assert.deepEqual([s.mode, s.modules.staff, s.modules.equip, s.modules.track], ["advanced", true, true, false]);
    const r = await pro("PUT", "/rdv/calendar/settings", { modules: { staff: false } });
    assert.deepEqual([r.status, r.body.error.code], [409, "in_use"]);
    // un autre garage n'y touche pas
    await own("bob", PETIT);
    assert.equal((await proOf(PETIT)("PUT", "/rdv/calendar/settings", { modules: { track: false } })).status, 200);
    assert.equal((await pro("GET", "/rdv/calendar")).body.modules.track, false);
  });

  test("switching the calculation carries phone bookings and whole-workshop holds: placed on mechanics and posts, then counted in their slot again", async () => {
    await openGarage();
    const job = (await pro("POST", "/rdv/calendar/blocks", phoneJob({ services: [{ id: "plaq_av" }], minutes: 90 }))).body.saved;
    assert.equal((await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Formation", day: WED, time: "14:00", to: "18:00" })).status, 201);
    const st = (await pro("POST", "/rdv/calendar/start")).body;
    const skill = (label) => st.skills.find((k) => k.label === label).id;
    await pro("PUT", "/rdv/calendar/settings", { receptionMin: 0, returnMin: 15 });
    await pro("POST", "/rdv/calendar/staff", { name: "Paul", skills: [skill("Entretien courant"), skill("Freinage")] });
    await pro("POST", "/rdv/calendar/resources", { name: "Pont n°1", type: "lift" });
    // l'aperçu le montre, l'activation le place
    const check = (await pro("POST", "/rdv/calendar/check")).body;
    assert.deepEqual(check.placed.map((p) => [p.id, p.block, p.staff]), [[job, true, ["Paul"]]]);
    assert.equal((await pro("POST", "/rdv/calendar/activate")).status, 200);
    let k = (await agenda()).blocks.find((b) => b.id === job);
    assert.deepEqual([k.slot, k.plan.map((a) => a.name).sort()], [null, ["Paul", "Pont n°1"]]);
    const free = timesOn(await times("plaq_av"));
    assert.ok(!free.includes("09:00") && !free.includes("14:00") && !free.includes("15:00"), free.join(" "));
    // Paul pris toute l'après-midi par le blocage de tout l'atelier : un créneau bloqué sur lui y est refusé
    const clash = await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Essai", day: WED, time: "15:00", to: "16:00" });
    assert.deepEqual([clash.status, clash.body.error.code], [409, "conflict"]);
    // retour au calcul par créneaux : de nouveau compté dans « Entretien courant »
    assert.equal((await pro("POST", "/rdv/calendar/simple")).status, 200);
    k = (await agenda()).blocks.find((b) => b.id === job);
    assert.equal(k.slot, "Entretien courant");
    assert.ok(!timesOn(await times()).includes("09:00"));
  });
});
