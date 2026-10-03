// L'API Pixcar : une fonction fetch(Request) → Response, sans dépendance à un serveur HTTP précis.
// Node la branche via server/index.mjs ; un Worker ou une fonction serverless peut l'appeler directement.
//
// Principe d'exploitation : l'API est une AMÉLIORATION de la page, pas un prérequis. Elle échoue vite et proprement
// (503 + Retry-After), garde de quoi répondre quand la base tombe (copie de la dernière bonne réponse), et ne retient
// aucun état en mémoire dont une autre instance aurait besoin : on en lance autant qu'on veut derrière un répartiteur.
import { apiError, corsHeaders, etagOf, etagResponse, json, readJson, withHeaders } from "./lib/http.mjs";
import { hmac, randomHex, sha256, toHex } from "./lib/crypto.mjs";
import { RADII_KM, cellOf } from "./lib/geo.mjs";
import { createMemoryLimiter } from "./lib/ratelimit.mjs";
import { createOverpassProxy } from "./lib/overpass.mjs";
import { isToken, isUuid, parseRepair } from "./lib/validate.mjs";
import { createRepo } from "./repo.mjs";
import { REPAIR_SERVICES } from "../src/js/shared/services.js";

const CACHE_REPAIRS = "public, max-age=30, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400";
const CACHE_OVERPASS = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800";
const SECURITY = { "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin" };
const AREA_FRESH_MS = 10_000; // une même zone n'est relue en base qu'une fois par 10 s et par instance
const AREA_STALE_MS = 3600_000; // et sa dernière bonne réponse sert jusqu'à 1 h quand la base ne répond plus

// Prestations déclarables : celles de la page (src/js/shared/services.js), « autre » comprise, contrôle technique exclu.
export async function loadServices() {
  return new Set(REPAIR_SERVICES);
}

// Erreur qui tient à la DONNÉE refusée par la base (contrainte violée, valeur hors limites : classes SQLSTATE 22 et 23), pas
// à son état. La base a répondu : renvoyer la même requête donnerait le même refus, et ce n'est pas une panne.
const isDataError = (e) => /^(22|23)/.test(String((e && e.code) || ""));

// Disjoncteur : après plusieurs échecs de suite, on cesse d'attendre une base qui ne répond pas (chaque requête
// attendrait le délai de connexion) et on la sonde de nouveau après cooldownMs. Une donnée refusée n'est pas un échec :
// sinon quelques requêtes mal formées suffiraient à écarter la base pour tout le monde.
function createBreaker({ threshold = 4, cooldownMs = 5000, now = Date.now } = {}) {
  let failures = 0, openUntil = 0;
  return {
    async run(fn) {
      if (now() < openUntil) throw Object.assign(new Error("base indisponible (disjoncteur ouvert)"), { unavailable: true });
      try {
        const out = await fn();
        failures = 0;
        return out;
      } catch (e) {
        if (isDataError(e)) {
          failures = 0;
          throw e;
        }
        if (++failures >= threshold) openUntil = now() + cooldownMs;
        throw Object.assign(e, { unavailable: true });
      }
    },
    get open() {
      return now() < openUntil;
    },
  };
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const unavailable = (headers = {}) => apiError(503, "unavailable", "Service momentanément indisponible. Réessayez dans quelques secondes.", {}, { "retry-after": "5", ...headers });

export function createApp({ db, config, services, fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, overpassOptions = {} }) {
  const repo = createRepo(db);
  const breaker = createBreaker({ now });
  const proxy = createOverpassProxy({ repo, fetchImpl, now, log, userAgent: config.overpassUserAgent, ...overpassOptions });
  const readLimiter = createMemoryLimiter({ limit: config.readLimitPerMinute, windowMs: 60_000, now });
  const missLimiter = createMemoryLimiter({ limit: config.upstreamMissLimitPerMinute, windowMs: 60_000, now });
  const areaCache = new Map(); // « y,x,rayon » → { text, etag, at }
  const areaInflight = new Map();
  const textOf = new WeakMap(); // réponse Overpass (objet) → texte JSON
  let draining = false; // arrêt demandé : /readyz répond 503 pour que le répartiteur nous retire avant la fermeture

  // ---- adresse du visiteur (jamais journalisée en clair ; seule son empreinte sert à limiter les écritures)
  let warnedProxy = false;
  const clientIp = (request, ctx) => {
    const mode = config.trustProxy;
    if (mode === 0 && !warnedProxy && (request.headers.has("x-forwarded-for") || request.headers.has("cf-connecting-ip"))) {
      warnedProxy = true; // un relais est devant nous et TRUST_PROXY ne le sait pas : toutes les adresses sont celles du relais
      log({ level: "warn", msg: "en-tête de relais reçu alors que TRUST_PROXY=0 : tous les visiteurs partagent la même limite de débit. Régler TRUST_PROXY (nombre de relais ou cloudflare)." });
    }
    if (mode === "cloudflare") return request.headers.get("cf-connecting-ip") || ctx.remoteIp || "unknown";
    if (mode > 0) {
      const hops = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (hops.length >= mode) return hops[hops.length - mode];
    }
    return ctx.remoteIp || "unknown";
  };

  // ---- GET /v1/repairs
  async function getRepairs(request, url) {
    const num = (name) => {
      const raw = url.searchParams.get(name);
      return raw !== null && raw.trim() !== "" ? Number(raw) : NaN;
    };
    const lat = num("lat"), lon = num("lon"), radius = num("radius");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return apiError(400, "bad_request", "lat et lon (degrés décimaux) requis.");
    if (!RADII_KM.includes(radius)) return apiError(400, "bad_request", `radius : l'une de ces valeurs en km : ${RADII_KM.join(", ")}.`);

    const cell = cellOf(lat, lon);
    const key = `${cell.y},${cell.x},${radius}`;
    const hit = areaCache.get(key);
    let text, etag, stale = false;
    if (hit && now() - hit.at < AREA_FRESH_MS) ({ text, etag } = hit);
    else {
      let flight = areaInflight.get(key);
      if (!flight) {
        flight = breaker
          .run(() => repo.listArea({ lat, lon, radiusKm: radius }))
          .then(async (area) => {
            const body = JSON.stringify({ v: 1, cell: area.cell, radius, generatedAt: new Date(now()).toISOString(), truncated: area.truncated, garages: area.garages });
            const entry = { text: body, etag: await etagOf(body), at: now() }; // sérialisé et empreinte calculés une fois pour toutes les requêtes des 10 s qui suivent
            areaCache.set(key, entry);
            if (areaCache.size > 300) areaCache.delete(areaCache.keys().next().value);
            return entry;
          })
          .finally(() => areaInflight.delete(key));
        areaInflight.set(key, flight);
      }
      try {
        ({ text, etag } = await flight);
      } catch (e) {
        log({ level: "error", msg: "lecture des réparations impossible", error: e.message });
        if (hit && now() - hit.at < AREA_STALE_MS) {
          ({ text, etag } = hit);
          stale = true;
        } else return unavailable();
      }
    }
    if (stale) return new Response(text, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=5", "x-pixcar-stale": "1", etag } });
    return etagResponse(request, 200, text, { "cache-control": CACHE_REPAIRS }, etag);
  }

  // ---- POST /v1/repairs
  async function verifyTurnstile(token, ip) {
    if (!config.turnstileSecret) return "ok";
    if (!token) return "missing";
    try {
      const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(3000),
      });
      const out = await res.json();
      return out && out.success === true ? "ok" : "failed";
    } catch {
      return "unreachable";
    }
  }

  async function postRepair(request, ctx) {
    const ip = clientIp(request, ctx);
    const body = await readJson(request, 8192);
    if (body.error === "content_type") return apiError(415, "unsupported_media_type", "Content-Type : application/json attendu.");
    if (body.error === "too_large") return apiError(413, "too_large", "Corps de requête trop grand (8 Ko au plus).");
    if (body.error) return apiError(400, "bad_json", "JSON illisible.");

    const parsed = parseRepair(body.value, { services, today: utcDate(now() + 14 * 3600_000) }); // jusqu'à UTC+14 : « aujourd'hui » chez le visiteur
    if (parsed.fields) return apiError(422, "validation", "Déclaration refusée : un ou plusieurs champs sont invalides.", { fields: parsed.fields });

    const captcha = await verifyTurnstile(request.headers.get("x-turnstile-token"), ip);
    if (captcha === "missing" || captcha === "failed") return apiError(403, "captcha_failed", "Vérification anti-robot échouée.");
    if (captcha === "unreachable") return apiError(503, "captcha_unavailable", "Vérification anti-robot momentanément indisponible.", {}, { "retry-after": "30" });

    const v = parsed.value;
    let result;
    try {
      // empreintes en hexadécimal (64 caractères) : c'est ainsi que la base les garde (DSQL n'indexe pas bytea)
      const [plateHash, ipHash] = (await Promise.all([hmac(config.plateSecret, v.plate), hmac(config.ipSecret, ip)])).map(toHex);
      const tokenHash = toHex(await sha256(v.deleteToken));
      result = await breaker.run(() =>
        repo.insertRepair(v, { tokenHash, plateHash, ipHash, limitPerHour: config.writeLimitPerHour, limitGlobalPerMinute: config.writeLimitGlobalPerMinute, moderate: config.moderation === "auto" }),
      );
    } catch (e) {
      if (isDataError(e)) {
        // la validation de l'API a laissé passer ce que la base refuse : à corriger, mais renvoyer la requête n'y changerait rien
        log({ level: "error", msg: "déclaration refusée par une contrainte de la base : validation de l'API incomplète", error: e.message, code: e.code });
        return apiError(422, "validation", "Déclaration refusée : une valeur n'est pas acceptée.");
      }
      log({ level: "error", msg: "écriture impossible", error: e.message });
      return unavailable();
    }
    switch (result.kind) {
      case "created":
        return json(201, { id: v.id, status: result.status }, { "cache-control": "no-store" });
      case "replay":
        return json(200, { id: v.id, status: result.status, replayed: true }, { "cache-control": "no-store" });
      case "conflict":
        return apiError(409, "id_conflict", "Cet identifiant est déjà utilisé.");
      case "duplicate":
        return apiError(409, "duplicate", "Cette réparation a déjà été déclarée (même plaque, garage, prestation et jour).");
      default:
        return apiError(429, "rate_limited", "Trop de déclarations depuis cette adresse. Réessayez plus tard.", {}, { "retry-after": String(result.retryAfter) });
    }
  }

  // ---- DELETE /v1/repairs/:id
  async function deleteRepair(request, id) {
    const token = request.headers.get("x-delete-token") || "";
    if (!isUuid(id) || !isToken(token)) return apiError(404, "not_found", "Réparation introuvable.");
    try {
      const ok = await breaker.run(async () => repo.deleteRepair(id.toLowerCase(), toHex(await sha256(token.toLowerCase()))));
      return ok ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : apiError(404, "not_found", "Réparation introuvable.");
    } catch (e) {
      log({ level: "error", msg: "suppression impossible", error: e.message });
      return unavailable();
    }
  }

  // ---- GET /v1/overpass
  async function getOverpass(request, url, ip) {
    const out = await proxy.get(url.searchParams.get("data"), { onMiss: () => missLimiter.check(ip).ok });
    if (out.status === 400) return apiError(400, "bad_query", "Requête non reconnue.");
    if (out.status === 429) return apiError(429, "busy", "Serveur occupé, réessayez dans un instant.", {}, { "retry-after": "10" });
    if (out.status !== 200) return apiError(502, "upstream_unavailable", "Les serveurs OpenStreetMap ne répondent pas.", {}, { "retry-after": "15" });
    let cached = textOf.get(out.body);
    if (!cached) {
      const text = JSON.stringify(out.body); // la même réponse sert des milliers de visiteurs : sérialisée et empreinte calculée une seule fois
      textOf.set(out.body, (cached = { text, etag: await etagOf(text) }));
    }
    return etagResponse(request, 200, cached.text, out.stale ? { "cache-control": "public, max-age=60", "x-pixcar-stale": "1" } : { "cache-control": CACHE_OVERPASS, "x-pixcar-source": out.source }, cached.etag);
  }

  async function route(request, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (path === "/healthz") return method === "GET" || method === "HEAD" ? json(200, { ok: true }, { "cache-control": "no-store" }) : methodNotAllowed("GET");
    if (path === "/readyz") {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET");
      if (draining) return json(503, { ok: false, draining: true }, { "cache-control": "no-store", "retry-after": "5" });
      try {
        await Promise.race([repo.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), 1000))]);
        return json(200, { ok: true, db: "up" }, { "cache-control": "no-store" });
      } catch (e) {
        return json(503, { ok: false, db: "down" }, { "cache-control": "no-store", "retry-after": "5" });
      }
    }

    const ip = clientIp(request, ctx);
    if (path === "/v1/repairs") {
      if (method === "GET") return limited(readLimiter.check(ip)) || getRepairs(request, url);
      if (method === "POST") return postRepair(request, ctx);
      return methodNotAllowed("GET, POST");
    }
    const one = /^\/v1\/repairs\/([^/]+)$/.exec(path);
    if (one) {
      if (method !== "DELETE") return methodNotAllowed("DELETE");
      let id = "";
      try {
        id = decodeURIComponent(one[1]);
      } catch {} // pourcentage mal formé : l'identifiant ne sera pas reconnu, la réponse sera « introuvable »
      return limited(readLimiter.check(ip)) || deleteRepair(request, id);
    }
    if (path === "/v1/overpass") return method === "GET" ? limited(readLimiter.check(ip)) || getOverpass(request, url, ip) : methodNotAllowed("GET");
    return apiError(404, "not_found", "Route inconnue.");
  }
  const methodNotAllowed = (allow) => apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow });
  const limited = (check) => (check.ok ? null : apiError(429, "rate_limited", "Trop de requêtes. Réessayez dans un instant.", {}, { "retry-after": String(check.retryAfter) }));

  return {
    repo,
    overpass: proxy,
    async fetch(request, ctx = {}) {
      const started = now();
      const id = /^[\w.-]{8,64}$/.test(request.headers.get("x-request-id") || "") ? request.headers.get("x-request-id") : randomHex(8);
      const cors = corsHeaders(request.headers.get("origin"), config.allowedOrigins);
      let response;
      try {
        if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
        else {
          let timer;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(unavailable()), config.requestTimeoutMs);
          });
          try {
            response = await Promise.race([route(request, ctx), timeout]);
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (e) {
        log({ level: "error", msg: "erreur non prévue", id, error: e && e.message });
        response = apiError(500, "internal", "Erreur interne.");
      }
      withHeaders(response, { ...SECURITY, ...cors, "x-request-id": id });
      log({ level: "info", msg: "requête", id, method: request.method, path: new URL(request.url).pathname, status: response.status, ms: now() - started });
      return response;
    },
    // à lancer toutes les heures (index.mjs) : purge des journaux, caches et déclarations périmés
    maintenance: () => repo.purge({ repairRetentionMonths: config.repairRetentionMonths }),
    drain() {
      draining = true;
    },
    async close() {
      await db.close();
    },
  };
}
