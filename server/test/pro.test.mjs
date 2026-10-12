// Espace Pro : vérification qu'un compte gère un garage (SIRET, choix du moyen, code, limites). Base réelle (PGlite), application réelle,
// registre des entreprises simulé, envois gardés en mémoire.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { parseContactRows } from "../lib/contact.mjs";
import { ORIGIN, makeApp } from "./helpers.mjs";

// SIRET dont la clé de Luhn est juste : 13 chiffres + la clé
export function siretOf(prefix13) {
  for (let k = 0; k <= 9; k++) {
    const s = prefix13 + k;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      let d = Number(s[13 - i]);
      if (i % 2 === 1) (d *= 2) > 9 && (d -= 9);
      sum += d;
    }
    if (sum % 10 === 0) return s;
  }
}

const HERE = { lat: 43.2174, lon: 1.1014 }; // Cazères
const north = (m, p = HERE) => ({ lat: p.lat + m / 111_320, lon: p.lon });

const CONTACTS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Garage Dupont", addr: "12 rue de la Gare", pc: "31220", ...HERE, emails: ["Contact@Garage-Dupont.fr"], phones: ["+33561976545", "+33612345678"], web: "https://www.garage-dupont.fr/" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Norauto Cazères", pc: "31220", ...north(120), brand: true, emails: ["cazeres@norauto.fr"], phones: ["+33561000002"], web: "https://www.norauto.fr/" },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", name: "Carrosserie Martin", pc: "31220", ...north(150), phones: ["+33698765432"], web: "https://martin.wixsite.com/carrosserie" },
  { id: "aaaaaaaa-0000-4000-8000-000000000004", name: "Garage Lointain", pc: "31220", ...north(5000), emails: ["loin@exemple.fr"] },
  { id: "aaaaaaaa-0000-4000-8000-000000000005", name: "Auto Sud Cazères", pc: "31220", ...north(200), web: "https://auto-sud.fr" },
  { id: "aaaaaaaa-0000-4000-8000-000000000006", name: "Auto Sud Martres", pc: "31220", ...north(9000), web: "https://www.auto-sud.fr/" },
  { id: "aaaaaaaa-0000-4000-8000-000000000007", name: "Pneus Express Moreau", pc: "31220", ...north(250), phones: ["+33561000007"], web: "https://pneus-moreau.fr/contact" },
  { id: "aaaaaaaa-0000-4000-8000-000000000008", name: "Garage Petit", pc: "31220", ...north(60), emails: ["petit@garage-petit.fr"] },
];
const A = CONTACTS[0].id, C = CONTACTS[2].id, D = CONTACTS[3].id;

const S = {
  dupont: siretOf("1234567890001"),
  closed: siretOf("1234567890002"),
  ct: siretOf("1234567890003"),
  nopos: siretOf("1234567890004"),
  far: siretOf("1234567890005"),
  down: siretOf("1234567890006"),
};
const etab = (o) => ({ name: "GARAGE DUPONT", company: "DUPONT SARL", addr: "12 RUE DE LA GARE 31220 CAZERES", naf: "45.20A", active: true, pc: "31220", ...north(25), ...o });
const REGISTRY = {
  [S.dupont]: etab({ siret: S.dupont }),
  [S.closed]: etab({ siret: S.closed, active: false }),
  [S.ct]: etab({ siret: S.ct, naf: "71.20A" }),
  [S.nopos]: etab({ siret: S.nopos, name: "DUPONT", lat: null, lon: null }),
  [S.far]: etab({ siret: S.far, ...north(2000) }),
};

describe("Espace Pro : vérification d'un garagiste", () => {
  let t, sirene;
  const outbox = () => t.app.pro.senders.outbox;
  const as = (who) => ({ "x-pro-dev-account": who });
  const call = (who, method, path, body) => t.call(method, path, { body, headers: who ? as(who) : {} });
  const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
  const HOLDER = { firstName: "Camille", lastName: "Durand", role: "manager", certify: true };
  const claim = (who, body) => call(who, "POST", "/v1/pro/claims", { siret: S.dupont, garageId: A, option: "email:0", holder: HOLDER, ...body }).then(json);
  const lastCode = () => outbox()[outbox().length - 1].code;
  const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  before(async () => {
    sirene = { fail: false, calls: 0 };
    t = await makeApp({
      env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1" },
      proOptions: {
        sirene: async (siret) => {
          sirene.calls++;
          if (siret === S.down || sirene.fail) throw new Error("injoignable");
          return REGISTRY[siret] || null;
        },
      },
    });
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    outbox().length = 0;
    const { rows, rejected } = parseContactRows(CONTACTS);
    assert.equal(rejected, 0);
    await t.app.pro.repo.upsertContacts(rows, "test-1");
  });

  test("closed by default: without PRO_ENABLED every /v1/pro route answers 404 « pro_disabled »", async () => {
    const off = await makeApp();
    try {
      const r = await json(await off.call("GET", "/v1/pro/me", { headers: as("x") }));
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, "pro_disabled");
    } finally {
      await off.close();
    }
  });

  test("an account is required (401 with WWW-Authenticate); the development header works only when allowed", async () => {
    const r = await json(await call(null, "GET", "/v1/pro/me"));
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /^Bearer/);
    assert.equal((await json(await t.call("GET", "/v1/pro/me", { headers: { authorization: "Bearer pas.un.jeton" } }))).status, 401);
    const me = await json(await call("alice", "GET", "/v1/pro/me"));
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { account: "dev-alice", claims: [] });
    const noDev = await makeApp({ env: { PRO_ENABLED: "1" } });
    try {
      assert.equal((await noDev.call("GET", "/v1/pro/me", { headers: as("alice") })).status, 401);
    } finally {
      await noDev.close();
    }
  });

  test("with Cognito: a Bearer token checked by the verifier gives the account; a refused token is a 401, a verifier failure a 503", async () => {
    const { AuthError } = await import("../lib/jwt.mjs");
    let down = false;
    const app = await makeApp({
      env: { PRO_ENABLED: "1" },
      proOptions: {
        verifier: async (token) => {
          if (down) throw Object.assign(new Error("clés injoignables"), { unavailable: true });
          if (token === "bon.jeton.signe") return { sub: "cognito-sub-1" };
          throw new AuthError("signature invalide");
        },
      },
    });
    try {
      const me = await app.call("GET", "/v1/pro/me", { headers: { authorization: "Bearer bon.jeton.signe" } });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).account, "cognito-sub-1");
      assert.equal((await app.call("GET", "/v1/pro/me", { headers: { authorization: "Bearer faux.jeton.signe" } })).status, 401);
      assert.equal((await app.call("GET", "/v1/pro/me", { headers: { authorization: "Basic eDp5" } })).status, 401);
      down = true;
      assert.equal((await app.call("GET", "/v1/pro/me", { headers: { authorization: "Bearer bon.jeton.signe" } })).status, 503);
    } finally {
      await app.close();
    }
  });

  test("the browser may send the Authorization header (CORS)", async () => {
    const res = await t.call("OPTIONS", "/v1/pro/me", { origin: ORIGIN });
    assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
  });

  test("SIRET checks: format and key, unknown, closed, not a garage activity, registry down", async () => {
    const code = async (siret) => (await json(await call("alice", "GET", `/v1/pro/siret/${siret}`))).body.error?.code;
    assert.equal(await code("12345678900011"), "bad_siret"); // mauvaise clé
    assert.equal(await code("123"), "bad_siret");
    assert.equal(await code(siretOf("9999999990001")), "siret_not_found");
    assert.equal(await code(S.closed), "siret_closed");
    assert.equal(await code(S.ct), "siret_activity");
    const down = await json(await call("alice", "GET", `/v1/pro/siret/${S.down}`));
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, "sirene_unavailable");
    assert.equal(down.headers.get("retry-after"), "60");
  });

  test("the garages at the establishment's address come with their means of verification, masked; nothing reveals a real address or number", async () => {
    const r = await json(await call("alice", "GET", `/v1/pro/siret/${S.dupont.slice(0, 3)} ${S.dupont.slice(3)}`)); // espaces tolérés
    assert.equal(r.status, 200);
    assert.equal(r.body.establishment.siret, S.dupont);
    const ids = r.body.garages.map((g) => g.id);
    assert.equal(ids[0], A, "même nom d'abord");
    assert.ok(!ids.includes(D), "à 5 km : pas à cette adresse");
    assert.ok(ids.includes(C) && ids.includes(CONTACTS[1].id));
    const a = r.body.garages[0];
    assert.equal(a.status, "free");
    assert.deepEqual(a.options, [
      { id: "email:0", channel: "email", hint: "c•••••@garage-dupont.fr" },
      { id: "domain", channel: "email_domain", hint: "…@garage-dupont.fr", domain: "garage-dupont.fr" },
      { id: "sms:1", channel: "sms", hint: "06 •• •• •• 78" },
    ]);
    const text = JSON.stringify(r.body);
    assert.ok(!/contact@|612345678|561976545|cazeres@norauto/.test(text), text);
  });

  test("no domain option for a network, a site builder, a page deep in a site or a shared domain; no SMS to a landline", async () => {
    const r = await json(await call("alice", "GET", `/v1/pro/siret/${S.dupont}`));
    const of = (id) => r.body.garages.find((g) => g.id === id);
    assert.deepEqual(of(CONTACTS[1].id).options.map((o) => o.id), ["email:0"], "Norauto : l'e-mail public de ce centre, pas le domaine du réseau, pas de SMS vers un fixe");
    assert.deepEqual(of(C).options.map((o) => o.id), ["sms:0"], "wixsite : pas de domaine");
    assert.deepEqual(of(CONTACTS[4].id).options, [], "auto-sud.fr est le site de deux garages");
    assert.deepEqual(of(CONTACTS[6].id).options, [], "site qui n'est pas à la racine, fixe seulement");
  });

  test("without a position in the registry: same postcode AND same name", async () => {
    const r = await json(await call("alice", "GET", `/v1/pro/siret/${S.nopos}`));
    assert.deepEqual(r.body.garages.map((g) => g.id), [A]);
  });

  test("the whole path: code sent to the public e-mail, a wrong code counts, the right one links the garage to the account", async () => {
    const created = await claim("alice");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.channel, "email");
    assert.equal(created.body.hint, "c•••••@garage-dupont.fr");
    assert.equal(created.body.attemptsLeft, 5);
    assert.ok(created.body.expiresInSeconds > 590 && created.body.expiresInSeconds <= 600);
    assert.equal(created.body.resendInSeconds, 60);
    assert.ok(!("target" in created.body));
    assert.equal(outbox().length, 1);
    assert.equal(outbox()[0].target, "contact@garage-dupont.fr");
    assert.equal(outbox()[0].garageName, "Garage Dupont");
    assert.match(lastCode(), /^\d{6}$/);
    const row = (await t.db.query("SELECT code_hash, target, target_hash FROM pro_claims")).rows[0];
    assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!row.code_hash.includes(lastCode()));

    const id = created.body.id;
    const bad = await json(await call("alice", "POST", `/v1/pro/claims/${id}/code`, { code: wrong(lastCode()) }));
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "bad_code");
    assert.equal(bad.body.error.attemptsLeft, 4);

    const ok = await json(await call("alice", "POST", `/v1/pro/claims/${id}/code`, { code: lastCode().slice(0, 3) + " " + lastCode().slice(3) }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "verified");
    assert.ok(ok.body.verifiedAt);
    const after = (await t.db.query("SELECT status, code_hash, target, target_hash FROM pro_claims WHERE id = $1", [id])).rows[0];
    assert.deepEqual([after.status, after.code_hash, after.target], ["verified", null, null], "plus de code ni de cible une fois vérifié");
    assert.match(after.target_hash, /^[0-9a-f]{64}$/);

    // le même code une seconde fois : sans effet, toujours vérifié
    assert.equal((await json(await call("alice", "POST", `/v1/pro/claims/${id}/code`, { code: lastCode() }))).body.status, "verified");
    const me = await json(await call("alice", "GET", "/v1/pro/me"));
    assert.deepEqual(me.body.claims.map((c) => [c.garageId, c.status, c.garageName]), [[A, "verified", "Garage Dupont"]]);
    const look = await json(await call("alice", "GET", `/v1/pro/siret/${S.dupont}`));
    assert.equal(look.body.garages[0].status, "mine");
    assert.deepEqual(look.body.garages[0].options, []);
    assert.equal((await claim("alice")).body.error.code, "already_yours");
  });

  test("a garage has a single verified account: the next one is sent to manual verification", async () => {
    const first = await claim("alice");
    await call("alice", "POST", `/v1/pro/claims/${first.body.id}/code`, { code: lastCode() });
    const second = await claim("bob");
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "already_claimed");
    assert.equal(second.body.error.contact, "contact@pixcar.fr");
    assert.equal((await json(await call("bob", "GET", `/v1/pro/siret/${S.dupont}`))).body.garages[0].status, "claimed");
  });

  test("two accounts racing for the same garage: the first right code wins, the other ends « already_claimed »", async () => {
    const a = await claim("alice");
    const codeA = lastCode();
    const b = await claim("bob", { option: "sms:1" });
    const codeB = lastCode();
    assert.equal((await call("bob", "POST", `/v1/pro/claims/${b.body.id}/code`, { code: codeB })).status, 200);
    const late = await json(await call("alice", "POST", `/v1/pro/claims/${a.body.id}/code`, { code: codeA }));
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "already_claimed");
  });

  test("five wrong codes close the request: even the right code is then refused", async () => {
    const c = await claim("alice");
    const code = lastCode();
    for (let i = 4; i >= 1; i--) assert.equal((await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: wrong(code) }))).body.error.attemptsLeft, i);
    const fifth = await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: wrong(code) }));
    assert.equal(fifth.status, 423);
    assert.equal(fifth.body.error.code, "locked");
    const right = await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code }));
    assert.equal(right.status, 409);
    assert.equal(right.body.error.code, "claim_closed");
    assert.equal((await t.db.query("SELECT status FROM pro_claims WHERE id = $1", [c.body.id])).rows[0].status, "failed");
  });

  test("parallel guesses never get more than five tries", async () => {
    const c = await claim("alice");
    const code = lastCode();
    const guesses = Array.from({ length: 12 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const res = await Promise.all(guesses.map((g) => call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: g })));
    assert.ok(res.every((r) => r.status !== 200));
    const row = (await t.db.query("SELECT attempts, status FROM pro_claims WHERE id = $1", [c.body.id])).rows[0];
    assert.ok(row.attempts <= 5, String(row.attempts));
    assert.equal(row.status, "failed");
  });

  test("a code is good for 10 minutes; a new one can be asked 60 s after the previous one, and replaces it", async () => {
    const c = await claim("alice");
    const first = lastCode();
    const soon = await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/resend`));
    assert.equal(soon.status, 429);
    assert.equal(soon.body.error.code, "resend_too_soon");
    assert.ok(Number(soon.headers.get("retry-after")) >= 59);

    await t.db.query("UPDATE pro_claims SET code_expires_at = now() - interval '1 second', last_sent_at = now() - interval '11 minutes' WHERE id = $1", [c.body.id]);
    const expired = await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: first }));
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, "code_expired");

    const again = await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/resend`));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.resendsLeft, 1);
    assert.equal(outbox().length, 2);
    assert.equal(outbox()[1].target, "contact@garage-dupont.fr", "même destinataire");
    const second = lastCode();
    if (second !== first) assert.equal((await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: first }))).body.error.code, "bad_code");
    assert.equal((await json(await call("alice", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: second }))).body.status, "verified");
  });

  test("e-mail on the garage's own domain: the requester picks the local part, never the domain", async () => {
    const bad = await claim("alice", { option: "domain", localPart: "x@pirate.fr" });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "local_part");
    assert.equal((await claim("alice", { option: "domain" })).body.error.code, "local_part");
    const ok = await claim("alice", { option: "domain", localPart: "Atelier.Dupont" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.channel, "email_domain");
    assert.equal(ok.body.hint, "atelier.dupont@garage-dupont.fr");
    assert.equal(outbox()[0].target, "atelier.dupont@garage-dupont.fr");
  });

  test("SMS to the garage's mobile; options that the garage does not have are refused", async () => {
    const ok = await claim("alice", { option: "sms:1" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.hint, "06 •• •• •• 78");
    assert.deepEqual([outbox()[0].channel, outbox()[0].target], ["sms", "+33612345678"]);
    assert.equal((await claim("bob", { option: "sms:0" })).body.error.code, "option", "le fixe ne reçoit pas de SMS");
    assert.equal((await claim("bob", { option: "domain", garageId: CONTACTS[1].id, localPart: "chef" })).body.error.code, "option", "pas le domaine d'un réseau");
    assert.equal((await claim("bob", { option: "email:9" })).body.error.code, "option");
  });

  test("« Qui êtes-vous ? »: first and last name, a role, and the certification box are required, and kept with the request", async () => {
    for (const [holder, needle] of [
      [undefined, "prénom"],
      [{ ...HOLDER, firstName: "" }, "Prénom"],
      [{ ...HOLDER, lastName: "x".repeat(61) }, "60"],
      [{ ...HOLDER, firstName: "123", lastName: "456" }, "Prénom"],
      [{ ...HOLDER, role: "boss" }, "Fonction"],
      [{ ...HOLDER, certify: "true" }, "Cochez"],
      [{ ...HOLDER, certify: false }, "Cochez"],
    ]) {
      const r = await claim("alice", { holder });
      assert.equal(r.status, 422, JSON.stringify(holder));
      assert.equal(r.body.error.code, "holder");
      assert.match(r.body.error.message, new RegExp(needle));
    }
    assert.equal(outbox().length, 0);
    const ok = await claim("alice", { holder: { ...HOLDER, firstName: "  Jean-\u0007Marie ", lastName: "d'Ormesson" } });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.holder, { name: "Jean- Marie d'Ormesson", role: "manager" });
    const row = (await t.db.query("SELECT holder_name, holder_role, certified_at FROM pro_claims")).rows[0];
    assert.ok(row.certified_at);
  });

  test("PRO_CHANNELS closes a means everywhere: not offered, and refused if asked anyway", async () => {
    const mailOnly = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", PRO_CHANNELS: "email,email_domain" }, proOptions: { sirene: async (s) => REGISTRY[s] || null } });
    try {
      await mailOnly.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "t");
      const look = await json(await mailOnly.call("GET", `/v1/pro/siret/${S.dupont}`, { headers: as("zoe") }));
      assert.deepEqual(look.body.garages.find((g) => g.id === A).options.map((o) => o.id), ["email:0", "domain"]);
      const sms = await json(await mailOnly.call("POST", "/v1/pro/claims", { headers: as("zoe"), body: { siret: S.dupont, garageId: A, option: "sms:1", holder: HOLDER } }));
      assert.equal(sms.body.error.code, "option");
      assert.equal(mailOnly.app.pro.senders.outbox.length, 0);
    } finally {
      await mailOnly.close();
    }
  });

  test("the garage must be at the establishment's address", async () => {
    assert.equal((await claim("alice", { garageId: D })).body.error.code, "siret_far");
    assert.equal((await claim("alice", { siret: S.far })).body.error.code, "siret_far");
    assert.equal(outbox().length, 0);
  });

  test("nobody can use up the real garagiste's codes: 3 per account and per garage, 10 per garage for all accounts together", async () => {
    // un tiers (le SIRET du garage est public) épuise SES envois vers le garage A…
    for (let i = 0; i < 3; i++) assert.equal((await claim("mallory")).status, 201);
    const fourth = await claim("mallory");
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.scope, "garage");
    assert.equal(fourth.headers.get("retry-after"), "86400");
    // … le vrai garagiste reçoit quand même son code et rattache son garage
    const real = await claim("alice", { option: "sms:1" });
    assert.equal(real.status, 201);
    assert.equal((await json(await call("alice", "POST", `/v1/pro/claims/${real.body.id}/code`, { code: lastCode() }))).body.status, "verified");
    assert.equal(outbox().length, 4);

    // plafond du garage, tous comptes confondus : 10 envois sur 24 h
    await t.db.exec("TRUNCATE pro_claims, pro_events");
    await t.db.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) SELECT 'send', 'dev-x' || g, $1, 'email' FROM generate_series(1, 10) AS g", [A]);
    const full = await claim("zoe");
    assert.equal(full.status, 429);
    assert.equal(full.body.error.scope, "garage_total");
    assert.match(full.body.error.message, /Ce garage a reçu trop de codes/);
  });

  test("a garage asked for by several accounts within 24 h leaves a dedicated log line (event « pro_contested »), turned into an alarm by the stack", async () => {
    const lines = [];
    const watched = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1" }, log: (l) => lines.push(l), proOptions: { sirene: async (s) => REGISTRY[s] || null } });
    try {
      await watched.app.pro.repo.upsertContacts(parseContactRows(CONTACTS).rows, "t");
      const ask = (who) => watched.call("POST", "/v1/pro/claims", { headers: as(who), body: { siret: S.dupont, garageId: A, option: "email:0", holder: HOLDER } });
      assert.equal((await ask("alice")).status, 201);
      assert.ok(!lines.some((l) => l.event === "pro_contested"), "un seul compte : rien à signaler");
      assert.equal((await ask("bob")).status, 201);
      const flagged = lines.filter((l) => l.event === "pro_contested");
      assert.equal(flagged.length, 1);
      assert.deepEqual([flagged[0].level, flagged[0].garageId, flagged[0].accounts], ["warn", A, 2]);
      assert.ok(!JSON.stringify(flagged[0]).includes("dev-"), "ni compte ni cible dans le journal");
    } finally {
      await watched.close();
    }
  });

  test("limits: 3 requests in progress and 5 codes per account over 24 h", async () => {
    // un compte : 3 demandes en cours au plus
    assert.equal((await claim("eve", { option: "email:0" })).status, 201);
    assert.equal((await claim("eve", { garageId: C, option: "sms:0" })).status, 201);
    assert.equal((await claim("eve", { garageId: CONTACTS[1].id, option: "email:0" })).status, 201);
    // une nouvelle demande pour un garage déjà en cours remplace l'ancienne (un seul code valable) et ne compte pas en plus
    const again = await claim("eve", { option: "domain", localPart: "eve" });
    assert.equal(again.status, 201);
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM pro_claims WHERE account_id = 'dev-eve' AND garage_id = $1 AND status = 'pending'", [A])).rows[0].n, 1);
    const busy = await claim("eve", { garageId: CONTACTS[7].id, option: "email:0" });
    assert.equal(busy.body.error.code, "too_many_pending");

    // 5 envois par compte sur 24 h, quel que soit le garage
    await t.db.exec("TRUNCATE pro_claims");
    await t.db.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) SELECT 'send', 'dev-eve', 'cccccccc-0000-4000-8000-00000000000' || g, 'email' FROM generate_series(1, 1) AS g");
    const sixth = await claim("eve");
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error.scope, "account");
  });

  test("a failed delivery says so (502) and the request cannot be used", async () => {
    const send = t.app.pro.senders.send;
    t.app.pro.senders.send = async () => {
      throw new Error("SES : adresse refusée");
    };
    try {
      const r = await claim("alice");
      assert.equal(r.status, 502);
      assert.equal(r.body.error.code, "send_failed");
      assert.equal((await t.db.query("SELECT status, code_hash FROM pro_claims")).rows[0].status, "failed");
    } finally {
      t.app.pro.senders.send = send;
    }
  });

  test("a request belongs to its account: another account cannot read it nor try codes on it", async () => {
    const c = await claim("alice");
    assert.equal((await call("bob", "GET", `/v1/pro/claims/${c.body.id}`)).status, 404);
    assert.equal((await call("bob", "POST", `/v1/pro/claims/${c.body.id}/code`, { code: lastCode() })).status, 404);
    assert.equal((await call("bob", "POST", `/v1/pro/claims/${c.body.id}/resend`)).status, 404);
    assert.equal((await json(await call("alice", "GET", `/v1/pro/claims/${c.body.id}`))).body.status, "pending");
    assert.equal((await call("alice", "GET", "/v1/pro/claims/pas-un-uuid")).status, 404);
  });

  test("registry lookups are limited per account, whether they come from a search or from a request", async () => {
    const few = await makeApp({ env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", PRO_LOOKUPS_PER_ACCOUNT_PER_HOUR: "2" }, proOptions: { sirene: async () => null } });
    try {
      const ask = (path, body) => few.call(body ? "POST" : "GET", path, { headers: as("mallory"), body });
      assert.equal((await ask(`/v1/pro/siret/${siretOf("5555555550001")}`)).status, 404);
      assert.equal((await ask("/v1/pro/claims", { siret: siretOf("5555555550002"), garageId: A, option: "email:0", holder: HOLDER })).status, 404);
      const third = await ask("/v1/pro/claims", { siret: siretOf("5555555550003"), garageId: A, option: "email:0", holder: HOLDER });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
      assert.equal((await ask(`/v1/pro/siret/${siretOf("5555555550001")}`)).status, 404, "un SIRET déjà vu (en cache) ne compte pas");
    } finally {
      await few.close();
    }
  });

  test("test establishments (PRO_TEST_ESTABLISHMENTS): an invented SIRET leads to the test garage without asking the registry", async () => {
    const fake = siretOf("0000000000001");
    const sea = { lat: 0.5, lon: -20.5 };
    const lines = [];
    const app = await makeApp({
      env: { PRO_ENABLED: "1", PRO_DEV_AUTH: "1", PRO_TEST_ESTABLISHMENTS: JSON.stringify([{ siret: fake, name: "Garage Essai Pixcar", ...sea }]) },
      log: (l) => lines.push(l),
      proOptions: { sirene: async () => { throw new Error("le registre ne doit pas être interrogé"); } },
    });
    try {
      assert.ok(lines.some((l) => /établissements d'essai actifs/.test(l.msg) && l.count === 1), "signalé au démarrage");
      await app.app.pro.repo.upsertContacts(parseContactRows([{ id: "f0000000-0000-4000-8000-000000000001", name: "Garage Essai Pixcar", ...sea, emails: ["essai@exemple.fr"], phones: ["+33612345678"] }]).rows, "essai");
      const r = await json(await app.call("GET", `/v1/pro/siret/${fake}`, { headers: as("me") }));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.garages.map((g) => [g.name, g.options.map((o) => o.id)]), [["Garage Essai Pixcar", ["email:0", "sms:0"]]]);
      const c = await json(await app.call("POST", "/v1/pro/claims", { headers: as("me"), body: { siret: fake, garageId: "f0000000-0000-4000-8000-000000000001", option: "sms:0", holder: HOLDER } }));
      assert.equal(c.status, 201);
    } finally {
      await app.close();
    }
    const { loadConfig } = await import("../config.mjs");
    assert.throws(() => loadConfig({ NODE_ENV: "test", PRO_TEST_ESTABLISHMENTS: "pas du json" }), /JSON illisible/);
    assert.throws(() => loadConfig({ NODE_ENV: "test", PRO_TEST_ESTABLISHMENTS: JSON.stringify([{ siret: "12345678901234", name: "X", lat: 0, lon: 0 }]) }), /clé juste/);
    assert.equal(loadConfig({ NODE_ENV: "test" }).pro.testEstablishments.size, 0);
  });

  test("the registry is asked once per SIRET for 10 minutes", async () => {
    const before = sirene.calls;
    await call("alice", "GET", `/v1/pro/siret/${S.nopos}`);
    await call("alice", "GET", `/v1/pro/siret/${S.nopos}`);
    await claim("alice", { siret: S.nopos });
    assert.ok(sirene.calls - before <= 1, String(sirene.calls - before));
  });

  test("upkeep: events older than 90 days and unfinished requests older than 30 days go away", async () => {
    await claim("alice");
    await t.db.exec("UPDATE pro_events SET at = now() - interval '91 days'; UPDATE pro_claims SET created_at = now() - interval '31 days'");
    const out = await t.app.maintenance();
    assert.equal(out.proEvents, 1);
    assert.equal(out.proClaims, 1);
  });
});
