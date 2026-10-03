// Relais Overpass : requête reconnue, cache, cascade de serveurs, périmé en cas de panne, limites.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { overpassQuery } from "../../src/js/shared/overpass.js";
import { get, makeApp } from "./helpers.mjs";

const FAST = { staggerMs: 25, timeoutMs: 400 };
const query = (lat = 45.7347, lon = 4.9128, m = 10000) => encodeURIComponent(overpassQuery(lat, lon, m));
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(Object.assign(new Error("annulé"), { name: "AbortError" }))));
  });

// Faux serveurs Overpass : un comportement par hôte (délai, code d'erreur, corps).
function upstream(behaviour = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = { host: u.host, data: u.searchParams.get("data"), ua: init.headers["user-agent"], signal: init.signal };
    calls.push(call);
    const b = behaviour[u.host] || {};
    await sleep(b.delay || 0, init.signal);
    if (b.status) return new Response("erreur", { status: b.status });
    if (b.raw !== undefined) return new Response(b.raw, { status: 200 });
    return new Response(JSON.stringify(b.json || { elements: [{ type: "node", id: 1, lat: 45.73, lon: 4.91, tags: { name: "Norauto", shop: "car_repair", source: "bing", note: "à ne pas garder" } }] }), { status: 200 });
  };
  return { fetchImpl, calls };
}
const A = "overpass-api.de", B = "overpass.openstreetmap.fr", C = "maps.mail.ru";

describe("GET /v1/overpass", () => {
  test("only the exact query the page produces is relayed; anything else is a 400 and never reaches OpenStreetMap", async () => {
    const up = upstream();
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      const canonical = overpassQuery(45.7347, 4.9128, 10000);
      for (const data of [
        "",
        "[out:json];node(1);out;",
        canonical.replace("10000", "12345"), // rayon que la page ne propose pas
        canonical + "out;", // requête rallongée
        canonical.replace('"shop"="car"', '"shop"="bank"'),
        canonical.replace("45.7347", "95.7347"),
      ]) {
        const res = await t.call("GET", `/v1/overpass?data=${encodeURIComponent(data)}`);
        assert.equal(res.status, 400, data.slice(0, 40));
        assert.equal((await res.json()).error.code, "bad_query");
      }
      assert.equal((await t.call("GET", "/v1/overpass")).status, 400);
      assert.equal(up.calls.length, 0);
    } finally {
      await t.close();
    }
  });

  test("answers with slimmed elements, asks upstream for the rounded centre (+100 m), and identifies itself", async () => {
    const up = upstream();
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST, config: { overpassUserAgent: "Pixcar/test (contact@pixcar.test)" } });
    try {
      const res = await t.call("GET", `/v1/overpass?data=${query()}`);
      const out = await get(res);
      assert.equal(out.status, 200);
      assert.equal(out.json.server, "overpass-api.de");
      assert.deepEqual(out.json.elements[0].tags, { name: "Norauto", shop: "car_repair" }, "seules les balises utiles sont gardées");
      assert.ok(out.json.generatedAt);
      assert.equal(res.headers.get("cache-control"), "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800");
      assert.equal(res.headers.get("x-pixcar-source"), "upstream");
      assert.equal(up.calls.length, 1);
      assert.equal(decodeURIComponent(up.calls[0].data), overpassQuery(45.735, 4.913, 10100));
      assert.equal(up.calls[0].ua, "Pixcar/test (contact@pixcar.test)");
    } finally {
      await t.close();
    }
  });

  test("the second request is served from memory, and neighbours (same 3-decimal centre) share the answer", async () => {
    const up = upstream();
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      await t.call("GET", `/v1/overpass?data=${query(45.73471, 4.91282)}`);
      const second = await t.call("GET", `/v1/overpass?data=${query(45.73468, 4.91279)}`);
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-pixcar-source"), "memory");
      assert.equal(up.calls.length, 1);
      const etag = second.headers.get("etag");
      assert.match(etag, /^W\//);
      assert.equal((await t.call("GET", `/v1/overpass?data=${query(45.73471, 4.91282)}`, { headers: { "if-none-match": etag } })).status, 304);
      await t.call("GET", `/v1/overpass?data=${query(45.9, 4.9)}`);
      assert.equal(up.calls.length, 2, "une autre zone interroge OpenStreetMap");
    } finally {
      await t.close();
    }
  });

  test("a slow first server is overtaken by the next one, which is then abandoned when one answers", async () => {
    const up = upstream({ [A]: { delay: 300 }, [B]: { json: { elements: [{ type: "node", id: 7, lat: 1, lon: 1, tags: { name: "Rapide" } }] } } });
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      const out = await get(await t.call("GET", `/v1/overpass?data=${query()}`));
      assert.equal(out.json.server, "OpenStreetMap France");
      assert.equal(out.json.elements[0].tags.name, "Rapide");
      assert.equal(up.calls[0].host, A);
      assert.equal(up.calls[0].signal.aborted, true, "la requête lente est abandonnée");
    } finally {
      await t.close();
    }
  });

  test("failing servers are skipped (429, 504, unreadable, interrupted); the metropolitan-only one is not asked about overseas areas", async () => {
    const up = upstream({ [A]: { status: 429 }, [B]: { status: 504 }, [C]: { json: { elements: [{ type: "node", id: 2, lat: 14.6, lon: -61, tags: { name: "Fort-de-France" } }] } } });
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      const out = await get(await t.call("GET", `/v1/overpass?data=${query(14.6, -61.07)}`));
      assert.equal(out.status, 200);
      assert.equal(out.json.server, "VK Maps");
      assert.deepEqual(up.calls.map((c) => c.host), [A, C], "outre-mer : le serveur métropolitain n'est pas interrogé");
    } finally {
      await t.close();
    }
    const odd = upstream({ [A]: { raw: "<html>pas du json</html>" }, [B]: { json: { elements: [], remark: "runtime error: Query timed out in \"query\" at line 4 after 25 seconds." } }, [C]: {} });
    const t2 = await makeApp({ fetchImpl: odd.fetchImpl, overpassOptions: FAST });
    try {
      const out = await get(await t2.call("GET", `/v1/overpass?data=${query()}`));
      assert.equal(out.json.server, "VK Maps");
    } finally {
      await t2.close();
    }
  });

  test("when every server fails: 502 with Retry-After and nothing cached; later a recovered server is used", async () => {
    const down = { [A]: { status: 503 }, [B]: { status: 503 }, [C]: { status: 503 } };
    const behaviour = { ...down };
    const up = upstream(behaviour);
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      const res = await t.call("GET", `/v1/overpass?data=${query()}`);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error.code, "upstream_unavailable");
      assert.ok(res.headers.get("retry-after"));
      for (const h of [A, B, C]) delete behaviour[h];
      assert.equal((await t.call("GET", `/v1/overpass?data=${query()}`)).status, 200, "l'échec n'est pas mémorisé");
    } finally {
      await t.close();
    }
  });

  test("when every server fails, the previous answer is served even if old, flagged as stale (and cached only briefly)", async () => {
    const behaviour = {};
    const up = upstream(behaviour);
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: { ...FAST, freshSeconds: 0 } }); // rien n'est jamais « frais » : chaque demande réinterroge
    try {
      assert.equal((await t.call("GET", `/v1/overpass?data=${query()}`)).status, 200);
      for (const h of [A, B, C]) behaviour[h] = { status: 503 };
      const stale = await t.call("GET", `/v1/overpass?data=${query()}`);
      assert.equal(stale.status, 200);
      assert.equal(stale.headers.get("x-pixcar-stale"), "1");
      assert.equal(stale.headers.get("cache-control"), "public, max-age=60");
      assert.equal((await stale.json()).elements[0].tags.name, "Norauto");
    } finally {
      await t.close();
    }
  });

  test("the database keeps answers across restarts: a new instance serves them without asking OpenStreetMap", async () => {
    const up = upstream();
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      await t.call("GET", `/v1/overpass?data=${query()}`);
      await new Promise((r) => setTimeout(r, 50)); // l'écriture en base est lancée sans attendre la réponse
      const { createOverpassProxy } = await import("../lib/overpass.mjs");
      const fresh = createOverpassProxy({ repo: t.app.repo, fetchImpl: up.fetchImpl, ...FAST });
      const out = await fresh.get(decodeURIComponent(query()));
      assert.equal(out.status, 200);
      assert.equal(out.source, "db");
      assert.equal(up.calls.length, 1);
    } finally {
      await t.close();
    }
  });

  test("a stale database copy is served when upstream is down and the memory is empty", async () => {
    const behaviour = { [A]: { status: 500 }, [B]: { status: 500 }, [C]: { status: 500 } };
    const up = upstream(behaviour);
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST });
    try {
      await t.app.repo.putUpstream("45.735,4.913,10000", { elements: [{ type: "node", id: 3, lat: 1, lon: 1, tags: { name: "Copie" } }], generatedAt: "2026-09-01T00:00:00Z" });
      await t.db.query("UPDATE upstream_cache SET fetched_at = now() - interval '3 days'");
      const res = await t.call("GET", `/v1/overpass?data=${query()}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-pixcar-stale"), "1");
      await t.db.query("UPDATE upstream_cache SET fetched_at = now() - interval '9 days'");
      const { createOverpassProxy } = await import("../lib/overpass.mjs");
      const fresh = createOverpassProxy({ repo: t.app.repo, fetchImpl: up.fetchImpl, ...FAST });
      assert.equal((await fresh.get(decodeURIComponent(query()))).status, 502, "au-delà de 7 jours on préfère ne rien servir");
    } finally {
      await t.close();
    }
  });

  test("concurrent requests for one area share a single upstream call", async () => {
    const up = upstream({ [A]: { delay: 15 } }); // plus court que le délai de la cascade : le serveur suivant n'est pas sollicité
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: { ...FAST, staggerMs: 200 }, config: { readLimitPerMinute: 1000 } });
    try {
      const all = await Promise.all(Array.from({ length: 8 }, () => t.call("GET", `/v1/overpass?data=${query()}`)));
      assert.ok(all.every((r) => r.status === 200));
      assert.equal(up.calls.length, 1);
    } finally {
      await t.close();
    }
  });

  test("at most N upstream calls at once (the mirrors would ban us otherwise); the others are told to retry", async () => {
    const up = upstream({ [A]: { delay: 100 } });
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: { ...FAST, maxConcurrent: 1 }, config: { readLimitPerMinute: 1000, upstreamMissLimitPerMinute: 1000 } });
    try {
      const [first, second] = await Promise.all([t.call("GET", `/v1/overpass?data=${query(45.7, 4.9)}`), t.call("GET", `/v1/overpass?data=${query(46.7, 5.9)}`)]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, "busy");
      assert.ok(second.headers.get("retry-after"));
    } finally {
      await t.close();
    }
  });

  test("with the default settings, four upstream calls at once at most: of six zones asked together, two are told to retry", async () => {
    const up = upstream({ [A]: { delay: 150 } });
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: { ...FAST }, config: { readLimitPerMinute: 1000, upstreamMissLimitPerMinute: 1000 } });
    try {
      const all = await Promise.all(Array.from({ length: 6 }, (_, i) => t.call("GET", `/v1/overpass?data=${query(45 + i * 0.3, 4.9)}`)));
      assert.deepEqual(all.map((r) => r.status).sort(), [200, 200, 200, 200, 429, 429]);
    } finally {
      await t.close();
    }
  });

  test("the in-memory copies are bounded in number and in bytes (a big city's 50 km area is several MB)", async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ type: "node", id: i, lat: 45, lon: 4, tags: { name: "Garage numéro " + i + " ".repeat(200) } })); // ≈ 100 Ko par zone
    const up = upstream({ [A]: { json: { elements: big } } });
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: { ...FAST, memoryBytes: 250_000, memoryEntries: 100 }, config: { readLimitPerMinute: 1000, upstreamMissLimitPerMinute: 1000 } });
    try {
      for (let i = 0; i < 6; i++) assert.equal((await t.call("GET", `/v1/overpass?data=${query(45 + i / 10, 4.9)}`)).status, 200);
      const stats = t.app.overpass.stats();
      assert.ok(stats.memoryBytes <= 250_000 + 130_000 && stats.memory <= 3, JSON.stringify(stats)); // jamais plus que la limite, plus la dernière zone posée
      const again = await t.call("GET", `/v1/overpass?data=${query(45, 4.9)}`); // la plus ancienne a été oubliée en mémoire, la base la sert
      assert.equal(again.status, 200);
      assert.equal(again.headers.get("x-pixcar-source"), "db");
    } finally {
      await t.close();
    }
  });

  test("a visitor can only trigger so many upstream calls per minute; cached areas stay free", async () => {
    const up = upstream();
    const t = await makeApp({ fetchImpl: up.fetchImpl, overpassOptions: FAST, config: { upstreamMissLimitPerMinute: 2, readLimitPerMinute: 1000 } });
    try {
      for (const lat of [45.1, 45.3]) assert.equal((await t.call("GET", `/v1/overpass?data=${query(lat, 4.9)}`)).status, 200);
      assert.equal((await t.call("GET", `/v1/overpass?data=${query(45.5, 4.9)}`)).status, 429, "troisième zone inconnue en une minute");
      assert.equal((await t.call("GET", `/v1/overpass?data=${query(45.1, 4.9)}`)).status, 200, "zone déjà en cache : gratuite");
      assert.equal((await t.call("GET", `/v1/overpass?data=${query(45.5, 4.9)}`, { ip: "198.51.100.200" })).status, 200, "un autre visiteur n'est pas touché");
    } finally {
      await t.close();
    }
  });
});
