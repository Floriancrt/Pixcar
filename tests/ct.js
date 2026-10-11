// Prix du contrôle technique (jeu « prix-controle-technique » de la DGCCRF) : des lignes calquées sur le vrai jeu (relevé du 11 octobre
// 2026, dont les lignes réelles d'Auto Bilan Saint Esprit à Bayonne) pour vérifier que le site n'affiche que le tarif « Voiture
// particulière » (catégorie 1, libellé avec un è), jamais celui d'une autre catégorie, et jamais un code (0 €, 999 €) pris pour un prix.
//   node tests/ct.js [page]
const { serve, launch, open, pickServices, ROOT } = require("./harness");
const { CENTER } = require("./mocks");
const FILE = process.argv[2] || process.env.FILE || "index.html";

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const norm = (s) => String(s || "").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

// Un centre : ses lignes [catégorie, libellé, énergie, visite, CV mini, CV maxi, date] (le libellé suit l'identifiant comme dans le vrai jeu)
const LABEL = { 1: "Voiture particulière", 2: "4 x 4", 3: "Voiture de collection", 4: "Camionnette", 5: "Camping-car (moins de 3,5 tonnes)", 7: "Motocyclette" };
const ENERGIES = ["Essence", "Diesel", "Gaz", "Hybride", "Electrique"];
function centre(i, name, lines) {
  const lat = CENTER.lat + 0.004 * (i + 1), lon = CENTER.lon + 0.003 * (i % 3);
  return lines.map(([cat, energy, visite, cvMin, cvMax, date, label]) => ({
    cct_siret: "418258299000" + String(10 + i), cct_denomination: name, cct_adresse: `${3 + i} AV DU TEST`, cct_code_postal: "69002", cct_commune: "LYON",
    cct_tel: "04 72 00 00 1" + i, cct_url: "", latitude: lat, longitude: lon,
    cat_vehicule_id: cat, cat_vehicule_libelle: label || LABEL[cat] || "", cat_energie_id: ENERGIES.indexOf(energy) + 1, cat_energie_libelle: energy,
    prix_visite: visite, prix_contre_visite_mini: cvMin, prix_contre_visite_maxi: cvMax, date_application_visite: date,
  }));
}
const all = (cat, prices, cv = [15, 35], date = "2020-09-10") => ENERGIES.map((e, k) => [cat, e, prices[k], ...(prices[k] ? cv : [0, 0]), date]);
const ROWS = [
  // les lignes réelles d'Auto Bilan Saint Esprit (Bayonne) : voiture particulière 90 € (gaz 0 € : non proposé), camping-car tout à 0 €
  ...centre(0, "AUTO BILAN SAINT ESPRIT", [...all(1, [90, 90, 0, 95, 95]), ...all(2, [95, 95, 0, 95, 95]), ...all(3, [90, 90, 0, 0, 0]), ...all(4, [95, 95, 0, 95, 95]), ...all(5, [0, 0, 0, 0, 0])]),
  // une camionnette moins chère que la voiture particulière : c'est la voiture qui compte ; déclaré en 2020 (plus de deux ans)
  ...centre(1, "CONTROLE AUTO ANCIEN", [[1, "Essence", 79, 10, 30, "2020-09-10"], [1, "Diesel", 79, 10, 30, "2020-09-10"], [4, "Essence", 59, 10, 30, "2020-09-10"], [5, "Essence", 0, 0, 0, "2020-09-10"]]),
  // aucune ligne voiture particulière valable (toutes à 0 €) : ni le camping-car à 85 €, ni la moto, ne prennent sa place
  ...centre(2, "CENTRE SANS TARIF VOITURE", [[1, "Essence", 0, 0, 0, "2025-01-10"], [1, "Diesel", 0, 0, 0, "2025-01-10"], [5, "Essence", 85, 10, 30, "2025-01-10"], [7, "Toutes énergies (cat. L : moto, etc.)", 65, 10, 20, "2025-01-10"]]),
  // codes : 999 € en essence, 12 € en diesel (erreur de saisie), 500 € de contre-visite ; seul l'hybride à 99 € est un vrai tarif
  ...centre(3, "CENTRE AUX CODES", [[1, "Essence", 999, 15, 500, "2026-06-01"], [1, "Diesel", 12, 15, 35, "2026-06-01"], [1, "Hybride", 99, 15, 500, "2026-06-01"]]),
  // contre-visite gratuite (0 € des deux côtés) sur un vrai tarif récent
  ...centre(4, "CONTROLE GRATUIT CV", [[1, "Essence", 85, 0, 0, "2026-06-18"], [1, "Diesel", 85, 0, 0, "2026-06-18"]]),
  // sans identifiant de catégorie : le libellé décide (« Véhicule particulier » ou « Voiture particulière »)
  ...centre(5, "CENTRE SANS IDENTIFIANT", [[null, "Essence", 88, 15, 30, "2026-05-01", "Voiture particulière"], [null, "Diesel", 70, 15, 30, "2026-05-01", "Camping-car (moins de 3,5 tonnes)"]]),
];

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  try {
    const { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { ct: ROWS } });
    await pickServices(page, "ct");
    await page.fill("#address", "12 rue de la république lyon");
    await page.waitForSelector("#addrList li[data-i]", { state: "visible", timeout: 5000 });
    await page.click("#addrList li[data-i='0']");
    await page.click("#go");
    await page.waitForSelector("#list > li.card", { timeout: 12000 });
    await page.waitForTimeout(400);
    const read = () =>
      page.evaluate(() => {
        const t = (e, s) => { const x = e && e.querySelector(s); return x ? x.textContent.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim() : ""; };
        const rows = {};
        for (const c of document.querySelectorAll("#list > li.card")) rows[t(c, ".g-name").toUpperCase()] = { price: t(c, ".amount") || t(c, ".no-price"), id: c.dataset.id };
        return { rows, best: t(document, ".stats .st-best b"), stats: [...document.querySelectorAll(".stats .stat b")].map((b) => b.textContent.replace(/[  ]/g, " ").trim()), energies: [...document.querySelectorAll("#energy option")].map((o) => o.value), energy: document.getElementById("energy").value };
      });
    const fiche = async (name) => {
      const id = await page.evaluate((n) => { const c = [...document.querySelectorAll("#list > li.card")].find((c) => c.querySelector(".g-name").textContent.trim().toUpperCase() === n); return c && c.dataset.id; }, name);
      if (!id) return "";
      const card = `#list > li.card[data-id="${id}"]`;
      if (!(await page.$eval(card, (c) => c.classList.contains("is-open")))) await page.click(`${card} .g-main`);
      await page.waitForTimeout(350);
      return norm(await page.$eval(`${card} .g-more`, (e) => e.innerText));
    };
    let s = await read();
    check("CT1 Auto Bilan Saint Esprit (Bayonne, vraies lignes) : 90 € en essence, plus 0 € (le camping-car à 0 € n'est pas une voiture)", s.rows["AUTO BILAN SAINT ESPRIT"] && /^90\s?€/.test(s.rows["AUTO BILAN SAINT ESPRIT"].price), JSON.stringify(s.rows["AUTO BILAN SAINT ESPRIT"]));
    let f = await fiche("AUTO BILAN SAINT ESPRIT");
    check("CT2 …sa fiche dit « Visite Essence · voiture particulière », contre-visite 15 € à 35 €", /Visite Essence · voiture particulière/.test(f) && /Contre-visite 15 € à 35 €/.test(f) && !/camping/i.test(f), f.slice(0, 300));
    check("CT3 …et signale un tarif déclaré il y a plus de deux ans (10 septembre 2020)", /en vigueur depuis le 10 septembre 2020/.test(f) && /Déclaré il y a plus de deux ans : le tarif a pu changer/.test(f), f.slice(0, 400));
    check("CT4 « Le moins cher » ne peut plus être 0 € : 79 € (le seul tarif voiture plus bas que les autres), pas la camionnette à 59 €", s.best === "79 €" && !s.stats.some((x) => /^0\s?€/.test(x)), JSON.stringify(s.stats));
    check("CT5 a camionnette cheaper than the car is never shown for a car (79 €, not 59 €)", s.rows["CONTROLE AUTO ANCIEN"] && /^79\s?€/.test(s.rows["CONTROLE AUTO ANCIEN"].price), JSON.stringify(s.rows["CONTROLE AUTO ANCIEN"]));
    check("CT6 no valid car price (all 0 €): « Prix non déclaré », neither the camping-car (85 €) nor the motorcycle (65 €)", s.rows["CENTRE SANS TARIF VOITURE"] && /non déclaré/i.test(s.rows["CENTRE SANS TARIF VOITURE"].price), JSON.stringify(s.rows["CENTRE SANS TARIF VOITURE"]));
    f = await fiche("CENTRE SANS TARIF VOITURE");
    check("CT7 …its fiche says the centre declared no price for cars and to call it", /n'a pas déclaré de prix pour les voitures particulières/.test(f), f.slice(0, 200));
    check("CT8 codes are not prices: 999 € and 12 € are ignored, the real hybrid price (99 €) is shown with « aucun tarif déclaré pour l'énergie choisie »", s.rows["CENTRE AUX CODES"] && /^99\s?€/.test(s.rows["CENTRE AUX CODES"].price), JSON.stringify(s.rows["CENTRE AUX CODES"]));
    f = await fiche("CENTRE AUX CODES");
    check("CT9 …and its 500 € counter-visit is ignored (only 15 €), the energy mismatch is said", /Contre-visite 15 €/.test(f) && !/500/.test(f) && /aucun tarif déclaré pour l'énergie choisie/.test(f), f.slice(0, 300));
    f = await fiche("CONTROLE GRATUIT CV");
    check("CT10 0 € on both sides of a counter-visit means free: « Contre-visite gratuite », and no age warning on a 2026 price", /Contre-visite gratuite/.test(f) && !/plus de deux ans/.test(f), f.slice(0, 300));
    check("CT11 without a category id, the label decides: « Voiture particulière » (88 €) counts, the camping-car (70 €) does not", s.rows["CENTRE SANS IDENTIFIANT"] && /^88\s?€/.test(s.rows["CENTRE SANS IDENTIFIANT"].price), JSON.stringify(s.rows["CENTRE SANS IDENTIFIANT"]));
    check("CT12 the energy menu lists only the energies with a valid car price: no « Gaz » (every gas line is at 0 €), no motorcycle « Toutes énergies (cat. L…) »; Essence by default", s.energy === "Essence" && s.energies.includes("Hybride") && s.energies.includes("Diesel") && !s.energies.includes("Gaz") && !s.energies.some((e) => /cat\. L/.test(e)), JSON.stringify(s.energies));
    await page.selectOption("#energy", "Hybride");
    await page.waitForTimeout(300);
    s = await read();
    check("CT13 Hybride: Auto Bilan 95 €, the centre with codes 99 € (now its own energy), the camionnette centre falls back to its car price (79 €)", /^95\s?€/.test((s.rows["AUTO BILAN SAINT ESPRIT"] || {}).price || "") && /^99\s?€/.test((s.rows["CENTRE AUX CODES"] || {}).price || "") && /^79\s?€/.test((s.rows["CONTROLE AUTO ANCIEN"] || {}).price || ""), JSON.stringify(s.rows));
    check("CT14 no console message, no script error", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    await ctx.close();
  } catch (e) {
    check("CT section crashed", false, e && e.stack);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[ct] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => "  - " + f.name).join("\n"));
    process.exit(1);
  }
})();
