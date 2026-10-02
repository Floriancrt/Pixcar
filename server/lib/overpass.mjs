// Relais avec cache vers l'API Overpass (OpenStreetMap), pour la page.
//
// Pourquoi : les serveurs Overpass publics sont lents et parfois saturés. Ce relais
//   - n'exécute que la requête exacte que produit la page (parseOverpassQuery), jamais une requête arbitraire ;
//   - arrondit le centre à 3 décimales (≈ 80 m) : deux visiteurs d'un même quartier partagent une réponse ;
//   - interroge les serveurs en cascade (le suivant part si le premier tarde, comme la page) ;
//   - garde les réponses en mémoire puis en base, et les sert PÉRIMÉES quand tous les serveurs échouent ;
//   - ne garde de chaque élément que les balises utilisées (slimElements) : réponse plus légère ;
//   - ne lance qu'une requête amont à la fois pour une même zone, et en limite le nombre simultané.
import { OVERPASS_MIRRORS, inMetroFrance, overpassQuery, parseOverpassQuery, slimElements } from "../../src/js/shared/overpass.js";

const MARGIN_M = 100; // le centre est arrondi : on couvre 100 m de plus pour ne perdre aucun garage au bord du rayon

export function createOverpassProxy({
  repo,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  mirrors = OVERPASS_MIRRORS,
  userAgent = "Pixcar",
  log = () => {},
  timeoutMs = 25_000,
  staggerMs = 4_000,
  freshSeconds = 24 * 3600, // au-delà, on réinterroge OpenStreetMap
  staleSeconds = 7 * 24 * 3600, // au-delà, on préfère ne rien servir
  memoryEntries = 100,
  maxConcurrent = 4,
} = {}) {
  const memory = new Map(); // key → { body, at }
  const inflight = new Map(); // key → Promise
  let upstreamRunning = 0;

  const remember = (key, body, at) => {
    memory.delete(key);
    memory.set(key, { body, at });
    while (memory.size > memoryEntries) memory.delete(memory.keys().next().value);
  };
  const fromMemory = (key) => {
    const hit = memory.get(key);
    return hit ? { body: hit.body, ageSeconds: Math.floor((now() - hit.at) / 1000) } : null;
  };

  async function fetchOne(mirror, query, signal) {
    const res = await fetchImpl(`${mirror.url}?data=${encodeURIComponent(query)}`, { signal, headers: { "user-agent": userAgent, accept: "application/json" } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const json = await res.json();
    if (!json || !Array.isArray(json.elements)) throw new Error("réponse illisible");
    if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error("requête interrompue par le serveur");
    return json;
  }

  // Cascade « couverte » : le serveur suivant part au bout de staggerMs (ou tout de suite si le précédent échoue), le premier qui répond gagne.
  function hedged(lat, lon, radiusM) {
    const query = overpassQuery(lat, lon, radiusM + MARGIN_M);
    const list = mirrors.filter((m) => !m.metro || inMetroFrance(lat, lon));
    return new Promise((resolve, reject) => {
      const controllers = [];
      const failures = [];
      let started = 0, finished = 0, done = false, timer = null;
      const startNext = () => {
        clearTimeout(timer);
        if (done || started >= list.length) return;
        const mirror = list[started++];
        const ctl = new AbortController();
        controllers.push(ctl);
        const killer = setTimeout(() => ctl.abort(), timeoutMs);
        fetchOne(mirror, query, ctl.signal)
          .then((json) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            controllers.forEach((c) => c !== ctl && c.abort());
            resolve({ json, server: mirror.name });
          })
          .catch((e) => {
            if (done) return;
            failures.push(`${mirror.name} : ${ctl.signal.aborted ? "pas de réponse à temps" : e.message}`);
            finished++;
            if (finished >= list.length) {
              done = true;
              reject(Object.assign(new Error("tous les serveurs Overpass ont échoué"), { failures }));
            } else startNext();
          })
          .finally(() => clearTimeout(killer));
        if (started < list.length) timer = setTimeout(startNext, staggerMs);
      };
      startNext();
    });
  }

  async function refresh(key, q, onMiss) {
    if (upstreamRunning >= maxConcurrent || (onMiss && !onMiss())) return { refused: true };
    upstreamRunning++;
    try {
      const { json, server } = await hedged(q.lat, q.lon, q.radiusM);
      const body = { elements: slimElements(json.elements), server, generatedAt: new Date(now()).toISOString() };
      remember(key, body, now());
      repo?.putUpstream(key, body).catch((e) => log(`overpass : cache en base impossible : ${e.message}`));
      return { body };
    } catch (e) {
      log(`overpass : échec amont (${key}) : ${(e.failures || [e.message]).join(" · ")}`);
      return { failed: true };
    } finally {
      upstreamRunning--;
    }
  }

  // Résout une zone : copie de la base si elle est plus fraîche que celle de la mémoire, sinon OpenStreetMap, et en dernier
  // recours une copie périmée. Partagée par tous les visiteurs qui demandent la même zone en même temps.
  async function resolve(key, q, onMiss, memoryHit) {
    let hit = memoryHit;
    if (repo) {
      try {
        const row = await repo.getUpstream(key); // une autre instance a peut-être renouvelé la copie de la base
        if (row && (!hit || row.ageSeconds < hit.ageSeconds)) {
          hit = { body: row.body, ageSeconds: row.ageSeconds };
          if (row.ageSeconds < freshSeconds) {
            remember(key, row.body, now() - row.ageSeconds * 1000);
            return { status: 200, body: row.body, stale: false, source: "db" };
          }
        }
      } catch (e) {
        log(`overpass : lecture du cache en base impossible : ${e.message}`);
      }
    }
    const out = await refresh(key, q, onMiss);
    if (out.body) return { status: 200, body: out.body, stale: false, source: "upstream" };
    if (hit && hit.ageSeconds < staleSeconds) return { status: 200, body: hit.body, stale: true, source: "stale" };
    return out.refused ? { status: 429, code: "busy" } : { status: 502, code: "upstream_unavailable" };
  }

  return {
    // data : paramètre « data » reçu. onMiss() : le visiteur a-t-il encore droit à une requête amont ?
    // → { status: 200, body, stale, source } | { status: 400 | 429 | 502, code }
    async get(data, { onMiss } = {}) {
      const q = parseOverpassQuery(data);
      if (!q) return { status: 400, code: "bad_query" };
      const key = `${q.lat.toFixed(3)},${q.lon.toFixed(3)},${q.radiusM}`;
      q.lat = +q.lat.toFixed(3);
      q.lon = +q.lon.toFixed(3);
      const hit = fromMemory(key);
      if (hit && hit.ageSeconds < freshSeconds) return { status: 200, body: hit.body, stale: false, source: "memory" };
      let flight = inflight.get(key);
      if (!flight) {
        flight = resolve(key, q, onMiss, hit).finally(() => inflight.delete(key));
        inflight.set(key, flight);
      }
      return flight;
    },
    stats: () => ({ memory: memory.size, inflight: inflight.size, upstreamRunning }),
  };
}
