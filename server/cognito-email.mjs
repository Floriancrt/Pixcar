// Cognito, déclencheur « custom email sender » : Cognito n'envoie plus lui-même ses codes (inscription, connexion sans mot de passe) par
// SES, dont le compte reste en mode test ; il appelle cette fonction avec le code CHIFFRÉ par la clé KMS de la pile pixcar-pro, et elle
// l'envoie par Scaleway Transactional Email depuis connexion@pixcar.fr.
//   événement : { triggerSource: "CustomEmailSender_…", request: { type: "customEmailSenderRequestV1", code: <base64>, userAttributes: { email } } }
//   rien à renvoyer ; une exception fait échouer l'action côté Cognito (la page affiche une erreur, la personne peut réessayer).
// Jamais de code ni d'adresse dans les journaux : seulement le type d'événement et l'identifiant d'envoi de Scaleway.
// Variables : KEY_ARN (clé KMS), SSM_PREFIX (+ SCW_SECRET_KEY lu dans SSM), SCW_PROJECT_ID, SCW_REGION, EMAIL_FROM, CONTACT, LOG_LEVEL.
import { buildDecrypt } from "@aws-crypto/decrypt-node";
import { KmsKeyringNode } from "@aws-crypto/kms-keyring-node";
import { CommitmentPolicy } from "@aws-crypto/material-management-node";
import { jsonLog } from "./lib/log.mjs";
import { createScalewayMailer } from "./lib/scaleway.mjs";
import { readSecrets } from "./lib/secrets.mjs";

const SITE = "Pixcar — comparateur de prix de garages (https://pixcar.fr)";

// Texte de chaque événement ; null = événement que l'Espace Pro ne produit pas (rien n'est envoyé, l'événement est journalisé).
export function messageFor(triggerSource, code, contact) {
  const ignore = `Vous n'êtes pas à l'origine de cette demande ? Ignorez ce message${contact ? ` ou signalez-le à ${contact}` : ""}.`;
  switch (triggerSource) {
    case "CustomEmailSender_SignUp":
    case "CustomEmailSender_ResendCode":
      return {
        subject: `Pixcar : votre code de confirmation ${code}`,
        text: ["Bonjour,", "", `Votre code de confirmation pour l'Espace Pro Pixcar : ${code}`, "", "Saisissez-le sur la page ouverte pour terminer votre inscription. Aucun compte n'est créé sans lui.", ignore, "", SITE].join("\n"),
      };
    case "CustomEmailSender_Authentication":
      return {
        subject: `Pixcar : votre code de connexion ${code}`,
        text: ["Bonjour,", "", `Votre code de connexion à l'Espace Pro Pixcar : ${code}`, "", "Il n'est valable que quelques minutes. Personne ne peut se connecter à votre compte sans lui : ne le transmettez à personne.", ignore, "", SITE].join("\n"),
      };
    case "CustomEmailSender_ForgotPassword":
      return {
        subject: `Pixcar : votre code de réinitialisation ${code}`,
        text: ["Bonjour,", "", `Votre code de réinitialisation pour l'Espace Pro Pixcar : ${code}`, "", ignore, "", SITE].join("\n"),
      };
    case "CustomEmailSender_UpdateUserAttribute":
    case "CustomEmailSender_VerifyUserAttribute":
      return {
        subject: `Pixcar : vérification de votre adresse ${code}`,
        text: ["Bonjour,", "", `Votre code pour vérifier cette adresse dans l'Espace Pro Pixcar : ${code}`, "", ignore, "", SITE].join("\n"),
      };
    default:
      return null; // AdminCreateUser (comptes créés par l'exploitant : non utilisé), AccountTakeOverNotification (protection avancée : non activée)
  }
}

// Cœur testable : decryptCode(base64) → texte du code ; send({ from, to, subject, text }) → { id }
export function createEmailSender({ decryptCode, send, from, contact = "", log = () => {} }) {
  return async function handler(event) {
    const source = event && event.triggerSource;
    const req = (event && event.request) || {};
    const to = req.userAttributes && req.userAttributes.email;
    if (req.type && req.type !== "customEmailSenderRequestV1") throw new Error(`événement Cognito inattendu (${String(req.type).slice(0, 60)})`);
    if (!to || typeof req.code !== "string" || !req.code) throw new Error(`événement Cognito incomplet (${source})`);
    const probe = messageFor(source, "0", contact);
    if (!probe) {
      log({ level: "warn", msg: "événement Cognito sans e-mail prévu : rien n'est envoyé", event: "cognito_email_skipped", triggerSource: String(source).slice(0, 80) });
      return;
    }
    const code = await decryptCode(req.code);
    if (!/^[0-9]{4,12}$/.test(code)) throw new Error(`code Cognito inattendu (${source})`); // jamais d'autre chose qu'un code dans un e-mail
    const { subject, text } = messageFor(source, code, contact);
    const out = await send({ from, to, subject, text });
    log({ level: "info", msg: "code Cognito envoyé", event: "cognito_email_sent", triggerSource: source, id: out.id });
  };
}

// Déchiffrement du code : message du kit de chiffrement d'AWS (AWS Encryption SDK), clé KMS de la pile. Le trousseau est injectable (tests).
export function makeDecryptCode({ keyArn, keyring } = {}) {
  const { decrypt } = buildDecrypt(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
  const ring = keyring || new KmsKeyringNode({ keyIds: [keyArn] });
  return async (b64) => {
    const { plaintext } = await decrypt(ring, Buffer.from(b64, "base64"));
    return Buffer.from(plaintext).toString("utf8");
  };
}

// Démarrage réel : la clé Scaleway est lue une fois dans SSM (SecureString), au premier envoi.
export function handlerFromEnvironment(env = process.env, log = jsonLog(env.LOG_LEVEL)) {
  if (!env.KEY_ARN) throw new Error("KEY_ARN absent (clé KMS du déclencheur Cognito)");
  const decryptCode = makeDecryptCode({ keyArn: env.KEY_ARN });
  let mailer = null;
  const send = async (msg) => {
    if (!mailer) {
      const secrets = await readSecrets(env, { names: ["SCW_SECRET_KEY"] }); // {} si la variable d'environnement est déjà là (tests)
      mailer = createScalewayMailer({ secretKey: env.SCW_SECRET_KEY || secrets.SCW_SECRET_KEY, projectId: env.SCW_PROJECT_ID, region: env.SCW_REGION || "fr-par" });
    }
    return mailer.send(msg);
  };
  return createEmailSender({ decryptCode, send, from: env.EMAIL_FROM || "Pixcar <connexion@pixcar.fr>", contact: env.CONTACT || "contact@pixcar.fr", log });
}

let real = null;
export const handler = async (event) => (real ||= handlerFromEnvironment())(event);
