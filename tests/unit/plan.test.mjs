// Calendrier avancé (src/js/shared/plan.js) : horaires calculés à partir des ressources de l'atelier. Scénarios du cahier des charges
// au niveau du moteur (1 à 7, 9, 11 ; les autres, qui demandent la base ou deux transactions, sont dans server/test/calendar.test.mjs).
// Horloge : lundi 19 octobre 2026, 10:00 à Paris. Atelier ouvert du lundi au vendredi, 8:00–12:00 et 14:00–18:00.
import assert from "node:assert/strict";
import { test } from "node:test";
import { minOf, parisInstant } from "../../src/js/shared/rdv.js";
import {
  addPlan, assignmentsOf, buildJob, defaultReq, explain, makeWorld, parseCalendar, parseReq, parseResource, parseSkill, parseStaff, parseUnavail, pickPlan,
  placeExisting, planAt, planTimes, readiness,
} from "../../src/js/shared/plan.js";

const at = (iso, hhmm) => parisInstant(iso, minOf(hhmm));
const H = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: H, tu: H, we: H, th: H, fr: H };
const NOW = at("2026-10-19", "10:00");
const WED = "2026-10-21";
const ids = { paul: "11111111-0000-4000-8000-000000000001", lea: "11111111-0000-4000-8000-000000000002", lift1: "22222222-0000-4000-8000-000000000001", lift2: "22222222-0000-4000-8000-000000000002", clim: "22222222-0000-4000-8000-000000000003", align: "22222222-0000-4000-8000-000000000004" };
const SK = { brakes: "33333333-0000-4000-8000-000000000001", maint: "33333333-0000-4000-8000-000000000002", clim: "33333333-0000-4000-8000-000000000003" };
const staff = (id, over = {}) => ({ id, name: id === ids.paul ? "Paul" : "Léa", active: true, hours: null, services: null, skills: [{ id: SK.brakes, until: null }, { id: SK.maint, until: null }], ...over });
const lift = (id, over = {}) => ({ id, name: id === ids.lift1 ? "Pont n°1" : "Pont n°2", type: "lift", active: true, hours: null, services: null, ...over });
const req = (over = {}) => ({ online: true, labour: 60, shared: 0, immob: 60, staffN: 1, skills: [], stations: ["lift"], tools: [], margin: 0, auto: false, parts: false, partsH: 0, drop: false, vehicles: {}, ...over });
const REQS = {
  vidange: req({ labour: 30, shared: 10, immob: 40, skills: [SK.maint], stations: ["lift", "quick"] }),
  plaq_av: req({ labour: 90, shared: 15, immob: 90, skills: [SK.brakes] }),
  disq_av: req({ labour: 120, shared: 15, immob: 120, skills: [SK.brakes] }),
  clim: req({ labour: 45, immob: 45, skills: [SK.clim], stations: [], tools: ["clim"] }),
  batterie: req({ labour: 20, immob: 20, stations: [] }),
  montage: req({ labour: 30, shared: 10, immob: 30, stations: ["lift"] }),
  geo_av: req({ labour: 45, immob: 45, stations: ["align"] }),
  distribution: req({ labour: 240, shared: 15, immob: 240, drop: true, parts: true, partsH: 48 }),
};
function world(over = {}) {
  return makeWorld({
    nowMs: NOW,
    ctx: { hours: WEEK, closures: [], holidays: true },
    settings: { minDelayH: 0, horizonDays: 14, stepMin: 30 },
    cal: { receptionMin: 0, returnMin: 15, loadPct: 100, maxDay: 0 },
    staff: [staff(ids.paul)],
    resources: [lift(ids.lift1)],
    skills: Object.values(SK).map((id) => ({ id, label: id, cert: false })),
    reqs: REQS,
    unavail: [],
    busy: [],
    ...over,
  });
}
const job = (list, vehicle = "") => buildJob(list.map((x) => (typeof x === "string" ? { id: x, qty: 1 } : x)), REQS, vehicle);
const times = (w, j, day = WED) => ((planTimes(w, j).find((d) => d.day === day) || { times: [] }).times).map((t) => `${String(Math.floor(t.start / 60)).padStart(2, "0")}:${String(t.start % 60).padStart(2, "0")}`);
const busy = (target, targetId, day, a, b, requestId = "r-other") => ({ requestId, target, targetId, role: target === "staff" ? "labour" : "station", start: at(day, a), end: at(day, b) });

test("1. a free time is offered, and the chosen time can be taken (plan with mechanic, lift, return time)", () => {
  const w = world();
  const j = job(["plaq_av"]);
  assert.deepEqual(times(w, j).slice(0, 4), ["08:00", "08:30", "09:00", "09:30"]);
  // 1 h 30 : 11:00 et 11:30 aussi (le travail reprend après midi) ; l'après-midi jusqu'à 16:30
  assert.deepEqual(times(w, j), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
  const o = pickPlan(w, j, { day: WED, start: minOf("09:00") });
  assert.equal(o.mode, "hour");
  assert.equal(o.end, minOf("10:45"), "restitution : prête à 10:30 + 15 min");
  assert.deepEqual(o.plan.steps[0].staff, [ids.paul]);
  assert.equal(o.plan.steps[0].station, ids.lift1);
  assert.deepEqual(assignmentsOf(o.plan), [
    { target: "staff", targetId: ids.paul, role: "labour", a: minOf("09:00"), b: minOf("10:30") },
    { target: "resource", targetId: ids.lift1, role: "station", a: minOf("09:00"), b: minOf("10:30") },
  ]);
  // la première journée possible : demain après l'heure limite de réponse (mardi 12:00)
  assert.equal(planTimes(w, j)[0].day, "2026-10-20");
  assert.equal(planTimes(w, j)[0].times[0].start, minOf("14:00"));
  assert.equal(pickPlan(w, j, { day: WED, start: minOf("09:10") }), null, "hors de la grille de 30 min");
  assert.equal(pickPlan(w, j, { day: WED, start: minOf("09:00"), mode: "drop" }), null);
});

test("2. a taken time is no longer offered: one mechanic and one lift, overlaps refused, the next free time follows", () => {
  const w = world();
  const j = job(["plaq_av"]);
  const o = pickPlan(w, j, { day: WED, start: minOf("09:00") });
  addPlan(w, "r1", o.plan);
  const t = times(w, j);
  for (const x of ["08:00", "08:30", "09:00", "09:30", "10:00"]) assert.ok(!t.includes(x), `${x} chevauche 9:00–10:30`);
  assert.ok(t.includes("10:30"));
  assert.equal(pickPlan(w, j, { day: WED, start: minOf("09:30") }), null);
  // un second pont ne suffit pas : le seul mécanicien est pris
  const w2 = world({ resources: [lift(ids.lift1), lift(ids.lift2)] });
  addPlan(w2, "r1", o.plan);
  assert.ok(!times(w2, j).includes("09:30"));
  // un second mécanicien et un second pont : l'horaire revient, sur l'autre pont avec l'autre mécanicien
  const w3 = world({ staff: [staff(ids.paul), staff(ids.lea)], resources: [lift(ids.lift1), lift(ids.lift2)] });
  addPlan(w3, "r1", o.plan);
  const o3 = pickPlan(w3, j, { day: WED, start: minOf("09:30") });
  assert.deepEqual([o3.plan.steps[0].staff, o3.plan.steps[0].station], [[ids.lea], ids.lift2]);
});

test("3. the only compatible lift: busy until 10:00 → first time 10:00 (cahier des charges); in maintenance → nothing; a job without a lift still fits", () => {
  const w = world({ busy: [busy("resource", ids.lift1, WED, "08:00", "10:00")] });
  const j = job(["plaq_av"]);
  assert.equal(times(w, j)[0], "10:00", "le mécanicien est libre à 9:00, pas le pont");
  const e = explain(w, j, { day: WED, start: minOf("09:00") });
  assert.ok(!e.plan);
  assert.match(e.reasons[0].text, /Pont n°1 : déjà occupé de 8:00 à 10:00/);
  assert.deepEqual(e.alternatives.map((a) => a.start), [minOf("10:00"), minOf("10:30"), minOf("11:00")]);
  const down = world({ unavail: [{ id: "u1", target: "resource", targetId: ids.lift1, start: at(WED, "00:00"), end: at("2026-10-22", "00:00"), kind: "maintenance", label: "" }] });
  assert.deepEqual(times(down, j), []);
  assert.match(explain(down, j, { day: WED, start: minOf("09:00") }).reasons[0].text, /Pont n°1 : indisponible \(maintenance\)/);
  assert.ok(times(down, job(["batterie"])).length > 0, "une prestation sans pont se planifie sans pont");
  const off = world({ resources: [lift(ids.lift1, { active: false })] });
  assert.deepEqual(times(off, j), []);
  assert.match(explain(off, j, { day: WED, start: minOf("09:00") }).reasons[0].text, /Aucun poste compatible disponible \(Pont élévateur\)/);
  // poste réservé à d'autres prestations
  const only = world({ resources: [lift(ids.lift1, { services: ["vidange"] })] });
  assert.deepEqual(times(only, j), []);
  assert.ok(times(only, job(["vidange"])).length > 0);
});

test("4. an absent mechanic: no time while absent, the colleague takes over, a partial absence blocks only its hours", () => {
  const absent = { id: "u1", target: "staff", targetId: ids.paul, start: at(WED, "00:00"), end: at("2026-10-22", "00:00"), kind: "leave", label: "" };
  const j = job(["plaq_av"]);
  const w = world({ unavail: [absent] });
  assert.deepEqual(times(w, j), []);
  assert.ok(times(w, j, "2026-10-22").length > 0, "le lendemain, de nouveau");
  assert.match(explain(w, j, { day: WED, start: minOf("09:00") }).reasons[0].text, /Paul : indisponible \(congés\)/);
  const w2 = world({ staff: [staff(ids.paul), staff(ids.lea)], unavail: [absent] });
  assert.deepEqual(pickPlan(w2, j, { day: WED, start: minOf("09:00") }).plan.steps[0].staff, [ids.lea]);
  const half = world({ unavail: [{ ...absent, start: at(WED, "08:00"), end: at(WED, "12:00"), kind: "training" }] });
  assert.deepEqual(times(half, j)[0], "14:00");
});

test("5. skills: a mechanic without the skill is never chosen; an expired qualification no longer counts; allowed services are respected", () => {
  const j = job(["clim"]);
  const station = { id: ids.clim, name: "Station clim", type: "clim", active: true, hours: null, services: null };
  const w = world({ resources: [lift(ids.lift1), station] });
  assert.deepEqual(times(w, j), []);
  assert.match(explain(w, j, { day: WED, start: minOf("09:00") }).reasons[0].text, /Aucun mécanicien actif ne peut faire Recharge de climatisation/);
  const lea = staff(ids.lea, { skills: [{ id: SK.clim, until: "2026-10-21" }] });
  const w2 = world({ staff: [staff(ids.paul), lea], resources: [lift(ids.lift1), station] });
  assert.deepEqual(pickPlan(w2, j, { day: WED, start: minOf("09:00") }).plan.steps[0].staff, [ids.lea]);
  assert.deepEqual(times(w2, j, "2026-10-22"), [], "habilitation échue après le 21");
  // prestations autorisées : Paul ne fait que les vidanges
  const w3 = world({ staff: [staff(ids.paul, { services: ["vidange"] })] });
  assert.deepEqual(times(w3, job(["plaq_av"])), []);
  assert.ok(times(w3, job(["vidange"])).length > 0);
  // il faut deux mécaniciens
  const two = buildJob([{ id: "plaq_av", qty: 1 }], { ...REQS, plaq_av: req({ labour: 90, immob: 90, staffN: 2 }) });
  assert.deepEqual(times(world(), two), []);
  const w4 = world({ staff: [staff(ids.paul), staff(ids.lea)] });
  assert.deepEqual(pickPlan(w4, two, { day: WED, start: minOf("09:00") }).plan.steps[0].staff, [ids.paul, ids.lea]);
});

test("6. a job across the lunch break is paused and resumed (the car stays on the lift); one that would end after closing is not offered", () => {
  const w = world();
  const j = job(["disq_av"]); // 2 h
  const p = planAt(w, j, WED, minOf("11:00"));
  assert.deepEqual(p.steps[0].segs, [[minOf("11:00"), minOf("12:00")], [minOf("14:00"), minOf("15:00")]]);
  assert.equal(p.ready, minOf("15:00"));
  assert.equal(p.back, minOf("15:15"));
  assert.deepEqual(assignmentsOf(p).find((a) => a.role === "station"), { target: "resource", targetId: ids.lift1, role: "station", a: minOf("11:00"), b: minOf("15:00") });
  assert.ok(times(w, j).includes("11:00"));
  assert.ok(!times(w, j).includes("16:30") && times(w, j).at(-1) === "16:00", "2 h après 16:00 dépassent 18:00");
  assert.match(explain(w, j, { day: WED, start: minOf("16:30") }).reasons[0].text, /ne se termine pas avant la fermeture/);
  // la pause du mécanicien (horaires propres) interrompt aussi le travail
  const own = world({ staff: [staff(ids.paul, { hours: { we: [["08:00", "10:00"], ["10:30", "18:00"]] } })] });
  const p2 = planAt(own, job(["plaq_av"]), WED, minOf("09:00"));
  assert.deepEqual(p2.steps[0].segs, [[minOf("09:00"), minOf("10:00")], [minOf("10:30"), minOf("11:00")]]);
  // une fermeture (congés du garage) : rien ce jour-là
  const closed = world({ ctx: { hours: WEEK, closures: [{ first: WED, last: WED }], holidays: true } });
  assert.deepEqual(times(closed, j), []);
  // 11 novembre (férié) : rien
  assert.deepEqual(times(world({ settings: { minDelayH: 0, horizonDays: 28, stepMin: 30 } }), j, "2026-11-11"), []);
});

test("7. several services: common time counted once, same lift for the same post, tools and posts combined, quantities", () => {
  const w = world({ resources: [lift(ids.lift1), { id: ids.clim, name: "Station clim", type: "clim", active: true, hours: null, services: null }], staff: [staff(ids.paul, { skills: Object.values(SK).map((id) => ({ id, until: null })) })] });
  const j = job(["vidange", "plaq_av"]);
  assert.equal(j.steps.length, 1, "vidange et plaquettes sur le même pont");
  assert.deepEqual(j.steps[0].stations, ["lift"]);
  assert.equal(j.steps[0].labour, 30 + 90 - (10 + 15) + 15, "temps communs : le plus grand seulement");
  assert.equal(j.steps[0].immob, j.steps[0].labour + 10, "temps passif de la vidange (40 − 30)");
  const p = planAt(w, j, WED, minOf("08:00"));
  assert.equal(p.ready, minOf("08:00") + 110 + 10);
  // climatisation (sans poste, avec sa station) : rejoint l'étape du pont, la station est prise pendant la main-d'œuvre
  const j2 = job(["clim", "vidange"]);
  assert.equal(j2.steps.length, 1);
  assert.deepEqual(j2.steps[0].tools, ["clim"]);
  const p2 = planAt(w, j2, WED, minOf("08:00"));
  assert.ok(assignmentsOf(p2).some((a) => a.role === "tool" && a.targetId === ids.clim));
  // deux postes différents : deux étapes qui se suivent
  const geo = world({ resources: [lift(ids.lift1), { id: ids.align, name: "Banc", type: "align", active: true, hours: null, services: null }] });
  const j3 = job(["plaq_av", "geo_av"]);
  assert.equal(j3.steps.length, 2);
  const p3 = planAt(geo, j3, WED, minOf("08:00"));
  assert.deepEqual([p3.steps[0].station, p3.steps[1].station], [ids.lift1, ids.align]);
  assert.equal(p3.steps[1].start, p3.steps[0].ready);
  // 4 pneus : temps commun + (30 − 10) × 4
  assert.equal(job([{ id: "montage", qty: 4 }]).labour, 10 + 20 * 4);
  assert.equal(job([{ id: "inconnu", qty: 1 }]).error, "not_configured");
});

test("8. drop-off: arrival window at the start of each opening range, work after the window, return time the same day", () => {
  const w = world({ settings: { minDelayH: 0, horizonDays: 14, stepMin: 30 } });
  const j = job(["distribution"]); // 4 h, dépôt
  assert.equal(j.drop, true);
  const day = planTimes(w, j, { online: false }).find((d) => d.day === WED);
  assert.deepEqual(day.times.map((t) => [t.start, t.until, t.mode]), [[minOf("08:00"), minOf("09:00"), "drop"]], "l'après-midi, 4 h ne tiennent plus après 15:00");
  const p = day.times[0].plan;
  assert.deepEqual(p.steps[0].segs, [[minOf("09:00"), minOf("12:00")], [minOf("14:00"), minOf("15:00")]]);
  assert.equal(day.times[0].end, minOf("15:15"));
  // pièces à commander : 48 h de délai en ligne (lundi 10:00 → mercredi 10:00 : le dépôt de 8:00 mercredi n'est plus possible)
  const online = planTimes(w, j);
  assert.ok(!online.some((d) => d.day === WED), "mercredi 8:00 est avant le délai des pièces");
  assert.equal(online[0].day, "2026-10-22");
  assert.equal(j.auto, false, "pièces à vérifier : confirmation par le garage");
});

test("9. moving: the reason of a conflict is explained, nearest alternatives are proposed, a chosen mechanic or post is respected", () => {
  const w = world({ staff: [staff(ids.paul), staff(ids.lea)], resources: [lift(ids.lift1), lift(ids.lift2)] });
  const j = job(["plaq_av"]);
  addPlan(w, "r1", pickPlan(w, j, { day: WED, start: minOf("09:00") }).plan); // Paul, pont 1
  const forced = explain(w, j, { day: WED, start: minOf("09:30"), forced: { staff: [ids.paul] } });
  assert.ok(!forced.plan);
  assert.match(forced.reasons.map((r) => r.text).join(" "), /Paul : déjà occupé de 9:00 à 10:30/);
  assert.deepEqual(forced.alternatives[0], { day: WED, start: minOf("10:30"), end: minOf("14:00") }, "prête à 12:00 : restitution à la réouverture");
  const lea = explain(w, j, { day: WED, start: minOf("09:30"), forced: { staff: [ids.lea], station: ids.lift1 } });
  assert.match(lea.reasons[0].text, /Pont n°1 : déjà occupé de 9:00 à 10:30/);
  const ok = explain(w, j, { day: WED, start: minOf("09:30"), forced: { staff: [ids.lea], station: ids.lift2 } });
  assert.deepEqual([ok.plan.steps[0].staff, ok.plan.steps[0].station], [[ids.lea], ids.lift2]);
  assert.match(explain(w, j, { day: "2026-10-19", start: minOf("08:00") }).reasons[0].text, /passé/);
  assert.match(explain(w, j, { day: "2026-10-24", start: minOf("09:00") }).reasons[0].text, /fermé/);
});

test("11. clock change (25 October 2026): instants on both sides, busy hours read in Paris time", () => {
  const w = world({ settings: { minDelayH: 0, horizonDays: 14, stepMin: 30 } });
  const j = job(["plaq_av"]);
  const fri = pickPlan(w, j, { day: "2026-10-23", start: minOf("08:00") });
  const mon = pickPlan(w, j, { day: "2026-10-26", start: minOf("08:00") });
  assert.equal(new Date(parisInstant("2026-10-23", fri.start)).toISOString(), "2026-10-23T06:00:00.000Z");
  assert.equal(new Date(parisInstant("2026-10-26", mon.start)).toISOString(), "2026-10-26T07:00:00.000Z");
  // une occupation saisie en UTC le lundi d'après le changement bloque bien 8:00–9:30 heure de Paris
  const w2 = world({ busy: [{ requestId: "x", target: "resource", targetId: ids.lift1, role: "station", start: Date.UTC(2026, 9, 26, 7, 0), end: Date.UTC(2026, 9, 26, 8, 30) }] });
  assert.equal(times(w2, j, "2026-10-26")[0], "09:30");
  // sur une journée entière qui contient le changement, l'occupation se coupe à minuit, heure de Paris
  const sat = world({ ctx: { hours: { ...WEEK, sa: H, su: H }, closures: [], holidays: true }, unavail: [{ id: "u", target: "staff", targetId: ids.paul, start: at("2026-10-24", "18:00"), end: at("2026-10-25", "10:00"), kind: "absence", label: "" }] });
  assert.equal(times(sat, j, "2026-10-25")[0], "10:00");
});

test("online rules: minimum delay, daily maximum, share of the capacity, horizon", () => {
  const j = job(["plaq_av"]);
  const late = world({ settings: { minDelayH: 48, horizonDays: 14, stepMin: 30 } });
  assert.equal(planTimes(late, j)[0].day, WED);
  assert.equal(planTimes(late, j)[0].times[0].start, minOf("10:00"));
  const two = world({ cal: { receptionMin: 0, returnMin: 15, loadPct: 100, maxDay: 1 }, resources: [lift(ids.lift1), lift(ids.lift2)], staff: [staff(ids.paul), staff(ids.lea)] });
  addPlan(two, "r1", pickPlan(two, j, { day: WED, start: minOf("08:00") }).plan);
  assert.deepEqual(times(two, j), [], "1 rendez-vous en ligne par jour");
  assert.ok(pickPlan(two, j, { day: WED, start: minOf("14:00") }, { online: false }), "le garage, lui, peut encore placer");
  // 50 % de 8 h de travail = 240 min : deux plaquettes (180 min) passent, la troisième non
  const half = world({ cal: { receptionMin: 0, returnMin: 15, loadPct: 50, maxDay: 0 } });
  addPlan(half, "r1", pickPlan(half, j, { day: WED, start: minOf("08:00") }).plan);
  assert.ok(times(half, j).length > 0);
  addPlan(half, "r2", pickPlan(half, j, { day: WED, start: minOf("14:00") }).plan);
  assert.deepEqual(times(half, j), []);
  assert.equal(pickPlan(world(), j, { day: "2026-11-30", start: minOf("08:00") }), null, "au-delà de l'horizon");
  // accueil du véhicule : les travaux commencent 10 min après l'arrivée
  const rec = world({ cal: { receptionMin: 10, returnMin: 15, loadPct: 100, maxDay: 0 } });
  const p = pickPlan(rec, j, { day: WED, start: minOf("08:00") }).plan;
  assert.deepEqual([p.arrival, p.workStart, p.ready, p.back], [minOf("08:00"), minOf("08:10"), minOf("09:40"), minOf("09:55")]);
  assert.ok(times(rec, j).includes("16:00") && !times(rec, j).includes("16:30"), "16:30 + 10 min + 1 h 30 dépasse 18:00");
});

test("vehicle types: durations by type, and the job says when the type must be asked", () => {
  const reqs = { ...REQS, plaq_av: req({ labour: 90, immob: 90, vehicles: { suv: { labour: 120, immob: 120 } } }) };
  assert.equal(buildJob([{ id: "plaq_av", qty: 1 }], reqs).needVehicle, true);
  assert.equal(buildJob([{ id: "plaq_av", qty: 1 }], reqs, "suv").labour, 120);
  assert.equal(buildJob([{ id: "plaq_av", qty: 1 }], reqs, "city").labour, 90);
  assert.equal(buildJob([{ id: "vidange", qty: 1 }], reqs).needVehicle, false);
  assert.equal(buildJob([{ id: "vidange", qty: 1 }], { vidange: { ...REQS.vidange, auto: true } }).auto, true);
  assert.equal(buildJob([{ id: "vidange", qty: 1 }, { id: "plaq_av", qty: 1 }], { vidange: { ...REQS.vidange, auto: true }, plaq_av: REQS.plaq_av }).auto, false, "une manuelle rend la demande manuelle");
});

test("12. existing appointments are placed one after the other; the one that does not fit is reported, nothing is moved", () => {
  const w = world();
  const j = job(["plaq_av"]);
  const out = placeExisting(w, [
    { requestId: "a", day: WED, start: minOf("08:00"), mode: "hour", job: j },
    { requestId: "b", day: WED, start: minOf("08:30"), mode: "hour", job: j }, // même mécanicien, même pont : décalé après a ?
    { requestId: "c", day: WED, start: minOf("09:00"), mode: "drop", job: j, backBy: minOf("10:00") },
    { requestId: "d", day: WED, start: minOf("09:00"), mode: "hour", job: job(["clim"]) },
  ]);
  assert.deepEqual(out.placed.map((p) => [p.requestId, p.plan.workStart]), [["a", minOf("08:00")], ["b", minOf("09:30")]], "b attend que le pont se libère (rendez-vous déjà pris : le travail peut commencer plus tard)");
  assert.deepEqual(out.failed.map((f) => f.requestId), ["c", "d"]);
  assert.match(out.failed[0].reasons[0].text, /restitution promise/);
  assert.match(out.failed[1].reasons[0].text, /Aucun mécanicien|Équipement manquant/);
  assert.deepEqual(placeExisting(w, [{ requestId: "e", day: WED, start: minOf("08:00"), mode: "hour", job: job([{ id: "nope", qty: 1 }]) }]).failed[0].reasons[0].code, "not_configured");
});

test("readiness before activation: a mechanic, then each online service needs skills, a post and its tools", () => {
  const empty = readiness(world({ staff: [] }), ["vidange"]);
  assert.equal(empty.ok, false);
  assert.match(empty.problems[0].text, /au moins un mécanicien/);
  const r = readiness(world(), ["vidange", "plaq_av", "clim", "geo_av", "embrayage"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ready, ["vidange", "plaq_av"]);
  assert.deepEqual(r.problems.map((p) => p.service), ["clim", "geo_av", "embrayage"]);
  assert.match(r.problems.find((p) => p.service === "geo_av").text, /aucun poste compatible \(Banc de géométrie\)/);
  assert.equal(readiness(world({ resources: [] }), ["plaq_av"]).ok, false);
});

test("defaults proposed by the wizard", () => {
  const d = defaultReq("plaq_av", 60, { brakes: SK.brakes });
  assert.deepEqual([d.labour, d.shared, d.immob, d.skills, d.stations, d.auto, d.drop], [60, 15, 60, [SK.brakes], ["lift"], false, false]);
  assert.deepEqual([defaultReq("distribution", 270).parts, defaultReq("distribution", 270).partsH, defaultReq("distribution", 270).drop], [true, 48, true]);
  assert.deepEqual(defaultReq("clim", 45).tools, ["clim"]);
  assert.equal(defaultReq("equil", 15).shared, 5);
});

test("validation of what the garage enters", () => {
  const skillIds = new Set([SK.brakes]);
  assert.deepEqual(parseCalendar({ receptionMin: 10, loadPct: 80, maxDay: 6, step: 2, autoAssign: false }).value, { receptionMin: 10, loadPct: 80, maxDay: 6, step: 2, autoAssign: false });
  for (const bad of [{ receptionMin: 7 }, { loadPct: 40 }, { maxDay: 51 }, { step: 7 }, { nope: 1 }, {}]) assert.ok(parseCalendar(bad).error, JSON.stringify(bad));
  const s = parseStaff({ name: "  Paul  ", skills: [SK.brakes, { id: SK.brakes, until: "2027-06-30" }], services: ["plaq_av", "vidange"] }, { skillIds });
  assert.deepEqual(s.value, { name: "Paul", active: true, hours: null, services: ["vidange", "plaq_av"], skills: [{ id: SK.brakes, until: null }] });
  assert.equal(parseStaff({ name: "P" }, { skillIds }).field, "name");
  assert.equal(parseStaff({ name: "Paul", skills: [SK.maint] }, { skillIds }).field, "skills");
  assert.equal(parseStaff({ name: "Paul", services: [] }, { skillIds }).field, "services");
  assert.equal(parseStaff({ name: "Paul", hours: {} }, { skillIds }).field, "hours");
  assert.deepEqual(parseStaff({ name: "Léa", hours: { mo: [["07:30", "16:00"]] } }, { skillIds }).value.hours, { mo: [["07:30", "16:00"]] });
  assert.deepEqual(parseSkill({ label: "Freinage", cert: true }).value, { label: "Freinage", cert: true });
  assert.ok(parseSkill({ label: "F" }).error);
  assert.deepEqual(parseResource({ name: "Pont n°1", type: "lift" }).value, { name: "Pont n°1", type: "lift", active: true, hours: null, services: null });
  assert.equal(parseResource({ name: "Pont", type: "rocket" }).field, "type");
  const r = parseReq("plaq_av", { labour: 90, shared: 15, skills: [SK.brakes], stations: ["lift"], vehicles: { suv: { labour: 120 } } }, { skillIds });
  assert.deepEqual(r.value, { online: true, labour: 90, shared: 15, immob: 90, staffN: 1, skills: [SK.brakes], stations: ["lift"], tools: [], margin: 0, auto: false, parts: false, partsH: 0, drop: false, vehicles: { suv: { labour: 120, immob: 120 } } });
  for (const [bad, field] of [
    [{ labour: 7 }, "labour"], [{ labour: 60, shared: 70 }, "shared"], [{ labour: 60, immob: 30 }, "immob"], [{ labour: 60, staffN: 4 }, "staffN"],
    [{ labour: 60, stations: ["lift"], tools: ["lift"] }, "tools"], [{ labour: 60, auto: true, parts: true }, "auto"], [{ labour: 60, partsH: 36, parts: true }, "partsH"],
    [{ labour: 60, vehicles: { truck: { labour: 60 } } }, "vehicles"], [{ labour: 60, skills: [SK.maint] }, "skills"],
  ])
    assert.equal(parseReq("plaq_av", bad, { skillIds }).field, field, JSON.stringify(bad));
  assert.equal(parseReq("ct", { labour: 60 }, { skillIds }).field, "service");
  const u = parseUnavail({ target: "staff", targetId: ids.paul, kind: "leave", first: WED, last: "2026-10-23" }, { staffIds: new Set([ids.paul]), resourceIds: new Set(), nowMs: NOW });
  assert.deepEqual([u.value.start, u.value.end], [at(WED, "00:00"), at("2026-10-24", "00:00")]);
  const h = parseUnavail({ target: "staff", targetId: ids.paul, kind: "absence", first: WED, from: "14:00", to: "16:30" }, { staffIds: new Set([ids.paul]), resourceIds: new Set(), nowMs: NOW });
  assert.deepEqual([h.value.start, h.value.end], [at(WED, "14:00"), at(WED, "16:30")]);
  const ctx = { staffIds: new Set([ids.paul]), resourceIds: new Set([ids.lift1]), nowMs: NOW };
  for (const [bad, field] of [
    [{ target: "x" }, "target"], [{ target: "staff", targetId: ids.lea, kind: "leave", first: WED }, "targetId"], [{ target: "staff", targetId: ids.paul, kind: "maintenance", first: WED }, "kind"],
    [{ target: "resource", targetId: ids.lift1, kind: "leave", first: WED }, "kind"], [{ target: "staff", targetId: ids.paul, kind: "leave", first: "2026-10-01" }, "last"],
    [{ target: "staff", targetId: ids.paul, kind: "leave", first: WED, from: "14:00", to: "13:00" }, "to"], [{ target: "staff", targetId: ids.paul, kind: "leave", first: WED, last: "2027-03-01" }, "last"],
  ])
    assert.equal(parseUnavail(bad, ctx).field, field, JSON.stringify(bad));
});
