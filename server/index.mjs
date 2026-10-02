// Démarrage de l'API sur Node (≥ 20) : adaptateur node:http → Request/Response, compression, arrêt propre.
//   DATABASE_URL=postgres://… PLATE_PEPPER=… IP_PEPPER=… ALLOWED_ORIGINS=https://pixcar.example node server/index.mjs
import http from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createApp, loadServices } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { migrate } from "./migrate.mjs";

const COMPRESSIBLE = /^(application\/json|text\/|application\/javascript|image\/svg\+xml)/i;
// Une réponse identique (même ETag) est compressée une fois, pas à chaque requête : c'est le coût le plus lourd d'une lecture.
const packed = new Map();
const pack = (key, make) => {
  if (!key) return make();
  let hit = packed.get(key);
  if (!hit) {
    hit = make();
    packed.set(key, hit);
    if (packed.size > 200) packed.delete(packed.keys().next().value);
  }
  return hit;
};

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
      const type = response.headers.get("content-type") || "";
      const accept = String(req.headers["accept-encoding"] || "");
      if (body.length >= 1024 && COMPRESSIBLE.test(type) && !response.headers.has("content-encoding")) {
        const etag = response.headers.get("etag");
        const plain = body;
        if (/\bbr\b/.test(accept)) {
          body = pack(etag && "br|" + etag, () => brotliCompressSync(plain, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }));
          res.setHeader("content-encoding", "br");
        } else if (/\bgzip\b/.test(accept)) {
          body = pack(etag && "gzip|" + etag, () => gzipSync(plain, { level: 6 }));
          res.setHeader("content-encoding", "gzip");
        }
        if (res.hasHeader("content-encoding")) res.setHeader("vary", [res.getHeader("vary"), "Accept-Encoding"].filter(Boolean).join(", "));
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

// LOG_LEVEL : « info » (une ligne par requête, par défaut), « warn » (incidents seulement), « error ». Ni adresse IP, ni requête, ni corps.
const LEVELS = { error: 0, warn: 1, info: 2 };
const jsonLog = (min) => (o) => (LEVELS[o.level] ?? 2) <= (LEVELS[min] ?? 2) && console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

export async function start({ env = process.env, log = jsonLog(env.LOG_LEVEL) } = {}) {
  const config = loadConfig(env);
  const db = await createDb({ url: config.databaseUrl, dataDir: env.DEV_DATA_DIR || undefined, log: (m) => log({ level: "warn", msg: m }) });
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
