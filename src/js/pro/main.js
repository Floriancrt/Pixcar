// Espace Pro (pro/index.html) : connexion sans mot de passe, puis rattachement d'un garage en quatre étapes (SIRET, la personne, le code,
// les premiers prix). Les écrans sont dans le HTML ; ce script ne fait que les montrer et y écrire du TEXTE (jamais de HTML venu d'ailleurs).
import { createCognito, explain } from "./cognito.js";
import { createProApi } from "./api.js";

const $ = (id) => document.getElementById(id);
const meta = document.querySelector('meta[name="pixcar-pro"]');
const apiBase = (document.querySelector('meta[name="pixcar-api"]').content || "").replace(/\/+$/, "");
const auth = createCognito({ userPoolId: meta.content, clientId: meta.dataset.client });
const api = createProApi({ base: apiBase, token: () => auth.accessToken() });

const STEPS = { garage: "garage", you: "you", verify: "verify", code: "verify", done: "done", manual: "garage" };
const state = { mode: "login", email: "", flow: "signin", session: null, siret: "", establishment: null, garages: [], garage: null, holder: null, claim: null };
let ticker = null;

// ---- petits outils d'affichage
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
const icon = (id) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "ic");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#" + id);
  s.append(u);
  return s;
};

function alertBox(message, kind = "error") {
  const a = $("alert");
  a.textContent = message || "";
  a.dataset.kind = kind;
  a.hidden = !message;
}
function fieldError(input, errId, message) {
  const err = $(errId);
  err.textContent = message || "";
  err.hidden = !message;
  if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  if (message && input) input.focus();
}
async function busy(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function show(screen, { focus = true } = {}) {
  for (const s of document.querySelectorAll("[data-screen]")) s.hidden = s.dataset.screen !== screen;
  const step = STEPS[screen];
  const steps = $("steps");
  steps.hidden = !step;
  if (step) {
    const order = ["garage", "you", "verify", "done"];
    for (const li of steps.children) {
      const i = order.indexOf(li.dataset.step), cur = order.indexOf(step);
      li.className = i < cur ? "done" : i === cur ? "current" : "";
      if (i === cur) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    }
  }
  $("account").hidden = !auth.signedIn;
  $("accountEmail").textContent = auth.email;
  if (screen !== "code") stopTicker();
  if (focus) {
    const h = document.querySelector(`[data-screen="${screen}"] h1:not([hidden])`);
    if (h) h.focus();
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const n of document.querySelectorAll("[data-when]")) n.hidden = n.dataset.when !== mode;
}

// Erreur de l'API → message ; renvoie true si la session est perdue (retour à la connexion)
function apiProblem(e) {
  if (e.status === 401) {
    auth.forget();
    setMode("login");
    show("login");
    alertBox("Votre session a expiré. Reconnectez-vous.");
    return true;
  }
  alertBox(e.message);
  return false;
}

// ---- connexion
async function submitLogin(ev) {
  ev.preventDefault();
  alertBox("");
  const input = $("email");
  const email = input.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fieldError(input, "emailErr", "Adresse e-mail invalide.");
  fieldError(input, "emailErr", "");
  await busy($("loginBtn"), async () => {
    try {
      state.email = email;
      if (state.mode === "signup") {
        try {
          await auth.startSignUp(email);
          state.flow = "signup";
          state.session = null;
        } catch (e) {
          if (e.code !== "UsernameExistsException") throw e;
          state.flow = "signin"; // déjà inscrit : on le connecte
          state.session = (await auth.startSignIn(email)).session;
        }
      } else {
        const r = await auth.startSignIn(email);
        if (r.done) return home();
        state.flow = "signin";
        state.session = r.session;
      }
      $("otpEmail").textContent = email;
      $("otpTo").textContent = email;
      $("otp").value = "";
      fieldError($("otp"), "otpErr", "");
      show("otp");
    } catch (e) {
      fieldError(input, "emailErr", explain(e));
    }
  });
}

async function submitOtp(ev) {
  ev.preventDefault();
  const input = $("otp");
  const code = input.value.replace(/\D/g, "");
  if (code.length !== 6) return fieldError(input, "otpErr", "Le code compte 6 chiffres.");
  await busy(ev.submitter || input.form.querySelector("button"), async () => {
    try {
      const r = state.flow === "signup" ? await auth.answerSignUp(state.email, code) : await auth.answerSignIn(state.email, state.session, code);
      if (r.done) return home();
      // inscription confirmée sur un groupe qui demande un code de connexion en plus : un second code arrive
      state.flow = "signin";
      state.session = r.session;
      input.value = "";
      fieldError(input, "otpErr", "Compte confirmé. Un code de connexion vient de partir : saisissez-le.");
    } catch (e) {
      if (e.code === "NotAuthorizedException") {
        show("login");
        return fieldError($("email"), "emailErr", explain(e));
      }
      fieldError(input, "otpErr", explain(e));
    }
  });
}

async function resendOtp() {
  await busy($("otpResend"), async () => {
    try {
      if (state.flow === "signup") await auth.resendSignUp(state.email);
      else state.session = (await auth.startSignIn(state.email)).session;
      alertBox("Un nouveau code vient de partir.", "info");
    } catch (e) {
      alertBox(explain(e));
    }
  });
}

// ---- tableau de bord
async function home() {
  alertBox("");
  show("loading", { focus: false });
  let me;
  try {
    me = await api.me();
  } catch (e) {
    if (!apiProblem(e)) show("home");
    return;
  }
  const list = $("garageList");
  list.replaceChildren();
  for (const c of me.claims) {
    const verified = c.status === "verified";
    const item = el(
      "li",
      { class: "garage-item" + (verified ? " ok" : "") },
      el("div", { class: "gi-main" }, el("b", { text: c.garageName || "Garage" }), c.garageAddr ? el("span", { class: "muted", text: c.garageAddr }) : null),
      verified
        ? el("span", { class: "pill ok" }, icon("i-check"), "Vérifié")
        : el("button", { type: "button", class: "btn small", onclick: () => resumeClaim(c) }, "Saisir le code"),
    );
    list.append(item);
  }
  $("noGarage").hidden = me.claims.length > 0;
  show("home");
}

async function resumeClaim(c) {
  state.claim = c;
  state.garage = { id: c.garageId, name: c.garageName };
  openCode();
}

// ---- étape 1 : SIRET
async function submitSiret(ev) {
  ev.preventDefault();
  alertBox("");
  const input = $("siret");
  const siret = input.value.replace(/[\s.]/g, "");
  if (!/^\d{14}$/.test(siret)) return fieldError(input, "siretErr", "Le SIRET compte 14 chiffres.");
  fieldError(input, "siretErr", "");
  $("siretResult").hidden = true;
  await busy(ev.submitter || input.form.querySelector("button"), async () => {
    let out;
    try {
      out = await api.siret(siret);
    } catch (e) {
      if (e.status === 401) return apiProblem(e);
      return fieldError(input, "siretErr", e.message);
    }
    state.siret = siret;
    state.establishment = out.establishment;
    state.garages = out.garages;
    renderEstablishment();
  });
}

function renderEstablishment() {
  const e = state.establishment;
  $("etabName").textContent = e.name || e.company;
  $("etabAddr").textContent = e.addr;
  $("etabNaf").textContent = e.naf;
  const box = $("garageOptions");
  box.replaceChildren();
  let first = null;
  for (const g of state.garages) {
    const usable = g.status === "free" && g.options.length > 0;
    const note =
      g.status === "mine" ? "Déjà rattaché à votre compte" : g.status === "claimed" ? "Déjà géré par un autre compte : vérification manuelle" : g.options.length ? `${g.options.length} moyen${g.options.length > 1 ? "s" : ""} de vérification` : "Aucun moyen de vérification en ligne : vérification manuelle";
    const radio = el("input", { type: "radio", name: "garage", value: g.id, disabled: g.status !== "free" });
    if (usable && !first) first = radio;
    box.append(
      el(
        "label",
        { class: "choice" + (g.status !== "free" ? " off" : "") },
        radio,
        el("span", { class: "choice-body" }, el("b", { text: g.name }), el("span", { class: "muted", text: [g.addr, g.distanceM != null ? `à ${g.distanceM} m de l'établissement` : ""].filter(Boolean).join(" · ") }), el("small", { text: note })),
      ),
    );
  }
  if (first) first.checked = true;
  else {
    const free = box.querySelector("input:not([disabled])");
    if (free) free.checked = true;
  }
  const none = !state.garages.length;
  $("garageChoice").hidden = none;
  $("noCandidate").hidden = !none;
  $("noCandidate").textContent = none ? "Aucun garage de la carte Pixcar n'est à l'adresse de cet établissement. Une vérification manuelle reste possible." : "";
  $("pickGarage").textContent = "";
  $("pickGarage").append(none ? "Vérification manuelle" : "C'est mon garage", icon("i-next"));
  $("siretResult").hidden = false;
  $("siretResult").scrollIntoView({ block: "nearest" });
}

function pickGarage() {
  alertBox("");
  if (!state.garages.length) return manual("Aucun garage de nos données n'est à l'adresse de cet établissement.");
  const chosen = document.querySelector('input[name="garage"]:checked');
  if (!chosen) return alertBox("Choisissez votre garage dans la liste.");
  const g = state.garages.find((x) => x.id === chosen.value);
  if (!g.options.length) return manual("Nous ne connaissons pour ce garage ni e-mail ni portable où envoyer un code.");
  state.garage = g;
  $("youGarage").textContent = g.name;
  $("youEmail").value = auth.email;
  show("you");
}

function manual(why) {
  $("manualWhy").textContent = why;
  show("manual");
}

// ---- étape 2 : la personne
function submitYou(ev) {
  ev.preventDefault();
  const first = $("firstName").value.trim(), last = $("lastName").value.trim();
  if (!first) return fieldError($("firstName"), "youErr", "Indiquez votre prénom.");
  if (!last) return fieldError($("lastName"), "youErr", "Indiquez votre nom.");
  if (!$("certify").checked) return fieldError($("certify"), "youErr", "Cochez la case pour certifier que vous êtes habilité(e).");
  fieldError(null, "youErr", "");
  const role = document.querySelector('input[name="role"]:checked').value;
  state.holder = { firstName: first, lastName: last, role, certify: true };
  renderChannels();
  show("verify");
}

// ---- étape 3 : moyen de vérification, envoi, code
const CHANNEL = {
  email: { icon: "i-mail", title: "E-mail public du garage" },
  email_domain: { icon: "i-at", title: "Une adresse du site du garage" },
  sms: { icon: "i-sms", title: "SMS au portable du garage" },
};
function renderChannels() {
  const box = $("channelOptions");
  box.replaceChildren();
  const options = state.garage.options;
  for (const o of options) {
    const radio = el("input", { type: "radio", name: "channel", value: o.id });
    const extra =
      o.channel === "email_domain"
        ? el(
            "span",
            { class: "local" },
            el("label", { class: "sr-only", for: "localPart", text: `Adresse sur ${o.domain} (partie avant le @)` }),
            el("input", { id: "localPart", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "atelier", onfocus: () => (radio.checked = true) }),
            el("span", { class: "local-domain", text: "@" + o.domain }),
          )
        : el("span", { class: "hint", text: o.hint });
    box.append(el("label", { class: "choice" }, radio, icon(CHANNEL[o.channel].icon), el("span", { class: "choice-body" }, el("b", { text: CHANNEL[o.channel].title }), extra)));
  }
  if (options.length === 1) box.querySelector("input[type=radio]").checked = true;
  fieldError(null, "channelErr", "");
}

async function submitChannel(ev) {
  ev.preventDefault();
  alertBox("");
  const chosen = document.querySelector('input[name="channel"]:checked');
  if (!chosen) return fieldError(null, "channelErr", "Choisissez où recevoir le code.");
  const option = state.garage.options.find((o) => o.id === chosen.value);
  const body = { siret: state.siret, garageId: state.garage.id, option: option.id, holder: state.holder };
  if (option.channel === "email_domain") {
    body.localPart = $("localPart").value.trim();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(body.localPart) || body.localPart.includes("..")) return fieldError($("localPart"), "channelErr", "Saisissez la partie avant le @ (lettres, chiffres, point, tiret).");
  }
  fieldError(null, "channelErr", "");
  await busy(ev.submitter || chosen.form.querySelector("button[type=submit]"), async () => {
    try {
      state.claim = await api.claim(body);
      openCode();
    } catch (e) {
      if (e.status === 401) return apiProblem(e);
      if (e.code === "local_part") return fieldError($("localPart"), "channelErr", e.message);
      if (e.code === "already_claimed") return manual("Ce garage est déjà géré par un autre compte.");
      if (e.code === "already_yours") return home();
      fieldError(null, "channelErr", e.message);
    }
  });
}

function where(c) {
  if (c.channel === "sms") return `par SMS au ${c.hint}`;
  return `par e-mail à ${c.hint}`;
}

function openCode() {
  const c = state.claim;
  $("codeWhere").textContent = where(c);
  $("code").value = "";
  fieldError($("code"), "codeErr", "");
  $("codeHelp").textContent = c.codeLive === false ? "Ce code a expiré : demandez-en un nouveau." : "Valable 10 minutes.";
  show("code");
  startTicker(c.resendInSeconds || 0);
}

function startTicker(seconds) {
  stopTicker();
  let left = Math.max(0, Math.ceil(seconds));
  const btn = $("resend");
  const out = $("resendIn");
  const paint = () => {
    const none = state.claim && state.claim.resendsLeft === 0;
    btn.disabled = left > 0 || none;
    out.textContent = none ? " (plus d'envoi possible pour cette demande)" : left > 0 ? ` dans ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "";
  };
  paint();
  if (left > 0)
    ticker = setInterval(() => {
      left--;
      paint();
      if (left <= 0) stopTicker();
    }, 1000);
}
function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

async function submitCode(ev) {
  ev.preventDefault();
  alertBox("");
  const input = $("code");
  const code = input.value.replace(/\D/g, "");
  if (code.length !== 6) return fieldError(input, "codeErr", "Le code compte 6 chiffres.");
  await busy(ev.submitter || input.form.querySelector("button"), async () => {
    try {
      state.claim = await api.code(state.claim.id, code);
      $("doneGarage").textContent = state.claim.garageName || (state.garage && state.garage.name) || "Votre garage";
      show("done");
    } catch (e) {
      if (e.status === 401) return apiProblem(e);
      if (e.code === "locked" || e.code === "claim_closed") {
        alertBox(e.message);
        renderChannels();
        return show("verify", { focus: false });
      }
      if (e.code === "already_claimed") return manual("Ce garage vient d'être rattaché à un autre compte.");
      if (e.code === "code_expired") startTicker(0);
      fieldError(input, "codeErr", e.message);
    }
  });
}

async function resendCode() {
  alertBox("");
  await busy($("resend"), async () => {
    try {
      state.claim = await api.resend(state.claim.id);
      $("codeHelp").textContent = "Nouveau code envoyé. Valable 10 minutes.";
      startTicker(state.claim.resendInSeconds || 60);
    } catch (e) {
      if (e.status === 401) return apiProblem(e);
      if (e.code === "resend_too_soon") return startTicker(e.details.retryAfter || 60);
      alertBox(e.message);
    }
  });
  if (ticker) $("resend").disabled = true;
}

// ---- branchements
$("loginForm").addEventListener("submit", submitLogin);
$("otpForm").addEventListener("submit", submitOtp);
$("otpResend").addEventListener("click", resendOtp);
$("siretForm").addEventListener("submit", submitSiret);
$("pickGarage").addEventListener("click", pickGarage);
$("changeSiret").addEventListener("click", () => {
  $("siretResult").hidden = true;
  $("siret").focus();
});
$("youForm").addEventListener("submit", submitYou);
$("channelForm").addEventListener("submit", submitChannel);
$("codeForm").addEventListener("submit", submitCode);
$("resend").addEventListener("click", resendCode);
$("signOut").addEventListener("click", async () => {
  await auth.signOut();
  setMode("login");
  show("login");
});
for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => (setMode(b.dataset.mode), show("login")));
for (const b of document.querySelectorAll("[data-go]"))
  b.addEventListener("click", () => {
    alertBox("");
    const to = b.dataset.go;
    if (to === "home") return home();
    if (to === "verify") renderChannels();
    show(to);
  });
for (const id of ["otp", "code", "siret"]) $(id).addEventListener("input", (e) => (e.target.value = e.target.value.replace(/[^\d\s.]/g, "")));

setMode(location.hash === "#inscription" ? "signup" : "login");
if (auth.signedIn) home();
else show("login", { focus: false });
