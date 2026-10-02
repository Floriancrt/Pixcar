// L'API réelle (base PostgreSQL embarquée PGlite) avec une couche de pannes réglable, pour tester la page en mode distant
// de bout en bout : page → réseau → API → base. Les services publics (adresses, OpenStreetMap…) restent simulés par mocks.js.
const http = require("http");

async function startApi({ origin, writeLimit = 1000 } = {}) {
  const { createApp, loadServices } = await import("../server/app.mjs");
  const { loadConfig } = await import("../server/config.mjs");
  const { createDb } = await import("../server/db.mjs");
  const { migrate } = await import("../server/migrate.mjs");
  const { toNodeListener } = await import("../server/index.mjs");
  const db = await createDb({});
  await migrate(db);
  // L'horloge de l'API suit celle de la page de test (2026-10-01) puis avance en temps réel ; clock.skew permet de la faire sauter
  // (la copie de 10 s d'une zone expire alors sans attendre).
  const base = Date.parse("2026-10-01T12:00:00Z"), t0 = Date.now(), clock = { skew: 0 };
  const now = () => base + (Date.now() - t0) + clock.skew;
  const config = { ...loadConfig({ NODE_ENV: "test", ALLOWED_ORIGINS: origin }), writeLimitPerHour: writeLimit, writeLimitGlobalPerMinute: 10000, readLimitPerMinute: 100000 };
  const upstream = { calls: 0, elements: [], fail: false, delayMs: 0 };
  const fetchImpl = async () => {
    upstream.calls++;
    if (upstream.delayMs) await new Promise((r) => setTimeout(r, upstream.delayMs)); // un serveur OpenStreetMap lent
    return upstream.fail ? new Response("indisponible", { status: 503 }) : new Response(JSON.stringify({ elements: upstream.elements }), { status: 200 });
  };
  const app = createApp({ db, config, services: await loadServices(), now, fetchImpl, overpassOptions: { staggerMs: 50 } });
  const handler = toNodeListener(app);
  // mode : "ok" · "down" (connexion coupée, comme une API éteinte) · délai ajouté (delayMs, éventuellement à un chemin) · failNext : N prochaines réponses en erreur
  const chaos = { mode: "ok", delayMs: 0, delayPath: "", failNext: 0, status: 503, requests: [] };
  const server = http.createServer(async (req, res) => {
    chaos.requests.push(`${req.method} ${req.url.split("?")[0]}`);
    if (chaos.mode === "down") return void req.socket.destroy();
    if (chaos.delayMs && req.url.startsWith(chaos.delayPath)) await new Promise((r) => setTimeout(r, chaos.delayMs));
    if (chaos.failNext > 0) {
      chaos.failNext--;
      res.writeHead(chaos.status, { "content-type": "application/json", "access-control-allow-origin": origin, "retry-after": "1" });
      return void res.end('{"error":{"code":"unavailable","message":"panne simulée"}}');
    }
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, app, db, chaos, clock, upstream,
    // dépose une déclaration comme le ferait un autre visiteur
    async post(body) {
      const res = await fetch(url + "/v1/repairs", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    rows: () => db.query("SELECT id, garage_id, service_id, price_cents, repaired_on::text AS date, rating, vehicle_model, vehicle_year, plate_hmac, status FROM repairs ORDER BY created_at").then((r) => r.rows),
    reset: () => { chaos.mode = "ok"; chaos.delayMs = 0; chaos.delayPath = ""; chaos.failNext = 0; chaos.requests.length = 0; },
    async close() {
      server.close();
      server.closeAllConnections && server.closeAllConnections();
      await app.close();
    },
  };
}
module.exports = { startApi };
