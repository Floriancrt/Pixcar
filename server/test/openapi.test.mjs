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
  if (value === null && schema.nullable) return [];
  if (schema.allOf) return schema.allOf.flatMap((s) => check(s, value, at));
  if (value === null) return [`${at} : null non permis`];
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
      // raccourcis du tableau de bord (lot 3c)
      const PF = "/v1/pro/garages/{id}/prefs";
      await call("PUT", PF, `${G}/prefs`, { headers: me, body: { shortcuts: ["planning", "site"] }, status: 200 });
      await call("PUT", PF, `${G}/prefs`, { headers: me, body: { shortcuts: ["x"] }, status: 422 });
      await call("PUT", PF, `${G}/prefs`, { headers: me, body: "{", status: 400 });
      await call("PUT", PF, `${G}/prefs`, { headers: { "x-pro-dev-account": "other" }, body: { shortcuts: [] }, status: 404 });
      await call("PUT", PF, `${G}/prefs`, { body: { shortcuts: [] }, status: 401 });
      await call("GET", "/v1/pro/garages/{id}", G, { headers: me, status: 200 }); // avec prefs
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

  test("the rendez-vous routes answer with documented statuses and shapes", async () => {
    const { parseContactRows } = await import("../lib/contact.mjs");
    const { parisInstant } = await import("../../src/js/shared/rdv.js");
    let clock = parisInstant("2026-10-19", 600); // lundi 10:00, heure de Paris
    const app = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", RDV_ENABLED: "1", READ_LIMIT_PER_MINUTE: "100000" }, now: () => clock });
    const keep = t;
    t = app;
    try {
      const gid = "aaaaaaaa-0000-4000-8000-000000000001";
      await app.app.pro.repo.upsertContacts(parseContactRows([{ id: gid, name: "Garage Dupont", lat: 43.2174, lon: 1.1014, emails: ["contact@garage-dupont.fr"] }]).rows, "doc");
      await app.db.query(
        "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, 'dev-doc', $2, '73282932000074', 'verified', 'email', 'C D', 'manager', $3, 'x', now())",
        [crypto.randomUUID(), gid, "a".repeat(64)],
      );
      const me = { "x-pro-dev-account": "doc" };
      const other = { "x-pro-dev-account": "other" };
      const G = `/v1/pro/garages/${gid}/rdv`;
      const code = (to) => /code (\d{6})/.exec(app.app.pro.senders.outbox.filter((m) => m.target === to).at(-1).subject)[1];
      const week = Object.fromEntries(["mo", "tu", "we", "th", "fr"].map((d) => [d, [["08:00", "12:00"], ["14:00", "18:00"]]]));
      await app.call("PUT", `/v1/pro/garages/${gid}/profile`, { headers: me, body: { hours: week } });
      await app.call("PUT", `/v1/pro/garages/${gid}/services/vidange`, { headers: me, body: { offered: true, minutes: 45 } });
      await call("GET", "/v1/pro/garages/{id}/rdv", G, { headers: me, status: 200 });
      await call("GET", "/v1/pro/garages/{id}/rdv", G, { status: 401 });
      await call("GET", "/v1/pro/garages/{id}/rdv", G, { headers: other, status: 404 });
      await call("PUT", "/v1/pro/garages/{id}/rdv/settings", `${G}/settings`, { headers: me, body: { enabled: true }, status: 409 });
      await call("PUT", "/v1/pro/garages/{id}/rdv/settings", `${G}/settings`, { headers: me, body: { stepMin: 20 }, status: 422 });
      await call("POST", "/v1/pro/garages/{id}/rdv/notify", `${G}/notify`, { headers: me, body: { email: "x" }, status: 422 });
      await call("POST", "/v1/pro/garages/{id}/rdv/notify/code", `${G}/notify/code`, { headers: me, body: { code: "123456" }, status: 409 });
      await call("POST", "/v1/pro/garages/{id}/rdv/notify", `${G}/notify`, { headers: me, body: { email: "atelier@garage-dupont.fr" }, status: 200 });
      await call("POST", "/v1/pro/garages/{id}/rdv/notify", `${G}/notify`, { headers: me, body: { email: "atelier@garage-dupont.fr" }, status: 429 });
      const good = code("atelier@garage-dupont.fr");
      await call("POST", "/v1/pro/garages/{id}/rdv/notify/code", `${G}/notify/code`, { headers: me, body: { code: good === "000000" ? "111111" : "000000" }, status: 422 });
      await call("POST", "/v1/pro/garages/{id}/rdv/notify/code", `${G}/notify/code`, { headers: me, body: { code: good }, status: 200 });
      const slot = { name: "Entretien", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", capacity: 2, services: ["vidange"] };
      await call("POST", "/v1/pro/garages/{id}/rdv/slots", `${G}/slots`, { headers: me, body: { ...slot, days: ["su"] }, status: 422 });
      const created = JSON.parse((await call("POST", "/v1/pro/garages/{id}/rdv/slots", `${G}/slots`, { headers: me, body: slot, status: 200 })).text);
      const sid = created.slots[0].id;
      await call("PUT", "/v1/pro/garages/{id}/rdv/slots/{slot}", `${G}/slots/${sid}`, { headers: me, body: slot, status: 200 });
      await call("PUT", "/v1/pro/garages/{id}/rdv/slots/{slot}", `${G}/slots/${sid}`, { headers: me, body: { ...slot, capacity: 0 }, status: 422 });
      const extra = JSON.parse((await call("POST", "/v1/pro/garages/{id}/rdv/slots", `${G}/slots`, { headers: me, body: slot, status: 200 })).text).slots[1].id;
      await call("DELETE", "/v1/pro/garages/{id}/rdv/slots/{slot}", `${G}/slots/${extra}`, { headers: me, status: 200 });
      await call("DELETE", "/v1/pro/garages/{id}/rdv/slots/{slot}", `${G}/slots/${extra}`, { headers: me, status: 404 });
      await call("PUT", "/v1/pro/garages/{id}/rdv/settings", `${G}/settings`, { headers: me, body: { enabled: true, minDelayH: 0 }, status: 200 });
      // l'automobiliste
      const T = "/v1/rdv/garages/{id}/times";
      await call("GET", T, `/v1/rdv/garages/${gid}/times?services=vidange`, { status: 200 });
      await call("GET", T, `/v1/rdv/garages/${gid}/times?services=clim`, { status: 404 });
      await call("GET", T, `/v1/rdv/garages/${gid}/times?services=`, { status: 400 });
      const body = { garageId: gid, services: [{ id: "vidange" }], day: "2026-10-21", time: "08:00", name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC" };
      await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body: { ...body, email: "x" }, status: 422 });
      await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body: { ...body, time: "08:10" }, status: 409 });
      await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body: "{", status: 400 });
      const draft = JSON.parse((await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body, status: 201 })).text);
      await call("POST", "/v1/rdv/requests/{id}/resend", `/v1/rdv/requests/${draft.id}/resend`, { status: 429 });
      const c = code("julien.roux@example.com");
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${draft.id}/code`, { body: { code: c === "000000" ? "111111" : "000000" }, status: 422 });
      const sent = JSON.parse((await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${draft.id}/code`, { body: { code: c }, status: 200 })).text);
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${draft.id}/code`, { body: { code: c }, status: 409 });
      await call("POST", "/v1/rdv/requests/{id}/resend", `/v1/rdv/requests/${draft.id}/resend`, { status: 409 });
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${crypto.randomUUID()}/code`, { body: { code: c }, status: 404 });
      await call("GET", "/v1/rdv/me", "/v1/rdv/me", { headers: { "x-rdv-token": sent.token }, status: 200 });
      await call("GET", "/v1/rdv/me", "/v1/rdv/me", { status: 404 });
      await call("GET", "/v1/pro/public/garages", `/v1/pro/public/garages?ids=${gid}`, { status: 200 }); // avec rdv
      await call("GET", "/v1/pro/garages/{id}", `/v1/pro/garages/${gid}`, { headers: me, status: 200 }); // avec rdv.todo
      // le garage : page de l'e-mail, puis l'Espace Pro
      const g = /#g=([A-Za-z0-9_-]{43})/.exec(app.app.pro.senders.outbox.find((m) => /Nouvelle demande/.test(m.subject)).text)[1];
      await call("GET", "/v1/rdv/action", "/v1/rdv/action", { headers: { "x-rdv-token": g }, status: 200 });
      await call("GET", "/v1/rdv/action", "/v1/rdv/action", { headers: { "x-rdv-token": sent.token }, status: 404 });
      await call("POST", "/v1/rdv/action/decline", "/v1/rdv/action/decline", { headers: { "x-rdv-token": g }, body: {}, status: 422 });
      await call("POST", "/v1/rdv/action/decline", "/v1/rdv/action/decline", { headers: { "x-rdv-token": g }, body: "{", status: 400 });
      await call("POST", "/v1/rdv/action/accept", "/v1/rdv/action/accept", { headers: { "x-rdv-token": g }, status: 200 });
      await call("POST", "/v1/rdv/action/accept", "/v1/rdv/action/accept", { headers: { "x-rdv-token": g }, status: 409 });
      await call("POST", "/v1/rdv/action/decline", "/v1/rdv/action/decline", { headers: { "x-rdv-token": g }, body: { reason: "full" }, status: 409 });
      await call("POST", "/v1/rdv/action/accept", "/v1/rdv/action/accept", { status: 404 });
      const R = "/v1/pro/garages/{id}/rdv/requests";
      await call("GET", R, `${G}/requests?view=upcoming`, { headers: me, status: 200 });
      await call("GET", R, `${G}/requests?view=x`, { headers: me, status: 400 });
      await call("POST", `${R}/{request}/accept`, `${G}/requests/${draft.id}/accept`, { headers: me, status: 409 });
      await call("POST", `${R}/{request}/accept`, `${G}/requests/${crypto.randomUUID()}/accept`, { headers: me, status: 404 });
      await call("POST", `${R}/{request}/decline`, `${G}/requests/${draft.id}/decline`, { headers: me, body: { reason: "x" }, status: 422 });
      await call("POST", `${R}/{request}/decline`, `${G}/requests/${draft.id}/decline`, { headers: me, body: { reason: "full" }, status: 409 });
      await call("POST", `${R}/{request}/cancel`, `${G}/requests/${draft.id}/cancel`, { headers: me, body: {}, status: 422 });
      // le client annule, puis le garage ne peut plus annuler
      await call("POST", "/v1/rdv/me/cancel", "/v1/rdv/me/cancel", { headers: { "x-rdv-token": sent.token }, body: { reason: "zzz" }, status: 422 });
      await call("POST", "/v1/rdv/me/cancel", "/v1/rdv/me/cancel", { headers: { "x-rdv-token": sent.token }, body: { reason: "unable" }, status: 200 });
      await call("POST", "/v1/rdv/me/cancel", "/v1/rdv/me/cancel", { headers: { "x-rdv-token": sent.token }, body: {}, status: 409 });
      await call("POST", "/v1/rdv/me/cancel", "/v1/rdv/me/cancel", { status: 404 });
      await call("POST", `${R}/{request}/cancel`, `${G}/requests/${draft.id}/cancel`, { headers: me, body: { reason: "workshop" }, status: 409 });
      // une seconde demande, acceptée puis annulée par le garage
      const d2 = JSON.parse((await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body: { ...body, email: "b@example.com" }, status: 201 })).text);
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${d2.id}/code`, { body: { code: code("b@example.com") }, status: 200 });
      await call("GET", R, `${G}/requests?view=todo`, { headers: me, status: 200 });
      await call("POST", `${R}/{request}/accept`, `${G}/requests/${d2.id}/accept`, { headers: me, status: 200 });
      await call("POST", `${R}/{request}/cancel`, `${G}/requests/${d2.id}/cancel`, { headers: me, body: { reason: "workshop", note: "Pont en panne." }, status: 200 });
      const d3 = JSON.parse((await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body: { ...body, email: "c@example.com" }, status: 201 })).text);
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${d3.id}/code`, { body: { code: code("c@example.com") }, status: 200 });
      await call("POST", `${R}/{request}/decline`, `${G}/requests/${d3.id}/decline`, { headers: me, body: { reason: "full" }, status: 200 });
      await call("GET", R, `${G}/requests?view=past`, { headers: me, status: 200 });
      // fermetures
      const CL = "/v1/pro/garages/{id}/rdv/closures";
      const closure = JSON.parse((await call("POST", CL, `${G}/closures`, { headers: me, body: { first: "2026-12-24", last: "2027-01-02", label: "Congés" }, status: 200 })).text);
      await call("POST", CL, `${G}/closures`, { headers: me, body: { first: "2026-01-01" }, status: 422 });
      const cid = closure.closures[0].id;
      await call("PUT", `${CL}/{closure}`, `${G}/closures/${cid}`, { headers: me, body: { first: "2026-12-23", last: "2027-01-02" }, status: 200 });
      await call("PUT", `${CL}/{closure}`, `${G}/closures/${cid}`, { headers: me, body: { first: "x" }, status: 422 });
      await call("DELETE", `${CL}/{closure}`, `${G}/closures/${cid}`, { headers: me, status: 200 });
      await call("DELETE", `${CL}/{closure}`, `${G}/closures/${cid}`, { headers: me, status: 404 });
    } finally {
      t = keep;
      await app.close();
    }
  });

  test("the calendar routes answer with documented statuses and shapes", async () => {
    const { parseContactRows } = await import("../lib/contact.mjs");
    const { parisInstant } = await import("../../src/js/shared/rdv.js");
    const clock = parisInstant("2026-10-19", 600);
    const app = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", RDV_ENABLED: "1", READ_LIMIT_PER_MINUTE: "100000" }, now: () => clock });
    const keep = t;
    t = app;
    try {
      const gid = "aaaaaaaa-0000-4000-8000-000000000001";
      await app.app.pro.repo.upsertContacts(parseContactRows([{ id: gid, name: "Garage Dupont", lat: 43.2174, lon: 1.1014, emails: ["contact@garage-dupont.fr"] }]).rows, "doc");
      await app.db.query(
        "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, 'dev-doc', $2, '73282932000074', 'verified', 'email', 'C D', 'manager', $3, 'x', now())",
        [crypto.randomUUID(), gid, "a".repeat(64)],
      );
      const me = { "x-pro-dev-account": "doc" };
      const G = `/v1/pro/garages/${gid}/rdv`;
      const C = "/v1/pro/garages/{id}/rdv/calendar";
      const code = (to) => /code (\d{6})/.exec(app.app.pro.senders.outbox.filter((m) => m.target === to).at(-1).subject)[1];
      const week = Object.fromEntries(["mo", "tu", "we", "th", "fr"].map((d) => [d, [["08:00", "12:00"], ["14:00", "18:00"]]]));
      await app.call("PUT", `/v1/pro/garages/${gid}/profile`, { headers: me, body: { hours: week } });
      await app.call("PUT", `/v1/pro/garages/${gid}/services/plaq_av`, { headers: me, body: { offered: true, minutes: 60 } });
      await app.call("POST", `${G}/notify`, { headers: me, body: { email: "atelier@garage-dupont.fr" } });
      await app.call("POST", `${G}/notify/code`, { headers: me, body: { code: code("atelier@garage-dupont.fr") } });
      await call("GET", C, `${G}/calendar`, { headers: me, status: 200 });
      await call("GET", C, `${G}/calendar`, { status: 401 });
      await call("POST", `${C}/activate`, `${G}/calendar/activate`, { headers: me, status: 409 });
      const st = JSON.parse((await call("POST", `${C}/start`, `${G}/calendar/start`, { headers: me, status: 200 })).text);
      await call("PUT", `${C}/settings`, `${G}/calendar/settings`, { headers: me, body: { receptionMin: 0 }, status: 200 });
      await call("PUT", `${C}/settings`, `${G}/calendar/settings`, { headers: me, body: { receptionMin: 7 }, status: 422 });
      await call("POST", `${C}/activate`, `${G}/calendar/activate`, { headers: me, status: 409 }); // pas de mécanicien
      const brakes = st.skills.find((k) => k.label === "Freinage").id;
      const paul = JSON.parse((await call("POST", `${C}/staff`, `${G}/calendar/staff`, { headers: me, body: { name: "Paul", skills: [brakes] }, status: 200 })).text).saved;
      await call("POST", `${C}/staff`, `${G}/calendar/staff`, { headers: me, body: { name: "P" }, status: 422 });
      await call("PUT", `${C}/staff/{staff}`, `${G}/calendar/staff/${paul}`, { headers: me, body: { name: "Paul", skills: [brakes] }, status: 200 });
      await call("PUT", `${C}/staff/{staff}`, `${G}/calendar/staff/${crypto.randomUUID()}`, { headers: me, body: { name: "Paul" }, status: 404 });
      const tmp = JSON.parse((await call("POST", `${C}/staff`, `${G}/calendar/staff`, { headers: me, body: { name: "Léa" }, status: 200 })).text).saved;
      await call("DELETE", `${C}/staff/{staff}`, `${G}/calendar/staff/${tmp}`, { headers: me, status: 200 });
      await call("DELETE", `${C}/staff/{staff}`, `${G}/calendar/staff/${tmp}`, { headers: me, status: 404 });
      const sk = JSON.parse((await call("POST", `${C}/skills`, `${G}/calendar/skills`, { headers: me, body: { label: "Géométrie" }, status: 200 })).text).saved;
      await call("POST", `${C}/skills`, `${G}/calendar/skills`, { headers: me, body: { label: "G" }, status: 422 });
      await call("PUT", `${C}/skills/{skill}`, `${G}/calendar/skills/${sk}`, { headers: me, body: { label: "Géométrie 3D" }, status: 200 });
      await call("PUT", `${C}/skills/{skill}`, `${G}/calendar/skills/${sk}`, { headers: me, body: {}, status: 422 });
      await call("DELETE", `${C}/skills/{skill}`, `${G}/calendar/skills/${sk}`, { headers: me, status: 200 });
      await call("DELETE", `${C}/skills/{skill}`, `${G}/calendar/skills/${sk}`, { headers: me, status: 404 });
      const lift = JSON.parse((await call("POST", `${C}/resources`, `${G}/calendar/resources`, { headers: me, body: { name: "Pont n°1", type: "lift" }, status: 200 })).text).saved;
      await call("POST", `${C}/resources`, `${G}/calendar/resources`, { headers: me, body: { name: "Pont", type: "x" }, status: 422 });
      await call("PUT", `${C}/resources/{resource}`, `${G}/calendar/resources/${lift}`, { headers: me, body: { name: "Pont n°1", type: "lift" }, status: 200 });
      await call("PUT", `${C}/resources/{resource}`, `${G}/calendar/resources/${lift}`, { headers: me, body: { name: "", type: "lift" }, status: 422 });
      const spare = JSON.parse((await call("POST", `${C}/resources`, `${G}/calendar/resources`, { headers: me, body: { name: "Pont n°2", type: "lift" }, status: 200 })).text).saved;
      await call("DELETE", `${C}/resources/{resource}`, `${G}/calendar/resources/${spare}`, { headers: me, status: 200 });
      await call("DELETE", `${C}/resources/{resource}`, `${G}/calendar/resources/${spare}`, { headers: me, status: 404 });
      await call("PUT", `${C}/services/{service}`, `${G}/calendar/services/plaq_av`, { headers: me, body: { labour: 90, skills: [brakes], stations: ["lift"] }, status: 200 });
      await call("PUT", `${C}/services/{service}`, `${G}/calendar/services/plaq_av`, { headers: me, body: { labour: 7 }, status: 422 });
      await call("PUT", `${C}/services/{service}`, `${G}/calendar/services/vidange`, { headers: me, body: { labour: 30 }, status: 409 });
      const un = JSON.parse((await call("POST", `${C}/unavail`, `${G}/calendar/unavail`, { headers: me, body: { target: "staff", targetId: paul, kind: "leave", first: "2026-11-02" }, status: 200 })).text).saved;
      await call("POST", `${C}/unavail`, `${G}/calendar/unavail`, { headers: me, body: { target: "staff", targetId: paul, kind: "maintenance", first: "2026-11-02" }, status: 422 });
      await call("DELETE", `${C}/unavail/{unavail}`, `${G}/calendar/unavail/${un}`, { headers: me, status: 200 });
      await call("DELETE", `${C}/unavail/{unavail}`, `${G}/calendar/unavail/${un}`, { headers: me, status: 404 });
      await call("POST", `${C}/check`, `${G}/calendar/check`, { headers: me, body: {}, status: 200 });
      await call("POST", `${C}/check`, `${G}/calendar/check`, { headers: me, body: { placements: "x" }, status: 422 });
      await call("POST", `${C}/activate`, `${G}/calendar/activate`, { headers: me, body: { placements: [{ requestId: "pas-un-id" }] }, status: 422 });
      await call("POST", `${C}/activate`, `${G}/calendar/activate`, { headers: me, status: 200 });
      await app.call("PUT", `${G}/settings`, { headers: me, body: { enabled: true, minDelayH: 0 } });
      // une demande en mode avancé, puis le calendrier, le déplacement, le retour au simple
      const body = { garageId: gid, services: [{ id: "plaq_av" }], day: "2026-10-21", time: "08:00", name: "Julien Roux", email: "julien.roux@example.com", phone: "06 39 98 12 34", car: "Peugeot 208", year: 2019, plate: "EZ-108-BC" };
      await call("GET", "/v1/rdv/garages/{id}/times", `/v1/rdv/garages/${gid}/times?services=plaq_av`, { status: 200 });
      const d = JSON.parse((await call("POST", "/v1/rdv/requests", "/v1/rdv/requests", { body, status: 201 })).text);
      await call("POST", "/v1/rdv/requests/{id}/code", `/v1/rdv/requests/${d.id}/code`, { body: { code: code("julien.roux@example.com") }, status: 200 });
      await call("GET", "/v1/pro/garages/{id}/rdv/requests", `${G}/requests?view=todo`, { headers: me, status: 200 }); // avec plan
      await call("GET", `${C}/agenda`, `${G}/calendar/agenda?from=2026-10-21&to=2026-10-21`, { headers: me, status: 200 });
      await call("GET", `${C}/agenda`, `${G}/calendar/agenda?from=2026-10-21&to=2027-10-21`, { headers: me, status: 400 });
      const M = "/v1/pro/garages/{id}/rdv/requests/{request}/move";
      await call("POST", M, `${G}/requests/${d.id}/move`, { headers: me, body: { day: "2026-10-21", time: "14:00" }, status: 409 }); // confirmer
      await call("POST", M, `${G}/requests/${d.id}/move`, { headers: me, body: { day: "2026-10-24", time: "08:00", confirm: true }, status: 409 }); // samedi : fermé
      await call("POST", M, `${G}/requests/${d.id}/move`, { headers: me, body: { day: "x" }, status: 422 });
      await call("POST", M, `${G}/requests/${crypto.randomUUID()}/move`, { headers: me, body: { day: "2026-10-21", time: "14:00" }, status: 404 });
      await call("POST", M, `${G}/requests/${d.id}/move`, { headers: me, body: { day: "2026-10-21", time: "14:00", confirm: true }, status: 200 });
      // blocs internes (lot 3b) : créneau bloqué, rendez-vous hors Pixcar, puis le planning qui les montre
      const B = `${C}/blocks`, BB = `${C}/blocks/{block}`;
      const hold = { kind: "hold", label: "Réunion", day: "2026-10-22", time: "14:00", to: "15:00", staff: [paul] };
      const h = JSON.parse((await call("POST", B, `${G}/calendar/blocks`, { headers: me, body: hold, status: 201 })).text).saved;
      await call("POST", B, `${G}/calendar/blocks`, { headers: me, body: { ...hold, time: "14:30", to: "15:30" }, status: 409 }); // Paul déjà pris
      await call("POST", B, `${G}/calendar/blocks`, { headers: me, body: { ...hold, kind: "x" }, status: 422 });
      await call("POST", B, `${G}/calendar/blocks`, { headers: me, body: { kind: "job", label: "Client du quartier", services: ["plaq_av"], day: "2026-10-23", time: "08:00" }, status: 201 });
      await call("PUT", BB, `${G}/calendar/blocks/${h}`, { headers: me, body: { ...hold, time: "16:00", to: "17:00" }, status: 200 });
      await call("PUT", BB, `${G}/calendar/blocks/${crypto.randomUUID()}`, { headers: me, body: hold, status: 404 });
      await call("GET", `${C}/agenda`, `${G}/calendar/agenda?from=2026-10-21&to=2026-10-23`, { headers: me, status: 200 }); // avec les blocs
      await call("DELETE", BB, `${G}/calendar/blocks/${h}`, { headers: me, status: 200 });
      await call("DELETE", BB, `${G}/calendar/blocks/${h}`, { headers: me, status: 404 });
      // suivi des interventions (lot 3c) : client déjà sur place aujourd'hui, en cours ; passage impossible, jour à venir, erreurs
      const WK = `${C}/work/{ref}`;
      const walk = JSON.parse((await call("POST", B, `${G}/calendar/blocks`, { headers: me, body: { kind: "job", label: "Client au comptoir", services: ["plaq_av"], day: "2026-10-19", time: "10:15", received: true }, status: 201 })).text).saved;
      await call("POST", WK, `${G}/calendar/work/${walk}`, { headers: me, body: { status: "in_progress" }, status: 200 });
      await call("POST", WK, `${G}/calendar/work/${walk}`, { headers: me, body: { status: "returned" }, status: 409 });
      await call("POST", WK, `${G}/calendar/work/${walk}`, { headers: me, body: { status: "x" }, status: 422 });
      await call("POST", WK, `${G}/calendar/work/${crypto.randomUUID()}`, { headers: me, body: { status: "received" }, status: 404 });
      await call("POST", WK, `${G}/calendar/work/${walk}`, { body: { status: "done" }, status: 401 });
      await call("GET", `${C}/agenda`, `${G}/calendar/agenda?from=2026-10-19&to=2026-10-21`, { headers: me, status: 200 }); // avec les états
      await call("DELETE", `${C}/staff/{staff}`, `${G}/calendar/staff/${paul}`, { headers: me, status: 409 }); // engagé
      await call("POST", `${C}/simple`, `${G}/calendar/simple`, { headers: me, status: 409 }); // aucun créneau
      await app.call("POST", `${G}/slots`, { headers: me, body: { name: "Journée", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "18:00", capacity: 1, services: ["plaq_av"] } });
      await call("POST", `${C}/simple`, `${G}/calendar/simple`, { headers: me, status: 200 });
      await call("GET", "/v1/pro/garages/{id}/rdv", G, { headers: me, status: 200 }); // avec calendar
    } finally {
      t = keep;
      await app.close();
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
    ]).concat([
      "GET /v1/pro/garages/{id}/rdv", "PUT /v1/pro/garages/{id}/rdv/settings", "POST /v1/pro/garages/{id}/rdv/slots", "PUT /v1/pro/garages/{id}/rdv/slots/{slot}",
      "DELETE /v1/pro/garages/{id}/rdv/slots/{slot}", "POST /v1/pro/garages/{id}/rdv/closures", "PUT /v1/pro/garages/{id}/rdv/closures/{closure}",
      "DELETE /v1/pro/garages/{id}/rdv/closures/{closure}", "POST /v1/pro/garages/{id}/rdv/notify", "POST /v1/pro/garages/{id}/rdv/notify/code",
      "GET /v1/pro/garages/{id}/rdv/requests", "POST /v1/pro/garages/{id}/rdv/requests/{request}/accept", "POST /v1/pro/garages/{id}/rdv/requests/{request}/decline",
      "POST /v1/pro/garages/{id}/rdv/requests/{request}/cancel", "GET /v1/rdv/garages/{id}/times", "POST /v1/rdv/requests", "POST /v1/rdv/requests/{id}/code",
      "POST /v1/rdv/requests/{id}/resend", "GET /v1/rdv/me", "POST /v1/rdv/me/cancel", "GET /v1/rdv/action", "POST /v1/rdv/action/accept", "POST /v1/rdv/action/decline",
    ]).concat([
      "POST /v1/pro/garages/{id}/rdv/requests/{request}/move", "GET /v1/pro/garages/{id}/rdv/calendar", "POST /v1/pro/garages/{id}/rdv/calendar/start",
      "PUT /v1/pro/garages/{id}/rdv/calendar/settings", "POST /v1/pro/garages/{id}/rdv/calendar/staff", "PUT /v1/pro/garages/{id}/rdv/calendar/staff/{staff}",
      "DELETE /v1/pro/garages/{id}/rdv/calendar/staff/{staff}", "POST /v1/pro/garages/{id}/rdv/calendar/skills", "PUT /v1/pro/garages/{id}/rdv/calendar/skills/{skill}",
      "DELETE /v1/pro/garages/{id}/rdv/calendar/skills/{skill}", "POST /v1/pro/garages/{id}/rdv/calendar/resources", "PUT /v1/pro/garages/{id}/rdv/calendar/resources/{resource}",
      "DELETE /v1/pro/garages/{id}/rdv/calendar/resources/{resource}", "PUT /v1/pro/garages/{id}/rdv/calendar/services/{service}", "POST /v1/pro/garages/{id}/rdv/calendar/unavail",
      "DELETE /v1/pro/garages/{id}/rdv/calendar/unavail/{unavail}", "POST /v1/pro/garages/{id}/rdv/calendar/check", "POST /v1/pro/garages/{id}/rdv/calendar/activate",
      "POST /v1/pro/garages/{id}/rdv/calendar/simple", "GET /v1/pro/garages/{id}/rdv/calendar/agenda", "POST /v1/pro/garages/{id}/rdv/calendar/blocks",
      "PUT /v1/pro/garages/{id}/rdv/calendar/blocks/{block}", "DELETE /v1/pro/garages/{id}/rdv/calendar/blocks/{block}",
    ]).concat([
      // lot 3c
      "POST /v1/pro/garages/{id}/rdv/calendar/work/{ref}", "PUT /v1/pro/garages/{id}/prefs",
    ]).sort());
    // et chaque méthode non documentée d'une route documentée est refusée en 405
    for (const [method, path] of [["PUT", "/v1/repairs"], ["DELETE", "/v1/repairs"], ["POST", "/v1/overpass"], ["POST", "/healthz"], ["GET", `/v1/repairs/${repair().id}`]]) {
      const res = await t.call(method, path, {});
      assert.equal(res.status, 405, `${method} ${path}`);
    }
  });
});
