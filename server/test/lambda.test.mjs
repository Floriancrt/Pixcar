// server/lambda.mjs : l'API derrière API Gateway HTTP (charge utile 2.0). Événements synthétiques, vraie application, vraie base (PGlite).
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { appFromEnvironment, createHandler, fromResponse, toRequest } from "../lambda.mjs";
import { readSecrets } from "../lib/secrets.mjs";
import { ORIGIN, isoDay, makeApp, repair } from "./helpers.mjs";

const event = ({ method = "GET", path = "/healthz", query = "", headers = {}, body, base64 = false, ip = "203.0.113.7", domain = "abc123.execute-api.eu-north-1.amazonaws.com" } = {}) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: path,
  rawQueryString: query,
  headers: { host: domain, "user-agent": "test", ...headers },
  requestContext: { domainName: domain, requestId: "req-1", http: { method, path, protocol: "HTTP/1.1", sourceIp: ip, userAgent: "test" } },
  body,
  isBase64Encoded: base64,
});
const post = (r, over = {}) => event({ method: "POST", path: "/v1/repairs", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(r), ...over });
const json = (res) => JSON.parse(res.isBase64Encoded ? Buffer.from(res.body, "base64").toString() : res.body);

describe("Lambda adapter", () => {
  let t, handler, logged;
  before(async () => {
    t = await makeApp({ config: { writeLimitPerHour: 3, trustProxy: 1 } });
    logged = [];
    handler = createHandler({ getApp: async () => t.app, log: (l) => logged.push(l) });
  });
  after(() => t.close());

  test("a declaration goes in through the event and comes back out through the same API: 201, JSON text, CORS for the allowed origin", async () => {
    const res = await handler(post(repair({ date: isoDay(5) })));
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.isBase64Encoded, false);
    assert.equal(json(res).status, "approved");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], ORIGIN);
    assert.ok(res.headers["x-request-id"]);
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n, 1);
  });

  test("a body sent in base64 is decoded", async () => {
    const r = repair({ date: isoDay(6) });
    const res = await handler(post(r, { body: Buffer.from(JSON.stringify(r)).toString("base64"), base64: true }));
    assert.equal(res.statusCode, 201, res.body);
  });

  test("the visitor's address is the one API Gateway reports; headers the visitor writes cannot change it", async () => {
    await t.reset();
    // 3 déclarations par heure et par adresse ; l'en-tête X-Forwarded-For change à chaque fois, la vraie adresse (sourceIp) jamais
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await handler(post(repair({ date: isoDay(7 + i) }), { ip: "198.51.100.9", headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": `10.0.0.${i}`, "cf-connecting-ip": `10.1.0.${i}` } }))).statusCode);
    assert.deepEqual(codes, [201, 201, 201, 429]);
    assert.equal((await handler(post(repair({ date: isoDay(20) }), { ip: "198.51.100.10" }))).statusCode, 201, "une autre adresse n'est pas limitée");
    assert.ok(!logged.some((l) => /relais/.test(l.msg || "")), "l'application ne se plaint pas d'en-têtes de relais : ils sont écartés avant elle");
  });

  test("reading an area: compressed with brotli (base64) when asked, identical content, ETag, then 304 without a body", async () => {
    await t.reset();
    for (let i = 0; i < 40; i++) {
      const r = repair({ date: isoDay(5 + i), garage: { id: `osm:node/${5000 + i}`, name: `Garage numéro ${i} avec un nom assez long`, addr: `${i} rue de la République, 69002 Lyon`, lat: 45.75 + i / 1000, lon: 4.85, chainId: "" }, area: { lat: 45.75, lon: 4.85 } });
      assert.equal((await handler(post(r, { ip: `192.0.2.${i + 1}` }))).statusCode, 201);
    }
    const q = { path: "/v1/repairs", query: "lat=45.75&lon=4.85&radius=10" };
    const plain = await handler(event({ ...q }));
    const br = await handler(event({ ...q, headers: { "accept-encoding": "gzip, br" } }));
    const gz = await handler(event({ ...q, headers: { "accept-encoding": "gzip" } }));
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.isBase64Encoded, true);
    assert.match(br.headers.vary, /Accept-Encoding/);
    assert.deepEqual(JSON.parse(brotliDecompressSync(Buffer.from(br.body, "base64")).toString()), json(plain));
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(gz.body, "base64")).toString()), json(plain));
    assert.equal(json(plain).garages.length, 40);
    const again = await handler(event({ ...q, headers: { "if-none-match": plain.headers.etag } }));
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, undefined);
  });

  test("HEAD answers headers only; the preflight request is a 204 with the CORS headers; unknown routes and bad JSON are clean errors", async () => {
    const head = await handler(event({ method: "HEAD", path: "/healthz" }));
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, undefined);
    const pre = await handler(event({ method: "OPTIONS", path: "/v1/repairs", headers: { origin: ORIGIN, "access-control-request-method": "POST" } }));
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
    assert.match(pre.headers["access-control-allow-methods"], /DELETE/);
    assert.equal((await handler(event({ path: "/nulle-part" }))).statusCode, 404);
    const bad = await handler(event({ method: "POST", path: "/v1/repairs", headers: { "content-type": "application/json" }, body: "{pas du json" }));
    assert.equal(bad.statusCode, 400);
    assert.equal(json(bad).error.code, "bad_json");
  });

  test("a startup failure is a 503 with Retry-After (never a crash), and is retried on the next invocation", async () => {
    const env = { NODE_ENV: "test", ALLOWED_ORIGINS: ORIGIN };
    const log = [];
    const h = createHandler({ getApp: appFromEnvironment(env, (l) => log.push(l)), log: (l) => log.push(l) });
    const down = await h(event({ path: "/healthz" }));
    assert.equal(down.statusCode, 503);
    assert.equal(down.headers["retry-after"], "5");
    assert.match(log.map((l) => l.error || "").join(" "), /secrets absents/);
    Object.assign(env, { PLATE_PEPPER: "p".repeat(16), IP_PEPPER: "i".repeat(16) });
    const up = await h(event({ path: "/healthz" }));
    assert.equal(up.statusCode, 200, "le démarrage raté n'est pas gardé en mémoire");
    assert.equal(json(up).ok, true);
  });
});

describe("toRequest / fromResponse", () => {
  test("path, query string, method, headers and host are carried over; the visitor's address headers are not", () => {
    const req = toRequest(event({ method: "GET", path: "/v1/repairs", query: "lat=45.5&lon=4.5&radius=3", headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8", accept: "application/json" } }));
    assert.equal(req.url, "https://abc123.execute-api.eu-north-1.amazonaws.com/v1/repairs?lat=45.5&lon=4.5&radius=3");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.get("accept"), "application/json");
    assert.equal(req.headers.get("x-forwarded-for"), null);
    assert.equal(req.headers.get("cf-connecting-ip"), null);
  });
  test("a binary or compressed body is base64, a small JSON body is text, 204 and 304 have no body", async () => {
    const e = event();
    const text = await fromResponse(new Response('{"a":1}', { headers: { "content-type": "application/json" } }), e);
    assert.deepEqual([text.body, text.isBase64Encoded], ['{"a":1}', false]);
    const bin = await fromResponse(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }), e);
    assert.deepEqual([bin.body, bin.isBase64Encoded], ["AQID", true]);
    assert.equal((await fromResponse(new Response(null, { status: 204 }), e)).body, undefined);
    assert.equal((await fromResponse(new Response(null, { status: 304 }), e)).body, undefined);
  });
});

describe("secrets", () => {
  const fakeSsm = (params, invalid = []) => ({
    SSMClient: class { send() { return Promise.resolve({ Parameters: params, InvalidParameters: invalid }); } },
    GetParametersCommand: class { constructor(input) { this.input = input; } },
  });
  test("environment variables win and SSM is not even asked", async () => {
    assert.deepEqual(await readSecrets({ PLATE_PEPPER: "a", IP_PEPPER: "b" }, { client: { SSMClient: class { constructor() { throw new Error("SSM interrogé"); } } } }), {});
  });
  test("otherwise they are read from SSM under the prefix; a missing parameter or prefix is an explicit error", async () => {
    const env = { SSM_PREFIX: "/pixcar/prod/" };
    const got = await readSecrets(env, { client: fakeSsm([{ Name: "/pixcar/prod/PLATE_PEPPER", Value: "pp" }, { Name: "/pixcar/prod/IP_PEPPER", Value: "ii" }]) });
    assert.deepEqual(got, { PLATE_PEPPER: "pp", IP_PEPPER: "ii" });
    await assert.rejects(readSecrets(env, { client: fakeSsm([], ["/pixcar/prod/IP_PEPPER"]) }), /introuvables.*IP_PEPPER/);
    await assert.rejects(readSecrets({}), /secrets absents/);
    assert.deepEqual(await readSecrets({ SSM_PREFIX: "/p/" }, { names: ["PLATE_PEPPER"], client: fakeSsm([{ Name: "/p/PLATE_PEPPER", Value: "seul" }]) }), { PLATE_PEPPER: "seul" });
  });
});
