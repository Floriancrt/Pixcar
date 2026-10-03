// scripts/smoke-api.mjs : l'essai que l'on lance contre l'API DÉPLOYÉE. Ici contre une vraie API (vraies connexions HTTP, vraie base),
// et contre des API volontairement défectueuses : un essai qui ne sait pas échouer ne prouve rien.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { smoke } from "../../scripts/smoke-api.mjs";
import { toNodeListener } from "../index.mjs";
import { ORIGIN, makeApp } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/smoke-api.mjs", import.meta.url));
const quick = { waitMs: 100, pollMs: 10 };
const failed = (result) => result.steps.filter((s) => !s.ok).map((s) => s.name);

describe("smoke-api : essai d'une API déployée", () => {
  let ctx, server, base;
  // L'API garde chaque zone lue 10 s en mémoire (comme en production) : entre deux essais, on fait « passer » une minute.
  const clock = { skew: 0 };
  const later = () => (clock.skew += 60_000);
  before(async () => {
    ctx = await makeApp({ config: { writeLimitPerHour: 1000 }, now: () => Date.now() + clock.skew });
    server = http.createServer(toNodeListener(ctx.app));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    later();
  });
  const rows = async () => (await ctx.db.query("SELECT id, garage_id, service_id, price_cents, status, octet_length(plate_hmac) AS plate_bytes, comment FROM repairs")).rows;

  test("API saine : toutes les étapes passent, et la base est revenue à zéro ensuite", async () => {
    const lines = [];
    const result = await smoke(base, { origin: ORIGIN, ...quick, log: (l) => lines.push(l) });
    assert.deepEqual(failed(result), []);
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 13);
    assert.ok(lines.every((l) => l.startsWith("✔")), lines.join("\n"));
    assert.deepEqual(await rows(), [], "l'essai nettoie derrière lui");
  });

  test("--keep : la déclaration d'essai reste en base, avec la plaque seulement sous forme d'empreinte", async () => {
    const result = await smoke(base, { origin: ORIGIN, keep: true, ...quick });
    assert.equal(result.ok, true, failed(result).join(" | "));
    const [row, ...others] = await rows();
    assert.equal(others.length, 0);
    assert.equal(row.garage_id, "custom:essai-pixcar");
    assert.equal(row.service_id, "vidange");
    assert.equal(row.price_cents, 4250);
    assert.equal(row.status, "approved");
    assert.equal(row.plate_bytes, 32);
  });

  test("deux essais de suite ne se gênent pas (plaque tirée au hasard, identifiants neufs)", async () => {
    const a = await smoke(base, { origin: ORIGIN, ...quick });
    later();
    const b = await smoke(base, { origin: ORIGIN, ...quick });
    assert.equal(a.ok && b.ok, true, [...failed(a), ...failed(b)].join(" | "));
  });

  test("la déclaration d'essai est posée loin de toute zone habitée (jamais visible sur la carte d'un visiteur)", async () => {
    await smoke(base, { origin: ORIGIN, keep: true, ...quick });
    const { lat, lon } = (await ctx.db.query("SELECT lat, lon FROM garages WHERE id = 'custom:essai-pixcar'")).rows[0];
    assert.ok(Math.abs(lat) < 5 && lon < -15 && lon > -30, `${lat}, ${lon}`);
  });

  describe("l'essai échoue quand l'API est défectueuse", () => {
    // Une API qui ment : on intercepte les requêtes de l'essai et on les falsifie.
    const through = (patch) => async (url, init = {}) => {
      const forged = await patch(String(url), init);
      return forged || fetch(url, init);
    };
    const reply = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

    test("site non autorisé (ALLOWED_ORIGINS ne contient pas l'origine du site) : échec à la pré-vérification, rien n'est écrit", async () => {
      const result = await smoke(base, { origin: "https://autre-site.example", ...quick });
      assert.equal(result.ok, false);
      assert.match(failed(result)[0], /OPTIONS \/v1\/repairs/);
      assert.equal(result.steps.length, 3, "arrêt dès la première étape qui échoue");
      assert.deepEqual(await rows(), []);
    });

    test("API injoignable : échec sur /healthz avec la cause réseau", async () => {
      const result = await smoke("http://127.0.0.1:1", { origin: ORIGIN, ...quick });
      assert.equal(result.ok, false);
      assert.equal(result.steps.length, 1);
      assert.match(result.steps[0].detail, /ECONNREFUSED|fetch failed|ECONNRESET/);
    });

    test("base en panne (/readyz répond 503) : échec, aucune écriture tentée", async () => {
      const calls = [];
      const result = await smoke(base, { origin: ORIGIN, ...quick, fetchImpl: through((url, init) => { calls.push(init.method); return url.endsWith("/readyz") ? reply(503, { ok: false, db: "down" }) : null; }) });
      assert.equal(result.ok, false);
      assert.equal(failed(result).length, 1);
      assert.ok(!calls.includes("POST"));
    });

    test("base saturée à l'écriture (POST en 503) : échec, arrêt immédiat, rien n'est écrit", async () => {
      const result = await smoke(base, { origin: ORIGIN, ...quick, fetchImpl: through((url, init) => (init.method === "POST" ? reply(503, { error: { code: "unavailable" } }) : null)) });
      assert.equal(result.ok, false);
      assert.match(failed(result)[0], /POST \/v1\/repairs → 201/);
      assert.equal(result.steps.length, 4, "arrêt dès l'écriture refusée");
      assert.deepEqual(await rows(), []);
    });

    test("réponse d'écriture sans autorisation CORS : échec distinct (le navigateur ne pourrait pas lire le résultat)", async () => {
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          const res = await fetch(url, init);
          if (init.method !== "POST") return res;
          return new Response(await res.clone().text(), { status: res.status, headers: [...res.headers].filter(([k]) => k !== "access-control-allow-origin") });
        },
      });
      assert.equal(result.ok, false);
      assert.equal(failed(result).filter((n) => /CORS/.test(n)).length, 1, failed(result).join(" | "));
    });

    test("suppression avec le bon jeton refusée (500) : échec", async () => {
      let token = "";
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          if (init.method === "POST" && !token) token = JSON.parse(init.body).deleteToken;
          if (init.method === "DELETE" && init.headers["x-delete-token"] === token) return reply(500, { error: { code: "internal" } });
          return fetch(url, init);
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /bon jeton → 204/.test(n)), failed(result).join(" | "));
    });

    test("API qui accuse réception sans rien enregistrer : la relecture ne retrouve pas la réparation", async () => {
      const result = await smoke(base, { origin: ORIGIN, ...quick, fetchImpl: through((url, init) => (init.method === "POST" ? reply(201, { status: "approved" }, { "access-control-allow-origin": ORIGIN }) : null)) });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /relue depuis la base/.test(n)), failed(result).join(" | "));
    });

    test("API qui publie le commentaire ou la plaque : échec de la vérification de confidentialité", async () => {
      for (const leak of [{ comment: "secret" }, { plate: "AB-123-CD" }, { immat: "AB-123-CD" }]) {
        const result = await smoke(base, {
          origin: ORIGIN,
          ...quick,
          fetchImpl: async (url, init = {}) => {
            const res = await fetch(url, init);
            if (init.method !== undefined && init.method !== "GET") return res;
            const json = await res.clone().json().catch(() => null);
            if (!json || !json.garages) return res;
            for (const g of json.garages) for (const r of g.repairs) Object.assign(r, leak);
            return reply(200, json, { "access-control-allow-origin": ORIGIN });
          },
        });
        assert.equal(result.ok, false, JSON.stringify(leak));
        assert.ok(failed(result).some((n) => /sans commentaire, sans plaque/.test(n)), JSON.stringify(leak));
      }
    });

    test("API qui publie le jour exact de la réparation : échec", async () => {
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          const res = await fetch(url, init);
          const json = init.method === undefined || init.method === "GET" ? await res.clone().json().catch(() => null) : null;
          if (!json || !json.garages) return res;
          for (const g of json.garages) for (const r of g.repairs) r.month = new Date().toISOString().slice(0, 10);
          return reply(200, json, { "access-control-allow-origin": ORIGIN });
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /sans commentaire, sans plaque/.test(n)));
    });

    test("API qui ne répond pas aux requêtes CORS de la lecture : échec distinct", async () => {
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          const res = await fetch(url, init);
          if (init.method !== undefined && init.method !== "GET") return res;
          const stripped = new Response(await res.clone().text(), { status: res.status, headers: [...res.headers].filter(([k]) => k !== "access-control-allow-origin") });
          return stripped;
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /la lecture porte l'autorisation CORS/.test(n)), failed(result).join(" | "));
    });

    test("API qui accepte n'importe quel jeton de suppression : échec", async () => {
      let genuine = "";
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          if (init.method === "POST" && !genuine) genuine = JSON.parse(init.body).deleteToken;
          if (init.method === "DELETE" && init.headers["x-delete-token"] !== genuine) return new Response(null, { status: 204 });
          return fetch(url, init);
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /mauvais jeton/.test(n)), failed(result).join(" | "));
    });

    test("API qui répond « supprimé » sans toucher à la base : la réparation est toujours lue après le DELETE", async () => {
      let token = "";
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          if (init.method === "POST" && !token) token = JSON.parse(init.body).deleteToken;
          if (init.method === "DELETE" && init.headers["x-delete-token"] === token) return new Response(null, { status: 204 });
          return fetch(url, init);
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /a disparu/.test(n)), failed(result).join(" | "));
    });

    test("API qui crée en double (rejeu ou doublon non détectés) : échec", async () => {
      let first = null;
      const result = await smoke(base, {
        origin: ORIGIN,
        ...quick,
        fetchImpl: async (url, init = {}) => {
          if (init.method === "POST") {
            if (!first) {
              first = init.body;
              return fetch(url, init);
            }
            return reply(201, { status: "approved" }, { "access-control-allow-origin": ORIGIN }); // le rejeu et le doublon « réussissent »
          }
          return fetch(url, init);
        },
      });
      assert.equal(result.ok, false);
      assert.ok(failed(result).some((n) => /rejeu/.test(n)) && failed(result).some((n) => /doublon/.test(n)), failed(result).join(" | "));
    });
  });

  describe("ligne de commande", () => {
    // asynchrone : l'API de l'essai tourne dans ce processus, un appel bloquant l'empêcherait de répondre
    const run = (...args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, ...args]);
        let stdout = "", stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });

    test("API saine : code 0 et message de conclusion", async () => {
      const r = await run(base, "--origin", ORIGIN);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Tout est conforme/);
      assert.doesNotMatch(r.stdout, /✘/);
    });

    test("API défaillante : code 1 et ligne ✘", async () => {
      const r = await run(base, "--origin", "https://autre-site.example");
      assert.equal(r.status, 1);
      assert.match(r.stdout, /✘ OPTIONS/);
      assert.match(r.stdout, /ÉCHEC/);
    });

    test("ligne de commande incorrecte : code 2 et rappel d'usage, sans rien envoyer", async () => {
      for (const args of [[], ["pas-une-adresse"], [base + "/v1"], [base, "--origin", "https://pixcar.fr/"], [base, "--origin"], [base, "--bogus"], [base, base]]) {
        const r = await run(...args);
        assert.equal(r.status, 2, JSON.stringify(args) + " → " + r.stdout + r.stderr);
        assert.match(r.stderr, /usage : node scripts\/smoke-api\.mjs/);
        assert.equal(r.stdout, "");
      }
    });
  });
});
