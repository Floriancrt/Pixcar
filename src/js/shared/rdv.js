// Rendez-vous en ligne (docs/rendez-vous.md, lot 2) : heure de Paris, jours fériés, heure limite de réponse du garage, horaires proposés
// et capacité des créneaux, validation de ce que le garage règle. Une seule définition, partagée par l'API (dernier mot), la page Pro
// (aperçu d'un créneau) et les pages de l'automobiliste (libellés, fichier d'agenda). Fonctions pures : l'heure vient de l'appelant.
import { DAYS, MINUTES_STEP } from "./garage-profile.js";
import { PRO_SERVICES } from "./pro-prices.js";

export const TZ = "Europe/Paris";
const DAY_KEYS = DAYS.map((d) => d[0]); // mo … su
const SERVICE_BY_ID = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const DAY_MS = 864e5;

// ---------------------------------------------------------------- heure de Paris
let partsFmt = null;
// { iso: "2026-10-21", min: minutes depuis minuit (heure de Paris), wd: "tu" } pour un instant (ms)
export function parisParts(ms) {
  partsFmt ||= new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const iso = `${p.year}-${p.month}-${p.day}`;
  return { iso, min: Number(p.hour) * 60 + Number(p.minute), wd: weekday(iso) };
}
// Décalage de Paris sur l'UTC à cet instant, en minutes (60 l'hiver, 120 l'été)
function offsetMin(ms) {
  const p = parisParts(ms);
  const [y, m, d] = p.iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) + p.min * 60e3 - (ms - (ms % 60e3))) / 60e3);
}
// Instant (ms) de « tel jour, telle minute » à Paris. Une heure qui n'existe pas (la nuit du passage à l'heure d'été) glisse d'une heure.
export function parisInstant(iso, minutes) {
  const [y, m, d] = iso.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * 60e3;
  let t = wall - offsetMin(wall) * 60e3;
  const again = wall - offsetMin(t) * 60e3;
  if (again !== t) t = again;
  return t;
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}
export const weekday = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_KEYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
};
export const isIsoDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

// « 08:30 » ↔ 510
export const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const minOf = (t) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t)) || (t === "24:00" ? [0, "24", "00"] : null);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
export const timeLabel = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`; // 8:30
const dayDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
// « mardi 21 octobre » ; short : « mar. 21 oct. »
export const dayLabel = (iso, { year = false, short = false } = {}) =>
  dayDate(iso).toLocaleDateString("fr-FR", { timeZone: "UTC", weekday: short ? "short" : "long", day: "numeric", month: short ? "short" : "long", ...(year ? { year: "numeric" } : {}) });
// « mardi 21 octobre à 8:30 »
export const whenLabel = (iso, min, opts) => `${dayLabel(iso, opts)} à ${timeLabel(min)}`;
// « lundi 20 octobre à 12:00 » pour un instant
export const instantLabel = (ms) => {
  const p = parisParts(ms);
  return whenLabel(p.iso, p.min);
};

// ---------------------------------------------------------------- jours fériés (métropole)
// Pâques (algorithme de Meeus, Jones et Butcher, calendrier grégorien)
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const holidayCache = new Map();
// { "2026-11-11": "Armistice", … } pour une année
export function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easter(y);
  const out = {
    [`${y}-01-01`]: "Jour de l'an",
    [addDays(e, 1)]: "Lundi de Pâques",
    [`${y}-05-01`]: "Fête du travail",
    [`${y}-05-08`]: "Victoire 1945",
    [addDays(e, 39)]: "Ascension",
    [addDays(e, 50)]: "Lundi de Pentecôte",
    [`${y}-07-14`]: "Fête nationale",
    [`${y}-08-15`]: "Assomption",
    [`${y}-11-01`]: "Toussaint",
    [`${y}-11-11`]: "Armistice",
    [`${y}-12-25`]: "Noël",
  };
  holidayCache.set(y, out);
  return out;
}
export const holidayName = (iso) => holidays(Number(iso.slice(0, 4)))[iso] || "";
// Les n prochains jours fériés à partir de ce jour (compris) : [{ day, name }]
export function nextHolidays(fromIso, n = 3) {
  const y = Number(fromIso.slice(0, 4));
  return [y, y + 1]
    .flatMap((yy) => Object.entries(holidays(yy)).map(([day, name]) => ({ day, name })))
    .filter((h) => h.day >= fromIso)
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .slice(0, n);
}

// ---------------------------------------------------------------- jours d'ouverture
// ctx : { hours (horaires de « Mon garage »), closures: [{ first, last }], holidays: true si le garage ferme les jours fériés }
export const openRanges = (iso, hours) => ((hours && hours[weekday(iso)]) || []).map(([a, b]) => [minOf(a), minOf(b)]);
export const closureOf = (iso, closures) => (closures || []).find((c) => c.first <= iso && iso <= c.last) || null;
export function isOpenDay(iso, ctx) {
  if (closureOf(iso, ctx.closures)) return false;
  if (ctx.holidays && holidayName(iso)) return false;
  return openRanges(iso, ctx.hours).length > 0;
}

// Heure limite de réponse du garage pour une demande envoyée à l'instant ms : 12:00 (Paris) du premier jour ouvré qui suit. Sans aucun
// jour ouvré dans les 60 jours (garage fermé partout), le premier jour du lundi au vendredi hors jours fériés.
export const DEADLINE_MIN = 12 * 60;
export function deadlineAfter(ms, ctx) {
  const today = parisParts(ms).iso;
  for (let i = 1; i <= 60; i++) {
    const d = addDays(today, i);
    if (isOpenDay(d, ctx)) return parisInstant(d, DEADLINE_MIN);
  }
  for (let i = 1; ; i++) {
    const d = addDays(today, i);
    if (!["sa", "su"].includes(weekday(d)) && !holidayName(d)) return parisInstant(d, DEADLINE_MIN);
  }
}
// Premier instant qu'on peut proposer : le plus tardif de l'heure limite et de maintenant + délai minimum (pas leur somme)
export const earliestStart = (ms, ctx, minDelayH) => Math.max(deadlineAfter(ms, ctx), ms + minDelayH * 3600e3);

// ---------------------------------------------------------------- prestations demandées
// « vidange,montage:2 » → { value: [{ id: "vidange", qty: 1 }, { id: "montage", qty: 2 }] } ; quantité (1 à 4) seulement pour une
// prestation « par pneu » ou « par roue ».
export const QTY_MAX = 4;
export function parseServices(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",").filter(Boolean).map((x) => {
    const [id, q] = x.split(":");
    return { id, qty: q === undefined ? 1 : Number(q) };
  });
  if (!list.length || list.length > 5) return { error: "Choisissez de 1 à 5 prestations." };
  const out = [];
  for (const raw of list) {
    const s = raw && SERVICE_BY_ID.get(raw.id);
    if (!s) return { error: "Prestation inconnue." };
    const qty = raw.qty === undefined ? 1 : raw.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > (s.unit ? QTY_MAX : 1)) return { error: s.unit ? `${s.label} : de 1 à ${QTY_MAX}.` : `${s.label} : une seule fois.` };
    if (out.some((x) => x.id === s.id)) return { error: "Une prestation en double." };
    out.push({ id: s.id, qty });
  }
  return { value: out };
}
export const servicesParam = (list) => list.map((s) => (s.qty > 1 ? `${s.id}:${s.qty}` : s.id)).join(",");
// « Vidange (huile + filtre) », « Montage et équilibrage d'un pneu × 2 »
export const serviceText = (s) => {
  const x = SERVICE_BY_ID.get(s.id);
  return (x ? x.label : s.id) + (s.qty > 1 ? ` × ${s.qty}` : "");
};
export const servicesText = (list) => list.map(serviceText).join(" + ");
// Temps nécessaire (minutes) : temps moyens du garage (minutesById) × quantités ; null si une prestation n'a pas de temps moyen
export function neededMinutes(list, minutesById) {
  let total = 0;
  for (const s of list) {
    const m = minutesById[s.id];
    if (!Number.isInteger(m) || m <= 0) return null;
    total += m * s.qty;
  }
  return total;
}

// ---------------------------------------------------------------- horaires libres
const STATES_HOLDING = new Set(["pending", "confirmed"]);
// La demande retient-elle encore son horaire ? (une demande en attente dont l'heure limite est passée, non)
export const holds = (b, nowMs) => STATES_HOLDING.has(b.status) && !(b.status === "pending" && b.deadline !== undefined && b.deadline !== null && b.deadline <= nowMs);

// Nombre maximal de demandes en même temps sur [start, end[ (bookings : [{ start, end }] du même créneau, même jour)
function peak(bookings, start, end) {
  const points = [start, ...bookings.filter((b) => b.start > start && b.start < end).map((b) => b.start)];
  let max = 0;
  for (const p of points) max = Math.max(max, bookings.filter((b) => b.start <= p && p < b.end).length);
  return max;
}
const within = (ranges, a, b) => ranges.some(([x, y]) => a >= x && b <= y);

// Les offres d'un créneau pour un jour : [{ start, end, slotId, mode, until }] (until : fin de la fenêtre d'arrivée d'un dépôt)
function slotOffers(slot, iso, ranges, { minutes, stepMin, earliest, bookings }) {
  const mine = bookings.filter((b) => b.slotId === slot.id && b.day === iso);
  const len = slot.end - slot.start;
  if (minutes > len) return [];
  if (slot.mode === "drop") {
    const until = Math.min(slot.start + 60, slot.end);
    if (parisInstant(iso, slot.start) < earliest) return [];
    if (!ranges.some(([x, y]) => slot.start >= x && slot.start < y)) return []; // l'arrivée tombe pendant une plage d'ouverture
    return mine.length < slot.capacity ? [{ start: slot.start, end: slot.end, slotId: slot.id, mode: "drop", until }] : [];
  }
  const out = [];
  for (let t = slot.start; t + minutes <= slot.end; t += stepMin) {
    if (!within(ranges, t, t + minutes)) continue;
    if (parisInstant(iso, t) < earliest) continue;
    if (peak(mine, t, t + minutes) >= slot.capacity) continue;
    out.push({ start: t, end: t + minutes, slotId: slot.id, mode: "hour" });
  }
  return out;
}

// Horaires libres, jour par jour : [{ day, times: [{ start, end, slotId, mode, until? }] }] (jours sans horaire omis).
//  - ctx : { hours, closures, holidays } ; settings : { minDelayH, horizonDays, stepMin }
//  - slots : [{ id, days: ["mo", …], start, end, mode, capacity, services: [ids] }] (minutes depuis minuit)
//  - need : { services: [{ id, qty }], minutes } ; bookings : [{ slotId, day, start, end, status, deadline }] (deadline en ms)
//  - maxDays : ne pas regarder au-delà (14 pour l'étiquette du comparateur) ; first : s'arrêter au premier horaire trouvé
export function freeTimes({ nowMs, ctx, settings, slots, need, bookings = [], maxDays = Infinity, first = false }) {
  const earliest = earliestStart(nowMs, ctx, settings.minDelayH);
  const held = bookings.filter((b) => holds(b, nowMs));
  const ids = need.services.map((s) => s.id);
  const fitting = slots.filter((s) => ids.every((id) => s.services.includes(id)));
  const out = [];
  if (!fitting.length || !Number.isInteger(need.minutes) || need.minutes <= 0) return out;
  const today = parisParts(nowMs).iso;
  const days = Math.min(settings.horizonDays, maxDays);
  for (let i = 0; i < days; i++) {
    const iso = addDays(today, i);
    if (!isOpenDay(iso, ctx)) continue;
    const ranges = openRanges(iso, ctx.hours);
    const wd = weekday(iso);
    const seen = new Map();
    for (const slot of fitting) {
      if (!slot.days.includes(wd)) continue;
      for (const o of slotOffers(slot, iso, ranges, { minutes: need.minutes, stepMin: settings.stepMin, earliest, bookings: held })) {
        const key = `${o.mode}:${o.start}`;
        if (!seen.has(key)) seen.set(key, o); // deux créneaux qui proposent la même heure n'en font qu'une : le premier qui a de la place
      }
    }
    if (!seen.size) continue;
    out.push({ day: iso, times: [...seen.values()].sort((a, b) => a.start - b.start || (a.mode < b.mode ? -1 : 1)) });
    if (first) break;
  }
  return out;
}
// L'horaire choisi est-il encore libre ? Renvoie l'offre (avec le créneau qui la prend) ou null.
export function pickOffer(args, { day, start, mode }) {
  const found = freeTimes(args).find((d) => d.day === day);
  return (found && found.times.find((t) => t.start === start && (!mode || t.mode === mode))) || null;
}

// ---------------------------------------------------------------- ce que règle le garage
export const MIN_DELAYS_H = [0, 2, 4, 24, 48];
export const HORIZONS_DAYS = [7, 14, 21, 28];
export const STEPS_MIN = [15, 30, 60];
export const DEFAULT_SETTINGS = { minDelayH: 24, horizonDays: 28, stepMin: 30, holidays: true };
export const MAX_SLOTS = 20;
export const MAX_CAPACITY = 9;
export const SLOT_MIN_MINUTES = 30;
export const MAX_CLOSURES = 30;
export const CLOSURE_MAX_DAYS = 90;
const clean = (v) => String(v ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();

// { enabled?, minDelayH?, horizonDays?, stepMin?, holidays? } → { value } (champs présents seulement) ou { error }
export function parseSettings(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu." };
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "enabled" || k === "holidays") {
      if (typeof v !== "boolean") return { error: `${k} : true ou false.` };
      out[k] = v;
    } else if (k === "minDelayH") {
      if (!MIN_DELAYS_H.includes(v)) return { error: "Délai minimum : aucun, 2 h, 4 h, 24 h ou 48 h." };
      out[k] = v;
    } else if (k === "horizonDays") {
      if (!HORIZONS_DAYS.includes(v)) return { error: "Horizon : 1, 2, 3 ou 4 semaines." };
      out[k] = v;
    } else if (k === "stepMin") {
      if (!STEPS_MIN.includes(v)) return { error: "Horaires proposés : toutes les 15, 30 ou 60 minutes." };
      out[k] = v;
    } else return { error: `Réglage inconnu : ${String(k).slice(0, 20)}.` };
  }
  if (!Object.keys(out).length) return { error: "Rien à enregistrer." };
  return { value: out };
}

// Un créneau saisi par le garage → { value: { name, days, start, end, mode, capacity, services } } ou { error, field }.
//  - hours : horaires d'ouverture (obligatoires) ; offered : { serviceId: minutes } des prestations faites avec un temps moyen
export function parseSlot(b, { hours, offered }) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "slot" };
  if (!hours || !Object.keys(hours).length) return { error: "Renseignez d'abord vos horaires d'ouverture (Mon garage).", field: "hours" };
  const name = clean(b.name) || "Créneau";
  if ([...name].length > 40) return { error: "Nom du créneau : 40 caractères au plus.", field: "name" };
  if (!Array.isArray(b.days) || !b.days.length || !b.days.every((d) => DAY_KEYS.includes(d))) return { error: "Choisissez au moins un jour.", field: "days" };
  const days = DAY_KEYS.filter((d) => b.days.includes(d));
  const start = minOf(b.start), end = minOf(b.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start % MINUTES_STEP || end % MINUTES_STEP) return { error: "Horaires au quart d'heure (08:00, 08:15…).", field: "start" };
  if (end - start < SLOT_MIN_MINUTES) return { error: `Le créneau dure ${SLOT_MIN_MINUTES} minutes au moins.`, field: "end" };
  for (const d of days) {
    const r = (hours[d] || []).map(([a, z]) => [minOf(a), minOf(z)]);
    const label = DAYS.find((x) => x[0] === d)[1].toLowerCase();
    if (!r.length) return { error: `Le ${label}, le garage est fermé (Mon garage › Horaires).`, field: "days" };
    if (start < r[0][0] || end > r[r.length - 1][1]) return { error: `Le ${label}, le créneau dépasse vos horaires d'ouverture (${hm(r[0][0])}–${hm(r[r.length - 1][1])}).`, field: "start" };
  }
  const mode = b.mode === undefined ? "hour" : b.mode;
  if (mode !== "hour" && mode !== "drop") return { error: "L'automobiliste vient à une heure précise (hour) ou dépose sa voiture (drop).", field: "mode" };
  const capacity = b.capacity === undefined ? 1 : b.capacity;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) return { error: `Voitures en même temps : de 1 à ${MAX_CAPACITY}.`, field: "capacity" };
  if (!Array.isArray(b.services) || !b.services.length) return { error: "Choisissez au moins une prestation.", field: "services" };
  const services = [];
  for (const id of b.services) {
    const s = SERVICE_BY_ID.get(id);
    if (!s) return { error: "Prestation inconnue.", field: "services" };
    const m = offered[id];
    if (!Number.isInteger(m)) return { error: `${s.label} : indiquez d'abord que vous la faites et son temps moyen (Mon garage).`, field: "services" };
    if (m > end - start) return { error: `${s.label} dure plus longtemps que le créneau.`, field: "services" };
    if (!services.includes(id)) services.push(id);
  }
  return { value: { name, days, start, end, mode, capacity, services: PRO_SERVICES.map((s) => s.id).filter((id) => services.includes(id)) } };
}

// Une fermeture { first, last, label? } → { value } ou { error }. Pas dans le passé, 90 jours au plus, dans l'année qui vient.
export function parseClosure(b, todayIso) {
  if (!b || typeof b !== "object") return { error: "Objet attendu." };
  const first = b.first, last = b.last === undefined || b.last === "" ? b.first : b.last;
  if (!isIsoDay(first) || !isIsoDay(last)) return { error: "Dates : AAAA-MM-JJ." };
  if (last < first) return { error: "La fin précède le début." };
  if (last < todayIso) return { error: "Cette fermeture est passée." };
  if (first > addDays(todayIso, 366)) return { error: "Fermeture dans l'année qui vient seulement." };
  if ((dayDate(last) - dayDate(first)) / DAY_MS + 1 > CLOSURE_MAX_DAYS) return { error: `Une fermeture dure ${CLOSURE_MAX_DAYS} jours au plus.` };
  const label = clean(b.label);
  if ([...label].length > 60) return { error: "Libellé : 60 caractères au plus." };
  return { value: { first, last, label } };
}

// ---------------------------------------------------------------- motifs
export const DECLINE_REASONS = [
  ["full", "Pas de place à cet horaire"],
  ["service", "Prestation pas faite en ce moment"],
  ["parts", "Pièces indisponibles"],
  ["other", "Autre raison"],
];
export const GARAGE_CANCEL_REASONS = [
  ["workshop", "Imprévu à l'atelier"],
  ["parts", "Pièces indisponibles"],
  ["closed", "Fermeture exceptionnelle"],
  ["other", "Autre raison"],
];
export const CLIENT_CANCEL_REASONS = [
  ["unable", "Empêchement"],
  ["other_garage", "J'ai trouvé un autre garage"],
  ["no_need", "Je n'ai plus besoin de cette prestation"],
  ["other", "Autre raison"],
];
export const reasonText = (list, code) => (list.find((r) => r[0] === code) || [0, ""])[1];

// ---------------------------------------------------------------- fichier d'agenda (iCalendar, RFC 5545)
const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// Lignes de 75 octets au plus, suite précédée d'une espace (sans couper un caractère UTF-8)
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
// events : [{ uid, start, end (ms), summary, location, description, cancelled? }] → texte du fichier .ics
export function icsCalendar(events, nowMs = Date.now()) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Pixcar//Rendez-vous//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEsc(e.uid)}`,
      `DTSTAMP:${icsTime(nowMs)}`,
      `DTSTART:${icsTime(e.start)}`,
      `DTEND:${icsTime(e.end)}`,
      `SUMMARY:${icsEsc(e.summary)}`,
      ...(e.location ? [`LOCATION:${icsEsc(e.location)}`] : []),
      ...(e.description ? [`DESCRIPTION:${icsEsc(e.description)}`] : []),
      `STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
