// Primitives de chiffrement (Web Crypto : identique sous Node 20+ et Cloudflare Workers).
const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
export async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
export const randomHex = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const toHex = hex;
