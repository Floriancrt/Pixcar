#!/usr/bin/env node
// Charge indicative de l'API (lecture d'une zone, déclaration, suppression) sur une vraie base.
//   DATABASE_URL=postgres://… node scripts/load-api.mjs [--seconds 20] [--users 50] [--garages 400]
// Avec DATABASE_URL : le serveur tourne dans son propre processus (sa consommation de processeur est mesurée à part,
// et le générateur de charge ne lui prend pas le sien). Sans : PGlite, tout dans un seul processus, bien plus lent
// qu'un vrai PostgreSQL — ce n'est PAS représentatif.
// Les chiffres d'un bac à sable ne sont pas ceux de la production : ils servent à repérer un défaut (requête qui explose,
// verrou, erreurs sous charge), pas à dimensionner. Les limites de débit sont relevées pour ne pas fausser la mesure.
import http from "node:http";
import { fork } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp, loadServices } from "../server/app.mjs";
import { loadConfig } from "../server/config.mjs";
import { createDb } from "../server/db.mjs";
import { toNodeListener } from "../server/index.mjs";
import { migrate } from "../server/migrate.mjs";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = +arg("seconds", 20), USERS = +arg("users", 50), GARAGES = +arg("garages", 400);
const url = process.env.DATABASE_URL || "";

// le serveur de l'essai : mêmes réglages que la production, limites de débit relevées
async function serve(db) {
  const config = { ...loadConfig({ NODE_ENV: "test", ALLOWED_ORIGINS: "*" }), writeLimitPerHour: 1e9, writeLimitGlobalPerMinute: 1e9, readLimitPerMinute: 1e9 };
  const app = createApp({ db, config, services: await loadServices(), log: () => {} });
  const server = http.createServer(toNodeListener(app));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { app, server, port: server.address().port };
}

if (process.argv.includes("--serve")) {
  const { app, server, port } = await serve(await createDb({ url }));
  process.on("message", async (m) => {
    if (m === "cpu") process.send({ cpu: process.cpuUsage() });
    if (m === "stop") { server.close(); await app.close(); process.exit(0); }
  });
  process.send({ port });
} else await main();

async function main() {
  const db = await createDb({ url });
  if (url) await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);

  // semis : GARAGES garages autour de Lyon, 8 réparations chacun
  await db.exec(`
    INSERT INTO garages (id, name, addr, lat, lon, chain_id, area_y, area_x)
    SELECT 'osm:node/' || g, 'Garage ' || g, '', 45.5 + (g % 40) * 0.01, 4.6 + (g / 40) * 0.01, '',
           floor((45.5 + (g % 40) * 0.01 + 90) / 0.05)::int, floor((4.6 + (g / 40) * 0.01 + 180) / 0.05)::int
    FROM generate_series(1, ${GARAGES}) g;
    INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, vehicle_model, vehicle_year, plate_hmac, delete_token_hash)
    SELECT gen_random_uuid(), 'osm:node/' || g, (ARRAY['vidange','revision','plaq_av','geo_av'])[1 + (r % 4)], 4000 + (g * 37 + r * 911) % 20000,
           DATE '2026-09-01' - (r * 9), 1 + (g + r) % 5, 'Peugeot 208', 2019, decode(md5(g || '-' || r) || md5(r || '-' || g), 'hex'), decode(repeat('ab', 32), 'hex')
    FROM generate_series(1, ${GARAGES}) g, generate_series(1, 8) r;
  `);

  let base, cpu, stopServer;
  if (url) {
    await db.close?.();
    const child = fork(fileURLToPath(import.meta.url), ["--serve"], { env: process.env });
    const port = await new Promise((resolve, reject) => { child.once("message", (m) => resolve(m.port)); child.once("exit", () => reject(new Error("le serveur de l'essai s'est arrêté"))); });
    base = `http://127.0.0.1:${port}`;
    cpu = () => new Promise((resolve) => { child.once("message", (m) => resolve(m.cpu)); child.send("cpu"); });
    stopServer = async () => { child.send("stop"); await new Promise((r) => child.once("exit", r)); };
  } else {
    const local = await serve(db);
    base = `http://127.0.0.1:${local.port}`;
    cpu = async () => process.cpuUsage();
    stopServer = async () => { local.server.close(); await local.app.close(); };
  }
  const monitor = url ? await createDb({ url }) : db;

  // 70 % des lectures visent 5 zones « chaudes », le reste 40 zones
  const centers = Array.from({ length: 40 }, (_, i) => [45.52 + (i % 8) * 0.05, 4.62 + Math.floor(i / 8) * 0.05]);
  const pick = () => centers[Math.random() < 0.7 ? Math.floor(Math.random() * 5) : Math.floor(Math.random() * 40)];
  const stat = { GET: [], POST: [], DELETE: [] }, codes = {};
  const mine = [];
  let stop = false, wire = 0, plain = 0;
  const encoding = process.env.LOAD_ENCODING || "gzip, br";
  const cpu0 = await cpu();
  const t0 = Date.now();
  async function user() {
    while (!stop) {
      const roll = Math.random();
      const s = performance.now();
      let kind, res;
      try {
        if (roll < 0.93) {
          kind = "GET";
          const [la, lo] = pick();
          res = await fetch(`${base}/v1/repairs?lat=${la}&lon=${lo}&radius=10`, { headers: { "accept-encoding": encoding } });
        } else if (roll < 0.99 || !mine.length) {
          kind = "POST";
          const id = randomUUID(), token = randomBytes(24).toString("hex"), g = 1 + Math.floor(Math.random() * GARAGES);
          const plate = `${String.fromCharCode(65 + (Math.random() * 26) | 0)}${String.fromCharCode(65 + (Math.random() * 26) | 0)}-${100 + ((Math.random() * 900) | 0)}-${String.fromCharCode(65 + (Math.random() * 26) | 0)}${String.fromCharCode(65 + (Math.random() * 26) | 0)}`;
          res = await fetch(`${base}/v1/repairs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, deleteToken: token, garage: { id: `osm:node/${g}`, name: `Garage ${g}`, addr: "", lat: 45.5 + (g % 40) * 0.01, lon: 4.6 + Math.floor(g / 40) * 0.01, chainId: "" }, serviceId: "vidange", price: 40 + Math.random() * 100, date: "2026-09-20", rating: 4, comment: "", vehicle: { model: "Clio", year: 2018, plate } }) });
          if (res.status === 201) mine.push([id, token]);
        } else {
          kind = "DELETE";
          const [id, token] = mine.pop();
          res = await fetch(`${base}/v1/repairs/${id}`, { method: "DELETE", headers: { "x-delete-token": token } });
        }
        const body = await res.arrayBuffer();
        if (kind === "GET") {
          plain += body.byteLength; // fetch décompresse : c'est la taille du JSON
          wire += Number(res.headers.get("content-length")) || body.byteLength; // taille réellement transmise (compressée si le serveur l'a fait)
        }
        stat[kind].push(performance.now() - s);
        codes[`${kind} ${res.status}`] = (codes[`${kind} ${res.status}`] || 0) + 1;
      } catch (e) {
        codes[`erreur ${e.cause?.code || e.message}`] = (codes[`erreur ${e.cause?.code || e.message}`] || 0) + 1;
      }
    }
  }
  setTimeout(() => (stop = true), SECONDS * 1000);
  await Promise.all(Array.from({ length: USERS }, user));
  const elapsed = (Date.now() - t0) / 1000;
  const cpu1 = await cpu();
  const busy = (cpu1.user - cpu0.user + cpu1.system - cpu0.system) / 1e6;
  const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : "-");
  const total = Object.values(stat).reduce((n, a) => n + a.length, 0);
  console.log(`base : ${db.kind}${url ? " · serveur dans son propre processus" : " (PGlite, un seul processus : non représentatif)"} · ${USERS} utilisateurs simultanés · ${SECONDS} s · ${GARAGES * 8} réparations au départ · accept-encoding : ${encoding}`);
  for (const [k, a] of Object.entries(stat)) if (a.length) console.log(`${k.padEnd(7)} ${String(a.length).padStart(7)} requêtes (${(a.length / elapsed).toFixed(0)}/s)  p50 ${pct(a, 0.5)} ms · p95 ${pct(a, 0.95)} ms · p99 ${pct(a, 0.99)} ms`);
  if (stat.GET.length) console.log(`réponse de lecture : ${(plain / stat.GET.length / 1024).toFixed(1)} Ko de JSON, ${(wire / stat.GET.length / 1024).toFixed(1)} Ko transmis`);
  console.log(`processeur du serveur : ${busy.toFixed(1)} s sur ${elapsed.toFixed(0)} s (${((busy / elapsed) * 100).toFixed(0)} % d'un cœur) · ${((busy / total) * 1000).toFixed(2)} ms par requête`);
  console.log("codes :", JSON.stringify(codes));
  const errors = Object.entries(codes).filter(([k]) => /erreur| 5\d\d$/.test(k)).reduce((n, [, v]) => n + v, 0);
  const plan = (await monitor.query("EXPLAIN SELECT g.id FROM garages g JOIN repairs r ON r.garage_id = g.id WHERE r.status = 'approved' AND g.area_y BETWEEN 2710 AND 2714 AND g.area_x BETWEEN 3690 AND 3694")).rows.map((r) => r["QUERY PLAN"]).join("\n");
  console.log(`erreurs (réseau ou 5xx) : ${errors}\n\nplan de la requête de lecture :\n${plan}`);
  await stopServer();
  if (monitor !== db) await monitor.close?.();
  process.exit(errors ? 1 : 0);
}
