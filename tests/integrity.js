const { serve, launch, open, ROOT } = require("./harness");
const fs = require("fs"), path = require("path");
(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const { page, ctx } = await open(browser, server, "index.html", { width: 1440, height: 900 });
  const js = fs.readFileSync(path.join(ROOT, "src/js/app.js"), "utf8"); // the built page is minified: read the source
  const jsIds = [...new Set([...js.matchAll(/(?:w\(|querySelector\(|getElementById\()\s*["'`]#?([A-Za-z][\w-]*)["'`]/g)].map((m) => m[1]).filter((i) => !/^(a|li|button|label|svg|use|b|small|span|p|div|dl|dt|dd|details|summary|input|ul|ol|h\d)$/.test(i)))];
  const r = await page.evaluate((jsIds) => {
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const dup = ids.filter((i, k) => ids.indexOf(i) !== k);
    const refs = [];
    for (const attr of ["aria-controls", "aria-labelledby", "aria-describedby", "for", "list"]) {
      for (const e of document.querySelectorAll(`[${attr}]`)) for (const id of e.getAttribute(attr).split(/\s+/)) if (id && !document.getElementById(id)) refs.push(`${attr}=${id} on ${e.tagName.toLowerCase()}`);
    }
    const missingJs = jsIds.filter((id) => !document.getElementById(id));
    const hrefs = [...document.querySelectorAll("use")].map((u) => u.getAttribute("href")).filter((h) => h && !document.querySelector(h));
    const imgs = [...document.querySelectorAll("img")].length;
    return { count: ids.length, dup, refs, missingJs, hrefs, imgs, title: document.title, lang: document.documentElement.lang, h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()) };
  }, jsIds);
  console.log(JSON.stringify(r, null, 1));
  console.log("JS-referenced ids checked:", jsIds.length);
  await ctx.close(); await browser.close(); server.close();
})();
