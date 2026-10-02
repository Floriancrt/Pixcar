// Service worker de Pixcar : la coque de la page (HTML, CSS, JS, police, icônes) vit dans le navigateur.
// Effets : les visites suivantes démarrent sans réseau ; la page s'ouvre hors connexion et même quand l'hébergeur est en panne.
//
// Ce que ce fichier NE fait pas : il ne touche jamais aux requêtes vers l'API, les services d'adresses, OpenStreetMap, les
// tuiles : la page gère elle-même ses copies de secours (localStorage) et ses messages d'erreur. Elles passent telles quelles.
//
// Mises à jour : chaque build change VERSION. Le nouveau worker précharge TOUTE sa coque, prend la main tout de suite
// (skipWaiting + claim) et la page affichée garde ses fichiers : la génération précédente reste en cache, donc un chargement
// tardif (carte, Leaflet) d'une page ouverte avant le déploiement retrouve son fichier même si l'hébergeur ne le sert plus.
// La nouvelle version apparaît à la visite suivante (la page demande une vérification à chaque ouverture).
const VERSION = "__VERSION__";
const CACHE = "pixcar-" + VERSION;
const SHELL = __SHELL__; // « ./ » (la page) et chaque fichier de la coque, relatifs au worker

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(async (error) => {
        await caches.delete(CACHE); // une coque incomplète ne doit jamais rester : elle passerait pour la « génération précédente »
        throw error; // l'installation échoue : l'ancien worker reste en place
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // on garde la génération courante et la précédente (les caches sont listés dans l'ordre de création)
      const mine = (await caches.keys()).filter((k) => k.startsWith("pixcar-"));
      const previous = mine[mine.indexOf(CACHE) - 1];
      await Promise.all(mine.filter((k) => k !== CACHE && k !== previous).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

const scope = new URL(self.registration.scope);
const isShellPage = (url) => url.origin === scope.origin && (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // API, adresses, OpenStreetMap, tuiles : réseau seul
  if (request.mode === "navigate") {
    if (isShellPage(url)) event.respondWith(page(request));
    return;
  }
  if (url.pathname.startsWith(scope.pathname + "assets/")) event.respondWith(immutable(request)); // noms à empreinte : jamais modifiés
  else if (SHELL.some((f) => new URL(f, self.registration.scope).href === url.href)) event.respondWith(refresh(event)); // icônes
});

// La page : celle de cette version, immédiatement ; le réseau n'est consulté que si elle manque (ne devrait pas arriver).
async function page(request) {
  // d'abord le cache de CETTE version : caches.match() sans précision rend la plus ancienne génération qui a une page
  const cached = (await (await caches.open(CACHE)).match("./", { ignoreSearch: true })) || (await caches.match("./", { ignoreSearch: true }));
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response("Pixcar est momentanément injoignable. Réessayez dans un instant.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

// Fichier à empreinte : le cache d'abord (toutes générations), sinon le réseau, que l'on garde.
async function immutable(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

// Icônes : la copie tout de suite, rafraîchie en arrière-plan.
async function refresh(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((response) => (response.ok ? cache.put(event.request, response.clone()).then(() => response) : response))
    .catch(() => cached);
  event.waitUntil(network);
  return cached || network;
}
