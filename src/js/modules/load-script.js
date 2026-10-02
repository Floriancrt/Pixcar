// Charge un script classique en essayant chaque adresse à tour de rôle (copie locale, puis CDN de secours).
// Rejette si aucune ne répond ; l'appelant peut réessayer plus tard.
export function loadScript(urls) {
  const one = (url) =>
    new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = url;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        el.remove();
        reject(new Error("script indisponible : " + url));
      };
      document.head.appendChild(el);
    });
  return urls.reduce((previous, url) => previous.catch(() => one(url)), Promise.reject(new Error("aucune adresse")));
}
