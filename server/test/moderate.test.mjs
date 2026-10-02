// Outil d'exploitation : modération et effacement à la demande d'une personne (sur la vraie application et la vraie base).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { moderate, normalizePlate } from "../moderate.mjs";
import { isoDay, makeApp, repair } from "./helpers.mjs";

const SECRET = "secret-de-plaques-d-essai-0123456789";
const run = async (t, argv, plateSecret = SECRET) => {
  const lines = [], errors = [];
  const code = await moderate(argv, { db: t.db, plateSecret, out: (l) => lines.push(typeof l === "string" ? l : JSON.stringify(l)), err: (l) => errors.push(l) });
  return { code, lines, errors };
};
const post = (t, body, ip) => t.call("POST", "/v1/repairs", { body, ip });

describe("normalizePlate", () => {
  test("accepts the usual ways of writing a plate and refuses anything else", () => {
    for (const ok of ["AB-123-CD", "ab-123-cd", "ab 123 cd", "AB123CD", "ab.123.cd", " ab–123–cd "]) assert.equal(normalizePlate(ok), "AB-123-CD", ok);
    for (const bad of ["", "AB-12-CD", "1234 AB 56", "ABC-123-DE", "AB-123-C", "A1-123-CD"]) assert.throws(() => normalizePlate(bad), /format AB-123-CD/, bad);
  });
});

describe("forget", () => {
  test("removes every declaration of a plate (rejected ones too), and nothing else", async () => {
    const t = await makeApp({ config: { plateSecret: SECRET } });
    try {
      const mine1 = repair({ vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" }, date: isoDay(10) });
      const mine2 = repair({ vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" }, date: isoDay(40), serviceId: "revision" });
      const other = repair({ vehicle: { model: "Renault Clio", year: 2020, plate: "FG-456-HJ" } });
      for (const [i, r] of [mine1, mine2, other].entries()) assert.equal((await post(t, r, `198.51.100.${i + 1}`)).status, 201);
      assert.ok(await t.app.repo.setStatus(mine2.id, "rejected"));

      const out = await run(t, ["forget", "ez 108 bc"]);
      assert.equal(out.code, 0);
      assert.deepEqual(out.lines, ["EZ-108-BC : 2 déclaration(s) supprimée(s)"]);
      const left = (await t.db.query("SELECT id FROM repairs")).rows.map((r) => r.id);
      assert.deepEqual(left, [other.id]);
      // la plaque peut de nouveau déclarer (l'empreinte de doublon est partie avec les lignes)
      assert.equal((await post(t, repair({ vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" }, date: isoDay(10) }), "198.51.100.9")).status, 201);
    } finally {
      await t.close();
    }
  });

  test("refuses to run without the secret, without a plate or with a bad one (and deletes nothing then); another secret matches nothing", async () => {
    const t = await makeApp({ config: { plateSecret: SECRET } });
    try {
      const r = repair({ vehicle: { model: "Peugeot 208", year: 2019, plate: "EZ-108-BC" } });
      assert.equal((await post(t, r)).status, 201);
      await assert.rejects(() => run(t, ["forget", "EZ-108-BC"], ""), /PLATE_PEPPER/);
      await assert.rejects(() => run(t, ["forget"]), /usage/);
      await assert.rejects(() => run(t, ["forget", "EZ-108-BC", "n'importe quoi"]), /format AB-123-CD/);
      assert.equal((await t.db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n, 1, "rien n'est supprimé tant que toutes les plaques ne sont pas valides");
      const wrong = await run(t, ["forget", "EZ-108-BC"], "un-autre-secret-de-plus-de-16-caracteres");
      assert.deepEqual(wrong.lines, ["EZ-108-BC : 0 déclaration(s) supprimée(s)"]);
      assert.equal((await t.db.query("SELECT count(*)::int AS n FROM repairs")).rows[0].n, 1);
    } finally {
      await t.close();
    }
  });
});

describe("moderation commands", () => {
  test("list, approve, reject, stats and unknown commands", async () => {
    const t = await makeApp({ config: { plateSecret: SECRET } });
    try {
      for (let i = 0; i < 6; i++) await post(t, repair({ price: 60 + i }), `198.51.100.${i + 1}`);
      const high = repair({ price: 900, comment: "prix étonnant" });
      assert.equal((await (await post(t, high, "198.51.100.50")).json()).status, "pending");
      const listed = await run(t, ["list"]);
      assert.equal(listed.lines.length, 1);
      assert.match(listed.lines[0], new RegExp(`^${high.id}  .*900\\.00 €.*prix étonnant`));
      assert.deepEqual((await run(t, ["approve", high.id, "00000000-0000-4000-8000-000000000000"])).lines, [`${high.id} : ok`, "00000000-0000-4000-8000-000000000000 : introuvable"]);
      assert.deepEqual((await run(t, ["list"])).lines, ["Rien en attente."]);
      assert.deepEqual((await run(t, ["reject", high.id])).lines, [`${high.id} : ok`]);
      assert.deepEqual((await run(t, ["stats"])).lines, ['{"approved":6,"rejected":1}']);
      await assert.rejects(() => run(t, ["approve"]), /usage/);
      const unknown = await run(t, ["fais-moi-un-café"]);
      assert.equal(unknown.code, 2);
      assert.match(unknown.errors[0], /Commandes/);
    } finally {
      await t.close();
    }
  });
});
