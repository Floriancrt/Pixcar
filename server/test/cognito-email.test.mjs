// Déclencheur Cognito « custom email sender » : vrai déchiffrement d'un message du kit de chiffrement d'AWS (trousseau AES local à la place
// de KMS), texte de chaque événement, rien d'envoyé pour les événements que l'Espace Pro ne produit pas, jamais de code ni d'adresse
// dans les journaux, refus des événements incomplets.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { buildEncrypt } from "@aws-crypto/encrypt-node";
import { CommitmentPolicy } from "@aws-crypto/material-management-node";
import { RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from "@aws-crypto/raw-aes-keyring-node";
import { createEmailSender, handlerFromEnvironment, makeDecryptCode, messageFor } from "../cognito-email.mjs";

const keyring = new RawAesKeyringNode({ keyName: "test", keyNamespace: "pixcar-test", unencryptedMasterKey: new Uint8Array(randomBytes(32)), wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING });
const encryptWith = (policy) => async (code) => Buffer.from((await buildEncrypt(policy).encrypt(keyring, code)).result).toString("base64");
const event = (triggerSource, code = "Y29kZQ==", email = "garagiste@exemple.fr") => ({ version: "1", triggerSource, region: "eu-north-1", userPoolId: "eu-north-1_X", userName: "u", request: { type: "customEmailSenderRequestV1", code, userAttributes: { email } } });

function harness({ code = "48291375" } = {}) {
  const sent = [];
  const logs = [];
  const handler = createEmailSender({
    decryptCode: async () => code,
    send: async (m) => (sent.push(m), { id: "scw-1" }),
    from: "Pixcar <connexion@pixcar.fr>",
    contact: "contact@pixcar.fr",
    log: (o) => logs.push(o),
  });
  return { handler, sent, logs };
}

describe("Cognito → Scaleway : déchiffrement du code", () => {
  test("message du kit d'AWS, avec ou sans engagement de clé (key commitment) : le code est retrouvé", async () => {
    const decryptCode = makeDecryptCode({ keyring });
    assert.equal(await decryptCode(await encryptWith(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)("12345678")), "12345678");
    assert.equal(await decryptCode(await encryptWith(CommitmentPolicy.FORBID_ENCRYPT_ALLOW_DECRYPT)("654321")), "654321");
  });

  test("un message altéré ou chiffré par une autre clé est refusé", async () => {
    const decryptCode = makeDecryptCode({ keyring });
    const good = Buffer.from(await encryptWith(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT)("12345678"), "base64");
    good[good.length - 5] ^= 1;
    await assert.rejects(decryptCode(good.toString("base64")));
    const other = new RawAesKeyringNode({ keyName: "test", keyNamespace: "pixcar-test", unencryptedMasterKey: new Uint8Array(randomBytes(32)), wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING });
    const foreign = Buffer.from((await buildEncrypt(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT).encrypt(other, "12345678")).result).toString("base64");
    await assert.rejects(decryptCode(foreign));
  });
});

describe("Cognito → Scaleway : envoi", () => {
  test("connexion : code à 8 chiffres, envoyé depuis connexion@pixcar.fr à l'adresse du compte", async () => {
    const h = harness();
    await h.handler(event("CustomEmailSender_Authentication"));
    assert.equal(h.sent.length, 1);
    const m = h.sent[0];
    assert.deepEqual([m.from, m.to, m.subject], ["Pixcar <connexion@pixcar.fr>", "garagiste@exemple.fr", "Pixcar : votre code de connexion 48291375"]);
    assert.match(m.text, /Votre code de connexion à l'Espace Pro Pixcar : 48291375/);
    assert.match(m.text, /signalez-le à contact@pixcar\.fr/);
  });

  test("inscription et nouvel envoi : code de confirmation", async () => {
    for (const src of ["CustomEmailSender_SignUp", "CustomEmailSender_ResendCode"]) {
      const h = harness({ code: "123456" });
      await h.handler(event(src));
      assert.equal(h.sent[0].subject, "Pixcar : votre code de confirmation 123456", src);
      assert.match(h.sent[0].text, /terminer votre inscription/);
    }
  });

  test("journaux : le type d'événement et l'identifiant d'envoi, jamais le code ni l'adresse", async () => {
    const h = harness();
    await h.handler(event("CustomEmailSender_Authentication"));
    const all = JSON.stringify(h.logs);
    assert.match(all, /cognito_email_sent/);
    assert.match(all, /scw-1/);
    assert.ok(!all.includes("48291375") && !all.includes("garagiste@exemple.fr"), all);
  });

  test("événements que l'Espace Pro ne produit pas (création par l'exploitant, alerte de prise de contrôle) : rien n'est envoyé", async () => {
    for (const src of ["CustomEmailSender_AdminCreateUser", "CustomEmailSender_AccountTakeOverNotification", "Autre"]) {
      const h = harness();
      await h.handler(event(src));
      assert.equal(h.sent.length, 0, src);
      assert.match(JSON.stringify(h.logs), /cognito_email_skipped/);
    }
    assert.equal(messageFor("CustomEmailSender_AdminCreateUser", "1", ""), null);
  });

  test("événement incomplet, d'un autre type, ou code qui n'est pas un code : erreur, rien n'est envoyé", async () => {
    const h = harness();
    await assert.rejects(h.handler(event("CustomEmailSender_Authentication", "", "a@b.fr")), /incomplet/);
    await assert.rejects(h.handler(event("CustomEmailSender_Authentication", "Y29kZQ==", "")), /incomplet/);
    await assert.rejects(h.handler({ ...event("CustomEmailSender_Authentication"), request: { ...event("x").request, type: "customSMSSenderRequestV1" } }), /inattendu/);
    const bad = harness({ code: "MotDePasse!1" });
    await assert.rejects(bad.handler(event("CustomEmailSender_Authentication")), /code Cognito inattendu/);
    assert.equal(h.sent.length + bad.sent.length, 0);
  });

  test("démarrage : la clé KMS est obligatoire", () => {
    assert.throws(() => handlerFromEnvironment({}), /KEY_ARN/);
  });
});
