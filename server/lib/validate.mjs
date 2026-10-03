// Validation d'une déclaration de réparation. Ne fait confiance à rien de ce que le navigateur envoie.
import { COMMENT_MAX, DATE_MIN, GARAGE_ID_RE, MODEL_MAX, MODEL_MIN, PLATE_RE, PRICE_MAX, PRICE_MIN, YEAR_MIN } from "../../src/js/shared/rules.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32,128}$/i;
const CHAIN_RE = /^[a-z0-9_-]{0,40}$/;
// caractères de contrôle (sauf retour à la ligne dans le commentaire) et séparateurs de ligne Unicode
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g;

export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
export const isToken = (v) => typeof v === "string" && TOKEN_RE.test(v);

const text = (v) => (typeof v === "string" ? v.replace(CONTROL, "").replace(/[ \t]+/g, " ").trim() : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param body    JSON reçu
 * @param opts    { services: Set<string>, today: "YYYY-MM-DD" (date du serveur) }
 * @returns {{ value } | { fields }}  fields : { chemin: message }
 */
export function parseRepair(body, { services, today }) {
  const fields = {};
  const bad = (k, msg) => void (fields[k] = fields[k] || msg);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields: { body: "objet JSON attendu" } };

  const id = body.id;
  if (!isUuid(id)) bad("id", "identifiant (UUID v4) attendu");
  const token = body.deleteToken;
  if (!isToken(token)) bad("deleteToken", "jeton de 32 à 128 caractères hexadécimaux attendu");

  const g = body.garage && typeof body.garage === "object" ? body.garage : {};
  const garage = {
    id: text(g.id),
    name: text(g.name),
    addr: text(g.addr),
    lat: g.lat == null ? null : num(g.lat),
    lon: g.lon == null ? null : num(g.lon),
    chainId: text(g.chainId),
  };
  if (!GARAGE_ID_RE.test(garage.id)) bad("garage.id", "identifiant de garage non reconnu");
  if (garage.name.length < 2 || garage.name.length > 120) bad("garage.name", "nom de 2 à 120 caractères");
  if (garage.addr.length > 200) bad("garage.addr", "adresse de 200 caractères au plus");
  if (!CHAIN_RE.test(garage.chainId)) bad("garage.chainId", "enseigne non reconnue");
  const hasPos = garage.lat != null || garage.lon != null;
  if (hasPos && (garage.lat == null || garage.lon == null || Math.abs(garage.lat) > 90 || Math.abs(garage.lon) > 180))
    bad("garage.lat", "coordonnées invalides");

  // Position utile pour retrouver la déclaration : celle du garage, sinon le point de recherche du visiteur.
  const a = body.area && typeof body.area === "object" ? body.area : {};
  const area = { lat: num(a.lat), lon: num(a.lon) };
  const pos = hasPos ? { lat: garage.lat, lon: garage.lon } : area;
  if (pos.lat == null || pos.lon == null || Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180)
    bad("area", "position du garage ou de la recherche requise");

  const serviceId = text(body.serviceId);
  if (!services.has(serviceId)) bad("serviceId", "prestation inconnue");

  const price = num(body.price);
  if (price == null || price < PRICE_MIN || price > PRICE_MAX) bad("price", `prix entre ${PRICE_MIN} et ${PRICE_MAX} €`);
  const priceCents = price == null ? 0 : Math.round(price * 100);

  const date = text(body.date);
  if (!isRealDate(date) || date < DATE_MIN) bad("date", "date de réparation invalide");
  else if (date > today) bad("date", "la date ne peut pas être dans le futur");

  const rating = body.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) bad("rating", "note entière de 1 à 5");

  const comment = typeof body.comment === "string" ? body.comment.replace(CONTROL, "").trim() : "";
  if (comment.length > COMMENT_MAX) bad("comment", `commentaire de ${COMMENT_MAX} caractères au plus`);

  const v = body.vehicle && typeof body.vehicle === "object" ? body.vehicle : {};
  const model = text(v.model);
  if (model.length < MODEL_MIN || model.length > MODEL_MAX) bad("vehicle.model", `modèle de ${MODEL_MIN} à ${MODEL_MAX} caractères`);
  const year = v.year;
  const thisYear = +today.slice(0, 4);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > thisYear) bad("vehicle.year", `année entre ${YEAR_MIN} et ${thisYear}`);
  else if (isRealDate(date) && year > +date.slice(0, 4)) bad("vehicle.year", "l'année du modèle ne peut pas suivre la date de la réparation");
  const plate = typeof v.plate === "string" ? v.plate.trim().toUpperCase() : "";
  if (!PLATE_RE.test(plate)) bad("vehicle.plate", "immatriculation au format AB-123-CD attendue");

  if (Object.keys(fields).length) return { fields };
  return {
    value: { id: id.toLowerCase(), deleteToken: token.toLowerCase(), garage, pos, serviceId, priceCents, date, rating, comment, model, year, plate },
  };
}
