// Espace Pro : un compte (Amazon Cognito, sans mot de passe) prouve qu'il gère un garage.
//
//   GET  /v1/pro/me                      le compte et ses rattachements (vérifiés ou en cours)
//   GET  /v1/pro/siret/:siret            l'établissement (registre public) et les garages de nos données situés à son adresse, chacun avec
//                                        ses moyens de vérification MASQUÉS (e-mail public, e-mail sur le domaine du site, SMS)
//   POST /v1/pro/claims                  { siret, garageId, option, localPart? } : crée la demande et envoie le code par le moyen choisi
//   GET  /v1/pro/claims/:id              état d'une demande
//   POST /v1/pro/claims/:id/code         { code } : essai du code (5 au plus) ; le bon code rattache le garage au compte
//   POST /v1/pro/claims/:id/resend       nouveau code (60 s après le précédent ; 3 envois par demande)
//
// Une fois le garage rattaché (« Vos premiers prix ») :
//   GET    /v1/pro/garages/:id                    tableau de bord : prix annoncés, prix payés par ses clients (médianes), visites de sa fiche
//   PUT    /v1/pro/garages/:id/prices/:service    { kind, price, vehicles, includes } : annonce (ou remplace) un prix ; un prix très éloigné des
//                                                 prix payés du secteur attend une relecture avant publication
//   DELETE /v1/pro/garages/:id/prices/:service    retire un prix
//   POST   /v1/pro/garages/:id/confirm            « Tout confirmer » : les prix repartent pour 6 mois
// « Mon garage » (docs/rendez-vous.md, lot 1) :
//   GET    /v1/pro/garages/:id/profile            coordonnées connues, fiche déclarée, changements à relire ou décidés, prestations et temps moyens
//   PUT    /v1/pro/garages/:id/profile            { website?, email?, hours? } : publiés tout de suite
//   POST   /v1/pro/garages/:id/changes            { field: name | addr | phone, value } : changement relu par Pixcar avant publication
//   DELETE /v1/pro/garages/:id/changes/:change    annule un changement en attente
//   PUT    /v1/pro/garages/:id/services/:service  { offered, minutes } : prestation faite ou non, temps moyen ; décocher retire le prix annoncé
//   GET    /v1/pro/garages/:id/registry           l'établissement rattaché dans le registre public (lecture seule)
// Tableau de bord (docs/calendrier-avance.md, lot 3c) :
//   PUT    /v1/pro/garages/:id/prefs              { shortcuts?: [identifiants], view?: "simple" | "advanced" | null } : raccourcis et affichage de
//                                                 Gestion d'atelier de ce compte pour ce garage (GET /v1/pro/garages/:id les renvoie dans prefs)
// Rendez-vous en ligne (docs/rendez-vous.md, lot 2) : /v1/pro/garages/:id/rdv/… et /v1/rdv/… (server/rdv.mjs).
// Sans compte (le comparateur) :
//   GET    /v1/pro/public/garages?ids=a,b,…       garages vérifiés parmi ces identifiants (100 au plus), leurs prix publiés, leur fiche déclarée
//                                                 et les prestations qu'ils disent faire ou non (jamais les temps moyens)
//   POST   /v1/pro/public/visits                  { garageId, kind: view | call } : une visite de fiche ou une touche « Appeler » (garage vérifié)
//
// Règles : SIRET valide, actif, d'une activité de garage, et situé à moins de 300 m du garage (ou même code postal et même nom quand le
// registre n'a pas de position) ; le code part UNIQUEMENT vers un contact connu du garage par nos données (jamais saisi par le demandeur,
// sauf la partie locale d'une adresse sur le domaine propre au garage) ; code à 6 chiffres valable 10 minutes, gardé en empreinte ;
// sur 24 h, au plus 3 envois par compte vers un même garage, 10 vers un garage tous comptes confondus, 5 par compte ; 30 envois par heure pour
// tout le service ; un garage n'a qu'un compte vérifié.
// Quand un garage offre plusieurs moyens, c'est le demandeur qui choisit.
import { apiError, json, readJson } from "./lib/http.mjs";
import { hmac, toHex } from "./lib/crypto.mjs";
import { isUuid } from "./lib/validate.mjs";
import { createMemoryLimiter } from "./lib/ratelimit.mjs";
import { resolveOption, sameName, verificationOptions } from "./lib/contact.mjs";
import { GARAGE_NAF, NAF_LABELS, isSiret, lookupSiret, normalizeSiret } from "./lib/sirene.mjs";
import { AuthError, createCognitoVerifier } from "./lib/jwt.mjs";
import { createSenders, reviewEmailText } from "./lib/senders.mjs";
import { createProRepo } from "./pro-repo.mjs";
import { createRdv } from "./rdv.mjs";
import { PRO_SERVICES, freshness, parseProPrice, staleAt } from "../src/js/shared/pro-prices.js";
import { addrText, parseAddr, parseEmail, parseHours, parseMinutes, parseName, parsePhone, parseWebsite, phoneText } from "../src/js/shared/garage-profile.js";
import { DEFAULT_SHORTCUTS, parsePrefs } from "../src/js/shared/work.js";

const NO_STORE = { "cache-control": "no-store" };
const SIRENE_TTL_MS = 10 * 60_000;
const ACCOUNT_RE = /^[\w-]{1,128}$/;
const GARAGE_RE = /^[0-9a-f-]{8,40}$/; // identifiant Overture d'un lieu (celui des tuiles et de garage_contacts)
const PUBLIC_MAX_IDS = 100;
const DAY_MS = 864e5;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoOf = (v) => (v ? new Date(v).toISOString() : null);
const msOf = (v) => new Date(v).getTime();

// Code à 6 chiffres, uniforme (tirage rejeté au-dessus du plus grand multiple de 10⁶ représentable).
export function newCode() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

// « Qui êtes-vous ? » : prénom, nom, fonction, et la case « je certifie être habilité(e) à représenter cet établissement » (trace écrite en cas
// de litige). Aucun numéro de téléphone personnel n'est demandé.
const ROLES = ["manager", "employee", "other"];
const personName = (v) => String(v || "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
export function parseHolder(h) {
  if (!h || typeof h !== "object") return { error: "Indiquez vos prénom, nom et fonction." };
  const first = personName(h.firstName), last = personName(h.lastName);
  if (first.length < 1 || first.length > 60 || last.length < 1 || last.length > 60 || !/\p{L}/u.test(first + last)) return { error: "Prénom et nom : 60 caractères au plus chacun." };
  if (!ROLES.includes(h.role)) return { error: "Fonction : gérant(e), salarié(e) ou autre." };
  if (h.certify !== true) return { error: "Cochez la case qui certifie que vous êtes habilité(e) à représenter cet établissement." };
  return { name: `${first} ${last}`, role: h.role };
}

// Comparaison en temps constant de deux textes de même longueur (empreintes hexadécimales).
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Un prix annoncé tel que le tableau de bord le montre. state : « ok », « due » (à confirmer bientôt), « stale » (ancien), « review », « rejected ».
function priceView(p, nowMs) {
  const confirmed = msOf(p.confirmed_at);
  return {
    service: p.service_id,
    kind: p.kind,
    price: p.price_cents === null ? null : p.price_cents / 100,
    vehicles: p.vehicles || [],
    includes: p.includes || [],
    status: p.status,
    state: p.status === "published" ? freshness(confirmed, nowMs) : p.status,
    confirmedAt: isoOf(p.confirmed_at),
    staleAt: new Date(staleAt(confirmed)).toISOString(),
    updatedAt: isoOf(p.updated_at),
  };
}

// La fiche déclarée d'un garage, telle que « Mon garage » la montre (champs vides : rien de déclaré).
function profileView(p) {
  return {
    name: (p && p.name) || "",
    addr: p && p.street ? { street: p.street, pc: p.pc, city: p.city } : null,
    phone: (p && p.phone) || "",
    website: (p && p.website) || "",
    email: (p && p.email) || "",
    hours: (p && p.hours) || null,
    updatedAt: p ? isoOf(p.updated_at) : null,
  };
}
// Ce que le comparateur reçoit : seulement les champs publiés
function publicProfile(p) {
  if (!p) return null;
  const v = profileView(p);
  const out = {};
  for (const k of ["name", "addr", "phone", "website", "email", "hours"]) if (v[k] && (k !== "hours" || Object.keys(v[k]).length)) out[k] = v[k];
  return Object.keys(out).length ? out : null;
}
const changeView = (c) => ({
  id: c.id,
  field: c.field,
  value: c.field === "addr" ? JSON.parse(c.value) : c.value,
  status: c.status,
  ...(c.status === "rejected" && c.reason ? { reason: c.reason } : {}),
  createdAt: isoOf(c.created_at),
  ...(c.decided_at ? { decidedAt: isoOf(c.decided_at) } : {}),
});
const CHANGE_PARSERS = { name: parseName, addr: parseAddr, phone: parsePhone };
const CHANGE_LABELS = { name: "nom affiché", addr: "adresse", phone: "téléphone" };
const REVIEW_MAILS_PER_DAY = 5; // e-mails de relecture par garage et par 24 h : au-delà, la demande attend dans la file (op « pro-changes »)
const REVIEW_MAIL_TIMEOUT_MS = 4000;
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("délai dépassé")), ms); t.unref && t.unref(); })]);
const SERVICE_IDS = new Set(PRO_SERVICES.map((x) => x.id));

export function createPro({ db, config, fetchImpl = globalThis.fetch, now = Date.now, log = () => {}, senders, verifier, sirene } = {}) {
  const pro = config.pro;
  const repo = createProRepo(db);
  const send = senders || createSenders(pro, { production: config.production, log });
  const verify = verifier || (pro.userPoolId && pro.clientId ? createCognitoVerifier({ userPoolId: pro.userPoolId, clientId: pro.clientId, fetchImpl, now }) : null);
  // établissements d'essai d'abord (PRO_TEST_ESTABLISHMENTS, vide en temps normal), puis le registre public
  const registry = sirene || ((siret) => lookupSiret(siret, { fetchImpl }));
  const tests = pro.testEstablishments || new Map();
  const lookup = async (siret) => (tests.has(siret) ? tests.get(siret) : registry(siret));
  if (tests.size) log({ level: "warn", msg: "Espace Pro : établissements d'essai actifs (PRO_TEST_ESTABLISHMENTS)", count: tests.size });
  const lookups = createMemoryLimiter({ limit: pro.lookupsPerAccountPerHour, windowMs: 3600_000, now });
  const sireneCache = new Map(); // siret → { at, value }
  // secret des codes et des cibles : dérivé du secret des adresses IP (aucun nouveau secret à gérer), distinct de lui
  let secret = null;
  const proSecret = () => (secret ||= hmac(config.ipSecret, "pixcar/pro/v1").then(toHex));
  const digest = async (text) => toHex(await hmac(await proSecret(), text));
  const limits = { perGarageAccountPerDay: pro.sendsPerGarageAccountPerDay, perGaragePerDay: pro.sendsPerGaragePerDay, perAccountPerDay: pro.sendsPerAccountPerDay, globalPerHour: pro.sendsGlobalPerHour };
  // Plusieurs comptes demandent des codes pour un même garage en 24 h : litige ou tentative de blocage. Une ligne de journal dédiée
  // (event « pro_contested ») que la pile transforme en alarme par courriel ; la vérification manuelle tranche.
  // rendez-vous en ligne : mêmes envois d'e-mails, même secret pour les empreintes et les jetons des liens
  const rdv = createRdv({ db, config, now, log, send, secret: proSecret, proRepo: repo, newCode });
  const watch = (garageId, accounts) => {
    if (accounts >= 2) log({ level: "warn", msg: "garage demandé par plusieurs comptes", event: "pro_contested", garageId, accounts });
  };

  // ---- compte
  async function account(request) {
    if (pro.devAuth) {
      const dev = request.headers.get("x-pro-dev-account") || "";
      if (ACCOUNT_RE.test(dev)) return { sub: "dev-" + dev };
    }
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
    if (!m || !verify) return null;
    try {
      return await verify(m[1]);
    } catch (e) {
      if (e instanceof AuthError) return null;
      throw e;
    }
  }

  // ---- registre
  // Le registre n'est interrogé qu'une fois par SIRET et par 10 minutes ; chaque interrogation compte dans la limite du compte, que la
  // recherche vienne de GET /siret ou de POST /claims (sinon une suite de demandes ferait autant d'appels au registre).
  async function establishment(siret, sub) {
    const hit = sireneCache.get(siret);
    if (hit && now() - hit.at < SIRENE_TTL_MS) return hit.value;
    const check = lookups.check(sub);
    if (!check.ok) throw Object.assign(new Error("trop de recherches"), { limited: check.retryAfter });
    const value = await lookup(siret);
    sireneCache.set(siret, { at: now(), value });
    if (sireneCache.size > 500) sireneCache.delete(sireneCache.keys().next().value);
    return value;
  }

  // Établissement contrôlé + garages candidats, ou { error: Response }.
  async function checkSiret(raw, sub) {
    const siret = normalizeSiret(raw);
    if (!isSiret(siret)) return { error: apiError(400, "bad_siret", "Numéro SIRET invalide : 14 chiffres, clé de contrôle comprise.") };
    let e;
    try {
      e = await establishment(siret, sub);
    } catch (err) {
      if (err.limited) return { error: apiError(429, "rate_limited", "Trop de recherches de SIRET. Réessayez plus tard.", {}, { "retry-after": String(err.limited) }) };
      log({ level: "warn", msg: "registre des entreprises indisponible", error: err.message });
      return { error: apiError(503, "sirene_unavailable", "Le registre des entreprises ne répond pas. Réessayez dans quelques minutes.", {}, { "retry-after": "60" }) };
    }
    if (!e) return { error: apiError(404, "siret_not_found", "Ce SIRET est introuvable dans le registre des entreprises.") };
    if (!e.active) return { error: apiError(422, "siret_closed", "Cet établissement est fermé selon le registre des entreprises.") };
    if (!GARAGE_NAF.includes(e.naf)) return { error: apiError(422, "siret_activity", "L'activité déclarée de cet établissement n'est pas celle d'un garage.", { naf: e.naf }) };
    let near;
    if (e.lat !== null && e.lon !== null) near = await repo.contactsNear({ lat: e.lat, lon: e.lon, radiusM: pro.maxDistanceM });
    else if (e.pc) near = (await repo.contactsByPostcode(e.pc)).filter((g) => sameName(g.name, e.name) || sameName(g.name, e.company)).map((g) => ({ ...g, distanceM: null }));
    else near = [];
    // même nom d'abord, puis le plus proche
    near.sort((a, b) => Number(sameName(b.name, e.name) || sameName(b.name, e.company)) - Number(sameName(a.name, e.name) || sameName(a.name, e.company)) || (a.distanceM ?? 0) - (b.distanceM ?? 0));
    return { siret, establishment: e, garages: near };
  }

  async function garageView(g, sub) {
    const owner = await repo.verifiedOwner(g.garage_id);
    const domainShared = g.web_domain ? (await repo.domainCount(g.web_domain)) > 1 : false;
    return {
      id: g.garage_id,
      name: g.name,
      addr: g.addr,
      distanceM: g.distanceM ?? null,
      status: owner ? (owner.account_id === sub ? "mine" : "claimed") : "free",
      options: owner ? [] : openOptions(g, domainShared).map(({ id, channel, hint, domain }) => (domain ? { id, channel, hint, domain } : { id, channel, hint })),
    };
  }

  // moyens ouverts par la configuration (PRO_CHANNELS) parmi ceux que le garage permet
  const openOptions = (g, domainShared) => verificationOptions(g, { domainShared }).filter((o) => pro.channels.includes(o.channel));

  const claimView = (c) => {
    const dbNow = c.db_now ? new Date(c.db_now).getTime() : now();
    const sinceSend = c.last_sent_at ? (dbNow - new Date(c.last_sent_at).getTime()) / 1000 : Infinity;
    const live = c.status === "pending" && c.code_expires_at && new Date(c.code_expires_at).getTime() > dbNow;
    return {
      id: c.id,
      garageId: c.garage_id,
      garageName: c.garage_name || "",
      ...(c.garage_addr !== undefined ? { garageAddr: c.garage_addr || "" } : {}),
      status: c.status,
      channel: c.channel,
      hint: c.target_hint,
      holder: { name: c.holder_name, role: c.holder_role },
      ...(c.status === "pending"
        ? {
            codeLive: !!live,
            expiresInSeconds: live ? Math.max(0, Math.round((new Date(c.code_expires_at).getTime() - dbNow) / 1000)) : 0,
            resendInSeconds: Math.max(0, Math.ceil(pro.resendAfterSeconds - sinceSend)),
            resendsLeft: Math.max(0, pro.maxSendsPerClaim - c.sends),
            attemptsLeft: Math.max(0, pro.maxAttempts - c.attempts),
          }
        : {}),
      ...(c.verified_at ? { verifiedAt: new Date(c.verified_at).toISOString() } : {}),
    };
  };

  const limitedSend = (scope) =>
    apiError(
      429,
      "send_limited",
      scope === "global"
        ? "Trop de codes envoyés en ce moment. Réessayez dans une heure."
        : scope === "claim"
          ? "Plus de nouvel envoi possible pour cette demande. Recommencez la vérification ou choisissez un autre moyen."
          : scope === "garage_total"
            ? "Ce garage a reçu trop de codes aujourd'hui. Réessayez demain ou écrivez-nous pour une vérification manuelle."
            : "Limite de codes atteinte pour aujourd'hui. Réessayez demain ou demandez une vérification manuelle.",
      { scope },
      { "retry-after": scope === "global" ? "3600" : "86400" },
    );

  async function deliver({ claimId, channel, target, code, garageName }) {
    try {
      await send.send({ channel: channel === "sms" ? "sms" : "email", target, code, garageName });
      return true;
    } catch (e) {
      log({ level: "error", msg: "envoi du code impossible", channel, error: e.message });
      await repo.abandon(claimId).catch(() => {});
      return false;
    }
  }

  // ---- routes
  async function postClaim(request, sub) {
    const body = await readJson(request, 2048);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (2 Ko au plus).");
    const { siret, garageId, option, localPart, holder } = body.value || {};
    if (typeof garageId !== "string" || typeof option !== "string") return apiError(422, "validation", "garageId et option requis.");
    const who = parseHolder(holder);
    if (who.error) return apiError(422, "holder", who.error);
    const checked = await checkSiret(siret, sub);
    if (checked.error) return checked.error;
    const g = checked.garages.find((x) => x.garage_id === garageId);
    if (!g) return apiError(422, "siret_far", "Ce garage n'est pas à l'adresse de cet établissement. Une vérification manuelle reste possible.");
    const domainShared = g.web_domain ? (await repo.domainCount(g.web_domain)) > 1 : false;
    const chosen = openOptions(g, domainShared).some((o) => o.id === option) ? resolveOption(g, option, { localPart, domainShared }) : { error: "option" };
    if (chosen.error === "local_part") return apiError(422, "local_part", "Adresse invalide : lettres, chiffres, point, tiret ou souligné avant le @.");
    if (chosen.error) return apiError(422, "option", "Ce moyen de vérification n'est pas proposé pour ce garage.");

    const id = crypto.randomUUID();
    const code = newCode();
    const out = await repo.createClaim({
      id,
      accountId: sub,
      garageId,
      siret: checked.siret,
      channel: chosen.channel,
      holderName: who.name,
      holderRole: who.role,
      target: chosen.target,
      targetHash: await digest("target:" + chosen.target),
      targetHint: chosen.hint,
      codeHash: await digest(`${id}:${code}`),
      ttlSeconds: pro.codeTtlSeconds,
      maxPending: pro.maxPendingPerAccount,
      limits,
    });
    if (out.kind === "owned") return apiError(409, "already_claimed", "Ce garage est déjà géré par un autre compte. Écrivez-nous pour une vérification manuelle.", { contact: pro.contact });
    if (out.kind === "mine") return apiError(409, "already_yours", "Ce garage est déjà rattaché à votre compte.");
    if (out.kind === "too_many") return apiError(429, "too_many_pending", "Trop de vérifications en cours sur ce compte. Terminez-en une ou attendez 10 minutes.", {}, { "retry-after": "600" });
    if (out.kind === "limited") return limitedSend(out.scope);
    if (!(await deliver({ claimId: id, channel: chosen.channel, target: chosen.target, code, garageName: g.name })))
      return apiError(502, "send_failed", "Le code n'a pas pu être envoyé. Réessayez ou choisissez un autre moyen.");
    log({ level: "info", msg: "demande pro créée", channel: chosen.channel });
    watch(garageId, out.accounts);
    return json(201, claimView(await repo.getClaim(id, sub)), NO_STORE);
  }

  async function postCode(request, sub, id) {
    const body = await readJson(request, 512);
    if (body.error) return apiError(400, "bad_json", "JSON attendu.");
    const code = String((body.value && body.value.code) || "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return apiError(422, "validation", "Le code compte 6 chiffres.");
    const out = await repo.tryCode({ id, accountId: sub, maxAttempts: pro.maxAttempts, matches: async (stored) => sameText(stored, await digest(`${id}:${code}`)) });
    switch (out.kind) {
      case "verified":
      case "already":
        if (out.kind === "verified") log({ level: "info", msg: "garage rattaché à un compte pro" });
        return json(200, claimView(await repo.getClaim(id, sub)), NO_STORE);
      case "bad":
        return apiError(422, "bad_code", out.attemptsLeft > 1 ? `Code incorrect. Encore ${out.attemptsLeft} essais.` : "Code incorrect. Dernier essai.", { attemptsLeft: out.attemptsLeft });
      case "busy":
        return apiError(409, "busy", "Un autre essai est en cours. Réessayez.");
      case "locked":
        return apiError(423, "locked", "Trop de codes incorrects : cette demande est close. Recommencez la vérification.");
      case "expired":
        return apiError(410, "code_expired", "Ce code a expiré. Demandez-en un nouveau.");
      case "owned":
        return apiError(409, "already_claimed", "Ce garage vient d'être rattaché à un autre compte. Écrivez-nous pour une vérification manuelle.", { contact: pro.contact });
      case "closed":
        return apiError(409, "claim_closed", "Cette demande est close. Recommencez la vérification.");
      default:
        return apiError(404, "not_found", "Demande introuvable.");
    }
  }

  async function postResend(sub, id) {
    const code = newCode();
    const out = await repo.resend({
      id,
      accountId: sub,
      codeHash: await digest(`${id}:${code}`),
      ttlSeconds: pro.codeTtlSeconds,
      resendAfterSeconds: pro.resendAfterSeconds,
      maxSends: pro.maxSendsPerClaim,
      limits,
    });
    if (out.kind === "not_found") return apiError(404, "not_found", "Demande introuvable.");
    if (out.kind === "closed") return apiError(409, "claim_closed", "Cette demande est close. Recommencez la vérification.");
    if (out.kind === "wait") return apiError(429, "resend_too_soon", `Attendez ${out.retryAfter} s avant de redemander un code.`, { retryAfter: out.retryAfter }, { "retry-after": String(out.retryAfter) });
    if (out.kind === "limited") return limitedSend(out.scope);
    watch(out.garageId, out.accounts);
    const c = await repo.getClaim(id, sub);
    if (!(await deliver({ claimId: id, channel: out.channel, target: out.target, code, garageName: (c && c.garage_name) || "" })))
      return apiError(502, "send_failed", "Le code n'a pas pu être envoyé. Recommencez la vérification ou choisissez un autre moyen.");
    return json(200, claimView(await repo.getClaim(id, sub)), NO_STORE);
  }

  async function getSiret(sub, raw) {
    const checked = await checkSiret(raw, sub);
    if (checked.error) return checked.error;
    const e = checked.establishment;
    return json(
      200,
      {
        establishment: { siret: e.siret, name: e.name, company: e.company, addr: e.addr, naf: e.naf },
        garages: await Promise.all(checked.garages.slice(0, 10).map((g) => garageView(g, sub))),
      },
      NO_STORE,
    );
  }

  return {
    // Réponse pour un chemin /v1/pro/…, ou null si le chemin n'est pas de l'Espace Pro.
    async handle(request, path, ctx = {}) {
      const isRdv = path === "/v1/rdv" || path.startsWith("/v1/rdv/");
      if (!isRdv && path !== "/v1/pro" && !path.startsWith("/v1/pro/")) return null;
      try {
        if (isRdv) return await rdv.publicRoute(request, path, ctx);
        return await route(request, path, ctx);
      } catch (e) {
        // base ou registre injoignable : on échoue vite et proprement, comme le reste de l'API
        log({ level: "error", msg: "Espace Pro indisponible", error: e && e.message });
        return apiError(503, "unavailable", "Service momentanément indisponible. Réessayez dans quelques secondes.", {}, { "retry-after": "5" });
      }
    },
    maintenance: async () => ({ ...(await repo.purge()), ...(config.rdv.enabled ? await rdv.purge() : {}) }),
    rdv,
    repo,
    senders: send,
  };

  async function route(request, path, ctx) {
    if (!pro.enabled) return apiError(404, "pro_disabled", "L'Espace Pro n'est pas encore ouvert.");
    if (path.startsWith("/v1/pro/public/")) return publicRoute(request, path, ctx);
    let me;
    try {
      me = await account(request);
    } catch (e) {
      log({ level: "error", msg: "vérification du jeton impossible", error: e.message });
      return apiError(503, "unavailable", "Service momentanément indisponible.", {}, { "retry-after": "5" });
    }
    if (!me) return apiError(401, "unauthorized", "Connexion requise.", {}, { "www-authenticate": 'Bearer realm="pixcar-pro"' });
    const sub = me.sub;
    const method = request.method;
    let m;
    if (path === "/v1/pro/me") {
      if (method !== "GET") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "GET" });
      return json(200, { account: sub, claims: (await repo.listClaims(sub)).map(claimView) }, NO_STORE);
    }
    if ((m = /^\/v1\/pro\/siret\/([^/]+)$/.exec(path))) {
      if (method !== "GET") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "GET" });
      let raw = "";
      try {
        raw = decodeURIComponent(m[1]);
      } catch {} // pourcentage mal formé : le SIRET sera refusé
      return getSiret(sub, raw);
    }
    if (path === "/v1/pro/claims") {
      if (method !== "POST") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "POST" });
      return postClaim(request, sub);
    }
    if ((m = /^\/v1\/pro\/claims\/([^/]+)(\/code|\/resend)?$/.exec(path))) {
      const id = m[1].toLowerCase();
      if (!isUuid(id)) return apiError(404, "not_found", "Demande introuvable.");
      if (!m[2]) {
        if (method !== "GET") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "GET" });
        const c = await repo.getClaim(id, sub);
        return c ? json(200, claimView(c), NO_STORE) : apiError(404, "not_found", "Demande introuvable.");
      }
      if (method !== "POST") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "POST" });
      return m[2] === "/code" ? postCode(request, sub, id) : postResend(sub, id);
    }
    if ((m = /^\/v1\/pro\/garages\/([^/]+)\/rdv(\/.*)?$/.exec(path))) {
      const id = m[1].toLowerCase();
      if (!GARAGE_RE.test(id)) return noGarage();
      return rdv.garageRoute(request, sub, id, m[2] || "");
    }
    if ((m = /^\/v1\/pro\/garages\/([^/]+)\/(profile|registry|changes|services|prefs)(?:\/([^/]+))?$/.exec(path))) {
      const id = m[1].toLowerCase();
      if (!GARAGE_RE.test(id)) return noGarage();
      const [what, sub2] = [m[2], m[3]];
      const allow = (methods) => apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: methods });
      if (what === "profile" && !sub2) return method === "GET" ? getProfile(sub, id) : method === "PUT" ? putProfile(request, sub, id) : allow("GET, PUT");
      if (what === "registry" && !sub2) return method === "GET" ? getRegistry(sub, id) : allow("GET");
      if (what === "changes" && !sub2) return method === "POST" ? postChange(request, sub, id) : allow("POST");
      if (what === "changes") return method === "DELETE" ? deleteChange(sub, id, sub2) : allow("DELETE");
      if (what === "services" && sub2) return method === "PUT" ? putService(request, sub, id, sub2) : allow("PUT");
      if (what === "prefs" && !sub2) return method === "PUT" ? putPrefs(request, sub, id) : allow("PUT");
      return apiError(404, "not_found", "Route inconnue.");
    }
    if ((m = /^\/v1\/pro\/garages\/([^/]+)(?:\/(confirm)|\/prices\/([^/]+))?$/.exec(path))) {
      const id = m[1].toLowerCase();
      if (!GARAGE_RE.test(id)) return noGarage();
      if (m[2]) return method === "POST" ? postConfirm(sub, id) : apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "POST" });
      if (m[3]) {
        if (method === "PUT") return putPrice(request, sub, id, m[3]);
        if (method === "DELETE") return deletePrice(sub, id, m[3]);
        return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "PUT, DELETE" });
      }
      if (method !== "GET") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "GET" });
      return getGarage(sub, id);
    }
    return apiError(404, "not_found", "Route inconnue.");
  }

  // ---- « Vos premiers prix » : seulement sur un garage rattaché à CE compte (sinon : introuvable, sans dire s'il existe)
  function noGarage() {
    return apiError(404, "not_found", "Garage introuvable, ou pas rattaché à ce compte.");
  }

  async function getGarage(sub, id) {
    const owned = await repo.ownedGarage(id, sub);
    if (!owned) return noGarage();
    const nowMs = now();
    const [prices, paid, visits, profile, prefs] = await Promise.all([
      repo.listPrices(id),
      repo.paidPrices(owned.contact),
      repo.visitStats(id, { since30: isoDay(nowMs - 30 * DAY_MS), since60: isoDay(nowMs - 60 * DAY_MS) }),
      repo.getProfile(id),
      repo.getPrefs(id, sub),
    ]);
    const c = owned.contact || {};
    const p = profileView(profile); // un nom ou une adresse relus par Pixcar remplacent ceux des données
    return json(
      200,
      {
        garage: { id, name: p.name || c.name || "", addr: p.addr ? addrText(p.addr) : c.addr || "", verifiedAt: isoOf(owned.claim.verified_at), holderName: owned.claim.holder_name },
        prices: prices.map((p) => priceView(p, nowMs)),
        paid,
        visits: { views: visits.view, calls: visits.call },
        prefs: prefs || { shortcuts: DEFAULT_SHORTCUTS, view: null },
        ...(config.rdv.enabled ? { rdv: await rdv.summary(id) } : {}),
      },
      NO_STORE,
    );
  }

  async function putPrice(request, sub, id, rawService) {
    const body = await readJson(request, 1024);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (1 Ko au plus).");
    let serviceId = "";
    try {
      serviceId = decodeURIComponent(rawService);
    } catch {} // pourcentage mal formé : prestation inconnue
    const parsed = parseProPrice(serviceId, body.value);
    if (parsed.error) return apiError(422, "validation", parsed.error, { field: parsed.field });
    const owned = await repo.ownedGarage(id, sub);
    if (!owned) return noGarage();
    const v = parsed.value;
    const area = owned.contact ? { y: owned.contact.area_y, x: owned.contact.area_x } : null;
    const row = await repo.savePrice({ garageId: id, serviceId: v.serviceId, kind: v.kind, priceCents: v.priceCents, vehicles: v.vehicles, includes: v.includes, accountId: sub, area });
    if (row.status === "review") log({ level: "info", msg: "prix annoncé à relire", event: "pro_price_review", garageId: id, serviceId: v.serviceId });
    return json(200, priceView(row, now()), NO_STORE);
  }

  async function deletePrice(sub, id, rawService) {
    let serviceId = "";
    try {
      serviceId = decodeURIComponent(rawService);
    } catch {}
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    return (await repo.deletePrice(id, serviceId)) ? new Response(null, { status: 204, headers: NO_STORE }) : apiError(404, "not_found", "Aucun prix pour cette prestation.");
  }

  // raccourcis du tableau de bord (lot 3c)
  async function putPrefs(request, sub, id) {
    const body = await readJson(request, 1024);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (1 Ko au plus).");
    const parsed = parsePrefs(body.value);
    if (parsed.error) return apiError(422, "validation", parsed.error, { field: parsed.field });
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    await repo.savePrefs(id, sub, parsed.value, DEFAULT_SHORTCUTS);
    return json(200, (await repo.getPrefs(id, sub)) || { shortcuts: DEFAULT_SHORTCUTS, view: null }, NO_STORE);
  }

  async function postConfirm(sub, id) {
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    return json(200, { confirmed: await repo.confirmPrices(id) }, NO_STORE);
  }

  // ---- « Mon garage »
  async function getProfile(sub, id) {
    const owned = await repo.ownedGarage(id, sub);
    if (!owned) return noGarage();
    const [profile, changes, services] = await Promise.all([repo.getProfile(id), repo.listChanges(id), repo.listServices(id)]);
    const c = owned.contact || {};
    const byService = new Map(services.map((x) => [x.service_id, x]));
    return json(
      200,
      {
        // ce que les données publiques disent du garage (OpenStreetMap, Overture) ; jamais ses contacts privés (e-mails et numéros de vérification)
        garage: { id, name: c.name || "", addr: c.addr || "", pc: c.pc || "" },
        profile: profileView(profile),
        changes: changes.map(changeView),
        services: PRO_SERVICES.map((x) => {
          const r = byService.get(x.id);
          return { service: x.id, offered: r ? r.offered : null, minutes: r && r.minutes !== null ? r.minutes : null };
        }),
      },
      NO_STORE,
    );
  }

  async function putProfile(request, sub, id) {
    const body = await readJson(request, 4096);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (4 Ko au plus).");
    const b = body.value && typeof body.value === "object" && !Array.isArray(body.value) ? body.value : null;
    if (!b) return apiError(422, "validation", "Objet attendu : { website, email, hours }.");
    const parsers = { website: parseWebsite, email: parseEmail, hours: parseHours };
    const fields = {};
    for (const [k, v] of Object.entries(b)) {
      if (!parsers[k]) return apiError(422, "validation", `Champ inconnu : ${String(k).slice(0, 20)}. Nom, adresse et téléphone passent par une demande de changement.`, { field: k });
      const out = parsers[k](v);
      if (out.error) return apiError(422, "validation", out.error, { field: k });
      fields[k] = out.value;
    }
    if (!Object.keys(fields).length) return apiError(422, "validation", "Rien à enregistrer.");
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    return json(200, profileView(await repo.saveProfile(id, sub, fields)), NO_STORE);
  }

  async function postChange(request, sub, id) {
    const body = await readJson(request, 1024);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (1 Ko au plus).");
    const { field, value } = body.value || {};
    const parse = Object.hasOwn(CHANGE_PARSERS, String(field)) ? CHANGE_PARSERS[field] : null;
    if (!parse) return apiError(422, "validation", "Champ : name, addr ou phone.", { field: "field" });
    const out = parse(value);
    if (out.error) return apiError(422, "validation", out.error, { field });
    const owned = await repo.ownedGarage(id, sub);
    if (!owned) return noGarage();
    const current = profileView(await repo.getProfile(id));
    const same = field === "addr" ? current.addr && addrText(current.addr) === addrText(out.value) : current[field] === out.value;
    if (same) return apiError(422, "unchanged", "C'est déjà la valeur de votre fiche.", { field });
    const row = await repo.requestChange({ id: crypto.randomUUID(), garageId: id, field, value: field === "addr" ? JSON.stringify(out.value) : out.value, accountId: sub });
    log({ level: "info", msg: "changement de fiche à relire", event: "pro_change_review", garageId: id, field });
    await reviewMail({ garageId: id, owned, current, field, value: out.value, row });
    return json(201, changeView(row), NO_STORE);
  }

  // Prévient Pixcar (adresse PRO_CONTACT) qu'un changement attend sa relecture. Jamais bloquant : un échec ou un dépassement du plafond
  // est journalisé, la demande du garagiste reste enregistrée et visible avec l'op « pro-changes ».
  async function reviewMail({ garageId, owned, current, field, value, row }) {
    if (typeof send.mail !== "function" || !pro.contact) return;
    try {
      if ((await repo.countRecentChanges(garageId)) > REVIEW_MAILS_PER_DAY) {
        log({ level: "warn", msg: "changement à relire : plafond d'e-mails atteint pour ce garage", event: "pro_change_review_mail_skipped", garageId });
        return;
      }
      const c = owned.contact || {};
      const shown = (v) => (field === "addr" ? addrText(v) : field === "phone" ? phoneText(v) : v);
      const publicAddr = [c.addr, c.pc].filter(Boolean).join(", ");
      const currentText = current[field]
        ? `${shown(current[field])} (déjà vérifié par Pixcar)`
        : field === "name" && c.name
          ? `${c.name} (données publiques)`
          : field === "addr" && publicAddr
            ? `${publicAddr} (données publiques)`
            : "aucune valeur déclarée";
      const { subject, text } = reviewEmailText({
        garageName: current.name || c.name || garageId,
        garageId,
        siret: owned.claim.siret,
        fieldLabel: CHANGE_LABELS[field],
        current: currentText,
        requested: shown(value),
        changeId: row.id,
        at: row.created_at || now(),
      });
      await withTimeout(send.mail({ to: pro.contact, subject, text }), REVIEW_MAIL_TIMEOUT_MS);
      log({ level: "info", msg: "changement à relire : e-mail envoyé à Pixcar", event: "pro_change_review_mail", garageId, field });
    } catch (e) {
      log({ level: "warn", msg: "changement à relire : e-mail non envoyé", event: "pro_change_review_mail_failed", garageId, error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  async function deleteChange(sub, id, rawChange) {
    const changeId = String(rawChange || "").toLowerCase();
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    if (!isUuid(changeId) || !(await repo.cancelChange(id, changeId))) return apiError(404, "not_found", "Aucun changement en attente avec cet identifiant.");
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  async function putService(request, sub, id, rawService) {
    const body = await readJson(request, 256);
    if (body.error) return apiError(400, "bad_json", "JSON attendu.");
    let serviceId = "";
    try {
      serviceId = decodeURIComponent(rawService);
    } catch {} // pourcentage mal formé : prestation inconnue
    if (!SERVICE_IDS.has(serviceId)) return apiError(422, "validation", "Prestation inconnue.", { field: "service" });
    const { offered, minutes } = body.value || {};
    if (typeof offered !== "boolean") return apiError(422, "validation", "offered : true (je la fais) ou false.", { field: "offered" });
    const m = parseMinutes(minutes);
    if (m.error) return apiError(422, "validation", m.error, { field: "minutes" });
    if (!(await repo.ownedGarage(id, sub))) return noGarage();
    const out = await repo.saveService({ garageId: id, serviceId, offered, minutes: m.value });
    return json(200, { service: out.row.service_id, offered: out.row.offered, minutes: out.row.minutes, priceRemoved: out.priceRemoved }, NO_STORE);
  }

  async function getRegistry(sub, id) {
    const owned = await repo.ownedGarage(id, sub);
    if (!owned) return noGarage();
    let e;
    try {
      e = await establishment(owned.claim.siret, sub);
    } catch (err) {
      if (err.limited) return apiError(429, "rate_limited", "Trop de lectures du registre. Réessayez plus tard.", {}, { "retry-after": String(err.limited) });
      log({ level: "warn", msg: "registre des entreprises indisponible", error: err.message });
      return apiError(503, "sirene_unavailable", "Le registre des entreprises ne répond pas. Réessayez dans quelques minutes.", {}, { "retry-after": "60" });
    }
    if (!e) return apiError(404, "siret_not_found", "Cet établissement n'est plus dans le registre des entreprises.");
    return json(200, { siret: e.siret, name: e.name, company: e.company, addr: e.addr, naf: e.naf, nafLabel: NAF_LABELS[e.naf] || "", active: e.active }, NO_STORE);
  }

  // ---- sans compte : ce que le comparateur montre (badge, prix annoncés) et ce qu'il compte (visites des fiches)
  async function publicRoute(request, path, ctx) {
    const method = request.method;
    if (path === "/v1/pro/public/garages") {
      if (method !== "GET") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "GET" });
      const raw = new URL(request.url).searchParams.get("ids") || "";
      const ids = [...new Set(raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
      if (!ids.length || ids.length > PUBLIC_MAX_IDS || !ids.every((x) => GARAGE_RE.test(x)))
        return apiError(400, "bad_request", `ids : de 1 à ${PUBLIC_MAX_IDS} identifiants de garages, séparés par des virgules.`);
      const nowMs = now();
      const garages = (await repo.publicGarages(ids)).map((g) => ({
        id: g.garage_id,
        verified: true,
        prices: g.prices.map((p) => ({
          service: p.service_id,
          kind: p.kind,
          price: p.price_cents === null ? null : p.price_cents / 100,
          vehicles: p.vehicles || [],
          includes: p.includes || [],
          updated: isoDay(msOf(p.confirmed_at)),
          stale: freshness(msOf(p.confirmed_at), nowMs) === "stale",
        })),
        ...(publicProfile(g.profile) ? { profile: publicProfile(g.profile) } : {}),
        ...(g.services.length
          ? {
              services: Object.fromEntries(
                [
                  ["offered", g.services.filter((x) => x.offered).map((x) => x.service_id)],
                  ["notOffered", g.services.filter((x) => !x.offered).map((x) => x.service_id)],
                ].filter(([, list]) => list.length),
              ),
            }
          : {}),
      }));
      // rendez-vous en ligne : les prestations qu'un garage prend en ligne avec un horaire libre dans les 14 jours
      if (config.rdv.enabled && garages.length) {
        const open = await rdv.openServices(garages.map((g) => g.id));
        for (const g of garages) if (open.has(g.id)) g.rdv = open.get(g.id);
      }
      return json(200, { garages }, { "cache-control": "public, max-age=60" });
    }
    if (path === "/v1/pro/public/visits") {
      if (method !== "POST") return apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: "POST" });
      const body = await readJson(request, 256);
      if (body.error) return apiError(400, "bad_json", "JSON attendu.");
      const { garageId, kind } = body.value || {};
      if (typeof garageId !== "string" || !GARAGE_RE.test(garageId.toLowerCase()) || (kind !== "view" && kind !== "call"))
        return apiError(422, "validation", "garageId (identifiant du garage) et kind (view ou call) requis.");
      const id = garageId.toLowerCase();
      const day = isoDay(now());
      // un visiteur compte une fois par jour, par garage et par type ; l'empreinte change chaque jour et pour chaque garage
      await repo.recordVisit({ garageId: id, day, kind, visitor: await digest(`visit:${ctx.ip || "unknown"}:${id}:${day}`) });
      return new Response(null, { status: 204, headers: NO_STORE });
    }
    return apiError(404, "not_found", "Route inconnue.");
  }
}
