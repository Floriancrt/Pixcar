// Lecture de l'adresse de l'API dans le document.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { apiBase } from "../../src/js/modules/config.js";

const set = ({ meta, tune, href = "https://pixcar.example/" } = {}) => {
  globalThis.document = { querySelector: () => (meta === undefined ? null : { content: meta }) };
  globalThis.location = { href };
  globalThis.JG_TUNE = tune === undefined ? undefined : { api: tune };
};
afterEach(() => {
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.JG_TUNE;
});

describe("apiBase", () => {
  test("empty or missing: local mode", () => {
    set({});
    assert.equal(apiBase(), "");
    set({ meta: "" });
    assert.equal(apiBase(), "");
    set({ meta: "   " });
    assert.equal(apiBase(), "");
  });
  test("an https address is kept (origin and path, no trailing slash)", () => {
    set({ meta: "https://api.pixcar.example/" });
    assert.equal(apiBase(), "https://api.pixcar.example");
    set({ meta: "https://api.pixcar.example/pixcar/" });
    assert.equal(apiBase(), "https://api.pixcar.example/pixcar");
    set({ meta: "https://api.pixcar.example:8443/x?y=1#z" });
    assert.equal(apiBase(), "https://api.pixcar.example:8443/x");
  });
  test("http only for local development; other schemes are refused", () => {
    set({ meta: "http://localhost:8787" });
    assert.equal(apiBase(), "http://localhost:8787");
    set({ meta: "http://127.0.0.1:8787/" });
    assert.equal(apiBase(), "http://127.0.0.1:8787");
    for (const bad of ["http://api.pixcar.example", "javascript:alert(1)", "data:text/html,x", "ftp://x", "file:///etc/passwd"]) {
      set({ meta: bad });
      assert.equal(apiBase(), "", bad);
    }
  });
  test("a relative address is resolved against the page (same-origin API)", () => {
    set({ meta: "/api", href: "https://pixcar.example/index.html" });
    assert.equal(apiBase(), "https://pixcar.example/api");
  });
  test("the test hook wins over the document; garbage never throws", () => {
    set({ meta: "https://a.example", tune: "http://localhost:9999" });
    assert.equal(apiBase(), "http://localhost:9999");
    set({ meta: "https://[oups" });
    assert.equal(apiBase(), "");
  });
});
