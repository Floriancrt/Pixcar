// docs/openapi.yaml dit la vérité : chaque route documentée existe, chaque réponse produite est décrite (code et forme).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import YAML from "yaml";
import { overpassQuery } from "../../src/js/shared/overpass.js";
import { makeApp, repair } from "./helpers.mjs";

const doc = YAML.parse(await readFile(new URL("../../docs/openapi.yaml", import.meta.url), "utf8"));
const resolve = (node) => {
  if (node && node.$ref) return node.$ref.slice(2).split("/").reduce((n, k) => n[k], doc);
  return node;
};
const FORMATS = { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, date: /^\d{4}-\d{2}-\d{2}$/ };

// Validation d'un sous-ensemble d'OpenAPI : ce que ce document utilise (type, required, properties, items, enum, pattern, bornes, allOf, nullable, format)
function check(schema, value, at = "$") {
  schema = resolve(schema);
  const errors = [];
  if (schema.allOf) return schema.allOf.flatMap((s) => check(s, value, at));
  if (value === null) return schema.nullable ? [] : [`${at} : null non permis`];
  const type = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const okType = !schema.type || schema.type === type || (schema.type === "number" && type === "integer");
  if (!okType) return [`${at} : ${schema.type} attendu, reçu ${type}`];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} : ${JSON.stringify(value)} hors de ${JSON.stringify(schema.enum)}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at} : ne correspond pas à ${schema.pattern}`);
  if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) errors.push(`${at} : format ${schema.format} attendu`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} : sous le minimum ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} : au-dessus du maximum ${schema.maximum}`);
  if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} : trop court`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} : trop long`);
  if (type === "object") {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}.${k} : requis`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) errors.push(...check(s, value[k], `${at}.${k}`));
  }
  if (type === "array" && schema.items) value.forEach((v, i) => errors.push(...check(schema.items, v, `${at}[${i}]`)));
  return errors;
};

describe("docs/openapi.yaml ↔ API", () => {
  let t;
  const seen = new Set(); // « METHODE /chemin statut » effectivement produits
  const op = (method, path) => doc.paths[path]?.[method.toLowerCase()];
  before(async () => {
    const elements = [{ type: "node", id: 1, lat: 45.7, lon: 4.9, tags: { name: "Norauto" } }];
    t = await makeApp({ fetchImpl: async () => new Response(JSON.stringify({ elements }), { status: 200 }), overpassOptions: { staggerMs: 20 } });
  });
  after(() => t.close());

  // Fait l'appel, vérifie que le code est documenté et que le corps respecte le schéma déclaré.
  async function call(method, template, real, { body, headers, status, ip } = {}) {
    const res = await t.call(method, real, { body, headers, ip });
    const operation = op(method, template);
    assert.ok(operation, `${method} ${template} n'est pas documenté`);
    seen.add(`${method} ${template} ${res.status}`);
    assert.equal(res.status, status, `${method} ${real}`);
    const spec = resolve(operation.responses[String(res.status)]);
    assert.ok(spec, `${method} ${template} : réponse ${res.status} non documentée`);
    for (const [name, h] of Object.entries(spec.headers || {})) if (h.required) assert.ok(res.headers.get(name), `en-tête ${name} documenté`);
    const schema = spec.content?.["application/json"]?.schema;
    const text = await res.text();
    if (schema) {
      const errors = check(schema, JSON.parse(text));
      assert.deepEqual(errors, [], `${method} ${real} → ${res.status} : ${errors.join(" · ")}\n${text.slice(0, 300)}`);
    } else assert.equal(text, "", "pas de corps documenté, pas de corps renvoyé");
    return { res, text };
  }

  test("every documented route answers with documented statuses and shapes", async () => {
    const r1 = repair();
    const valid = (r) => {
      const errors = check(doc.components.schemas.RepairInput, r);
      assert.deepEqual(errors, [], "la déclaration d'essai respecte le schéma de la requête : " + errors.join(" · "));
      return r;
    };
    await call("POST", "/v1/repairs", "/v1/repairs", { body: valid(r1), status: 201 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: r1, status: 200 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: valid(repair({ vehicle: r1.vehicle })), status: 409 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: { ...repair(), price: -1 }, status: 422 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: "{pas du json", status: 400 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: "x", headers: { "content-type": "text/plain" }, status: 415 });
    await call("POST", "/v1/repairs", "/v1/repairs", { body: JSON.stringify({ x: "é".repeat(9000) }), status: 413 });
    await call("GET", "/v1/repairs", "/v1/repairs?lat=45.7347&lon=4.9128&radius=10", { status: 200 });
    await call("GET", "/v1/repairs", "/v1/repairs?lat=45.7347", { status: 400 });
    await call("DELETE", "/v1/repairs/{id}", `/v1/repairs/${r1.id}`, { headers: { "x-delete-token": "0".repeat(32) }, status: 404 });
    await call("DELETE", "/v1/repairs/{id}", `/v1/repairs/${r1.id}`, { headers: { "x-delete-token": r1.deleteToken }, status: 204 });
    await call("GET", "/v1/overpass", `/v1/overpass?data=${encodeURIComponent(overpassQuery(45.7347, 4.9128, 10000))}`, { status: 200 });
    await call("GET", "/v1/overpass", "/v1/overpass?data=nimporte", { status: 400 });
    await call("GET", "/healthz", "/healthz", { status: 200 });
    await call("GET", "/readyz", "/readyz", { status: 200 });
  });

  test("rate limiting and outages are documented too (429 and 503, with Retry-After)", async () => {
    const limited = await makeApp({ config: { writeLimitPerHour: 1 } });
    try {
      await limited.call("POST", "/v1/repairs", { body: repair() });
      const res = await limited.call("POST", "/v1/repairs", { body: repair() });
      assert.equal(res.status, 429);
      assert.ok(resolve(op("POST", "/v1/repairs").responses["429"]).headers["Retry-After"], "429 documente Retry-After");
      assert.ok(res.headers.get("retry-after"));
      assert.deepEqual(check(doc.components.schemas.Error, await res.json()), []);
    } finally {
      await limited.close();
    }
    const down = await makeApp();
    await down.db.close();
    const res = await down.call("POST", "/v1/repairs", { body: repair() });
    assert.equal(res.status, 503);
    assert.ok(resolve(op("POST", "/v1/repairs").responses["503"]).headers["Retry-After"]);
    assert.deepEqual(check(doc.components.schemas.Error, await res.json()), []);
    assert.equal((await down.call("GET", "/readyz")).status, 503);
    assert.ok(op("GET", "/readyz").responses["503"]);
  });

  test("the Pro routes answer with documented statuses and shapes", async () => {
    const { parseContactRows } = await import("../lib/contact.mjs");
    const siret = "73282932000074";
    const pro = await makeApp({
      env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1" },
      proOptions: { sirene: async (s) => (s === siret ? { siret, name: "GARAGE DUPONT", company: "DUPONT", addr: "1 RUE X 31220 CAZERES", naf: "45.20A", active: true, lat: 43.2176, lon: 1.1014, pc: "31220" } : null) },
    });
    const keep = t;
    t = pro;
    try {
      const g = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Garage Dupont", lat: 43.2174, lon: 1.1014, emails: ["contact@garage-dupont.fr"], phones: ["+33612345678"], web: "https://garage-dupont.fr/" };
      await pro.app.pro.repo.upsertContacts(parseContactRows([g]).rows, "doc");
      const me = { "x-pro-dev-account": "doc" };
      const holder = { firstName: "Camille", lastName: "Durand", role: "manager", certify: true };
      await call("GET", "/v1/pro/me", "/v1/pro/me", { status: 401 });
      await call("GET", "/v1/pro/me", "/v1/pro/me", { headers: me, status: 200 });
      await call("GET", "/v1/pro/siret/{siret}", `/v1/pro/siret/${siret}`, { headers: me, status: 200 });
      await call("GET", "/v1/pro/siret/{siret}", "/v1/pro/siret/123", { headers: me, status: 400 });
      await call("GET", "/v1/pro/siret/{siret}", "/v1/pro/siret/35600000049837", { headers: me, status: 404 });
      await call("POST", "/v1/pro/claims", "/v1/pro/claims", { headers: me, body: { siret, garageId: g.id, option: "nope", holder }, status: 422 });
      const created = await call("POST", "/v1/pro/claims", "/v1/pro/claims", { headers: me, body: { siret, garageId: g.id, option: "sms:0", holder }, status: 201 });
      const id = JSON.parse(created.text).id;
      await call("GET", "/v1/pro/claims/{id}", `/v1/pro/claims/${id}`, { headers: me, status: 200 });
      await call("POST", "/v1/pro/claims/{id}/resend", `/v1/pro/claims/${id}/resend`, { headers: me, status: 429 });
      const code = pro.app.pro.senders.outbox[0].code;
      await call("POST", "/v1/pro/claims/{id}/code", `/v1/pro/claims/${id}/code`, { headers: me, body: { code: String((Number(code) + 1) % 1e6).padStart(6, "0") }, status: 422 });
      await call("POST", "/v1/pro/claims/{id}/code", `/v1/pro/claims/${id}/code`, { headers: me, body: { code }, status: 200 });
      await call("POST", "/v1/pro/claims/{id}/resend", `/v1/pro/claims/${id}/resend`, { headers: me, status: 409 });
      await call("POST", "/v1/pro/claims", "/v1/pro/claims", { headers: { "x-pro-dev-account": "other" }, body: { siret, garageId: g.id, option: "sms:0", holder }, status: 409 });
      // « Vos premiers prix » : le garage est maintenant rattaché au compte « doc »
      const G = `/v1/pro/garages/${g.id}`;
      await call("GET", "/v1/pro/garages/{id}", G, { status: 401 });
      await call("GET", "/v1/pro/garages/{id}", G, { headers: { "x-pro-dev-account": "other" }, status: 404 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/vidange`, { headers: me, body: { kind: "fixed", price: 89, vehicles: ["city"], includes: ["parts", "labour"] }, status: 200 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/diag`, { headers: me, body: { kind: "quote" }, status: 200 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/ct`, { headers: me, body: { kind: "fixed", price: 70 }, status: 422 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/vidange`, { headers: me, body: "{", status: 400 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/vidange`, { headers: { "x-pro-dev-account": "other" }, body: { kind: "quote" }, status: 404 });
      await call("PUT", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/vidange`, { status: 401, body: { kind: "quote" } });
      await call("POST", "/v1/pro/public/visits", "/v1/pro/public/visits", { body: { garageId: g.id, kind: "view" }, status: 204 });
      await call("POST", "/v1/pro/public/visits", "/v1/pro/public/visits", { body: { garageId: g.id, kind: "like" }, status: 422 });
      await call("POST", "/v1/pro/public/visits", "/v1/pro/public/visits", { body: "{", status: 400 });
      await call("GET", "/v1/pro/garages/{id}", G, { headers: me, status: 200 });
      await call("POST", "/v1/pro/garages/{id}/confirm", `${G}/confirm`, { headers: me, status: 200 });
      await call("POST", "/v1/pro/garages/{id}/confirm", `${G}/confirm`, { status: 401 });
      await call("POST", "/v1/pro/garages/{id}/confirm", `${G}/confirm`, { headers: { "x-pro-dev-account": "other" }, status: 404 });
      await call("GET", "/v1/pro/public/garages", `/v1/pro/public/garages?ids=${g.id}`, { status: 200 });
      await call("GET", "/v1/pro/public/garages", "/v1/pro/public/garages?ids=x!", { status: 400 });
      await call("DELETE", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/diag`, { headers: me, status: 204 });
      await call("DELETE", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/diag`, { headers: me, status: 404 });
      await call("DELETE", "/v1/pro/garages/{id}/prices/{service}", `${G}/prices/diag`, { status: 401 });
      // « Mon garage »
      const P = "/v1/pro/garages/{id}/profile";
      await call("GET", P, `${G}/profile`, { headers: me, status: 200 });
      await call("GET", P, `${G}/profile`, { status: 401 });
      await call("GET", P, `${G}/profile`, { headers: { "x-pro-dev-account": "other" }, status: 404 });
      await call("PUT", P, `${G}/profile`, { headers: me, body: { website: "garage-dupont.fr", hours: { mo: [["08:00", "12:00"], ["14:00", "18:30"]] } }, status: 200 });
      await call("PUT", P, `${G}/profile`, { headers: me, body: { website: "javascript:x" }, status: 422 });
      await call("PUT", P, `${G}/profile`, { headers: me, body: "{", status: 400 });
      await call("PUT", P, `${G}/profile`, { body: { email: "" }, status: 401 });
      await call("PUT", P, `${G}/profile`, { headers: { "x-pro-dev-account": "other" }, body: { email: "" }, status: 404 });
      const C = "/v1/pro/garages/{id}/changes";
      const change = await call("POST", C, `${G}/changes`, { headers: me, body: { field: "addr", value: { street: "2 rue X", pc: "31220", city: "Cazères" } }, status: 201 });
      await call("POST", C, `${G}/changes`, { headers: me, body: { field: "phone", value: "12" }, status: 422 });
      await call("POST", C, `${G}/changes`, { headers: me, body: "{", status: 400 });
      await call("POST", C, `${G}/changes`, { body: { field: "name", value: "Dupont" }, status: 401 });
      await call("POST", C, `${G}/changes`, { headers: { "x-pro-dev-account": "other" }, body: { field: "name", value: "Dupont" }, status: 404 });
      await call("GET", P, `${G}/profile`, { headers: me, status: 200 }); // avec un changement en attente
      const D = "/v1/pro/garages/{id}/changes/{change}";
      await call("DELETE", D, `${G}/changes/${JSON.parse(change.text).id}`, { headers: me, status: 204 });
      await call("DELETE", D, `${G}/changes/${JSON.parse(change.text).id}`, { headers: me, status: 404 });
      await call("DELETE", D, `${G}/changes/${JSON.parse(change.text).id}`, { status: 401 });
      const S = "/v1/pro/garages/{id}/services/{service}";
      await call("PUT", S, `${G}/services/vidange`, { headers: me, body: { offered: false }, status: 200 });
      await call("PUT", S, `${G}/services/vidange`, { headers: me, body: { offered: true, minutes: 45 }, status: 200 });
      await call("PUT", S, `${G}/services/ct`, { headers: me, body: { offered: true }, status: 422 });
      await call("PUT", S, `${G}/services/vidange`, { headers: me, body: "{", status: 400 });
      await call("PUT", S, `${G}/services/vidange`, { body: { offered: true }, status: 401 });
      await call("PUT", S, `${G}/services/vidange`, { headers: { "x-pro-dev-account": "other" }, body: { offered: true }, status: 404 });
      const R = "/v1/pro/garages/{id}/registry";
      await call("GET", R, `${G}/registry`, { headers: me, status: 200 });
      await call("GET", R, `${G}/registry`, { status: 401 });
      await call("GET", R, `${G}/registry`, { headers: { "x-pro-dev-account": "other" }, status: 404 });
      await call("GET", "/v1/pro/public/garages", `/v1/pro/public/garages?ids=${g.id}`, { status: 200 }); // avec fiche et prestations
    } finally {
      t = keep;
      await pro.close();
    }
    const off = await makeApp();
    try {
      assert.equal((await off.call("GET", "/v1/pro/me")).status, 404);
      assert.ok(op("GET", "/v1/pro/me").responses["404"]);
    } finally {
      await off.close();
    }
  });

  test("no route exists that the document does not mention", async () => {
    const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    assert.deepEqual([...documented].sort(), [
      "DELETE /v1/pro/garages/{id}/prices/{service}", "DELETE /v1/repairs/{id}", "GET /healthz", "GET /readyz", "GET /v1/overpass", "GET /v1/pro/claims/{id}",
      "GET /v1/pro/garages/{id}", "GET /v1/pro/me", "GET /v1/pro/public/garages", "GET /v1/pro/siret/{siret}", "GET /v1/repairs", "POST /v1/pro/claims",
      "POST /v1/pro/claims/{id}/code", "POST /v1/pro/claims/{id}/resend", "POST /v1/pro/garages/{id}/confirm", "POST /v1/pro/public/visits", "POST /v1/repairs",
      "PUT /v1/pro/garages/{id}/prices/{service}",
    ].concat([
      "DELETE /v1/pro/garages/{id}/changes/{change}", "GET /v1/pro/garages/{id}/profile", "GET /v1/pro/garages/{id}/registry", "POST /v1/pro/garages/{id}/changes",
      "PUT /v1/pro/garages/{id}/profile", "PUT /v1/pro/garages/{id}/services/{service}",
    ]).sort());
    // et chaque méthode non documentée d'une route documentée est refusée en 405
    for (const [method, path] of [["PUT", "/v1/repairs"], ["DELETE", "/v1/repairs"], ["POST", "/v1/overpass"], ["POST", "/healthz"], ["GET", `/v1/repairs/${repair().id}`]]) {
      const res = await t.call(method, path, {});
      assert.equal(res.status, 405, `${method} ${path}`);
    }
  });
});
