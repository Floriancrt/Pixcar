// Les prestations déclarables viennent de la même définition que celles de la page : elles ne peuvent pas diverger.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OTHER_SERVICE, REPAIR_SERVICES, SERVICES } from "../../src/js/shared/services.js";
import { loadServices } from "../app.mjs";
import { makeApp, repair } from "./helpers.mjs";

test("the declarable services are the page's, « autre » included, the official-price technical inspection excluded", async () => {
  assert.ok(SERVICES.length >= 15);
  assert.equal(new Set(SERVICES.map((s) => s.id)).size, SERVICES.length, "identifiants uniques");
  for (const s of SERVICES) assert.ok(s.id && s.g && s.label && s.kind, JSON.stringify(s));
  assert.ok(REPAIR_SERVICES.includes(OTHER_SERVICE) && !REPAIR_SERVICES.includes("ct"));
  assert.deepEqual([...(await loadServices())].sort(), [...REPAIR_SERVICES].sort());
});

test("the API accepts every service the repair form offers (including « Autre réparation »), and refuses the technical inspection", async () => {
  const t = await makeApp();
  try {
    let n = 0;
    for (const serviceId of REPAIR_SERVICES) {
      const res = await t.call("POST", "/v1/repairs", { body: repair({ serviceId }), ip: `198.51.100.${(n++ % 200) + 1}` });
      assert.equal(res.status, 201, `${serviceId} : ${await res.text()}`);
    }
    const ct = await t.call("POST", "/v1/repairs", { body: repair({ serviceId: "ct" }) });
    assert.equal(ct.status, 422);
    assert.ok("serviceId" in (await ct.json()).error.fields);
  } finally {
    await t.close();
  }
});
