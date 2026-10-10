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
    const TOP = scheme === "light" ? [17, 18, 22] : [8, 9, 11]; // l'en-tête est noir : #111216 en clair, #08090B en sombre
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
    check(`${T}3 a single theme-color, the black of the header (#111216)`, head.themeColors.length === 1 && head.themeColors[0] === "#111216", JSON.stringify(head.themeColors));
    check(`${T}4 symbol path has 16 sectors, an arc pair each`, head.sprite && (head.sprite.match(/M/g) || []).length === 16 && (head.sprite.match(/A/g) || []).length === 32, head.sprite && head.sprite.slice(0, 80));
    const brand = await page.evaluate(() => {
      const a = document.querySelector(".topbar .brand"), svg = a.querySelector("svg"), w = a.querySelector(".brand-word"), cs = getComputedStyle(svg), ws = getComputedStyle(w), wr = w.getBoundingClientRect();
      return { label: a.getAttribute("aria-label"), use: svg.querySelector("use").getAttribute("href"), fill: cs.fill, svgW: Math.round(svg.getBoundingClientRect().width), plate: getComputedStyle(a).backgroundColor, word: ws.display, wordBox: [Math.round(wr.width), Math.round(wr.height)], wordImg: /^url\("data:image\/png;base64,/.test(ws.backgroundImage), hidden: w.getAttribute("aria-hidden") };
    });
    check(`${T}5 brand link in the header: label, symbol via sprite in the logo light orange (#FF9A72, 40 px), wordmark (80 × 27 px, decorative) on its navy plate`, brand.label === "Pixcar, accueil" && brand.use === "#px-mark" && eq(brand.fill, 255, 154, 114) && brand.svgW === 40 && brand.word === "block" && brand.wordBox[0] === 80 && brand.wordBox[1] === 27 && brand.wordImg && brand.hidden === "true" && rgb(brand.plate)[2] > rgb(brand.plate)[0] + 10, JSON.stringify(brand));
    const title = await page.evaluate(() => {
      const h = document.getElementById("garagesTitle"), c = getComputedStyle(h);
      return { tag: h.tagName, text: h.textContent.replace(/\s+/g, " ").trim(), size: c.fontSize, weight: c.fontWeight, family: c.fontFamily.split(",")[0].replace(/"/g, ""), loaded: document.fonts.check(`800 ${c.fontSize} Manrope`) && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Manrope" && f.status === "loaded") };
    });
    check(`${T}6 home: the visible title is the hero sentence, an h1 in Manrope ExtraBold (54.4 px), the font file loaded`, title.tag === "H1" && title.text === "Le bon prix pour votre voiture, près de chez vous." && title.size === "54.4px" && title.weight === "800" && title.family === "Manrope" && title.loaded, JSON.stringify(title));
    // pixel check of the logo plate: navy background, near-white "pix", orange "car"
    const plateShot = path.join(__dirname, ".out", "shots", `brand-${scheme}-plate.png`);
    const shotOk = await page.locator(".topbar .brand").screenshot({ path: plateShot, timeout: 4000, scale: "device" }).then(() => true, () => false);
    const hist = shotOk ? execSync(`convert ${plateShot} -format %c histogram:info:-`, { maxBuffer: 64 * 1024 * 1024 }).toString().split("\n") : [];
    let nNavy = 0, nOrange = 0, nIce = 0;
    for (const l of hist) {
      const m = l.match(/^\s*(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const [n, r, g, b] = m.slice(1).map(Number);
      if (Math.abs(r - 15) <= 6 && Math.abs(g - 18) <= 6 && Math.abs(b - 31) <= 6) nNavy += n;
      else if (Math.abs(r - 253) <= 8 && Math.abs(g - 83) <= 10 && Math.abs(b - 25) <= 12) nOrange += n;
      else if (r >= 238 && r <= 250 && g >= 238 && b >= 244 && Math.abs(r - g) <= 4) nIce += n;
    }
    check(`${T}7 plate pixels: navy background, near-white "pix" (#F4F5FA) and orange "car" (#FD5319) all present`, nNavy > 3000 && nOrange > 80 && nIce > 80, JSON.stringify({ nNavy, nOrange, nIce }));
    const chrome = await page.evaluate(() => {
      const top = getComputedStyle(document.querySelector(".topbar")), tabs = [...document.querySelectorAll("#tabs .tab")].map((t) => ({ cur: t.getAttribute("aria-current") === "page", shown: getComputedStyle(t).display !== "none", fg: getComputedStyle(t).color, text: t.textContent.trim() })), add = document.getElementById("addRepairBtn"), ac = getComputedStyle(add);
      return { top: [top.backgroundColor, top.color, top.position, Math.round(document.querySelector(".topbar").getBoundingClientRect().top)], tabs, add: [ac.backgroundColor, ac.color, ac.fontSize, ac.fontWeight], addName: add.getAttribute("aria-label") };
    });
    const other = chrome.tabs.find((t) => !t.cur), cur = chrome.tabs.find((t) => t.cur);
    check(`${T}8 header: black (${scheme}), sticky at the top, pale ink; the nav shows the other section only (« Prix et promos »); the add button is orange with white text, large and bold (19 px, 700: 3:1 is enough)`, eq(chrome.top[0], ...TOP) && eq(chrome.top[1], 244, 245, 250) && chrome.top[2] === "sticky" && chrome.top[3] === 0 && cur && !cur.shown && other && other.shown && other.text === "Prix et promos" && eq(other.fg, 185, 189, 207) && eq(chrome.add[0], 255, 90, 30) && eq(chrome.add[1], 255, 255, 255) && parseFloat(chrome.add[2]) >= 18.66 && +chrome.add[3] >= 700 && chrome.addName === "Ajouter une réparation", JSON.stringify(chrome));
    const tok = await page.evaluate(() => { const s = getComputedStyle(document.documentElement); const g = (k) => s.getPropertyValue(k).trim(); return { accent: g("--accent"), btn: g("--btn"), indigo: g("--indigo"), pink: g("--pink"), canvas: g("--canvas") }; });
    check(`${T}9 tokens: accent ${scheme === "light" ? "#b13506 (burnt orange, 4.5:1 on tinted backgrounds)" : "#ff7c49 (light orange)"}, old indigo/pink tokens gone`, tok.accent === (scheme === "light" ? "#b13506" : "#ff7c49") && tok.indigo === "" && tok.pink === "", JSON.stringify(tok));
    // markers read the tokens
    await search(page, { service: "vidange" });
    await page.click("#list > li:nth-child(2) .g-main"); await page.waitForTimeout(800);
    const mk = await page.evaluate(() => {
      const m = window.__maps[0], out = { user: null, selected: null, priced: null, none: null, radius: null, fills8: [] };
      m.eachLayer((l) => {
        const o = l.options || {};
        if (!o.fillColor) return;
        if (l._radius === 8) out.fills8.push(o.fillColor);
        if (l._radius === 9) out.user = [o.fillColor, o.color];
        else if (l._radius === 11) out.selected = [o.fillColor, o.color];
        else if (l._radius === 8 && !out.priced) out.priced = [o.fillColor, o.color];
        else if (l._radius === 6 && !out.none) out.none = [o.fillColor, o.color];
        else if (l._mRadius) out.radius = [o.color, o.fillColor];
      });
      return out;
    });
    const exp = scheme === "light" ? { user: ["#ffffff", "#111216"], selected: ["#E5440B", "#ffffff"], priced: ["#111216", "#ffffff"], radius: ["#E5440B", "#E5440B"] } : { user: ["#07080f", "#ff7c49"], selected: ["#ff7c49", "#07080f"], priced: ["#f4f5fa", "#07080f"], radius: ["#ff7c49", "#ff7c49"] };
    check(`${T}10 markers use the Pixcar tokens (user ring, selected, priced, search radius)`, JSON.stringify(mk.user) === JSON.stringify(exp.user) && JSON.stringify(mk.selected) === JSON.stringify(exp.selected) && JSON.stringify(mk.priced) === JSON.stringify(exp.priced) && JSON.stringify(mk.radius) === JSON.stringify(exp.radius), JSON.stringify(mk));
    // la ligne la moins chère (la 1re, tri par prix) n'est pas la ligne choisie (la 2e) : son marqueur reste à 8 px, en orange ; les autres prix restent noirs
    const best8 = mk.fills8.filter((f) => f === exp.selected[0]).length, rest8 = mk.fills8.filter((f) => f === exp.priced[0]).length;
    check(`${T}10b the cheapest garage's marker is orange like its row (one marker), the other priced markers stay ${scheme === "light" ? "black" : "pale"}; it is drawn last (on top)`, best8 === 1 && rest8 === mk.fills8.length - 1 && rest8 >= 2 && mk.fills8[mk.fills8.length - 1] === exp.selected[0], JSON.stringify(mk.fills8));
    // tuile des indépendants : un seul fond neutre, le jeton --tile-gray (la couleur dit le type de garage, pas le nom)
    const av = await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.background = "var(--tile-gray)";
      document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { token, tiles: [...document.querySelectorAll("#list .card.k-indep .avatar:not(.has-logo)")].slice(0, 12).map((a) => getComputedStyle(a).backgroundColor) };
    });
    const hue = (c) => { const [r, g, b] = rgb(c).map((x) => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return -1; const d = mx - mn; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(((h * 60) + 360) % 360); };
    check(`${T}11 independents' tiles all use the neutral tile token (--tile-gray), whatever their name`, av.tiles.length >= 5 && av.tiles.every((c) => c === av.token), JSON.stringify({ token: av.token, hues: av.tiles.map(hue) }));
    check(`${T}12 no page error`, logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
    await ctx.close();

    // ===================== mobile =====================
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, colorScheme: scheme }));
    const mob = await page.evaluate(() => {
      const a = document.querySelector(".topbar .brand"), w = a.querySelector(".brand-word").getBoundingClientRect(), sv = a.querySelector("svg").getBoundingClientRect(), top = document.querySelector(".topbar");
      const add = document.getElementById("addRepairBtn"), ac = getComputedStyle(add), cur = getComputedStyle(document.querySelector('.tab[aria-current="page"]')), tabs = document.getElementById("tabs"), tr = tabs.getBoundingClientRect();
      return { word: [Math.round(w.width), Math.round(w.height)], symbol: Math.round(sv.width), top: [getComputedStyle(top).backgroundColor, getComputedStyle(top).position, Math.round(top.getBoundingClientRect().height)], add: [ac.backgroundColor, ac.color, ac.fontSize, ac.fontWeight, add.textContent.replace(/\s+/g, " ").trim(), [...add.querySelectorAll("span")].filter((x) => getComputedStyle(x).display !== "none" && x.getBoundingClientRect().width > 1).map((x) => x.textContent.trim()).join("")], cur: [cur.backgroundColor, cur.color], tabs: [getComputedStyle(tabs).backgroundColor, getComputedStyle(tabs).position, Math.round(innerHeight - tr.bottom)], h1: getComputedStyle(document.getElementById("garagesTitle")).fontSize };
    });
    check(`${T}13 mobile: black sticky top bar (66 px) with the symbol (32 px) and the wordmark (65 × 22 px); the hero title shrinks to 37.6 px`, eq(mob.top[0], ...TOP) && mob.top[1] === "sticky" && mob.top[2] === 66 && mob.symbol === 32 && mob.word[0] === 65 && mob.word[1] === 22 && mob.h1 === "37.6px", JSON.stringify(mob));
    check(`${T}14 mobile: orange « Réparation » button (white, 19 px bold) and a floating black bottom nav, its current tab orange with black text`, eq(mob.add[0], 255, 90, 30) && eq(mob.add[1], 255, 255, 255) && parseFloat(mob.add[2]) >= 18.66 && +mob.add[3] >= 700 && mob.add[5] === "Réparation" && eq(mob.cur[0], 255, 90, 30) && eq(mob.cur[1], 17, 18, 22) && mob.tabs[0] === `rgba(${TOP.join(", ")}, 0.94)` && mob.tabs[1] === "fixed" && mob.tabs[2] === 12, JSON.stringify(mob));
    check(`${T}15 mobile: no page error`, logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([logs.errors, logs.console]));
    await ctx.close();
  }

  // ===================== forced colors =====================
  const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, forcedColors: "active", locale: "fr-FR" });
  await installMocks(fctx, {});
  const fpage = await fctx.newPage();
  await fpage.goto(`${server.url}/${FILE}`); await fpage.waitForTimeout(500);
  const fc = await fpage.evaluate(() => ({ plate: getComputedStyle(document.querySelector(".topbar .brand")).backgroundColor, adj: getComputedStyle(document.querySelector(".topbar .brand")).forcedColorAdjust }));
  check("F1 forced colors: the logo keeps its navy plate (the wordmark has a white part)", /rgb\(14, 18, 32\)/.test(fc.plate) && fc.adj === "none", JSON.stringify(fc));
  await fctx.close();

  await browser.close(); server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n[brand] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
