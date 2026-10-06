#!/usr/bin/env python3
"""Mutations sur les fiches complétées par Mapbox (téléphone, horaires, site à l'ouverture d'une fiche) : voir lib.py.

  python3 tests/mutation/mut_mapbox_fiches.py          variantes de src/ (page, textes, style) jugées par la suite navigateur tests/mapbox-fiches.js
  python3 tests/mutation/mut_mapbox_fiches.py --unit   variantes de modules/mapbox-fiches.js et de modules/mapbox.js jugées par tests/unit (sans navigateur)
  python3 tests/mutation/mut_mapbox_fiches.py --build  variantes de scripts/build.mjs (réglage « enrich », politique de sécurité, textes) jugées par tests/mapbox-fiches.js
  options : --anchors  vérifie seulement que chaque ancre existe encore ; des mots : seulement les variantes dont le nom en contient un
"""
import os, pathlib, re, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import ROOT, run, run_node

MF = "src/js/modules/mapbox-fiches.js"
MB = "src/js/modules/mapbox.js"

# name, find, replace, sections (inutilisé : la suite construit ses pages elle-même), must-fail check prefix
M = [
 # ---- quand et pour qui on interroge Mapbox
 ("cards are never completed (no request on opening)", "r && n && (adEnsure(n), mbxEnsure(n));", "r && n && (adEnsure(n));", "", "F20"),
 ("mode « map » ignores whether the map shows Mapbox tiles", '("always" === mbxCfg.enrich ? !mbxFallen : mbxLive)', "!0", "", "F60"),
 ("the map never says it shows Mapbox tiles (mode « map » never asks)", "mbxLive = isMapbox;", "mbxLive = !1;", "", "F20"),
 ("giving Mapbox up for the IGN is not remembered (mode « always » keeps asking)", "isMapbox && (mbxFallen = !0), ", "", "", "F63"),
 ("enrich=off is not honoured", '"off" !== mbxCfg.enrich &&', "", "", "F70"),
 ("the run-time switch (JG_MAPBOX_ENRICH) is not honoured", "window.JG_MAPBOX_ENRICH !== !1 &&", "", "", "F71"),
 ("complete cards are asked too (no more « something is missing » test)", "(g.mbxTry || 0) < 2 &&\n      missingOf(g);", "(g.mbxTry || 0) < 2;", "", "F30"),
 ("only OpenStreetMap garages are completed (not the SIRENE register's)", '("osm" === g.src || "sirene" === g.src) &&', '("osm" === g.src) &&', "", "F45"),
 ("the token is not sent", "createEnricher({ token: mbxCfg.token })", 'createEnricher({ token: "" })', "", "F22b"),
 # ---- ce qu'on fait de la réponse
 ("the phone is not written to the garage", "(f.phone && (g.phone = f.phone), f.hours && (g.hours = f.hours), f.web && (g.web = f.web));", "(f.hours && (g.hours = f.hours), f.web && (g.web = f.web));", "", "F24"),
 ("the hours are not written to the garage", "(f.phone && (g.phone = f.phone), f.hours && (g.hours = f.hours), f.web && (g.web = f.web));", "(f.phone && (g.phone = f.phone), f.web && (g.web = f.web));", "", "F24"),
 ("the site is not written to the garage", "(f.phone && (g.phone = f.phone), f.hours && (g.hours = f.hours), f.web && (g.web = f.web));", "(f.phone && (g.phone = f.phone), f.hours && (g.hours = f.hours));", "", "F24"),
 ("no mention of the source on filled-in rows", "g.mbx = Object.fromEntries(Object.keys(f).map((k) => [k, !0]));", "g.mbx = {};", "", "F25"),
 ("the mention is put on every row, even those OpenStreetMap filled in", "g.mbx = Object.fromEntries(Object.keys(f).map((k) => [k, !0]));", "g.mbx = { phone: !0, hours: !0, web: !0 };", "", "F32"),
 ("the rows are not repainted when the answer comes", "nd && dl.replaceWith(nd);", "", "", "F24"),
 ("the « Appeler » button is not refreshed", "act && (act.innerHTML = gActions(g));", "", "", "F26"),
 ("no « Recherche… » while the request is pending (phone row)", '${none(wait ? "Recherche…" : "Non renseigné")} · <a href', '${none("Non renseigné")} · <a href', "", "F20"),
 ("the card is not repainted when the request starts", "((g.mbxBusy = !0), mbxRepaint(g));", "(g.mbxBusy = !0);", "", "F20"),
 ("the rows are replaced instead of updated in place (a screen reader hears nothing)", "if (cur.length === nxt.length) cur.forEach((dd, i) => dd.innerHTML !== nxt[i].innerHTML && (dd.innerHTML = nxt[i].innerHTML));\n      else nd && dl.replaceWith(nd);", "nd && dl.replaceWith(nd);", "", "F28"),
 ("the contact rows are not live regions", """<dd${/^(Téléphone|Horaires|Site)$/.test(e) ? ' aria-live="polite"' : ""}>""", "<dd>", "", "F28"),
 # ---- présentation
 ("the mention has no title", ' title="Information fournie par Mapbox, à titre indicatif"', "", "", "F27"),
 ("the mention is as large as the row", "font-size: 0.72rem;\n  font-weight: 600;\n  line-height: 1.5;", "font-size: 0.88rem;\n  font-weight: 600;\n  line-height: 1.5;", "", "F27"),
 ("the mention can be split over two lines", "line-height: 1.5;\n  color: var(--ink-3);\n  white-space: nowrap;", "line-height: 1.5;\n  color: var(--ink-3);", "", "F27"),
 # ---- textes
 ("privacy text does not say that a card opening sends the garage's position", "il reçoit aussi, quand vous ouvrez la fiche d'un garage dont le téléphone", "il reçoit aussi, quand vous ouvrez une page dont le téléphone", "", "F05"),
 ("privacy text does not say the data is kept only for the visit", "ne sont conservées que le temps de votre visite", "sont conservées", "", "F05"),
 ("the sources text does not say the contacts can come from Mapbox", "la fiche les cherche chez Mapbox", "la fiche les cherche ailleurs", "", "F07"),
]

# Variantes des fonctions pures : tests/unit
U = [
 ("search zone ten times wider", MF, "export const NEAR_M = 150;", "export const NEAR_M = 1500;", "tests/unit", ["mapbox-fiches"]),
 ("a garage without a name takes a place up to 400 m away", MF, "export const SAME_SPOT_M = 40;", "export const SAME_SPOT_M = 400;", "tests/unit", ["mapbox-fiches"]),
 ("no cap per visit (4000)", MF, "export const CAP = 40;", "export const CAP = 4000;", "tests/unit", ["mapbox-fiches"]),
 ("the pause after failures lasts one millisecond", MF, "const PAUSE_MS = 60_000;", "const PAUSE_MS = 1;", "tests/unit", ["mapbox-fiches"]),
 ("another category than auto_repair", MF, 'export const CATEGORY = "auto_repair";', 'export const CATEGORY = "car_repair";', "tests/unit", ["mapbox-fiches"]),
 ("a hundred results asked", MF, "radiusM = NEAR_M, limit = 10 }", "radiusM = NEAR_M, limit = 100 }", "tests/unit", ["mapbox-fiches"]),
 ("a country restriction added to the request", MF, 'language: "fr", limit: String(limit)', 'language: "fr", country: "fr", limit: String(limit)', "tests/unit", ["mapbox-fiches"]),
 ("the zone is not restricted (no bbox, proximity only)", MF, "limit: String(limit), bbox, proximity:", "limit: String(limit), proximity:", "tests/unit", ["mapbox-fiches"]),
 ("proximity written latitude first", MF, "proximity: `${lon.toFixed(6)},${lat.toFixed(6)}`", "proximity: `${lat.toFixed(6)},${lon.toFixed(6)}`", "tests/unit", ["mapbox-fiches"]),
 ("the zone is too narrow (the longitude ignores the latitude)", MF, "const dLon = radiusM / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));", "const dLon = radiusM / 111320;", "tests/unit", ["mapbox-fiches"]),
 ("directories and aggregators are accepted as the site", MF, "if (DENY_SITES.some((d) =>", "if ([].some((d) =>", "tests/unit", ["mapbox-fiches"]),
 ("tracking parameters are kept", MF, "const TRACKING = /^(utm_|y_source$|fbclid$|gclid$|ref$)/i;", "const TRACKING = /^(utm_)/i;", "tests/unit", ["mapbox-fiches"]),
 ("javascript: and other schemes accepted as a site", MF, 'if (!/^https?:$/.test(u.protocol)) return "";', "", "tests/unit", ["mapbox-fiches"]),
 ("names are compared with their accents", MF, 'const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();', 'const fold = (s) => String(s || "").toLowerCase();', "tests/unit", ["mapbox-fiches"]),
 ("generic words (garage, carrosserie, pneus…) make a same garage", MF, 'const GENERIC = new Set(["garage", "garages",', 'const GENERIC = new Set(["zzz",', "tests/unit", ["mapbox-fiches"]),
 ("a shared distinctive word no longer makes a same name", MF, "for (const t of tokens(a)) if (B.has(t)) return true;", "", "tests/unit", ["mapbox-fiches"]),
 ("the punctuation-free containment no longer makes a same name", MF, "return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));", "return false;", "tests/unit", ["mapbox-fiches"]),
 ("a nameless garage takes a place up to 150 m away", MF, "x.d <= SAME_SPOT_M && spot.length === 1", "x.d <= NEAR_M", "tests/unit", ["mapbox-fiches"]),
 ("a nameless garage takes one of several places at the same spot", MF, "x.d <= SAME_SPOT_M && spot.length === 1", "x.d <= SAME_SPOT_M", "tests/unit", ["mapbox-fiches"]),
 ("a named garage takes a place of ANOTHER name", MF, "const ok = named ? sameName(garage.name, x.p.name) :", "const ok = named ? true :", "tests/unit", ["mapbox-fiches"]),
 ("the first candidate is taken instead of the nearest", MF, "if (ok && (!best || x.d < best.d)) best = x;", "if (ok && !best) best = x;", "tests/unit", ["mapbox-fiches"]),
 ("Sunday (day 0) is read as Monday", MF, "(d + 6) % 7 : -1", "d % 7 : -1", "tests/unit", ["mapbox-fiches"]),
 ("the ranges of a day are not sorted", MF, 'days.map((r) => r.sort().join(","))', 'days.map((r) => r.join(","))', "tests/unit", ["mapbox-fiches"]),
 ("a closing before the opening is kept", MF, "overnight ? dayOf(c.day) !== (day + 1) % 7 : to <= from", "false", "tests/unit", ["mapbox-fiches"]),
 ("a closing two days later is kept", MF, "overnight ? dayOf(c.day) !== (day + 1) % 7 : to <= from", "overnight ? false : to <= from", "tests/unit", ["mapbox-fiches"]),
 ("open every day all day is not written 24/7", MF, 'if (labels.every((l) => l === "00:00-24:00")) return "24/7";', "", "tests/unit", ["mapbox-fiches"]),
 ("three consecutive days are not grouped (Mo-Fr)", MF, "if (e - k >= 2) parts.push", "if (e - k >= 99) parts.push", "tests/unit", ["mapbox-fiches"]),
 ("a period without closing time is guessed", MF, "if (!o || !c) continue;", "if (!o) continue;", "tests/unit", ["mapbox-fiches"]),
 ("a phone OpenStreetMap already gives is overwritten", MF, "if (!have.phone && phoneParse(place.phone).length) out.phone = place.phone;", "if (phoneParse(place.phone).length) out.phone = place.phone;", "tests/unit", ["mapbox-fiches"]),
 ("hours OpenStreetMap already gives are overwritten", MF, "if (!have.hours) {", "if (true) {", "tests/unit", ["mapbox-fiches"]),
 ("a phone that is not a number is accepted", MF, "if (!have.phone && phoneParse(place.phone).length) out.phone", "if (!have.phone && place.phone) out.phone", "tests/unit", ["mapbox-fiches"]),
 ("no memory of the answers (every opening asks again)", MF, "if (memo.has(k)) return memo.get(k);", "", "tests/unit", ["mapbox-fiches"]),
 ("no cap per visit in the enricher", MF, "if (state.refused || state.requests >= cap || now() < state.until) return null;", "if (state.refused || now() < state.until) return null;", "tests/unit", ["mapbox-fiches"]),
 ("a refused token does not stop the requests", MF, "state.refused = true; // jeton refusé", "state.refused = false; // jeton refusé", "tests/unit", ["mapbox-fiches"]),
 ("a failure is remembered as an answer", MF, "if (list === null) memo.delete(k);", "", "tests/unit", ["mapbox-fiches"]),
 ("the pause only comes after five failures", MF, "if (++state.failures >= 2)", "if (++state.failures >= 5)", "tests/unit", ["mapbox-fiches"]),
 ("the pause never comes", MF, "if (++state.failures >= 2) (state.until = now() + PAUSE_MS, (state.failures = 0));", "++state.failures;", "tests/unit", ["mapbox-fiches"]),
 ("a request that does not answer is never abandoned", MF, "setTimeout(() => ctl.abort(), timeoutMs)", "setTimeout(() => {}, timeoutMs)", "tests/unit", ["mapbox-fiches"]),
 ("a garage without position still triggers a request", MF, "if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return null;", "if (!g) return null;", "tests/unit", ["mapbox-fiches"]),
 ("the default setting of the enrichment is « always »", MB, 'export const DEFAULT_ENRICH = "map";', 'export const DEFAULT_ENRICH = "always";', "tests/unit", ["mapbox"]),
 ("an invalid enrich setting is used as it is", MB, "enrich: isEnrichMode(enrich) ? enrich : DEFAULT_ENRICH", "enrich", "tests/unit", ["mapbox"]),
 ("the enrich setting is read from the wrong attribute", MB, 'meta.getAttribute("data-enrich")', 'meta.getAttribute("data-style")', "tests/unit", ["mapbox"]),
]

# Variantes de scripts/build.mjs : tests/mapbox-fiches.js (la suite lit PIXCAR_BUILD)
B = [
 ("the content security policy lacks api.mapbox.com", "...(mbx ? MAPBOX_CONNECT : [])", "...[]", "F04"),
 ("api.mapbox.com is in the policy even with enrich=off or without token", 'mbx = !!mapbox && mapbox.enrich !== "off") {', "mbx = true) {", "F04"),
 ("an invalid enrich setting does not stop the build", 'if (!["off", "map", "always"].includes(enrich)) throw new Error(', "if (false) throw new Error(", "F02"),
 ("PIXCAR_MAPBOX_ENRICH is ignored", 'process.env.PIXCAR_MAPBOX_ENRICH || config.enrich || "map"', 'config.enrich || "map"', "F01"),
 ("the enrich setting of src/mapbox.json is ignored", 'process.env.PIXCAR_MAPBOX_ENRICH || config.enrich || "map"', 'process.env.PIXCAR_MAPBOX_ENRICH || "map"', "F03"),
 ("the card texts appear even with enrich=off", 'MX: () => !!mapbox && mapbox.enrich !== "off"', "MX: () => !!mapbox", "F06"),
 ("the card texts never appear", 'MX: () => !!mapbox && mapbox.enrich !== "off"', "MX: () => false", "F05"),
 ("the setting is not written in the page", 'MAPBOX_ENRICH: mapbox ? mapbox.enrich : "",', 'MAPBOX_ENRICH: "",', "F01"),
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
            r = subprocess.run(["node", "tests/mapbox-fiches.js"], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "PIXCAR_BUILD": "scripts/.build.mut.mjs"})
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
    run_node(U, 62)
elif "--build" in sys.argv:
    run_build(B)
else:
    run(M, "mapbox-fiches.js", 72)
