// Chain avatars: branded monograms + logo tiers (Wikidata logo > official-site icon > monogram).
// Runs in "real" mode (harness.js): the services answer over a local HTTPS server, official sites included, because
// Playwright drops every */favicon.ico request while a route is active.
const { serve, launch, open, search, shot, ROOT } = require("./harness");
const { logoPNG, buildElements, CENTER } = require("./mocks");
const fs = require("fs"), path = require("path");
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600)); };
const FILE = process.env.FILE || "index.html";
// brand tables and chain ids parsed from the application source (single source of truth; the built page is minified)
const html = fs.readFileSync(path.join(ROOT, "src/js/app.js"), "utf8");
const table = (name) => { const m = html.match(new RegExp(name + " = \\{([\\s\\S]*?)\\n    \\}")); const o = {}; for (const r of m[1].matchAll(/(\w+): \["(#[0-9a-f]{6})", "([^"]+)"\]/g)) o[r[1]] = [r[2], r[3]]; return o; };
const BRAND = table("logoBrand"), CT = table("ctBrand");

const lum = (rgb) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgbOf = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const DARK = [17, 19, 21], WHITE = [255, 255, 255];

// two extra AD garages very close to the search point, so they are among the first cards
const extra = (n, name, dLat) => ({ type: "node", id: 9000 + n, lat: CENTER.lat + dLat, lon: CENTER.lon, tags: { name, shop: "car_repair", phone: "+33 4 72 00 00 0" + n, "addr:city": "Lyon" } });
const ELEMENTS = buildElements().concat([extra(1, "AD Garage Dupont", 0.0006), extra(2, "AD Expert Lumière", 0.0009)]);

const WD_LOGOS = [
  { q: "Q3317698", kind: 0, file: "Norauto icon.png" },                                 // norauto : icône Wikidata
  { q: "Q3312613", kind: 1, file: "Midas old.png", start: "2010-01-01T00:00:00Z" },    // midas : le plus récent gagne
  { q: "Q3312613", kind: 1, file: "Midas logo.png", start: "2020-01-01T00:00:00Z" },
  { q: "Q3393358", kind: 1, file: "Point S round.png" },                                // point s
  { q: "Q3434112", kind: 1, file: "Roady missing.png" },                                // roady : fichier 404 -> repli sur le site
  { q: "Q3060668", kind: 1, raw: "https://evil.example/logo.png" },                    // euromaster : hors Commons -> rejeté
];
const WD_SITES = [
  { q: "Q3492969", url: "https://www.speedy.fr/" },        // speedy : site officiel Wikidata (même domaine que les données de la page)
  { q: "Q108753388", url: "https://www.ad.fr/" },          // ad : site officiel Wikidata (domaine à 2 lettres)
  { q: "Q3070922", url: "javascript:alert(1)" },           // feu vert : schéma refusé
  { q: "Q3434112", url: "https://evil.example/" },         // roady : domaine étranger refusé
];
const ICONS = {
  "www.speedy.fr": { "/favicon.ico": { frames: [16, 32, 64], color: "#FFD100" } },     // apple-touch 404 ; .ico à 3 images, la plus grande compte
  "www.ad.fr": { "/favicon.ico": { frames: [16], color: "#D1001C" } },                 // 16 px seulement : refusé
  "www.roady.fr": { "/favicon.ico": { size: 48, color: "#F26522" } },                  // après un fichier Commons cassé
  "www.euromaster.fr": { "/apple-touch-icon.png": { size: 32, color: "#0057B8" } },    // 32 px pile : accepté
  "www.feuvert.fr": { "/apple-touch-icon.png": 200 },                                  // 200 sans image : illisible -> monogramme
};
const MOCK = { elements: ELEMENTS, logos: WD_LOGOS, sites: WD_SITES, siteIcons: ICONS, logo404: ["Roady missing.png"] };
const W = { width: 1440, height: 900, real: true };

const state = (page) => page.evaluate(() => {
  const g = {};
  for (const a of document.querySelectorAll(".avatar[data-c]")) {
    const id = a.dataset.c, o = (g[id] = g[id] || { n: 0, logo: 0, brand: 0, text: a.textContent.trim(), loaded: 0 });
    o.n++; a.classList.contains("has-logo") && o.logo++; a.classList.contains("mono") && o.brand++;
    const i = a.querySelector("img.lg"); if (i && i.complete && i.naturalWidth > 0) o.loaded++;
  }
  const plain = [...document.querySelectorAll(".avatar:not([data-c])")];
  return { g, plain: plain.length, plainBrand: plain.filter((a) => a.classList.contains("mono")).length };
});
const has2 = (st, k) => st.g[k] && st.g[k].logo === st.g[k].n && st.g[k].loaded === st.g[k].n;
const none2 = (st, k) => st.g[k] && st.g[k].logo === 0 && st.g[k].brand === st.g[k].n;
const waitIds = (page, ids) => page.waitForFunction((ids) => ids.every((id) => { const a = [...document.querySelectorAll(`.avatar[data-c="${id}"]`)]; return a.length && a.every((x) => x.querySelector("img.lg") && x.querySelector("img.lg").complete); }), ids, { timeout: 6000 }).catch(() => {}); // a missing logo must show up as a failed check, not as a crash
const chainRowGeometry = (page) => page.evaluate(() => [...document.querySelectorAll("#refList .ref-chain")].map((c) => {
  const a = c.querySelector(".avatar").getBoundingClientRect(), tn = [...c.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  const r = document.createRange(); r.selectNodeContents(tn); const x = r.getBoundingClientRect();
  return { name: tn.textContent.trim(), dy: Math.round(a.top + a.height / 2 - (x.top + x.height / 2)), gap: Math.round(x.left - a.right) };
}));
const listLyon = async (page, extraOpts = {}) => { await search(page, { service: "vidange", ...extraOpts }); await page.click("[data-sort=dist]"); await page.waitForTimeout(400); await page.click("#moreBtn").catch(() => {}); };

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();

  // ===== T. brand tables (no browser) =====
  check("T1 tables cover the 26 chains and the 8 CT networks", Object.keys(BRAND).length === 26 && Object.keys(CT).length === 8, JSON.stringify([Object.keys(BRAND).length, Object.keys(CT).length]));
  const lowTable = Object.entries({ ...BRAND, ...CT }).filter(([, v]) => { const bg = hexRgb(v[0]); return Math.max(ratio(bg, WHITE), ratio(bg, DARK)) < 4.5; });
  check("T2 every monogram colour allows text at >= 4.5:1 (white or dark, whichever contrasts best)", lowTable.length === 0, JSON.stringify(lowTable));
  const mono = Object.values({ ...BRAND, ...CT }).map((v) => v[1]);
  check("T3 monogram texts are 1 or 2 characters (they must fit the circle)", mono.every((t) => t.length >= 1 && t.length <= 2), JSON.stringify(mono));
  const dupBrand = Object.entries(BRAND).filter(([, a], i, arr) => arr.some(([, b], j) => j < i && b[0] === a[0] && b[1] === a[1]));
  check("T4 no two chains share the same colour and text", dupBrand.length === 0, JSON.stringify(dupBrand));
  const chainIds = [...html.matchAll(/\{\s*id: "([a-z]+)",\s*name:/g)].map((m) => m[1]);
  check("T5 every chain id of the page has a monogram", chainIds.length === 26 && chainIds.every((id) => BRAND[id]), JSON.stringify(chainIds.filter((id) => !BRAND[id])));

  // ===== A. Everything offline: every chain avatar is still a branded monogram =====
  let { page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, wikidataFail: true } });
  await listLyon(page);
  await page.waitForTimeout(500);
  let s = await state(page);
  const ids = Object.keys(s.g);
  check("A1 all chains shown are branded monograms (no pastel letter), none has a logo offline", ids.length >= 9 && ids.every((k) => s.g[k].brand === s.g[k].n && s.g[k].logo === 0), JSON.stringify(s.g));
  check("A2 monogram text comes from the table", ids.every((k) => BRAND[k] && s.g[k].text === BRAND[k][1]), JSON.stringify(ids.map((k) => [k, s.g[k].text, BRAND[k] && BRAND[k][1]])));
  check("A3 AD (the reported case) has its own monogram", s.g.ad && s.g.ad.text === "AD" && s.g.ad.brand === s.g.ad.n, JSON.stringify(s.g.ad));
  check("A4 independents keep the pastel initial (never branded)", s.plain > 0 && s.plainBrand === 0, JSON.stringify([s.plain, s.plainBrand]));
  const css = await page.evaluate(() => [...document.querySelectorAll(".avatar.mono")].map((a) => { const c = getComputedStyle(a); return { id: a.dataset.c, bg: c.backgroundColor, fg: c.color }; }));
  const low = css.filter((x) => ratio(rgbOf(x.bg), rgbOf(x.fg)) < 4.5);
  check("A5 rendered monogram text contrast >= 4.5:1 on every chain shown", css.length > 0 && low.length === 0, JSON.stringify(low));
  const sp = css.find((x) => x.id === "speedy");
  check("A6 Speedy is yellow with dark text", sp && sp.bg === "rgb(255, 209, 0)" && sp.fg === "rgb(17, 19, 21)", JSON.stringify(sp));
  const nw = css.find((x) => x.id === "norauto");
  check("A7 Norauto is red with white text", nw && nw.bg === "rgb(226, 35, 26)" && nw.fg === "rgb(255, 255, 255)", JSON.stringify(nw));
  const geo = await page.evaluate(() => [...document.querySelectorAll("#list .card")].slice(0, 14).map((c) => {
    // The title block is the name and the distance chip. The type (« Indépendant ») is not part of it: when the city makes the chip
    // too wide for both on one line, the type drops to a third line and the avatar stays level with the name and the chip.
    const av = c.querySelector(".avatar"), a = av.getBoundingClientRect(), t = c.querySelector(".g-id").getBoundingClientRect(), d = c.querySelector(".dist").getBoundingClientRect(), m = getComputedStyle(av);
    return { id: av.dataset.c || "-", rendered: a.height > 0 && t.height > 0, dy: Math.round(a.top + a.height / 2 - (t.top + d.bottom) / 2), margin: [m.marginTop, m.marginRight, m.marginBottom, m.marginLeft].join(" ") };
  }));
  const geoOk = geo.filter((g) => g.rendered), geoBad = geo.filter((g) => g.margin !== "0px 0px 0px 0px" || (g.rendered && Math.abs(g.dy) > 3));
  check("A9 avatars have no stray margin and sit on the centre line of the title block: name and distance chip (chains and independents)", geo.length >= 10 && geoOk.length >= 4 && geoBad.length === 0, JSON.stringify(geoBad));
  await shot(page, "av-01-offline-monograms");
  check("A8 no page error", logs.errors.length === 0, JSON.stringify(logs.errors));
  await ctx.close();

  // ===== B. The three tiers together =====
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, storage: { "jg.logos.v1": { t: 1, m: { norauto: "https://old.example/x.png" } } }, mock: MOCK }));
  await listLyon(page);
  await waitIds(page, ["norauto", "midas", "points", "speedy", "roady", "euromaster"]);
  await page.waitForTimeout(700);
  s = await state(page);
  const has = (k) => s.g[k] && s.g[k].logo === s.g[k].n && s.g[k].loaded === s.g[k].n;
  const none = (k) => s.g[k] && s.g[k].logo === 0 && s.g[k].brand === s.g[k].n;
  check("B1 tier 1: Wikidata logo for norauto, midas, points", has("norauto") && has("midas") && has("points"), JSON.stringify(s.g));
  check("B2 tier 2: official-site icon for speedy (apple-touch 404 -> favicon.ico with 16/32/64 frames)", has("speedy"), JSON.stringify(s.g.speedy));
  check("B3 tier 2 after a broken tier-1 file: roady falls back to its own site", has("roady"), JSON.stringify(s.g.roady));
  check("B4 tier 2 accepts a 32 px icon (euromaster), the tier-1 URL outside Commons having been refused", has("euromaster"), JSON.stringify(s.g.euromaster));
  check("B5 an icon smaller than 32 px is refused: AD keeps its monogram", none("ad"), JSON.stringify(s.g.ad));
  check("B6 no icon, or an unreadable one (200 without image): feuvert, bosch, cartercash keep their monogram", none("feuvert") && none("bosch") && none("cartercash"), JSON.stringify([s.g.feuvert, s.g.bosch, s.g.cartercash]));
  const c = ctx.__counters, icons = c.siteIcons, at = icons.indexOf.bind(icons);
  check("B7 apple-touch-icon is tried before favicon.ico", at("www.speedy.fr/apple-touch-icon.png") >= 0 && at("www.speedy.fr/apple-touch-icon.png") < at("www.speedy.fr/favicon.ico"), JSON.stringify(icons));
  check("B8 chains resolved at tier 1 never hit a site (norauto, midas, points)", !icons.some((x) => /norauto|midas|points/.test(x)), JSON.stringify(icons));
  check("B9 refused sites are never requested (javascript:, foreign domain)", !logs.requests.some((u) => /evil\.example|^javascript/.test(u)) && !c.other.some((u) => /evil\.example|javascript/.test(u)), JSON.stringify([logs.requests.filter((u) => /evil/.test(u)), c.other]));
  check("B10 exactly one SPARQL request; the query asks icon, logo and official website", c.wikidata === 1 && /P8972/.test(c.sparql) && /P154/.test(c.sparql) && /P856/.test(c.sparql), JSON.stringify([c.wikidata, c.sparql.slice(0, 120)]));
  const dbg = await page.evaluate(() => window.jgLogos());
  check("B11 jgLogos() reports what is shown (speedy: its favicon)", /^https:\/\/www\.speedy\.fr\/favicon\.ico$/.test(dbg.speedy.shown) && /Norauto%20icon\.png/.test(dbg.norauto.shown), JSON.stringify([dbg.speedy, dbg.norauto]));
  check("B12 jgLogos() sites: Wikidata's when it passes the guard, else the page's own (feuvert, roady)", dbg.speedy.site === "https://www.speedy.fr" && dbg.ad.site === "https://www.ad.fr" && dbg.feuvert.site === "https://www.feuvert.fr" && dbg.roady.site === "https://www.roady.fr" && dbg.midas.site === "https://www.midas.fr", JSON.stringify([dbg.speedy, dbg.ad, dbg.feuvert, dbg.roady, dbg.midas]));
  const st = await page.evaluate(() => ({ v1: localStorage.getItem("jg.logos.v1"), v2: JSON.parse(localStorage.getItem("jg.logos.v2") || "null") }));
  check("B13 legacy cache v1 removed; v2 keeps logos, sites and the icons that worked", st.v1 === null && st.v2 && st.v2.t > 0 && st.v2.w.speedy === "https://www.speedy.fr/favicon.ico" && st.v2.w.roady === "https://www.roady.fr/favicon.ico" && /Norauto%20icon/.test(st.v2.m.norauto) && st.v2.s.speedy === "https://www.speedy.fr" && st.v2.s.ad === "https://www.ad.fr", JSON.stringify(st.v2 && st.v2.w));
  check("B14 failures are not cached (no 'work' entry for feuvert, ad, bosch)", st.v2 && !st.v2.w.feuvert && !st.v2.w.ad && !st.v2.w.bosch, JSON.stringify(st.v2 && st.v2.w));
  check("B15 logos are decorative: alt='', no referrer, parent aria-hidden", await page.$eval(".avatar.has-logo img.lg", (i) => i.getAttribute("alt") === "" && i.referrerPolicy === "no-referrer" && i.parentElement.getAttribute("aria-hidden") === "true"));
  check("B16 no page error; the console only has the expected logo misses", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
  await page.evaluate(() => document.getElementById("panelCol").scrollTo(0, 0));
  await page.waitForTimeout(500);
  await shot(page, "av-02-tiers");

  // info bar + prices view
  const cardOf = (id) => page.evaluate((id) => { const a = document.querySelector(`#list .avatar[data-c="${id}"]`); return a && a.closest(".card").dataset.id; }, id);
  const spId = await cardOf("speedy");
  await page.click(`#list [data-id="${spId}"] .g-main`); await page.waitForTimeout(500);
  const bar = await page.evaluate(() => { const a = document.querySelector("#mapInfo .avatar"); return a && { logo: a.classList.contains("has-logo"), ok: !!(a.querySelector("img") && a.querySelector("img").naturalWidth > 0) }; });
  check("B17 info bar shows the site icon for speedy", bar && bar.logo && bar.ok, JSON.stringify(bar));
  const adId = await cardOf("ad");
  await page.click(`#list [data-id="${adId}"] .g-main`); await page.waitForTimeout(500);
  const bar2 = await page.evaluate(() => { const a = document.querySelector("#mapInfo .avatar"); return a && { brand: a.classList.contains("mono"), logo: a.classList.contains("has-logo"), text: a.textContent.trim() }; });
  check("B18 info bar shows the AD monogram", bar2 && bar2.brand && !bar2.logo && bar2.text === "AD", JSON.stringify(bar2));
  await page.click(".tab[data-view=prix]"); await page.mouse.move(900, 600); await page.waitForTimeout(500);
  const refs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#refList .ref-chain")].map((c) => [c.textContent.trim().split(/\s+/)[0], { logo: !!c.querySelector(".avatar.has-logo img.lg"), brand: !!c.querySelector(".avatar.mono") }])));
  check("B19 prices view: every chain row has an avatar (logo or monogram)", Object.keys(refs).length >= 5 && Object.values(refs).every((r) => r.logo || r.brand), JSON.stringify(refs));
  const rows = await chainRowGeometry(page);
  check("B20 prices view: each avatar is centred on its chain name and right next to it", rows.length >= 5 && rows.every((x) => Math.abs(x.dy) <= 2 && x.gap >= 4 && x.gap <= 14), JSON.stringify(rows));
  await shot(page, "av-03-prix");

  // C. cache v2: reload keeps logos, no new SPARQL, the icon that worked is tried first
  await page.click(".tab[data-view=garages]");
  const before = icons.length;
  await page.reload(); await page.waitForTimeout(1500);
  check("C1 reload: no new SPARQL request", c.wikidata === 1, c.wikidata);
  const spAfter = icons.slice(before).filter((x) => /speedy/.test(x));
  check("C2 reload: speedy's icon is not looked up again through apple-touch-icon", !spAfter.includes("www.speedy.fr/apple-touch-icon.png"), JSON.stringify(spAfter));
  s = await state(page);
  check("C3 reload: logos are back (norauto, midas, speedy)", has("norauto") && has("speedy") && has("midas"), JSON.stringify(s.g));
  await page.evaluate(() => { const x = JSON.parse(localStorage.getItem("jg.logos.v2")); x.t -= 31 * 864e5; localStorage.setItem("jg.logos.v2", JSON.stringify(x)); });
  await page.reload(); await page.waitForTimeout(1200);
  check("C4 cache older than 30 days -> refreshed once", c.wikidata === 2, c.wikidata);
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.logos.v2") || "null"));
  check("C5 refresh resets the remembered tier-2 icons and stamps a fresh date", st2 && Date.now() - st2.t < 60e3, JSON.stringify(st2 && st2.t));
  await ctx.close();

  // ===== D. AD with a usable icon (.ico with 16/32/48 frames), pinned logo, Wikidata down =====
  ({ page, ctx } = await open(browser, server, FILE, { ...W, mock: { ...MOCK, siteIcons: { ...ICONS, "www.ad.fr": { "/favicon.ico": { frames: [16, 32, 48], color: "#D1001C" } } } } }));
  await listLyon(page);
  await waitIds(page, ["ad", "speedy"]); await page.waitForTimeout(500);
  s = await state(page);
  check("D1 AD gets its official favicon when the .ico holds a frame >= 32 px", has("ad"), JSON.stringify(s.g.ad));
  await ctx.close();
  const pin = "data:image/png;base64," + logoPNG("Pinned icon.png").toString("base64");
  ({ page, ctx } = await open(browser, server, FILE, { ...W, mock: { ...MOCK, wikidataFail: true }, logosPin: { norauto: pin } }));
  await listLyon(page);
  await waitIds(page, ["norauto", "speedy"]); await page.waitForTimeout(500);
  s = await state(page);
  const src = await page.$eval('#list .avatar[data-c="norauto"] img.lg', (i) => i.getAttribute("src").slice(0, 22));
  check("D2 JG_LOGOS pin wins and works while Wikidata is down; own-site icons still work (speedy)", src === "data:image/png;base64," && has("norauto") && has("speedy"), JSON.stringify([src, s.g.norauto, s.g.speedy]));
  check("D3 a pinned chain makes no request to Commons or to its site", !ctx.__counters.siteIcons.some((x) => /norauto/.test(x)) && ctx.__counters.logoFiles.length === 0, JSON.stringify([ctx.__counters.siteIcons, ctx.__counters.logoFiles]));
  await ctx.close();

  // ===== E. Data saver: no network for logos, monograms only =====
  ({ page, ctx } = await open(browser, server, FILE, { ...W, mock: MOCK, initScript: "Object.defineProperty(navigator,'connection',{get:()=>({saveData:true})});" }));
  await listLyon(page);
  await page.waitForTimeout(1200);
  s = await state(page);
  check("E1 saveData: no Wikidata call, no site icon call, monograms everywhere", ctx.__counters.wikidata === 0 && ctx.__counters.siteIcons.length === 0 && Object.values(s.g).every((x) => x.logo === 0 && x.brand === x.n), JSON.stringify([ctx.__counters.wikidata, ctx.__counters.siteIcons.length]));
  await ctx.close();

  // ===== H. JG_SITE_ICONS = false: Wikidata logos only, chains' own sites are never contacted =====
  ({ page, ctx } = await open(browser, server, FILE, { ...W, mock: MOCK, initScript: "window.JG_SITE_ICONS=false;" }));
  await listLyon(page);
  await waitIds(page, ["norauto", "midas"]); await page.waitForTimeout(1000);
  s = await state(page);
  check("H1 JG_SITE_ICONS=false: tier 1 still works, no request reaches any chain site", has("norauto") && has("midas") && ctx.__counters.siteIcons.length === 0, JSON.stringify([ctx.__counters.siteIcons, s.g.norauto]));
  check("H2 JG_SITE_ICONS=false: speedy, ad, roady, euromaster keep their monogram", none("speedy") && none("ad") && none("roady") && none("euromaster"), JSON.stringify([s.g.speedy, s.g.ad, s.g.roady, s.g.euromaster]));
  await ctx.close();

  // ===== G. Guards: Wikidata sites (chains without a site in the page data, so the Wikidata one is the only candidate) =====
  const BAD_SITES = [
    { q: "Q3393358", url: "http://127.0.0.1:9999/" },                     // points : IP
    { q: "Q80184403", url: "https://localhost/" },                        // vulco : localhost
    { q: "Q894368", url: "https://bosch.exemple.org/" },                  // bosch : nom de l'enseigne en sous-domaine d'un autre domaine
    { q: "Q108753388", url: "ftp://www.ad.fr/" },                         // ad : schéma
    { q: "Q117602800", url: "https://www.top-garage.fr/" },               // top garage : accepté (tiret)
    { q: "Q6918585", url: "https://motrio.fr:8443/chemin?x=1" },          // motrio : accepté, port / chemin / requête retirés
    { q: "Q48180528", url: "https://user:pw@www.driver-center.fr/" },     // driver : accepté, identifiants retirés
    { q: "Q1273376", url: "https://www.e.leclerc/" },                     // e.leclerc : accepté (domaine à un libellé)
  ];
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, logos: [], sites: BAD_SITES, siteIcons: {} } }));
  await listLyon(page);
  await page.waitForTimeout(1500);
  const g = await page.evaluate(() => window.jgLogos());
  const wd = await page.evaluate(() => (JSON.parse(localStorage.getItem("jg.logos.v2") || "{}").s) || {});
  check("G1 IP, localhost, subdomain trick and non-http scheme are refused (Wikidata-derived sites, read from the cache)", wd.points === "" && wd.vulco === "" && wd.bosch === "" && wd.ad === "", JSON.stringify([wd.points, wd.vulco, wd.bosch, wd.ad]));
  check("G2 domains that carry the chain name are accepted (top-garage.fr, e.leclerc)", wd.topgarage === "https://www.top-garage.fr" && wd.eleclerc === "https://www.e.leclerc", JSON.stringify([wd.topgarage, wd.eleclerc]));
  check("G3 port, path, query and credentials are dropped from an accepted site", wd.motrio === "https://motrio.fr" && wd.driver === "https://www.driver-center.fr", JSON.stringify([wd.motrio, wd.driver]));
  check("G4 nothing was requested from the refused hosts", !logs.requests.some((u) => /127\.0\.0\.1:9999|localhost|bosch\.exemple|^ftp:/.test(u)), JSON.stringify(logs.requests.filter((u) => /9999|localhost|exemple|^ftp/.test(u))));
  check("G5 the page's own site wins over Wikidata's, and the verified table over Wikidata's too (speedy, bosch)", g.speedy.site === "https://www.speedy.fr" && g.bosch.site === "https://www.boschcarservice.com" && g.eleclerc.site === "https://www.auto.leclerc", JSON.stringify([g.speedy, g.bosch, g.eleclerc]));
  await ctx.close();

  // ===== L. Tier 2 does not depend on Wikidata =====
  const SITES = { norauto: "https://www.norauto.fr", feuvert: "https://www.feuvert.fr", speedy: "https://www.speedy.fr", midas: "https://www.midas.fr", roady: "https://www.roady.fr", euromaster: "https://www.euromaster.fr", points: "https://www.points.fr", firststop: "https://www.firststop.fr", vulco: "https://www.vulco.fr", profilplus: "https://www.profilplus.fr", siligom: "https://www.siligom.fr", eurotyre: "https://www.eurotyre.fr", bestdrive: "https://www.bestdrive.fr", driver: "", eleclerc: "https://www.auto.leclerc", cartercash: "https://www.carter-cash.com", eurorepar: "https://www.eurorepar.fr", motrio: "https://www.motrio.fr", ad: "https://www.ad.fr", bosch: "https://www.boschcarservice.com", topgarage: "https://www.top-garage.fr", precisium: "https://www.precisium.fr", delko: "https://www.delko.fr", autoprimo: "https://www.autoprimo.com", avatacar: "https://www.avatacar.com", glass: "https://www.carglass.fr" };
  const L_ICONS = {
    "www.speedy.fr": { "/favicon.ico": { frames: [16, 48], color: "#FFD100" } },
    "www.points.fr": { "/favicon.ico": { frames: [16, 32, 64], color: "#004A99" } },
    "www.ad.fr": { "/apple-touch-icon.png": { size: 180, color: "#D1001C" } },
    "www.midas.fr": { "/favicon.ico": { frames: [48], color: "#C8102E" } },
  };
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, wikidataFail: true, siteIcons: L_ICONS } }));
  const lg = await page.evaluate(() => window.jgLogos());
  const diff = Object.keys(SITES).filter((k) => lg[k].site !== SITES[k]);
  check("L1 25 of 26 chains have a verified official site without any Wikidata answer (Driver Center: none found)", Object.keys(lg).length === 26 && diff.length === 0, JSON.stringify(diff.map((k) => [k, lg[k].site, SITES[k]])));
  await listLyon(page);
  await waitIds(page, ["speedy", "points", "ad"]); await page.waitForTimeout(500);
  s = await state(page);
  check("L2 Wikidata down: Speedy (favicon .ico 16/48), Point S (.ico 16/32/64) and AD (apple-touch 180 px) get their logo from their own site", has("speedy") && has("points") && has("ad"), JSON.stringify([s.g.speedy, s.g.points, s.g.ad]));
  const ih = ctx.__counters.siteIcons;
  check("L3 official sites are asked in the same order for each chain (apple-touch-icon before favicon.ico)", ih.indexOf("www.points.fr/apple-touch-icon.png") >= 0 && ih.indexOf("www.points.fr/apple-touch-icon.png") < ih.indexOf("www.points.fr/favicon.ico") && ih.indexOf("www.ad.fr/apple-touch-icon.png") >= 0 && !ih.includes("www.ad.fr/favicon.ico"), JSON.stringify(ih.filter((x) => /points|www\.ad/.test(x))));
  await ctx.close();

  // Wikidata that hangs: tier 2 must start after 2.5 s, not after the 9 s timeout
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, logos: WD_LOGOS, sites: WD_SITES, wikidataDelay: 15000, siteIcons: L_ICONS } }));
  const t0 = Date.now();
  await listLyon(page);
  await waitIds(page, ["speedy"]);
  const dt = Date.now() - t0;
  check("L4 Wikidata does not answer: Speedy's own icon is there within ~5 s of the first search (2.5 s grace + load), not after the 9 s timeout", has2(await state(page), "speedy") && dt < 6500, dt);
  check("L5 Wikidata is still asked once", ctx.__counters.wikidata === 1, ctx.__counters.wikidata);
  await ctx.close();

  // Wikidata that answers late (3.6 s): the chains without a logo yet get a second chance, without repeating failed requests
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, logos: WD_LOGOS, sites: WD_SITES, wikidataDelay: 3600, siteIcons: { "www.midas.fr": { "/favicon.ico": { frames: [48], color: "#C8102E" } } } } }));
  await listLyon(page);
  await page.waitForTimeout(6500);
  s = await state(page);
  const lg2 = await page.evaluate(() => window.jgLogos());
  const nHits = ctx.__counters.siteIcons.filter((x) => /^www\.norauto\.fr/.test(x));
  check("L6 late Wikidata answer: Norauto (own site has no icon) gets its Wikidata logo after the site attempts failed", has2(s, "norauto") && /Norauto%20icon/.test(lg2.norauto.shown), JSON.stringify([s.g.norauto, lg2.norauto.shown]));
  check("L7 ...and the failed site requests were not repeated (2 per chain: apple-touch-icon, favicon.ico)", nHits.length === 2, JSON.stringify(nHits));
  check("L8 an icon already found before the late answer is kept (Midas keeps its favicon, not swapped for the Wikidata logo)", /midas\.fr\/favicon\.ico$/.test(lg2.midas.shown), JSON.stringify(lg2.midas));
  await ctx.close();

  // JG_WIKIDATA = false: no Wikidata, no Commons, tier 2 still works
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS, logos: WD_LOGOS, sites: WD_SITES, siteIcons: L_ICONS }, initScript: "window.JG_WIKIDATA=false;" }));
  await listLyon(page);
  await waitIds(page, ["speedy", "points"]); await page.waitForTimeout(600);
  s = await state(page);
  check("L9 JG_WIKIDATA=false: no request to Wikidata or Commons, official-site icons still shown", ctx.__counters.wikidata === 0 && ctx.__counters.logoFiles.length === 0 && has2(s, "speedy") && has2(s, "points") && none2(s, "norauto"), JSON.stringify([ctx.__counters.wikidata, ctx.__counters.logoFiles, s.g.norauto]));
  await ctx.close();

  // ===== F. Contrôle technique: networks get monograms too =====
  ({ page, ctx, logs } = await open(browser, server, FILE, { ...W, mock: MOCK }));
  await page.waitForTimeout(1200);
  const before2 = [ctx.__counters.wikidata, ctx.__counters.siteIcons.length];
  await page.selectOption("#service", "ct");
  await page.fill("#address", "12 rue de la république lyon"); await page.waitForSelector("#addrList li[data-i]", { state: "visible" }); await page.click("#addrList li[data-i='0']");
  await page.click("#go"); await page.waitForSelector("#list > li.card", { timeout: 12000 }); await page.waitForTimeout(700);
  const ct = await page.evaluate(() => [...document.querySelectorAll("#list .card")].map((c) => ({ kind: c.querySelector(".kind").textContent.trim(), brand: c.querySelector(".avatar").classList.contains("mono"), logo: c.querySelector(".avatar").classList.contains("has-logo"), text: c.querySelector(".avatar").textContent.trim(), chain: c.querySelector(".avatar").hasAttribute("data-c") })));
  const ctKey = (k) => k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
  check("F1 every CT card has a network monogram", ct.length >= 8 && ct.every((x) => x.brand && x.text.length >= 1), JSON.stringify(ct));
  check("F2 the monogram matches the network (Autosur A, Dekra D, Sécuritest S, Contrôle Auto CA…)", ct.every((x) => CT[ctKey(x.kind)] && CT[ctKey(x.kind)][1] === x.text), JSON.stringify(ct.map((x) => [x.kind, x.text])));
  check("F3 CT cards are not chain avatars: no logo lookup is started for them", ct.every((x) => !x.chain && !x.logo) && ctx.__counters.wikidata === before2[0], JSON.stringify([ct.map((x) => x.chain), ctx.__counters.wikidata, before2]));
  await shot(page, "av-04-ct");
  await ctx.close();

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[avatars] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
