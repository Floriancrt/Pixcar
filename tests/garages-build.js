// Site construit avec la table de garages : `node scripts/build.mjs --garages <dossier de tuiles>` joint les tuiles à dist/ (dist/garages/), pose la balise
// que la page lit, ajoute les textes de sources et de confidentialité, interdit le dossier aux robots et lui donne un cache d'une heure ; sans l'option, rien de
// tout cela n'existe. Les tuiles sont ici de vrais fichiers sur disque, servis par le serveur de test de dist/ (types MIME, compression, politique de sécurité
// du contenu) : la page les lit sans aucune simulation, comme sur le site publié. Les sites sont construits dans tests/.out/garages-site.
//   node tests/garages-build.js
delete process.env.PIXCAR_ROOT; // la suite construit et sert ses propres sites, quel que soit celui que les autres suites testent
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { launch, open, search, ROOT, sortBy } = require("./harness");
const { serveDir } = require("./static-server");
const { OSM, FOUR, TILES, ovtId, dayStr, indexOf } = require("./fixtures/garages-data");

const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond }); if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 700)); };
const OUT = path.join(__dirname, ".out", "garages-site");
const SRC = process.env.PIXCAR_SRC || path.join(ROOT, "src"); // les tests de mutation y mettent une copie modifiée des sources
const BUILD = process.env.PIXCAR_BUILD ? path.resolve(ROOT, process.env.PIXCAR_BUILD) : path.join(ROOT, "scripts/build.mjs");
const LEGAL = {
  editorLine: "Pixcar est édité à titre non professionnel par Jeanne Exemple, responsable du traitement des données décrites ici.",
  contact: "contact@exemple.test",
  hostPages: "GitHub, Inc. (GitHub Pages), États-Unis",
  hostApi: "Amazon Web Services EMEA SARL, Luxembourg (région Europe, Stockholm)",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const exists = (...p) => fs.existsSync(path.join(...p));
const W = { width: 1440, height: 900 };

// ---------------------------------------------------------------------------------------------------------------------------------- les tuiles sur disque
function writeTiles(dir, { built = dayStr(20), tiles = TILES, index } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "t"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index || indexOf({ built, tiles })));
  for (const [k, v] of Object.entries(tiles)) fs.writeFileSync(path.join(dir, "t", k + ".json"), JSON.stringify({ v: 1, g: v }));
  return dir;
}
// Construit un site dans OUT/<name> ; renvoie { dir (dist/ ou la racine), res }.
function build(name, { garages, only = "dist", pages, legal = LEGAL } = {}) {
  const src = path.join(OUT, name + "-src");
  fs.rmSync(src, { recursive: true, force: true });
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, "legal.json"), JSON.stringify(legal));
  const env = { ...process.env, PIXCAR_API_BASE: "", PIXCAR_GA_ID: "", PIXCAR_MAPBOX_TOKEN: "" }; // ni API, ni mesure d'audience, ni Mapbox (src/mapbox.json a un jeton, une construction --pages le prend) : seule la table est en cause
  const args = [BUILD, "--src", src, "--out", path.join(OUT, name)];
  if (only) args.push("--only", only);
  if (pages) args.push("--pages", pages);
  if (garages) args.push("--garages", garages);
  const res = spawnSync(process.execPath, args, { encoding: "utf8", env });
  return { res, root: path.join(OUT, name), dir: path.join(OUT, name, only === "dist" || !only ? "dist" : "") };
}
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name))).sort() : []);
const metaOf = (html) => { const m = /<meta name="pixcar-garages" content="([^"]*)">/.exec(html); return m ? m[1] : null; };
const cspOf = (headers) => { const m = /Content-Security-Policy: (.*)/.exec(headers); return m ? m[1] : ""; };

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const TILE_DIR = writeTiles(path.join(OUT, "tuiles"), { tiles: TILES });

  // ===== A. dist construit avec les tuiles =====
  const A = build("with", { garages: TILE_DIR });
  check("A1 the build succeeds", A.res.status === 0, A.res.stderr + A.res.stdout);
  const files = tree(path.join(A.dir, "garages"));
  const expected = ["index.json", ...Object.keys(TILES).map((k) => path.join("t", k + ".json"))].sort();
  check("A2 dist/garages holds the index and every tile, and nothing else", files.join() === expected.join(), files.join());
  check("A3 the files are copied byte for byte", files.every((f) => fs.readFileSync(path.join(A.dir, "garages", f)).equals(fs.readFileSync(path.join(TILE_DIR, f)))));
  const htmlA = read(A.dir, "index.html");
  check("A4 the page carries the folder in its pixcar-garages meta", metaOf(htmlA) === "garages/", String(metaOf(htmlA)));
  check("A5 robots.txt keeps robots out of /garages/ and the rest open", /User-agent: \*\nAllow: \/\nDisallow: \/garages\/\n/.test(read(A.dir, "robots.txt")), read(A.dir, "robots.txt"));
  const headersA = read(A.dir, "_headers");
  check("A6 _headers gives the tiles a one-hour cache, and only them", /\n\/garages\/\*\n  Cache-Control: public, max-age=3600\n/.test(headersA) && (headersA.match(/max-age=3600/g) || []).length === 1, headersA.slice(-400));
  check("A7 the service worker knows nothing of the tiles (they go through the HTTP cache, never the shell cache)", !/garages/.test(read(A.dir, "sw.js")));
  const P = build("plain");
  check("A8 the same build without --garages: succeeds", P.res.status === 0, P.res.stderr);
  const headersP = read(P.dir, "_headers");
  check("A9 the content security policy is the same with and without tiles: no new host is allowed", cspOf(headersA) === cspOf(headersP) && /connect-src 'self'/.test(cspOf(headersA)) && !/overture/i.test(headersA), cspOf(headersA).slice(0, 300));
  check("A10 without --garages: empty meta, no folder, nothing about it in robots.txt or _headers", metaOf(read(P.dir, "index.html")) === "" && !exists(P.dir, "garages") && !/garages/.test(read(P.dir, "robots.txt")) && !/garages/.test(headersP));

  // les textes
  const body = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "");
  const flat = (h) => h.replace(/\s+/g, " ");
  check("A11 with tiles: the sources text names Overture Maps, its owners and its licences, and says the data may be out of date", /Overture Maps/.test(flat(htmlA)) && /CDLA-Permissive-2\.0/.test(flat(htmlA)) && /AllThePlaces/.test(flat(htmlA)) && /garder un garage fermé ou un numéro périmé/.test(flat(htmlA)));
  check("A12 with tiles: the credit under the list adds Overture Maps Foundation to OpenStreetMap's", /id="osmNote"[^>]*>[\s\S]{0,400}\(ODbL\), <a href="https:\/\/overturemaps\.org"[^>]*>Overture Maps Foundation<\/a> \(CDLA-Permissive-2\.0, Apache-2\.0, CC0\)\./.test(htmlA), (/id="osmNote"[\s\S]{0,500}/.exec(htmlA) || [""])[0]);
  check("A13 with tiles: the privacy window says the list is copied on the site (no Overture, Meta or Foursquare contact) and tells professionals how to ask for removal", /Les garages ajoutés ou complétés viennent d'Overture Maps/.test(flat(htmlA)) && /ne contacte ni Overture, ni Meta, ni Foursquare/.test(flat(htmlA)) && /dont le garage figure dans la liste peut en demander le retrait ou la correction, en écrivant à <a href="mailto:contact@exemple\.test">contact@exemple\.test<\/a>/.test(flat(htmlA)));
  check("A14 without tiles: none of this appears, anywhere", !/Overture|overturemaps|CDLA|AllThePlaces/.test(body(read(P.dir, "index.html"))), "");
  check("A15 no template marker is left in either page", ![htmlA, read(P.dir, "index.html")].some((h) => /<!--\/?GT:|\{\{[A-Za-z_.]+\}\}/.test(h)), "");

  // ===== B. toutes les sorties, avec les tuiles : la page tout-en-un n'en a pas, ni dans les fichiers ni dans les textes =====
  const B = build("both", { garages: TILE_DIR, only: "" });
  check("B1 build without --only, with tiles: succeeds", B.res.status === 0, B.res.stderr);
  const single = read(B.root, "index.html");
  check("B2 the single-file page has an empty meta and says nothing of the table (it never carries tiles)", metaOf(single) === "" && !/Overture|overturemaps/.test(body(single)), String(metaOf(single)));
  check("B3 …while dist/ of the same build has the tiles and the texts", exists(B.root, "dist/garages/index.json") && /Overture Maps/.test(read(B.root, "dist/index.html")));

  // ===== C. version GitHub Pages =====
  const G = build("pages", { garages: TILE_DIR, pages: "pixcar.example" });
  check("C1 --pages with tiles: succeeds, no _headers (GitHub Pages ignores them), CNAME and .nojekyll as usual", G.res.status === 0 && !exists(G.dir, "_headers") && exists(G.dir, "CNAME") && exists(G.dir, ".nojekyll"), G.res.stderr);
  const htmlG = read(G.dir, "index.html");
  check("C2 the policy travels in a meta tag and still allows the site's own origin only for connections; the tiles are there", metaOf(htmlG) === "garages/" && /<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src 'self'/.test(htmlG) && exists(G.dir, "garages/index.json"), "");
  check("C3 robots.txt keeps robots out of /garages/", /Disallow: \/garages\//.test(read(G.dir, "robots.txt")));

  // ===== D. des tuiles que la page ne saurait pas lire ne sont jamais publiées =====
  const bad = (name, mutate, rx) => {
    const dir = writeTiles(path.join(OUT, "tuiles-" + name), { tiles: TILES });
    mutate(dir);
    const r = build("bad-" + name, { garages: dir });
    check(`D-${name} ${rx.source}: the build stops with a message that says why`, r.res.status !== 0 && rx.test(r.res.stderr), r.res.stderr.slice(0, 300));
  };
  bad("noindex", (d) => fs.rmSync(path.join(d, "index.json")), /index\.json illisible/);
  bad("step", (d) => { const i = JSON.parse(read(d, "index.json")); i.step = 0.5; fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(i)); }, /index\.json inattendu/);
  bad("origin", (d) => { const i = JSON.parse(read(d, "index.json")); i.x0 = 0; fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(i)); }, /index\.json inattendu/);
  bad("version", (d) => { const i = JSON.parse(read(d, "index.json")); i.v = 2; fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(i)); }, /index\.json inattendu/);
  bad("key", (d) => { const i = JSON.parse(read(d, "index.json")); i.tiles["../x"] = 1; fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(i)); }, /case « \.\.\/x » inattendue/);
  bad("empty", (d) => { const i = JSON.parse(read(d, "index.json")); i.tiles = {}; fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(i)); }, /aucune case/);
  bad("missingtile", (d) => fs.rmSync(path.join(d, "t", "183-59.json")), /183-59\.json|ENOENT/);

  // ===== E. la page, sur le site construit : vraies tuiles, vraie politique de sécurité =====
  const browser = await launch();
  for (const [label, dir] of [["dist with _headers", A.dir], ["GitHub Pages (policy meta)", G.dir]]) {
    const server = await serveDir(dir);
    const { page, ctx, logs } = await open(browser, server, "index.html", { ...W, mock: { elements: OSM, reverse: { delayMs: 50 } }, initScript: "window.JG_CITY_LOOKUP=false;" });
    await search(page, { service: "vidange", km: 10 });
    await sortBy(page, "dist"); await page.waitForTimeout(500);
    const reqs = server.stats.requests.filter((r) => /\/garages\//.test(r));
    const tiles = reqs.filter((r) => /\/garages\/t\//.test(r)).map((r) => /t\/(.*)\.json/.exec(r)[1]).sort();
    check(`E1 ${label}: the page reads the index once and exactly the four tiles of the disc, from its own origin`, reqs.filter((r) => /index\.json/.test(r)).length === 1 && tiles.join() === FOUR.join(), JSON.stringify(reqs));
    const names = await page.evaluate(() => [...document.querySelectorAll("#list > li.card .g-name")].map((e) => e.textContent.trim()));
    check(`E2 ${label}: nine garages (five of OpenStreetMap, four of the table)`, names.length === 9 && names.includes("Carrosserie du Soleil") && names.includes("Garage de l'Ouest"), JSON.stringify(names));
    const ji = await page.evaluate(() => window.jgGarages());
    check(`E3 ${label}: counters say so`, ji && ji.recs === 8 && ji.matched === 3 && ji.filled === 2 && ji.added === 4 && ji.dup === 1 && ji.failed === 0, JSON.stringify(ji));
    check(`E4 ${label}: the credits name Overture Maps next to OpenStreetMap, under the list and on the map`, await page.evaluate(() => /Overture Maps Foundation/.test(document.getElementById("osmNote").textContent) && /Overture Maps/.test((document.querySelector(".leaflet-control-attribution") || {}).textContent || "")), "");
    await page.click(`#list [data-id="${ovtId(5)}"] .g-main`); await page.waitForTimeout(200);
    check(`E5 ${label}: a table garage's card is open with its note`, await page.evaluate((id) => /Garage référencé par la base Overture Maps/.test(document.querySelector(`#list [data-id="${CSS.escape(id)}"] .fact-note`).textContent), ovtId(5)), "");
    const legalTxt = await page.evaluate(() => { const d = document.getElementById("legalDlg") || document.querySelector("dialog[aria-labelledby^='lg']"); return d ? d.textContent.replace(/\s+/g, " ") : ""; });
    check(`E6 ${label}: the privacy window of the page has the table's paragraphs`, /Les garages ajoutés ou complétés viennent d'Overture Maps/.test(legalTxt) && /demander le retrait ou la correction/.test(legalTxt), legalTxt.slice(0, 200));
    check(`E7 ${label}: nothing refused by the content security policy, no error, no request to another host`, logs.errors.length === 0 && logs.console.length === 0 && ctx.__counters.other.length === 0, JSON.stringify([logs.errors, logs.console, ctx.__counters.other]));
    await ctx.close();
    server.close();
  }

  // un site sans les tuiles ne demande rien (la balise est vide) : la page est celle d'avant
  {
    const server = await serveDir(P.dir);
    const { page, ctx, logs } = await open(browser, server, "index.html", { ...W, mock: { elements: OSM }, initScript: "window.JG_CITY_LOOKUP=false;" });
    await search(page, { service: "vidange", km: 10 });
    await page.waitForTimeout(2200); // plus que le délai de chauffe de l'index (1,5 s)
    const names = await page.evaluate(() => [...document.querySelectorAll("#list > li.card .g-name")].map((e) => e.textContent.trim()));
    check("E8 site built without tiles: five garages, not a single request to /garages/, no error", names.length === 5 && server.stats.requests.every((r) => !/garages/.test(r)) && logs.errors.length === 0 && logs.console.length === 0, JSON.stringify([names.length, server.stats.requests.filter((r) => /garages/.test(r)), logs.console]));
    await ctx.close();
    server.close();
  }
  await browser.close();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n[garages-build] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
