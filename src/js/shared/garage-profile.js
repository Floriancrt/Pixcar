// « Mon garage » (Espace Pro) : ce qu'un garage vérifié déclare de lui-même (coordonnées, horaires) et le temps moyen de ses prestations.
// Une seule définition, partagée par l'API (validation), la page pro (saisie) et le comparateur (affichage). Voir docs/rendez-vous.md.
import { phoneParse } from "../modules/phone.js";

// Jours dans l'ordre de la semaine : clé enregistrée, libellé long, libellé court
export const DAYS = [
  ["mo", "Lundi", "lun."],
  ["tu", "Mardi", "mar."],
  ["we", "Mercredi", "mer."],
  ["th", "Jeudi", "jeu."],
  ["fr", "Vendredi", "ven."],
  ["sa", "Samedi", "sam."],
  ["su", "Dimanche", "dim."],
];
const DAY_KEYS = DAYS.map((d) => d[0]);
export const MAX_SLOTS = 2; // plages par jour (matin, après-midi)
export const MINUTES_MIN = 15;
export const MINUTES_MAX = 480;
export const MINUTES_STEP = 15;

const clean = (v) => String(v ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const minuteOf = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm) || (hhmm === "24:00" ? [0, "24", "00"] : null);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

// Horaires : { mo: [["08:00","12:00"], ["14:00","18:30"]], … } ; jour absent ou vide = fermé. → { value } (null : non déclarés) ou { error }
export function parseHours(h) {
  if (h === null || h === undefined || h === "") return { value: null };
  if (typeof h !== "object" || Array.isArray(h)) return { error: "Horaires : un objet par jour attendu." };
  for (const k of Object.keys(h)) if (!DAY_KEYS.includes(k)) return { error: `Horaires : jour inconnu (${String(k).slice(0, 10)}).` };
  const out = {};
  for (const [key, long] of DAYS) {
    const label = long.toLowerCase();
    const slots = h[key] === undefined || h[key] === null ? [] : h[key];
    if (!Array.isArray(slots) || slots.length > MAX_SLOTS) return { error: `Horaires du ${label} : ${MAX_SLOTS} plages au plus.` };
    let last = -1;
    const day = [];
    for (const s of slots) {
      if (!Array.isArray(s) || s.length !== 2) return { error: `Horaires du ${label} : une plage = une heure d'ouverture et une heure de fermeture.` };
      const [a, b] = s.map((x) => minuteOf(String(x)));
      if (!Number.isFinite(a) || !Number.isFinite(b) || a % MINUTES_STEP || b % MINUTES_STEP)
        return { error: `Horaires du ${label} : heures au quart d'heure (08:00, 08:15…).` };
      if (a >= b) return { error: `Horaires du ${label} : l'ouverture doit précéder la fermeture.` };
      if (a <= last) return { error: `Horaires du ${label} : plages dans l'ordre, sans chevauchement.` };
      last = b;
      day.push([String(s[0]), String(s[1])]);
    }
    if (day.length) out[key] = day;
  }
  return { value: out };
}

// « lun.–ven. 8:00–12:00, 14:00–18:30 · sam. 8:00–12:00 · dim. fermé » (jours qui se suivent et se ressemblent regroupés)
const hm = (t) => t.replace(/^0(\d)/, "$1");
export function hoursText(hours) {
  if (!hours || typeof hours !== "object") return "";
  const sig = DAYS.map(([k]) => (hours[k] || []).map((s) => `${hm(s[0])}–${hm(s[1])}`).join(", ") || "fermé");
  if (sig.every((s) => s === "fermé")) return "";
  const parts = [];
  for (let i = 0; i < 7; ) {
    let j = i;
    while (j + 1 < 7 && sig[j + 1] === sig[i]) j++;
    const days = i === j ? DAYS[i][2] : `${DAYS[i][2]}–${DAYS[j][2]}`;
    parts.push(`${days} ${sig[i]}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

// Site : vide, ou une adresse http(s) d'un vrai domaine (« garage-demo.fr » devient « https://garage-demo.fr/ »). → { value } ou { error }
export function parseWebsite(raw) {
  const s = clean(raw);
  if (!s) return { value: "" };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
  } catch {
    return { error: "Site : adresse invalide (ex. garage-martin.fr)." };
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname) || u.href.length > 200)
    return { error: "Site : adresse invalide (ex. garage-martin.fr)." };
  return { value: u.href };
}

// E-mail affiché aux clients : vide, ou une adresse plausible. → { value } ou { error }
export function parseEmail(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return { value: "" };
  if (s.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) || s.includes(".."))
    return { error: "E-mail : adresse invalide." };
  return { value: s };
}

// Téléphone : un seul numéro, français (« 05 61 00 00 01 ») ou international (« +262… »). → { value: "+33561000001" } ou { error }
export function parsePhone(raw) {
  const s = clean(raw);
  const list = phoneParse(s);
  if (list.length !== 1 || s.replace(/\D/g, "").length > 15) return { error: "Téléphone : un numéro, par exemple 05 61 00 00 01." };
  return { value: list[0].tel };
}
export const phoneText = (tel) => (phoneParse(tel)[0] || { text: "" }).text;

// Nom affiché : 2 à 120 caractères, au moins une lettre.
export function parseName(raw) {
  const s = clean(raw);
  if (s.length < 2 || s.length > 120 || !/\p{L}/u.test(s)) return { error: "Nom : 2 à 120 caractères." };
  return { value: s };
}

// Adresse : { street, pc, city } (code postal à 5 chiffres). → { value } ou { error }
export function parseAddr(a) {
  if (!a || typeof a !== "object") return { error: "Adresse : rue, code postal et ville." };
  const street = clean(a.street), pc = clean(a.pc).replace(/\s/g, ""), city = clean(a.city);
  if (street.length < 3 || street.length > 200 || !/\p{L}/u.test(street)) return { error: "Adresse : numéro et rue (3 à 200 caractères)." };
  if (!/^\d{5}$/.test(pc)) return { error: "Adresse : code postal à 5 chiffres." };
  if (city.length < 1 || city.length > 80 || !/\p{L}/u.test(city)) return { error: "Adresse : ville (80 caractères au plus)." };
  return { value: { street, pc, city } };
}
export const addrText = (a) => (a && a.street ? `${a.street}, ${a.pc} ${a.city}` : "");

// Temps moyen : vide (à saisir), ou de 15 min à 8 h par quart d'heure. → { value } ou { error }
export function parseMinutes(v) {
  if (v === null || v === undefined) return { value: null };
  if (!Number.isInteger(v) || v < MINUTES_MIN || v > MINUTES_MAX || v % MINUTES_STEP)
    return { error: `Temps moyen : de ${MINUTES_MIN} min à ${MINUTES_MAX / 60} h, par quart d'heure.` };
  return { value: v };
}
// 45 → « 45 min », 90 → « 1 h 30 », 240 → « 4 h »
export function minutesText(m) {
  if (!Number.isInteger(m)) return "";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h${r ? " " + String(r).padStart(2, "0") : ""}` : `${r} min`;
}
