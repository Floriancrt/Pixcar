// Prix annoncés par un garage vérifié (Espace Pro) : une seule définition, partagée par l'API (validation, ancienneté), la page pro (saisie,
// aperçu) et le comparateur (étiquette « Annoncé », fiche). Les prix annoncés ne se mélangent jamais aux prix payés.
import { SERVICES } from "./services.js";
import { PRICE_MAX, PRICE_MIN } from "./rules.js";

// Prestations qu'un garage peut annoncer : celles du comparateur, contrôle technique exclu (ses prix sont les prix officiels publiés).
export const PRO_SERVICES = SERVICES.filter((s) => s.kind !== "ct");
const SERVICE_IDS = new Set(PRO_SERVICES.map((s) => s.id));

export const PRICE_KINDS = [
  { id: "fixed", label: "Forfait" },
  { id: "from", label: "À partir de" },
  { id: "quote", label: "Sur devis" },
];
export const VEHICLES = [
  { id: "city", label: "Citadine" },
  { id: "compact", label: "Compacte" },
  { id: "sedan", label: "Berline" },
  { id: "suv", label: "SUV" },
  { id: "van", label: "Utilitaire" },
];
export const INCLUDES = [
  { id: "parts", label: "Pièces" },
  { id: "labour", label: "Main-d'œuvre" },
  { id: "extras", label: "Recyclage, produits annexes" },
];

export const STALE_MONTHS = 6; // un prix non confirmé depuis 6 mois est marqué « ancien » sur Pixcar
export const DUE_DAYS = 30; // et « à confirmer » dans le tableau de bord pendant les 30 jours qui précèdent
const DAY_MS = 864e5;

// Date (ms) à laquelle un prix confirmé à confirmedMs devient « ancien ».
export function staleAt(confirmedMs) {
  const d = new Date(confirmedMs);
  d.setUTCMonth(d.getUTCMonth() + STALE_MONTHS);
  return d.getTime();
}
// « ok » | « due » (à confirmer bientôt) | « stale » (ancien)
export function freshness(confirmedMs, nowMs) {
  const at = staleAt(confirmedMs);
  if (nowMs >= at) return "stale";
  return at - nowMs <= DUE_DAYS * DAY_MS ? "due" : "ok";
}

const pick = (list, allowed) => {
  if (!Array.isArray(list)) return null;
  const ids = new Set();
  for (const v of list) {
    if (typeof v !== "string" || !allowed.some((a) => a.id === v)) return null;
    ids.add(v);
  }
  return allowed.filter((a) => ids.has(a.id)).map((a) => a.id); // ordre canonique, sans doublon
};

// Corps d'une saisie { kind, price, vehicles, includes } pour la prestation serviceId → { value } ou { error, field }.
// Prix en euros TTC, deux décimales au plus ; pas de prix pour « sur devis ».
export function parseProPrice(serviceId, body) {
  if (!SERVICE_IDS.has(serviceId)) return { error: "Prestation inconnue.", field: "service" };
  const b = body && typeof body === "object" ? body : {};
  if (!PRICE_KINDS.some((k) => k.id === b.kind)) return { error: "Type : forfait, « à partir de » ou sur devis.", field: "kind" };
  let priceCents = null;
  if (b.kind !== "quote") {
    const p = typeof b.price === "number" ? b.price : NaN;
    const cents = Math.round(p * 100);
    if (!Number.isFinite(p) || p < PRICE_MIN || p > PRICE_MAX || Math.abs(cents - p * 100) > 1e-6)
      return { error: `Prix TTC entre ${PRICE_MIN} et ${PRICE_MAX.toLocaleString("fr-FR")} €, deux décimales au plus.`, field: "price" };
    priceCents = cents;
  } else if (b.price !== undefined && b.price !== null) return { error: "Pas de prix pour une prestation sur devis.", field: "price" };
  const vehicles = pick(b.vehicles === undefined ? [] : b.vehicles, VEHICLES);
  if (!vehicles) return { error: "Véhicules : citadine, compacte, berline, SUV, utilitaire.", field: "vehicles" };
  const includes = pick(b.includes === undefined ? [] : b.includes, INCLUDES);
  if (!includes) return { error: "Compris : pièces, main-d'œuvre, recyclage et produits annexes.", field: "includes" };
  return { value: { serviceId, kind: b.kind, priceCents, vehicles: vehicles.length === VEHICLES.length ? [] : vehicles, includes } };
}

// Affichage d'un prix annoncé : « 89 € », « dès 119 € », « sur devis » (centimes seulement s'il y en a).
export function announcedText(kind, price) {
  if (kind === "quote" || typeof price !== "number") return "sur devis";
  const euros = Number.isInteger(price) ? String(price) : price.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (kind === "from" ? "dès " : "") + euros + " €";
}
// « forfait, pièces et main-d'œuvre », « à partir de, main-d'œuvre », « sur devis »
export function announcedDetail(kind, includes) {
  const k = PRICE_KINDS.find((x) => x.id === kind);
  const inc = INCLUDES.filter((i) => (includes || []).includes(i.id)).map((i) => i.label.toLowerCase());
  const what = inc.length > 1 ? inc.slice(0, -1).join(", ") + " et " + inc[inc.length - 1] : inc[0] || "";
  return [k ? k.label.toLowerCase() : "", what].filter(Boolean).join(", ");
}
export const vehiclesText = (ids) => (!ids || !ids.length ? "tous véhicules" : VEHICLES.filter((v) => ids.includes(v.id)).map((v) => (v.id === "suv" ? v.label : v.label.toLowerCase())).join(", "));
export const serviceLabel = (id) => (PRO_SERVICES.find((s) => s.id === id) || { label: id }).label;
