// axe-core audit of key states. Usage: node a11y.js <file> <tag>
const { serve, launch, open, search, markerPoint, ROOT } = require("./harness");
const fs = require("fs"), path = require("path");
const FILE = process.argv[2] || "index.html", TAG = process.argv[3] || "new";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const REPAIRS = [
  { id: "r1", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Peugeot 208", rating: 4, serviceId: "vidange", price: 59.9, date: "2026-09-12", comment: "RAS", createdAt: "2026-09-12T10:00:00Z" },
  { id: "r2", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue Marcel Mérieux, 69100 Bron", lat: null, lon: null, chainId: "norauto", model: "Renault Clio", rating: 5, serviceId: "vidange", price: 72, date: "2026-08-02", comment: "", createdAt: "2026-08-02T10:00:00Z" },
  { id: "r3", garageId: "custom:garage-du-coin", garageName: "Garage du Coin", garageAddr: "", lat: null, lon: null, chainId: "", model: "Dacia Sandero", rating: 3, serviceId: "plaq_av", price: 140, date: "2026-07-05", comment: "Un peu long", createdAt: "2026-07-05T10:00:00Z" },
];
async function audit(page, label, out) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const res = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    const f = (x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, ex: x.nodes.slice(0, 3).map((n) => ({ t: n.target.join(" "), s: (n.any[0] || n.all[0] || n.none[0] || {}).message })) });
    return { violations: res.violations.map(f), incompleteContrast: (res.incomplete.find((i) => i.id === "color-contrast") || { nodes: [] }).nodes.length, passes: res.passes.length };
  });
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
    await page.click(".tab[data-view=reparations]"); await page.waitForTimeout(250);
    await audit(page, `${scheme} desktop reparations`, out);
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
