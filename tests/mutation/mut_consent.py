#!/usr/bin/env python3
"""Mutations sur la mesure d'audience (consentement, chargement de Google, politique de sécurité, textes) : voir lib.py.

  python3 tests/mutation/mut_consent.py          variantes de src/ jugées par la suite navigateur tests/consent.js
  python3 tests/mutation/mut_consent.py --unit   variantes de modules/analytics.js jugées par tests/unit/analytics.test.mjs (sans navigateur)
  python3 tests/mutation/mut_consent.py --build  variantes de scripts/build.mjs (politique, identifiant, variantes du texte) jugées par tests/consent.js
  options : --anchors  vérifie seulement que chaque ancre existe encore ; des mots : seulement les variantes dont le nom en contient un
"""
import os, pathlib, re, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import ROOT, run, run_node

# name, find, replace, sections (inutilisé : la suite construit ses pages elle-même), must-fail check prefix
M = [
 # ---- rien avant la réponse, rien après un refus
 ("library loaded for everybody, before any answer", '  if (choice === "granted") enable();\n  render();', '  enable();\n  render();', "", "M21"),
 ("a refusal loads the library too", '    granted ? enable() : disable();\n    render();\n    if (returnTo && returnTo.isConnected) returnTo.focus();', '    enable();\n    render();\n    if (returnTo && returnTo.isConnected) returnTo.focus();', "", "M51"),
 ("an acceptance does nothing", '    granted ? enable() : disable();\n    render();\n    if (returnTo && returnTo.isConnected) returnTo.focus();', '    granted ? 0 : disable();\n    render();\n    if (returnTo && returnTo.isConnected) returnTo.focus();', "", "M41"),
 ("any click on the page counts as an answer (the bug found while building it)", 'const button = from.closest("button[data-consent]");', 'const button = from.closest("[data-analytics]");', "", "M27"),
 ("Escape stores a refusal", '  const dismiss = () => {\n    shown = false;', '  const dismiss = () => {\n    if (storage) saveChoice(storage, false);\n    shown = false;', "", "M30"),
 ("Escape does nothing", 'e.key === "Escape" && dismiss()', 'e.key === "F13" && dismiss()', "", "M30"),
 ("banner never shown on a first visit", '  let shown = choice === null;', '  let shown = false;', "", "M20"),
 ("banner shown although a choice is kept", '  let shown = choice === null;', '  let shown = true;', "", "M48"),
 ("state attribute not set", '    root.dataset.analytics = choice || "unset";', '    root.dataset.analyticsX = choice || "unset";', "", "M20"),
 # ---- le choix gardé
 ("choice not kept", '    if (storage) saveChoice(storage, granted);\n', '', "", "M40"),
 ("a choice never expires", '    if (saved.at > now + DAY || now - saved.at > CHOICE_DAYS * DAY) return null;', '    if (saved.at > now + DAY) return null;', "", "M80"),
 ("validity of one day only", 'export const CHOICE_DAYS = 183;', 'export const CHOICE_DAYS = 1;', "", "M82"),
 ("a choice dated in the future is trusted", 'if (saved.at > now + DAY || now - saved.at > CHOICE_DAYS * DAY) return null;', 'if (now - saved.at > CHOICE_DAYS * DAY) return null;', "", "M83"),
 ("garbage in storage read as an acceptance", 'if (!saved || typeof saved.analytics !== "boolean" || !Number.isFinite(saved.at)) return null;', 'if (!saved || !Number.isFinite(saved.at)) return null;', "", "M84"),
 # ---- ce que fait l'accord
 ("library requested without the identifier", '    script.src = LIBRARY + encodeURIComponent(id);', '    script.src = LIBRARY;', "", "M41"),
 ("library requested from another address", 'const LIBRARY = "https://www.googletagmanager.com/gtag/js?id=";', 'const LIBRARY = "https://www.google-analytics.com/gtag/js?id=";', "", "M41"),
 ("library script not asynchronous", '    script.async = true;\n    script.src = LIBRARY', '    script.async = false;\n    script.src = LIBRARY', "", "M41"),
 ("no consent defaults declared", '    win.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });\n', '', "", "M42"),
 ("advertising storage allowed by default", 'ad_storage: "denied", ad_user_data', 'ad_storage: "granted", ad_user_data', "", "M42"),
 ("Google signals left on", 'allow_google_signals: false', 'allow_google_signals: true', "", "M43"),
 ("ad personalisation left on", 'allow_ad_personalization_signals: false }', 'allow_ad_personalization_signals: true }', "", "M43"),
 ("cookies kept two years", 'export const COOKIE_SECONDS = 34128000;', 'export const COOKIE_SECONDS = 63072000;', "", "M43"),
 ("gtag pushes an array, not the arguments object", '      layer.push(arguments); // l\'objet', '      layer.push([].slice.call(arguments)); // l\'objet', "", "M44"),
 # ---- retrait et nouveau choix
 ("withdrawal keeps the cookies of Google", 'forget(googleCookieNames(doc.cookie), hosts);', 'forget([], hosts);', "", "M60"),
 ("withdrawal deletes _ga only", '.filter((name) => /^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat(_.*)?)$/.test(name));', '.filter((name) => /^(_ga)$/.test(name));', "", "M60"),
 ("withdrawal does not switch the measurement off", '    win["ga-disable-" + id] = true;', '    win["ga-disable-" + id] = false;', "", "M61"),
 ("withdrawal does not tell Google", '    if (loaded) win.gtag("consent", "update", { analytics_storage: "denied" });\n', '', "", "M61"),
 ("changing one's mind again loads the library twice", '    loaded = true;\n    const layer', '    loaded = false;\n    const layer', "", "M63"),
 ("accepting again does not switch the measurement back on", '      win.gtag("consent", "update", { analytics_storage: "granted" });\n      win.gtag("config", id, params);\n      return;', '      return;', "", "M63"),
 # ---- clavier, fenêtre de confidentialité
 ("the link does not move the focus to the banner", '    if (first) first.focus();\n', '', "", "M71"),
 ("focus not given back after an answer from the reopened banner", '    granted ? enable() : disable();\n    render();\n    if (returnTo && returnTo.isConnected) returnTo.focus();', '    granted ? enable() : disable();\n    render();', "", "M73"),
 ("window labels not updated", '    doc.querySelectorAll("[data-consent-label]").forEach((el) => (el.textContent = LABEL[choice || "unset"]));\n', '', "", "M47"),
 ("pressed state not updated", '    doc.querySelectorAll("button[data-consent][aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.consent === (choice === "granted" ? "grant" : choice === "denied" ? "deny" : ""))));\n', '', "", "M47"),
 # ---- Contentsquare
 ("Contentsquare not loaded on acceptance", '    if (csId) enableContentsquare();', '    0;', "", "M131"),
 ("Contentsquare tag from another address", 'const CS_TAG = "https://t.contentsquare.net/uxa/";', 'const CS_TAG = "https://c.contentsquare.net/uxa/";', "", "M131"),
 ("Contentsquare tag not asynchronous", '    script.async = true;\n    script.src = CS_TAG', '    script.async = false;\n    script.src = CS_TAG', "", "M131"),
 ("Contentsquare tag loaded again when accepting again", '    if (csLoaded) return;\n    csLoaded = true;', '    csLoaded = true;', "", "M135"),
 ("consent not passed on to Contentsquare", '    queue.push(["trackConsentGranted"]);\n', '', "", "M132"),
 ("no optout sent on withdrawal", '      if (csLoaded) (win._uxa = win._uxa || []).push(["optout"]);\n', '', "", "M134"),
 ("withdrawal keeps Contentsquare's cookies", 'forget(contentsquareCookieNames(doc.cookie).filter((name) => name !== "_cs_optout"), hosts);', 'forget([], hosts);', "", "M147"),
 ("withdrawal deletes _cs_optout, the record of the refusal", '.filter((name) => name !== "_cs_optout")', '', "", "M134"),
 ("Contentsquare stopped only when Google is there", '    if (csId) {\n      if (csLoaded)', '    if (id && csId) {\n      if (csLoaded)', "", "M145"),
 ("no optin after a refusal", '    if (csLoaded || contentsquareCookieNames(doc.cookie).includes("_cs_optout")) queue.push(["optin"]);\n', '', "", "M135"),
 ("optin only within the same page", 'if (csLoaded || contentsquareCookieNames(doc.cookie).includes("_cs_optout"))', 'if (csLoaded)', "", "M137"),
 ("Contentsquare alone switches the consent off", '  if (!id && !csId) return null;', '  if (!id) return null;', "", "M142"),
 ("Google loaded although only Contentsquare is configured", '    if (id) enableGoogle();', '    enableGoogle();', "", "M143"),
 ("address summary not masked in recordings", '<b id="sumWhere" data-cs-mask></b>', '<b id="sumWhere"></b>', "", "M138"),
 ("address field not masked in recordings", 'id="addrField" data-cs-mask>', 'id="addrField">', "", "M138"),
 ("declaration form (plate) not masked in recordings", '<form id="repairForm" novalidate data-cs-mask>', '<form id="repairForm" novalidate>', "", "M138"),
 ("route address not masked in recordings", '<span class="r-val" data-cs-mask>${y(me.place.label', '<span class="r-val">${y(me.place.label', "", "M138"),
 ("banner text without the clicks and scrolls sent to Contentsquare", '<!--CS:on-->, clics et défilements<!--/CS:on-->', '', "", "M122"),
 ("privacy text without who runs Contentsquare", '          <h4>Contentsquare</h4>\n          <p>Un service de Contentsquare SAS (France).</p>\n', '', "", "M139"),
 ("Contentsquare missing from the list of services", '<!--CS:on--><li>\n              Contentsquare, seulement si', '<!--CS:on--><li>\n              Un service, seulement si', "", "M140"),
 ("« les deux » said when only one tool is there", '<!--GA:on--><!--CS:on-->\n            Un seul choix vaut pour les deux.<!--/CS:on--><!--/GA:on-->', '\n            Un seul choix vaut pour les deux.', "", "M144"),
 ("« En savoir plus » does not go to the section", '    if (from.closest("[data-consent-more]")) win.requestAnimationFrame(() => doc.getElementById("lg-audience")?.scrollIntoView({ block: "start" }));', '    if (from.closest("[data-consent-more]")) 0;', "", "M32"),
]

# Variantes des fonctions pures de modules/analytics.js : tests/unit/analytics.test.mjs
AN = "src/js/modules/analytics.js"
U = [
 ("id: any string accepted", AN, 'return ID_FORMAT.test(id) ? id : "";', 'return id;', "tests/unit", ["analytics"]),
 ("id: lowercase accepted", AN, '/^G-[A-Z0-9]{6,12}$/', '/^G-[A-Za-z0-9]{6,12}$/', "tests/unit", ["analytics"]),
 ("id: length not bounded", AN, '{6,12}', '{1,}', "tests/unit", ["analytics"]),
 ("choice expires after a year", AN, 'CHOICE_DAYS * DAY) return null;', 'CHOICE_DAYS * DAY * 2) return null;', "tests/unit", ["analytics"]),
 ("future dates tolerated for a year", AN, 'saved.at > now + DAY ||', 'saved.at > now + 400 * DAY ||', "tests/unit", ["analytics"]),
 ("a non-boolean answer is accepted", AN, 'typeof saved.analytics !== "boolean" ||', '', "tests/unit", ["analytics"]),
 ("a date that is not a number is accepted", AN, ' || !Number.isFinite(saved.at)', '', "tests/unit", ["analytics"]),
 ("a refusal read as an acceptance", AN, 'return saved.analytics ? "granted" : "denied";', 'return "granted";', "tests/unit", ["analytics"]),
 ("a storage that fails reports success", AN, '    return false; // stockage refusé', '    return true; // stockage refusé', "tests/unit", ["analytics"]),
 ("cookie names: look-alikes (_gac, _ga2) taken", AN, '/^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat(_.*)?)$/', '/^(_ga.*|_gid|_gat(_.*)?)$/', "tests/unit", ["analytics"]),
 ("cookie names listed twice", AN, '.filter((name) => /^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat(_.*)?)$/.test(name));\n  return [...new Set(names)];', '.filter((name) => /^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat(_.*)?)$/.test(name));\n  return names;', "tests/unit", ["analytics"]),
 ("Contentsquare id: any string accepted", AN, 'return CS_FORMAT.test(id) ? id : "";', 'return id;', "tests/unit", ["analytics"]),
 ("Contentsquare id: uppercase or paths accepted", AN, 'const CS_FORMAT = /^[0-9a-f]{8,20}$/;', 'const CS_FORMAT = /^[0-9A-Za-z/.]{8,20}$/;', "tests/unit", ["analytics"]),
 ("Contentsquare id: length not bounded", AN, 'const CS_FORMAT = /^[0-9a-f]{8,20}$/;', 'const CS_FORMAT = /^[0-9a-f]{1,}$/;', "tests/unit", ["analytics"]),
 ("Contentsquare cookies: look-alikes (cs_id, _csx) taken", AN, '/^_cs_[A-Za-z0-9_.-]+$/', '/_cs/', "tests/unit", ["analytics"]),
 ("Contentsquare cookies listed twice", AN, '.filter((name) => /^_cs_[A-Za-z0-9_.-]+$/.test(name));\n  return [...new Set(names)];', '.filter((name) => /^_cs_[A-Za-z0-9_.-]+$/.test(name));\n  return names;', "tests/unit", ["analytics"]),
 ("Contentsquare alone in a page without a window does something", AN, '  const csId = win ? contentsquareId(doc) : "";', '  const csId = contentsquareId(doc);', "tests/unit", ["analytics"]),
 ("domains include the public suffix", AN, 'for (let i = 0; i < parts.length - 1; i++)', 'for (let i = 0; i < parts.length; i++)', "tests/unit", ["analytics"]),
 ("IP addresses get domains", AN, ' || /^\\d+(\\.\\d+){3}$/.test(host)', '', "tests/unit", ["analytics"]),
 ("host name not lowercased", AN, 'const host = String(hostname || "").toLowerCase();', 'const host = String(hostname || "");', "tests/unit", ["analytics"]),
 ("six months become a year", AN, 'export const CHOICE_DAYS = 183;', 'export const CHOICE_DAYS = 365;', "tests/unit", ["analytics"]),
 ("cookies of Google kept two years", AN, 'export const COOKIE_SECONDS = 34128000;', 'export const COOKIE_SECONDS = 63072000;', "tests/unit", ["analytics"]),
]

# Variantes de scripts/build.mjs : tests/consent.js (la suite lit PIXCAR_BUILD)
B = [
 ("Google in script-src of every build", '...(ga ? GOOGLE_SCRIPT : [])', '...GOOGLE_SCRIPT', "M09"),
 ("Google in connect-src of every build", '...(ga ? GOOGLE_CONNECT : [])', '...GOOGLE_CONNECT', "M09"),
 ("bare analytics.google.com missing from connect-src (a wildcard does not cover it: found by M112)", '"https://analytics.google.com", ', '', "M112"),
 ("script-src open to all of google.com", 'const GOOGLE_SCRIPT = ["https://www.googletagmanager.com"];', 'const GOOGLE_SCRIPT = ["https://www.googletagmanager.com", "https://*.google.com"];', "M07"),
 ("the published build ignores src/analytics.json", 'pages !== undefined ? config.measurementId ?? "" : ""', '""', "M05"),
 ("every build takes src/analytics.json", 'pages !== undefined ? config.measurementId ?? "" : ""', 'config.measurementId ?? ""', "M05"),
 ("an empty PIXCAR_GA_ID does not switch the measurement off", 'const fromEnv = process.env.PIXCAR_GA_ID;', 'const fromEnv = process.env.PIXCAR_GA_ID || undefined;', "M06"),
 ("a malformed identifier is accepted", 'if (!/^G-[A-Z0-9]{6,12}$/.test(id)) throw new Error(', 'if (false) throw new Error(', "M03"),
 ("no privacy window needed for the measurement", 'if ((apiBase || audience || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")', 'if ((apiBase || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")', "M04"),
 ("no privacy window needed for Contentsquare alone", 'const audience = !!(analytics || contentsquare);', 'const audience = !!analytics;', "M124"),
 ("both text variants kept", '((mode === "on") === variantOn[flag]() ? text : "")', '(text)', "M91"),
 ("nested text variants not resolved (a GA block inside the AU block)", 'for (let prev = null; prev !== html; ) [prev, html] = [html, variantOnce(html)];', 'html = variantOnce(html);', "M90"),
 ("the banner and text name Google Analytics even when only Contentsquare is there", 'tools: [analytics && "Google Analytics", contentsquare && "Contentsquare"]', 'tools: ["Google Analytics", contentsquare && "Contentsquare"]', "M122"),
 ("the data go « to Google » even without it", 'recipients: [analytics && "Google", contentsquare && "Contentsquare"]', 'recipients: ["Google", contentsquare && "Contentsquare"]', "M122"),
 ("Contentsquare in the policy of every build", '...(cs ? CS_SCRIPT : [])', '...CS_SCRIPT', "M126"),
 ("Contentsquare connections missing from the policy", '...(cs ? CS_CONNECT : [])', '', "M115"),
 ("only contentsquare.net may receive data (contentsquare.com refused)", 'const CS_CONNECT = ["https://*.contentsquare.net", "https://*.contentsquare.com"];', 'const CS_CONNECT = ["https://*.contentsquare.net"];', "M115"),
 ("no blob: worker for Contentsquare's recordings", '`worker-src \'self\'${cs ? " blob:" : ""}`', '"worker-src \'self\'"', "M115"),
 ("blob: workers allowed in every build", '`worker-src \'self\'${cs ? " blob:" : ""}`', '"worker-src \'self\' blob:"', "M126"),
 ("script-src opened to every host", 'const CS_SCRIPT = ["https://*.contentsquare.net", "https://app.contentsquare.com"];', 'const CS_SCRIPT = ["https://*.contentsquare.net", "https://app.contentsquare.com", "https:"];', "M126"),
 ("the published build ignores contentsquareId", 'pages !== undefined ? config.contentsquareId ?? "" : ""', '""', "M125"),
 ("every build takes contentsquareId", 'pages !== undefined ? config.contentsquareId ?? "" : ""', 'config.contentsquareId ?? ""', "M121"),
 ("an empty PIXCAR_CS_ID does not switch Contentsquare off", 'const fromEnv = process.env.PIXCAR_CS_ID;', 'const fromEnv = process.env.PIXCAR_CS_ID || undefined;', "M125"),
 ("a malformed Contentsquare identifier is accepted", 'if (!/^[0-9a-f]{8,20}$/.test(id)) throw new Error(', 'if (false) throw new Error(', "M123"),
 ("Contentsquare retention of src/analytics.json ignored", 'return { id, retentionMonths: months };', 'return { id, retentionMonths: 99 };', "M139"),
 ("Contentsquare identifier not written in the page", 'CS_ID: contentsquare ? contentsquare.id : "",', 'CS_ID: "",', "M120"),
 ("retention from src/analytics.json ignored", 'return { id, cookie: id.slice(2), retentionMonths: months };', 'return { id, cookie: id.slice(2), retentionMonths: 99 };', "M90"),
 ("cookie name not derived from the identifier", 'return { id, cookie: id.slice(2), retentionMonths: months };', 'return { id, cookie: id, retentionMonths: months };', "M90"),
 ("banner left out of the page", 'consent: audience ? fillAudience(variants(await read(SRC, "partials/consent.html")), "partials/consent.html") : ""', 'consent: ""', "M02"),
 ("identifier not written in the page", 'GA_ID: analytics ? analytics.id : "",', 'GA_ID: "",', "M02"),
 ("link to the choice left out of the panel", "${audience ? '<span aria-hidden=\"true\"> · </span>", "${false ? '<span aria-hidden=\"true\"> · </span>", "M70"),
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
            r = subprocess.run(["node", "tests/consent.js"], cwd=ROOT, capture_output=True, text=True, timeout=900, env={**os.environ, "PIXCAR_BUILD": "scripts/.build.mut.mjs"})
            fails = re.findall(r"FAIL: (\S+)", r.stdout)
            crashed = r.returncode != 0 and not fails
            ok = any(f.startswith(must) for f in fails)
            note = ", ".join(sorted(set(fails))) or "aucun"
            if crashed:
                # la suite s'est arrêtée : si la construction elle-même refuse la variante (garde-fou du texte : un {{ga.…}}, {{cs.…}} ou {{au.…}} hors de
                # son bloc), elle est détectée par le build ; sinon c'est un plantage de la suite, qui ne prouve rien. Le garde-fou ne se déclenche que si
                # l'outil concerné est absent : on essaie sans outil, avec Google seul et avec Contentsquare seul.
                refused = None
                for ga, cs in (("", ""), ("G-TEST123456", ""), ("", "abc123def4567")):
                    direct = subprocess.run(["node", "scripts/.build.mut.mjs", "--only", "single", "--out", str(ROOT / ".mut" / "guard")], cwd=ROOT, capture_output=True, text=True, env={**os.environ, "PIXCAR_GA_ID": ga, "PIXCAR_CS_ID": cs})
                    m = re.search(r"hors d'un bloc <!--(GA|CS|AU):on-->", direct.stderr) if direct.returncode else None
                    if m:
                        refused = m.group(1)
                        break
                if refused:
                    ok, note = True, f"la construction refuse la variante (garde-fou des textes {refused}:on)"
                else:
                    note = "la suite s'est arrêtée (plantage, pas un contrôle) : " + (r.stderr.strip().splitlines() or [""])[-1][:80]
            print(f"[{'tuée' if ok else 'SURVIVANTE'}] {name:60s} attendu {must:5s} -> échecs : {note}", flush=True)
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
    run(M, "consent.js", 62)
