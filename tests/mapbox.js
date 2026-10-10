// Fond de carte Mapbox : tuiles raster affichées par Leaflet à la place du Plan IGN quand la page porte un jeton PUBLIC Mapbox (src/mapbox.json pour
// la version publiée, PIXCAR_MAPBOX_TOKEN) ; sans jeton rien n'est demandé à Mapbox ; un jeton secret ou mal formé arrête le build ; repli sur
// l'IGN puis sur CARTO quand Mapbox refuse les tuiles ; attribution exigée par Mapbox ; texte de confidentialité ; politique de sécurité de la
// version publiée (GitHub Pages, sans en-têtes). Les sites sont construits ici, avec une copie des sources dont src/legal.json est complet
// (valeurs fictives). Mapbox lui-même n'est jamais joint : tests/mocks.js (option mapbox) sert des tuiles et peut les refuser.
//   node tests/mapbox.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert ses propres pages, quel que soit le site que les autres suites testent
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, ROOT, injectScript } = require("./harness");
const { buildElements, installMocks } = require("./mocks");
const { serveDir } = require("./static-server");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};

const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const OUT = path.join(__dirname, ".out", "mapbox-site");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src"); // les tests de mutation y mettent une copie modifiée des sources
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs"); // idem pour le build
const TOKEN = ["pk", "eyJ1IjoicGl4Y2FyLXRlc3QifQ", "c2lnbmF0dXJlLWZpY3RpZg"].join("."); // jeton fictif, de la bonne forme
const SECRET = ["sk", "eyJ1IjoicGl4Y2FyLXRlc3QifQ", "c2lnbmF0dXJlLWZpY3RpZg"].join("."); // « jeton secret » fictif (écrit en morceaux : le contrôle M08 cherche ce motif dans le dépôt)
const LEGAL = {
  editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.",
  contact: "contact@exemple.test",
  hostPages: "GitHub, Inc. (GitHub Pages), États-Unis",
  hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};
const REAL = JSON.parse(fs.readFileSync(path.join(SRC, "mapbox.json"), "utf8")); // ce que le dépôt contient
const MB_PATH = /^https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/light-v11\/tiles\/512\/(\d+)\/(\d+)\/(\d+)(@2x)?\?access_token=([^&]+)$/;

// Construit un site dans OUT/<name> : token = PIXCAR_MAPBOX_TOKEN (undefined : non défini), style = PIXCAR_MAPBOX_STYLE, file = contenu de src/mapbox.json.
function prepare(name, { legal = LEGAL, file } = {}) {
  const src = path.join(OUT, name + "-src");
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(legal));
  if (file) fs.writeFileSync(path.join(src, "mapbox.json"), JSON.stringify(file));
  return src;
}
const envOf = ({ token, style }) => {
  const env = { ...process.env, PIXCAR_API_BASE: "", PIXCAR_GA_ID: "" };
  if (token === undefined) delete env.PIXCAR_MAPBOX_TOKEN;
  else env.PIXCAR_MAPBOX_TOKEN = token;
  if (style === undefined) delete env.PIXCAR_MAPBOX_STYLE;
  else env.PIXCAR_MAPBOX_STYLE = style;
  return env;
};
function site(name, { token, style, legal, file, only = "single", pages } = {}) {
  const src = prepare(name, { legal, file });
  const args = [BUILD, "--only", only, "--src", src, "--out", path.join(OUT, name)];
  if (pages) args.push("--pages", pages);
  execFileSync(process.execPath, args, { stdio: "pipe", env: envOf({ token, style }) });
  return path.join(OUT, name, only === "dist" ? "dist" : "");
}
const attempt = (name, { token, style, legal, file, pages } = {}) => {
  const src = prepare(name, { legal, file });
  const args = [BUILD, "--only", "single", "--src", src, "--out", path.join(OUT, name)];
  if (pages) args.push("--pages", pages);
  return spawnSync(process.execPath, args, { encoding: "utf8", env: envOf({ token, style }) });
};
const metaOf = (dir) => {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const m = /<meta name="pixcar-mapbox" content="([^"]*)" data-style="([^"]*)" data-enrich="([^"]*)">/.exec(html);
  return m ? { token: m[1], style: m[2], enrich: m[3] } : null;
};
const policyOf = (dir) => (/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8")) || [])[1] || "";

const norm = (t) => String(t).replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
const axeOf = async (page) => {
  await injectScript(page, AXE);
  return page.evaluate(async (tags) => (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 120)) })), TAGS);
};
const tilesIn = (page) => page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length > 0, null, { timeout: 8000 }).then(() => true, () => false);
const attribution = (page) => page.evaluate(() => (document.querySelector(".leaflet-control-attribution") || {}).innerHTML || "");
const attributionText = (page) => page.evaluate(() => ((document.querySelector(".leaflet-control-attribution") || {}).textContent || "").replace(/\s+/g, " "));
const waitAttribution = (page, text) => page.waitForFunction((t) => ((document.querySelector(".leaflet-control-attribution") || {}).textContent || "").includes(t), text, { timeout: 8000 }).then(() => true, () => false);
const tileBases = (page) => page.evaluate(() => [...document.querySelectorAll(".leaflet-tile")].map((i) => i.src));
const MOCK = (extra = {}) => ({ elements: buildElements(), ...extra });
const viewOf = async (browser, srv, { mock, dpr = 1, colorScheme = "light", width = 1440, height = 900 } = {}) => {
  const o = await open(browser, srv, "index.html", { width, height, dpr, colorScheme, mock });
  await search(o.page, { service: "vidange" });
  return o;
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ============ construction ============
  check("M01 the repository file src/mapbox.json is well formed: no token yet or a PUBLIC one (pk.…), a style of the form « compte/style »", typeof REAL.accessToken === "string" && (REAL.accessToken === "" || /^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(REAL.accessToken)) && /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(REAL.style), JSON.stringify({ ...REAL, accessToken: REAL.accessToken.slice(0, 3) }));
  const none = site("none"); // ni variable ni --pages : aucun jeton
  const withToken = site("with", { token: TOKEN });
  const noneMeta = metaOf(none), withMeta = metaOf(withToken);
  check("M02 without a token: the page has an empty Mapbox meta tag (and the build does not fail)", noneMeta && noneMeta.token === "" && noneMeta.style === "", JSON.stringify(noneMeta));
  check("M03 with PIXCAR_MAPBOX_TOKEN: the page carries the token and the default style (mapbox/light-v11)", withMeta && withMeta.token === TOKEN && withMeta.style === "mapbox/light-v11", JSON.stringify(withMeta));
  check("M03b …and no early connection to Mapbox (no preconnect, no preload): a visitor who never opens the map never contacts it", !/rel="(preconnect|preload|dns-prefetch)"[^>]*mapbox/i.test(fs.readFileSync(path.join(withToken, "index.html"), "utf8")) && !/<link[^>]*mapbox/i.test(fs.readFileSync(path.join(withToken, "index.html"), "utf8")), "");
  const styled = site("styled", { token: TOKEN, style: "mapbox/streets-v12" });
  check("M04 PIXCAR_MAPBOX_STYLE chooses the style", (metaOf(styled) || {}).style === "mapbox/streets-v12", JSON.stringify(metaOf(styled)));
  check("M05 a secret token (sk.…) stops the build, with a message that says why and does not repeat the token", (() => {
    const r = attempt("secret", { token: SECRET });
    return r.status !== 0 && /jeton Mapbox refusé/.test(r.stderr) && /PUBLIC/.test(r.stderr) && !r.stderr.includes(SECRET) && !r.stdout.includes(SECRET);
  })());
  check("M06 so does anything that is not a public token: temporary or malformed tokens, a URL, a token that tries to close the attribute", ["tk.abc.def", "pk.abc", "pk.a.b.c", "PK.a.b", "pk.a b.c", `pk.a.b"><script>`, "https://api.mapbox.com/?access_token=pk.a.b", "pk.a.b?x=1"].every((bad, i) => {
    const r = attempt("bad-" + i, { token: bad });
    return r.status !== 0 && /jeton Mapbox refusé/.test(r.stderr);
  }));
  check("M07 an invalid style stops the build too", ["light-v11", "mapbox/", "mapbox/light v11", "a/b/c", "mapbox/light-v11\"x"].every((bad, i) => {
    const r = attempt("badstyle-" + i, { token: TOKEN, style: bad });
    return r.status !== 0 && /style Mapbox invalide/.test(r.stderr);
  }));
  const leaks = (() => {
    const found = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if ([".git", "node_modules", ".out", ".mut", "dist"].includes(e.name)) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(js|mjs|json|html|css|md|py|txt|yml|yaml|sh)$/.test(e.name) && fs.statSync(f).size < 3e6 && /\bsk\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(fs.readFileSync(f, "utf8"))) found.push(path.relative(ROOT, f));
      }
    };
    for (const top of ["src", "scripts", "docs", "tests", "server", "infra"]) if (fs.existsSync(path.join(ROOT, top))) walk(path.join(ROOT, top));
    for (const f of ["README.md", "CLAUDE.md", "index.html"]) if (fs.existsSync(path.join(ROOT, f)) && /\bsk\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(fs.readFileSync(path.join(ROOT, f), "utf8"))) found.push(f);
    return found;
  })();
  check("M08 no Mapbox secret token (sk.…) anywhere in the repository: sources, scripts, docs, tests, README", leaks.length === 0, leaks.join(", "));
  const fileToken = { accessToken: TOKEN, style: "mapbox/dark-v11" };
  const pubFile = site("pages-file", { pages: "pixcar.fr", only: "dist", file: fileToken });
  const plainFile = site("plain-file", { only: "single", file: fileToken });
  const pubOff = site("pages-off", { pages: "pixcar.fr", only: "dist", file: fileToken, token: "" });
  check("M09 the published site (--pages) takes the token and the style of src/mapbox.json, any other build ignores that file", (metaOf(pubFile) || {}).token === TOKEN && (metaOf(pubFile) || {}).style === "mapbox/dark-v11" && (metaOf(plainFile) || {}).token === "", JSON.stringify([metaOf(pubFile), metaOf(plainFile)]));
  check("M10 PIXCAR_MAPBOX_TOKEN empty switches Mapbox off even for the published site", (metaOf(pubOff) || {}).token === "", JSON.stringify(metaOf(pubOff)));
  check("M11 no Mapbox without the privacy text that tells visitors: the build refuses when src/legal.json is incomplete", (() => {
    const r = attempt("bare", { token: TOKEN, legal: { ...LEGAL, editorLine: "", contact: "", repairRetentionMonths: "", updated: "" } });
    return r.status !== 0 && /Mapbox/.test(r.stderr);
  })());
  const pubPolicy = policyOf(pubFile), pubPolicyOff = policyOf(pubOff);
  check("M12 Mapbox adds one thing to the content security policy: api.mapbox.com in connect-src, for the completion of the cards (tests/mapbox-fiches.js) — the tiles are images, img-src already allows https: — and the policy stays narrow", pubPolicy.replace(" https://api.mapbox.com", "") === pubPolicyOff && /connect-src [^;]*https:\/\/api\.mapbox\.com/.test(pubPolicy) && !/mapbox/.test(pubPolicyOff) && /img-src [^;]*https:/.test(pubPolicy) && !/unsafe-eval/.test(pubPolicy), pubPolicy);

  // ============ navigateur ============
  const plain = await serve(none);
  const mapped = await serve(withToken);
  const browser = await launch();
  const pubSrv = await serveDir(pubFile);
  try {
    // ---- sans jeton : rien n'est demandé à Mapbox
    {
      const { page, ctx, logs } = await viewOf(browser, plain, { mock: MOCK({ mapbox: {} }) }); // le faux Mapbox est branché : s'il est appelé, on le saura
      await tilesIn(page);
      const c = ctx.__counters;
      check("M20 no token: the map keeps the IGN background, and Mapbox is never asked (not even a preconnect)", c.mapbox.length === 0 && c.tiles > 0 && !logs.requests.some((u) => /mapbox/.test(u)), JSON.stringify({ mapbox: c.mapbox.length, ign: c.tiles }));
      check("M21 …with the IGN credit on the map, and no Mapbox credit", /Plan IGN/.test(await attributionText(page)) && !/Mapbox/.test(await attributionText(page)), await attributionText(page));
      await ctx.close();
    }

    // ---- avec jeton : tuiles Mapbox de 512 px
    {
      const { page, ctx, logs } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: {} }) });
      const ok = await tilesIn(page);
      const c = ctx.__counters;
      const urls = c.mapbox.slice();
      const parsed = urls.map((u) => MB_PATH.exec(u));
      check("M22 with a token: the map shows tiles from Mapbox", ok && urls.length > 0, JSON.stringify({ ok, n: urls.length }));
      check("M23 every Mapbox request is a 512 px tile of the chosen style, with the token as access_token and nothing else in the address", parsed.every(Boolean) && parsed.every((m) => decodeURIComponent(m[5]) === TOKEN), JSON.stringify(urls.slice(0, 3)));
      check("M24b the number of tile requests for a desktop view stays small (512 px tiles: 4 to 16 for 1440×900 ; 256 px tiles would ask four times more)", urls.length >= 4 && urls.length <= 16, String(urls.length));
      check("M24 the IGN and CARTO backgrounds are not requested while Mapbox answers", c.tiles === 0 && !logs.requests.some((u) => /cartocdn|geopf\.fr\/wmts/.test(u)), JSON.stringify({ ign: c.tiles }));
      const geo = await page.evaluate(() => {
        const t = document.querySelector(".leaflet-tile-loaded"), m = (window.__maps || [])[0];
        return { w: t ? Math.round(parseFloat(getComputedStyle(t).width)) : 0, minZoom: m ? m.getMinZoom() : -9, zoom: m ? m.getZoom() : -9, markers: (() => { let n = 0; m && m.eachLayer((l) => { if (l.jg) n++; }); return n; })() };
      });
      check("M25 tiles are displayed at 512 px (zoom offset -1) and the map cannot be zoomed out to a level Mapbox has no tile for", geo.w === 512 && geo.minZoom >= 1, JSON.stringify(geo));
      check("M26 the tile level requested is the map zoom minus one (zoom offset -1, Leaflet rounds the zoom): never below 0", parsed.filter(Boolean).every((m) => +m[1] >= 0 && +m[1] <= 22) && parsed.filter(Boolean).some((m) => +m[1] === Math.round(geo.zoom) - 1), JSON.stringify({ zoom: geo.zoom, z: parsed.filter(Boolean).map((m) => m[1]).slice(0, 6) }));
      check("M27 the garages are still on the map, over Mapbox's background", geo.markers > 0, JSON.stringify(geo));
      const credit = await attribution(page);
      const text = await attributionText(page);
      check("M28 Mapbox's credit is on the map: © Mapbox and © OpenStreetMap as links, and the « improve this map » link (all open in a new tab, noopener)", /href="https:\/\/www\.mapbox\.com\/about\/maps\/"[^>]*>Mapbox</.test(credit) && /href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap</.test(credit) && /href="https:\/\/www\.mapbox\.com\/map-feedback\/"/.test(credit) && (credit.match(/target="_blank"/g) || []).length >= 3 && !/rel="(?!noopener)[^"]*"/.test(credit.replace(/rel="noopener( noreferrer)?"/g, "")), credit);
      check("M29 …next to the credit for the garages data (OpenStreetMap), and without the IGN credit", /Garages © les contributeurs d'OpenStreetMap/.test(text) && !/Plan IGN/.test(text), text);
      const viol = await axeOf(page);
      check("M30 the page with the Mapbox credit has no accessibility violation (axe)", viol.length === 0, JSON.stringify(viol));
      check("M31 no script error and no Mapbox request went anywhere but api.mapbox.com", logs.errors.length === 0 && c.other.every((u) => !/mapbox/.test(u)), JSON.stringify({ errors: logs.errors, other: c.other.filter((u) => /mapbox/.test(u)) }));
      await ctx.close();
    }

    // ---- écran à haute densité : tuiles @2x (même nombre de requêtes, image plus fine)
    {
      const { page, ctx } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: {} }), dpr: 2 });
      await tilesIn(page);
      const urls = ctx.__counters.mapbox;
      check("M32 on a high-density screen the tiles are the @2x ones, still 512 px", urls.length > 0 && urls.every((u) => /\/tiles\/512\/\d+\/\d+\/\d+@2x\?/.test(u)), JSON.stringify(urls.slice(0, 2)));
      await ctx.close();
    }

    // ---- système réglé en sombre : un seul thème (clair), même fond, même filtre adouci qu'en clair (pas d'inversion)
    {
      const { page, ctx } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: {} }), colorScheme: "dark" });
      await tilesIn(page);
      const filter = await page.evaluate(() => getComputedStyle(document.querySelector(".leaflet-tile-pane")).filter);
      check("M33 system set to dark: the same style is requested and the map is not inverted (one light theme)", ctx.__counters.mapbox.length > 0 && ctx.__counters.mapbox.every((u) => MB_PATH.test(u)) && !/invert/.test(filter), filter);
      await ctx.close();
    }

    // ---- style choisi au build
    {
      const srv = await serve(styled);
      const { page, ctx } = await viewOf(browser, srv, { mock: MOCK({ mapbox: {} }) });
      await tilesIn(page);
      check("M34 the style chosen at build time is the one requested", ctx.__counters.mapbox.length > 0 && ctx.__counters.mapbox.every((u) => /\/styles\/v1\/mapbox\/streets-v12\/tiles\/512\//.test(u)), JSON.stringify(ctx.__counters.mapbox.slice(0, 2)));
      await ctx.close();
      srv.close();
    }

    // ---- Mapbox refuse les tuiles (jeton refusé, quota, panne) : repli sur le Plan IGN
    {
      const { page, ctx, logs } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: { status: 401 } }) });
      const switched = await waitAttribution(page, "Plan IGN");
      await tilesIn(page);
      const c = ctx.__counters;
      const text = await attributionText(page);
      const srcs = await tileBases(page);
      check("M40 Mapbox refuses the tiles (401): after two refusals and no tile shown, the map switches to the IGN background", switched && c.mapbox.length >= 2 && c.tiles > 0, JSON.stringify({ switched, mapbox: c.mapbox.length, ign: c.tiles }));
      check("M41 …the credit follows (IGN, no Mapbox), only IGN tiles stay on the map, and the garages are still there", /Plan IGN/.test(text) && !/Mapbox/.test(text) && srcs.length > 0 && srcs.every((s) => /geopf\.fr\/wmts/.test(s)) && (await page.evaluate(() => { let n = 0; const m = (window.__maps || [])[0]; m && m.eachLayer((l) => { if (l.jg) n++; }); return n; })) > 0, JSON.stringify({ text, srcs: srcs.slice(0, 2) }));
      check("M42 the failed background is not asked again once abandoned (no endless requests to Mapbox)", await (async () => { const n = c.mapbox.length; await page.waitForTimeout(1200); return c.mapbox.length <= n + 2; })(), String(c.mapbox.length));
      check("M43 no script error on the way", logs.errors.length === 0, JSON.stringify(logs.errors));
      await ctx.close();
    }

    // ---- une seule tuile refusée : on garde Mapbox
    {
      const { page, ctx } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: { failFirst: 1 } }) });
      await tilesIn(page);
      await page.waitForTimeout(800);
      const text = await attributionText(page);
      check("M45 one refused tile does not make the map give up Mapbox (two refusals and not a single tile shown are needed)", ctx.__counters.tiles === 0 && /Mapbox/.test(text) && !/Plan IGN/.test(text), JSON.stringify({ ign: ctx.__counters.tiles, text }));
      await ctx.close();
    }

    // ---- Mapbox et l'IGN en panne : dernier recours, CARTO
    {
      const { page, ctx, logs } = await viewOf(browser, mapped, { mock: MOCK({ mapbox: { status: 429 }, ignStatus: 503 }) });
      const switched = await waitAttribution(page, "CARTO");
      await tilesIn(page);
      check("M44 Mapbox and the IGN both down: the map ends on CARTO, with its credit, and shows tiles", switched && logs.requests.some((u) => /basemaps\.cartocdn\.com/.test(u)) && /CARTO/.test(await attributionText(page)) && (await tileBases(page)).every((s) => /cartocdn/.test(s)), await attributionText(page));
      await ctx.close();
    }

    // ---- version publiée (GitHub Pages) : politique de sécurité dans la page, sans en-têtes
    {
      const watch = "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});";
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block" });
      await ctx.addInitScript("window.JG_TUNE={today:'2026-10-01',stagger:60,retry:60,osmTimeout:8000,sirenePace:5};" + watch);
      await installMocks(ctx, { log: () => {}, elements: buildElements(), mapbox: {} });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${pubSrv.url}/index.html`);
      await page.waitForLoadState("load");
      await search(page, { service: "vidange" });
      const ok = await tilesIn(page);
      const violations = await page.evaluate(() => window.__csp.slice());
      check("M50 the published site (policy in a <meta>, no header): Mapbox tiles are displayed and nothing is blocked", ok && ctx.__counters.mapbox.length > 0 && violations.length === 0 && errors.length === 0, JSON.stringify({ ok, violations, errors }));
      check("M51 the published site took the token and the style of src/mapbox.json (here: the dark style, set in the test copy)", ctx.__counters.mapbox.length > 0 && ctx.__counters.mapbox.every((u) => /\/mapbox\/dark-v11\/tiles\/512\//.test(u) && u.includes("access_token=" + TOKEN)), JSON.stringify(ctx.__counters.mapbox.slice(0, 2)));
      await ctx.close();
    }

    // ---- textes : confidentialité et sources
    {
      const texts = async (srv, mock) => {
        const { page, ctx } = await viewOf(browser, srv, { mock });
        await page.waitForSelector(".legal-foot:not([hidden]) [data-open-legal]", { timeout: 4000 }).catch(() => {});
        await page.click(".legal-foot [data-open-legal]");
        await page.waitForFunction(() => document.getElementById("legalDlg").open);
        const legal = norm(await page.evaluate(() => document.getElementById("legalDlg").innerText));
        await page.keyboard.press("Escape");
        const sources = norm(await page.evaluate(() => (document.querySelector("details.sources") || {}).textContent || ""));
        await ctx.close();
        return { legal, sources };
      };
      const without = await texts(plain, MOCK());
      const withMb = await texts(mapped, MOCK({ mapbox: {} }));
      check("M60 without Mapbox the privacy text does not mention it, and names the IGN and CARTO backgrounds that the page can use", !/Mapbox/.test(without.legal) && /fond de carte/.test(without.legal) && /basemaps\.cartocdn\.com/.test(without.legal) && /Plan IGN/.test(without.sources) && !/Mapbox/.test(without.sources), without.legal.slice(without.legal.indexOf("Services que votre navigateur"), 900));
      check("M61 with Mapbox the privacy text says who sees what: Mapbox, Inc., its host, the IP address and the area viewed, only once the map is shown, a possible transfer outside the EU", /Mapbox, Inc\./.test(withMb.legal) && /api\.mapbox\.com/.test(withMb.legal) && /adresse IP/.test(withMb.legal.slice(withMb.legal.indexOf("Mapbox, Inc."), withMb.legal.indexOf("Mapbox, Inc.") + 500)) && /zone que vous regardez/.test(withMb.legal) && /dès qu'elle s'affiche/.test(withMb.legal) && /hors de l'Union européenne/.test(withMb.legal.slice(withMb.legal.indexOf("Mapbox, Inc."), withMb.legal.indexOf("Mapbox, Inc.") + 1000)), withMb.legal.slice(withMb.legal.indexOf("Mapbox, Inc."), withMb.legal.indexOf("Mapbox, Inc.") + 1000));
      check("M62 …the IGN is then described as address search and fallback, CARTO stays the last resort", /recherche d'adresse, et fond de carte si celui de Mapbox ne répond pas/.test(withMb.legal) && /basemaps\.cartocdn\.com/.test(withMb.legal), withMb.legal.slice(withMb.legal.indexOf("l'IGN"), withMb.legal.indexOf("l'IGN") + 300));
      check("M63 the « Sources et méthode » text names the background that is shown, and the chain behind it", /Fond de carte : Mapbox \(© Mapbox, © les contributeurs d'OpenStreetMap\)/.test(withMb.sources) && /Plan IGN \(Géoplateforme\), puis CARTO/.test(withMb.sources) && !/Fond de carte : Plan IGN \(Géoplateforme\)\./.test(withMb.sources), withMb.sources.slice(withMb.sources.indexOf("Fond de carte"), withMb.sources.indexOf("Fond de carte") + 220));
    }
  } finally {
    await browser.close();
    plain.close();
    mapped.close();
    pubSrv.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[mapbox] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
