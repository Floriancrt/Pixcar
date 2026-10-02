// Limiteur à fenêtre fixe, en mémoire : freine un client trop bavard sur UNE instance. La limite qui compte pour les
// écritures vit dans la base (table write_log), commune à toutes les instances ; pour les lectures, la vraie protection
// est le cache du CDN et la limitation du pare-feu en amont.
export function createMemoryLimiter({ limit, windowMs, now = Date.now, maxKeys = 10_000 }) {
  const hits = new Map();
  return {
    check(key) {
      const t = now();
      let e = hits.get(key);
      if (!e || t >= e.reset) {
        if (hits.size >= maxKeys) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear(); // sous attaque : on préfère oublier que grossir
        e = { n: 0, reset: t + windowMs };
        hits.set(key, e);
      }
      e.n++;
      return { ok: e.n <= limit, retryAfter: Math.max(1, Math.ceil((e.reset - t) / 1000)) };
    },
  };
}
