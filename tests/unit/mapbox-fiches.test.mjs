// Fiches complétées par Mapbox : les fonctions pures et l'interrogation de modules/mapbox-fiches.js (requête, lecture de la réponse, rapprochement
// garage / lieu, horaires, site web, plafond, mémoire, arrêt sur jeton refusé). Le comportement dans la page est vérifié par tests/mapbox-fiches.js.
// Les noms, numéros (01 99 00 xx xx : numéros réservés à la fiction) et adresses sont fictifs : les résultats de Mapbox ne se conservent pas dans le dépôt.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CAP, NEAR_M, SAME_SPOT_M, cleanSite, createEnricher, fieldsFromPlace, hasRealName, haveOf, hoursFromPeriods, meters, missingOf, parsePlaces, pickPlace, sameName, searchUrl } from "../../src/js/modules/mapbox-fiches.js";

const TOKEN = ["pk", "eyJ1IjoiZXhlbXBsZSJ9", "c2lnbmF0dXJlLWZpY3RpZg"].join(".");
const LAT = 45.764;
const LON = 4.8357;
const north = (m) => ({ lat: LAT + m / 111320, lon: LON }); // un point à m mètres au nord
const garage = (name, m = 0, extra = {}) => ({ name, ...north(m), ...extra });
const place = (name, m = 0, extra = {}) => ({ id: "p-" + name, name, ...north(m), phone: "", web: "", periods: [], ...extra });
const week = (from, to, open = "0900", close = "1730") => Array.from({ length: to - from + 1 }, (_, i) => ({ open: { day: from + i, time: open }, close: { day: from + i, time: close } }));

describe("searchUrl", () => {
  const u = new URL(searchUrl({ token: TOKEN, lat: LAT, lon: LON }));
  test("la catégorie « auto_repair » de Search Box, avec le jeton, le français et dix résultats au plus", () => {
    assert.equal(u.origin + u.pathname, "https://api.mapbox.com/search/searchbox/v1/category/auto_repair");
    assert.equal(u.searchParams.get("access_token"), TOKEN);
    assert.equal(u.searchParams.get("language"), "fr");
    assert.equal(u.searchParams.get("limit"), "10");
    assert.equal(u.searchParams.has("country"), false);
    assert.equal(u.searchParams.has("session_token"), false);
  });
  test("une zone carrée de ±150 m autour du garage (« bbox » restreint, « proximity » ne fait que classer), et « proximity » au garage", () => {
    const [w, s, e, n] = u.searchParams.get("bbox").split(",").map(Number);
    assert.ok(w < LON && LON < e && s < LAT && LAT < n);
    assert.ok(Math.abs((n - s) * 111320 - 300) < 1, "hauteur = 300 m");
    assert.ok(Math.abs((e - w) * 111320 * Math.cos((LAT * Math.PI) / 180) - 300) < 1, "largeur = 300 m à cette latitude");
    assert.equal(u.searchParams.get("proximity"), `${LON.toFixed(6)},${LAT.toFixed(6)}`);
  });
  test("le jeton est encodé : un caractère qui sortirait du paramètre ne le peut pas", () => {
    const x = new URL(searchUrl({ token: "pk.a b&x=1.c", lat: LAT, lon: LON }));
    assert.equal(x.searchParams.get("access_token"), "pk.a b&x=1.c");
    assert.equal(x.searchParams.has("x"), false);
  });
});

describe("parsePlaces", () => {
  const feature = (name, lon, lat, metadata, more = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { name, mapbox_id: "id-" + name, feature_type: "poi", metadata, ...more } });
  test("lit le nom, la position, le téléphone, le site et les horaires dans la forme de la réponse de Search Box", () => {
    const periods = week(1, 5);
    const out = parsePlaces({ type: "FeatureCollection", features: [feature("Garage Exemple", LON, LAT, { phone: "+33199001234", website: "https://exemple.test/", open_hours: { periods } })] });
    assert.deepEqual(out, [{ id: "id-Garage Exemple", name: "Garage Exemple", lat: LAT, lon: LON, phone: "+33199001234", web: "https://exemple.test/", periods }]);
  });
  test("ce qui n'a pas la forme attendue est ignoré : pas de position, position non numérique, métadonnées absentes ou de mauvais type", () => {
    const out = parsePlaces({ features: [feature("Sans position", NaN, NaN, {}), { type: "Feature", properties: { name: "Sans géométrie" } }, feature("Mauvais types", LON, LAT, { phone: 33199001234, website: ["x"], open_hours: { periods: "lundi" } }), feature("Sans métadonnées", LON, LAT, undefined), null, 42] });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((p) => [p.name, p.phone, p.web, p.periods]), [["Mauvais types", "", "", []], ["Sans métadonnées", "", "", []]]);
  });
  test("une réponse qui n'est pas une liste de lieux donne une liste vide", () => {
    for (const bad of [null, undefined, {}, { features: "x" }, [], 42, "x"]) assert.deepEqual(parsePlaces(bad), []);
  });
});

describe("sameName", () => {
  test("un mot distinctif en commun suffit : enseigne suivie d'une ville, nom de famille, casse et accents", () => {
    for (const [a, b] of [["SOLSONA", "Carosserie Solsona"], ["Speedy Lyon 7e", "Speedy"], ["GARAGE CHIRIO", "garage chirio"], ["BERGES PNEUS 31", "Berges Pneus"], ["Garage Dupont", "Dupont Automobiles"], ["Garage Générale Éléphant", "ELEPHANT SERVICES"]]) assert.equal(sameName(a, b), true, `${a} / ${b}`);
  });
  test("un nom contenu dans l'autre une fois la ponctuation retirée suffit aussi, même sans mot distinctif", () => {
    assert.equal(sameName("L'ATELIER AUTO-MOBILE", "L’Atelier automobile"), true);
    assert.equal(sameName("AB REPARATION", "AB Reparation"), true);
  });
  test("des mots qui ne distinguent rien (garage, carrosserie, pneus, contrôle technique…) ne font pas un même garage", () => {
    for (const [a, b] of [["Carrosserie Zeleno", "Carrosserie Togue"], ["Garage du Centre", "Garage de la Gare"], ["Pneus Express", "Pneus Plus"], ["Contrôle technique Nord", "Contrôle technique Sud"], ["Auto Services", "Auto Service Pro"]]) assert.equal(sameName(a, b), false, `${a} / ${b}`);
  });
  test("deux noms sans rapport, ou un nom vide, ne concordent pas", () => {
    assert.equal(sameName("Garage Martin", "Pneus Lopez"), false);
    assert.equal(sameName("", "Garage Martin"), false);
    assert.equal(sameName("Garage Martin", ""), false);
    assert.equal(sameName(undefined, null), false);
  });
});

describe("hasRealName", () => {
  test("les noms de remplacement de la page ne sont pas de vrais noms", () => {
    assert.equal(hasRealName("Garage (nom non renseigné)"), false);
    assert.equal(hasRealName("Spécialiste pneus (sans nom)"), false);
    assert.equal(hasRealName(""), false);
    assert.equal(hasRealName("Garage Martin"), true);
    assert.equal(hasRealName("Garage de la Gare"), true);
  });
});

describe("meters", () => {
  test("distance à vol d'oiseau en mètres", () => {
    assert.ok(Math.abs(meters(north(0), north(100)) - 100) < 0.5);
    assert.equal(Math.round(meters(north(0), north(0))), 0);
  });
});

describe("pickPlace", () => {
  test("même nom à quelques mètres : c'est le bon lieu", () => {
    const p = place("Garage Dupont", 15);
    assert.equal(pickPlace(garage("Garage Dupont"), [p]), p);
  });
  test("garage nommé : un lieu d'un autre nom n'est jamais retenu, même à 10 m", () => {
    assert.equal(pickPlace(garage("Garage Dupont"), [place("Pneus Lopez", 10)]), null);
  });
  test("de 40 à 150 m : le nom doit concorder ; au-delà de 150 m : jamais", () => {
    assert.ok(pickPlace(garage("Garage Dupont"), [place("Dupont Auto", 60)]));
    assert.ok(pickPlace(garage("Garage Dupont"), [place("Dupont Auto", 140)]));
    assert.equal(pickPlace(garage("Garage Dupont"), [place("Dupont Auto", 170)]), null);
    assert.equal(pickPlace(garage("Garage Dupont"), [place("Autre Nom", 60)]), null);
  });
  test("garage sans nom : seul lieu à moins de 40 m, ou rien", () => {
    const g = garage("Garage (nom non renseigné)");
    const only = place("Garage Quelconque", 20);
    assert.equal(pickPlace(g, [only]), only);
    assert.equal(pickPlace(g, [only, place("Autre", 25)]), null, "deux lieux au même endroit : on ne choisit pas au hasard");
    assert.equal(pickPlace(g, [place("Garage Quelconque", 60)]), null, "au-delà de 40 m, sans nom, rien");
    const at35 = place("Garage Quelconque", 35);
    assert.equal(pickPlace(g, [at35]), at35, "à 35 m : encore le même endroit");
    assert.equal(pickPlace(garage("Spécialiste pneus (sans nom)"), [only]), only);
  });
  test("plusieurs candidats de même nom : le plus proche ; le lieu en double d'un autre nom est écarté", () => {
    const near = place("Dupont Auto", 20);
    const far = place("Dupont Auto Services", 110);
    assert.equal(pickPlace(garage("Garage Dupont"), [far, near]), near);
    const dup = place("Garage APS", 2); // la même entreprise inscrite sous un autre nom, au même endroit
    assert.equal(pickPlace(garage("FAP Automobiles"), [dup, place("FAP Automobiles", 3)]).name, "FAP Automobiles");
  });
  test("rien à rapprocher : null", () => {
    assert.equal(pickPlace(garage("Garage Dupont"), []), null);
    assert.equal(pickPlace(garage("Garage Dupont"), undefined), null);
  });
});

describe("hoursFromPeriods", () => {
  test("lundi-vendredi et samedi : la syntaxe d'OpenStreetMap que la page met déjà en forme", () => {
    assert.equal(hoursFromPeriods([...week(1, 5), ...week(6, 6, "0900", "1200")]), "Mo-Fr 09:00-17:30; Sa 09:00-12:00");
  });
  test("pause de midi : deux plages le même jour, dans l'ordre", () => {
    const p = [...week(1, 5, "1400", "1800"), ...week(1, 5, "0830", "1200")];
    assert.equal(hoursFromPeriods(p), "Mo-Fr 08:30-12:00,14:00-18:00");
  });
  test("dimanche = jour 0, rangé en dernier ; jours consécutifs regroupés à partir de trois, sinon énumérés", () => {
    assert.equal(hoursFromPeriods([...week(0, 0, "1000", "1200"), ...week(1, 2), ...week(4, 4)]), "Mo,Tu,Th 09:00-17:30; Su 10:00-12:00");
    assert.equal(hoursFromPeriods(week(1, 3)), "Mo-We 09:00-17:30");
  });
  test("ouvert tous les jours de 0 h à 24 h : « 24/7 »", () => {
    assert.equal(hoursFromPeriods(week(0, 6, "0000", "2400")), "24/7");
  });
  test("fermeture après minuit (le lendemain) : gardée ; fermeture un autre jour, avant l'ouverture, sans heure de fermeture, heures invalides : ignorées, jamais devinées", () => {
    assert.equal(hoursFromPeriods([{ open: { day: 5, time: "2200" }, close: { day: 6, time: "0200" } }]), "Fr 22:00-02:00");
    assert.equal(hoursFromPeriods([{ open: { day: 1, time: "0900" }, close: { day: 3, time: "1000" } }]), "");
    assert.equal(hoursFromPeriods([{ open: { day: 1, time: "1800" }, close: { day: 1, time: "0900" } }]), "");
    assert.equal(hoursFromPeriods([{ open: { day: 1, time: "0900" } }]), "");
    assert.equal(hoursFromPeriods([{ open: { day: 1, time: "9h" }, close: { day: 1, time: "1700" } }, { open: { day: 7, time: "0900" }, close: { day: 7, time: "1700" } }, { open: { day: 1, time: 900 }, close: { day: 1, time: 1700 } }]), "");
  });
  test("rien d'exploitable : chaîne vide", () => {
    for (const bad of [undefined, null, [], "x", {}, [null, 3, "x"]]) assert.equal(hoursFromPeriods(bad), "");
  });
  test("deux plages identiques ne sont écrites qu'une fois", () => {
    assert.equal(hoursFromPeriods([...week(1, 1), ...week(1, 1)]), "Mo 09:00-17:30");
  });
});

describe("cleanSite", () => {
  test("une adresse http(s) ordinaire est gardée, une page de réseau social aussi", () => {
    assert.equal(cleanSite("https://exemple.test/"), "https://exemple.test/");
    assert.equal(cleanSite("http://www.garage-exemple.fr/contact"), "http://www.garage-exemple.fr/contact");
    assert.equal(cleanSite("https://www.facebook.com/Garage.Exemple/"), "https://www.facebook.com/Garage.Exemple/");
  });
  test("les annuaires et agrégateurs sont écartés, sous-domaines compris", () => {
    for (const bad of ["https://frmap.org/cazres/905394-garage", "https://www.frmap.org/x", "https://www.pagesjaunes.fr/pros/1", "https://fr.mappy.com/x", "https://www.tripadvisor.fr/x"]) assert.equal(cleanSite(bad), "", bad);
    assert.equal(cleanSite("https://notfrmap.org/"), "https://notfrmap.org/", "un autre domaine qui finit pareil n'est pas écarté");
  });
  test("les paramètres de suivi sont retirés, les autres gardés", () => {
    assert.equal(cleanSite("https://exemple.test/a?y_source=1_abc%3D&utm_source=x&fbclid=z&page=2"), "https://exemple.test/a?page=2");
    assert.equal(cleanSite("https://exemple.test/a?y_source=1"), "https://exemple.test/a");
  });
  test("tout ce qui n'est pas une adresse web est refusé : javascript:, data:, mailto:, texte, vide", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "mailto:a@b.test", "garage-exemple.fr", "", "  ", undefined, null, "ftp://exemple.test/"]) assert.equal(cleanSite(bad), "", String(bad));
  });
});

describe("haveOf, missingOf et fieldsFromPlace", () => {
  const full = { phone: "04 72 00 00 01", hours: "Mo-Fr 08:00-18:00", web: "https://exemple.test/" };
  test("ce que le garage a déjà : un numéro reconnu, des horaires, un site", () => {
    assert.deepEqual(haveOf(full), { phone: true, hours: true, web: true });
    assert.deepEqual(haveOf({ phone: "pas un numéro", hours: "", web: "" }), { phone: false, hours: false, web: false });
    assert.deepEqual(haveOf(null), { phone: false, hours: false, web: false });
    assert.equal(missingOf(full), false);
    assert.equal(missingOf({ ...full, hours: "" }), true);
  });
  const p = place("Garage Dupont", 0, { phone: "+33199001234", web: "https://exemple.test/", periods: week(1, 5) });
  test("seuls les champs qui manquent sont remplis", () => {
    assert.deepEqual(fieldsFromPlace(p, { phone: false, hours: false, web: false }), { phone: "+33199001234", hours: "Mo-Fr 09:00-17:30", web: "https://exemple.test/" });
    assert.deepEqual(fieldsFromPlace(p, { phone: true, hours: false, web: true }), { hours: "Mo-Fr 09:00-17:30" });
    assert.deepEqual(fieldsFromPlace(p, { phone: true, hours: true, web: true }), {});
    assert.deepEqual(fieldsFromPlace(null, { phone: false, hours: false, web: false }), {});
  });
  test("un numéro qui n'est pas un numéro, un site refusé, des horaires illisibles : rien d'ajouté", () => {
    const bad = place("Garage Dupont", 0, { phone: "voir site", web: "https://frmap.org/x", periods: [{ open: { day: 1, time: "9h" } }] });
    assert.deepEqual(fieldsFromPlace(bad, { phone: false, hours: false, web: false }), {});
  });
});

describe("createEnricher", () => {
  const body = (places) => ({ features: places.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { name: p.name, mapbox_id: p.id, metadata: { phone: p.phone, website: p.web, open_hours: { periods: p.periods } } } })) });
  const answer = (places, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body(places) });
  const here = place("Garage Dupont", 10, { phone: "+33199001234", periods: week(1, 5) });
  const seen = (fn) => {
    const urls = [];
    return { urls, fetchImpl: async (u, o) => (urls.push(String(u)), fn(u, o)) };
  };

  test("renvoie les champs à ajouter et le lieu retenu ; la requête porte le jeton", async () => {
    const f = seen(answer([here]));
    const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl });
    const r = await e.lookup(garage("Garage Dupont"));
    assert.deepEqual(r.fields, { phone: "+33199001234", hours: "Mo-Fr 09:00-17:30" });
    assert.equal(r.place.name, "Garage Dupont");
    assert.equal(f.urls.length, 1);
    assert.equal(new URL(f.urls[0]).searchParams.get("access_token"), TOKEN);
    assert.equal(e.requests, 1);
  });
  test("pas de lieu sûr : { fields: {}, place: null }, la requête a bien eu lieu", async () => {
    const e = createEnricher({ token: TOKEN, fetchImpl: answer([place("Pneus Lopez", 5, { phone: "+33199001234" })]) });
    assert.deepEqual(await e.lookup(garage("Garage Dupont")), { fields: {}, place: null });
  });
  test("ne remplit que ce qui manque : un garage qui a un téléphone le garde", async () => {
    const e = createEnricher({ token: TOKEN, fetchImpl: answer([here]) });
    const r = await e.lookup(garage("Garage Dupont", 0, { phone: "04 72 00 00 01" }));
    assert.deepEqual(r.fields, { hours: "Mo-Fr 09:00-17:30" });
  });
  test("une réponse est gardée pour la visite : la même position ne refait pas la requête (même en parallèle)", async () => {
    const f = seen(answer([here]));
    const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl });
    await Promise.all([e.lookup(garage("Garage Dupont")), e.lookup(garage("Garage Dupont"))]);
    await e.lookup(garage("Garage Dupont"));
    assert.equal(f.urls.length, 1);
  });
  test("plafond par visite : au-delà, aucune requête et null ; les réponses déjà obtenues servent encore", async () => {
    const f = seen(answer([here]));
    const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl, cap: 2 });
    const at = (m) => ({ name: "Garage Dupont", lat: LAT + m / 111320, lon: LON + m / 80000 });
    assert.ok(await e.lookup(at(0)));
    assert.ok(await e.lookup(at(1000)));
    assert.equal(await e.lookup(at(2000)), null);
    assert.equal(f.urls.length, 2);
    assert.ok(await e.lookup(at(0)), "déjà en mémoire");
    assert.equal(f.urls.length, 2);
  });
  test("les réglages : 40 requêtes par visite, zone de 150 m, « même endroit » à 40 m", () => {
    assert.equal(CAP, 40);
    assert.equal(NEAR_M, 150);
    assert.equal(SAME_SPOT_M, 40);
  });
  test("jeton refusé (401, 403) : on s'arrête net, aucune autre requête, jamais", async () => {
    for (const status of [401, 403]) {
      const f = seen(answer([], status));
      const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl });
      assert.equal(await e.lookup(garage("Garage Dupont", 0)), null);
      assert.equal(e.refused, true);
      assert.equal(await e.lookup({ name: "Autre", lat: LAT + 0.01, lon: LON }), null);
      assert.equal(f.urls.length, 1, `HTTP ${status} : une seule requête`);
    }
  });
  test("deux échecs de suite (réseau, 429, 500) : pause d'une minute, puis on reprend ; un échec n'est jamais mémorisé", async () => {
    let t = 1_000;
    let fail = true;
    const f = seen(async () => {
      if (fail) throw new Error("réseau");
      return { ok: true, status: 200, json: async () => body([here]) };
    });
    const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl, now: () => t });
    const g1 = { name: "Garage Dupont", lat: LAT, lon: LON };
    const g2 = { name: "Garage Dupont", lat: LAT + 0.01, lon: LON };
    assert.equal(await e.lookup(g1), null);
    assert.equal(await e.lookup(g2), null); // deuxième échec : pause
    assert.equal(f.urls.length, 2);
    assert.equal(await e.lookup(g1), null, "en pause : pas de requête");
    t += 30_000;
    assert.equal(await e.lookup(g1), null, "trente secondes plus tard, toujours en pause");
    assert.equal(f.urls.length, 2);
    t += 31_000;
    fail = false;
    assert.ok(await e.lookup(g1), "la pause est finie, et l'échec d'avant n'était pas mémorisé");
    assert.equal(f.urls.length, 3);
  });
  test("une réponse qui n'est pas du JSON ou une erreur serveur donne null", async () => {
    assert.equal(await createEnricher({ token: TOKEN, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("pas du JSON"); } }) }).lookup(garage("Garage Dupont")), null);
    assert.equal(await createEnricher({ token: TOKEN, fetchImpl: answer([here], 500) }).lookup(garage("Garage Dupont")), null);
  });
  test("une requête qui ne répond pas est abandonnée au bout du délai", { timeout: 3000 }, async () => {
    const e = createEnricher({ token: TOKEN, timeoutMs: 30, fetchImpl: (u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abandon")))) });
    assert.equal(await e.lookup(garage("Garage Dupont")), null);
  });
  test("un garage sans position exploitable ne déclenche aucune requête", async () => {
    const f = seen(answer([here]));
    const e = createEnricher({ token: TOKEN, fetchImpl: f.fetchImpl });
    for (const bad of [null, undefined, {}, { lat: NaN, lon: 1 }, { lat: 1 }]) assert.equal(await e.lookup(bad), null);
    assert.equal(f.urls.length, 0);
  });
  test("rien n'est écrit sur le disque : le module n'utilise ni localStorage, ni sessionStorage, ni IndexedDB", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../src/js/modules/mapbox-fiches.js", import.meta.url), "utf8"));
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\.|document\.cookie/.test(src.replace(/\/\/.*$/gm, "")));
  });
});
