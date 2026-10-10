// Visual states of the refreshed page (light/dark, desktop/tablet/mobile).
const { serve, launch, open, search, shot, sheet, markerPoint, ROOT, pickServices, editSearch } = require("./harness");
const path = require("path");
const FILE = process.argv[2] || "index.html";
(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const report = [];
  const log = (...a) => report.push(a.join(" "));

  // ---------- Desktop light: marker click, collapse/expand, dialog, CT ----------
  let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 });
  await search(page, { service: "vidange" });
  await page.mouse.move(700, 450);
  // click on the 3rd priced marker (view sorted by price asc)
  let mp = await markerPoint(page, 4);
  log("marker point", JSON.stringify(mp));
  await page.mouse.click(mp.x, mp.y);
  await page.waitForTimeout(900);
  await shot(page, "d-10-marker-click");
  // close via info bar ×
  await page.click("#mapInfo [data-mi=close]");
  await page.waitForTimeout(300);
  await shot(page, "d-11-after-close");
  // scroll panel to top & expand the search form
  await page.evaluate(() => document.getElementById("panelCol").scrollTo(0, 0));
  await editSearch(page);
  await page.waitForTimeout(300);
  await shot(page, "d-12-form-expanded");
  // dialog
  await page.click("#addRepairBtn");
  await page.waitForTimeout(400);
  await shot(page, "d-13-dialog");
  await page.click("#repairForm button[type=submit]");
  await page.waitForTimeout(300);
  await shot(page, "d-14-dialog-errors");
  log("desktop console", JSON.stringify(logs.console), "errors", JSON.stringify(logs.errors));
  await ctx.close();

  // ---------- Desktop CT ----------
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  await pickServices(page, "ct");
  await page.fill("#address", "lyon");
  await page.waitForSelector("#addrList li[data-i]");
  await page.click("#addrList li[data-i='0']");
  await page.click("#go");
  await page.waitForSelector("#list > li", { timeout: 12000 });
  await page.waitForTimeout(500);
  await shot(page, "d-20-ct");
  await page.click("#list > li:nth-child(1) .g-main");
  await page.waitForTimeout(700);
  await shot(page, "d-21-ct-open");
  log("ct console", JSON.stringify(logs.console), "errors", JSON.stringify(logs.errors));
  await ctx.close();

  // ---------- Desktop dark ----------
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: "dark" }));
  await shot(page, "dk-00-initial");
  await search(page, { service: "vidange" });
  mp = await markerPoint(page, 2);
  await page.mouse.click(mp.x, mp.y);
  await page.waitForTimeout(900);
  await shot(page, "dk-01-selected");
  await page.click(".tab[data-view=prix]");
  await page.mouse.move(700, 450);
  await page.waitForTimeout(300);
  await shot(page, "dk-02-prix");
  await page.click("#addRepairBtn");
  await page.waitForTimeout(400);
  await shot(page, "dk-03-dialog");
  log("dark console", JSON.stringify(logs.console), "errors", JSON.stringify(logs.errors));
  await ctx.close();

  // ---------- Preview mode (no network), error states ----------
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { geocodeFail: true } }));
  await page.waitForTimeout(500);
  await shot(page, "d-30-preview");
  await ctx.close();
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { overpassFail: true, sireneFail: true } }));
  await page.fill("#address", "12 rue de la république lyon");
  await page.waitForSelector("#addrList li[data-i]");
  await page.click("#addrList li[data-i='0']");
  await page.click("#go");
  await page.waitForSelector("#status.err", { timeout: 20000 });
  await shot(page, "d-31-overpass-fail");
  await ctx.close();
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: [] } }));
  await page.fill("#address", "12 rue de la république lyon");
  await page.waitForSelector("#addrList li[data-i]");
  await page.click("#addrList li[data-i='0']");
  await page.click("#go");
  await page.waitForSelector("#summary:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot(page, "d-32-no-results");
  await ctx.close();

  // ---------- Tablet ----------
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 820, height: 1180 }));
  await search(page, { service: "vidange" });
  await shot(page, "t-00-results");
  await page.click("#mapFab");
  await page.waitForTimeout(900);
  mp = await markerPoint(page, 3);
  await page.mouse.click(mp.x, mp.y);
  await page.waitForTimeout(700);
  await shot(page, "t-01-map-selected");
  log("tablet console", JSON.stringify(logs.console), "errors", JSON.stringify(logs.errors));
  await ctx.close();

  // ---------- Mobile ----------
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true }));
  await shot(page, "m-00-initial");
  await search(page, { service: "vidange" });
  await page.click("#list > li:nth-child(1) .g-main");
  await page.waitForTimeout(500);
  await shot(page, "m-01-card-open");
  await page.click("#mapFab");
  await page.waitForTimeout(1000);
  await shot(page, "m-02-map-with-selection");
  mp = await markerPoint(page, 6);
  await page.touchscreen.tap(mp.x, mp.y);
  await page.waitForTimeout(800);
  await shot(page, "m-03-map-marker-tap");
  await page.click("#mapInfo [data-mi=card]");
  await page.waitForTimeout(900);
  await shot(page, "m-04-back-to-card");
  await page.click("#addRepairBtn");
  await page.waitForTimeout(500);
  await shot(page, "m-05-dialog-sheet");
  log("mobile console", JSON.stringify(logs.console), "errors", JSON.stringify(logs.errors));
  await ctx.close();

  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, colorScheme: "dark" }));
  await search(page, { service: "vidange" });
  await shot(page, "mk-00-results");
  await page.click("#mapFab");
  await page.waitForTimeout(1000);
  mp = await markerPoint(page, 5);
  await page.touchscreen.tap(mp.x, mp.y);
  await page.waitForTimeout(800);
  await shot(page, "mk-01-map");
  await ctx.close();

  await browser.close();
  server.close();
  console.log(report.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
