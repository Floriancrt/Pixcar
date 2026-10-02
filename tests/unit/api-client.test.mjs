// Client HTTP de la page : délais, nouvelles tentatives, disjoncteur. Réseau, horloge et attentes simulés.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createClient } from "../../src/js/modules/api-client.js";

const res = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
// script : une entrée par appel de fetch : Response, Error, ou "hang" (ne répond jamais, jusqu'à l'annulation)
function setup(script, opts = {}) {
  const calls = [], waits = [];
  let clock = 1_000_000;
  const fetchImpl = (url, init) => {
    calls.push({ url, ...init });
    const next = script.shift();
    if (next === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("annulé", "AbortError"))));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const client = createClient({
    base: "https://api.test",
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5, // gigue neutre : ×(0,5 + 0,5) = ×1
    ...opts,
  });
  return { client, calls, waits, advance: (ms) => (clock += ms) };
}
const down = () => new TypeError("fetch failed");

describe("createClient", () => {
  test("a JSON answer comes back parsed; the request goes without cookies and asks for JSON", async () => {
    const { client, calls } = setup([res(200, { garages: [] })]);
    const out = await client.request("GET", "/v1/repairs?lat=1");
    assert.deepEqual([out.ok, out.status, out.kind, out.data], [true, 200, "ok", { garages: [] }]);
    assert.equal(calls[0].url, "https://api.test/v1/repairs?lat=1");
    assert.equal(calls[0].credentials, "omit");
    assert.equal(calls[0].headers.accept, "application/json");
  });

  test("a body is sent as JSON with its content type; 204 has no data", async () => {
    const { client, calls } = setup([res(204)]);
    const out = await client.request("POST", "/v1/repairs", { body: { a: 1 } });
    assert.equal(calls[0].body, '{"a":1}');
    assert.equal(calls[0].headers["content-type"], "application/json");
    assert.deepEqual([out.ok, out.status, out.data], [true, 204, null]);
  });

  test("an unreadable body leaves the status intact", async () => {
    const { client } = setup([new Response("<html>oups</html>", { status: 502 }), new Response("<html>oups</html>", { status: 502 }), new Response("pas du json", { status: 200 })], { retries: 0 });
    const a = await client.request("GET", "/x");
    assert.deepEqual([a.status, a.data, a.kind], [502, null, "server"]);
  });

  test("a 4xx is the caller's problem: no retry, kind « client », the answer is returned as is", async () => {
    const { client, calls, waits } = setup([res(422, { error: { code: "validation", fields: { price: "x" } } })]);
    const out = await client.request("POST", "/v1/repairs", { body: {} });
    assert.deepEqual([out.ok, out.status, out.kind], [false, 422, "client"]);
    assert.equal(out.data.error.fields.price, "x");
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  test("503 is retried with growing waits (400 ms, 800 ms), and the call succeeds when the server recovers", async () => {
    const { client, calls, waits } = setup([res(503), res(503), res(200, { ok: true })]);
    const out = await client.request("GET", "/x");
    assert.equal(out.ok, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [400, 800]);
  });

  test("network errors and 502/504 are retried; the last failure is returned when attempts run out", async () => {
    const { client, calls } = setup([down(), res(504), down()]);
    const out = await client.request("GET", "/x");
    assert.equal(calls.length, 3);
    assert.deepEqual([out.ok, out.status, out.kind], [false, 0, "network"]);
    const b = setup([res(502), res(502)], { retries: 1 });
    assert.deepEqual([(await b.client.request("GET", "/x")).status, b.calls.length], [502, 2]);
  });

  test("a plain 500 is not retried (it will not fix itself) but counts as a failure", async () => {
    const { client, calls } = setup([res(500)]);
    const out = await client.request("GET", "/x");
    assert.deepEqual([out.status, out.kind, calls.length], [500, "server", 1]);
  });

  test("Retry-After sets the wait (capped at 60 s)", async () => {
    const a = setup([res(503, {}, { "retry-after": "3" }), res(200)]);
    await a.client.request("GET", "/x");
    assert.deepEqual(a.waits, [3000]);
    const b = setup([res(503, {}, { "retry-after": "3600" }), res(200)]);
    await b.client.request("GET", "/x");
    assert.deepEqual(b.waits, [60_000]);
    const c = setup([res(429, {}, { "retry-after": "42" })]);
    const out = await c.client.request("POST", "/x", { body: {} });
    assert.deepEqual([out.status, out.retryAfter, c.calls.length], [429, 42, 1]); // 429 : rendu à l'appelant, qui décide
  });

  test("a request that gets no answer in time is aborted: kind « timeout »", async () => {
    const { client, calls } = setup(["hang"], { retries: 0 });
    const out = await client.request("GET", "/x", { timeoutMs: 20 });
    assert.deepEqual([out.ok, out.kind, out.status], [false, "timeout", 0]);
    assert.equal(calls[0].signal.aborted, true);
  });

  test("the retry count and the timeout can be set per call", async () => {
    const { client, calls } = setup([down(), down(), down(), down()]);
    await client.request("GET", "/x", { retries: 0 });
    assert.equal(calls.length, 1);
  });

  describe("circuit breaker", () => {
    test("after 3 failures in a row nothing is sent for the cool-down; then one probe decides", async () => {
      const { client, calls, advance } = setup([down(), down(), down(), res(200), down(), res(200)], { retries: 0 });
      for (let i = 0; i < 3; i++) await client.request("GET", "/x");
      assert.equal(client.state, "open");
      const blocked = await client.request("GET", "/x");
      assert.deepEqual([blocked.kind, blocked.ok, blocked.status], ["circuit", false, 0]);
      assert.ok(blocked.retryAfter >= 29 && blocked.retryAfter <= 30);
      assert.equal(calls.length, 3, "rien n'est parti pendant que le disjoncteur est ouvert");
      advance(30_001);
      assert.equal(client.state, "half-open");
      assert.equal((await client.request("GET", "/x")).ok, true, "la sonde réussit");
      assert.equal(client.state, "closed");
      // un échec isolé ne rouvre pas tout de suite
      await client.request("GET", "/x");
      assert.equal(client.state, "closed");
    });

    test("a failed probe reopens the breaker at once", async () => {
      const { client, calls, advance } = setup([down(), down(), down(), down()], { retries: 0 });
      for (let i = 0; i < 3; i++) await client.request("GET", "/x");
      advance(30_001);
      await client.request("GET", "/x");
      assert.equal(client.state, "open");
      assert.equal((await client.request("GET", "/x")).kind, "circuit");
      assert.equal(calls.length, 4);
    });

    test("a 4xx proves the server is alive: failures start again from zero", async () => {
      const { client } = setup([down(), down(), res(404), down(), down()], { retries: 0 });
      for (let i = 0; i < 5; i++) await client.request("GET", "/x");
      assert.equal(client.state, "closed");
    });

    test("the retries of one call count as ONE failure: a blip of three 503 does not open the breaker; three failed calls do", async () => {
      const { client, calls } = setup([res(503), res(503), res(503), res(200), down(), down(), down(), down(), down(), down(), down(), down(), down()], { retries: 2 });
      const first = await client.request("GET", "/x");
      assert.equal(first.status, 503);
      assert.equal(calls.length, 3);
      assert.equal(client.state, "closed", "trois tentatives d'un même appel : un seul échec");
      assert.equal((await client.request("GET", "/x")).ok, true);
      for (let i = 0; i < 3; i++) await client.request("GET", "/x");
      assert.equal(client.state, "open", "trois appels échoués de suite");
      const sent = calls.length;
      assert.equal((await client.request("GET", "/x")).kind, "circuit");
      assert.equal(calls.length, sent, "rien ne part pendant que le disjoncteur est ouvert");
    });

    test("reset() closes it (the network is back)", async () => {
      const { client } = setup([down(), down(), down(), res(200)], { retries: 0 });
      for (let i = 0; i < 3; i++) await client.request("GET", "/x");
      assert.equal(client.state, "open");
      client.reset();
      assert.equal(client.state, "closed");
      assert.equal((await client.request("GET", "/x")).ok, true);
    });
  });
});
