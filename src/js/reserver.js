// Mini-site de réservation d'un garage (docs/rendez-vous.md, « Mini-site de réservation ») : pixcar.fr/reserver/?garage=<identifiant>, le
// lien que le garage partage depuis Mon garage › Horaires. Vue « Essentielle » de la maquette « Mini-site garage · 3 propositions »
// (25 octobre 2026) : immatriculation et prestations, disponibilités de l'atelier (semaine ou jour, matin ou après-midi, prochain
// créneau), récapitulatif à droite, coordonnées, puis récapitulatif et code reçu par e-mail : rien ne part au garage avant le bon code.
// Données : la fiche publique du garage (/v1/pro/public/garages : nom, adresse, téléphone, horaires, prix annoncés, prestations prises en
// ligne) et ses horaires libres (/v1/rdv/garages/:id/times) ; demande et code comme la fenêtre du comparateur (src/js/rdv-book.js).
// Que du TEXTE écrit dans la page (textContent), jamais de HTML venu de l'API.
import { MODEL_MAX, MODEL_MIN, YEAR_MIN, parsePlate } from "./shared/rules.js";
import { announcedText, serviceLabel } from "./shared/pro-prices.js";
import { DAYS, phoneText } from "./shared/garage-profile.js";

const $ = (id) => document.getElementById(id);
const API = (document.querySelector('meta[name="pixcar-api"]') || {}).content || "";
const NET = "Le service ne répond pas. Vérifiez votre connexion et réessayez.";
const GARAGE_RE = /^[0-9a-f-]{8,40}$/; // même forme que l'API (lieu Overture ou garage d'essai)
const MESSAGE_MAX = 500;
const PER_DAY = 5; // horaires montrés par jour dans la vue Semaine ; le reste derrière « +N créneaux »
const NOT_OPEN = ["Pas de rendez-vous en ligne pour l'instant", "Ce garage ne propose pas d'horaire en ligne en ce moment. Retrouvez-le, ou un autre garage près de chez vous, sur le comparateur."];

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
const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", "ico");
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVG, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const put = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean)); // replaceChildren(null) écrirait « null »
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const euros = (n) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`;

// ---- jours (heure de Paris) ; une date « AAAA-MM-JJ » est lue à midi UTC pour ne jamais changer de jour
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateOf = (iso) => new Date(`${iso}T12:00:00Z`);
const addDays = (iso, n) => {
  const d = dateOf(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dow = (iso) => dateOf(iso).getUTCDay();
const monday = (iso) => addDays(iso, -((dow(iso) + 6) % 7));
const dayKey = (iso) => DAYS[(dow(iso) + 6) % 7][0];
const fmt = (iso, opts) => new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", ...opts }).format(dateOf(iso));
const longDate = (iso) => fmt(iso, { weekday: "long", day: "numeric", month: "long" });
const shortDate = (iso) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
const dayMonth = (iso) => fmt(iso, { day: "numeric", month: "short" });

let st = null;

// ================================================================ API
async function call(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, { method, headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" }, body: body ? JSON.stringify(body) : undefined, referrerPolicy: "no-referrer" });
  } catch {
    throw Object.assign(new Error(NET), { status: 0, code: "", data: {} });
  }
  const out = await res.json().catch(() => null);
  if (res.ok) return out || {};
  const e = (out && out.error) || {};
  throw Object.assign(new Error(e.message || NET), { status: res.status, code: e.code || "", data: e });
}

// ================================================================ arrivée : la fiche du garage
function gone(title, text, retry = false) {
  $("msLoading").hidden = true;
  $("msApp").hidden = true;
  $("msGone").hidden = false;
  $("msGoneTitle").textContent = title;
  $("msGoneText").textContent = text;
  if (retry) $("msGoneActs").replaceChildren(el("button", { type: "button", class: "orange", onclick: () => location.reload() }, "Réessayer"));
  $("msGoneTitle").focus();
}
async function load() {
  const id = (new URLSearchParams(location.search).get("garage") || "").trim().toLowerCase();
  if (!GARAGE_RE.test(id)) return gone("Ce lien de réservation n'est pas valide", "Vérifiez l'adresse reçue du garage : elle est peut-être incomplète.");
  let out;
  try {
    out = await call("GET", `/v1/pro/public/garages?ids=${encodeURIComponent(id)}`);
  } catch (e) {
    return e.status === 404 ? gone(...NOT_OPEN) : gone("Le service ne répond pas", e.message, true);
  }
  const g = (out.garages || []).find((x) => x && x.id === id && x.verified === true);
  const offered = (g && g.rdv && Array.isArray(g.rdv.services) ? g.rdv.services : []).filter((s) => typeof s === "string");
  if (!offered.length) return gone(...NOT_OPEN);
  const p = g.profile || {};
  const addr = p.addr && typeof p.addr === "object" ? p.addr : {};
  let name = typeof p.name === "string" ? p.name : "";
  let addrLine = addr.street ? `${addr.street}, ${addr.pc || ""} ${addr.city || ""}`.trim() : "";
  // fiche pas encore relue par Pixcar : le nom et l'adresse que l'API donne avec les horaires
  if (!name) {
    try {
      const t = await call("GET", `/v1/rdv/garages/${encodeURIComponent(id)}/times?services=${encodeURIComponent(offered[0])}`);
      name = (t.garage && t.garage.name) || "";
      addrLine = addrLine || (t.garage && t.garage.addr) || "";
    } catch (e) {
      if (e.status === 404) return gone(...NOT_OPEN);
    }
  }
  const prices = new Map();
  for (const x of Array.isArray(g.prices) ? g.prices : []) if (x && typeof x.service === "string" && !prices.has(x.service)) prices.set(x.service, x);
  st = {
    id,
    name: name || "Ce garage",
    street: addr.street || "",
    pc: addr.pc || "",
    city: addr.city || "",
    addrLine,
    phone: typeof p.phone === "string" && /^\+\d{6,15}$/.test(p.phone) ? p.phone : "",
    email: typeof p.email === "string" && /^[^\s@]+@[^\s@]+$/.test(p.email) ? p.email : "",
    website: typeof p.website === "string" && /^https?:\/\//.test(p.website) ? p.website : "",
    hours: p.hours && typeof p.hours === "object" ? p.hours : null,
    offered,
    auto: new Set((g.rdv.auto || []).filter((s) => typeof s === "string")),
    prices,
    // réservation
    plate: "",
    foreign: false,
    picked: [],
    vehicle: "",
    times: null,
    loading: false,
    timesErr: "",
    week: monday(today()),
    view: "week",
    day: "",
    filter: "all",
    pick: null,
    stage: "pick", // pick → contact → review → done
    notice: "",
    form: {},
    draft: null,
    code: "",
    change: false,
    done: null,
  };
  document.title = `${st.name} · Réserver en ligne · Pixcar`;
  $("msHeadName").textContent = st.name;
  $("msHead").hidden = false;
  $("msNav").hidden = false;
  $("msLoading").hidden = true;
  $("msApp").hidden = false;
  paintPage();
}

// ================================================================ la page
const contactHref = () => (st.phone ? `tel:${st.phone}` : st.email ? `mailto:${st.email}` : "");
function paintPage() {
  const app = $("msApp");
  $("msNavBook").hidden = st.stage === "done";
  if (st.stage === "done") {
    app.replaceChildren(success(), info());
    $("msDoneTitle").focus();
    return;
  }
  app.replaceChildren(hero(), el("div", { class: "wrap", id: "booking", tabindex: "-1" }), info(), faq());
  paintBooking();
}

function hero() {
  const k = dayKey(today());
  const open = !!(st.hours && (st.hours[k] || []).length);
  const day = fmt(today(), { weekday: "long" });
  return el(
    "section",
    { class: "hero wrap" },
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, icon("garage"), [st.name, st.city].filter(Boolean).join(" · ")),
      el("h1", { text: "Réservez votre créneau." }),
      el("p", { text: "Choisissez vos prestations et un horaire libre de l'atelier : la demande part directement au garage, qui vous répond par e-mail." }),
      el(
        "div",
        { class: "garage-facts" },
        st.city ? el("span", {}, icon("pin"), [st.city, st.pc].filter(Boolean).join(" · ")) : null,
        el("span", { class: "verified" }, icon("shield"), "Garage vérifié"),
        st.hours ? el("span", {}, el("i", { class: "open-dot" + (open ? "" : " closed"), "aria-hidden": "true" }), `${open ? "Ouvert" : "Fermé"} ce ${day}`) : null,
      ),
    ),
    el("div", { class: "hero-aside" }, "Un rendez-vous, sans créer de compte.", el("b", { text: "Des disponibilités adaptées à vos prestations." })),
  );
}

// ---- réservation : étapes, colonne principale, récapitulatif
function paintBooking() {
  const keep = document.activeElement && document.activeElement.id;
  const steps = [["Prestation & créneau", "pick"], ["Vos coordonnées", "contact"], ["Confirmation", "review"]];
  const at = steps.findIndex((s) => s[1] === st.stage);
  const progress = el("div", { class: "progress", role: "group", "aria-label": "Étapes de réservation" });
  steps.forEach(([label], i) => {
    progress.append(el("span", { class: i === at ? "current" : i < at ? "done" : "", ...(i === at ? { "aria-current": "step" } : {}) }, el("i", { "aria-hidden": "true", text: i < at ? "✓" : String(i + 1) }), label));
    if (i < steps.length - 1) progress.append(el("em", { "aria-hidden": "true", text: "→" }));
  });
  const main = st.stage === "pick" ? pickPanel() : st.stage === "contact" ? contactPanel() : reviewPanel();
  put(
    $("booking"),
    progress,
    st.notice ? el("p", { class: "eligibility-note ms-notice", role: "alert" }, icon("info"), st.notice) : null,
    el("div", { class: "booking-layout" }, el("div", { class: "booking-main" }, main), el("aside", { class: "booking-summary", id: "msSum", "aria-label": "Votre rendez-vous" })),
  );
  if (st.stage === "pick") paintPick();
  paintSum();
  if (keep && $(keep) && keep !== "booking") $(keep).focus({ preventScroll: true });
}
function stage(next, focusId) {
  st.stage = next;
  paintBooking();
  $("booking").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
}

// ================================================================ 1. immatriculation, prestations, horaire
function plateField(id) {
  const input = el("input", {
    id,
    type: "text",
    name: "plate",
    class: "ms-plate",
    maxlength: "15",
    placeholder: st.foreign ? "Ex. M-AB 1234" : "AB-123-CD",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    "aria-describedby": `${id}Err msPlateHelp`,
    oninput: (e) => {
      st.plate = e.target.value;
      clearErr(e.target);
      const d = $("msSumPlate");
      if (d) (d.textContent = st.plate.trim().toUpperCase() || "À renseigner"), d.classList.toggle("undecided", !st.plate.trim());
    },
  });
  input.value = st.plate;
  const foreign = el("input", {
    type: "checkbox",
    id: id + "Foreign",
    onchange: (e) => {
      st.foreign = e.target.checked;
      input.placeholder = st.foreign ? "Ex. M-AB 1234" : "AB-123-CD";
      input.closest(".plate-input").classList.toggle("foreign", st.foreign);
      clearErr(input);
    },
  });
  foreign.checked = st.foreign;
  return el(
    "div",
    { class: "plate-field" },
    el("label", { for: id, text: "Immatriculation du véhicule" }),
    el("div", { class: "plate-input" + (st.foreign ? " foreign" : "") }, el("span", { class: "plate-country", "aria-hidden": "true", text: "F" }), input),
    el("label", { class: "ms-foreign" }, foreign, el("span", { text: "Plaque étrangère" })),
    el("span", { class: "field-err", id: `${id}Err`, hidden: true }),
  );
}
// la plaque, lue et mise en forme ; null et le champ en erreur si elle ne va pas
function readPlate(id) {
  const input = $(id);
  const r = parsePlate(input.value, { foreign: st.foreign });
  if (r.error) {
    fieldErr(input, r.error);
    return null;
  }
  st.plate = input.value = r.value;
  return r.value;
}

function pickPanel() {
  const has = st.picked.length > 0;
  return el(
    "section",
    { class: "panel" + (has ? "" : " selection-stage"), id: "availability", "aria-labelledby": "msPanelTitle" },
    el(
      "div",
      { class: "panel-head" },
      el("div", {}, el("h2", { id: "msPanelTitle", tabindex: "-1", text: has ? "Les disponibilités de l'atelier" : "Préparez votre rendez-vous" }), el("p", { text: has ? "Choisissez vos prestations, puis un créneau disponible." : "Votre immatriculation, vos prestations, puis le bon créneau." })),
      has ? null : el("span", { class: "step-tag", text: "Étape 1" }),
    ),
    el("div", { class: "compact-criteria" }, plateField("msPlate"), servicePicker()),
    el("div", { id: "msChips" }),
    el("p", { class: "vehicle-hint", id: "msPlateHelp" }, icon("info"), "Le garage identifie votre véhicule grâce à son immatriculation et vérifie la compatibilité des prestations."),
    el("div", { id: "msVeh" }),
    el("div", { id: "msCal" }),
  );
}

// ---- prestations : liste déroulante à cases, recherche, « Terminé »
function servicePicker() {
  const rows = st.offered.map((id) => {
    const p = st.prices.get(id);
    const box = el("input", { type: "checkbox", id: `svc-${id}`, "data-svc": id, onchange: (e) => toggleService(id, e.target.checked) });
    box.checked = st.picked.includes(id);
    return el(
      "label",
      { class: "multi-option" + (box.checked ? " checked" : ""), "data-row": id },
      box,
      el("span", {}, el("b", { text: serviceLabel(id) }), el("small", { text: st.auto.has(id) ? "Confirmation immédiate" : "Confirmée par le garage" })),
      p ? el("em", { text: cap(announcedText(p.kind, p.price)) }) : null,
    );
  });
  const search = el("input", { id: "msSvcSearch", type: "search", "aria-label": "Rechercher une prestation", placeholder: "Rechercher une prestation…", autocomplete: "off", oninput: filterServices });
  const menu = el(
    "div",
    { class: "multi-menu", id: "msSvcMenu", hidden: true },
    st.offered.length > 5 ? el("div", { class: "multi-menu-search" }, icon("tool"), search) : null,
    el("div", { class: "multi-options", role: "group", "aria-label": "Prestations proposées en ligne" }, ...rows),
    el("p", { class: "search-empty", id: "msSvcNone", hidden: true, text: "Aucune prestation correspondante." }),
    el(
      "div",
      { class: "multi-menu-footer" },
      el("button", { type: "button", class: "text-link", id: "msSvcClear", onclick: () => setServices([]) }, "Tout effacer"),
      el("span", { id: "msSvcCount", role: "status" }),
      el("button", { type: "button", class: "black", id: "msSvcDone", onclick: () => closeMenu(true) }, "Terminé", icon("check")),
    ),
  );
  return el(
    "div",
    { class: "multi-picker" },
    el("span", { class: "ms-label", id: "msSvcLabel", text: "Vos prestations" }),
    el("button", { type: "button", class: "multi-trigger", id: "msSvcBtn", "aria-expanded": "false", "aria-controls": "msSvcMenu", "aria-labelledby": "msSvcLabel msSvcValue", onclick: () => (menuOpen() ? closeMenu(true) : openMenu()) }, el("span", { id: "msSvcValue" }), icon("chevron")),
    menu,
  );
}
const menuOpen = () => $("msSvcMenu") && !$("msSvcMenu").hidden;
function openMenu() {
  $("msSvcMenu").hidden = false;
  $("msSvcBtn").setAttribute("aria-expanded", "true");
  ($("msSvcSearch") || $("msSvcMenu").querySelector("input")).focus();
}
function closeMenu(focusTrigger) {
  if (!menuOpen()) return;
  $("msSvcMenu").hidden = true;
  $("msSvcBtn").setAttribute("aria-expanded", "false");
  if (focusTrigger) $("msSvcBtn").focus();
}
function filterServices() {
  const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = fold($("msSvcSearch").value.trim());
  let shown = 0;
  for (const row of $("msSvcMenu").querySelectorAll("[data-row]")) {
    row.hidden = !fold(serviceLabel(row.dataset.row)).includes(q);
    if (!row.hidden) shown++;
  }
  $("msSvcNone").hidden = shown > 0;
}
function toggleService(id, on) {
  setServices(on ? [...st.picked, id] : st.picked.filter((x) => x !== id), true);
}
let timesTimer = null;
function setServices(list, fromMenu = false) {
  const was = st.picked.length;
  st.picked = st.offered.filter((id) => list.includes(id)); // dans l'ordre de la fiche
  st.pick = null;
  st.notice = "";
  if (!st.picked.length) (st.times = null), (st.vehicle = "");
  // le premier choix fait passer le panneau à « Les disponibilités » : on le reconstruit en gardant la liste ouverte
  if (!was !== !st.picked.length) {
    const open = menuOpen();
    paintBooking();
    if (open) openMenu();
    const box = $(`svc-${fromMenu && list.at(-1)}`);
    if (box) box.focus();
  } else paintPick();
  paintSum();
  clearTimeout(timesTimer);
  if (st.picked.length) {
    st.loading = true;
    paintCal();
    timesTimer = setTimeout(fetchTimes, 250);
  }
}
let seq = 0;
async function fetchTimes() {
  const mine = ++seq;
  st.loading = true;
  st.timesErr = "";
  const q = `services=${st.picked.map(encodeURIComponent).join(",")}${st.vehicle ? `&vehicle=${encodeURIComponent(st.vehicle)}` : ""}`;
  try {
    const t = await call("GET", `/v1/rdv/garages/${encodeURIComponent(st.id)}/times?${q}`);
    if (mine !== seq) return;
    st.times = t;
    if (t.needVehicle) st.vehicle = "";
    if (st.pick && !findTime(st.pick.day, st.pick.t)) st.pick = null;
    const first = (t.days || [])[0];
    if (first && !(t.days || []).some((d) => monday(d.day) === st.week)) st.week = monday(first.day);
    if (!st.day || !(t.days || []).some((d) => d.day === st.day)) st.day = first ? first.day : "";
  } catch (e) {
    if (mine !== seq) return;
    st.times = null;
    st.timesErr = e.status === 404 ? "Ce garage ne prend plus de rendez-vous en ligne pour cette sélection. Appelez-le pour convenir d'un horaire." : e.message;
  }
  st.loading = false;
  if (st.stage === "pick") paintPick();
  paintSum();
}
const findTime = (day, t) => {
  const d = ((st.times && st.times.days) || []).find((x) => x.day === day);
  return d && d.times.find((x) => x.t === t);
};

// chips, véhicule, calendrier : ce qui change avec le choix
function paintPick() {
  if (!$("msCal")) return;
  const n = st.picked.length;
  $("msSvcValue").textContent = n ? `${plural(n, "prestation sélectionnée", "prestations sélectionnées")}` : "Choisir une ou plusieurs prestations";
  $("msSvcCount").textContent = plural(n, "sélectionnée");
  $("msSvcClear").disabled = !n;
  for (const box of $("msSvcMenu").querySelectorAll("[data-svc]")) {
    box.checked = st.picked.includes(box.dataset.svc);
    box.closest(".multi-option").classList.toggle("checked", box.checked);
  }
  $("msChips").replaceChildren(
    ...(n
      ? [
          el(
            "div",
            { class: "picked-tags", role: "group", "aria-label": "Prestations sélectionnées" },
            ...st.picked.map((id) => el("span", {}, serviceLabel(id), el("button", { type: "button", id: `rm-${id}`, "aria-label": `Retirer ${serviceLabel(id)}`, onclick: () => removeService(id), text: "×" }))),
          ),
        ]
      : []),
  );
  const vs = st.times && (st.times.needVehicle || st.vehicle) ? st.times.vehicles || [] : [];
  $("msVeh").replaceChildren(
    ...(vs.length
      ? [
          el(
            "div",
            { class: "ms-vehicles", role: "group", "aria-labelledby": "msVehLabel" },
            el("span", { class: "ms-label", id: "msVehLabel", text: "Type de véhicule" }),
            ...vs.map((v) => el("button", { type: "button", id: `veh-${v.id}`, "aria-pressed": String(st.vehicle === v.id), onclick: () => chooseVehicle(v.id), text: v.label })),
          ),
        ]
      : []),
  );
  paintCal();
}
function removeService(id) {
  setServices(st.picked.filter((x) => x !== id));
  const next = st.picked[0];
  ($(`rm-${next}`) || $("msSvcBtn")).focus();
}
function chooseVehicle(id) {
  st.vehicle = id;
  st.pick = null;
  st.loading = true;
  paintCal();
  fetchTimes();
}

function paintCal() {
  const box = $("msCal");
  if (!box) return;
  if (!st.picked.length) {
    box.replaceChildren(
      el(
        "div",
        { class: "selection-prompt" },
        el("span", { class: "prompt-icon", "aria-hidden": "true" }, icon("plus")),
        el("div", {}, el("h3", { text: "Commençons par vos prestations." }), el("p", { text: "Choisissez une ou plusieurs prestations dans la liste ci-dessus. Les créneaux compatibles apparaîtront ensuite." })),
        el("button", { type: "button", class: "orange", id: "msOpenSvc", onclick: () => (openMenu(), $("msSvcBtn").scrollIntoView({ block: "center" })) }, "Choisir mes prestations", icon("chevron")),
      ),
    );
    return;
  }
  const t = st.times;
  const rule = el("div", { class: "service-rule" }, icon("clock"), el("span", { text: !t ? "Recherche des horaires libres…" : autoMode() ? "Confirmation immédiate pour cette sélection : le garage confirme dès votre demande envoyée." : `Le garage confirme votre demande au plus tard le ${t.deadlineText}, par e-mail.` }));
  const foot = el(
    "div",
    { class: "booking-footer" },
    el("span", {}, icon("shield"), "Créneaux calculés selon les disponibilités du garage."),
    contactHref() ? el("a", { class: "text-link", href: contactHref() }, st.phone ? "Aucun horaire ne vous convient ? Appelez l'atelier" : "Aucun horaire ne vous convient ? Écrivez à l'atelier", icon("arrow")) : null,
  );
  if (st.timesErr) return box.replaceChildren(rule, el("p", { class: "eligibility-note", role: "alert" }, icon("info"), st.timesErr), foot);
  if (st.loading && !t) return box.replaceChildren(rule, el("p", { class: "ms-wait", role: "status", text: "Recherche des horaires libres…" }), foot);
  if (t && t.needVehicle) return box.replaceChildren(rule, el("p", { class: "eligibility-note" }, icon("car"), "Choisissez le type de votre véhicule ci-dessus : la durée de l'intervention en dépend, les horaires proposés aussi."), foot);
  const days = (t && t.days) || [];
  const first = today();
  const last = days.length ? days.at(-1).day : first;
  const shown = (d) => d.times.filter((x) => st.filter === "all" || (st.filter === "am" ? x.t < "12:00" : x.t >= "12:00"));
  const next = days.map((d) => [d, shown(d)[0]]).find(([, x]) => x);
  const week = Array.from({ length: 7 }, (_, i) => addDays(st.week, i));
  const nav = el(
    "div",
    { class: "calendar-toolbar" },
    el(
      "div",
      { class: "week-navigation" },
      el("button", { type: "button", id: "msPrevWeek", "aria-label": "Semaine précédente", disabled: st.week <= monday(first), onclick: () => shiftWeek(-1) }, icon("back")),
      el("span", { class: "date-range", id: "msRange" }, icon("calendar"), `${dayMonth(st.week)} – ${dayMonth(addDays(st.week, 6))}`),
      el("button", { type: "button", id: "msNextWeek", "aria-label": "Semaine suivante", disabled: st.week >= monday(last), onclick: () => shiftWeek(1) }, icon("arrow")),
    ),
    el(
      "div",
      { class: "view-switch", role: "group", "aria-label": "Affichage des créneaux" },
      el("button", { type: "button", id: "msViewWeek", "aria-pressed": String(st.view === "week"), onclick: () => setView("week") }, "Semaine"),
      el("button", { type: "button", id: "msViewDay", "aria-pressed": String(st.view === "day"), onclick: () => setView("day") }, "Par jour"),
    ),
  );
  const bar = el(
    "div",
    { class: "next-slot" },
    next
      ? el("button", { type: "button", id: "msNext", onclick: () => choose(next[0], next[1], true) }, icon("bolt"), `Prochain créneau : ${shortDate(next[0].day)} · ${next[1].t}`)
      : el("span", { text: days.length ? "Aucun créneau à ce moment de la journée." : "Aucun créneau libre dans les semaines à venir." }),
    el(
      "div",
      { class: "time-filter", role: "group", "aria-label": "Moment de la journée" },
      ...[["all", "Tous"], ["am", "Matin"], ["pm", "Après-midi"]].map(([id, label]) => el("button", { type: "button", id: `msF-${id}`, "aria-pressed": String(st.filter === id), onclick: () => ((st.filter = id), paintCal()) }, label)),
    ),
  );
  let grid;
  if (st.view === "week") {
    grid = el(
      "div",
      { class: "availability-wrap" },
      el(
        "div",
        { class: "availability-week" },
        ...week.map((iso) => {
          const d = days.find((x) => x.day === iso);
          const ts = d ? shown(d) : [];
          const closed = !st.hours ? false : !(st.hours[dayKey(iso)] || []).length;
          const head = el(
            "button",
            { type: "button", class: "day-heading" + (st.view === "day" && iso === st.day ? " selected" : "") + (st.pick && st.pick.day === iso ? " selected" : ""), id: `d-${iso}`, "aria-label": `${longDate(iso)} : ${plural(ts.length, "créneau", "créneaux")}`, onclick: () => openDay(iso) },
            el("span", { text: fmt(iso, { weekday: "short" }) }),
            el("b", { text: dayMonth(iso) }),
            el("small", { text: plural(ts.length, "créneau", "créneaux") }),
          );
          if (!ts.length) return el("div", { class: "availability-column" }, head, el("div", { class: "no-slot" }, icon("calendar"), iso < first ? "Passé" : closed ? "Fermé" : "Pas de créneau"));
          return el(
            "div",
            { class: "availability-column" },
            head,
            ...ts.slice(0, PER_DAY).map((x) => slotButton(d, x)),
            ts.length > PER_DAY ? el("button", { type: "button", class: "slot-more", id: `m-${iso}`, onclick: () => openDay(iso), "aria-label": `${plural(ts.length - PER_DAY, "autre créneau", "autres créneaux")} le ${longDate(iso)}` }, `+${plural(ts.length - PER_DAY, "créneau", "créneaux")}`) : null,
          );
        }),
      ),
      el("p", { class: "calendar-caption", text: "Heure de dépôt au garage · Horaires locaux (France) · Tous les créneaux tiennent compte de vos prestations." }),
    );
  } else {
    const d = days.find((x) => x.day === st.day) || days.find((x) => monday(x.day) === st.week) || days[0];
    const ts = d ? shown(d) : [];
    grid = el(
      "div",
      { class: "availability-wrap" },
      d
        ? el("div", { class: "ms-day-tabs", role: "group", "aria-label": "Jours" }, ...days.filter((x) => monday(x.day) === monday(d.day)).map((x) => el("button", { type: "button", id: `t-${x.day}`, "aria-pressed": String(x.day === d.day), onclick: () => openDay(x.day, `t-${x.day}`) }, el("span", { text: cap(shortDate(x.day)) }))))
        : null,
      d && ts.length
        ? el("div", { class: "day-slot-view" }, el("h3", { text: cap(longDate(d.day)) }), el("div", { role: "group", "aria-label": `Horaires du ${longDate(d.day)}` }, ...ts.map((x) => slotButton(d, x))))
        : el("div", { class: "availability-empty" }, icon("calendar"), el("h3", { text: "Aucun créneau pour cette sélection." }), el("p", { text: d ? "Aucun horaire libre à ce moment de la journée. Essayez « Tous » ou une autre journée." : "Plus aucun horaire libre dans les semaines à venir pour ces prestations." })),
    );
  }
  box.replaceChildren(rule, nav, bar, grid, foot);
}
function slotButton(d, x) {
  const on = !!st.pick && st.pick.day === d.day && st.pick.t === x.t;
  const label = x.drop ? `${x.t}–${x.until}` : x.t;
  return el(
    "button",
    {
      type: "button",
      class: "slot-button" + (on ? " selected" : ""),
      id: `s-${d.day}-${x.t.replace(":", "")}`,
      "aria-pressed": String(on),
      "aria-label": x.drop ? `Déposer la voiture le ${longDate(d.day)} entre ${x.t} et ${x.until}` : `Réserver le ${longDate(d.day)} à ${x.t}`,
      onclick: () => choose(d, x),
    },
    label,
  );
}
function shiftWeek(n) {
  st.week = addDays(st.week, 7 * n);
  const d = ((st.times && st.times.days) || []).find((x) => monday(x.day) === st.week);
  if (d) st.day = d.day;
  paintCal();
  $(n < 0 ? "msPrevWeek" : "msNextWeek").disabled ? $("msRange").parentElement.querySelector("button:not(:disabled)").focus() : $(n < 0 ? "msPrevWeek" : "msNextWeek").focus();
}
function setView(v) {
  st.view = v;
  paintCal();
  $(v === "week" ? "msViewWeek" : "msViewDay").focus();
}
function openDay(iso, focusId) {
  st.day = iso;
  st.week = monday(iso);
  st.view = "day";
  paintCal();
  $(focusId || "msViewDay").focus();
}
function choose(d, x, jump = false) {
  st.pick = { day: d.day, label: d.label, ...x };
  st.notice = "";
  if (jump) (st.day = d.day), (st.week = monday(d.day)), (st.view = "day");
  const id = `s-${d.day}-${x.t.replace(":", "")}`;
  paintCal();
  paintSum();
  if ($(id)) $(id).focus();
  $("msLive").textContent = `Créneau choisi : ${longDate(d.day)} à ${x.t}.`;
}
const autoMode = () => (st.times && typeof st.times.auto === "boolean" ? st.times.auto : st.picked.length > 0 && st.picked.every((id) => st.auto.has(id)));

// ================================================================ récapitulatif (à droite)
function estimate() {
  const ps = st.picked.map((id) => st.prices.get(id));
  if (!ps.length || ps.some((p) => !p || p.kind === "quote" || typeof p.price !== "number")) return null;
  return { total: ps.reduce((n, p) => n + p.price, 0), from: ps.some((p) => p.kind === "from") };
}
function paintSum() {
  const box = $("msSum");
  if (!box) return;
  box.classList.toggle("initial-summary", st.stage === "pick" && !st.picked.length);
  if (st.stage === "pick" && !st.picked.length) {
    box.replaceChildren(
      el(
        "div",
        { class: "initial-guide" },
        el("div", { class: "initial-guide-icon", "aria-hidden": "true" }, icon("shield")),
        el("h2", {}, "Un rendez-vous,", el("br"), "en toute simplicité."),
        el(
          "ol",
          {},
          el("li", {}, el("b", { text: "Vos prestations" }), el("span", { text: "Un ou plusieurs besoins, un seul passage." })),
          el("li", {}, el("b", { text: "Le bon créneau" }), el("span", { text: "Des horaires libres, adaptés à votre sélection." })),
          el("li", {}, el("b", { text: "Votre confirmation" }), el("span", { text: "Sans compte et sans paiement en ligne." })),
        ),
        contactHref() ? el("a", { class: "text-link", href: contactHref() }, "Une question pour l'atelier ?", icon("arrow")) : null,
      ),
    );
    return;
  }
  const est = estimate();
  const p = st.pick;
  const end = p && (p.end || "");
  const plate = st.plate.trim().toUpperCase();
  const vehicleLabel = st.vehicle && st.times ? ((st.times.vehicles || []).find((v) => v.id === st.vehicle) || {}).label : "";
  const dl = el(
    "dl",
    { class: "summary-dl" },
    el("dt", { text: "Immatriculation" }),
    el("dd", { id: "msSumPlate", class: plate ? "" : "undecided", text: plate || "À renseigner" }),
    vehicleLabel ? el("dt", { text: "Véhicule" }) : null,
    vehicleLabel ? el("dd", { text: vehicleLabel }) : null,
    el("dt", { text: p && p.drop ? "Dépôt entre" : "Dépôt" }),
    el("dd", { class: p ? "" : "undecided", text: p ? `${shortDate(p.day)} · ${p.drop ? `${p.t}–${p.until}` : p.t}` : "Choisissez un créneau" }),
    end ? el("dt", { text: "Fin indicative" }) : null,
    end ? el("dd", { text: end }) : null,
  );
  const action =
    st.stage === "pick"
      ? el("button", { type: "button", class: "orange", id: "msContinue", disabled: !p, onclick: next }, st.change ? "Envoyer avec cet horaire" : "Continuer", icon("arrow"))
      : el("button", { type: "button", class: "quiet", id: "msChangeTime", onclick: () => stage("pick", "msPanelTitle") }, "Modifier le créneau");
  put(
    box,
    el(
      "div",
      { class: "panel" },
      el("div", { class: "summary-garage" }, el("span", { class: "garage-monogram", "aria-hidden": "true", text: initials(st.name) }), el("div", {}, el("b", { text: st.name }), el("p", { text: [st.city, st.pc].filter(Boolean).join(" · ") }))),
      el(
        "div",
        { class: "summary-body" },
        el("h2", { text: "Votre rendez-vous" }),
        el(
          "div",
          { class: "summary-services" },
          ...st.picked.map((id) => {
            const pr = st.prices.get(id);
            return el("div", { class: "summary-service" }, el("span", { text: serviceLabel(id) }), el("b", { text: pr ? cap(announcedText(pr.kind, pr.price)) + (pr.kind === "quote" ? "" : "*") : "À préciser" }));
          }),
        ),
        dl,
        el("div", { class: "summary-price" }, el("span", { text: est ? (est.from ? "Estimation à partir de" : "Prix annoncé") : "Tarif à préciser" }), est ? el("strong", {}, euros(est.total), el("small", { text: "*" })) : el("strong", { class: "quote", text: "Au garage" })),
        action,
        el("p", { class: "summary-mode" }, icon(autoMode() ? "check" : "clock"), el("span", { text: autoMode() ? "Confirmation immédiate proposée pour cette sélection." : "Demande soumise à la confirmation du garage." })),
        el("p", { class: "summary-note", text: `* Prix annoncés par le garage, TTC. Le garage confirme le montant adapté à votre véhicule avant les travaux.${end ? " La fin indiquée est une estimation, pas une heure de restitution garantie." : ""}` }),
      ),
    ),
    el("p", { class: "summary-safety" }, icon("shield"), "Sans compte · Sans paiement en ligne"),
    contactHref()
      ? el(
          "div",
          { class: "booking-follow" },
          el("b", { text: "Un besoin particulier ?" }),
          "Une prestation introuvable ou une question sur votre véhicule ? L'atelier peut vous proposer un rendez-vous adapté.",
          el("br"),
          el("a", { class: "ms-btn", href: contactHref() }, st.phone ? `Appeler l'atelier · ${phoneText(st.phone)}` : "Écrire à l'atelier", icon("arrow")),
        )
      : null,
  );
}
function initials(name) {
  const w = name.split(/[\s'’-]+/).filter((x) => /\p{L}/u.test(x));
  return ((w[0] || "?")[0] + (w.length > 1 ? w.at(-1)[0] : "")).toUpperCase();
}
// « Continuer » : la plaque d'abord, puis les coordonnées (ou, après un horaire pris entre-temps, le même code avec le nouvel horaire)
function next() {
  if (!st.pick) return;
  if (!readPlate("msPlate")) return;
  st.notice = "";
  if (st.change) {
    stage("review");
    countdown(0);
    return sendCode();
  }
  stage("contact", "msContactTitle");
}

// ================================================================ 2. coordonnées
function contactPanel() {
  const f = st.form;
  const thisYear = new Date().getFullYear();
  const field = (id, label, attrs, value, wide = false) => {
    const input = el(attrs.rows ? "textarea" : "input", { id, "aria-describedby": `${id}Err`, ...attrs, rows: attrs.rows });
    input.value = value || "";
    return el("label", { class: wide ? "wide" : "", for: id }, label, input, el("span", { class: "field-err", id: `${id}Err`, hidden: true }));
  };
  const opt = (text) => el("span", {}, text, " ", el("span", { class: "opt", text: "(facultatif)" }));
  return el(
    "section",
    { class: "panel contact-card", "aria-labelledby": "msContactTitle" },
    el(
      "div",
      { class: "panel-body step-content" },
      el("button", { type: "button", class: "step-back", id: "msBackTimes", onclick: () => stage("pick", "msPanelTitle") }, icon("back"), "Revenir aux créneaux"),
      el("h2", { id: "msContactTitle", tabindex: "-1", text: "Faisons connaissance." }),
      el("p", { class: "intro", text: "Vos coordonnées permettront au garage de préparer votre venue et de vous répondre." }),
      slotStrip(),
      el(
        "form",
        { class: "form-fields", id: "msForm", novalidate: true, "data-cs-mask": true, onsubmit: sendContact, oninput: (e) => clearErr(e.target) },
        field("msFirst", "Prénom", { type: "text", autocomplete: "given-name", maxlength: "40" }, f.first),
        field("msLast", "Nom", { type: "text", autocomplete: "family-name", maxlength: "40" }, f.last),
        field("msEmail", "E-mail", { type: "email", autocomplete: "email", maxlength: "254", spellcheck: "false" }, f.email),
        field("msPhone", "Téléphone", { type: "tel", autocomplete: "tel", maxlength: "20" }, f.phone),
        el("div", { class: "wide contact-registration" }, plateField("msPlate2")),
        field("msCar", "Modèle du véhicule", { type: "text", maxlength: String(MODEL_MAX), placeholder: "Ex. Renault Clio", autocomplete: "off" }, f.car),
        field("msYear", "Année du modèle", { type: "text", inputmode: "numeric", maxlength: "4", placeholder: String(thisYear - 6), autocomplete: "off" }, f.year),
        field("msMsg", opt("Précision pour le garage"), { rows: "3", maxlength: String(MESSAGE_MAX), placeholder: "Un bruit, un voyant, une demande particulière…" }, f.message, true),
        el("div", { class: "ms-trap", "aria-hidden": "true" }, el("label", { text: "Site web " }, el("input", { type: "text", name: "website", id: "msWebsite", tabindex: "-1", autocomplete: "off" }))),
        el("p", { class: "form-note wide", text: `Un code de confirmation vous est envoyé par e-mail. Vos coordonnées vont au seul ${st.name}, pour ce rendez-vous ; Pixcar les efface 30 jours après.` }),
        el("p", { class: "error wide", id: "msFormErr", role: "alert", hidden: true }),
        el("button", { type: "submit", class: "orange wide", id: "msSend" }, "Vérifier ma demande", icon("arrow")),
      ),
    ),
  );
}
function slotStrip() {
  const p = st.pick;
  if (!p) return null;
  return el(
    "div",
    { class: "selected-slot-strip" },
    icon("calendar"),
    el("div", {}, el("b", { text: cap(p.drop ? `${longDate(p.day)}, dépôt entre ${p.t} et ${p.until}` : `${longDate(p.day)} à ${p.t}`) }), el("small", { text: `Dépôt au garage${p.end ? ` · Fin indicative ${p.end}` : ""}` })),
  );
}
function fieldErr(input, message) {
  const b = $(input.id + "Err");
  if (b) (b.textContent = message), (b.hidden = false);
  input.setAttribute("aria-invalid", "true");
  input.focus();
}
function clearErr(input) {
  if (!input || input.getAttribute("aria-invalid") !== "true") return;
  input.removeAttribute("aria-invalid");
  const b = $(input.id + "Err");
  if (b) b.hidden = true;
}
function sayForm(message) {
  const b = $("msFormErr");
  b.textContent = message || "";
  b.hidden = !message;
}
const FIELDS = { name: "msFirst", email: "msEmail", phone: "msPhone", car: "msCar", year: "msYear", plate: "msPlate2", message: "msMsg" };
async function sendContact(ev) {
  ev.preventDefault();
  sayForm("");
  const val = (id) => $(id).value.trim();
  const f = (st.form = { first: val("msFirst"), last: val("msLast"), email: val("msEmail"), phone: val("msPhone"), car: val("msCar"), year: val("msYear"), message: val("msMsg") });
  const thisYear = new Date().getFullYear();
  const y = Number(f.year);
  if (!f.first) return fieldErr($("msFirst"), "Indiquez votre prénom.");
  if (!f.last) return fieldErr($("msLast"), "Indiquez votre nom.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return fieldErr($("msEmail"), "Adresse e-mail invalide.");
  if (f.phone.replace(/\D/g, "").length < 9) return fieldErr($("msPhone"), "Un numéro de téléphone, par exemple 06 12 34 56 78.");
  if (!readPlate("msPlate2")) return;
  if (f.car.length < MODEL_MIN) return fieldErr($("msCar"), "Indiquez le modèle, par exemple Renault Clio.");
  if (!/^\d{4}$/.test(f.year) || y < YEAR_MIN || y > thisYear + 1) return fieldErr($("msYear"), `Année du modèle : de ${YEAR_MIN} à ${thisYear + 1}.`);
  const btn = $("msSend");
  btn.disabled = true;
  btn.firstChild.textContent = "Envoi du code…";
  try {
    st.draft = await call("POST", "/v1/rdv/requests", {
      garageId: st.id,
      services: st.picked.map((id) => ({ id, qty: 1 })),
      day: st.pick.day,
      time: st.pick.t,
      ...(st.pick.drop ? { drop: true } : {}),
      ...(st.vehicle ? { vehicle: st.vehicle } : {}),
      name: `${f.first} ${f.last}`,
      email: f.email,
      phone: f.phone,
      car: f.car,
      year: y,
      plate: st.plate,
      ...(st.foreign ? { plateForeign: true } : {}),
      message: f.message,
      remindPrice: false,
      website: $("msWebsite").value,
    });
    st.change = false;
    st.code = "";
    stage("review", "msReviewTitle");
    countdown(st.draft.resendInSeconds);
  } catch (e) {
    btn.disabled = false;
    btn.firstChild.textContent = "Vérifier ma demande";
    if (e.code === "time_taken") return taken(e);
    if (e.status === 422 && FIELDS[e.data.field]) return fieldErr($(FIELDS[e.data.field]), e.message);
    sayForm(e.message);
  }
}
// l'horaire est parti entre-temps : retour aux créneaux (ceux que l'API vient de renvoyer), le code reste valable s'il y en a un
function taken(e) {
  stopTick();
  st.times = { ...st.times, days: e.data.days || [] };
  st.pick = null;
  st.notice = e.message || "Cet horaire n'est plus libre. Choisissez-en un autre.";
  stage("pick", "msPanelTitle");
}

// ================================================================ 3. récapitulatif et code
function reviewPanel() {
  const f = st.form;
  const d = st.draft;
  const auto = autoMode();
  const est = estimate();
  const code = el("input", { type: "text", id: "msCode", class: "ms-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", spellcheck: "false", "aria-describedby": "msCodeHelp msCodeErr", oninput: (e) => ((e.target.value = e.target.value.replace(/[^\d\s]/g, "")), clearErr(e.target)) });
  code.value = st.code;
  return el(
    "section",
    { class: "panel contact-card", "aria-labelledby": "msReviewTitle" },
    el(
      "div",
      { class: "panel-body step-content" },
      el("button", { type: "button", class: "step-back", id: "msBackContact", onclick: () => (stopTick(), stage("contact", "msContactTitle")) }, icon("back"), "Modifier mes coordonnées"),
      el("h2", { id: "msReviewTitle", tabindex: "-1", text: "Tout est prêt." }),
      el("p", { class: "intro", text: auto ? "Vérifiez les informations, puis confirmez le rendez-vous avec le code reçu par e-mail." : "Vérifiez les informations, puis envoyez votre demande avec le code reçu par e-mail." }),
      slotStrip(),
      el(
        "div",
        { class: "review-card" },
        el("h3", {}, "Le véhicule et les prestations", el("button", { type: "button", onclick: () => (stopTick(), stage("pick", "msPanelTitle")) }, "Modifier")),
        el(
          "dl",
          {},
          el("dt", { text: "Immatriculation" }),
          el("dd", { text: st.plate }),
          el("dt", { text: "Véhicule" }),
          el("dd", { text: `${f.car} · ${f.year}` }),
          el("dt", { text: "Prestations" }),
          el("dd", {}, ...st.picked.flatMap((id, i) => [i ? el("br") : null, serviceLabel(id)])),
          el("dt", { text: "Estimation" }),
          el("dd", { text: est ? `${est.from ? "À partir de " : ""}${euros(est.total)} TTC` : "À préciser avec le garage" }),
        ),
      ),
      el(
        "div",
        { class: "review-card" },
        el("h3", {}, "Vos coordonnées", el("button", { type: "button", onclick: () => (stopTick(), stage("contact", "msContactTitle")) }, "Modifier")),
        el("dl", {}, el("dt", { text: "Nom" }), el("dd", { text: `${f.first} ${f.last}` }), el("dt", { text: "E-mail" }), el("dd", { text: f.email }), el("dt", { text: "Téléphone" }), el("dd", { text: f.phone })),
      ),
      el(
        "form",
        { class: "ms-code-form", id: "msCodeForm", novalidate: true, onsubmit: (e) => (e.preventDefault(), sendCode()) },
        el("label", { for: "msCode", text: "Code à 6 chiffres reçu par e-mail" }),
        code,
        el("p", { class: "ms-help", id: "msCodeHelp" }, "Envoyé à ", el("b", { text: d ? d.email : f.email }), `. Valable ${d ? Math.round(d.expiresInSeconds / 60) : 10} minutes. Rien ne part au garage avant ce code.`),
        el("span", { class: "field-err", id: "msCodeErr", hidden: true }),
        el("div", { class: "final-actions" }, el("button", { type: "submit", class: "orange", id: "msConfirm" }, auto ? "Confirmer le rendez-vous" : "Envoyer la demande", icon("check"))),
        el("p", { class: "ms-links" }, el("button", { type: "button", class: "text-link", id: "msResend", onclick: resendCode })),
      ),
      el("p", { class: "form-note", text: auto ? "La disponibilité du créneau est vérifiée à nouveau à la confirmation." : "Le garage confirme la faisabilité et le tarif avant d'accepter le rendez-vous." }),
    ),
  );
}
let tick = null;
function stopTick() {
  clearInterval(tick);
  tick = null;
}
function countdown(seconds) {
  stopTick();
  let left = seconds;
  const paint = () => {
    const b = $("msResend");
    if (!b) return stopTick();
    const out = !st.draft || !st.draft.resendsLeft;
    b.disabled = left > 0 || out;
    b.textContent = out ? "Plus de nouvel envoi possible" : left > 0 ? `Renvoyer le code (${left} s)` : "Renvoyer le code";
  };
  paint();
  if (left > 0)
    tick = setInterval(() => {
      left--;
      paint();
      if (left <= 0) stopTick();
    }, 1000);
}
async function resendCode() {
  const err = $("msCodeErr");
  err.hidden = true;
  try {
    st.draft = { ...st.draft, ...(await call("POST", `/v1/rdv/requests/${encodeURIComponent(st.draft.id)}/resend`)) };
    countdown(st.draft.resendInSeconds);
    $("msCodeHelp").firstChild.textContent = "Nouveau code envoyé à ";
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    if (e.data && e.data.retryAfter) countdown(e.data.retryAfter);
  }
}
async function sendCode() {
  const input = $("msCode");
  const code = input.value.replace(/\D/g, "");
  if (code.length !== 6) return fieldErr(input, "Le code compte 6 chiffres.");
  const btn = $("msConfirm");
  const label = btn.firstChild.textContent;
  btn.disabled = true;
  btn.firstChild.textContent = "Envoi…";
  try {
    const out = await call("POST", `/v1/rdv/requests/${encodeURIComponent(st.draft.id)}/code`, { code, ...(st.change ? { day: st.pick.day, time: st.pick.t, ...(st.pick.drop ? { drop: true } : {}) } : {}) });
    stopTick();
    st.done = out;
    st.code = "";
    st.change = false;
    st.stage = "done";
    paintPage();
    window.scrollTo(0, 0);
  } catch (e) {
    btn.disabled = false;
    btn.firstChild.textContent = label;
    if (e.code === "time_taken") {
      st.code = code;
      st.change = true;
      return taken(e);
    }
    fieldErr(input, e.message);
  }
}

// ================================================================ envoyée
function success() {
  const v = st.done;
  const ok = v.status === "confirmed";
  const back = (v.when && (v.when.back || (v.when.mode === "drop" ? v.when.end : ""))) || "";
  const link = new URL(`../rendez-vous/#c=${v.token}`, location.href).href;
  return el(
    "div",
    { class: "wrap" },
    el(
      "section",
      { class: "success-panel", "aria-labelledby": "msDoneTitle" },
      el("div", { class: "success-badge" + (ok ? "" : " pending"), "aria-hidden": "true" }, icon(ok ? "check" : "clock")),
      el("h1", { id: "msDoneTitle", tabindex: "-1", text: ok ? "Votre rendez-vous est confirmé." : "Votre demande est envoyée." }),
      el("p", { class: "intro", text: ok ? `${st.name} a confirmé votre rendez-vous. La confirmation et le fichier d'agenda arrivent par e-mail à ${v.email}.` : `${st.name} répond au plus tard le ${v.deadlineText}. Sa réponse arrive par e-mail à ${v.email}.` }),
      el(
        "div",
        { class: "review-card" },
        el("h2", { text: st.name }),
        el(
          "dl",
          {},
          el("dt", { text: "Rendez-vous" }),
          el("dd", { text: v.when.label + (back ? ` · voiture rendue vers ${back}` : "") }),
          el("dt", { text: "Immatriculation" }),
          el("dd", { text: st.plate }),
          el("dt", { text: "Véhicule" }),
          el("dd", { text: `${st.form.car} · ${st.form.year}` }),
          el("dt", { text: "Prestations" }),
          el("dd", {}, ...v.services.flatMap((s, i) => [i ? el("br") : null, s.label])),
        ),
      ),
      el("p", { class: "status-strip" }, el("b", { text: ok ? "Confirmation immédiate" : "En attente de réponse du garage" }), el("br"), ok ? "Le lien de suivi, dans l'e-mail et ci-dessous, permet aussi d'annuler." : "Sans réponse à l'heure dite, la demande est annulée et vous êtes prévenu par e-mail. Le lien de suivi permet aussi d'annuler."),
      el("div", { class: "success-actions" }, el("a", { class: "ms-btn orange", id: "msTrack", href: link }, ok ? "Voir mon rendez-vous" : "Suivre ma demande", icon("arrow")), el("button", { type: "button", id: "msAgain", onclick: again }, "Prendre un autre rendez-vous")),
    ),
  );
}
function again() {
  Object.assign(st, { picked: [], pick: null, times: null, vehicle: "", notice: "", draft: null, done: null, code: "", change: false, stage: "pick", view: "week", filter: "all", week: monday(today()) });
  paintPage();
  $("msPanelTitle").focus();
}

// ================================================================ l'atelier, les questions
function info() {
  const k = dayKey(today());
  const links = [
    st.phone ? el("a", { href: `tel:${st.phone}` }, icon("phone"), phoneText(st.phone)) : null,
    st.email ? el("a", { href: `mailto:${st.email}` }, icon("mail"), st.email) : null,
    st.website ? el("a", { href: st.website, target: "_blank", rel: "noopener" }, icon("globe"), st.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) : null,
  ].filter(Boolean);
  const dest = [st.name, st.addrLine].filter(Boolean).join(", ");
  return el(
    "section",
    { class: "garage-info wrap", id: "garage-info", tabindex: "-1", "aria-label": "L'atelier" },
    el(
      "article",
      { class: "info-card" },
      el("h2", {}, icon("garage"), "Votre garage"),
      el("p", { text: st.name }),
      st.street ? el("p", { class: "address" }, st.street, el("br"), `${st.pc} ${st.city}`.trim()) : st.addrLine ? el("p", { class: "address", text: st.addrLine }) : null,
      links.length ? el("div", { class: "ms-contact" }, ...links) : null,
      st.addrLine ? el("a", { class: "text-link", href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`, target: "_blank", rel: "noopener" }, "Préparer mon trajet", el("span", { class: "sr-only", text: " (nouvel onglet)" }), icon("arrow")) : null,
    ),
    el(
      "article",
      { class: "info-card" },
      el("h2", {}, icon("clock"), "Les horaires"),
      st.hours
        ? el("div", { class: "hours" }, ...DAYS.map(([key, label]) => el("div", { class: key === k ? "active-day" : "" }, el("span", { text: label }), el("span", { text: (st.hours[key] || []).map(([a, b]) => `${a}–${b}`).join(" / ") || "Fermé" }))))
        : el("p", { text: "Horaires non communiqués : appelez l'atelier." }),
    ),
    el(
      "article",
      { class: "info-card" },
      el("h2", {}, icon("info"), "Avant votre venue"),
      el("div", { class: "info-bullet" }, icon("car"), "L'horaire choisi correspond au dépôt de votre véhicule."),
      el("div", { class: "info-bullet" }, icon("tool"), "La durée et le prix sont confirmés par le garage selon votre véhicule et les travaux."),
      el("div", { class: "info-bullet" }, icon("mail"), "Le garage vous indique par e-mail si votre demande est acceptée ou confirmée."),
    ),
  );
}
function faq() {
  const qa = [
    ["Le créneau affiché est-il adapté à ma prestation ?", "Oui : les horaires proposés tiennent compte de toutes les prestations choisies et de l'agenda de l'atelier. Le garage vérifie ensuite la compatibilité avec votre véhicule."],
    ["Pourquoi l'immatriculation ?", "Elle permet au garage d'identifier précisément votre véhicule (modèle, motorisation) et de préparer l'intervention. Elle ne va qu'à ce garage, pour ce rendez-vous."],
    ["Quand puis-je récupérer mon véhicule ?", "L'heure de fin, quand elle est affichée, est indicative. L'atelier confirme l'heure de restitution selon le diagnostic, les pièces et les travaux."],
    ["Comment modifier ou annuler le rendez-vous ?", "Après l'envoi, vous recevez par e-mail un lien personnel de suivi : il permet d'annuler. Pour changer d'horaire, annulez puis reprenez rendez-vous, ou appelez l'atelier."],
  ];
  return el("section", { class: "faq wrap", "aria-labelledby": "msFaqTitle" }, el("h2", { id: "msFaqTitle", text: "Vos questions, simplement." }), ...qa.map(([q, a]) => el("details", {}, el("summary", { text: q }), el("p", { text: a }))));
}

// ================================================================ en-tête : partager, contacter
let toastTimer = null;
function toast(text) {
  clearTimeout(toastTimer);
  const t = $("msToast");
  t.textContent = text;
  t.hidden = false;
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}
$("msShare").addEventListener("click", async () => {
  const url = location.href.split("#")[0];
  if (navigator.share) {
    try {
      return await navigator.share({ title: document.title, url });
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Lien du mini-site copié.");
  } catch {
    toast(`Adresse du mini-site : ${url}`);
  }
});
// la liste des prestations se ferme avec Échap ou un clic ailleurs
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen()) {
    e.preventDefault();
    closeMenu(true);
  }
});
document.addEventListener("click", (e) => {
  if (menuOpen() && !e.target.closest(".multi-picker") && e.target.id !== "msOpenSvc" && !e.target.closest("#msOpenSvc")) closeMenu(false);
});

load();
