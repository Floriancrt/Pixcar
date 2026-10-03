// lib/compress.mjs : la compression partagée par le serveur Node et la fonction Lambda.
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, test } from "node:test";
import { compressIfUseful } from "../lib/compress.mjs";

const big = Buffer.from(JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: "Garage numéro " + i })) }));

describe("compressIfUseful", () => {
  test("brotli when accepted (preferred), else gzip, else nothing — and the content survives", () => {
    const br = compressIfUseful({ body: big, type: "application/json; charset=utf-8", acceptEncoding: "gzip, deflate, br" });
    assert.equal(br.encoding, "br");
    assert.deepEqual(brotliDecompressSync(br.body), big);
    const gz = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "gzip, deflate" });
    assert.equal(gz.encoding, "gzip");
    assert.deepEqual(gunzipSync(gz.body), big);
    assert.equal(compressIfUseful({ body: big, type: "application/json", acceptEncoding: "identity" }), null);
    assert.equal(compressIfUseful({ body: big, type: "application/json" }), null);
  });
  test("small bodies, already compressed answers and non-text types are left alone", () => {
    assert.equal(compressIfUseful({ body: Buffer.alloc(1023, "a"), type: "application/json", acceptEncoding: "br" }), null);
    assert.ok(compressIfUseful({ body: Buffer.alloc(1024, "a"), type: "application/json", acceptEncoding: "br" }));
    assert.equal(compressIfUseful({ body: big, type: "application/json", acceptEncoding: "br", alreadyEncoded: true }), null);
    assert.equal(compressIfUseful({ body: big, type: "image/png", acceptEncoding: "br" }), null);
  });
  test("one compression per content: the same ETag reuses the same compressed copy, per encoding", () => {
    const a = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "br", etag: 'W/"same"' });
    const b = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "br", etag: 'W/"same"' });
    assert.equal(a.body, b.body, "même objet : pas recompressé");
    const g = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "gzip", etag: 'W/"same"' });
    assert.notEqual(g.body, a.body);
    const c = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "br" });
    const d = compressIfUseful({ body: big, type: "application/json", acceptEncoding: "br" });
    assert.notEqual(c.body, d.body, "sans ETag, rien n'est gardé");
  });
});
