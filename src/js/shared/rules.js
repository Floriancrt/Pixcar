// Règles de validation d'une réparation déclarée, communes à la page (messages en direct) et à l'API (dernier mot).
export const PLATE_RE = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/; // format SIV : EZ-108-BC
export const YEAR_MIN = 1950;
export const PRICE_MAX = 20000; // euros
export const COMMENT_MAX = 500;
export const MODEL_MIN = 2;
export const MODEL_MAX = 40;
export const DATE_MIN = "1990-01-01";
// osm:node/123 · osm:way/45 · siret:12345678901234 · custom:nom-saisi-a-la-main
export const GARAGE_ID_RE = /^(osm:(node|way|relation)\/\d+|siret:\d{14}|custom:[a-z0-9-]{1,80})$/;
