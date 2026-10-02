const { serve, launch, open, search, shot, sheet, markerPoint, ROOT } = require("./harness");
const path = require("path");
(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const out = [];
  for (const [w, h] of [[1280, 720], [1024, 768]]) {
    const { page, ctx, logs } = await open(browser, server, "index.html", { width: w, height: h });
    await search(page, { service: "vidange" });
    // select the garage with the very long name
    await page.evaluate(() => { const b = [...document.querySelectorAll(".g-name")].find((x) => /SNERA/.test(x.textContent)); b && b.closest(".card").scrollIntoView({ block: "start" }); });
    await page.waitForTimeout(300);
    const n = await page.$$eval(".g-name", (l) => l.findIndex((x) => /SNERA/.test(x.textContent)));
    if (n >= 0) await page.click(`#list > li:nth-child(${n + 1}) .g-main`);
    await page.waitForTimeout(800);
    await shot(page, `sz-${w}`);
    const overflow = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth, panelOverflowX: document.getElementById("panelCol").scrollWidth - document.getElementById("panelCol").clientWidth }));
    out.push(`${w}x${h} overflow: ${JSON.stringify(overflow)} console=${JSON.stringify(logs.console)} errors=${JSON.stringify(logs.errors)}`);
    await ctx.close();
  }
  // live resize: desktop -> mobile -> desktop with a selection
  const { page, ctx, logs } = await open(browser, server, "index.html", { width: 1440, height: 900 });
  await search(page, { service: "vidange" });
  await page.click("#list > li:nth-child(3) .g-main");
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot(page, "sz-resize-mobile");
  await page.click("#mapFab");
  await page.waitForTimeout(900);
  await shot(page, "sz-resize-mobile-map");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(900);
  await shot(page, "sz-resize-back");
  const mapOk = await page.evaluate(() => { const m = window.__maps[0], c = m.getContainer().getBoundingClientRect(), s = m.getSize(); return { cw: Math.round(c.width), cs: s.x, sel: document.querySelectorAll(".card.is-selected").length, bar: !document.getElementById("mapInfo").hidden, isMap: document.body.classList.contains("is-map") }; });
  out.push("after resize back: " + JSON.stringify(mapOk) + " console=" + JSON.stringify(logs.console) + " errors=" + JSON.stringify(logs.errors));
  await ctx.close();
  const b = await launch();
  await sheet(b, ["sz-1280", "sz-1024"], "S11-sizes", { cols: 2, width: 1500 });
  await sheet(b, ["sz-resize-mobile", "sz-resize-mobile-map", "sz-resize-back"], "S12-resize", { cols: 3, width: 1700 });
  await b.close();
  await browser.close(); server.close();
  console.log(out.join("\n"));
})();
