// Page rendez-vous/ (docs/rendez-vous.md, lot 2 ; maquettes « Rendez-vous » 4 et 7), ouverte depuis les liens des e-mails :
//  - #c=<jeton> : suivi de l'automobiliste (état, frise, agenda, itinéraire, appel, annulation, autres garages, déclarer le prix payé) ;
//  - #g=<jeton> : réponse du garage sans connexion (accepter, refuser avec un motif), jusqu'à l'heure limite ;
//  - ?garage=<identifiant> : lien de réservation directe du garage (Mon garage › Horaires), à mettre sur son site ou ses réseaux : le
//    garage, les prestations qu'il prend en ligne, puis la fenêtre « Prendre rendez-vous » du comparateur (rdv-book), chargée au clic.
// Le jeton reste dans le fragment de l'adresse : ni GitHub Pages ni l'en-tête Referer ne le voient. Il part à l'API dans l'en-tête
// x-rdv-token, jamais dans le chemin. L'identifiant du garage, lui, est public. Que du TEXTE écrit dans la page.
import { CLIENT_CANCEL_REASONS, DECLINE_REASONS, icsCalendar } from "./shared/rdv.js";
import { serviceLabel } from "./shared/pro-prices.js";

const $ = (id) => document.getElementById(id);
const API = (document.querySelector('meta[name="pixcar-api"]') || {}).content || "";
const LAST = "jg.last.v1"; // dernière recherche du comparateur (prestation choisie) : « Déclarer mon prix » et « autres garages » y renvoient

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return n;
}
const icon = (name) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "ic");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
};

const m = /^#([cg])=([A-Za-z0-9_-]{43})$/.exec(location.hash);
// ?garage= : même forme d'identifiant que l'API (lieu Overture ou garage d'essai)
const bookFor = m ? "" : (new URLSearchParams(location.search).get("garage") || "").trim().toLowerCase();
const kind = m ? (m[1] === "c" ? "client" : "garage") : bookFor ? "book" : "";
const token = m ? m[2] : "";
const GARAGE_RE = /^[0-9a-f-]{8,40}$/;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, { method, headers: { "x-rdv-token": token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    throw Object.assign(new Error("Le service ne répond pas. Vérifiez votre connexion et réessayez."), { status: 0 });
  }
  const out = await res.json().catch(() => null);
  if (res.ok) return out;
  const e = (out && out.error) || {};
  throw Object.assign(new Error(e.message || "Le service ne répond pas. Réessayez dans un instant."), { status: res.status, code: e.code || "" });
}
function alertBox(message, info = false) {
  const a = $("rvAlert");
  a.textContent = message || "";
  a.dataset.kind = info ? "info" : "error";
  a.hidden = !message;
}
function gone(text, title = "") {
  $("rvLoading").hidden = true;
  $("rvView").hidden = true;
  $("rvGone").hidden = false;
  if (title) $("rvGoneTitle").textContent = title;
  if (text) $("rvGoneText").textContent = text;
  $("rvGoneTitle").focus();
}
const svcText = (v) => v.services.map((s) => s.label).join(" + ");
const whenText = (w) => (w.mode === "drop" ? `${w.label} (dépôt entre ${w.start} et ${w.until}, voiture rendue vers ${w.end})` : w.back ? `${w.label} (voiture rendue vers ${w.back})` : w.label);
function show(status, tone, title, lead) {
  $("rvLoading").hidden = true;
  $("rvGone").hidden = true;
  $("rvView").hidden = false;
  $("rvStatus").replaceChildren(el("span", { class: `pill ${tone}`, text: status }));
  $("rvTitle").textContent = title;
  $("rvLead").textContent = lead;
}
// frise : [libellé, détail, fait ?]
function steps(list) {
  $("rvSteps").replaceChildren(...list.map(([label, detail, state]) => el("li", { class: state }, el("b", { text: label }), detail ? el("span", { text: detail }) : null)));
}

// ================================================================ automobiliste
const STATUS = {
  pending: ["En attente du garage", "due"],
  confirmed: ["Confirmé", "ok"],
  declined: ["Refusé", "off"],
  expired: ["Sans réponse", "off"],
  cancelled: ["Annulé", "off"],
};
// étape de l'intervention montrée au client : reçue, travaux (en cours, en attente de pièces, en attente), prête, restituée
const PROGRESS = { received: 0, in_progress: 1, waiting_parts: 1, suspended: 1, done: 2, returned: 3 };
function client(v) {
  if ($("rvCancel")) $("rvCancel").remove();
  const past = v.past === true;
  const by = v.cancelledBy;
  const [label, tone] = v.status === "confirmed" && past ? ["Passé", "off"] : STATUS[v.status] || ["", "off"];
  const titles = {
    pending: ["Demande envoyée", `${v.garage.name} répond au plus tard le ${v.deadlineText}. Sa réponse arrive par e-mail à ${v.email}.`],
    confirmed: past ? ["Rendez-vous passé", `Votre rendez-vous chez ${v.garage.name}.`] : ["Rendez-vous confirmé", `${v.garage.name} vous attend.`],
    declined: [`${v.garage.name} ne peut pas vous recevoir`, v.reasonText ? `Motif : ${v.reasonText.toLowerCase()}${v.note ? ` — « ${v.note} »` : ""}.` : ""],
    expired: ["Pas de réponse du garage", `${v.garage.name} n'a pas répondu avant l'heure limite : la demande est annulée.`],
    cancelled:
      by === "client"
        ? ["Rendez-vous annulé", "Vous avez annulé ; le garage est prévenu."]
        : by === "closure"
          ? ["Rendez-vous annulé", `${v.garage.name} sera fermé ce jour-là.`]
          : [`Annulé par ${v.garage.name}`, v.reasonText ? `Motif : ${v.reasonText.toLowerCase()}${v.note ? ` — « ${v.note} »` : ""}.` : ""],
  };
  let [title, lead] = titles[v.status] || ["Votre demande", ""];
  // lot 3c : l'avancement de l'intervention, dès « Voiture reçue »
  const pg = v.status === "confirmed" ? v.progress : null;
  const stage = pg ? PROGRESS[pg.status] : -1;
  if (pg) [title, lead] = stage === 2 ? ["Votre voiture est prête", `Vous pouvez venir la chercher chez ${v.garage.name}.`] : stage === 3 ? ["Voiture restituée", `Merci de votre visite chez ${v.garage.name}.`] : ["Votre voiture est au garage", `${pg.label}, mis à jour le ${pg.atText}.`];
  show(pg ? pg.label : label, pg ? "ok" : tone, title, lead);
  $("rvCard").replaceChildren(
    el("p", { class: "rv-when" }, el("b", { text: whenText(v.when) }), el("span", { text: svcText(v) })),
    el(
      "ul",
      { class: "rq-facts" },
      el("li", {}, icon("garage"), el("span", {}, el("b", { text: v.garage.name }), v.garage.addr ? ` · ${v.garage.addr}` : "")),
      v.garage.phone ? el("li", {}, icon("phone"), el("a", { href: `tel:${v.garage.phone}`, text: v.garage.phoneText || v.garage.phone })) : null,
      el("li", {}, icon("car"), el("span", { text: [v.car.model, v.car.year, v.car.plate].filter(Boolean).join(" · ") })),
    ),
  );
  const decided = v.decidedText ? `le ${v.decidedText}` : "";
  steps([
    ["Demande envoyée", v.sentText ? `le ${v.sentText}` : "", "done"],
    v.status === "pending" ? ["Réponse du garage", `au plus tard le ${v.deadlineText}`, "cur"] : ["Réponse du garage", v.status === "confirmed" ? `acceptée ${decided}` : v.status === "declined" ? `refusée ${decided}` : v.status === "expired" ? "aucune" : decided, v.status === "confirmed" ? "done" : "off"],
    ["Rendez-vous", v.when.label, v.status === "confirmed" ? (past || pg ? "done" : "cur") : "off"],
    ...(pg ? ["Voiture reçue", stage === 1 ? pg.label : "Travaux", "Prête", "Restituée"].map((s, i) => [s, i === stage ? `le ${pg.atText}` : "", i < stage || stage === 3 ? "done" : i === stage ? "cur" : "off"]) : []),
  ]);
  const acts = [];
  if (v.status === "confirmed" && !past) {
    if (!pg) acts.push(el("button", { type: "button", class: "btn primary small", onclick: () => ics(v) }, icon("download"), "Ajouter à mon agenda"));
    const dest = Number.isFinite(v.garage.lat) ? `${v.garage.lat},${v.garage.lon}` : v.garage.addr || v.garage.name;
    acts.push(el("a", { class: "btn small", href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`, target: "_blank", rel: "noopener" }, icon("pin"), "Itinéraire"));
  }
  if (v.garage.phone && ["pending", "confirmed"].includes(v.status) && !past) acts.push(el("a", { class: "btn small", href: `tel:${v.garage.phone}` }, icon("phone"), "Appeler le garage"));
  if (v.status === "confirmed" && past) acts.push(el("a", { class: "btn primary small", href: "../", onclick: () => remember(v) }, icon("tag"), "Déclarer le prix payé"));
  if (v.canCancel) acts.push(el("button", { type: "button", class: "btn small danger", "aria-expanded": "false", "aria-controls": "rvCancel", onclick: (e) => cancelForm(v, e.currentTarget) }, v.status === "pending" ? "Annuler ma demande" : "Annuler ce rendez-vous"));
  $("rvActs").replaceChildren(...acts);
  const more = [];
  if (v.alternatives && v.alternatives.length)
    more.push(
      el(
        "section",
        { class: "rv-alt", "aria-labelledby": "rvAltTitle" },
        el("h2", { id: "rvAltTitle", text: "D'autres garages proches prennent cette prestation en ligne" }),
        el("ul", {}, ...v.alternatives.map((a) => el("li", {}, el("b", { text: a.name }), el("span", { text: [a.city, a.km].filter(Boolean).join(" · ") }), el("span", { class: "rv-first", text: a.first })))),
        el("p", {}, el("a", { class: "btn primary small", href: "../", onclick: () => remember(v) }, "Les comparer sur Pixcar")),
      ),
    );
  $("rvMore").replaceChildren(...more);
}
// la prestation du rendez-vous devient celle de la prochaine visite du comparateur (zone et réglages gardés)
function remember(v) {
  try {
    const last = JSON.parse(localStorage.getItem(LAST) || "null") || {};
    const ids = v.services.map((s) => s.id);
    localStorage.setItem(LAST, JSON.stringify({ ...last, svc: ids[0], svcs: ids }));
  } catch {}
}
function ics(v) {
  const text = icsCalendar([
    {
      uid: `rdv-${Date.parse(v.when.startsAt)}-${v.when.day}@pixcar.fr`,
      start: Date.parse(v.when.startsAt),
      end: Date.parse(v.when.endsAt),
      summary: `${svcText(v)} · ${v.garage.name}`,
      location: v.garage.addr || "",
      description: [v.garage.phoneText, [v.car.model, v.car.year].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
    },
  ]);
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  const a = el("a", { href: url, download: "rendez-vous-pixcar.ics" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function reasonsBox(list, name) {
  return el("fieldset", { class: "rv-reasons" }, el("legend", { text: "Motif" }), ...list.map(([code, label]) => el("label", { class: "choice-line" }, el("input", { type: "radio", name, value: code }), el("span", { text: label }))));
}
function cancelForm(v, opener) {
  if ($("rvCancel")) {
    $("rvCancel").remove();
    opener.setAttribute("aria-expanded", "false");
    return;
  }
  opener.setAttribute("aria-expanded", "true");
  const err = el("p", { class: "field-err", id: "rvCancelErr", role: "alert", hidden: true });
  const form = el(
    "form",
    { class: "rv-form", id: "rvCancel", novalidate: true },
    el("h2", { text: v.status === "pending" ? "Annuler la demande" : "Annuler le rendez-vous" }),
    el("p", { class: "help", text: `${v.garage.name} est prévenu par e-mail. Le motif est facultatif.` }),
    reasonsBox(CLIENT_CANCEL_REASONS, "cancelReason"),
    err,
    el("div", { class: "rv-acts" }, el("button", { type: "submit", class: "btn small danger", id: "rvCancelGo", text: "Confirmer l'annulation" }), el("button", { type: "button", class: "btn small", text: "Ne pas annuler", onclick: () => (form.remove(), opener.setAttribute("aria-expanded", "false"), opener.focus()) })),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const picked = form.querySelector("input:checked");
    const btn = $("rvCancelGo");
    btn.disabled = true;
    try {
      const out = await call("POST", "/v1/rdv/me/cancel", picked ? { reason: picked.value } : {});
      client(out);
      alertBox("C'est annulé : le garage est prévenu par e-mail.", true);
      $("rvTitle").focus();
    } catch (e) {
      btn.disabled = false;
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  opener.closest(".rv-acts").after(form);
  form.querySelector("input").focus();
}

// ================================================================ garage (lien de l'e-mail « Nouvelle demande »)
const DONE = { confirmed: ["Acceptée", "ok"], declined: ["Refusée", "off"], expired: ["Sans réponse", "off"], cancelled: ["Annulée", "off"] };
function garage(v) {
  if ($("rvDecline")) $("rvDecline").remove();
  const c = v.client;
  if (v.open) show("À traiter", "due", "Nouvelle demande de rendez-vous", `Répondez avant le ${v.deadlineText} : sans réponse, la demande est annulée et le client prévenu.`);
  else {
    const [label, tone] = DONE[v.status] || ["Traitée", "off"];
    show(label, tone, v.status === "confirmed" ? "Rendez-vous confirmé" : v.status === "declined" ? "Demande refusée" : v.status === "expired" ? "Demande expirée" : "Demande annulée", v.status === "confirmed" ? `${c.name} a reçu la confirmation par e-mail. Retrouvez vos rendez-vous dans l'Espace Pro.` : "Plus rien à faire ici. Retrouvez vos demandes dans l'Espace Pro.");
  }
  $("rvCard").replaceChildren(
    el("p", { class: "rv-when" }, el("b", { text: whenText(v.when) }), el("span", { text: `${svcText(v)} · ${v.garage.name}` })),
    el(
      "ul",
      { class: "rq-facts" },
      el("li", {}, icon("user"), el("span", {}, el("b", { text: c.name }), " · ", el("a", { href: `tel:${c.phone}`, text: c.phoneText || c.phone }), " · ", el("a", { href: `mailto:${c.email}`, text: c.email }))),
      el("li", {}, icon("car"), el("span", { text: [c.car, c.year, c.plate].filter(Boolean).join(" · ") })),
      el("li", {}, icon("mail"), el("span", { class: v.message ? "" : "muted", text: v.message || "Pas de message" })),
      v.reasonText ? el("li", {}, icon("clock"), el("span", { text: `Motif : ${v.reasonText}${v.note ? ` — « ${v.note} »` : ""}` })) : null,
    ),
  );
  $("rvSteps").replaceChildren();
  $("rvMore").replaceChildren();
  if (!v.open) {
    $("rvActs").replaceChildren(el("a", { class: "btn small", href: "../pro/" }, "Ouvrir l'Espace Pro"));
    return;
  }
  $("rvActs").replaceChildren(
    el("button", { type: "button", class: "btn primary small", id: "rvAccept", onclick: accept }, icon("check"), "Accepter"),
    el("button", { type: "button", class: "btn small", "aria-expanded": "false", "aria-controls": "rvDecline", onclick: (e) => declineForm(e.currentTarget) }, "Refuser"),
    el("a", { class: "btn small", href: `tel:${c.phone}` }, icon("phone"), "Appeler le client"),
  );
}
async function accept() {
  const b = $("rvAccept");
  b.disabled = true;
  try {
    garage(await call("POST", "/v1/rdv/action/accept"));
    alertBox("Rendez-vous confirmé : le client reçoit la confirmation par e-mail, avec un fichier d'agenda.", true);
    $("rvTitle").focus();
  } catch (e) {
    b.disabled = false;
    alertBox(e.message);
    if (e.status === 409) load();
  }
}
function declineForm(opener) {
  if ($("rvDecline")) {
    $("rvDecline").remove();
    opener.setAttribute("aria-expanded", "false");
    return;
  }
  opener.setAttribute("aria-expanded", "true");
  const err = el("p", { class: "field-err", role: "alert", hidden: true });
  const note = el("textarea", { id: "rvNote", maxlength: "300", rows: "3" });
  const form = el(
    "form",
    { class: "rv-form", id: "rvDecline", novalidate: true },
    el("h2", { text: "Refuser la demande" }),
    el("p", { class: "help", text: "Le motif est transmis au client, avec jusqu'à 3 autres garages proches qui prennent cette prestation en ligne." }),
    reasonsBox(DECLINE_REASONS, "declineReason"),
    el("label", { for: "rvNote", text: "Un mot pour le client (facultatif)" }),
    note,
    err,
    el("div", { class: "rv-acts" }, el("button", { type: "submit", class: "btn small danger", id: "rvDeclineGo", text: "Refuser la demande" })),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const picked = form.querySelector("input:checked");
    if (!picked) {
      err.textContent = "Choisissez un motif : il est transmis au client.";
      err.hidden = false;
      return;
    }
    const btn = $("rvDeclineGo");
    btn.disabled = true;
    try {
      garage(await call("POST", "/v1/rdv/action/decline", { reason: picked.value, note: note.value.trim() }));
      alertBox("Demande refusée : le client est prévenu par e-mail, avec votre motif.", true);
      $("rvTitle").focus();
    } catch (e) {
      btn.disabled = false;
      err.textContent = e.message;
      err.hidden = false;
      if (e.status === 409) load();
    }
  });
  opener.closest(".rv-acts").after(form);
  form.querySelector("input").focus();
}

// ================================================================ lien de réservation directe (?garage=…)
// l'API ne donne les prestations en ligne que s'il reste un horaire libre dans les 14 jours : fermé ou complet, même message
const NOT_OPEN = ["Ce garage ne propose pas d'horaire en ligne en ce moment. Retrouvez-le, ou un autre garage près de chez vous, sur le comparateur.", "Pas de rendez-vous en ligne pour l'instant"];
// la fenêtre « Prendre rendez-vous » : script et feuille de style du comparateur, chargés au premier clic, gardés ensuite
let bookLoad = null;
function loadBook() {
  const [js, css] = ((document.querySelector('meta[name="pixcar-rdv-book"]') || {}).content || "").split(" ");
  if (!js || !css) return Promise.reject(new Error("no book"));
  bookLoad =
    bookLoad ||
    Promise.all(
      [
        ["script", { src: js }],
        ["link", { rel: "stylesheet", href: css }],
      ].map(
        ([tag, attrs]) =>
          new Promise((ok, ko) => {
            const n = el(tag, attrs);
            n.addEventListener("load", ok);
            n.addEventListener("error", ko);
            document.head.append(n);
          }),
      ),
    ).catch((e) => {
      bookLoad = null;
      throw e;
    });
  return bookLoad;
}
async function book() {
  if (!GARAGE_RE.test(bookFor)) return gone("Vérifiez l'adresse reçue du garage : elle est peut-être incomplète.", "Ce lien de réservation n'est pas valide");
  const out = await callPublic(`/v1/pro/public/garages?ids=${encodeURIComponent(bookFor)}`);
  const g = (out.garages || []).find((x) => x && x.id === bookFor && x.verified === true);
  const offered = (g && g.rdv && Array.isArray(g.rdv.services) ? g.rdv.services : []).filter((id) => typeof id === "string");
  if (!offered.length) return gone(...NOT_OPEN);
  const auto = new Set((g.rdv.auto || []).filter((id) => typeof id === "string"));
  const profile = g.profile || {};
  let name = typeof profile.name === "string" ? profile.name : "";
  let addr = profile.addr && typeof profile.addr === "object" ? [profile.addr.street, `${profile.addr.pc || ""} ${profile.addr.city || ""}`.trim()].filter(Boolean).join(", ") : "";
  // fiche pas encore relue par Pixcar : le nom et l'adresse que l'API donne avec les horaires
  if (!name) {
    try {
      const t = await callPublic(`/v1/rdv/garages/${encodeURIComponent(bookFor)}/times?services=${encodeURIComponent(offered[0])}`);
      name = (t.garage && t.garage.name) || "";
      addr = addr || (t.garage && t.garage.addr) || "";
    } catch (e) {
      if (e.status === 404) return gone(...NOT_OPEN);
    }
  }
  name = name || "Ce garage";
  document.title = `Prendre rendez-vous · ${name} · Pixcar`;
  $("rvPersonal").hidden = true;
  show("Rendez-vous en ligne", "ok", "Prendre rendez-vous", addr ? `${name}, ${addr}` : name);
  const boxes = offered.map((id, i) =>
    el("label", { class: "chip" }, el("input", { type: "checkbox", name: "rvSvc", value: id, checked: offered.length === 1 || i === 0 }), el("span", { text: serviceLabel(id) })),
  );
  const err = el("p", { class: "field-err", id: "rvSvcErr", role: "alert", hidden: true });
  const note = el("p", { class: "help", id: "rvSvcHelp" });
  const picked = () => boxes.map((b) => b.querySelector("input")).filter((x) => x.checked).map((x) => x.value);
  const sayAuto = () => {
    const ids = picked();
    note.textContent =
      ids.length && ids.every((id) => auto.has(id))
        ? "Confirmation immédiate : le garage confirme ces prestations dès votre demande envoyée."
        : "Vous choisissez un horaire libre ; le garage confirme votre demande par e-mail.";
  };
  $("rvCard").replaceChildren(
    el(
      "fieldset",
      { class: "rv-svc", "aria-describedby": "rvSvcHelp" },
      el("legend", { text: offered.length > 1 ? "Les prestations à faire" : "La prestation" }),
      el("div", { class: "rv-chips" }, ...boxes),
      err,
    ),
    note,
  );
  sayAuto();
  $("rvCard").addEventListener("change", () => {
    err.hidden = true;
    sayAuto();
  });
  const go = el("button", { type: "button", class: "btn primary", id: "rvBook" }, icon("calendar"), "Choisir un horaire");
  go.addEventListener("click", async () => {
    const ids = picked();
    if (!ids.length) {
      err.textContent = "Choisissez au moins une prestation.";
      err.hidden = false;
      boxes[0].querySelector("input").focus();
      return;
    }
    go.disabled = true;
    try {
      await loadBook();
      window.PixcarRdv.open({ base: API, garage: { id: bookFor, name }, services: ids, opener: go, root: new URL("../", location.href).href });
    } catch {
      alertBox("La prise de rendez-vous ne répond pas. Réessayez dans un instant.");
    } finally {
      go.disabled = false;
    }
  });
  const acts = [go];
  if (typeof profile.phone === "string" && /^\+\d{6,15}$/.test(profile.phone)) acts.push(el("a", { class: "btn", href: `tel:${profile.phone}` }, icon("phone"), "Appeler le garage"));
  $("rvActs").replaceChildren(...acts);
  $("rvMore").replaceChildren(el("p", { class: "help rv-via", text: "Pixcar transmet votre demande au garage, qui la confirme ; vous suivez tout par e-mail et sur cette page." }));
  $("rvTitle").focus();
}
// lectures publiques (sans jeton)
async function callPublic(path) {
  let res;
  try {
    res = await fetch(API + path, { headers: { accept: "application/json" }, referrerPolicy: "no-referrer" });
  } catch {
    throw Object.assign(new Error("Le service ne répond pas. Vérifiez votre connexion et réessayez."), { status: 0 });
  }
  const out = await res.json().catch(() => null);
  if (res.ok) return out || {};
  const e = (out && out.error) || {};
  throw Object.assign(new Error(e.message || "Le service ne répond pas. Réessayez dans un instant."), { status: res.status, code: e.code || "" });
}

// ================================================================ entrée
async function load() {
  if (kind === "book") {
    try {
      return await book();
    } catch (e) {
      if (e.status === 404) return gone("Les rendez-vous en ligne ne sont pas ouverts pour l'instant.", NOT_OPEN[1]);
      $("rvLoading").hidden = true;
      return alertBox(e.message);
    }
  }
  if (!kind) return gone("Ouvrez cette page depuis le lien reçu par e-mail.");
  try {
    const v = await call("GET", kind === "client" ? "/v1/rdv/me" : "/v1/rdv/action");
    kind === "client" ? client(v) : garage(v);
  } catch (e) {
    if (e.status === 404) return gone(e.code === "rdv_disabled" ? "Les rendez-vous en ligne ne sont pas ouverts pour l'instant." : "");
    $("rvLoading").hidden = true;
    alertBox(e.message);
  }
}
document.title = kind === "garage" ? "Demande de rendez-vous · Pixcar" : kind === "book" ? "Prendre rendez-vous · Pixcar" : "Votre rendez-vous · Pixcar";
window.addEventListener("hashchange", () => location.reload());
load();
