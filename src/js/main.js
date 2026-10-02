// Point d'entrée : le build (esbuild) en fait un seul script. app.js est l'application ; les modules de src/js/modules/
// (configuration, accès réseau, stockage des réparations…) s'y branchent.
import "./app.js";
import { registerServiceWorker } from "./modules/sw-register.js";

// Adresse du service worker : renseignée par le build du site publiable (dist/), vide dans la page tout-en-un.
if (__SW_URL__) registerServiceWorker(__SW_URL__);
