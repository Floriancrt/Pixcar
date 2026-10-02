// Ce que le HTML contient avant l'exécution du script : listes de prestations remplies, aide de la première prestation.
// Le script les reconstruit à l'identique : le contenu ne bouge pas quand il démarre (et la page ne se décale pas).
//   node tests/prerender.js [index.html]
const { serve, launch, ROOT } = require("./harness");
const { installMocks } = require("./mocks");

const FILE = process.argv[2] || "index.html";
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 400));
};
const read = (page) =>
  page.evaluate(() => ({
    service: document.getElementById("service").innerHTML,
    ref: document.getElementById("refService").innerHTML,
    repair: document.getElementById("rService").innerHTML,
    hint: document.getElementById("serviceHint").textContent.trim(),
    selected: document.getElementById("service").value,
  }));

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const shot = async (js, storage) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", javaScriptEnabled: js, serviceWorkers: "block" });
    await installMocks(ctx, { log: () => {} });
    if (js) await ctx.addInitScript((st) => {
      window.JG_TUNE = { today: "2026-10-01" };
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      if (st) for (const [k, v] of Object.entries(st)) localStorage.setItem(k, JSON.stringify(v));
    }, storage || null);
    const page = await ctx.newPage();
    await page.goto(`${server.url}/${FILE}`, { waitUntil: "load" });
    await page.waitForTimeout(js ? 1200 : 200);
    const data = await read(page);
    const cls = js ? await page.evaluate(() => window.__cls) : 0;
    await ctx.close();
    return { ...data, cls };
  };
  try {
    const before = await shot(false), after = await shot(true);
    check("P1 without any script the service list is already filled (17 repair services, 3 groups for « Pneus », « Entretien », « Freinage », …)", (before.service.match(/<option /g) || []).length === 18 && /<optgroup label="Pneus et géométrie">/.test(before.service), before.service.slice(0, 120));
    check("P2 the list of the « Prix et promos » tab is filled the same way", before.ref === before.service);
    check("P3 the repair form's list has the same services except the technical inspection, plus « Autre réparation »", /<option value="autre">Autre réparation/.test(before.repair) && !/value="ct"/.test(before.repair) && (before.repair.match(/<option /g) || []).length === 18);
    check("P4 the help text of the first service is there before the script runs", /^Contrôle et réglage du train avant/.test(before.hint), before.hint);
    check("P5 what the script builds is identical to what the HTML already held (service list, tab list, repair form list, help text)", before.service === after.service && before.ref === after.ref && before.repair === after.repair && before.hint === after.hint, JSON.stringify([before.service === after.service, before.ref === after.ref, before.repair === after.repair, before.hint === after.hint]));
    check("P6 first visit: nothing moves when the script starts (layout shift under 0.005)", after.cls < 0.005, String(after.cls));
    const saved = await shot(true, { "jg.last.v1": { svc: "vidange", km: "10", place: null, sirene: false } });
    check("P7 a returning visitor whose last service was another one gets it (select and help text follow the saved choice)", saved.selected === "vidange" && !/^Contrôle et réglage du train avant/.test(saved.hint) && saved.hint.length > 10, JSON.stringify([saved.selected, saved.hint]));
  } catch (e) {
    check("prerender section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    server.close();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[prerender ${FILE}] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
