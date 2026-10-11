// Espace Pro : contrôle d'un SIRET auprès de l'API publique « Recherche d'entreprises » (recherche-entreprises.api.gouv.fr, sans clé,
// la même que la page interroge déjà). On en retient l'état (actif / fermé), l'activité principale (code NAF) et la position.
// Forme de réponse utilisée : results[].matching_etablissements[] (et results[].siege) avec siret, etat_administratif,
// activite_principale, latitude, longitude, adresse, liste_enseignes, nom_commercial ; results[].nom_complet.

// Activités retenues pour un garage (mêmes codes que la recherche de la page) : entretien et réparation de véhicules légers (45.20A),
// autres véhicules (45.20B), commerce d'équipements automobiles (45.32Z : centres pneus, montage), commerce de voitures (45.11Z : concessions
// avec atelier). Le contrôle technique (71.20A) n'en fait pas partie : ses prix restent ceux de l'État.
export const GARAGE_NAF = ["45.20A", "45.20B", "45.32Z", "45.11Z"];

// Clé de Luhn du SIRET ; La Poste (SIREN 356000000) suit une autre règle : la somme des chiffres est un multiple de 5.
export function isSiret(value) {
  const s = String(value || "");
  if (!/^\d{14}$/.test(s)) return false;
  if (s.startsWith("356000000")) return [...s].reduce((a, c) => a + Number(c), 0) % 5 === 0;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(s[13 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export const normalizeSiret = (raw) => String(raw || "").replace(/[\s.]/g, "");

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

// Établissement d'un SIRET : { siret, name, addr, naf, active, lat, lon } (lat / lon : null si inconnues), ou null s'il est introuvable.
// Lève une erreur (unavailable) si l'API ne répond pas correctement : ce n'est pas la même chose qu'un SIRET inconnu.
export async function lookupSiret(siret, { fetchImpl = globalThis.fetch, timeoutMs = 5000, base = "https://recherche-entreprises.api.gouv.fr" } = {}) {
  const q = new URLSearchParams({ q: siret, per_page: "5", limite_matching_etablissements: "20" });
  let res;
  try {
    res = await fetchImpl(`${base}/search?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw Object.assign(new Error("registre des entreprises injoignable : " + e.message), { unavailable: true });
  }
  if (!res.ok) throw Object.assign(new Error("registre des entreprises : réponse " + res.status), { unavailable: true });
  let body;
  try {
    body = await res.json();
  } catch {
    throw Object.assign(new Error("registre des entreprises : réponse illisible"), { unavailable: true });
  }
  for (const r of (body && body.results) || []) {
    const all = [...(Array.isArray(r.matching_etablissements) ? r.matching_etablissements : []), ...(r.siege ? [r.siege] : [])];
    const e = all.find((x) => x && String(x.siret) === siret);
    if (!e) continue;
    const lat = num(e.latitude), lon = num(e.longitude);
    const sign = (Array.isArray(e.liste_enseignes) && e.liste_enseignes.find(Boolean)) || e.nom_commercial || "";
    return {
      siret,
      name: String(sign || r.nom_complet || r.nom_raison_sociale || "").slice(0, 120),
      company: String(r.nom_complet || r.nom_raison_sociale || "").slice(0, 120),
      addr: String(e.adresse || "").slice(0, 200),
      naf: String(e.activite_principale || r.activite_principale || ""),
      active: e.etat_administratif === "A",
      lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
      lon: Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : null,
      pc: (/\b(\d{5})\b/.exec(String(e.code_postal || e.adresse || "")) || [])[1] || "",
    };
  }
  return null;
}
