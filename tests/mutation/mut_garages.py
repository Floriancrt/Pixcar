#!/usr/bin/env python3
"""Mutations sur la table de garages : voir lib.py. Quatre familles, une par commande.

  python3 tests/mutation/mut_garages.py            variantes de src/ (page, module, balise, texte, style) jugées par la suite navigateur tests/garages.js
  python3 tests/mutation/mut_garages.py --unit     variantes de modules/garages-table.js et config.js jugées par tests/unit/garages-table.test.mjs (sans navigateur)
  python3 tests/mutation/mut_garages.py --build    variantes de scripts/build.mjs (tuiles jointes, balise, robots, en-têtes, textes) jugées par tests/garages-build.js
  python3 tests/mutation/mut_garages.py --python   variantes de scripts/garages/*.py jugées par scripts/garages/test_garages.py (à lancer avec un Python qui a
                                                   les dépendances de scripts/garages/requirements.txt : le même interpréteur sert aux variantes)
  options : --anchors  vérifie seulement que chaque ancre existe encore ; des mots : seulement les variantes dont le nom en contient un
"""
import os, pathlib, re, shutil, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import ROOT, WORK, run, run_node

# ---- la page : name, find, replace, sections de tests/garages.js, vérification qui doit échouer
M = [
 # ---- quelles cases, quel rayon
 ("radius filter removed (a place of a requested tile 20 km away is counted)", 'for (const t of got) if (t) for (const r of t) if (meters(here, r) <= km * 1000) recs.push(r);', 'for (const t of got) if (t) for (const r of t) recs.push(r);', "B", "B5"),
 ("tiles that the index does not list are asked for", '.filter((k) => ix.tiles[k] > 0)', '', "I", "I1"),
 ("the table is asked for a fixed 5 km whatever the search", 'GT.load(l.lat, l.lon, c).catch(() => null)', 'GT.load(l.lat, l.lon, 5).catch(() => null)', "B", "B1"),
 # ---- une table que l'on ne doit pas lire
 ("a table built 200 days ago is used", 'if (!Number.isFinite(built) || now() - built > maxAgeDays * 864e5) throw new Error("périmé");', 'if (!Number.isFinite(built)) throw new Error("périmé");', "E", "E3"),
 ("an index of another version is used", 'if (!ix || ix.v !== 1 || ix.step !== STEP', 'if (!ix || ix.step !== STEP', "E", "E4"),
 ("a failed index is asked again at every search", 'if (failedAt && now() - failedAt < 60000) return Promise.resolve(null);', '', "E", "E2"),
 ("the kill switch window.JG_GARAGES = false is ignored", 'base: window.JG_GARAGES === !1 ? "" : garagesBase()', 'base: garagesBase()', "G", "G1"),
 ("any base is accepted, another host included", '/^[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._-]*)*\\/?$/i.test(raw) ? raw.replace(/\\/*$/, "/") : ""', 'raw ? raw.replace(/\\/*$/, "/") : ""', "G", "G2"),
 # ---- une case qui échoue, une table lente
 ("a failed tile is kept for the visit (never asked again)", "      tiles.delete(key); // un échec n'est jamais gardé : il peut être passager", "      0;", "D", "D3"),
 ("one failing tile fails the whole load", 'const got = await Promise.all(keys.map((k) => tile(k).catch(() => null)));', 'const got = await Promise.all(keys.map((k) => tile(k)));', "D", "D1"),
 ("the list waits for the table as long as it takes", 'const tb = await Promise.race([tableLoad, new Promise((done) => setTimeout(() => done(null), a.tableWait))]);', 'const tb = await tableLoad;', "F", "F1"),
 # ---- fusion
 ("a phone of the table replaces OpenStreetMap's", 'if (!h.phoneCount(g.phone) && rec.phones.length) {', 'if (rec.phones.length) {', "B", "B9"),
 ("a site of the table replaces OpenStreetMap's", 'if (!g.web && rec.web) {', 'if (rec.web) {', "B", "B9"),
 ("an address of the table replaces OpenStreetMap's", 'if (g.addrGap && rec.addr) {', 'if (rec.addr) {', "B", "B9"),
 ("nothing is ever completed", 'if (!h.phoneCount(g.phone) && rec.phones.length) {', 'if (false) {', "B", "B6"),
 ("duplicates are added to the list", '    if (clash) {\n      dup++;\n      continue;\n    }', '    if (false) {\n      dup++;\n      continue;\n    }', "B", "B2"),
 ("a place within 4 m only is the same spot", 'export const SAME_SPOT_M = 40; // en deçà : le nom peut manquer ou différer', 'export const SAME_SPOT_M = 4; // en deçà : le nom peut manquer ou différer', "B", "B2"),
 ("a table garage has a made-up identifier", 'id: "custom:ovt-" + rec.id.replace(/-/g, ""),', 'id: "ovt:" + rec.id,', "B", "B4"),
 ("a table garage without a street address is never looked up", 'addrGap: !rec.addr,', 'addrGap: false,', "B", "B14"),
 ("the address lookup keeps to OpenStreetMap's garages", 'if (!g || ("osm" !== g.src && "ovt" !== g.src) || !g.addrGap', 'if (!g || "osm" !== g.src || !g.addrGap', "B", "B14"),
 # ---- OpenStreetMap en panne
 ("OpenStreetMap down: the table does not take over", '((s = tb.recs.map((r) => toGarage(r, GTH))), (me.tableInfo.added = s.length), (me.cachedAt = 0));', '0;', "C", "C1"),
 ("OpenStreetMap down: the page does not say so", 'me.notes.push("OpenStreetMap n\'a pas répondu : cette liste vient de la base Overture Maps, à titre indicatif.");', '0;', "C", "C3"),
 # ---- ce que la fiche dit
 ("completed fields are not named", 'return f.length ? `<p class="fact-note">Complété par la base Overture Maps, à titre indicatif : ${y(f.join(", "))}.</p>` : "";', 'return "";', "B", "B7"),
 ("a table garage carries no note", 'if ("ovt" === e.src)\n      return', 'if (false)\n      return', "B", "B12"),
 ("the map does not credit Overture", '+ (GT.enabled ? ", Overture Maps" : "")', '+ ""', "B", "B19b"),
 ("the note is tiny", '.fact-note {\n  margin: 8px 0 0;\n  font-size: 0.78rem;', '.fact-note {\n  margin: 8px 0 0;\n  font-size: 0.5rem;', "H", "H2"),
]

# ---- le module et la balise, sans navigateur : name, fichier, find, replace, dossier de tests, filtres
GT = "src/js/modules/garages-table.js"
CF = "src/js/modules/config.js"
U = [
 ("tile key: longitude origin added instead of removed", GT, 'Math.floor((lon - X0) / STEP)}`;', 'Math.floor((lon + X0) / STEP)}`;', "tests/unit", ["garages-table"]),
 ("tile keys: no longitude correction", GT, 'const dLon = km / (111.2 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));', 'const dLon = km / 111.2;', "tests/unit", ["garages-table"]),
 ("distance: wrong earth radius", GT, '2 * 6371008.8 * Math.asin', '2 * 6371008.8 * 1.01 * Math.asin', "tests/unit", ["garages-table"]),
 ("names: a generic word makes two garages the same", GT, '"garage", "garages", "auto"', '"auto"', "tests/unit", ["garages-table"]),
 ("names: one or two letters are distinctive", GT, '.filter((t) => t.length >= 3 && !GENERIC.has(t))', '.filter((t) => t.length >= 1 && !GENERIC.has(t))', "tests/unit", ["garages-table"]),
 ("names: very short names contain each other", GT, 'return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));', 'return ca.length >= 1 && cb.length >= 1 && (ca.includes(cb) || cb.includes(ca));', "tests/unit", ["garages-table"]),
 ("names: containment ignored", GT, '(ca.includes(cb) || cb.includes(ca));', 'false;', "tests/unit", ["garages-table"]),
 ("names: accents and capitals matter", GT, 'normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()', 'normalize("NFD")', "tests/unit", ["garages-table"]),
 ("names: the page's placeholder for a tyre shop with no name is a real name", GT, '/^(Garage \\(nom|Spécialiste pneus \\(sans)/', '/^(Garage \\(nom)/', "tests/unit", ["garages-table"]),
 ("rule: a garage without a name matches when other places are within 40 m", GT, 'x.d <= SAME_SPOT_M && spot.length === 1', 'x.d <= SAME_SPOT_M', "tests/unit", ["garages-table"]),
 ("rule: a garage without a name matches a place 150 m away", GT, 'x.d <= SAME_SPOT_M && spot.length === 1', 'true', "tests/unit", ["garages-table"]),
 ("rule: the nearest same-named place is not preferred", GT, 'if (ok && (!best || x.d < best.d)) best = x;', 'if (ok && !best) best = x;', "tests/unit", ["garages-table"]),
 ("rule: 1.5 km counts as near", GT, 'export const NEAR_M = 150;', 'export const NEAR_M = 1500;', "tests/unit", ["garages-table"]),
 ("grid: neighbours one cell away are not searched", GT, 'const dLat = Math.ceil(radiusM / 111320 / LAT);', 'const dLat = 0;', "tests/unit", ["garages-table"]),
 ("tile: a place without a name is kept", GT, ' || typeof r.name !== "string" || r.name.trim().length < 2', '', "tests/unit", ["garages-table"]),
 ("tile: an identifier of any shape is kept", GT, 'typeof r.id !== "string" || !ID_RE.test(r.id)', 'typeof r.id !== "string"', "tests/unit", ["garages-table"]),
 ("tile: a position outside the world is kept", GT, '|| Math.abs(lat) > 90 || Math.abs(lon) > 180', '', "tests/unit", ["garages-table"]),
 ("tile: any phone text is kept", GT, 'r.phones.filter((p) => typeof p === "string" && PHONE_RE.test(p)).slice(0, 2)', 'r.phones.slice(0, 2)', "tests/unit", ["garages-table"]),
 ("tile: three phones are kept", GT, 'PHONE_RE.test(p)).slice(0, 2)', 'PHONE_RE.test(p)).slice(0, 3)', "tests/unit", ["garages-table"]),
 ("tile: a site that is not http(s) is kept", GT, '/^https?:\\/\\/[^\\s"\'<>]+$/.test(r.web)', '/^.+$/.test(r.web)', "tests/unit", ["garages-table"]),
 ("tile: a very long site is kept", GT, 'r.web.length <= 200 && ', '', "tests/unit", ["garages-table"]),
 ("tile: an unknown kind is kept", GT, 'KINDS.includes(r.kind) ? r.kind : "r"', 'true ? r.kind : "r"', "tests/unit", ["garages-table"]),
 ("tile: a postcode of any shape is kept", GT, '/^\\d{5}$/.test(r.pc)', '/^.*$/.test(r.pc)', "tests/unit", ["garages-table"]),
 ("tile: a text of any length is kept", GT, 'const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");', 'const str = (v, n) => (typeof v === "string" ? v : "");', "tests/unit", ["garages-table"]),
 ("index: another version is accepted", GT, 'if (!ix || ix.v !== 1 || ix.step !== STEP', 'if (!ix || ix.step !== STEP', "tests/unit", ["garages-table"]),
 ("tile: another version is read", GT, 'if (!json || json.v !== 1 || !Array.isArray(json.g)) return null;', 'if (!json || !Array.isArray(json.g)) return null;', "tests/unit", ["garages-table"]),
 ("index: another grid step is accepted", GT, ' || ix.step !== STEP', '', "tests/unit", ["garages-table"]),
 ("index: another longitude origin is accepted", GT, ' || ix.x0 !== X0', '', "tests/unit", ["garages-table"]),
 ("index: no list of tiles is accepted", GT, ' || !ix.tiles || typeof ix.tiles !== "object"', '', "tests/unit", ["garages-table"]),
 ("index: a date that is not a date is accepted", GT, 'if (!Number.isFinite(built) || now() - built', 'if (now() - built', "tests/unit", ["garages-table"]),
 ("index: a table 181 days old is refused", GT, 'export const MAX_AGE_DAYS = 180;', 'export const MAX_AGE_DAYS = 90;', "tests/unit", ["garages-table"]),
 ("fetch: an error status is read as a tile", GT, '      if (!res.ok) throw new Error(String(res.status));\n', '', "tests/unit", ["garages-table"]),
 ("fetch: no time limit", GT, '    const timer = setTimeout(() => ctl.abort(), timeoutMs);', '    const timer = setTimeout(() => {}, timeoutMs);', "tests/unit", ["garages-table"]),
 ("load: no cap on the number of tiles", GT, '.slice(0, maxTiles)', '', "tests/unit", ["garages-table"]),
 ("load: a failed tile is kept", GT, '        tiles.delete(key); // un échec n\'est jamais gardé : il peut être passager\n', '', "tests/unit", ["garages-table"]),
 ("load: a failed index is kept for good", GT, '        indexP = null;\n        failedAt = now();', '        failedAt = now();', "tests/unit", ["garages-table"]),
 ("load: a failed index is asked again at once", GT, 'if (failedAt && now() - failedAt < 60000)', 'if (failedAt && now() - failedAt < 0)', "tests/unit", ["garages-table"]),
 ("load: nothing without a base", GT, 'const root = base ? (base.endsWith("/") ? base : base + "/") : "";', 'const root = base ? (base.endsWith("/") ? base : base + "/") : "garages/";', "tests/unit", ["garages-table"]),
 ("toGarage: the identifier keeps its dashes", GT, 'rec.id.replace(/-/g, "")', 'rec.id', "tests/unit", ["garages-table"]),
 ("toGarage: a tyre shop is a repair garage", GT, 'shop: rec.kind === "t" ? "tyres" : "car_repair",', 'shop: "car_repair",', "tests/unit", ["garages-table"]),
 ("toGarage: only the first phone", GT, 'phone: rec.phones.join(";"),', 'phone: rec.phones[0] || "",', "tests/unit", ["garages-table"]),
 ("toGarage: a missing address is not flagged", GT, 'addrGap: !rec.addr,', 'addrGap: false,', "tests/unit", ["garages-table"]),
 ("toGarage: the site is not normalised", GT, 'web: h.web(rec.web),', 'web: rec.web,', "tests/unit", ["garages-table"]),
 ("toGarage: a dealer is not told from an independent", GT, 'dealer: !chain && h.dealerOf({ name: rec.name, brand: rec.brand }),', 'dealer: false,', "tests/unit", ["garages-table"]),
 ("complete: a phone of the garage is replaced", GT, 'if (!h.phoneCount(g.phone) && rec.phones.length) {', 'if (rec.phones.length) {', "tests/unit", ["garages-table"]),
 ("complete: a site of the garage is replaced", GT, 'if (!g.web && rec.web) {', 'if (rec.web) {', "tests/unit", ["garages-table"]),
 ("complete: an address of the garage is replaced", GT, 'if (g.addrGap && rec.addr) {', 'if (rec.addr) {', "tests/unit", ["garages-table"]),
 ("complete: the table's identifier is not kept", GT, '  g.tableId = rec.id;\n', '', "tests/unit", ["garages-table"]),
 ("complete: the fields completed are not recorded", GT, '  if (done.length) g.tableFields = [...new Set([...(g.tableFields || []), ...done])];', '', "tests/unit", ["garages-table"]),
 ("merge: the garages of the table are matched as if from OpenStreetMap", GT, 'if (g.src === "ovt") continue;', '', "tests/unit", ["garages-table"]),
 ("merge: a place used to complete a garage is added too", GT, '    taken.add(rec.id);\n', '', "tests/unit", ["garages-table"]),
 ("merge: any garage within 40 m is not a clash", GT, 'return d <= SAME_SPOT_M || (d <= NEAR_M', 'return (d <= NEAR_M', "tests/unit", ["garages-table"]),
 ("merge: a same-named garage 150 m away is not a clash", GT, '|| (d <= NEAR_M && hasRealName(g.name) && sameName(g.name, rec.name))', '', "tests/unit", ["garages-table"]),
 ("merge: a garage without a name clashes with any place within 150 m", GT, 'hasRealName(g.name) && sameName(g.name, rec.name)', 'sameName(g.name, rec.name)', "tests/unit", ["garages-table"]),
 ("merge: two places of the table that overlap are both added", GT, '    garageGrid.add(g); // deux lieux de la table qui se recoupent ne s\'ajoutent pas deux fois\n', '', "tests/unit", ["garages-table"]),
 ("merge: the list handed in is modified", GT, 'const list = garages.slice();', 'const list = garages;', "tests/unit", ["garages-table"]),
 ("labels: field names mixed up", GT, 'const FIELD_LABEL = { phone: "téléphone", web: "site", addr: "adresse" };', 'const FIELD_LABEL = { phone: "site", web: "téléphone", addr: "adresse" };', "tests/unit", ["garages-table"]),
 ("base: another host accepted", CF, '/^[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._-]*)*\\/?$/i', '/^.*$/i', "tests/unit", ["garages-table"]),
 ("base: a path that climbs out of the site accepted", CF, '(\\/[a-z0-9][a-z0-9._-]*)*', '(\\/[a-z0-9._-]*)*', "tests/unit", ["garages-table"]),
 ("base: no trailing slash added", CF, 'raw.replace(/\\/*$/, "/")', 'raw', "tests/unit", ["garages-table"]),
 ("base: the test override is ignored", CF, 'const raw = String(typeof tune === "string" ? tune : (meta && meta.content) || "").trim();', 'const raw = String((meta && meta.content) || "").trim();', "tests/unit", ["garages-table"]),
 ("base: the meta tag is ignored", CF, 'typeof tune === "string" ? tune : (meta && meta.content) || ""', 'typeof tune === "string" ? tune : ""', "tests/unit", ["garages-table"]),
]

# ---- la construction du site : name, find, replace, vérification qui doit échouer (scripts/build.mjs, tests/garages-build.js lit PIXCAR_BUILD)
B = [
 ("the tiles are not copied into dist/", 'for (const k of garages.keys) await copyFile(join(garages.dir, "t", k + ".json"), join(DIST, "garages/t", k + ".json"));', '', "A2"),
 ("the index is not copied into dist/", 'await copyFile(join(garages.dir, "index.json"), join(DIST, "garages/index.json"));', '', "A2"),
 ("the meta stays empty with tiles", 'garagesBase: garages ? "garages/" : ""', 'garagesBase: ""', "A4"),
 ("the meta is set without tiles", 'garagesBase: garages ? "garages/" : ""', 'garagesBase: "garages/"', "A10"),
 ("robots are not kept out of the tiles", '(garages ? "Disallow: /garages/\\n" : "")', '""', "A5"),
 ("robots are always kept out of /garages/", '(garages ? "Disallow: /garages/\\n" : "")', '"Disallow: /garages/\\n"', "A10"),
 ("no cache rule for the tiles", 'const garagesRule = garages ?', 'const garagesRule = false ?', "A6"),
 ("the tiles are cached for a year", 'Cache-Control: public, max-age=3600', 'Cache-Control: public, max-age=31536000, immutable', "A6"),
 ("the cache rule is written without tiles", 'const garagesRule = garages ?', 'const garagesRule = true ?', "A10"),
 ("an index of another version is built into the site", 'if (index.v !== 1 || index.step !== 0.25', 'if (index.step !== 0.25', "D-version"),
 ("an index of another step is built into the site", 'index.step !== 0.25 || ', '', "D-step"),
 ("an index of another origin is built into the site", ' || index.x0 !== -10', '', "D-origin"),
 ("a tile key that climbs out of the folder is accepted", 'if (!/^-?\\d+--?\\d+$/.test(k)) throw', 'if (false) throw', "D-key"),
 ("an index without tiles is built into the site", 'if (!keys.length) throw', 'if (false) throw', "D-empty"),
 ("the single-file page says the table is read", 'const parts = await pageParts(false);', 'const parts = await pageParts(!!garages);', "B2"),
 ("both text variants are kept", '((mode === "on") === !!on ? text : "")', '(text)', "A14"),
 ("the privacy window does not carry the table's paragraphs", 'garagesVariants(variants(await read(SRC, "partials/legal.html")), withGarages)', 'garagesVariants(variants(await read(SRC, "partials/legal.html")), false)', "A13"),
 ("the sources text does not carry the table's paragraph", 'garagesVariants(await read(SRC, "partials/body.html"), withGarages)', 'garagesVariants(await read(SRC, "partials/body.html"), false)', "A11"),
 ("dist/ is built with the texts of the single-file page", 'const dist = only === "single" ? null : await buildDist(distParts);', 'const dist = only === "single" ? null : await buildDist(parts);', "A11"),
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
            r = subprocess.run(["node", "tests/garages-build.js"], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "PIXCAR_BUILD": "scripts/.build.mut.mjs"})
            fails = re.findall(r"FAIL: (\S+)", r.stdout)
            crashed = r.returncode != 0 and not fails
            ok = any(f.startswith(must) for f in fails)
            note = ", ".join(sorted(set(fails))) or "aucun"
            if crashed:
                note = "la suite s'est arrêtée (plantage, pas un contrôle) : " + (r.stderr.strip().splitlines() or [""])[-1][:80]
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:62s} attendu {must:9s} -> échecs : {note}", flush=True)
            bad += not ok
    finally:
        copy.unlink(missing_ok=True)
    print("ancres périmées :" if anchors_only else "mutations non tuées :", bad)
    sys.exit(1 if bad else 0)


# ---- la construction des tuiles (Python) : name, fichier de scripts/garages, find, replace
P = [
 # matching.py : la règle partagée avec la page
 ("rule: a place 1.5 km away is near", "matching.py", "NEAR_M = 150\n", "NEAR_M = 1500\n"),
 ("rule: same spot is 4 m", "matching.py", "SAME_SPOT_M = 40\n", "SAME_SPOT_M = 4\n"),
 ("names: 'garage' is distinctive", "matching.py", '    "garage", "garages", "auto"', '    "auto"'),
 ("names: two letters are distinctive", "matching.py", "if len(x) >= 3 and x not in GENERIC", "if len(x) >= 1 and x not in GENERIC"),
 ("names: short names contain each other", "matching.py", "return len(ca) >= 5 and len(cb) >= 5 and (cb in ca or ca in cb)", "return len(ca) >= 1 and len(cb) >= 1 and (cb in ca or ca in cb)"),
 ("names: containment ignored", "matching.py", "(cb in ca or ca in cb)", "False"),
 ("names: accents and capitals matter", "matching.py", 'return re.sub("[̀-ͯ]", "", s).lower()', 'return re.sub("[̀-ͯ]", "", s)'),
 ("rule: unnamed garage matches among several places", "matching.py", "(d <= spot_m and len(spot) == 1)", "(d <= spot_m)"),
 ("rule: the nearest is not preferred", "matching.py", "if ok and (best is None or d < best[1]):", "if ok and best is None:"),
 ("rule: a placeholder name counts as a name", "matching.py", "return bool(name) and not re.match(", "return bool(name) or re.match("),
 ("distance: wrong earth radius", "matching.py", "2 * 6371008.8 *", "2 * 6371008.8 * 1.01 *"),
 ("grid: no neighbour cells", "matching.py", "dlat = int(math.ceil((radius_m / 111320) / self.LAT))", "dlat = 0"),
 ("phone: a number with a leading 0 and nothing else is kept", "matching.py", 'if not re.fullmatch(r"0[1-9]\\d{8}", d):', 'if not re.fullmatch(r"0\\d{8}", d):'),
 ("phone: international numbers of any length", "matching.py", "elif len(d) < 10 or len(d) > 15:", "elif False:"),
 ("phone: duplicates kept", "matching.py", "if tel not in seen:", "if True:"),
 # tiles.py : mise en forme, doublons, fermés, écriture, contrôle
 ("tiles: another grid step", "tiles.py", "STEP = 0.25\n", "STEP = 0.5\n"),
 ("tiles: longitude origin added", "tiles.py", "math.floor((lon - X0) / STEP))\n", "math.floor((lon + X0) / STEP))\n"),
 ("site: a directory site is kept", "tiles.py", 'if any(bare == d or bare.endswith("." + d) for d in DENY_SITES):', "if False:"),
 ("site: a login in the address is kept", "tiles.py", 'or u.username or u.password:', ":"),
 ("site: tracking parameters are kept", "tiles.py", "if not TRACKING.match(k)]", "if True]"),
 ("site: a very long address is kept", "tiles.py", 'return out if len(out) <= 200 else ""', "return out"),
 ("site: a site that is not http(s) is kept", "tiles.py", 'if u.scheme not in ("http", "https") or not host', "if not host"),
 ("record: a name of one letter is kept", "tiles.py", "if len(name) < 2 or not re.search", "if not re.search"),
 ("record: three phones are kept", "tiles.py", "[p for p in (row.get(\"phones\") or []) if p])[:2]", "[p for p in (row.get(\"phones\") or []) if p])[:3]"),
 ("record: a postcode of any length is kept", "tiles.py", "if len(pc) == 5:", "if pc:"),
 ("record: a category outside the list is kept", "tiles.py", "    if not kind:\n        return None\n", ""),
 ("record: a position that is not a number is kept", "tiles.py", "math.isfinite(lat) and math.isfinite(lon)):", "True):"),
 ("duplicates: a pile of more than three is merged", "tiles.py", "if len(members) == 1 or len(members) > max_cluster:", "if len(members) == 1:"),
 ("duplicates: the merged place keeps no phone of the others", "tiles.py", '        if phones:\n            head["phones"] = phones[:2]', "        pass"),
 ("duplicates: the merged place keeps no site of the others", "tiles.py", 'for field in ("web", "addr", "pc", "loc", "brand"):', "for field in ():"),
 ("duplicates: the best-documented place is not the head", "tiles.py", 'members.sort(key=lambda r: (not r.get("phones"), not r.get("web"), -(r.get("conf") or 0), r["id"]))', 'members.sort(key=lambda r: r["id"])'),
 ("duplicates: a merge keeps the sources of the head only", "tiles.py", 'src = "".join(sorted({c for m in members for c in m.get("src", "")}))', 'src = head.get("src", "")'),
 ("closed: nothing is dropped", "tiles.py", "if c is not None and M.pick_place(r, ga.near(r[\"lat\"], r[\"lon\"])) is None:", "if False:"),
 ("closed: a place that also matches an active establishment is dropped", "tiles.py", "if c is not None and M.pick_place(r, ga.near(r[\"lat\"], r[\"lon\"])) is None:", "if c is not None:"),
 ("write: old tiles are left in the folder", "tiles.py", '        if f.endswith(".json"):\n            os.remove(os.path.join(tdir, f))', "        pass"),
 ("write: tiles are not sorted", "tiles.py", 'items = sorted(by_tile[key], key=lambda r: (r["lat"], r["lon"], r["id"]))', "items = by_tile[key]"),
 ("write: the index does not list the missing closure", "tiles.py", '    if meta.get("closure_missing"):', "    if False:"),
 ("check: another grid step goes unnoticed", "tiles.py", 'if index["step"] != STEP or index["x0"] != X0:', "if False:"),
 ("check: a heavy tile goes unnoticed", "tiles.py", "if os.path.getsize(path) > MAX_TILE_BYTES:", "if False:"),
 ("check: a tile that does not match the index goes unnoticed", "tiles.py", 'if index["tiles"].get(key) != len(items):', "if False:"),
 ("check: a duplicate identifier goes unnoticed", "tiles.py", 'if g.get("id") in seen:', "if False:"),
 ("check: a place in the wrong tile goes unnoticed", "tiles.py", 'or tile_key(g["lat"], g["lon"]) != key:', ":"),
 ("check: a phone of the wrong format goes unnoticed", "tiles.py", 'if not re.fullmatch(r"\\+\\d{10,15}", p):', "if False:"),
 ("check: an unknown field goes unnoticed", "tiles.py", "            if extra:\n", "            if False:\n"),
 ("check: a wrong total goes unnoticed", "tiles.py", 'if total != index["count"]:', "if False:"),
 ("check: too few entries go unnoticed", "tiles.py", "if total < min_entries:", "if False:"),
 # build.py : l'enchaînement
 ("build: the exclusion list is ignored", "build.py", 'records = [r for r in records if r["id"] not in excl]', "records = records"),
 ("build: a partial closure is reported as complete", "build.py", 'closure = "partial" if missing else "sirene"', 'closure = "sirene"'),
 ("build: any number of departments without an answer is tolerated", "build.py", "if len(missing) > a.max_sirene_missing:", "if False:"),
 ("build: a failed check does not fail the build", "build.py", "return 2 if problems else 0", "return 0"),
 ("build: duplicates are not merged", "build.py", "records, absorbed, too_big = T.merge_duplicates(records)", "absorbed = too_big = 0"),
 ("build: the registry is read without a department code", "build.py", 'if not codes:\n            raise SystemExit("le registre SIRENE demande --dept-codes (ou --sirene off)")', "pass"),
 # overture.py, sirene.py
 ("overture: places of other countries are kept", "overture.py", 'return not (country and addr.get("country") not in (country, None))', "return True"),
 ("overture: categories outside the list are kept", "overture.py", 'if ((r.get("taxonomy") or {}).get("primary")) not in KINDS:\n        return False', "if False:\n        return False"),
 ("overture: the filter of a row is not applied when reading", "overture.py", "if not ok or not keep_place(r, country):", "if not ok:"),
 ("sirene: closed establishments are read as active", "sirene.py", 'is_closed = bool(s.get("etat_administratif") and s["etat_administratif"] != "A")', "is_closed = False"),
 ("sirene: a query capped at 9,900 results is never split", "sirene.py", "if total >= CAP_RESULTS:", "if False:"),
]


def run_python(mutations):
    args = sys.argv[1:]
    only = [a for a in args if not a.startswith("--")]
    anchors_only = "--anchors" in args
    work = WORK / "py"
    if not anchors_only:
        shutil.rmtree(work, ignore_errors=True)
        shutil.copytree(ROOT / "scripts" / "garages", work / "scripts" / "garages", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (work / "src" / "js" / "modules").mkdir(parents=True)
        shutil.copyfile(ROOT / GT, work / GT)  # diff_js.mjs compare les règles de matching.py à celles de ce module
    bad = 0
    for name, rel, find, rep in mutations:
        if only and not any(o.lower() in name.lower() for o in only):
            continue
        original = (ROOT / "scripts" / "garages" / rel).read_text(encoding="utf-8")
        n = original.count(find)
        if n != 1:
            print(f"[skip] {name}: ancre trouvée {n} fois dans {rel}", flush=True)
            bad += 1
            continue
        if anchors_only:
            continue
        target = work / "scripts" / "garages" / rel
        target.write_text(original.replace(find, rep), encoding="utf-8")
        try:
            r = subprocess.run([sys.executable, "-B", "scripts/garages/test_garages.py"], cwd=work, capture_output=True, text=True, timeout=900)
            out = r.stdout + r.stderr
            broken = re.search(r"(SyntaxError|IndentationError|NameError|ImportError|ModuleNotFoundError)[^\n]*", out)
            if broken:
                print(f"[skip] {name:62s} la variante ne se charge pas : {broken.group(0)[:90]}", flush=True)
                bad += 1
                continue
            m = re.search(r"AssertionError: (.*)", out)
            ok = r.returncode != 0
            shown = (m.group(1) if m else (out.strip().splitlines() or ["rien"])[-1])[:100]
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:62s} -> {shown if ok else 'tous les contrôles passent'}", flush=True)
            bad += not ok
        finally:
            target.write_text(original, encoding="utf-8")
    print("ancres périmées :" if anchors_only else "mutations non tuées :", bad)
    sys.exit(1 if bad else 0)


if "--unit" in sys.argv:
    run_node(U, 62)
elif "--build" in sys.argv:
    run_build(B)
elif "--python" in sys.argv:
    run_python(P)
else:
    run(M, "garages.js", 70)
