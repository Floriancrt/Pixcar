// Serveur de développement : le site (dist/ ou, à défaut, index.html) ET l'API sur la même adresse, avec une base
// PostgreSQL embarquée (PGlite) : rien à installer.
//   npm run build && npm run dev            → http://localhost:8787  (base conservée dans .data/)
//   npm run dev -- --memory                 → base en mémoire, perdue à l'arrêt
//   npm run dev -- --port 3000 --dir dist
// La page est servie avec <meta name="pixcar-api"> pointant ici : les réparations passent par l'API et la base.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createApp, loadServices } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { toNodeListener } from "./index.mjs";
import { migrate } from "./migrate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const memory = process.argv.includes("--memory");
const port = Number(arg("port", process.env.PORT || 8787));
const dir = resolve(ROOT, arg("dir", existsSync(join(ROOT, "dist/index.html")) ? "dist" : "."));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const log = (o) => (o.level === "error" || o.level === "warn" ? console.error(JSON.stringify(o)) : void 0);
const config = { ...loadConfig({ NODE_ENV: "development", ALLOWED_ORIGINS: "*" }), port };
const db = await createDb({ dataDir: memory ? undefined : join(ROOT, ".data/pglite"), log: (m) => log({ level: "warn", msg: m }) });
await migrate(db, undefined, (m) => console.log(m));
const app = createApp({ db, config, services: await loadServices(), log });
const api = toNodeListener(app, { onError: (e) => console.error(e.message) });

const isApi = (url) => /^\/(v1\/|healthz|readyz)/.test(url);
async function serveStatic(req, res) {
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(dir, path));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Introuvable");
  }
  const type = MIME[extname(file)] || "application/octet-stream";
  if (file.endsWith("index.html")) {
    const origin = `http://${req.headers.host}`;
    const html = (await readFile(file, "utf8")).replace(/(<meta name="pixcar-api" content=")[^"]*(")/, `$1${origin}$2`);
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    return res.end(html);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
}

http.createServer((req, res) => (isApi(req.url) ? api(req, res) : serveStatic(req, res).catch(() => (res.headersSent ? res.destroy() : (res.writeHead(500), res.end("Erreur"))))))
  .listen(port, () => console.log(`Pixcar : http://localhost:${port}   (site : ${dir.replace(ROOT, ".") || "."}, base : ${memory ? "mémoire" : ".data/pglite"})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.close().finally(() => process.exit(0)));
