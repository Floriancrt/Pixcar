// Client HTTP de l'API : délai maximal, nouvelles tentatives espacées, disjoncteur.
//
// Rien ici ne lève d'exception : chaque appel rend { ok, status, data, headers, kind, retryAfter }.
//   kind : "ok" · "client" (4xx : la requête est en cause) · "server" (5xx) · "network" (aucune réponse)
//          "timeout" (pas de réponse à temps) · "circuit" (disjoncteur ouvert : rien n'a été envoyé)
//
// Toutes les requêtes de la page sont rejouables sans risque (lecture, déclaration à identifiant fixe, suppression) :
// on peut donc les retenter après un échec dont on ignore s'il a atteint le serveur.
//
// Le disjoncteur évite de faire attendre le visiteur (délai × tentatives) sur un serveur qui ne répond plus : après
// `threshold` APPELS échoués de suite (un appel qui épuise ses tentatives compte pour un), plus aucune requête ne part
// pendant `cooldownMs` ; ensuite une requête sert de sonde.

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export function createClient({
  base,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  timeoutMs = 6000,
  retries = 2,
  backoffMs = 400,
  breaker = { threshold: 3, cooldownMs: 30_000 },
} = {}) {
  let failures = 0;
  let openUntil = 0;

  async function once(method, path, { body, headers, timeout }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(base + path, { method, headers, body, signal: controller.signal, credentials: "omit" });
      let data = null;
      if (res.status !== 204 && res.status !== 304) {
        const text = await res.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
      }
      const retryAfter = Math.min(60, Number(res.headers.get("retry-after")) || 0);
      const kind = res.ok ? "ok" : res.status >= 500 ? "server" : "client";
      return { ok: res.ok, status: res.status, data, headers: res.headers, kind, retryAfter };
    } catch {
      return { ok: false, status: 0, data: null, kind: controller.signal.aborted ? "timeout" : "network", retryAfter: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // le réseau est revenu (événement « online ») : on n'attend pas la fin du délai du disjoncteur
    reset() {
      failures = 0;
      openUntil = 0;
    },

    // « closed » : tout part · « open » : rien ne part · « half-open » : la prochaine requête sert de sonde
    get state() {
      if (now() < openUntil) return "open";
      return failures >= breaker.threshold ? "half-open" : "closed";
    },

    async request(method, path, { body, headers = {}, retries: maxRetries = retries, timeoutMs: timeout = timeoutMs } = {}) {
      const h = { accept: "application/json", ...headers };
      let payload;
      if (body !== undefined) {
        payload = typeof body === "string" ? body : JSON.stringify(body);
        h["content-type"] = "application/json";
      }
      for (let attempt = 0; ; attempt++) {
        if (now() < openUntil) return { ok: false, status: 0, data: null, kind: "circuit", retryAfter: Math.ceil((openUntil - now()) / 1000) };
        const out = await once(method, path, { body: payload, headers: h, timeout });
        const infrastructureFailure = out.status === 0 || out.status >= 500;
        if (!infrastructureFailure) {
          failures = 0; // le serveur répond : un 4xx est notre erreur, pas la sienne
          return out;
        }
        const retryable = out.status === 0 || RETRYABLE_STATUS.has(out.status);
        if (!retryable || attempt >= maxRetries) {
          if (++failures >= breaker.threshold) openUntil = now() + breaker.cooldownMs; // l'appel a échoué pour de bon
          return out;
        }
        // attente exponentielle avec gigue (0,5 à 1,5 fois), ou le délai demandé par le serveur
        await sleep(out.retryAfter ? out.retryAfter * 1000 : backoffMs * 2 ** attempt * (0.5 + random()));
      }
    },
  };
}
