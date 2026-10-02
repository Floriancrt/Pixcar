// Serveur Node réel : vraies connexions HTTP, flux de requête, compression, arrêt propre.
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { start } from "../index.mjs";
import { isoDay, repair } from "./helpers.mjs";

const silent = () => {};
const raw = (port, path, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });

describe("server over real HTTP", () => {
  let running, port;
  before(async () => {
    running = await start({ env: { NODE_ENV: "test", PORT: "0", ALLOWED_ORIGINS: "*", WRITE_LIMIT_PER_HOUR: "1000", DRAIN_MS: "150", SHUTDOWN_GRACE_MS: "2000" }, log: silent });
    port = running.port;
  });
  after(() => running.stop());

  test("a declaration goes in over the wire and comes back out, compressed when asked", async () => {
    for (let i = 0; i < 40; i++) {
      const r = repair({ date: isoDay(5 + i), garage: { id: `osm:node/${5000 + i}`, name: `Garage numéro ${i} avec un nom assez long`, addr: `${i} rue de la République, 69002 Lyon`, lat: 45.75 + i / 1000, lon: 4.85, chainId: "" }, area: { lat: 45.75, lon: 4.85 } });
      const res = await fetch(`http://127.0.0.1:${port}/v1/repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
      assert.equal(res.status, 201, await res.clone().text());
    }
    const gz = await raw(port, "/v1/repairs?lat=45.75&lon=4.85&radius=10", { headers: { "accept-encoding": "gzip" } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.match(gz.headers.vary, /Accept-Encoding/i);
    const json = JSON.parse(gunzipSync(gz.body).toString());
    assert.equal(json.garages.length, 40);
    assert.ok(gz.body.length < JSON.stringify(json).length / 2, "la compression doit réduire nettement la réponse");
    const plain = await raw(port, "/v1/repairs?lat=45.75&lon=4.85&radius=10", { headers: { "accept-encoding": "identity" } });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(Number(plain.headers["content-length"]), plain.body.length);
  });

  test("HEAD answers headers only; small bodies are not compressed; 304 has no body", async () => {
    const head = await raw(port, "/healthz", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    const small = await raw(port, "/healthz", { headers: { "accept-encoding": "gzip" } });
    assert.equal(small.headers["content-encoding"], undefined);
    const first = await raw(port, "/v1/repairs?lat=45.75&lon=4.85&radius=10");
    const second = await raw(port, "/v1/repairs?lat=45.75&lon=4.85&radius=10", { headers: { "if-none-match": first.headers.etag } });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });

  test("a request body arrives intact in pieces; a body claimed too big is refused before being read", async () => {
    const r = repair({ date: isoDay(3) });
    const text = JSON.stringify(r);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/repairs", method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (x) => {
        const c = [];
        x.on("data", (d) => c.push(d));
        x.on("end", () => resolve({ status: x.statusCode, body: Buffer.concat(c).toString() }));
      });
      req.on("error", reject);
      req.write(text.slice(0, 50));
      setTimeout(() => req.end(text.slice(50)), 30);
    });
    assert.equal(res.status, 201, res.body);
    const big = await raw(port, "/v1/repairs", { method: "POST", headers: { "content-type": "application/json", "content-length": "9000" }, body: "x".repeat(9000) });
    assert.equal(big.status, 413);
  });

  test("malformed requests get a clean JSON error, never a stack trace or a crash", async () => {
    const odd = await raw(port, "/v1/repairs/%zz", { method: "DELETE", headers: { "x-delete-token": "a".repeat(32) } });
    assert.equal(odd.status, 404);
    const junk = await raw(port, "/%E0%A4%A", { method: "GET" });
    assert.ok([400, 404].includes(junk.status), String(junk.status));
    assert.ok(!/at .*\.mjs/.test(junk.body.toString()));
    assert.equal((await raw(port, "/healthz")).status, 200, "le serveur tient toujours");
  });

  test("stopping drains first (/readyz says 503 while requests are still served), then closes for good", async () => {
    const second = await start({ env: { NODE_ENV: "test", PORT: "0", ALLOWED_ORIGINS: "*", DRAIN_MS: "300", SHUTDOWN_GRACE_MS: "2000" }, log: silent });
    assert.equal((await raw(second.port, "/readyz")).status, 200);
    const stopped = second.stop();
    await new Promise((r) => setTimeout(r, 80));
    const during = await raw(second.port, "/readyz");
    assert.equal(during.status, 503);
    assert.equal(JSON.parse(during.body).draining, true);
    assert.equal((await raw(second.port, "/healthz")).status, 200, "encore servi pendant la vidange");
    await stopped;
    await assert.rejects(() => raw(second.port, "/healthz"), /ECONNREFUSED/);
  });
});
