// Espace Pro : envoi des codes de vérification.
//  - e-mail : Amazon SES (API v2, SendEmail), depuis une adresse du domaine pixcar.fr vérifié dans SES, ou Scaleway Transactional Email
//    (PRO_EMAIL_PROVIDER=scaleway) : le compte SES de Pixcar reste en mode test (sortie refusée le 14 octobre 2026) ;
//  - SMS : AWS End User Messaging Notify (SendNotifyTextMessage) : numéros gérés par AWS, modèle de message « code de vérification »
//    en français fourni par AWS (variables « code » et « time »), sans numéro d'expéditeur à enregistrer ;
//  - « memory » : rien ne part, les messages sont gardés en mémoire (tests, développement).
// Le texte ne contient que le code, le nom du garage et la marche à suivre si l'on n'a rien demandé.
// Les clients AWS ne sont chargés qu'au premier envoi : ils n'alourdissent pas le démarrage de l'API.

import { createScalewayMailer } from "./scaleway.mjs";

export function emailText({ code, minutes, garageName, contact }) {
  const subject = `Pixcar : votre code de vérification ${code}`;
  const text = [
    "Bonjour,",
    "",
    `Quelqu'un demande à gérer la fiche Pixcar du garage « ${garageName} » et a choisi de recevoir le code à cette adresse.`,
    "",
    `Code de vérification : ${code}`,
    `Il est valable ${minutes} minutes.`,
    "",
    "Vous n'êtes pas à l'origine de cette demande ? Ne transmettez ce code à personne : sans lui, rien ne change sur la fiche du garage.",
    `Signalez-le si vous le souhaitez à ${contact}.`,
    "",
    "Pixcar — comparateur de prix de garages (https://pixcar.fr)",
  ].join("\n");
  return { subject, text };
}

// E-mail à Pixcar quand un garage vérifié demande à changer son nom, son adresse ou son téléphone (« Mon garage », relu avant publication).
// Texte seul ; tout ce qu'il contient vient de l'API (valeurs déjà validées) ou du registre. Les retours à la ligne sont retirés de l'objet.
export function reviewEmailText({ garageName, garageId, siret, fieldLabel, current, requested, changeId, at }) {
  const oneLine = (v) => String(v).replace(/[\r\n]+/g, " ").trim();
  const when = new Date(at).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const siretText = /^\d{14}$/.test(String(siret)) ? `${siret.slice(0, 3)} ${siret.slice(3, 6)} ${siret.slice(6, 9)} ${siret.slice(9)}` : "";
  const subject = oneLine(`Pixcar · à relire : ${fieldLabel} de « ${garageName} »`);
  const text = [
    "Bonjour,",
    "",
    "Un garage vérifié demande un changement de sa fiche Pixcar. Il ne sera publié qu'après votre relecture ; d'ici là, la fiche garde sa valeur actuelle.",
    "",
    `Garage : ${oneLine(garageName)}`,
    `Identifiant : ${garageId}`,
    siretText ? `SIRET : ${siretText} — fiche officielle : https://annuaire-entreprises.data.gouv.fr/etablissement/${siret}` : null,
    `Champ : ${fieldLabel}`,
    `Valeur actuelle : ${oneLine(current)}`,
    `Valeur demandée : ${oneLine(requested)}`,
    `Demandé le ${when} (heure de Paris)`,
    "",
    "Avant d'approuver : la valeur demandée correspond-elle au registre (adresse de l'établissement) et au site du garage ? Pour un téléphone : figure-t-il sur le site ou sur une fiche publique du garage ? Une adresse approuvée ne déplace pas le garage sur la carte.",
    "",
    "Décision, avec la fonction d'opérations pixcar-ops (docs/exploitation.md, section 10.11) :",
    `  approuver : {"op":"pro-change","id":"${changeId}","decision":"approve"}`,
    `  refuser :   {"op":"pro-change","id":"${changeId}","decision":"reject","reason":"<motif montré au garagiste>"}`,
    'Toutes les demandes en attente : {"op":"pro-changes"}',
    "",
    "Une nouvelle demande sur le même champ remplace celle-ci.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return { subject, text };
}

export function createSenders(pro, { production = false, log = () => {}, fetchImpl } = {}) {
  const minutes = Math.round(pro.codeTtlSeconds / 60);
  if (pro.sender === "memory") {
    const outbox = [];
    return {
      kind: "memory",
      outbox,
      async send({ channel, target, code, garageName }) {
        outbox.push({ channel, target, code, garageName, minutes });
        if (!production) log({ level: "info", msg: "code de vérification (envoi simulé)", channel });
        return { id: "memory-" + outbox.length };
      },
      // e-mail à Pixcar (relecture d'un changement de fiche) ou e-mail de rendez-vous (channel « rdv »)
      async mail({ to, subject, text, html, from, replyTo, attachments, channel = "review" }) {
        outbox.push({ channel, target: to, subject, text, ...(html ? { html } : {}), ...(from ? { from } : {}), ...(replyTo ? { replyTo } : {}), ...(attachments ? { attachments } : {}) });
        return { id: "memory-" + outbox.length };
      },
    };
  }
  if (pro.sender !== "aws") throw new Error(`PRO_SENDER inconnu : ${pro.sender}`);
  let ses, sms, scw;
  return {
    kind: "aws",
    async send({ channel, target, code, garageName }) {
      if (channel === "sms") {
        const { PinpointSMSVoiceV2Client, SendNotifyTextMessageCommand } = await import("@aws-sdk/client-pinpoint-sms-voice-v2");
        sms ||= new PinpointSMSVoiceV2Client({ region: pro.awsRegion });
        const out = await sms.send(
          new SendNotifyTextMessageCommand({
            NotifyConfigurationId: pro.notifyConfigurationId,
            DestinationPhoneNumber: target,
            TemplateId: pro.notifyTemplateId || undefined,
            TemplateVariables: { code, time: String(minutes) },
            TimeToLive: pro.codeTtlSeconds, // secondes ; 72 h par défaut chez AWS, inutile pour un code valable 10 minutes
          }),
        );
        return { id: out.MessageId || "" };
      }
      const { subject, text } = emailText({ code, minutes, garageName, contact: pro.contact });
      if (pro.emailProvider === "scaleway") {
        scw ||= createScalewayMailer({ secretKey: pro.scwSecretKey, projectId: pro.scwProjectId, region: pro.scwRegion, ...(fetchImpl ? { fetchImpl } : {}) });
        return scw.send({ from: pro.emailFrom, to: target, subject, text });
      }
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      ses ||= new SESv2Client({ region: pro.awsRegion });
      const out = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: pro.emailFrom,
          Destination: { ToAddresses: [target] },
          Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } },
          ConfigurationSetName: pro.sesConfigurationSet || undefined,
        }),
      );
      return { id: out.MessageId || "" };
    },
    // e-mail à Pixcar (relecture d'un changement de fiche) ou e-mail de rendez-vous (from : rendez-vous@…, HTML, Reply-To, fichier
    // d'agenda), par le même fournisseur que les codes. Scaleway refuse une pièce jointe (type non admis) : l'e-mail repart sans elle
    // (le lien de suivi permet aussi d'ajouter le rendez-vous à l'agenda). SES (mode simple) : pas de pièce jointe.
    async mail({ to, subject, text, html, from, replyTo, attachments }) {
      const sender = from || pro.emailFrom;
      if (pro.emailProvider === "scaleway") {
        scw ||= createScalewayMailer({ secretKey: pro.scwSecretKey, projectId: pro.scwProjectId, region: pro.scwRegion, ...(fetchImpl ? { fetchImpl } : {}) });
        try {
          return await scw.send({ from: sender, to, subject, text, html, replyTo, attachments });
        } catch (e) {
          if (!(attachments && attachments.length && (e.status === 400 || e.status === 422))) throw e;
          log({ level: "warn", msg: "pièce jointe refusée par Scaleway : e-mail renvoyé sans elle", event: "rdv_attachment_refused", error: String(e.message).slice(0, 200) });
          return scw.send({ from: sender, to, subject, text, html, replyTo });
        }
      }
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      ses ||= new SESv2Client({ region: pro.awsRegion });
      const out = await ses.send(
        new SendEmailCommand({
          FromEmailAddress: sender,
          Destination: { ToAddresses: [to] },
          ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
          Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}) } } },
          ConfigurationSetName: pro.sesConfigurationSet || undefined,
        }),
      );
      return { id: out.MessageId || "" };
    },
  };
}
