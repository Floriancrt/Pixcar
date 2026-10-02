// Enregistre le service worker (dist/sw.js) : après le chargement, sans jamais gêner ni faire de bruit.
// À chaque ouverture on demande une vérification : une nouvelle version est installée en arrière-plan et sert dès la visite suivante.
export function registerServiceWorker(url) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || (location.protocol === "http:" && local))) return;
  const go = () => navigator.serviceWorker.register(url).then((registration) => registration.update()).catch(() => {});
  document.readyState === "complete" ? go() : window.addEventListener("load", go, { once: true });
}
