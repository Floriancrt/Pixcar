// Version GitHub Pages du site (scripts/build.mjs --pages) : GitHub Pages ne laisse pas choisir les en-têtes de réponse, donc la
// politique de sécurité du contenu voyage dans une balise <meta>. Ce qu'on vérifie : la construction produit ce qu'il faut, la
// politique est bien appliquée SANS en-tête (le serveur de test imite GitHub Pages : aucun en-tête personnalisé), et la page
// fonctionne en l'état (recherche, formulaire, aucune violation, aucune erreur). Une seconde construction, pour une API (c'est ce qui est
// publié à l'ouverture au public), vérifie que la page peut la contacter malgré cette politique et qu'elle affiche le texte du mode API.
//   node tests/pages.js
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { launch, open, search, ROOT } = require("./harness");
const { installMocks, buildElements } = require("./mocks");
const { serveDir } = require("./static-server");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 400));
};

const OUT = path.join(__dirname, ".out", "pages-site");
const SITE = path.join(OUT, "dist");
const OUT_API = path.join(__dirname, ".out", "pages-site-api");
const SITE_API = path.join(OUT_API, "dist");
const DOMAIN = "pixcar.fr";

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--only", "dist", "--out", OUT, "--pages", DOMAIN], { stdio: "ignore", env: { ...process.env, PIXCAR_API_BASE: "" } });

  // ---- ce que la construction produit
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const files = fs.readdirSync(SITE);
  check("G1 the domain is written in CNAME (GitHub Pages reads it there) and .nojekyll is there", fs.readFileSync(path.join(SITE, "CNAME"), "utf8") === DOMAIN + "\n" && files.includes(".nojekyll"), files.join());
  check("G2 no _headers file: GitHub Pages ignores it, and it would only be published as a stray file", !files.includes("_headers"), files.join());
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  const policy = meta ? meta[1] : "";
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const styleHash = crypto.createHash("sha256").update(style).digest("base64");
  check("G3 the policy is in a <meta>, before anything that loads (style, script, preload) and right after the charset", meta && html.indexOf(meta[0]) < html.indexOf("<style>") && html.indexOf(meta[0]) < html.indexOf("<script") && html.indexOf(meta[0]) < html.indexOf("<link") && /<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy"/.test(html), String(meta && meta.index));
  check("G4 it allows the inline stylesheet by its hash (the hash of what is actually in the page), no inline script, no eval", policy.includes(`'sha256-${styleHash}'`) && !/unsafe-eval/.test(policy) && !/script-src[^;]*unsafe-inline/.test(policy), policy.slice(0, 200));
  check("G5 frame-ancestors is left out (browsers ignore it in a <meta> and complain in the console)", policy && !/frame-ancestors/.test(policy));
  check("G6 same policy as the headers of the regular build, minus frame-ancestors", (() => {
    const regular = path.join(ROOT, "dist/_headers");
    if (!fs.existsSync(regular)) return true; // pas de construction ordinaire à comparer
    const csp = /Content-Security-Policy: (.+)/.exec(fs.readFileSync(regular, "utf8"));
    return csp && csp[1].split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ") === policy;
  })(), policy);
  check("G7 the referrer policy is set too (a header would normally do it)", /<meta name="referrer" content="strict-origin-when-cross-origin">/.test(html));
  check("G8 local mode: no API address in the page (this is the build without PIXCAR_API_BASE)", /<meta name="pixcar-api" content="">/.test(html));

  // ---- ce que fait le navigateur, sans aucun en-tête de politique
  const server = serveDir(SITE);
  const site = await server;
  const browser = await launch();
  try {
    const res = await fetch(site.url + "/index.html");
    check("G9 the test server sends no Content-Security-Policy header, like GitHub Pages", !res.headers.get("content-security-policy"), JSON.stringify([...res.headers]));
    const watch = "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});";
    const { page, ctx, logs } = await open(browser, site, "index.html", { width: 1440, height: 900, initScript: watch });
    await search(page);
    const cards = await page.$$eval("#list > li", (l) => l.length);
    check("G10 the site works under this policy: a search lists garages", cards > 0, String(cards));
    check("G11 the repair dialog is part of the page", await page.evaluate(() => !!document.getElementById("repairDlg")));
    const quiet = await page.evaluate(() => window.__csp.slice());
    check("G12 no policy violation during load and search", quiet.length === 0, JSON.stringify(quiet));
    check("G13 no console error or warning (a misplaced policy directive would show up here), no script error", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    // Mise à l'épreuve de la politique : la page tente ce qu'elle interdit. (Les événements de violation arrivent un instant plus tard.)
    const probe = await page.evaluate(async () => {
      const inline = document.createElement("script");
      inline.textContent = "window.__ranInline = true";
      document.head.appendChild(inline);
      const foreign = document.createElement("script");
      foreign.src = "https://evil.example/x.js";
      document.head.appendChild(foreign);
      await new Promise((r) => setTimeout(r, 150));
      return { ran: window.__ranInline === true, violations: window.__csp.slice() };
    });
    check("G14 the policy is enforced although it comes from a <meta>: an inline script does not run", probe.ran === false && probe.violations.some((v) => /^script-src/.test(v) && !/evil/.test(v)), JSON.stringify(probe));
    check("G15 … and a script from another host is refused before it is even fetched", probe.violations.some((v) => /^script-src/.test(v) && /evil\.example/.test(v)), JSON.stringify(probe));
    await ctx.close();

    // ---- la même version construite pour une API : l'adresse est fictive et interceptée par le navigateur (l'API réelle est testée par
    // tests/remote.js) ; ce qu'on vérifie ici, c'est la page publiée : son adresse d'API, sa politique, son texte du mode API.
    // Le build refuse si src/legal.json est incomplet : c'est voulu, on n'ouvre pas au public sans mentions.
    {
      const API = "https://api.exemple.test";
      fs.rmSync(OUT_API, { recursive: true, force: true });
      execFileSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--only", "dist", "--out", OUT_API, "--pages", DOMAIN], { stdio: "pipe", env: { ...process.env, PIXCAR_API_BASE: API } });
      const htmlApi = fs.readFileSync(path.join(SITE_API, "index.html"), "utf8");
      const policyApi = (/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(htmlApi) || [])[1] || "";
      const connect = ((/connect-src([^;]*)/.exec(policyApi) || [])[1] || "").trim().split(/\s+/);
      const localConnect = ((/connect-src([^;]*)/.exec(policy) || [])[1] || "").trim().split(/\s+/);
      check("H1 API mode: the page carries the API address and the policy lets it connect there, one more host than the local build and nothing else", htmlApi.includes(`<meta name="pixcar-api" content="${API}">`) && connect.includes(API) && connect.filter((h) => !localConnect.includes(h)).join() === API, connect.join(" "));

      const siteApi = await serveDir(SITE_API);
      const ctxApi = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR", timezoneId: "Europe/Paris", serviceWorkers: "block" });
      await ctxApi.addInitScript(
        "window.JG_TUNE={today:'2026-10-01',stagger:60,retry:60,osmTimeout:8000,sirenePace:5};window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});",
      );
      await installMocks(ctxApi, { log: () => {} });
      const calls = [];
      const cors = { "access-control-allow-origin": siteApi.url, "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", vary: "origin" };
      const json = { ...cors, "content-type": "application/json" };
      await ctxApi.route(`${API}/**`, (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        calls.push(`${req.method()} ${url.pathname}`);
        if (url.pathname === "/v1/overpass") return route.fulfill({ status: 200, headers: json, body: JSON.stringify({ elements: buildElements() }) });
        if (url.pathname === "/v1/repairs" && req.method() === "GET") return route.fulfill({ status: 200, headers: json, body: JSON.stringify({ v: 1, cell: { y: 0, x: 0 }, radius: 10, generatedAt: new Date().toISOString(), truncated: false, garages: [] }) });
        return route.fulfill({ status: 404, headers: json, body: "{}" });
      });
      const pageApi = await ctxApi.newPage();
      const problems = [];
      pageApi.on("pageerror", (e) => problems.push(String(e)));
      pageApi.on("console", (m) => {
        const u = (m.location() && m.location().url) || "";
        if (["error", "warning"].includes(m.type()) && !/Service Worker registration blocked/.test(m.text()) && !/apple-touch-icon\.png$|favicon\.ico$|wikimedia\.org/.test(u)) problems.push(`[${m.type()}] ${m.text()}`);
      });
      await pageApi.goto(`${siteApi.url}/index.html`);
      await pageApi.waitForLoadState("load");
      await search(pageApi);
      const cardsApi = await pageApi.$$eval("#list > li", (l) => l.length);
      const violations = await pageApi.evaluate(() => window.__csp.slice());
      check("H2 API mode: a search goes through the API relay, lists garages, and the policy blocks nothing", calls.some((c) => c === "GET /v1/overpass") && cardsApi > 0 && violations.length === 0, JSON.stringify({ calls, cardsApi, violations }));
      check("H3 … with no console error or warning and no script error", problems.length === 0, JSON.stringify(problems));

      await pageApi.waitForSelector(".legal-foot:not([hidden]) [data-open-legal]");
      await pageApi.click(".legal-foot [data-open-legal]");
      await pageApi.waitForFunction(() => document.getElementById("legalDlg").open);
      const legalText = await pageApi.evaluate(() => document.getElementById("legalDlg").innerText.replace(/\s+/g, " "));
      check("H4 the page is in API mode and its legal window tells what an API implies: the API hosting, what is recorded, how long (24 months)", (await pageApi.evaluate(() => document.body.dataset.store)) === "remote" && /API et base de données/.test(legalText) && /Ce que Pixcar enregistre/.test(legalText) && /24 mois après leur dépôt/.test(legalText) && !/rien n'est envoyé à Pixcar/.test(legalText), legalText.slice(0, 300));
      await pageApi.keyboard.press("Escape");
      await pageApi.click("#addRepairBtn");
      await pageApi.waitForSelector("#repairDlg[open]");
      check("H5 the declaration form shows the link to the privacy window (it collects data in this mode)", await pageApi.isVisible("#repairDlg [data-open-legal]"));
      await ctxApi.close();
      siteApi.close();
    }
  } catch (e) {
    check("pages section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    site.close();
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.rmSync(OUT_API, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[pages ${DOMAIN}] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
