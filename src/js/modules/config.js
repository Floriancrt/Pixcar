// Configuration de la page, lue dans le document : adresse de l'API des réparations, dossier des tuiles de la table de garages.
//   <meta name="pixcar-api" content="https://api.example.fr">   (renseignée au build : PIXCAR_API_BASE=… npm run build)
// Sans adresse, la page reste en mode local : les réparations ne quittent pas le navigateur.
// window.JG_TUNE.api permet de la remplacer (tests).
export function apiBase() {
  let raw = "";
  try {
    const tune = globalThis.JG_TUNE && globalThis.JG_TUNE.api;
    const meta = document.querySelector('meta[name="pixcar-api"]');
    raw = String(tune || (meta && meta.content) || "").trim();
    if (!raw) return "";
    const url = new URL(raw, location.href);
    // jamais autre chose que http(s) ; http n'est admis que pour le développement local
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// Dossier des tuiles de la table de garages : <meta name="pixcar-garages" content="garages/">, posée au build quand le site est construit avec des tuiles
// (node scripts/build.mjs --garages <dossier>). Seul un chemin relatif au site est admis, jamais un autre hôte (la politique de sécurité ne l'autoriserait pas).
// Vide : la table est inactive. window.JG_GARAGES_BASE remplace la balise (essais) ; window.JG_GARAGES_BASE = "" l'éteint.
export function garagesBase() {
  try {
    const tune = globalThis.JG_GARAGES_BASE;
    const meta = document.querySelector('meta[name="pixcar-garages"]');
    const raw = String(typeof tune === "string" ? tune : (meta && meta.content) || "").trim();
    return /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\/?$/i.test(raw) ? raw.replace(/\/*$/, "/") : "";
  } catch {
    return "";
  }
}
