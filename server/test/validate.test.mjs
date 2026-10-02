// Validation d'une déclaration : ce que le navigateur envoie n'est jamais cru sur parole.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isToken, isUuid, parseRepair } from "../lib/validate.mjs";
import { repair } from "./helpers.mjs";

const services = new Set(["vidange", "revision"]);
const today = "2026-10-02";
const parse = (body) => parseRepair(body, { services, today });

describe("parseRepair", () => {
  test("accepts a complete declaration and returns the normalised value", () => {
    const r = repair({ date: "2026-09-12" });
    const { value, fields } = parse(r);
    assert.equal(fields, undefined);
    assert.equal(value.id, r.id);
    assert.equal(value.priceCents, 5990);
    assert.equal(value.model, "Peugeot 208");
    assert.deepEqual(value.pos, { lat: 45.7347, lon: 4.9128 });
  });

  test("normalises text: trims, collapses spaces, drops control and line-separator characters, lower-cases ids, upper-cases the plate", () => {
    const r = repair({
      id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      deleteToken: "ABCDEF0123456789ABCDEF0123456789",
      garage: { id: "osm:node/5", name: "  Garage\u0007  du\t  Coin\u2028 ", addr: " 1 rue  X ", lat: 45, lon: 4, chainId: "" },
      comment: "Ligne 1\nLigne 2\u0000\u200b  ",
      vehicle: { model: "  Peugeot\u0000 208 ", year: 2019, plate: " ez-108-bc " },
    });
    const { value } = parse(r);
    assert.equal(value.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(value.deleteToken, "abcdef0123456789abcdef0123456789");
    assert.equal(value.garage.name, "Garage du Coin");
    assert.equal(value.garage.addr, "1 rue X");
    assert.equal(value.model, "Peugeot 208");
    assert.equal(value.plate, "EZ-108-BC");
    assert.ok(value.comment.startsWith("Ligne 1\nLigne 2"), "les retours à la ligne du commentaire sont gardés");
    assert.ok(!/[\u0000\u2028]/.test(value.comment));
  });

  test("prices become integer cents without floating-point drift", () => {
    for (const [price, cents] of [[59.9, 5990], [19.99, 1999], [0.01, 1], [20000, 2000000], [89.9, 8990], [1234.56, 123456]]) assert.equal(parse(repair({ price })).value.priceCents, cents, String(price));
    assert.ok(parse(repair({ price: 20000.01 })).fields.price);
    assert.ok(parse(repair({ price: -5 })).fields.price);
    assert.ok(parse(repair({ price: Infinity })).fields.price);
    assert.ok(parse(repair({ price: "12" })).fields.price);
  });

  test("date: today passes, tomorrow does not; the model year may equal the repair year but not exceed it", () => {
    assert.ok(parse(repair({ date: "2026-10-02" })).value);
    assert.ok(parse(repair({ date: "2026-10-03" })).fields.date);
    const v = (year, date) => parse(repair({ date, vehicle: { model: "Clio", year, plate: "EZ-108-BC" } }));
    assert.ok(v(2020, "2020-03-01").value);
    assert.ok(v(2021, "2020-03-01").fields["vehicle.year"]);
    assert.ok(v(2027, "2026-09-01").fields["vehicle.year"], "l'année en cours est le plafond");
  });

  test("a garage position is all or nothing; without one the search position is used", () => {
    const base = repair();
    assert.deepEqual(parse({ ...base, garage: { ...base.garage, lat: null, lon: null }, area: { lat: 45.5, lon: 4.5 } }).value.pos, { lat: 45.5, lon: 4.5 });
    assert.ok(parse({ ...base, garage: { ...base.garage, lon: null } }).fields["garage.lat"]);
    assert.ok(parse({ ...base, garage: { ...base.garage, lat: null, lon: null }, area: undefined }).fields.area);
    assert.ok(parse({ ...base, garage: { ...base.garage, lat: "45" } }).fields["garage.lat"]);
  });

  test("anything that is not an object is refused; unknown extra fields are ignored", () => {
    for (const body of [null, undefined, [], "texte", 12, true]) assert.ok(parse(body).fields.body, String(body));
    const r = { ...repair(), isAdmin: true, status: "approved", __proto__: { evil: 1 }, "garage.x": 1 };
    const { value } = parse(r);
    assert.ok(value && !("isAdmin" in value) && !("status" in value));
  });

  test("every error is reported at once, keyed by field", () => {
    const { fields } = parse({});
    for (const k of ["id", "deleteToken", "garage.id", "garage.name", "area", "serviceId", "price", "date", "rating", "vehicle.model", "vehicle.year", "vehicle.plate"]) assert.ok(k in fields, k);
  });

  test("isUuid / isToken", () => {
    assert.ok(isUuid("11111111-1111-4111-8111-111111111111"));
    assert.ok(!isUuid("11111111-1111-3111-8111-111111111111")); // pas v4
    assert.ok(!isUuid("11111111111141118111111111111111"));
    assert.ok(!isUuid(null));
    assert.ok(isToken("a".repeat(32)) && isToken("A".repeat(128)));
    assert.ok(!isToken("a".repeat(31)) && !isToken("a".repeat(129)) && !isToken("g".repeat(32)));
  });
});
