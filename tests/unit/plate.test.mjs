// Immatriculation d'un rendez-vous en ligne (src/js/shared/rules.js, parsePlate) : obligatoire, SIV, ancienne FNI, plaque étrangère sur
// demande ; forme gardée de 9 caractères au plus (colonne rdv_requests.plate).
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLATE_MAX, parsePlate } from "../../src/js/shared/rules.js";

const ok = (raw, opts) => parsePlate(raw, opts).value;
const err = (raw, opts) => parsePlate(raw, opts).error;

test("SIV plates, written with or without dashes or spaces, any case, become AB-123-CD", () => {
  for (const raw of ["EZ-108-BC", "ez108bc", "EZ 108 BC", " ez-108 bc ", "EZ–108–BC", "EZ.108.BC"]) assert.equal(ok(raw), "EZ-108-BC", raw);
});

test("old FNI plates are accepted, kept without separators (they would not fit otherwise)", () => {
  assert.equal(ok("1234 AB 31"), "1234AB31");
  assert.equal(ok("1234ab31"), "1234AB31");
  assert.equal(ok("12 ABC 2A"), "12ABC2A");
  assert.equal(ok("123 AB 974"), "123AB974");
  assert.match(err("1234 ABCD 31"), /^Immatriculation au format AB-123-CD/, "trop de caractères");
  assert.match(err("12 AB 3"), /^Immatriculation au format/, "département sur un chiffre");
});

test("required: empty or blank is refused with its own message", () => {
  for (const raw of ["", "   ", null, undefined]) assert.equal(err(raw), "Indiquez l'immatriculation de la voiture.", String(raw));
});

test("foreign plates only when said so: 2 to 9 letters and digits, kept as written when they fit", () => {
  assert.match(err("GE 123456"), /^Immatriculation au format/);
  assert.equal(ok("GE 123456", { foreign: true }), "GE 123456");
  assert.equal(ok("m - ab 1234", { foreign: true }), "M-AB 1234");
  assert.equal(ok("KA-AB 1234", { foreign: true }), "KAAB1234", "10 caractères : sans séparateurs");
  for (const raw of ["A", "-", "ABCDEFGHIJ", "AB/12", "é12"]) assert.match(err(raw, { foreign: true }), /^Plaque étrangère/, raw);
});

test("every accepted form fits the column", () => {
  for (const [raw, opts] of [["EZ-108-BC"], ["1234 AB 31"], ["12 ABC 974"], ["M-AB 1234", { foreign: true }], ["KA-AB 1234", { foreign: true }], ["A-B-C-D-E-F-G-H-I", { foreign: true }]]) {
    const v = ok(raw, opts);
    assert.ok(v && v.length <= PLATE_MAX, `${raw} → ${v}`);
  }
});
