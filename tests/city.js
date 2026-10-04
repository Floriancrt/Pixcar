// City in the distance chip of the cards ("2,5 km · Bron"): where the city comes from (OSM tags, address, registry,
// technical inspection, nearest-address lookup), the lookup rules (cards on screen only, 3 at a time, 250 m, cache,
// failure, switch), the interplay with the address lookup of tests/addr.js, and the layout of the chip.
const { serve, launch, open, search, shot, ROOT, injectScript } = require("./harness");
const { CENTER } = require("./mocks");
const fs = require("fs"), path = require("path");
const FILE = process.argv[2] || process.env.FILE || "index.html";
const SECS = process.argv[3] || ""; // sections to run (letters A-F), all when empty: used by the mutation runner
const has = (s) => !SECS || SECS.includes(s);
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 700)); };

const mk = (id, name, dLat, tags) => ({ type: "node", id, lat: CENTER.lat + dLat, lon: CENTER.lon, tags: { name, shop: "car_repair", phone: "+33 4 72 00 00 00", ...tags } });
// A. the city is already in the data: no request at all
const LONG = "Saint-Remy-de-Chargnat-la-Grande-Plaine-du-Haut-Pays";
const TAGGED = [
  mk(9301, "Garage Tag Ville", 0.0004, { "addr:postcode": "69007", "addr:city": "Lyon" }),
  mk(9302, "Garage Tag Majuscules", 0.0008, { "addr:city": "SAINT-GENIS-LAVAL" }),
  mk(9303, "Garage Tag Quartier", 0.0012, { "addr:suburb": "Gerland" }),
  mk(9304, "Garage Tag Contact", 0.0016, { "contact:city": "Bron" }),
  mk(9305, "Garage Tag Adresse Complete", 0.0020, { "addr:full": "3 place Jean Macé 69007 Lyon" }),
  mk(9306, "Garage Tag Nom Long", 0.0024, { "addr:city": LONG }),
];
const TAGGED_CITIES = ["Lyon", "Saint-Genis-Laval", "Gerland", "Bron", "Lyon", LONG];
// B. no address tag at all: the city comes from the nearest-address lookup (24 garages, 44 m apart)
const N = 24;
const BARE = Array.from({ length: N }, (_, i) => mk(9400 + i, `Garage Nu ${String(i + 1).padStart(2, "0")}`, 0.0004 * (i + 1), {}));
const ONE = mk(9307, "Garage Avec Ville", 0.0002, { "addr:city": "Lyon" }); // alone at its position: proves a garage whose data holds a city is never looked up
const BAND = 0.0050; // beyond this offset (garage 13 and after) the mock answers « Vénissieux », before it « Bron »
const at = (lat) => (lat > CENTER.lat + BAND ? { city: "Vénissieux", postcode: "69200" } : { city: "Bron", postcode: "69500" });
const ID = (n) => `osm:node/${9400 + n}`;
const bareNum = (id) => (/^osm:node\/94\d\d$/.test(id) ? +id.slice(-2) : -1);

const dist = async (page) => { await page.click("[data-sort=dist]"); await page.waitForTimeout(350); };
// A cards are ~190 px tall and the list starts ~650 px down the page: a 1440 × 900 window shows two of them.
// `tall` windows show more at once, which is what the queue (3 at a time) needs to be seen at work.
// `noSort`: read the page as the search left it. Sorting redraws every card, which would hide a chip that a late answer
// forgot to repaint (the redraw reads the cache again).
const opened = async (env, elements, mock = {}, o = {}) => {
  const { noSort, ...openOpts } = o;
  const r = await open(env.browser, env.server, FILE, { width: 1440, height: 900, mock: { elements, ...mock }, ...openOpts });
  await search(r.page, { service: "vidange" });
  if (!noSort) await dist(r.page);
  return r;
};
const chips = (page) => page.evaluate(() => [...document.querySelectorAll("#list > li.card")].map((c) => {
  const d = c.querySelector(".dist"), city = d.querySelector(".d-city"), km = d.querySelector(".d-km");
  const sr = d.cloneNode(true);
  sr.querySelectorAll('[aria-hidden="true"], svg').forEach((n) => n.remove());
  const cr = c.getBoundingClientRect(), dr = d.getBoundingClientRect();
  return {
    id: c.dataset.id, key: d.dataset.dist,
    km: km ? km.textContent : "", city: city ? city.textContent : "",
    said: sr.textContent.replace(/\s+/g, " ").trim(),
    sep: !!d.querySelector('.d-sep[aria-hidden="true"]'), comma: !!d.querySelector(".d-km + .sr-only"),
    inside: dr.right <= cr.right + 0.5 && dr.left >= cr.left - 0.5,
    cut: city ? city.scrollWidth > city.clientWidth + 1 : false,
    ell: city ? (() => { const cs = getComputedStyle(city); return cs.textOverflow === "ellipsis" && cs.overflow === "hidden" && cs.whiteSpace === "nowrap"; })() : false,
    top: Math.round(dr.top), bottom: Math.round(dr.bottom), vh: window.innerHeight,
  };
}));
// waits until the number of reverse requests has not moved for `ms` (a request pending in the mock counts when it starts:
// pass a `ms` longer than the mock's delay)
const settle = async (ctx, ms = 700, max = 9000) => {
  const t0 = Date.now(); let last = -1, since = Date.now();
  while (Date.now() - t0 < max) {
    const n = ctx.__counters.reverse;
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= ms) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return ctx.__counters.reverse;
};
// scrolls the list card by card, like a reader going through it (a jump to the end skips the cards in between: they were never on screen)
const scrollThrough = async (page) => {
  const n = await page.$$eval("#list > li.card", (l) => l.length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => document.querySelectorAll("#list > li.card")[i].scrollIntoView({ block: "center" }), i);
    await page.waitForTimeout(60);
  }
};
const memory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jg.addr.v1") || "{}"));
const axeRun = (page) => page.evaluate(async () => { const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }); return r.violations.map((v) => v.id + "×" + v.nodes.length); });
const addrText = (page, id) => page.$eval(`#list [data-id="${id}"] [data-ad]`, (e) => e.textContent.replace(/\s+/g, " ").trim());

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const env = { browser, server };
  let page, ctx, logs, c, ch;

  if (has("A")) {
  // ===== A. the city is in the data: tags, address, no request =====
  ({ page, ctx, logs } = await opened(env, TAGGED, {}));
  c = ctx.__counters;
  ch = await chips(page);
  check("A1 six garages whose data holds a city: addr:city, capitals tidied, addr:suburb, contact:city, addr:full parsed", ch.length === 6 && JSON.stringify(ch.map((x) => x.city)) === JSON.stringify(TAGGED_CITIES), JSON.stringify(ch.map((x) => x.city)));
  check("A2 no nearest-address request for them", c.reverse === 0, c.reverse);
  check("A3 the chip keeps the distance first and shows the city after a separator", ch.every((x) => /^\d+(,\d)? (m|km)$/.test(x.km)) && ch.every((x) => x.sep && x.comma), JSON.stringify(ch.map((x) => [x.km, x.sep, x.comma])));
  check("A4 screen readers hear « à 40 m, Lyon » (separator hidden from them)", ch[0].said === `à ${ch[0].km}, Lyon`, JSON.stringify(ch[0]));
  check("A5 the chip carries the garage id (so that a late answer repaints the right card)", ch.every((x) => x.key === x.id), JSON.stringify(ch.map((x) => [x.key, x.id])));
  check("A6 desktop: every chip stays inside its card, even with a 52-character city", ch.every((x) => x.inside), JSON.stringify(ch.map((x) => x.inside)));
  await shot(page, "city-01-tags");
  await injectScript(page, AXE);
  const ax1 = await axeRun(page);
  check("A7 axe: no violation with cities in the chips", ax1.length === 0, JSON.stringify(ax1));
  check("A8 no page error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
  await ctx.close();

  }

  if (has("B")) {
  // ===== B. no address tag: the city comes from the nearest-address lookup, for the cards that come on screen =====
  ({ page, ctx, logs } = await opened(env, BARE.concat(ONE), { reverse: { delayMs: 120, at } }, { height: 1800, noSort: true }));
  c = ctx.__counters;
  await settle(ctx);
  ch = await chips(page);
  const nFirst = c.reverse;
  const onScreen = ch.filter((x) => bareNum(x.id) >= 0 && x.bottom > -160 && x.top < x.vh + 160).length;
  const done0 = ch.filter((x) => bareNum(x.id) >= 0 && x.city);
  check("B1 the cards on screen get their city: as many requests as bare cards on screen, far fewer than 24", nFirst >= 3 && nFirst < N / 2 && Math.abs(nFirst - onScreen) <= 1 && done0.length === nFirst, JSON.stringify([nFirst, onScreen, done0.length]));
  check("B2 ...none for the cards far below the screen", ch.filter((x) => bareNum(x.id) >= 0 && x.top > x.vh + 400 && x.city).length === 0, JSON.stringify(ch.filter((x) => x.city).map((x) => x.top)));
  check("B3 requests run 3 at a time, no more", c.reverseMax === 3, c.reverseMax);
  const urls = c.reverseUrls.map((u) => new URLSearchParams(u));
  const lats = urls.map((u) => +u.get("lat"));
  check("B4 each request asks for one garage (limit=1, its coordinates), none twice", urls.every((u) => u.get("limit") === "1" && Math.abs(+u.get("lon") - CENTER.lon) < 2e-6) && new Set(lats.map((l) => l.toFixed(5))).size === lats.length, JSON.stringify(c.reverseUrls.slice(0, 3)));
  check("B5 the city shown is the one of the answer for that garage's position (here « Bron »)", done0.every((x) => x.city === "Bron"), JSON.stringify(done0.map((x) => x.city)));
  const tagged = ch.find((x) => x.id === "osm:node/9307");
  check("B6 the garage whose tags hold a city is never looked up", tagged && tagged.city === "Lyon" && !lats.some((l) => Math.abs(l - (CENTER.lat + 0.0002)) < 2e-6), JSON.stringify([tagged, lats.length]));
  await scrollThrough(page);
  await settle(ctx);
  ch = await chips(page);
  const bare = ch.filter((x) => bareNum(x.id) >= 0);
  check("B7 read through to the end: every garage has its city", bare.length === N && bare.every((x) => x.city), JSON.stringify(bare.filter((x) => !x.city).map((x) => x.id)));
  check("B8 each city matches the answer for its own position (« Bron » up to the 12th garage, « Vénissieux » after)", bare.every((x) => x.city === (0.0004 * (bareNum(x.id) + 1) > BAND ? "Vénissieux" : "Bron")), JSON.stringify(bare.map((x) => x.city)));
  check("B9 24 requests in all (one per garage without a city), still 3 at a time at most", c.reverse === N && c.reverseMax === 3, JSON.stringify([c.reverse, c.reverseMax]));
  const ents = Object.values(await memory(page));
  check("B10 answers cached with their city (« c ») next to the address of the same answer", ents.length === N && ents.every((e) => e.c && e.a && e.d === 14), JSON.stringify(ents.slice(0, 2)));
  await page.click("[data-sort=price]"); await page.waitForTimeout(250);
  await dist(page);
  await page.click("[data-sort=note]"); await page.waitForTimeout(250);
  await dist(page);
  await page.evaluate((id) => document.querySelector(`#list [data-id="${CSS.escape(id)}"]`).scrollIntoView({ block: "center" }), ID(0));
  await settle(ctx, 500);
  const before = c.reverse;
  check("B11 sorting again or coming back to a card asks nothing more", before === N, before);
  // opening a card whose lookup is done: the address comes from the same answer, with no new request
  await page.click(`#list [data-id="${ID(0)}"] .g-main`); await page.waitForTimeout(300);
  const adr = await addrText(page, ID(0));
  check("B12 opening that card shows the approximate address of the same answer, with no new request", /^≈ Environ \d+ Rue du Test, 69500 Bron$/.test(adr) && c.reverse === before, JSON.stringify([adr, c.reverse, before]));
  const after = (await chips(page)).find((x) => x.id === ID(0));
  check("B13 the chip keeps its city once the address is applied", after && after.city === "Bron", JSON.stringify(after));
  await shot(page, "city-02-lookup");
  check("B14 no page error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
  // reload: the cities come back from the cache, in the first paint, with no request
  await page.reload();
  await page.waitForSelector("#list > li", { timeout: 8000 });
  await dist(page);
  await settle(ctx, 500);
  ch = await chips(page);
  check("B15 after a reload every city is there at once (cache), with no request", ch.filter((x) => bareNum(x.id) >= 0 && x.city).length === N && c.reverse === before, JSON.stringify([c.reverse, before]));
  await ctx.close();

  }

  if (has("C")) {
  // ===== C. what the answer is worth =====
  // C1: 200 m away: too far for an address (80 m), close enough for the city (250 m)
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 2), { reverse: { offsetM: 200 } }));
  c = ctx.__counters; await settle(ctx);
  ch = await chips(page);
  check("C1 an answer 200 m away gives the city but not the address", ch.length === 2 && ch.every((x) => x.city === "Lyon"), JSON.stringify(ch.map((x) => x.city)));
  await page.click(`#list [data-id="${ID(0)}"] .g-main`); await page.waitForTimeout(300);
  const noAdr = await addrText(page, ID(0));
  const m1 = Object.values(await memory(page));
  check("C2 ...the sheet still says « Adresse non renseignée »; the cache keeps the city with an empty address", noAdr === "Adresse non renseignée" && m1.length === 2 && m1.every((e) => e.a === "" && e.c === "Lyon") && c.reverse === 2, JSON.stringify([noAdr, m1[0], c.reverse]));
  await ctx.close();
  // C3: 300 m away: neither
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 2), { reverse: { offsetM: 300 } }));
  c = ctx.__counters; await settle(ctx);
  ch = await chips(page);
  const m2 = Object.values(await memory(page));
  const n3 = c.reverse;
  await page.click("[data-sort=price]"); await page.waitForTimeout(250); await dist(page); await settle(ctx, 500);
  check("C3 an answer 300 m away is refused: no city, the chip shows the distance only", ch.length === 2 && ch.every((x) => x.city === "" && /^à \d+ m$/.test(x.said)), JSON.stringify(ch.map((x) => [x.city, x.said])));
  check("C4 the refusal is cached (empty city) and not asked again", m2.length === 2 && m2.every((e) => e.a === "" && e.c === "") && n3 === 2 && c.reverse === n3, JSON.stringify([m2, n3, c.reverse]));
  await ctx.close();
  // C5: answer without a "city" property: the city is read from the label
  ({ page, ctx } = await opened(env, BARE.slice(0, 2), { reverse: { noCity: true } }));
  await settle(ctx);
  ch = await chips(page);
  check("C5 no « city » in the answer: read from its label (« … 69007 Lyon »)", ch.length === 2 && ch.every((x) => x.city === "Lyon"), JSON.stringify(ch.map((x) => x.city)));
  await ctx.close();
  // C6: an old cache entry (before the city was kept): asked again once, then kept
  ({ page, ctx } = await opened(env, BARE.slice(0, 2), { reverse: {} }, { storage: { "jg.addr.v1": { [`${(CENTER.lat + 0.0004).toFixed(5)},${CENTER.lon.toFixed(5)}`]: { a: "", t: Date.now() } } } }));
  c = ctx.__counters; await settle(ctx);
  ch = await chips(page);
  check("C6 an old « no address » entry without a city is asked again once; the other card is asked as well", c.reverse === 2 && ch.every((x) => x.city === "Lyon"), JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  await ctx.close();
  // C7: a cached address gives the city without any request
  ({ page, ctx } = await opened(env, BARE.slice(0, 2), { reverse: {} }, { storage: { "jg.addr.v1": Object.fromEntries([1, 2].map((i) => [`${(CENTER.lat + 0.0004 * i).toFixed(5)},${CENTER.lon.toFixed(5)}`, { a: "5 Rue Ancienne, 69100 Villeurbanne", d: 10, t: Date.now() }])) } }));
  c = ctx.__counters; await settle(ctx, 500);
  ch = await chips(page);
  check("C7 a cached address from before (no « c » field) already gives the city, with no request", c.reverse === 0 && ch.every((x) => x.city === "Villeurbanne"), JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  await ctx.close();
  // C7b: a garage with a street but no city, whose position holds an address cached before (the garage had no street then,
  // or another garage stood at the same spot): the city is read from that cached address, without any request
  ({ page, ctx } = await opened(env, [mk(9500, "Garage Rue Sans Ville", 0.0004, { "addr:street": "Rue Test", "addr:housenumber": "3" })], { reverse: {} }, { storage: { "jg.addr.v1": { [`${(CENTER.lat + 0.0004).toFixed(5)},${CENTER.lon.toFixed(5)}`]: { a: "5 Rue Ancienne, 69100 Villeurbanne", d: 10, t: Date.now() } } } }));
  c = ctx.__counters; await settle(ctx, 500);
  ch = await chips(page);
  check("C7b a garage with a street but no city takes the city of the address cached for its position, with no request", c.reverse === 0 && ch.length === 1 && ch[0].city === "Villeurbanne", JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  await ctx.close();
  // C8: the service is down (all 12 cards on screen), then comes back
  const down = { fail: true };
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 12), { reverse: down }, { height: 3200, initScript: "window.JG_TUNE.cityPause=3000;" }));
  c = ctx.__counters; await settle(ctx, 900);
  ch = await chips(page);
  const mDown = await page.evaluate(() => localStorage.getItem("jg.addr.v1"));
  const stopped = c.reverse;
  check("C8 service down: it stops after a few failures (at most 6 requests for 12 garages), nothing cached", stopped >= 4 && stopped <= 6 && mDown === null, JSON.stringify([stopped, mDown]));
  check("C9 ...the chips keep the distance alone, no page error", ch.length === 12 && ch.every((x) => x.city === "" && /^à \d+ m$/.test(x.said)) && logs.errors.length === 0, JSON.stringify([ch.map((x) => x.said).slice(0, 3), logs.errors]));
  await page.click("[data-sort=price]"); await page.waitForTimeout(250); await dist(page); await settle(ctx, 500);
  check("C10 during the pause a new display of the list asks nothing", c.reverse === stopped, [c.reverse, stopped]);
  down.fail = false; // the service is back
  await page.waitForTimeout(3200);
  await page.click("[data-sort=price]"); await page.waitForTimeout(250); await dist(page); await settle(ctx, 600);
  ch = await chips(page);
  check("C11 after the pause the lookups start again and, the service answering, every card gets its city", c.reverse > stopped && ch.length === 12 && ch.every((x) => x.city === "Lyon"), JSON.stringify([c.reverse, stopped, ch.map((x) => x.city)]));
  await ctx.close();
  // C12: switch
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 6), { reverse: {} }, { height: 1800, initScript: "window.JG_CITY_LOOKUP=false;" }));
  c = ctx.__counters; await page.waitForTimeout(900);
  ch = await chips(page);
  check("C12 window.JG_CITY_LOOKUP = false: no lookup, distance only", c.reverse === 0 && ch.every((x) => x.city === ""), JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  // ...but opening a card still completes its address (tests/addr.js), and the city of its chip follows from that address
  await page.click(`#list [data-id="${ID(0)}"] .g-main`); await page.waitForTimeout(500);
  ch = await chips(page);
  check("C13 switched off, opening a card gives its address and, from it, the city of its chip (one request)", c.reverse === 1 && ch[0].city === "Lyon" && ch.slice(1).every((x) => x.city === ""), JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  await ctx.close();
  // C14: failures that are not in a row never stop the lookups (every other garage fails: 6 failures, 6 answers)
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 12), { reverse: { failAt: (lat) => Math.round((lat - CENTER.lat) / 0.0004) % 2 === 0 } }, { height: 3200 }));
  c = ctx.__counters; await settle(ctx, 900);
  ch = await chips(page);
  check("C14 failures that are not consecutive do not trip the stop: all 12 garages are asked (those that failed once get one more try at the next display), the 6 that answer show their city", c.reverse >= 12 && c.reverse <= 18 && ch.filter((x) => x.city === "Lyon").length === 6 && ch.filter((x) => x.city === "").length === 6, JSON.stringify([c.reverse, ch.map((x) => x.city)]));
  await ctx.close();

  }

  if (has("D")) {
  // ===== D. opening a card while its lookup is still pending: one request for that garage =====
  ({ page, ctx, logs } = await opened(env, BARE.slice(0, 2), { reverse: { delayMs: 2500 } }));
  c = ctx.__counters;
  await page.click(`#list [data-id="${ID(0)}"] .g-main`);
  await page.waitForTimeout(150);
  const busy = await addrText(page, ID(0));
  await settle(ctx, 3200, 14000);
  const lat0 = CENTER.lat + 0.0004;
  const forFirst = c.reverseUrls.filter((u) => Math.abs(+new URLSearchParams(u).get("lat") - lat0) < 2e-6).length;
  ch = await chips(page);
  const adr2 = await addrText(page, ID(0));
  check("D1 while the request is pending the sheet says « Recherche de l'adresse… »", /Recherche de l'adresse/.test(busy), busy);
  check("D2 the opening joins the pending request: a single request for that garage, two in all", forFirst === 1 && c.reverse === 2, JSON.stringify([forFirst, c.reverse]));
  check("D3 then the address (« ≈ ») and the city both appear", /^≈ Environ \d+ Rue du Test, 69007 Lyon$/.test(adr2) && ch.length === 2 && ch.every((x) => x.city === "Lyon"), JSON.stringify([adr2, ch.map((x) => x.city)]));
  await ctx.close();

  }

  if (has("E")) {
  // ===== E. the other sources carry their city with the data =====
  // E1: technical inspection
  ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: TAGGED } }));
  await page.selectOption("#service", "ct");
  await page.fill("#address", "12 rue de la république lyon"); await page.waitForSelector("#addrList li[data-i]", { state: "visible" }); await page.click("#addrList li[data-i='0']");
  await page.click("#go"); await page.waitForSelector("#list > li.card", { timeout: 12000 }); await page.waitForTimeout(500);
  ch = await chips(page);
  check("E1 technical-inspection centres: the city comes with the data (capitals tidied: « Lyon »), no request", ch.length > 0 && ch.every((x) => x.city === "Lyon") && ctx.__counters.reverse === 0, JSON.stringify([ch.slice(0, 2).map((x) => x.city), ctx.__counters.reverse]));
  await ctx.close();
  // E2: registry only (the garage base is down)
  const sir = [
    { siret: "90000000001", name: "Atelier Registre 1", lat: CENTER.lat + 0.003, lon: CENTER.lon, adresse: "3 rue du Registre 69002 LYON" },
    { siret: "90000000002", name: "Atelier Registre 2", lat: CENTER.lat + 0.006, lon: CENTER.lon, adresse: "5 AVENUE DE LA PAIX 69003 LYON 3EME" },
    { siret: "90000000003", name: "Atelier Registre 3", lat: CENTER.lat + 0.009, lon: CENTER.lon, adresse: "ZI LES PLATANES 69800 SAINT-PRIEST CEDEX" },
  ];
  ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 1800, mock: { overpassFail: true, sireneItems: sir } }));
  await search(page, { service: "vidange" }); await dist(page);
  ch = await chips(page);
  check("E2 registry cards: the city is read from the address (« Lyon », « Lyon 3e », « Saint-Priest » without cedex), no request", JSON.stringify(ch.map((x) => x.city)) === JSON.stringify(["Lyon", "Lyon 3e", "Saint-Priest"]) && ctx.__counters.reverse === 0, JSON.stringify([ch.map((x) => x.city), ctx.__counters.reverse]));
  await ctx.close();

  }

  if (has("F")) {
  // ===== F. layout =====
  ({ page, ctx, logs } = await opened(env, TAGGED, {}, { width: 390, height: 844, dpr: 2, touch: true }));
  ch = await chips(page);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("F1 mobile (390 px): every chip stays inside its card, no sideways scroll", ch.length === 6 && ch.every((x) => x.inside) && !overflowX, JSON.stringify([ch.map((x) => x.inside), overflowX]));
  check("F2 mobile: a very long city is shortened (« … ») rather than overflowing; short ones are shown in full", ch[5].cut && ch.every((x) => x.ell) && ch.filter((x) => x.city.length <= 8).every((x) => !x.cut), JSON.stringify(ch.map((x) => [x.city.slice(0, 10), x.cut])));
  check("F3 mobile: the shortened chip still reads in full for a screen reader", ch[5].said === `à ${ch[5].km}, ${LONG}`, ch[5].said);
  await shot(page, "city-03-mobile");
  await ctx.close();
  ({ page, ctx, logs } = await opened(env, TAGGED, {}, { colorScheme: "dark" }));
  await injectScript(page, AXE);
  const ax2 = await axeRun(page);
  check("F4 dark theme: axe finds nothing", ax2.length === 0, JSON.stringify(ax2));
  await shot(page, "city-04-dark");
  await ctx.close();

  }

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[city] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
