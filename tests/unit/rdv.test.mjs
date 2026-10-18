// Rendez-vous en ligne (src/js/shared/rdv.js) : heure de Paris, jours fériés, heure limite, horaires libres et capacité, validation des
// réglages du garage, fichier d'agenda. Dates de référence : octobre et novembre 2026 (le 19 octobre 2026 est un lundi).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays, dayLabel, deadlineAfter, earliestStart, easter, freeTimes, holidayName, holds, hm, icsCalendar, instantLabel, isOpenDay, minOf, neededMinutes,
  nextHolidays, parisInstant, parisParts, parseClosure, parseServices, parseSettings, parseSlot, pickOffer, servicesParam, servicesText, weekday, whenLabel,
} from "../../src/js/shared/rdv.js";

const at = (iso, hhmm) => parisInstant(iso, minOf(hhmm));
const WEEK = { mo: [["08:00", "12:00"], ["14:00", "18:00"]], tu: [["08:00", "12:00"], ["14:00", "18:00"]], we: [["08:00", "12:00"], ["14:00", "18:00"]], th: [["08:00", "12:00"], ["14:00", "18:00"]], fr: [["08:00", "12:00"], ["14:00", "18:00"]] };
const ctx = (extra = {}) => ({ hours: WEEK, closures: [], holidays: true, ...extra });
const SETTINGS = { minDelayH: 0, horizonDays: 28, stepMin: 30 };
const entretien = { id: "s1", days: ["mo", "tu", "we", "th", "fr"], start: minOf("08:00"), end: minOf("12:00"), mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] };
const vidange45 = { services: [{ id: "vidange", qty: 1 }], minutes: 45 };

test("Paris time: offsets in summer and winter, both clock changes of 2026", () => {
  assert.equal(new Date(at("2026-10-21", "08:30")).toISOString(), "2026-10-21T06:30:00.000Z"); // UTC+2
  assert.equal(new Date(at("2026-12-01", "12:00")).toISOString(), "2026-12-01T11:00:00.000Z"); // UTC+1
  assert.equal(new Date(at("2026-03-29", "10:00")).toISOString(), "2026-03-29T08:00:00.000Z"); // jour du passage à l'heure d'été
  assert.equal(new Date(at("2026-10-25", "10:00")).toISOString(), "2026-10-25T09:00:00.000Z"); // jour du passage à l'heure d'hiver
  assert.deepEqual(parisParts(Date.UTC(2026, 9, 24, 22, 30)), { iso: "2026-10-25", min: 30, wd: "su" });
  assert.deepEqual(parisParts(Date.UTC(2026, 9, 25, 1, 30)), { iso: "2026-10-25", min: 150, wd: "su" });
  for (const iso of ["2026-01-15", "2026-07-15"]) for (const t of ["00:00", "08:15", "23:45"]) assert.deepEqual(parisParts(at(iso, t)), { iso, min: minOf(t), wd: weekday(iso) });
  assert.equal(weekday("2026-10-19"), "mo");
  assert.equal(weekday("2026-10-18"), "su");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(hm(510), "08:30");
  assert.ok(Number.isNaN(minOf("8:30")));
  assert.equal(minOf("24:00"), 1440);
});

test("French labels: days, times, instants", () => {
  assert.equal(dayLabel("2026-10-20"), "mardi 20 octobre");
  assert.equal(dayLabel("2026-10-20", { short: true }), "mar. 20 oct.");
  assert.equal(whenLabel("2026-10-20", 510), "mardi 20 octobre à 8:30");
  assert.equal(instantLabel(at("2026-10-19", "12:00")), "lundi 19 octobre à 12:00");
});

test("public holidays: Easter-based dates and fixed ones", () => {
  assert.deepEqual([2024, 2025, 2026, 2027].map(easter), ["2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28"]);
  assert.equal(holidayName("2026-04-06"), "Lundi de Pâques");
  assert.equal(holidayName("2026-05-14"), "Ascension");
  assert.equal(holidayName("2026-05-25"), "Lundi de Pentecôte");
  assert.equal(holidayName("2026-11-11"), "Armistice");
  assert.equal(holidayName("2026-11-12"), "");
  assert.deepEqual(nextHolidays("2026-10-18", 3), [{ day: "2026-11-01", name: "Toussaint" }, { day: "2026-11-11", name: "Armistice" }, { day: "2026-12-25", name: "Noël" }]);
  assert.deepEqual(nextHolidays("2026-12-26", 1), [{ day: "2027-01-01", name: "Jour de l'an" }]);
});

test("deadline: noon on the next day the garage opens, skipping closures and (when set) public holidays", () => {
  // vendredi 16 octobre, 15 h → lundi 19 à midi (le garage ne travaille pas le week-end)
  assert.equal(deadlineAfter(at("2026-10-16", "15:00"), ctx()), at("2026-10-19", "12:00"));
  // ouvert le samedi : samedi 17 à midi
  assert.equal(deadlineAfter(at("2026-10-16", "15:00"), ctx({ hours: { ...WEEK, sa: [["08:00", "12:00"]] } })), at("2026-10-17", "12:00"));
  // demande faite à 8 h un lundi : mardi à midi (jamais le jour même)
  assert.equal(deadlineAfter(at("2026-10-19", "08:00"), ctx()), at("2026-10-20", "12:00"));
  // mardi 10 novembre : le mercredi 11 est férié → jeudi 12 ; si le garage travaille les jours fériés, mercredi 11
  assert.equal(deadlineAfter(at("2026-11-10", "10:00"), ctx()), at("2026-11-12", "12:00"));
  assert.equal(deadlineAfter(at("2026-11-10", "10:00"), ctx({ holidays: false })), at("2026-11-11", "12:00"));
  // fermeture du 20 au 23 octobre : lundi 26
  assert.equal(deadlineAfter(at("2026-10-19", "10:00"), ctx({ closures: [{ first: "2026-10-20", last: "2026-10-23" }] })), at("2026-10-26", "12:00"));
  // garage sans aucun jour ouvert : le premier jour du lundi au vendredi hors fériés
  assert.equal(deadlineAfter(at("2026-11-10", "10:00"), ctx({ hours: {} })), at("2026-11-12", "12:00"));
  // juste avant minuit : le lendemain compte comme « jour suivant »
  assert.equal(deadlineAfter(at("2026-10-19", "23:59"), ctx()), at("2026-10-20", "12:00"));
  assert.equal(isOpenDay("2026-10-24", ctx()), false);
});

test("earliest start: the later of the deadline and now + minimum delay, never their sum", () => {
  const now = at("2026-10-19", "10:00");
  assert.equal(earliestStart(now, ctx(), 0), at("2026-10-20", "12:00"));
  assert.equal(earliestStart(now, ctx(), 24), at("2026-10-20", "12:00"));
  assert.equal(earliestStart(now, ctx(), 48), at("2026-10-21", "10:00"));
});

test("requested services: quantities only for per-tyre or per-wheel services, needed time multiplied", () => {
  assert.deepEqual(parseServices("vidange,montage:2").value, [{ id: "vidange", qty: 1 }, { id: "montage", qty: 2 }]);
  assert.deepEqual(parseServices([{ id: "equil", qty: 4 }]).value, [{ id: "equil", qty: 4 }]);
  for (const bad of ["", "inconnu", "vidange:2", "montage:5", "montage:0", "vidange,vidange", "ct", "a,b,c,d,e,f"]) assert.ok(parseServices(bad).error, bad);
  assert.equal(servicesParam([{ id: "vidange", qty: 1 }, { id: "montage", qty: 2 }]), "vidange,montage:2");
  assert.equal(servicesText([{ id: "vidange", qty: 1 }, { id: "montage", qty: 2 }]), "Vidange (huile + filtre) + Montage et équilibrage d'un pneu × 2");
  assert.equal(neededMinutes([{ id: "vidange", qty: 1 }, { id: "montage", qty: 2 }], { vidange: 45, montage: 20 }), 85);
  assert.equal(neededMinutes([{ id: "vidange", qty: 1 }], {}), null);
});

test("free times, at a set hour: inside the slot and one opening range, after the deadline, every step", () => {
  const now = at("2026-10-19", "10:00"); // lundi ; heure limite mardi 20 à midi
  const days = freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: vidange45 });
  assert.equal(days[0].day, "2026-10-21"); // mardi : l'entretien finit à midi, rien après l'heure limite
  assert.deepEqual(days[0].times.map((t) => hm(t.start)), ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert.equal(days[0].times[0].end, minOf("08:45"));
  assert.ok(days.every((d) => !["sa", "su"].includes(weekday(d.day))));
  assert.equal(days.at(-1).day <= addDays("2026-10-19", 27), true);
  // un créneau à cheval sur la pause de midi : aucune heure qui la traverse
  const longSlot = { ...entretien, id: "s2", end: minOf("18:00") };
  const t = freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [longSlot], need: { services: [{ id: "vidange", qty: 1 }], minutes: 90 } })[0].times.map((x) => hm(x.start));
  assert.deepEqual(t, ["14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]); // mardi 20 après midi (heure limite à midi pile)
  // pas de 60 min, délai minimum 48 h
  const d2 = freeTimes({ nowMs: now, ctx: ctx(), settings: { ...SETTINGS, stepMin: 60, minDelayH: 48 }, slots: [entretien], need: vidange45 });
  assert.equal(d2[0].day, "2026-10-21");
  assert.deepEqual(d2[0].times.map((x) => hm(x.start)), ["10:00", "11:00"]);
});

test("free times: capacity, expired pending requests, other slots and days do not count", () => {
  const now = at("2026-10-19", "10:00");
  const b = (start, minutes, extra = {}) => ({ slotId: "s1", day: "2026-10-21", start: minOf(start), end: minOf(start) + minutes, status: "confirmed", ...extra });
  const times = (bookings) => freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: vidange45, bookings })[0].times.map((x) => hm(x.start));
  // une voiture à 9:00 : il reste une place partout (capacité 2)
  assert.equal(times([b("09:00", 45)]).length, 7);
  // deux voitures de 9:00 à 9:45 : 8:30 (8:30–9:15), 9:00 et 9:30 tombent
  assert.deepEqual(times([b("09:00", 45), b("09:00", 45, { status: "pending", deadline: now + 3600e3 })]), ["08:00", "10:00", "10:30", "11:00"]);
  // une demande en attente dont l'heure limite est passée, refusée, annulée : ne retiennent rien
  assert.equal(times([b("09:00", 45), b("09:00", 45, { status: "pending", deadline: now - 1 })]).length, 7);
  assert.equal(times([b("09:00", 45), b("09:00", 45, { status: "declined" }), b("09:00", 45, { status: "cancelled" })]).length, 7);
  // autre créneau, autre jour : sans effet
  assert.equal(times([b("09:00", 45), b("09:00", 45, { slotId: "s9" }), b("09:00", 45, { day: "2026-10-22" })]).length, 7);
  // deux voitures qui ne se chevauchent pas entre elles : seul l'instant où elles sont deux compte
  assert.deepEqual(times([b("08:00", 45), b("08:30", 45)]), ["09:00", "09:30", "10:00", "10:30", "11:00"]);
  assert.equal(holds({ status: "confirmed" }, now), true);
  assert.equal(holds({ status: "code" }, now), false);
});

test("free times: drop-off mode, overlapping slots merged, services, closures, holidays, horizon", () => {
  const now = at("2026-10-19", "10:00");
  const depot = { id: "s3", days: ["tu", "th"], start: minOf("08:00"), end: minOf("18:00"), mode: "drop", capacity: 1, services: ["distribution", "vidange"] };
  const need = { services: [{ id: "distribution", qty: 1 }], minutes: 270 };
  const days = freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [depot], need });
  assert.equal(days[0].day, "2026-10-22"); // jeudi (le mardi 20 à 8 h précède l'heure limite)
  assert.deepEqual(days[0].times, [{ start: minOf("08:00"), end: minOf("18:00"), slotId: "s3", mode: "drop", until: minOf("09:00") }]);
  const full = [{ slotId: "s3", day: "2026-10-22", start: minOf("08:00"), end: minOf("18:00"), status: "confirmed" }];
  assert.equal(freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [depot], need, bookings: full })[0].day, "2026-10-27");
  // trop long pour le créneau
  assert.deepEqual(freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: { services: [{ id: "vidange", qty: 1 }], minutes: 300 } }), []);
  // deux créneaux proposent 8:00 le mardi : une seule offre, celle du premier
  const twin = { ...entretien, id: "s4", capacity: 1 };
  const merged = freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien, twin], need: vidange45 })[0];
  assert.equal(merged.times.filter((t) => t.start === minOf("08:00")).length, 1);
  assert.equal(merged.times[0].slotId, "s1");
  // une prestation que le créneau ne prend pas : rien
  assert.deepEqual(freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: { services: [{ id: "clim", qty: 1 }], minutes: 45 } }), []);
  // prestations demandées ensemble : il faut un créneau qui les prenne toutes
  assert.equal(freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: { services: [{ id: "vidange", qty: 1 }, { id: "plaq_av", qty: 1 }], minutes: 105 } })[0].times.length, 5);
  // fermeture et jour férié (mercredi 11 novembre) ; horizon d'une semaine
  const all = freeTimes({ nowMs: now, ctx: ctx({ closures: [{ first: "2026-10-21", last: "2026-10-23" }] }), settings: SETTINGS, slots: [entretien], need: vidange45 }).map((d) => d.day);
  assert.ok(!all.includes("2026-10-21") && !all.includes("2026-10-23") && all.includes("2026-10-26"));
  assert.ok(!all.includes("2026-11-11") && all.includes("2026-11-12"));
  assert.ok(freeTimes({ nowMs: now, ctx: ctx({ holidays: false }), settings: SETTINGS, slots: [entretien], need: vidange45 }).some((d) => d.day === "2026-11-11"));
  const week = freeTimes({ nowMs: now, ctx: ctx(), settings: { ...SETTINGS, horizonDays: 7 }, slots: [entretien], need: vidange45 }).map((d) => d.day);
  assert.deepEqual(week, ["2026-10-21", "2026-10-22", "2026-10-23"]); // le lundi 26 est le 8e jour
  assert.equal(freeTimes({ nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: vidange45, first: true }).length, 1);
  // l'horaire choisi est-il libre ?
  const args = { nowMs: now, ctx: ctx(), settings: SETTINGS, slots: [entretien], need: vidange45 };
  assert.equal(pickOffer(args, { day: "2026-10-21", start: minOf("08:30") }).slotId, "s1");
  assert.equal(pickOffer(args, { day: "2026-10-21", start: minOf("08:15") }), null);
  assert.equal(pickOffer(args, { day: "2026-10-20", start: minOf("08:30") }), null);
});

test("parseSlot: days the garage opens, within its hours, quarter hours, capacity, services done with an average time", () => {
  const offered = { vidange: 45, plaq_av: 60, distribution: 270 };
  const ok = parseSlot({ name: " Entretien  courant ", days: ["tu", "mo"], start: "08:00", end: "12:00", mode: "hour", capacity: 2, services: ["plaq_av", "vidange"] }, { hours: WEEK, offered });
  assert.deepEqual(ok.value, { name: "Entretien courant", days: ["mo", "tu"], start: 480, end: 720, mode: "hour", capacity: 2, services: ["vidange", "plaq_av"] });
  assert.equal(parseSlot({ days: ["mo"], start: "08:00", end: "18:00", services: ["vidange"] }, { hours: WEEK, offered }).value.name, "Créneau");
  const bad = (b, field) => assert.equal(parseSlot({ days: ["mo"], start: "08:00", end: "12:00", services: ["vidange"], ...b }, { hours: WEEK, offered }).field, field, JSON.stringify(b));
  bad({ days: [] }, "days");
  bad({ days: ["sa"] }, "days"); // fermé le samedi
  bad({ start: "07:00" }, "start"); // avant l'ouverture
  bad({ end: "18:30" }, "start"); // après la fermeture
  bad({ start: "08:10" }, "start");
  bad({ end: "08:15" }, "end");
  bad({ mode: "maybe" }, "mode");
  bad({ capacity: 0 }, "capacity");
  bad({ capacity: 10 }, "capacity");
  bad({ services: [] }, "services");
  bad({ services: ["clim"] }, "services"); // pas de temps moyen
  bad({ services: ["distribution"] }, "services"); // 4 h 30 dans un créneau de 4 h
  bad({ name: "x".repeat(41) }, "name");
  assert.equal(parseSlot({ days: ["mo"], start: "08:00", end: "12:00", services: ["vidange"] }, { hours: null, offered }).field, "hours");
});

test("parseSettings, parseClosure", () => {
  assert.deepEqual(parseSettings({ enabled: true, minDelayH: 4, horizonDays: 14, stepMin: 15, holidays: false }).value, { enabled: true, minDelayH: 4, horizonDays: 14, stepMin: 15, holidays: false });
  for (const bad of [null, [], {}, { enabled: 1 }, { minDelayH: 3 }, { horizonDays: 30 }, { stepMin: 20 }, { other: 1 }]) assert.ok(parseSettings(bad).error, JSON.stringify(bad));
  const today = "2026-10-18";
  assert.deepEqual(parseClosure({ first: "2026-12-24", last: "2027-01-02", label: " Congés " }, today).value, { first: "2026-12-24", last: "2027-01-02", label: "Congés" });
  assert.deepEqual(parseClosure({ first: "2026-11-02" }, today).value, { first: "2026-11-02", last: "2026-11-02", label: "" });
  assert.ok(parseClosure({ first: "2026-10-18", last: "2026-10-18" }, today).value); // aujourd'hui compte
  for (const bad of [{ first: "2026-10-01", last: "2026-10-10" }, { first: "2026-12-02", last: "2026-12-01" }, { first: "2026-02-30" }, { first: "2026-11-01", last: "2027-03-01" }, { first: "2028-01-01" }, { first: "2026-11-02", label: "x".repeat(61) }])
    assert.ok(parseClosure(bad, today).error, JSON.stringify(bad));
});

test("icsCalendar: CRLF lines of 75 bytes at most, escaped text, UTC times, cancelled events", () => {
  const ics = icsCalendar([{ uid: "abc@pixcar.fr", start: at("2026-10-21", "08:30"), end: at("2026-10-21", "09:15"), summary: "Vidange, chez Garage Martin; Lyon", location: "12 rue de la Paix, 69002 Lyon", description: "Ligne 1\nLigne 2 " + "é".repeat(60) }], Date.UTC(2026, 9, 18, 12));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(ics.includes("DTSTART:20261021T063000Z\r\n"));
  assert.ok(ics.includes("DTEND:20261021T071500Z\r\n"));
  assert.ok(ics.includes("SUMMARY:Vidange\\, chez Garage Martin\\; Lyon"));
  assert.ok(ics.includes("DESCRIPTION:Ligne 1\\nLigne 2"));
  assert.ok(ics.includes("STATUS:CONFIRMED"));
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(icsCalendar([{ uid: "x", start: 0, end: 1, summary: "a", cancelled: true }]).includes("STATUS:CANCELLED"));
});
