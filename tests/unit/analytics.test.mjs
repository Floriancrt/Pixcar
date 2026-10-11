// Mesure d'audience : les fonctions pures de modules/analytics.js (identifiants Google et Contentsquare, validité du choix, cookies). Le comportement dans le
// navigateur (bandeau, chargement après accord, retrait) est vérifié par tests/consent.js.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHOICE_DAYS, CHOICE_KEY, COOKIE_SECONDS, contentsquareCookieNames, contentsquareId, cookieDomains, googleCookieNames, initAnalytics, measurementId, readChoice, saveChoice } from "../../src/js/modules/analytics.js";

const DAY = 864e5;
const docWith = (content) => ({ querySelector: (sel) => (sel === 'meta[name="pixcar-analytics"]' && content !== undefined ? { content } : null) });
const csDocWith = (content) => ({ querySelector: (sel) => (sel === 'meta[name="pixcar-contentsquare"]' && content !== undefined ? { content } : null) });
const storeWith = (value) => ({ getItem: (k) => (k === CHOICE_KEY ? (value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value)) : null) });
const NOW = 1_800_000_000_000;

describe("constantes", () => {
  test("le choix vaut six mois, les cookies de Google 13 mois (395 jours)", () => {
    assert.equal(CHOICE_DAYS, 183);
    assert.equal(COOKIE_SECONDS, 395 * 86400);
    assert.equal(CHOICE_KEY, "jg.consent.v1");
  });
});

describe("measurementId", () => {
  test("un identifiant G-… bien formé est repris (espaces autour retirés)", () => {
    assert.equal(measurementId(docWith("G-5E8XFJBN5E")), "G-5E8XFJBN5E");
    assert.equal(measurementId(docWith("  G-ABC123  ")), "G-ABC123");
  });
  test("absent, vide ou mal formé : chaîne vide (aucune mesure)", () => {
    for (const bad of [undefined, "", "UA-12345-1", "g-abc123", "G-abc123", "G-AB", "G-ABCDEFGHIJKLM", "G-ABC 123", "G-ABC123;alert(1)", "https://www.googletagmanager.com/gtag/js?id=G-ABC123"]) assert.equal(measurementId(docWith(bad)), "", String(bad));
  });
});

describe("contentsquareId", () => {
  test("l'identifiant du tag (nom du fichier t.contentsquare.net/uxa/<identifiant>.js) est repris, espaces autour retirés", () => {
    assert.equal(contentsquareId(csDocWith("cdb4789d71fe2")), "cdb4789d71fe2");
    assert.equal(contentsquareId(csDocWith("  abc123def4567 ")), "abc123def4567");
  });
  test("absent, vide ou mal formé (majuscules, chemin, trop court ou trop long) : chaîne vide, aucun tag", () => {
    for (const v of [undefined, "", "CDB4789D71FE2", "abc/../x", "cdb4789d71fe2.js", "abc123", "a".repeat(21), "cdb4789d71fe2?x=1", "javascript:1"]) assert.equal(contentsquareId(csDocWith(v)), "", String(v));
  });
});

describe("readChoice", () => {
  const now = NOW;
  test("accepté et refusé, récents", () => {
    assert.equal(readChoice(storeWith({ analytics: true, at: now - DAY }), now), "granted");
    assert.equal(readChoice(storeWith({ analytics: false, at: now - DAY }), now), "denied");
  });
  test("valable jusqu'à 183 jours, plus après (accepté comme refusé)", () => {
    assert.equal(readChoice(storeWith({ analytics: true, at: now - 183 * DAY }), now), "granted");
    assert.equal(readChoice(storeWith({ analytics: true, at: now - 183 * DAY - 1 }), now), null);
    assert.equal(readChoice(storeWith({ analytics: false, at: now - 183 * DAY - 1 }), now), null);
  });
  test("daté du futur : toléré d'un jour (horloge), refusé au-delà", () => {
    assert.equal(readChoice(storeWith({ analytics: true, at: now + DAY }), now), "granted");
    assert.equal(readChoice(storeWith({ analytics: true, at: now + DAY + 1 }), now), null);
  });
  test("jamais répondu, illisible, incomplet ou mal typé : null", () => {
    assert.equal(readChoice(storeWith(undefined), now), null);
    for (const junk of ["granted", "{oops", "null", "[]", { analytics: "yes", at: now }, { analytics: 1, at: now }, { analytics: true }, { at: now }, { analytics: true, at: "hier" }, { analytics: true, at: NaN }, { analytics: true, at: null }]) assert.equal(readChoice(storeWith(junk), now), null, JSON.stringify(junk));
  });
  test("un stockage qui échoue : null, sans exception", () => {
    assert.equal(readChoice({ getItem: () => { throw new Error("SecurityError"); } }, now), null);
    assert.equal(readChoice(null, now), null);
  });
});

describe("saveChoice", () => {
  test("écrit le choix et sa date", () => {
    const written = {};
    const ok = saveChoice({ setItem: (k, v) => (written[k] = v) }, true, NOW);
    assert.equal(ok, true);
    assert.deepEqual(JSON.parse(written[CHOICE_KEY]), { analytics: true, at: NOW });
    saveChoice({ setItem: (k, v) => (written[k] = v) }, false, NOW + 5);
    assert.deepEqual(JSON.parse(written[CHOICE_KEY]), { analytics: false, at: NOW + 5 });
  });
  test("ce qui est écrit se relit", () => {
    const mem = {};
    const storage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => (mem[k] = v) };
    saveChoice(storage, true, NOW);
    assert.equal(readChoice(storage, NOW + DAY), "granted");
    saveChoice(storage, false, NOW);
    assert.equal(readChoice(storage, NOW + DAY), "denied");
  });
  test("stockage refusé : faux, sans exception", () => {
    assert.equal(saveChoice({ setItem: () => { throw new Error("QuotaExceededError"); } }, true, NOW), false);
  });
});

describe("googleCookieNames", () => {
  test("repère _ga, _ga_<flux>, _gid et _gat…, pas les autres", () => {
    const names = googleCookieNames("a=1; _ga=GA1.1.1.1; _ga_5E8XFJBN5E=GS1.1; _gid=x; _gat_gtag_UA_1=1; session=2; _gac_foo=1; xga=3; _ga2=4");
    assert.deepEqual(names, ["_ga", "_ga_5E8XFJBN5E", "_gid", "_gat_gtag_UA_1"]);
  });
  test("un nom une seule fois, rien quand il n'y a rien", () => {
    assert.deepEqual(googleCookieNames("_ga=1; _ga=2"), ["_ga"]);
    assert.deepEqual(googleCookieNames(""), []);
    assert.deepEqual(googleCookieNames("a=1; b=2"), []);
  });
});

describe("contentsquareCookieNames", () => {
  test("repère tous les cookies « _cs_… » (_cs_id, _cs_s, _cs_c, _cs_optout…), pas les autres", () => {
    assert.deepEqual(contentsquareCookieNames("a=1; _cs_id=1.2; _cs_s=1.0; _cs_c=1; _cs_optout=1; _cs_root-domain=pixcar.fr; _ga=1; cs_id=2; _csx=3; x_cs_id=4"), ["_cs_id", "_cs_s", "_cs_c", "_cs_optout", "_cs_root-domain"]);
  });
  test("un nom une seule fois, rien quand il n'y a rien", () => {
    assert.deepEqual(contentsquareCookieNames("_cs_id=1; _cs_id=2"), ["_cs_id"]);
    assert.deepEqual(contentsquareCookieNames(""), []);
    assert.deepEqual(contentsquareCookieNames("_ga=1; _gid=2"), []);
  });
});

describe("cookieDomains", () => {
  test("du nom complet au domaine enregistrable, jamais le suffixe seul", () => {
    assert.deepEqual(cookieDomains("www.pixcar.fr"), ["www.pixcar.fr", "pixcar.fr"]);
    assert.deepEqual(cookieDomains("pixcar.fr"), ["pixcar.fr"]);
    assert.deepEqual(cookieDomains("a.b.c.exemple.fr"), ["a.b.c.exemple.fr", "b.c.exemple.fr", "c.exemple.fr", "exemple.fr"]);
    assert.deepEqual(cookieDomains("WWW.Pixcar.FR"), ["www.pixcar.fr", "pixcar.fr"]);
  });
  test("localhost, adresses IP, vide : aucun domaine (le cookie est propre à l'hôte)", () => {
    for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "::1", "[::1]", "", undefined, null]) assert.deepEqual(cookieDomains(host), [], String(host));
  });
});

describe("initAnalytics", () => {
  test("sans identifiant, ou sans fenêtre : rien (null), aucun effet", () => {
    assert.equal(initAnalytics(docWith(""), {}), null);
    assert.equal(initAnalytics(docWith(undefined), {}), null);
    assert.equal(initAnalytics(docWith("G-ABC123"), undefined), null);
    assert.equal(initAnalytics(csDocWith(""), {}), null);
    assert.equal(initAnalytics(csDocWith("cdb4789d71fe2"), undefined), null);
  });
});
