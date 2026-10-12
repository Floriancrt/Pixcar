// Espace Pro côté comparateur (maquette 6) : badge « Garage vérifié », étiquette « Annoncé » à part de l'échelle des prix payés, bloc « Prix
// annoncés par le garage » dans la fiche, tri (un prix seulement annoncé ne passe jamais devant un prix payé), visites comptées pour le tableau de
// bord du garagiste (fiche ouverte, « Appeler »), une seule lecture regroupée par recherche, rien quand l'Espace Pro est fermé.
// Vraie API (PGlite) en mode distant, tuiles de la table simulées (tests/fixtures/garages-data.js), OpenStreetMap simulé.
//   node tests/pro-public.js [index.html | dist/index.html]
const fs = require("fs");
const path = require("path");
const { serve, launch, open, search, sortBy, shot, ROOT } = require("./harness");
const { startApi } = require("./api-harness");
const { OSM, oid, uid, ovtId, R, TILES, indexOf, dayStr } = require("./fixtures/garages-data");

const FILE = process.argv[2] || process.env.FILE || "index.html";
const AXE = fs.readFileSync(path.join(__dirname, "..", "node_modules/axe-core/axe.min.js"), "utf8");
const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log("  FAIL:", name, "|", String(detail).slice(0, 600));
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(80);
  }
}

// tuiles de la table servies par le site (comme tests/garages.js)
async function tiles(ctx) {
  await ctx.route("**/garages/**", (route) => {
    const u = new URL(route.request().url());
    const m = /\/garages\/(index|t\/(-?\d+--?\d+))\.json$/.exec(u.pathname);
    if (!m) return route.fulfill({ status: 404, body: "" });
    const body = m[2] ? { v: 1, g: TILES[m[2]] || [] } : indexOf({ built: dayStr(20), tiles: TILES });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

(async () => {
  const { repair, isoDay } = await import("../server/test/helpers.mjs");
  const server = await serve(ROOT);
  const browser = await launch();
  const api = await startApi({ origin: server.url, env: { PRO_ENABLED: "1" } });
  api.upstream.elements = OSM;
  if (server.allowConnect) server.allowConnect(api.url);

  // Garage Martin : OpenStreetMap (osm:node/9301) complété par le lieu uid(1) de la table, vérifié, 95 € payé, 89 € annoncé.
  // Carrosserie du Soleil : lieu de la table seul (ovtId(5)), vérifié, « dès 75 € » annoncé, aucun prix payé.
  // Garage Dubois : OpenStreetMap complété par uid(3), PAS vérifié, 60 € payé.
  const verify = (garageId) =>
    api.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES (gen_random_uuid(), $1, $2, '73282932000074', 'verified', 'email', 'Camille Durand', 'manager', $3, 'x', now())",
      ["acc-" + garageId.slice(-2), garageId, "a".repeat(64)],
    );
  const announce = (garageId, service, kind, cents, over = "now()") =>
    api.db.query(`INSERT INTO pro_prices (garage_id, service_id, kind, price_cents, vehicles, includes, status, account_id, confirmed_at) VALUES ($1, $2, $3, $4, '[]', '["parts","labour"]', 'published', 'acc', ${over})`, [garageId, service, kind, cents]);
  await verify(uid(1));
  await verify(uid(5));
  await announce(uid(1), "vidange", "fixed", 8900);
  await announce(uid(1), "clim", "fixed", 6900, "now() - interval '200 days'");
  await announce(uid(5), "vidange", "from", 7500);
  const osmOf = (n) => OSM.find((e) => e.id === 9300 + n);
  const declare = (n, price) => api.post(repair({ price, date: isoDay(20), garage: { id: oid(n), name: osmOf(n).tags.name, addr: "", lat: osmOf(n).lat, lon: osmOf(n).lon, chainId: "" }, area: { lat: osmOf(n).lat, lon: osmOf(n).lon } }));
  check("setup: paid prices declared on Garage Martin and Garage Dubois", (await declare(1, 95)).status === 201 && (await declare(3, 60)).status === 201);

  const go = async ({ init = "", vp = { width: 1440, height: 900 } } = {}) => {
    const r = await open(browser, server, FILE, { ...vp, mock: { elements: OSM }, initScript: `window.JG_CITY_LOOKUP=false;window.JG_GARAGES_BASE="garages/";window.JG_TUNE.api=${JSON.stringify(api.url)};${init}` });
    await tiles(r.ctx);
    return r;
  };
  const rows = (page) =>
    page.$$eval("#list > li.card", (els) =>
      els.map((c) => ({
        id: c.dataset.id,
        name: c.querySelector(".g-name").textContent.trim(),
        badge: !!c.querySelector(".v-badge"),
        price: c.querySelector(".g-price").textContent.replace(/\s+/g, " ").trim(),
        bar: !!c.querySelector(".g-price .bar i"),
      })),
    );

  // ---- recherche : badge, étiquettes, tri
  let { page, ctx, logs } = await go();
  api.chaos.requests.length = 0;
  await search(page, { service: "vidange", km: 10 });
  await sortBy(page, "price");
  const list = await until(async () => {
    const l = await rows(page);
    return l.some((x) => x.badge) && l;
  });
  const by = (name) => (list || []).find((x) => x.name === name) || {};
  check("« Garage vérifié » under the name of the verified garages only", by("Garage Martin").badge && by("Carrosserie du Soleil").badge && !by("Garage Dubois").badge, JSON.stringify(list));
  check("a paid price keeps its scale bar; the announced price sits beside it as « Annoncé 89 € »", /95\s?€/.test(by("Garage Martin").price) && /Annoncé 89 €$/.test(by("Garage Martin").price) && by("Garage Martin").bar, by("Garage Martin").price);
  check("announced only: « Annoncé dès 75 € » and « Pas encore de prix payé déclaré », no bar", /^Annoncé dès 75 € ?Pas encore de prix payé déclaré$/.test(by("Carrosserie du Soleil").price) && !by("Carrosserie du Soleil").bar, by("Carrosserie du Soleil").price);
  const order = (list || []).map((x) => x.name);
  check(
    "by price: paid prices first (60, 95), then the announced-only garage, then those without any price",
    order[0] === "Garage Dubois" && order[1] === "Garage Martin" && order[2] === "Carrosserie du Soleil" && order.slice(3).every((n) => !["Garage Dubois", "Garage Martin", "Carrosserie du Soleil"].includes(n)),
    order.join(" · "),
  );
  const stats = norm(await page.textContent("#summary"));
  check("the announced price stays out of the figures (cheapest 60 €, 2 published prices)", /60\s?€/.test(stats) && /2\s?Prix publiés/.test(stats), stats);
  const reads = api.chaos.requests.filter((r) => r.startsWith("GET /v1/pro/public/garages"));
  check("one grouped read for the whole search", reads.length === 1, api.chaos.requests.join("\n"));

  // ---- fiche : bloc des prix annoncés, visite comptée
  await page.click(`#list [data-id="${oid(1)}"] .g-main`);
  await page.waitForSelector(`#list [data-id="${oid(1)}"] .pro-ann`);
  const block = norm(await page.textContent(`#list [data-id="${oid(1)}"] .pro-ann`));
  check("the fiche shows « Prix annoncés par le garage », the searched service first, an old price marked, the responsibility note", /^Prix annoncés par le garage ?Vérifié ?Vidange \(huile \+ filtre\) ?89 € ?Recharge de climatisation ancien ?69 € ?Mis à jour le 12 oct\. 2026\. Communiqués par le garage, sous sa responsabilité/.test(block), block);
  // la fiche s'ouvre en fondu (0,24 s) : axe mesurerait le contraste en cours d'animation
  await page.$eval(`#list [data-id="${oid(1)}"] .g-more`, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document.querySelector("#list"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } })).violations.map((x) => x.id + ": " + x.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")));
  check("axe: no violation in the list with badges, labels and the open fiche", !v.length, v.join("\n"));
  await page.$eval(`#list [data-id="${oid(1)}"] .pro-ann`, (el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "pro-public-fiche");
  const visits = async () => (await api.db.query("SELECT garage_id, kind FROM pro_visits ORDER BY kind, garage_id")).rows.map((r) => `${r.kind}:${r.garage_id}`);
  check("opening the fiche of a verified garage counts one view", (await until(async () => (await visits()).join() === `view:${uid(1)}`)), (await visits()).join());
  await page.click(`#list [data-id="${oid(1)}"] .g-main`);
  await page.click(`#list [data-id="${oid(1)}"] .g-main`); // refermée puis rouverte : une seule visite par visite de la page
  await page.click(`#list [data-id="${oid(3)}"] .g-main`); // garage non vérifié : rien
  await sleep(300);
  check("reopening, or opening a garage that is not verified, counts nothing more", (await visits()).join() === `view:${uid(1)}`, (await visits()).join());
  await page.evaluate((id) => {
    const a = document.querySelector(`#list [data-id="${CSS.escape(id)}"] a[href^="tel:"]`);
    a.addEventListener("click", (e) => e.preventDefault(), { once: true }); // pas de vrai appel depuis le navigateur de test
    a.click();
  }, oid(1));
  check("« Appeler » on a verified garage counts one call", await until(async () => (await visits()).includes(`call:${uid(1)}`)), (await visits()).join());
  check("no console error, no page error", !logs.errors.length && !logs.console.some((m) => /error/i.test(m.type || "")), JSON.stringify(logs.errors).slice(0, 400));
  await ctx.close();

  // ---- plusieurs prestations : badge, mais pas d'étiquette (le prix annoncé est celui d'une prestation)
  ({ page, ctx } = await go());
  await search(page, { service: ["vidange", "clim"], km: 10 });
  const multi = await until(async () => {
    const l = await rows(page);
    return l.some((x) => x.badge) && l;
  });
  check("several services: the badge stays, no « Annoncé » label", multi && multi.some((x) => x.badge) && !multi.some((x) => x.price.includes("Annoncé")), JSON.stringify(multi));
  await ctx.close();

  // ---- mobile : badge et étiquettes visibles, rien ne déborde de l'écran, fiche lisible
  ({ page, ctx, logs } = await go({ vp: { width: 390, height: 844, dpr: 2, touch: true } }));
  await search(page, { service: "vidange", km: 10 });
  await until(async () => (await rows(page)).some((x) => x.badge));
  const sel = `#list [data-id="${oid(1)}"]`;
  const mob = await page.$eval(sel, (c) => {
    const vis = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right <= innerWidth + 0.5;
    return { badge: vis(c.querySelector(".v-badge")), chip: vis(c.querySelector(".tag.annonce")), overflow: document.scrollingElement.scrollWidth - innerWidth };
  });
  await page.click(`${sel} .g-main`);
  await page.waitForSelector(`${sel} .pro-ann`);
  await page.$eval(`${sel} .g-more`, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const box = await page.$eval(`${sel} .pro-ann`, (el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, overflow: document.scrollingElement.scrollWidth - innerWidth };
  });
  await shot(page, "pro-public-mobile");
  check("mobile (390 px): badge and « Annoncé » label visible, the announced-prices block inside the screen, no horizontal scroll", mob.badge && mob.chip && mob.overflow <= 0 && box.left >= 0 && box.right <= 390 && box.overflow <= 0, JSON.stringify({ mob, box }));
  check("mobile: no page error", !logs.errors.length, JSON.stringify(logs.errors).slice(0, 300));
  await ctx.close();

  // ---- Espace Pro fermé (404) : rien d'affiché, aucune autre requête, aucune erreur
  const off = await startApi({ origin: server.url });
  off.upstream.elements = OSM;
  if (server.allowConnect) server.allowConnect(off.url);
  {
    const r = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: OSM }, initScript: `window.JG_CITY_LOOKUP=false;window.JG_GARAGES_BASE="garages/";window.JG_TUNE.api=${JSON.stringify(off.url)};` });
    await tiles(r.ctx);
    await search(r.page, { service: "vidange", km: 10 });
    await sleep(500);
    await r.page.click(`#list > li.card .g-main`);
    await sleep(300);
    const l = await rows(r.page);
    const pro = off.chaos.requests.filter((x) => x.includes("/v1/pro/"));
    check("Pro space closed: no badge, no label, one read only, no visit sent", l.length > 0 && !l.some((x) => x.badge || x.price.includes("Annoncé")) && pro.length === 1 && pro[0].startsWith("GET"), pro.join(" | "));
    check("Pro space closed: no page error", !r.logs.errors.length, JSON.stringify(r.logs.errors).slice(0, 300));
    await r.ctx.close();
  }
  await off.close();

  // ---- mode local (sans API) : aucune requête vers l'Espace Pro
  {
    const r = await open(browser, server, FILE, { width: 1440, height: 900, mock: { elements: OSM }, initScript: `window.JG_CITY_LOOKUP=false;window.JG_GARAGES_BASE="garages/";` });
    await tiles(r.ctx);
    await search(r.page, { service: "vidange", km: 10 });
    await sleep(400);
    check("local mode: nothing asked to the Pro space", !r.logs.requests.some((u) => /\/v1\/pro\//.test(u)) && !(await rows(r.page)).some((x) => x.badge));
    await r.ctx.close();
  }

  await browser.close();
  await api.close();
  server.close && server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`[pro-public ${FILE}] ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
