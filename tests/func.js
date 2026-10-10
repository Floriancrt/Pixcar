// Functional tests. Same scenarios run on the original and on the refreshed page;
// semantic snapshots are written to JSON so the two can be diffed (non-regression of data + logic).
// Checks tagged [new] only apply to the refreshed UI.
const { serve, launch, open, search, shot, markerPoint, ROOT, sortBy, pickServices, filterBy, clearFilters, editSearch } = require("./harness");
const fs = require("fs");
const path = require("path");

const FILE = process.argv[2] || "index.html";
const TAG = process.argv[3] || "new";
const IS_NEW = TAG !== "orig";
const results = [];
const snaps = {};
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail: cond ? "" : String(detail) });
  if (!cond) console.log("  FAIL:", name, "|", detail);
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

// ---- extractors (work on both versions) ----
async function cards(page, n = 40) {
  return page.evaluate((n) => {
    const t = (e, s) => { const x = e.querySelector(s); return x ? x.textContent.replace(/\s+/g, " ").trim() : ""; };
    return [...document.querySelectorAll("#list > li.card")].slice(0, n).map((c) => ({
      id: c.dataset.id,
      name: t(c, ".g-name"),
      kind: t(c, ".kind"),
      price: t(c, ".amount") || t(c, ".no-price"),
      tag: t(c, ".g-price .tag"),
      avail: (c.querySelector(".kind") || { getAttribute: () => "" }).getAttribute("title") || "",
      promo: t(c, ".g-promo"),
      rating: t(c, ".rating"),
      dist: t(c, ".borne") || t(c, ".dist"),
      actions: [...c.querySelectorAll(".g-actions a")].map((a) => a.textContent.trim() + "→" + a.getAttribute("href")),
    }));
  }, n);
}
const summaryText = (page) => page.$eval("#summary", (e) => e.textContent.replace(/\s+/g, " ").trim());
const toolbarState = (page) =>
  page.evaluate(() => ({
    sort: [...document.querySelectorAll("[data-sort]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.sort),
    filter: [...document.querySelectorAll("[data-ftype], [data-fprice]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.ftype || b.dataset.fprice),
  }));
const listCount = (page) => page.$$eval("#list > li.card", (l) => l.length);

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();

  // =============== A. OSM search, sort, filters, pagination, radius ===============
  let { page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 });
  await search(page, { service: "vidange" });
  snaps.A_summary = await summaryText(page);
  snaps.A_cards = await cards(page);
  check("A1 40 cards on first page", (await listCount(page)) === 40, await listCount(page));
  check("A2 'Afficher plus' visible", await page.isVisible("#moreBtn"));
  snaps.A_moreLabel = norm(await page.textContent("#moreBtn"));
  await page.click("#moreBtn");
  await page.waitForTimeout(200);
  check("A3 after 'Afficher plus' all 66 cards", (await listCount(page)) === 66, await listCount(page));
  check("A3b 'Afficher plus' hidden when exhausted", !(await page.isVisible("#moreBtn")));

  await sortBy(page, "dist");
  await page.waitForTimeout(200);
  snaps.A_sortDist = (await cards(page, 12)).map((c) => `${c.name}|${c.dist}|${c.price}`);
  await sortBy(page, "note");
  await page.waitForTimeout(200);
  snaps.A_sortNote = (await cards(page, 6)).map((c) => `${c.name}|${c.price}`);
  await sortBy(page, "price");
  // une seule dimension de filtre à la fois, comme les pastilles d'avant (« Avec prix », « En promo », « Enseignes », « Indépendants »)
  const FILTER = { priced: ["price", "priced"], promo: ["price", "promo"], chains: ["type", "chains"], indep: ["type", "indep"] };
  for (const f of Object.keys(FILTER)) {
    await clearFilters(page);
    await filterBy(page, ...FILTER[f]);
    await page.waitForTimeout(150);
    snaps["A_filter_" + f] = { n: await listCount(page), first: (await cards(page, 5)).map((c) => c.name), tb: await toolbarState(page) };
  }
  await clearFilters(page);
  await filterBy(page, "chain", "norauto");
  await page.waitForTimeout(150);
  snaps.A_chain_norauto = { n: await listCount(page), names: (await cards(page, 10)).map((c) => c.name) };
  await filterBy(page, "chain", "norauto");
  await editSearch(page);
  await page.selectOption("#radius", "5");
  await page.waitForTimeout(300);
  snaps.A_radius5 = { summary: await summaryText(page), n: await listCount(page) };
  // widening beyond the fetched radius must NOT silently re-fetch
  await page.selectOption("#radius", "20");
  await page.waitForTimeout(200);
  snaps.A_radius20_status = norm(await page.textContent("#status"));
  check("A4 console clean (OSM flow)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
  await ctx.close();

  // =============== B. Contrôle technique ===============
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  await pickServices(page, "ct");
  check("B1 the button keeps « Comparer » and its accessible name switches to the inspection centres", norm(await page.textContent("#goLabel")) === "Comparer" && (await page.getAttribute("#go", "aria-label")) === "Comparer les centres de contrôle technique", await page.getAttribute("#go", "aria-label"));
  check("B2 energy field shown for CT", await page.isVisible("#energyField"));
  await page.fill("#address", "lyon");
  await page.waitForSelector("#addrList li[data-i]");
  await page.click("#addrList li[data-i='0']");
  await page.click("#go");
  await page.waitForSelector("#list > li.card", { timeout: 12000 });
  snaps.B_summary = await summaryText(page);
  snaps.B_cards = await cards(page);
  await page.selectOption("#energy", "Diesel");
  await page.waitForTimeout(250);
  snaps.B_diesel = (await cards(page, 8)).map((c) => `${c.name}|${c.price}`);
  check("B3 CT cards carry official price tag", snaps.B_cards.every((c) => /Prix officiel|Prix non déclaré|^$/.test(c.tag) || c.price.includes("non")), JSON.stringify(snaps.B_cards.map((c) => c.tag)));
  check("B4 console clean (CT flow)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
  await ctx.close();

  // =============== C. Repairs: dialog → save → fiche → delete/undo (no « Mes réparations » tab) ===============
  const declare = async (page, price = "59,90") => {
    await page.click("#addRepairBtn");
    await page.fill("#rGarage", "Norauto");
    await page.waitForSelector("#rGarageList li[data-i]", { state: "visible" });
    await page.click("#rGarageList li[data-i='0']");
    await page.fill("#rModel", "peugeot 208");
    if (IS_NEW) {
      await page.fill("#rPlate", "ez108bc");
      await page.fill("#rYear", "2019");
    }
    await page.fill("#rPrice", price);
    await page.click("label[for=rSt4]");
    await page.fill("#rComment", "Très bien, rapide.");
    await page.click("#repairForm button[type=submit]");
    await page.waitForTimeout(500);
  };
  const storedRepairs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("jg.repairs.v1") || "[]"));
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  await search(page, { service: "vidange" });
  await page.click("#addRepairBtn");
  check("C1 dialog opens", await page.$eval("#repairDlg", (d) => d.open));
  await page.click("#repairForm button[type=submit]");
  const errs = await page.$$eval("#repairForm [aria-invalid=true]", (l) => l.length);
  check("C2 empty submit flags invalid fields", errs >= 4, errs);
  await page.click("#dlgCancel");
  await declare(page);
  const toast1 = norm(await page.textContent("#toast"));
  snaps.C_toast = toast1.replace(/Annuler$/, "").trim();
  check("C3 toast confirms saving, with Annuler", /Réparation enregistrée/.test(toast1) && /Annuler$/.test(toast1), toast1);
  check("C4 dialog closed", !(await page.$eval("#repairDlg", (d) => d.open)));
  check("C5 two tabs only: no « Mes réparations » tab, badge, view or second add button", await page.evaluate(() => [...document.querySelectorAll(".tab")].map((t) => t.dataset.view).join() === "garages,prix" && !document.querySelector("#repBadge, #view-reparations, #addRepairBtn2, #repGroups")));
  const stored = await storedRepairs(page);
  check("C6 localStorage has the repair", stored.length === 1 && stored[0].price === 59.9 && stored[0].model === "Peugeot 208" && stored[0].rating === 4, JSON.stringify(stored));
  if (IS_NEW) check("C6b [new] the repair carries the plate (normalised) and the model year", stored[0].immat === "EZ-108-BC" && stored[0].year === 2019, JSON.stringify(stored));
  snaps.C_stored = stored.map(({ id, createdAt, garageId, lat, lon, immat, year, ...r }) => r);
  snaps.C_cardAfter = (await cards(page, 40)).filter((c) => /Prix déclaré/.test(c.tag)).map((c) => `${c.name}|${c.price}|${c.tag}`);
  const hist = () => page.evaluate(() => {
    const d = document.querySelector("#list .card.is-open details.history");
    return d ? { open: d.open, rows: [...d.querySelectorAll(".h-rows li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()), del: d.querySelectorAll(".h-del").length, label: (d.querySelector(".h-del") || { getAttribute: () => "" }).getAttribute("aria-label") } : null;
  });
  let h = await hist();
  check("C7 saving opens the garage card on its history: the new row and a Supprimer button", h && h.open && h.rows.length === 1 && /59,90/.test(h.rows[0]) && h.del === 1 && /^Supprimer votre réparation : /.test(h.label), JSON.stringify(h));
  check("C7b the new row shows the model with its year, never the plate or the comment", h && /Peugeot 208/.test(h.rows[0]) && /2019/.test(h.rows[0]) && !/EZ-108-BC|Très bien/.test(h.rows[0]), JSON.stringify(h));
  await page.click("#list .card.is-open .h-del");
  await page.waitForTimeout(250);
  const toast2 = norm(await page.textContent("#toast"));
  check("C8 Supprimer → toast « Réparation supprimée » with Annuler", /Réparation supprimée/.test(toast2) && /Annuler$/.test(toast2), toast2);
  check("C9 deleted: storage empty, history gone, price no longer « déclaré »", (await storedRepairs(page)).length === 0 && (await hist()) === null && !(await page.$$eval("#list > li.card", (l) => l.some((c) => c.querySelector(".g-price .tag.info")))));
  check("C9b focus is not lost on <body> after deleting", await page.evaluate(() => document.activeElement !== document.body && !!document.activeElement.closest("#list")), await page.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 120)));
  await page.click("#toast button");
  await page.waitForTimeout(250);
  h = await hist();
  check("C10 undo restores the repair (storage + history row)", (await storedRepairs(page)).length === 1 && h && h.rows.length === 1, JSON.stringify(h));
  check("C11 console clean (repairs flow)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
  await ctx.close();

  // « Annuler » on the save message withdraws the repair just declared; without a user session, nothing else remains of it
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  await search(page, { service: "vidange" });
  await declare(page);
  await page.click("#toast button");
  await page.waitForTimeout(250);
  check("C12 Annuler on the save toast removes the repair and says so", (await storedRepairs(page)).length === 0 && /Réparation annulée/.test(norm(await page.textContent("#toast"))) && !(await page.$$eval("#list > li.card", (l) => l.some((c) => c.querySelector(".g-price .tag.info")))), norm(await page.textContent("#toast")));
  check("C12b the toast offers no further action once cancelled", (await page.$$("#toast button")).length === 0);
  // declared from the « Prix et promos » tab: saved, the toast says where it will show
  await page.click(".tab[data-view=prix]");
  await declare(page, "64,50");
  const toast3 = norm(await page.textContent("#toast"));
  check("C13 declaring from another tab: saved, and the toast points at the garage fiche", /Réparation enregistrée/.test(toast3) && /fiche de ce garage/.test(toast3) && (await storedRepairs(page)).length === 1, toast3);
  await page.click(".tab[data-view=garages]");
  await page.waitForTimeout(250);
  check("C14 back on the main tab, the repair already counts (declared price on the card)", (await page.$$eval("#list > li.card", (l) => l.some((c) => c.querySelector(".g-price .tag.info")))));
  check("C15 console clean (second flow)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
  await ctx.close();

  // =============== E. Navigation (tabs, hash, history) ===============
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  const cur = () => page.$eval(".tab[aria-current=page]", (e) => e.dataset.view);
  check("E1 default tab = garages", (await cur()) === "garages");
  await page.click(".tab[data-view=prix]");
  check("E2 prix tab", (await cur()) === "prix" && (await page.isVisible("#view-prix")) && !(await page.isVisible("#view-garages")));
  check("E3 hash updated", (await page.evaluate(() => location.hash)) === "#prix");
  await page.goBack();
  await page.waitForTimeout(150);
  check("E4 back returns to garages", (await cur()) === "garages");
  await page.evaluate(() => (location.hash = "#prix"));
  await page.waitForTimeout(150);
  check("E5 hash navigation", (await cur()) === "prix");
  await page.evaluate(() => (location.hash = "#reparations"));
  await page.waitForTimeout(150);
  check("E6 an old #reparations link lands on the main tab", (await cur()) === "garages" && !(await page.$eval("#view-garages", (e) => e.hidden)) && (await page.$eval("#view-prix", (e) => e.hidden)));
  await page.selectOption("#refService", "montage").catch(() => {});
  await ctx.close();

  // =============== F. Reload restores last search from cache ===============
  ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
  await search(page, { service: "geo_av" });
  const html0 = await page.evaluate(() => ({ ls: Object.fromEntries(Object.entries(localStorage)) }));
  await page.reload();
  await page.waitForTimeout(800);
  check("F1 reload restores results from cache", (await listCount(page)) > 0, await listCount(page));
  check("F2 reload restores address", norm(await page.inputValue("#address")).includes("République"), await page.inputValue("#address"));
  snaps.F_summary = (await page.isVisible("#summary")) ? await summaryText(page) : "";
  await ctx.close();

  // =============== D. New behaviours (refreshed UI only) ===============
  if (IS_NEW) {
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    check("D0 desktop home: hero and search card shown, no map before a search (it comes with the results)", (await page.isVisible(".hero")) && (await page.isVisible("#searchForm")) && !(await page.isVisible("#stage")));
    check("D0b desktop: FAB hidden", !(await page.isVisible("#mapFab")));
    await search(page, { service: "vidange" });
    const stg = await page.evaluate(() => {
      const r = document.getElementById("stage").getBoundingClientRect(), h = document.querySelector(".topbar").getBoundingClientRect(), l = document.getElementById("listPane").getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, head: h.bottom, listRight: l.right, pos: getComputedStyle(document.getElementById("stage")).position, iw: document.documentElement.clientWidth, ih: innerHeight };
    });
    check("D0c desktop results: the map is a sticky right-hand column (28.3 % of the width) from under the header to the bottom of the window, right of the table", stg.pos === "sticky" && Math.abs(stg.right - stg.iw) <= 1 && Math.abs(stg.w - 0.283 * stg.iw) <= 2 && Math.abs(stg.top - stg.head) <= 1 && Math.abs(stg.bottom - stg.ih) <= 1 && stg.listRight <= stg.left, JSON.stringify(stg));
    check("D0d placeholder gone after search", !(await page.isVisible(".map-empty")) && (await page.isVisible("#mapPane")));
    const st = () => page.evaluate(() => ({
      open: [...document.querySelectorAll(".card.is-open")].map((c) => c.dataset.id),
      sel: [...document.querySelectorAll(".card.is-selected")].map((c) => c.dataset.id),
      bar: !document.getElementById("mapInfo").hidden,
      barTitle: (document.querySelector("#mapInfo .mi-title") || {}).textContent || "",
      markers: (() => { const m = (window.__maps || [])[0], out = []; m && m.eachLayer((l) => { if (l.jg && l.jgOn) out.push(l.jg.id); }); return out; })(),
      halo: (() => { const m = (window.__maps || [])[0]; let n = 0; m && m.eachLayer((l) => { if (l.options && l.options.radius === 22) n++; }); return n; })(),
    }));
    let s = await st();
    check("D1 nothing selected initially", !s.open.length && !s.sel.length && !s.bar && !s.markers.length, JSON.stringify(s));
    await page.click("#list > li:nth-child(3) .g-main");
    s = await st();
    const id3 = await page.$eval("#list > li:nth-child(3)", (e) => e.dataset.id);
    check("D2 click card → opened + selected + bar + marker + halo", s.open[0] === id3 && s.sel[0] === id3 && s.bar && s.markers[0] === id3 && s.halo === 1, JSON.stringify(s));
    check("D2b info bar title = card name", norm(s.barTitle) === norm(await page.textContent("#list > li:nth-child(3) .g-name")), s.barTitle);
    await page.click("#list > li:nth-child(5) .g-main");
    s = await st();
    const id5 = await page.$eval("#list > li:nth-child(5)", (e) => e.dataset.id);
    check("D3 accordion: one open card, selection moved", s.open.length === 1 && s.open[0] === id5 && s.sel[0] === id5 && s.markers.length === 1 && s.markers[0] === id5 && s.halo === 1, JSON.stringify(s));
    await page.click("#list > li:nth-child(5) .g-name");
    s = await st();
    check("D4 toggling the open card clears selection", !s.open.length && !s.sel.length && !s.bar && !s.markers.length && s.halo === 0, JSON.stringify(s));
    // marker for a garage NOT rendered yet (beyond first 40)
    const rendered = await page.$$eval("#list > li.card", (l) => l.map((c) => c.dataset.id));
    const far = await page.evaluate((rendered) => {
      const m = window.__maps[0], out = [];
      m.eachLayer((l) => { if (l.jg && !rendered.includes(l.jg.id)) { const p = m.latLngToContainerPoint(l.getLatLng()), r = m.getContainer().getBoundingClientRect(), pr = document.getElementById("panelCol").getBoundingClientRect(); if (p.x + r.left > pr.right + 60 && p.y > 120 && p.y < 700) out.push({ x: p.x + r.left, y: p.y + r.top, id: l.jg.id }); } });
      return out[0];
    }, rendered);
    check("D5a found a marker beyond the first page", !!far);
    if (far) {
      await page.mouse.click(far.x, far.y);
      await page.waitForTimeout(700);
      s = await st();
      check("D5 clicking a far marker renders + opens + selects its card", s.open[0] === far.id && s.sel[0] === far.id && s.bar, JSON.stringify({ ...s, far: far.id }));
      // Le défilement est lissé (scrollIntoView « smooth ») : mesuré, la carte entre dans la fenêtre du panneau 650 à 680 ms après le clic et le
      // défilement s'arrête vers 730 à 760 ms. Une attente fixe de 700 ms est donc trop juste (échec de temps en temps) : on attend l'état voulu, avec une échéance.
      // c'est la page qui défile : la ligne doit arriver dans la fenêtre, sous l'en-tête collé (pas dessous)
      const inPanel = () => page.$eval(`[data-id="${far.id}"]`, (c) => { const r = c.getBoundingClientRect(), h = document.querySelector(".topbar").getBoundingClientRect().bottom; return r.top >= h - 2 && r.top < innerHeight - 40; });
      for (let i = 0; i < 40 && !(await inPanel()); i++) await page.waitForTimeout(50);
      check("D5b the row is scrolled into the window, just under the sticky header", await inPanel(), await page.$eval(`[data-id="${far.id}"]`, (c) => [c.getBoundingClientRect().top, document.querySelector(".topbar").getBoundingClientRect().bottom, innerHeight]));
    }
    // selecting an unpriced garage then filtering on priced clears the selection
    await page.evaluate(() => window.scrollTo(0, 0));
    const unpriced = await page.evaluate(() => { const c = [...document.querySelectorAll("#list > li.card")].find((c) => c.querySelector(".no-price")); return c && c.dataset.id; });
    check("D6a found an unpriced card", !!unpriced);
    if (unpriced) {
      await page.click(`[data-id="${unpriced}"] .g-main`);
      await filterBy(page, "price", "priced");
      await page.waitForTimeout(250);
      s = await st();
      check("D6 filter hiding the selected garage clears selection + bar", !s.sel.length && !s.bar && !s.markers.length, JSON.stringify(s));
    }
    await clearFilters(page);
    // new search clears selection
    await page.click("#list > li:nth-child(2) .g-main");
    await editSearch(page);
    await page.selectOption("#radius", "5");
    await page.click("#go");
    await page.waitForTimeout(900);
    s = await st();
    check("D7 new search clears selection", !s.sel.length && !s.bar && !s.markers.length, JSON.stringify(s));
    // keyboard: name button toggles
    await page.focus("#list > li:nth-child(2) .g-name");
    await page.keyboard.press("Enter");
    s = await st();
    check("D8 keyboard Enter on card name opens + selects", s.open.length === 1 && s.sel.length === 1 && s.bar, JSON.stringify(s));
    check("D8b aria-expanded reflects state", (await page.getAttribute("#list > li:nth-child(2) .g-name", "aria-expanded")) === "true");
    // info-bar close also collapses the card
    await page.click("#mapInfo [data-mi=close]");
    s = await st();
    check("D9 info-bar × closes card and selection", !s.open.length && !s.sel.length && !s.bar, JSON.stringify(s));
    check("D9b focus returns to the card title after closing the bar", await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("g-name")), await page.evaluate(() => document.activeElement && document.activeElement.outerHTML.slice(0, 80)));
    // clicked card stays put when an open card above it collapses (scroll compensation)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click("#list > li:nth-child(2) .g-main");
    await page.evaluate(() => window.scrollBy(0, document.querySelector("#list > li:nth-child(9)").getBoundingClientRect().top - 300)); // c'est la page qui défile
    await page.waitForTimeout(150);
    const y0 = await page.$eval("#list > li:nth-child(9)", (e) => e.getBoundingClientRect().top);
    await page.mouse.click(300, y0 + 25);
    await page.waitForTimeout(150);
    const y1 = await page.$eval("#list > li:nth-child(9)", (e) => e.getBoundingClientRect().top);
    s = await st();
    const id9 = await page.$eval("#list > li:nth-child(9)", (e) => e.dataset.id);
    check("D21 card above collapses, clicked card stays in place", y0 > 150 && y0 < 700 && Math.abs(y1 - y0) < 3 && s.open.length === 1 && s.open[0] === id9, JSON.stringify({ y0, y1, open: s.open, id9 }));
    await page.click("#mapInfo [data-mi=close]");
    // la carte a sa colonne : le cercle de recherche y est centré et entier
    const fit = await page.evaluate(() => { const m = window.__maps[0], sz = m.getSize(); let c = null; m.eachLayer((l) => { if (l.options && l.options.dashArray && l.getLatLng) c = l; }); const p = m.latLngToContainerPoint(c.getLatLng()), b = c.getBounds(), nw = m.latLngToContainerPoint(b.getNorthWest()), se = m.latLngToContainerPoint(b.getSouthEast()); return { cx: Math.round(p.x), w: sz.x, h: sz.y, l: Math.round(nw.x), t: Math.round(nw.y), r: Math.round(se.x), b: Math.round(se.y) }; });
    check("D10 search circle centred in the map column and wholly inside it", Math.abs(fit.cx - fit.w / 2) <= 2 && fit.l >= 0 && fit.t >= 0 && fit.r <= fit.w && fit.b <= fit.h, JSON.stringify(fit));
    await ctx.close();

    // ---- preview mode: banner must be visible on desktop ----
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, mock: { geocodeFail: true } }));
    await page.waitForTimeout(600);
    const ban = await page.evaluate(() => { const b = document.getElementById("modeBanner"); if (b.hidden) return { hidden: true }; const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hidden: false, covered: !(top === b || b.contains(top)), r: [r.left, r.top, r.width, r.height] }; });
    check("D11 preview banner visible and not covered (desktop)", ban.hidden === false && ban.covered === false, JSON.stringify(ban));
    await ctx.close();

    // ---- mobile: map mode ----
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 390, height: 844, dpr: 2, touch: true }));
    check("D12 mobile: no bar at the bottom: the link to the other section sits in the header", await page.$eval("#tabs", (e) => { const r = e.getBoundingClientRect(), t = document.querySelector(".topbar").getBoundingClientRect(); return getComputedStyle(e).position === "static" && r.top >= t.top && r.bottom <= t.bottom; }));
    check("D12b mobile: stage hidden in list mode", !(await page.isVisible("#stage")));
    await search(page, { service: "vidange" });
    check("D13 mobile: FAB visible after search", await page.isVisible("#mapFab"));
    await page.click("#mapFab");
    await page.waitForTimeout(900);
    check("D14 mobile: map mode shows stage, hides panel", (await page.evaluate(() => document.body.classList.contains("is-map"))) && (await page.isVisible("#stage")) && !(await page.isVisible("#panelCol")));
    check("D14b FAB now says Liste", /Liste/.test(await page.textContent("#mapFab")));
    let mp = await markerPoint(page, 6);
    await page.touchscreen.tap(mp.x, mp.y);
    await page.waitForTimeout(700);
    s = await page.evaluate(() => ({ bar: !document.getElementById("mapInfo").hidden, cta: !!document.querySelector("#mapInfo [data-mi=card]") }));
    check("D15 mobile: marker tap shows info bar with 'Voir la fiche'", s.bar && s.cta, JSON.stringify(s));
    check("D15b still in map mode (no jump to list)", await page.evaluate(() => document.body.classList.contains("is-map")));
    const attr = await page.evaluate(() => { const a = document.querySelector(".leaflet-control-attribution").getBoundingClientRect(), b = document.getElementById("mapInfo").getBoundingClientRect(); return { aTop: a.top, aBottom: a.bottom, barBottom: b.bottom, vh: innerHeight }; });
    check("D15c attribution not covered by the info bar, and on screen (no bar at the bottom any more)", attr.aTop >= attr.barBottom - 1 && attr.aBottom <= attr.vh, JSON.stringify(attr));
    await page.click("#mapInfo [data-mi=card]");
    await page.waitForTimeout(900);
    s = await page.evaluate(() => ({ map: document.body.classList.contains("is-map"), open: document.querySelectorAll(".card.is-open").length, sel: document.querySelectorAll(".card.is-selected").length, panel: !document.getElementById("panelCol").hidden && getComputedStyle(document.getElementById("panelCol")).display !== "none" }));
    check("D16 'Voir la fiche' → list mode, card open + selected", !s.map && s.open === 1 && s.sel === 1 && s.panel, JSON.stringify(s));
    check("D17 console clean (mobile)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
    await ctx.close();

    // ---- live resize: mobile map mode -> desktop must restore the panel (tablet rotation) ----
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 820, height: 1180 }));
    await search(page, { service: "vidange" });
    await page.click("#mapFab");
    await page.waitForTimeout(800);
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.waitForTimeout(800);
    const rz = await page.evaluate(() => { const p = document.getElementById("panelCol"), r = p.getBoundingClientRect(), m = window.__maps[0], c = m.getContainer().getBoundingClientRect(); return { panelVisible: getComputedStyle(p).display !== "none" && r.width > 300, fab: getComputedStyle(document.getElementById("mapFab")).display, mapW: Math.round(c.width), mapSize: m.getSize().x, col: Math.round(document.getElementById("stage").getBoundingClientRect().width), vw: document.documentElement.clientWidth }; });
    check("D22 rotate tablet from map mode to desktop width: panel back, map resized to its column, FAB hidden", rz.panelVisible && rz.fab === "none" && Math.abs(rz.col - 0.283 * rz.vw) <= 2 && rz.mapW === rz.col && rz.mapSize === rz.mapW, JSON.stringify(rz));
    await ctx.close();

    // ---- un seul thème (clair), même quand le système est réglé en sombre + reduced motion ----
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, colorScheme: "dark" }));
    const dk = await page.evaluate(() => ({ card: getComputedStyle(document.documentElement).getPropertyValue("--card").trim(), scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.body).backgroundColor, sysDark: matchMedia("(prefers-color-scheme: dark)").matches }));
    check("D18 system set to dark: the page stays light (light tokens, color-scheme light)", dk.sysDark && dk.card.toLowerCase() === "#ffffff" && dk.scheme === "light" && dk.bg === "rgb(246, 244, 240)", JSON.stringify(dk));
    await ctx.close();
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900, reducedMotion: "reduce" }));
    await search(page, { service: "vidange" });
    await page.click("#list > li:nth-child(2) .g-main");
    const dur = await page.$eval("#list > li:nth-child(2) .g-more", (e) => getComputedStyle(e).animationDuration);
    check("D19 reduced motion: reveal animation neutralised", parseFloat(dur) < 0.01, dur);
    await ctx.close();

    // ---- plus de thème sombre à forcer : data-theme="dark" ne change rien ----
    ({ page, ctx, logs } = await open(browser, server, FILE, { width: 1440, height: 900 }));
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const lt = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--card").trim());
    check("D20 data-theme=dark is ignored (no dark theme left in the stylesheet)", lt.toLowerCase() === "#ffffff", lt);
    await ctx.close();
  }

  await browser.close();
  server.close();
  fs.writeFileSync(path.join(__dirname, ".out", "shots", `func-${TAG}.json`), JSON.stringify(snaps, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[${TAG}] ${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log("  ✗", f.name, "-", f.detail.slice(0, 300)));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
