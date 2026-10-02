// Configuration : en production, un secret ou une origine manquant empêche le démarrage ; en développement tout a une valeur.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../config.mjs";

const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://x", PLATE_PEPPER: "p".repeat(24), IP_PEPPER: "i".repeat(24), ALLOWED_ORIGINS: "https://pixcar.example", TRUST_PROXY: "0" };

describe("loadConfig", () => {
  test("development: everything has a default, secrets are random per process", () => {
    const a = loadConfig({}), b = loadConfig({});
    assert.equal(a.port, 8787);
    assert.deepEqual(a.allowedOrigins, ["*"]);
    assert.notEqual(a.plateSecret, b.plateSecret);
    assert.equal(a.production, false);
    assert.equal(a.trustProxy, 0);
    assert.equal(a.moderation, "auto");
  });
  test("production: lists every missing or weak setting at once", () => {
    assert.throws(() => loadConfig({ NODE_ENV: "production" }), (e) => /PLATE_PEPPER/.test(e.message) && /IP_PEPPER/.test(e.message) && /ALLOWED_ORIGINS/.test(e.message) && /DATABASE_URL/.test(e.message) && /TRUST_PROXY/.test(e.message));
    const { TRUST_PROXY, ...withoutProxy } = prod;
    assert.throws(() => loadConfig(withoutProxy), /TRUST_PROXY/, "à choisir explicitement en production");
    assert.throws(() => loadConfig({ ...withoutProxy, TRUST_PROXY: "" }), /TRUST_PROXY/);
    assert.throws(() => loadConfig({ ...prod, PLATE_PEPPER: "court" }), /PLATE_PEPPER/);
    assert.doesNotThrow(() => loadConfig(prod));
  });
  test("parses the knobs, and refuses nonsense", () => {
    const c = loadConfig({ ...prod, PORT: "3000", TRUST_PROXY: "2", WRITE_LIMIT_PER_HOUR: "5", MODERATION: "off", ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    assert.equal(c.port, 3000);
    assert.equal(c.trustProxy, 2);
    assert.equal(c.writeLimitPerHour, 5);
    assert.equal(c.moderation, "off");
    assert.deepEqual(c.allowedOrigins, ["https://a.example", "https://b.example"]);
    assert.equal(loadConfig({ ...prod, TRUST_PROXY: "cloudflare" }).trustProxy, "cloudflare");
    assert.throws(() => loadConfig({ ...prod, PORT: "abc" }), /entière/);
    assert.throws(() => loadConfig({ ...prod, WRITE_LIMIT_PER_HOUR: "0" }), /≥ 1/);
  });
});
