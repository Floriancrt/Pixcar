// Version GitHub Pages du site (scripts/build.mjs --pages) : GitHub Pages ne laisse pas choisir les en-têtes de réponse, donc la
// politique de sécurité du contenu voyage dans une balise <meta>. Ce qu'on vérifie : la construction produit ce qu'il faut, la
// politique est bien appliquée SANS en-tête (le serveur de test imite GitHub Pages : aucun en-tête personnalisé), et la page
// fonctionne en l'état (recherche, formulaire, aucune violation, aucune erreur).
//   node tests/pages.js
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { launch, open, search, ROOT } = require("./harness");
const { serveDir } = require("./static-server");

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 400));
};

const OUT = path.join(__dirname, ".out", "pages-site");
const SITE = path.join(OUT, "dist");
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
  } catch (e) {
    check("pages section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    site.close();
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[pages ${DOMAIN}] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
