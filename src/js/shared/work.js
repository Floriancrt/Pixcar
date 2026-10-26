// Lot 3c (docs/calendrier-avance.md, « Lot 3c ») : états d'une intervention et passages possibles ; raccourcis du tableau de bord de
// l'Espace Pro. Une seule définition, partagée par l'API (dernier mot) et la page Pro (menus d'actions). Fonctions pures.
import { addDays, dayLabel, isOpenDay, openRanges, parisParts, timeLabel } from "./rdv.js";

// label : ce que lit le garage ; client : ce que montre la page de suivi du client (vide : rien de plus que « Confirmé »)
export const WORK_STATES = [
  { id: "planned", label: "Prévue", client: "" },
  { id: "received", label: "Voiture reçue", client: "Voiture reçue" },
  { id: "in_progress", label: "En cours", client: "Travaux en cours" },
  { id: "waiting_parts", label: "En attente de pièces", client: "En attente de pièces" },
  { id: "suspended", label: "Suspendue", client: "En attente" },
  { id: "done", label: "Prête", client: "Prête" },
  { id: "returned", label: "Restituée", client: "Restituée" },
  { id: "no_show", label: "Client absent", client: "" },
];
const BY_ID = new Map(WORK_STATES.map((s) => [s.id, s]));
// voiture dans l'atelier (« Interventions en cours »)
export const WORK_LIVE = ["received", "in_progress", "waiting_parts", "suspended"];
// au-delà de 30 jours après le rendez-vous, l'état ne change plus
export const WORK_MAX_DAYS = 30;

// passages possibles : [état visé, libellé de l'action, retour en arrière (correction d'une erreur)]
const MOVES = {
  planned: [["received", "Voiture reçue"], ["no_show", "Client absent"]],
  received: [["in_progress", "Commencer les travaux"], ["done", "Voiture prête"], ["planned", "Annuler la réception", true]],
  in_progress: [["waiting_parts", "En attente de pièces"], ["suspended", "Suspendre"], ["done", "Voiture prête"]],
  waiting_parts: [["in_progress", "Reprendre les travaux"], ["done", "Voiture prête"]],
  suspended: [["in_progress", "Reprendre les travaux"], ["done", "Voiture prête"]],
  done: [["returned", "Voiture restituée"], ["in_progress", "Pas prête finalement", true]],
  returned: [["done", "Annuler la restitution", true]],
  no_show: [["planned", "Le client est finalement venu", true]],
};

export const workLabel = (id) => (BY_ID.get(id) || BY_ID.get("planned")).label;
export const clientWorkLabel = (id) => (BY_ID.get(id) || { client: "" }).client;
// état d'une intervention tel que le lit la page : « no_show » quand le client est noté absent
export const workState = (o) => (!o ? "planned" : o.noShow ? "no_show" : o.status || "planned");
// actions offertes depuis cet état : [{ to, label, back }]
export const workActions = (state) => (MOVES[state] || []).map(([to, label, back]) => ({ to, label, back: !!back }));

// Contrôle d'un passage : from (état actuel), to (visé), day (jour du rendez-vous), today (jour de Paris), started (l'heure de dépôt est
// passée). { error, code } quand il est refusé.
export function checkWork({ from, to, day, today, started }) {
  if (day > today) return { code: "too_early", error: "Pas avant le jour du rendez-vous." };
  if (day < addDays(today, -WORK_MAX_DAYS)) return { code: "too_late", error: `Plus de ${WORK_MAX_DAYS} jours après le rendez-vous : l'état ne change plus.` };
  if (!(MOVES[from] || []).some(([t]) => t === to)) return { code: "state", error: `${workLabel(from)} → ${workLabel(to)} : passage impossible. Rechargez la page : l'état a peut-être changé.` };
  if (to === "no_show" && !started) return { code: "too_early", error: "Client absent : seulement une fois l'heure de dépôt passée." };
  return {};
}

// corps de POST …/calendar/work/:id : { status, notify? }
export function parseWork(body) {
  const b = body && typeof body === "object" ? body : {};
  if (!BY_ID.has(b.status)) return { error: "État inconnu.", field: "status" };
  if (b.notify !== undefined && typeof b.notify !== "boolean") return { error: "notify : vrai ou faux.", field: "notify" };
  return { value: { status: b.status, notify: b.notify !== false } };
}

// Prochaines heures d'ouverture à partir de maintenant (e-mail « Votre voiture est prête ») : « aujourd'hui jusqu'à 18:00 »,
// « demain de 8:00 à 12:00 et de 14:00 à 18:00 », « mardi 21 octobre de 8:00 à 12:00 » ; vide si rien dans les 14 jours.
// ctx : { hours, closures, holidays } (comme le moteur des horaires).
export function nextOpening(ctx, nowMs) {
  const now = parisParts(nowMs);
  const span = ([a, b]) => `de ${timeLabel(a)} à ${timeLabel(b)}`;
  for (let d = 0; d < 14; d++) {
    const iso = addDays(now.iso, d);
    if (!isOpenDay(iso, ctx)) continue;
    const ranges = openRanges(iso, ctx.hours).filter(([, b]) => d > 0 || b > now.min);
    if (!ranges.length) continue;
    if (d === 0) {
      const [a, b] = ranges[0];
      const first = a <= now.min ? `jusqu'à ${timeLabel(b)}` : span(ranges[0]);
      return ["aujourd'hui " + first, ...ranges.slice(1).map(span)].join(" et ");
    }
    return `${d === 1 ? "demain" : dayLabel(iso)} ${ranges.map(span).join(" et ")}`;
  }
  return "";
}

// ---------------------------------------------------------------- raccourcis du tableau de bord
// rdv : demande les rendez-vous en ligne ; adv : demande le mode avancé (sinon le raccourci n'est pas proposé)
export const SHORTCUTS = [
  { id: "planning", label: "Gestion d'atelier", sub: "Voir et modifier vos rendez-vous", rdv: true },
  { id: "requests", label: "Demandes", sub: "Répondre aux demandes de rendez-vous", rdv: true },
  { id: "prices", label: "Prix annoncés", sub: "Mon garage › Prestations" },
  { id: "agenda", label: "Horaires et créneaux", sub: "Mon garage › Horaires", rdv: true },
  { id: "garage", label: "Mon garage", sub: "Horaires, prestations, fiche Pixcar" },
  { id: "team", label: "Équipe et postes", sub: "Mon garage › Ressources", adv: true },
  { id: "new", label: "Nouveau rendez-vous", sub: "Pris par téléphone ou au comptoir", rdv: true },
  { id: "closure", label: "Fermer une journée", sub: "Congés, fermeture exceptionnelle", rdv: true },
  { id: "site", label: "Voir Pixcar", sub: "Le comparateur, comme vos clients" },
];
export const DEFAULT_SHORTCUTS = ["planning", "prices", "agenda"];

// ---------------------------------------------------------------- Gestion d'atelier (docs/gestion-atelier.md 2.1)
// Affichage de Gestion d'atelier choisi par un compte (préférence) : simple ou advanced ; null tant que rien n'a été choisi.
export const VIEWS = ["simple", "advanced"];
// Modules de l'affichage avancé, pour tout le garage. Couper un module masque son espace ; ses données restent. Les analyses (stats)
// attendent les temps réellement passés : jamais actives pour l'instant.
export const MODULE_KEYS = ["staff", "equip", "track", "load"];
export const DEFAULT_MODULES = { staff: true, equip: true, track: true, load: true };
export const modulesOf = (stored) => {
  const out = { ...DEFAULT_MODULES };
  if (stored && typeof stored === "object") for (const k of MODULE_KEYS) if (typeof stored[k] === "boolean") out[k] = stored[k];
  return { ...out, stats: false };
};
// Ce qu'un interrupteur peut faire : mécaniciens et équipements servent au calcul par ressources (on ne les coupe qu'après être revenu
// au calcul par créneaux) ; la charge demande l'un des deux. → { locked, why }
export function moduleRule(key, on, m, { byResources = false } = {}) {
  if (key === "stats") return { locked: true, why: "Prochainement : il faut d'abord noter les heures réelles de début et de fin des travaux." };
  if ((key === "staff" || key === "equip") && on && byResources) return { locked: true, why: "Utilisé par le calcul de vos disponibilités en ligne : revenez d'abord au calcul par créneaux pour le couper." };
  if (key === "load" && !on && !m.staff && !m.equip) return { locked: true, why: "Demande le module Mécaniciens ou Ponts et équipements." };
  return { locked: false, why: "" };
}
// modules de PUT …/calendar/settings : { staff?, equip?, track?, load?, stats? } complétés par current (ceux du garage)
// → { value } (sans stats) ou { error, field, code? } (code « in_use » : refus lié au calcul par ressources)
export function parseModules(body, { current = null, byResources = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "modules : un objet.", field: "modules" };
  for (const [k, v] of Object.entries(body)) {
    if (!MODULE_KEYS.includes(k) && k !== "stats") return { error: `Module inconnu : ${String(k).slice(0, 20)}.`, field: "modules" };
    if (typeof v !== "boolean") return { error: "Un module est actif (true) ou non (false).", field: "modules" };
  }
  if (body.stats === true) return { error: "Analyses : prochainement.", field: "modules" };
  const was = modulesOf(current);
  const m = { ...was };
  for (const k of MODULE_KEYS) if (body[k] !== undefined) m[k] = body[k];
  if (byResources && (!m.staff || !m.equip)) return { error: "Mécaniciens et Ponts et équipements servent au calcul de vos disponibilités en ligne : revenez d'abord au calcul par créneaux pour les couper.", field: "modules", code: "in_use" };
  if (m.load && !m.staff && !m.equip) return { error: "Charge et capacité demande le module Mécaniciens ou Ponts et équipements.", field: "modules" };
  return { value: Object.fromEntries(MODULE_KEYS.map((k) => [k, m[k]])) };
}
export const MAX_SHORTCUTS = 6;
const SHORTCUT_IDS = new Set(SHORTCUTS.map((s) => s.id));

// corps de PUT /v1/pro/garages/:id/prefs : { shortcuts?: [identifiants], view?: "simple" | "advanced" | null } (l'un des deux au moins ;
// celui qui manque ne change pas)
export function parsePrefs(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Objet attendu.", field: "shortcuts" };
  const out = {};
  if (body.shortcuts !== undefined) {
    const list = body.shortcuts;
    if (!Array.isArray(list)) return { error: "shortcuts : une liste.", field: "shortcuts" };
    if (list.length > MAX_SHORTCUTS) return { error: `${MAX_SHORTCUTS} raccourcis au plus.`, field: "shortcuts" };
    if (!list.every((id) => SHORTCUT_IDS.has(id))) return { error: "Raccourci inconnu.", field: "shortcuts" };
    if (new Set(list).size !== list.length) return { error: "Un raccourci en double.", field: "shortcuts" };
    out.shortcuts = list;
  }
  if (body.view !== undefined) {
    if (body.view !== null && !VIEWS.includes(body.view)) return { error: "Affichage : simple ou avancé.", field: "view" };
    out.view = body.view;
  }
  if (!Object.keys(out).length) return { error: "shortcuts : une liste.", field: "shortcuts" };
  return { value: out };
}
