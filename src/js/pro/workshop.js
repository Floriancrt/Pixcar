// Espace Pro : ce que le Planning (planning.js) et le tableau de bord (home.js) calculent de la même façon à partir de l'agenda
// (GET …/calendar/agenda) et des réglages du calendrier (GET …/calendar) : rendez-vous et blocs sous une même forme, ouverture du
// garage, absences, horaires et charge des mécaniciens et des postes (comme le moteur : heures d'ouverture ∩ horaires propres, moins
// les absences). Fonctions pures : l'agenda et les réglages sont passés en argument.
import { minOf, parisParts, timeLabel, weekday } from "../shared/rdv.js";
import { workState } from "../shared/work.js";

// textes : « 1 h 30 », « 45 min » ; « 0 h » pour rien ; pourcentage entier ; « 3 rendez-vous » ; « 8:00–9:30 » ; majuscule initiale
export const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : `${m} min`);
export const hrs = (m) => (m ? dur(Math.round(m)) : "0 h");
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
export const range = (a, b) => `${timeLabel(a)}–${timeLabel(b)}`;
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// positions et tailles posées par le CSSOM : la politique de sécurité de la page publiée (style-src 'self') refuse l'attribut style
export const css = (node, props) => {
  for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v);
  return node;
};
// intervalles de minutes [[a, b]] : réunion, intersection, différence, durée totale
export function merge(xs) {
  const out = [];
  for (const [a, b] of [...xs].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
export function inter(A, B) {
  const out = [];
  for (const [a, b] of A) for (const [c, d] of B) if (Math.min(b, d) > Math.max(a, c)) out.push([Math.max(a, c), Math.min(b, d)]);
  return merge(out);
}
export function minus(A, B) {
  let out = merge(A);
  for (const [c, d] of merge(B))
    out = out.flatMap(([a, b]) => (d <= a || c >= b ? [[a, b]] : [...(c > a ? [[a, c]] : []), ...(d < b ? [[d, b]] : [])]));
  return out;
}
export const total = (A) => merge(A).reduce((n, [a, b]) => n + b - a, 0);
// côte à côte quand des blocs se chevauchent : couloir de chaque bloc et nombre de couloirs de son groupe
export function lanes(segs) {
  segs.sort((x, y) => x.a - y.a || y.b - x.b);
  let group = [], end = -1;
  const close = () => {
    const n = Math.max(...group.map((s) => s.lane)) + 1;
    for (const s of group) s.lanes = n;
  };
  for (const s of segs) {
    if (group.length && s.a >= end) {
      close();
      group = [];
      end = -1;
    }
    const used = new Set(group.filter((g) => g.b > s.a).map((g) => g.lane));
    let l = 0;
    while (used.has(l)) l++;
    s.lane = l;
    group.push(s);
    end = Math.max(end, s.b);
  }
  if (group.length) close();
  return segs;
}

// horaires propres d'un mécanicien ou d'un poste ({ mo: [["08:00", "12:00"]] }) pour un jour donné
export const rangesOf = (hours, iso) => ((hours && hours[weekday(iso)]) || []).map(([a, b]) => [minOf(a), b === "24:00" ? 1440 : minOf(b)]);
// une affectation de l'API (instants) → jour et minutes de Paris
export function rowOf(r) {
  const a = parisParts(Date.parse(r.start)), b = parisParts(Date.parse(r.end));
  return { ...r, day: a.iso, a: a.min, b: b.iso === a.iso ? b.min : 1440 };
}

// rendez-vous et blocs sous une même forme (deadlines : demande à confirmer → heure limite, en ms). work : état de l'intervention
// (src/js/shared/work.js) pour un rendez-vous Pixcar ou hors Pixcar, null pour un créneau bloqué ; noShow : client absent ; channel :
// le canal d'origine (pixcar ; phone, walkin ou other pour un rendez-vous saisi par le garage, téléphone s'il n'a rien dit ; hold).
export function itemsOf(data, deadlines = new Map()) {
  const conf = new Map(data.conflicts.map((c) => [c.id, c.reasons]));
  const out = [];
  for (const a of data.appointments)
    out.push({
      id: a.id, type: "rdv", origin: "pixcar", channel: "pixcar", state: a.status === "pending" ? "pending" : "confirmed", conflict: conf.get(a.id) || null,
      day: a.when.day, start: minOf(a.when.start), end: minOf(a.when.end), title: a.client || "Client", services: a.services,
      plan: a.plan.map(rowOf), work: workState(a.work), workAt: (a.work && a.work.at) || null, noShow: !!(a.work && a.work.noShow), deadline: deadlines.get(a.id) || null, src: a,
    });
  for (const k of data.blocks) {
    const job = k.kind === "job";
    out.push({
      id: k.id, type: k.kind, origin: k.kind, channel: job ? CHANNELS.includes(k.channel) ? k.channel : "phone" : "hold", state: job ? "confirmed" : null, conflict: conf.get(k.id) || null,
      day: k.when.day, start: minOf(k.when.start), end: minOf(k.when.end), title: k.label || (job ? "Rendez-vous hors Pixcar" : "Créneau bloqué"),
      services: k.services, plan: k.plan.map(rowOf), work: job ? workState(k.work) : null, workAt: (k.work && k.work.at) || null, noShow: !!(k.work && k.work.noShow), deadline: null, src: k,
    });
  }
  return out;
}

// canaux d'un rendez-vous saisi par le garage (gestion d'atelier, docs/gestion-atelier.md)
export const CHANNELS = ["phone", "walkin", "other"];

// ouverture du garage un jour donné : [[a, b]] en minutes
export const openOn = (data, day) => (data.days.find((d) => d.day === day) || { open: [] }).open.map(([a, b]) => [minOf(a), b === "24:00" ? 1440 : minOf(b)]);
// absences et maintenances d'un mécanicien ou d'un poste, ce jour-là (de leur début à leur fin, d'un seul tenant)
export function awayOn(data, targetId, day) {
  const out = [];
  for (const u of data.unavail) {
    if (u.targetId !== targetId || day < u.first || day > u.last) continue;
    out.push({ a: day === u.first && u.from ? minOf(u.from) : 0, b: day === u.last && u.to ? minOf(u.to) : 1440, text: u.text, kind: u.kind });
  }
  return out;
}
// st : réponse de GET …/calendar (horaires propres des mécaniciens et des postes)
const hoursOf = (st, id) => ((st && [...st.staff, ...st.resources].find((x) => x.id === id)) || { hours: null }).hours;
export const hoursFor = (data, st, x, day) => (x.active ? inter(openOn(data, day), hoursOf(st, x.id) ? rangesOf(hoursOf(st, x.id), day) : openOn(data, day)) : []);
export const workOf = (data, st, x, day) => minus(hoursFor(data, st, x, day), awayOn(data, x.id, day).map((u) => [u.a, u.b]));
// affectations de ces rendez-vous et blocs pour une ressource, un jour ; un client absent ne compte plus
export const rowsOn = (list, target, id, day, role = null) =>
  list.filter((it) => !it.noShow).flatMap((it) => it.plan.filter((r) => r.target === target && r.id === id && r.day === day && (!role || r.role === role)).map((r) => [r.a, r.b]));
