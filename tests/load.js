// Loading state: ring road + car on the map, waiting sentence in the status card.
// Usage: node load.js [file] [sections]   (default index.html; run it on an older build to see what the old build lacks)
const { serve, launch, open, SHOTS, ROOT, injectScript } = require("./harness");
const { buildElements, CENTER } = require("./mocks");
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || "index.html";
const ONLY = (process.argv[3] || "ILEMRCAX").toUpperCase();
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const has = (s) => ONLY.includes(s);
const QUOTE = "Votre titine est comme vous, elle n'aime pas qu'on lui cache des choses";
const cache = (n) => ({ "jg.osm.v3": { [`${CENTER.lat.toFixed(4)},${CENTER.lon.toFixed(4)},10000`]: { at: `${CENTER.lat.toFixed(4)},${CENTER.lon.toFixed(4)}`, m: 10000, t: Date.now() - 3600e3, els: buildElements(n) } } });

// cubic-bezier(.65, 0, .35, 1) (the lap's easing), solved numerically
const bez = (p) => {
  const X = (t) => 3 * (1 - t) * (1 - t) * t * 0.65 + 3 * (1 - t) * t * t * 0.35 + t * t * t, Y = (t) => 3 * (1 - t) * t * t * 1 + t * t * t;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; X(m) < p ? (lo = m) : (hi = m); }
  return Y((lo + hi) / 2);
};
const expectAngle = (t) => (360 - 360 * bez(Math.min((t % 2400) / 1800, 1))) % 360; // counter-clockwise from the top, in clockwise degrees

async function begin(page, { service = "vidange", address = "12 rue de la république lyon" } = {}) {
  await page.selectOption("#service", service);
  await page.fill("#address", address);
  await page.waitForSelector("#addrList li[data-i]", { state: "visible", timeout: 5000 });
  await page.click("#addrList li[data-i='0']");
  await page.click("#go");
}
const seek = (page, t) => page.evaluate((t) => document.getAnimations().filter((a) => a.animationName === "ld-lap").forEach((a) => { a.pause(); a.currentTime = t; }), t);
// centre of the island, scale (px per user unit) and the car's polar position, all measured on screen
const polar = (page, root = ".map-empty") => page.evaluate((root) => {
  const r = (s) => document.querySelector(`${root} ${s}`).getBoundingClientRect();
  const isl = r(".ld-island"), car = r(".ld-car");
  const cx = isl.left + isl.width / 2, cy = isl.top + isl.height / 2, k = isl.width / 116; // island radius is 58 units
  const x = car.left + car.width / 2, y = car.top + car.height / 2;
  return { cx, cy, k, radius: Math.hypot(x - cx, y - cy) / k, angle: (Math.atan2(x - cx, -(y - cy)) * 180 / Math.PI + 360) % 360 };
}, root);
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

(async () => {
  const server = await serve(ROOT);
  const browser = await launch({ scrollbars: true });
  const slow = { overpassDelayMs: 60000 };

  // =============== I. idle: nothing moves, nothing is drawn ===============
  if (has("I")) try {
    const { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 });
    const idle = await page.evaluate(() => ({
      searching: document.body.classList.contains("is-searching"),
      ld: [...document.querySelectorAll(".map-empty .ld")].map((e) => getComputedStyle(e).display),
      hint: getComputedStyle(document.querySelector(".map-hint")).display,
      hintText: document.querySelector(".map-hint span").textContent.trim(),
      laps: document.getAnimations().filter((a) => a.animationName === "ld-lap").length,
      pin: getComputedStyle(document.querySelector(".ma-pin-ring")).fill + "|" + getComputedStyle(document.querySelector(".ma-pin")).fill,
    }));
    check("I1 idle: the ring and the car are not drawn", idle.ld.length === 2 && idle.ld.every((d) => d === "none"), JSON.stringify(idle));
    check("I2 idle: no animation runs (nothing costs anything before a search)", idle.laps === 0 && !idle.searching, JSON.stringify(idle));
    check("I3 idle: the map card and its sentence are shown", idle.hint !== "none" && idle.hintText === QUOTE, JSON.stringify(idle));
    check("I4 console clean", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    await ctx.close();
  } catch (e) { check("I section crashed", false, e && e.message); }

  // =============== L. on the map, desktop ===============
  if (has("L")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: slow });
    await begin(page);
    await page.waitForTimeout(1100); // fade-in delay (0.35 s) + fade (0.4 s)
    const st = await page.evaluate(() => ({
      searching: document.body.classList.contains("is-searching"),
      ld: [...document.querySelectorAll(".map-empty .ld")].map((e) => [getComputedStyle(e).display, getComputedStyle(e).opacity]),
      hint: getComputedStyle(document.querySelector(".map-hint")).display,
      teaser: getComputedStyle(document.getElementById("teaser")).display,
      empty: getComputedStyle(document.querySelector(".map-empty")).display,
      laps: document.getAnimations().filter((a) => a.animationName === "ld-lap").map((a) => ({ state: a.playState, dur: a.effect.getTiming().duration, it: a.effect.getTiming().iterations })),
      goBusy: document.getElementById("go").getAttribute("aria-busy"),
    }));
    check("L1 searching: body.is-searching, map card hidden, ring and car fully shown", st.searching && st.hint === "none" && st.empty !== "none" && st.ld.every(([d, o]) => d === "inline" && o === "1"), JSON.stringify(st));
    check("L2 exactly one lap animation runs on desktop: 2.4 s, endless", st.laps.length === 1 && st.laps[0].state === "running" && st.laps[0].dur === 2400 && st.laps[0].it === Infinity, JSON.stringify(st.laps));
    check("L3 the price teaser steps aside so the waiting card is close to the button", st.teaser === "none");
    // geometry: the roundabout is centred on the address pin; the car stays in the outer lane
    const geo = await page.evaluate(() => { const isl = document.querySelector(".map-empty .ld-island").getBoundingClientRect(), pin = document.querySelector(".map-empty .ma-pin").getBoundingClientRect(); return { dx: isl.left + isl.width / 2 - (pin.left + pin.width / 2), dy: isl.top + isl.height / 2 - (pin.top + pin.height / 2), w: isl.width }; });
    check("L4 the ring is centred on the address pin", Math.abs(geo.dx) < 1.5 && Math.abs(geo.dy) < 1.5 && geo.w > 90, JSON.stringify(geo));
    // motion: radius constant, counter-clockwise, ease-in-out, one lap in 1.8 s then a pause until 2.4 s, endless
    const samples = [];
    for (const t of [0, 150, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700]) { await seek(page, t); await page.waitForTimeout(40); samples.push({ t, ...(await polar(page)) }); }
    const radii = samples.map((s) => s.radius);
    check("L5 the car stays in the outer lane all the way round (84 units from the centre, ±2)", radii.every((r) => Math.abs(r - 84) < 2), JSON.stringify(radii.map((r) => +r.toFixed(1))));
    const worst = Math.max(...samples.map((s) => angDiff(s.angle, expectAngle(s.t))));
    check("L6 position follows the lap exactly: counter-clockwise, ease-in-out, 1.8 s (max error " + worst.toFixed(1) + "°)", worst < 5, JSON.stringify(samples.map((s) => [s.t, Math.round(s.angle), Math.round(expectAngle(s.t))])));
    check("L7 counter-clockwise (French roundabout): just after the start the car is on the left of the top", samples[2].angle > 270 && samples[2].angle < 360, samples[2].angle);
    check("L8 pause after the lap (1.8 → 2.4 s) and the next lap starts again", angDiff(samples[7].angle, 0) < 3 && angDiff(samples[8].angle, 0) < 3 && angDiff(samples[10].angle, samples[2].angle) < 3, JSON.stringify(samples.map((s) => Math.round(s.angle))));
    await ctx.close();
  } catch (e) { check("L section crashed", false, e && e.message); }

  // =============== E. the status card ===============
  if (has("E")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: slow });
    await begin(page);
    await page.waitForTimeout(900);
    const c = await page.evaluate(() => { const s = document.getElementById("status"); const r = s.getBoundingClientRect(); return { cls: s.className, quote: (s.querySelector(".wait-quote") || {}).textContent, qHidden: (s.querySelector(".wait-quote") || { getAttribute: () => null }).getAttribute("aria-hidden"), step: ((s.querySelector(".wait-step") || {}).textContent || ""), svg: s.querySelector("svg") && [s.querySelector("svg").getAttribute("aria-hidden"), s.querySelector("svg").getAttribute("focusable"), getComputedStyle(s.querySelector("svg")).display], opacity: getComputedStyle(s).opacity, top: r.top, bottom: r.bottom, vh: innerHeight, order: [...document.querySelectorAll(".panel-col > *")].map((e) => e.id || e.tagName.toLowerCase()) }; });
    check("E1 the waiting sentence is shown in the status card (exact wording)", c.quote === QUOTE && /\bis-wait\b/.test(c.cls) && !/\berr\b/.test(c.cls), JSON.stringify(c));
    check("E2 the current step stays, smaller, under the sentence", /^(Recherche|Le serveur principal|Chargement)/.test(c.step) && /…$/.test(c.step), c.step);
    check("E3 the card is on screen without scrolling (desktop, 900 px high)", c.top >= 0 && c.bottom <= c.vh && c.opacity === "1", JSON.stringify([c.top, c.bottom, c.opacity]));
    check("E4 sentence and pictogram are hidden from screen readers (the live region would repeat them at each step); the step is not", c.qHidden === "true" && c.svg[0] === "true" && c.svg[1] === "false", JSON.stringify([c.qHidden, c.svg]));
    check("E5 desktop: no second pictogram in the card (the map has the animation)", c.svg[2] === "none", JSON.stringify(c.svg));
    // the step changes when the first server is slow, the sentence stays
    await page.waitForTimeout(600);
    const c2 = await page.evaluate(() => { const s = document.getElementById("status"); return { quote: s.querySelector(".wait-quote").textContent, step: s.querySelector(".wait-step").textContent }; });
    check("E6 slow first server: the step announces the backup server, the sentence is unchanged", c2.quote === QUOTE && /serveur principal tarde/.test(c2.step) && !/OpenStreetMap/.test(c2.step), JSON.stringify(c2));
    await ctx.close();
  } catch (e) { check("E section crashed", false, e && e.message); }

  // =============== M. mobile ===============
  if (has("M")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, mock: slow });
    await begin(page);
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => { const s = document.getElementById("status"), l = s.querySelector(".wait-loader"), r = s.getBoundingClientRect(), nav = document.getElementById("tabs").getBoundingClientRect(); return { cls: s.className, top: r.top, bottom: r.bottom, vh: innerHeight, navTop: nav.top, loader: l && { d: getComputedStyle(l).display, w: l.getBoundingClientRect().width, h: l.getBoundingClientRect().height, left: l.getBoundingClientRect().left }, cardLeft: r.left, quote: (s.querySelector(".wait-quote") || {}).textContent, stage: getComputedStyle(document.getElementById("stage")).display, laps: document.getAnimations().filter((a) => a.animationName === "ld-lap").length, teaser: getComputedStyle(document.getElementById("teaser")).display }; });
    check("M1 mobile: the card shows the sentence and a 72 px pictogram on its left", m.quote === QUOTE && m.loader && m.loader.d === "block" && Math.round(m.loader.w) === 72 && m.loader.left < m.cardLeft + 20, JSON.stringify(m));
    check("M2 mobile: the card is on screen, above the floating navigation, without scrolling", m.top >= 0 && m.bottom <= m.navTop && /\bis-wait\b/.test(m.cls), JSON.stringify([m.top, m.bottom, m.navTop]));
    check("M3 mobile: the map is hidden, so exactly one animation runs (the card's)", m.stage === "none" && m.laps === 1, JSON.stringify([m.stage, m.laps]));
    // the pictogram's car turns too, around its own ring
    await seek(page, 0);
    const a0 = await polar(page, "#status");
    await seek(page, 900);
    const a1 = await polar(page, "#status");
    check("M4 the pictogram's car is on its ring and moves (top, then the bottom half-way)", Math.abs(a0.radius - 84) < 3 && angDiff(a0.angle, 0) < 4 && angDiff(a1.angle, 180) < 6, JSON.stringify([a0, a1]));
    await ctx.close();
  } catch (e) { check("M section crashed", false, e && e.message); }

  // =============== C. end of the search, failures, quick searches ===============
  if (has("C")) try {
    // C1: normal end
    let { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassDelayMs: 1400 } });
    await begin(page);
    await page.waitForTimeout(500);
    const mid = await page.evaluate(() => document.body.classList.contains("is-searching"));
    await page.waitForSelector("#list > li", { timeout: 15000 });
    await page.waitForTimeout(400);
    const end = await page.evaluate(() => ({ searching: document.body.classList.contains("is-searching"), status: document.getElementById("status").innerHTML, statusDisplay: getComputedStyle(document.getElementById("status")).display, ld: [...document.querySelectorAll(".map-empty .ld")].map((e) => getComputedStyle(e).display), empty: getComputedStyle(document.querySelector(".map-empty")).display, mapShown: !document.getElementById("mapPane").hidden, laps: document.getAnimations().filter((a) => a.animationName === "ld-lap").length }));
    check("C1 the loading state is on during the search and gone when results arrive", mid && !end.searching && end.status === "" && end.statusDisplay === "none" && end.ld.every((d) => d === "none") && end.laps === 0, JSON.stringify([mid, end]));
    check("C2 the real map replaces the decor", end.mapShown && end.empty === "none");
    // C3: an information message outside a search keeps its plain look
    await page.click("#editSearch");
    await page.click("#radiusChips .chip[data-km='20']");
    await page.waitForTimeout(200);
    const info = await page.evaluate(() => ({ cls: document.getElementById("status").className, text: document.getElementById("status").textContent.trim() }));
    check("C3 messages outside a search are unchanged (no sentence)", /^Relancez la recherche pour élargir la zone à 20 km\.$/.test(info.text) && info.cls === "status", JSON.stringify(info));
    await ctx.close();

    // C4: failure: the state clears, the error card has no sentence, the idle card is back
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassFail: true, sireneFail: true } }));
    await begin(page);
    await page.waitForSelector("#status.err", { timeout: 20000 });
    await page.waitForTimeout(300);
    const f = await page.evaluate(() => ({ searching: document.body.classList.contains("is-searching"), cls: document.getElementById("status").className, quote: !!document.getElementById("status").querySelector(".wait-quote"), hint: getComputedStyle(document.querySelector(".map-hint")).display, ld: [...document.querySelectorAll(".map-empty .ld")].map((e) => getComputedStyle(e).display), go: document.getElementById("go").disabled, teaser: getComputedStyle(document.getElementById("teaser")).display }));
    check("C4 failure: loading state cleared, error card without the sentence, idle card back, button usable", !f.searching && /\berr\b/.test(f.cls) && !/is-wait/.test(f.cls) && !f.quote && f.hint !== "none" && f.ld.every((d) => d === "none") && !f.go && f.teaser !== "none", JSON.stringify(f));
    await ctx.close();

    // C5: unknown address (error before any request): same
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    await page.fill("#address", "zzzz introuvable");
    await page.click("#go");
    await page.waitForSelector("#status.err", { timeout: 10000 });
    const u = await page.evaluate(() => ({ searching: document.body.classList.contains("is-searching"), text: document.getElementById("status").textContent.trim(), quote: !!document.getElementById("status").querySelector(".wait-quote") }));
    check("C5 unknown address: error message only, loading state cleared", !u.searching && /Adresse introuvable/.test(u.text) && !u.quote, JSON.stringify(u));
    await ctx.close();

    // C6: a quick search (150 ms, well under the 0.35 s delay) never shows the loader nor the card, although frames are drawn
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassDelayMs: 150 } }));
    await page.evaluate(() => { window.__ld = { frames: 0, maxLd: 0, maxCard: 0 }; const tick = () => { if (document.body.classList.contains("is-searching")) { window.__ld.frames++; window.__ld.maxLd = Math.max(window.__ld.maxLd, ...[...document.querySelectorAll(".map-empty .ld")].map((e) => parseFloat(getComputedStyle(e).opacity))); const c = document.getElementById("status"); if (/is-wait/.test(c.className)) window.__ld.maxCard = Math.max(window.__ld.maxCard, parseFloat(getComputedStyle(c).opacity)); } requestAnimationFrame(tick); }; tick(); });
    await begin(page);
    await page.waitForSelector("#list > li", { timeout: 10000 });
    await page.waitForTimeout(300);
    const q = await page.evaluate(() => window.__ld);
    check("C6 quick search (150 ms): several frames drawn while searching, yet neither the loader nor the card ever became visible", q.frames >= 3 && q.maxLd === 0 && q.maxCard === 0, JSON.stringify(q));
    await ctx.close();

    // C7: contrôle technique goes through the same states
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    await page.selectOption("#service", "ct");
    await page.fill("#address", "lyon");
    await page.waitForSelector("#addrList li[data-i]");
    await page.click("#addrList li[data-i='0']");
    await page.click("#go");
    await page.waitForSelector("#list > li.card", { timeout: 12000 });
    await page.waitForTimeout(300);
    check("C7 contrôle technique search ends cleanly too", !(await page.evaluate(() => document.body.classList.contains("is-searching"))) && (await page.$eval("#status", (e) => e.innerHTML)) === "");
    await ctx.close();
  } catch (e) { check("C section crashed", false, e && e.message); }

  // =============== R. reduced motion ===============
  if (has("R")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, reducedMotion: "reduce", mock: slow });
    await begin(page);
    await page.waitForTimeout(1200);
    const p0 = await polar(page);
    await page.waitForTimeout(900);
    const p1 = await polar(page);
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".map-empty .ld-orbit")).animationDuration);
    check("R1 reduced motion: the car stays still at the top of the ring, the ring is drawn", angDiff(p0.angle, 0) < 3 && angDiff(p1.angle, 0) < 3 && Math.abs(p0.radius - 84) < 2 && /^0\.001ms$|^1e-06s$/.test(dur), JSON.stringify([p0.angle, p1.angle, dur]));
    await ctx.close();
  } catch (e) { check("R section crashed", false, e && e.message); }

  // =============== A. charte colours and accessibility ===============
  if (has("A")) try {
    for (const scheme of ["light", "dark"]) {
      const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme, mock: slow });
      await begin(page);
      await page.waitForTimeout(1100);
      const col = await page.evaluate(() => {
        const g = (s, p) => getComputedStyle(document.querySelector(`.map-empty ${s}`))[p];
        const all = new Set();
        document.querySelectorAll(".map-empty .ld circle, .map-empty .ld path").forEach((e) => { const c = getComputedStyle(e); [c.fill, c.stroke].forEach((v) => v && v !== "none" && all.add(v)); });
        return { road: g(".ld-asphalt", "stroke"), dash: g(".ld-dash", "stroke"), car: g(".ld-body", "fill"), edge: g(".ld-edge", "stroke"), island: g(".ld-island", "fill"), all: [...all] };
      });
      const want = scheme === "light"
        ? { road: "rgb(10, 13, 10)", dash: "rgb(242, 242, 242)", car: "rgb(121, 250, 82)", island: "rgb(255, 255, 255)" }
        : { road: "rgb(43, 51, 43)", dash: "rgb(242, 242, 242)", car: "rgb(121, 250, 82)", island: "rgb(16, 20, 16)" };
      check(`A1 [${scheme}] charte colours: black / grey asphalt, off-white markings (#F2F2F2), lime car (#79FA52)`, col.road === want.road && col.dash === want.dash && col.car === want.car && col.island === want.island, JSON.stringify(col));
      const allowed = new Set(["rgb(10, 13, 10)", "rgb(43, 51, 43)", "rgb(61, 70, 61)", "rgb(242, 242, 242)", "rgb(121, 250, 82)", "rgb(255, 255, 255)", "rgb(16, 20, 16)", "rgba(0, 0, 0, 0)"]);
      check(`A2 [${scheme}] nothing outside the charte (no red, blue or yellow anywhere in the pictogram)`, col.all.every((c) => allowed.has(c)), JSON.stringify(col.all));
      await injectScript(page, AXE);
      const ax = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length })));
      check(`A3 [${scheme}] axe: no violation while searching (desktop)`, ax.length === 0, JSON.stringify(ax));
      await ctx.close();
      const mob = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, colorScheme: scheme, mock: slow });
      await begin(mob.page);
      await mob.page.waitForTimeout(900);
      await injectScript(mob.page, AXE);
      const ax2 = await mob.page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length })));
      check(`A4 [${scheme}] axe: no violation while searching (mobile)`, ax2.length === 0, JSON.stringify(ax2));
      await mob.ctx.close();
    }
  } catch (e) { check("A section crashed", false, e && e.message); }

  // =============== X. forced colours ===============
  if (has("X")) try {
    const { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, forcedColors: "active", mock: slow });
    await begin(page);
    await page.waitForTimeout(1100);
    const fc = await page.evaluate(() => {
      const probe = (c) => { const d = document.createElement("i"); d.style.background = c; document.body.append(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; };
      const g = (s, p) => getComputedStyle(document.querySelector(`.map-empty ${s}`))[p];
      return { road: g(".ld-asphalt", "stroke"), body: g(".ld-body", "fill"), dash: g(".ld-dash", "stroke"), tyre: g(".ld-tyre", "fill"), text: probe("CanvasText"), canvas: probe("Canvas") };
    });
    check("X1 forced colours: the car (Canvas) stands out from the asphalt (CanvasText), markings and tyres likewise", fc.road === fc.text && fc.body === fc.canvas && fc.dash === fc.canvas && fc.tyre === fc.text && fc.text !== fc.canvas, JSON.stringify(fc));
    await ctx.close();
  } catch (e) { check("X section crashed", false, e && e.message); }

  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[load ${FILE}] ${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(SHOTS, `load-${path.basename(FILE, ".html")}.json`), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
