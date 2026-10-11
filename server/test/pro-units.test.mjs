// Espace Pro, briques sans base : jetons Cognito, règles de contact (domaines, e-mails, portables, masques), SIRET, configuration.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AuthError, createCognitoVerifier, issuerOf } from "../lib/jwt.mjs";
import { isFrMobile, maskEmail, maskPhone, normalizeEmail, normalizeFrPhone, normalizeLocalPart, parseContactRows, resolveOption, sameName, siteDomain, verificationOptions } from "../lib/contact.mjs";
import { isSiret, lookupSiret } from "../lib/sirene.mjs";
import { emailText } from "../lib/senders.mjs";
import { loadConfig } from "../config.mjs";
import { newCode } from "../pro.mjs";

// ---- jetons
const POOL = "eu-north-1_AbCdEf123";
const CLIENT = "3n4b5c6d7e8f9g0h1i2j3k4l5m";
const b64url = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" } };
}
async function sign(key, claims, header = {}) {
  const h = b64url({ alg: "RS256", kid: key.kid, ...header });
  const p = b64url(claims);
  const s = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`))).toString("base64url");
  return `${h}.${p}.${s}`;
}

describe("Cognito access tokens", async () => {
  const k1 = await keyPair("k1");
  const k2 = await keyPair("k2");
  let published = [k1.jwk];
  let downloads = 0;
  let clock = 1_800_000_000_000;
  const fetchImpl = async (url) => {
    downloads++;
    assert.equal(url, `${issuerOf(POOL)}/.well-known/jwks.json`);
    return new Response(JSON.stringify({ keys: published }), { status: 200 });
  };
  const verify = createCognitoVerifier({ userPoolId: POOL, clientId: CLIENT, fetchImpl, now: () => clock });
  const t = () => Math.floor(clock / 1000);
  const good = () => ({ sub: "4f1e2d3c-aaaa-bbbb-cccc-1234567890ab", iss: issuerOf(POOL), token_use: "access", client_id: CLIENT, iat: t() - 10, exp: t() + 3600 });

  test("a genuine access token gives its account (sub); keys are downloaded once", async () => {
    assert.deepEqual(await verify(await sign(k1, good())), { sub: good().sub });
    await verify(await sign(k1, good()));
    assert.equal(downloads, 1);
    assert.equal(issuerOf(POOL), "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_AbCdEf123");
  });

  const refused = [
    ["expired", { exp: () => t() - 120 }],
    ["from another user pool", { iss: () => "https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Autre" }],
    ["for another app client", { client_id: () => "autreclient1234" }],
    ["an ID token instead of an access token", { token_use: () => "id" }],
    ["issued in the future", { iat: () => t() + 600 }],
    ["without account", { sub: () => undefined }],
  ];
  for (const [label, over] of refused) {
    test(`refused: ${label}`, async () => {
      const claims = good();
      for (const [k, f] of Object.entries(over)) claims[k] = f();
      await assert.rejects(verify(await sign(k1, claims)), AuthError);
    });
  }

  test("refused: forged signature, « none » algorithm, unknown key, garbage", async () => {
    const [h, p] = (await sign(k1, good())).split(".");
    const forged = await sign(k2, good(), { kid: "k1" }); // signé par une autre clé en se faisant passer pour k1
    await assert.rejects(verify(forged), /signature/);
    await assert.rejects(verify(`${b64url({ alg: "none", kid: "k1" })}.${p}.`), AuthError);
    await assert.rejects(verify(`${h}.${b64url({ ...good(), sub: "autre" })}.${(await sign(k1, good())).split(".")[2]}`), /signature/);
    await assert.rejects(verify("a.b"), AuthError);
    await assert.rejects(verify(""), AuthError);
  });

  test("key rotation: an unknown key triggers one new download, at most once a minute", async () => {
    const before = downloads;
    clock += 120_000;
    published = [k1.jwk, k2.jwk];
    assert.equal((await verify(await sign(k2, good()))).sub, good().sub);
    assert.equal(downloads, before + 1);
    const k3 = await keyPair("k3");
    for (let i = 0; i < 5; i++) await assert.rejects(verify(await sign(k3, good())), /clé inconnue/);
    assert.equal(downloads, before + 1, "pas de nouveau téléchargement dans la minute");
  });

  test("Cognito unreachable: the error is « unavailable » (503), not « unauthorized »", async () => {
    const v = createCognitoVerifier({ userPoolId: POOL, clientId: CLIENT, fetchImpl: async () => new Response("", { status: 500 }), now: () => clock });
    const err = await verify(await sign(k1, good())).then(() => null);
    assert.equal(err, null);
    await assert.rejects(v(await sign(k1, good())), (e) => e.unavailable === true && !(e instanceof AuthError));
  });

  test("bad configuration is caught at start", () => {
    assert.throws(() => createCognitoVerifier({ userPoolId: "pool", clientId: CLIENT }));
    assert.throws(() => createCognitoVerifier({ userPoolId: POOL, clientId: "x" }));
  });
});

// ---- règles de contact
describe("contact rules", () => {
  test("site domain: only the root of a domain that belongs to the garage", () => {
    assert.equal(siteDomain("https://www.garage-dupont.fr/"), "garage-dupont.fr");
    assert.equal(siteDomain("garage-dupont.fr"), "garage-dupont.fr");
    assert.equal(siteDomain("http://garage-dupont.fr/index.html"), "garage-dupont.fr");
    assert.equal(siteDomain("https://garage-dupont.fr/contact"), "", "une page, pas la racine");
    assert.equal(siteDomain("https://dupont.wixsite.com/garage"), "");
    assert.equal(siteDomain("https://garage.business.site/"), "", "sous-domaine d'une plateforme");
    assert.equal(siteDomain("https://www.norauto.fr/"), "", "domaine d'un réseau");
    assert.equal(siteDomain("https://www.facebook.com/garagedupont"), "");
    assert.equal(siteDomain("https://user:pw@garage-dupont.fr/"), "");
    assert.equal(siteDomain("https://garage-dupont.fr:8443/"), "");
    assert.equal(siteDomain("ftp://garage-dupont.fr/"), "");
    assert.equal(siteDomain("https://atelier.garage-dupont.fr/"), "", "sous-domaine : on ne sait pas qui le détient");
    assert.equal(siteDomain("https://garage-dupont.co.uk/"), "garage-dupont.co.uk");
    assert.equal(siteDomain("pas une adresse"), "");
  });

  test("e-mails: normalised, invalid ones dropped; masks reveal the first letter and the domain only", () => {
    assert.equal(normalizeEmail(" Contact@Garage-Dupont.FR "), "contact@garage-dupont.fr");
    assert.equal(normalizeEmail("mailto:atelier@garage.fr"), "atelier@garage.fr");
    for (const bad of ["", "pas-un-mail", "a@b", "a..b@garage.fr", "@garage.fr", "a@garage..fr", "a b@garage.fr", "x".repeat(250) + "@g.fr"]) assert.equal(normalizeEmail(bad), "", bad);
    assert.equal(maskEmail("contact@garage-dupont.fr"), "c•••••@garage-dupont.fr");
    assert.equal(maskEmail("a@garage.fr"), "a•••••@garage.fr", "même longueur de masque, quelle que soit l'adresse");
    assert.equal(normalizeLocalPart("Atelier.Dupont"), "atelier.dupont");
    for (const bad of ["", "x@y", ".a", "a.", "a..b", "a b", "é", "x".repeat(65)]) assert.equal(normalizeLocalPart(bad), "", bad);
  });

  test("phones: French numbers to international form; only 06 and 07 receive a text; mask keeps the last two digits", () => {
    assert.equal(normalizeFrPhone("06 12 34 56 78"), "+33612345678");
    assert.equal(normalizeFrPhone("+33 6 12 34 56 78"), "+33612345678");
    assert.equal(normalizeFrPhone("0033612345678"), "+33612345678");
    assert.equal(normalizeFrPhone("+330612345678"), "");
    assert.equal(normalizeFrPhone("+44 7700 900123"), "");
    assert.ok(isFrMobile("+33612345678") && isFrMobile("+33712345678"));
    assert.ok(!isFrMobile("+33561976545") && !isFrMobile("+33899123456"));
    assert.equal(maskPhone("+33612345678"), "06 •• •• •• 78");
  });

  test("options and their targets: the requester chooses, the server holds the target", () => {
    const g = { name: "Garage Dupont", brand: false, emails: ["bad", "contact@garage-dupont.fr"], phones: ["+33561976545", "+33712345678"], web_domain: "garage-dupont.fr" };
    assert.deepEqual(verificationOptions(g).map((o) => o.id), ["email:1", "domain", "sms:1"]);
    assert.deepEqual(resolveOption(g, "email:1"), { channel: "email", target: "contact@garage-dupont.fr", hint: "c•••••@garage-dupont.fr" });
    assert.deepEqual(resolveOption(g, "sms:1"), { channel: "sms", target: "+33712345678", hint: "07 •• •• •• 78" });
    assert.deepEqual(resolveOption(g, "domain", { localPart: "chef" }), { channel: "email_domain", target: "chef@garage-dupont.fr", hint: "chef@garage-dupont.fr" });
    assert.deepEqual(resolveOption(g, "email:0"), { error: "option" }, "adresse invalide : pas d'option");
    assert.deepEqual(resolveOption(g, "domain", { localPart: "chef", domainShared: true }), { error: "option" });
    assert.deepEqual(verificationOptions({ ...g, name: "Speedy Muret" }).map((o) => o.id), ["email:1", "sms:1"], "atelier d'un réseau : pas de domaine");
    assert.deepEqual(verificationOptions({ ...g, brand: true }).map((o) => o.id), ["email:1", "sms:1"]);
  });

  test("names: one distinctive word in common, generic words do not count", () => {
    assert.ok(sameName("GARAGE DUPONT", "Garage Dupont et Fils"));
    assert.ok(sameName("DUPONT SARL", "Garage Dupont"));
    assert.ok(!sameName("Garage Martin", "Garage Dupont"));
    assert.ok(!sameName("Carrosserie Auto", "Garage Auto Service"));
  });

  test("contact import: each row checked again, bad rows counted and dropped, nothing invented", () => {
    const { rows, rejected } = parseContactRows([
      { id: "aaaaaaaa-0000-4000-8000-000000000001", name: " Garage Dupont ", lat: 43.2, lon: 1.1, pc: "31220", emails: ["A@B.fr", "a@b.fr", "nope"], phones: ["+33612345678", "0612345678"], web: "https://garage-dupont.fr/", brand: true },
      { id: "AAAA", name: "Mauvais id", lat: 1, lon: 1 },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "G", lat: 1, lon: 1 },
      { id: "aaaaaaaa-0000-4000-8000-000000000003", name: "Sans position", lat: null, lon: 1 },
      { id: "aaaaaaaa-0000-4000-8000-000000000004", name: "Site de plateforme", lat: 1, lon: 1, web: "https://x.wixsite.com/y", pc: "312" },
    ]);
    assert.equal(rejected, 3);
    assert.deepEqual(rows[0], { garageId: "aaaaaaaa-0000-4000-8000-000000000001", name: "Garage Dupont", addr: "", pc: "31220", lat: 43.2, lon: 1.1, brand: true, emails: ["a@b.fr"], phones: ["+33612345678"], webDomain: "garage-dupont.fr" });
    assert.deepEqual([rows[1].webDomain, rows[1].pc, rows[1].brand], ["", "", false]);
  });
});

// ---- SIRET, codes, messages, configuration
describe("SIRET, codes and configuration", () => {
  test("SIRET key (Luhn), and the La Poste exception", () => {
    assert.ok(isSiret("73282932000074")); // SIRET public d'exemple (INSEE)
    assert.ok(!isSiret("73282932000075"));
    assert.ok(!isSiret("7328293200007"));
    assert.ok(isSiret("35600000049837")); // La Poste : somme des chiffres multiple de 5
    assert.ok(!isSiret("35600000049838"));
  });

  test("registry lookup: the establishment of THAT siret, its activity, state and position; « unavailable » when the registry fails", async () => {
    const body = { results: [{ nom_complet: "DUPONT SARL", siege: { siret: "73282932000074", etat_administratif: "A", activite_principale: "45.20A", latitude: "43.2", longitude: "1.1", adresse: "1 RUE X 31220 CAZERES", liste_enseignes: ["GARAGE DUPONT"] }, matching_etablissements: [{ siret: "73282932000082", etat_administratif: "F" }] }] };
    const fetchImpl = async (url) => {
      assert.match(url, /^https:\/\/recherche-entreprises\.api\.gouv\.fr\/search\?q=73282932000074&/);
      return new Response(JSON.stringify(body));
    };
    assert.deepEqual(await lookupSiret("73282932000074", { fetchImpl }), { siret: "73282932000074", name: "GARAGE DUPONT", company: "DUPONT SARL", addr: "1 RUE X 31220 CAZERES", naf: "45.20A", active: true, lat: 43.2, lon: 1.1, pc: "31220" });
    assert.equal(await lookupSiret("11111111111111", { fetchImpl: async () => new Response(JSON.stringify(body)) }), null);
    await assert.rejects(lookupSiret("73282932000074", { fetchImpl: async () => new Response("", { status: 429 }) }), (e) => e.unavailable);
    await assert.rejects(lookupSiret("73282932000074", { fetchImpl: async () => { throw new Error("réseau"); } }), (e) => e.unavailable);
  });

  test("codes: six digits, spread over the whole range", () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const c = newCode();
      assert.match(c, /^\d{6}$/);
      seen.add(c[0]);
    }
    assert.equal(seen.size, 10, "le premier chiffre prend toutes les valeurs, zéro compris");
  });

  test("the e-mail names the garage, gives the code and its life, and says what to do if you did not ask", () => {
    const { subject, text } = emailText({ code: "042917", minutes: 10, garageName: "Garage Dupont", contact: "contact@pixcar.fr" });
    assert.match(subject, /042917/);
    assert.match(text, /« Garage Dupont »/);
    assert.match(text, /valable 10 minutes/);
    assert.match(text, /contact@pixcar\.fr/);
  });

  const prod = { NODE_ENV: "production", PLATE_PEPPER: "p".repeat(20), IP_PEPPER: "i".repeat(20), ALLOWED_ORIGINS: "https://pixcar.fr", TRUST_PROXY: "0", DSQL_ENDPOINT: "x.dsql.eu-north-1.on.aws" };
  test("configuration: off by default; in production it needs Cognito and real senders, and refuses the development header", () => {
    assert.equal(loadConfig(prod).pro.enabled, false);
    assert.equal(loadConfig({ NODE_ENV: "test" }).pro.sender, "memory");
    assert.throws(() => loadConfig({ ...prod, PRO_ENABLED: "1" }), /COGNITO_USER_POOL_ID[\s\S]*COGNITO_CLIENT_ID[\s\S]*PRO_NOTIFY_CONFIGURATION_ID/);
    // e-mail seulement (SMS pas encore prêt) : pas besoin de Notify ; un moyen inconnu est refusé
    const emailOnly = loadConfig({ ...prod, PRO_ENABLED: "1", COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT, PRO_CHANNELS: "email,email_domain" });
    assert.deepEqual(emailOnly.pro.channels, ["email", "email_domain"]);
    assert.throws(() => loadConfig({ ...prod, PRO_CHANNELS: "email,fax" }), /PRO_CHANNELS : « fax »/);
    assert.throws(() => loadConfig({ ...prod, PRO_ENABLED: "1", COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT, PRO_NOTIFY_CONFIGURATION_ID: "nc-1", PRO_SENDER: "memory" }), /PRO_SENDER/);
    assert.throws(() => loadConfig({ ...prod, PRO_ENABLED: "1", COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT, PRO_NOTIFY_CONFIGURATION_ID: "nc-1", PRO_DEV_AUTH: "1" }), /PRO_DEV_AUTH/);
    const ok = loadConfig({ ...prod, PRO_ENABLED: "1", COGNITO_USER_POOL_ID: POOL, COGNITO_CLIENT_ID: CLIENT, PRO_NOTIFY_CONFIGURATION_ID: "nc-1" });
    assert.deepEqual([ok.pro.enabled, ok.pro.sender, ok.pro.devAuth, ok.pro.codeTtlSeconds, ok.pro.maxAttempts, ok.pro.sendsPerGaragePerDay], [true, "aws", false, 600, 5, 3]);
  });
});
