// Espace Pro : vérification des jetons d'accès Amazon Cognito (JWT signés RS256), sans dépendance : Web Crypto et les clés publiques
// du groupe d'utilisateurs (…/.well-known/jwks.json), gardées en mémoire. L'API ne fait confiance qu'à ce qu'elle a vérifié elle-même :
// signature, émetteur (le groupe d'utilisateurs), usage « access », client (l'application Pixcar), expiration.
const b64urlBytes = (s) => Uint8Array.from(Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const b64urlJson = (s) => JSON.parse(Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
const enc = new TextEncoder();

export const issuerOf = (userPoolId) => {
  const region = String(userPoolId).split("_")[0];
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
};

export class AuthError extends Error {}

// verify(token) → { sub } ou lève AuthError. Les clés sont rechargées si un jeton cite une clé inconnue (rotation), au plus une fois par
// minute : un flot de jetons forgés ne déclenche pas un flot de téléchargements.
export function createCognitoVerifier({ userPoolId, clientId, fetchImpl = globalThis.fetch, now = Date.now, skewSeconds = 60, jwksUrl } = {}) {
  if (!/^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(String(userPoolId || ""))) throw new Error("identifiant de groupe d'utilisateurs Cognito invalide");
  if (!/^[a-z0-9]{10,64}$/i.test(String(clientId || ""))) throw new Error("identifiant de client Cognito invalide");
  const issuer = issuerOf(userPoolId);
  const url = jwksUrl || `${issuer}/.well-known/jwks.json`;
  let keys = new Map(); // kid → CryptoKey
  let loadedAt = -Infinity;
  let loading = null;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error("clés Cognito : réponse " + res.status);
      const body = await res.json();
      const next = new Map();
      for (const jwk of (body && body.keys) || []) {
        if (!jwk || jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig") || typeof jwk.kid !== "string") continue;
        try {
          next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
        } catch {} // clé illisible : ignorée, les autres servent
      }
      keys = next;
      loadedAt = now();
    })().finally(() => (loading = null));
    return loading;
  }

  return async function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)) || token.length > 8192) throw new AuthError("jeton mal formé");
    let header, claims;
    try {
      header = b64urlJson(parts[0]);
      claims = b64urlJson(parts[1]);
    } catch {
      throw new AuthError("jeton illisible");
    }
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("algorithme refusé");
    let key = keys.get(header.kid);
    if (!key && now() - loadedAt > 60_000) {
      try {
        await load();
      } catch (e) {
        loadedAt = now() - 50_000; // nouvel essai dans 10 s, pas à chaque requête
        throw Object.assign(new Error(e.message), { unavailable: true });
      }
      key = keys.get(header.kid);
    }
    if (!key) throw new AuthError("clé inconnue");
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
    if (!ok) throw new AuthError("signature invalide");
    const t = now() / 1000;
    if (!claims || claims.iss !== issuer) throw new AuthError("émetteur inattendu");
    if (claims.token_use !== "access") throw new AuthError("jeton d'accès attendu");
    if (claims.client_id !== clientId) throw new AuthError("client inattendu");
    if (typeof claims.exp !== "number" || claims.exp + skewSeconds < t) throw new AuthError("jeton expiré");
    if (typeof claims.iat === "number" && claims.iat - skewSeconds > t) throw new AuthError("jeton du futur");
    if (typeof claims.sub !== "string" || !/^[\w-]{1,128}$/.test(claims.sub)) throw new AuthError("compte inattendu");
    return { sub: claims.sub };
  };
}
