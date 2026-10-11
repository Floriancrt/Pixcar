// Mesure d'audience (Google Analytics 4, « balise Google » gtag.js) avec consentement préalable.
//
// Tant que le visiteur n'a pas accepté, rien ne part chez Google et aucun cookie n'est déposé : l'extrait fourni par Google (un script en
// ligne et un script de googletagmanager.com) est reproduit ici et exécuté seulement après l'accord, depuis le script de la page (la
// politique de sécurité du contenu interdit tout script en ligne). Le choix est gardé six mois dans le navigateur (localStorage, clé
// jg.consent.v1) puis redemandé ; il se change à tout moment (fenêtre « Confidentialité et mentions légales », lien « Mesure d'audience »
// du bas du panneau) et un refus supprime les cookies de Google et coupe l'envoi. Fermer le bandeau sans répondre (Échap) ou continuer
// à naviguer ne vaut pas consentement : rien ne part, le bandeau revient à la visite suivante.
//
// Actif seulement si la page porte <meta name="pixcar-analytics" content="G-…"> (renseignée au build : src/analytics.json pour la version
// publiée, ou PIXCAR_GA_ID, voir scripts/build.mjs) ; sinon ce module ne fait rien : la page ouverte depuis le disque, le développement et
// les tests n'envoient rien à Google.
//
// Contentsquare (analyse de l'utilisation des pages : clics, défilements, enregistrement des sessions) suit le même choix : son tag
// (t.contentsquare.net/uxa/<identifiant>.js, <meta name="pixcar-contentsquare">) n'est ajouté qu'après l'accord ; un refus lui demande de
// s'arrêter (commande « optout ») et supprime ses cookies « _cs_… » (sauf _cs_optout, qui ne garde que le refus). Les deux outils peuvent
// être branchés séparément : le bandeau existe dès qu'il y en a un.

export const CHOICE_KEY = "jg.consent.v1";
export const CHOICE_DAYS = 183; // six mois : durée de validité d'un choix (accepté ou refusé), ensuite on redemande
export const COOKIE_SECONDS = 34128000; // 395 jours (13 mois) : la durée maximale des cookies selon la CNIL ; Google Analytics 4 : 2 ans par défaut
const ID_FORMAT = /^G-[A-Z0-9]{6,12}$/;
const DAY = 864e5;
const LIBRARY = "https://www.googletagmanager.com/gtag/js?id=";
const CS_FORMAT = /^[0-9a-f]{8,20}$/;
const CS_TAG = "https://t.contentsquare.net/uxa/";
const LABEL = { granted: "accepté", denied: "refusé", unset: "pas encore fait" };

// Identifiant de mesure (« G-XXXXXXXXXX ») lu dans la page ; vide s'il manque ou n'a pas la bonne forme.
export function measurementId(doc = document) {
  const meta = doc.querySelector('meta[name="pixcar-analytics"]');
  const id = String((meta && meta.content) || "").trim();
  return ID_FORMAT.test(id) ? id : "";
}

// Identifiant du tag Contentsquare lu dans la page (le nom du fichier du tag) ; vide s'il manque ou n'a pas la bonne forme.
export function contentsquareId(doc = document) {
  const meta = doc.querySelector('meta[name="pixcar-contentsquare"]');
  const id = String((meta && meta.content) || "").trim();
  return CS_FORMAT.test(id) ? id : "";
}

// Choix gardé : « granted », « denied », ou null (jamais répondu, plus vieux que six mois, daté du futur, illisible).
export function readChoice(storage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(CHOICE_KEY));
    if (!saved || typeof saved.analytics !== "boolean" || !Number.isFinite(saved.at)) return null;
    if (saved.at > now + DAY || now - saved.at > CHOICE_DAYS * DAY) return null;
    return saved.analytics ? "granted" : "denied";
  } catch {
    return null;
  }
}

export function saveChoice(storage, granted, now = Date.now()) {
  try {
    storage.setItem(CHOICE_KEY, JSON.stringify({ analytics: !!granted, at: now }));
    return true;
  } catch {
    return false; // stockage refusé (navigation privée…) : le choix vaut pour cette page seulement, le bandeau reviendra
  }
}

// Noms des cookies de Google Analytics présents dans document.cookie : « _ga », « _ga_<flux> » (Analytics 4), et les anciens « _gid », « _gat… ».
export function googleCookieNames(cookieString) {
  const names = String(cookieString)
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter((name) => /^(_ga|_ga_[A-Za-z0-9]+|_gid|_gat(_.*)?)$/.test(name));
  return [...new Set(names)];
}

// Noms des cookies de Contentsquare présents dans document.cookie : tous commencent par « _cs_ » (_cs_id, _cs_s, _cs_c, _cs_optout…).
export function contentsquareCookieNames(cookieString) {
  const names = String(cookieString)
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter((name) => /^_cs_[A-Za-z0-9_.-]+$/.test(name));
  return [...new Set(names)];
}

// Domaines où Google a pu déposer un cookie : « www.pixcar.fr » → www.pixcar.fr, pixcar.fr (jamais « fr »). Rien pour une adresse IP ni « localhost ».
export function cookieDomains(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host.includes(".") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) return [];
  const parts = host.split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

export function initAnalytics(doc = document, win = typeof window === "undefined" ? undefined : window) {
  const id = win ? measurementId(doc) : "";
  const csId = win ? contentsquareId(doc) : "";
  if (!id && !csId) return null;
  let storage = null;
  try {
    storage = win.localStorage;
  } catch {
    storage = null;
  }
  const banner = doc.getElementById("consent");
  const root = doc.documentElement;
  let choice = storage ? readChoice(storage) : null;
  let shown = choice === null; // bandeau affiché tant que le visiteur n'a rien décidé
  let loaded = false;
  let csLoaded = false;
  let returnTo = null;

  const render = () => {
    root.dataset.analytics = choice || "unset"; // état lisible par le CSS et les tests (jamais « data-consent » : ce nom est celui des boutons)
    if (banner) banner.hidden = !shown;
    doc.querySelectorAll("button[data-consent][aria-pressed]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.consent === (choice === "granted" ? "grant" : choice === "denied" ? "deny" : ""))));
    doc.querySelectorAll("[data-consent-label]").forEach((el) => (el.textContent = LABEL[choice || "unset"]));
  };

  // Accord : l'extrait de Google, à l'identique (consent par défaut en plus : seule la mesure d'audience est permise, ni publicité ni profils),
  // puis le chargement de gtag.js. Une seconde acceptation dans la même page rallume l'envoi sans recharger la bibliothèque.
  const params = { cookie_expires: COOKIE_SECONDS, allow_google_signals: false, allow_ad_personalization_signals: false };
  const enableGoogle = () => {
    win["ga-disable-" + id] = false;
    if (loaded) {
      win.gtag("consent", "update", { analytics_storage: "granted" });
      win.gtag("config", id, params);
      return;
    }
    loaded = true;
    const layer = (win.dataLayer = win.dataLayer || []);
    win.gtag = function () {
      layer.push(arguments); // l'objet « arguments » lui-même, pas un tableau : c'est ce que gtag.js sait lire
    };
    win.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
    win.gtag("js", new Date());
    win.gtag("config", id, params);
    const script = doc.createElement("script");
    script.async = true;
    script.src = LIBRARY + encodeURIComponent(id);
    doc.head.appendChild(script);
  };

  // Contentsquare : la file de commandes « _uxa » (le tag la lit à son arrivée), le consentement donné (utile si le projet Contentsquare
  // l'exige avant de mesurer), puis le tag. Après un refus (ici ou à une visite précédente : cookie _cs_optout), « optin » le relance.
  const enableContentsquare = () => {
    const queue = (win._uxa = win._uxa || []);
    if (csLoaded || contentsquareCookieNames(doc.cookie).includes("_cs_optout")) queue.push(["optin"]);
    queue.push(["trackConsentGranted"]);
    if (csLoaded) return;
    csLoaded = true;
    const script = doc.createElement("script");
    script.async = true;
    script.src = CS_TAG + csId + ".js";
    doc.head.appendChild(script);
  };
  const enable = () => {
    if (id) enableGoogle();
    if (csId) enableContentsquare();
  };

  const forget = (names, hosts) => {
    for (const name of names) {
      doc.cookie = `${name}=; Max-Age=0; Path=/`;
      for (const host of hosts) doc.cookie = `${name}=; Max-Age=0; Path=/; Domain=${host}`;
    }
  };
  // Refus ou retrait : l'envoi est coupé (l'interrupteur officiel « ga-disable-<identifiant> » ; la commande « optout » de Contentsquare),
  // les cookies des deux outils sont supprimés (sauf _cs_optout, posé par « optout » : il ne contient que le refus).
  const disable = () => {
    const hosts = cookieDomains(win.location && win.location.hostname);
    if (id) {
      win["ga-disable-" + id] = true;
      if (loaded) win.gtag("consent", "update", { analytics_storage: "denied" });
      forget(googleCookieNames(doc.cookie), hosts);
    }
    if (csId) {
      if (csLoaded) (win._uxa = win._uxa || []).push(["optout"]);
      forget(contentsquareCookieNames(doc.cookie).filter((name) => name !== "_cs_optout"), hosts);
    }
  };

  const decide = (granted) => {
    choice = granted ? "granted" : "denied";
    if (storage) saveChoice(storage, granted);
    shown = false;
    granted ? enable() : disable();
    render();
    if (returnTo && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  };
  const reopen = (opener) => {
    returnTo = opener;
    shown = true;
    render();
    const first = banner && banner.querySelector("button");
    if (first) first.focus();
  };
  const dismiss = () => {
    shown = false;
    render();
    if (returnTo && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  };

  doc.addEventListener("click", (e) => {
    const from = e.target && e.target.closest ? e.target : null;
    if (!from) return;
    const button = from.closest("button[data-consent]");
    if (button) return decide(button.dataset.consent === "grant");
    const opener = from.closest("[data-consent-open]");
    if (opener) return reopen(opener);
    if (from.closest("[data-consent-more]")) win.requestAnimationFrame(() => doc.getElementById("lg-audience")?.scrollIntoView({ block: "start" })); // la fenêtre s'ouvre (modules/legal.js) : on va à la section
  });
  if (banner) banner.addEventListener("keydown", (e) => e.key === "Escape" && dismiss());

  if (choice === "granted") enable();
  render();
  return { id, csId, choice: () => choice };
}
