// Envoi des e-mails de l'Espace Pro par Scaleway Transactional Email : requête exacte, erreurs sans fuite de la clé ni du destinataire,
// choix du fournisseur par la configuration, secret lu dans SSM seulement quand il sert.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../config.mjs";
import { createScalewayMailer, isScwProjectId, parseAddress, ScalewayError } from "../lib/scaleway.mjs";
import { secretNames } from "../lib/secrets.mjs";
import { createSenders } from "../lib/senders.mjs";

const PROJECT = "0b2c8f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const KEY = "scw-secret-key-for-tests-only-0000"; // jamais une vraie clé
const fakeFetch = (respond) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  f.calls = calls;
  return f;
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("Scaleway : client d'envoi", () => {
  test("adresse d'expédition « Nom <adresse> » ou adresse seule", () => {
    assert.deepEqual(parseAddress("Pixcar <verification@pixcar.fr>"), { name: "Pixcar", email: "verification@pixcar.fr" });
    assert.deepEqual(parseAddress('"Pixcar Pro" <connexion@pixcar.fr>'), { name: "Pixcar Pro", email: "connexion@pixcar.fr" });
    assert.deepEqual(parseAddress("connexion@pixcar.fr"), { email: "connexion@pixcar.fr" });
    assert.throws(() => parseAddress("Pixcar"));
  });

  test("paramètres refusés : clé absente, projet qui n'est pas un UUID, région inconnue", () => {
    assert.throws(() => createScalewayMailer({ secretKey: "", projectId: PROJECT }), /clé secrète absente/);
    assert.throws(() => createScalewayMailer({ secretKey: KEY, projectId: "projet" }), /identifiant de projet/);
    assert.throws(() => createScalewayMailer({ secretKey: KEY, projectId: PROJECT, region: "paris" }), /région/);
    assert.ok(isScwProjectId(PROJECT) && !isScwProjectId("x"));
  });

  test("requête : point d'accès de Paris, clé dans X-Auth-Token, projet, expéditeur, destinataire, sujet, texte", async () => {
    const f = fakeFetch(() => json(200, { emails: [{ id: "e-1", status: "new" }] }));
    const m = createScalewayMailer({ secretKey: KEY, projectId: PROJECT, fetchImpl: f });
    const out = await m.send({ from: "Pixcar <verification@pixcar.fr>", to: "garage@exemple.fr", subject: "Pixcar : votre code 123456", text: "Code : 123456" });
    assert.deepEqual(out, { id: "e-1" });
    const c = f.calls[0];
    assert.equal(c.url, "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers["x-auth-token"], KEY);
    assert.deepEqual(c.body, { project_id: PROJECT, from: { name: "Pixcar", email: "verification@pixcar.fr" }, to: [{ email: "garage@exemple.fr" }], subject: "Pixcar : votre code 123456", text: "Code : 123456" });
  });

  test("refus de Scaleway : erreur avec le statut et le message de Scaleway, sans la clé ni le destinataire", async () => {
    const f = fakeFetch(() => json(403, { message: "domain not checked", type: "permissions_denied" }));
    const m = createScalewayMailer({ secretKey: KEY, projectId: PROJECT, fetchImpl: f });
    const err = await m.send({ from: "verification@pixcar.fr", to: "garage@exemple.fr", subject: "Sujet assez long", text: "x" }).catch((e) => e);
    assert.ok(err instanceof ScalewayError);
    assert.equal(err.status, 403);
    assert.match(err.message, /HTTP 403 : domain not checked/);
    assert.ok(!err.message.includes(KEY) && !err.message.includes("garage@exemple.fr"));
  });

  test("réseau coupé ou délai dépassé : erreur de statut 0, sans la clé", async () => {
    const down = createScalewayMailer({ secretKey: KEY, projectId: PROJECT, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    const e1 = await down.send({ from: "verification@pixcar.fr", to: "a@b.fr", subject: "Sujet assez long", text: "x" }).catch((e) => e);
    assert.equal(e1.status, 0);
    assert.match(e1.message, /injoignable \(réseau\)/);
    const slow = createScalewayMailer({
      secretKey: KEY,
      projectId: PROJECT,
      timeoutMs: 20,
      fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    });
    const e2 = await slow.send({ from: "verification@pixcar.fr", to: "a@b.fr", subject: "Sujet assez long", text: "x" }).catch((e) => e);
    assert.match(e2.message, /délai dépassé/);
    assert.ok(!e1.message.includes(KEY) && !e2.message.includes(KEY));
  });
});

describe("Scaleway : fournisseur des codes de vérification de l'API", () => {
  const pro = (over = {}) => ({ sender: "aws", codeTtlSeconds: 600, contact: "contact@pixcar.fr", emailFrom: "Pixcar <verification@pixcar.fr>", awsRegion: "eu-north-1", emailProvider: "scaleway", scwProjectId: PROJECT, scwRegion: "fr-par", scwSecretKey: KEY, ...over });

  test("PRO_EMAIL_PROVIDER=scaleway : le code de vérification part par Scaleway, avec le texte habituel", async () => {
    const f = fakeFetch(() => json(200, { emails: [{ id: "e-9" }] }));
    const s = createSenders(pro(), { fetchImpl: f });
    const out = await s.send({ channel: "email", target: "contact@garage.fr", code: "482913", garageName: "Garage Martin" });
    assert.deepEqual(out, { id: "e-9" });
    const b = f.calls[0].body;
    assert.deepEqual(b.to, [{ email: "contact@garage.fr" }]);
    assert.equal(b.subject, "Pixcar : votre code de vérification 482913");
    assert.match(b.text, /« Garage Martin »/);
    assert.match(b.text, /Code de vérification : 482913/);
    assert.match(b.text, /valable 10 minutes/);
  });

  test("le client Scaleway n'est créé qu'une fois (deux envois, une clé lue une fois)", async () => {
    const f = fakeFetch(() => json(200, { emails: [{ id: "e" }] }));
    const s = createSenders(pro(), { fetchImpl: f });
    await s.send({ channel: "email", target: "a@b.fr", code: "111111", garageName: "G" });
    await s.send({ channel: "email_domain", target: "c@d.fr", code: "222222", garageName: "G" });
    assert.equal(f.calls.length, 2);
  });
});

describe("Scaleway : configuration et secrets", () => {
  const base = { NODE_ENV: "production", PLATE_PEPPER: "p".repeat(32), IP_PEPPER: "i".repeat(32), ALLOWED_ORIGINS: "https://pixcar.fr", DSQL_ENDPOINT: "x.dsql.eu-north-1.on.aws", TRUST_PROXY: "1", PRO_ENABLED: "1", COGNITO_USER_POOL_ID: "eu-north-1_Abc123", COGNITO_CLIENT_ID: "3ehjknufqlki9fft1a4aj7urmg", PRO_CHANNELS: "email,email_domain" };

  test("SES reste le fournisseur par défaut ; un fournisseur inconnu est refusé", () => {
    assert.equal(loadConfig(base).pro.emailProvider, "ses");
    assert.throws(() => loadConfig({ ...base, PRO_EMAIL_PROVIDER: "brevo" }), /PRO_EMAIL_PROVIDER : « brevo » inconnu/);
  });

  test("Scaleway en production : projet (UUID) et clé secrète exigés", () => {
    assert.throws(() => loadConfig({ ...base, PRO_EMAIL_PROVIDER: "scaleway" }), (e) => /PRO_SCW_PROJECT_ID/.test(e.message) && /SCW_SECRET_KEY/.test(e.message));
    const c = loadConfig({ ...base, PRO_EMAIL_PROVIDER: "scaleway", PRO_SCW_PROJECT_ID: PROJECT, SCW_SECRET_KEY: KEY });
    assert.deepEqual([c.pro.emailProvider, c.pro.scwProjectId, c.pro.scwRegion, c.pro.scwSecretKey], ["scaleway", PROJECT, "fr-par", KEY]);
  });

  test("la clé Scaleway n'est lue dans SSM que si l'Espace Pro est ouvert ET envoie par Scaleway", () => {
    assert.deepEqual(secretNames({}), ["PLATE_PEPPER", "IP_PEPPER"]);
    assert.deepEqual(secretNames({ PRO_EMAIL_PROVIDER: "scaleway" }), ["PLATE_PEPPER", "IP_PEPPER"]);
    assert.deepEqual(secretNames({ PRO_ENABLED: "1", PRO_EMAIL_PROVIDER: "ses" }), ["PLATE_PEPPER", "IP_PEPPER"]);
    assert.deepEqual(secretNames({ PRO_ENABLED: "1", PRO_EMAIL_PROVIDER: "scaleway" }), ["PLATE_PEPPER", "IP_PEPPER", "SCW_SECRET_KEY"]);
  });
});
