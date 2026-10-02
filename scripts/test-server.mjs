#!/usr/bin/env node
// Lance les tests de l'API (node:test) : tous les fichiers server/test/*.test.mjs, sans dépendre du shell pour développer les « * ».
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(ROOT, "server/test");
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs") && (!only.length || only.some((o) => f.includes(o))))
  .map((f) => join(dir, f));
// Avec un vrai PostgreSQL (TEST_DATABASE_URL), les fichiers partagent une même base : un seul à la fois.
const serial = process.env.TEST_DATABASE_URL ? ["--test-concurrency=1"] : [];
const r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...serial, ...files], { stdio: "inherit", cwd: ROOT });
process.exit(r.status ?? 1);
