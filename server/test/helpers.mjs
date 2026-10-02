// Outils des tests de l'API : une vraie base PostgreSQL embarquée (PGlite), la vraie application, des requêtes Web standard.
import { randomUUID } from "node:crypto";
import { createApp, loadServices } from "../app.mjs";
import { loadConfig } from "../config.mjs";
import { createDb } from "../db.mjs";
import { migrate } from "../migrate.mjs";
import { randomHex } from "../lib/crypto.mjs";

export const ORIGIN = "https://pixcar.test";

// Par défaut une base PostgreSQL embarquée (PGlite) ; avec TEST_DATABASE_URL, un vrai serveur PostgreSQL (son schéma est
// vidé au début de chaque test) : c'est ce qui vérifie le pilote « pg » utilisé en production.
//   TEST_DATABASE_URL=postgres://pixcar:pixcar@127.0.0.1:5432/pixcar_test npm run test:server
export const REAL_PG = process.env.TEST_DATABASE_URL || "";
export async function freshDb() {
  const db = await createDb({ url: REAL_PG });
  if (REAL_PG) await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  return db;
}

export async function makeApp({ config = {}, fetchImpl, now, log, overpassOptions } = {}) {
  const db = await freshDb();
  await migrate(db);
  const cfg = { ...loadConfig({ NODE_ENV: "test", ALLOWED_ORIGINS: ORIGIN }), ...config };
  const app = createApp({ db, config: cfg, services: await loadServices(), fetchImpl, now, log, overpassOptions });
  const call = (method, path, { body, headers = {}, ip = "203.0.113.7", origin } = {}) =>
    app.fetch(
      new Request("http://api.test" + path, {
        method,
        headers: { ...(body !== undefined && !headers["content-type"] ? { "content-type": "application/json" } : {}), ...(origin ? { origin } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      { remoteIp: ip },
    );
  const reset = () => db.exec("TRUNCATE repairs, garages, write_log, upstream_cache CASCADE");
  return { app, db, config: cfg, call, reset, close: () => app.close() };
}

export const isoDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);

// Une déclaration valide ; chaque appel produit un identifiant, un jeton et une plaque neufs.
let plateN = 0;
export function repair(over = {}) {
  const n = ++plateN;
  const letters = (k) => String.fromCharCode(65 + (k % 26)) + String.fromCharCode(65 + (Math.floor(k / 26) % 26));
  return {
    id: randomUUID(),
    deleteToken: randomHex(16),
    garage: { id: "osm:node/1022", name: "Norauto Bron", addr: "98 rue Marcel Mérieux, 69100 Bron", lat: 45.7347, lon: 4.9128, chainId: "norauto" },
    area: { lat: 45.7347, lon: 4.9128 },
    serviceId: "vidange",
    price: 59.9,
    date: isoDay(10),
    rating: 4,
    comment: "Très bien, rapide.",
    vehicle: { model: "Peugeot 208", year: 2019, plate: `${letters(n)}-${String(100 + (n % 900))}-${letters(n * 7)}` },
    ...over,
  };
}

export const get = async (res) => ({ status: res.status, headers: res.headers, json: await res.clone().json().catch(() => null), text: await res.text() });
