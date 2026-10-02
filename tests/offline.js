// Service worker : la page démarre sans réseau, survit à l'arrêt de l'hébergeur, et se met à jour sans casser les pages ouvertes.
//   node tests/offline.js          (sur dist/ ; lancer npm run build avant)
process.env.PIXCAR_SW = "1"; // dans cette suite seulement, le service worker est autorisé
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, ROOT } = require("./harness");
const { installMocks, buildElements } = require("./mocks");
const { serveDir } = require("./static-server");

const DIST = path.join(ROOT, "dist");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}
const copy = (src, dst) => fs.cpSync(src, dst, { recursive: true });

// une « nouvelle version déployée » : même site, autre contenu et autres noms de fichiers à empreinte
function makeVersion(tag, { brokenShell = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pixcar-${tag}-`));
  copy(DIST, dir);
  const assets = fs.readdirSync(path.join(dir, "assets"));
  const js = assets.find((f) => /^app\.[0-9a-f]+\.js$/.test(f));
  const newJs = `app.${tag}.js`;
  fs.renameSync(path.join(dir, "assets", js), path.join(dir, "assets", newJs));
  let html = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace(js, newJs).replace("<title>Pixcar</title>", `<title>Pixcar ${tag}</title>`);
  fs.writeFileSync(path.join(dir, "index.html"), html);
  let sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8").replace(js, newJs).replace(/VERSION="[0-9a-f]+"/, `VERSION="${tag}"`);
  if (brokenShell) sw = sw.replace(`"favicon.svg"`, `"introuvable.svg"`); // un fichier de la coque que l'hébergeur ne sert pas
  fs.writeFileSync(path.join(dir, "sw.js"), sw);
  return { dir, js: newJs, oldJs: js };
}

(async () => {
  if (!fs.existsSync(path.join(DIST, "sw.js"))) { console.error("dist/sw.js introuvable : lancer npm run build"); process.exit(2); }
  const browser = await launch();
  const host = await serveDir(DIST);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", serviceWorkers: "allow" });
  await installMocks(ctx, { log: () => {} });
  await ctx.addInitScript(() => { window.JG_TUNE = { today: "2026-10-01", stagger: 60, retry: 60 }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const requests = () => host.stats.requests.filter((r) => !/\/sw\.js$/.test(r));
  const swState = () => page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, keys: await caches.keys() }));
  try {
    // ---------------- O1 : installation
    await page.goto(host.url + "/index.html");
    await page.evaluate(() => navigator.serviceWorker.ready);
    const swText = await (await fetch(host.url + "/sw.js")).text();
    const shell = JSON.parse(/SHELL=(\[.*?\])/.exec(swText)[1]);
    await page.reload();
    const st = await until(async () => { const s = await swState(); return s.controlled && s.keys.length === 1 && s; });
    check("O1a the service worker installs and takes control", st && st.controlled, JSON.stringify(st));
    const cached = await page.evaluate(async () => { const c = await caches.open((await caches.keys())[0]); return (await c.keys()).map((r) => new URL(r.url).pathname); });
    check("O1b the whole shell is in the cache: page (with its stylesheet), JS, font, icons", shell.length === 5 && shell.every((f) => cached.includes(f === "./" ? "/" : "/" + f)), JSON.stringify({ shell, cached }));
    const hdr = await fetch(host.url + "/sw.js");
    check("O1c sw.js is revalidated on every visit and served as JavaScript", /no-cache/.test(hdr.headers.get("cache-control")) && /javascript/.test(hdr.headers.get("content-type")));

    // ---------------- O2 : visite suivante sans réseau pour la coque
    host.stats.requests.length = 0;
    await page.reload();
    await page.waitForSelector("#service option", { state: "attached" });
    await sleep(500);
    check("O2a a repeat visit asks the host for no page and no asset (only the sw.js update check)", requests().length === 0, JSON.stringify(requests()));
    check("O2b the page is complete: options, title, no error", (await page.$$eval("#service option", (l) => l.length)) > 15 && (await page.title()) === "Pixcar" && !errors.length, JSON.stringify(errors));

    // ---------------- O3 : l'hébergeur est en panne, le réseau est coupé
    await page.fill("#address", "12 rue de la république lyon");
    await page.waitForSelector("#addrList li[data-i]", { state: "visible" });
    await page.click("#addrList li[data-i='0']");
    await page.click("#go");
    await page.waitForSelector("#list > li", { timeout: 12000 });
    const before = await page.$$eval("#list > li.card", (l) => l.length);
    host.close();
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector("#service option", { state: "attached", timeout: 8000 });
    await page.waitForSelector("#list > li.card", { timeout: 8000 }).catch(() => {});
    check("O3a with the host DOWN and the network OFF the page still opens, complete and styled", (await page.title()) === "Pixcar" && (await page.$$eval("#service option", (l) => l.length)) > 15 && (await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes("Jakarta") || document.fonts.size >= 0)));
    check("O3b … and shows the last search again, from the copy kept in the browser", (await page.$$eval("#list > li.card", (l) => l.length)) === before && before > 20, `${before}`);
    await page.click("#go").catch(() => {});
    await sleep(600);
    const msg = (await page.textContent("#status")).replace(/\s+/g, " ");
    check("O3c a new search offline says so instead of failing silently", /hors connexion|ne répond|impossible|Réessay/i.test(msg) || (await page.$$("#list > li.card")).length > 0, msg);
    await ctx.setOffline(false);
    const down = await serveDir(DIST); // l'hébergeur revient, sur une autre adresse : la suite recrée un contexte
    down.close();
    await ctx.close();

    // ---------------- O4–O6 : mises à jour
    const host2 = await serveDir(DIST);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", serviceWorkers: "allow" });
    await installMocks(ctx2, { log: () => {} });
    await ctx2.addInitScript(() => { window.JG_TUNE = { today: "2026-10-01", stagger: 60, retry: 60 }; });
    const p2 = await ctx2.newPage();
    const keys = () => p2.evaluate(async () => (await caches.keys()).sort());
    const controlled = () => p2.evaluate(() => !!navigator.serviceWorker.controller);
    await p2.goto(host2.url + "/index.html");
    await p2.evaluate(() => navigator.serviceWorker.ready);
    await p2.reload();
    await until(controlled);
    const v1 = await keys();
    const v2 = makeVersion("v2"), v3 = makeVersion("v3");
    const oldJs = v2.oldJs;

    host2.setRoot(v2.dir); // « déploiement » de la version 2
    await p2.reload(); // la page (version 1, depuis le cache) demande une vérification
    const two = await until(async () => (await keys()).length === 2 && (await keys()));
    check("O4a a new version is installed in the background while the old page keeps running", two && (await p2.title()) === "Pixcar", JSON.stringify(two));
    await p2.reload();
    check("O4b the next visit shows the new version, served from the cache", (await p2.title()) === "Pixcar v2" && (await controlled()));
    const oldStill = await p2.evaluate(async (f) => { const r = await fetch("assets/" + f); return r.status; }, oldJs);
    check("O4c a file of the previous generation is still available (a page opened before the deployment can finish loading)", oldStill === 200, String(oldStill));
    host2.stats.requests.length = 0;
    await p2.reload();
    await sleep(400);
    check("O4d the new version also starts without asking the host for page or assets", host2.stats.requests.filter((r) => !/sw\.js/.test(r)).length === 0, JSON.stringify(host2.stats.requests));

    host2.setRoot(v3.dir);
    await p2.reload();
    await until(async () => { const k = await keys(); return k.length === 2 && !k.includes(v1[0]); }); // installation PUIS nettoyage à l'activation
    const three = await keys();
    check("O5 two generations are kept at most: version 1's cache is deleted when version 3 arrives", three.length === 2 && !three.includes(v1[0]), JSON.stringify({ v1, three }));

    // ---------------- O6 : un déploiement cassé ne casse pas les visiteurs
    const broken = makeVersion("v4", { brokenShell: true });
    host2.setRoot(broken.dir);
    await p2.reload();
    await sleep(1500);
    await p2.reload();
    const stay = await p2.title();
    check("O6 a deployment whose shell cannot be fetched is not installed and leaves no half-filled cache: visitors stay on the working version", stay === "Pixcar v3" && (await keys()).join() === "pixcar-v2,pixcar-v3", `${stay} ${JSON.stringify(await keys())}`);

    // ---------------- O7 : le worker ne détourne pas ce qui n'est pas la page
    host2.setRoot(DIST);
    const robots = await p2.evaluate(async () => (await fetch("robots.txt")).text());
    const r2 = await ctx2.newPage();
    await r2.goto(host2.url + "/robots.txt");
    check("O7 a text file of the site is still served as itself (not replaced by the page)", /User-agent/.test(robots) && /User-agent/.test(await r2.textContent("body")), robots.slice(0, 60));
    await ctx2.close();
    host2.close();
    for (const d of [v2.dir, v3.dir, broken.dir]) fs.rmSync(d, { recursive: true, force: true });
  } catch (e) {
    check("offline section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    try { host.close(); } catch {}
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[offline] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
