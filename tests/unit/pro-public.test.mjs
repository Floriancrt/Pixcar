// Comparateur, « Mon garage » (src/js/modules/pro-public.js) : ce que la page garde du profil publié par l'API, et ce que le garage dit faire.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProPublic } from "../../src/js/modules/pro-public.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
async function loaded(garage) {
  let done;
  const ready = new Promise((r) => (done = r));
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ garages: [{ id: ID, verified: true, prices: [], ...garage }] }) });
  const pro = createProPublic({ base: "https://api.test", fetchImpl, onUpdate: done, delayMs: 0 });
  const g = { tableId: ID };
  pro.need([g]);
  await ready;
  return { pro, g };
}

test("a well-formed profile is kept whole; services said done or not done", async () => {
  const profile = { name: "Garage Martin & Fils", addr: { street: "5 rue Neuve", pc: "31220", city: "Cazères" }, phone: "+33561000099", website: "https://garage-martin.fr/", email: "atelier@garage-martin.fr", hours: { mo: [["08:00", "12:00"], ["14:00", "18:00"]], su: [["00:00", "24:00"]] } };
  const { pro, g } = await loaded({ profile, services: { offered: ["vidange"], notOffered: ["clim", "pas-une-prestation"] } });
  assert.deepEqual(pro.profile(g), profile);
  assert.equal(pro.offers(g, "vidange"), true);
  assert.equal(pro.offers(g, "clim"), false);
  assert.equal(pro.offers(g, "diag"), null);
  assert.equal(pro.offers(g, ""), null);
  assert.equal(pro.offers({ tableId: "bbbbbbbb-0000-4000-8000-000000000002" }, "vidange"), null);
});

test("anything malformed is dropped: never a website other than http(s), no odd phone, no broken hours", async () => {
  const { pro, g } = await loaded({
    profile: { name: "x".repeat(121), addr: { street: "5 rue Neuve", pc: "3122", city: "Cazères" }, phone: "05 61 00 00 99", website: "javascript:alert(1)", email: "pas un mail", hours: { mo: [["8h", "12h"]] } },
    services: "rien",
  });
  assert.equal(pro.profile(g), null);
  assert.equal(pro.offers(g, "vidange"), null);
  const other = await loaded({ profile: { website: 'https://garage.fr/"><script>', hours: { xx: [["08:00", "12:00"]] }, email: "atelier@garage.fr" } });
  assert.deepEqual(other.pro.profile(other.g), { email: "atelier@garage.fr" });
});

test("online booking: the services taken online, and those the garage confirms at once (advanced calendar)", async () => {
  const { pro, g } = await loaded({ rdv: { services: ["vidange", "plaq_av", "zzz"], auto: ["vidange"] } });
  assert.equal(pro.books(g, ["vidange", "plaq_av"]), true);
  assert.equal(pro.books(g, ["vidange", "clim"]), false);
  assert.equal(pro.instant(g, ["vidange"]), true);
  assert.equal(pro.instant(g, ["vidange", "plaq_av"]), false, "une prestation à confirmer rend la demande à confirmer");
  assert.equal(pro.instant(g, []), false);
  assert.match(pro.rdvHtml("", true), /Le garage le confirme aussitôt/);
  assert.match(pro.rdvHtml(), /au plus tard à midi le jour ouvré suivant/);
  const old = await loaded({ rdv: { services: ["vidange"] } });
  assert.equal(old.pro.instant(old.g, ["vidange"]), false);
});
