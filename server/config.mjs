// Configuration par variables d'environnement. En production, un secret manquant ou faible est une erreur de démarrage :
// mieux vaut ne pas démarrer que tourner avec une empreinte de plaques ou d'adresses IP devinable.
import { randomHex } from "./lib/crypto.mjs";

const int = (v, d, min = 0) => {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`valeur entière ≥ ${min} attendue, reçu « ${v} »`);
  return n;
};

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const problems = [];
  const need = (name, why) => {
    const v = env[name];
    if (v && v.length >= 16) return v;
    if (production) problems.push(`${name} : ${why} (16 caractères au moins)`);
    return randomHex(16); // développement et tests : valeur aléatoire par processus
  };
  const plate = need("PLATE_PEPPER", "secret qui sert à calculer l'empreinte des plaques");
  const ip = need("IP_PEPPER", "secret qui sert à calculer l'empreinte des adresses IP");
  const origins = (env.ALLOWED_ORIGINS || (production ? "" : "*")).split(",").map((s) => s.trim()).filter(Boolean);
  if (production && !origins.length) problems.push("ALLOWED_ORIGINS : liste des origines autorisées, séparées par des virgules (ou « * »)");
  if (production && !env.DATABASE_URL) problems.push("DATABASE_URL : adresse de la base PostgreSQL");
  if (problems.length) throw new Error("Configuration incomplète :\n  - " + problems.join("\n  - "));

  const trust = (env.TRUST_PROXY || "0").toLowerCase();
  return {
    production,
    port: int(env.PORT, 8787),
    databaseUrl: env.DATABASE_URL || "",
    allowedOrigins: origins,
    plateSecret: plate,
    ipSecret: ip,
    // adresse du visiteur derrière un ou plusieurs relais : 0 = connexion directe, N = N relais de confiance (lecture de
    // X-Forwarded-For en partant de la droite), « cloudflare » = en-tête CF-Connecting-IP
    trustProxy: trust === "cloudflare" ? "cloudflare" : int(trust, 0),
    writeLimitPerHour: int(env.WRITE_LIMIT_PER_HOUR, 10, 1),
    writeLimitGlobalPerMinute: int(env.WRITE_LIMIT_GLOBAL_PER_MINUTE, 300, 1),
    readLimitPerMinute: int(env.READ_LIMIT_PER_MINUTE, 240, 1),
    upstreamMissLimitPerMinute: int(env.UPSTREAM_MISS_LIMIT_PER_MINUTE, 20, 1),
    overpassUserAgent: env.OVERPASS_USER_AGENT || "Pixcar/1.0 (+contact: configurer OVERPASS_USER_AGENT)",
    turnstileSecret: env.TURNSTILE_SECRET || "",
    moderation: env.MODERATION === "off" ? "off" : "auto",
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 10_000, 1000),
  };
}
