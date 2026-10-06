// Fiches complétées par Mapbox : téléphone, horaires et site web d'un garage quand OpenStreetMap ne les donne pas.
//
// À l'ouverture d'une fiche, une seule requête « Search Box » (catégorie « auto_repair », la réparation automobile) est envoyée à Mapbox pour une
// petite zone autour du garage ; le résultat est rapproché du garage par la position ET le nom ; seuls les champs manquants sont remplis, jamais
// ceux qu'OpenStreetMap a donnés. Rien n'est écrit sur le disque ni dans la base : les réponses de Mapbox ne se conservent que le temps de la visite.
//
// Garde-fous de coût (chaque requête est facturable chez Mapbox) : une requête par garage et par visite au plus, aucune si la fiche est déjà complète,
// plafond par visite (cap), arrêt net sur un jeton refusé (401, 403), pause après deux échecs de suite.
// Un mauvais rapprochement vaut pire qu'aucun : un numéro de téléphone qui n'est pas celui du garage fait perdre du temps à un client. Le nom doit
// donc concorder (sauf pour un garage sans nom, seul à moins de 40 m).
import { phoneParse } from "./phone.js";

const SEARCH = "https://api.mapbox.com/search/searchbox/v1/category/";
export const CATEGORY = "auto_repair"; // seule catégorie de réparation automobile de Mapbox (pneus, carrosserie et contrôle technique y figurent aussi)
export const NEAR_M = 150; // rayon de la zone interrogée autour du garage
export const SAME_SPOT_M = 40; // en deçà : le nom peut manquer, pas ailleurs
export const CAP = 40; // requêtes par visite
const PAUSE_MS = 60_000;

// Annuaires et agrégateurs : un « site » qui n'est pas celui du garage (deux sur vingt-deux à Cazères : frmap.org). Le garage garde alors « Non renseigné ».
const DENY_SITES = ["frmap.org", "pagesjaunes.fr", "mappy.com", "118712.fr", "118218.fr", "cylex.fr", "hoodspot.fr", "societe.com", "pappers.fr", "infogreffe.fr", "yelp.com", "yelp.fr", "tripadvisor.com", "tripadvisor.fr", "foursquare.com", "mapquest.com", "waze.com"];
const TRACKING = /^(utm_|y_source$|fbclid$|gclid$|ref$)/i;

// ---------------------------------------------------------------------------------------------------------------------------------- requête
// Zone carrée de ±radiusM autour du point (Search Box API : « bbox » = ouest,sud,est,nord ; « proximity » = lon,lat). La bbox restreint, « proximity » seule
// ne fait que classer : à Cazères, une requête sans bbox ramène des garages à 215 km.
export function searchUrl({ token, lat, lon, radiusM = NEAR_M, limit = 10 }) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(6)).join(",");
  const q = new URLSearchParams({ access_token: token, language: "fr", limit: String(limit), bbox, proximity: `${lon.toFixed(6)},${lat.toFixed(6)}` });
  return `${SEARCH}${CATEGORY}?${q}`;
}

// Réponse de Mapbox → lieux { id, name, lat, lon, phone, web, periods }. Tout ce qui n'a pas la forme attendue est ignoré, jamais deviné.
export function parsePlaces(json) {
  const out = [];
  for (const f of json && Array.isArray(json.features) ? json.features : []) {
    const p = (f && f.properties) || {};
    const c = (f && f.geometry && f.geometry.coordinates) || [];
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const m = p.metadata || {};
    out.push({
      id: String(p.mapbox_id || ""),
      name: String(p.name || ""),
      lat,
      lon,
      phone: typeof m.phone === "string" ? m.phone : "",
      web: typeof m.website === "string" ? m.website : "",
      periods: m.open_hours && Array.isArray(m.open_hours.periods) ? m.open_hours.periods : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------- rapprochement
const rad = (d) => (d * Math.PI) / 180;
export function meters(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Mots qui ne distinguent pas un garage d'un autre : seuls deux « Carrosserie … » n'en font pas le même garage.
const GENERIC = new Set(["garage", "garages", "auto", "autos", "automobile", "automobiles", "sarl", "eurl", "sas", "sasu", "ets", "centre", "station", "service", "services", "reparation", "mecanique", "atelier", "societe", "entreprise", "carrosserie", "carosserie", "pneu", "pneus", "tires", "controle", "technique", "peinture", "depannage", "vitrage", "pieces", "accessoires", "multimarque", "multimarques", "express", "les", "des", "du", "de", "la", "le", "et", "and", "pro"]);
const tokens = (s) => new Set(fold(s).replace(/['’`-]/g, " ").split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
const compact = (s) => fold(s).replace(/[^a-z0-9]+/g, "");
// Même nom : un mot distinctif en commun (« Solsona » / « Carosserie Solsona »), ou un nom contenu dans l'autre une fois espaces et ponctuation retirés
// (« L'ATELIER AUTO-MOBILE » / « L’Atelier automobile »).
export function sameName(a, b) {
  const B = tokens(b);
  for (const t of tokens(a)) if (B.has(t)) return true;
  const ca = compact(a);
  const cb = compact(b);
  return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
}
// Nom renseigné ? (OpenStreetMap n'a pas toujours de nom : la page écrit « Garage (nom non renseigné) » ou « Spécialiste pneus (sans nom) »)
export const hasRealName = (name) => !!name && !/^(Garage \(nom|Spécialiste pneus \(sans)/.test(name);

// Le lieu de Mapbox qui correspond au garage { name, lat, lon }, ou null. À moins de 40 m : même nom, ou garage sans nom et seul lieu à cet endroit ;
// de 40 à 150 m : même nom obligatoire. Plusieurs candidats : le plus proche.
export function pickPlace(garage, places) {
  const near = (places || []).map((p) => ({ p, d: meters(garage, p) })).filter((x) => x.d <= NEAR_M);
  const spot = near.filter((x) => x.d <= SAME_SPOT_M);
  const named = hasRealName(garage.name);
  let best = null;
  for (const x of near) {
    const ok = named ? sameName(garage.name, x.p.name) : x.d <= SAME_SPOT_M && spot.length === 1;
    if (ok && (!best || x.d < best.d)) best = x;
  }
  return best && best.p;
}

// ---------------------------------------------------------------------------------------------------------------------------------- horaires
// Mapbox : open_hours.periods = [{ open: { day, time: "0900" }, close: { day, time: "1730" } }…], day 0 = dimanche … 6 = samedi (un lundi-vendredi
// 9 h-17 h 30 et un samedi 9 h-12 h donnent les jours 1 à 5 puis 6). Le site affiche la syntaxe d'OpenStreetMap (« Mo-Fr 09:00-17:30; Sa 09:00-12:00 »), que
// sa mise en forme française lit déjà : on écrit donc la même.
const OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const TIME = /^(?:[01]\d|2[0-3])[0-5]\d$|^2400$/;
const hhmm = (t) => (TIME.test(String(t)) ? `${String(t).slice(0, 2)}:${String(t).slice(2)}` : "");
const dayOf = (d) => (Number.isInteger(d) && d >= 0 && d <= 6 ? (d + 6) % 7 : -1); // 0 (dimanche) → 6, 1 (lundi) → 0
export function hoursFromPeriods(periods) {
  const days = Array.from({ length: 7 }, () => []);
  for (const p of Array.isArray(periods) ? periods : []) {
    const o = p && p.open;
    const c = p && p.close;
    if (!o || !c) continue; // sans heure de fermeture, on ne devine pas
    const day = dayOf(o.day);
    const from = hhmm(o.time);
    const to = hhmm(c.time);
    if (day < 0 || !from || !to) continue;
    const overnight = dayOf(c.day) !== day;
    if (overnight ? dayOf(c.day) !== (day + 1) % 7 : to <= from) continue; // fermeture un autre jour que le lendemain, ou avant l'ouverture : donnée incohérente
    const range = `${from}-${to}`;
    if (!days[day].includes(range)) days[day].push(range);
  }
  const labels = days.map((r) => r.sort().join(","));
  if (labels.every((l) => l === "00:00-24:00")) return "24/7";
  const out = [];
  const done = new Set();
  for (let i = 0; i < 7; i++) {
    if (!labels[i] || done.has(i)) continue;
    const same = [];
    for (let j = i; j < 7; j++) if (labels[j] === labels[i]) (same.push(j), done.add(j));
    // jours consécutifs : « Mo-Fr » à partir de trois, « Mo,Tu » sinon
    const parts = [];
    for (let k = 0; k < same.length; ) {
      let e = k;
      while (e + 1 < same.length && same[e + 1] === same[e] + 1) e++;
      if (e - k >= 2) parts.push(`${OSM_DAYS[same[k]]}-${OSM_DAYS[same[e]]}`);
      else for (let m = k; m <= e; m++) parts.push(OSM_DAYS[same[m]]);
      k = e + 1;
    }
    out.push(`${parts.join(",")} ${labels[i]}`);
  }
  return out.join("; ");
}

// ---------------------------------------------------------------------------------------------------------------------------------- champs
// Adresse web présentable : http(s) seulement, hors annuaires, sans paramètres de suivi ; sinon "".
export function cleanSite(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (DENY_SITES.some((d) => host === d || host.endsWith("." + d))) return "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.href;
}
// Ce que le garage a déjà : { phone, hours, web } (booléens). Les champs absents sont ceux qu'on cherche.
export const haveOf = (g) => ({ phone: phoneParse(g && g.phone).length > 0, hours: !!(g && g.hours), web: !!(g && g.web) });
export const missingOf = (g) => {
  const h = haveOf(g);
  return !(h.phone && h.hours && h.web);
};
// Champs à ajouter au garage : seulement ceux qui lui manquent et que le lieu donne sous une forme sûre.
export function fieldsFromPlace(place, have) {
  const out = {};
  if (!place) return out;
  if (!have.phone && phoneParse(place.phone).length) out.phone = place.phone;
  if (!have.hours) {
    const h = hoursFromPeriods(place.periods);
    if (h) out.hours = h;
  }
  if (!have.web) {
    const w = cleanSite(place.web);
    if (w) out.web = w;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------- l'interrogation
// { lookup(garage) } : renvoie { fields, place } (fields = {} quand Mapbox n'a rien de sûr à ajouter) ou null quand la requête n'a pas pu se faire
// (plafond atteint, jeton refusé, pause après des échecs, réseau). Une réponse est gardée en mémoire pour la visite : rouvrir une fiche, ou ouvrir deux
// garages voisins, ne refait pas la requête.
export function createEnricher({ token, fetchImpl = (...a) => fetch(...a), cap = CAP, now = Date.now, timeoutMs = 6000 } = {}) {
  const memo = new Map(); // « lat,lon » → Promise<lieux | null>
  const state = { requests: 0, failures: 0, until: 0, refused: false };
  const key = (g) => `${g.lat.toFixed(5)},${g.lon.toFixed(5)}`;
  async function places(g) {
    const k = key(g);
    if (memo.has(k)) return memo.get(k);
    if (state.refused || state.requests >= cap || now() < state.until) return null;
    state.requests++;
    const p = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(searchUrl({ token, lat: g.lat, lon: g.lon }), { signal: ctl.signal });
        if (res.status === 401 || res.status === 403) {
          state.refused = true; // jeton refusé ou restreint à une autre adresse : inutile d'insister
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const list = parsePlaces(await res.json());
        state.failures = 0;
        return list;
      } catch {
        if (++state.failures >= 2) (state.until = now() + PAUSE_MS, (state.failures = 0));
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    memo.set(k, p);
    const list = await p;
    if (list === null) memo.delete(k); // un échec n'est jamais mémorisé : la prochaine ouverture peut réessayer
    return list;
  }
  return {
    get requests() {
      return state.requests;
    },
    get refused() {
      return state.refused;
    },
    async lookup(g) {
      if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return null;
      const list = await places(g);
      if (list === null) return null;
      const place = pickPlace(g, list);
      return { fields: fieldsFromPlace(place, haveOf(g)), place };
    },
  };
}
