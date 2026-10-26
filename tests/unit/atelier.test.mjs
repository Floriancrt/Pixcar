// Gestion d'atelier (docs/gestion-atelier.md) : ce que le calcul par créneaux fait des rendez-vous saisis et des créneaux bloqués
// (src/js/shared/rdv.js freeTimes, placeInSlot), la validation de ce que saisit le garage (src/js/shared/plan.js parseBlock), les modules
// et la préférence d'affichage (src/js/shared/work.js). Le 21 octobre 2026 est un mercredi.
import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTimes, hm, minOf, parisInstant, placeInSlot } from "../../src/js/shared/rdv.js";
import { parseBlock } from "../../src/js/shared/plan.js";
import { DEFAULT_MODULES, moduleRule, modulesOf, parseModules, parsePrefs } from "../../src/js/shared/work.js";

const at = (iso, hhmm) => parisInstant(iso, minOf(hhmm));
const H = [["08:00", "12:00"], ["14:00", "18:00"]];
const ctx = { hours: { mo: H, tu: H, we: H, th: H, fr: H }, closures: [], holidays: true };
const SETTINGS = { minDelayH: 0, horizonDays: 28, stepMin: 30 };
const NOW = at("2026-10-19", "10:00");
const WED = "2026-10-21";
const matin = { id: "s1", name: "Matin", days: ["mo", "tu", "we", "th", "fr"], start: minOf("08:00"), end: minOf("12:00"), mode: "hour", capacity: 1, services: ["vidange", "plaq_av"] };
const clim = { id: "s2", name: "Clim", days: ["we"], start: minOf("08:00"), end: minOf("10:00"), mode: "hour", capacity: 1, services: ["clim"] };
const depot = { id: "s3", name: "Dépôt", days: ["we"], start: minOf("14:00"), end: minOf("18:00"), mode: "drop", capacity: 2, services: ["vidange"] };
const vidange = { services: [{ id: "vidange", qty: 1 }], minutes: 45 };
const job = (start, minutes, extra = {}) => ({ id: `j${start}`, slotId: "s1", day: WED, start: minOf(start), end: minOf(start) + minutes, status: "confirmed", deadline: null, ...extra });
const hold = (start, end) => ({ id: `h${start}`, slotId: null, day: WED, start: minOf(start), end: minOf(end), status: "confirmed", deadline: null, hold: true });
const timesOn = (bookings, slots = [matin, depot]) =>
  (freeTimes({ nowMs: NOW, ctx, settings: SETTINGS, slots, need: vidange, bookings }).find((d) => d.day === WED) || { times: [] }).times.map((x) => (x.mode === "drop" ? `dépôt ${hm(x.start)}` : hm(x.start)));

test("free times: a whole-workshop hold removes every arrival and every job that would overlap it, in every slot of that day only", () => {
  assert.deepEqual(timesOn([]), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "dépôt 14:00"]);
  assert.deepEqual(timesOn([hold("09:00", "10:00")]), ["08:00", "10:00", "10:30", "11:00", "dépôt 14:00"]);
  // un dépôt : l'heure d'arrivée (la première heure du créneau) compte, pas la journée entière
  assert.deepEqual(timesOn([hold("14:30", "15:30")]), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"], "arrivée de 14:00 à 15:00 : touchée à 14:30");
  assert.ok(timesOn([hold("16:00", "17:00")]).includes("dépôt 14:00"));
  // un autre jour, ou une demande refusée : sans effet ; un blocage n'occupe pas de place dans un créneau
  assert.equal(timesOn([{ ...hold("09:00", "10:00"), day: "2026-10-22" }]).length, 8);
  assert.equal(timesOn([{ ...job("09:00", 60), status: "declined" }]).length, 8);
  // un rendez-vous saisi compte comme une demande confirmée, sur toute sa durée
  assert.deepEqual(timesOn([job("09:00", 60)]), ["08:00", "10:00", "10:30", "11:00", "dépôt 14:00"]);
});

test("placeInSlot: the slot that holds the start time, services and full duration preferred; full is told, not refused; none outside slots", () => {
  const slots = [clim, matin];
  const place = (start, minutes, services, bookings = [], extra = {}) => placeInSlot({ slots, bookings, nowMs: NOW, day: WED, start: minOf(start), minutes, services, ...extra });
  // la vidange va dans « Matin » (il la propose), même si « Clim » est listé avant et couvre l'heure
  assert.deepEqual([place("08:30", 45, [{ id: "vidange" }]).slot.id, place("08:30", 45, [{ id: "vidange" }]).busy], ["s1", 0]);
  // une prestation qu'aucun créneau ne propose : le premier qui couvre l'heure et la durée
  assert.equal(place("08:00", 60, [{ id: "embrayage" }]).slot.id, "s2");
  assert.equal(place("09:30", 60, [{ id: "embrayage" }]).slot.id, "s1", "Clim finit à 10:00 : la durée tient dans Matin");
  // « Matin » pris de 9:00 à 10:00 : 9:30 → plein (Clim ne propose pas la vidange mais a de la place : il la prend)
  const taken = [job("09:00", 60)];
  assert.equal(place("09:30", 30, [{ id: "vidange" }], taken).slot.id, "s2");
  const both = [...taken, { ...job("09:00", 60), id: "c", slotId: "s2" }];
  assert.deepEqual([place("09:30", 30, [{ id: "vidange" }], both).full.id, place("09:30", 30, [{ id: "vidange" }], both).busy], ["s1", 1]);
  // celui qu'on déplace ne se compte pas ; une demande expirée non plus ; à 10:00, la place est libre
  assert.equal(place("09:30", 30, [{ id: "vidange" }], taken, { exclude: "j09:00" }).slot.id, "s1");
  assert.equal(place("09:30", 30, [{ id: "vidange" }], [{ ...taken[0], status: "pending", deadline: NOW - 1 }]).slot.id, "s1");
  assert.equal(place("10:00", 30, [{ id: "vidange" }], taken).slot.id, "s1");
  // hors des créneaux (midi, samedi) : aucun
  assert.deepEqual(place("12:30", 30, [{ id: "vidange" }]), { slot: null });
  assert.deepEqual(placeInSlot({ slots, bookings: [], nowMs: NOW, day: "2026-10-24", start: 540, minutes: 30, services: [] }), { slot: null });
  // dépôt : les voitures du jour comptent, pas les heures
  const d = (bookings) => placeInSlot({ slots: [depot], bookings, nowMs: NOW, day: WED, start: minOf("15:00"), minutes: 45, services: [] });
  assert.equal(d([{ ...job("14:00", 240), slotId: "s3" }]).slot.id, "s3");
  assert.equal(d([{ ...job("14:00", 240), slotId: "s3" }, { ...job("14:00", 240), id: "b", slotId: "s3" }]).full.id, "s3");
});

test("parseBlock: client or vehicle, optional fields kept out when absent, whole-workshop hold, no mechanic or post without the resource calculation", () => {
  const ids = { staffIds: new Set(), resourceIds: new Set(), serviceIds: new Set(["vidange"]), nowMs: NOW };
  const base = { kind: "job", services: ["vidange"], day: WED, time: "09:00" };
  const v = parseBlock({ ...base, client: "  M.  Martin ", car: "Clio", plate: "ab-123 cd", phone: "+33 6 12 34 56 78", note: "Ligne 1\nLigne 2", channel: "walkin", minutes: 60, back: "12:00" }, ids).value;
  assert.deepEqual(v, { kind: "job", day: WED, start: 540, services: [{ id: "vidange", qty: 1 }], vehicle: "", staff: [], station: null, client: "M. Martin", car: "Clio", plate: "AB-123 CD", phone: "+33612345678", note: "Ligne 1\nLigne 2", channel: "walkin", minutes: 60, back: 720 });
  // absents : pas de clé (une modification les garde) ; null : à recalculer ; « label » reste lu comme le client (lot 3b)
  assert.deepEqual(Object.keys(parseBlock(base, ids).value).sort(), ["day", "kind", "services", "staff", "start", "station", "vehicle"]);
  assert.equal(parseBlock({ ...base, label: "Mme Durand" }, ids).value.client, "Mme Durand");
  assert.deepEqual([parseBlock({ ...base, minutes: null, back: null }, ids).value.minutes, parseBlock({ ...base, minutes: null, back: "" }, ids).value.back], [null, null]);
  assert.equal(parseBlock({ ...base, back: "24:00" }, ids).value.back, 1440);
  for (const [over, field] of [
    [{ phone: "06 12 AB" }, "phone"],
    [{ plate: "AB*123" }, "plate"],
    [{ minutes: 1441 }, "minutes"],
    [{ minutes: 62 }, "minutes"],
    [{ back: "09:00" }, "back"],
    [{ back: "9h" }, "back"],
    [{ channel: "pixcar" }, "channel"],
    [{ client: 12 }, "label"],
    [{ staff: ["aaaaaaaa-0000-4000-8000-000000000001"] }, "staff"],
    [{ station: "aaaaaaaa-0000-4000-8000-000000000001" }, "staff"],
  ])
    assert.equal(parseBlock({ ...base, ...over }, ids).field, field, JSON.stringify(over));
  // créneau bloqué : sans mécanicien ni poste, tout l'atelier
  assert.deepEqual(parseBlock({ kind: "hold", label: "Formation", day: WED, time: "14:00", to: "18:00" }, ids).value, { kind: "hold", label: "Formation", day: WED, start: 840, end: 1080, staff: [], resources: [], whole: true });
  assert.equal(parseBlock({ kind: "hold", label: "Formation", day: WED, time: "14:00", to: "18:00", resources: ["aaaaaaaa-0000-4000-8000-000000000001"] }, ids).field, "staff");
  const adv = { ...ids, resourceIds: new Set(["aaaaaaaa-0000-4000-8000-000000000001"]) };
  assert.equal(parseBlock({ kind: "hold", label: "Pont", day: WED, time: "14:00", to: "18:00", resources: ["aaaaaaaa-0000-4000-8000-000000000001"] }, adv).value.whole, false);
});

test("modules and display preference: defaults, dependencies, the resource calculation lock", () => {
  assert.deepEqual(modulesOf(null), { ...DEFAULT_MODULES, stats: false });
  assert.deepEqual(modulesOf({ track: false, stats: true, foo: 1 }), { staff: true, equip: true, track: false, load: true, stats: false });
  assert.deepEqual(parseModules({ track: false }, { current: { load: false } }).value, { staff: true, equip: true, track: false, load: false });
  assert.equal(parseModules({ staff: false, equip: false }).field, "modules", "la charge demande l'un des deux");
  assert.deepEqual(parseModules({ staff: false, equip: false, load: false }).value, { staff: false, equip: false, track: true, load: false });
  assert.equal(parseModules({ equip: false }, { byResources: true }).code, "in_use");
  assert.equal(parseModules({ track: false }, { byResources: true }).error, undefined);
  for (const bad of [null, [], { stats: true }, { x: true }, { track: 1 }]) assert.ok(parseModules(bad).error, JSON.stringify(bad));
  assert.deepEqual(moduleRule("staff", true, modulesOf(null), { byResources: true }).locked, true);
  assert.deepEqual(moduleRule("staff", true, modulesOf(null)).locked, false);
  assert.deepEqual(moduleRule("load", false, { staff: false, equip: false }).locked, true);
  assert.deepEqual(parsePrefs({ view: "simple" }).value, { view: "simple" });
  assert.deepEqual(parsePrefs({ view: null, shortcuts: ["planning"] }).value, { view: null, shortcuts: ["planning"] });
  assert.equal(parsePrefs({ view: "expert" }).field, "view");
  assert.equal(parsePrefs({}).field, "shortcuts");
});
