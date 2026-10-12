#!/usr/bin/env node
// Build de la page Pixcar.
//
//   node scripts/build.mjs          production : JS/CSS minifiés
//   node scripts/build.mjs --dev    lisible : rien n'est minifié
//   node scripts/build.mjs --check  reconstruit à part et vérifie que index.html et dist/ du dépôt sont à jour (sort en erreur sinon)
//   options : --only single|dist · --src <dossier des sources> · --out <dossier de sortie>   (utilisées par les tests de mutation)
//             --pages <domaine>  sortie dist/ pour GitHub Pages (ex. pixcar.fr) : pas de _headers (GitHub Pages les ignore), la politique
//                                de sécurité du contenu passe par une balise <meta> dans la page, + CNAME et .nojekyll
//             --garages <dossier> joint à dist/ (dist/garages/) les tuiles de la table de garages construites par scripts/garages/build.py : la page
//                                les charge à côté d'OpenStreetMap, et les textes de sources et de confidentialité en parlent. Sans cette option, la table
//                                est inactive (balise pixcar-garages vide) et les textes n'en disent rien. Jamais jointes (ni citées dans les textes) à la page tout-en-un.
//
// Variable d'environnement : PIXCAR_API_BASE = URL de l'API des réparations (vide : stockage dans le navigateur).
//                            PIXCAR_ALLOW_NO_LEGAL=1 : construire avec l'API même si src/legal.json est incomplet (essai seulement, voir legalParts).
//                            PIXCAR_GA_ID = identifiant de mesure Google Analytics (« G-… ») : bandeau de consentement, texte de confidentialité
//                            et politique de sécurité en tiennent compte. Sans cette variable, la version publiée (--pages) prend celui de
//                            src/analytics.json ; les autres sorties n'en ont aucun. PIXCAR_GA_ID= (vide) le désactive même avec --pages.
//                            PIXCAR_CS_ID = identifiant du tag Contentsquare (le nom du fichier de t.contentsquare.net/uxa/<identifiant>.js) : chargé
//                            après le même accord que Google Analytics (un seul choix « mesure d'audience »). Sans cette variable, la version publiée
//                            (--pages) prend contentsquareId de src/analytics.json ; les autres sorties n'en ont aucun. PIXCAR_CS_ID= (vide) le désactive.
//                            PIXCAR_MAPBOX_TOKEN = jeton PUBLIC Mapbox (« pk.… ») : fond de carte Mapbox. Sans cette variable, la version publiée (--pages)
//                            prend celui de src/mapbox.json (vide tant qu'il n'est pas renseigné : fond de l'IGN) ; les autres sorties n'en ont aucun.
//                            PIXCAR_MAPBOX_TOKEN= (vide) le désactive même avec --pages. PIXCAR_MAPBOX_STYLE = style (« mapbox/light-v11 »).
//                            PIXCAR_MAPBOX_ENRICH = « off », « map » (par défaut) ou « always » : fiches complétées par Mapbox (téléphone, horaires, site), voir src/mapbox.json.
//                            PIXCAR_PRO_POOL, PIXCAR_PRO_CLIENT = groupe d'utilisateurs et client d'application Amazon Cognito de l'Espace Pro : avec eux (et l'API),
//                            dist/ reçoit la page pro/ (connexion sans mot de passe, rattachement d'un garage). Sans ces variables, la version publiée
//                            (--pages) prend celles de src/pro.json (vides tant que l'Espace Pro n'est pas ouvert : pas de page pro/) ; les autres sorties n'en ont pas.
//
// Deux sorties à partir des mêmes sources :
//   index.html   page tout-en-un (CSS, JS, police et icônes en ligne) : s'ouvre depuis le disque, se déploie n'importe où ;
//   dist/        site publiable : fichiers séparés à nom haché (cache « immutable »), police locale, Leaflet local,
//                service worker (coque hors ligne), en-têtes de cache et de sécurité (_headers : Netlify, Cloudflare Pages),
//                robots.txt. L'adresse de l'API (PIXCAR_API_BASE) y est aussi dans la politique de sécurité du contenu.
import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const check = process.argv.includes("--check");
const SRC = resolve(arg("src") || join(ROOT, "src"));
const OUT = check ? await mkdtemp(join(tmpdir(), "pixcar-build-")) : resolve(arg("out") || ROOT);
const DIST = join(OUT, "dist");
const only = arg("only"); // « single » ou « dist » : une seule sortie
const pages = arg("pages"); // domaine servi par GitHub Pages : voir l'en-tête de ce fichier
const garagesDir = arg("garages"); // dossier de tuiles de la table de garages : voir l'en-tête de ce fichier
if (pages !== undefined && !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(pages)) throw new Error(`--pages attend un nom de domaine (ex. pixcar.fr), reçu « ${pages} »`);
const { OTHER_SERVICE, SERVICES } = await import(pathToFileURL(join(SRC, "js/shared/services.js")).href);
const dev = process.argv.includes("--dev");
const apiBase = (process.env.PIXCAR_API_BASE || "").replace(/\/+$/, "");
const read = (...p) => readFile(join(...p), "utf8");
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

// Mesure d'audience (Google Analytics) : l'identifiant vient de src/analytics.json pour la version publiée (--pages) seulement, ou de
// PIXCAR_GA_ID (qui l'emporte ; vide : désactivée). Sans identifiant, la page n'a ni bandeau, ni texte sur Google, ni hôte Google dans sa
// politique de sécurité, et le module modules/analytics.js ne fait rien : page tout-en-un, développement et tests n'envoient rien à Google.
const analytics = await (async () => {
  let config = {};
  try {
    config = JSON.parse(await read(SRC, "analytics.json"));
  } catch {
    /* pas de fichier : pas de mesure d'audience par défaut */
  }
  const fromEnv = process.env.PIXCAR_GA_ID;
  const id = String(fromEnv !== undefined ? fromEnv : pages !== undefined ? config.measurementId ?? "" : "").trim();
  if (!id) return null;
  if (!/^G-[A-Z0-9]{6,12}$/.test(id)) throw new Error(`identifiant de mesure invalide (« G-XXXXXXXXXX » attendu) : ${id}`);
  const months = Number.isInteger(config.retentionMonths) && config.retentionMonths > 0 ? config.retentionMonths : 14;
  return { id, cookie: id.slice(2), retentionMonths: months };
})();
// Contentsquare (analyse de l'utilisation des pages : clics, défilements, enregistrement des sessions) : même règle que Google Analytics,
// contentsquareId de src/analytics.json pour la version publiée seulement, ou PIXCAR_CS_ID (qui l'emporte ; vide : désactivé). Le tag n'est
// chargé qu'après l'accord du visiteur, par modules/analytics.js, sous le même choix « mesure d'audience ».
const contentsquare = await (async () => {
  let config = {};
  try {
    config = JSON.parse(await read(SRC, "analytics.json"));
  } catch {
    /* pas de fichier : pas de Contentsquare */
  }
  const fromEnv = process.env.PIXCAR_CS_ID;
  const id = String(fromEnv !== undefined ? fromEnv : pages !== undefined ? config.contentsquareId ?? "" : "").trim();
  if (!id) return null;
  if (!/^[0-9a-f]{8,20}$/.test(id)) throw new Error(`identifiant de tag Contentsquare invalide (celui de t.contentsquare.net/uxa/<identifiant>.js attendu) : ${id}`);
  const months = Number.isInteger(config.contentsquareRetentionMonths) && config.contentsquareRetentionMonths > 0 ? config.contentsquareRetentionMonths : 13;
  return { id, retentionMonths: months };
})();
// Mesure d'audience au sens large : au moins un outil soumis au consentement (bandeau, choix, lien « Mesure d'audience »).
const audience = !!(analytics || contentsquare);

// Table de garages : tuiles de scripts/garages/build.py. Contrôle minimal ici (la construction a déjà contrôlé la sortie : tests/garages.js le vérifie aussi) : un
// index que la page ne saurait pas lire ne doit jamais être publié.
const garages = await (async () => {
  if (garagesDir === undefined) return null;
  const dir = resolve(garagesDir);
  let index;
  try {
    index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  } catch (e) {
    throw new Error(`--garages : index.json illisible dans ${dir} (${e.message})`);
  }
  if (index.v !== 1 || index.step !== 0.25 || index.x0 !== -10 || !index.tiles || typeof index.tiles !== "object") throw new Error("--garages : index.json inattendu (version, pas ou origine différents de ceux de la page)");
  const keys = Object.keys(index.tiles);
  for (const k of keys) if (!/^-?\d+--?\d+$/.test(k)) throw new Error(`--garages : case « ${k} » inattendue`);
  if (!keys.length) throw new Error("--garages : aucune case dans index.json");
  return { dir, index, keys };
})();
// Variantes du texte selon la table : <!--GT:on-->…<!--/GT:on--> (avec les tuiles) et <!--GT:off-->…<!--/GT:off--> (sans). La page tout-en-un n'a jamais les
// tuiles : ses textes sont toujours ceux « sans », même quand le site (dist/) est construit avec.
const garagesVariants = (html, on) => html.replace(/<!--GT:(on|off)-->([\s\S]*?)<!--\/GT:\1-->/g, (m, mode, text) => ((mode === "on") === !!on ? text : ""));
// De même <!--PRO:on-->…<!--/PRO:on--> : texte qui n'existe qu'avec la page pro/ (site dist/ construit avec l'Espace Pro ; jamais la page tout-en-un).
const proVariants = (html, on) => html.replace(/<!--PRO:(on|off)-->([\s\S]*?)<!--\/PRO:\1-->/g, (m, mode, text) => ((mode === "on") === !!on ? text : ""));
// Fond de carte Mapbox : le jeton vient de src/mapbox.json pour la version publiée (--pages) seulement, ou de PIXCAR_MAPBOX_TOKEN (qui l'emporte ;
// vide : désactivé). Sans jeton, la carte garde le fond de l'IGN (puis CARTO) : rien n'est demandé à Mapbox, ni par la page tout-en-un, ni en
// développement, ni dans les tests. Seul un jeton PUBLIC (« pk.… ») est accepté : il finit dans la page, donc dans le dépôt et chez tout visiteur ;
// un jeton secret (« sk.… ») y serait publié à la vue de tous, le build refuse. Un jeton public se restreint à l'adresse du site dans le compte Mapbox.
const mapbox = await (async () => {
  let config = {};
  try {
    config = JSON.parse(await read(SRC, "mapbox.json"));
  } catch {
    /* pas de fichier : pas de fond Mapbox par défaut */
  }
  const fromEnv = process.env.PIXCAR_MAPBOX_TOKEN;
  const token = String(fromEnv !== undefined ? fromEnv : pages !== undefined ? config.accessToken ?? "" : "").trim();
  if (!token) return null;
  if (!/^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw new Error("jeton Mapbox refusé : seul un jeton PUBLIC (« pk.… ») est accepté ; un jeton secret (« sk.… ») ne doit jamais figurer dans la page ni dans le dépôt");
  const style = String(process.env.PIXCAR_MAPBOX_STYLE || config.style || "mapbox/light-v11").trim();
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(style)) throw new Error(`style Mapbox invalide (« mapbox/light-v11 » attendu) : ${style}`);
  // Fiches complétées par Mapbox (téléphone, horaires, site, à l'ouverture d'une fiche) : « map » par défaut, « always », ou « off » (PIXCAR_MAPBOX_ENRICH l'emporte).
  const enrich = String(process.env.PIXCAR_MAPBOX_ENRICH || config.enrich || "map").trim();
  if (!["off", "map", "always"].includes(enrich)) throw new Error(`réglage Mapbox « enrich » invalide (« off », « map » ou « always » attendu) : ${enrich}`);
  return { token, style, enrich };
})();

// Espace Pro : page dist/pro/ (connexion Amazon Cognito sans mot de passe, rattachement d'un garage par SIRET et code). Construite seulement
// quand le groupe d'utilisateurs et le client sont connus ET que l'API est branchée : sans eux, aucune trace de l'Espace Pro dans le site.
// Jamais dans la page tout-en-un. Les identifiants Cognito ne sont pas secrets (ils figurent dans toute page de connexion Cognito).
const pro = await (async () => {
  let config = {};
  try {
    config = JSON.parse(await read(SRC, "pro.json"));
  } catch {
    /* pas de fichier : pas d'Espace Pro */
  }
  const pick = (envName, key) => String(process.env[envName] !== undefined ? process.env[envName] : pages !== undefined ? config[key] ?? "" : "").trim();
  const pool = pick("PIXCAR_PRO_POOL", "userPoolId");
  const client = pick("PIXCAR_PRO_CLIENT", "clientId");
  if (!pool && !client) return null;
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(pool)) throw new Error(`Espace Pro : groupe d'utilisateurs Cognito invalide (« eu-north-1_AbC123 » attendu) : ${pool}`);
  if (!/^[a-z0-9]{10,64}$/i.test(client)) throw new Error(`Espace Pro : client d'application Cognito invalide : ${client}`);
  if (!apiBase) throw new Error("Espace Pro : la page pro/ a besoin de l'API (PIXCAR_API_BASE)");
  return { pool, client, cognito: `https://cognito-idp.${pool.split("_")[0]}.amazonaws.com` };
})();

// Leaflet est chargé à la demande (premier affichage de la carte). Page tout-en-un : CDN. dist : copie locale puis CDN.
const LEAFLET_CDN = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";

// ------------------------------------------------------------------------------------------------ JS
async function buildJs(extraDefine = {}) {
  const r = await build({
    entryPoints: [join(SRC, "js/main.js")],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: !dev,
    legalComments: "none",
    write: false,
    loader: { ".txt": "text" },
    define: { __LEAFLET_URLS__: JSON.stringify([LEAFLET_CDN]), __SW_URL__: JSON.stringify(""), ...extraDefine },
    logLevel: "warning",
  });
  return r.outputFiles[0].text;
}

// ------------------------------------------------------------------------------------------------ CSS
// Un seul thème (clair) : le thème sombre et son fichier de jetons ont été retirés le 10 octobre 2026.
async function buildCss(fontCss) {
  const css = fontCss + (await read(SRC, "css/vendor/leaflet.css")) + "\n" + (await read(SRC, "css/app.css"));
  if (dev) return css;
  return (await transform(css, { loader: "css", minify: true })).code;
}

// ------------------------------------------------------------------------------------------------ polices
// Manrope (SIL OFL 1.1, The Manrope Project Authors : texte de la licence dans src/assets/fonts/OFL-Manrope.txt), variable 200–800, fichiers
// officiels de Google Fonts (v20), non modifiés. « latin » couvre le français (Latin-1 et œ), « latin-ext » le reste. Une police libre (OFL) peut
// être versionnée et redistribuée avec le site. Pas de size-adjust : les tailles du CSS sont celles de la maquette, dessinée en Manrope.
const FONTS = [
  { file: "manrope-latin.woff2", range: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  { file: "manrope-latin-ext.woff2", range: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF" },
];
const fontFace = (url, range) => `@font-face{font-family:'Manrope';font-style:normal;font-weight:200 800;font-display:swap;src:url(${url}) format('woff2');unicode-range:${range}}\n`;
// Repli aux mesures de Manrope, le temps que la police arrive : Arial (Windows, macOS) ou ses jumelles métriques Liberation Sans (Linux) et
// Arimo (ChromeOS), agrandies pour occuper la même largeur que Manrope (largeur moyenne mesurée sur les textes de la page : +4 % en regular
// à la graisse 500, +2 % en gras à la graisse 800) et ramenées à ses hauteurs (ascendante 1,066 em, descendante 0,3 em, sans interligne
// ajouté). Sans lui, le titre de l'accueil change de nombre de lignes quand Manrope remplace la police système, et tout ce qui suit
// bouge (test « prerender »). Une police locale ne se télécharge pas : la politique de sécurité (font-src) ne la concerne pas.
const FALLBACK = [
  { weight: "200 599", adjust: 104, src: ["Arial", "ArialMT", "Liberation Sans", "LiberationSans", "Arimo", "Helvetica"] },
  { weight: "600 800", adjust: 102, src: ["Arial Bold", "Arial-BoldMT", "Liberation Sans Bold", "LiberationSans-Bold", "Arimo Bold", "Helvetica Bold"] },
];
const pct = (v) => `${+(v * 100).toFixed(2)}%`;
const fallbackFaces = FALLBACK.map((f) => `@font-face{font-family:'Manrope Fallback';font-style:normal;font-weight:${f.weight};src:${f.src.map((n) => `local('${n}')`).join(",")};size-adjust:${f.adjust}%;ascent-override:${pct(1.066 / (f.adjust / 100))};descent-override:${pct(0.3 / (f.adjust / 100))};line-gap-override:0%}\n`).join("");

// ------------------------------------------------------------------------------------------------ HTML
const oneLine = (s) => s.trim().split("\n").map((l) => l.trim()).join(" ");
// Connexions ouvertes dès le chargement : le service d'adresses (utilisé dès la première recherche) et l'API.
const GEOCODER = "https://data.geopf.fr";
const apiOrigin = (() => {
  try {
    return apiBase ? new URL(apiBase).origin : "";
  } catch {
    throw new Error(`PIXCAR_API_BASE n'est pas une adresse valide : ${apiBase}`);
  }
})();
const preconnect = () => [GEOCODER, apiOrigin].filter(Boolean).map((o) => `<link rel="preconnect" href="${o}" crossorigin>`).join("\n");
// Listes de prestations écrites dans le HTML, pour que la liste déroulante soit remplie et son aide visible avant l'exécution du
// script (la page les reconstruit à l'identique ; un test compare les deux). Même échappement que la page.
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function optionsHtml(list, extra = "") {
  const groups = [];
  for (const s of list) {
    let g = groups.find((x) => x.name === s.g);
    if (!g) groups.push((g = { name: s.g, items: [] }));
    g.items.push(s);
  }
  return groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}</optgroup>`).join("") + extra;
}
// Variantes du texte selon ce que la page contient : <!--GA:on-->…<!--/GA:on--> (avec Google Analytics) et <!--GA:off-->…<!--/GA:off--> (sans) ;
// de même <!--MB:on--> et <!--MB:off--> pour le fond de carte Mapbox, <!--MX:on--> et <!--MX:off--> pour les fiches complétées par Mapbox. Pas d'imbrication.
// AU : au moins un outil de mesure d'audience (Google Analytics ou Contentsquare) ; GA, CS : chacun ; MX : fiches complétées par Mapbox
const variantOn = { AU: () => audience, GA: () => !!analytics, CS: () => !!contentsquare, MB: () => !!mapbox, MX: () => !!mapbox && mapbox.enrich !== "off" };
const variantOnce = (html) => html.replace(/<!--(AU|GA|CS|MB|MX):(on|off)-->([\s\S]*?)<!--\/\1:\2-->/g, (m, flag, mode, text) => ((mode === "on") === variantOn[flag]() ? text : ""));
// Les blocs s'imbriquent (un bloc GA dans un bloc AU) : on recommence jusqu'à ce qu'il n'en reste aucun.
const variants = (html) => {
  for (let prev = null; prev !== html; ) [prev, html] = [html, variantOnce(html)];
  return html;
};
// Les outils de mesure d'audience branchés, nommés dans le bandeau et le texte de confidentialité : {{au.tools}}, {{au.recipients}}
const audienceFields = () => ({
  tools: [analytics && "Google Analytics", contentsquare && "Contentsquare"].filter(Boolean).join(" et "),
  recipients: [analytics && "Google", contentsquare && "Contentsquare"].filter(Boolean).join(" et "),
});
const fillAudience = (html, where) =>
  html.replace(/\{\{au\.([A-Za-z]+)\}\}/g, (m, k) => {
    const v = audience ? audienceFields()[k] : undefined;
    if (v === undefined) throw new Error(`${where} : {{au.${k}}} inconnu, ou hors d'un bloc <!--AU:on-->`);
    return esc(v);
  });
// Mentions légales et politique de confidentialité : src/legal.json (ce qui dépend de l'éditeur) + src/partials/legal.html (le texte).
// Complet : la fenêtre « Confidentialité et mentions légales » et ses liens sont dans la page. Incomplet : ni fenêtre ni liens, SAUF si
// l'API est branchée (PIXCAR_API_BASE) : le build échoue alors, on n'ouvre pas au public des déclarations sans informer les visiteurs.
// PIXCAR_ALLOW_NO_LEGAL=1 lève cette garde pour un essai.
const LEGAL_FIELDS = ["editorLine", "contact", "hostPages", "hostApi", "repairRetentionMonths", "updated"];
async function legalParts(withGarages, withPro) {
  const config = JSON.parse(await read(SRC, "legal.json"));
  const filled = (k) => String(config[k] ?? "").trim() !== "";
  const problems = LEGAL_FIELDS.filter((k) => !filled(k)).map((k) => `${k} : à renseigner`);
  if (filled("contact") && !/^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(String(config.contact).trim())) problems.push("contact : une adresse électronique est attendue");
  if (filled("repairRetentionMonths") && !(Number.isInteger(config.repairRetentionMonths) && config.repairRetentionMonths > 0)) problems.push("repairRetentionMonths : un nombre entier de mois est attendu");
  if (problems.length) {
    if ((apiBase || audience || mapbox) && process.env.PIXCAR_ALLOW_NO_LEGAL !== "1")
      throw new Error(`mentions légales incomplètes dans src/legal.json (${problems.join(" ; ")}) : ${audience ? "la mesure d'audience est branchée (PIXCAR_GA_ID, PIXCAR_CS_ID, src/analytics.json) : le bandeau de consentement renvoie à cette fenêtre" : mapbox ? "le fond de carte Mapbox est branché (PIXCAR_MAPBOX_TOKEN, src/mapbox.json) : Mapbox verrait l'adresse IP des visiteurs sans que le texte de confidentialité le dise" : "l'API est branchée (PIXCAR_API_BASE), des visiteurs y déposeraient des données sans en être informés"}. Complétez ce fichier (docs/exploitation.md, section 6) ; PIXCAR_ALLOW_NO_LEGAL=1 le permet pour un simple essai.`);
    return { dialog: "", linkPanel: "", linkSources: "", linkDialog: "" };
  }
  const gaFields = { cookie: analytics && analytics.cookie, retentionMonths: analytics && analytics.retentionMonths };
  const dialog = fillAudience(proVariants(garagesVariants(variants(await read(SRC, "partials/legal.html")), withGarages), withPro), "partials/legal.html")
    .replace(/\{\{legal\.([A-Za-z]+)\}\}/g, (m, k) => {
      if (!LEGAL_FIELDS.includes(k)) throw new Error(`partials/legal.html : {{legal.${k}}} n'existe pas dans src/legal.json`);
      return esc(String(config[k]).trim());
    })
    .replace(/\{\{ga\.([A-Za-z]+)\}\}/g, (m, k) => {
      if (!analytics || gaFields[k] === undefined) throw new Error(`partials/legal.html : {{ga.${k}}} inconnu, ou hors d'un bloc <!--GA:on-->`);
      return esc(String(gaFields[k]));
    })
    .replace(/\{\{cs\.([A-Za-z]+)\}\}/g, (m, k) => {
      if (!contentsquare || k !== "retentionMonths") throw new Error(`partials/legal.html : {{cs.${k}}} inconnu, ou hors d'un bloc <!--CS:on-->`);
      return esc(String(contentsquare.retentionMonths));
    });
  return {
    dialog,
    // Masqué dans le HTML, montré par modules/legal.js une fois la page construite : sous le panneau des résultats, que le script remplit, il
    // descendrait de plusieurs lignes au démarrage (décalage de mise en page). Avec la mesure d'audience : un second lien rouvre le choix.
    linkPanel: `<p class="legal-foot" hidden><button type="button" class="link-btn" data-open-legal>Confidentialité et mentions légales</button>${audience ? '<span aria-hidden="true"> · </span><button type="button" class="link-btn" data-consent-open>Mesure d\'audience</button>' : ""}</p>`,
    linkSources: '<p><b>Confidentialité et mentions légales.</b> <button type="button" class="link-btn" data-open-legal>Lire la politique de confidentialité</button></p>',
    linkDialog: '<p class="dlg-note" data-store-only="remote"><button type="button" class="link-btn" data-open-legal>Comment Pixcar traite vos données</button></p>',
  };
}
async function pageParts(withGarages, withPro = false) {
  const road = oneLine(await read(SRC, "partials/ld-road.svg"));
  const car = oneLine(await read(SRC, "partials/ld-car.svg"));
  let body = garagesVariants(variants(await read(SRC, "partials/body.html")), withGarages);
  let dialog = await read(SRC, "partials/dialog.html");
  const fill = (text, pairs) => {
    for (const [mark, value, times = 1] of pairs) {
      if (text.split(mark).length !== times + 1) throw new Error(`${mark} : ${times} occurrence(s) attendue(s)`);
      text = text.split(mark).join(value);
    }
    return text;
  };
  const legal = await legalParts(withGarages, withPro);
  body = fill(body, [
    ["<!--LD_ROAD-->", road],
    ["<!--LD_CAR-->", car],
    ["<!--SERVICE_OPTIONS-->", optionsHtml(SERVICES), 2],
    ["<!--SERVICE_HINT-->", esc(SERVICES[0].hint)], // la première prestation est celle que la page sélectionne à la première visite
    ["<!--SERVICE_LABEL-->", esc(SERVICES[0].label)], // son libellé : texte du bouton « Prestation » avant le démarrage du script (pas de décalage)
    ["<!--LEGAL_LINK_PANEL-->", legal.linkPanel],
    ["<!--LEGAL_LINK_SOURCES-->", legal.linkSources],
  ]);
  dialog = fill(dialog, [
    ["<!--REPAIR_OPTIONS-->", optionsHtml(SERVICES.filter((s) => s.kind !== "ct"), `<optgroup label="Autre"><option value="${OTHER_SERVICE}">Autre réparation (précisez en commentaire)</option></optgroup>`)],
    ["<!--LEGAL_LINK_DIALOG-->", legal.linkDialog],
  ]);
  return { body, sprite: await read(SRC, "partials/sprite.html"), dialog, legal: legal.dialog, consent: audience ? fillAudience(variants(await read(SRC, "partials/consent.html")), "partials/consent.html") : "" };
}
function squeeze(html) {
  if (dev) return html;
  // commentaires HTML et indentation retirés ; les retours à la ligne restent (ils valent une espace entre éléments en ligne)
  return html.replace(/<!--(?!\[)[\s\S]*?-->/g, "").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n");
}
async function render(parts, { headAssets, scripts, garagesBase = "" }) {
  const tpl = await read(SRC, "index.html");
  const fill = { API_BASE: apiBase, GA_ID: analytics ? analytics.id : "", CS_ID: contentsquare ? contentsquare.id : "", GARAGES_BASE: garagesBase, MAPBOX_TOKEN: mapbox ? mapbox.token : "", MAPBOX_STYLE: mapbox ? mapbox.style : "", MAPBOX_ENRICH: mapbox ? mapbox.enrich : "", PRECONNECT: preconnect(), HEAD_ASSETS: headAssets, SPRITE: parts.sprite, CONSENT: parts.consent, BODY: parts.body, DIALOG: parts.dialog, LEGAL: parts.legal, SCRIPTS: scripts };
  return squeeze(tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m)));
}

// ------------------------------------------------------------------------------------------------ page tout-en-un
async function buildSingle(parts) {
  const latin = await readFile(join(SRC, "assets/fonts/manrope-latin.woff2"));
  const fontCss = fontFace(`data:font/woff2;base64,${latin.toString("base64")}`, FONTS[0].range) + fallbackFaces;
  const css = await buildCss(fontCss);
  const js = await buildJs();
  const svg = (await read(SRC, "assets/favicon.svg")).trim();
  const png = await readFile(join(SRC, "assets/apple-touch-icon.png"));
  const headAssets = [
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}">`,
    `<link rel="apple-touch-icon" href="data:image/png;base64,${png.toString("base64")}">`,
    `<style>${css}</style>`,
  ].join("\n");
  const html = await render(parts, { headAssets, scripts: `<script>\n${js}</script>` });
  await writeFile(join(OUT, "index.html"), html);
  return html.length;
}

// ------------------------------------------------------------------------------------------------ en-têtes (dist/_headers)
// Même format pour Netlify et Cloudflare Pages ; d'autres hébergeurs : reprendre les mêmes valeurs dans leur configuration.
// La page appelle ces services, et eux seuls : tout autre hôte est refusé par le navigateur (Content-Security-Policy).
const CONNECT = ["https://data.geopf.fr", "https://overpass-api.de", "https://overpass.openstreetmap.fr", "https://recherche-entreprises.api.gouv.fr", "https://data.economie.gouv.fr", "https://query.wikidata.org"];
// Google Analytics (seulement si la page est construite avec un identifiant) : la bibliothèque gtag.js vient de googletagmanager.com, les mesures
// partent vers *.google-analytics.com (adresses régionales comprises) et analytics.google.com. Les images, déjà permises en https, couvrent les pixels.
const GOOGLE_SCRIPT = ["https://www.googletagmanager.com"];
const GOOGLE_CONNECT = ["https://*.google-analytics.com", "https://analytics.google.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"]; // un joker ne couvre pas le domaine lui-même : analytics.google.com est donc nommé
// Contentsquare (seulement si la page est construite avec un identifiant), d'après sa documentation (« Content Security Policy », web) : le tag
// et ses modules viennent de *.contentsquare.net, les données partent vers *.contentsquare.net et *.contentsquare.com, app.contentsquare.com
// sert au zoning et aux captures faits depuis l'application Contentsquare (script et feuille de style), l'enregistrement des sessions
// travaille dans des workers créés depuis des blob:. Pas de 'unsafe-inline' : le tag est ajouté par le script de la page, pas par un extrait en ligne.
const CS_SCRIPT = ["https://*.contentsquare.net", "https://app.contentsquare.com"];
const CS_STYLE = ["https://app.contentsquare.com"];
const CS_CONNECT = ["https://*.contentsquare.net", "https://*.contentsquare.com"];
// Fiches complétées par Mapbox : la page interroge api.mapbox.com (Search Box) à l'ouverture d'une fiche. Les tuiles sont des images (img-src https: les couvre).
const MAPBOX_CONNECT = ["https://api.mapbox.com"];
export function contentSecurityPolicy(origin = apiOrigin, styleHash = "", ga = !!analytics, mbx = !!mapbox && mapbox.enrich !== "off", cs = !!contentsquare, cognito = pro ? pro.cognito : "") {
  return [
    "default-src 'self'",
    `script-src ${["'self'", "https://cdnjs.cloudflare.com", ...(ga ? GOOGLE_SCRIPT : []), ...(cs ? CS_SCRIPT : [])].join(" ")}`, // le CDN ne sert que de secours à la copie locale de Leaflet
    `style-src ${["'self'", styleHash && `'sha256-${styleHash}'`, ...(cs ? CS_STYLE : [])].filter(Boolean).join(" ")}`, // la feuille de style est dans la page : autorisée par son empreinte
    "style-src-attr 'unsafe-inline'", // quelques positions calculées (repères de l'échelle de prix, marqueurs)
    "img-src 'self' data: blob: https:", // tuiles de la carte (Mapbox, IGN, CARTO), logos (Wikimedia Commons), icônes des sites d'enseignes
    "font-src 'self'",
    `connect-src ${["'self'", origin, ...CONNECT, ...(ga ? GOOGLE_CONNECT : []), ...(cs ? CS_CONNECT : []), ...(mbx ? MAPBOX_CONNECT : []), cognito].filter(Boolean).join(" ")}`, // cognito : en-têtes communs (_headers) quand le site a l'Espace Pro
    `worker-src 'self'${cs ? " blob:" : ""}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
// GitHub Pages ne laisse pas choisir les en-têtes de réponse : la politique de sécurité du contenu et la politique de référent
// passent par des balises <meta>, placées tout en haut de <head>, avant ce qui charge quoi que ce soit. frame-ancestors n'y est pas
// pris en compte par les navigateurs : on la retire plutôt que de laisser un avertissement dans la console.
function withPolicyMeta(html, styleHash, csp = contentSecurityPolicy(apiOrigin, styleHash, undefined, undefined, undefined, "")) {
  csp = csp.split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ");
  const tags = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="strict-origin-when-cross-origin">\n`;
  const charset = '<meta charset="utf-8">\n';
  if (html.split(charset).length !== 2) throw new Error("balise <meta charset> introuvable ou en double : impossible de placer la politique de sécurité");
  return html.replace(charset, charset + tags);
}
function headersFile(styleHash) {
  const immutable = "public, max-age=31536000, immutable";
  const garagesRule = garages ? "\n# Table de garages : renouvelée une fois par mois ; une heure de cache allège le site sans retarder une mise à jour.\n/garages/*\n  Cache-Control: public, max-age=3600\n" : "";
  return `# Généré par scripts/build.mjs. Netlify et Cloudflare Pages lisent ce fichier tel quel.
/*
  Content-Security-Policy: ${contentSecurityPolicy(apiOrigin, styleHash)}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000

# La page et le service worker : toujours revalidés (un 304 suffit), pour que chaque déploiement soit vu tout de suite.
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
${pro ? "/pro/\n  Cache-Control: no-cache\n/pro/index.html\n  Cache-Control: no-cache\n" : ""}
# Fichiers dont le nom contient l'empreinte de leur contenu : jamais modifiés, gardés un an.
/assets/*
  Cache-Control: ${immutable}

# Icônes : nom fixe, un jour.
/favicon.svg
  Cache-Control: public, max-age=86400
/favicon.ico
  Cache-Control: public, max-age=86400
/apple-touch-icon.png
  Cache-Control: public, max-age=86400
${garagesRule}`;
}

// ------------------------------------------------------------------------------------------------ dist
async function buildDist(parts) {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, "assets/fonts"), { recursive: true });
  const fontUrls = [];
  const fonts = []; // { name, range } : reprises par la feuille de style de l'Espace Pro
  let fontCss = fallbackFaces;
  for (const f of FONTS) {
    const buf = await readFile(join(SRC, "assets/fonts", f.file));
    const name = f.file.replace(".woff2", `.${hash(buf)}.woff2`);
    await writeFile(join(DIST, "assets/fonts", name), buf);
    fontCss += fontFace(`assets/fonts/${name}`, f.range); // le CSS est dans la page : chemins depuis la racine du site
    fontUrls.push(`assets/fonts/${name}`);
    fonts.push({ name, range: f.range });
  }
  const css = await buildCss(fontCss);

  // Leaflet : copie locale (chargée à la demande), le CDN ne sert plus que de secours.
  const leaflet = await readFile(join(ROOT, "node_modules/leaflet/dist/leaflet.js"));
  const leafletMin = dev ? leaflet.toString() : (await transform(leaflet.toString(), { minify: true, legalComments: "none" })).code;
  const leafletName = `leaflet.${hash(leafletMin)}.js`;
  await writeFile(join(DIST, "assets", leafletName), leafletMin);

  const js = await buildJs({ __LEAFLET_URLS__: JSON.stringify([`assets/${leafletName}`, LEAFLET_CDN]), __SW_URL__: JSON.stringify("sw.js") });
  const jsName = `app.${hash(js)}.js`;
  await writeFile(join(DIST, "assets", jsName), js);

  await copyFile(join(SRC, "assets/favicon.svg"), join(DIST, "favicon.svg"));
  await copyFile(join(SRC, "assets/favicon.ico"), join(DIST, "favicon.ico"));
  await copyFile(join(SRC, "assets/apple-touch-icon.png"), join(DIST, "apple-touch-icon.png"));
  const headAssets = [
    // favicon.ico (16, 32, 48 px, fabriqué par scripts/favicon-ico.mjs) pour les robots et navigateurs qui ne lisent pas le SVG ;
    // sa taille déclarée laisse le SVG gagner chez les navigateurs qui le savent afficher.
    `<link rel="icon" href="favicon.ico" sizes="48x48">`,
    `<link rel="icon" type="image/svg+xml" href="favicon.svg">`,
    `<link rel="apple-touch-icon" href="apple-touch-icon.png">`,
    `<link rel="preload" href="${fontUrls[0]}" as="font" type="font/woff2" crossorigin>`,
    // Feuille de style dans la page : un aller-retour de moins avant le premier affichage (la page revient du cache du service
    // worker ou d'un 304 aux visites suivantes : l'intégrer ne coûte rien). La politique de sécurité l'autorise par son empreinte.
    `<style>${css}</style>`,
  ].join("\n");
  let html = await render(parts, { headAssets, scripts: `<script src="assets/${jsName}" defer></script>`, garagesBase: garages ? "garages/" : "" });
  if (garages) {
    await mkdir(join(DIST, "garages/t"), { recursive: true });
    await copyFile(join(garages.dir, "index.json"), join(DIST, "garages/index.json"));
    for (const k of garages.keys) await copyFile(join(garages.dir, "t", k + ".json"), join(DIST, "garages/t", k + ".json"));
  }
  const styleSource = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const styleHash = createHash("sha256").update(styleSource).digest("base64");
  if (pages) html = withPolicyMeta(html, styleHash); // avant le calcul de la version du service worker : elle dépend du contenu final
  await writeFile(join(DIST, "index.html"), html);

  // Coque hors ligne : la page, le script à empreinte et la police (Leaflet et la 2e police se chargent à la demande)
  const shell = ["./", `assets/${jsName}`, fontUrls[0], "favicon.svg", "apple-touch-icon.png"];
  const version = hash(Buffer.from([html, ...shell.slice(1)].join("\n") + (await read(SRC, "sw.js"))));
  const sw = (await read(SRC, "sw.js")).replace("__VERSION__", version).replace("__SHELL__", JSON.stringify(shell));
  await writeFile(join(DIST, "sw.js"), dev ? sw : (await transform(sw, { minify: true, legalComments: "none" })).code);
  if (pages) {
    await writeFile(join(DIST, "CNAME"), pages.toLowerCase() + "\n"); // GitHub Pages lit le domaine personnalisé ici
    await writeFile(join(DIST, ".nojekyll"), ""); // servir les fichiers tels quels, sans passer par Jekyll
  } else await writeFile(join(DIST, "_headers"), headersFile(styleHash));
  await writeFile(join(DIST, "robots.txt"), "User-agent: *\nAllow: /\n" + (garages ? "Disallow: /garages/\n" : "") + (pro ? "Disallow: /pro/\n" : ""));
  if (pro) await buildPro(fonts);
  return { html: html.length, js: js.length, css: css.length, version };
}

// ------------------------------------------------------------------------------------------------ Espace Pro (dist/pro/)
// Page à part, sans rien d'en ligne : feuille de style et script dans assets/ (noms à empreinte), donc permis par 'self' dans la politique de
// sécurité commune (_headers) ; la version publiée (--pages) porte sa propre balise <meta> (connect-src : l'API et Cognito, rien d'autre).
// Pas dans la coque du service worker : l'Espace Pro n'a pas de sens hors connexion.
const PRO_CSP = (cognito) =>
  ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", `connect-src ${[apiOrigin, cognito].join(" ")}`, "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
export const proContentSecurityPolicy = () => (pro ? PRO_CSP(pro.cognito) : "");
async function buildPro(fonts) {
  const app = await read(SRC, "css/app.css");
  const word = /\.px-word\s*\{[^}]*\}/.exec(app);
  if (!word) throw new Error("Espace Pro : règle .px-word introuvable dans css/app.css (mot-symbole du logo)");
  let css = fonts.map((f) => fontFace(`fonts/${f.name}`, f.range)).join("") + fallbackFaces + word[0] + "\n" + (await read(SRC, "css/pro.css"));
  if (!dev) css = (await transform(css, { loader: "css", minify: true })).code;
  const cssName = `pro.${hash(css)}.css`;
  await writeFile(join(DIST, "assets", cssName), css);
  const js = (await build({ entryPoints: [join(SRC, "js/pro/main.js")], bundle: true, format: "iife", target: "es2020", minify: !dev, legalComments: "none", write: false, logLevel: "warning" })).outputFiles[0].text;
  const jsName = `pro.${hash(js)}.js`;
  await writeFile(join(DIST, "assets", jsName), js);
  const mark = /<symbol id="px-mark"[\s\S]*?<\/symbol>/.exec(await read(SRC, "partials/sprite.html"));
  if (!mark) throw new Error("Espace Pro : symbole px-mark introuvable dans partials/sprite.html");
  let contact = "";
  try {
    contact = JSON.parse(await read(SRC, "legal.json")).contact || "";
  } catch {}
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(contact)) throw new Error("Espace Pro : adresse de contact absente ou invalide dans src/legal.json (« contact ») : la vérification manuelle y renvoie");
  const headAssets = [
    `<link rel="icon" href="../favicon.ico" sizes="48x48">`,
    `<link rel="icon" type="image/svg+xml" href="../favicon.svg">`,
    `<link rel="preload" href="../assets/fonts/${fonts[0].name}" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="../assets/${cssName}">`,
  ].join("\n");
  const fill = { API_BASE: apiBase, POOL: pro.pool, CLIENT: pro.client, CONTACT: contact, HEAD_ASSETS: headAssets, MARK: mark[0], SCRIPTS: `<script src="../assets/${jsName}" defer></script>` };
  let html = squeeze((await read(SRC, "pro/index.html")).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m)));
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error("Espace Pro : marque {{…}} non remplacée dans pro/index.html");
  if (pages) html = withPolicyMeta(html, "", PRO_CSP(pro.cognito));
  await mkdir(join(DIST, "pro"), { recursive: true });
  await writeFile(join(DIST, "pro", "index.html"), html);
}

// ------------------------------------------------------------------------------------------------
const parts = await pageParts(false);
const distParts = garages || pro ? await pageParts(!!garages, !!pro) : parts;
await mkdir(OUT, { recursive: true });
const single = only === "dist" ? null : await buildSingle(parts);
const dist = only === "single" ? null : await buildDist(distParts);
const kb = (n) => (n / 1024).toFixed(1) + " Ko";

if (check) {
  // Les sorties sont déterministes (noms à empreinte, version du service worker dérivée du contenu) : toute différence avec ce
  // qui est dans le dépôt veut dire qu'une source a changé sans reconstruction.
  const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath ?? e.path, e.name))).sort();
  const problems = [];
  const same = async (a, b, label) => {
    const [fa, fb] = await Promise.all([files(a).catch(() => []), files(b).catch(() => [])]);
    for (const f of fa) if (!fb.includes(f)) problems.push(`${label}/${f} : absent du dépôt`);
    for (const f of fb) if (!fa.includes(f)) problems.push(`${label}/${f} : n'existe plus dans la construction`);
    for (const f of fa) if (fb.includes(f) && !(await readFile(join(a, f))).equals(await readFile(join(b, f)))) problems.push(`${label}/${f} : contenu différent`);
  };
  await same(DIST, join(ROOT, "dist"), "dist");
  if (!(await readFile(join(OUT, "index.html"))).equals(await readFile(join(ROOT, "index.html")).catch(() => Buffer.alloc(0)))) problems.push("index.html : contenu différent");
  await rm(OUT, { recursive: true, force: true });
  if (problems.length) {
    console.error("Sorties du dépôt périmées :\n  - " + problems.join("\n  - ") + "\nLancer npm run build et recommiter.");
    process.exit(1);
  }
  console.log("index.html et dist/ sont à jour.");
} else console.log(`${dev ? "dev" : "prod"} · ${single ? `index.html ${kb(single)}` : ""}${single && dist ? " · " : ""}${dist ? `dist : html ${kb(dist.html)}, js ${kb(dist.js)}, css ${kb(dist.css)}` : ""}`);
