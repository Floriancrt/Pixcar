// Fabrique src/assets/apple-touch-icon.png (180 px, fond noir plein : iOS arrondit lui-même les coins) à partir de
// docs/brand/apple-touch-icon.svg (écrit par scripts/brand-logo.py --apply), rendu par Chromium puis réduit à une palette.
// À relancer après chaque modification du symbole : node scripts/apple-touch-icon.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(join(ROOT, "docs/brand/apple-touch-icon.svg"), "utf8");
const browser = await chromium.launch();
let png;
try {
  const page = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:#000}svg{display:block;width:180px;height:180px}</style>${svg}`);
  png = await page.screenshot({ clip: { x: 0, y: 0, width: 180, height: 180 } });
} finally {
  await browser.close();
}
const out = join(ROOT, "src/assets/apple-touch-icon.png");
await writeFile(out, png);
// palette de 64 couleurs (le dégradé reste lisse à cette taille) : quelques Ko au lieu d'une dizaine
execFileSync("python3", ["-I", "-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGB');im.quantize(64,method=Image.Quantize.MEDIANCUT).save(sys.argv[1],optimize=True)", out]);
console.log(`apple-touch-icon.png : ${(await readFile(out)).length} octets`);
