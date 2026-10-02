// Emulates a browser WITHOUT scroll anchoring (Safari) and checks the clicked card does not jump.
const { serve, launch, open, search, ROOT, injectStyle } = require("./harness");
const path = require("path");
(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  for (const file of process.argv[2] ? [process.argv[2]] : ["index.html"]) { // (pass a variant without the compensation as a control)
    for (const mode of ["desktop", "mobile"]) {
      const o = mode === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844, dpr: 2, touch: true };
      const { page, ctx } = await open(browser, server, file, o);
      await injectStyle(page, "*{overflow-anchor:none!important}");
      await search(page, { service: "vidange" });
      await page.click("#list > li:nth-child(2) .g-main");
      await page.waitForTimeout(300);
      // bring card 9 near the top of the scroll area, then click it
      await page.evaluate((mode) => {
        const t = document.querySelector("#list > li:nth-child(9)");
        if (mode === "desktop") { const p = document.getElementById("panelCol"); p.scrollTop += t.getBoundingClientRect().top - p.getBoundingClientRect().top - 200; }
        else window.scrollBy(0, t.getBoundingClientRect().top - 200);
      }, mode);
      await page.waitForTimeout(250);
      const y0 = await page.$eval("#list > li:nth-child(9)", (e) => e.getBoundingClientRect().top);
      if (mode === "desktop") await page.mouse.click(300, y0 + 25); else await page.touchscreen.tap(200, y0 + 25);
      await page.waitForTimeout(250);
      const y1 = await page.$eval("#list > li:nth-child(9)", (e) => e.getBoundingClientRect().top);
      console.log(`${file.padEnd(16)} ${mode.padEnd(8)} card top before=${Math.round(y0)} after=${Math.round(y1)} shift=${Math.round(y1 - y0)}px`);
      await ctx.close();
    }
  }
  await browser.close(); server.close();
})();
