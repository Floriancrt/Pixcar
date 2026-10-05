// Fiches complétées par Mapbox : à l'ouverture d'une fiche de garage dont le téléphone, les horaires ou le site manquent, la page interroge Mapbox
// (Search Box, catégorie « auto_repair », zone de 150 m), rapproche le lieu par la position ET le nom, et ne remplit que ce qui manque, avec la mention
// « Mapbox ». Vérifié ici : construction (réglage « enrich », politique de sécurité, textes), une requête par garage, aucune pour une fiche complète ou sans
// jeton, rapprochement prudent (un autre nom n'est jamais retenu), champs déjà connus jamais écrasés, annuaires écartés, échecs et jeton refusé, mode « map » et
// « always », interrupteurs, rien conservé sur le disque, accessibilité. Mapbox lui-même n'est jamais joint : tests/mocks.js (opts.mapbox.search) sert des
// réponses dans la forme réelle de Search Box, avec des données fictives.
//   node tests/mapbox-fiches.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert ses propres pages
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, ROOT, injectScript } = require("./harness");
const { buildElements, CENTER } = require("./mocks");
const { serveDir } = require("./static-server");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 700));
};

const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = path.join(__dirname, ".out", "mapbox-fiches-site");
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

// ---------------------------------------------------------------------------------------------------------------------------------- construction
function prepare(name, file) {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(LEGAL));
  if (file) fs.writeFileSync(path.join(src, "mapbox.json"), JSON.stringify(file));
  return src;
}
const envOf = ({ token, enrich }) => {
  const env = { ...process.env, PIXCAR_API_BASE: "", PIXCAR_GA_ID: "" };
  delete env.PIXCAR_MAPBOX_STYLE;
  if (token === undefined) delete env.PIXCAR_MAPBOX_TOKEN;
  else env.PIXCAR_MAPBOX_TOKEN = token;
  if (enrich === undefined) delete env.PIXCAR_MAPBOX_ENRICH;
  else env.PIXCAR_MAPBOX_ENRICH = enrich;
  return env;
};
function site(name, { token, enrich, file, only = "single", pages } = {}) {
  const src = prepare(name, file);
  const args = [BUILD, "--only", only, "--src", src, "--out", path.join(OUT, name)];
  if (pages) args.push("--pages", pages);
  execFileSync(process.execPath, args, { stdio: "pipe", env: envOf({ token, enrich }) });
  return path.join(OUT, name, only === "dist" ? "dist" : "");
}
const attempt = (name, { token, enrich, file } = {}) => spawnSync(process.execPath, [BUILD, "--only", "single", "--src", prepare(name, file), "--out", path.join(OUT, name)], { encoding: "utf8", env: envOf({ token, enrich }) });
const metaOf = (dir) => {
  const m = /<meta name="pixcar-mapbox" content="([^"]*)" data-style="([^"]*)" data-enrich="([^"]*)">/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8"));
  return m ? { token: m[1], style: m[2], enrich: m[3] } : null;
};
const policyOf = (dir) => (/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8")) || [])[1] || "";
const directive = (policy, name) => ((policy.split("; ").find((d) => d.startsWith(name + " ")) || "").slice(name.length + 1).split(" "));
const norm = (t) => String(t).replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------------------------------- données fictives
// Huit garages et un garage du registre, espacés de 330 m, chacun avec son cas ; les lieux de Mapbox sont à côté (positions relatives).
const pos = (n) => ({ lat: CENTER.lat + 0.003 * n, lon: CENTER.lon + 0.0004 });
const north = (p, m) => ({ lat: p.lat + m / 111320, lon: p.lon });
const ADDR = { "addr:housenumber": "1", "addr:street": "rue de l'Essai", "addr:postcode": "69002", "addr:city": "Lyon" };
const node = (n, tags) => ({ type: "node", id: 9200 + n, ...pos(n), tags: { shop: "car_repair", ...ADDR, ...tags } });
const ID = (n) => `osm:node/${9200 + n}`;
const SIRET = "11122233300011";
const SID = "siret:" + SIRET;
const SPOS = pos(9);
const ELEMENTS = buildElements().concat([
  node(1, { name: "Garage Sans Rien" }), // ni téléphone, ni horaires, ni site
  node(2, { name: "Garage Complet", phone: "+33 4 72 00 00 02", opening_hours: "Mo-Fr 08:00-18:00", website: "https://www.garage-complet.test/" }), // rien à compléter
  node(3, { name: "Garage Voisin" }), // un lieu d'un AUTRE nom à 20 m : refusé
  node(4, { name: "Pneus Dupont", shop: "tyres", phone: "+33 4 72 00 00 04" }), // a un téléphone (qui ne doit pas être écrasé), pas d'horaires ni de site
  node(5, {}), // sans nom : un seul lieu à moins de 40 m
  node(6, { name: "Garage Annuaire" }), // le site que donne Mapbox est un annuaire : écarté
  node(7, { name: "Garage Lent" }), // pour les échecs
  node(8, { name: "Garage Absent" }), // aucun lieu autour
]);
const WEEK = (from, to, open, close) => Array.from({ length: to - from + 1 }, (_, i) => ({ open: { day: from + i, time: open }, close: { day: from + i, time: close } }));
const PLACES = [
  { name: "Garage Sans Rien", ...north(pos(1), 15), metadata: { phone: "+33199001234", website: "https://www.garage-sans-rien.test/?utm_source=x", open_hours: { periods: [...WEEK(1, 5, "0900", "1730"), ...WEEK(6, 6, "0900", "1200")] } } },
  { name: "Atelier Lopez", ...north(pos(3), 20), metadata: { phone: "+33199005555", website: "https://www.atelier-lopez.test/" } },
  { name: "Dupont Pneus", ...north(pos(4), 60), metadata: { phone: "+33199006666", website: "https://www.dupont-pneus.test/", open_hours: { periods: WEEK(1, 6, "0845", "1915") } } },
  { name: "Garage de la Place", ...north(pos(5), 25), metadata: { phone: "+33199007777" } },
  { name: "Garage Annuaire", ...north(pos(6), 10), metadata: { phone: "+33199008888", website: "https://frmap.org/lyon/123-garage-annuaire" } },
  { name: "Garage Lent", ...north(pos(7), 12), metadata: { phone: "+33199004444", open_hours: { periods: WEEK(1, 5, "1000", "1800") } } },
  { name: "Renard Automobiles", ...north(SPOS, 18), metadata: { phone: "+33199009999", website: "https://www.renard-auto.test/" } },
];
const SIRENE = [{ siret: SIRET, name: "RENARD AUTOMOBILES", lat: SPOS.lat, lon: SPOS.lon, adresse: "9 RUE DE L'ESSAI 69002 LYON" }];
const MOCK = (search = {}, extra = {}) => ({ elements: ELEMENTS, sireneItems: SIRENE, mapbox: { ...(extra.mapbox || {}), search: { places: PLACES, ...search } } });

// ---------------------------------------------------------------------------------------------------------------------------------- aides de page
const tilesIn = (page) => page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length > 0, null, { timeout: 8000 }).then(() => true, () => false);
const openCard = (page, id) => page.click(`#list [data-id="${id}"] .g-main`);
const waitSettled = (page, id) => page.waitForFunction((i) => { const c = document.querySelector(`#list [data-id="${CSS.escape(i)}"]`); return c && c.classList.contains("is-open") && c.querySelector("dl.facts") && !/Recherche…/.test(c.querySelector("dl.facts").textContent); }, id, { timeout: 6000 }).then(() => true, () => false);
const facts = (page, id) => page.evaluate((i) => {
  const c = document.querySelector(`#list [data-id="${CSS.escape(i)}"]`);
  const rows = {};
  if (c) c.querySelectorAll("dl.facts > dt").forEach((dt) => {
    const dd = dt.nextElementSibling;
    rows[dt.textContent.trim()] = { text: dd.textContent.replace(/\s+/g, " ").trim(), badge: dd.querySelectorAll(".fact-src").length, links: [...dd.querySelectorAll("a")].map((a) => a.getAttribute("href")) };
  });
  const call = c && c.querySelector(".act-call");
  return { rows, call: call ? call.getAttribute("href") : null, open: !!(c && c.classList.contains("is-open")) };
}, id);
const hasBadge = (f) => f.rows["Téléphone"].badge + f.rows["Horaires"].badge + f.rows["Site"].badge;
const axeOf = async (page) => {
  await injectScript(page, AXE);
  return page.evaluate(async (tags) => (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 140)) })), TAGS);
};
// Ouvre la page, lance la recherche, trie par distance (les garages d'essai sont les plus proches) et attend la carte quand elle doit s'afficher.
const opened = async (browser, srv, mock, o = {}) => {
  const r = await open(browser, srv, "index.html", { width: 1440, height: 900, mock, ...o });
  if (o.search && o.search.sirene) await r.page.click("#moreOpts > summary"); // « Plus d'ateliers » : la case du registre SIRENE y est
  await search(r.page, { service: "vidange", ...(o.search || {}) });
  await r.page.click("[data-sort=dist]");
  await r.page.waitForTimeout(400);
  if (o.map !== false) await tilesIn(r.page);
  return r;
};
const searchesOf = (ctx) => ctx.__counters.mapboxSearch;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ============ construction ============
  const plainDir = site("plain"); // pas de jeton
  const mappedDir = site("mapped", { token: TOKEN }); // réglage par défaut : « map »
  const alwaysDir = site("always", { token: TOKEN, enrich: "always" });
  const offDir = site("off", { token: TOKEN, enrich: "off" });
  const noMapboxDir = plainDir;
  check("F01 default build with a token: the page carries enrich=\"map\"; no token: an empty meta tag; PIXCAR_MAPBOX_ENRICH chooses « always » or « off »", JSON.stringify([metaOf(mappedDir), metaOf(plainDir), metaOf(alwaysDir), metaOf(offDir)].map((m) => m && [m.token === TOKEN ? "token" : m.token, m.enrich])) === JSON.stringify([["token", "map"], ["", ""], ["token", "always"], ["token", "off"]]), JSON.stringify([metaOf(mappedDir), metaOf(plainDir), metaOf(alwaysDir), metaOf(offDir)]));
  check("F02 an invalid enrich setting stops the build with a message that lists the values; so does a bad value in src/mapbox.json", (() => {
    const a = attempt("bad-env", { token: TOKEN, enrich: "yes" });
    const b = attempt("bad-file", { token: TOKEN, file: { accessToken: TOKEN, style: "mapbox/light-v11", enrich: "partout" } });
    return a.status !== 0 && /enrich/.test(a.stderr) && /off/.test(a.stderr) && /map/.test(a.stderr) && /always/.test(a.stderr) && b.status !== 0 && /enrich/.test(b.stderr);
  })());
  const fileOf = (enrich) => ({ accessToken: TOKEN, style: "mapbox/light-v11", ...(enrich ? { enrich } : {}) });
  const pubDir = site("pub", { pages: "pixcar.fr", only: "dist", file: fileOf("map") });
  const pubOffDir = site("pub-off", { pages: "pixcar.fr", only: "dist", file: fileOf("off") });
  const pubNoneDir = site("pub-none", { pages: "pixcar.fr", only: "dist", file: { accessToken: "", style: "mapbox/light-v11", enrich: "map" } });
  check("F03 the published site (--pages) takes the setting from src/mapbox.json (default « map » when absent)", (metaOf(pubDir) || {}).enrich === "map" && (metaOf(pubOffDir) || {}).enrich === "off" && (metaOf(site("pub-default", { pages: "pixcar.fr", only: "dist", file: fileOf() })) || {}).enrich === "map", JSON.stringify([metaOf(pubDir), metaOf(pubOffDir)]));
  const pol = policyOf(pubDir), polOff = policyOf(pubOffDir), polNone = policyOf(pubNoneDir);
  check("F04 content security policy: with enrichment api.mapbox.com joins connect-src (and only there: nothing else changes, nothing is opened wide); with enrich=off or no token the policy is the one without Mapbox", directive(pol, "connect-src").includes("https://api.mapbox.com") && !directive(polOff, "connect-src").some((h) => /mapbox/.test(h)) && polOff === polNone && pol.replace(" https://api.mapbox.com", "") === polOff && !/unsafe-eval/.test(pol) && !directive(pol, "script-src").some((h) => /mapbox/.test(h)) && !directive(pol, "img-src").some((h) => /mapbox/.test(h)), JSON.stringify({ pol: directive(pol, "connect-src"), off: directive(polOff, "connect-src") }));

  // ============ navigateur ============
  const plain = await serve(plainDir);
  const mapped = await serve(mappedDir);
  const always = await serve(alwaysDir);
  const off = await serve(offDir);
  const pubSrv = await serveDir(pubDir);
  const browser = await launch();
  try {
    // ---- textes
    {
      const texts = async (srv) => {
        const { page, ctx } = await open(browser, srv, "index.html", { mock: MOCK() });
        await search(page, { service: "vidange" });
        await page.waitForSelector(".legal-foot:not([hidden]) [data-open-legal]", { timeout: 4000 }).catch(() => {});
        await page.click(".legal-foot [data-open-legal]");
        await page.waitForFunction(() => document.getElementById("legalDlg").open);
        const legal = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
        await page.keyboard.press("Escape");
        const sources = norm(await page.evaluate(() => (document.querySelector("details.sources") || {}).textContent || ""));
        await ctx.close();
        return { legal, sources };
      };
      const t = { map: await texts(mapped), off: await texts(off), none: await texts(plain) };
      const mb = (s) => s.slice(s.indexOf("Mapbox, Inc."), s.indexOf("Mapbox, Inc.") + 900);
      check("F05 privacy text with enrichment: Mapbox also receives, when a card is opened, the position of that garage (a 150 m zone), the data appears with the « Mapbox » mention and is kept only during the visit", /quand vous ouvrez la fiche d'un garage dont le téléphone, les horaires ou le site ne sont pas connus/.test(t.map.legal) && /position de ce garage \(une zone de 150 m autour\)/.test(t.map.legal) && /mention « Mapbox »/.test(t.map.legal) && /que le temps de votre visite/.test(t.map.legal) && /hors de l'Union européenne/.test(mb(t.map.legal)), mb(t.map.legal));
      check("F06 …and without it (enrich=off, or no token) the text says nothing about garage positions nor about cards", !/position de ce garage/.test(t.off.legal) && !/position de ce garage/.test(t.none.legal) && /Mapbox, Inc\./.test(t.off.legal) && /hors de l'Union européenne/.test(mb(t.off.legal)), mb(t.off.legal));
      check("F07 « Sources et méthode » says that the phone, hours and site can come from Mapbox, with the mention and as an indication — only with enrichment", /la fiche les cherche chez Mapbox/.test(t.map.sources) && /mention « Mapbox »/.test(t.map.sources) && /à titre indicatif/.test(t.map.sources) && !/chez Mapbox/.test(t.off.sources) && !/chez Mapbox/.test(t.none.sources), t.map.sources.slice(t.map.sources.indexOf("Fond de carte"), t.map.sources.indexOf("Fond de carte") + 420));
    }

    // ---- sans jeton : Mapbox n'est jamais appelé
    {
      const { page, ctx } = await opened(browser, plain, MOCK(), { map: false });
      await openCard(page, ID(1));
      await page.waitForTimeout(500);
      const f = await facts(page, ID(1));
      check("F10 no token: opening a card calls Mapbox for nothing (neither tiles nor search) and the rows stay « Non renseigné »", ctx.__counters.mapbox.length === 0 && searchesOf(ctx).length === 0 && /Non renseigné/.test(f.rows["Téléphone"].text) && /Non renseignés/.test(f.rows["Horaires"].text) && /Non renseigné/.test(f.rows["Site"].text) && hasBadge(f) === 0 && ctx.__counters.other.every((u) => !/mapbox/.test(u)), JSON.stringify({ n: ctx.__counters.mapbox.length, s: searchesOf(ctx).length, f }));
      await ctx.close();
    }

    // ---- avec jeton, mode « map » : le parcours principal
    {
      const { page, ctx, logs } = await opened(browser, mapped, MOCK({ delay: 500 }));
      const c = ctx.__counters;
      await openCard(page, ID(1));
      await page.waitForTimeout(150);
      const busy = await facts(page, ID(1));
      check("F20 while the request is pending the three rows say « Recherche… »", ["Téléphone", "Horaires", "Site"].every((k) => /Recherche…/.test(busy.rows[k].text)), JSON.stringify(busy.rows));
      check("F21 the card has no « Appeler » button yet (no number known)", busy.call === null, String(busy.call));
      // les trois lignes de contact sont des zones « polite » mises à jour SUR PLACE : un lecteur d'écran annonce celles qui changent
      const live = await page.evaluate((i) => {
        const dds = [...document.querySelectorAll(`#list [data-id="${CSS.escape(i)}"] dl.facts > dd`)];
        dds.forEach((d, n) => { d.__mark = n; });
        return dds.map((d) => d.getAttribute("aria-live"));
      }, ID(1));
      check("F22 one request to Mapbox for the garage, and nothing else went to Mapbox but the tiles", searchesOf(ctx).length === 1 && c.other.every((u) => !/mapbox/.test(u)), JSON.stringify({ s: searchesOf(ctx).length, other: c.other.filter((u) => /mapbox/.test(u)) }));
      check("F22b …to the auto_repair category of Search Box, with the token, French, ten results at most, a 300 m square around the garage and the garage as proximity (no country, no session token)", (() => {
        const u = new URL(searchesOf(ctx)[0]);
        const [w, s, e, n] = (u.searchParams.get("bbox") || "").split(",").map(Number);
        const g = pos(1);
        const prox = (u.searchParams.get("proximity") || "").split(",").map(Number);
        return u.host === "api.mapbox.com" && u.pathname === "/search/searchbox/v1/category/auto_repair" && u.searchParams.get("access_token") === TOKEN && u.searchParams.get("language") === "fr" && u.searchParams.get("limit") === "10" && !u.searchParams.has("country") && !u.searchParams.has("session_token") && w < g.lon && g.lon < e && s < g.lat && g.lat < n && Math.abs((n - s) * 111320 - 300) < 2 && Math.abs(prox[0] - g.lon) < 2e-6 && Math.abs(prox[1] - g.lat) < 2e-6;
      })(), searchesOf(ctx)[0]);
      check("F23 the request is sent once the map shows Mapbox tiles, and the tiles are Mapbox's", c.mapbox.length > 0 && c.tiles === 0, JSON.stringify({ tiles: c.mapbox.length, ign: c.tiles }));
      await waitSettled(page, ID(1));
      const f = await facts(page, ID(1));
      check("F24 phone, hours and site are filled in, written the way the page writes them (« 01 99 00 12 34 », « lun-ven 09:00-17:30 · sam 09:00-12:00 », the host of the site)", /^01 99 00 12 34/.test(f.rows["Téléphone"].text) && f.rows["Téléphone"].links.includes("tel:+33199001234") && /^lun-ven 09:00-17:30 · sam 09:00-12:00/.test(f.rows["Horaires"].text) && /^garage-sans-rien\.test/.test(f.rows["Site"].text), JSON.stringify(f.rows));
      check("F25 each of the three rows carries the « Mapbox » mention; the site address has lost its tracking parameter", hasBadge(f) === 3 && f.rows["Site"].links[0] === "https://www.garage-sans-rien.test/", JSON.stringify(f.rows));
      check("F26 the card's « Appeler » button appears, with the number", f.call === "tel:+33199001234", String(f.call));
      const after = await page.evaluate((i) => [...document.querySelectorAll(`#list [data-id="${CSS.escape(i)}"] dl.facts > dd`)].map((d) => [d.__mark, d.getAttribute("aria-live")]), ID(1));
      check("F28 phone, hours and site are polite live regions, and the rows are updated in place (the same elements, not replaced): a screen reader announces what changed", live.filter((x) => x === "polite").length === 3 && after.filter(([m, l]) => m !== undefined && l === "polite").length === 3 && after.length === live.length, JSON.stringify({ live, after }));
      const badge = await page.evaluate((i) => {
        const b = document.querySelector(`#list [data-id="${CSS.escape(i)}"] .fact-src`);
        if (!b) return null;
        const cs = getComputedStyle(b), row = getComputedStyle(b.closest("dd"));
        return { text: b.textContent, title: b.getAttribute("title"), size: parseFloat(cs.fontSize), rowSize: parseFloat(row.fontSize), radius: parseFloat(cs.borderTopLeftRadius), wrap: cs.whiteSpace };
      }, ID(1));
      check("F27 the mention is text (not only a colour), says in its title that it is a third party's indication, and is a small discreet pill (smaller than the row, rounded, never split)", badge && badge.text === "Mapbox" && /Mapbox, à titre indicatif/.test(badge.title) && badge.size < badge.rowSize - 1 && badge.radius >= 10 && badge.wrap === "nowrap", JSON.stringify(badge));

      // fiche complète : aucune requête
      const before = searchesOf(ctx).length;
      await openCard(page, ID(2));
      await waitSettled(page, ID(2));
      await page.waitForTimeout(300);
      const f2 = await facts(page, ID(2));
      check("F30 a complete card (phone, hours and site known) makes no request and shows no mention", searchesOf(ctx).length === before && hasBadge(f2) === 0 && /^04 72 00 00 02/.test(f2.rows["Téléphone"].text) && /lun-ven 08:00-18:00/.test(f2.rows["Horaires"].text), JSON.stringify({ n: searchesOf(ctx).length, f2 }));

      // un lieu d'un autre nom : refusé
      await openCard(page, ID(3));
      await waitSettled(page, ID(3));
      const f3 = await facts(page, ID(3));
      check("F31 a place of ANOTHER name 20 m away is not taken: nothing is filled in, no mention, no « Appeler » button — a wrong number is worse than none", searchesOf(ctx).length === before + 1 && /Non renseigné/.test(f3.rows["Téléphone"].text) && /Non renseignés/.test(f3.rows["Horaires"].text) && hasBadge(f3) === 0 && f3.call === null, JSON.stringify(f3));

      // champ déjà connu : jamais écrasé
      await openCard(page, ID(4));
      await waitSettled(page, ID(4));
      const f4 = await facts(page, ID(4));
      check("F32 a phone OpenStreetMap already gives is never overwritten (Mapbox's number differs), only the hours and the site are added, with the mention", /^04 72 00 00 04/.test(f4.rows["Téléphone"].text) && f4.rows["Téléphone"].badge === 0 && f4.call === "tel:+33472000004" && /^lun-sam 08:45-19:15/.test(f4.rows["Horaires"].text) && f4.rows["Horaires"].badge === 1 && /dupont-pneus\.test/.test(f4.rows["Site"].text) && f4.rows["Site"].badge === 1, JSON.stringify(f4));

      // sans nom : le seul lieu à moins de 40 m
      await openCard(page, ID(5));
      await waitSettled(page, ID(5));
      const f5 = await facts(page, ID(5));
      check("F33 a garage without a name takes the only place within 40 m (phone only: the hours and the site stay « Non renseigné »)", /^01 99 00 77 77/.test(f5.rows["Téléphone"].text) && f5.rows["Téléphone"].badge === 1 && /Non renseignés/.test(f5.rows["Horaires"].text) && /Non renseigné/.test(f5.rows["Site"].text), JSON.stringify(f5));

      // annuaire écarté
      await openCard(page, ID(6));
      await waitSettled(page, ID(6));
      const f6 = await facts(page, ID(6));
      check("F34 a directory given as « website » (frmap.org) is not shown: the phone is added, the site stays « Non renseigné »", /^01 99 00 88 88/.test(f6.rows["Téléphone"].text) && /Non renseigné/.test(f6.rows["Site"].text) && f6.rows["Site"].badge === 0 && f6.rows["Site"].links.length === 0, JSON.stringify(f6.rows));

      // aucun lieu autour
      await openCard(page, ID(8));
      await waitSettled(page, ID(8));
      const f8 = await facts(page, ID(8));
      check("F35 no place around: the rows stay as they were, the request was made once", /Non renseigné/.test(f8.rows["Téléphone"].text) && hasBadge(f8) === 0, JSON.stringify(f8));

      // une seule requête par garage et par visite : rouvrir ne refait rien, et l'information revient avec sa mention
      const total = searchesOf(ctx).length;
      await openCard(page, ID(1)); // referme la fiche ouverte (une seule à la fois) et ouvre celle-ci
      await waitSettled(page, ID(1));
      await openCard(page, ID(1));
      await page.waitForTimeout(150);
      await openCard(page, ID(1));
      await waitSettled(page, ID(1));
      await page.waitForTimeout(300);
      const again = await facts(page, ID(1));
      check("F40 reopening cards makes no new request: one request per garage and per visit (6 garages with something missing, the complete one made none)", searchesOf(ctx).length === total && total === 6 && hasBadge(again) === 3 && /^01 99 00 12 34/.test(again.rows["Téléphone"].text), JSON.stringify({ total, n: searchesOf(ctx).length, again: again.rows }));

      // rien sur le disque
      const stored = await page.evaluate(async () => {
        const dump = [];
        for (const area of [localStorage, sessionStorage]) for (let i = 0; i < area.length; i++) dump.push(area.key(i) + "=" + area.getItem(area.key(i)));
        const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
        return { text: dump.join("\n"), dbs };
      });
      const cookies = await ctx.cookies();
      check("F41 nothing from Mapbox is kept on the disk: no phone number, hours or site of the answers in localStorage or sessionStorage, no database, no cookie from Mapbox", !/199001234|199006666|199007777|199008888|09:00-17:30|08:45-19:15|garage-sans-rien|dupont-pneus/i.test(stored.text) && !stored.dbs.some((n) => /mapbox/i.test(n)) && !cookies.some((k) => /mapbox/.test(k.domain)), JSON.stringify({ keys: stored.text.split("\n").map((l) => l.slice(0, 40)), dbs: stored.dbs, cookies: cookies.map((k) => k.domain) }));
      check("F42 no script error, no console error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify({ errors: logs.errors, console: logs.console }));
      // accessibilité, clair puis sombre : la mention, les lignes mises à jour
      const viol = await axeOf(page);
      check("F43 the card with the filled-in information has no accessibility violation (axe), light theme", viol.length === 0, JSON.stringify(viol));
      await ctx.close();
    }
    {
      const { page, ctx } = await opened(browser, mapped, MOCK(), { colorScheme: "dark" });
      await openCard(page, ID(1));
      await waitSettled(page, ID(1));
      const viol = await axeOf(page);
      const f = await facts(page, ID(1));
      check("F44 …and in the dark theme", hasBadge(f) === 3 && viol.length === 0, JSON.stringify(viol));
      await ctx.close();
    }

    // ---- garage du registre SIRENE (« Liste plus complète ») : aucun contact, donc complété
    {
      const { page, ctx } = await opened(browser, mapped, MOCK(), { search: { sirene: true } });
      await page.waitForSelector(`#list [data-id="${SID}"]`, { timeout: 8000 }).catch(() => {});
      await openCard(page, SID);
      await waitSettled(page, SID);
      const f = await facts(page, SID);
      check("F45 a garage of the SIRENE register (no contact at all) is completed the same way, by name and position", /^01 99 00 99 99/.test(f.rows["Téléphone"].text) && f.rows["Téléphone"].badge === 1 && /renard-auto\.test/.test(f.rows["Site"].text) && searchesOf(ctx).length === 1, JSON.stringify(f));
      await ctx.close();
    }

    // ---- échec réseau (500) : « Non renseigné », une nouvelle tentative à l'ouverture suivante
    {
      const { page, ctx } = await opened(browser, mapped, MOCK({ failFirst: 1 }));
      await openCard(page, ID(1));
      await waitSettled(page, ID(1));
      const first = await facts(page, ID(1));
      await openCard(page, ID(1)); // referme
      await page.waitForTimeout(150);
      await openCard(page, ID(1)); // rouvre : seconde tentative
      await waitSettled(page, ID(1));
      await page.waitForTimeout(300);
      const second = await facts(page, ID(1));
      await openCard(page, ID(1));
      await page.waitForTimeout(150);
      await openCard(page, ID(1));
      await waitSettled(page, ID(1));
      await page.waitForTimeout(250);
      check("F50 a failed request (HTTP 500) leaves the rows as they were, without error on the card; the next opening tries again, once it works nothing more is asked", hasBadge(first) === 0 && /Non renseigné/.test(first.rows["Téléphone"].text) && hasBadge(second) === 3 && searchesOf(ctx).length === 2, JSON.stringify({ first: first.rows["Téléphone"], second: second.rows["Téléphone"], n: searchesOf(ctx).length }));
      await ctx.close();
    }
    {
      const { page, ctx } = await opened(browser, mapped, MOCK({ abort: true }));
      for (const n of [1, 3, 7]) {
        await openCard(page, ID(n));
        await waitSettled(page, ID(n));
        await page.waitForTimeout(100);
      }
      const f = await facts(page, ID(7));
      check("F51 network down: no crash, the rows keep « Non renseigné », and after two failures in a row Mapbox is left alone for a minute (the third garage costs no request)", searchesOf(ctx).length === 2 && /Non renseigné/.test(f.rows["Téléphone"].text) && hasBadge(f) === 0, JSON.stringify({ n: searchesOf(ctx).length, f: f.rows }));
      await ctx.close();
    }

    // ---- jeton refusé (401) : on s'arrête net
    {
      const { page, ctx } = await opened(browser, mapped, MOCK({ status: 401 }));
      for (const n of [1, 3, 4]) {
        await openCard(page, ID(n));
        await waitSettled(page, ID(n));
        await page.waitForTimeout(100);
      }
      const f = await facts(page, ID(4));
      check("F52 token refused (401): a single request, then none for the following garages; the rows are untouched (OSM's phone stays)", searchesOf(ctx).length === 1 && /^04 72 00 00 04/.test(f.rows["Téléphone"].text) && /Non renseignés/.test(f.rows["Horaires"].text) && hasBadge(f) === 0, JSON.stringify({ n: searchesOf(ctx).length, f: f.rows }));
      await ctx.close();
    }

    // ---- mode « map » : seulement tant que la carte affiche des tuiles Mapbox
    {
      const { page, ctx } = await opened(browser, mapped, MOCK({}, { mapbox: { status: 401 } }), { map: false });
      await page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length > 0, null, { timeout: 8000 }).catch(() => {});
      await openCard(page, ID(1));
      await page.waitForTimeout(600);
      check("F60 mode « map »: when Mapbox refuses the tiles (the map falls back to the IGN) the cards are not completed either — no search request", ctx.__counters.tiles > 0 && searchesOf(ctx).length === 0, JSON.stringify({ ign: ctx.__counters.tiles, s: searchesOf(ctx).length }));
      await ctx.close();
    }
    const phone = { width: 390, height: 844, dpr: 2, touch: true };
    {
      const { page, ctx } = await opened(browser, mapped, MOCK(), { ...phone, map: false });
      await openCard(page, ID(1));
      await page.waitForTimeout(600);
      check("F61 mode « map » on a phone in list view (no map on screen, so no Mapbox background): no request", searchesOf(ctx).length === 0 && ctx.__counters.mapbox.length === 0, JSON.stringify({ s: searchesOf(ctx).length, tiles: ctx.__counters.mapbox.length }));
      await ctx.close();
    }
    {
      const { page, ctx } = await opened(browser, always, MOCK(), { ...phone, map: false });
      await openCard(page, ID(1));
      await waitSettled(page, ID(1));
      const f = await facts(page, ID(1));
      check("F62 mode « always »: the same phone in list view does complete the card (one request)", searchesOf(ctx).length === 1 && hasBadge(f) === 3 && ctx.__counters.mapbox.length === 0, JSON.stringify({ s: searchesOf(ctx).length, f: f.rows }));
      await ctx.close();
    }
    {
      const { page, ctx } = await opened(browser, always, MOCK({}, { mapbox: { status: 401 } }), { map: false });
      await page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length > 0, null, { timeout: 8000 }).catch(() => {});
      await openCard(page, ID(1));
      await page.waitForTimeout(600);
      check("F63 mode « always » stops too once the map has given Mapbox up for the IGN (tiles refused)", ctx.__counters.tiles > 0 && searchesOf(ctx).length === 0, JSON.stringify({ ign: ctx.__counters.tiles, s: searchesOf(ctx).length }));
      await ctx.close();
    }

    // ---- interrupteurs
    {
      const { page, ctx } = await opened(browser, off, MOCK());
      await openCard(page, ID(1));
      await page.waitForTimeout(600);
      const f = await facts(page, ID(1));
      check("F70 enrich=\"off\": Mapbox tiles still, but no search request and no mention", searchesOf(ctx).length === 0 && ctx.__counters.mapbox.length > 0 && hasBadge(f) === 0, JSON.stringify({ s: searchesOf(ctx).length, tiles: ctx.__counters.mapbox.length }));
      await ctx.close();
    }
    {
      const { page, ctx } = await opened(browser, mapped, MOCK(), { initScript: "window.JG_MAPBOX_ENRICH=false;" });
      await openCard(page, ID(1));
      await page.waitForTimeout(600);
      check("F71 window.JG_MAPBOX_ENRICH = false switches the completion off at run time", searchesOf(ctx).length === 0, String(searchesOf(ctx).length));
      await ctx.close();
    }

    // ---- site publié (GitHub Pages) : la politique de sécurité du contenu laisse passer la requête, et elle seule
    {
      const { page, ctx, logs } = await opened(browser, pubSrv, MOCK());
      await openCard(page, ID(1));
      const ok = await waitSettled(page, ID(1));
      const f = await facts(page, ID(1));
      check("F80 on the published build (with its content security policy) the request goes through and the card is completed: no policy violation in the console", ok && hasBadge(f) === 3 && searchesOf(ctx).length === 1 && !logs.console.some((l) => /Content Security Policy|Refused to connect/i.test(l)) && logs.errors.length === 0, JSON.stringify({ f: f.rows, console: logs.console }));
      await ctx.close();
    }
  } finally {
    await browser.close();
    for (const s of [plain, mapped, always, off, pubSrv]) s.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[mapbox-fiches] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
