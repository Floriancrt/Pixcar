// Rendez-vous en ligne, côté automobiliste (docs/rendez-vous.md, lot 2 ; maquettes « Rendez-vous » 2 à 4) : la fenêtre ouverte depuis la
// fiche d'un garage. Script à part (assets/rdv-book.<empreinte>.js, avec sa feuille de style), chargé au premier clic sur « Choisir un
// horaire » : le comparateur n'en porte que le bouton. Étapes : horaire → coordonnées → code reçu par e-mail → demande envoyée (lien de
// suivi). Rien ne part au garage avant le bon code ; un horaire pris entre-temps se rechoisit avec le même code. Calendrier avancé du
// garage (docs/calendrier-avance.md) : type de véhicule demandé d'abord quand la durée en dépend, heure de restitution prévue, et
// confirmation immédiate quand les prestations y sont ouvertes.
// Que du TEXTE écrit dans la page (textContent), jamais de HTML venu de l'API.
import { MODEL_MAX, MODEL_MIN, PLATE_RE, YEAR_MIN } from "./shared/rules.js";

const VEHICLES = "jg.vehicles.v1"; // mémoire du véhicule du comparateur (modules/repair-store.js) : lue ici, jamais écrite
const MESSAGE_MAX = 500;
const STEPS = ["Horaire", "Coordonnées", "Code"];
const NET = "Le service ne répond pas. Vérifiez votre connexion et réessayez.";

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
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const tl = (t) => String(t).replace(/^0(\d)/, "$1"); // « 08:00 » (API) → « 8:00 »

let st = null; // { base, garage, services, opener, times, day, pick, draft, change, form, vehicle }
let dlg = null;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(st.base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error(NET), { status: 0, data: {} });
  }
  const out = await res.json().catch(() => null);
  if (res.ok) return out;
  const e = (out && out.error) || {};
  throw Object.assign(new Error(e.message || NET), { status: res.status, code: e.code || "", data: e });
}

function shell() {
  dlg = el("dialog", { class: "dlg rdv-dlg", "aria-labelledby": "rbTitle" });
  dlg.append(
    el(
      "div",
      { class: "rb-in" },
      el("div", { class: "dlg-head" }, el("h2", { id: "rbTitle", text: "Prendre rendez-vous" }), el("button", { type: "button", class: "dlg-close", "aria-label": "Fermer", text: "×", onclick: () => dlg.close() })),
      el("p", { class: "rb-garage", id: "rbGarage" }),
      el("ol", { class: "rb-steps", id: "rbSteps", "aria-label": "Étapes" }, ...STEPS.map((s, i) => el("li", {}, el("span", { "aria-hidden": "true", text: String(i + 1) }), s))),
      el("div", { class: "rb-body", id: "rbBody" }),
    ),
  );
  dlg.addEventListener("close", () => {
    document.documentElement.classList.remove("dlg-open");
    if (st && st.opener && st.opener.isConnected) st.opener.focus();
  });
  document.body.append(dlg);
}

// étape courante (0 à 2 ; 3 : envoyée, sans frise) et son contenu ; le titre de l'étape prend le focus
function step(n, title, ...content) {
  const items = dlg.querySelectorAll("#rbSteps li");
  dlg.querySelector("#rbSteps").hidden = n > 2;
  items.forEach((li, i) => {
    li.className = i < n ? "done" : i === n ? "cur" : "";
    if (i === n) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  const h = el("h3", { class: "rb-h", tabindex: "-1", text: title });
  dlg.querySelector("#rbBody").replaceChildren(h, ...content.filter(Boolean));
  h.focus();
}
const errBox = (id) => el("p", { class: "err-msg", id, role: "alert", hidden: true });
function say(id, message) {
  const b = dlg.querySelector("#" + id);
  if (!b) return;
  b.textContent = message || "";
  b.hidden = !message;
}

// ================================================================ 1. horaire
async function loadTimes() {
  step(0, "Choisissez un horaire", el("p", { class: "hint", text: "Recherche des horaires libres…" }));
  try {
    st.times = await call("GET", `/v1/rdv/garages/${encodeURIComponent(st.garage.id)}/times?services=${st.services.map(encodeURIComponent).join(",")}${st.vehicle ? `&vehicle=${encodeURIComponent(st.vehicle)}` : ""}`);
  } catch (e) {
    step(0, "Choisissez un horaire", el("p", { class: "dlg-note warn", text: e.status === 404 ? "Ce garage ne prend plus de rendez-vous en ligne pour cette prestation. Appelez-le pour convenir d'un horaire." : e.message }), actions(el("button", { type: "button", class: "btn", text: "Fermer", onclick: () => dlg.close() })));
    return;
  }
  dlg.querySelector("#rbGarage").textContent = `${st.garage.name} · ${st.times.services.map((s) => s.label).join(" + ")}`;
  if (st.times.needVehicle) return vehicleStep();
  st.day = (st.times.days[0] || {}).day || "";
  renderTimes();
}
// la durée dépend du véhicule : on le demande avant de chercher les horaires
function vehicleStep() {
  step(
    0,
    "Quel est votre véhicule ?",
    el("p", { class: "hint", text: "La durée de l'intervention en dépend : les horaires proposés en tiennent compte." }),
    el(
      "div",
      { class: "rb-vehicles", role: "group", "aria-label": "Type de véhicule" },
      ...st.times.vehicles.map((v) => el("button", { type: "button", class: "rb-time rb-vehicle", "data-vehicle": v.id, "aria-pressed": String(st.vehicle === v.id), onclick: () => ((st.vehicle = v.id), (st.pick = null), loadTimes()) }, el("b", { text: v.label }))),
    ),
  );
}
const vehicleLabel = () => ((st.times.vehicles || []).find((v) => v.id === st.vehicle) || {}).label || "";
function renderTimes(message = "") {
  if (!st.times.days.length) {
    step(0, "Choisissez un horaire", el("p", { class: "dlg-note warn", text: "Plus aucun horaire libre dans les semaines à venir. Appelez le garage pour convenir d'un rendez-vous." }), actions(el("button", { type: "button", class: "btn", text: "Fermer", onclick: () => dlg.close() })));
    return;
  }
  step(
    0,
    "Choisissez un horaire",
    message ? el("p", { class: "dlg-note warn", role: "alert", text: message }) : null,
    st.vehicle ? el("p", { class: "rb-links" }, `Véhicule : ${vehicleLabel()} · `, el("button", { type: "button", class: "link-btn", text: "changer", onclick: () => ((st.vehicle = ""), (st.pick = null), loadTimes()) })) : null,
    el("div", { id: "rbPick" }),
    el("p", { class: "hint", text: st.times.auto ? "Confirmation immédiate : ce garage confirme ces prestations dès votre demande envoyée." : `Le garage répond au plus tard le ${st.times.deadlineText}. Vous recevez sa réponse par e-mail.` }),
    actions(el("button", { type: "button", class: "btn dark", id: "rbGo", text: st.change ? "Envoyer avec cet horaire" : "Continuer", onclick: () => (st.change ? codeStep(true) : contactStep()) })),
  );
  paintTimes();
}
// jours et horaires seuls : le focus reste sur le bouton touché
function paintTimes(focus = "") {
  const days = st.times.days;
  if (!days.some((d) => d.day === st.day)) st.day = days[0].day;
  const day = days.find((d) => d.day === st.day);
  if (st.pick && !days.some((d) => d.day === st.pick.day && d.times.some((t) => t.t === st.pick.t))) st.pick = null;
  dlg.querySelector("#rbPick").replaceChildren(
    el(
      "div",
      { class: "rb-days", role: "group", "aria-label": "Jours" },
      ...days.map((d) => el("button", { type: "button", class: "rb-day", "data-day": d.day, "aria-pressed": String(d.day === st.day), onclick: () => ((st.day = d.day), paintTimes(`.rb-day[data-day="${d.day}"]`)) }, el("b", { text: d.label }), el("small", { text: plural(d.times.length, "horaire") }))),
    ),
    el(
      "div",
      { class: "rb-times", role: "group", "aria-label": `Horaires, ${day.label}` },
      ...day.times.map((t) =>
        el(
          "button",
          { type: "button", class: "rb-time" + (t.drop ? " drop" : ""), "data-t": t.t, "aria-pressed": String(!!st.pick && st.pick.day === day.day && st.pick.t === t.t), onclick: () => ((st.pick = { day: day.day, label: day.label, ...t }), paintTimes(`.rb-time[data-t="${t.t}"]`)) },
          el("b", { text: t.drop ? `Dépôt ${tl(t.t)}–${tl(t.until)}` : tl(t.t) }),
          t.end ? el("small", { text: `rendue vers ${tl(t.end)}` }) : null,
        ),
      ),
    ),
    ...(day.times.some((t) => t.drop) ? [el("p", { class: "hint", text: "Dépôt : vous laissez la voiture pendant ce créneau d'arrivée ; le garage la rend vers l'heure indiquée." })] : []),
  );
  dlg.querySelector("#rbGo").disabled = !st.pick;
  if (focus) dlg.querySelector(focus).focus();
}
const actions = (...btns) => el("div", { class: "dlg-actions" }, ...btns);

// ================================================================ 2. coordonnées
function vehicle() {
  try {
    const v = JSON.parse(localStorage.getItem(VEHICLES) || "null");
    return Array.isArray(v) && v[0] && typeof v[0].model === "string" ? v[0] : null;
  } catch {
    return null;
  }
}
function field(id, label, input, hint = "") {
  input.id = id;
  input.setAttribute("aria-describedby", `${id}Err${hint ? ` ${id}Hint` : ""}`);
  return el("div", { class: "field" }, el("label", { for: id }, ...(Array.isArray(label) ? label : [label])), input, hint ? el("p", { class: "hint", id: id + "Hint", text: hint }) : null, errBox(id + "Err"));
}
const opt = (text) => [text, " ", el("span", { class: "opt", text: "facultatif" })];
function contactStep() {
  const f = st.form || {};
  const v = vehicle() || {};
  const thisYear = new Date().getFullYear();
  const input = (attrs, value) => {
    const i = el("input", attrs);
    i.value = value || "";
    return i;
  };
  const form = el(
    "form",
    {
      class: "rb-form",
      novalidate: true,
      "data-cs-mask": true,
      onsubmit: sendContact,
      // une saisie corrigée efface l'erreur de son champ
      oninput: (e) => {
        if (e.target.getAttribute("aria-invalid") !== "true") return;
        e.target.removeAttribute("aria-invalid");
        say(e.target.id + "Err", "");
      },
    },
    field("rbName", "Nom et prénom", input({ type: "text", autocomplete: "name", maxlength: "80" }, f.name)),
    field("rbEmail", "E-mail", input({ type: "email", autocomplete: "email", maxlength: "254", spellcheck: "false" }, f.email), "Le code et la réponse du garage arrivent à cette adresse."),
    field("rbPhone", "Téléphone", input({ type: "tel", autocomplete: "tel", maxlength: "20" }, f.phone), "Pour que le garage puisse vous joindre."),
    el(
      "div",
      { class: "row2" },
      field("rbCar", "Votre voiture", input({ type: "text", maxlength: String(MODEL_MAX), placeholder: "Ex. Peugeot 208", autocomplete: "off" }, f.car || v.model)),
      field("rbYear", "Année du modèle", input({ type: "text", inputmode: "numeric", maxlength: "4", placeholder: String(thisYear - 6), autocomplete: "off" }, f.year || (v.year ? String(v.year) : ""))),
    ),
    field("rbPlate", opt("Immatriculation"), input({ type: "text", class: "plate-in", maxlength: "9", placeholder: "AB-123-CD", autocomplete: "off", spellcheck: "false" }, f.plate || v.plate)),
    field("rbMsg", opt("Message au garage"), Object.assign(el("textarea", { maxlength: String(MESSAGE_MAX), rows: "3", placeholder: "Ex. un bruit au freinage" }), { value: f.message || "" })),
    el("label", { class: "rb-check" }, Object.assign(el("input", { type: "checkbox", id: "rbRemind" }), { checked: !!f.remindPrice }), el("span", { text: "Le lendemain du rendez-vous, m'inviter par e-mail à déclarer le prix payé (une fois)." })),
    el("div", { class: "rb-trap", "aria-hidden": "true" }, el("label", { text: "Site web " }, el("input", { type: "text", name: "website", id: "rbWebsite", tabindex: "-1", autocomplete: "off" }))),
    el("p", { class: "dlg-note" }, `Vos coordonnées vont au seul ${st.garage.name}, pour ce rendez-vous ; elles sont effacées 30 jours après. `, el("button", { type: "button", class: "link-btn", "data-open-legal": true, text: "Comment Pixcar traite vos données" })),
    errBox("rbFormErr"),
    actions(el("button", { type: "button", class: "btn", text: "Retour", onclick: () => renderTimes() }), el("button", { type: "submit", class: "btn dark", id: "rbSend", text: "Recevoir le code" })),
  );
  step(1, `${st.pick.label}, ${st.pick.drop ? `dépôt ${tl(st.pick.t)}–${tl(st.pick.until)}` : tl(st.pick.t)}`, el("p", { class: "hint", text: "Vos coordonnées, pour que le garage vous confirme le rendez-vous." }), form);
}
function readForm() {
  const val = (id) => dlg.querySelector("#" + id).value.trim();
  return {
    name: val("rbName"),
    email: val("rbEmail"),
    phone: val("rbPhone"),
    car: val("rbCar"),
    year: val("rbYear"),
    plate: val("rbPlate").toUpperCase(),
    message: val("rbMsg"),
    remindPrice: dlg.querySelector("#rbRemind").checked,
    website: dlg.querySelector("#rbWebsite").value,
  };
}
const FIELDS = { name: "rbName", email: "rbEmail", phone: "rbPhone", car: "rbCar", year: "rbYear", plate: "rbPlate", message: "rbMsg" };
function fieldErr(key, message) {
  const id = FIELDS[key];
  if (!id) return say("rbFormErr", message);
  say(id + "Err", message);
  const i = dlg.querySelector("#" + id);
  i.setAttribute("aria-invalid", "true");
  i.focus();
}
function check(f) {
  const thisYear = new Date().getFullYear();
  const y = Number(f.year);
  if (f.name.length < 2) return ["name", "Indiquez votre nom."];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return ["email", "Adresse e-mail invalide."];
  if (f.phone.replace(/\D/g, "").length < 9) return ["phone", "Un numéro de téléphone, par exemple 06 12 34 56 78."];
  if (f.car.length < MODEL_MIN) return ["car", "Indiquez votre voiture, par exemple Peugeot 208."];
  if (!/^\d{4}$/.test(f.year) || y < YEAR_MIN || y > thisYear + 1) return ["year", `Année du modèle : de ${YEAR_MIN} à ${thisYear + 1}.`];
  if (f.plate && !PLATE_RE.test(f.plate)) return ["plate", "Format AB-123-CD, ou laissez vide."];
  return null;
}
async function sendContact(ev) {
  ev.preventDefault();
  for (const i of dlg.querySelectorAll(".rb-form [aria-invalid]")) i.removeAttribute("aria-invalid");
  for (const b of dlg.querySelectorAll(".rb-form .err-msg")) b.hidden = true;
  const f = (st.form = readForm());
  const bad = check(f);
  if (bad) return fieldErr(...bad);
  const btn = dlg.querySelector("#rbSend");
  btn.disabled = true;
  btn.textContent = "Envoi du code…";
  try {
    st.draft = await call("POST", "/v1/rdv/requests", {
      garageId: st.garage.id,
      services: st.services.map((id) => ({ id, qty: 1 })),
      day: st.pick.day,
      time: st.pick.t,
      ...(st.pick.drop ? { drop: true } : {}),
      ...(st.vehicle ? { vehicle: st.vehicle } : {}),
      name: f.name,
      email: f.email,
      phone: f.phone,
      car: f.car,
      year: Number(f.year),
      plate: f.plate,
      message: f.message,
      remindPrice: f.remindPrice,
      website: f.website,
    });
    st.change = false;
    codeStep(false);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Recevoir le code";
    if (e.status === 422 && e.data.field) return fieldErr(e.data.field, e.message);
    say("rbFormErr", e.message);
  }
}

// ================================================================ 3. code
let tick = null;
function codeStep(submitNow) {
  const d = st.draft;
  const code = el("input", { type: "text", id: "rbCode", class: "rb-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", spellcheck: "false", "aria-describedby": "rbCodeHelp rbCodeErr" });
  if (st.code) code.value = st.code;
  code.addEventListener("input", () => (code.value = code.value.replace(/[^\d\s]/g, "")));
  const resend = el("button", { type: "button", class: "link-btn", id: "rbResend", onclick: resendCode });
  const form = el(
    "form",
    { class: "rb-form", novalidate: true, onsubmit: sendCode },
    el("div", { class: "field" }, el("label", { for: "rbCode", text: "Code à 6 chiffres" }), code, el("p", { class: "hint", id: "rbCodeHelp" }, "Envoyé à ", el("b", { text: d.email }), `. Valable ${Math.round(d.expiresInSeconds / 60)} minutes. Rien ne part au garage avant ce code.`), errBox("rbCodeErr")),
    actions(el("button", { type: "submit", class: "btn dark", id: "rbCheck", text: "Envoyer la demande" })),
    el("p", { class: "rb-links" }, resend, el("span", { "aria-hidden": "true", text: " · " }), el("button", { type: "button", class: "link-btn", text: "Modifier mes coordonnées", onclick: () => (stopTick(), (st.code = ""), contactStep()) })),
  );
  step(2, "Saisissez le code reçu par e-mail", form);
  countdown(d.resendInSeconds);
  code.focus();
  if (submitNow) form.requestSubmit();
}
function stopTick() {
  clearInterval(tick);
  tick = null;
}
function countdown(seconds) {
  stopTick();
  let left = seconds;
  const b = dlg.querySelector("#rbResend");
  const paint = () => {
    const out = !st.draft.resendsLeft;
    b.disabled = left > 0 || out;
    b.textContent = out ? "Plus de nouvel envoi possible" : left > 0 ? `Renvoyer le code (${left} s)` : "Renvoyer le code";
  };
  paint();
  if (left > 0)
    tick = setInterval(() => {
      left--;
      if (!b.isConnected) return stopTick();
      paint();
      if (left <= 0) stopTick();
    }, 1000);
}
async function resendCode() {
  say("rbCodeErr", "");
  try {
    st.draft = { ...st.draft, ...(await call("POST", `/v1/rdv/requests/${encodeURIComponent(st.draft.id)}/resend`)) };
    countdown(st.draft.resendInSeconds);
    say("rbCodeErr", "");
    dlg.querySelector("#rbCodeHelp").firstChild.textContent = "Nouveau code envoyé à ";
  } catch (e) {
    say("rbCodeErr", e.message);
    if (e.data && e.data.retryAfter) countdown(e.data.retryAfter);
  }
}
async function sendCode(ev) {
  ev.preventDefault();
  const input = dlg.querySelector("#rbCode");
  const code = input.value.replace(/\D/g, "");
  if (code.length !== 6) {
    input.setAttribute("aria-invalid", "true");
    return say("rbCodeErr", "Le code compte 6 chiffres.");
  }
  input.removeAttribute("aria-invalid");
  const btn = dlg.querySelector("#rbCheck");
  btn.disabled = true;
  btn.textContent = "Envoi…";
  try {
    const out = await call("POST", `/v1/rdv/requests/${encodeURIComponent(st.draft.id)}/code`, { code, ...(st.change ? { day: st.pick.day, time: st.pick.t, ...(st.pick.drop ? { drop: true } : {}) } : {}) });
    stopTick();
    done(out);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Envoyer la demande";
    if (e.code === "time_taken") {
      // l'horaire est parti entre-temps : on en choisit un autre, le code reste valable
      stopTick();
      st.code = code;
      st.change = true;
      st.times = { ...st.times, days: e.data.days || [] };
      st.pick = null;
      return renderTimes(e.message);
    }
    input.setAttribute("aria-invalid", "true");
    say("rbCodeErr", e.message);
    input.focus();
  }
}

// ================================================================ envoyée
function done(v) {
  const link = new URL(`rendez-vous/#c=${v.token}`, st.root || document.baseURI).href;
  st.code = "";
  const ok = v.status === "confirmed";
  const back = v.when.back || (v.when.mode === "drop" ? v.when.end : "");
  step(
    3,
    ok ? "Rendez-vous confirmé" : "Demande envoyée",
    el(
      "div",
      { class: "rb-done" },
      el("p", { class: "rb-when" }, el("b", { text: v.when.label }), el("span", { text: v.services.map((s) => s.label).join(" + ") + (back ? ` · voiture rendue vers ${tl(back)}` : "") })),
      ok
        ? el("p", { text: `${st.garage.name} a confirmé votre rendez-vous. La confirmation et le fichier d'agenda arrivent par e-mail à ${v.email}, avec le lien de suivi.` })
        : el("p", { text: `${st.garage.name} répond au plus tard le ${v.deadlineText}. Sa réponse arrive par e-mail à ${v.email}, avec le lien de suivi.` }),
      ok ? null : el("p", { class: "hint", text: "Sans réponse à l'heure dite, la demande est annulée et vous êtes prévenu par e-mail." }),
    ),
    actions(el("a", { class: "btn", href: link, text: ok ? "Voir mon rendez-vous" : "Suivre ma demande" }), el("button", { type: "button", class: "btn dark", text: "Fermer", onclick: () => dlg.close() })),
  );
}

// ================================================================ entrée
// root : la racine du site quand la fenêtre s'ouvre ailleurs qu'à l'accueil (lien de réservation directe, rendez-vous/?garage=…)
function open({ base, garage, services, opener, root = "" }) {
  if (!dlg) shell();
  stopTick();
  st = { base, garage, services, opener, root, times: null, day: "", pick: null, draft: null, change: false, form: null, code: "", vehicle: "" };
  dlg.querySelector("#rbTitle").textContent = "Prendre rendez-vous";
  dlg.querySelector("#rbGarage").textContent = garage.name;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  document.documentElement.classList.add("dlg-open");
  loadTimes();
}

window.PixcarRdv = { open };
