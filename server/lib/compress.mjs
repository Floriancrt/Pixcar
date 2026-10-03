// Compression des réponses (brotli ou gzip selon ce que le client accepte), partagée par le serveur Node (index.mjs) et la fonction
// Lambda (lambda.mjs). Une réponse identique (même ETag) est compressée UNE fois, pas à chaque requête : c'est le coût le plus lourd
// d'une lecture.
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const COMPRESSIBLE = /^(application\/json|text\/|application\/javascript|image\/svg\+xml)/i;
const packed = new Map();
const pack = (key, make) => {
  if (!key) return make();
  let hit = packed.get(key);
  if (!hit) {
    hit = make();
    packed.set(key, hit);
    if (packed.size > 200) packed.delete(packed.keys().next().value);
  }
  return hit;
};

/**
 * Renvoie { encoding, body } si la réponse mérite d'être compressée et que le client le permet, sinon null.
 * body : Buffer en clair. type : en-tête content-type. etag : sert de clé de cache à la copie compressée.
 */
export function compressIfUseful({ body, type = "", acceptEncoding = "", etag = "", alreadyEncoded = false }) {
  if (alreadyEncoded || body.length < 1024 || !COMPRESSIBLE.test(type)) return null;
  const accept = String(acceptEncoding);
  if (/\bbr\b/.test(accept)) return { encoding: "br", body: pack(etag && "br|" + etag, () => brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })) };
  if (/\bgzip\b/.test(accept)) return { encoding: "gzip", body: pack(etag && "gzip|" + etag, () => gzipSync(body, { level: 6 })) };
  return null;
}
