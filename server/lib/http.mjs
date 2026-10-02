// Petits outils HTTP au-dessus de Request / Response (API Web standard : Node 20+, Cloudflare Workers, Deno…).

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export const apiError = (status, code, message, extra = {}, headers = {}) =>
  json(status, { error: { code, message, ...extra } }, { "cache-control": "no-store", ...headers });

// Lit le corps JSON en refusant plus de maxBytes (l'en-tête Content-Length peut mentir : on compte les octets reçus).
export async function readJson(request, maxBytes = 8192) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) return { error: "too_large" };
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return { error: "content_type" };
  let received = 0;
  const chunks = [];
  const reader = request.body?.getReader();
  if (!reader) return { error: "empty" };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      reader.cancel().catch(() => {});
      return { error: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(concat(chunks, received))) };
  } catch {
    return { error: "bad_json" };
  }
}
function concat(chunks, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// CORS : l'API n'accepte que les origines listées (ALLOWED_ORIGINS), « * » pour tout accepter.
export function corsHeaders(origin, allowed) {
  const h = { vary: "Origin" };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    h["access-control-allow-origin"] = allowed.includes("*") ? "*" : origin;
    h["access-control-expose-headers"] = "retry-after, x-pixcar-stale, x-request-id"; // sans cela la page ne peut pas lire Retry-After
    h["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    h["access-control-allow-headers"] = "content-type, x-delete-token, x-turnstile-token";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

export const withHeaders = (response, headers) => {
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
};

// ETag faible d'un texte (empreinte SHA-256 tronquée). À calculer une fois par corps mis en cache, pas à chaque requête.
export async function etagOf(bodyText) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText)));
  return `W/"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

// Répond avec ETag ; renvoie 304 si le client l'a déjà. `etag` : valeur déjà calculée (sinon elle l'est ici).
export async function etagResponse(request, status, bodyText, headers, etag) {
  etag = etag || (await etagOf(bodyText));
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...headers } });
  return new Response(bodyText, { status, headers: { "content-type": "application/json; charset=utf-8", etag, ...headers } });
}
