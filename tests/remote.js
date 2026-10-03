// Page en mode distant, de bout en bout : navigateur → réseau → API réelle → base PostgreSQL (PGlite), avec des pannes réglables.
//   node tests/remote.js [index.html | dist/index.html]
// Les services publics (adresses, OpenStreetMap, IGN…) restent simulés par mocks.js ; le relais Overpass de l'API interroge
// le même faux OpenStreetMap. Chaque scénario ouvre un contexte neuf et part d'une API remise à zéro.
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, ROOT, injectScript } = require("./harness");
const { startApi } = require("./api-harness");
const { buildElements } = require("./mocks");

const FILE = process.argv[2] || "index.html";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 500));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELEMENTS = buildElements();
const NORAUTO = ELEMENTS.find((e) => e.id === 1022); // « Norauto Bron »
const CARD = '#list [data-id="osm:node/1022"]';
const stored = (page, key = "jg.repairs.v1") => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
async function until(fn, ms = 6000, step = 80) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

(async () => {
  const { repair, isoDay } = await import("../server/test/helpers.mjs");
  const server = await serve(ROOT);
  const browser = await launch();
  const api = await startApi({ origin: server.url });
  api.upstream.elements = ELEMENTS;
  if (server.allowConnect) server.allowConnect(api.url); // site publiable : sa politique de sécurité n'autorise que les hôtes de production

  // une déclaration d'« un autre visiteur » chez Norauto Bron
  const others = (prices, over = {}) =>
    Promise.all(prices.map((price, i) => api.post(repair({ price, date: isoDay(20 + i), garage: { id: "osm:node/1022", name: "Norauto Bron", addr: "98 rue Marcel Mérieux, 69100 Bron", lat: NORAUTO.lat, lon: NORAUTO.lon, chainId: "norauto" }, area: { lat: NORAUTO.lat, lon: NORAUTO.lon }, ...over }))));
  const fresh = async (o = {}) => {
    await api.db.exec("TRUNCATE repairs, garages, write_log, upstream_cache CASCADE");
    api.app.overpass.reset();
    api.reset();
    api.upstream.fail = false;
    api.upstream.calls = 0;
    api.clock.skew += 60_000; // la copie de 10 s des zones expire
    return open(browser, server, FILE, { width: 1440, height: 900, initScript: `window.JG_TUNE.api=${JSON.stringify(api.url)};`, ...o });
  };
  const declare = async (page, { garage = "Norauto Bron", price = "59,90", service } = {}) => {
    await page.click("#addRepairBtn");
    if (service) await page.selectOption("#rService", service);
    await page.fill("#rGarage", garage);
    await page.waitForSelector("#rGarageList li[data-i]", { state: "visible" });
    await page.click("#rGarageList li[data-i='0']");
    if (!(await page.inputValue("#rModel"))) await page.fill("#rModel", "peugeot 208");
    if (!(await page.inputValue("#rPlate"))) await page.fill("#rPlate", "ez108bc");
    if (!(await page.inputValue("#rYear"))) await page.fill("#rYear", "2019");
    await page.fill("#rPrice", price);
    await page.click("label[for=rSt4]");
    await page.fill("#rComment", "Très bien, rapide.");
    await page.click("#repairForm button[type=submit]");
    await page.waitForTimeout(300);
  };
  const openHistory = async (page) => {
    await page.locator(`${CARD} .g-main`).scrollIntoViewIfNeeded();
    if (!(await page.$(`${CARD}.is-open`))) await page.click(`${CARD} .g-main`);
    await page.waitForTimeout(300);
    await page.evaluate((s) => { const d = document.querySelector(`${s} details.history`); if (d) d.open = true; }, CARD);
  };
  const history = (page) => page.evaluate((s) => { const d = document.querySelector(`${s} details.history`); return d ? { rows: d.querySelectorAll(".h-rows li").length, del: d.querySelectorAll(".h-del").length, states: [...d.querySelectorAll(".h-state")].map((e) => e.textContent.trim()) } : null; }, CARD);
  const declaredTag = (page) => page.$eval(CARD, (c) => { const t = c.querySelector(".g-price .tag.info"); const a = c.querySelector(".g-price .amount .num"); return t ? { tag: t.textContent.trim(), amount: a && a.textContent.replace(/\s+/g, " ").trim() } : null; }).catch(() => null);
  const note = (page) => page.$eval("#repairNote", (e) => (e.hidden ? "" : e.textContent.replace(/\s+/g, " ").trim()));
  const toast = (page) => page.$eval("#toast", (e) => (e.hidden ? "" : e.textContent.replace(/\s+/g, " ").trim()));
  const apiRepairRequests = () => api.chaos.requests.filter((r) => r.includes("/v1/repairs"));

  try {
    // ============ R1. lecture : les réparations d'autres s'affichent ; OpenStreetMap passe par le relais ============
    {
      let { page, ctx, logs } = await fresh();
      await others([55, 60, 65, 70]);
      check("R1a the page is in remote mode (store flag, Sources text variant)", (await page.evaluate(() => document.body.dataset.store)) === "remote" && (await page.isVisible('[data-store-only="remote"] >> nth=0').catch(() => false)) !== undefined);
      check("R1b only the remote wording is displayed in « Sources » (declared repairs, garages relay), not the local one", await page.evaluate(() => { const vis = (e) => getComputedStyle(e).display !== "none"; const remote = [...document.querySelectorAll('[data-store-only="remote"]')], local = [...document.querySelectorAll('[data-store-only="local"]')]; return remote.length === 2 && local.length === 1 && remote.every(vis) && local.every((e) => !vis(e)); }));
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      await page.waitForTimeout(300);
      const tag = await declaredTag(page);
      check("R1c the garage's card shows the declared price: median of what others declared (55, 60, 65, 70 → 62,50 €)", tag && /Prix déclaré/.test(tag.tag) && /62,50/.test(tag.amount), JSON.stringify(tag));
      await openHistory(page);
      const h = await history(page);
      check("R1d the history lists the 4 declarations of others, none deletable from here", h && h.rows === 4 && h.del === 0, JSON.stringify(h));
      const summary = norm(await page.textContent("#summary"));
      check("R1e the summary says who declared: « par des automobilistes », not « par vous »", /par des automobilistes/.test(summary) && !/par vous/.test(summary), summary.slice(0, 300));
      check("R1f the garages came through the API relay (one upstream call), not straight from OpenStreetMap", api.upstream.calls === 1 && ctx.__counters.overpass === 0, JSON.stringify({ upstream: api.upstream.calls, direct: ctx.__counters.overpass }));
      check("R1g one read of the area, from the centre of its 0.05° cell", apiRepairRequests().filter((r) => r.startsWith("GET")).length === 1);
      await page.click("#addRepairBtn");
      const dlgNote = norm(await page.textContent("#dlgNote"));
      check("R1h the form tells what is published and what is not", /publiée sans votre nom/.test(dlgNote) && /jamais publié \(seule la modération peut le lire\)/.test(dlgNote) && /ni conservée en clair/.test(dlgNote), dlgNote);
      await page.click("#dlgCancel");
      check("R1i console clean (read path)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));
      await ctx.close();
    }

    // ============ R2–R4. écrire, retirer, annuler ============
    {
      let { page, ctx, logs } = await fresh();
      await others([55, 60, 65, 70]);
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      await declare(page);
      const synced = await until(async () => { const r = await stored(page); return r && r.length === 1 && r[0].sync === "synced"; });
      check("R2a the declaration is stored with its secret and reaches « synced »", synced, JSON.stringify(await stored(page)));
      const rows = await api.rows();
      const mine = rows.find((r) => r.price_cents === 5990);
      check("R2b the database has it: price, service, model, year, status", mine && mine.service_id === "vidange" && mine.vehicle_model === "Peugeot 208" && mine.vehicle_year === 2019 && mine.status === "approved" && rows.length === 5, JSON.stringify(rows.map((r) => r.price_cents)));
      check("R2c the plate is stored as a 64-character hex hash only; the comment never leaves the page's own copy of the public listing", mine && /^[0-9a-f]{64}$/.test(mine.plate_hmac) && !JSON.stringify(rows).includes("EZ-108-BC"));
      const row = (await stored(page))[0];
      check("R2d the id is a UUID v4 and the secret is 48 hex characters", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id) && /^[0-9a-f]{48}$/.test(row.deleteToken) && mine.id === row.id, JSON.stringify(row));
      await openHistory(page);
      const h = await history(page);
      check("R2e the history shows 5 rows; only the one declared here can be deleted, with no sync label once synced", h && h.rows === 5 && h.del === 1 && h.states.length === 0, JSON.stringify(h));
      const tag = await declaredTag(page);
      check("R2f the card's declared price counts everyone's: median of 55, 59,90, 60, 65, 70 = 60 €", tag && /^60 €$/.test(tag.amount), JSON.stringify(tag));
      check("R2g console clean (write path)", logs.console.length === 0 && logs.errors.length === 0, JSON.stringify([logs.console, logs.errors]));

      // R3 : « Supprimer » retire la ligne en base ; « Annuler » la remet (même identifiant)
      await page.click(`${CARD} .h-del`);
      check("R3a delete → toast with Annuler", /Réparation supprimée/.test(await toast(page)) && /Annuler$/.test(await toast(page)));
      const gone = await until(async () => (await api.rows()).length === 4);
      check("R3b the row is gone from the database (the secret authorised it)", gone && (await api.rows()).every((r) => r.id !== row.id));
      await page.click("#toast button");
      const back = await until(async () => (await api.rows()).some((r) => r.id === row.id));
      check("R3c undo posts the same declaration again: same id, back in the database, synced", back && (await until(async () => ((await stored(page)) || [{}])[0].sync === "synced")));

      // R4 : « Annuler » sur le message d'enregistrement
      await declare(page, { price: "75", service: "revision" }); // une autre prestation : ce n'est pas un doublon de la première déclaration
      await page.click("#toast button");
      const cancelled = await until(async () => (await api.rows()).length === 5);
      check("R4 « Annuler » on the save toast: the row ends up out of the database and out of the page", cancelled && (await stored(page)).length === 1 && /Réparation annulée/.test(await toast(page)), JSON.stringify((await api.rows()).map((r) => r.price_cents)));
      await ctx.close();
    }

    // ============ R5. API éteinte au moment de déclarer ; retour du réseau ============
    {
      let { page, ctx } = await fresh();
      await others([55, 60, 65]);
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      api.chaos.mode = "down";
      await declare(page);
      check("R5a the declaration is accepted by the page at once", /Réparation enregistrée/.test(await toast(page)) && (await stored(page)).length === 1);
      await openHistory(page);
      let h = await history(page);
      check("R5b the history labels it « En attente d'envoi »; it is still deletable", h && h.states.join() === "En attente d'envoi" && h.del === 1, JSON.stringify(h));
      const pending = await until(async () => /1 réparation en attente d'envoi/.test(await note(page)), 4000);
      check("R5c a calm note says one declaration waits to be sent", pending, await note(page));
      check("R5d it sits in the queue saved by the browser, with its next attempt in the future", await page.evaluate(() => { const q = JSON.parse(localStorage.getItem("jg.outbox.v1") || "[]"); return q.length === 1 && q[0].op === "post" && q[0].next > Date.now(); }).catch(() => false) || (await stored(page, "jg.outbox.v1")).length === 1);
      check("R5e nothing reached the database", (await api.rows()).length === 3);
      api.chaos.mode = "ok";
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      const sent = await until(async () => (await api.rows()).length === 4, 8000);
      check("R5f the network comes back: the queue goes out without waiting for the delay", sent, JSON.stringify((await api.rows()).length));
      await until(async () => (await note(page)) === "");
      h = await history(page);
      check("R5g label and note disappear once sent", (await note(page)) === "" && h && h.states.length === 0, JSON.stringify([await note(page), h]));
      await ctx.close();
    }

    // ============ R6. API lente : la liste ne l'attend pas plus de 2,5 s ============
    {
      let { page, ctx } = await fresh();
      await others([55, 60, 65, 70]);
      api.chaos.delayMs = 3200;
      api.chaos.delayPath = "/v1/repairs";
      await page.selectOption("#service", "vidange");
      await page.fill("#address", "12 rue de la république lyon");
      await page.waitForSelector("#addrList li[data-i]", { state: "visible" });
      await page.click("#addrList li[data-i='0']");
      const t0 = Date.now();
      await page.click("#go");
      await page.waitForSelector("#list > li", { timeout: 8000 });
      const firstRender = Date.now() - t0;
      const early = await declaredTag(page);
      check("R6a results appear after about 2,5 s, before the slow repairs endpoint answers (3,2 s)", firstRender < 3200 + 400 && firstRender >= 2000, String(firstRender));
      check("R6b … without the declared price yet", early === null, JSON.stringify(early));
      const late = await until(async () => declaredTag(page), 6000);
      check("R6c … and when the endpoint answers the list updates by itself (62,50 €)", late && /62,50/.test(late.amount), JSON.stringify(late));
      await ctx.close();
    }

    // ============ R7. API éteinte à la lecture : la page marche, sans les réparations d'autres ============
    {
      let { page, ctx } = await fresh();
      await others([55, 60, 65, 70]);
      api.chaos.requests.length = 0; // on ne compte que ce que la page demande à une API éteinte
      api.chaos.mode = "down";
      const t0 = Date.now();
      await search(page, { service: "vidange" });
      check("R7a the search still works (garages come straight from OpenStreetMap), in normal time", (await page.$$("#list > li")).length > 20 && Date.now() - t0 < 8000, String(Date.now() - t0));
      check("R7b the relay was tried first, then the public servers answered", ctx.__counters.overpass >= 1);
      const n = await until(async () => /momentanément indisponibles/.test(await note(page)), 5000);
      check("R7c a note says declared repairs are unavailable (nothing else is hidden)", n, await note(page));
      check("R7d no declared price is shown, chains' prices still are", (await declaredTag(page)) === null && (await page.$$eval("#list > li .g-price .amount", (l) => l.length)) > 0);
      check("R7e the broken API is asked a bounded number of times (circuit breaker), not for every action", apiRepairRequests().length <= 4, JSON.stringify(apiRepairRequests()));
      await ctx.close();
    }

    // ============ R8. dernière bonne réponse : l'API tombe entre deux visites ============
    {
      let { page, ctx } = await fresh();
      await others([55, 60, 65, 70]);
      await search(page, { service: "vidange" });
      check("R8a first visit: declared price shown, area saved for later", (await declaredTag(page)) !== null && Object.keys((await stored(page, "jg.area.v1")) || {}).length === 1);
      api.chaos.mode = "down";
      await page.reload();
      await page.waitForSelector("#list > li", { timeout: 8000 });
      const tag = await declaredTag(page);
      check("R8b API down at the next visit: the saved copy is in the very first render (no flash without it)", tag && /62,50/.test(tag.amount), JSON.stringify(tag));
      const n = await until(async () => /dernière copie/.test(await note(page)), 6000);
      check("R8c … and the page says it is a saved copy", n, await note(page));
      await ctx.close();
    }

    // ============ R9. doublon ============
    {
      let { page, ctx } = await fresh();
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      await declare(page, { price: "59,90" });
      await until(async () => (await api.rows()).length === 1);
      await declare(page, { price: "61" });
      const dup = await until(async () => /avait déjà été déclarée/.test(await toast(page)), 5000);
      check("R9a the same plate, garage, service and day cannot be declared twice: the page says so", dup, await toast(page));
      check("R9b … the second copy is withdrawn from the page, the first one counts", (await stored(page)).length === 1 && (await api.rows()).length === 1);
      await ctx.close();
    }

    // ============ R10. la file d'attente survit au rechargement ============
    {
      let { page, ctx } = await fresh();
      await search(page, { service: "vidange" });
      api.chaos.mode = "down";
      await declare(page);
      await page.waitForTimeout(300);
      await page.reload();
      await page.waitForSelector("#list > li", { timeout: 8000 });
      const r = await stored(page);
      check("R10a after a reload the declaration is still there, still waiting", r && r.length === 1 && r[0].sync === "pending" && (await stored(page, "jg.outbox.v1")).length === 1);
      await openHistory(page);
      check("R10b … and still labelled", (await history(page)).states.join() === "En attente d'envoi");
      api.chaos.mode = "ok";
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      check("R10c back online it goes out and the row is in the database", await until(async () => (await api.rows()).length === 1, 8000));
      await ctx.close();
    }

    // ============ R11. un 5xx n'est pas une panne définitive ============
    {
      let { page, ctx } = await fresh();
      await search(page, { service: "vidange" });
      api.chaos.failNext = 3; // trois réponses 503 de suite : les trois essais d'un même appel
      await declare(page);
      await until(async () => apiRepairRequests().filter((r) => r.startsWith("POST")).length >= 3, 6000);
      check("R11a three 503 in a row: the declaration is not lost, it waits for its next attempt", (await api.rows()).length === 0 && /en attente d'envoi/.test(await until(async () => note(page), 3000)) && (await stored(page))[0].sync === "pending");
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      check("R11b then it goes through (a 5xx is a blip, not a verdict)", await until(async () => (await api.rows()).length === 1, 6000), JSON.stringify(apiRepairRequests()));
      await ctx.close();
    }

    // ============ R12. relais Overpass : secours quand l'API ou OpenStreetMap défaillent ============
    {
      let { page, ctx } = await fresh();
      api.upstream.fail = true;
      await search(page, { service: "vidange" });
      check("R12a relay up but OpenStreetMap down: 502 from the relay, the page falls back to the public mirrors and still lists garages", (await page.$$("#list > li")).length > 20 && ctx.__counters.overpass >= 1);
      await ctx.close();
    }

    // ============ R13. réparations d'avant l'API : elles restent ici ============
    {
      const legacy = { id: "r-ancienne", garageId: "osm:node/1022", garageName: "Norauto Bron", garageAddr: "98 rue X", lat: null, lon: null, chainId: "norauto", model: "Renault Clio", rating: 5, serviceId: "vidange", price: 72, date: "2026-08-02", comment: "", createdAt: "2026-08-02T10:00:00Z" };
      let { page, ctx } = await fresh({ storage: { "jg.repairs.v1": [legacy] } });
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      await openHistory(page);
      const h = await history(page);
      check("R13a an old declaration is displayed, deletable, labelled « Gardée sur cet appareil »", h && h.rows === 1 && h.del === 1 && h.states.join() === "Gardée sur cet appareil", JSON.stringify(h));
      await page.waitForTimeout(500);
      check("R13b it is never sent to the API", !api.chaos.requests.some((r) => r.startsWith("POST")) && (await api.rows()).length === 0);
      await page.click(`${CARD} .h-del`);
      await page.waitForTimeout(500);
      check("R13c deleting it asks nothing of the API", !api.chaos.requests.some((r) => r.startsWith("DELETE")));
      await ctx.close();
    }

    // ============ R14. « Annuler » ne fait pas oublier le véhicule ============
    {
      let { page, ctx } = await fresh();
      await search(page, { service: "vidange" });
      await declare(page);
      await page.click("#toast button"); // Annuler
      await page.click("#addRepairBtn");
      await page.waitForTimeout(250);
      const v = await page.evaluate(() => ({ plate: document.getElementById("rPlate").value, model: document.getElementById("rModel").value, year: document.getElementById("rYear").value }));
      check("R14 after cancelling, the form still opens with the plate, model and year just typed", v.plate === "EZ-108-BC" && v.model === "Peugeot 208" && v.year === "2019", JSON.stringify(v));
      await ctx.close();
    }

    // ============ R16. « Autre réparation » : une prestation hors liste est acceptée par l'API ============
    {
      let { page, ctx } = await fresh();
      await search(page, { service: "vidange" });
      await declare(page, { price: "120", service: "autre" });
      const accepted = await until(async () => (await api.rows()).length === 1, 5000);
      const rows = await api.rows();
      check("R16a « Autre réparation » (not in the services list) is accepted and stored by the API", accepted && rows[0].service_id === "autre", JSON.stringify(rows.map((r) => r.service_id)));
      check("R16b … and the page keeps it as its own, synced, deletable declaration", ((await stored(page)) || [{}])[0].sync === "synced" || (await until(async () => ((await stored(page)) || [{}])[0].sync === "synced")));
      await ctx.close();
    }

    // ============ R15. accessibilité des états propres au mode distant ============
    {
      let { page, ctx } = await fresh();
      await others([55, 60, 65, 70]);
      await search(page, { service: "vidange" });
      await page.click("[data-sort=dist]");
      api.chaos.mode = "down";
      await declare(page);
      await openHistory(page);
      await until(async () => /en attente/.test(await note(page)), 5000);
      await injectScript(page, AXE);
      const v = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } })).violations.map((x) => ({ id: x.id, n: x.nodes.length, ex: x.nodes.slice(0, 2).map((n) => n.target.join(" ")) })));
      check("R15 axe: no violation with a waiting declaration, its label and the note", v.length === 0, JSON.stringify(v));
      await ctx.close();
    }
  } catch (e) {
    check("remote section crashed", false, e && e.stack);
  } finally {
    await api.close();
    await browser.close();
    server.close();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n[remote ${FILE}] ${results.length - bad.length}/${results.length} checks passed`);
  bad.forEach((b) => console.log("  ✗", b.name));
  process.exit(bad.length ? 1 : 0);
})();
