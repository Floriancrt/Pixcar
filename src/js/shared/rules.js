// Règles de validation d'une réparation déclarée, communes à la page (messages en direct) et à l'API (dernier mot).
export const PLATE_RE = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/; // format SIV : EZ-108-BC

// Immatriculation d'un rendez-vous en ligne (obligatoire : le garage identifie la voiture avec), commune à la page et à l'API.
// Plaque française au format SIV (AB-123-CD) ou à l'ancien format FNI (1234 AB 31, 12 ABC 2A), écrite avec ou sans tirets ni
// espaces ; plaque étrangère sur demande explicite (foreign) : de 2 à 9 lettres et chiffres, espaces et tirets permis.
// Forme gardée : 9 caractères au plus (colonne rdv_requests.plate, contrainte CHECK qu'Aurora DSQL ne laisse pas modifier) : SIV
// « AB-123-CD », FNI sans séparateurs « 1234AB31 », plaque étrangère telle qu'écrite si elle tient, sinon sans séparateurs.
// → { value } ou { error }
export const PLATE_MAX = 9;
export function parsePlate(raw, { foreign = false } = {}) {
  const s = String(raw ?? "").toUpperCase().replace(/[\u2010-\u2015\u2212_.]/g, "-").replace(/\s+/g, " ").trim();
  if (!s) return { error: "Indiquez l'immatriculation de la voiture." };
  if (foreign) {
    const v = s.replace(/ ?- ?/g, "-").replace(/^[ -]+|[ -]+$/g, "");
    const bare = v.replace(/[ -]/g, "");
    if (!/^[A-Z0-9 -]+$/.test(v) || bare.length < 2 || bare.length > PLATE_MAX) return { error: `Plaque étrangère : de 2 à ${PLATE_MAX} lettres et chiffres.` };
    return { value: v.length <= PLATE_MAX ? v : bare };
  }
  let m = /^([A-Z]{2})[ -]?(\d{3})[ -]?([A-Z]{2})$/.exec(s);
  if (m) return { value: `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{1,4})[ -]?([A-Z]{1,3})[ -]?(\d{2}|2A|2B|97[1-6])$/.exec(s);
  if (m && m[1].length + m[2].length <= 6) return { value: m[1] + m[2] + m[3] };
  return { error: "Immatriculation au format AB-123-CD (ou 1234 AB 31 pour une ancienne plaque)." };
}
export const YEAR_MIN = 1950;
export const PRICE_MIN = 1; // euros : la base refuse moins (price_cents ≥ 100), la validation et le formulaire aussi
export const PRICE_MAX = 20000; // euros
export const COMMENT_MAX = 500;
export const MODEL_MIN = 2;
export const MODEL_MAX = 40;
export const DATE_MIN = "1990-01-01";
// osm:node/123 · osm:way/45 · siret:12345678901234 · custom:nom-saisi-a-la-main
export const GARAGE_ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|siret:\d{14}|custom:[a-z0-9-]{1,80})$/;
