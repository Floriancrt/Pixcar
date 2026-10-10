// Plusieurs prestations : disponibilité, prix total, promotions et fourchette des enseignes pour l'ensemble choisi (modules/svc-combo.js).
// Le rendu dans la page (fiches, résumé, carte) est vérifié par tests/services.js.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { comboOffer, comboPrice, comboPromos, comboRange, comboTag } from "../../src/js/modules/svc-combo.js";

const VID = { label: "Vidange (huile + filtre)" },
  CLIM = { label: "Recharge de climatisation" },
  GEO = { label: "Parallélisme / géométrie avant" };

describe("comboOffer", () => {
  test("une prestation seule : son niveau et sa raison, tels quels", () => {
    assert.deepEqual(comboOffer([{ ...VID, lvl: "likely", why: "Garage mécanique : prestation probable" }]), { lvl: "likely", why: "Garage mécanique : prestation probable" });
    assert.deepEqual(comboOffer([]), { lvl: "no" });
  });
  test("toutes au même niveau, même raison : raison au pluriel", () => {
    const o = comboOffer([
      { ...VID, lvl: "likely", why: "Garage mécanique : prestation probable" },
      { ...CLIM, lvl: "likely", why: "Garage mécanique : prestation probable" },
    ]);
    assert.deepEqual(o, { lvl: "likely", why: "Garage mécanique : prestations probables" });
    assert.deepEqual(comboOffer([{ ...VID, lvl: "yes", why: "Au catalogue de l'enseigne" }, { ...CLIM, lvl: "yes", why: "Au catalogue de l'enseigne" }]), { lvl: "yes", why: "Au catalogue de l'enseigne" });
  });
  test("le niveau le plus faible l'emporte, et on dit pour quelle prestation", () => {
    const o = comboOffer([
      { ...VID, lvl: "yes", why: "Au catalogue de l'enseigne" },
      { ...CLIM, lvl: "check", why: "Pas au catalogue national de l'enseigne : à vérifier" },
    ]);
    assert.equal(o.lvl, "check");
    assert.equal(o.why, "Pas au catalogue national de l'enseigne : à vérifier (recharge de climatisation)");
  });
  test("deux raisons différentes au niveau le plus faible : les deux sont dites", () => {
    const o = comboOffer([
      { ...GEO, lvl: "check", why: "Banc de géométrie non renseigné : à vérifier" },
      { ...CLIM, lvl: "check", why: "Carrosserie : prestation à vérifier" },
      { ...VID, lvl: "likely", why: "Garage mécanique : prestation probable" },
    ]);
    assert.equal(o.lvl, "check");
    assert.equal(o.why, "Banc de géométrie non renseigné : à vérifier · Carrosserie : prestation à vérifier");
  });
  test("une prestation que le garage ne fait pas : « 1 prestation sur 2 », la prestation manquante nommée", () => {
    const o = comboOffer([{ ...VID, lvl: "no" }, { ...GEO, lvl: "yes", why: "Au catalogue de l'enseigne" }]);
    assert.deepEqual(o, { lvl: "part", why: "1 prestation sur 2 : ne propose pas vidange (huile + filtre)", n: 1, of: 2 });
    const o3 = comboOffer([{ ...VID, lvl: "no" }, { ...CLIM, lvl: "no" }, { ...GEO, lvl: "likely", why: "x" }]);
    assert.equal(o3.why, "1 prestation sur 3 : ne propose pas vidange (huile + filtre) et recharge de climatisation");
    assert.equal(comboOffer([{ ...VID, lvl: "likely", why: "x" }, { ...CLIM, lvl: "likely", why: "x" }, { ...GEO, lvl: "no" }]).why, "2 prestations sur 3 : ne propose pas parallélisme / géométrie avant");
  });
  test("aucune des prestations : écarté", () => {
    assert.deepEqual(comboOffer([{ ...VID, lvl: "no" }, { ...CLIM, lvl: "no" }]), { lvl: "no" });
  });
});

const chain = (amount, extra = {}) => ({ kind: "chain", amount, ...extra }),
  declared = (amount) => ({ kind: "declared", amount, n: 2 });

describe("comboPrice", () => {
  test("une prestation seule : son prix, tel quel (même objet)", () => {
    const p = chain(49);
    assert.equal(comboPrice([{ id: "vidange", price: p }]), p);
    assert.deepEqual(comboPrice([]), { kind: "none" });
  });
  test("tous les prix connus : total complet, source commune", () => {
    const parts = [{ id: "vidange", price: chain(49) }, { id: "clim", price: chain(59.9) }];
    const c = comboPrice(parts);
    assert.equal(c.kind, "combo");
    assert.equal(c.amount, 108.9);
    assert.equal(c.partial, false);
    assert.equal(c.missing, 0);
    assert.equal(c.src, "chain");
    assert.equal(c.declared, 0);
    assert.equal(c.parts, parts);
    assert.equal(comboTag(c), "Total 2 prestations");
  });
  test("prix déclaré et prix d'enseigne : source mixte, déclarés comptés", () => {
    const c = comboPrice([{ id: "a", price: declared(80) }, { id: "b", price: chain(20, { approx: true }) }]);
    assert.equal(c.src, "mixed");
    assert.equal(c.declared, 1);
    assert.equal(c.approx, true);
    assert.equal(c.amount, 100);
  });
  test("un prix manquant : total partiel (jamais complet)", () => {
    const c = comboPrice([{ id: "a", price: chain(49) }, { id: "b", price: { kind: "center" } }]);
    assert.equal(c.amount, 49);
    assert.equal(c.partial, true);
    assert.equal(c.missing, 1);
    assert.equal(comboTag(c), "Total partiel");
  });
  test("« pièces en plus » sur une prestation : total partiel", () => {
    const c = comboPrice([{ id: "a", price: chain(49) }, { id: "b", price: chain(30, { partial: true }) }]);
    assert.equal(c.partial, true);
    assert.equal(c.missing, 0);
    assert.equal(c.amount, 79);
  });
  test("une prestation que le garage ne fait pas : son prix ne compte pas", () => {
    const c = comboPrice([{ id: "a", price: chain(49) }, { id: "b", price: chain(500), no: true }]);
    assert.equal(c.amount, 49);
    assert.equal(c.partial, true);
    assert.equal(c.missing, 1);
  });
  test("aucun prix : « tarif fixé par le centre » si une enseigne fait la prestation, sinon « prix non publié »", () => {
    assert.equal(comboPrice([{ id: "a", price: { kind: "center" } }, { id: "b", price: { kind: "none" } }]).kind, "center");
    assert.equal(comboPrice([{ id: "a", price: { kind: "none" } }, { id: "b", price: { kind: "none" } }]).kind, "none");
    assert.equal(comboPrice([{ id: "a", price: { kind: "center" }, no: true }, { id: "b", price: { kind: "none" } }]).kind, "none");
    assert.equal(Number.isFinite(comboPrice([{ id: "a", price: { kind: "none" } }, { id: "b", price: { kind: "none" } }]).amount), false);
  });
  test("arrondi au centime (pas de 108,89999…)", () => {
    assert.equal(comboPrice([{ id: "a", price: chain(0.1) }, { id: "b", price: chain(0.2) }]).amount, 0.3);
  });
});

describe("comboPromos", () => {
  test("une même offre sur deux prestations n'apparaît qu'une fois ; les offres à venir après celles en cours", () => {
    const a = { label: "−10 € géométrie", src: "s1", start: "2026-09-10", end: "2026-10-06", st: "active" };
    const soon = { label: "Clim offerte", src: "s2", start: "2026-11-01", st: "soon" };
    const out = comboPromos([[soon, a], [{ ...a }], []]);
    assert.deepEqual(out.map((p) => p.label), ["−10 € géométrie", "Clim offerte"]);
  });
  test("deux offres différentes de même libellé (dates différentes) restent deux", () => {
    const out = comboPromos([[{ label: "x", src: "s", start: "2026-01-01" }], [{ label: "x", src: "s", start: "2026-02-01" }]]);
    assert.equal(out.length, 2);
  });
});

describe("comboRange", () => {
  const prices = {
    vidange: [{ c: "norauto", p: 49 }, { c: "speedy", p: 55 }, { c: "midas", p: 60, partial: true }, { c: "feu", p: 52 }],
    clim: [{ c: "norauto", p: 59.9 }, { c: "speedy", p: 69 }, { c: "midas", p: 50 }],
  };
  test("seulement les enseignes qui publient un prix complet pour chaque prestation", () => {
    const r = comboRange(["vidange", "clim"], prices);
    assert.deepEqual(r, { min: { c: "norauto", p: 108.9 }, max: { c: "speedy", p: 124 }, n: 2 });
  });
  test("une prestation seule ou aucune enseigne complète : rien", () => {
    assert.equal(comboRange(["vidange"], prices), null);
    assert.equal(comboRange(["vidange", "inconnue"], prices), null);
    assert.equal(comboRange(["clim", "vidange"], { clim: [{ c: "midas", p: 50 }], vidange: [{ c: "midas", p: 60, partial: true }] }), null);
  });
  test("l'ordre des prestations ne change pas le résultat", () => {
    assert.deepEqual(comboRange(["clim", "vidange"], prices), comboRange(["vidange", "clim"], prices));
  });
});
