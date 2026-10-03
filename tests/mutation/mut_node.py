#!/usr/bin/env python3
"""Mutations sur le serveur, le magasin de réparations et le client HTTP : voir lib.py (même principe, sans navigateur).

  python3 tests/mutation/mut_node.py              toutes
  python3 tests/mutation/mut_node.py jeton retry  seulement celles dont le nom contient un de ces mots
  python3 tests/mutation/mut_node.py --anchors    vérifie que chaque ancre existe encore
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run_node

V, APP, UNIT, SRV = "server/lib/validate.mjs", "server/app.mjs", "tests/unit", "server/test"
REPO, HTTP, STORE, CLIENT = "server/repo.mjs", "server/lib/http.mjs", "src/js/modules/repair-store.js", "src/js/modules/api-client.js"
M = [
 # ---- validation des déclarations
 ("price: under 1 € accepted (the database refuses it)", V, "price < PRICE_MIN ||", "price <= 0 ||", SRV, ["validate"]),
 ("price: no upper bound", V, "price > PRICE_MAX)", "price > PRICE_MAX * 10)", SRV, ["validate"]),
 ("date in the future accepted", V, "else if (date > today)", "else if (false)", SRV, ["validate"]),
 ("rating 0 accepted", V, "rating < 1 || rating > 5", "rating < 0 || rating > 5", SRV, ["validate"]),
 ("plate format not checked", V, "if (!PLATE_RE.test(plate)) bad(", "if (false) bad(", SRV, ["validate"]),
 ("control characters kept in the comment", V, 'body.comment.replace(CONTROL, "").trim()', "body.comment.trim()", SRV, ["validate"]),
 ("model year after the repair date accepted", V, "else if (isRealDate(date) && year > +date.slice(0, 4))", "else if (false)", SRV, ["validate"]),
 ("identifier not required to be a UUID v4", V, "-4[0-9a-f]{3}-[89ab]", "-[0-9a-f]{4}-[89ab]", SRV, ["validate"]),
 # ---- écriture, lecture et suppression
 ("delete: any token deletes", REPO, "AND delete_token_hash = $2 RETURNING id", "AND ($2::bytea IS NOT NULL) RETURNING id", SRV, ["api"]),
 ("replay: any token is recognised", REPO, "const sameBytes = (a, b) => !!a && !!b && Buffer.from(a).equals(Buffer.from(b));", "const sameBytes = (a, b) => true;", SRV, ["api"]),
 ("per-address limit off by one", REPO, "if (perIp.n >= ctx.limitPerHour)", "if (perIp.n > ctx.limitPerHour)", SRV, ["api"]),
 ("global limit off by one", REPO, "if (global.n >= ctx.limitGlobalPerMinute)", "if (global.n > ctx.limitGlobalPerMinute)", SRV, ["api"]),
 ("moderation never triggers (needs 500 declarations)", REPO, "if (r.n >= 5 && med > 0 &&", "if (r.n >= 500 && med > 0 &&", SRV, ["api"]),
 ("moderation ignores prices far below the median", REPO, "(priceCents < med / 3 || priceCents > med * 3)", "(priceCents > med * 3)", SRV, ["api"]),
 ("pending and rejected declarations are listed", REPO, "WHERE r.status = 'approved' AND g.area_y BETWEEN $1 AND $2", "WHERE g.area_y BETWEEN $1 AND $2", SRV, ["api"]),
 ("no cap on declarations per garage and service", REPO, "export const MAX_PER_GARAGE_SERVICE = 30;", "export const MAX_PER_GARAGE_SERVICE = 3000;", SRV, ["api"]),
 ("plate hash differs from the one forget computes", APP, "hmac(config.plateSecret, v.plate)", 'hmac(config.plateSecret, v.plate + "!")', SRV, ["moderate"]),
 ("a refused value counts as a database failure", APP, "if (isDataError(e)) {\n          failures = 0;", "if (false) {\n          failures = 0;", SRV, ["api"]),
 ("a refused value is a retried 503 instead of a final 422", APP, 'const isDataError = (e) => /^(22|23)/.test(String((e && e.code) || ""));', "const isDataError = (e) => false;", SRV, ["api"]),
 ("any radius accepted", APP, "if (!RADII_KM.includes(radius))", "if (false)", SRV, ["api"]),
 ("wrong token says 403 instead of 404", APP, 'headers: { "cache-control": "no-store" } }) : apiError(404,', 'headers: { "cache-control": "no-store" } }) : apiError(403,', SRV, ["api"]),
 ("client address read from the left of X-Forwarded-For", APP, "return hops[hops.length - mode];", "return hops[0];", SRV, ["api"]),
 ("Turnstile skipped even with a secret", APP, 'if (!config.turnstileSecret) return "ok";', 'return "ok";', SRV, ["api"]),
 ("stale copy never served when the database is down", APP, "if (hit && now() - hit.at < AREA_STALE_MS) {", "if (false) {", SRV, ["api"]),
 ("readyz answers 200 when the database is down", APP, 'json(503, { ok: false, db: "down" }', 'json(200, { ok: false, db: "down" }', SRV, ["api"]),
 ("readyz answers 200 while draining", APP, "if (draining) return json(503,", "if (false) return json(503,", SRV, ["api", "index"]),
 ("no stale-if-error on area reads", APP, "stale-while-revalidate=300, stale-if-error=86400", "stale-while-revalidate=300", SRV, ["api"]),
 ("ETag never matches (no 304)", HTTP, 'if (request.headers.get("if-none-match") === etag)', "if (false)", SRV, ["api", "index"]),
 ("any origin allowed by CORS", HTTP, 'if (origin && (allowed.includes("*") || allowed.includes(origin))) {', "if (origin) {", SRV, ["api"]),
 ("compression off", "server/index.mjs", "if (body.length >= 1024 && COMPRESSIBLE.test(type)", "if (false && COMPRESSIBLE.test(type)", SRV, ["index"]),
 ("weak secret accepted in production", "server/config.mjs", "if (v && v.length >= 16) return v;", "if (v && v.length >= 1) return v;", SRV, ["config"]),
 # ---- relais Overpass
 ("stale Overpass copy served for 7 hours instead of 7 days", "server/lib/overpass.mjs", "staleSeconds = 7 * 24 * 3600,", "staleSeconds = 7 * 3600,", SRV, ["overpass"]),
 ("no cap on simultaneous upstream requests", "server/lib/overpass.mjs", "maxConcurrent = 4,", "maxConcurrent = 4000,", SRV, ["overpass"]),
 ("upstream misses not limited per visitor", "server/lib/overpass.mjs", "(onMiss && !onMiss())", "false", SRV, ["overpass", "api"]),
 # ---- magasin de réparations (page)
 ("give-up delay shortened to 7 hours", STORE, "const GIVE_UP_MS = 7 * 864e5;", "const GIVE_UP_MS = 7 * 864e3;", UNIT, ["repair-store"]),
 ("429 retried after one second", STORE, "Math.max(60, res.retryAfter || 0)", "Math.max(1, res.retryAfter || 0)", UNIT, ["repair-store"]),
 ("rows saved before the API are uploaded", STORE, 'r.sync = "local"; // enregistrées avant l\'API', 'r.sync = "pending"; // enregistrées avant l\'API', UNIT, ["repair-store"]),
 ("duplicate: the local copy is kept", STORE, "own.splice(own.indexOf(row), 1);", "", UNIT, ["repair-store"]),
 ("undo of a deletion does not post again", STORE, 'if (row.sync === "pending" && !hasOp("post", row.id)) enqueue({ op: "post", id: row.id });', "", UNIT, ["repair-store"]),
 ("deleting a sent row does not queue a DELETE", STORE, 'if (!neverSent(post)) enqueue({ op: "delete", id, token: row.deleteToken });', "", UNIT, ["repair-store"]),
 ("saved areas never expire (7 days → 7 minutes)", STORE, "const AREA_MAX_AGE_MS = 7 * 864e5;", "const AREA_MAX_AGE_MS = 7 * 6e4;", UNIT, ["repair-store"]),
 ("back-off ceiling removed", STORE, "const BACKOFF_MAX_MS = 15 * 60_000;", "const BACKOFF_MAX_MS = 15 * 60_000_000;", UNIT, ["repair-store"]),
 ("429 treated as a final refusal", STORE, 'if (res.status === 429 || res.kind === "network" || res.kind === "timeout" || res.status >= 500) {', 'if (res.kind === "network" || res.kind === "timeout" || res.status >= 500) {', UNIT, ["repair-store"]),
 # ---- client HTTP
 ("circuit breaker needs 30 failures", CLIENT, "breaker = { threshold: 3, cooldownMs: 30_000 }", "breaker = { threshold: 30, cooldownMs: 30_000 }", UNIT, ["api-client"]),
 ("500 retried like 502/503/504", CLIENT, "const RETRYABLE_STATUS = new Set([502, 503, 504]);", "const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);", UNIT, ["api-client"]),
 ("Retry-After not capped", CLIENT, 'Math.min(60, Number(res.headers.get("retry-after")) || 0)', 'Math.min(6000, Number(res.headers.get("retry-after")) || 0)', UNIT, ["api-client"]),
 ("a success does not reset the failure count", CLIENT, "failures = 0; // le serveur répond : un 4xx est notre erreur, pas la sienne", "", UNIT, ["api-client"]),
 ("cookies sent to the API", CLIENT, 'credentials: "omit"', 'credentials: "include"', UNIT, ["api-client"]),
]
run_node(M, 56)
