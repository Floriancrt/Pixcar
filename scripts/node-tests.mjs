#!/usr/bin/env node
// Lance les tests node:test d'un dossier (tous les fichiers *.test.mjs), sans dépendre du shell pour développer les « * ».
//   node scripts/node-tests.mjs server/test            l'API
//   node scripts/node-tests.mjs tests/unit             modules de la page (client HTTP, stockage des réparations…)
//   node scripts/node-tests.mjs server/test overpass   seulement les fichiers dont le nom contient « overpass »
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [dirArg, ...only] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage : node scripts/node-tests.mjs <dossier> [filtre…]");
  process.exit(2);
}
const dir = join(ROOT, dirArg);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs") && (!only.length || only.some((o) => f.includes(o))))
  .map((f) => join(dir, f));
// Avec un vrai PostgreSQL (TEST_DATABASE_URL), les fichiers partagent une même base : un seul à la fois.
const serial = process.env.TEST_DATABASE_URL ? ["--test-concurrency=1"] : [];
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...serial, ...files], { stdio: "inherit", cwd: ROOT });
process.exit(r.status ?? 1);
