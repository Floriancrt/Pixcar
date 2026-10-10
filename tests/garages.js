// Table de garages (Overture Maps) dans la page : des tuiles statiques lues à côté d'OpenStreetMap, jamais à la place de ce qu'OpenStreetMap sait.
// Ce que la suite vérifie : rien n'est demandé sans balise ni interrupteur ; les cases voulues (et elles seules) sont lues ; un garage d'OpenStreetMap
// n'est complété que de ce qui lui manque ; un garage absent d'OpenStreetMap est ajouté, sauf doublon ; les fiches le disent ; une case qui échoue,
// un index absent ou périmé, une table lente ne cassent ni ne retardent la liste (aucune erreur affichée) ; la table remplace OpenStreetMap quand
// celui-ci ne répond pas ; l'adresse manquante est cherchée comme pour OpenStreetMap ; une réparation déclarée chez un garage de la table est
// enregistrée sous un identifiant que l'API accepte ; rien de la table n'est gardé dans le navigateur ; un dossier de tuiles venu d'un autre hôte est refusé.
// Les tuiles sont simulées ici (tests/garages-build.js construit un vrai site avec de vraies tuiles).
//   node tests/garages.js
const { serve, launch, open, search, shot, ROOT, injectScript, markerPoint, sortBy, editSearch } = require("./harness");
const { OSM, oid, ovtId, R, TILES, FOUR, dayStr, indexOf } = require("./fixtures/garages-data");
const fs = require("fs"), path = require("path");
const FILE = process.argv[2] || process.env.FILE || "index.html";
const SECS = process.argv[3] || ""; // sections à lancer (lettres A à I), toutes si vide : utilisé par le lanceur de mutations
const has = (s) => !SECS || SECS.includes(s);
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 700)); };
const W = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let GARAGE_ID_RE; // src/js/shared/rules.js : ce que l'API accepte (lu là, pas recopié)

// ---------------------------------------------------------------------------------------------------------------------------------- données
// OpenStreetMap : cinq garages ; la table : dix lieux dans cinq cases (tests/fixtures/garages-data.js, partagé avec tests/garages-build.js).
const SPEC = (o = {}) => ({ built: dayStr(20), tiles: TILES, extraIndex: { "150-20": 2, "100-30": 0 }, ...o });

// Le « serveur » de tuiles : répond à /garages/index.json et /garages/t/<case>.json, compte les demandes.
// spec : built, tiles, extraIndex, indexStatus, indexBody, tileDelay, failTimes { case: n échecs avant de répondre }, failAlways { case: statut }
async function tileServer(ctx, spec) {
  const hits = { index: 0, tiles: [], other: [] };
  const failed = {};
  const json = (o, status = 200) => ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: typeof o === "string" ? o : JSON.stringify(o) });
  await ctx.route("**/garages/**", async (route) => {
    const u = new URL(route.request().url());
    const m = /\/garages\/(index|t\/(-?\d+--?\d+))\.json$/.exec(u.pathname);
    if (!m) { hits.other.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
    if (!m[2]) {
      hits.index++;
      if (spec.indexStatus) return route.fulfill({ status: spec.indexStatus, body: "" });
      if (spec.indexBody !== undefined) return route.fulfill(json(spec.indexBody));
      return route.fulfill(json(indexOf({ built: spec.built, tiles: spec.tiles, extra: spec.extraIndex })));
    }
    const key = m[2];
    hits.tiles.push(key);
    if (spec.tileDelay) await sleep(spec.tileDelay);
    if (spec.failAlways && spec.failAlways[key]) return route.fulfill({ status: spec.failAlways[key], body: "" });
    if (spec.failTimes && (failed[key] || 0) < (spec.failTimes[key] || 0)) { failed[key] = (failed[key] || 0) + 1; return route.fulfill({ status: 503, body: "" }); }
    return route.fulfill(json({ v: 1, g: spec.tiles[key] || [] }));
  });
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------------------------- aides
const listNames = (page) => page.evaluate(() => [...document.querySelectorAll("#list > li.card")].map((c) => c.querySelector(".g-name").textContent.trim()));
const listIds = (page) => page.evaluate(() => [...document.querySelectorAll("#list > li.card")].map((c) => c.dataset.id));
const info = (page) => page.evaluate(() => (window.jgGarages ? window.jgGarages() : null));
const openCard = async (page, id) => { await page.click(`#list [data-id="${id}"] .g-main`); await page.waitForTimeout(120); };
const closeCard = async (page, id) => { await page.click(`#list [data-id="${id}"] .g-main`); await page.waitForTimeout(120); };
// Ce que la fiche ouverte montre.
const read = (page, id) => page.evaluate((id) => {
  const c = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`);
  if (!c) return null;
  const facts = {};
  c.querySelectorAll("dl.facts > dt").forEach((dt) => { const dd = dt.nextElementSibling; facts[dt.textContent.trim()] = dd ? dd.textContent.replace(/\s+/g, " ").trim() : ""; });
  const note = c.querySelector(".fact-note");
  const ad = c.querySelector("[data-ad]");
  const web = c.querySelector('dl.facts a[target="_blank"]:not([href*="google.com/maps"])');
  return {
    kind: c.querySelector(".kind").textContent.trim(),
    callHref: c.querySelector(".act-call") ? c.querySelector(".act-call").getAttribute("href") : "",
    phones: [...c.querySelectorAll("dl.facts a.phone")].map((a) => a.getAttribute("href")),
    webHref: web ? web.getAttribute("href") : "",
    hours: facts["Horaires"] || "",
    facts,
    addr: ad ? ad.textContent.replace(/\s+/g, " ").trim() : "",
    note: note ? note.textContent.replace(/\s+/g, " ").trim() : "",
  };
}, id);
const NOTE_ADDED = "Garage référencé par la base Overture Maps (Meta, Foursquare…), à titre indicatif : appelez avant de vous déplacer.";
const NOTE_FILLED = (f) => `Complété par la base Overture Maps, à titre indicatif : ${f}.`;
const storageDump = (page) => page.evaluate(() => {
  const out = {};
  for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) out[s === localStorage ? "L:" + s.key(i) : "S:" + s.key(i)] = s.getItem(s.key(i));
  return out;
});
const again = async (page) => { await editSearch(page); await page.click("#go"); await page.waitForSelector("#list > li", { timeout: 12000 }).catch(() => {}); await page.waitForTimeout(500); };
// Chromium écrit lui-même « Failed to load resource » pour toute réponse HTTP en échec (503, 404) : la page n'y peut rien. Ce qu'on exige : aucune exception.
const onlyLoadNotices = (logs) => logs.errors.length === 0 && logs.console.every((m) => /^\[error\] Failed to load resource: the server responded with a status of (404|503)/.test(m));

(async () => {
  ({ GARAGE_ID_RE } = await import(require("url").pathToFileURL(path.join(ROOT, "src/js/shared/rules.js")).href));
  const server = await serve(ROOT);
  const browser = await launch();
  const go = async ({ spec, mock = {}, init = "", base = true, search: s = {}, ...o } = {}) => {
    const r = await open(browser, server, FILE, { ...W, mock: { elements: OSM, ...mock }, ...o, initScript: "window.JG_CITY_LOOKUP=false;" + (base ? 'window.JG_GARAGES_BASE="garages/";' : "") + init });
    r.hits = await tileServer(r.ctx, spec || SPEC());
    // une liste qui n'arrive pas ne fait pas planter la suite : le contrôle suivant l'écrit (et un contrôle nommé échoue, pas une attente)
    await search(r.page, { service: "vidange", km: 10, ...s }).catch((e) => { r.searchError = String(e).slice(0, 160); });
    await sortBy(r.page, "dist").catch(() => {});
    await r.page.waitForTimeout(400);
    return r;
  };

  // ===== A. sans balise ni interrupteur : la table est éteinte, la page est celle d'avant =====
  let page, ctx, logs, hits;
  if (has("A")) {
  ({ page, ctx, logs, hits } = await go({ base: false }));
  check("A1 no pixcar-garages base: the list is OpenStreetMap's alone (5 garages)", (await listNames(page)).length === 5, JSON.stringify(await listNames(page)));
  check("A2 no request at all to the tile folder", hits.index === 0 && hits.tiles.length === 0 && logs.requests.every((u) => !/\/garages\//.test(u)), JSON.stringify([hits, logs.requests.filter((u) => /garages/.test(u))]));
  const a3 = await info(page);
  check("A3 window.jgGarages() exists and reports an idle table", a3 && a3.requests === 0 && a3.indexOk === false && !a3.recs, JSON.stringify(a3));
  await openCard(page, oid(1));
  const a4 = await read(page, oid(1));
  check("A4 an open card has no Overture note and keeps its blanks", a4 && a4.note === "" && a4.phones.length === 0 && /Non renseigné/.test(a4.facts["Téléphone"]) && /Non renseigné/.test(a4.facts["Site"]), JSON.stringify(a4));
  check("A5 the page carries an empty pixcar-garages meta (the build adds none without tiles)", await page.evaluate(() => { const m = document.querySelector('meta[name="pixcar-garages"]'); return !!m && m.content === ""; }));
  const attrib = () => page.evaluate(() => { const a = document.querySelector(".leaflet-control-attribution"); return a ? a.textContent.replace(/\s+/g, " ").trim() : null; });
  const a7 = await attrib();
  check("A6 the map credits OpenStreetMap alone", a7 && /Garages © les contributeurs d'OpenStreetMap/.test(a7) && !/Overture/.test(a7), a7);
  check("A7 no page error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
  await ctx.close();

  }
  // ===== B. table active : OpenStreetMap complété, garages ajoutés, doublon écarté =====
  if (has("B")) {
  ({ page, ctx, logs, hits } = await go({ mock: { reverse: { delayMs: 120 } } }));
  const c = ctx.__counters;
  check("B1 one index request, then exactly the four tiles of the 10 km disc (the far tile and the unknown ones are never asked for)", hits.index === 1 && [...hits.tiles].sort().join() === FOUR.join(), JSON.stringify(hits));
  const names = await listNames(page);
  check("B2 nine garages: the five of OpenStreetMap + four added; the duplicate, the far place and the one of a requested tile 20 km away are not there", names.length === 9 && !names.includes("Mécanique Express") && !names.includes("Garage Lointain") && !names.includes("Garage Éloigné Nord"), JSON.stringify(names));
  check("B3 sorted by distance, the added ones in their place among OpenStreetMap's", names.join("|") === ["Garage Martin", "Carrosserie du Soleil", "Auto Plus Lyon", "Garage Dubois", "Atelier 69", "Garage du Parc", "Auto Service Sud", "Auto Sud-Ouest", "Garage de l'Ouest"].join("|"), JSON.stringify(names));
  const ids = await listIds(page);
  check("B4 identifiers: osm:node/… kept for OpenStreetMap's, custom:ovt-<32 hex> for the table's (a form the API already accepts)", ids.filter((i) => /^osm:node\/93\d\d$/.test(i)).length === 5 && ids.filter((i) => /^custom:ovt-[0-9a-f]{32}$/.test(i) && GARAGE_ID_RE.test(i)).length === 4 && ids.includes(ovtId(5)) && ids.includes(ovtId(7)), JSON.stringify(ids));
  const b5 = await info(page);
  check("B5 counters: 8 places read, 3 matched, 2 completed, 4 added, 1 duplicate; 4 tiles, none failed; the build date is reported", b5 && b5.recs === 8 && b5.matched === 3 && b5.filled === 2 && b5.added === 4 && b5.dup === 1 && b5.tiles === 4 && b5.failed === 0 && b5.built === dayStr(20) && b5.indexOk === true, JSON.stringify(b5));

  await openCard(page, oid(1));
  const b6 = await read(page, oid(1));
  check("B6 Garage Martin (blank in OpenStreetMap): phone, site and address come from the table, the call button too", b6 && b6.phones.join() === "tel:+33561000001" && b6.callHref === "tel:+33561000001" && b6.webHref === "https://garage-martin.example/" && /12 rue de la Paix/i.test(b6.addr) && /69002 Lyon/.test(b6.addr), JSON.stringify(b6));
  check("B7 …and the card says what was completed, and that it is indicative", b6 && b6.note === NOTE_FILLED("téléphone, site, adresse"), b6 && b6.note);
  check("B8 the opening hours stay unknown (the table has none), nothing is made up", b6 && /Non renseignés/.test(b6.hours), b6 && b6.hours);
  await closeCard(page, oid(1));

  await openCard(page, oid(2));
  const b9 = await read(page, oid(2));
  check("B9 Auto Plus Lyon (complete in OpenStreetMap): its phone, site and address are kept, the table's different ones are ignored, no note", b9 && b9.phones.join() === "tel:+33472112233" && b9.webHref === "https://autoplus-lyon.example" && /4 rue Test/i.test(b9.addr) && b9.note === "", JSON.stringify(b9));
  await closeCard(page, oid(2));

  await openCard(page, oid(3));
  const b10 = await read(page, oid(3));
  check("B10 Garage Dubois (no phone only): the phone is added, the site and address stay OpenStreetMap's, the note names the phone alone", b10 && b10.phones.join() === "tel:+33478555555" && b10.webHref === "https://dubois.example" && /4 rue Test/i.test(b10.addr) && b10.note === NOTE_FILLED("téléphone"), JSON.stringify(b10));
  await closeCard(page, oid(3));

  await openCard(page, oid(4));
  const b11 = await read(page, oid(4));
  check("B11 Atelier 69 sits 27 m from another name of the table: no second garage, nothing borrowed from it", b11 && b11.phones.join() === "tel:+33472000004" && b11.note === "", JSON.stringify(b11));
  await closeCard(page, oid(4));

  await openCard(page, ovtId(5));
  const b12 = await read(page, ovtId(5));
  check("B12 Carrosserie du Soleil (table only): phone, site and street address of the table, hours unknown, marked as coming from Overture", b12 && b12.phones.join() === "tel:+33472000005" && b12.webHref === "https://carrosserie-soleil.example/" && /3 rue du Soleil/i.test(b12.addr) && /Non renseignés/.test(b12.hours) && b12.note === NOTE_ADDED, JSON.stringify(b12));
  check("B13 a body shop of the table is a body shop here too: labelled « Indépendant » like OpenStreetMap's, its services « à vérifier »", b12 && /Indépendant/.test(b12.kind), b12 && b12.kind);
  const b13b = await page.evaluate((id) => { const c = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`); return (c.querySelector(".svc") || {}).textContent || ""; }, ovtId(5));
  check("B13b …its service line says the service must be checked", /vérifier/i.test(b13b), b13b);
  await closeCard(page, ovtId(5));

  // une adresse de rue manquante est cherchée comme pour OpenStreetMap, une seule fois
  const reverse0 = c.reverse;
  await openCard(page, ovtId(7));
  await page.waitForFunction((id) => { const v = document.querySelector(`#list [data-id="${CSS.escape(id)}"] [data-ad]`); return v && !v.classList.contains("is-busy") && /≈/.test(v.textContent); }, ovtId(7), { timeout: 5000 }).catch(() => {});
  const b14 = await read(page, ovtId(7));
  check("B14 a table garage with no street address: one reverse lookup, shown as « ≈ … », like an OpenStreetMap garage", c.reverse === reverse0 + 1 && b14 && /^≈ Environ \d+ Rue du Test, 69007 Lyon$/.test(b14.addr), JSON.stringify([c.reverse - reverse0, b14]));
  check("B15 the lookup used the garage's own position", (() => { const q = new URLSearchParams(c.reverseUrls[c.reverseUrls.length - 1] || ""); return Math.abs(+q.get("lat") - R.sud.lat) < 2e-6 && Math.abs(+q.get("lon") - R.sud.lon) < 2e-6; })(), c.reverseUrls.slice(-1)[0]);
  await closeCard(page, ovtId(7));
  await openCard(page, ovtId(5)); await page.waitForTimeout(300);
  check("B16 a table garage that has its address triggers no lookup", c.reverse === reverse0 + 1, c.reverse - reverse0);
  await closeCard(page, ovtId(5));

  const mk = await markerPoint(page, 0);
  check("B17 the map carries one marker per garage of the list (table ones included)", mk && mk.n === 9, JSON.stringify(mk));
  const dump = await storageDump(page);
  const flat = Object.values(dump).join("\n");
  check("B18 nothing of the table is written in the browser: no table phone, site, identifier or name in local or session storage", !/33561000001|33478555555|33472000005|garage-martin\.example|carrosserie-soleil\.example|0a1b2c3d|Carrosserie du Soleil|Overture/i.test(flat), Object.keys(dump).join());
  check("B19 …and the OpenStreetMap cache still holds OpenStreetMap's own data only (the five blanks and phones as OpenStreetMap gave them)", (() => { const o = dump["L:jg.osm.v3"] || ""; return !!o && /Garage Martin/.test(o) && !/Soleil|33561000001|garage-martin/.test(o); })(), Object.keys(dump).join());
  const b23 = await page.evaluate(() => { const a = document.querySelector(".leaflet-control-attribution"); return a ? a.textContent.replace(/\s+/g, " ").trim() : null; });
  check("B19b the map credits Overture Maps next to OpenStreetMap once the table is on", b23 && /Garages © les contributeurs d'OpenStreetMap, Overture Maps/.test(b23), b23);
  check("B20 no request to any host that is not mocked, no page error", c.other.length === 0 && logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([c.other, logs.errors, logs.console]));

  // une réparation déclarée chez un garage qui n'est que dans la table
  await page.click("#addRepairBtn");
  await page.fill("#rGarage", "Carrosserie du Soleil");
  await page.waitForSelector("#rGarageList li[data-i]", { state: "visible" });
  await page.click("#rGarageList li[data-i='0']");
  await page.fill("#rModel", "peugeot 208");
  await page.fill("#rPlate", "ez108bc");
  await page.fill("#rYear", "2019");
  await page.fill("#rPrice", "89,90");
  await page.click("label[for=rSt4]");
  await page.click("#repairForm button[type=submit]");
  await page.waitForTimeout(500);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.repairs.v1") || "[]"));
  check("B21 a repair declared at a table-only garage keeps the garage's custom:ovt-… identifier (no rewriting: the API accepts it)", stored.length === 1 && stored[0].garageId === ovtId(5) && GARAGE_ID_RE.test(stored[0].garageId), JSON.stringify(stored.map((r) => r.garageId)));
  const b22 = await page.evaluate((id) => { const c = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`); return c ? c.querySelector(".g-price").textContent.replace(/\s+/g, " ").trim() : null; }, ovtId(5));
  check("B22 …and the card of that garage then shows the declared price", b22 && /89,90/.test(b22) && /Prix déclaré/.test(b22), b22);
  await shot(page, "gt-01-desktop");
  await ctx.close();

  }
  // ===== C. OpenStreetMap ne répond pas : la liste vient de la table, et la page le dit =====
  if (has("C")) {
  ({ page, ctx, logs, hits } = await go({ mock: { overpassFail: true, reverse: { delayMs: 50 } } }));
  const cn = await listNames(page);
  check("C1 OpenStreetMap down: the list is the table's eight places in the disc", cn.length === 8 && cn.includes("Garage Martin") && cn.includes("Garage Dubois SARL") && !cn.includes("Garage Lointain"), JSON.stringify(cn));
  const cids = await listIds(page);
  check("C2 all of them carry the table's identifiers", cids.every((i) => /^custom:ovt-[0-9a-f]{32}$/.test(i)), JSON.stringify(cids));
  const hint = await page.evaluate(() => [...document.querySelectorAll(".hint")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => /Overture/.test(t)));
  check("C3 a note on the results says OpenStreetMap did not answer and the list comes from Overture Maps, indicatively", hint.some((t) => /OpenStreetMap n'a pas répondu/.test(t) && /Overture Maps, à titre indicatif/.test(t)), JSON.stringify(hint));
  const cNoError = await page.evaluate(() => !document.querySelector("#list + .error, .err-box, [data-error]") && document.querySelectorAll("#list > li.card").length > 0);
  check("C4 no error state is shown in that case", cNoError);
  await ctx.close();

  }
  // ===== D. une case en échec : les autres servent, aucune erreur ; elle est redemandée à la recherche suivante =====
  if (has("D")) {
  ({ page, ctx, logs, hits } = await go({ spec: SPEC({ failTimes: { "183-58": 1 } }) }));
  const dn = await listNames(page);
  const d1 = await info(page);
  check("D1 one tile fails (503): the other three serve, the list has 8 garages and no error", dn.length === 8 && !dn.includes("Garage de l'Ouest") && d1 && d1.failed === 1 && d1.tiles === 4, JSON.stringify([dn, d1]));
  check("D2 nothing is shown about it: no exception, no message of the page (only the browser's own notice of the 503)", onlyLoadNotices(logs) && logs.console.length <= 1, JSON.stringify([logs.errors, logs.console]));
  await again(page);
  const dn2 = await listNames(page);
  check("D3 the next search asks the failed tile again (and only that one), and the garage appears", hits.tiles.filter((k) => k === "183-58").length === 2 && hits.tiles.length === 5 && hits.index === 1 && dn2.includes("Garage de l'Ouest"), JSON.stringify([hits, dn2]));
  await ctx.close();

  }
  // ===== E. index absent, périmé ou illisible : la table se tait =====
  if (has("E")) {
  ({ page, ctx, logs, hits } = await go({ spec: SPEC({ indexStatus: 404 }) }));
  check("E1 index missing (404): the list is OpenStreetMap's alone, no tile asked, no error", (await listNames(page)).length === 5 && hits.index === 1 && hits.tiles.length === 0 && onlyLoadNotices(logs) && logs.console.length <= 1, JSON.stringify([hits, logs.console]));
  await again(page);
  check("E2 a second search within the minute does not ask for the index again", hits.index === 1, hits.index);
  await ctx.close();

  ({ page, ctx, logs, hits } = await go({ spec: SPEC({ built: dayStr(200) }) }));
  check("E3 table built 200 days ago (the monthly build stopped): not used, no tile asked, the list is OpenStreetMap's", (await listNames(page)).length === 5 && hits.index === 1 && hits.tiles.length === 0, JSON.stringify(hits));
  await ctx.close();

  ({ page, ctx, logs, hits } = await go({ spec: SPEC({ indexBody: { ...indexOf({ built: dayStr(20), tiles: TILES }), v: 2 } }) }));
  check("E4 an index that differs only by its version number is ignored the same way", (await listNames(page)).length === 5 && hits.tiles.length === 0 && logs.errors.length === 0, JSON.stringify(hits));
  await ctx.close();

  }
  // ===== F. table lente : la liste n'attend pas au-delà du délai, la table sert à la recherche suivante =====
  if (has("F")) {
  ({ page, ctx, logs, hits } = await go({ spec: SPEC({ tileDelay: 3500 }), init: "window.JG_TUNE.tableWait=300;" }));
  const f1 = await info(page);
  check("F1 slow tiles (3.5 s, wait 0.3 s): the list is displayed without them, 5 garages, no error", (await listNames(page)).length === 5 && f1 && f1.tilesOk === 0 && hits.tiles.length === 4 && logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([f1, hits]));
  await page.waitForFunction(() => window.jgGarages().tilesOk === 4, null, { timeout: 10000 });
  await again(page);
  check("F2 once they have arrived, the next search uses them with no new request (the tile requests are kept)", (await listNames(page)).length === 9 && hits.tiles.length === 4 && hits.index === 1, JSON.stringify([hits, await listNames(page)]));
  await ctx.close();

  }
  // ===== G. interrupteur et dossier d'un autre hôte =====
  if (has("G")) {
  ({ page, ctx, logs, hits } = await go({ init: "window.JG_GARAGES=false;" }));
  check("G1 window.JG_GARAGES = false switches the table off even with a base: 5 garages, no request", (await listNames(page)).length === 5 && hits.index === 0 && hits.tiles.length === 0, JSON.stringify(hits));
  await ctx.close();

  ({ page, ctx, logs, hits } = await go({ init: 'window.JG_GARAGES_BASE="https://evil.example/garages/";' }));
  check("G2 a base on another host is refused (only a path of the site is accepted): no request to it, no request to the site's own folder either", (await listNames(page)).length === 5 && hits.index === 0 && logs.requests.every((u) => !/evil\.example/.test(u)) && ctx.__counters.other.every((u) => !/evil/.test(u)), JSON.stringify([hits, ctx.__counters.other, logs.requests.filter((u) => /evil/.test(u))]));
  await ctx.close();

  }
  // ===== H. accessibilité : la fiche avec la mention, thèmes clair et sombre ; mobile =====
  if (has("H")) {
  for (const scheme of ["light", "dark"]) {
    ({ page, ctx, logs } = await go({ colorScheme: scheme }));
    await openCard(page, ovtId(5));
    await injectScript(page, AXE);
    const ax = await page.evaluate(async () => { const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }); return r.violations.map((v) => v.id + "×" + v.nodes.length); });
    check(`H1 axe (${scheme}): no violation with a table card open`, ax.length === 0, JSON.stringify(ax));
    const note = await page.evaluate((id) => { const n = document.querySelector(`#list [data-id="${CSS.escape(id)}"] .fact-note`); if (!n) return null; const cs = getComputedStyle(n); return { size: parseFloat(cs.fontSize), color: cs.color }; }, ovtId(5));
    check(`H2 (${scheme}) the note is readable: at least 12 px`, note && note.size >= 12, JSON.stringify(note));
    if (scheme === "dark") await shot(page, "gt-02-desktop-dark");
    await ctx.close();
  }
  ({ page, ctx, logs } = await go({ width: 390, height: 844, dpr: 2, touch: true }));
  await page.tap(`#list [data-id="${ovtId(5)}"] .g-main`); await page.waitForTimeout(200);
  const hm = await read(page, ovtId(5));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check("H3 mobile: same card, the note shows, no horizontal overflow", hm && hm.note === NOTE_ADDED && !overflow && logs.errors.length === 0, JSON.stringify([hm && hm.note, overflow]));
  await shot(page, "gt-03-mobile");
  await ctx.close();

  }
  // ===== I. un rayon plus large : seules les cases de l'index sont demandées, le lieu d'une case demandée mais hors du rayon n'est pas montré =====
  if (has("I")) {
  ({ page, ctx, logs, hits } = await go({ search: { km: 20 } }));
  check("I1 at 20 km the disc meets six tiles but the index lists four of them: only those are asked for", hits.index === 1 && [...hits.tiles].sort().join() === FOUR.join(), JSON.stringify(hits));
  const in20 = await listNames(page);
  check("I2 the place of a requested tile that lies 20.7 km away is not shown (nine garages, as at 10 km)", in20.length === 9 && !in20.includes("Garage Éloigné Nord") && !in20.includes("Garage Lointain"), JSON.stringify(in20));
  await ctx.close();
  }

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[garages] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
