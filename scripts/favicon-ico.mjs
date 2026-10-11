// Fabrique src/assets/favicon.ico (16, 32 et 48 px) à partir de src/assets/favicon.svg, rendu par Chromium.
// /favicon.ico est l'adresse que demandent par défaut les robots et les navigateurs qui ne lisent pas <link rel="icon"> ;
// 48 px est la taille minimale que Google retient pour l'icône affichée dans ses résultats.
// À relancer après chaque modification de favicon.svg : node scripts/favicon-ico.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../src/assets");
const SIZES = [16, 32, 48];

const svg = await readFile(join(ASSETS, "favicon.svg"), "utf8");
const browser = await chromium.launch();
const pngs = [];
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
  }
} finally {
  await browser.close();
}

// Format ICO : en-tête de 6 octets, une entrée de 16 octets par taille, puis les images PNG telles quelles.
const header = Buffer.alloc(6 + 16 * SIZES.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(SIZES.length, 4);
let offset = header.length;
SIZES.forEach((size, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(size, at);
  header.writeUInt8(size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs[i].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pngs[i].length;
});
await writeFile(join(ASSETS, "favicon.ico"), Buffer.concat([header, ...pngs]));
console.log(`favicon.ico : ${SIZES.join(", ")} px, ${offset} octets`);
