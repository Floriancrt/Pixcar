// L'API Pixcar sur AWS Lambda, derrière une API Gateway HTTP API (charge utile 2.0). Même application (app.mjs) que sur Node : cet
// adaptateur ne fait que traduire un événement en Request, et la Response en réponse API Gateway.
//  - l'adresse du visiteur vient de requestContext.http.sourceIp (posée par API Gateway, non falsifiable) ; les en-têtes
//    X-Forwarded-For / CF-Connecting-IP du client sont écartés avant l'application (TRUST_PROXY=0 les ignorerait de toute façon,
//    mais l'application s'en plaindrait dans le journal) ;
//  - brotli / gzip comme sur Node (lib/compress.mjs), en base64 ;
//  - le démarrage (secrets, connexion à la base) se fait à la première invocation et se réessaie à la suivante s'il échoue.
import { createApp, loadServices } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { compressIfUseful } from "./lib/compress.mjs";
import { jsonLog } from "./lib/log.mjs";
import { readSecrets } from "./lib/secrets.mjs";

const NO_BODY = new Set([204, 304]);
const CLIENT_ADDRESS_HEADERS = new Set(["x-forwarded-for", "cf-connecting-ip"]);
const TEXTUAL = /^(application\/json|text\/)/i;

export function toRequest(event) {
  const http = (event.requestContext && event.requestContext.http) || {};
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers || {})) if (value != null && !CLIENT_ADDRESS_HEADERS.has(name.toLowerCase())) headers.set(name, String(value));
  const method = String(http.method || "GET").toUpperCase();
  const host = headers.get("host") || (event.requestContext && event.requestContext.domainName) || "localhost";
  const query = event.rawQueryString ? "?" + event.rawQueryString : "";
  const hasBody = method !== "GET" && method !== "HEAD" && event.body != null && event.body !== "";
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body) : undefined;
  return new Request(`https://${host}${event.rawPath || http.path || "/"}${query}`, { method, headers, body });
}

export async function fromResponse(response, event) {
  const headers = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  const method = String((event.requestContext && event.requestContext.http && event.requestContext.http.method) || "GET").toUpperCase();
  if (method === "HEAD" || NO_BODY.has(response.status) || !response.body) return { statusCode: response.status, headers };
  let body = Buffer.from(await response.arrayBuffer());
  const packedBody = compressIfUseful({ body, type: headers["content-type"] || "", acceptEncoding: (event.headers || {})["accept-encoding"], etag: headers.etag || "", alreadyEncoded: "content-encoding" in headers });
  if (packedBody) {
    body = packedBody.body;
    headers["content-encoding"] = packedBody.encoding;
    headers.vary = [headers.vary, "Accept-Encoding"].filter(Boolean).join(", ");
  }
  const text = !packedBody && TEXTUAL.test(headers["content-type"] || "");
  return { statusCode: response.status, headers, body: text ? body.toString("utf8") : body.toString("base64"), isBase64Encoded: !text };
}

const problem = (statusCode, code, message, extra = {}) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  body: JSON.stringify({ error: { code, message } }),
});

export function createHandler({ getApp, log = () => {} }) {
  return async (event) => {
    let app;
    try {
      app = await getApp();
    } catch (e) {
      log({ level: "error", msg: "démarrage impossible", error: e.message });
      return problem(503, "unavailable", "Service momentanément indisponible.", { "retry-after": "5" });
    }
    let request;
    try {
      request = toRequest(event);
    } catch {
      return problem(400, "bad_request", "Requête illisible.");
    }
    const response = await app.fetch(request, { remoteIp: event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp });
    return fromResponse(response, event);
  };
}

// Démarrage réel : secrets (SSM), configuration, base (Aurora DSQL sous le rôle de base de l'API), application.
export function appFromEnvironment(env = process.env, log = jsonLog(env.LOG_LEVEL)) {
  let starting = null;
  return () =>
    (starting ||= (async () => {
      const config = loadConfig({ ...env, ...(await readSecrets(env)) });
      const db = await createDb({ url: config.databaseUrl, dsql: config.dsql, log: (m) => log({ level: "warn", msg: m }) });
      log({ level: "info", msg: "instance démarrée", db: db.kind });
      return createApp({ db, config, services: await loadServices(), log });
    })().catch((e) => {
      starting = null; // un démarrage raté se réessaie à l'invocation suivante
      throw e;
    }));
}

const log = jsonLog(process.env.LOG_LEVEL);
export const handler = createHandler({ getApp: appFromEnvironment(process.env, log), log });
