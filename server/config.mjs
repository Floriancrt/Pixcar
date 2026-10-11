// Configuration par variables d'environnement. En production, un secret manquant ou faible est une erreur de démarrage :
// mieux vaut ne pas démarrer que tourner avec une empreinte de plaques ou d'adresses IP devinable.
import { randomHex } from "./lib/crypto.mjs";

const int = (v, d, min = 0) => {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`valeur entière ≥ ${min} attendue, reçu « ${v} »`);
  return n;
};

// Durée de conservation des déclarations, en mois (24 par défaut : c'est la durée annoncée dans src/legal.json ; 0 = illimitée, déconseillé).
export const repairRetentionMonths = (env = process.env) => int(env.REPAIR_RETENTION_MONTHS, 24, 0);

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
  if (production && !env.DATABASE_URL && !env.DSQL_ENDPOINT) problems.push("DATABASE_URL (adresse de la base PostgreSQL) ou DSQL_ENDPOINT (adresse du cluster Aurora DSQL)");
  if (env.DATABASE_URL && env.DSQL_ENDPOINT) problems.push("DATABASE_URL et DSQL_ENDPOINT sont exclusifs : choisir une seule base");
  // pas de valeur par défaut en production : derrière un répartiteur, « 0 » ferait partager à tous les visiteurs la même limite de débit
  if (production && (env.TRUST_PROXY === undefined || env.TRUST_PROXY === "")) problems.push("TRUST_PROXY : 0 (visiteurs directs), N (derrière N relais de confiance) ou cloudflare — à choisir explicitement, sinon tous les visiteurs partagent une même limite de débit");
  // Espace Pro (vérification des garagistes) : coupé tant que PRO_ENABLED ne vaut pas 1. En production, il exige le groupe d'utilisateurs
  // Cognito et de vrais envois (SES pour l'e-mail, Notify pour le SMS) ; l'envoi simulé et l'en-tête de développement y sont refusés.
  const proEnabled = env.PRO_ENABLED === "1";
  const proSender = env.PRO_SENDER || (production ? "aws" : "memory");
  // moyens de vérification ouverts : on peut commencer par l'e-mail (SES) et ajouter le SMS quand Notify est prêt
  const proChannels = String(env.PRO_CHANNELS || "email,email_domain,sms").split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of proChannels) if (!["email", "email_domain", "sms"].includes(c)) problems.push(`PRO_CHANNELS : « ${c} » inconnu (email, email_domain, sms)`);
  if (production && proEnabled) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(env.COGNITO_USER_POOL_ID || "")) problems.push("COGNITO_USER_POOL_ID : groupe d'utilisateurs Amazon Cognito des comptes pro (ex. eu-north-1_AbC123)");
    if (!/^[a-z0-9]{10,64}$/i.test(env.COGNITO_CLIENT_ID || "")) problems.push("COGNITO_CLIENT_ID : client d'application Cognito de l'Espace Pro");
    if (proSender !== "aws") problems.push("PRO_SENDER : « aws » attendu en production (l'envoi simulé n'envoie rien)");
    if (proChannels.includes("sms") && !env.PRO_NOTIFY_CONFIGURATION_ID) problems.push("PRO_NOTIFY_CONFIGURATION_ID : configuration AWS End User Messaging Notify (SMS), ou retirer « sms » de PRO_CHANNELS");
    if (env.PRO_DEV_AUTH === "1") problems.push("PRO_DEV_AUTH : interdit en production");
  }
  if (problems.length) throw new Error("Configuration incomplète :\n  - " + problems.join("\n  - "));

  const trust = (env.TRUST_PROXY || "0").toLowerCase();
  return {
    production,
    port: int(env.PORT, 8787),
    databaseUrl: env.DATABASE_URL || "",
    // Aurora DSQL : l'API se connecte sous un rôle de base à moindre privilège (pixcar_api) ; « admin » est réservé aux migrations
    dsql: env.DSQL_ENDPOINT ? { endpoint: env.DSQL_ENDPOINT, user: env.DSQL_USER || "pixcar_api", max: int(env.DSQL_POOL_MAX, 2, 1) } : null,
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
    repairRetentionMonths: repairRetentionMonths(env),
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 10_000, 1000),
    pro: {
      enabled: proEnabled,
      userPoolId: env.COGNITO_USER_POOL_ID || "",
      clientId: env.COGNITO_CLIENT_ID || "",
      devAuth: !production && env.PRO_DEV_AUTH === "1", // en-tête x-pro-dev-account accepté à la place d'un jeton (développement seulement)
      sender: proSender,
      channels: proChannels,
      awsRegion: env.PRO_AWS_REGION || env.AWS_REGION || "eu-north-1",
      emailFrom: env.PRO_EMAIL_FROM || "Pixcar <verification@pixcar.fr>",
      contact: env.PRO_CONTACT || "contact@pixcar.fr",
      notifyConfigurationId: env.PRO_NOTIFY_CONFIGURATION_ID || "",
      notifyTemplateId: env.PRO_NOTIFY_TEMPLATE_ID || "notify-code-verification-french-009",
      sesConfigurationSet: env.PRO_SES_CONFIGURATION_SET || "",
      codeTtlSeconds: int(env.PRO_CODE_TTL_SECONDS, 600, 60),
      maxAttempts: int(env.PRO_MAX_ATTEMPTS, 5, 1),
      resendAfterSeconds: int(env.PRO_RESEND_AFTER_SECONDS, 60, 10),
      maxSendsPerClaim: int(env.PRO_MAX_SENDS_PER_CLAIM, 3, 1),
      maxPendingPerAccount: int(env.PRO_MAX_PENDING_PER_ACCOUNT, 3, 1),
      sendsPerGaragePerDay: int(env.PRO_SENDS_PER_GARAGE_PER_DAY, 3, 1),
      sendsPerAccountPerDay: int(env.PRO_SENDS_PER_ACCOUNT_PER_DAY, 5, 1),
      sendsGlobalPerHour: int(env.PRO_SENDS_GLOBAL_PER_HOUR, 30, 1),
      lookupsPerAccountPerHour: int(env.PRO_LOOKUPS_PER_ACCOUNT_PER_HOUR, 30, 1),
      maxDistanceM: int(env.PRO_MAX_DISTANCE_M, 300, 50),
    },
  };
}
