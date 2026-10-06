// Pixcar charte: logos, brand chrome, tokens, markers, favicon, forced colors.
const { serve, launch, open, search, shot, ROOT } = require("./harness");
const { installMocks } = require("./mocks");
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path");
const FILE = process.env.FILE || "index.html";
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500)); };
const rgb = (s) => (String(s).match(/[\d.]+/g) || []).slice(0, 4).map(Number);
const eq = (s, r, g, b) => { const v = rgb(s); return v[0] === r && v[1] === g && v[2] === b; };

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();

  for (const scheme of ["light", "dark"]) {
    const T = scheme.toUpperCase().slice(0, 1);
    const NV = scheme === "light" ? "16, 18, 31" : "7, 8, 15"; // le chrome est marine : #10121F en clair, #07080F en sombre
    // ===================== desktop =====================
    let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme });
    const head = await page.evaluate(() => ({
      title: document.title,
      icon: (document.querySelector('link[rel="icon"]') || {}).href || "",
      touch: (document.querySelector('link[rel="apple-touch-icon"]') || {}).href || "",
      themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content),
      sprite: (document.getElementById("px-mark") || { querySelector: () => null }).querySelector("path") && document.getElementById("px-mark").querySelector("path").getAttribute("d"),
    }));
    check(`${T}1 title is Pixcar and no trace of the old name in the page text`, head.title === "Pixcar" && !/Juste Garage/i.test(await page.evaluate(() => document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ""))), head.title);
    // page tout-en-un : icônes en data URI ; site publiable : fichiers favicon.svg et apple-touch-icon.png (même contenu)
    const iconsOk = /^data:/.test(head.icon)
      ? /^data:image\/svg\+xml,/.test(head.icon) && /%3Cpath/.test(head.icon) && /^data:image\/png;base64,/.test(head.touch)
      : await page.evaluate(async ([i, t]) => {
          const svg = await (await fetch(i)).text();
          const png = new Uint8Array(await (await fetch(t)).arrayBuffer()).slice(0, 4);
          return /<svg/.test(svg) && /<path/.test(svg) && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        }, [head.icon, head.touch]);
    check(`${T}2 favicon is an SVG holding the symbol (data URI, or favicon.svg), apple-touch-icon a PNG`, iconsOk, head.icon.slice(0, 60));
    check(`${T}3 single navy theme-color`, head.themeColors.length === 1 && head.themeColors[0] === "#10121F", JSON.stringify(head.themeColors));
    check(`${T}4 symbol path has 16 sectors, an arc pair each`, head.sprite && (head.sprite.match(/M/g) || []).length === 16 && (head.sprite.match(/A/g) || []).length === 32, head.sprite && head.sprite.slice(0, 80));
    const brand = await page.evaluate(() => {
      const a = document.querySelector(".rail .brand"), svg = a.querySelector("svg"), w = a.querySelector(".brand-word"), cs = getComputedStyle(svg), ws = getComputedStyle(w);
      return { label: a.getAttribute("aria-label"), use: svg.querySelector("use").getAttribute("href"), fill: cs.fill, svgW: Math.round(svg.getBoundingClientRect().width), word: ws.display, wordImg: /^url\("data:image\/png;base64,/.test(ws.backgroundImage), hidden: w.getAttribute("aria-hidden") };
    });
    check(`${T}5 brand link: label, symbol via sprite in the logo light orange (#FF9A72), 48 px on desktop, wordmark hidden in the narrow rail`, brand.label === "Pixcar, accueil" && brand.use === "#px-mark" && eq(brand.fill, 255, 154, 114) && brand.svgW === 48 && brand.word === "none" && brand.wordImg && brand.hidden === "true", JSON.stringify(brand));
    const title = await page.evaluate(() => {
      const h = document.getElementById("garagesTitle"), p = h.querySelector(".t-brand"), t = h.querySelector(".t-text"), img = h.querySelector(".px-word");
      const pr = p.getBoundingClientRect(), tr = t.getBoundingClientRect(), cs = getComputedStyle(p), im = img.getBoundingClientRect();
      return { plate: [Math.round(pr.width), Math.round(pr.height)], bg: cs.backgroundColor, display: cs.display, textBox: [Math.round(tr.width), Math.round(tr.height)], label: img.getAttribute("aria-label"), role: img.getAttribute("role"), wordH: Math.round(im.height), name: (img.getAttribute("aria-label") + " " + h.querySelector(".t-text").textContent + h.querySelector(".sr-only").textContent).trim() };
    });
    check(`${T}6 desktop: the wordmark on a navy plate replaces the visible title; the text stays for screen readers`, title.display === "inline-flex" && eq(title.bg, 16, 18, 31) && title.plate[0] > 120 && title.textBox[0] <= 1 && title.wordH === 30 && title.label === "Pixcar" && title.role === "img" && title.name === "Pixcar Garages autour de votre adresse", JSON.stringify(title));
    // pixel check of the plate: navy background, near-white "pix", orange "car"
    const plateShot = path.join(__dirname, ".out", "shots", `brand-${scheme}-plate.png`);
    const shotOk = await page.locator(".t-brand").screenshot({ path: plateShot, timeout: 4000 }).then(() => true, () => false);
    const hist = shotOk ? execSync(`convert ${plateShot} -format %c histogram:info:-`, { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n") : [];
    let nNavy = 0, nOrange = 0, nIce = 0;
    for (const l of hist) {
      const m = l.match(/^\s*(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const [n, r, g, b] = m.slice(1).map(Number);
      if (Math.abs(r - 16) <= 6 && Math.abs(g - 18) <= 6 && Math.abs(b - 31) <= 6) nNavy += n;
      else if (Math.abs(r - 253) <= 8 && Math.abs(g - 83) <= 10 && Math.abs(b - 25) <= 12) nOrange += n;
      else if (r >= 238 && r <= 250 && g >= 238 && b >= 244 && Math.abs(r - g) <= 4) nIce += n;
    }
    check(`${T}7 plate pixels: navy background, near-white "pix" (#F4F5FA) and orange "car" (#FD5319) all present`, nNavy > 3000 && nOrange > 150 && nIce > 150, JSON.stringify({ nNavy, nOrange, nIce }));
    const chrome = await page.evaluate(() => {
      const dock = getComputedStyle(document.querySelector(".dock")), cur = getComputedStyle(document.querySelector('.tab[aria-current="page"]')), add = getComputedStyle(document.getElementById("addRepairBtn")), rail = getComputedStyle(document.querySelector(".rail"));
      return { dock: dock.backgroundImage.slice(0, 80), cur: [cur.backgroundColor, cur.color], add: [add.backgroundColor, add.color], railInk: rail.color };
    });
    check(`${T}8 chrome is navy in both themes: navy dock under the rail, orange active tab with navy icon, orange-tinted add button`, chrome.dock.includes(`rgb(${NV}) 0px, rgb(${NV}) 76px`) && eq(chrome.cur[0], 253, 83, 25) && eq(chrome.cur[1], 16, 18, 31) && eq(chrome.railInk, 244, 245, 250), JSON.stringify(chrome));
    const tok = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); const g = (k) => s.getPropertyValue(k).trim(); return { accent: g("--accent"), btn: g("--btn"), indigo: g("--indigo"), pink: g("--pink"), canvas: g("--canvas") }; });
    check(`${T}9 tokens: accent ${scheme === "light" ? "#b13506 (burnt orange, 4.5:1 on tinted backgrounds)" : "#ff7c49 (light orange)"}, old indigo/pink tokens gone`, tok.accent === (scheme === "light" ? "#b13506" : "#ff7c49") && tok.indigo === "" && tok.pink === "", JSON.stringify(tok));
    // markers read the tokens
    await search(page, { service: "vidange" });
    await page.click("#list > li:nth-child(2) .g-main"); await page.waitForTimeout(800);
    const mk = await page.evaluate(() => {
      const m = window.__maps[0], out = { user: null, selected: null, priced: null, none: null, radius: null };
      m.eachLayer((l) => {
        const o = l.options || {};
        if (!o.fillColor) return;
        if (l._radius === 9) out.user = [o.fillColor, o.color];
        else if (l._radius === 11) out.selected = [o.fillColor, o.color];
        else if (l._radius === 8 && !out.priced) out.priced = [o.fillColor, o.color];
        else if (l._radius === 6 && !out.none) out.none = [o.fillColor, o.color];
        else if (l._mRadius) out.radius = [o.color, o.fillColor];
      });
      return out;
    });
    const exp = scheme === "light" ? { user: ["#ffffff", "#10121F"], selected: ["#E5440B", "#ffffff"], priced: ["#10121F", "#ffffff"], radius: ["#E5440B", "#E5440B"] } : { user: ["#07080f", "#ff7c49"], selected: ["#ff7c49", "#07080f"], priced: ["#f4f5fa", "#07080f"], radius: ["#ff7c49", "#ff7c49"] };
    check(`${T}10 markers use the Pixcar tokens (user ring, selected, priced, search radius)`, JSON.stringify(mk.user) === JSON.stringify(exp.user) && JSON.stringify(mk.selected) === JSON.stringify(exp.selected) && JSON.stringify(mk.priced) === JSON.stringify(exp.priced) && JSON.stringify(mk.radius) === JSON.stringify(exp.radius), JSON.stringify(mk));
    const av = await page.evaluate(() => [...document.querySelectorAll("#list .avatar:not([data-c])")].slice(0, 12).map((a) => getComputedStyle(a).backgroundColor));
    const hue = (c) => { const [r, g, b] = rgb(c).map((x) => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1; const d = mx - mn; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(((h * 60) + 360) % 360); };
    check(`${T}11 independents' initials stay in the green family (hue 80-180)`, av.length >= 5 && av.every((c) => { const h = hue(c); return h >= 80 && h <= 180; }), JSON.stringify(av.map(hue)));
    check(`${T}12 no page error`, logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
    await ctx.close();

    // ===================== mobile =====================
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, colorScheme: scheme }));
    const mob = await page.evaluate(() => {
      const h = document.getElementById("garagesTitle"), p = h.querySelector(".t-brand"), t = h.querySelector(".t-text");
      const w = document.querySelector(".rail .brand-word").getBoundingClientRect(), s = document.querySelector(".rail .brand svg").getBoundingClientRect(), before = getComputedStyle(document.querySelector(".rail"), "::before");
      const add = getComputedStyle(document.getElementById("addRepairBtn")), cur = getComputedStyle(document.querySelector('.tab[aria-current="page"]')), tabs = getComputedStyle(document.getElementById("tabs"));
      return { plate: getComputedStyle(p).display, text: [getComputedStyle(t).position, Math.round(t.getBoundingClientRect().width)], word: [Math.round(w.width), Math.round(w.height)], symbol: Math.round(s.width), bar: before.backgroundColor, add: [add.backgroundColor, add.color], cur: [cur.backgroundColor, cur.color], tabs: tabs.backgroundColor };
    });
    check(`${T}13 mobile: navy top bar with symbol (40 px) + wordmark (24 px high, ~71 px wide), title stays text`, mob.plate === "none" && mob.text[0] !== "absolute" && mob.text[1] > 60 && mob.word[1] === 24 && mob.word[0] >= 70 && mob.word[0] <= 72 && mob.symbol === 40 && mob.bar === `rgba(${NV}, 0.95)`, JSON.stringify(mob));
    check(`${T}14 mobile: orange add button and orange active tab on a navy floating nav`, eq(mob.add[0], 253, 83, 25) && eq(mob.add[1], 16, 18, 31) && eq(mob.cur[0], 253, 83, 25) && mob.tabs === `rgba(${NV}, 0.93)`, JSON.stringify(mob));
    check(`${T}15 mobile: no page error`, logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
    await ctx.close();
  }

  // ===================== forced colors =====================
  const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, forcedColors: "active", locale: "fr-FR" });
  await installMocks(fctx, {});
  const fpage = await fctx.newPage();
  await fpage.goto(`${server.url}/${FILE}`); await fpage.waitForTimeout(500);
  const fc = await fpage.evaluate(() => ({ plate: getComputedStyle(document.querySelector(".t-brand")).backgroundColor, rail: getComputedStyle(document.querySelector(".dock")).backgroundImage.slice(0, 60), adj: getComputedStyle(document.querySelector(".t-brand")).forcedColorAdjust }));
  check("F1 forced colors: the wordmark plate and the rail keep their navy background (the wordmark has a white part)", /rgb\(16, 18, 31\)/.test(fc.plate) && /rgb\(16, 18, 31\)/.test(fc.rail) && fc.adj === "none", JSON.stringify(fc));
  await fctx.close();

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[brand] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
