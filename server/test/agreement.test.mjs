// Accord de sous-traitance des données (docs/sous-traitance.md) : lecture et acceptation par le garage (preuve : version, signataire,
// date), refus des écritures qu'il couvre tant qu'il n'est pas accepté (personnel, absences, rendez-vous saisis), lecture et suppression
// toujours possibles, nouvelle version à accepter, fin au retrait du rattachement, preuve gardée 5 ans. Base réelle (PGlite).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { loadConfig } from "../config.mjs";
import { makeApp } from "./helpers.mjs";
import { parisInstant } from "../../src/js/shared/rdv.js";
import { AGREEMENT } from "../../src/js/shared/agreement.js";

const HERE = { lat: 43.2174, lon: 1.1014 };
const DUPONT = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACTS = [{ id: DUPONT, name: "Garage Dupont", addr: "12 rue de l'Exemple", pc: "31220", ...HERE, emails: ["contact@garage-dupont.fr"], phones: ["+33561000001"] }];
const H = [["08:00", "12:00"], ["14:00", "18:00"]];
const WEEK = { mo: H, tu: H, we: H, th: H, fr: H };
const SLOT = { name: "Entretien courant", days: ["mo", "tu", "we", "th", "fr"], start: "08:00", end: "12:00", mode: "hour", capacity: 2, services: ["vidange"] };
const MONDAY = parisInstant("2026-10-19", 600);
const WED = "2026-10-21";
const ACCEPT = { version: AGREEMENT.version, accept: true };

describe("Accord de sous-traitance", () => {
  let t;
  const json = async (res) => ({ status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) });
  const pro = (method, path, body, who = "alice") => t.call(method, `/v1/pro/garages/${DUPONT}${path}`, { body, headers: { "x-pro-dev-account": who } }).then(json);
  const outbox = () => t.app.pro.senders.outbox;
  const lastCode = (to) => {
    const m = outbox().filter((x) => x.channel === "rdv" && x.target === to && /code (\d{6})/.test(x.subject)).at(-1);
    return m && /code (\d{6})/.exec(m.subject)[1];
  };
  const own = (who, holder = "Camille Durand") =>
    t.db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', $4, 'manager', $5, 'c•••@x.fr', now())",
      [crypto.randomUUID(), "dev-" + who, DUPONT, holder, "a".repeat(64)],
    );
  const rows = async () => (await t.db.query("SELECT version, account_id, signer, ended_at FROM pro_agreements ORDER BY accepted_at")).rows;
  // calcul par créneaux, rendez-vous en ligne ouverts : de quoi noter un rendez-vous
  async function openGarage() {
    await own("alice");
    assert.equal((await pro("PUT", "/profile", { hours: WEEK })).status, 200);
    assert.equal((await pro("PUT", "/services/vidange", { offered: true, minutes: 45 })).status, 200);
    assert.equal((await pro("POST", "/rdv/notify", { email: "atelier@garage-dupont.fr" })).status, 200);
    assert.equal((await pro("POST", "/rdv/notify/code", { code: lastCode("atelier@garage-dupont.fr") })).status, 200);
    assert.equal((await pro("POST", "/rdv/slots", SLOT)).status, 200);
    assert.equal((await pro("PUT", "/rdv/settings", { enabled: true, minDelayH: 0 })).status, 200);
  }
  const phoneJob = (over = {}) => ({ kind: "job", client: "M. Martin", phone: "06 12 34 56 78", car: "Renault Clio", services: [{ id: "vidange" }], day: WED, time: "09:00", minutes: 45, channel: "phone", ...over });

  before(async () => {
    t = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", RDV_ENABLED: "1", PRO_AGREEMENT_REQUIRED: "1", READ_LIMIT_PER_MINUTE: "100000", WRITE_LIMIT_PER_HOUR: "1000" }, now: () => MONDAY });
  });
  after(() => t.close());
  beforeEach(async () => {
    outbox().length = 0;
    await t.reset();
    await t.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "test-1");
  });

  test("the garage reads the version in force, accepts it once (case ticked, version read), the proof keeps signer and date", async () => {
    await own("alice");
    assert.deepEqual((await pro("GET", "/agreement")).body, { version: AGREEMENT.version, label: AGREEMENT.label, draft: AGREEMENT.draft, accepted: false, required: true });
    assert.equal((await pro("GET", "")).body.agreement.accepted, false, "résumé du garage");
    // case non cochée, version changée entre-temps, corps illisible : rien n'est enregistré
    const unticked = await pro("POST", "/agreement", { version: AGREEMENT.version });
    assert.deepEqual([unticked.status, unticked.body.error.field], [422, "accept"]);
    const stale = await pro("POST", "/agreement", { version: "2000-01-01", accept: true });
    assert.deepEqual([stale.status, stale.body.error.code, stale.body.error.version], [409, "agreement_version", AGREEMENT.version]);
    assert.equal((await pro("POST", "/agreement", "pas du json")).status, 400);
    assert.deepEqual(await rows(), []);
    // un autre compte, ou un garage qui n'est pas le sien : introuvable
    assert.equal((await pro("GET", "/agreement", undefined, "bob")).status, 404);
    assert.equal((await pro("POST", "/agreement", ACCEPT, "bob")).status, 404);
    // acceptée : 201, puis 200 avec la même preuve (la première fait foi)
    const first = await pro("POST", "/agreement", ACCEPT);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.accepted, first.body.signer, first.body.version], [true, "Camille Durand", AGREEMENT.version]);
    assert.match(first.body.acceptedAt, /^\d{4}-\d\d-\d\dT/);
    const again = await pro("POST", "/agreement", ACCEPT);
    assert.deepEqual([again.status, again.body.acceptedAt], [200, first.body.acceptedAt]);
    assert.deepEqual(await rows(), [{ version: AGREEMENT.version, account_id: "dev-alice", signer: "Camille Durand", ended_at: null }]);
    assert.deepEqual((await pro("GET", "")).body.agreement, { ...first.body });
    assert.equal((await pro("PUT", "/agreement", ACCEPT)).status, 405);
  });

  test("the team, absences and bookings noted by the garage wait for the acceptance; reading, other settings and deletions do not", async () => {
    await openGarage();
    const refused = await pro("POST", "/rdv/calendar/blocks", phoneJob());
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.version], [403, "agreement_required", AGREEMENT.version]);
    assert.match(refused.body.error.message, /accord de sous-traitance/);
    assert.equal((await pro("POST", "/rdv/calendar/blocks", { kind: "hold", label: "Réunion", day: WED, time: "14:00", end: "15:00" })).body.error.code, "agreement_required", "créneau bloqué : un libellé libre");
    // le calcul par ressources : ses mécaniciens et leurs absences aussi ; pas ses postes ni ses réglages
    assert.equal((await pro("POST", "/rdv/calendar/start")).status, 200);
    assert.equal((await pro("POST", "/rdv/calendar/staff", { name: "Paul" })).body.error.code, "agreement_required");
    assert.equal((await pro("POST", "/rdv/calendar/unavail", { targetId: crypto.randomUUID(), kind: "leave", from: WED, to: WED })).body.error.code, "agreement_required");
    const lift = await pro("POST", "/rdv/calendar/resources", { name: "Pont n°1", type: "lift" });
    assert.equal(lift.status, 200, JSON.stringify(lift.body));
    assert.equal((await pro("GET", "/rdv/calendar/agenda?from=" + WED + "&to=" + WED)).status, 200);
    assert.equal(await t.db.query("SELECT count(*)::int AS n FROM rdv_blocks").then((r) => r.rows[0].n), 0);
    // accepté : tout s'enregistre
    assert.equal((await pro("POST", "/agreement", ACCEPT)).status, 201);
    const job = await pro("POST", "/rdv/calendar/blocks", phoneJob());
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const paul = await pro("POST", "/rdv/calendar/staff", { name: "Paul" });
    assert.equal(paul.status, 200, JSON.stringify(paul.body));
    // une nouvelle version (simulée : l'acceptation porte sur une autre) : plus d'ajout ni de modification, mais la suppression reste
    await t.db.query("UPDATE pro_agreements SET version = '2000-01-01'");
    assert.equal((await pro("GET", "/agreement")).body.accepted, false);
    assert.equal((await pro("PUT", `/rdv/calendar/blocks/${job.body.saved}`, phoneJob({ client: "M. Martin-Durand" }))).body.error.code, "agreement_required");
    assert.equal((await pro("PUT", `/rdv/calendar/staff/${paul.body.saved}`, { name: "Paulo" })).body.error.code, "agreement_required");
    for (const path of [`/rdv/calendar/blocks/${job.body.saved}`, `/rdv/calendar/staff/${paul.body.saved}`]) {
      const del = await pro("DELETE", path);
      assert.ok(del.status === 200 || del.status === 204, `${path} : ${del.status} ${JSON.stringify(del.body)}`);
    }
    assert.equal(await t.db.query("SELECT count(*)::int AS n FROM rdv_blocks").then((r) => r.rows[0].n), 0);
  });

  test("the attachment withdrawn ends the agreement: the next holder accepts again; the proof is purged 5 years after the end", async () => {
    await own("alice");
    assert.equal((await pro("POST", "/agreement", ACCEPT)).status, 201);
    assert.equal(await t.app.pro.repo.revoke(DUPONT), 1);
    const [ended] = await rows();
    assert.ok(ended.ended_at, "close au retrait");
    // un nouveau titulaire : l'accord est à accepter de nouveau, à son nom
    await own("bob", "Dominique Martin");
    assert.equal((await pro("GET", "/agreement", undefined, "bob")).body.accepted, false);
    const b = await pro("POST", "/agreement", ACCEPT, "bob");
    assert.deepEqual([b.status, b.body.signer], [201, "Dominique Martin"]);
    // purge : la preuve close depuis plus de 5 ans part, celle d'il y a 4 ans et celle en cours restent
    await t.db.query("UPDATE pro_agreements SET ended_at = now() - interval '5 years 1 day' WHERE account_id = 'dev-alice'");
    await t.db.query("INSERT INTO pro_agreements (id, garage_id, version, account_id, signer, ended_at) VALUES ($1, $2, '2022-01-01', 'dev-old', 'Ancien Titulaire', now() - interval '4 years')", [crypto.randomUUID(), DUPONT]);
    assert.equal((await t.app.pro.repo.purge()).proAgreements, 1);
    assert.deepEqual((await rows()).map((r) => r.account_id).sort(), ["dev-bob", "dev-old"]);
  });

  test("the switch: required as soon as the text is no longer a draft, unless forced", () => {
    assert.equal(loadConfig({}).pro.agreementRequired, !AGREEMENT.draft);
    assert.equal(loadConfig({ PRO_AGREEMENT_REQUIRED: "1" }).pro.agreementRequired, true);
    assert.equal(loadConfig({ PRO_AGREEMENT_REQUIRED: "0" }).pro.agreementRequired, false);
  });
});
