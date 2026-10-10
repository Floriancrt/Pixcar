#!/usr/bin/env python3
"""Mutations sur le fond de carte Mapbox (jeton, tuiles, repli, crédit, textes, build) : voir lib.py.

  python3 tests/mutation/mut_mapbox.py          variantes de src/ jugées par la suite navigateur tests/mapbox.js
  python3 tests/mutation/mut_mapbox.py --unit   variantes de modules/mapbox.js jugées par tests/unit/mapbox.test.mjs (sans navigateur)
  python3 tests/mutation/mut_mapbox.py --build  variantes de scripts/build.mjs (jeton, style, politique, variantes du texte) jugées par tests/mapbox.js
  options : --anchors  vérifie seulement que chaque ancre existe encore ; des mots : seulement les variantes dont le nom en contient un
"""
import os, pathlib, re, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import ROOT, run, run_node

MB = "src/js/modules/mapbox.js"

# name, find, replace, sections (inutilisé : la suite construit ses pages elle-même), must-fail check prefix
M = [
 # ---- le jeton est utilisé, les tuiles sont celles qu'on attend
 ("Mapbox never used by the page", "(mapbox && bases.push(L.tileLayer(mapboxTileUrl(mapbox), MAPBOX_OPTIONS)),", "(false && bases.push(L.tileLayer(mapboxTileUrl(mapbox), MAPBOX_OPTIONS)),", "", "M22"),
 ("tiles asked at 256 px (four times the requests, so four times the bill)", "/tiles/512/{z}", "/tiles/256/{z}", "", "M23"),
 ("tiles displayed at 256 px", "tileSize: 512, zoomOffset: -1, minZoom: 1,", "tileSize: 256, zoomOffset: -1, minZoom: 1,", "", "M25"),
 ("no zoom offset: tiles of the wrong level", "tileSize: 512, zoomOffset: -1,", "tileSize: 512, zoomOffset: 0,", "", "M26"),
 ("the map can be zoomed out to level 0 (no tile exists one level below)", "minZoom: 1, maxZoom: 19, attribution: MAPBOX_ATTRIBUTION", "minZoom: 0, maxZoom: 19, attribution: MAPBOX_ATTRIBUTION", "", "M25"),
 ("no @2x tiles on dense screens", "/tiles/512/{z}/{x}/{y}{r}?access_token=", "/tiles/512/{z}/{x}/{y}?access_token=", "", "M32"),
 ("token not sent to Mapbox", "?access_token=${encodeURIComponent(token)}`;", "?access_token=`;", "", "M23"),
 ("another style than the one chosen", "${TILES}${style}/tiles/512/", "${TILES}mapbox/streets-v12/tiles/512/", "", "M23"),
 # ---- repli
 ("no fallback when Mapbox refuses the tiles", "failed >= 2 &&", "failed >= 999999 &&", "", "M40"),
 ("fallback at the very first refused tile (a single lost tile is enough to give up Mapbox)", "failed >= 2 &&", "failed >= 1 &&", "", "M45"),
 ("the abandoned background stays on the map", "Mt.removeLayer(layer), showBase(i + 1))", "showBase(i + 1))", "", "M41"),
 ("CARTO unreachable: last resort lost", 'L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {', 'L.tileLayer("https://{s}.basemaps.cartocdn.invalid/rastertiles/voyager/{z}/{x}/{y}{r}.png", {', "", "M44"),
 # ---- crédit
 ("no credit for Mapbox on the map", "maxZoom: 19, attribution: MAPBOX_ATTRIBUTION }", 'maxZoom: 19, attribution: "" }', "", "M28"),
 # ---- textes
 ("privacy text does not name Mapbox", "Mapbox, Inc. (États-Unis ; api.mapbox.com)&nbsp;: le fond de la carte", "Un prestataire de cartes&nbsp;: le fond de la carte", "", "M61"),
 ("privacy text silent about CARTO (as before)", "CARTO (basemaps.cartocdn.com)&nbsp;: fond de carte de dernier recours", "Un autre prestataire&nbsp;: fond de carte de dernier recours", "", "M60"),
 ("the IGN is still described as the background with Mapbox", "recherche d'adresse, et fond de carte si celui de Mapbox ne répond pas", "recherche d'adresse et fond de carte", "", "M62"),
 ("the sources text does not name Mapbox", "Fond de carte : Mapbox (© Mapbox, © les contributeurs d'OpenStreetMap) ; à défaut, Plan IGN (Géoplateforme), puis CARTO.", "Fond de carte : Plan IGN (Géoplateforme).", "", "M63"),
]

# Variantes des fonctions pures de modules/mapbox.js : tests/unit/mapbox.test.mjs
U = [
 ("a secret token (sk.) is accepted", MB, "const TOKEN_FORMAT = /^pk\\.", "const TOKEN_FORMAT = /^(pk|sk)\\.", "tests/unit", ["mapbox"]),
 ("token not anchored at the start", MB, "const TOKEN_FORMAT = /^pk\\.", "const TOKEN_FORMAT = /pk\\.", "tests/unit", ["mapbox"]),
 ("token not anchored at the end", MB, "\\.[A-Za-z0-9_-]+$/;\nconst STYLE_FORMAT", "\\.[A-Za-z0-9_-]+/;\nconst STYLE_FORMAT", "tests/unit", ["mapbox"]),
 ("address characters allowed in the token", MB, "/^pk\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/", "/^pk\\.[A-Za-z0-9_?&=\"<>-]+\\.[A-Za-z0-9_?&=\"<>-]+$/", "tests/unit", ["mapbox"]),
 ("a token with three parts is accepted", MB, "/^pk\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/", "/^pk\\.[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$/", "tests/unit", ["mapbox"]),
 ("a style with several slashes is accepted", MB, "const STYLE_FORMAT = /^[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+$/;", "const STYLE_FORMAT = /^[A-Za-z0-9_/.-]+$/;", "tests/unit", ["mapbox"]),
 ("another default style", MB, 'export const DEFAULT_STYLE = "mapbox/light-v11";', 'export const DEFAULT_STYLE = "mapbox/streets-v12";', "tests/unit", ["mapbox"]),
 ("an invalid style is used as it is", MB, "style: isStyle(style) ? style : DEFAULT_STYLE", "style", "tests/unit", ["mapbox"]),
 ("the token is not trimmed", MB, 'const token = String((meta && meta.content) || "").trim();', 'const token = String((meta && meta.content) || "");', "tests/unit", ["mapbox"]),
 ("the style is read from the wrong attribute", MB, 'meta.getAttribute("data-style")', 'meta.getAttribute("style")', "tests/unit", ["mapbox"]),
 ("tiles of 256 px in the address", MB, "/tiles/512/{z}", "/tiles/256/{z}", "tests/unit", ["mapbox"]),
 ("token not encoded in the address", MB, "${encodeURIComponent(token)}", "${token}", "tests/unit", ["mapbox"]),
 ("no @2x placeholder in the address", MB, "{x}/{y}{r}?access_token=", "{x}/{y}?access_token=", "tests/unit", ["mapbox"]),
 ("Leaflet tiles of 256 px", MB, "tileSize: 512, zoomOffset: -1,", "tileSize: 256, zoomOffset: -1,", "tests/unit", ["mapbox"]),
 ("Leaflet zoom offset 0", MB, "zoomOffset: -1,", "zoomOffset: 0,", "tests/unit", ["mapbox"]),
 ("Leaflet minimum zoom 0", MB, "minZoom: 1,", "minZoom: 0,", "tests/unit", ["mapbox"]),
 ("credit link without noopener", MB, '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> \'', '<a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> \'', "tests/unit", ["mapbox"]),
 ("credit link over http", MB, 'href="https://www.mapbox.com/about/maps/"', 'href="http://www.mapbox.com/about/maps/"', "tests/unit", ["mapbox"]),
 ("« improve this map » link dropped", MB, "'<a href=\"https://www.mapbox.com/map-feedback/\" target=\"_blank\" rel=\"noopener\">Améliorer cette carte</a>';", "'';", "tests/unit", ["mapbox"]),
]

# Variantes de scripts/build.mjs : tests/mapbox.js (la suite lit PIXCAR_BUILD)
B = [
 ("the build accepts a secret token", "if (!/^pk\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(token))", "if (!/^(pk|sk)\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(token))", "M05"),
 ("the refusal repeats the token", 'throw new Error("jeton Mapbox refusé : seul un jeton PUBLIC', 'throw new Error("jeton Mapbox refusé (" + token + ") : seul un jeton PUBLIC', "M05"),
 ("any token accepted", "if (!/^pk\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(token))", "if (false)", "M06"),
 ("any style accepted", "if (!/^[A-Za-z0-9_-]+\\/[A-Za-z0-9_-]+$/.test(style)) throw new Error(", "if (false) throw new Error(", "M07"),
 ("the published build ignores src/mapbox.json", 'pages !== undefined ? config.accessToken ?? "" : ""', '""', "M09"),
 ("every build takes src/mapbox.json", 'pages !== undefined ? config.accessToken ?? "" : ""', 'config.accessToken ?? ""', "M09"),
 ("an empty PIXCAR_MAPBOX_TOKEN does not switch Mapbox off", "const fromEnv = process.env.PIXCAR_MAPBOX_TOKEN;", "const fromEnv = process.env.PIXCAR_MAPBOX_TOKEN || undefined;", "M10"),
 ("Mapbox allowed without the privacy window that tells visitors", 'if ((apiBase || analytics || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")', 'if ((apiBase || analytics) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")', "M11"),
 ("Mapbox text variants chosen by the wrong switch", '(flag === "GA" ? analytics : mapbox)', '(flag === "GA" ? analytics : analytics)', "M61"),
 ("Mapbox host added to the content security policy", "\"img-src 'self' data: blob: https:\", // tuiles de la carte (Mapbox, IGN, CARTO)", "\"img-src 'self' data: blob: https: https://api.mapbox.com\", // tuiles de la carte (Mapbox, IGN, CARTO)", "M12"),
 ("early connection to Mapbox", "const preconnect = () => [GEOCODER, apiOrigin].filter(Boolean)", 'const preconnect = () => [GEOCODER, apiOrigin, mapbox ? "https://api.mapbox.com" : ""].filter(Boolean)', "M03b"),
 ("token not written in the page", 'MAPBOX_TOKEN: mapbox ? mapbox.token : "",', 'MAPBOX_TOKEN: "",', "M03"),
 ("style not written in the page", 'MAPBOX_STYLE: mapbox ? mapbox.style : "",', 'MAPBOX_STYLE: "",', "M03"),
]


def run_build(mutations):
    args = sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    anchors_only = "--anchors" in args
    build = ROOT / "scripts" / "build.mjs"
    original = build.read_text(encoding="utf-8")
    copy = ROOT / "scripts" / ".build.mut.mjs"  # à côté de l'original : ses imports (esbuild…) se résolvent de la même façon
    bad = 0
    try:
        for name, find, rep, must in mutations:
            if only and not any(o.lower() in name.lower() for o in only):
                continue
            n = original.count(find)
            if n != 1:
                print(f"[skip] {name}: ancre trouvée {n} fois", flush=True)
                bad += 1
                continue
            if anchors_only:
                continue
            copy.write_text(original.replace(find, rep), encoding="utf-8")
            r = subprocess.run(["node", "tests/mapbox.js"], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "PIXCAR_BUILD": "scripts/.build.mut.mjs"})
            fails = re.findall(r"FAIL: (\S+)", r.stdout)
            crashed = r.returncode != 0 and not fails
            ok = any(f.startswith(must) for f in fails)
            note = ", ".join(sorted(set(fails))) or "aucun"
            if crashed:
                note = "la suite s'est arrêtée (plantage, pas un contrôle) : " + (r.stderr.strip().splitlines() or [""])[-1][:80]
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:62s} attendu {must:5s} -> échecs : {note}", flush=True)
            bad += not ok
    finally:
        copy.unlink(missing_ok=True)
    print("ancres périmées :" if anchors_only else "mutations non tuées :", bad)
    sys.exit(1 if bad else 0)


if "--unit" in sys.argv:
    run_node(U, 52)
elif "--build" in sys.argv:
    run_build(B)
else:
    run(M, "mapbox.js", 70)
