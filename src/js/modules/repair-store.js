// Les réparations déclarées : un seul endroit qui sait où elles vivent.
//
//   Mode local   (aucune adresse d'API configurée) : tout reste dans ce navigateur, clé « jg.repairs.v1 ».
//   Mode distant (<meta name="pixcar-api"> renseignée) : les déclarations sont envoyées à l'API et enregistrées en base ;
//                la page lit en retour ce que les autres ont déclaré autour de l'adresse cherchée.
//
// Dans les deux modes la page ne voit qu'un tableau vivant, rows(), qui contient les réparations de ce navigateur et, en
// mode distant, celles de la zone (marquées shared: true). Elle ne sait pas, et n'a pas à savoir, si l'API répond :
//
//   - déclarer ou retirer une réparation prend effet TOUT DE SUITE dans la page ; l'envoi se fait ensuite, en tâche de fond ;
//   - un envoi qui échoue (hors ligne, API en panne, 5xx, délai) reste dans une file d'attente enregistrée dans le navigateur
//     (jg.outbox.v1), rejouée avec un délai croissant, au retour du réseau et au retour sur l'onglet ;
//   - rejouer est sans risque : l'identifiant de la déclaration est choisi ici (UUID), l'API le reconnaît ;
//   - la lecture d'une zone garde sa dernière bonne réponse (jg.area.v1) et la ressert quand l'API ne répond plus.
//
// Retirer une réparation qu'on a déclarée se fait avec un jeton secret (deleteToken) gardé dans ce navigateur : pas de compte.
// Les réparations enregistrées AVANT l'arrivée de l'API (sans champ « sync ») restent dans ce navigateur : elles ont été
// saisies avec la promesse « rien n'est envoyé », on ne les envoie donc jamais d'office.
import { GARAGE_ID_RE, PLATE_RE, YEAR_MIN } from "../shared/rules.js";
import { createClient } from "./api-client.js";

export const KEYS = { rows: "jg.repairs.v1", outbox: "jg.outbox.v1", area: "jg.area.v1", vehicles: "jg.vehicles.v1" };
const RADII_KM = [3, 5, 10, 20, 30, 50];
const CELL_DEG = 0.05;
const AREA_KEPT = 6; // zones gardées en secours
const AREA_MAX_AGE_MS = 7 * 864e5;
const GIVE_UP_MS = 7 * 864e5; // au-delà, une déclaration jamais partie reste sur cet appareil
const BACKOFF_FIRST_MS = 15_000;
const BACKOFF_MAX_MS = 15 * 60_000;

// ---- stockage du navigateur : jamais d'exception (navigation privée, quota, stockage bloqué)
export function jsonStorage(ls) {
  const area = () => {
    try {
      return ls || globalThis.localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key, fallback) {
      try {
        const raw = area().getItem(key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        area().setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        area().removeItem(key);
      } catch {}
    },
    works() {
      try {
        area().setItem("jg.t", "1");
        area().removeItem("jg.t");
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---- identifiants
const hex = (bytes) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newToken = () => hex(24); // 192 bits
export function newUuid() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const slug = (name) =>
  String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

// ---- lecture des réparations enregistrées : ce qui est invalide (modifié à la main, ancien format) est écarté ou corrigé
export function normalizeStored(list) {
  const rows = (Array.isArray(list) ? list : []).filter((e) => e && e.id && e.garageName && Number.isFinite(e.price) && e.serviceId && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
  let migrated = false;
  for (const r of rows) {
    if (!PLATE_RE.test(r.immat)) delete r.immat;
    if (!(Number.isInteger(r.year) && r.year >= YEAR_MIN && r.year <= 2100)) delete r.year;
  }
  if (rows.some((e) => "plate" in e)) {
    // ancien champ « plate » (avant l'immatriculation) : le modèle qui lui était associé est repris, le champ disparaît
    for (const e of rows)
      if (!e.model && e.plate) {
        const same = rows.find((x) => x.plate === e.plate && x.model);
        if (same) e.model = same.model;
      }
    for (const e of rows) delete e.plate;
    migrated = true;
  }
  return { rows, migrated };
}

// ---- une réparation de la page → corps de POST /v1/repairs
export function toApi(r) {
  const hasPos = Number.isFinite(r.lat) && Number.isFinite(r.lon);
  return {
    id: r.id,
    deleteToken: r.deleteToken,
    garage: {
      id: GARAGE_ID_RE.test(r.garageId) ? r.garageId : "custom:" + (slug(r.garageName) || "garage"), // ex. un centre de contrôle technique choisi à la main
      name: String(r.garageName).slice(0, 120),
      addr: String(r.garageAddr || "").slice(0, 200),
      lat: hasPos ? r.lat : null,
      lon: hasPos ? r.lon : null,
      chainId: /^[a-z0-9_-]{0,40}$/.test(r.chainId || "") ? r.chainId || "" : "",
    },
    area: r.area || (hasPos ? { lat: r.lat, lon: r.lon } : undefined),
    serviceId: r.serviceId,
    price: r.price,
    date: r.date,
    rating: r.rating,
    comment: r.comment || "",
    vehicle: { model: r.model, year: r.year, plate: r.immat },
  };
}

// ---- réponse de GET /v1/repairs → réparations « d'autres » (shared: true), validées une à une
export function fromApi(body) {
  const out = [];
  const garages = body && Array.isArray(body.garages) ? body.garages : [];
  for (const g of garages) {
    if (!g || typeof g.id !== "string" || typeof g.name !== "string") continue;
    for (const r of Array.isArray(g.repairs) ? g.repairs : []) {
      if (!r || typeof r.id !== "string" || typeof r.serviceId !== "string" || !Number.isFinite(r.price) || r.price <= 0 || !/^\d{4}-\d{2}$/.test(r.month)) continue;
      out.push({
        id: r.id,
        garageId: g.id,
        garageName: g.name,
        garageAddr: typeof g.addr === "string" ? g.addr : "",
        lat: Number.isFinite(g.lat) ? g.lat : null,
        lon: Number.isFinite(g.lon) ? g.lon : null,
        chainId: typeof g.chainId === "string" ? g.chainId : "",
        model: typeof r.model === "string" ? r.model.slice(0, 60) : "",
        year: Number.isInteger(r.year) && r.year >= YEAR_MIN && r.year <= 2100 ? r.year : undefined,
        rating: Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : 0,
        serviceId: r.serviceId,
        price: r.price,
        date: `${r.month}-01`, // l'API ne publie que le mois
        shared: true,
      });
    }
  }
  return out;
}

// Case de 0,05° dont le CENTRE est demandé à l'API : tous les visiteurs d'un quartier envoient la même adresse, donc partagent le même cache.
export function areaQuery(lat, lon, km) {
  const center = (v, offset) => ((Math.floor((v + offset) / CELL_DEG) + 0.5) * CELL_DEG - offset).toFixed(3);
  const radius = RADII_KM.find((r) => r >= km) || RADII_KM[RADII_KM.length - 1];
  const la = center(lat, 90), lo = center(lon, 180);
  return { key: `${la},${lo},${radius}`, query: `lat=${la}&lon=${lo}&radius=${radius}` };
}

const signature = (list) => list.map((r) => `${r.id}:${r.price}:${r.rating}`).sort().join("|");

export function createStore({
  apiBase = "",
  storage = jsonStorage(),
  client,
  now = () => Date.now(),
  random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  newId = newUuid,
  newSecret = newToken,
} = {}) {
  const remote = !!apiBase;
  if (remote && !client) client = createClient({ base: apiBase.replace(/\/+$/, "") });

  // ---------------------------------------------------------------- état
  const rows = []; // le tableau vivant rendu par rows() : jamais remplacé, seulement modifié sur place
  const loaded = normalizeStored(storage.get(KEYS.rows, []));
  const own = loaded.rows;
  if (remote) for (const r of own) if (!["pending", "synced", "local"].includes(r.sync)) r.sync = "local"; // enregistrées avant l'API : elles restent ici
  if (loaded.migrated) storage.set(KEYS.rows, own);
  for (const old of ["jg.platemodels.v1", "jg.plateapi.v1"]) storage.remove(old);
  let shared = [];
  let sharedSignature = "";
  let outbox = remote ? (storage.get(KEYS.outbox, []) || []).filter((o) => o && (o.op === "post" || o.op === "delete") && typeof o.id === "string") : [];
  let vehicles = storage.get(KEYS.vehicles, null);
  let apiState = "unknown"; // "ok" · "stale" (copie de secours servie) · "down" (aucune réponse, aucune copie)
  let running = null;
  let current = null; // opération en cours d'envoi
  let timer = null;
  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => fn(event));

  const rebuild = () => {
    const mine = new Set(own.map((r) => r.id));
    rows.length = 0;
    rows.push(...own, ...shared.filter((r) => !mine.has(r.id)));
  };
  const saveOwn = () => storage.set(KEYS.rows, own);
  const saveOutbox = () => remote && storage.set(KEYS.outbox, outbox);

  // véhicules : mémoire à part, pour que « Annuler » ou « Supprimer » n'efface pas la plaque et le modèle déjà saisis
  if (!Array.isArray(vehicles)) {
    vehicles = [];
    for (const r of [...own].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) remember(r);
  }
  function remember(r) {
    if (!r.model) return;
    const entry = { model: r.model, year: r.year || 0, plate: r.immat || "", at: now() };
    vehicles = [entry, ...vehicles.filter((v) => (entry.plate ? v.plate !== entry.plate : v.model !== entry.model))].slice(0, 5);
    storage.set(KEYS.vehicles, vehicles);
  }

  rebuild();

  // ---------------------------------------------------------------- écriture
  const hasOp = (kind, id) => outbox.find((o) => o.op === kind && o.id === id);
  const enqueue = (op) => {
    outbox.push({ tries: 0, next: 0, firstAt: now(), ...op });
    saveOutbox();
  };
  // une opération jamais partie (ni en cours) n'a rien à défaire côté serveur : on peut simplement l'annuler
  const neverSent = (op) => op && !op.tries && current !== op;

  function add(row) {
    const r = { ...row, id: row.id || newId(), createdAt: row.createdAt || new Date(now()).toISOString() };
    if (remote) {
      r.deleteToken = newSecret();
      r.sync = "pending";
      enqueue({ op: "post", id: r.id });
    }
    own.push(r);
    saveOwn();
    remember(r);
    rebuild();
    emit({ type: "rows" });
    flush();
    return r;
  }

  function remove(id) {
    const index = own.findIndex((r) => r.id === id);
    if (index < 0) return null;
    const [row] = own.splice(index, 1);
    saveOwn();
    if (remote && row.sync !== "local") {
      const post = hasOp("post", id);
      outbox = outbox.filter((o) => o !== post);
      // déjà (peut-être) arrivée chez le serveur, ou réponse inconnue : on demande sa suppression, qui réussit aussi si elle n'existe pas
      if (!neverSent(post)) enqueue({ op: "delete", id, token: row.deleteToken });
      saveOutbox();
    }
    rebuild();
    emit({ type: "rows" });
    flush();
    return { row, index };
  }

  // « Annuler » après une suppression : la déclaration revient à sa place
  function restore({ row, index }) {
    if (own.some((r) => r.id === row.id)) return row;
    own.splice(Math.min(index, own.length), 0, row);
    saveOwn();
    if (remote && row.sync !== "local") {
      const del = hasOp("delete", row.id);
      outbox = outbox.filter((o) => o !== del);
      if (!neverSent(del)) row.sync = "pending"; // la suppression est (peut-être) partie : on redépose la même déclaration
      // même identifiant, même jeton : l'API l'enregistre, ou la reconnaît si elle y est encore
      if (row.sync === "pending" && !hasOp("post", row.id)) enqueue({ op: "post", id: row.id });
      saveOutbox();
    }
    rebuild();
    emit({ type: "rows" });
    flush();
    return row;
  }

  // ---------------------------------------------------------------- envoi en tâche de fond
  const backoff = (tries) => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, tries - 1)) * (0.75 + 0.5 * random());

  function flush() {
    if (!remote) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      await null; // le corps démarre APRÈS l'affectation de « running » : sinon, sans rien à envoyer, il se terminerait avant et « running » resterait fixé
      try {
        const attempted = new Set();
        let stop = false;
        // plusieurs passages : une opération ajoutée pendant l'envoi d'une autre (« Annuler » juste après « Supprimer ») part sans attendre
        while (!stop && outbox.some((o) => !attempted.has(o) && o.next <= now())) {
          const blocked = new Set(); // une opération en attente retient les suivantes sur la même déclaration (l'ordre compte)
          for (const op of [...outbox]) {
            if (!outbox.includes(op) || attempted.has(op)) continue; // annulée entre-temps, ou déjà tentée à ce tour
            if (now() - op.firstAt > GIVE_UP_MS) {
              giveUp(op);
              continue;
            }
            if (op.next > now() || blocked.has(op.id)) {
              blocked.add(op.id);
              continue;
            }
            attempted.add(op);
            if ((stop = await run(op))) break; // disjoncteur ouvert : inutile d'insister
          }
        }
      } finally {
        running = null;
        schedule();
      }
    })();
    return running;
  }

  function schedule() {
    clearTimer(timer);
    timer = null;
    const due = outbox.map((o) => o.next).filter((n) => n > 0);
    if (due.length) timer = setTimer(() => flush(), Math.max(1000, Math.min(...due) - now()));
  }

  function giveUp(op) {
    outbox = outbox.filter((o) => o !== op);
    saveOutbox();
    const row = own.find((r) => r.id === op.id);
    if (op.op === "post" && row && row.sync === "pending") {
      row.sync = "local";
      saveOwn();
      rebuild();
      emit({ type: "row", id: row.id });
      emit({ type: "notice", kind: "gaveup", row });
    }
    emit({ type: "sync" });
  }

  const finish = (op) => {
    outbox = outbox.filter((o) => o !== op);
    saveOutbox();
  };
  const retryLater = (op, res) => {
    op.next = now() + (res.status === 429 ? Math.max(60, res.retryAfter || 0) * 1000 : backoff(op.tries));
    op.last = res.status || res.kind;
    saveOutbox();
  };
  // la déclaration est gardée ici et partira plus tard : on le dit une fois
  const queuedNotice = (op, row) => {
    if (op.op !== "post" || op.notified) return;
    op.notified = true;
    emit({ type: "notice", kind: "queued", row: row || own.find((r) => r.id === op.id) });
  };

  // renvoie true quand il faut arrêter la boucle (disjoncteur ouvert)
  async function run(op) {
    op.tries++;
    current = op;
    saveOutbox();
    try {
      const row = own.find((r) => r.id === op.id);
      if (op.op === "post" && !row) return void finish(op); // retirée entre-temps ; sa suppression est dans la file
      const res =
        op.op === "post"
          ? await client.request("POST", "/v1/repairs", { body: toApi(row) })
          : await client.request("DELETE", `/v1/repairs/${encodeURIComponent(op.id)}`, { headers: { "x-delete-token": op.token } });
      if (!outbox.includes(op)) return false; // annulée pendant l'envoi (« Annuler » juste après « Supprimer ») : la file a été recomposée
      if (res.kind === "circuit") {
        op.tries--;
        op.next = now() + res.retryAfter * 1000;
        queuedNotice(op, row);
        saveOutbox();
        return true;
      }
      if (res.status > 0 && res.status < 500) apiState = "ok";
      op.op === "post" ? afterPost(op, row, res) : afterDelete(op, res);
      return false;
    } finally {
      current = null;
      emit({ type: "sync" });
    }
  }

  function afterPost(op, row, res) {
    const permanent = (kind, fields) => {
      finish(op);
      row.sync = "local"; // reste visible ici, n'est jamais partagée
      saveOwn();
      emit({ type: "row", id: row.id });
      emit({ type: "notice", kind, row, fields });
    };
    if (res.ok) {
      finish(op);
      row.sync = "synced";
      row.review = res.data && res.data.status === "pending" ? "pending" : undefined;
      if (!row.review) delete row.review;
      saveOwn();
      return void emit({ type: "row", id: row.id });
    }
    const code = res.data && res.data.error && res.data.error.code;
    if (res.status === 409 && code === "duplicate") {
      // déjà déclarée (même plaque, garage, prestation, jour) : la première compte, la copie locale ferait double emploi
      finish(op);
      own.splice(own.indexOf(row), 1);
      saveOwn();
      rebuild();
      emit({ type: "rows" });
      return void emit({ type: "notice", kind: "duplicate", row });
    }
    if (res.status === 409) {
      // identifiant déjà pris par une autre déclaration (probabilité négligeable) : on en tire un autre et on recommence
      row.id = op.id = newId();
      row.deleteToken = newSecret();
      op.tries = 0;
      op.next = 0;
      saveOwn();
      saveOutbox();
      return void setTimer(() => flush(), 0);
    }
    if (res.status === 429 || res.kind === "network" || res.kind === "timeout" || res.status >= 500) {
      queuedNotice(op, row);
      return retryLater(op, res);
    }
    permanent("rejected", res.data && res.data.error && res.data.error.fields); // 400, 403, 413, 415, 422… : renvoyer à l'identique ne changerait rien
  }

  function afterDelete(op, res) {
    if (res.ok || res.status === 404) return finish(op); // supprimée, ou déjà absente : même résultat
    if (res.status === 429 || res.status === 0 || res.status >= 500) return retryLater(op, res);
    finish(op); // 400, 403… : le jeton ne sera jamais bon, inutile d'insister
  }

  // ---------------------------------------------------------------- lecture d'une zone
  const readAreas = () => storage.get(KEYS.area, {}) || {};
  const setShared = (list) => {
    const sig = signature(list);
    const changed = sig !== sharedSignature;
    shared = list;
    sharedSignature = sig;
    if (changed) {
      rebuild();
      emit({ type: "rows" });
    }
    return changed;
  };

  // Synchrone : la dernière bonne réponse de cette zone, pour que le premier affichage comprenne déjà les réparations d'autres.
  function preload({ lat, lon, km }) {
    if (!remote) return false;
    const { key } = areaQuery(lat, lon, km);
    const hit = readAreas()[key];
    if (!hit || now() - hit.at >= AREA_MAX_AGE_MS) return false;
    setShared(fromApi(hit.body));
    return true;
  }

  async function load({ lat, lon, km }) {
    if (!remote) return { changed: false, source: "none" };
    const { key, query } = areaQuery(lat, lon, km);
    const res = await client.request("GET", `/v1/repairs?${query}`, { timeoutMs: 4000, retries: 1 });
    if (res.ok && res.data && Array.isArray(res.data.garages)) {
      const areas = readAreas();
      areas[key] = { at: now(), body: res.data };
      const keep = Object.keys(areas).sort((a, b) => areas[b].at - areas[a].at).slice(0, AREA_KEPT);
      storage.set(KEYS.area, Object.fromEntries(keep.map((k) => [k, areas[k]])));
      apiState = "ok";
      const changed = setShared(fromApi(res.data));
      emit({ type: "sync" });
      return { changed, source: "network" };
    }
    const hit = readAreas()[key];
    if (hit && now() - hit.at < AREA_MAX_AGE_MS) {
      apiState = "stale";
      const changed = setShared(fromApi(hit.body));
      emit({ type: "sync" });
      return { changed, source: "cache", stale: true, error: res.kind };
    }
    apiState = "down";
    emit({ type: "sync" });
    return { changed: false, source: "none", error: res.kind };
  }

  // ---------------------------------------------------------------- branchement sur la page
  function attach(win = globalThis) {
    if (!remote) return;
    win.addEventListener("online", () => {
      client.reset && client.reset(); // le réseau est revenu : on n'attend pas la fin du délai du disjoncteur
      for (const op of outbox) op.next = 0;
      return flush();
    });
    win.document.addEventListener("visibilitychange", () => (win.document.hidden ? undefined : flush()));
    flush();
  }

  return {
    mode: remote ? "remote" : "local",
    rows: () => rows,
    own: () => own,
    vehicles: () => vehicles.slice(),
    add,
    remove,
    restore,
    load,
    preload,
    flush,
    attach,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    status: () => ({ mode: remote ? "remote" : "local", api: apiState, pending: outbox.filter((o) => o.op === "post").length, queued: outbox.length, circuit: client ? client.state : "closed" }),
    storageWorks: () => storage.works(),
  };
}
