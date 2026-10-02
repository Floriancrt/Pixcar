// Combien de temps entre « Rechercher » et la première fiche, selon que les garages viennent directement des serveurs publics
// d'OpenStreetMap (lents, parfois saturés) ou du relais en cache de l'API ?  node tests/perf-search.js [--latency 1500] [--runs 5]
// Les serveurs OpenStreetMap sont simulés avec la latence demandée ; le relais est l'API réelle. Le temps du relais « à chaud »
// ne dépend plus d'OpenStreetMap : c'est le cas de presque toutes les recherches une fois une zone demandée une fois.
const { serve, launch, open, ROOT } = require("./harness");
const { startApi } = require("./api-harness");
const { buildElements } = require("./mocks");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const LATENCY = +arg("latency", 1500), RUNS = +arg("runs", 5);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

(async () => {
  const server = await serve(ROOT);
  const browser = await launch();
  const api = await startApi({ origin: server.url });
  const elements = buildElements();
  api.upstream.elements = elements;
  if (server.allowConnect) server.allowConnect(api.url);
  const timeSearch = async ({ remote, mock }) => {
    const { page, ctx } = await open(browser, server, process.env.PIXCAR_ROOT ? "index.html" : "index.html", { width: 1440, height: 900, mock, initScript: "window.JG_TUNE.stagger=4000;" + (remote ? `window.JG_TUNE.api=${JSON.stringify(api.url)};` : "") }); // 4 s avant d'essayer un autre serveur, comme en production
    await page.fill("#address", "12 rue de la république lyon");
    await page.waitForSelector("#addrList li[data-i]", { state: "visible" });
    await page.click("#addrList li[data-i='0']");
    const t0 = Date.now();
    await page.click("#go");
    await page.waitForSelector("#list > li", { timeout: 30000 });
    const ms = Date.now() - t0;
    const cards = await page.$$eval("#list > li.card", (l) => l.length);
    await ctx.close();
    return { ms, cards };
  };
  const series = async (label, fn) => {
    const out = [];
    for (let i = 0; i < RUNS; i++) out.push(await fn());
    const r = { label, ms: median(out.map((o) => o.ms)), cards: out[0].cards };
    console.log(`${label.padEnd(62)} ${r.ms < 0 ? "aucun résultat" : `${String(r.ms).padStart(5)} ms   (${r.cards} garages)`}`);
    return r;
  };
  console.log(`Latence d'un serveur OpenStreetMap simulée : ${LATENCY} ms · médiane de ${RUNS} recherches\n`);
  const direct = await series("directement chez OpenStreetMap", () => timeSearch({ remote: false, mock: { elements, overpassDelayMs: LATENCY } }));
  api.upstream.delayMs = LATENCY;
  // les serveurs publics restent aussi lents que le serveur amont du relais : le secours direct de la page ne triche pas
  const cold = await series("via le relais, zone jamais demandée", async () => { api.app.overpass.reset(); await api.db.exec("TRUNCATE upstream_cache"); return timeSearch({ remote: true, mock: { elements, overpassDelayMs: LATENCY } }); });
  api.upstream.delayMs = 0;
  await timeSearch({ remote: true, mock: { elements, overpassDelayMs: LATENCY } }); // une première recherche remplit le cache
  const warm = await series("via le relais, zone déjà demandée (cache mémoire)", () => timeSearch({ remote: true, mock: { elements, overpassDelayMs: LATENCY } }));
  api.app.overpass.reset();
  const warmDb = await series("via le relais, zone déjà demandée (cache en base seulement)", () => { api.app.overpass.reset(); return timeSearch({ remote: true, mock: { elements, overpassDelayMs: LATENCY } }); });
  api.upstream.fail = true;
  api.app.overpass.reset();
  const down = await series("via le relais, OpenStreetMap en panne (copie périmée en base)", async () => { api.app.overpass.reset(); await api.db.query("UPDATE upstream_cache SET fetched_at = now() - interval '2 days'"); return timeSearch({ remote: true, mock: { elements, overpassFail: true } }); });
  const directDown = await series("directement, serveurs OpenStreetMap en panne (secours : registre)", () => timeSearch({ remote: false, mock: { elements, overpassFail: true } }).catch(() => ({ ms: -1, cards: 0 })));
  console.log(`\nGain à chaud : ${direct.ms - warm.ms} ms (${Math.round((1 - warm.ms / direct.ms) * 100)} %). Relais, zone jamais demandée : ${cold.ms - direct.ms >= 0 ? "+" : ""}${cold.ms - direct.ms} ms par rapport au direct.`);
  await api.close(); await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
