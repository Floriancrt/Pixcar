// Table de garages (Overture) ET fiches complétées par Mapbox, ensemble : chacune a sa suite (tests/garages.js, tests/mapbox-fiches.js) ; celle-ci vérifie ce
// qui n'existe que lorsque les deux sont actives. La table apporte des garages absents d'OpenStreetMap (téléphone et site, jamais d'horaires) : Mapbox
// peut compléter ce qui leur manque ; ce que la table a déjà donné n'est jamais écrasé ; chaque fiche coûte une requête au plus ; rien ne reste dans le navigateur ;
// chacune des deux se coupe sans gêner l'autre. Les tuiles et les réponses de Mapbox sont simulées (données fictives).
//   node tests/garages-mapbox.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert ses propres pages
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, ROOT, injectScript } = require("./harness");
const { OSM, oid, ovtId, R, TILES, FOUR, dayStr, indexOf } = require("./fixtures/garages-data");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 700));
};

const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = path.join(__dirname, ".out", "garages-mapbox-site");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src"); // les tests de mutation y mettent une copie modifiée des sources
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const TOKEN = ["pk", "eyJ1IjoicGl4Y2FyLXRlc3QifQ", "c2lnbmF0dXJlLWZpY3RpZg"].join("."); // jeton fictif, de la bonne forme
const LEGAL = {
  editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.",
  contact: "contact@exemple.test",
  hostPages: "GitHub, Inc. (GitHub Pages), États-Unis",
  hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------------------- construction
function site(name, token) {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  const env = { ...process.env, PIXCAR_API_BASE: "", PIXCAR_GA_ID: "" };
  delete env.PIXCAR_MAPBOX_STYLE;
  delete env.PIXCAR_MAPBOX_ENRICH;
  if (token) env.PIXCAR_MAPBOX_TOKEN = token;
  else delete env.PIXCAR_MAPBOX_TOKEN;
  execFileSync(process.execPath, [BUILD, "--only", "single", "--src", src, "--out", path.join(OUT, name)], { stdio: "pipe", env });
  return path.join(OUT, name);
}

// ---------------------------------------------------------------------------------------------------------------------------------- données fictives
// La table : celle de tests/fixtures/garages-data.js (dix lieux, cinq cases). Les lieux de Mapbox sont placés à côté de certains d'entre eux.
const north = (p, m) => ({ lat: p.lat + m / 111320, lon: p.lon });
const WEEK = (from, to, open, close) => Array.from({ length: to - from + 1 }, (_, i) => ({ open: { day: from + i, time: open }, close: { day: from + i, time: close } }));
const PLACES = [
  // Garage Martin (OpenStreetMap, rien) : la table lui a déjà donné téléphone, site et adresse ; Mapbox ne peut apporter que les horaires
  { name: "Garage Martin", ...north(R.martin, 15), metadata: { phone: "+33199001111", website: "https://www.garage-martin-mbx.test/", open_hours: { periods: WEEK(1, 5, "0900", "1730") } } },
  // Carrosserie du Soleil (la table seule : téléphone et site) : les horaires
  { name: "Carrosserie du Soleil", ...north(R.soleil, 12), metadata: { phone: "+33199002222", website: "https://www.soleil-mbx.test/", open_hours: { periods: WEEK(1, 6, "0800", "1800") } } },
  // Auto Service Sud (la table seule : téléphone) : les horaires et le site, pas le téléphone
  { name: "Auto Service Sud", ...north(R.sud, 18), metadata: { phone: "+33199003333", website: "https://www.auto-service-sud.test/?utm_source=x", open_hours: { periods: WEEK(1, 5, "0830", "1930") } } },
  // un lieu d'un AUTRE nom à 20 m du Garage de l'Ouest : refusé
  { name: "Atelier Lopez", ...north(R.ouest, 20), metadata: { phone: "+33199005555", website: "https://www.atelier-lopez.test/" } },
];
const MOCK = (extra = {}) => ({ elements: OSM, mapbox: { search: { places: PLACES, ...extra } } });
const SPEC = (o = {}) => ({ built: dayStr(20), tiles: TILES, extraIndex: { "150-20": 2, "100-30": 0 }, ...o });

// Le « serveur » de tuiles de la table (comme tests/garages.js)
async function tileServer(ctx, spec) {
  const hits = { index: 0, tiles: [] };
  const json = (o, status = 200) => ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(o) });
  await ctx.route("**/garages/**", async (route) => {
    const m = /\/garages\/(index|t\/(-?\d+--?\d+))\.json$/.exec(new URL(route.request().url()).pathname);
    if (!m) return route.fulfill({ status: 404, body: "" });
    if (!m[2]) {
      hits.index++;
      return route.fulfill(json(indexOf({ built: spec.built, tiles: spec.tiles, extra: spec.extraIndex })));
    }
    hits.tiles.push(m[2]);
    if (spec.tileDelay) await sleep(spec.tileDelay);
    return route.fulfill(json({ v: 1, g: spec.tiles[m[2]] || [] }));
  });
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------------------------- aides de page
const tilesIn = (page) => page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length > 0, null, { timeout: 8000 }).then(() => true, () => false);
const openCard = async (page, id) => { await page.click(`#list [data-id="${id}"] .g-main`); await page.waitForTimeout(120); };
const waitSettled = (page, id) => page.waitForFunction((i) => { const c = document.querySelector(`#list [data-id="${CSS.escape(i)}"]`); return c && c.classList.contains("is-open") && c.querySelector("dl.facts") && !/Recherche…/.test(c.querySelector("dl.facts").textContent); }, id, { timeout: 6000 }).then(() => true, () => false);
const facts = (page, id) => page.evaluate((i) => {
  const c = document.querySelector(`#list [data-id="${CSS.escape(i)}"]`);
  const rows = {};
  if (c) c.querySelectorAll("dl.facts > dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    rows[dt.textContent.trim()] = { text: dd.textContent.replace(/\s+/g, " ").trim(), badge: dd.querySelectorAll(".fact-src").length, links: [...dd.querySelectorAll("a")].map((a) => a.getAttribute("href")) };
  });
  const call = c && c.querySelector(".act-call");
  const note = c && c.querySelector(".fact-note");
  return { rows, call: call ? call.getAttribute("href") : null, note: note ? note.textContent.replace(/\s+/g, " ").trim() : "" };
}, id);
const listIds = (page) => page.evaluate(() => [...document.querySelectorAll("#list > li.card")].map((c) => c.dataset.id));
const axeOf = async (page) => {
  await injectScript(page, AXE);
  return page.evaluate(async (tags) => (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 140)) })), TAGS);
};
const searchesOf = (ctx) => ctx.__counters.mapboxSearch;
const NOTE_ADDED = "Garage référencé par la base Overture Maps (Meta, Foursquare…), à titre indicatif : appelez avant de vous déplacer.";
const NOTE_FILLED = "Complété par la base Overture Maps, à titre indicatif : téléphone, site, adresse.";

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const both = await serve(site("both", TOKEN));
  const plain = await serve(site("plain", ""));
  const browser = await launch();
  // Ouvre la page construite, branche la table (tuiles simulées) et lance la recherche à Lyon (rayon de 10 km, tri par distance).
  const go = async (srv, { mock = MOCK(), init = "", spec = SPEC(), map = true, ...o } = {}) => {
    const r = await open(browser, srv, "index.html", { width: 1440, height: 900, mock, ...o, initScript: 'window.JG_CITY_LOOKUP=false;window.JG_GARAGES_BASE="garages/";' + init });
    r.hits = await tileServer(r.ctx, spec);
    await search(r.page, { service: "vidange", km: 10 });
    await r.page.click("[data-sort=dist]", { timeout: 1500 }).catch(() => {});
    await r.page.waitForTimeout(400);
    if (map) await tilesIn(r.page);
    return r;
  };
  try {
    // ===== H. les deux actives : le parcours complet =====
    {
      const { page, ctx, logs, hits } = await go(both);
      const ids = await listIds(page);
      check("H1 both active: the list is the table's (nine garages: OpenStreetMap's five + four added) and Mapbox draws the map", ids.length === 9 && ids.filter((i) => /^custom:ovt-/.test(i)).length === 4 && hits.index === 1 && [...hits.tiles].sort().join() === FOUR.join() && ctx.__counters.mapbox.length > 0, JSON.stringify({ n: ids.length, hits, tiles: ctx.__counters.mapbox.length }));
      check("H2 opening the list asks Mapbox for nothing: a request is made when a card is opened, not before", searchesOf(ctx).length === 0, String(searchesOf(ctx).length));

      // un garage de la table (téléphone et site, pas d'horaires) : Mapbox apporte les horaires, rien d'autre
      await openCard(page, ovtId(5));
      const settled = await waitSettled(page, ovtId(5));
      const f5 = await facts(page, ovtId(5));
      const u = searchesOf(ctx)[0] ? new URL(searchesOf(ctx)[0]) : null;
      const [w, s, e, n] = u ? (u.searchParams.get("bbox") || "").split(",").map(Number) : [];
      check("H3 a garage added by the table is completed by Mapbox: one request, around THAT garage (the table's position), and the hours appear with the « Mapbox » mention", settled && searchesOf(ctx).length === 1 && u && u.pathname === "/search/searchbox/v1/category/auto_repair" && w < R.soleil.lon && R.soleil.lon < e && s < R.soleil.lat && R.soleil.lat < n && /^lun-sam 08:00-18:00/.test(f5.rows["Horaires"].text) && f5.rows["Horaires"].badge === 1, JSON.stringify({ n: searchesOf(ctx).length, f5: f5.rows }));
      check("H4 …the phone and the site the table gave are NOT overwritten (Mapbox's differ), they carry no « Mapbox » mention, the call button keeps the table's number", /^04 72 00 00 05/.test(f5.rows["Téléphone"].text) && f5.rows["Téléphone"].badge === 0 && f5.rows["Site"].badge === 0 && f5.rows["Site"].links[0] === "https://carrosserie-soleil.example/" && f5.call === "tel:+33472000005", JSON.stringify(f5));
      check("H5 …and the card keeps saying that the garage comes from the Overture Maps base, to be taken as an indication", f5.note === NOTE_ADDED, f5.note);

      // un garage de la table qui n'a que le téléphone : horaires et site, pas le téléphone
      await openCard(page, ovtId(7));
      await waitSettled(page, ovtId(7));
      const f7 = await facts(page, ovtId(7));
      check("H6 a garage of the table with a phone only gets the hours and the site from Mapbox (the tracking parameter dropped), with the mention; its phone stays the table's", /^04 72 00 00 07/.test(f7.rows["Téléphone"].text) && f7.rows["Téléphone"].badge === 0 && /^lun-ven 08:30-19:30/.test(f7.rows["Horaires"].text) && f7.rows["Horaires"].badge === 1 && f7.rows["Site"].links[0] === "https://www.auto-service-sud.test/" && f7.rows["Site"].badge === 1 && searchesOf(ctx).length === 2, JSON.stringify({ n: searchesOf(ctx).length, f7: f7.rows }));

      // un garage d'OpenStreetMap que la table a complété : Mapbox n'apporte que les horaires
      await openCard(page, oid(1));
      await waitSettled(page, oid(1));
      const f1 = await facts(page, oid(1));
      check("H7 an OpenStreetMap garage the table completed (phone, site, address) gets only its hours from Mapbox; the table's phone and site stay, and the card still says what the table completed", /^05 61 00 00 01/.test(f1.rows["Téléphone"].text) && f1.rows["Téléphone"].badge === 0 && f1.rows["Site"].links[0] === "https://garage-martin.example/" && f1.rows["Site"].badge === 0 && /^lun-ven 09:00-17:30/.test(f1.rows["Horaires"].text) && f1.rows["Horaires"].badge === 1 && f1.note === NOTE_FILLED && searchesOf(ctx).length === 3, JSON.stringify({ n: searchesOf(ctx).length, f1 }));

      // un lieu d'un autre nom à côté : refusé
      await openCard(page, ovtId(8));
      await waitSettled(page, ovtId(8));
      const f8 = await facts(page, ovtId(8));
      check("H8 a place of ANOTHER name 20 m from a table garage is not taken (a wrong number is worse than none): the hours stay unknown, no mention", searchesOf(ctx).length === 4 && /Non renseignés/.test(f8.rows["Horaires"].text) && f8.rows["Horaires"].badge === 0 && f8.rows["Site"].links[0] === "https://garage-ouest.example/" && f8.note === NOTE_ADDED, JSON.stringify({ n: searchesOf(ctx).length, f8 }));

      // aucun lieu autour
      await openCard(page, ovtId(9));
      await waitSettled(page, ovtId(9));
      const f9 = await facts(page, ovtId(9));
      check("H9 no Mapbox place around a table garage: nothing changes, no error on the card", /Non renseignés/.test(f9.rows["Horaires"].text) && f9.rows["Horaires"].badge === 0 && f9.note === NOTE_ADDED && searchesOf(ctx).length === 5, JSON.stringify({ n: searchesOf(ctx).length, f9 }));

      // une seule requête par garage et par visite
      const total = searchesOf(ctx).length;
      for (const id of [ovtId(5), ovtId(7), oid(1)]) {
        await openCard(page, id); // referme la fiche ouverte (une seule à la fois) ; ouvre celle-ci
        await openCard(page, id);
        await openCard(page, id);
        await waitSettled(page, id);
      }
      await openCard(page, ovtId(5)); // referme la fiche ouverte (la dernière) et rouvre celle-ci : ses lignes ne sont dans la page que fiche ouverte
      await waitSettled(page, ovtId(5));
      await page.waitForTimeout(300);
      const again = await facts(page, ovtId(5));
      check("H10 reopening cards asks nothing more (one request per garage and per visit: five garages, five requests) and the completed hours come back with their mention", searchesOf(ctx).length === total && total === 5 && /^lun-sam 08:00-18:00/.test(again.rows["Horaires"].text) && again.rows["Horaires"].badge === 1, JSON.stringify({ total, n: searchesOf(ctx).length, again: again.rows }));

      // rien sur le disque : ni la table, ni Mapbox
      const stored = await page.evaluate(async () => {
        const dump = [];
        for (const area of [localStorage, sessionStorage]) for (let i = 0; i < area.length; i++) dump.push(area.key(i) + "=" + area.getItem(area.key(i)));
        const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
        return { text: dump.join("\n"), dbs };
      });
      check("H11 nothing from the table nor from Mapbox is kept in the browser: no number, address, site or hours of either in localStorage / sessionStorage, no database", !/561000001|472000005|472000007|199001111|199002222|199003333|08:00-18:00|08:30-19:30|09:00-17:30|carrosserie-soleil|auto-service-sud|garage-martin|soleil-mbx|rue du Soleil/i.test(stored.text) && stored.dbs.length === 0, JSON.stringify({ keys: stored.text.split("\n").map((l) => l.slice(0, 40)), dbs: stored.dbs }));
      check("H12 no script error, no console error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify({ errors: logs.errors, console: logs.console }));
      const viol = await axeOf(page);
      check("H13 the cards of a table garage completed by Mapbox have no accessibility violation (axe)", viol.length === 0, JSON.stringify(viol));
      await ctx.close();
    }

    // ===== I. chacune se coupe sans gêner l'autre =====
    {
      const { page, ctx, hits } = await go(both, { init: "window.JG_GARAGES=false;" });
      await openCard(page, oid(1));
      await waitSettled(page, oid(1));
      const f = await facts(page, oid(1));
      check("I1 table off (window.JG_GARAGES = false): five OpenStreetMap garages, no tile request; Mapbox alone completes the blank garage — phone, hours and site, three mentions, no Overture note", (await listIds(page)).length === 5 && hits.index === 0 && hits.tiles.length === 0 && searchesOf(ctx).length === 1 && /^01 99 00 11 11/.test(f.rows["Téléphone"].text) && f.rows["Téléphone"].badge === 1 && f.rows["Horaires"].badge === 1 && f.rows["Site"].badge === 1 && f.note === "", JSON.stringify({ n: searchesOf(ctx).length, f }));
      await ctx.close();
    }
    {
      const { page, ctx, hits } = await go(both, { init: "window.JG_MAPBOX_ENRICH=false;" });
      await openCard(page, ovtId(5));
      await page.waitForTimeout(600);
      const f = await facts(page, ovtId(5));
      check("I2 Mapbox completion off (window.JG_MAPBOX_ENRICH = false): the table still adds its four garages, no search request, the hours stay « Non renseignés »", (await listIds(page)).length === 9 && hits.tiles.length === 4 && searchesOf(ctx).length === 0 && /Non renseignés/.test(f.rows["Horaires"].text) && f.rows["Horaires"].badge === 0 && f.note === NOTE_ADDED, JSON.stringify({ n: searchesOf(ctx).length, f }));
      await ctx.close();
    }
    {
      const { page, ctx } = await go(plain, { map: false });
      await openCard(page, ovtId(5));
      await page.waitForTimeout(600);
      const f = await facts(page, ovtId(5));
      check("I3 a build without a Mapbox token: the table works, Mapbox is never called (no tile, no search), the table garage keeps « Non renseignés »", (await listIds(page)).length === 9 && ctx.__counters.mapbox.length === 0 && searchesOf(ctx).length === 0 && /Non renseignés/.test(f.rows["Horaires"].text) && f.note === NOTE_ADDED && ctx.__counters.other.every((u) => !/mapbox/.test(u)), JSON.stringify({ tiles: ctx.__counters.mapbox.length, s: searchesOf(ctx).length, f }));
      await ctx.close();
    }
    {
      // jeton refusé : on s'arrête net, la table n'en souffre pas
      const { page, ctx } = await go(both, { mock: MOCK({ status: 401 }) });
      for (const id of [ovtId(5), ovtId(7)]) { await openCard(page, id); await waitSettled(page, id); await page.waitForTimeout(100); }
      const f = await facts(page, ovtId(7));
      check("I4 token refused (401): one request, none for the next card; the table garage keeps what the table gave (phone, site), no error", searchesOf(ctx).length === 1 && /^04 72 00 00 07/.test(f.rows["Téléphone"].text) && /Non renseignés/.test(f.rows["Horaires"].text) && f.rows["Horaires"].badge === 0 && f.note === NOTE_ADDED, JSON.stringify({ n: searchesOf(ctx).length, f }));
      await ctx.close();
    }
    {
      // réponse de Mapbox lente : la fiche d'un garage de la table dit « Recherche… » puis se complète, sans bloquer la liste
      const { page, ctx } = await go(both, { mock: MOCK({ delay: 700 }) });
      await openCard(page, ovtId(5));
      await page.waitForTimeout(150);
      const busy = await facts(page, ovtId(5));
      await waitSettled(page, ovtId(5));
      const done = await facts(page, ovtId(5));
      check("I5 while Mapbox answers (slowly) the hours of a table garage say « Recherche… », the phone and site stay readable; then the hours appear", /Recherche…/.test(busy.rows["Horaires"].text) && /^04 72 00 00 05/.test(busy.rows["Téléphone"].text) && /^lun-sam 08:00-18:00/.test(done.rows["Horaires"].text), JSON.stringify({ busy: busy.rows, done: done.rows }));
      await ctx.close();
    }
  } finally {
    await browser.close();
    for (const s of [both, plain]) s.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[garages-mapbox] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
