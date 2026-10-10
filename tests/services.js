// Plusieurs prestations : la fenêtre « Quelles prestations souhaitez-vous réaliser ? » (recherche, cases, pastilles, contrôle technique seul,
// 5 au plus, Échap) et les résultats d'un ensemble de prestations (total des prix, total partiel, garage qui n'en fait qu'une partie,
// détail dans la fiche, repères d'accueil, résumé, mémoire, mobile, clavier, accessibilité). Les règles de calcul elles-mêmes sont
// vérifiées sans navigateur (tests/unit/svc-combo.test.mjs, tests/unit/service-picker.test.mjs).
// Usage : node tests/services.js [fichier]
const { serve, launch, open, search, sortBy, filterBy, clearFilters, pickServices, injectScript, ROOT } = require("./harness");
const { buildElements, CENTER } = require("./mocks");
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || "index.html";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const num = (t) => {
  const m = /(\d+(?:\s\d{3})*(?:,\d+)?)\s*€/.exec(norm(t));
  return m ? parseFloat(m[1].replace(/\s/g, "").replace(",", ".")) : NaN;
};
const near = (a, b) => Math.abs(a - b) < 0.006;

// Deux garages de plus : l'un ne fait pas la vidange (OpenStreetMap le dit) mais fait la climatisation, l'autre ne fait ni l'une ni l'autre
const ELEMENTS = buildElements().concat([
  { type: "node", id: 9301, lat: CENTER.lat + 0.002, lon: CENTER.lon + 0.002, tags: { name: "Garage Clim Seule", shop: "car_repair", "service:vehicle:oil_change": "no", "service:vehicle:air_conditioning": "yes", "addr:street": "rue Test", "addr:housenumber": "1", "addr:postcode": "69002", "addr:city": "Lyon" } },
  { type: "node", id: 9302, lat: CENTER.lat + 0.0025, lon: CENTER.lon - 0.002, tags: { name: "Garage Ni Vidange Ni Clim", shop: "car_repair", "service:vehicle:oil_change": "no", "service:vehicle:air_conditioning": "no", "addr:street": "rue Test", "addr:housenumber": "3", "addr:postcode": "69002", "addr:city": "Lyon" } },
]);

const picker = (page) =>
  page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    return {
      open: $("svcDlg").open,
      chips: [...document.querySelectorAll("#svcChips .svc-chip span")].map((s) => s.textContent),
      checked: [...document.querySelectorAll("#svcList input:checked")].map((i) => i.value),
      disabled: [...document.querySelectorAll("#svcList input:disabled")].map((i) => i.value),
      go: $("svcGo").textContent,
      goDisabled: $("svcGo").disabled,
      note: $("svcNote").textContent,
      selHidden: $("svcSel").hidden,
      visible: [...document.querySelectorAll("#svcList .svc-opt")].filter((r) => !r.hidden).map((r) => r.dataset.id),
      none: !$("svcNone").hidden,
      bar: [$("svcVal").textContent, $("svcN").hidden ? "" : $("svcN").textContent],
      focus: document.activeElement && document.activeElement.id,
    };
  });
const openPicker = async (page) => {
  await page.click("#svcBtn");
  await page.waitForSelector("#svcDlg[open]");
};
// Prix nationaux d'une enseigne, lus sur la page « Prix et promos » (pas recopiés dans le test)
async function chainPrice(page, service, chain) {
  await page.click(".tab[data-view=prix]");
  await page.selectOption("#refService", service);
  await page.waitForTimeout(150);
  const rows = await page.$$eval("#refList > li", (l) => l.map((li) => ({ chain: (li.querySelector(".ref-chain") || {}).textContent || "", price: (li.querySelector(".ref-price") || {}).textContent || "", partial: !!li.querySelector(".tag.warn") })));
  await page.click(".tab[data-view=garages]");
  await page.waitForTimeout(150);
  const r = rows.find((x) => x.chain.includes(chain) && !x.partial);
  return r ? num(r.price.replace(/env\./, "")) : NaN;
}
const cardsOf = (page) =>
  page.$$eval("#list > li.card", (l) =>
    l.map((c) => ({
      id: c.dataset.id,
      name: c.querySelector(".g-name").textContent.trim(),
      price: (c.querySelector(".g-price") || {}).textContent || "",
      tag: ((c.querySelector(".g-price .tag") || {}).textContent || "").trim(),
      svc: c.querySelector(".svc") ? { cls: c.querySelector(".svc").className, title: c.querySelector(".svc").getAttribute("title"), text: c.querySelector(".svc").textContent } : null,
    })),
  );
const axeRun = async (page) => {
  await injectScript(page, AXE); // pas de <script> en ligne : la politique de sécurité du site publiable (dist/) le refuse
  return page.evaluate(async (tags) => (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.html.slice(0, 140)) })), TAGS);
};

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  try {
    // =============== P. La fenêtre de choix (ordinateur) ===============
    let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: ELEMENTS } });
    await openPicker(page);
    let s = await picker(page);
    check("P1 the « Prestation » button opens the window, the current service is ticked and shown as a chip, the search field has the focus", s.open && s.checked.length === 1 && s.chips.length === 1 && !s.selHidden && s.go === "Valider cette prestation" && s.focus === "svcSearch", JSON.stringify(s));
    const start = s.checked[0];
    await page.fill("#svcSearch", "clim");
    s = await picker(page);
    check("P2a search narrows the list (« clim » → recharge de climatisation)", JSON.stringify(s.visible) === JSON.stringify(["clim"]) && !s.none, JSON.stringify(s.visible));
    await page.fill("#svcSearch", "GEOMETRIE avant");
    s = await picker(page);
    check("P2b without accents or case, every word must match", s.visible.includes("geo_av") && s.visible.every((id) => /^geo_/.test(id)), JSON.stringify(s.visible));
    await page.fill("#svcSearch", "zzzz");
    s = await picker(page);
    check("P2c nothing matches: a sentence says so", !s.visible.length && s.none, JSON.stringify(s));
    await page.fill("#svcSearch", "");
    await page.press("#svcSearch", "Enter");
    s = await picker(page);
    check("P2d Enter in the search field does not validate", s.open && s.visible.length > 15, JSON.stringify([s.open, s.visible.length]));
    await page.click(`#svcChips [data-rm="${start}"]`);
    s = await picker(page);
    check("P3a removing the last chip: nothing chosen, « Choisissez une prestation » and the button is disabled", !s.checked.length && s.selHidden && s.goDisabled && s.go === "Choisissez une prestation", JSON.stringify(s));
    await page.check("#svcList input[value='vidange']");
    await page.check("#svcList input[value='clim']");
    s = await picker(page);
    check("P3b two services ticked: two chips, « Valider ces 2 prestations »", JSON.stringify(s.checked) === JSON.stringify(["vidange", "clim"]) && JSON.stringify(s.chips) === JSON.stringify(["Vidange (huile + filtre)", "Recharge de climatisation"]) && s.go === "Valider ces 2 prestations" && !s.goDisabled, JSON.stringify(s));
    await page.click('#svcChips [data-rm="clim"]');
    s = await picker(page);
    check("P4 the chip's × removes the service (box unticked, label back to one), the focus stays in the chips", JSON.stringify(s.checked) === JSON.stringify(["vidange"]) && s.go === "Valider cette prestation" && (await page.evaluate(() => document.activeElement.dataset.rm)) === "vidange", JSON.stringify(s));
    await page.check("#svcList input[value='ct']");
    s = await picker(page);
    check("P5a the contrôle technique is searched alone: ticking it replaces the others, and the window says why", JSON.stringify(s.checked) === JSON.stringify(["ct"]) && /contrôle technique se cherche seul/.test(s.note), JSON.stringify(s));
    await page.check("#svcList input[value='vidange']");
    s = await picker(page);
    check("P5b ticking another service removes the contrôle technique", JSON.stringify(s.checked) === JSON.stringify(["vidange"]) && !s.note, JSON.stringify(s));
    for (const id of ["clim", "diag", "batterie", "plaq_av"]) await page.check(`#svcList input[value='${id}']`);
    s = await picker(page);
    check("P6 five at most: the other boxes are disabled (the contrôle technique stays available), and the window says so", s.checked.length === 5 && s.disabled.length > 5 && !s.disabled.includes("ct") && !s.disabled.some((id) => s.checked.includes(id)) && s.note === "5 prestations au plus." && s.go === "Valider ces 5 prestations", JSON.stringify(s));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    s = await picker(page);
    check("P7 Escape closes without applying: the bar still names the service chosen before, the focus is back on the button", !s.open && s.bar[1] === "" && (await page.inputValue("#service")) === start && s.focus === "svcBtn", JSON.stringify(s));
    await openPicker(page);
    s = await picker(page);
    check("P8 reopened, the window shows the applied choice again (unsaved ticks are forgotten)", JSON.stringify(s.checked) === JSON.stringify([start]), JSON.stringify(s.checked));
    await page.click("#svcClose");
    await page.waitForTimeout(150);
    check("P9a the × button closes it", !(await picker(page)).open);
    await openPicker(page);
    await page.mouse.click(30, 450); // sur le voile, hors de la fenêtre
    await page.waitForTimeout(150);
    check("P9b a click outside the window closes it", !(await picker(page)).open);
    await pickServices(page, ["vidange", "clim"]);
    s = await picker(page);
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem("jg.last.v1") || "{}"));
    check("P10 validated: the bar reads « Vidange (huile + filtre) » with « +1 », the main service drives the page, the choice is remembered", !s.open && s.bar[0] === "Vidange (huile + filtre)" && s.bar[1] === "+1" && (await page.inputValue("#service")) === "vidange" && JSON.stringify(last.svcs) === JSON.stringify(["vidange", "clim"]) && s.focus === "svcBtn", JSON.stringify([s, last]));
    const teaser = await page.evaluate(() => ({ h: document.querySelector("#teaser h2").textContent, p: document.querySelector("#teaser p").textContent, rows: [...document.querySelectorAll("#teaser .teaser-svcs li")].map((li) => li.textContent) }));
    check("P11 before the search, the landmarks speak of both services: range for the whole set, then one line each", teaser.h === "2 prestations : les repères" && /l'ensemble coûte de .+ à .+/.test(teaser.p) && teaser.rows.length === 2 && /^Vidange/.test(teaser.rows[0]) && /^Recharge de climatisation/.test(teaser.rows[1]), JSON.stringify(teaser));

    // =============== R. Les résultats d'un ensemble de prestations ===============
    const pV = await chainPrice(page, "vidange", "Norauto"), pC = await chainPrice(page, "clim", "Norauto");
    await search(page, {});
    await sortBy(page, "price");
    let cards = await cardsOf(page);
    const nor = cards.find((c) => /^Norauto/.test(c.name));
    check("R1 a chain with both prices shows their total, tagged « Total 2 prestations »", nor && near(num(nor.price), pV + pC) && nor.tag === "Total 2 prestations", JSON.stringify([nor, pV, pC]));
    const sum = norm(await page.textContent("#summary"));
    check("R2 the summary counts garages with a price for both, and the cheapest is « au total »", /\d+ avec un prix pour les 2 prestations/.test(sum) && /au total\./.test(sum), sum);
    const full = cards.filter((c) => c.tag === "Total 2 prestations").map((c) => num(c.price));
    const firstPartial = cards.findIndex((c) => c.tag === "Total partiel"), lastFull = cards.map((c) => c.tag).lastIndexOf("Total 2 prestations");
    check("R3 sorted by price: complete totals first, from the cheapest, then partial totals", full.length >= 3 && full.every((v, i) => !i || v >= full[i - 1]) && (firstPartial < 0 || firstPartial > lastFull), JSON.stringify([full.slice(0, 8), firstPartial, lastFull]));
    const clim = cards.find((c) => c.name === "Garage Clim Seule");
    check("R4 a garage that does only one of them stays, saying « 1 prestation sur 2 » and what it does not do", clim && /lvl-part/.test(clim.svc.cls) && clim.svc.title === "1 prestation sur 2 : ne propose pas vidange (huile + filtre)" && /1 sur 2|1 prestation sur 2/.test(clim.svc.text), JSON.stringify(clim));
    check("R5 a garage that does neither is left out", !cards.some((c) => c.name === "Garage Ni Vidange Ni Clim"), JSON.stringify(cards.map((c) => c.name).slice(0, 5)));
    await page.click(`#list [data-id="${nor.id}"] .g-main`);
    await page.waitForTimeout(500);
    const det = await page.evaluate((id) => {
      const card = document.querySelector(`#list [data-id="${id}"]`);
      const rows = [...card.querySelectorAll(".combo li")].map((li) => ({ svc: li.querySelector(".c-svc").textContent, val: li.querySelector(".c-val").textContent, src: li.querySelector(".c-src").textContent, tot: li.classList.contains("c-tot") }));
      const bar = document.getElementById("mapInfo");
      return { rows, note: (card.querySelector(".price-note") || {}).textContent || "", bar: bar ? bar.textContent.replace(/\s+/g, " ") : "" };
    }, nor.id);
    check("R6 the open card details the price of each service, then the total", det.rows.length === 3 && det.rows[0].svc === "Vidange (huile + filtre)" && near(num(det.rows[0].val), pV) && /prix enseigne/.test(det.rows[0].src) && det.rows[1].svc === "Recharge de climatisation" && near(num(det.rows[1].val), pC) && det.rows[2].tot && near(num(det.rows[2].val), pV + pC) && /Les promotions ne sont pas déduites/.test(det.note), JSON.stringify(det));
    check("R7 the map bar says « Total 2 prestations » and the total", /Total 2 prestations/.test(det.bar) && /total \d/.test(det.bar), det.bar);
    await filterBy(page, "price", "priced");
    cards = await cardsOf(page);
    check("R8 « Avec prix » keeps complete totals only", cards.length > 0 && cards.every((c) => c.tag === "Total 2 prestations"), JSON.stringify(cards.map((c) => c.tag).slice(0, 10)));
    await clearFilters(page);
    await pickServices(page, ["vidange", "revision"]);
    await page.waitForTimeout(300);
    cards = await cardsOf(page);
    const nor2 = cards.find((c) => /^Norauto/.test(c.name));
    const sum2 = norm(await page.textContent("#summary"));
    check("R9 a service without any national price (révision): totals are partial, « + 1 sur devis », never shown as complete", nor2 && nor2.tag === "Total partiel" && near(num(nor2.price), pV) && /\+ 1 sur devis/.test(nor2.price) && !cards.some((c) => c.tag === "Total 2 prestations"), JSON.stringify(nor2));
    check("R10 ...and the summary says the totals are partial", /Aucun garage n'affiche un prix pour chacune des 2 prestations : les totaux sont partiels\./.test(sum2), sum2);
    await pickServices(page, "vidange");
    await page.waitForTimeout(300);
    cards = await cardsOf(page);
    const nor3 = cards.find((c) => /^Norauto/.test(c.name));
    check("R11 back to one service: the card shows that service's price as before (« Prix enseigne »), the bar has no « +N »", nor3 && near(num(nor3.price), pV) && nor3.tag === "Prix enseigne" && (await picker(page)).bar[1] === "", JSON.stringify(nor3));
    await pickServices(page, "ct");
    await page.waitForTimeout(300);
    const st = norm(await page.textContent("#status"));
    check("R12 choosing the contrôle technique asks for a new search (other places, official prices)", /Lancez la recherche pour charger les prix officiels du contrôle technique\./.test(st), st);
    check("R13 no console error", !logs.errors.length && !logs.console.length, JSON.stringify([logs.errors, logs.console]));
    await ctx.close();

    // =============== S. Mémoire : la sélection revient au rechargement ===============
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: ELEMENTS }, storage: { "jg.last.v1": { svc: "geo_av", svcs: ["geo_av", "montage"], km: "10", place: null, sirene: false } } }));
    s = await picker(page);
    check("S1 reloaded, the bar names the saved services (« Parallélisme / géométrie avant » +1)", s.bar[0] === "Parallélisme / géométrie avant" && s.bar[1] === "+1", JSON.stringify(s.bar));
    await openPicker(page);
    s = await picker(page);
    check("S2 ...and the window ticks them both", JSON.stringify(s.checked) === JSON.stringify(["geo_av", "montage"]), JSON.stringify(s.checked));
    await page.keyboard.press("Escape");
    await ctx.close();
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: ELEMENTS }, storage: { "jg.last.v1": { svc: "ct", svcs: ["ct", "vidange", "nope"], km: "10", place: null, sirene: false } } }));
    s = await picker(page);
    check("S3 a tampered memory (contrôle technique with another service, unknown id) falls back to the contrôle technique alone", /^Contrôle technique/.test(s.bar[0]) && s.bar[1] === "", JSON.stringify(s.bar));
    await ctx.close();

    // =============== M. Mobile : la fenêtre en feuille, « Valider » toujours à l'écran ===============
    for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
      ({ page, ctx, logs } = await open(browser, server, FILE, { ...vp, dpr: 2, touch: true, mock: { elements: ELEMENTS } }));
      await openPicker(page);
      for (const cb of await page.$$("#svcList input:checked")) await cb.uncheck();
      for (const id of ["vidange", "clim", "diag"]) await page.check(`#svcList input[value='${id}']`);
      const geo = await page.evaluate(() => {
        const go = document.getElementById("svcGo").getBoundingClientRect(), list = document.getElementById("svcList");
        const at = document.elementFromPoint(go.left + go.width / 2, go.top + go.height / 2);
        return { goBottom: Math.round(go.bottom), vh: innerHeight, hit: at && at.id, listScrolls: list.scrollHeight > list.clientHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1, focus: document.activeElement && document.activeElement.type };
      });
      check(`M1 [${vp.width} px] the sheet keeps « Valider » on screen and clickable, only the list scrolls`, geo.goBottom <= geo.vh && geo.hit === "svcGo" && geo.listScrolls && !geo.overflowX, JSON.stringify(geo));
      check(`M2 [${vp.width} px] on a touch screen the keyboard does not pop up: the focus goes to the ticked service, not the search field`, geo.focus === "checkbox", JSON.stringify(geo));
      await page.click("#svcGo");
      await page.waitForSelector("#svcDlg", { state: "hidden" });
      await search(page, {});
      const sumSvc = norm(await page.textContent("#sumSvc"));
      check(`M3 [${vp.width} px] the folded search summary names the choice (« … +2 »)`, /Vidange \(huile \+ filtre\) \+2/.test(sumSvc), sumSvc);
      cards = await cardsOf(page);
      check(`M4 [${vp.width} px] cards show totals, no sideways scroll`, cards.some((c) => /^Total/.test(c.tag)) && !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), JSON.stringify(cards.slice(0, 2)));
      check(`M5 [${vp.width} px] no console error`, !logs.errors.length && !logs.console.length, JSON.stringify([logs.errors, logs.console]));
      await ctx.close();
    }

    // =============== K. Clavier ===============
    ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: ELEMENTS } }));
    await page.focus("#svcBtn");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#svcDlg[open]");
    await page.keyboard.type("clim");
    // dans l'ordre de l'écran : la recherche, les pastilles (le bouton × de la prestation déjà choisie), puis la liste
    const onBox = () => page.evaluate(() => (document.activeElement.type === "checkbox" ? document.activeElement.value : ""));
    for (let i = 0; i < 4 && (await onBox()) !== "clim"; i++) await page.keyboard.press("Tab");
    const k1 = await onBox();
    await page.keyboard.press("Space");
    s = await picker(page);
    check("K1 keyboard only: Enter opens, typing filters, Tab goes through the chips to the matching box, Space ticks it", k1 === "clim" && s.checked.includes("clim"), JSON.stringify([k1, s.checked]));
    for (let i = 0; i < 40 && (await page.evaluate(() => document.activeElement.id)) !== "svcGo"; i++) await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    s = await picker(page);
    check("K2 ...Tab reaches « Valider », Enter applies, the focus is back on the bar's button", !s.open && s.bar[1] === "+1" && s.focus === "svcBtn", JSON.stringify(s));
    await ctx.close();

    // =============== A. Accessibilité (axe) : la fenêtre ouverte et une liste de totaux ===============
    for (const scheme of ["light", "dark"]) {
      ({ page, ctx } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: scheme, mock: { elements: ELEMENTS } }));
      await openPicker(page);
      await page.check("#svcList input[value='vidange']");
      await page.check("#svcList input[value='clim']");
      let v = await axeRun(page);
      check(`A1 [${scheme}] axe: no violation with the window open and two chips`, !v.length, JSON.stringify(v));
      await page.click("#svcGo");
      await search(page, {});
      await page.click("#list > li:nth-child(1) .g-main");
      await page.waitForTimeout(400);
      v = await axeRun(page);
      check(`A2 [${scheme}] axe: no violation with totals and an open card detailing them`, !v.length, JSON.stringify(v));
      await ctx.close();
    }
    ({ page, ctx } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true, mock: { elements: ELEMENTS } }));
    await openPicker(page);
    const v = await axeRun(page);
    check("A3 [mobile] axe: no violation with the sheet open", !v.length, JSON.stringify(v));
    await ctx.close();
  } catch (e) {
    check("services suite crashed", false, e && e.stack);
  }
  await browser.close();
  server.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`[services] ${ok}/${results.length} checks passed`);
  for (const r of results.filter((r) => !r.ok)) console.log("  ✗", r.name);
  process.exit(ok === results.length ? 0 : 1);
})();
