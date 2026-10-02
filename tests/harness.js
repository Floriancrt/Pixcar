// Shared test harness: static server, browser launcher, mocked page opener, helpers.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const https = require("https");
const { installMocks, iconPNG, icoFile } = require("./mocks");

const ROOT = path.join(__dirname, "..");
const SHOTS = path.join(__dirname, ".out", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

function serve(dir) {
  // PIXCAR_ROOT=dist : on teste le site publiable tel qu'un hébergeur le sert (types MIME, compression, _headers dont la
  // politique de sécurité du contenu) ; sinon, les fichiers du dépôt tels quels.
  if (process.env.PIXCAR_ROOT) return require("./static-server").serveDir(path.join(ROOT, process.env.PIXCAR_ROOT));
  const srv = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end("nf");
    }
    const ext = path.extname(f);
    res.writeHead(200, { "content-type": ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

// "Real" mode (open(..., { real: true })): the hosts the page talks to are mapped to a local HTTPS server with
// --host-resolver-rules and Playwright does not route anything. Needed for the official-site icons: while a route is
// active Playwright drops every page-initiated */favicon.ico request, so tier 2 cannot be tested through route().
// The very same handlers of mocks.js answer, behind a small route() adapter; the chains' official sites answer here.
const ICON_HOSTS = ["www.euromaster.fr", "www.feuvert.fr", "www.midas.fr", "www.norauto.fr", "www.roady.fr", "www.speedy.fr", "www.ad.fr",
  "www.points.fr", "www.firststop.fr", "www.vulco.fr", "www.profilplus.fr", "www.siligom.fr", "www.eurotyre.fr", "www.bestdrive.fr", "www.auto.leclerc",
  "www.carter-cash.com", "www.eurorepar.fr", "www.motrio.fr", "www.boschcarservice.com", "www.top-garage.fr", "www.precisium.fr", "www.delko.fr",
  "www.autoprimo.com", "www.avatacar.com", "www.carglass.fr"];
const MOCK_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "data.geopf.fr", "overpass-api.de", "overpass.openstreetmap.fr", "maps.mail.ru", "recherche-entreprises.api.gouv.fr", "data.economie.gouv.fr", "query.wikidata.org", "commons.wikimedia.org", "upload.wikimedia.org", "*.basemaps.cartocdn.com"];
async function startReal() {
  const real = { config: {}, hits: [], port: 0, handler: null, close: () => {} };
  const srv = https.createServer(
    { key: fs.readFileSync(path.join(__dirname, "tls/key.pem")), cert: fs.readFileSync(path.join(__dirname, "tls/cert.pem")) },
    async (req, res) => {
      const host = String(req.headers.host || "").split(":")[0], p = req.url.split("?")[0];
      if (ICON_HOSTS.includes(host)) {
        real.hits.push(host + p);
        const spec = (real.config[host] || {})[p];
        if (spec && typeof spec === "object") {
          const ico = p.endsWith(".ico");
          res.writeHead(200, { "content-type": ico ? "image/x-icon" : "image/png", "cache-control": "no-store" });
          return res.end(ico ? icoFile(spec.frames || [spec.size], spec.color) : iconPNG(spec.size, spec.color));
        }
        res.writeHead(typeof spec === "number" ? spec : 404, { "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
        return res.end();
      }
      if (!real.handler) { res.writeHead(503); return res.end(); }
      const route = {
        request: () => ({ url: () => `https://${host}${req.url}` }),
        fulfill: async ({ status = 200, contentType, headers = {}, body = "" }) => {
          res.writeHead(status, { ...(contentType ? { "content-type": contentType } : {}), ...headers });
          res.end(body);
        },
        abort: async () => req.socket.destroy(),
        continue: async () => { res.writeHead(502); res.end(); },
      };
      try { await real.handler(route); } catch (e) { res.writeHead(500); res.end(String(e)); }
    },
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  real.port = srv.address().port;
  real.close = () => srv.close();
  return real;
}

async function launch(opts = {}) {
  const real = await startReal();
  const rules = [...ICON_HOSTS, ...MOCK_HOSTS].map((h) => `MAP ${h} 127.0.0.1:${real.port}`).join(",");
  // (--no-proxy-server is ignored by this headless shell; the sandbox's HTTPS proxy would otherwise be tried)
  // opts.scrollbars: keep the classic (non-overlay) scrollbars, which headless Chromium hides by default
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=${rules}`, "--proxy-server=direct://", "--proxy-bypass-list=*"],
    ...(opts.scrollbars ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}),
  });
  browser.__real = real;
  const close = browser.close.bind(browser);
  browser.close = async () => (real.close(), close());
  return browser;
}

/** Open a page of the site under test with all external services mocked. */
async function open(browser, server, file, o = {}) {
  const {
    width = 1440, height = 900, colorScheme = "light", reducedMotion = "no-preference", dpr = 1,
    today = "2026-10-01", storage = null, mock = {}, touch = false, logosPin = null, initScript = "", forcedColors = "none",
  } = o;
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme, reducedMotion, forcedColors, deviceScaleFactor: dpr,
    locale: "fr-FR", timezoneId: "Europe/Paris", hasTouch: touch, isMobile: touch, ignoreHTTPSErrors: true,
    // le service worker change qui répond aux requêtes du site : bloqué partout sauf dans sa propre suite (tests/offline.js)
    serviceWorkers: process.env.PIXCAR_SW === "1" ? "allow" : "block",
  });
  const logs = { console: [], errors: [], failed: [], requests: [] };
  await ctx.addInitScript(
    `window.JG_TUNE={today:${JSON.stringify(today)},stagger:60,retry:60,osmTimeout:8000,sirenePace:5};` +
      (storage ? `try{for(const [k,v] of Object.entries(${JSON.stringify(storage)}))localStorage.setItem(k,JSON.stringify(v))}catch(e){}` : "") +
      (logosPin ? `window.JG_LOGOS=${JSON.stringify(logosPin)};` : "") + initScript,
  );
  if (o.real) {
    const real = browser.__real;
    real.config = mock.siteIcons || {};
    real.hits.length = 0;
    const fake = { route: async (_pattern, handler) => { real.handler = handler; } };
    await installMocks(fake, { log: () => {}, ...mock });
    ctx.__counters = fake.__counters;
    ctx.__counters.siteIcons = real.hits;
  } else await installMocks(ctx, { log: () => {}, ...mock });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (!["error", "warning"].includes(m.type())) return;
    const u = (m.location() && m.location().url) || "";
    if (/\/apple-touch-icon\.png$|\/favicon\.ico$|wikimedia\.org/.test(u)) return; // expected misses of the optional logo tiers
    if (/Service Worker registration blocked by Playwright/.test(m.text())) return; // the harness blocks service workers (see serviceWorkers above)
    logs.console.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("request", (r) => logs.requests.push(r.url()));
  page.on("pageerror", (e) => logs.errors.push(String(e && e.stack ? e.stack : e)));
  page.on("requestfailed", (r) => logs.failed.push(`${r.url().slice(0, 100)} ${r.failure() && r.failure().errorText}`));
  await page.goto(`${server.url}/${file}`);
  await page.waitForLoadState("load");
  // wait for the live/preview probe to settle
  await page.waitForTimeout(250);
  return { page, ctx, logs };
}

/** Type an address, pick the first suggestion, optionally set radius, submit, wait for results. */
async function search(page, { service, address = "12 rue de la république lyon", km, sirene = false } = {}) {
  if (service) await page.selectOption("#service", service);
  await page.fill("#address", address);
  await page.waitForSelector("#addrList li[data-i]", { state: "visible", timeout: 5000 });
  await page.click("#addrList li[data-i='0']");
  if (km) await page.click(`#radiusChips .chip[data-km='${km}']`);
  if (sirene) await page.check("#sirene");
  await page.click("#go");
  await page.waitForSelector("#list > li", { timeout: 12000 });
  await page.waitForTimeout(400);
}

const shot = async (page, name, opt = {}) => {
  const p = path.join(SHOTS, name + ".png");
  await page.screenshot({ path: p, ...opt });
  return p;
};

/** Contact sheet: lay several screenshots side by side into one image (for quick visual review). */
async function sheet(browser, files, out, { cols = 3, width = 1500, bg = "#888" } = {}) {
  const p = await browser.newPage({ viewport: { width, height: 800 } });
  const imgs = files.map((f) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(SHOTS, f + ".png")).toString("base64")}" style="width:${Math.floor((width - 8 * (cols + 1)) / cols)}px;display:block;border:1px solid #0002">`).join("");
  await p.setContent(`<body style="margin:8px;background:${bg};display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;align-items:start">${imgs}</body>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(SHOTS, out + ".png"), fullPage: true });
  await p.close();
}

/** Pixel position (page coordinates) of the Leaflet marker belonging to garage index i (in current view order). */
async function markerPoint(page, which = 0) {
  return page.evaluate((which) => {
    const m = (window.__maps || [])[0];
    if (!m) return null;
    const mk = [];
    m.eachLayer((l) => { if (l.jg) mk.push(l); });
    if (!mk.length) return null;
    const l = mk[which];
    const pt = m.latLngToContainerPoint(l.getLatLng());
    const r = m.getContainer().getBoundingClientRect();
    return { x: r.left + pt.x, y: r.top + pt.y, id: l.jg.id, name: l.jg.name, n: mk.length };
  }, which);
}

// page.addScriptTag / addStyleTag posent des éléments « inline » : la politique de sécurité du contenu du site publiable les
// refuse. Ces aides passent par le protocole de débogage (évaluation directe) et par une feuille de style construite, que la
// politique n'interdit pas : le site reste testé avec sa politique, sans exception pour les tests.
const injectScript = (page, source) => page.evaluate(source);
async function injectStyle(page, css) {
  await page.evaluate((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    (window.__testSheets = window.__testSheets || []).push(sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, css);
  return () => page.evaluate(() => { const s = window.__testSheets.pop(); document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s); });
}
module.exports = { serve, launch, open, search, shot, sheet, markerPoint, injectScript, injectStyle, SHOTS, ROOT };
