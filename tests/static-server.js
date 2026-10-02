// Serveur statique « comme un vrai hébergeur » pour mesurer et tester dist/ : types MIME exacts, compression (brotli, gzip),
// ETag, en-têtes lus dans _headers (même format que Netlify et Cloudflare Pages), 404 propre.
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".map": "application/json",
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/;

// _headers : une règle commence par un chemin (« /assets/* »), ses en-têtes suivent, indentés.
function parseHeaders(file) {
  if (!fs.existsSync(file)) return [];
  const rules = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) rules.push({ pattern: line.trim(), headers: {} });
    else {
      const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
      if (m && rules.length) rules[rules.length - 1].headers[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  return rules.map((r) => ({ ...r, re: new RegExp("^" + r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") }));
}

// opts.dir : dossier servi · opts.compress (défaut vrai) · opts.latencyMs : délai ajouté à chaque réponse (réseau lent simulé côté serveur)
function serveDir(dir, opts = {}) {
  let root = path.resolve(dir);
  let rules = parseHeaders(path.join(root, "_headers"));
  const extraConnect = [];
  const stats = { requests: [], bytes: 0 };
  const cache = new Map(); // fichier + encodage → Buffer
  const send = (req, res, status, type, body, extra = {}) => {
    const headers = { "content-type": type, ...extra };
    const accept = String(req.headers["accept-encoding"] || "");
    let out = body;
    if (opts.compress !== false && COMPRESSIBLE.test(type) && body.length > 1024) {
      const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : "";
      if (enc) {
        const key = enc + ":" + crypto.createHash("md5").update(body).digest("hex");
        if (!cache.has(key)) cache.set(key, enc === "br" ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(body, { level: 9 }));
        out = cache.get(key);
        headers["content-encoding"] = enc;
        headers.vary = "Accept-Encoding";
      }
    }
    headers["content-length"] = out.length;
    const go = () => {
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : out);
    };
    stats.bytes += out.length;
    opts.latencyMs ? setTimeout(go, opts.latencyMs) : go();
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = decodeURIComponent(url.pathname);
    stats.requests.push(`${req.method} ${rel}`);
    const file = path.join(root, rel.endsWith("/") ? rel + "index.html" : rel);
    const applied = {};
    for (const r of rules) if (r.re.test(rel)) Object.assign(applied, r.headers);
    if (extraConnect.length && applied["content-security-policy"]) applied["content-security-policy"] = applied["content-security-policy"].replace("connect-src 'self'", `connect-src 'self' ${extraConnect.join(" ")}`);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const nf = path.join(root, "404.html");
      return send(req, res, 404, "text/html; charset=utf-8", fs.existsSync(nf) ? fs.readFileSync(nf) : Buffer.from("Introuvable"), { ...applied, "cache-control": "no-store" });
    }
    const body = fs.readFileSync(file);
    const etag = `"${crypto.createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, ...applied });
      return res.end();
    }
    send(req, res, 200, MIME[path.extname(file)] || "application/octet-stream", body, { etag, ...applied });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, stats,
        // « déploie » une autre version sur la même adresse (tests de mise à jour)
        setRoot(next) { root = path.resolve(next); rules = parseHeaders(path.join(root, "_headers")); },
        // autorise la page à joindre une API de test (la politique de sécurité du contenu de dist/ ne connaît que les hôtes de production)
        allowConnect(origin) { extraConnect.push(origin); },
        close: () => { server.closeAllConnections && server.closeAllConnections(); server.close(); },
      }),
    ),
  );
}
module.exports = { serveDir, parseHeaders, MIME };
