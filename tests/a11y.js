// axe-core audit of key states. Usage: node a11y.js <file> <tag>
const { serve, launch, open, search, markerPoint, ROOT, injectScript } = require("./harness");
const fs = require("fs"), path = require("path");
const FILE = process.argv[2] || "index.html", TAG = process.argv[3] || "new";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const REPAIRS = [
  { id: "r1", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Peugeot 208", rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-12", comment: "RAS", createdAt: "2026-09-12T10:00:00Z" },
  { id: "r2", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Renault Clio", rating: 5, serviceId: "vidange", price: 72, date: "2026-08-02", comment: "", createdAt: "2026-08-02T10:00:00Z" },
  { id: "r3", garageId: "custom:garage-du-coin", garageName: "Garage du Coin", garageAddr: "", lat: null, lon: null, chainId: "", model: "Dacia Sandero", rating: 3, serviceId: "plaq_av", price: 140, date: "2026-07-05", comment: "Un peu long", createdAt: "2026-07-05T10:00:00Z" },
];
async function audit(page, label, out) {
  await injectScript(page, AXE);
  const r = await page.evaluate(async () => {
    const res = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    const f = (x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, ex: x.nodes.slice(0, 3).map((n) => ({ t: n.target.join(" "), s: (n.any[0] || n.all[0] || n.none[0] || {}).message })) });
    return { violations: res.violations.map(f), incompleteContrast: (res.incomplete.find((i) => i.id === "color-contrast") || { nodes: [] }).nodes.length, passes: res.passes.length };
  });
  // Blanc sur l'orange des boutons (#FF5A1E) : 3,12:1, admis seulement en grand texte (24 px, ou 18,66 px en gras). Vérifié sur tout texte
  // affiché, quel que soit l'avis d'axe (qui classe parfois un fond en « incomplet »).
  const small = await page.evaluate(() => {
    const bgOf = (e) => { for (let n = e; n && n.nodeType === 1; n = n.parentElement) { const b = getComputedStyle(n).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") return b; } return ""; };
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t; (t = w.nextNode()); ) {
      const e = t.parentElement;
      if (!t.textContent.trim() || !e || !e.getClientRects().length) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.color !== "rgb(255, 255, 255)" || bgOf(e) !== "rgb(255, 90, 30)") continue;
      const px = parseFloat(cs.fontSize), wt = +cs.fontWeight;
      if (!(px >= 24 || (px >= 18.66 && wt >= 700))) out.push(`${e.tagName.toLowerCase()}.${e.className} ${px}px/${wt} « ${t.textContent.trim().slice(0, 30)} »`);
    }
    return out;
  });
  if (small.length) r.violations.push({ id: "white-on-orange-small-text", impact: "serious", help: "white on #FF5A1E only as large bold text", nodes: small.length, ex: small.slice(0, 3) });
  out.push({ label, ...r });
  console.log(`${label.padEnd(34)} violations=${r.violations.length} (${r.violations.map((v) => v.id + "×" + v.nodes).join(", ") || "none"}) | contrast-incomplete=${r.incompleteContrast}`);
  return r;
}
(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const out = [];
  for (const scheme of ["light", "dark"]) {
    let { page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme, storage: { "jg.repairs.v1": REPAIRS } });
    await audit(page, `${scheme} desktop initial`, out);
    await search(page, { service: "vidange" });
    await page.click("#list > li:nth-child(1) .g-main");
    await page.waitForTimeout(500);
    await audit(page, `${scheme} desktop results+open`, out);
    // the history of a garage with declarations (Norauto Bron), open: rows with their « Supprimer » buttons
    const hist = '#list [data-id="osm:node/1022"]';
    await page.locator(`${hist} .g-main`).scrollIntoViewIfNeeded();
    await page.click(`${hist} .g-main`);
    await page.waitForTimeout(400);
    await page.evaluate((s) => { const d = document.querySelector(`${s} details.history`); if (d) d.open = true; }, hist);
    if (!(await page.$(`${hist} details.history[open] .h-del`))) throw new Error("a11y: l'historique du garage ouvert doit afficher des boutons Supprimer");
    await page.waitForTimeout(250);
    await audit(page, `${scheme} desktop history+delete`, out);
    await page.click(".tab[data-view=prix]"); await page.waitForTimeout(250);
    await audit(page, `${scheme} desktop prix`, out);
    await page.click("#addRepairBtn"); await page.waitForTimeout(350);
    await audit(page, `${scheme} desktop dialog`, out);
    await ctx.close();
    ({ page, ctx } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, colorScheme: scheme, storage: { "jg.repairs.v1": REPAIRS } }));
    await search(page, { service: "vidange" });
    await page.click("#list > li:nth-child(1) .g-main"); await page.waitForTimeout(400);
    await audit(page, `${scheme} mobile results+open`, out);
    if (TAG !== "orig") {
      await page.click("#mapFab"); await page.waitForTimeout(900);
      const mp = await markerPoint(page, 6); await page.touchscreen.tap(mp.x, mp.y); await page.waitForTimeout(600);
      await audit(page, `${scheme} mobile map+bar`, out);
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(__dirname, ".out", "shots", `a11y-${TAG}.json`), JSON.stringify(out, null, 1));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
