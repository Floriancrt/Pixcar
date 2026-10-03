// Interrogation d'OpenStreetMap (API Overpass) : requête, serveurs, balises conservées.
// Partagé par la page et par l'API (route /v1/overpass : proxy avec cache) : une seule définition.

export const OVERPASS_MIRRORS = [
  { url: "https://overpass-api.de/api/interpreter", name: "overpass-api.de" },
  { url: "https://overpass.openstreetmap.fr/api/interpreter", name: "OpenStreetMap France", metro: true },
];

// Le serveur français ne couvre que la France métropolitaine.
export const inMetroFrance = (lat, lon) => lat > 41 && lat < 51.5 && lon > -5.5 && lon < 10;

// Balises gardées de chaque élément (la réponse brute d'Overpass en contient beaucoup d'autres).
export const KEEP_TAG =
  /^(name|brand|brand:fr|brand:wikidata|operator|operator:wikidata|shop|craft|service|phone|contact:phone|phone:mobile|contact:mobile|mobile|website|contact:website|opening_hours|addr:housenumber|addr:street|addr:postcode|addr:city|addr:full|addr:place|addr:suburb|contact:housenumber|contact:street|contact:postcode|contact:city|service:vehicle:.+)$/;

// Rayons de recherche proposés par la page, en mètres.
export const RADII_M = [3000, 5000, 10000, 20000, 30000, 50000];

export function overpassQuery(lat, lon, radiusM) {
  const around = `(around:${radiusM},${lat},${lon})`;
  return `[out:json][timeout:25][maxsize:67108864];nwr["shop"="car"]${around}->.c;(nwr["shop"="car_repair"]${around};nwr["shop"="tyres"]${around};nwr["shop"="car_parts"]${around};nwr["craft"="car_repair"]${around};nwr.c["service"~"repair"];nwr.c[~"^service:vehicle:"~"^yes$"];nwr.c[~"^(name|brand|operator)$"~"norauto|feu.?vert|speedy|midas|roady|euromaster|point s|first.?stop|vulco|profil|siligom|euro.?tyre|best.?drive|driver.?cent|leclerc|carter|euro.?repar|motrio|bosch|top.?garage|pr.cisium|delko|auto.?primo|avatacar",i];);out center tags;`;
}

// Relit (rayon, latitude, longitude) d'une requête reçue et ne la reconnaît que si elle est EXACTEMENT celle que la page
// produit : le proxy n'exécute jamais une requête arbitraire.
export function parseOverpassQuery(data) {
  const m = /\(around:(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/.exec(String(data || ""));
  if (!m) return null;
  const radiusM = +m[1], lat = +m[2], lon = +m[3];
  if (!RADII_M.includes(radiusM) || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
  return overpassQuery(lat, lon, radiusM) === data ? { lat, lon, radiusM } : null;
}

// Éléments réduits à ce que la page utilise.
export function slimElements(elements) {
  return (Array.isArray(elements) ? elements : []).map((e) => {
    const tags = {};
    for (const k in e.tags || {}) if (KEEP_TAG.test(k)) tags[k] = e.tags[k];
    return { type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags };
  });
}
