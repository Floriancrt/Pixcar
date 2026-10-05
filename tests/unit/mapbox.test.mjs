// Fond de carte Mapbox : les fonctions pures de modules/mapbox.js (forme du jeton public, du style, adresse des tuiles, options Leaflet). Le
// comportement dans le navigateur (tuiles demandées, repli sur l'IGN, crédit sur la carte) est vérifié par tests/mapbox.js.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ENRICH, DEFAULT_STYLE, ENRICH_MODES, MAPBOX_ATTRIBUTION, MAPBOX_OPTIONS, isEnrichMode, isPublicToken, isStyle, mapboxConfig, mapboxTileUrl } from "../../src/js/modules/mapbox.js";

// jetons fictifs ; la forme secrète est écrite en morceaux : tests/mapbox.js (M08) cherche ce motif dans tout le dépôt
const PUBLIC = ["pk", "eyJ1IjoiZXhlbXBsZSIsImEiOiJjbHh4eHh4eHgwMDAwMnFxeHh4eHh4eHh4In0", "AbCdEfGhIjKlMnOpQrStUv"].join(".");
const SECRET = ["sk", "eyJ1IjoiZXhlbXBsZSIsImEiOiJjbHh4eHh4eHgwMDAwMnFxeHh4eHh4eHh4In0", "AbCdEfGhIjKlMnOpQrStUv"].join(".");
const docWith = (content, style, enrich) =>
  ({ querySelector: (sel) => (sel === 'meta[name="pixcar-mapbox"]' && content !== undefined ? { content, getAttribute: (n) => (n === "data-style" ? style ?? null : n === "data-enrich" ? enrich ?? null : null) } : null) });

describe("isPublicToken", () => {
  test("un jeton public (pk.<charge>.<signature>) est accepté", () => {
    assert.equal(isPublicToken(PUBLIC), true);
    assert.equal(isPublicToken("pk.a.b"), true);
    assert.equal(isPublicToken("pk.A-b_9.C-d_8"), true);
  });
  test("un jeton secret ou temporaire n'est jamais accepté", () => {
    assert.equal(isPublicToken(SECRET), false);
    assert.equal(isPublicToken(["tk", "a", "b"].join(".")), false);
  });
  test("tout ce qui n'a pas la forme exacte est refusé : vide, un seul point, trois points, majuscules, espaces, caractères d'adresse ou de balise", () => {
    for (const bad of ["", " ", "pk", "pk.", "pk.abc", "pk..", "pk.a.", "pk..b", "pk.a.b.c", "PK.a.b", "pk.a b.c", "pk.a.b c", "pk.a.b?x=1", "pk.a.b&x=1", "pk.a.b=", 'pk.a.b"', "pk.a.b<", "pk.a.b>", "pk.a.b/", "pk.a/b.c", "https://api.mapbox.com/?access_token=pk.a.b", "pk.a.b\n", undefined, null])
      assert.equal(isPublicToken(bad), false, String(bad));
  });
});

describe("isStyle", () => {
  test("« compte/style » : le style de Mapbox ou un style du compte", () => {
    for (const ok of ["mapbox/light-v11", "mapbox/dark-v11", "mapbox/streets-v12", "moncompte/ck12ab34", "a/b"]) assert.equal(isStyle(ok), true, ok);
  });
  test("tout le reste est refusé : un seul morceau, trois morceaux, vide, espaces, remontée de dossier, paramètres", () => {
    for (const bad of ["", "light-v11", "mapbox/", "/light-v11", "a/b/c", "mapbox/light v11", "../x", "mapbox/..", "mapbox/light-v11?x=1", "mapbox/light-v11#x", 'mapbox/light"', "mapbox/light-v11\n", undefined]) assert.equal(isStyle(bad), false, String(bad));
  });
});

describe("mapboxConfig", () => {
  test("jeton public et style lus dans la balise", () => {
    assert.deepEqual(mapboxConfig(docWith(PUBLIC, "mapbox/streets-v12")), { token: PUBLIC, style: "mapbox/streets-v12", enrich: "map" });
  });
  test("espaces autour du jeton retirés ; style absent ou invalide : le style par défaut", () => {
    assert.deepEqual(mapboxConfig(docWith("  " + PUBLIC + " ", "")), { token: PUBLIC, style: DEFAULT_STYLE, enrich: "map" });
    assert.deepEqual(mapboxConfig(docWith(PUBLIC, undefined)), { token: PUBLIC, style: DEFAULT_STYLE, enrich: "map" });
    assert.deepEqual(mapboxConfig(docWith(PUBLIC, "../../x")), { token: PUBLIC, style: DEFAULT_STYLE, enrich: "map" });
  });
  test("pas de balise, balise vide, jeton secret ou mal formé : null (la carte garde le fond de l'IGN)", () => {
    for (const bad of [undefined, "", "   ", SECRET, "pk.abc", "n'importe quoi", "https://exemple.test"]) assert.equal(mapboxConfig(docWith(bad, "mapbox/light-v11")), null, String(bad));
  });
  test("réglage « enrich » (fiches complétées par Mapbox) : off, map ou always ; absent ou invalide : map, le plus prudent des modes actifs", () => {
    for (const mode of ["off", "map", "always"]) assert.equal(mapboxConfig(docWith(PUBLIC, "mapbox/light-v11", mode)).enrich, mode);
    for (const bad of [undefined, "", "oui", "ALWAYS", "map ", "1", "true"]) assert.equal(mapboxConfig(docWith(PUBLIC, "mapbox/light-v11", bad)).enrich, bad === "map " ? "map" : DEFAULT_ENRICH, String(bad));
    assert.deepEqual(ENRICH_MODES, ["off", "map", "always"]);
    assert.equal(DEFAULT_ENRICH, "map");
    assert.equal(isEnrichMode("always"), true);
    assert.equal(isEnrichMode("partout"), false);
  });
  test("le style par défaut est un fond sobre fait pour porter des repères", () => {
    assert.equal(DEFAULT_STYLE, "mapbox/light-v11");
  });
});

describe("mapboxTileUrl", () => {
  test("tuiles de 512 px de Mapbox, avec les jokers de Leaflet intacts ({z} {x} {y}, {r} : @2x sur les écrans à haute densité)", () => {
    assert.equal(mapboxTileUrl({ token: PUBLIC, style: "mapbox/light-v11" }), `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}{r}?access_token=${PUBLIC}`);
  });
  test("le style choisi est dans le chemin, le jeton est encodé", () => {
    const url = mapboxTileUrl({ token: "pk.a-b_c.d", style: "moncompte/ck12ab34" });
    assert.ok(url.startsWith("https://api.mapbox.com/styles/v1/moncompte/ck12ab34/tiles/512/"));
    assert.ok(url.endsWith("?access_token=pk.a-b_c.d"));
    assert.equal(new URL(url.replace(/[{}]/g, "x")).hostname, "api.mapbox.com");
    assert.equal(mapboxTileUrl({ token: "a b&c", style: "mapbox/light-v11" }).split("access_token=")[1], "a%20b%26c");
  });
});

describe("options Leaflet", () => {
  test("tuiles de 512 px, décalage de zoom -1, pas de zoom 0 (le niveau -1 n'existe pas), même zoom maximal que les autres fonds", () => {
    assert.equal(MAPBOX_OPTIONS.tileSize, 512);
    assert.equal(MAPBOX_OPTIONS.zoomOffset, -1);
    assert.equal(MAPBOX_OPTIONS.minZoom, 1);
    assert.equal(MAPBOX_OPTIONS.maxZoom, 19);
  });
  test("le crédit exigé par Mapbox : © Mapbox, © OpenStreetMap, lien d'amélioration ; liens https qui s'ouvrent dans un autre onglet sans donner la main à la page", () => {
    assert.equal(MAPBOX_OPTIONS.attribution, MAPBOX_ATTRIBUTION);
    for (const href of ["https://www.mapbox.com/about/maps/", "https://www.openstreetmap.org/copyright", "https://www.mapbox.com/map-feedback/"]) assert.ok(MAPBOX_ATTRIBUTION.includes(`href="${href}"`), href);
    assert.equal((MAPBOX_ATTRIBUTION.match(/<a /g) || []).length, 3);
    assert.equal((MAPBOX_ATTRIBUTION.match(/target="_blank" rel="noopener"/g) || []).length, 3);
    assert.ok(!/http:\/\//.test(MAPBOX_ATTRIBUTION));
    assert.ok(/© <a [^>]*>Mapbox<\/a>/.test(MAPBOX_ATTRIBUTION) && /© <a [^>]*>OpenStreetMap<\/a>/.test(MAPBOX_ATTRIBUTION));
  });
});
