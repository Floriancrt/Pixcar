// Fenêtre « Quelles prestations souhaitez-vous réaliser ? » : les fonctions pures de modules/service-picker.js (recherche, choix, bouton de
// validation). La fenêtre elle-même (cases, pastilles, Échap, clavier, mobile) est vérifiée dans le navigateur par tests/services.js.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SVC_MAX, canPick, goLabel, matchServices, toggleService } from "../../src/js/modules/service-picker.js";
import { SERVICES } from "../../src/js/shared/services.js";

const ids = (l) => l.map((s) => s.id);
const CT = SERVICES.find((s) => s.kind === "ct").id;

describe("matchServices", () => {
  test("saisie vide ou blanche : toutes les prestations, dans l'ordre", () => {
    assert.deepEqual(ids(matchServices(SERVICES, "")), ids(SERVICES));
    assert.deepEqual(ids(matchServices(SERVICES, "   ")), ids(SERVICES));
    assert.notEqual(matchServices(SERVICES, ""), SERVICES); // une copie
  });
  test("sans accents ni casse, sur le libellé", () => {
    assert.ok(ids(matchServices(SERVICES, "GEOMETRIE")).includes("geo_av"));
    assert.ok(ids(matchServices(SERVICES, "équilibrage")).includes("equil"));
    assert.deepEqual(ids(matchServices(SERVICES, "vidange")), ["vidange"]);
  });
  test("tous les mots doivent y être, dans n'importe quel ordre", () => {
    assert.deepEqual(ids(matchServices(SERVICES, "avant géométrie")), ids(matchServices(SERVICES, "géométrie avant")));
    assert.ok(matchServices(SERVICES, "géométrie avant").every((s) => /avant/i.test(`${s.label} ${s.hint}`)));
  });
  test("le groupe et l'aide comptent aussi (« pneus » trouve le montage)", () => {
    assert.ok(ids(matchServices(SERVICES, "pneus")).includes("montage"));
    assert.ok(ids(matchServices(SERVICES, "huile")).includes("vidange"));
  });
  test("ponctuation ignorée, rien ne correspond : liste vide", () => {
    assert.deepEqual(ids(matchServices(SERVICES, "vidange !")), ["vidange"]);
    assert.deepEqual(matchServices(SERVICES, "zzzz"), []);
  });
});

describe("toggleService", () => {
  test("cocher ajoute à la fin, décocher retire", () => {
    assert.deepEqual(toggleService(SERVICES, [], "vidange"), ["vidange"]);
    assert.deepEqual(toggleService(SERVICES, ["vidange"], "clim"), ["vidange", "clim"]);
    assert.deepEqual(toggleService(SERVICES, ["vidange", "clim"], "vidange"), ["clim"]);
  });
  test("une prestation inconnue ne change rien", () => {
    assert.deepEqual(toggleService(SERVICES, ["vidange"], "nope"), ["vidange"]);
  });
  test("le contrôle technique se cherche seul : il remplace tout, et toute autre prestation le remplace", () => {
    assert.deepEqual(toggleService(SERVICES, ["vidange", "clim"], CT), [CT]);
    assert.deepEqual(toggleService(SERVICES, [CT], "vidange"), ["vidange"]);
    assert.deepEqual(toggleService(SERVICES, [CT], CT), []);
  });
  test(`au plus ${SVC_MAX} prestations : la suivante ne s'ajoute pas`, () => {
    const five = SERVICES.filter((s) => s.kind !== "ct").slice(0, SVC_MAX).map((s) => s.id);
    const sixth = SERVICES.filter((s) => s.kind !== "ct")[SVC_MAX].id;
    assert.equal(five.length, SVC_MAX);
    assert.deepEqual(toggleService(SERVICES, five, sixth), five);
    assert.equal(canPick(SERVICES, five, sixth), false);
    assert.equal(canPick(SERVICES, five, five[0]), true); // on peut toujours décocher
    assert.equal(canPick(SERVICES, five, CT), true); // le contrôle technique remplace tout
  });
  test("avec max = 1, la nouvelle prestation remplace l'ancienne", () => {
    assert.deepEqual(toggleService(SERVICES, ["vidange"], "clim", 1), ["clim"]);
    assert.equal(canPick(SERVICES, ["vidange"], "clim", 1), true);
  });
  test("ne modifie jamais la sélection reçue", () => {
    const sel = ["vidange"];
    toggleService(SERVICES, sel, "clim");
    toggleService(SERVICES, sel, "vidange");
    assert.deepEqual(sel, ["vidange"]);
  });
});

describe("goLabel", () => {
  test("le bouton dit combien de prestations il valide", () => {
    assert.equal(goLabel(0), "Choisissez une prestation");
    assert.equal(goLabel(1), "Valider cette prestation");
    assert.equal(goLabel(2), "Valider ces 2 prestations");
    assert.equal(goLabel(5), "Valider ces 5 prestations");
  });
});
