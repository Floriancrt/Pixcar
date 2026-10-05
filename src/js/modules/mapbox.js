// Fond de carte Mapbox : tuiles raster (« Static Tiles API ») affichées par Leaflet, la bibliothèque de carte de la page.
//
// Actif seulement si la page porte <meta name="pixcar-mapbox" content="pk.…" data-style="mapbox/light-v11"> (renseignée au build : src/mapbox.json
// pour la version publiée, ou PIXCAR_MAPBOX_TOKEN, voir scripts/build.mjs) ; sinon la page garde le fond de l'IGN, et la page tout-en-un, le
// développement et les tests n'appellent jamais Mapbox. La carte ne se construit qu'après une recherche : un visiteur qui n'en fait pas ne
// contacte pas Mapbox (pas de préconnexion).
//
// Le jeton est un jeton PUBLIC (« pk.… ») : il se voit dans la page et dans les requêtes de tuiles, c'est le principe de Mapbox. Il doit être
// restreint à l'adresse du site dans le compte Mapbox (« URL restrictions »), sinon n'importe qui peut s'en servir aux frais de son titulaire.
// Un jeton secret (« sk.… », « tk.… ») n'est accepté nulle part : ni ici, ni au build.

const TOKEN_FORMAT = /^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const STYLE_FORMAT = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const TILES = "https://api.mapbox.com/styles/v1/";
export const DEFAULT_STYLE = "mapbox/light-v11"; // fond sobre, fait pour porter des repères : les marqueurs de garages restent lisibles

export const isPublicToken = (token) => TOKEN_FORMAT.test(String(token));
export const isStyle = (style) => STYLE_FORMAT.test(String(style));

// { token, style } lu dans la page, ou null (pas de balise, jeton vide ou qui n'a pas la forme d'un jeton public).
export function mapboxConfig(doc = document) {
  const meta = doc.querySelector('meta[name="pixcar-mapbox"]');
  const token = String((meta && meta.content) || "").trim();
  if (!isPublicToken(token)) return null;
  const style = String((meta && meta.getAttribute("data-style")) || "").trim();
  return { token, style: isStyle(style) ? style : DEFAULT_STYLE };
}

// Adresse des tuiles pour Leaflet ({z} {x} {y}, et {r} : « @2x » sur les écrans à haute densité). Tuiles de 512 px, comme Mapbox le recommande :
// quatre fois moins de requêtes qu'en 256 px pour la même surface, d'où tileSize 512 et zoomOffset -1 dans MAPBOX_OPTIONS.
export const mapboxTileUrl = ({ token, style }) => `${TILES}${style}/tiles/512/{z}/{x}/{y}{r}?access_token=${encodeURIComponent(token)}`;

// Attribution exigée par Mapbox : « © Mapbox © OpenStreetMap » et le lien d'amélioration de la carte.
export const MAPBOX_ATTRIBUTION =
  '© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' +
  '<a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener">Améliorer cette carte</a>';

// minZoom 1 : avec zoomOffset -1, le zoom 0 demanderait des tuiles de niveau -1, qui n'existent pas.
export const MAPBOX_OPTIONS = { tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 19, attribution: MAPBOX_ATTRIBUTION };
