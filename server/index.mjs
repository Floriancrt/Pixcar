// Démarrage de l'API sur Node (≥ 20) : adaptateur node:http → Request/Response, compression, arrêt propre.
//   DATABASE_URL=postgres://… PLATE_PEPPER=… IP_PEPPER=… ALLOWED_ORIGINS=https://pixcar.example node server/index.mjs
import http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createApp, loadServices } from "./app.mjs";
import { compressIfUseful } from "./lib/compress.mjs";
import { jsonLog } from "./lib/log.mjs";
import { loadConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { migrate } from "./migrate.mjs";

// Pont entre node:http et une fonction fetch(Request) → Response
export function toNodeListener(app, { onError = () => {} } = {}) {
  return async (req, res) => {
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
      const response = await app.fetch(request, { remoteIp: req.socket.remoteAddress });
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (req.method === "HEAD" || !response.body || response.status === 204 || response.status === 304) return void res.end();
      let body = Buffer.from(await response.arrayBuffer());
      const packedBody = compressIfUseful({ body, type: response.headers.get("content-type") || "", acceptEncoding: req.headers["accept-encoding"], etag: response.headers.get("etag") || "", alreadyEncoded: response.headers.has("content-encoding") });
      if (packedBody) {
        body = packedBody.body;
        res.setHeader("content-encoding", packedBody.encoding);
        res.setHeader("vary", [res.getHeader("vary"), "Accept-Encoding"].filter(Boolean).join(", "));
      }
      res.setHeader("content-length", body.length);
      res.end(body);
    } catch (e) {
      onError(e);
      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end('{"error":{"code":"bad_request","message":"Requête illisible."}}');
      } else res.destroy();
    }
  };
}

export async function start({ env = process.env, log = jsonLog(env.LOG_LEVEL) } = {}) {
  const config = loadConfig(env);
  const db = await createDb({ url: config.databaseUrl, dsql: config.dsql, dataDir: env.DEV_DATA_DIR || undefined, log: (m) => log({ level: "warn", msg: m }) });
  if (env.MIGRATE_ON_START !== "0") (await migrate(db, undefined, (m) => log({ level: "info", msg: m })));
  const app = createApp({ db, config, services: await loadServices(), log });
  const server = http.createServer(toNodeListener(app, { onError: (e) => log({ level: "error", msg: "requête illisible", error: e.message }) }));
  server.keepAliveTimeout = 65_000; // plus long que le délai d'inactivité des répartiteurs usuels (60 s)
  server.headersTimeout = 66_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve) => server.listen(config.port, resolve));
  const timer = setInterval(() => app.maintenance().catch((e) => log({ level: "warn", msg: "entretien impossible", error: e.message })), 3600_000);
  timer.unref();
  log({ level: "info", msg: `API à l'écoute sur le port ${server.address().port}`, db: db.kind });

  let stopping = null;
  const stop = () =>
    (stopping ||= (async () => {
      app.drain(); // /readyz répond 503 : le répartiteur cesse de nous envoyer du trafic
      await new Promise((r) => setTimeout(r, Number(env.DRAIN_MS ?? 0)));
      const closed = new Promise((r) => server.close(r));
      const hard = setTimeout(() => server.closeAllConnections(), Number(env.SHUTDOWN_GRACE_MS ?? 10_000));
      await closed;
      clearTimeout(hard);
      clearInterval(timer);
      await app.close();
      log({ level: "info", msg: "arrêt propre terminé" });
    })());
  return { server, app, stop, port: server.address().port };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const running = await start();
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => running.stop().then(() => process.exit(0)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
