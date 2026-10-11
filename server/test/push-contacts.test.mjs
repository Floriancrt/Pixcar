// scripts/pro/push-contacts.mjs : chargement des contacts privés par lots, de bout en bout jusqu'à la base (fonction d'opérations réelle,
// PGlite), sans AWS.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pushContacts, readContacts } from "../../scripts/pro/push-contacts.mjs";
import { createOps } from "../ops.mjs";
import { migrate } from "../migrate.mjs";
import { freshDb } from "./helpers.mjs";

describe("push-contacts", () => {
  let db, ops, dir;
  before(async () => {
    db = await freshDb();
    await migrate(db);
    ops = createOps({ openDb: async () => ({ ...db, close: async () => {} }), env: {} });
    dir = await mkdtemp(join(tmpdir(), "pixcar-push-"));
  });
  after(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const row = (n) => ({ id: `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Garage ${n}`, lat: 43 + n / 10000, lon: 1, emails: [`g${n}@garage${n}.fr`] });

  test("reads JSON Lines, sends batches, then removes what the complete load did not rewrite", async () => {
    const file = join(dir, "c.jsonl");
    await writeFile(file, Array.from({ length: 7 }, (_, i) => JSON.stringify(row(i + 1))).join("\n") + "\n\n");
    const rows = await readContacts(file);
    assert.equal(rows.length, 7);
    const calls = [];
    const invoke = async (p) => (calls.push([p.op, p.rows ? p.rows.length : 0]), ops(p));
    assert.deepEqual(await pushContacts({ rows, invoke, importId: "a", batch: 3 }), { importId: "a", written: 7, rejected: 0, removed: 0 });
    assert.deepEqual(calls, [["import-contacts", 3], ["import-contacts", 3], ["import-contacts", 1], ["prune-contacts", 0]]);
    const out = await pushContacts({ rows: rows.slice(0, 5), invoke, importId: "b", batch: 500 });
    assert.deepEqual([out.written, out.removed], [5, 2]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM garage_contacts")).rows[0].n, 5);
  });

  test("a refused batch stops everything before any removal", async () => {
    const seen = [];
    const invoke = async (p) => (seen.push(p.op), p.op === "import-contacts" && seen.length === 2 ? { ok: false, error: "base indisponible" } : ops(p));
    await assert.rejects(pushContacts({ rows: [row(1), row(2), row(3)], invoke, importId: "c", batch: 1 }), /lot 2 refusé : base indisponible/);
    assert.ok(!seen.includes("prune-contacts"));
  });

  test("an unreadable line is reported with its number", async () => {
    const file = join(dir, "bad.jsonl");
    await writeFile(file, JSON.stringify(row(1)) + "\n{pas du json\n");
    await assert.rejects(readContacts(file), /ligne 2/);
  });
});
