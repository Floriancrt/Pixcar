#!/usr/bin/env node
// Lance les suites de tests de la page (Playwright + Chromium) l'une après l'autre et résume le résultat.
//   npm test                  toutes les suites, sur index.html (page tout-en-un)
//   npm test -- dist          les mêmes sur dist/ (site publiable), servi avec ses en-têtes (CSP, MIME, compression)
//   npm test -- ux veh        seulement ces suites
// Prérequis : npm install, npm run build, un Chromium pour Playwright (npx playwright install chromium).
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const target = args.includes("dist") ? "dist" : "single";
const only = args.filter((a) => a !== "dist");
const FILE = "index.html"; // avec « dist », le serveur de test sert dist/ comme racine (PIXCAR_ROOT)

const SUITES = [
  { name: "func", cmd: ["node", "tests/func.js", FILE, "new"] },
  { name: "logos", cmd: ["node", "tests/logos.js"], env: { FILE } },
  { name: "brand", cmd: ["node", "tests/brand.js"], env: { FILE } },
  { name: "addr", cmd: ["node", "tests/addr.js"], env: { FILE } },
  { name: "city", cmd: ["node", "tests/city.js"], env: { FILE } },
  { name: "ux", cmd: ["node", "tests/ux.js", FILE] },
  { name: "load", cmd: ["node", "tests/load.js", FILE] },
  { name: "veh", cmd: ["node", "tests/veh.js", FILE] },
  { name: "remote", cmd: ["node", "tests/remote.js", FILE] },
  { name: "legal", cmd: ["node", "tests/legal.js"] }, // construit lui-même la page avec une copie des sources dont src/legal.json est complet
  { name: "consent", cmd: ["node", "tests/consent.js"] }, // mesure d'audience : construit lui-même ses pages (avec et sans identifiant Google)
  { name: "garages", cmd: ["node", "tests/garages.js", FILE] }, // table de garages (Overture) dans la page : tuiles simulées par la suite
  { name: "mapbox", cmd: ["node", "tests/mapbox.js"] }, // fond de carte Mapbox : construit lui-même ses pages (avec et sans jeton)
  { name: "mbxfiches", cmd: ["node", "tests/mapbox-fiches.js"] }, // fiches complétées par Mapbox (téléphone, horaires, site) : construit lui-même ses pages
  { name: "garagesmbx", cmd: ["node", "tests/garages-mapbox.js"] }, // table de garages ET fiches complétées par Mapbox, ensemble : construit lui-même sa page
  { name: "prerender", cmd: ["node", "tests/prerender.js", FILE] },
  { name: "budget", cmd: ["node", "tests/budget.js"], distOnly: true },
  { name: "offline", cmd: ["node", "tests/offline.js"], distOnly: true },
  { name: "pages", cmd: ["node", "tests/pages.js"], distOnly: true }, // construit lui-même la version GitHub Pages
  { name: "garagesbuild", cmd: ["node", "tests/garages-build.js"], distOnly: true }, // construit lui-même des sites avec et sans tuiles de garages (vraies tuiles sur disque)
  { name: "a11y", cmd: ["node", "tests/a11y.js", FILE, "new"], a11y: true },
  { name: "sizes", cmd: ["node", "tests/sizes.js"] },
  { name: "states", cmd: ["node", "tests/states.js", FILE] },
  { name: "integrity", cmd: ["node", "tests/integrity.js"] },
  { name: "anchor", cmd: ["node", "tests/anchor_test.js"] },
  { name: "phone", cmd: ["node", "tests/phone_unit.js"] },
  { name: "cityunit", cmd: ["node", "tests/city_unit.js"] },
  { name: "contrast", cmd: ["python3", "tests/contrast/contrast_css.py"], contrast: true },
];

const run = (s) =>
  new Promise((done) => {
    const dist = target === "dist" ? { PIXCAR_ROOT: "dist" } : {};
    const p = spawn(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, env: { ...process.env, ...dist, ...(s.env || {}) } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => done({ code, out }));
  });

let failed = 0;
for (const s of SUITES) {
  if (only.length && !only.includes(s.name)) continue;
  if (s.distOnly && target !== "dist") continue; // ces suites ne portent que sur le site publiable
  const t0 = Date.now();
  const { code, out } = await run(s);
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  let ok = code === 0;
  let summary = lines.filter((l) => /passed|cas|pass$|ok$/.test(l)).pop() || lines.pop() || "";
  if (s.a11y) {
    const bad = lines.filter((l) => /violations=[1-9]/.test(l));
    ok = ok && !bad.length;
    summary = `${lines.filter((l) => /violations=\d/.test(l)).length} états, ${bad.length} avec violations`;
  }
  if (s.contrast) {
    const bad = lines.filter((l) => /^LOW|LOW /.test(l));
    ok = ok && !bad.length;
    summary = lines.filter((l) => /pass$/.test(l)).join(" · ");
  }
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${s.name.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s  ${summary}`);
  if (!ok) console.log(lines.filter((l) => /FAIL|Error|✗/.test(l)).slice(0, 12).map((l) => "     " + l.slice(0, 200)).join("\n"));
}
console.log(failed ? `\n${failed} suite(s) en échec` : "\nToutes les suites passent");
process.exit(failed ? 1 : 0);
