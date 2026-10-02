// La liste des prestations de la page et celle de l'API (qui valide serviceId) ne doivent jamais diverger.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("server/shared/services.json lists exactly the services offered by the page, with the same labels", async () => {
  const page = await read("../../src/js/app.js");
  const fromPage = [...page.matchAll(/\{\s*id:\s*"([a-z0-9_]+)",\s*g:\s*"([^"]+)",\s*label:\s*"((?:[^"\\]|\\.)*)",\s*kind:\s*"([a-z]+)"/g)].map((m) => ({ id: m[1], group: m[2], label: JSON.parse(`"${m[3]}"`), kind: m[4] }));
  const fromApi = JSON.parse(await read("../shared/services.json"));
  assert.ok(fromPage.length >= 15, `${fromPage.length} prestations lues dans la page`);
  assert.deepEqual(fromApi, fromPage);
  assert.equal(new Set(fromApi.map((s) => s.id)).size, fromApi.length, "identifiants uniques");
});
