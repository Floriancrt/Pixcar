// Point d'entrée : le build (esbuild) en fait un seul script. app.js est l'application ; les modules de src/js/modules/
// (configuration, accès réseau, stockage des réparations…) s'y branchent.
import "./app.js";
import { initAnalytics } from "./modules/analytics.js";
import { initLegal } from "./modules/legal.js";
import { registerServiceWorker } from "./modules/sw-register.js";

// Fenêtre « Confidentialité et mentions légales » : présente seulement quand src/legal.json est complet (scripts/build.mjs).
initLegal();

// Mesure d'audience (Google Analytics) : seulement si la page est construite avec un identifiant (src/analytics.json, PIXCAR_GA_ID), et jamais
// avant l'accord du visiteur (modules/analytics.js).
initAnalytics();

// Adresse du service worker : renseignée par le build du site publiable (dist/), vide dans la page tout-en-un.
if (__SW_URL__) registerServiceWorker(__SW_URL__);
