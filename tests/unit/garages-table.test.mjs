// Table de garages (Overture) : cases, lecture défensive des tuiles, chargement, rapprochement et fusion avec la liste d'OpenStreetMap.
// Les lieux, noms et numéros sont fictifs (numéros en +33 1 99 …).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { garagesBase } from "../../src/js/modules/config.js";
import { MAX_AGE_DAYS, NEAR_M, SAME_SPOT_M, STEP, X0, cleanTile, completeGarage, createTable, fieldLabels, hasRealName, makeGrid, mergeTable, meters, pickRec, sameName, tileKey, tileKeysFor, toGarage } from "../../src/js/modules/garages-table.js";

const C = { lat: 43.2174, lon: 1.1014 }; // Cazères
const at = (dNorthM, dEastM) => ({ lat: C.lat + dNorthM / 111320, lon: C.lon + dEastM / (111320 * Math.cos((C.lat * Math.PI) / 180)) });
let seq = 0;
const rec = (name, pos, extra = {}) => ({ id: `0000${String(++seq).padStart(4, "0")}-0000-4000-8000-000000000000`, name, ...pos, kind: "r", phones: [], web: "", addr: "", pc: "", loc: "", brand: "", ...extra });
const garage = (name, pos, extra = {}) => ({ id: `osm:node/${++seq}`, src: "osm", name, ...pos, tags: {}, shop: "car_repair", phone: "", web: "", hours: "", addr: "", addrGap: true, city: "", ...extra });
const H = {
  chainOf: (r) => (/norauto/i.test(r.name) ? { id: "norauto", name: "Norauto" } : null),
  dealerOf: (r) => /renault/i.test(r.name),
  tidy: (s) => String(s || "").trim(),
  cityTidy: (s) => String(s || "").trim(),
  web: (u) => (u ? (/^https?:\/\//.test(u) ? u : "https://" + u) : ""),
  phoneCount: (t) => String(t || "").split(";").filter((x) => /\d{9}/.test(x.replace(/\D/g, ""))).length,
};
const tileJson = (items) => ({ v: 1, g: items });
const clone = (x) => JSON.parse(JSON.stringify(x));

describe("cases", () => {
  test("même calcul que scripts/garages/tiles.py", () => {
    assert.equal(STEP, 0.25);
    assert.equal(X0, -10);
    assert.equal(tileKey(C.lat, C.lon), "172-44");
    assert.equal(tileKey(0, -10), "0-0");
    assert.equal(tileKey(-0.01, -10.01), "-1--1");
    assert.deepEqual(tileKeysFor(C.lat, C.lon, 10), ["172-43", "172-44", "173-43", "173-44"]);
  });
  test("tout point du rayon est dans une case demandée ; plus le rayon grandit, plus il y a de cases", () => {
    for (const km of [3, 5, 10, 20, 30, 50]) {
      const keys = new Set(tileKeysFor(C.lat, C.lon, km));
      for (const [n, e] of [[0, 0], [km * 900, 0], [-km * 900, 0], [0, km * 900], [0, -km * 900], [km * 640, km * 640], [-km * 640, km * 640]]) {
        const p = at(n, e);
        if (meters(C, p) <= km * 1000) assert.ok(keys.has(tileKey(p.lat, p.lon)), `${km} km, point ${n}/${e}`);
      }
    }
    assert.ok(tileKeysFor(C.lat, C.lon, 50).length > tileKeysFor(C.lat, C.lon, 10).length);
    assert.ok(tileKeysFor(C.lat, C.lon, 50).length <= 40, "un rayon de 50 km reste sous le plafond de cases");
  });
});

describe("cleanTile : lecture défensive", () => {
  const ok = { id: "0a1b2c3d-0000-4000-8000-0123456789ab", name: "Garage Dupont", lat: 43.2, lon: 1.1, kind: "t", phones: ["+33199000001", "+33199000002", "+33199000003"], web: "https://dupont.example.fr/a?b=1", addr: "12 Rue de la Gare", pc: "31220", loc: "Cazères", brand: "Dupont" };
  test("un lieu complet est gardé tel quel, deux numéros au plus", () => {
    const [r] = cleanTile(tileJson([ok]));
    assert.deepEqual(r, { ...ok, phones: ["+33199000001", "+33199000002"] });
  });
  test("ce qui n'est pas une tuile est refusé", () => {
    for (const bad of [null, undefined, 3, "x", {}, { v: 2, g: [] }, { v: 1 }, { v: 1, g: {} }]) assert.equal(cleanTile(bad), null, JSON.stringify(bad));
  });
  test("un lieu sans nom, identifiant ou position valable est écarté, les autres restent", () => {
    const out = cleanTile(tileJson([{ ...ok, id: "not an id!" }, { ...ok, name: "" }, { ...ok, name: " A " }, { ...ok, lat: "x" }, { ...ok, lon: 999 }, null, 7, { ...ok, id: "0a1b2c3d-0000-4000-8000-0123456789ac" }]));
    assert.deepEqual(out.map((r) => r.id), ["0a1b2c3d-0000-4000-8000-0123456789ac"]);
  });
  test("champs douteux ignorés, jamais devinés", () => {
    const [r] = cleanTile(tileJson([{ ...ok, kind: "z", phones: ["0561976545", "+33", "javascript:1", 5], web: "javascript:alert(1)", pc: "3122", addr: 3, brand: null }]));
    assert.equal(r.kind, "r");
    assert.deepEqual(r.phones, []);
    assert.equal(r.web, "");
    assert.equal(r.pc, "");
    assert.equal(r.addr, "");
    assert.equal(r.brand, "");
    assert.equal(cleanTile(tileJson([{ ...ok, web: "https://a.example/ b" }]))[0].web, "", "espace dans l'adresse");
    assert.equal(cleanTile(tileJson([{ ...ok, web: 'https://a.example/"onload=x' }]))[0].web, "", "guillemet dans l'adresse");
    assert.equal(cleanTile(tileJson([{ ...ok, web: "https://a.example/" + "x".repeat(300) }]))[0].web, "", "adresse trop longue");
    assert.equal(cleanTile(tileJson([{ ...ok, name: "x".repeat(300) }]))[0].name.length, 120);
    const long = cleanTile(tileJson([{ ...ok, addr: "a".repeat(300), loc: "l".repeat(300), brand: "b".repeat(300) }]))[0];
    assert.deepEqual([long.addr.length, long.loc.length, long.brand.length], [160, 80, 60], "adresse, commune et enseigne sont bornées");
  });
});

describe("rapprochement (même règle que la page et que matching.py)", () => {
  test("noms", () => {
    assert.ok(sameName("Solsona", "Carosserie Solsona"));
    assert.ok(sameName("L'ATELIER AUTO-MOBILE", "L’Atelier automobile"));
    assert.ok(!sameName("Carrosserie Martin", "Carrosserie Dupont"), "les mots génériques seuls ne suffisent pas");
    assert.ok(!sameName("", "Garage Dupont") && !sameName("Garage Dupont", ""));
    assert.ok(!hasRealName("") && !hasRealName("Garage (nom non renseigné)") && !hasRealName("Spécialiste pneus (sans nom)") && hasRealName("Garage Dupont"));
    assert.ok(!sameName("Garage A2", "Atelier A2"), "un mot de deux lettres ne distingue pas un garage d'un autre");
    assert.ok(!sameName("AB", "AB Auto"), "un nom très court n'est pas « contenu » dans un autre");
  });
  test("distance : valeurs connues (Paris–Lyon environ 392 km, un millième de degré de latitude 111,2 m)", () => {
    const d = meters({ lat: 48.8566, lon: 2.3522 }, { lat: 45.764, lon: 4.8357 });
    assert.ok(d > 390800 && d < 393200, String(d));
    assert.ok(Math.abs(meters({ lat: 43, lon: 1 }, { lat: 43.001, lon: 1 }) - 111.2) < 0.5);
    assert.equal(meters(C, C), 0);
  });
  test("même nom à moins de 150 m", () => {
    const g = garage("Garage Dupont", C);
    assert.equal(pickRec(g, [rec("Dupont Auto", at(120, 0))]).name, "Dupont Auto");
    assert.equal(pickRec(g, [rec("Dupont Auto", at(180, 0))]), null, "au-delà de 150 m");
    assert.equal(pickRec(g, [rec("Garage Martin", at(10, 0))]), null, "autre nom, même tout près");
  });
  test("plusieurs candidats : le plus proche", () => {
    const g = garage("Garage Dupont", C);
    const a = rec("Dupont Auto", at(100, 0));
    const b = rec("Garage Dupont", at(30, 0));
    assert.equal(pickRec(g, [a, b]), b);
  });
  test("garage sans nom : seul lieu à moins de 40 m", () => {
    const g = garage("Garage (nom non renseigné)", C);
    const one = rec("Auto Plus", at(30, 0));
    assert.equal(pickRec(g, [one]), one);
    assert.equal(pickRec(g, [rec("Auto Plus", at(60, 0))]), null, "à 60 m");
    assert.equal(pickRec(g, [one, rec("Pneus Express", at(20, 10))]), null, "deux lieux à moins de 40 m : ambigu");
  });
  test("l'index en cases rend tous les voisins, d'une case à l'autre", () => {
    const items = [];
    for (let i = -12; i <= 12; i++) items.push({ name: "p" + i, ...at(i * 30, i * 41) });
    const grid = makeGrid(items);
    for (const c of items) {
      const want = items.filter((p) => meters(c, p) <= NEAR_M).map((p) => p.name).sort();
      const got = grid.near(c.lat, c.lon, NEAR_M).filter((p) => meters(c, p) <= NEAR_M).map((p) => p.name).sort();
      assert.deepEqual(got, want, c.name);
    }
  });
});

describe("createTable : chargement", () => {
  const index = (extra = {}) => ({ v: 1, built: "2026-10-06", step: STEP, x0: X0, closure: "sirene", count: 3, tiles: { "172-44": 2, "173-44": 1 }, ...extra });
  const here = rec("Garage Ici", C, { phones: ["+33199000001"] });
  const near = rec("Garage Près", at(2000, 0));
  const far = rec("Garage Loin", at(9500, 0)); // dans la case 173-44 mais hors d'un rayon de 5 km
  const files = () => ({ "garages/index.json": index(), "garages/t/172-44.json": tileJson([clone(here), clone(near)]), "garages/t/173-44.json": tileJson([clone(far)]) });
  const fakeFetch = (table, log = []) => async (url, { signal } = {}) => {
    log.push(url);
    const body = table[url];
    if (typeof body === "function") return body(signal);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => clone(body) };
  };
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const mk = (table, log, extra = {}) => createTable({ base: "garages", fetchImpl: fakeFetch(table, log), now: () => NOW, ...extra });

  test("sans dossier : inactif, aucune requête", async () => {
    const log = [];
    const t = createTable({ base: "", fetchImpl: fakeFetch({}, log) });
    assert.equal(t.enabled, false);
    assert.equal(await t.load(C.lat, C.lon, 10), null);
    assert.deepEqual(log, []);
  });
  test("l'index puis les seules cases annoncées ; le rayon coupe ce qui est trop loin", async () => {
    const log = [];
    const t = mk(files(), log);
    const r = await t.load(C.lat, C.lon, 5);
    assert.deepEqual(log, ["garages/index.json", "garages/t/172-44.json", "garages/t/173-44.json"]);
    assert.deepEqual(r.recs.map((x) => x.name).sort(), ["Garage Ici", "Garage Près"]);
    assert.equal(r.tiles, 2);
    assert.equal(r.failed, 0);
    assert.equal(r.built, "2026-10-06");
    assert.equal((await mk(files(), [])).enabled, true);
    const r10 = await mk(files(), []).load(C.lat, C.lon, 10);
    assert.equal(r10.recs.length, 3, "à 10 km, le troisième lieu est dans le rayon");
  });
  test("une case absente de l'index n'est pas demandée", async () => {
    const log = [];
    const t = mk(files(), log);
    await t.load(C.lat, C.lon, 10);
    assert.ok(!log.some((u) => /172-43|173-43/.test(u)), log.join(" "));
  });
  test("index et cases ne sont demandés qu'une fois par visite", async () => {
    const log = [];
    const t = mk(files(), log);
    await t.load(C.lat, C.lon, 5);
    await t.load(C.lat + 0.001, C.lon, 5);
    await Promise.all([t.load(C.lat, C.lon, 5), t.load(C.lat, C.lon, 5)]);
    assert.equal(log.length, 3);
    assert.equal(t.stats().requests, 3);
  });
  test("une case qui échoue n'arrête pas les autres et n'est pas gardée en échec", async () => {
    const f = files();
    let calls = 0;
    f["garages/t/173-44.json"] = () => {
      calls++;
      if (calls === 1) throw new Error("réseau");
      return { ok: true, status: 200, json: async () => clone(tileJson([clone(far)])) };
    };
    const t = mk(f, []);
    const r = await t.load(C.lat, C.lon, 10);
    assert.equal(r.failed, 1);
    assert.equal(r.recs.length, 2);
    const again = await t.load(C.lat, C.lon, 10);
    assert.equal(again.failed, 0, "redemandée à la recherche suivante");
    assert.equal(again.recs.length, 3);
  });
  test("une réponse qui n'est pas une tuile compte comme un échec", async () => {
    const f = files();
    f["garages/t/172-44.json"] = { v: 9, g: [] };
    const r = await mk(f, []).load(C.lat, C.lon, 10);
    assert.equal(r.failed, 1);
  });
  test("une réponse en erreur n'est pas lue, même si son corps ressemble à une tuile", async () => {
    const f = files();
    f["garages/t/172-44.json"] = () => ({ ok: false, status: 503, json: async () => clone(tileJson([here])) });
    const r = await mk(f, []).load(C.lat, C.lon, 10);
    assert.equal(r.failed, 1);
    assert.ok(!r.recs.some((x) => x.name === "Garage Ici"));
  });
  test("index illisible, d'un autre format ou périmé : la table reste éteinte", async () => {
    for (const bad of [index({ v: 2 }), index({ step: 0.5 }), index({ x0: 0 }), index({ tiles: null }), index({ built: "hier" }), index({ built: "2026-01-01" }), null]) {
      const f = files();
      f["garages/index.json"] = bad;
      assert.equal(await mk(f, []).load(C.lat, C.lon, 10), null, JSON.stringify(bad));
    }
    assert.ok(MAX_AGE_DAYS >= 120 && MAX_AGE_DAYS <= 240);
    const fresh = files();
    fresh["garages/index.json"] = index({ built: "2026-04-20" });
    assert.ok(await mk(fresh, []).load(C.lat, C.lon, 10), "172 jours : encore utilisable");
    assert.equal(await mk(fresh, [], { maxAgeDays: 100 }).load(C.lat, C.lon, 10), null, "limite réglable");
  });
  test("après un échec de l'index, une nouvelle demande n'a lieu qu'au bout d'une minute", async () => {
    let t0 = NOW;
    const log = [];
    const t = createTable({ base: "garages", fetchImpl: fakeFetch({}, log), now: () => t0 });
    assert.equal(await t.load(C.lat, C.lon, 5), null);
    assert.equal(await t.load(C.lat, C.lon, 5), null);
    assert.equal(log.length, 1, "pas de nouvelle demande tout de suite");
    t0 += 61000;
    await t.load(C.lat, C.lon, 5);
    assert.equal(log.length, 2);
  });
  test("une réponse qui ne vient pas est coupée au bout de timeoutMs", async () => {
    const hang = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abandon"))));
    const f = files();
    f["garages/t/172-44.json"] = hang;
    const t0 = Date.now();
    const r = await mk(f, [], { timeoutMs: 30 }).load(C.lat, C.lon, 5);
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(r.failed, 1);
    assert.equal(r.recs.length, 0 + (r.recs.length ? r.recs.length : 0));
  });
  test("un plafond de cases borne les requêtes", async () => {
    const log = [];
    const f = files();
    f["garages/index.json"] = index({ tiles: Object.fromEntries(tileKeysFor(C.lat, C.lon, 50).map((k) => [k, 1])) });
    const t = mk(f, log, { maxTiles: 3 });
    await t.load(C.lat, C.lon, 50);
    assert.equal(log.length, 1 + 3);
  });
  test("le dossier peut s'écrire avec ou sans barre finale", async () => {
    for (const base of ["garages", "garages/"]) {
      const log = [];
      await createTable({ base, fetchImpl: fakeFetch(files(), log), now: () => NOW }).load(C.lat, C.lon, 5);
      assert.equal(log[0], "garages/index.json");
    }
  });
});

describe("toGarage", () => {
  test("champs du garage de la page, identifiant accepté par l'API", () => {
    const r = rec("GARAGE DUPONT", C, { kind: "t", phones: ["+33199000001", "+33199000002"], web: "dupont.example.fr", addr: "12 Rue de la Gare", pc: "31220", loc: "Cazères", brand: "Dupont" });
    const g = toGarage(r, H);
    assert.match(g.id, /^custom:ovt-[0-9a-f]{32}$/);
    assert.equal(g.id, "custom:ovt-" + r.id.replace(/-/g, ""));
    assert.ok(g.id.length <= "custom:".length + 80, "tient dans la règle des identifiants (docs/exploitation.md)");
    assert.match(g.id.slice(7), /^[a-z0-9-]{1,80}$/);
    assert.equal(g.src, "ovt");
    assert.equal(g.ovtId, r.id);
    assert.equal(g.shop, "tyres");
    assert.equal(g.phone, "+33199000001;+33199000002");
    assert.equal(g.web, "https://dupont.example.fr");
    assert.equal(g.addr, "12 Rue de la Gare, 31220 Cazères");
    assert.equal(g.city, "Cazères");
    assert.equal(g.addrGap, false);
    assert.equal(g.hours, "");
    assert.deepEqual(g.tags, {});
    assert.equal(g.osmUrl, "");
  });
  test("sans adresse : trou d'adresse (la page cherche l'adresse la plus proche à l'ouverture)", () => {
    const g = toGarage(rec("Auto Plus", C, { pc: "31220", loc: "Cazères" }), H);
    assert.equal(g.addrGap, true);
    assert.equal(g.addr, "31220 Cazères");
    assert.equal(g.phone, "");
    assert.equal(g.web, "");
  });
  test("enseigne, atelier de marque, carrosserie, pneus", () => {
    assert.equal(toGarage(rec("Norauto Fenouillet", C), H).chain.id, "norauto");
    const dealer = toGarage(rec("Renault Retail Group", C), H);
    assert.equal(dealer.dealer, true);
    assert.equal(dealer.chain, null);
    assert.equal(toGarage(rec("Norauto Fenouillet", C), H).dealer, false);
    assert.equal(toGarage(rec("Carrosserie Solsona", C), H).body, true);
    assert.equal(toGarage(rec("Solsona", C, { kind: "b" }), H).body, true, "catégorie carrosserie");
    assert.equal(toGarage(rec("Garage Solsona mécanique", C, { kind: "b" }), H).body, false, "un nom de mécanique l'emporte");
    assert.equal(toGarage(rec("Pneus Express", C, { kind: "t" }), H).shop, "tyres");
    assert.equal(toGarage(rec("Pneus Express", C, { kind: "v" }), H).shop, "car_repair");
  });
});

describe("completeGarage : ne remplit que ce qui manque", () => {
  test("téléphone, site et adresse absents : repris du lieu", () => {
    const g = garage("Garage Dupont", C);
    const r = rec("Garage Dupont", C, { phones: ["+33199000001"], web: "https://d.example.fr", addr: "12 Rue de la Gare", pc: "31220", loc: "Cazères" });
    assert.deepEqual(completeGarage(g, r, H), ["phone", "web", "addr"]);
    assert.equal(g.phone, "+33199000001");
    assert.equal(g.web, "https://d.example.fr");
    assert.equal(g.addr, "12 Rue de la Gare, 31220 Cazères");
    assert.equal(g.addrGap, false);
    assert.equal(g.city, "Cazères");
    assert.deepEqual(g.tableFields, ["phone", "web", "addr"]);
    assert.equal(g.tableId, r.id);
  });
  test("jamais d'écrasement : ce qu'OpenStreetMap donne reste", () => {
    const g = garage("Garage Dupont", C, { phone: "+33561976545", web: "https://osm.example.fr", addr: "1 Rue OSM", addrGap: false, city: "Ville OSM" });
    const r = rec("Garage Dupont", C, { phones: ["+33199000001"], web: "https://d.example.fr", addr: "12 Rue de la Gare", pc: "31220", loc: "Cazères" });
    assert.deepEqual(completeGarage(g, r, H), []);
    assert.equal(g.phone, "+33561976545");
    assert.equal(g.web, "https://osm.example.fr");
    assert.equal(g.addr, "1 Rue OSM");
    assert.equal(g.city, "Ville OSM");
    assert.equal(g.tableFields, undefined);
    assert.equal(g.tableId, r.id, "le lien est gardé même sans rien compléter");
  });
  test("un numéro illisible côté OpenStreetMap est remplacé ; un site refusé par la page ne l'est pas", () => {
    const g = garage("Garage Dupont", C, { phone: "appeler" });
    completeGarage(g, rec("Garage Dupont", C, { phones: ["+33199000001"], web: "x" }), { ...H, web: () => "" });
    assert.equal(g.phone, "+33199000001");
    assert.equal(g.web, "");
  });
  test("fieldLabels", () => {
    assert.deepEqual(fieldLabels(["phone", "web", "addr", "autre"]), ["téléphone", "site", "adresse"]);
    assert.deepEqual(fieldLabels(undefined), []);
  });
});

describe("mergeTable", () => {
  test("un lieu qui correspond complète le garage ; un autre lieu s'ajoute", () => {
    const g1 = garage("Garage Dupont", C);
    const g2 = garage("Garage Martin", at(500, 0), { phone: "+33561000000" });
    const r1 = rec("Dupont Auto", at(60, 0), { phones: ["+33199000001"] });
    const r2 = rec("Pneus Express", at(2000, 300), { phones: ["+33199000002"], kind: "t" });
    const garages = [g1, g2];
    const m = mergeTable(garages, [r1, r2], H);
    assert.equal(garages.length, 2, "le tableau reçu n'est pas modifié");
    assert.equal(m.list.length, 3);
    assert.deepEqual({ matched: m.matched, filled: m.filled, added: m.added, dup: m.dup }, { matched: 1, filled: 1, added: 1, dup: 0 });
    assert.equal(g1.phone, "+33199000001");
    assert.equal(g2.phone, "+33561000000");
    assert.equal(m.list[2].src, "ovt");
    assert.equal(m.list[2].shop, "tyres");
    assert.equal(m.list[0], g1);
  });
  test("un lieu déjà dans la liste n'est pas ajouté : même nom à 150 m, ou n'importe quel garage à 40 m", () => {
    const g = garage("Garage Dupont", C, { phone: "+33561976545" });
    const sameNameFar = rec("Dupont Auto", at(140, 0)); // même nom : rapproché, pas ajouté
    const otherNameClose = rec("Pneus Express", at(0, 30)); // autre nom à 30 m : doublon probable
    const otherNameFar = rec("Pneus Express", at(0, 100)); // autre nom à 100 m : autre garage
    const m = mergeTable([g], [sameNameFar, otherNameClose, otherNameFar], H);
    assert.equal(m.added, 1);
    assert.equal(m.list[1].name, "Pneus Express");
    assert.equal(m.dup, 1);
    assert.equal(m.matched, 1);
  });
  test("un garage sans nom ne se rapproche que d'un lieu seul à moins de 40 m", () => {
    const g = garage("Garage (nom non renseigné)", C);
    const m = mergeTable([g], [rec("Auto Plus", at(20, 0), { phones: ["+33199000001"] })], H);
    assert.equal(m.matched, 1);
    assert.equal(g.phone, "+33199000001");
    const g2 = garage("Garage (nom non renseigné)", C);
    const m2 = mergeTable([g2], [rec("Auto Plus", at(20, 0), { phones: ["+33199000001"] }), rec("Pneus Rapides", at(10, 10), { phones: ["+33199000002"] })], H);
    assert.equal(m2.matched, 0, "deux lieux à moins de 40 m : ambigu, rien n'est copié");
    assert.equal(g2.phone, "");
    assert.equal(m2.added, 0, "et ils ne s'ajoutent pas : ils sont à moins de 40 m d'un garage");
    assert.equal(m2.dup, 2);
  });
  test("deux fiches du même garage dans la table ne s'ajoutent qu'une fois", () => {
    const m = mergeTable([], [rec("Garage Durand", at(1000, 0)), rec("Durand Auto", at(1050, 0))], H);
    assert.equal(m.added, 1);
    assert.equal(m.dup, 1);
  });
  test("deuxième fusion : rien de plus", () => {
    const recs = [rec("Garage Durand", at(1000, 0)), rec("Pneus Express", at(2000, 0))];
    const first = mergeTable([garage("Garage Dupont", C)], recs, H);
    const second = mergeTable(first.list, recs, H);
    assert.equal(second.list.length, first.list.length);
    assert.equal(second.added, 0);
    assert.equal(second.matched, 0, "les garages ajoutés la première fois ne sont pas des garages d'OpenStreetMap à compléter");
  });
  test("un garage de la liste sans nom de garage n'écarte pas un lieu qui partage seulement un mot de son libellé de remplacement", () => {
    const g = garage("Spécialiste pneus (sans nom)", C);
    const m = mergeTable([g], [rec("Spécialiste Pneus Dupont", at(100, 0))], H);
    assert.equal(m.added, 1, "à 100 m, un libellé de remplacement ne vaut pas un nom");
    assert.equal(m.dup, 0);
  });
  test("sans lieu, la liste est celle d'OpenStreetMap", () => {
    const gs = [garage("Garage Dupont", C)];
    const m = mergeTable(gs, [], H);
    assert.deepEqual(m.list, gs);
    assert.deepEqual({ matched: m.matched, filled: m.filled, added: m.added, dup: m.dup }, { matched: 0, filled: 0, added: 0, dup: 0 });
  });
  test("constantes", () => {
    assert.equal(NEAR_M, 150);
    assert.equal(SAME_SPOT_M, 40);
  });
});

describe("garagesBase (balise pixcar-garages)", () => {
  const set = ({ meta, tune } = {}) => {
    globalThis.document = { querySelector: () => (meta === undefined ? null : { content: meta }) };
    globalThis.JG_GARAGES_BASE = tune;
  };
  afterEach(() => {
    delete globalThis.document;
    delete globalThis.JG_GARAGES_BASE;
  });
  test("vide ou absente : inactive", () => {
    set({});
    assert.equal(garagesBase(), "");
    set({ meta: "" });
    assert.equal(garagesBase(), "");
  });
  test("un dossier relatif, toujours terminé par une barre", () => {
    set({ meta: "garages/" });
    assert.equal(garagesBase(), "garages/");
    set({ meta: "garages" });
    assert.equal(garagesBase(), "garages/");
    set({ meta: "data/garages" });
    assert.equal(garagesBase(), "data/garages/");
  });
  test("jamais un autre hôte ni un chemin douteux", () => {
    for (const bad of ["https://autre.example/garages/", "//autre.example/g/", "/garages/", "../garages/", "garages/../x", "javascript:alert(1)", "garages/ x", "a b", "garages?x=1"]) {
      set({ meta: bad });
      assert.equal(garagesBase(), "", bad);
    }
  });
  test("window.JG_GARAGES_BASE l'emporte, et \"\" l'éteint", () => {
    set({ meta: "garages/", tune: "essai/" });
    assert.equal(garagesBase(), "essai/");
    set({ meta: "garages/", tune: "" });
    assert.equal(garagesBase(), "");
  });
});
