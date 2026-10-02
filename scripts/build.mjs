#!/usr/bin/env node
// Build de la page Pixcar.
//
//   node scripts/build.mjs          production : JS/CSS minifiés
//   node scripts/build.mjs --dev    lisible : rien n'est minifié
//
// Variable d'environnement : PIXCAR_API_BASE = URL de l'API des réparations (vide : stockage dans le navigateur).
//
// Deux sorties à partir des mêmes sources :
//   index.html   page tout-en-un (CSS, JS, police et icônes en ligne) : s'ouvre depuis le disque, se déploie n'importe où ;
//   dist/        site publiable : fichiers séparés à nom haché (cache « immutable »), police locale, Leaflet local,
//                service worker (coque hors ligne), en-têtes de cache et de sécurité (_headers).
import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, copyFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
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
    define: { __LEAFLET_URLS__: JSON.stringify([LEAFLET_CDN]), ...extraDefine },
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
async function pageParts() {
  const road = oneLine(await read(SRC, "partials/ld-road.svg"));
  const car = oneLine(await read(SRC, "partials/ld-car.svg"));
  let body = await read(SRC, "partials/body.html");
  for (const [mark, svg] of [["<!--LD_ROAD-->", road], ["<!--LD_CAR-->", car]]) {
    if (body.split(mark).length !== 2) throw new Error(`${mark} : 1 occurrence attendue`);
    body = body.replace(mark, svg);
  }
  return { body, sprite: await read(SRC, "partials/sprite.html"), dialog: await read(SRC, "partials/dialog.html") };
}
function squeeze(html) {
  if (dev) return html;
  // commentaires HTML et indentation retirés ; les retours à la ligne restent (ils valent une espace entre éléments en ligne)
  return html.replace(/<!--(?!\[)[\s\S]*?-->/g, "").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n");
}
async function render(parts, { headAssets, scripts }) {
  const tpl = await read(SRC, "index.html");
  const fill = { API_BASE: apiBase, HEAD_ASSETS: headAssets, SPRITE: parts.sprite, BODY: parts.body, DIALOG: parts.dialog, SCRIPTS: scripts };
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
  await writeFile(join(ROOT, "index.html"), html);
  return html.length;
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
    fontCss += fontFace(`fonts/${name}`, f.range);
    fontUrls.push(`assets/fonts/${name}`);
  }
  const css = await buildCss(fontCss);
  const cssName = `app.${hash(css)}.css`;
  await writeFile(join(DIST, "assets", cssName), css);

  // Leaflet : copie locale (chargée à la demande), le CDN ne sert plus que de secours.
  const leaflet = await readFile(join(ROOT, "node_modules/leaflet/dist/leaflet.js"));
  const leafletMin = dev ? leaflet.toString() : (await transform(leaflet.toString(), { minify: true, legalComments: "none" })).code;
  const leafletName = `leaflet.${hash(leafletMin)}.js`;
  await writeFile(join(DIST, "assets", leafletName), leafletMin);

  const js = await buildJs({ __LEAFLET_URLS__: JSON.stringify([`assets/${leafletName}`, LEAFLET_CDN]) });
  const jsName = `app.${hash(js)}.js`;
  await writeFile(join(DIST, "assets", jsName), js);

  await copyFile(join(SRC, "assets/favicon.svg"), join(DIST, "favicon.svg"));
  await copyFile(join(SRC, "assets/apple-touch-icon.png"), join(DIST, "apple-touch-icon.png"));
  const headAssets = [
    `<link rel="icon" type="image/svg+xml" href="favicon.svg">`,
    `<link rel="apple-touch-icon" href="apple-touch-icon.png">`,
    `<link rel="preload" href="${fontUrls[0]}" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="assets/${cssName}">`,
  ].join("\n");
  const html = await render(parts, { headAssets, scripts: `<script src="assets/${jsName}" defer></script>` });
  await writeFile(join(DIST, "index.html"), html);
  return { html: html.length, js: js.length, css: css.length };
}

// ------------------------------------------------------------------------------------------------
const parts = await pageParts();
const single = await buildSingle(parts);
const dist = await buildDist(parts);
const kb = (n) => (n / 1024).toFixed(1) + " Ko";
console.log(`${dev ? "dev" : "prod"} · index.html ${kb(single)} · dist : html ${kb(dist.html)}, js ${kb(dist.js)}, css ${kb(dist.css)}`);
