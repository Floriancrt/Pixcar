// Table de garages : les lieux d'Overture Maps (Meta, Foursquare…) que scripts/garages/build.py range en tuiles statiques, chargés à côté d'OpenStreetMap.
//
// Ce que la page en fait : les tuiles qui touchent la zone cherchée sont lues (un fichier JSON par case de 0,25°, servi par le site lui-même : aucun
// service tiers, aucune donnée de l'utilisateur ne part), puis rapprochées de la liste d'OpenStreetMap avec la règle déjà utilisée pour le registre :
//   · un lieu qui correspond à un garage d'OpenStreetMap (même nom ET moins de 150 m ; garage sans nom : seul lieu à moins de 40 m) lui apporte ce qui lui
//     manque (téléphone, site, adresse), jamais l'inverse : les champs d'OpenStreetMap ne sont jamais écrasés ;
//   · un lieu qui ne correspond à rien (et n'est pas à moins de 40 m d'un garage, sauf commerces distincts : twoShops) s'ajoute à la liste, avec la
//     mention « Overture » ;
//   · si OpenStreetMap ne répond pas, la liste est celle de la table.
// Un mauvais rapprochement vaut pire qu'aucun : un numéro de téléphone qui n'est pas celui du garage fait perdre du temps à un client. Le même
// rapprochement est écrit en Python dans scripts/garages/matching.py (retrait des doublons à la construction) ; scripts/garages/diff_js.mjs compare les deux.
//
// Rien n'est conservé par la page (ni disque, ni cookie) hors le cache HTTP du navigateur. Sans données publiées (pas de balise pixcar-garages) : inactif.

export const STEP = 0.25; // degrés : taille d'une case (même valeur dans scripts/garages/tiles.py)
export const X0 = -10; // origine des longitudes
export const NEAR_M = 150; // un lieu et un garage plus proches que ça, de même nom, sont le même garage
export const SAME_SPOT_M = 40; // en deçà : le nom peut manquer ou différer, pas ailleurs
export const MAX_TILES = 40; // cases lues pour une recherche (un rayon de 50 km en demande une trentaine)
export const MAX_AGE_DAYS = 180; // une table plus vieille que ça n'est plus utilisée (la construction mensuelle s'est arrêtée)
const KINDS = "rtbv";

// ---------------------------------------------------------------------------------------------------------------------------------- cases
export const tileKey = (lat, lon) => `${Math.floor(lat / STEP)}-${Math.floor((lon - X0) / STEP)}`;
// Cases touchées par le carré de ±km autour du point.
export function tileKeysFor(lat, lon, km) {
  const dLat = km / 111.2;
  const dLon = km / (111.2 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const y0 = Math.floor((lat - dLat) / STEP);
  const y1 = Math.floor((lat + dLat) / STEP);
  const x0 = Math.floor((lon - dLon - X0) / STEP);
  const x1 = Math.floor((lon + dLon - X0) / STEP);
  const keys = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(`${y}-${x}`);
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------------------------- rapprochement
const rad = (d) => (d * Math.PI) / 180;
export function meters(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}
export const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Mots qui ne distinguent pas un garage d'un autre : deux « Carrosserie … » n'en font pas le même garage.
const GENERIC = new Set(["garage", "garages", "auto", "autos", "automobile", "automobiles", "sarl", "eurl", "sas", "sasu", "ets", "centre", "station", "service", "services", "reparation", "mecanique", "atelier", "societe", "entreprise", "carrosserie", "carosserie", "pneu", "pneus", "tires", "controle", "technique", "peinture", "depannage", "vitrage", "pieces", "accessoires", "multimarque", "multimarques", "express", "les", "des", "du", "de", "la", "le", "et", "and", "pro"]);
const tokens = (s) => new Set(fold(s).replace(/['’`-]/g, " ").split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
const compact = (s) => fold(s).replace(/[^a-z0-9]+/g, "");
// Même nom : un mot distinctif en commun (« Solsona » / « Carosserie Solsona »), ou un nom contenu dans l'autre une fois espaces et ponctuation retirés
// (« L'ATELIER AUTO-MOBILE » / « L’Atelier automobile »).
export function sameName(a, b) {
  const B = tokens(b);
  for (const t of tokens(a)) if (B.has(t)) return true;
  const ca = compact(a);
  const cb = compact(b);
  return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
}
// Nom renseigné ? (OpenStreetMap n'a pas toujours de nom : la page écrit « Garage (nom non renseigné) » ou « Spécialiste pneus (sans nom) »)
export const hasRealName = (name) => !!name && !/^(Garage \(nom|Spécialiste pneus \(sans)/.test(name);

// Index en cases de 0,003° de latitude sur 0,004° de longitude (environ 330 m sur 320 m) : near() rend les éléments proches d'un point.
export function makeGrid(items) {
  const LAT = 0.003;
  const LON = 0.004;
  const cells = new Map();
  const key = (lat, lon) => `${Math.floor(lat / LAT)}:${Math.floor(lon / LON)}`;
  const add = (it) => {
    const k = key(it.lat, it.lon);
    const c = cells.get(k);
    c ? c.push(it) : cells.set(k, [it]);
  };
  for (const it of items) add(it);
  return {
    add,
    near(lat, lon, radiusM = NEAR_M) {
      const dLat = Math.ceil(radiusM / 111320 / LAT);
      const dLon = Math.ceil(radiusM / (111320 * Math.max(0.01, Math.cos(rad(lat)))) / LON);
      const y = Math.floor(lat / LAT);
      const x = Math.floor(lon / LON);
      const out = [];
      for (let i = y - dLat; i <= y + dLat; i++) for (let j = x - dLon; j <= x + dLon; j++) out.push(...(cells.get(`${i}:${j}`) || []));
      return out;
    },
  };
}

// Le lieu de la table qui correspond au garage { name, lat, lon }, ou null. À moins de 40 m : même nom, ou garage sans nom et seul lieu à cet endroit ;
// de 40 à 150 m : même nom obligatoire. Plusieurs candidats : le plus proche.
export function pickRec(garage, recs) {
  const near = (recs || []).map((r) => ({ r, d: meters(garage, r) })).filter((x) => x.d <= NEAR_M);
  const spot = near.filter((x) => x.d <= SAME_SPOT_M);
  const named = hasRealName(garage.name);
  let best = null;
  for (const x of near) {
    const ok = named ? sameName(garage.name, x.r.name) : x.d <= SAME_SPOT_M && spot.length === 1;
    if (ok && (!best || x.d < best.d)) best = x;
  }
  return best && best.r;
}

// ---------------------------------------------------------------------------------------------------------------------------------- lecture d'une tuile
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const ID_RE = /^[0-9a-f-]{8,40}$/;
const PHONE_RE = /^\+\d{10,15}$/;
// Tuile → liste de lieux propres. Tout ce qui n'a pas la forme attendue est ignoré, jamais deviné ; null si le fichier n'est pas une tuile.
export function cleanTile(json) {
  if (!json || json.v !== 1 || !Array.isArray(json.g)) return null;
  const out = [];
  for (const r of json.g) {
    if (!r || typeof r !== "object") continue;
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (typeof r.id !== "string" || !ID_RE.test(r.id) || typeof r.name !== "string" || r.name.trim().length < 2) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({
      id: r.id,
      name: r.name.slice(0, 120),
      lat,
      lon,
      kind: typeof r.kind === "string" && r.kind.length === 1 && KINDS.includes(r.kind) ? r.kind : "r",
      phones: Array.isArray(r.phones) ? r.phones.filter((p) => typeof p === "string" && PHONE_RE.test(p)).slice(0, 2) : [],
      web: typeof r.web === "string" && r.web.length <= 200 && /^https?:\/\/[^\s"'<>]+$/.test(r.web) ? r.web : "",
      addr: str(r.addr, 160),
      pc: typeof r.pc === "string" && /^\d{5}$/.test(r.pc) ? r.pc : "",
      loc: str(r.loc, 80),
      brand: str(r.brand, 60),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------- chargement
// base : dossier des tuiles (« garages/ ») ; "" : inactif. fetchImpl : fetch par défaut (injecté par les tests).
export function createTable({ base = "", fetchImpl, timeoutMs = 6000, now = Date.now, maxAgeDays = MAX_AGE_DAYS, maxTiles = MAX_TILES } = {}) {
  const root = base ? (base.endsWith("/") ? base : base + "/") : "";
  const get = fetchImpl || ((...a) => fetch(...a));
  const tiles = new Map(); // case → promesse de lieux
  const stat = { requests: 0, tilesOk: 0, tilesFailed: 0, built: "", indexOk: false };
  let indexP = null;
  let failedAt = 0;
  async function json(path) {
    stat.requests++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await get(root + path, { signal: ctl.signal });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  // L'index : une seule demande par visite ; un échec n'est pas gardé plus d'une minute.
  function ready() {
    if (!root) return Promise.resolve(null);
    if (indexP) return indexP;
    if (failedAt && now() - failedAt < 60000) return Promise.resolve(null);
    indexP = json("index.json")
      .then((ix) => {
        if (!ix || ix.v !== 1 || ix.step !== STEP || ix.x0 !== X0 || !ix.tiles || typeof ix.tiles !== "object") throw new Error("index");
        const built = Date.parse(String(ix.built) + "T00:00:00Z");
        if (!Number.isFinite(built) || now() - built > maxAgeDays * 864e5) throw new Error("périmé");
        stat.built = String(ix.built);
        stat.indexOk = true;
        return ix;
      })
      .catch(() => {
        indexP = null;
        failedAt = now();
        return null;
      });
    return indexP;
  }
  function tile(key) {
    let p = tiles.get(key);
    if (!p) {
      p = json(`t/${key}.json`).then((j) => {
        const t = cleanTile(j);
        if (!t) throw new Error("tuile");
        stat.tilesOk++;
        return t;
      });
      tiles.set(key, p);
      p.catch(() => {
        tiles.delete(key); // un échec n'est jamais gardé : il peut être passager
        stat.tilesFailed++;
      });
    }
    return p;
  }
  // Lieux de la zone : { recs, tiles, failed, built } ; null si la table est inactive, absente ou trop vieille.
  async function load(lat, lon, km) {
    const ix = await ready();
    if (!ix) return null;
    const keys = tileKeysFor(lat, lon, km).filter((k) => ix.tiles[k] > 0).slice(0, maxTiles);
    const got = await Promise.all(keys.map((k) => tile(k).catch(() => null)));
    const here = { lat, lon };
    const recs = [];
    for (const t of got) if (t) for (const r of t) if (meters(here, r) <= km * 1000) recs.push(r);
    return { recs, tiles: keys.length, failed: got.filter((t) => !t).length, built: String(ix.built) };
  }
  return { enabled: !!root, ready, load, stats: () => ({ ...stat }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------- fusion
const bodyByName = (name, kind) => {
  const u = fold(name);
  return (/carross/.test(u) && !/meca|garage|pneu|entretien|reparation|service/.test(u.replace(/carross\w*/g, ""))) || (kind === "b" && !/meca|garage|pneu|entretien|reparation|service/.test(u));
};
const FIELD_LABEL = { phone: "téléphone", web: "site", addr: "adresse" };
export const fieldLabels = (fields) => (fields || []).map((f) => FIELD_LABEL[f]).filter(Boolean);

// Garage de la page pour un lieu de la table (mêmes champs que celui d'OpenStreetMap ; src « ovt »).
// Identifiant : « custom:ovt-<identifiant Overture sans tirets> », une forme que l'API accepte déjà (docs/exploitation.md) : une réparation déclarée chez un
// garage qui n'a qu'une fiche Overture est donc enregistrée sans changer l'API.
export function toGarage(rec, h) {
  const chain = h.chainOf({ name: rec.name, brand: rec.brand });
  const name = h.tidy(rec.name);
  const city = [rec.pc, rec.loc].filter(Boolean).join(" ");
  return {
    id: "custom:ovt-" + rec.id.replace(/-/g, ""),
    src: "ovt",
    ovtId: rec.id,
    name,
    lat: rec.lat,
    lon: rec.lon,
    tags: {},
    shop: rec.kind === "t" ? "tyres" : "car_repair",
    chain,
    dealer: !chain && h.dealerOf({ name: rec.name, brand: rec.brand }),
    body: bodyByName(rec.name, rec.kind),
    addr: [h.tidy(rec.addr), city].filter(Boolean).join(", "),
    city: h.cityTidy(rec.loc),
    addrGap: !rec.addr,
    phone: rec.phones.join(";"),
    web: h.web(rec.web),
    hours: "",
    osmUrl: "",
  };
}

// Ce que le lieu apporte au garage d'OpenStreetMap : seulement ce qui lui manque. Renvoie la liste des champs complétés.
export function completeGarage(g, rec, h) {
  const done = [];
  if (!h.phoneCount(g.phone) && rec.phones.length) {
    g.phone = rec.phones.join(";");
    done.push("phone");
  }
  if (!g.web && rec.web) {
    const w = h.web(rec.web);
    if (w) {
      g.web = w;
      done.push("web");
    }
  }
  if (g.addrGap && rec.addr) {
    g.addr = [h.tidy(rec.addr), [rec.pc, rec.loc].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    g.addrGap = false;
    done.push("addr");
  }
  if (!g.city && rec.loc) g.city = h.cityTidy(rec.loc);
  g.tableId = rec.id;
  if (done.length) g.tableFields = [...new Set([...(g.tableFields || []), ...done])];
  return done;
}

// Deux commerces distincts, même à quelques mètres ? Oui seulement si l'un est un centre d'enseigne intégrée (chain.own : Norauto, Feu Vert, Midas…)
// et que l'autre est d'une autre enseigne ou d'aucune, avec un nom distinctif : une zone commerciale met des magasins au même point (Muret : le
// Feu Vert, avec son prix national de géométrie, était écarté à 14 et 20 m de deux garages d'autres noms). Un réseau d'indépendants (Eurorepar, AD,
// Profil Plus… : pas d'own) n'y suffit pas : son nom est le second nom d'un garage indépendant (« Eurorepar Car Service » à 10 m de « Marin
// Automobiles ») ; ni un nom générique (« Centre Auto ») ou absent, qui peut être celui du centre lui-même. Symétrique : que le centre soit le garage de
// la liste ou le lieu de la table, la réponse est la même (sinon le résultat dépendrait de l'ordre des lieux dans la tuile).
const distinctive = (name) => hasRealName(name) && tokens(name).size > 0;
function twoShops(a, b) {
  if (!(a.chain && a.chain.own) && !(b.chain && b.chain.own)) return false;
  if (a.chain && b.chain && a.chain.id === b.chain.id) return false;
  return distinctive(a.name) && distinctive(b.name);
}

// Fusionne les lieux de la table dans la liste (le tableau garages n'est pas modifié ; les garages d'OpenStreetMap complétés le sont).
// Renvoie { list, matched, filled, added, dup }.
export function mergeTable(garages, recs, h) {
  const recGrid = makeGrid(recs);
  const garageGrid = makeGrid(garages);
  const taken = new Set();
  let matched = 0;
  let filled = 0;
  for (const g of garages) {
    if (g.src === "ovt") continue;
    const rec = pickRec(g, recGrid.near(g.lat, g.lon, NEAR_M));
    if (!rec) continue;
    matched++;
    taken.add(rec.id);
    if (completeGarage(g, rec, h).length) filled++;
  }
  const list = garages.slice();
  let added = 0;
  let dup = 0;
  for (const rec of recs) {
    if (taken.has(rec.id)) continue;
    const g = toGarage(rec, h);
    // déjà dans la liste sous un autre aspect : même nom à 150 m, ou un garage à 40 m qui n'est pas un commerce distinct (twoShops)
    const clash = garageGrid.near(rec.lat, rec.lon, NEAR_M).some((o) => {
      const d = meters(o, rec);
      return (d <= SAME_SPOT_M && !twoShops(o, g)) || (d <= NEAR_M && hasRealName(o.name) && sameName(o.name, rec.name));
    });
    if (clash) {
      dup++;
      continue;
    }
    list.push(g);
    garageGrid.add(g); // deux lieux de la table qui se recoupent ne s'ajoutent pas deux fois
    added++;
  }
  return { list, matched, filled, added, dup };
}
