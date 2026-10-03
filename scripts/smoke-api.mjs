#!/usr/bin/env node
// Vérifie qu'une API Pixcar DÉPLOYÉE enregistre bien les réparations en base : sondes, autorisation du site (CORS), déclaration,
// lecture publique, rejeu, doublon, suppression refusée sans le bon jeton puis acceptée avec.
//   node scripts/smoke-api.mjs https://api.pixcar.fr [--origin https://pixcar.fr] [--keep]
// La déclaration d'essai (garage « custom:essai-pixcar », véhicule « Essai Pixcar ») est posée en plein Atlantique (0,5° N, 20,5° O) :
// aucun visiteur ne la verra sur une carte. Elle est créée puis supprimée ; --keep la laisse en base pour la voir avec
// `node server/moderate.mjs stats`. Elle compte pour UNE déclaration dans le quota d'écriture de l'adresse qui lance l'essai
// (10 par heure par défaut) ; la plaque est tirée au hasard, aucune donnée personnelle.
// Code de sortie : 0 si tout est conforme, 1 sinon, 2 si la ligne de commande est incorrecte.
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const LAT = 0.5, LON = -20.5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

export async function smoke(base, { keep = false, origin = "https://pixcar.fr", waitMs = 30_000, pollMs = 1500, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const root = String(base).replace(/\/+$/, "");
  const steps = [];
  const step = (name, ok, detail = "") => {
    steps.push({ name, ok: !!ok, detail });
    log(`${ok ? "✔" : "✘"} ${name}${!ok && detail ? "  — " + detail : ""}`);
    return !!ok;
  };
  const finish = () => ({ ok: steps.length > 0 && steps.every((s) => s.ok), steps });
  // Comme le navigateur de la page : mêmes en-têtes Origin et Content-Type.
  const call = async (method, path, { body, headers = {} } = {}) => {
    try {
      const res = await fetchImpl(root + path, {
        method,
        headers: { accept: "application/json", origin, ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
    } catch (e) {
      return { status: 0, json: null, headers: new Headers(), error: (e && (e.cause?.code || e.message)) || "erreur réseau" };
    }
  };
  const until = async (fn) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v || Date.now() - t0 > waitMs) return v;
      await sleep(pollMs);
    }
  };
  const allowOrigin = (headers) => headers.get("access-control-allow-origin") || "absent";
  const allowsOrigin = (headers) => ["*", origin].includes(allowOrigin(headers));

  // 1. L'API répond et sa base aussi
  const health = await call("GET", "/healthz");
  if (!step("GET /healthz → 200 (l'API répond)", health.status === 200, health.error || `reçu ${health.status}`)) return finish();
  const ready = await call("GET", "/readyz");
  if (!step("GET /readyz → 200 (la base répond)", ready.status === 200 && ready.json?.db === "up", ready.error || `reçu ${ready.status} ${JSON.stringify(ready.json)}`)) return finish();

  // 2. Le navigateur du visiteur a le droit d'écrire : sinon la page croit « envoyer » et garde tout dans sa file d'attente
  const preflight = await call("OPTIONS", "/v1/repairs", { headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  const allowed = (name) => (preflight.headers.get(name) || "").toLowerCase();
  if (!step(
    `OPTIONS /v1/repairs depuis ${origin} → autorisé (variable ALLOWED_ORIGINS de l'API)`,
    preflight.status === 204 && allowsOrigin(preflight.headers) && /\bpost\b/.test(allowed("access-control-allow-methods")) && /\bdelete\b/.test(allowed("access-control-allow-methods")) && /content-type/.test(allowed("access-control-allow-headers")),
    preflight.error || `reçu ${preflight.status}, access-control-allow-origin : ${allowOrigin(preflight.headers)}`,
  )) return finish();

  // 3. Une déclaration est écrite en base
  const id = randomUUID(), token = randomBytes(24).toString("hex");
  const declaration = {
    id,
    deleteToken: token,
    garage: { id: "custom:essai-pixcar", name: "Garage d'essai Pixcar", addr: "", lat: LAT, lon: LON, chainId: "" },
    serviceId: "vidange",
    price: 42.5,
    date: new Date().toISOString().slice(0, 10),
    rating: 5,
    comment: "essai automatique de déploiement",
    vehicle: { model: "Essai Pixcar", year: 2020, plate: `${letters(2)}-${100 + Math.floor(Math.random() * 900)}-${letters(2)}` },
  };
  const created = await call("POST", "/v1/repairs", { body: declaration });
  if (!step("POST /v1/repairs → 201 (écrite en base)", created.status === 201, created.error || `reçu ${created.status} ${JSON.stringify(created.json)}`)) return finish();
  step("… et la réponse porte l'autorisation CORS (sans elle le navigateur ne lirait pas le résultat)", allowsOrigin(created.headers), `access-control-allow-origin : ${allowOrigin(created.headers)}`);

  // 4. Elle ressort de la lecture publique. Le paramètre « _ » évite qu'un CDN serve une copie de l'adresse exacte ; l'API garde
  //    en outre chaque zone lue 10 s en mémoire, d'où l'attente (pas ici, dans cette zone déserte, sauf instances multiples).
  const find = async (radius) => {
    const res = await call("GET", `/v1/repairs?lat=${LAT}&lon=${LON}&radius=${radius}&_=${Date.now()}`);
    const garage = res.json?.garages?.find((g) => g.id === "custom:essai-pixcar");
    return { status: res.status, headers: res.headers, row: garage?.repairs?.find((r) => r.id === id) };
  };
  let lastRead = null;
  const seen = await until(async () => (lastRead = await find(3)).row);
  step("GET /v1/repairs → la réparation est relue depuis la base", seen && seen.price === 42.5 && seen.serviceId === "vidange", seen ? JSON.stringify(seen) : `introuvable dans la zone (dernière lecture : ${lastRead && lastRead.status})`);
  step("… sans commentaire, sans plaque, avec le mois seulement (pas le jour)", seen && !("comment" in seen) && !("plate" in seen) && !("immat" in seen) && /^\d{4}-\d{2}$/.test(String(seen.month)), seen ? Object.keys(seen).join(", ") : "");
  step("… et la lecture porte l'autorisation CORS", lastRead && allowsOrigin(lastRead.headers), lastRead ? `access-control-allow-origin : ${allowOrigin(lastRead.headers)}` : "");

  // 5. Rejouer la même déclaration est sans effet ; la même plaque le même jour chez le même garage est un doublon
  const replay = await call("POST", "/v1/repairs", { body: declaration });
  step("POST identique → 200 « rejeu » (un envoi répété ne crée pas deux lignes)", replay.status === 200 && replay.json?.replayed === true, replay.error || `reçu ${replay.status}`);
  const duplicate = await call("POST", "/v1/repairs", { body: { ...declaration, id: randomUUID(), deleteToken: randomBytes(24).toString("hex") } });
  step("même plaque, garage, prestation et jour sous un autre identifiant → 409 « doublon »", duplicate.status === 409 && duplicate.json?.error?.code === "duplicate", duplicate.error || `reçu ${duplicate.status} ${JSON.stringify(duplicate.json?.error)}`);

  // 6. Supprimer exige le bon jeton
  const wrong = await call("DELETE", `/v1/repairs/${id}`, { headers: { "x-delete-token": randomBytes(24).toString("hex") } });
  step("DELETE avec un mauvais jeton → 404 (on ne révèle pas ce qui existe)", wrong.status === 404, wrong.error || `reçu ${wrong.status}`);
  if (keep) {
    log(`(--keep : la réparation ${id} reste en base)`);
    return finish();
  }
  const removed = await call("DELETE", `/v1/repairs/${id}`, { headers: { "x-delete-token": token } });
  step("DELETE avec le bon jeton → 204 (supprimée de la base)", removed.status === 204, removed.error || `reçu ${removed.status}`);
  const gone = await until(async () => {
    const r = await find(5); // un autre rayon : une autre entrée du cache de l'API, donc une lecture fraîche
    return r.status === 200 && !r.row;
  });
  step("GET /v1/repairs → la réparation a disparu", gone);
  return finish();
}

function parseArgs(argv) {
  const out = { base: "", keep: false, origin: "https://pixcar.fr", bad: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") out.keep = true;
    else if (a === "--origin") out.origin = argv[++i] || "";
    else if (a.startsWith("--")) out.bad = `option inconnue : ${a}`;
    else if (!out.base) out.base = a;
    else out.bad = `argument en trop : ${a}`;
  }
  if (!out.bad && !/^https?:\/\/[^/\s]+\/?$/.test(out.base)) out.bad = "adresse de l'API attendue (https://api.exemple.fr, sans chemin)";
  if (!out.bad && !/^https?:\/\/[^/\s]+$/.test(out.origin)) out.bad = "--origin attend une origine seule (https://pixcar.fr, sans chemin ni « / » final)";
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.bad) {
    console.error(`${args.bad}\nusage : node scripts/smoke-api.mjs https://api.pixcar.fr [--origin https://pixcar.fr] [--keep]`);
    process.exit(2);
  }
  console.log(`Essai de ${args.base} (le site qui l'appelle : ${args.origin})\n`);
  const result = await smoke(args.base, { keep: args.keep, origin: args.origin, log: console.log });
  console.log(result.ok ? "\nTout est conforme : l'API enregistre, relit et supprime les réparations dans sa base, et accepte le site." : "\nÉCHEC : voir les lignes ✘ ci-dessus (docs/exploitation.md, « Incidents »).");
  process.exit(result.ok ? 0 : 1);
}
