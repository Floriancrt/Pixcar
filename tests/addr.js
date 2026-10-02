// Missing garage addresses: nearest address from the IGN reverse geocoder, shown with "≈", cached, bounded to 80 m.
const { serve, launch, open, search, shot, ROOT } = require("./harness");
const { buildElements, CENTER } = require("./mocks");
const fs = require("fs"), path = require("path");
const FILE = process.env.FILE || "index.html";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600)); };

const mk = (n, name, dLat, tags) => ({ type: "node", id: 9100 + n, lat: CENTER.lat + dLat, lon: CENTER.lon, tags: { name, shop: "car_repair", phone: "+33 4 72 00 00 0" + n, ...tags } });
const SPEEDY = { brand: "Speedy", "brand:wikidata": "Q3492969" };
const ELEMENTS = buildElements().concat([
  mk(1, "Speedy Lyon Part-Dieu", 0.0006, SPEEDY),                                                                                       // no address at all
  mk(2, "Speedy Lyon Gerland", 0.0010, { ...SPEEDY, "addr:postcode": "69007", "addr:city": "Lyon" }),                                  // postcode + city only
  mk(3, "Speedy Lyon Brotteaux", 0.0014, { ...SPEEDY, "addr:housenumber": "12", "addr:street": "Cours Lafayette", "addr:postcode": "69006", "addr:city": "Lyon" }), // complete
  mk(4, "Garage du Parc Gerland", 0.0018, { "addr:full": "3 place Jean Macé 69007 Lyon" }),                                            // addr:full
  mk(5, "Garage Les Pins", 0.0022, { "addr:place": "Les Pins", "addr:postcode": "69100", "addr:city": "Villeurbanne" }),              // addr:place
  mk(6, "Garage Contact", 0.0026, { "contact:housenumber": "5", "contact:street": "rue Contact", "contact:postcode": "69003", "contact:city": "Lyon" }), // contact:*
  mk(7, "AD Expert Sans Adresse", 0.0030, { brand: "AD", "brand:wikidata": "Q108753388" }),                                            // another chain, no address
  mk(8, undefined, 0.0034, {}),                                                                                                    // independent, no address
]);
const ID = (n) => `osm:node/${9100 + n}`;
const garageLat = (n) => CENTER.lat + [0, 0.0006, 0.0010, 0.0014, 0.0018, 0.0022, 0.0026, 0.0030, 0.0034][n];
const W = { width: 1440, height: 900 };

const openCard = async (page, n) => { await page.click(`#list [data-id="${ID(n)}"] .g-main`); };
const closeCard = async (page, n) => { await page.click(`#list [data-id="${ID(n)}"] .g-main`); await page.waitForTimeout(150); };
const val = (page, n) => page.evaluate((id) => {
  const c = document.querySelector(`#list [data-id="${CSS.escape(id)}"]`), v = c && c.querySelector(".r-to [data-ad], .facts [data-ad]");
  if (!v) return null;
  const s = v.querySelector('[aria-hidden="true"]');
  return { text: v.textContent.replace(/\s+/g, " ").trim(), approx: !!(s && s.textContent.trim() === "≈"), srOnly: !!v.querySelector(".sr-only"), title: v.getAttribute("title"), busy: v.classList.contains("is-busy"), live: v.getAttribute("aria-live") };
}, ID(n));
const waitDone = (page, n) => page.waitForFunction((id) => { const v = document.querySelector(`#list [data-id="${CSS.escape(id)}"] [data-ad]`); return v && !v.classList.contains("is-busy"); }, ID(n), { timeout: 5000 }).catch(() => {});
const opened = async (page, mock, o = {}) => {
  const r = await open(page.browser, page.server, FILE, { ...W, mock: { elements: ELEMENTS, ...mock }, ...o });
  await search(r.page, { service: "vidange" });
  await r.page.click("[data-sort=dist]"); await r.page.waitForTimeout(400);
  return r;
};
const nearly = (a, b) => Math.abs(a - b) < 2e-6;

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const env = { browser, server };
  const run = (mock, o) => opened(env, mock, o);

  // ===== A. default behaviour (reverse answers 14 m away, after 500 ms) =====
  let { page, ctx, logs } = await run({ reverse: { delayMs: 500 } }, { storage: { "jg.osm.v2": { stale: 1 } } });
  const c = ctx.__counters;
  check("A0 old OSM cache v2 removed; new one stores the extra tags", await page.evaluate(() => localStorage.getItem("jg.osm.v2") === null && !!localStorage.getItem("jg.osm.v3")));
  await openCard(page, 1);
  await page.waitForTimeout(150);
  const busy = await val(page, 1);
  check("A1 no address: 'Recherche de l'adresse…' while the request is pending", busy && busy.busy && /Recherche de l'adresse/.test(busy.text) && busy.live === "polite", JSON.stringify(busy));
  await waitDone(page, 1);
  const done = await val(page, 1);
  check("A2 resolved: '≈' (visual) + 'Environ' (screen readers) + street, postcode and city; title says 80 m max and BAN", done && done.approx && done.srOnly && /^≈ Environ \d+ Rue du Test, 69007 Lyon$/.test(done.text) && /à 14 m/.test(done.title) && /Base Adresse Nationale/.test(done.title) && !done.busy, JSON.stringify(done));
  const url0 = c.reverseUrls[0] || "", qp = new URLSearchParams(url0);
  check("A3 one request, to the reverse endpoint, with the garage's coordinates and limit=1", c.reverse === 1 && nearly(+qp.get("lat"), garageLat(1)) && nearly(+qp.get("lon"), CENTER.lon) && qp.get("limit") === "1", JSON.stringify([c.reverse, url0]));
  await page.waitForTimeout(500); // Leaflet fades the old tooltip out
  const tips = await page.evaluate(() => [...document.querySelectorAll(".leaflet-tooltip.tip-sel")].map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  check("A4 the tooltip of the selected marker shows the approximate address (a single tooltip left)", tips.length === 1 && /Speedy Lyon Part-Dieu/.test(tips[0]) && /≈ \d+ Rue du Test, 69007 Lyon/.test(tips[0]), JSON.stringify(tips));
  const gl = await page.evaluate((id) => decodeURIComponent(document.querySelector(`#list [data-id="${CSS.escape(id)}"] .act-reviews`).getAttribute("href")), ID(1));
  check("A5 the Google reviews link now carries the address (without the ≈)", /Speedy Lyon Part-Dieu, \d+ Rue du Test, 69007 Lyon/.test(gl) && !/≈/.test(gl), gl);
  const mem = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.addr.v1") || "{}"));
  const ent = Object.entries(mem);
  check("A6 answer cached under 'lat,lon' (5 decimals) with distance and date", ent.length === 1 && /^45\.76\d{3},4\.\d{5}$/.test(ent[0][0]) && /Rue du Test, 69007 Lyon$/.test(ent[0][1].a) && ent[0][1].d === 14 && ent[0][1].t > 0, JSON.stringify(mem));
  await shot(page, "ad-01-speedy-approx");
  await closeCard(page, 1); await openCard(page, 1); await page.waitForTimeout(250);
  check("A7 closing and reopening makes no new request", c.reverse === 1, c.reverse);

  await closeCard(page, 1);
  await openCard(page, 2);
  await page.waitForTimeout(150);
  const part = await val(page, 2);
  check("A8 postcode + city only: that partial address is shown meanwhile, without '≈'", part && !part.approx && part.text === "69007 Lyon", JSON.stringify(part));
  await waitDone(page, 2);
  const part2 = await val(page, 2);
  check("A9 ...then replaced by the nearest full address, marked '≈'", part2 && part2.approx && /Rue du Test, 69007 Lyon$/.test(part2.text) && c.reverse === 2, JSON.stringify([part2, c.reverse]));
  const before = c.reverse;
  const exp = { 3: "12 Cours Lafayette, 69006 Lyon", 4: "3 place Jean Macé 69007 Lyon", 5: "Les Pins, 69100 Villeurbanne", 6: "5 rue Contact, 69003 Lyon" };
  const got = {};
  for (const n of [3, 4, 5, 6]) { await closeCard(page, n - 1 > 2 ? n - 1 : 2); await openCard(page, n); await page.waitForTimeout(250); got[n] = await val(page, n); }
  check("A10 addresses already in OSM (street+number, addr:full, addr:place, contact:*) are shown as is, without '≈' and without any request", [3, 4, 5, 6].every((n) => got[n] && !got[n].approx && got[n].text === exp[n]) && c.reverse === before, JSON.stringify([got, c.reverse]));
  await openCard(page, 7); await waitDone(page, 7);
  const adv = await val(page, 7);
  await openCard(page, 8); await waitDone(page, 8);
  const ind = await val(page, 8);
  check("A11 other chains and nameless garages without address are completed too (one request each)", adv && adv.approx && ind && ind.approx && c.reverse === before + 2, JSON.stringify([adv, ind, c.reverse]));
  const gl8 = await page.evaluate((id) => decodeURIComponent(document.querySelector(`#list [data-id="${CSS.escape(id)}"] .act-reviews`).getAttribute("href")), ID(8));
  check("A12 a garage with no name keeps the generic 'garage' search term in the Google link", /\/maps\/search\/garage, \d+ Rue du Test, 69007 Lyon\//.test(gl8), gl8);
  await page.addScriptTag({ content: AXE });
  const ax = await page.evaluate(async () => { const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }); return r.violations.map((v) => v.id + "×" + v.nodes.length); });
  check("A13 axe: no violation with an approximate address open", ax.length === 0, JSON.stringify(ax));
  check("A14 no page error", logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));

  // ===== B. reload: addresses come back from the cache, no request =====
  const nReq = c.reverse;
  await page.reload();
  await page.waitForSelector("#list > li", { timeout: 8000 });
  await page.click("[data-sort=dist]"); await page.waitForTimeout(400);
  await openCard(page, 1); await page.waitForTimeout(200);
  const again = await val(page, 1);
  check("B1 after a reload the address is there at once (cache), with no new request", again && again.approx && !again.busy && /Rue du Test, 69007 Lyon$/.test(again.text) && c.reverse === nReq, JSON.stringify([again, c.reverse, nReq]));
  // suggestions of the repair dialog use the cached address at once (nothing opened, no request)
  await page.click("#addRepairBtn"); await page.waitForTimeout(250);
  await page.fill("#rGarage", "Speedy Lyon Part");
  await page.waitForSelector("#rGarageList li[data-i]", { state: "visible", timeout: 4000 });
  const sug = await page.$eval("#rGarageList li[data-i='0'] .s-sub", (e) => e.textContent);
  check("B4 after a reload the dialog suggestion already shows the cached address with '≈', without any request", /^≈ \d+ Rue du Test, 69007 Lyon/.test(sug) && c.reverse === nReq, JSON.stringify([sug, c.reverse, nReq]));
  await page.click("#dlgClose"); await page.waitForTimeout(300);
  const cached = {};
  for (const n of [3, 4, 5, 6]) { await closeCard(page, n === 3 ? 1 : n - 1); await openCard(page, n); await page.waitForTimeout(250); cached[n] = await val(page, n); }
  check("B3 tags kept in the OSM cache (addr:full, addr:place, contact:*) still give the same addresses after a reload", [3, 4, 5, 6].every((n) => cached[n] && !cached[n].approx && cached[n].text === exp[n]) && c.reverse === nReq, JSON.stringify([cached, c.reverse]));
  await page.evaluate(() => { const m = JSON.parse(localStorage.getItem("jg.addr.v1")); for (const k in m) m[k].t -= 91 * 864e5; localStorage.setItem("jg.addr.v1", JSON.stringify(m)); });
  await page.reload();
  await page.waitForSelector("#list > li", { timeout: 8000 });
  await page.click("[data-sort=dist]"); await page.waitForTimeout(400);
  await openCard(page, 1); await waitDone(page, 1);
  check("B2 an answer older than 90 days is asked again", c.reverse === nReq + 1, [c.reverse, nReq]);
  await ctx.close();

  // ===== C. far result (300 m): refused, remembered as a refusal =====
  ({ page, ctx, logs } = await run({ reverse: { offsetM: 300 } }));
  const cc = ctx.__counters;
  await openCard(page, 1); await waitDone(page, 1);
  const far = await val(page, 1);
  const farMem = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("jg.addr.v1") || "{}")));
  check("C1 nearest address 300 m away: refused, 'Adresse non renseignée' stays", far && !far.approx && far.text === "Adresse non renseignée" && cc.reverse === 1, JSON.stringify([far, cc.reverse]));
  check("C2 the refusal is cached (empty address) so it is not asked again", farMem.length === 1 && farMem[0].a === "", JSON.stringify(farMem));
  await closeCard(page, 1); await openCard(page, 1); await page.waitForTimeout(200);
  check("C3 reopening after a refusal makes no new request", cc.reverse === 1, cc.reverse);
  await ctx.close();

  // ===== D. network failure: nothing cached, one retry, then it stops =====
  ({ page, ctx, logs } = await run({ reverse: { fail: true } }));
  const cd = ctx.__counters;
  await openCard(page, 1); await waitDone(page, 1);
  const f1 = await val(page, 1);
  check("D1 failure: falls back to 'Adresse non renseignée', no cache entry", f1 && f1.text === "Adresse non renseignée" && !f1.busy && (await page.evaluate(() => localStorage.getItem("jg.addr.v1"))) === null, JSON.stringify(f1));
  await closeCard(page, 1); await openCard(page, 1); await waitDone(page, 1); await page.waitForTimeout(200);
  await closeCard(page, 1); await openCard(page, 1); await page.waitForTimeout(300);
  check("D2 one retry on the next opening, then no more requests", cd.reverse === 2, cd.reverse);
  check("D3 failures raise no page error", logs.errors.length === 0, JSON.stringify(logs.errors));
  await ctx.close();

  // ===== E. response variants =====
  ({ page, ctx } = await run({ reverse: { noDistance: true } }));
  await openCard(page, 1); await waitDone(page, 1);
  const nd = await val(page, 1);
  check("E1 no 'distance' property but a geometry: the distance is computed, address accepted", nd && nd.approx && /à 14 m/.test(nd.title), JSON.stringify(nd));
  await ctx.close();
  ({ page, ctx } = await run({ reverse: { noDistance: true, noGeometry: true } }));
  await openCard(page, 1); await waitDone(page, 1);
  const nn = await val(page, 1);
  check("E2 neither distance nor geometry: cannot be checked, so refused", nn && !nn.approx && nn.text === "Adresse non renseignée", JSON.stringify(nn));
  await ctx.close();
  ({ page, ctx } = await run({ reverse: { empty: true } }));
  await openCard(page, 1); await waitDone(page, 1);
  const em = await val(page, 1);
  check("E3 no feature returned: 'Adresse non renseignée'", em && !em.approx && em.text === "Adresse non renseignée", JSON.stringify(em));
  await ctx.close();

  // ===== F. repair dialog: picking a garage without address completes it =====
  ({ page, ctx, logs } = await run({ reverse: { delayMs: 400 } }));
  await page.click("#addRepairBtn"); await page.waitForTimeout(300);
  await page.fill("#rGarage", "Speedy Lyon Part");
  await page.waitForSelector("#rGarageList li[data-i]", { state: "visible", timeout: 4000 });
  await page.click("#rGarageList li[data-i='0']");
  await page.waitForTimeout(120);
  const pick0 = await page.$eval("#rGarageInfo", (e) => e.textContent);
  await page.waitForFunction(() => /≈/.test(document.getElementById("rGarageInfo").textContent), null, { timeout: 4000 }).catch(() => {});
  const pick1 = await page.$eval("#rGarageInfo", (e) => e.textContent);
  check("F1 dialog: the confirmation line first says 'Adresse non renseignée', then shows the approximate address", /Adresse non renseignée/.test(pick0) && /^✓ ≈ \d+ Rue du Test, 69007 Lyon/.test(pick1), JSON.stringify([pick0, pick1]));
  await ctx.close();

  // ===== G. contrôle technique: addresses come with the data, never looked up =====
  ({ page, ctx } = await open(browser, server, FILE, { ...W, mock: { elements: ELEMENTS } }));
  await page.selectOption("#service", "ct");
  await page.fill("#address", "12 rue de la république lyon"); await page.waitForSelector("#addrList li[data-i]", { state: "visible" }); await page.click("#addrList li[data-i='0']");
  await page.click("#go"); await page.waitForSelector("#list > li.card", { timeout: 12000 });
  await page.click("#list > li:nth-child(1) .g-main"); await page.waitForTimeout(400);
  const ctAddr = await page.$eval("#list > li:nth-child(1) .r-to .r-val", (e) => e.textContent.trim());
  check("G1 contrôle technique: address from the dataset, no reverse request", /Avenue du Test|avenue du Test/i.test(ctAddr) && ctx.__counters.reverse === 0, JSON.stringify([ctAddr, ctx.__counters.reverse]));
  await ctx.close();

  // ===== H. mobile =====
  ({ page, ctx, logs } = await run({ reverse: { delayMs: 200 } }, { width: 390, height: 844, dpr: 2, touch: true }));
  await page.tap(`#list [data-id="${ID(1)}"] .g-main`); await waitDone(page, 1);
  const mob = await val(page, 1);
  check("H1 mobile: same behaviour", mob && mob.approx && /Rue du Test, 69007 Lyon$/.test(mob.text) && logs.errors.length === 0, JSON.stringify(mob));
  await shot(page, "ad-02-mobile");
  await ctx.close();

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[addresses] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
