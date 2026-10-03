#!/usr/bin/env node
// Construit le paquet des fonctions AWS Lambda de l'API (une seule archive pour les deux fonctions : api.handler et ops.handler).
//   node scripts/build-lambda.mjs [--out dossier]      →  <out>/pixcar-lambda-<empreinte>.zip  (+ <out>/build.json)
// Contenu : api.mjs (server/lambda.mjs et tout ce qu'il charge, dont pg et le connecteur Aurora DSQL), ops.mjs (server/ops.mjs),
// db/migrations/*.sql (lues à l'exécution par la fonction d'opérations), package.json {"type":"module"}.
// Reproductible : mêmes sources → même archive (dates fixées, ordre fixe) → même empreinte → même nom de fichier : CloudFormation ne
// remplace la fonction que si le code a réellement changé.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OUT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "dist-lambda"));

// Les dépendances CommonJS (pg…) appellent require() sur les modules de Node : en sortie ESM il faut le leur fournir.
const BANNER = `import { createRequire as __pixcarCreateRequire } from "node:module"; const require = __pixcarCreateRequire(import.meta.url);`;

export async function buildLambda({ out = OUT } = {}) {
  const work = await mkdtemp(join(tmpdir(), "pixcar-lambda-"));
  try {
    await build({
      entryPoints: { api: join(ROOT, "server/lambda.mjs"), ops: join(ROOT, "server/ops.mjs") },
      outdir: work,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      banner: { js: BANNER },
      // jamais utilisés dans Lambda : la base embarquée de développement et le pilote natif facultatif de pg
      external: ["@electric-sql/pglite", "pg-native"],
      legalComments: "none",
      logLevel: "warning",
    });
    await writeFile(join(work, "package.json"), '{"type":"module"}\n');
    await mkdir(join(work, "db/migrations"), { recursive: true });
    for (const f of (await readdir(join(ROOT, "db/migrations"))).sort()) await cp(join(ROOT, "db/migrations", f), join(work, "db/migrations", f));

    // archive reproductible : dates fixées, ordre alphabétique
    const names = ["api.mjs", "ops.mjs", "package.json", ...(await readdir(join(work, "db/migrations"))).sort().map((f) => `db/migrations/${f}`)];
    const sources = createHash("sha256");
    for (const n of names) sources.update(n).update(await readFile(join(work, n)));
    const hash = sources.digest("hex").slice(0, 16);
    await mkdir(out, { recursive: true });
    const zip = join(out, `pixcar-lambda-${hash}.zip`);
    await rm(zip, { force: true });
    execFileSync("sh", ["-c", `find . -type f | sort | sed 's|^\\./||' | xargs touch -d '2020-01-01 00:00:00 UTC' && find . -type f | sort | sed 's|^\\./||' | zip -X -q "${zip}" -@`], { cwd: work });
    const bytes = (await readFile(zip)).length;
    const info = { zip, file: `pixcar-lambda-${hash}.zip`, hash, bytes, handlers: { api: "api.handler", ops: "ops.handler" }, files: names };
    await writeFile(join(out, "build.json"), JSON.stringify(info, null, 2) + "\n");
    return info;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const info = await buildLambda();
  console.log(`${info.file}  ${(info.bytes / 1024).toFixed(0)} Ko  (empreinte ${info.hash})`);
  console.log(`→ ${info.zip}`);
}
