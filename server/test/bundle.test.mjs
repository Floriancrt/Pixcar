// Le paquet qui part dans AWS (scripts/build-lambda.mjs) : reproductible, assez petit, et les deux fonctions s'y chargent et répondent
// une fois extraites, comme dans Lambda (Node, modules ES, sans node_modules ni PGlite).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildLambda } from "../../scripts/build-lambda.mjs";

describe("Lambda package", () => {
  let dir, info, extracted;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pixcar-bundle-test-"));
    info = await buildLambda({ out: join(dir, "out") });
    extracted = join(dir, "x");
    execFileSync("unzip", ["-q", info.zip, "-d", extracted]);
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test("same sources, same archive; a name that carries its fingerprint; well under Lambda's 50 MB limit", async () => {
    const again = await buildLambda({ out: join(dir, "out2") });
    assert.equal(again.hash, info.hash);
    assert.match(info.file, /^pixcar-lambda-[0-9a-f]{16}\.zip$/);
    assert.ok(info.bytes < 5 * 1024 * 1024, `${info.bytes} octets`);
  });

  test("it holds both functions, the migrations and the module type — and nothing that must not travel", () => {
    assert.deepEqual(info.files, ["api.mjs", "ops.mjs", "package.json", "db/migrations/001_init.sql"]);
    const listing = execFileSync("unzip", ["-Z1", info.zip], { encoding: "utf8" });
    assert.ok(!/node_modules|\.env|pglite|\.pem|\.key/i.test(listing), listing);
  });

  const run = (code, env = {}) =>
    JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: extracted, encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).trim().split("\n").pop());
  const production = { NODE_ENV: "production", DSQL_ENDPOINT: "abc.dsql.eu-north-1.on.aws", PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20), ALLOWED_ORIGINS: "https://pixcar.fr", TRUST_PROXY: "0", LOG_LEVEL: "error" };
  const event = (method, path, headers = {}) => ({ version: "2.0", rawPath: path, rawQueryString: "", headers: { host: "x.example", ...headers }, requestContext: { http: { method, path, sourceIp: "203.0.113.5" } } });

  test("api.mjs, extracted alone, starts in production configuration and answers: health, preflight, unknown route", () => {
    const out = run(
      `import { handler } from "./api.mjs";
       const r = await Promise.all([handler(${JSON.stringify(event("GET", "/healthz"))}), handler(${JSON.stringify(event("OPTIONS", "/v1/repairs", { origin: "https://pixcar.fr", "access-control-request-method": "POST" }))}), handler(${JSON.stringify(event("GET", "/rien"))})]);
       console.log(JSON.stringify(r.map((x) => [x.statusCode, x.headers["access-control-allow-origin"] || null])));`,
      production,
    );
    assert.deepEqual(out, [[200, null], [204, "https://pixcar.fr"], [404, null]]);
  });

  test("api.mjs refuses to start without its secrets and says so with a 503, never a crash", () => {
    const { PLATE_PEPPER, IP_PEPPER, ...noSecrets } = production;
    const out = run(`import { handler } from "./api.mjs"; const r = await handler(${JSON.stringify(event("GET", "/healthz"))}); console.log(JSON.stringify([r.statusCode, r.headers["retry-after"]]));`, noSecrets);
    assert.deepEqual(out, [503, "5"]);
  });

  test("ops.mjs, extracted alone, loads and refuses an unknown operation", () => {
    const out = run(`import { handler } from "./ops.mjs"; const r = await handler({ op: "sql" }); console.log(JSON.stringify([r.ok, /opération inconnue/.test(r.error)]));`, production);
    assert.deepEqual(out, [false, true]);
  });
});
