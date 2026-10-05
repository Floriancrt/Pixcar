// UX round: wording, no "dès", price scale with both medians, OpenStreetMap notices, phones, scrollbar corners.
// Usage: node ux.js [file] [only-section-letters]   (file defaults to index.html; run it on an older build to see the mutations fail)
const { serve, launch, open, search, SHOTS, ROOT, injectScript, injectStyle } = require("./harness");
const { buildElements, CENTER } = require("./mocks");
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || "index.html";
const ONLY = (process.argv[3] || "TDNSPBF").toUpperCase();
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 400));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const euro = (v) => norm(new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2, maximumFractionDigits: Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2 }).format(v));
const median = (a) => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const num = (t) => { const m = /(\d+(?:\s\d{3})*(?:,\d+)?)\s*€/.exec(norm(t)); return m ? parseFloat(m[1].replace(/\s/g, "").replace(",", ".")) : NaN; };
const has = (s, id) => ONLY.includes(s);

const REPAIRS = [
  { id: "r1", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Peugeot 208", rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-12", comment: "RAS", createdAt: "2026-09-12T10:00:00Z" },
  { id: "r2", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Renault Clio", rating: 5, serviceId: "vidange", price: 72, date: "2026-08-02", comment: "", createdAt: "2026-08-02T10:00:00Z" },
  { id: "r4", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Citroën C3", rating: 4, serviceId: "vidange", price: 119, date: "2026-06-02", comment: "", createdAt: "2026-06-02T10:00:00Z" },
  { id: "r5", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Peugeot 208", rating: 4, serviceId: "revision", price: 130, date: "2026-05-02", comment: "", createdAt: "2026-05-02T10:00:00Z" },
  { id: "r3", garageId: "custom:garage-du-coin", garageName: "Garage du Coin", garageAddr: "", lat: null, lon: null, chainId: "", model: "Dacia Sandero", rating: 3, serviceId: "plaq_av", price: 140, date: "2026-07-05", comment: "Un peu long", createdAt: "2026-07-05T10:00:00Z" },
];
const T = (lat, lon) => ({ lat: CENTER.lat + lat, lon: CENTER.lon + lon });
const EXTRA = [
  { type: "node", id: 9201, ...T(0.004, 0), tags: { name: "Garage Sans Numéro", shop: "car_repair", "addr:housenumber": "5", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon" } },
  { type: "node", id: 9202, ...T(0.005, 0), tags: { name: "Garage Deux Numéros", shop: "car_repair", "addr:housenumber": "7", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon", phone: "+33 (0)4 72 00 00 02", "contact:phone": "04.72.00 00.02", mobile: "06.12.34.56.78", "phone:mobile": "06 99 88 77 66" } },
  { type: "node", id: 9203, ...T(0.006, 0), tags: { name: "Garage Mobile Seul", shop: "car_repair", "addr:housenumber": "9", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon", mobile: "07 98 76 54 32" } },
  { type: "node", id: 9204, ...T(0.007, 0), tags: { name: "Garage Numéro Bidon", shop: "car_repair", "addr:housenumber": "11", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon", phone: "n/a" } },
  { type: "node", id: 9206, ...T(0.009, 0), tags: { name: "Garage Deux Dans Un Tag", shop: "car_repair", "addr:housenumber": "15", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon", phone: "04 72 00 00 06 / 04 72 00 00 07" } },
  { type: "node", id: 9205, ...T(0.008, 0), tags: { name: "Garage Belge", shop: "car_repair", "addr:housenumber": "13", "addr:street": "rue Neuve", "addr:postcode": "69002", "addr:city": "Lyon", "contact:phone": "+32 2 123 45 67" } },
];
const sel = (id) => `#list [data-id="osm:node/${id}"]`;
const sortDist = async (page) => { await page.click("[data-sort=dist]"); await page.waitForTimeout(250); };
async function openCard(page, id) {
  await page.locator(`${sel(id)} .g-main`).scrollIntoViewIfNeeded();
  await page.click(`${sel(id)} .g-main`);
  await page.waitForTimeout(450);
}
async function chainPrices(page, service) {
  await page.click(".tab[data-view=prix]");
  await page.selectOption("#refService", service);
  await page.waitForTimeout(200);
  const rows = await page.$$eval("#refList > li", (l) => l.map((li) => ({ price: (li.querySelector(".ref-price") || {}).textContent || "", partial: !!li.querySelector(".tag.warn") })));
  await page.click(".tab[data-view=garages]");
  await page.waitForTimeout(200);
  return rows.map((r) => ({ price: num(r.price.replace(/env\./, "")), partial: r.partial })).filter((r) => Number.isFinite(r.price));
}
// Pixel diff between the normal page and the same page with the scroller's overflow switched off: whatever differs
// outside the rounded shape (or in the first/last 17 px of the track) is the scrollbar poking out of the corners.
async function cornerDiff(browser, page, selector, radius, inset) {
  const geo = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, selector);
  const clip = { x: Math.floor(geo.r - 40), y: Math.floor(geo.t - 6), width: 52, height: Math.ceil(geo.b - geo.t) + 12 };
  const a = await page.screenshot({ clip });
  const pad = await page.evaluate((s) => { const e = document.querySelector(s); return { sb: e.offsetWidth - e.clientWidth, pr: parseFloat(getComputedStyle(e).paddingRight) }; }, selector);
  const undo = await injectStyle(page, `${selector}{overflow:hidden!important;padding-right:${pad.pr + pad.sb}px!important}`);
  await page.waitForTimeout(150);
  const b = await page.screenshot({ clip });
  await undo();
  const pg = await browser.newPage();
  const px = async (buf) => pg.evaluate(async (b64) => { const i = new Image(); i.src = "data:image/png;base64," + b64; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return { w: c.width, h: c.height, d: Array.from(g.getImageData(0, 0, c.width, c.height).data) }; }, buf.toString("base64"));
  const A = await px(a), B = await px(b);
  await pg.close();
  const out = { corners: 0, ends: 0, track: 0 };
  const H = geo.b - geo.t;
  for (let y = 0; y < A.h; y++)
    for (let x = 0; x < A.w; x++) {
      const o = (y * A.w + x) * 4;
      if (Math.abs(A.d[o] - B.d[o]) + Math.abs(A.d[o + 1] - B.d[o + 1]) + Math.abs(A.d[o + 2] - B.d[o + 2]) < 24) continue;
      const px_ = clip.x + x + 0.5, py_ = clip.y + y + 0.5;
      const inTop = py_ < geo.t + radius, inBot = py_ > geo.b - radius;
      const cx = geo.r - radius, cy = inTop ? geo.t + radius : geo.b - radius;
      const dist = (inTop || inBot) && px_ > cx ? Math.hypot(px_ - cx, py_ - cy) : 0;
      if (dist > radius + 2) out.corners++; // drawn outside the rounded shape
      else if (dist > radius - 2) continue; // the anti-aliased edge of the rounded clip itself differs a little with a scrollbar
      else if (px_ > geo.r - 14 && (py_ < geo.t + inset - 1 || py_ > geo.b - inset + 1)) out.ends++; // bar or arrow in the first/last 17 px
      else if (px_ > geo.r - 14) out.track++;
    }
  return out;
}

(async () => {
  const server = await serve(ROOT);
  const browser = await launch({ scrollbars: true });
  const els = buildElements().concat(EXTRA);
  const oldCache = (n) => ({ "jg.osm.v3": { [`${CENTER.lat.toFixed(4)},${CENTER.lon.toFixed(4)},10000`]: { at: `${CENTER.lat.toFixed(4)},${CENTER.lon.toFixed(4)}`, m: 10000, t: Date.now() - 5 * 864e5, els: buildElements(n) } } });

  // =============== T. Wording ===============
  if (has("T")) try {
    let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 });
    check("T1 tagline under the logo (exact wording)", norm(await page.textContent(".panel-sub")) === "1ère plateforme communautaire de comparaison de prestations d'entretien et de réparation auto", await page.textContent(".panel-sub"));
    check("T2 tagline is visible on desktop, under the wordmark", await page.evaluate(() => { const s = document.querySelector(".panel-sub").getBoundingClientRect(), b = document.querySelector(".t-brand").getBoundingClientRect(); return s.height > 0 && s.top >= b.bottom - 1; }));
    check("T3 empty-map sentence (exact wording)", norm(await page.textContent(".map-empty span")) === "Votre titine est comme vous, elle n'aime pas qu'on lui cache des choses", await page.textContent(".map-empty span"));
    check("T4 empty-map sentence is on screen", await page.evaluate(() => { const r = document.querySelector(".map-empty span").getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    const html = await page.content();
    check("T5 old sentences are gone", !html.includes("Choisissez une prestation et une adresse") && !html.includes("Comparez le prix d'une prestation autour de votre adresse"));
    check("T6 page title and meta description unchanged", (await page.title()) === "Pixcar" && /comparez le prix d'une prestation/.test(await page.getAttribute('meta[name="description"]', "content")));
    check("T7 console clean", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    await ctx.close();
    ({ page, ctx } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true }));
    check("T8 tagline stays desktop-only (mobile keeps the compact header)", !(await page.isVisible(".panel-sub")));
    await ctx.close();
  } catch (e) {
    check("T section crashed", false, e && e.message);
  }

  // =============== D. No « dès » on prices ===============
  if (has("D")) try {
    let { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, storage: { "jg.repairs.v1": REPAIRS }, mock: { elements: els } });
    await search(page, { service: "vidange" });
    await sortDist(page);
    const bad = (t) => /dès\s*\d/i.test(t); // « dès 59,95 € » (textContent may glue the label to the word: « Prixdès 59,95 € »)
    const parts = await page.evaluate(() => ({
      prices: [...document.querySelectorAll("#list .g-price")].map((e) => e.textContent),
      from: [...document.querySelectorAll("#list .amount .from")].map((e) => e.textContent),
      summary: document.getElementById("summary").textContent,
      strips: [...document.querySelectorAll("#list .g-strip, #list .strip")].map((e) => e.textContent),
    }));
    check("D1 no « dès » in card prices", !parts.prices.some(bad) && !parts.from.some(bad), JSON.stringify(parts.prices.filter(bad)));
    check("D2 no « dès » in the summary line", !bad(parts.summary), parts.summary);
    check("D3 « env. » stays for approximate prices (only « dès » went)", await page.evaluate(() => document.querySelector("#list .amount .from") === null || [...document.querySelectorAll("#list .amount .from")].every((e) => e.textContent === "env.")));
    // a chain-priced garage: price note + map bar + tooltip
    // (Norauto, Feu Vert, Speedy and Midas publish « à partir de » prices: the ones that used to carry « dès »)
    const chainCard = await page.evaluate(() => { const c = [...document.querySelectorAll("#list > li.card")].find((c) => /^(Norauto|Feu Vert|Speedy|Midas)/.test(c.querySelector(".g-name").textContent) && c.querySelector(".tag.ok") && /Prix enseigne/.test(c.textContent)); return c ? c.dataset.id : null; });
    check("D4 a chain-priced card exists in the fixture", !!chainCard);
    if (chainCard) {
      await page.locator(`#list [data-id="${chainCard}"] .g-main`).scrollIntoViewIfNeeded();
      await page.click(`#list [data-id="${chainCard}"] .g-main`);
      await page.waitForTimeout(500);
      const note = await page.$eval(`#list [data-id="${chainCard}"] .price-note`, (e) => e.textContent);
      check("D5 details price note has no « dès »", !bad(note), note);
      const bar = norm(await page.textContent("#mapInfo"));
      check("D6 map bar price has no « dès »", !bad(bar), bar);
    }
    // declared + chain reference note (Norauto Bron)
    await openCard(page, 1022);
    const noteDecl = await page.$eval(`${sel(1022)} .price-note`, (e) => e.textContent);
    check("D7 « prix enseigne … » note has no « dès »", /prix enseigne \d/.test(norm(noteDecl)) && !bad(noteDecl), noteDecl);
    // Prix page
    await page.click(".tab[data-view=prix]");
    for (const s of ["vidange", "geo_av", "montage", "diag"]) {
      await page.selectOption("#refService", s);
      await page.waitForTimeout(120);
      const rp = await page.$$eval("#refList .ref-price", (l) => l.map((e) => e.textContent));
      check(`D8 Prix page ${s}: no « dès » before prices`, rp.length > 0 && !rp.some(bad), JSON.stringify(rp.filter(bad)));
    }
    check("D9 the « à partir de » disclosure stays once on the Prix page (its spaces are non-breaking: « \u00a0à\u00a0partir\u00a0de\u00a0 »)", /à\spartir\sde/.test(await page.textContent("#refsSub")));
    await page.selectOption("#refService", "vidange");
    await page.waitForTimeout(150);
    check("D10 promo wording from the chains' own offers is untouched", /vidange dès 49,95/.test(norm(await page.textContent("#refList"))), "expected the Norauto offer wording to be kept as published");
    await ctx.close();
  } catch (e) {
    check("D section crashed", false, e && e.message);
  }

  // =============== N. OpenStreetMap notices ===============
  if (has("N")) try {
    // N1: servers down, a 5-day-old saved list is reused
    let { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, storage: oldCache(12), mock: { overpassFail: true } });
    await search(page, { service: "vidange" });
    const sum = norm(await page.textContent("#summary"));
    check("N1 saved list reused when the servers are down", (await page.$$eval("#list > li.card", (l) => l.length)) === buildElements(12).length, sum);
    check("N2 no OpenStreetMap / « ne répond pas » paragraph in the summary", !/OpenStreetMap|ne répond pas|serveur/i.test(sum), sum);
    check("N3 the saved-list date and « Actualiser » remain", /Liste des garages enregistrée le/.test(sum) && (await page.isVisible("#refreshBtn")), sum);
    check("N4 exactly one hint line (the date), nothing about OSM", (await page.$$eval("#summary .hint", (l) => l.length)) === 1);
    await ctx.close();

    // N5: servers down, no cache: registry fallback, no explanatory paragraph either
    const sir = [0, 1, 2].map((i) => ({ siret: "9000000000" + i, name: `Atelier Registre ${i + 1}`, lat: CENTER.lat + 0.003 * (i + 1), lon: CENTER.lon, adresse: `${i + 3} rue du Registre 69002 LYON` }));
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassFail: true, sireneItems: sir } }));
    await search(page, { service: "vidange" });
    const sum2 = norm(await page.textContent("#summary"));
    check("N5 registry list shown when the garage base is down", (await page.$$eval("#list > li.card", (l) => l.length)) === 3, sum2);
    check("N6 no OpenStreetMap / « sans téléphone » paragraph on the registry list", !/OpenStreetMap|sans téléphone|ne répond pas/i.test(sum2), sum2);
    check("N7 the registry cards have no call button", (await page.$$eval("#list .act-call", (l) => l.length)) === 0);
    await page.click("#list > li:nth-child(1) .g-main");
    await page.waitForTimeout(400);
    const rows = await page.$$eval("#list .is-open .facts dt", (l) => l.map((e) => e.textContent));
    check("N8 registry sheet keeps its three rows with « Non renseigné »", JSON.stringify(rows) === JSON.stringify(["Téléphone", "Horaires", "Site"]), JSON.stringify(rows));
    await ctx.close();

    // N9: everything down: the error names no technical service
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassFail: true, sireneFail: true } }));
    await page.fill("#address", "12 rue de la république lyon");
    await page.waitForSelector("#addrList li[data-i]", { state: "visible", timeout: 5000 });
    await page.click("#addrList li[data-i='0']");
    await page.click("#go");
    await page.waitForFunction(() => /Réessayez dans une minute/.test(document.body.innerText), null, { timeout: 15000 });
    const body = norm(await page.evaluate(() => document.body.innerText));
    check("N9 total failure message: no jargon on screen", /Ni la base des garages ni le registre des entreprises ne répondent/.test(body) && !/OpenStreetMap|overpass/i.test(body), body.slice(0, 300));
    const det = await page.$eval("#status .detail", (d) => ({ open: d.open, summary: d.querySelector("summary").textContent, text: d.textContent }));
    check("N9b the server list is kept for support, folded under « Détails techniques »", !det.open && det.summary === "Détails techniques" && /overpass-api\.de/.test(det.text), JSON.stringify(det));
    await ctx.close();

    // N10: the optional registry failing says so in plain words
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { sireneFail: true } }));
    await page.click("#moreOpts > summary").catch(() => {});
    await search(page, { service: "vidange", sirene: true });
    const sum3 = norm(await page.textContent("#summary"));
    check("N10 optional registry failure: plain sentence without OpenStreetMap", /Le registre SIRENE n'a pas répondu : aucun atelier n'est ajouté à cette liste\./.test(sum3) && !/OpenStreetMap/.test(sum3), sum3);
    // N11: the licence credit stays where the garages are listed, and on the map
    check("N11 ODbL credit under the list", (await page.isVisible("#osmNote")) && /OpenStreetMap/.test(await page.textContent("#osmNote")) && (await page.getAttribute("#osmNote a", "href")) === "https://www.openstreetmap.org/copyright");
    check("N12 ODbL credit on the map", /OpenStreetMap/.test(await page.textContent(".leaflet-control-attribution")));
    await ctx.close();
    // N13: the sources paragraph says what the data is for
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    await page.click(".tab[data-view=prix]");
    const src = norm(await page.evaluate(() => document.querySelector("details.sources").textContent));
    check("N13 sources paragraph says what OpenStreetMap provides", /Garages \(nom, position, adresse, téléphone, horaires, site\) : © les contributeurs d'OpenStreetMap/.test(src), src.slice(0, 400));
    await ctx.close();
  } catch (e) {
    check("N section crashed", false, e && e.message);
  }

  // =============== S. Price scale with both medians ===============
  if (has("S")) try {
    for (const scheme of ["light", "dark"]) {
      let { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme, storage: { "jg.repairs.v1": REPAIRS }, mock: { elements: els } });
      await search(page, { service: "vidange" });
      await sortDist(page);
      const chains = (await chainPrices(page, "vidange")).filter((r) => !r.partial).map((r) => r.price);
      check(`S0 [${scheme}] chain prices read from the Prix page`, chains.length >= 3, JSON.stringify(chains));
      await openCard(page, 1022);
      const sc = await page.$eval(`${sel(1022)} .scale`, (el) => {
        const t = (s) => { const e = el.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : null; };
        return {
          head: t(".label"), delta: t(".delta"), deltaCls: (el.querySelector(".delta") || {}).className || "", ref: t(".cmp.is-ref .cmp-v"), me: t(".cmp.is-me .cmp-v"),
          refKey: t(".cmp.is-ref .cmp-k"), meKey: t(".cmp.is-me .cmp-k"), refLeft: (el.querySelector(".scale-ref") || { style: {} }).style.left, medLeft: (el.querySelector(".scale-med") || { style: {} }).style.left,
          dots: [...el.querySelectorAll(".scale-dot")].map((d) => d.style.left), ends: t(".scale-ends"), text: t(".scale-text"), barHidden: el.querySelector(".scale-bar").getAttribute("aria-hidden"), noRef: el.classList.contains("no-ref"),
          legend: !!el.querySelector(".scale-legend"), pill: !!el.querySelector(".scale-median"), tiles: el.querySelectorAll(".cmp").length,
        };
      });
      const declared = REPAIRS.filter((r) => r.serviceId === "vidange").map((r) => r.price);
      const refMed = median(chains), meMed = median(declared), gap = (meMed - refMed) / refMed;
      const all = declared.concat(chains), mn = Math.min(...all), mx = Math.max(...all), pos = (v) => (((v - mn) / (mx - mn)) * 100).toFixed(1) + "%";
      check(`S1 [${scheme}] chains' median is flagged with its label and value`, sc.ref === euro(refMed) && /Médiane des enseignes/.test(sc.refKey), JSON.stringify([sc.ref, euro(refMed), sc.refKey]));
      check(`S2 [${scheme}] garage's median is flagged with its label and value`, sc.me === euro(meMed) && /Médiane de ce garage/.test(sc.meKey), JSON.stringify([sc.me, euro(meMed), sc.meKey]));
      const pct = Math.round(100 * Math.abs(gap));
      check(`S3 [${scheme}] gap pill: ${pct} % ${gap < 0 ? "sous" : "au-dessus des"} les enseignes`, norm(sc.delta) === `${pct} % ${gap < 0 ? "sous les enseignes" : "au-dessus des enseignes"}` && sc.deltaCls.includes(gap < 0 ? "is-low" : "is-high"), JSON.stringify([sc.delta, sc.deltaCls]));
      check(`S4 [${scheme}] markers sit at the computed positions`, sc.refLeft === pos(refMed) && sc.medLeft === pos(meMed), JSON.stringify([sc.refLeft, pos(refMed), sc.medLeft, pos(meMed)]));
      check(`S5 [${scheme}] one dot per declared repair`, JSON.stringify(sc.dots.map(parseFloat).sort((a, b) => a - b)) === JSON.stringify(declared.map((v) => parseFloat(pos(v))).sort((a, b) => a - b)), JSON.stringify(sc.dots));
      check(`S6 [${scheme}] ends and sentence`, sc.ends === `${euro(mn)} · moins cherplus cher · ${euro(mx)}` && sc.text === `3 réparations déclarées, de ${euro(Math.min(...declared))} à ${euro(Math.max(...declared))}.`, JSON.stringify([sc.ends, sc.text]));
      check(`S7 [${scheme}] no median pill, legend or « dès » wording left; bar stays decorative`, !sc.pill && !sc.legend && !/dès|prix médian « /.test(sc.text + sc.head + sc.delta) && sc.barHidden === "true" && sc.tiles === 2, JSON.stringify(sc));
      // the medians are plain text (not only drawn): readable without the bar
      const txt = norm(await page.$eval(`${sel(1022)} .scale`, (e) => e.innerText));
      check(`S8 [${scheme}] both medians and the gap are readable as text`, txt.includes("Médiane des enseignes") && txt.includes("Médiane de ce garage") && txt.includes(euro(refMed)) && txt.includes(euro(meMed)) && txt.includes(sc.delta), txt);
      // the history of the same fiche: one block per declared service, each with its own median and a Supprimer per row
      await page.click(`${sel(1022)} details.history > summary`);
      await page.waitForTimeout(250);
      const blocks = await page.$$eval(`${sel(1022)} .h-type`, (l) => l.map((b) => ({ name: b.querySelector(".h-type-name").textContent.trim(), med: (b.querySelector(".h-median b") || {}).textContent || "", rows: b.querySelectorAll(".h-rows li").length, del: b.querySelectorAll(".h-del").length })));
      const vid = blocks.find((g) => /idange/.test(g.name)), rev = blocks.find((g) => /évision/i.test(g.name));
      check(`S9 [${scheme}] fiche history: one block per declared service, with its median and a Supprimer per row`, vid && vid.rows === 3 && vid.del === 3 && norm(vid.med) === euro(median(declared)) && rev && rev.rows === 1 && rev.del === 1 && norm(rev.med) === euro(130), JSON.stringify(blocks));
      // « revision » has no chain price: the same scale component shows only the garage median
      await page.selectOption("#service", "revision");
      await page.waitForTimeout(350);
      if (!(await page.$(`${sel(1022)} .scale`))) await openCard(page, 1022);
      const rv = await page.$eval(`${sel(1022)} .scale`, (el) => ({ noRef: el.classList.contains("no-ref"), tiles: el.querySelectorAll(".cmp").length, delta: !!el.querySelector(".delta"), ref: !!el.querySelector(".scale-ref"), med: !!el.querySelector(".scale-med"), me: (el.querySelector(".cmp.is-me .cmp-v") || {}).textContent }));
      check(`S10 [${scheme}] service without chain price: the fiche scale shows only the garage median`, rv.noRef && rv.tiles === 1 && !rv.delta && !rv.ref && rv.med && norm(rv.me) === euro(130), JSON.stringify(rv));
      await ctx.close();
    }
    // S11: narrow screens: nothing overflows
    let { page, ctx } = await open(browser, server, FILE, { width: 320, height: 640, dpr: 2, touch: true, storage: { "jg.repairs.v1": REPAIRS }, mock: { elements: els } });
    await search(page, { service: "vidange" });
    await sortDist(page);
    await openCard(page, 1022);
    const ov = await page.$eval(`${sel(1022)} .scale`, (el) => ({ sw: el.scrollWidth, cw: el.clientWidth, cmp: [...el.querySelectorAll(".cmp")].map((c) => c.scrollWidth - c.clientWidth), head: el.querySelector(".scale-head").scrollWidth - el.querySelector(".scale-head").clientWidth }));
    check("S11 320 px: scale, tiles and head fit", ov.sw <= ov.cw && ov.cmp.every((d) => d <= 0) && ov.head <= 0, JSON.stringify(ov));
    await ctx.close();
    // S13/S14: the pill's three states (close to the chains' median, above it)
    for (const [price, kind, txt, cls] of [[88, "S13", "Au niveau des enseignes", "is-eq"], [130, "S14", "48 % au-dessus des enseignes", "is-high"]]) {
      ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, storage: { "jg.repairs.v1": [{ ...REPAIRS[0], id: "y1", serviceId: "vidange", price }] }, mock: { elements: els } }));
      await search(page, { service: "vidange" });
      await sortDist(page);
      await openCard(page, 1022);
      const pill = await page.$eval(`${sel(1022)} .scale .delta`, (e) => ({ t: e.textContent.replace(/\s+/g, " ").trim(), c: e.className }));
      check(`${kind} gap pill for a garage median of ${price} € (chains' median 87,60 €)`, pill.t === txt && pill.c.includes(cls), JSON.stringify(pill));
      await ctx.close();
    }
    // S12: all prices identical -> markers coincide at 50 %, nothing breaks
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, storage: { "jg.repairs.v1": [{ ...REPAIRS[0], id: "x1", serviceId: "revision", price: 90 }].map((r) => ({ ...r, garageId: "osm:node/1022" })) }, mock: { elements: els } }));
    await search(page, { service: "revision" });
    await sortDist(page);
    await openCard(page, 1022);
    const one = await page.$eval(`${sel(1022)} .scale`, (el) => ({ med: el.querySelector(".scale-med").style.left, ends: !!el.querySelector(".scale-ends"), text: el.querySelector(".scale-text").textContent }));
    check("S12 single price: marker at 50 %, no ends row, « Les prochaines déclarations… » kept", one.med === "50%" && !one.ends && /Les prochaines déclarations compléteront l'échelle\.$/.test(one.text), JSON.stringify(one));
    await ctx.close();
  } catch (e) {
    check("S section crashed", false, e && e.message);
  }

  // =============== P. Phones ===============
  if (has("P")) try {
    let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await search(page, { service: "vidange" });
    await sortDist(page);
    const call = async (id) => page.$eval(`${sel(id)} .act-call`, (a) => ({ href: a.getAttribute("href"), label: a.getAttribute("aria-label") })).catch(() => null);
    const phones = async (id) => page.$$eval(`${sel(id)} .facts .phone`, (l) => l.map((a) => ({ t: a.textContent, h: a.getAttribute("href") })));
    // two numbers (+33 (0)…, dots, contact:phone and mobile duplicates)
    check("P1 call button uses the first number, international link, labelled", JSON.stringify(await call(9202)) === JSON.stringify({ href: "tel:+33472000002", label: "Appeler le 04 72 00 00 02" }), JSON.stringify(await call(9202)));
    await openCard(page, 9202);
    const two = await phones(9202);
    check("P2 sheet shows two numbers, French format, tel: links (same number in another format counted once, third left out)", JSON.stringify(two) === JSON.stringify([{ t: "04 72 00 00 02", h: "tel:+33472000002" }, { t: "06 12 34 56 78", h: "tel:+33612345678" }]), JSON.stringify(two));
    const copies = await page.$$eval(`${sel(9202)} .facts [data-act=copy]`, (l) => l.map((b) => b.dataset.v));
    check("P3 one « Copier » per number, each carrying its own number", JSON.stringify(copies) === JSON.stringify(["04 72 00 00 02", "06 12 34 56 78"]), JSON.stringify(copies));
    await page.click(`${sel(9202)} .facts .ph:nth-child(2) [data-act=copy]`);
    await page.waitForTimeout(200);
    const copied = await page.evaluate(async () => { let c = null; try { c = await navigator.clipboard.readText(); } catch (e) {} return { clip: c, sel: String(getSelection()).trim() }; });
    check("P4 « Copier » on the second line copies the second number", copied.clip === "06 12 34 56 78" || copied.sel === "06 12 34 56 78", JSON.stringify(copied));
    // clipboard refused (insecure context, denied permission): the number of that very line gets selected instead
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("denied")); getSelection().removeAllRanges(); });
    await page.click(`${sel(9202)} .facts .ph:nth-child(2) [data-act=copy]`);
    await page.waitForTimeout(150);
    const fall = await page.evaluate(() => ({ sel: String(getSelection()).trim(), label: document.querySelector("#list .is-open .facts .ph:nth-child(2) [data-act=copy]").textContent }));
    check("P4b clipboard refused: the second number (not the first) is selected, button says « Sélectionné »", fall.sel === "06 12 34 56 78" && fall.label === "Sélectionné", JSON.stringify(fall));
    await openCard(page, 9206);
    check("P4c two numbers written in one tag (« / »)", JSON.stringify((await phones(9206)).map((x) => x.t)) === JSON.stringify(["04 72 00 00 06", "04 72 00 00 07"]), JSON.stringify(await phones(9206)));
    // mobile tag only
    check("P5 a garage with only a « mobile » tag gets its number and call button", JSON.stringify(await call(9203)) === JSON.stringify({ href: "tel:+33798765432", label: "Appeler le 07 98 76 54 32" }), JSON.stringify(await call(9203)));
    // junk and missing numbers
    check("P6 junk value « n/a » is not shown as a number; no call button", (await call(9204)) === null);
    check("P7 no number: no call button", (await call(9201)) === null);
    await openCard(page, 9201);
    const none = await page.$eval(`${sel(9201)} .facts`, (dl) => { const dd = [...dl.children].find((e, i, a) => e.tagName === "DT" && e.textContent === "Téléphone"); const v = dd.nextElementSibling; return { text: v.textContent.replace(/\s+/g, " ").trim(), href: (v.querySelector("a") || {}).href || "", target: (v.querySelector("a") || {}).target, rel: (v.querySelector("a") || {}).rel, phones: dl.querySelectorAll(".phone").length }; });
    check("P8 missing number: « Non renseigné » + Google Maps search link (new tab, noopener)", /^Non renseigné · chercher sur Google Maps$/.test(none.text) && /^https:\/\/www\.google\.com\/maps\/search\//.test(none.href) && none.target === "_blank" && /noopener/.test(none.rel) && none.phones === 0, JSON.stringify(none));
    check("P9 the Google link names the garage and its address", decodeURIComponent(none.href).includes("Garage Sans Numéro") && decodeURIComponent(none.href).includes("rue Neuve"), none.href);
    const rows = await page.$$eval(`${sel(9201)} .facts dt`, (l) => l.map((e) => e.textContent));
    const vals = await page.$$eval(`${sel(9201)} .facts dd`, (l) => l.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    check("P10 every sheet shows Téléphone, Horaires, Site; missing ones read « Non renseigné(s) »", JSON.stringify(rows) === JSON.stringify(["Téléphone", "Horaires", "Site"]) && vals[1] === "Non renseignés" && vals[2] === "Non renseigné", JSON.stringify([rows, vals]));
    // foreign number kept as written
    await openCard(page, 9205);
    check("P11 foreign number kept in international form", JSON.stringify(await phones(9205)) === JSON.stringify([{ t: "+32 2 123 45 67", h: "tel:+3221234567" }]), JSON.stringify(await phones(9205)));
    // default fixtures: +33 4 7X … -> national format
    const fx = await page.$eval("#list > li.card:not([data-id*='92']) .act-call", (a) => a.getAttribute("href"));
    check("P12 fixture numbers (+33 4 7x …) give a +33 link", /^tel:\+33\d{9}$/.test(fx), fx);
    // cache path (filtered tags) keeps the mobile tag after a reload
    const c1 = await page.evaluate(() => { const k = JSON.parse(localStorage.getItem("jg.osm.v3") || "{}"); return Object.values(k).some((e) => e.els.some((x) => x.tags && x.tags.mobile === "07 98 76 54 32")); });
    check("P13 the « mobile » tag survives the whitelist used for the saved list", c1);
    await page.reload();
    await page.waitForSelector("#list > li.card", { timeout: 12000 });
    await sortDist(page);
    check("P14 saved list (no network) still gives the mobile-only garage its call button", JSON.stringify(await call(9203)) === JSON.stringify({ href: "tel:+33798765432", label: "Appeler le 07 98 76 54 32" }), JSON.stringify(await call(9203)));
    check("P15 console clean", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    await ctx.close();
    // CT centres: official data field cct_tel, same formatting
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    await page.selectOption("#service", "ct");
    await page.fill("#address", "lyon");
    await page.waitForSelector("#addrList li[data-i]");
    await page.click("#addrList li[data-i='0']");
    await page.click("#go");
    await page.waitForSelector("#list > li.card", { timeout: 12000 });
    await page.click("#list > li.card:nth-child(1) .g-main");
    await page.waitForTimeout(400);
    const ct = await page.$$eval("#list .is-open .facts .phone", (l) => l.map((a) => [a.textContent, a.getAttribute("href")]));
    check("P16 contrôle technique centre: number formatted, tel: link", ct.length === 1 && /^0\d( \d{2}){4}$/.test(ct[0][0]) && /^tel:\+33\d{9}$/.test(ct[0][1]), JSON.stringify(ct));
    await ctx.close();
    // sheet rows line up: label and number share a baseline
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: els } }));
    await search(page, { service: "vidange" });
    await sortDist(page);
    await openCard(page, 9202);
    const base = await page.evaluate((s) => { const dl = document.querySelector(`${s} .facts`); const dt = [...dl.querySelectorAll("dt")].find((e) => e.textContent === "Téléphone"), a = dl.querySelector(".phone"); const r = document.createRange(); r.selectNodeContents(dt); const rb = r.getBoundingClientRect(); r.selectNodeContents(a); const ra = r.getBoundingClientRect(); return { dt: rb.bottom, a: ra.bottom }; }, sel(9202));
    check("P17 « Téléphone » label and the first number share a baseline (±2 px)", Math.abs(base.dt - base.a) <= 2, JSON.stringify(base));
    await ctx.close();
  } catch (e) {
    check("P section crashed", false, e && e.message);
  }

  // =============== B. Scrollbar stays inside the rounded panel ===============
  if (has("B")) try {
    for (const scheme of ["light", "dark"]) {
      const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme, mock: { elements: els } });
      await search(page, { service: "vidange" });
      await page.mouse.move(1000, 450);
      const sb = await page.$eval("#panelCol", (p) => ({ w: p.offsetWidth - p.clientWidth, over: p.scrollHeight > p.clientHeight }));
      check(`B1 [${scheme}] the panel scrolls and shows a classic scrollbar`, sb.over && sb.w > 0, JSON.stringify(sb));
      const cs = await page.evaluate(() => { const p = document.getElementById("panelCol"); const g = (s) => { try { return getComputedStyle(p, s); } catch (e) { return null; } }; const b = g("::-webkit-scrollbar-button"), w = g("::-webkit-scrollbar"); return { btn: b && b.display, width: w && w.width }; });
      check(`B2 [${scheme}] no arrow buttons, 12 px bar`, cs.btn === "none" && cs.width === "12px", JSON.stringify(cs));
      let d = await cornerDiff(browser, page, "#panelCol", 28, 18);
      check(`B3 [${scheme}] scrollbar at the top: nothing drawn outside the rounded corner`, d.corners === 0, JSON.stringify(d));
      check(`B4 [${scheme}] scrollbar at the top: bar starts below the curve (first 17 px empty)`, d.ends === 0 && d.track > 0, JSON.stringify(d));
      await page.evaluate(() => { const p = document.getElementById("panelCol"); p.scrollTop = p.scrollHeight; });
      await page.waitForTimeout(250);
      d = await cornerDiff(browser, page, "#panelCol", 28, 18);
      check(`B5 [${scheme}] scrolled to the bottom: nothing outside the corner, bar ends above the curve`, d.corners === 0 && d.ends === 0 && d.track > 0, JSON.stringify(d));
      await ctx.close();
    }
    // dialog (same rounded corners): short window so that it scrolls
    const { page, ctx } = await open(browser, server, FILE, { width: 900, height: 420, mock: { elements: els } });
    await page.click("#addRepairBtn");
    await page.waitForTimeout(400);
    const dl = await page.$eval("#repairDlg", (d) => ({ over: d.scrollHeight > d.clientHeight, w: d.offsetWidth - d.clientWidth }));
    check("B6 dialog: scrolls with a classic scrollbar in a short window", dl.over && dl.w > 0, JSON.stringify(dl));
    const dd = await cornerDiff(browser, page, "#repairDlg", 28, 18);
    check("B7 dialog: scrollbar inside the rounded corners", dd.corners === 0 && dd.ends === 0 && dd.track > 0, JSON.stringify(dd));
    await ctx.close();
  } catch (e) {
    check("B section crashed", false, e && e.message);
  }

  // =============== (B, continued) touch screens keep the native overlay scrollbars ===============
  if (has("B")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 390, height: 600, dpr: 2, touch: true, mock: { elements: els } });
    await page.click("#addRepairBtn");
    await page.waitForTimeout(400);
    const w = await page.$eval("#repairDlg", (d) => ({ over: d.scrollHeight > d.clientHeight, w: getComputedStyle(d, "::-webkit-scrollbar").width, gutter: d.offsetWidth - d.clientWidth }));
    check("B8 touch screen: dialog keeps native scrollbars (no 12 px custom bar)", w.over && w.w !== "12px" && w.gutter === 0, JSON.stringify(w));
    await ctx.close();
  } catch (e) {
    check("B8 section crashed", false, e && e.message);
  }

  // =============== F. Accessibility of the new pieces ===============
  if (has("F")) try {
    for (const [scheme, mobile] of [["light", false], ["dark", false], ["light", true], ["dark", true]]) {
      const o = mobile ? { width: 390, height: 844, dpr: 2, touch: true } : { width: 1440, height: 900 };
      const { page, ctx } = await open(browser, server, FILE, { ...o, colorScheme: scheme, storage: { "jg.repairs.v1": REPAIRS }, mock: { elements: els } });
      await search(page, { service: "vidange" });
      await sortDist(page);
      await openCard(page, 1022);
      await openCard(page, 9202);
      await page.waitForTimeout(300);
      await injectScript(page, AXE);
      const r = await page.evaluate(async () => {
        const res = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
        return res.violations.map((v) => ({ id: v.id, n: v.nodes.length, ex: v.nodes.slice(0, 2).map((n) => n.target.join(" ")) }));
      });
      check(`F1 [${scheme}${mobile ? " mobile" : ""}] axe: no violation with scale + phone rows open`, r.length === 0, JSON.stringify(r));
      await ctx.close();
    }
    // forced colors: the markers are drawn with backgrounds, they must still exist
    const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, forcedColors: "active", storage: { "jg.repairs.v1": REPAIRS }, mock: { elements: els } });
    await search(page, { service: "vidange" });
    await sortDist(page);
    await openCard(page, 1022);
    const fc = await page.$eval(`${sel(1022)} .scale`, (el) => {
      const b = (s) => getComputedStyle(el.querySelector(s)).backgroundColor, probe = (c) => { const d = document.createElement("i"); d.style.background = c; document.body.append(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; };
      return { ref: b(".scale-ref"), med: b(".scale-med"), kref: b(".k-ref"), kme: b(".k-me"), text: probe("CanvasText"), hi: probe("Highlight") };
    });
    check("F2 forced colors: reference markers use CanvasText, garage markers Highlight", fc.ref === fc.text && fc.kref === fc.text && fc.med === fc.hi && fc.kme === fc.hi && fc.text !== fc.hi, JSON.stringify(fc));
    await ctx.close();
  } catch (e) {
    check("F section crashed", false, e && e.message);
  }

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[ux ${FILE}] ${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(SHOTS, `ux-${path.basename(FILE, ".html")}.json`), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
