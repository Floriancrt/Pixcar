// Prix annoncés (src/js/shared/pro-prices.js) : validation commune à l'API et à la page pro, textes du comparateur, ancienneté.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DUE_DAYS, PRO_SERVICES, announcedDetail, announcedText, freshness, parseProPrice, staleAt, vehiclesText } from "../../src/js/shared/pro-prices.js";

test("the catalogue is the comparator's, technical inspection excluded (official prices)", () => {
  assert.ok(PRO_SERVICES.length >= 15);
  assert.ok(!PRO_SERVICES.some((s) => s.kind === "ct"));
  assert.ok(PRO_SERVICES.some((s) => s.id === "vidange"));
});

test("parseProPrice: kind, euros with two decimals at most, no price on quote, vehicles and inclusions in canonical order", () => {
  assert.deepEqual(parseProPrice("vidange", { kind: "fixed", price: 89.9, vehicles: ["suv", "city"], includes: ["labour", "parts", "labour"] }).value, {
    serviceId: "vidange", kind: "fixed", priceCents: 8990, vehicles: ["city", "suv"], includes: ["parts", "labour"],
  });
  assert.equal(parseProPrice("vidange", { kind: "fixed", price: 0.29 + 88.71 }).value.priceCents, 8900, "arrondi binaire toléré");
  assert.deepEqual(parseProPrice("diag", { kind: "quote" }).value.priceCents, null);
  assert.deepEqual(parseProPrice("diag", { kind: "quote", price: null }).value.priceCents, null);
  for (const [svc, body, field] of [
    ["ct", { kind: "fixed", price: 70 }, "service"],
    ["vidange", null, "kind"],
    ["vidange", { kind: "fixed", price: 20000.01 }, "price"],
    ["vidange", { kind: "from", price: Infinity }, "price"],
    ["vidange", { kind: "fixed", price: 10.001 }, "price"],
    ["diag", { kind: "quote", price: 0 }, "price"],
    ["vidange", { kind: "fixed", price: 89, vehicles: "city" }, "vehicles"],
    ["vidange", { kind: "fixed", price: 89, includes: [1] }, "includes"],
  ])
    assert.equal(parseProPrice(svc, body).field, field, JSON.stringify(body));
  assert.deepEqual(parseProPrice("vidange", { kind: "fixed", price: 89, vehicles: ["city", "compact", "sedan", "suv", "van"] }).value.vehicles, [], "tous : liste vide");
});

test("texts shown on Pixcar: « 89 € », « dès 119 € », « sur devis », the detail and the vehicles", () => {
  assert.equal(announcedText("fixed", 89), "89 €");
  assert.equal(announcedText("from", 119), "dès 119 €");
  assert.equal(announcedText("fixed", 89.5), "89,50 €");
  assert.equal(announcedText("quote", null), "sur devis");
  assert.equal(announcedDetail("fixed", ["parts", "labour"]), "forfait, pièces et main-d'œuvre");
  assert.equal(announcedDetail("from", ["labour"]), "à partir de, main-d'œuvre");
  assert.equal(announcedDetail("quote", []), "sur devis");
  assert.equal(vehiclesText([]), "tous véhicules");
  assert.equal(vehiclesText(["suv", "city"]), "citadine, SUV");
});

test("freshness: ok, then « due » in the 30 days before 6 months, then « stale »", () => {
  const t0 = Date.UTC(2026, 3, 20);
  const at = staleAt(t0);
  assert.equal(new Date(at).toISOString().slice(0, 10), "2026-10-20");
  assert.equal(freshness(t0, t0), "ok");
  assert.equal(freshness(t0, at - (DUE_DAYS + 1) * 864e5), "ok");
  assert.equal(freshness(t0, at - DUE_DAYS * 864e5), "due");
  assert.equal(freshness(t0, at - 1), "due");
  assert.equal(freshness(t0, at), "stale");
});
