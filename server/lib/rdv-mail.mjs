// Rendez-vous en ligne : texte des e-mails (maquette « Rendez-vous 4 sur 7 »). Chaque e-mail a une version texte et une version HTML
// (sauf les codes : texte seul, code dans l'objet pour le lire dans la notification). HTML de messagerie : tableaux, styles en ligne,
// Arial, aucune image ni ressource distante. Tout ce qui vient d'une saisie est échappé ; l'objet tient sur une ligne.
import { dayLabel, instantLabel, servicesText, timeLabel, whenLabel } from "../../src/js/shared/rdv.js";
import { phoneText } from "../../src/js/shared/garage-profile.js";
import { NIL_SLOT } from "../../src/js/shared/plan.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const INK = "#111216", MUTED = "#686a72", LINE = "#e6e3dc", SOFT = "#f6f4ef", BTN = "#FF5A1E", BTN_INK = "#111216";
const FONT = "Arial, Helvetica, sans-serif";

const when = (r) => whenLabel(r.day, r.start_min);
const whenCap = (r) => cap(when(r));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const carText = (r) => [r.car, r.car_year, r.plate].filter(Boolean).join(" · ");
const dropText = (r) => (r.mode === "drop" ? `voiture déposée entre ${timeLabel(r.start_min)} et ${timeLabel(Math.min(r.start_min + 60, r.end_min))}, rendue vers ${timeLabel(r.end_min)}` : r.slot_id === NIL_SLOT ? `voiture rendue vers ${timeLabel(r.end_min)}` : "");
// mode avancé : qui fait l'intervention, et sur quel poste (e-mails au garage)
const planText = (p) => (p ? [p.staff.length ? `${p.proposed ? "Proposé à" : "Affecté à"} ${p.staff.join(", ")}` : "", p.posts.length ? p.posts.join(", ") : ""].filter(Boolean).join(" · ") : "");

// ---------------------------------------------------------------- briques HTML
function layout({ title, aside, body, foot }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${SOFT};font-family:${FONT};color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden">
<tr><td style="background:${INK};padding:18px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:${FONT};font-size:24px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px">pix<span style="color:${BTN}">car</span></td>
<td align="right" style="font-family:${FONT};font-size:13px;color:#d6d4cf">${esc(aside)}</td></tr></table></td></tr>
<tr><td style="padding:24px 24px 8px 24px;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK}">${body}</td></tr>
<tr><td style="padding:8px 24px 24px 24px"><div style="border-top:1px solid ${LINE};padding-top:12px;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED}">${foot}</div></td></tr>
</table></td></tr></table></body></html>`;
}
const badge = (text, tone) => {
  const [bg, fg] = { wait: ["#fdf0d5", "#7a4b00"], ok: ["#ddf3e3", "#14632f"], bad: ["#fde2e0", "#9b1c13"] }[tone];
  return `<p style="margin:0 0 12px 0"><span style="display:inline-block;background:${bg};color:${fg};font-size:13px;font-weight:bold;padding:4px 10px;border-radius:999px">${esc(text)}</span></p>`;
};
const h1 = (text) => `<h1 style="margin:0 0 14px 0;font-family:${FONT};font-size:22px;line-height:1.25;color:${INK}">${esc(text)}</h1>`;
const p = (html, style = "") => `<p style="margin:0 0 14px 0;${style}">${html}</p>`;
const b = (text) => `<b>${esc(text)}</b>`;
// rows : [[libellé, valeur (texte), précision (texte, facultative)]]
const facts = (rows) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border-radius:10px;margin:0 0 16px 0">${rows
    .filter((r) => r && r[1])
    .map(
      ([k, v, sub], i) =>
        `<tr><td valign="top" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ""}width:110px;font-size:14px;color:${MUTED}">${esc(k)}</td><td style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ""}font-size:14px;color:${INK}"><b>${esc(v)}</b>${sub ? `<br><span style="color:${MUTED};font-size:13px">${esc(sub)}</span>` : ""}</td></tr>`,
    )
    .join("")}</table>`;
const button = (href, text, { secondary = false } = {}) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;border-radius:10px;font-family:${FONT};font-size:15px;font-weight:bold;text-decoration:none;${secondary ? `background:#ffffff;color:${INK};border:2px solid ${INK}` : `background:${BTN};color:${BTN_INK};border:2px solid ${BTN}`}">${esc(text)}</a>`;
const buttons = (...list) => `<p style="margin:4px 0 14px 0">${list.join("")}</p>`;
const alert = (html) => `<p style="margin:0 0 16px 0;padding:12px 14px;background:#fdf0d5;border-radius:10px;color:#5c3900;font-size:14px">${html}</p>`;
const quote = (text) => `<p style="margin:0 0 14px 0;padding:10px 14px;border-left:3px solid ${LINE};color:${INK};font-style:italic">« ${esc(text)} »</p>`;

// ---------------------------------------------------------------- texte brut
const lines = (...l) => l.filter((x) => x !== null && x !== undefined && x !== false).join("\n");
const textFacts = (rows) => rows.filter((r) => r && r[1]).map(([k, v, sub]) => `${k} : ${v}${sub ? ` (${sub})` : ""}`).join("\n");

// ---------------------------------------------------------------- codes (texte seul)
export function clientCodeMail({ code, garageName, minutes }) {
  return {
    subject: `Pixcar : votre code ${code}`,
    text: lines(
      "Bonjour,",
      "",
      `Votre code pour envoyer votre demande de rendez-vous à ${oneLine(garageName)} : ${code}`,
      "",
      `Il est valable ${minutes} minutes. Si vous n'avez rien demandé, ignorez cet e-mail : aucune demande ne part sans ce code.`,
      "",
      "Pixcar — comparateur de prix de garages (https://pixcar.fr)",
    ),
  };
}
export function notifyCodeMail({ code, garageName, minutes }) {
  return {
    subject: `Pixcar : code ${code} pour recevoir vos demandes de rendez-vous`,
    text: lines(
      "Bonjour,",
      "",
      `Le garage « ${oneLine(garageName)} » veut recevoir ses demandes de rendez-vous en ligne à cette adresse.`,
      "",
      `Code à saisir dans l'Espace Pro (Disponibilités) : ${code}`,
      `Il est valable ${minutes} minutes.`,
      "",
      "Vous n'êtes pas à l'origine de cette demande ? Ignorez cet e-mail : sans ce code, rien ne vous sera envoyé.",
      "",
      "Pixcar — comparateur de prix de garages (https://pixcar.fr)",
    ),
  };
}

// ---------------------------------------------------------------- e-mails d'une demande
// c : { r (demande), garage: { name, addr, phone }, links: { track, action, pro, site, route }, alternatives: [{ name, km, city, first }],
//       reason (texte du motif), slot: { name, left, capacity } ou plan: { staff, posts } (e-mail au garage), ics (fichier d'agenda),
//       auto (confirmé d'office : prestations à confirmation automatique) }
export function requestMail(kind, c) {
  const make = BUILDERS[kind];
  if (!make) throw new Error(`e-mail inconnu : ${kind}`);
  const out = make(c);
  return { ...out, subject: oneLine(out.subject) };
}

const svc = (r) => servicesText(r.services);
const clientFacts = (c) => [
  ["Quand", whenCap(c.r), dropText(c.r)],
  ["Où", c.garage.name, [c.garage.addr, c.garage.phone].filter(Boolean).join(" · ")],
  ["Prestation", svc(c.r)],
  ["Voiture", carText(c.r)],
];
const clientFoot = (c, { personal = true } = {}) =>
  [
    personal ? "Ce lien est personnel : ne transférez pas cet e-mail." : "",
    `Ne répondez pas à ce message${c.garage.phone ? ` ; pour joindre le garage, appelez le ${esc(c.garage.phone)}` : ""}.`,
    `Vos coordonnées ne sont transmises qu'à ${esc(c.garage.name)} et sont effacées 30 jours après le rendez-vous.`,
  ]
    .filter(Boolean)
    .join(" ");
const clientFootText = (c, opts) => clientFoot(c, opts).replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const altBlock = (c) => {
  if (!c.alternatives || !c.alternatives.length) return "";
  const rows = c.alternatives
    .map(
      (a, i) =>
        `<tr><td style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ""}font-size:14px"><b>${esc(a.name)}</b><br><span style="color:${MUTED};font-size:13px">${esc([a.km, a.city].filter(Boolean).join(" · "))}</span></td><td align="right" style="padding:10px 14px;${i ? `border-top:1px solid ${LINE};` : ""}font-size:13px;color:${MUTED}">${esc(a.first)}</td></tr>`,
    )
    .join("");
  return `${p(`<b>D'autres garages acceptent ${esc(svc(c.r).toLowerCase())} en ligne près de chez ce garage :</b>`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:10px;margin:0 0 16px 0">${rows}</table>`;
};
const altText = (c) => (c.alternatives && c.alternatives.length ? ["D'autres garages acceptent cette prestation en ligne :", ...c.alternatives.map((a) => `- ${a.name} (${[a.km, a.city].filter(Boolean).join(", ")}) : ${a.first}`), ""] : []);

const BUILDERS = {
  client_sent: (c) => {
    const deadline = instantLabel(c.r.deadline);
    return {
      subject: `Demande envoyée à ${c.garage.name} : ${when(c.r)}`,
      html: layout({
        title: "Demande envoyée",
        aside: "Votre demande de rendez-vous",
        body: [
          badge("En attente de la réponse du garage", "wait"),
          h1(`${c.garage.name} a reçu votre demande`),
          facts(clientFacts(c)),
          p(`Le garage vous répond au plus tard ${b(deadline)}. Sans réponse, la demande est annulée et nous vous proposons d'autres garages.`),
          buttons(button(c.links.track, "Suivre ou annuler ma demande")),
        ].join(""),
        foot: clientFoot(c),
      }),
      text: lines(`${c.garage.name} a reçu votre demande de rendez-vous.`, "", textFacts(clientFacts(c)), "", `Le garage vous répond au plus tard ${deadline}. Sans réponse, la demande est annulée et nous vous proposons d'autres garages.`, "", `Suivre ou annuler votre demande : ${c.links.track}`, "", clientFootText(c)),
    };
  },
  garage_new: (c) => {
    const deadline = instantLabel(c.r.deadline);
    const slot = c.slot ? `Créneau « ${c.slot.name} »${c.slot.capacity > 1 ? ` · encore ${c.slot.left} place${c.slot.left > 1 ? "s" : ""} sur ${c.slot.capacity} à cette heure` : ""}` : planText(c.plan);
    const rows = [
      ["Quand", whenCap(c.r), [dropText(c.r), slot].filter(Boolean).join(" · ")],
      ["Prestation", svc(c.r)],
      ["Client", c.r.name, [phoneText(c.r.phone), c.r.email].filter(Boolean).join(" · ")],
      ["Voiture", carText(c.r)],
      ["Message", c.r.message || "Aucun"],
    ];
    return {
      subject: `Nouvelle demande : ${svc(c.r)}, ${when(c.r)}`,
      html: layout({
        title: "Nouvelle demande de rendez-vous",
        aside: `Espace Pro · ${c.garage.name}`,
        body: [
          h1("Nouvelle demande de rendez-vous"),
          alert(`Répondez avant ${b(deadline)}. Sans réponse, la demande est annulée et le client prévenu.`),
          facts(rows),
          buttons(button(c.links.action, "Accepter"), button(c.links.action, "Refuser", { secondary: true })),
          p(`Chaque bouton ouvre une page où vous confirmez votre choix. Toutes vos demandes : <a href="${esc(c.links.pro)}" style="color:${INK}">Espace Pro › Demandes</a>. Pour écrire au client, répondez simplement à cet e-mail.`, `font-size:13px;color:${MUTED}`),
        ].join(""),
        foot: "Après 3 demandes sans réponse de suite, vos rendez-vous en ligne sont mis en pause ; vous les réactivez dans Disponibilités. Ces coordonnées vous sont transmises pour ce rendez-vous seulement : ne les utilisez pas à d'autres fins.",
      }),
      text: lines(
        "Nouvelle demande de rendez-vous",
        "",
        `Répondez avant ${deadline}. Sans réponse, la demande est annulée et le client prévenu.`,
        "",
        textFacts(rows),
        "",
        `Accepter ou refuser : ${c.links.action}`,
        `Toutes vos demandes : ${c.links.pro}`,
        "Pour écrire au client, répondez à cet e-mail.",
        "",
        "Après 3 demandes sans réponse de suite, vos rendez-vous en ligne sont mis en pause ; vous les réactivez dans Disponibilités.",
      ),
    };
  },
  // nouveau rendez-vous confirmé d'office (mode avancé, confirmation automatique) : le garage est prévenu, il n'a rien à décider
  garage_booked: (c) => {
    const rows = [
      ["Quand", whenCap(c.r), [dropText(c.r), planText(c.plan)].filter(Boolean).join(" · ")],
      ["Prestation", svc(c.r)],
      ["Client", c.r.name, [phoneText(c.r.phone), c.r.email].filter(Boolean).join(" · ")],
      ["Voiture", carText(c.r)],
      ["Message", c.r.message || "Aucun"],
    ];
    return {
      subject: `Nouveau rendez-vous confirmé : ${svc(c.r)}, ${when(c.r)}`,
      html: layout({
        title: "Nouveau rendez-vous confirmé",
        aside: `Espace Pro · ${c.garage.name}`,
        body: [
          badge("Confirmé automatiquement", "ok"),
          h1("Nouveau rendez-vous"),
          p("Cette prestation est en confirmation automatique : le client a reçu sa confirmation, les ressources sont réservées dans votre calendrier."),
          facts(rows),
          buttons(button(c.links.pro, "Ouvrir l'Espace Pro", { secondary: true })),
          p("Pour écrire au client, répondez simplement à cet e-mail. Un empêchement : annulez depuis Espace Pro › Demandes, le client est prévenu.", `font-size:13px;color:${MUTED}`),
        ].join(""),
        foot: "Ces coordonnées vous sont transmises pour ce rendez-vous seulement : ne les utilisez pas à d'autres fins.",
      }),
      text: lines("Nouveau rendez-vous confirmé automatiquement.", "", textFacts(rows), "", `Espace Pro : ${c.links.pro}`, "Pour écrire au client, répondez à cet e-mail."),
    };
  },
  // le garage change l'heure d'un rendez-vous : nouveau fichier d'agenda, annulation toujours possible
  client_moved: (c) => ({
    subject: `Nouvel horaire : ${when(c.r)} chez ${c.garage.name}`,
    html: layout({
      title: "Rendez-vous déplacé",
      aside: "Votre rendez-vous",
      body: [
        badge("Horaire changé par le garage", "wait"),
        h1(`Votre rendez-vous est déplacé : ${when(c.r)}`),
        facts(clientFacts(c)),
        buttons(button(c.links.track, "Voir mon rendez-vous"), c.links.route ? button(c.links.route, "Itinéraire", { secondary: true }) : ""),
        p(`Ce nouvel horaire ne vous convient pas ? <a href="${esc(c.links.track)}" style="color:${INK}">Annulez ici</a>, ou appelez le garage.`, "font-size:14px"),
      ].join(""),
      foot: `Le fichier d'agenda joint remplace l'ancien horaire. ${clientFoot(c)}`,
    }),
    text: lines(`${c.garage.name} déplace votre rendez-vous.`, "", textFacts(clientFacts(c)), "", `Voir ou annuler : ${c.links.track}`, "", clientFootText(c)),
    attachments: c.ics ? [{ name: "rendez-vous.ics", type: "text/calendar", content: c.ics }] : [],
  }),
  client_confirmed: (c) => ({
    subject: `Confirmé : ${when(c.r)} chez ${c.garage.name}`,
    html: layout({
      title: "Rendez-vous confirmé",
      aside: "Votre rendez-vous",
      body: [
        badge(c.auto ? "Rendez-vous confirmé" : "Confirmé par le garage", "ok"),
        h1(`${cap(dayLabel(c.r.day).split(" ")[0])} ${dayLabel(c.r.day).split(" ").slice(1).join(" ")}, ${timeLabel(c.r.start_min)}, chez ${c.garage.name}`),
        facts(clientFacts(c)),
        buttons(button(c.links.track, "Ajouter à mon agenda"), c.links.route ? button(c.links.route, "Itinéraire", { secondary: true }) : ""),
        p(`Un empêchement ? <a href="${esc(c.links.track)}" style="color:${INK}">Annulez ici</a> : le garage est prévenu et l'horaire libéré.`, "font-size:14px"),
      ].join(""),
      foot: `Le fichier d'agenda est joint à cet e-mail. Le prix final se règle au garage, selon son devis. ${clientFoot(c)}`,
    }),
    text: lines(`Votre rendez-vous est confirmé par ${c.garage.name}.`, "", textFacts(clientFacts(c)), "", `Suivre, ajouter à l'agenda ou annuler : ${c.links.track}`, c.links.route ? `Itinéraire : ${c.links.route}` : null, "", "Le prix final se règle au garage, selon son devis.", clientFootText(c)),
    attachments: c.ics ? [{ name: "rendez-vous.ics", type: "text/calendar", content: c.ics }] : [],
  }),
  client_declined: (c) => endMail(c, {
    subject: `${c.garage.name} ne peut pas vous recevoir ${when(c.r)}`,
    badgeText: "Demande refusée",
    title: `${c.garage.name} ne peut pas vous recevoir`,
    lead: `Votre demande du ${when(c.r)} est refusée par le garage${c.reason ? ` : ${c.reason.toLowerCase()}` : ""}.`,
  }),
  client_expired: (c) => endMail(c, {
    subject: `${c.garage.name} n'a pas pu répondre à votre demande`,
    badgeText: "Demande annulée",
    title: `Pas de réponse de ${c.garage.name}`,
    lead: `Votre demande du ${when(c.r)} est annulée : le garage n'a pas répondu à temps. Rien ne vous est facturé.`,
  }),
  client_cancelled: (c) =>
    endMail(c, {
      subject: `Rendez-vous annulé par ${c.garage.name} : ${when(c.r)}`,
      badgeText: "Rendez-vous annulé",
      title: `${c.garage.name} annule votre rendez-vous`,
      lead:
        c.r.cancelled_by === "closure"
          ? `Votre rendez-vous du ${when(c.r)} est annulé : le garage sera fermé ce jour-là.`
          : `Votre rendez-vous du ${when(c.r)} est annulé par le garage${c.reason ? ` : ${c.reason.toLowerCase()}` : ""}.`,
    }),
  garage_cancelled: (c) => {
    const rows = [["Quand", whenCap(c.r)], ["Prestation", svc(c.r)], ["Client", c.r.name, phoneText(c.r.phone)], ["Motif", c.reason || "Non précisé"]];
    return {
      subject: `Annulé par le client : ${svc(c.r)}, ${when(c.r)}`,
      html: layout({
        title: "Rendez-vous annulé par le client",
        aside: `Espace Pro · ${c.garage.name}`,
        body: [badge("Annulé par le client", "bad"), h1("Un client annule"), facts(rows), p("L'horaire est de nouveau proposé aux automobilistes."), buttons(button(c.links.pro, "Ouvrir l'Espace Pro", { secondary: true }))].join(""),
        foot: "Pixcar — rendez-vous en ligne. Vous recevez cet e-mail à l'adresse choisie dans Disponibilités.",
      }),
      text: lines("Un client annule sa demande de rendez-vous.", "", textFacts(rows), "", "L'horaire est de nouveau proposé aux automobilistes.", `Espace Pro : ${c.links.pro}`),
    };
  },
  client_reminder: (c) => ({
    subject: `Rappel : demain ${timeLabel(c.r.start_min)}, ${svc(c.r)} chez ${c.garage.name}`,
    html: layout({
      title: "Rappel de votre rendez-vous",
      aside: "Votre rendez-vous",
      body: [
        badge("Demain", "ok"),
        h1(`Demain à ${timeLabel(c.r.start_min)}, chez ${c.garage.name}`),
        facts(clientFacts(c)),
        buttons(c.links.route ? button(c.links.route, "Itinéraire") : "", button(c.links.track, "Voir mon rendez-vous", { secondary: true })),
        p(`Un empêchement ? <a href="${esc(c.links.track)}" style="color:${INK}">Annulez ici</a> pour libérer l'horaire.`, "font-size:14px"),
      ].join(""),
      foot: clientFoot(c),
    }),
    text: lines(`Rappel : votre rendez-vous chez ${c.garage.name} est demain.`, "", textFacts(clientFacts(c)), "", `Voir ou annuler : ${c.links.track}`, c.links.route ? `Itinéraire : ${c.links.route}` : null, "", clientFootText(c)),
  }),
  client_followup: (c) => ({
    subject: `Combien avez-vous payé chez ${c.garage.name} ?`,
    html: layout({
      title: "Votre avis compte",
      aside: "Votre avis compte",
      body: [
        h1(`Votre ${svc(c.r).toLowerCase()} du ${dayLabel(c.r.day)}`),
        p("Déclarez le prix payé en 30 secondes : votre déclaration aide les automobilistes près de chez vous à comparer."),
        buttons(button(c.links.track, "Déclarer mon prix")),
      ].join(""),
      foot: "Vous recevez cet e-mail parce que vous l'avez demandé en prenant rendez-vous. C'est le seul : il n'y aura pas de relance.",
    }),
    text: lines(`Votre ${svc(c.r).toLowerCase()} du ${dayLabel(c.r.day)} chez ${c.garage.name}`, "", "Déclarez le prix payé en 30 secondes : votre déclaration aide les automobilistes près de chez vous à comparer.", "", `Déclarer mon prix : ${c.links.track}`, "", "Vous recevez cet e-mail parce que vous l'avez demandé en prenant rendez-vous. C'est le seul : il n'y aura pas de relance."),
  }),
  garage_paused: (c) => ({
    subject: "Vos rendez-vous en ligne sont en pause",
    html: layout({
      title: "Rendez-vous en ligne en pause",
      aside: `Espace Pro · ${c.garage.name}`,
      body: [
        badge("En pause", "bad"),
        h1("Vos rendez-vous en ligne sont en pause"),
        p("Trois demandes de suite sont restées sans réponse avant leur heure limite (une annulation de votre part compte aussi). Pour ne pas faire attendre d'autres automobilistes, Pixcar a mis vos rendez-vous en ligne en pause."),
        p("Réactivez-les dans <b>Espace Pro › Disponibilités</b> dès que vous pouvez répondre aux demandes."),
        buttons(button(c.links.pro, "Ouvrir l'Espace Pro")),
      ].join(""),
      foot: "Vos réglages et vos créneaux sont conservés. Vous recevez cet e-mail à l'adresse choisie dans Disponibilités.",
    }),
    text: lines("Vos rendez-vous en ligne sont en pause.", "", "Trois demandes de suite sont restées sans réponse avant leur heure limite. Réactivez-les dans Espace Pro › Disponibilités dès que vous pouvez répondre.", "", `Espace Pro : ${c.links.pro}`, "", "Vos réglages et vos créneaux sont conservés."),
  }),
};

// Refus, expiration, annulation : le motif, d'autres garages, et toujours une suite possible
function endMail(c, { subject, badgeText, title, lead }) {
  return {
    subject,
    html: layout({
      title: badgeText,
      aside: "Votre demande de rendez-vous",
      body: [
        badge(badgeText, "bad"),
        h1(title),
        p(esc(lead)),
        c.r.note ? quote(c.r.note) : "",
        altBlock(c),
        buttons(button(c.links.track, c.alternatives && c.alternatives.length ? "Voir ces garages sur Pixcar" : "Trouver un autre garage sur Pixcar")),
      ].join(""),
      foot: clientFoot(c, { personal: true }),
    }),
    text: lines(lead, c.r.note ? `Mot du garage : « ${c.r.note} »` : null, "", ...altText(c), `Trouver un autre garage : ${c.links.track}`, "", clientFootText(c)),
  };
}
