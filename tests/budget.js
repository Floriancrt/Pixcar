// Budgets et règles de livraison du site publiable (dist/) : poids, chemin critique, noms à empreinte, en-têtes, coque hors ligne.
// Ne lance aucun navigateur : lit dist/ tel que le build l'a produit.  node tests/budget.js
// Un budget qui casse n'est pas une fatalité : si la hausse est voulue, la relever ICI, avec la raison, dans le même commit.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { ROOT } = require("./harness");
const { parseHeaders } = require("./static-server");

const DIST = path.join(ROOT, "dist");
const KB = 1024;
// gzip, en Ko (mesuré le 2 octobre 2026 : page 7,7 hors feuille de style · feuille de style 19,9 · js 46 · police 27 ; marge d'environ 10 %)
// Police : Epilogue (35 Ko, fichier Google non modifié) remplace Plus Jakarta Sans (27 Ko) le 5 octobre 2026 : +8 Ko sur le chemin critique
// et sur la page tout-en-un (mesuré : police 34,9 · page 30,2 · js 47,3 ; tout-en-un 114,9 contre 106,6) ; les budgets de la police, du
// chemin critique et de la page tout-en-un montent d'autant (6, 7 et 8 Ko), les autres ne bougent pas.
const BUDGET = { page: 30, html: 10, js: 52, css: 22, font: 36, critical: 115, sw: 3, single: 120, icon: 20 };

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 400));
};
const read = (f) => fs.readFileSync(path.join(DIST, f));
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const br = (buf) => zlib.brotliCompressSync(buf).length;
const kb = (n) => (n / KB).toFixed(1);

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/ introuvable : lancer npm run build");
  process.exit(2);
}
const html = read("index.html").toString("utf8");
// La fenêtre « Confidentialité et mentions légales » (présente quand src/legal.json est complet) pèse environ 2,5 Ko gzip dans la page :
// le budget la prévoit quand elle est là, sans se desserrer quand elle est absente.
const LEGAL_GZ = html.includes('id="legalDlg"') ? 3 : 0;
for (const k of ["page", "html", "critical", "single"]) BUDGET[k] += LEGAL_GZ;
const assets = fs.readdirSync(path.join(DIST, "assets"));
const find = (re) => assets.find((f) => re.test(f));
const jsFile = find(/^app\.[0-9a-f]{10}\.js$/), leafletFile = find(/^leaflet\.[0-9a-f]{10}\.js$/);
const style = (/<style>([\s\S]*?)<\/style>/.exec(html) || [])[1] || ""; // la feuille de style est dans la page (un aller-retour de moins)
const htmlOnly = html.replace(/<style>[\s\S]*?<\/style>/, "");
const fontFiles = fs.readdirSync(path.join(DIST, "assets/fonts"));
const latin = fontFiles.find((f) => /^epilogue-latin\.[0-9a-f]{10}\.woff2$/.test(f));

// ---- poids
check("B1 the page (with its stylesheet), its script and its font are all there", html && style && jsFile && latin);
const size = { page: gz(read("index.html")), html: gz(Buffer.from(htmlOnly)), css: gz(Buffer.from(style)), js: gz(read("assets/" + jsFile)), font: read("assets/fonts/" + latin).length, sw: gz(read("sw.js")) };
console.log(`  poids gzip : page ${kb(size.page)} (dont feuille de style ${kb(size.css)}) · js ${kb(size.js)} (brotli ${kb(br(read("assets/" + jsFile)))}) · police ${kb(size.font)} · sw ${kb(size.sw)} · Leaflet (à la demande) ${kb(gz(read("assets/" + leafletFile)))} Ko`);
check(`B2 HTML without its stylesheet ≤ ${BUDGET.html} Ko gzip, whole page ≤ ${BUDGET.page} Ko`, size.html <= BUDGET.html * KB && size.page <= BUDGET.page * KB, kb(size.html) + " / " + kb(size.page));
check(`B3 application JS ≤ ${BUDGET.js} Ko gzip`, size.js <= BUDGET.js * KB, kb(size.js));
check(`B4 stylesheet (in the page) ≤ ${BUDGET.css} Ko gzip`, size.css <= BUDGET.css * KB, kb(size.css));
check(`B5 main font ≤ ${BUDGET.font} Ko`, size.font <= BUDGET.font * KB, kb(size.font));
const critical = size.page + size.js + size.font;
check(`B6 everything a first visit needs before it is usable ≤ ${BUDGET.critical} Ko (now ${kb(critical)})`, critical <= BUDGET.critical * KB, kb(critical));
check(`B7 service worker ≤ ${BUDGET.sw} Ko`, size.sw <= BUDGET.sw * KB, kb(size.sw));
check(`B8 icons stay small`, read("apple-touch-icon.png").length <= BUDGET.icon * KB && read("favicon.svg").length <= 5 * KB);
const single = gz(fs.readFileSync(path.join(ROOT, "index.html")));
check(`B9 the all-in-one page ≤ ${BUDGET.single} Ko gzip (now ${kb(single)})`, single <= BUDGET.single * KB, kb(single));

// ---- chemin critique
const hosts = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).origin);
const nonPreconnect = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g)].filter((m) => !/rel="preconnect"/.test(m[0])).map((m) => m[1]);
check("B10 the page loads nothing from another host to render (only preconnect hints)", nonPreconnect.length === 0, JSON.stringify(nonPreconnect));
check("B11 no inline script (the content security policy forbids them)", !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
check("B12 one inline stylesheet, no external one; exactly one script, local and deferred", (html.match(/<style>/g) || []).length === 1 && !/rel="stylesheet"/.test(html) && (html.match(/<script\b/g) || []).length === 1 && new RegExp(`<script src="assets/${jsFile}" defer></script>`).test(html));
check("B13 the font used first is preloaded (same file as the @font-face), as a CORS font", new RegExp(`<link rel="preload" href="assets/fonts/${latin}" as="font" type="font/woff2" crossorigin>`).test(html) && style.includes(`assets/fonts/${latin}`));
check("B14 text stays visible while the font loads (font-display: swap)", /font-display:swap/.test(style.replace(/\s/g, "")));
check("B15 connections warmed in advance: the address service (and the API when configured)", /<link rel="preconnect" href="https:\/\/data\.geopf\.fr" crossorigin>/.test(html));
check("B16 the viewport and the language are declared", /<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">/.test(html) && /<html lang="fr">/.test(html));

// ---- noms à empreinte
const stamp = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(DIST, "assets", f))).digest("hex").slice(0, 10);
const hashed = assets.filter((f) => f !== "fonts");
check("B17 every file under assets/ carries the hash of its own content in its name (so it can be cached forever)", hashed.every((f) => f.includes(stamp(f))) && fontFiles.every((f) => f.includes(crypto.createHash("sha256").update(fs.readFileSync(path.join(DIST, "assets/fonts", f))).digest("hex").slice(0, 10))), JSON.stringify(hashed.filter((f) => !f.includes(stamp(f)))));
check("B18 no source map, no leftover template marker or placeholder in what is shipped", !fs.readdirSync(DIST, { recursive: true }).some((f) => /\.map$/.test(f)) && !/\{\{[A-Z_]+\}\}|DARK_TOKENS|__VERSION__|__SHELL__|<!--[A-Z_]+-->/.test(html + read("sw.js").toString() + read("assets/" + jsFile).toString()));

// ---- en-têtes
const rules = parseHeaders(path.join(DIST, "_headers"));
const headersFor = (p) => Object.assign({}, ...rules.filter((r) => r.re.test(p)).map((r) => r.headers));
const csp = headersFor("/")["content-security-policy"] || "";
check("B19 hashed assets: cached a year, immutable", /max-age=31536000/.test(headersFor("/assets/app.x.js")["cache-control"]) && /immutable/.test(headersFor("/assets/app.x.js")["cache-control"]));
check("B20 the page and the service worker are revalidated at every visit", ["/", "/index.html", "/sw.js"].every((p) => /no-cache/.test(headersFor(p)["cache-control"] || "")));
const styleHash = crypto.createHash("sha256").update(style).digest("base64");
check("B21a the policy allows the inline stylesheet by its hash, and that hash is the current one (a stale hash would unstyle the whole page)", csp.includes(`style-src 'self' 'sha256-${styleHash}'`), csp.match(/style-src[^;]*/)[0]);
check("B21 content security policy: no inline script, no eval, no framing, no <base>, no plug-ins", /script-src 'self'[^;]*/.test(csp) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /object-src 'none'/.test(csp));
check("B22 content security policy lists the hosts the page really calls, and nothing else for connections", ["data.geopf.fr", "overpass-api.de", "recherche-entreprises.api.gouv.fr", "data.economie.gouv.fr", "query.wikidata.org"].every((h) => csp.includes(h)) && !/connect-src[^;]*\*/.test(csp));
check("B23 nosniff, referrer and permissions policies are set", headersFor("/")["x-content-type-options"] === "nosniff" && !!headersFor("/")["referrer-policy"] && /geolocation=\(self\)/.test(headersFor("/")["permissions-policy"] || ""));

// ---- coque hors ligne
const swText = read("sw.js").toString();
const shell = JSON.parse(/SHELL=(\[.*?\])/.exec(swText)[1]);
check("B24 every file of the offline shell exists", shell.every((f) => f === "./" || fs.existsSync(path.join(DIST, f))), JSON.stringify(shell));
check("B25 the shell holds exactly what the page needs to start: the page, script, font, icons", shell.length === 5 && [`assets/${jsFile}`, `assets/fonts/${latin}`, "favicon.svg", "apple-touch-icon.png"].every((f) => shell.includes(f)) && !shell.some((f) => /leaflet/.test(f)));
check("B26 the worker's version changes whenever the shell changes (it is derived from the shell's content)", /VERSION="[0-9a-f]{10}"/.test(swText));
check("B27 robots.txt exists", /User-agent/.test(read("robots.txt").toString()));

// ---- à jour : les sorties du dépôt sont celles que les sources produisent (le build est déterministe)
const rebuilt = require("child_process").spawnSync(process.execPath, ["scripts/build.mjs", "--check"], { cwd: ROOT, encoding: "utf8" });
check("B28 index.html and dist/ are what the sources build (nothing changed without rebuilding)", rebuilt.status === 0, rebuilt.stderr || rebuilt.stdout);

const bad = results.filter((r) => !r.ok);
console.log(`\n[budget] ${results.length - bad.length}/${results.length} checks passed`);
bad.forEach((b) => console.log("  ✗", b.name));
process.exit(bad.length ? 1 : 0);
