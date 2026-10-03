// La fenêtre « Confidentialité et mentions légales » : ce qu'elle annonce colle à ce que fait le code (durées, services contactés), et le
// build refuse d'ouvrir l'API au public tant que src/legal.json est incomplet. Le comportement dans le navigateur est dans tests/legal.js.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const partial = read("src/partials/legal.html");
const config = JSON.parse(read("src/legal.json"));
const text = partial.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

// Un fichier complet, fictif : sert à construire la page avec la fenêtre.
const COMPLETE = {
  editorLine: "Pixcar est édité par Jeanne <Exemple> & fils, à titre non professionnel.",
  contact: "contact@exemple.test",
  hostPages: "Hébergeur des pages, 1 rue du Test, 75000 Paris",
  hostApi: "Hébergeur de l'API, 2 rue du Test, 75000 Paris",
  repairRetentionMonths: 24,
  updated: "3 octobre 2026",
};

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
// Construit la page tout-en-un à partir d'une copie des sources dont on change src/legal.json (et, au besoin, le texte).
function build({ legal = COMPLETE, api = "", allow = false, text: override = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pixcar-legal-"));
  dirs.push(dir);
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/legal.json"), JSON.stringify(legal));
  if (override) writeFileSync(join(dir, "src/partials/legal.html"), override);
  const env = { ...process.env, PIXCAR_API_BASE: api };
  delete env.PIXCAR_ALLOW_NO_LEGAL;
  if (allow) env.PIXCAR_ALLOW_NO_LEGAL = "1";
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/build.mjs"), "--only", "single", "--src", join(dir, "src"), "--out", join(dir, "out")], { env, encoding: "utf8" });
  const file = join(dir, "out/index.html");
  return { status: r.status, stderr: r.stderr, html: existsSync(file) ? readFileSync(file, "utf8") : "" };
}
const INCOMPLETE = { ...COMPLETE, editorLine: "", contact: "", repairRetentionMonths: "", updated: "" };
const hasWindow = (html) => html.includes('id="legalDlg"');
const links = (html) => html.match(/<button type="button" class="link-btn" data-open-legal>/g)?.length ?? 0;

describe("legal notice and privacy window: the text", () => {
  test("every {{legal.x}} of the text is a field of src/legal.json, and every field is used", () => {
    const used = new Set([...partial.matchAll(/\{\{legal\.([A-Za-z]+)\}\}/g)].map((m) => m[1]));
    assert.deepEqual([...used].sort(), Object.keys(config).sort());
  });

  test("the retention periods it announces are the ones the code and the stack apply", () => {
    const days = (re, where) => {
      const m = re.exec(where);
      assert.ok(m, String(re));
      return Number(m[1]);
    };
    const repo = read("server/repo.mjs");
    const stack = read("infra/pixcar-api.yaml");
    const parameterDefault = (name) => days(new RegExp(`\\n  ${name}:\\n    Type: Number\\n    Default: (\\d+)`), stack);
    assert.equal(days(/Empreintes d'adresses IP : (\d+) jours/, text), days(/FROM write_log WHERE at < now\(\) - interval '(\d+) days'/, repo));
    assert.equal(days(/Journaux techniques de l'API : (\d+) jours/, text), parameterDefault("LogRetentionDays"));
    assert.equal(days(/réponses d'OpenStreetMap \(garages d'une zone\) : (\d+) jours/, text), days(/FROM upstream_cache WHERE fetched_at < now\(\) - interval '(\d+) days'/, repo));
    assert.equal(days(/il garde (\d+) jours la réponse d'OpenStreetMap/, text), days(/FROM upstream_cache WHERE fetched_at < now\(\) - interval '(\d+) days'/, repo));
    const backups = parameterDefault("BackupRetentionDays");
    assert.equal(days(/Sauvegardes de la base : (\d+) jours/, text), backups);
    assert.equal(days(/au plus tard (\d+) jours plus tard/, text), backups);
  });

  test("the retention it announces for declarations is the one the server and the stack apply by default", () => {
    const stack = read("infra/pixcar-api.yaml");
    const stackDefault = Number(/\n  RepairRetentionMonths:\n    Type: Number\n    Default: (\d+)/.exec(stack)[1]);
    assert.ok(/\{\{legal\.repairRetentionMonths\}\} mois après leur dépôt/.test(text), "la phrase de la durée est dans le texte");
    assert.equal(config.repairRetentionMonths, stackDefault, "src/legal.json = défaut de la pile");
    assert.equal(loadConfig({}).repairRetentionMonths, stackDefault, "défaut du serveur = défaut de la pile");
  });

  test("every service the page may contact (connect-src of the security policy) is named in it", () => {
    const hosts = [...read("scripts/build.mjs").match(/const CONNECT = \[(.*?)\];/s)[1].matchAll(/"https:\/\/([^"]+)"/g)].map((m) => m[1]);
    const NAMED = {
      "data.geopf.fr": "data.geopf.fr",
      "overpass-api.de": "overpass-api.de",
      "overpass.openstreetmap.fr": "OpenStreetMap France",
      "recherche-entreprises.api.gouv.fr": "recherche-entreprises.api.gouv.fr",
      "data.economie.gouv.fr": "data.economie.gouv.fr",
      "query.wikidata.org": "Wikidata",
    };
    for (const host of hosts) {
      assert.ok(NAMED[host], `${host} : nouveau service contacté par la page ; le nommer dans src/partials/legal.html puis dans ce test`);
      assert.ok(text.includes(NAMED[host]), `${host} : « ${NAMED[host]} » n'apparaît pas dans src/partials/legal.html`);
    }
    for (const name of Object.keys(NAMED)) assert.ok(hosts.includes(name), `${name} n'est plus contacté : le retirer du texte et de ce test`);
  });
});

describe("legal notice and privacy window: the build", () => {
  test("a complete src/legal.json puts the window and its three links in the page, values escaped", () => {
    const { status, html } = build();
    assert.equal(status, 0);
    assert.ok(hasWindow(html));
    assert.equal(links(html), 3);
    assert.ok(html.includes("Jeanne &lt;Exemple&gt; &amp; fils"), "le texte de l'éditeur est échappé, jamais du HTML");
    assert.ok(html.includes('<a href="mailto:contact@exemple.test">contact@exemple.test</a>'));
    assert.ok(html.includes("24 mois après leur dépôt") || html.includes("24 mois après leur\ndépôt"), "durée de conservation des déclarations");
    assert.ok(!/\{\{legal\./.test(html), "aucune variable laissée dans la page");
    assert.match(html, /<p class="dlg-note" data-store-only="remote"><button type="button" class="link-btn" data-open-legal>/, "le lien du formulaire n'existe qu'en mode API");
  });

  test("an incomplete src/legal.json leaves the window and its links out of a page without API", () => {
    const { status, html } = build({ legal: INCOMPLETE });
    assert.equal(status, 0);
    assert.ok(!hasWindow(html));
    assert.equal(links(html), 0);
  });

  test("an incomplete src/legal.json stops the build when the API is plugged in, and says which fields are missing", () => {
    const { status, stderr, html } = build({ legal: INCOMPLETE, api: "https://api.exemple.test" });
    assert.notEqual(status, 0);
    assert.equal(html, "");
    for (const field of ["editorLine", "contact", "repairRetentionMonths", "updated"]) assert.ok(stderr.includes(`${field} : à renseigner`), `${field} : ${stderr.slice(0, 300)}`);
    for (const field of ["hostPages", "hostApi"]) assert.ok(!stderr.includes(`${field} : à renseigner`), field);
  });

  test("PIXCAR_ALLOW_NO_LEGAL=1 allows a trial build with the API, without the window", () => {
    const { status, html } = build({ legal: INCOMPLETE, api: "https://api.exemple.test", allow: true });
    assert.equal(status, 0);
    assert.ok(html.includes('content="https://api.exemple.test"'));
    assert.ok(!hasWindow(html));
  });

  test("the contact must be an e-mail address and the retention a whole number of months", () => {
    const wrongContact = build({ legal: { ...COMPLETE, contact: "via le formulaire" }, api: "https://api.exemple.test" });
    assert.notEqual(wrongContact.status, 0);
    assert.ok(wrongContact.stderr.includes("contact : une adresse électronique est attendue"));
    for (const months of ["vingt-quatre", 0, -3, 1.5]) {
      const wrongMonths = build({ legal: { ...COMPLETE, repairRetentionMonths: months }, api: "https://api.exemple.test" });
      assert.notEqual(wrongMonths.status, 0, String(months));
    }
    assert.ok(build({ legal: { ...COMPLETE, repairRetentionMonths: "x" }, api: "https://api.exemple.test" }).stderr.includes("repairRetentionMonths : un nombre entier de mois est attendu"));
  });

  test("a variable in the text that src/legal.json does not define is an error, not a blank", () => {
    const { status, stderr } = build({ text: partial + "\n<p>{{legal.nope}}</p>\n" });
    assert.notEqual(status, 0);
    assert.ok(stderr.includes("{{legal.nope}}"));
  });

  test("the repository's own src/legal.json: either complete, or the pages built with the API are refused", () => {
    // Garde de cohérence : ni demi-mesure (un champ vide dans un fichier « complet »), ni fichier complet dont le build échoue.
    const filled = Object.values(config).filter((v) => String(v).trim() !== "").length;
    const { status } = (() => {
      const dir = mkdtempSync(join(tmpdir(), "pixcar-legal-"));
      dirs.push(dir);
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/build.mjs"), "--only", "single", "--out", dir], { env: { ...process.env, PIXCAR_API_BASE: "https://api.exemple.test", PIXCAR_ALLOW_NO_LEGAL: "" }, encoding: "utf8" });
      return { status: r.status };
    })();
    assert.equal(status === 0, filled === Object.keys(config).length, `${filled} champ(s) renseigné(s) sur ${Object.keys(config).length}, build avec l'API : code ${status}`);
  });
});
