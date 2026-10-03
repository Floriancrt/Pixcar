// Mesure le chargement de la page sur un téléphone d'entrée de gamme : processeur 4× plus lent, réseau « 4G lente »
// (1,6 Mb/s, 150 ms), services externes simulés. Médiane de plusieurs chargements à froid, puis à chaud (cache + service worker).
//   node tests/perf.js                 dist/ (le site publiable)
//   node tests/perf.js --target single index.html tout-en-un
//   node tests/perf.js --runs 7 --cpu 6 --json perf.json
//   node tests/perf.js --third-party-latency 150   ajoute au coût des services tiers (polices, CDN…) un aller-retour de 150 ms par
//                                                  requête et 3 allers-retours (DNS, TCP, TLS) à la première vers chaque domaine
// Sans cette option les services tiers sont simulés SANS délai ni débit limité : une page qui en dépend au démarrage (l'ancienne
// page : feuille de style Google Fonts) paraît alors plus rapide qu'elle ne l'est, une page qui n'en dépend pas n'est pas touchée.
// Les chiffres varient d'un lancement à l'autre (machine, charge) : comparer des médianes mesurées au même moment.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { launch, ROOT } = require("./harness");
const { installMocks } = require("./mocks");
const { serveDir } = require("./static-server");

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : def; };
const TARGET = arg("target", "dist");
const RUNS = +arg("runs", 5);
const CPU = +arg("cpu", 4);
const WARM = !process.argv.includes("--cold-only");
const OUT = arg("json", "");
const TP_LATENCY = +arg("third-party-latency", 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

async function measure(browser, base, file, { warm }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "allow" });
  await installMocks(ctx, { log: () => {} });
  if (TP_LATENCY > 0) {
    // enregistré après les simulations : il passe avant elles, attend, puis leur laisse répondre (route.fallback)
    const own = new URL(base).origin;
    const known = new Set();
    await ctx.route((url) => url.origin !== own, async (route) => {
      const origin = new URL(route.request().url()).origin;
      const first = !known.has(origin);
      known.add(origin);
      await new Promise((r) => setTimeout(r, first ? 4 * TP_LATENCY : TP_LATENCY)); // 3 allers-retours de connexion + 1 de requête
      await route.fallback();
    });
  }
  await ctx.addInitScript(() => {
    window.JG_TUNE = { today: "2026-10-01" };
    window.__perf = { lcp: 0, fcp: 0, longTasks: [], cls: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  let wire = 0, count = 0;
  const seen = new Set();
  cdp.on("Network.requestWillBeSent", (e) => seen.add(e.requestId));
  cdp.on("Network.loadingFinished", (e) => { if (seen.has(e.requestId)) { wire += e.encodedDataLength || 0; count++; } });
  const go = async () => {
    wire = 0; count = 0; seen.clear();
    await page.goto(`${base}/${file}`, { waitUntil: "load" });
    await page.waitForTimeout(2500); // laisse LCP et CLS se stabiliser
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const p = window.__perf;
      const tbt = p.longTasks.filter(([s]) => s >= p.fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
      return { fcp: Math.round(p.fcp), lcp: Math.round(p.lcp), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), tbt: Math.round(tbt), longTasks: p.longTasks.length, cls: +p.cls.toFixed(3), sw: !!navigator.serviceWorker.controller };
    });
    return { ...m, wireBytes: wire, requests: count };
  };
  const cold = await go();
  let hot = null;
  if (warm) {
    // le service worker s'installe après le premier chargement : on lui laisse le temps, puis on recharge
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__perf.longTasks.length = 0; });
    hot = await go();
  }
  await ctx.close();
  return { cold, hot };
}

(async () => {
  const dir = arg("dir", "") ? path.resolve(arg("dir", "")) : TARGET === "single" ? ROOT : path.join(ROOT, "dist");
  const file = TARGET === "single" ? "index.html" : "index.html";
  if (!fs.existsSync(path.join(dir, file))) { console.error(`${path.join(dir, file)} introuvable : lancer npm run build`); process.exit(2); }
  const host = await serveDir(dir);
  const browser = await launch();
  const raw = fs.readFileSync(path.join(dir, file));
  const sizes = { html: { raw: raw.length, gzip: zlib.gzipSync(raw, { level: 9 }).length, brotli: zlib.brotliCompressSync(raw).length } };
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, host.url, file, { warm: WARM }));
  await browser.close();
  host.close();
  const pick = (which, k) => median(runs.map((r) => r[which] && r[which][k]).filter((v) => v !== undefined && v !== null));
  const row = (which) => ({ fcp: pick(which, "fcp"), lcp: pick(which, "lcp"), dcl: pick(which, "dcl"), load: pick(which, "load"), tbt: pick(which, "tbt"), longTasks: pick(which, "longTasks"), cls: pick(which, "cls"), kb: +(pick(which, "wireBytes") / 1024).toFixed(1), requests: pick(which, "requests") });
  const result = { target: TARGET, runs: RUNS, cpu: CPU, html: sizes.html, cold: row("cold"), warm: WARM ? row("hot") : null, swControlled: WARM ? runs.every((r) => r.hot.sw) : null };
  const line = (n, r) => `${n}: FCP ${r.fcp} ms · LCP ${r.lcp} ms · DCL ${r.dcl} ms · load ${r.load} ms · TBT ${r.tbt} ms (${r.longTasks} tâches longues) · CLS ${r.cls} · ${r.kb} Ko transférés, ${r.requests} requêtes`;
  console.log(`${TARGET} — médiane de ${RUNS} chargements, CPU ×${CPU}, 4G lente\nHTML : ${(sizes.html.raw / 1024).toFixed(1)} Ko (gzip ${(sizes.html.gzip / 1024).toFixed(1)}, brotli ${(sizes.html.brotli / 1024).toFixed(1)})`);
  console.log(line("à froid", result.cold));
  if (result.warm) console.log(line("à chaud", result.warm) + (result.swControlled ? " · service worker actif" : " · sans service worker"));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
