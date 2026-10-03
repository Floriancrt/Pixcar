// Démonstration, sur un vrai PostgreSQL, que les réparations déclarées dans la page arrivent en base et s'y comptent.
//   TEST_DATABASE_URL=postgres://… node tests/demo-db.js        ATTENTION : le schéma de cette base est VIDÉ au départ.
// Parcours : page (mode distant) → réseau → API réelle → PostgreSQL. Les services publics (adresses, OpenStreetMap…) sont simulés.
// À chaque étape on interroge la table `repairs` et on affiche ce qu'elle contient.
const { serve, launch, open, search, ROOT } = require("./harness");
const { startApi } = require("./api-harness");
const { buildElements } = require("./mocks");

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL absent : indiquer une base PostgreSQL DE TEST (son schéma est vidé), p. ex.\n  TEST_DATABASE_URL=postgres://pixcar:pixcar@127.0.0.1:5432/pixcar_test node tests/demo-db.js");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = '#list [data-id="osm:node/1022"]';
const euro = (cents) => (cents / 100).toFixed(2).replace(".", ",") + " €";
let failed = 0;
const say = (text = "") => console.log(text);
const verdict = (ok, text) => {
  if (!ok) failed++;
  say(`   ${ok ? "✔" : "✘"} ${text}`);
};

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const api = await startApi({ origin: server.url });
  api.upstream.elements = buildElements();
  const open1 = (opts = {}) => open(browser, server, "index.html", { width: 1440, height: 900, initScript: `window.JG_TUNE.api=${JSON.stringify(api.url)};`, ...opts });
  const table = async () =>
    (await api.db.query(`SELECT left(id::text, 8) AS id, garage_id, service_id, price_cents, repaired_on::text AS day, vehicle_model, vehicle_year, status,
                                octet_length(plate_hmac) AS plate_bytes, left(encode(plate_hmac, 'hex'), 12) AS plate_hash, comment
                         FROM repairs ORDER BY created_at`)).rows;
  const count = async () => (await api.db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n;
  const show = async (title) => {
    const rows = await table();
    say(`\n${title}  →  ${rows.length} réparation(s) en base`);
    for (const r of rows) say(`     ${r.id}…  ${r.garage_id}  ${r.service_id.padEnd(8)} ${euro(r.price_cents).padStart(9)}  ${r.day}  ${r.vehicle_model} (${r.vehicle_year})  ${r.status}  plaque: empreinte ${r.plate_bytes} octets (${r.plate_hash}…)`);
    return rows;
  };
  const declare = async (page, { price, service }) => {
    await page.click("#addRepairBtn");
    if (service) await page.selectOption("#rService", service);
    await page.fill("#rGarage", "Norauto Bron");
    await page.waitForSelector("#rGarageList li[data-i]", { state: "visible" });
    await page.click("#rGarageList li[data-i='0']");
    if (!(await page.inputValue("#rModel"))) await page.fill("#rModel", "peugeot 208");
    if (!(await page.inputValue("#rPlate"))) await page.fill("#rPlate", "ez108bc");
    if (!(await page.inputValue("#rYear"))) await page.fill("#rYear", "2019");
    await page.fill("#rPrice", price);
    await page.click("label[for=rSt4]");
    await page.fill("#rComment", "Très bien, rapide.");
    await page.click("#repairForm button[type=submit]");
  };
  const waitCount = async (n, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await count()) === n) return true;
      await sleep(100);
    }
    return false;
  };

  try {
    const version = (await api.db.query("SHOW server_version")).rows[0].server_version;
    say(`Base : PostgreSQL ${version} · API : ${api.url} · page : ${server.url} (mode distant)`);
    await show("0. État initial");

    // ---- 1. un visiteur déclare une réparation dans la page
    const { page, ctx, logs } = await open1();
    await search(page, { service: "vidange" });
    await declare(page, { price: "59,90", service: "vidange" });
    verdict(await waitCount(1), "la déclaration « vidange · 59,90 € chez Norauto Bron » est arrivée en base (1 ligne)");
    const [first] = await show("1. Après une déclaration dans la page");
    verdict(first.status === "approved" && first.price_cents === 5990 && first.service_id === "vidange" && first.vehicle_year === 2019, "prix, prestation, modèle, année et statut « approved » enregistrés tels que saisis");
    verdict(first.plate_bytes === 32 && !JSON.stringify(first).includes("EZ-108-BC"), "la plaque n'est PAS stockée : seulement son empreinte (32 octets)");
    verdict(first.comment === "Très bien, rapide.", "le commentaire est stocké (lisible par la modération), mais n'est jamais renvoyé au public (voir étape 4)");

    // ---- 2. la même réparation une seconde fois : doublon refusé
    await page.waitForTimeout(500);
    await declare(page, { price: "59,90", service: "vidange" });
    await page.waitForTimeout(1500);
    verdict((await count()) === 1, "la même réparation déclarée une 2ᵉ fois (même plaque, garage, prestation, jour) n'est PAS comptée deux fois : toujours 1 ligne");
    await show("2. Après un doublon");

    // ---- 3. une autre prestation : +1
    await page.waitForTimeout(500);
    await declare(page, { price: "129", service: "revision" });
    verdict(await waitCount(2), "une autre prestation (révision · 129 €) s'ajoute : 2 lignes");
    await show("3. Après une 2ᵉ réparation (autre prestation)");

    // ---- 4. un AUTRE visiteur (autre navigateur) lit ce que l'API publie
    const res = await fetch(`${api.url}/v1/repairs?lat=45.7347&lon=4.9128&radius=10`);
    const body = await res.json();
    const shared = (body.garages || []).flatMap((g) => g.repairs);
    say(`\n4. Ce que lit un autre visiteur (GET /v1/repairs, ${res.status}) : ${shared.length} réparation(s) chez ${(body.garages || []).map((g) => g.name).join(", ")}`);
    for (const r of shared) say(`     ${euro(Math.round(r.price * 100)).padStart(9)}  ${r.month}  ${r.model} (${r.year})  note ${r.rating}/5  — champs publics : ${Object.keys(r).join(", ")}`);
    verdict(shared.length === 2 && shared.every((r) => !("comment" in r) && !("plate" in r) && !("immat" in r) && /^\d{4}-\d{2}$/.test(r.month)), "2 réparations visibles, sans commentaire, sans plaque, avec le mois seulement (pas le jour)");
    api.clock.skew += 60_000; // l'API garde une zone lue 10 s en mémoire : on laisse cette copie expirer, comme en production
    const other = await open1();
    await search(other.page, { service: "vidange" });
    await other.page.click("[data-sort=dist]");
    await other.page.waitForTimeout(500);
    const tag = await other.page.$eval(CARD, (c) => { const t = c.querySelector(".g-price .tag.info"); const a = c.querySelector(".g-price .amount .num"); return t ? t.textContent.trim() + " " + a.textContent.replace(/\s+/g, " ").trim() : null; });
    verdict(/Prix déclaré/.test(tag || ""), `dans un autre navigateur, la fiche du garage affiche le prix déclaré par le premier visiteur : « ${tag} »`);
    await other.ctx.close();

    // ---- 5. l'auteur supprime sa réparation : -1 (dans le même navigateur : c'est lui qui garde le jeton secret)
    await page.click("[data-sort=dist]");
    await page.locator(`${CARD} .g-main`).scrollIntoViewIfNeeded();
    if (!(await page.$(`${CARD}.is-open`))) await page.click(`${CARD} .g-main`);
    await page.waitForTimeout(300);
    await page.evaluate((s) => { const d = document.querySelector(`${s} details.history`); if (d) d.open = true; }, CARD);
    await page.click(`${CARD} .h-del[data-rid^="${first.id}"]`);
    verdict(await waitCount(1), "« Supprimer » dans l'historique de la fiche retire la ligne en base (jeton secret de l'auteur) : 1 ligne");
    const left = await show("5. Après la suppression de la vidange par son auteur");
    verdict(left.length === 1 && left[0].service_id === "revision", "il ne reste que la révision");
    verdict(logs.errors.length === 0, "aucune erreur dans la page pendant tout le parcours");
    await ctx.close();
  } catch (e) {
    failed++;
    console.error("\nÉchec de la démonstration :", e && e.stack);
  } finally {
    await browser.close();
    server.close();
    await api.close();
  }
  say(failed ? `\n${failed} point(s) en échec.` : "\nTout est conforme : les réparations déclarées dans la page s'enregistrent, se comptent, se dédoublonnent et se suppriment dans PostgreSQL.");
  process.exit(failed ? 1 : 0);
})();
