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

  test("no route exists that the document does not mention", async () => {
    const documented = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    assert.deepEqual([...documented].sort(), ["DELETE /v1/repairs/{id}", "GET /healthz", "GET /readyz", "GET /v1/overpass", "GET /v1/repairs", "POST /v1/repairs"]);
    // et chaque méthode non documentée d'une route documentée est refusée en 405
    for (const [method, path] of [["PUT", "/v1/repairs"], ["DELETE", "/v1/repairs"], ["POST", "/v1/overpass"], ["POST", "/healthz"], ["GET", `/v1/repairs/${repair().id}`]]) {
      const res = await t.call(method, path, {});
      assert.equal(res.status, 405, `${method} ${path}`);
    }
  });
});
