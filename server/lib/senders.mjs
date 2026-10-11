// Espace Pro : envoi des codes de vérification.
//  - e-mail : Amazon SES (API v2, SendEmail), depuis une adresse du domaine pixcar.fr vérifié dans SES ;
//  - SMS : AWS End User Messaging Notify (SendNotifyTextMessage) : numéros gérés par AWS, modèle de message « code de vérification »
//    en français fourni par AWS (variables « code » et « time »), sans numéro d'expéditeur à enregistrer ;
//  - « memory » : rien ne part, les messages sont gardés en mémoire (tests, développement).
// Le texte ne contient que le code, le nom du garage et la marche à suivre si l'on n'a rien demandé.
// Les clients AWS ne sont chargés qu'au premier envoi : ils n'alourdissent pas le démarrage de l'API.

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

export function createSenders(pro, { production = false, log = () => {} } = {}) {
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
    };
  }
  if (pro.sender !== "aws") throw new Error(`PRO_SENDER inconnu : ${pro.sender}`);
  let ses, sms;
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
          }),
        );
        return { id: out.MessageId || "" };
      }
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      ses ||= new SESv2Client({ region: pro.awsRegion });
      const { subject, text } = emailText({ code, minutes, garageName, contact: pro.contact });
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
  };
}
