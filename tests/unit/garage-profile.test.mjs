// « Mon garage » (src/js/shared/garage-profile.js) : validation commune à l'API et à la page pro, textes du comparateur.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAYS, addrText, hoursText, minutesText, parseAddr, parseEmail, parseHours, parseMinutes, parseName, parsePhone, parseWebsite, phoneText,
} from "../../src/js/shared/garage-profile.js";

test("parseHours: up to two slots a day, quarter hours, in order, without overlap; an absent or empty day is closed", () => {
  assert.deepEqual(parseHours({ mo: [["08:00", "12:00"], ["14:00", "18:30"]], tu: [], sa: [["08:00", "12:00"]] }).value, { mo: [["08:00", "12:00"], ["14:00", "18:30"]], sa: [["08:00", "12:00"]] });
  assert.deepEqual(parseHours({ su: [["00:00", "24:00"]] }).value, { su: [["00:00", "24:00"]] });
  for (const empty of [null, undefined, ""]) assert.equal(parseHours(empty).value, null);
  assert.deepEqual(parseHours({}).value, {});
  for (const bad of [
    [],
    "lun 8-12",
    { mon: [["08:00", "12:00"]] },
    { mo: "08:00-12:00" },
    { mo: [["08:00"]] },
    { mo: [["8:00", "12:00"]] },
    { mo: [["08:05", "12:00"]] },
    { mo: [["12:00", "12:00"]] },
    { mo: [["14:00", "18:00"], ["08:00", "12:00"]] },
    { mo: [["08:00", "12:00"], ["12:00", "18:00"]] },
    { mo: [["08:00", "09:00"], ["10:00", "11:00"], ["14:00", "15:00"]] },
    { mo: [["24:00", "24:15"]] },
  ])
    assert.ok(parseHours(bad).error, JSON.stringify(bad));
  assert.equal(DAYS.length, 7);
});

test("hoursText: neighbouring days that match are grouped; closed days said; nothing declared → empty", () => {
  const week = { mo: [["08:00", "12:00"], ["14:00", "18:30"]], tu: [["08:00", "12:00"], ["14:00", "18:30"]], we: [["08:00", "12:00"], ["14:00", "18:30"]], th: [["08:00", "12:00"], ["14:00", "18:30"]], fr: [["08:00", "12:00"], ["14:00", "18:30"]], sa: [["08:00", "12:00"]] };
  assert.equal(hoursText(week), "lun.–ven. 8:00–12:00, 14:00–18:30 · sam. 8:00–12:00 · dim. fermé");
  assert.equal(hoursText({ mo: [["09:00", "17:00"]], we: [["09:00", "17:00"]] }), "lun. 9:00–17:00 · mar. fermé · mer. 9:00–17:00 · jeu.–dim. fermé");
  assert.equal(hoursText({}), "");
  assert.equal(hoursText(null), "");
});

test("parseWebsite: a real http(s) domain, scheme added; no other scheme, no credentials, no local name", () => {
  assert.equal(parseWebsite("Garage-Martin.fr").value, "https://garage-martin.fr/");
  assert.equal(parseWebsite("http://www.garage-martin.fr/atelier").value, "http://www.garage-martin.fr/atelier");
  assert.equal(parseWebsite("  ").value, "");
  for (const bad of ["javascript:alert(1)", "ftp://garage.fr", "https://a:b@garage.fr", "localhost", "http://192.168.1.1", "garage", "https://garage.f", "x".repeat(200) + ".fr"])
    assert.ok(parseWebsite(bad).error, bad);
});

test("parseEmail, parseName, parseAddr: trimmed, lower-cased e-mail; a name with a letter; a 5-digit postcode", () => {
  assert.equal(parseEmail(" Atelier@Garage.FR ").value, "atelier@garage.fr");
  assert.equal(parseEmail("").value, "");
  for (const bad of ["atelier@", "@garage.fr", "a b@garage.fr", "a..b@garage.fr", "a@garage"]) assert.ok(parseEmail(bad).error, bad);
  assert.equal(parseName("  Garage   du   Centre ").value, "Garage du Centre");
  for (const bad of ["x", "12345", "y".repeat(121)]) assert.ok(parseName(bad).error, bad);
  assert.deepEqual(parseAddr({ street: " 12  rue de la Paix ", pc: "69 002", city: "Lyon" }).value, { street: "12 rue de la Paix", pc: "69002", city: "Lyon" });
  for (const bad of [null, "12 rue", { street: "12", pc: "69002", city: "Lyon" }, { street: "12 rue X", pc: "6900", city: "Lyon" }, { street: "12 rue X", pc: "69002", city: "" }])
    assert.ok(parseAddr(bad).error, JSON.stringify(bad));
  assert.equal(addrText({ street: "12 rue de la Paix", pc: "69002", city: "Lyon" }), "12 rue de la Paix, 69002 Lyon");
  assert.equal(addrText(null), "");
});

test("parsePhone: exactly one number, kept in international form; phoneText writes it the French way", () => {
  assert.equal(parsePhone("05 61 00 00 01").value, "+33561000001");
  assert.equal(parsePhone("+33 (0)5 61 00 00 01").value, "+33561000001");
  assert.equal(parsePhone("0033 6 12 34 56 78").value, "+33612345678");
  assert.equal(parsePhone("+262 262 12 34 56").value, "+262262123456");
  for (const bad of ["", "12", "05 61 00 00 01 ou 06 12 34 56 78", "0012345"]) assert.ok(parsePhone(bad).error, bad);
  assert.equal(phoneText("+33561000001"), "05 61 00 00 01");
});

test("parseMinutes and minutesText: from 15 min to 8 h by quarter hours, or nothing yet", () => {
  for (const ok of [15, 45, 90, 480]) assert.equal(parseMinutes(ok).value, ok);
  for (const empty of [null, undefined]) assert.equal(parseMinutes(empty).value, null);
  for (const bad of [0, 10, 50, 495, 45.5, "45", true]) assert.ok(parseMinutes(bad).error, String(bad));
  assert.deepEqual([15, 45, 60, 90, 240, 270].map(minutesText), ["15 min", "45 min", "1 h", "1 h 30", "4 h", "4 h 30"]);
  assert.equal(minutesText(null), "");
});
