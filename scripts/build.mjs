#!/usr/bin/env node
// Build de la page Pixcar.
//
//   node scripts/build.mjs          production : JS/CSS minifiés
//   node scripts/build.mjs --dev    lisible : rien n'est minifié
//   node scripts/build.mjs --check  reconstruit à part et vérifie que index.html et dist/ du dépôt sont à jour (sort en erreur sinon)
//   options : --only single|dist · --src <dossier des sources> · --out <dossier de sortie>   (utilisées par les tests de mutation)
//             --pages <domaine>  sortie dist/ pour GitHub Pages (ex. pixcar.fr) : pas de _headers (GitHub Pages les ignore), la politique
//                                de sécurité du contenu passe par une balise <meta> dans la page, + CNAME et .nojekyll
//
// Variable d'environnement : PIXCAR_API_BASE = URL de l'API des réparations (vide : stockage dans le navigateur).
//                            PIXCAR_ALLOW_NO_LEGAL=1 : construire avec l'API même si src/legal.json est incomplet (essai seulement, voir legalParts).
//
// Deux sorties à partir des mêmes sources :
//   index.html   page tout-en-un (CSS, JS, police et icônes en ligne) : s'ouvre depuis le disque, se déploie n'importe où ;
//   dist/        site publiable : fichiers séparés à nom haché (cache « immutable »), police locale, Leaflet local,
//                service worker (coque hors ligne), en-têtes de cache et de sécurité (_headers : Netlify, Cloudflare Pages),
//                robots.txt. L'adresse de l'API (PIXCAR_API_BASE) y est aussi dans la politique de sécurité du contenu.
import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");
const SRC = resolve(arg("src") || join(ROOT, "src"));
const OUT = check ? await mkdtemp(join(tmpdir(), "pixcar-build-")) : resolve(arg("out") || ROOT);
const DIST = join(OUT, "dist");
const only = arg("only"); // « single » ou « dist » : une seule sortie
const pages = arg("pages"); // domaine servi par GitHub Pages : voir l'en-tête de ce fichier
if (pages !== undefined && !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(pages)) throw new Error(`--pages attend un nom de domaine (ex. pixcar.fr), reçu « ${pages} »`);
const { OTHER_SERVICE, SERVICES } = await import(pathToFileURL(join(SRC, "js/shared/services.js")).href);
const dev = process.argv.includes("--dev");
const apiBase = (process.env.PIXCAR_API_BASE || "").replace(/\/+$/, "");
const read = (...p) => readFile(join(...p), "utf8");
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

// Leaflet est chargé à la demande (premier affichage de la carte). Page tout-en-un : CDN. dist : copie locale puis CDN.
const LEAFLET_CDN = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";

// ------------------------------------------------------------------------------------------------ JS
async function buildJs(extraDefine = {}) {
  const r = await build({
    entryPoints: [join(SRC, "js/main.js")],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: !dev,
    legalComments: "none",
    write: false,
    loader: { ".txt": "text" },
    define: { __LEAFLET_URLS__: JSON.stringify([LEAFLET_CDN]), __SW_URL__: JSON.stringify(""), ...extraDefine },
    logLevel: "warning",
  });
  return r.outputFiles[0].text;
}

// ------------------------------------------------------------------------------------------------ CSS
// Les jetons du thème sombre vivent dans un seul fichier, inséré aux deux endroits où le CSS les utilise
// (préférence système, et attribut data-theme="dark").
async function appCss() {
  const css = await read(SRC, "css/app.css");
  const tokens = (await read(SRC, "css/tokens.dark.css")).trim().split("\n");
  const indent = (n) => tokens.map((l) => (l.trim() ? " ".repeat(n) + l : l)).join("\n");
  const marks = ["    /*DARK_TOKENS*/", "  /*DARK_TOKENS*/"];
  let out = css;
  for (const [i, m] of marks.entries()) {
    const parts = out.split(m);
    if (parts.length !== 2) throw new Error(`marqueur ${m.trim()} : ${parts.length - 1} occurrence(s), 1 attendue`);
    out = parts[0] + indent(i === 0 ? 4 : 2).trimStart() + parts[1];
  }
  return out;
}
async function buildCss(fontCss) {
  const css = fontCss + (await read(SRC, "css/vendor/leaflet.css")) + "\n" + (await appCss());
  if (dev) return css;
  return (await transform(css, { loader: "css", minify: true })).code;
}

// ------------------------------------------------------------------------------------------------ polices
// Plus Jakarta Sans (SIL OFL), variable 200–800. « latin » couvre le français (Latin-1 et œ), « latin-ext » le reste.
const FONTS = [
  { file: "pjs-latin.woff2", range: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  { file: "pjs-latin-ext.woff2", range: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
];
const fontFace = (url, range) => `@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:200 800;font-display:swap;src:url(${url}) format('woff2');unicode-range:${range}}\n`;

// ------------------------------------------------------------------------------------------------ HTML
const oneLine = (s) => s.trim().split("\n").map((l) => l.trim()).join(" ");
// Connexions ouvertes dès le chargement : le service d'adresses (utilisé dès la première recherche) et l'API.
const GEOCODER = "https://data.geopf.fr";
const apiOrigin = (() => {
  try {
    return apiBase ? new URL(apiBase).origin : "";
  } catch {
    throw new Error(`PIXCAR_API_BASE n'est pas une adresse valide : ${apiBase}`);
  }
})();
const preconnect = () => [GEOCODER, apiOrigin].filter(Boolean).map((o) => `<link rel="preconnect" href="${o}" crossorigin>`).join("\n");
// Listes de prestations écrites dans le HTML, pour que la liste déroulante soit remplie et son aide visible avant l'exécution du
// script (la page les reconstruit à l'identique ; un test compare les deux). Même échappement que la page.
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function optionsHtml(list, extra = "") {
  const groups = [];
  for (const s of list) {
    let g = groups.find((x) => x.name === s.g);
    if (!g) groups.push((g = { name: s.g, items: [] }));
    g.items.push(s);
  }
  return groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}</optgroup>`).join("") + extra;
}
// Mentions légales et politique de confidentialité : src/legal.json (ce qui dépend de l'éditeur) + src/partials/legal.html (le texte).
// Complet : la fenêtre « Confidentialité et mentions légales » et ses liens sont dans la page. Incomplet : ni fenêtre ni liens, SAUF si
// l'API est branchée (PIXCAR_API_BASE) : le build échoue alors, on n'ouvre pas au public des déclarations sans informer les visiteurs.
// PIXCAR_ALLOW_NO_LEGAL=1 lève cette garde pour un essai.
const LEGAL_FIELDS = ["editorLine", "contact", "hostPages", "hostApi", "repairRetentionMonths", "updated"];
async function legalParts() {
  const config = JSON.parse(await read(SRC, "legal.json"));
  const filled = (k) => String(config[k] ?? "").trim() !== "";
  const problems = LEGAL_FIELDS.filter((k) => !filled(k)).map((k) => `${k} : à renseigner`);
  if (filled("contact") && !/^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(String(config.contact).trim())) problems.push("contact : une adresse électronique est attendue");
  if (filled("repairRetentionMonths") && !(Number.isInteger(config.repairRetentionMonths) && config.repairRetentionMonths > 0)) problems.push("repairRetentionMonths : un nombre entier de mois est attendu");
  if (problems.length) {
    if (apiBase && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")
      throw new Error(`mentions légales incomplètes dans src/legal.json (${problems.join(" ; ")}) : l'API est branchée (PIXCAR_API_BASE), des visiteurs y déposeraient des données sans en être informés. Complétez ce fichier (docs/exploitation.md, section 6) ; PIXCAR_ALLOW_NO_LEGAL=1 le permet pour un simple essai.`);
    return { dialog: "", linkPanel: "", linkSources: "", linkDialog: "" };
  }
  const dialog = (await read(SRC, "partials/legal.html")).replace(/\{\{legal\.([A-Za-z]+)\}\}/g, (m, k) => {
    if (!LEGAL_FIELDS.includes(k)) throw new Error(`partials/legal.html : {{legal.${k}}} n'existe pas dans src/legal.json`);
    return esc(String(config[k]).trim());
  });
  return {
    dialog,
    // Masqué dans le HTML, montré par modules/legal.js une fois la page construite : sous le panneau des résultats, que le script remplit, il
    // descendrait de plusieurs lignes au démarrage (décalage de mise en page).
    linkPanel: '<p class="legal-foot" hidden><button type="button" class="link-btn" data-open-legal>Confidentialité et mentions légales</button></p>',
    linkSources: '<p><b>Confidentialité et mentions légales.</b> <button type="button" class="link-btn" data-open-legal>Lire la politique de confidentialité</button></p>',
    linkDialog: '<p class="dlg-note" data-store-only="remote"><button type="button" class="link-btn" data-open-legal>Comment Pixcar traite vos données</button></p>',
  };
}
async function pageParts() {
  const road = oneLine(await read(SRC, "partials/ld-road.svg"));
  const car = oneLine(await read(SRC, "partials/ld-car.svg"));
  let body = await read(SRC, "partials/body.html");
  let dialog = await read(SRC, "partials/dialog.html");
  const fill = (text, pairs) => {
    for (const [mark, value, times = 1] of pairs) {
      if (text.split(mark).length !== times + 1) throw new Error(`${mark} : ${times} occurrence(s) attendue(s)`);
      text = text.split(mark).join(value);
    }
    return text;
  };
  const legal = await legalParts();
  body = fill(body, [
    ["<!--LD_ROAD-->", road],
    ["<!--LD_CAR-->", car],
    ["<!--SERVICE_OPTIONS-->", optionsHtml(SERVICES), 2],
    ["<!--SERVICE_HINT-->", esc(SERVICES[0].hint)], // la première prestation est celle que la page sélectionne à la première visite
    ["<!--LEGAL_LINK_PANEL-->", legal.linkPanel],
    ["<!--LEGAL_LINK_SOURCES-->", legal.linkSources],
  ]);
  dialog = fill(dialog, [
    ["<!--REPAIR_OPTIONS-->", optionsHtml(SERVICES.filter((s) => s.kind !== "ct"), `<optgroup label="Autre"><option value="${OTHER_SERVICE}">Autre réparation (précisez en commentaire)</option></optgroup>`)],
    ["<!--LEGAL_LINK_DIALOG-->", legal.linkDialog],
  ]);
  return { body, sprite: await read(SRC, "partials/sprite.html"), dialog, legal: legal.dialog };
}
function squeeze(html) {
  if (dev) return html;
  // commentaires HTML et indentation retirés ; les retours à la ligne restent (ils valent une espace entre éléments en ligne)
  return html.replace(/<!--(?!\[)[\s\S]*?-->/g, "").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n");
}
async function render(parts, { headAssets, scripts }) {
  const tpl = await read(SRC, "index.html");
  const fill = { API_BASE: apiBase, PRECONNECT: preconnect(), HEAD_ASSETS: headAssets, SPRITE: parts.sprite, BODY: parts.body, DIALOG: parts.dialog, LEGAL: parts.legal, SCRIPTS: scripts };
  return squeeze(tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m)));
}

// ------------------------------------------------------------------------------------------------ page tout-en-un
async function buildSingle(parts) {
  const latin = await readFile(join(SRC, "assets/fonts/pjs-latin.woff2"));
  const fontCss = fontFace(`data:font/woff2;base64,${latin.toString("base64")}`, FONTS[0].range);
  const css = await buildCss(fontCss);
  const js = await buildJs();
  const svg = (await read(SRC, "assets/favicon.svg")).trim();
  const png = await readFile(join(SRC, "assets/apple-touch-icon.png"));
  const headAssets = [
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}">`,
    `<link rel="apple-touch-icon" href="data:image/png;base64,${png.toString("base64")}">`,
    `<style>${css}</style>`,
  ].join("\n");
  const html = await render(parts, { headAssets, scripts: `<script>\n${js}</script>` });
  await writeFile(join(OUT, "index.html"), html);
  return html.length;
}

// ------------------------------------------------------------------------------------------------ en-têtes (dist/_headers)
// Même format pour Netlify et Cloudflare Pages ; d'autres hébergeurs : reprendre les mêmes valeurs dans leur configuration.
// La page appelle ces services, et eux seuls : tout autre hôte est refusé par le navigateur (Content-Security-Policy).
const CONNECT = ["https://data.geopf.fr", "https://overpass-api.de", "https://overpass.openstreetmap.fr", "https://recherche-entreprises.api.gouv.fr", "https://data.economie.gouv.fr", "https://query.wikidata.org"];
export function contentSecurityPolicy(origin = apiOrigin, styleHash = "") {
  return [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com", // le CDN ne sert que de secours à la copie locale de Leaflet
    `style-src 'self'${styleHash ? ` 'sha256-${styleHash}'` : ""}`, // la feuille de style est dans la page : autorisée par son empreinte
    "style-src-attr 'unsafe-inline'", // quelques positions calculées (repères de l'échelle de prix, marqueurs)
    "img-src 'self' data: blob: https:", // tuiles de la carte, logos (Wikimedia Commons), icônes des sites d'enseignes
    "font-src 'self'",
    `connect-src ${["'self'", origin, ...CONNECT].filter(Boolean).join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
// GitHub Pages ne laisse pas choisir les en-têtes de réponse : la politique de sécurité du contenu et la politique de référent
// passent par des balises <meta>, placées tout en haut de <head>, avant ce qui charge quoi que ce soit. frame-ancestors n'y est pas
// pris en compte par les navigateurs : on la retire plutôt que de laisser un avertissement dans la console.
function withPolicyMeta(html, styleHash) {
  const csp = contentSecurityPolicy(apiOrigin, styleHash).split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ");
  const tags = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="strict-origin-when-cross-origin">\n`;
  const charset = '<meta charset="utf-8">\n';
  if (html.split(charset).length !== 2) throw new Error("balise <meta charset> introuvable ou en double : impossible de placer la politique de sécurité");
  return html.replace(charset, charset + tags);
}
function headersFile(styleHash) {
  const immutable = "public, max-age=31536000, immutable";
  return `# Généré par scripts/build.mjs. Netlify et Cloudflare Pages lisent ce fichier tel quel.
/*
  Content-Security-Policy: ${contentSecurityPolicy(apiOrigin, styleHash)}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000

# La page et le service worker : toujours revalidés (un 304 suffit), pour que chaque déploiement soit vu tout de suite.
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache

# Fichiers dont le nom contient l'empreinte de leur contenu : jamais modifiés, gardés un an.
/assets/*
  Cache-Control: ${immutable}

# Icônes : nom fixe, un jour.
/favicon.svg
  Cache-Control: public, max-age=86400
/apple-touch-icon.png
  Cache-Control: public, max-age=86400
`;
}

// ------------------------------------------------------------------------------------------------ dist
async function buildDist(parts) {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, "assets/fonts"), { recursive: true });
  const fontUrls = [];
  let fontCss = "";
  for (const f of FONTS) {
    const buf = await readFile(join(SRC, "assets/fonts", f.file));
    const name = f.file.replace(".woff2", `.${hash(buf)}.woff2`);
    await writeFile(join(DIST, "assets/fonts", name), buf);
    fontCss += fontFace(`assets/fonts/${name}`, f.range); // le CSS est dans la page : chemins depuis la racine du site
    fontUrls.push(`assets/fonts/${name}`);
  }
  const css = await buildCss(fontCss);

  // Leaflet : copie locale (chargée à la demande), le CDN ne sert plus que de secours.
  const leaflet = await readFile(join(ROOT, "node_modules/leaflet/dist/leaflet.js"));
  const leafletMin = dev ? leaflet.toString() : (await transform(leaflet.toString(), { minify: true, legalComments: "none" })).code;
  const leafletName = `leaflet.${hash(leafletMin)}.js`;
  await writeFile(join(DIST, "assets", leafletName), leafletMin);

  const js = await buildJs({ __LEAFLET_URLS__: JSON.stringify([`assets/${leafletName}`, LEAFLET_CDN]), __SW_URL__: JSON.stringify("sw.js") });
  const jsName = `app.${hash(js)}.js`;
  await writeFile(join(DIST, "assets", jsName), js);

  await copyFile(join(SRC, "assets/favicon.svg"), join(DIST, "favicon.svg"));
  await copyFile(join(SRC, "assets/apple-touch-icon.png"), join(DIST, "apple-touch-icon.png"));
  const headAssets = [
    `<link rel="icon" type="image/svg+xml" href="favicon.svg">`,
    `<link rel="apple-touch-icon" href="apple-touch-icon.png">`,
    `<link rel="preload" href="${fontUrls[0]}" as="font" type="font/woff2" crossorigin>`,
    // Feuille de style dans la page : un aller-retour de moins avant le premier affichage (la page revient du cache du service
    // worker ou d'un 304 aux visites suivantes : l'intégrer ne coûte rien). La politique de sécurité l'autorise par son empreinte.
    `<style>${css}</style>`,
  ].join("\n");
  let html = await render(parts, { headAssets, scripts: `<script src="assets/${jsName}" defer></script>` });
  const styleSource = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const styleHash = createHash("sha256").update(styleSource).digest("base64");
  if (pages) html = withPolicyMeta(html, styleHash); // avant le calcul de la version du service worker : elle dépend du contenu final
  await writeFile(join(DIST, "index.html"), html);

  // Coque hors ligne : la page, le script à empreinte et la police (Leaflet et la 2e police se chargent à la demande)
  const shell = ["./", `assets/${jsName}`, fontUrls[0], "favicon.svg", "apple-touch-icon.png"];
  const version = hash(Buffer.from([html, ...shell.slice(1)].join("\n") + (await read(SRC, "sw.js"))));
  const sw = (await read(SRC, "sw.js")).replace("__VERSION__", version).replace("__SHELL__", JSON.stringify(shell));
  await writeFile(join(DIST, "sw.js"), dev ? sw : (await transform(sw, { minify: true, legalComments: "none" })).code);
  if (pages) {
    await writeFile(join(DIST, "CNAME"), pages.toLowerCase() + "\n"); // GitHub Pages lit le domaine personnalisé ici
    await writeFile(join(DIST, ".nojekyll"), ""); // servir les fichiers tels quels, sans passer par Jekyll
  } else await writeFile(join(DIST, "_headers"), headersFile(styleHash));
  await writeFile(join(DIST, "robots.txt"), "User-agent: *\nAllow: /\n");
  return { html: html.length, js: js.length, css: css.length, version };
}

// ------------------------------------------------------------------------------------------------
const parts = await pageParts();
await mkdir(OUT, { recursive: true });
const single = only === "dist" ? null : await buildSingle(parts);
const dist = only === "single" ? null : await buildDist(parts);
const kb = (n) => (n / 1024).toFixed(1) + " Ko";

if (check) {
  // Les sorties sont déterministes (noms à empreinte, version du service worker dérivée du contenu) : toute différence avec ce
  // qui est dans le dépôt veut dire qu'une source a changé sans reconstruction.
  const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath ?? e.path, e.name))).sort();
  const problems = [];
  const same = async (a, b, label) => {
    const [fa, fb] = await Promise.all([files(a).catch(() => []), files(b).catch(() => [])]);
    for (const f of fa) if (!fb.includes(f)) problems.push(`${label}/${f} : absent du dépôt`);
    for (const f of fb) if (!fa.includes(f)) problems.push(`${label}/${f} : n'existe plus dans la construction`);
    for (const f of fa) if (fb.includes(f) && !(await readFile(join(a, f))).equals(await readFile(join(b, f)))) problems.push(`${label}/${f} : contenu différent`);
  };
  await same(DIST, join(ROOT, "dist"), "dist");
  if (!(await readFile(join(OUT, "index.html"))).equals(await readFile(join(ROOT, "index.html")).catch(() => Buffer.alloc(0)))) problems.push("index.html : contenu différent");
  await rm(OUT, { recursive: true, force: true });
  if (problems.length) {
    console.error("Sorties du dépôt périmées :\n  - " + problems.join("\n  - ") + "\nLancer npm run build et recommiter.");
    process.exit(1);
  }
  console.log("index.html et dist/ sont à jour.");
} else console.log(`${dev ? "dev" : "prod"} · ${single ? `index.html ${kb(single)}` : ""}${single && dist ? " · " : ""}${dist ? `dist : html ${kb(dist.html)}, js ${kb(dist.js)}, css ${kb(dist.css)}` : ""}`);
