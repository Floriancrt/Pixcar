// Espace Pro d'un garage rattaché : le menu et ses écrans. « Tableau de bord » (home.js, lot 3c) ; Planning (planning.js) ; Demandes
// (rdv.js) ; « Mon garage », en rubriques comme la maquette (24 octobre 2026) : Horaires (garage.js, Disponibilités de rdv.js), Prestations
// (prix annoncés — maquette 5 du 11 octobre 2026 : prix payés par ses clients en lecture seule, visites de sa fiche, prix à confirmer,
// saisie d'un prix avec son aperçu sur Pixcar —, prestations faites), Ressources et Modules (calendrier avancé, calendar.js), Fiche Pixcar.
// L'assistant du mode avancé (calendar.js) reste un écran à part. Que du TEXTE écrit dans la page.
import { INCLUDES, PRICE_KINDS, PRO_SERVICES, VEHICLES, announcedDetail, announcedText, parseProPrice, serviceLabel } from "../shared/pro-prices.js";
import { createGarageView } from "./garage.js";
import { createRdvViews } from "./rdv.js";
import { createCalendarViews } from "./calendar.js";
import { createPlanning } from "./planning.js";
import { createHome } from "./home.js";
import { parisParts } from "../shared/rdv.js";

const LONG = { day: "numeric", month: "long", year: "numeric" };
const DAY_MONTH = { day: "numeric", month: "long" };
const SHORT = { day: "numeric", month: "short" };
const date = (iso, opts = LONG) => new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", ...opts });
const euros = (n) => (Number.isInteger(n) ? String(n) : n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + " €";
const ORDER = new Map(PRO_SERVICES.map((s, i) => [s.id, i]));
const STATE = {
  ok: { cls: "ok", text: (p) => date(p.confirmedAt, SHORT) },
  due: { cls: "due", text: () => "À confirmer" },
  stale: { cls: "stale", text: () => "Ancien sur Pixcar" },
  review: { cls: "review", text: () => "En relecture" },
  rejected: { cls: "stale", text: () => "Refusé" },
};
// Évolution sur les 30 jours d'avant : « +18 % », « −5 % », rien quand il n'y a pas de point de comparaison
const evolution = (v) => (v.previous ? `${v.recent >= v.previous ? "+" : "−"}${Math.abs(Math.round(((v.recent - v.previous) / v.previous) * 100))} %` : "");

export function createDashboard({ api, $, el, icon, alertBox, busy, show, apiProblem, home, roleOf = () => null }) {
  let data = null; // réponse de GET /v1/pro/garages/:id
  let editing = null; // prestation en cours de modification (null : ajout)
  let removeArmed = false;
  const dlg = $("priceDlg");
  const garage = createGarageView({
    api, $, el, icon, alertBox, busy, apiProblem,
    prices: () => (data ? data.prices : []),
    openPrice: (service) => openEditor(service),
    onPricesChanged: async () => {
      data = await api.garage(data.garage.id);
      render();
    },
    onHoursChanged: () => refreshGarage(),
  });

  // rendez-vous en ligne (rdv.js) : présents seulement quand l'API les a ouverts (data.rdv)
  const rdv = createRdvViews({ api, $, el, icon, alertBox, busy, apiProblem, goPanel: (name) => panel(name), onTodo: setTodo });
  // calendrier avancé (calendar.js) : l'assistant (mode simple), puis ses réglages dans Mon garage ; le planning (planning.js) n'existe
  // qu'en mode avancé
  const cal = createCalendarViews({ api, $, el, icon, alertBox, busy, apiProblem, goPanel: (name) => panel(name), onMode: setMode });
  const plan = createPlanning({ api, $, el, icon, alertBox, busy, apiProblem, goPanel: (name) => panel(name) });
  // tableau de bord (lot 3c) : ses liens ouvrent les autres écrans, parfois sur un jour, une fiche ou un formulaire
  const board = createHome({ api, $, el, icon, alertBox, busy, apiProblem, goPanel: (name, opts) => panel(name, opts), decline: (id, r, done) => rdv.decline(id, r, done), onTodo: (n) => setTodo(n) });
  // mode avancé : « Planning » apparaît ; Mon garage montre les ressources et les modules actifs
  let mode = "simple";
  function setMode(m) {
    mode = m === "advanced" && !!(data && data.rdv) ? "advanced" : "simple";
    const adv = mode === "advanced";
    for (const b of document.querySelectorAll(".dash-link[data-adv]")) b.hidden = !adv;
    $("dashNav").classList.toggle("is-adv", adv);
    $("mgResSimple").hidden = adv;
    modules();
  }
  function setTodo(n) {
    const c = $("rqCount");
    c.hidden = !n;
    c.textContent = n ? String(n) : "";
    c.setAttribute("aria-label", `${n} à traiter`);
  }

  // ---- chargement et rendu
  async function open(garageId, { focus = true } = {}) {
    alertBox("");
    show("loading", { focus: false });
    try {
      data = await api.garage(garageId);
    } catch (e) {
      if (!apiProblem(e)) home();
      return;
    }
    rdv.reset();
    cal.reset();
    plan.reset();
    const on = !!data.rdv;
    for (const b of document.querySelectorAll(".dash-link[data-rdv], #dash-garage [data-rdv]")) b.hidden = !on;
    tab = "hours";
    $("dashNav").classList.toggle("has-rdv", on);
    $("dashMore").hidden = !on;
    setTodo(on ? data.rdv.todo : 0);
    setMode(on ? data.rdv.mode : "simple");
    profile();
    render();
    await panel("top", { focus: false });
    show("dash", { focus });
  }

  // ---- écrans : « Tableau de bord », « Planning », « Demandes », « Mon garage » (et l'assistant du mode avancé). opts (depuis le
  // tableau de bord) : planning { day, item, form: { kind, arrived } }, garage { tab, closure, add } ; le formulaire ou la fiche s'ouvre
  // une fois l'écran affiché. Les anciens écrans regroupés dans Mon garage gardent leur nom : « prices » (Prestations), « agenda »
  // (Horaires) et, en mode avancé, « calendar » (Ressources).
  const BODIES = { top: "dash-top", garage: "dash-garage", requests: "dash-requests", calendar: "dash-calendar", planning: "dash-planning" };
  const TITLES = { top: "dashTitle", garage: "mgTitle", requests: "rqTitle", calendar: "calTitle", planning: "planTitle" };
  const ALIASES = { prices: "services", agenda: "hours" };
  // coque de la maquette : la carte du garage et celle de l'utilisateur (nom, fonction, initiales) dans la barre latérale
  const ROLES = { manager: "Gérant(e)", employee: "Salarié(e)" };
  function profile() {
    const name = String(data.garage.holderName || "").trim();
    $("navGarage").textContent = data.garage.name || "Mon garage";
    $("navName").textContent = name || "Mon compte";
    $("navRole").textContent = ROLES[roleOf(data.garage.id)] || "Espace professionnel";
    $("navInitials").textContent = name ? name.split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("") : "PRO";
  }
  // fil d'Ariane (en-tête de l'atelier) ; Mon garage ajoute sa rubrique (maquette : « Mon atelier / Mon garage / Modules »)
  const CRUMBS = { top: "Mon atelier / Tableau de bord", planning: "Mon atelier / Gestion d'atelier", requests: "Mon atelier / Demandes", garage: "Mon atelier / Mon garage", calendar: "Mon atelier / Mon garage / Mode avancé" };
  // Au clic, l'écran change tout de suite (menu, fil d'Ariane, rubrique) et se remplit dès que ses données arrivent, une barre fine en
  // haut le disant pendant ce temps (demande du 25 octobre 2026 : un « délai de latence » au clic dans la barre latérale). Un écran
  // jamais rempli pour ce garage reste masqué jusque-là ; un écran déjà vu garde son contenu le temps de la mise à jour. La réponse
  // d'un écran quitté entre-temps ne déplace ni le focus ni rien d'autre.
  let seq = 0;
  const filled = new Map(); // écran → garage pour lequel il a déjà été rempli
  function busyState(body, on, first = false) {
    if (on) body.setAttribute("aria-busy", "true");
    else body.removeAttribute("aria-busy");
    body.classList.toggle("is-first", on && first);
    $("dashBusy").hidden = !on;
  }
  async function panel(name, { focus = true, ...opts } = {}) {
    if (ALIASES[name]) return panel("garage", { focus, ...opts, tab: ALIASES[name] });
    if (name === "calendar" && mode === "advanced") return panel("garage", { focus, ...opts, tab: opts.tab || "resources" });
    const n = ++seq;
    more(false);
    alertBox("");
    const body = $(BODIES[name]);
    for (const id of new Set(Object.values(BODIES))) {
      $(id).hidden = id !== BODIES[name];
      if (id !== BODIES[name]) busyState($(id), false);
    }
    $("crumb").textContent = CRUMBS[name];
    if (name === "garage") showTab(opts.tab || tab);
    for (const b of document.querySelectorAll(".dash-link[data-panel]")) {
      if (b.dataset.panel === (name === "calendar" ? "garage" : name)) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    window.scrollTo(0, 0);
    busyState(body, true, filled.get(name) !== data.garage.id);
    try {
      if (name === "top") await board.open(data, { focus: false });
      if (name === "garage") await openGarage();
      if (name === "requests") await rdv.openRequests(data.garage.id, { focus: false });
      if (name === "calendar") await cal.open(data.garage.id, { focus: false });
      if (name === "planning") await (opts.day || opts.item || opts.form ? plan.openDay(data.garage.id, opts.day || parisParts(Date.now()).iso) : plan.open(data.garage.id, { focus: false, space: opts.space || null }));
    } catch (e) {
      if (n === seq) busyState(body, false);
      if (!apiProblem(e)) alertBox(e.message);
      return;
    }
    if (n !== seq) return; // un autre écran a été demandé entre-temps
    filled.set(name, data.garage.id);
    busyState(body, false);
    if (name === "planning" && opts.item && plan.showItem(opts.item)) return;
    if (name === "planning" && opts.form) return plan.form(opts.form.kind, opts.form);
    if (name === "garage" && opts.closure) return $("agAddClosure").click();
    if (name === "garage" && opts.add) return openEditor(null);
    if (focus) $(TITLES[name]).focus();
  }

  // ---- Mon garage (maquette « Mon garage ») : en-tête, carte de l'établissement, rubriques en onglets verticaux (en ligne sur téléphone)
  const TABS = { hours: "Horaires", services: "Prestations", resources: "Ressources", modules: "Modules", profile: "Fiche Pixcar" };
  let tab = "hours";
  // tout est chargé à l'ouverture : passer d'une rubrique à l'autre est immédiat
  async function openGarage() {
    const id = data.garage.id;
    identity();
    modules();
    // la fiche, les disponibilités et le calendrier avancé en même temps
    await Promise.all([garage.open(id, { verifiedAt: data.garage.verifiedAt }), data.rdv ? rdv.openAgenda(id, { focus: false }) : null, data.rdv ? mountCal() : null]);
  }
  // en mode avancé, délais et capacité (Horaires), exigences des prestations (Prestations), mécaniciens et postes (Ressources),
  // contrôles (Modules) viennent du calendrier avancé
  async function mountCal() {
    if (mode === "advanced") await cal.mount(data.garage.id, { hours: $("mgCalHours"), services: $("mgCalServices"), resources: $("mgCalResources"), modules: $("mgCalModules") });
    else cal.unmount();
  }
  // horaires d'ouverture changés : la semaine type et le calendrier avancé, dans la même rubrique, en dépendent
  async function refreshGarage() {
    if (!data.rdv) return;
    try {
      await rdv.openAgenda(data.garage.id, { focus: false });
      if (mode === "advanced") await mountCal();
    } catch (e) {
      if (!apiProblem(e)) alertBox(e.message);
    }
  }
  function identity() {
    const name = String(data.garage.holderName || "").trim();
    const role = ROLES[roleOf(data.garage.id)];
    $("mgIdName").textContent = data.garage.name || "Mon garage";
    $("mgIdSub").textContent = ["Espace professionnel", [name, role && role.toLowerCase()].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    $("mgScope").textContent = data.rdv ? "Paramètres communs aux modes Simple et Avancé" : "Les informations de votre fiche Pixcar et vos prix";
  }
  // les modules de l'affichage avancé de Gestion d'atelier (docs/gestion-atelier.md, 2.1) : un interrupteur chacun, pour tout le garage.
  // Couper un module masque son espace ; ses données restent. Dépendances : mécaniciens et équipements servent au calcul par
  // ressources (on ne les coupe qu'après être revenu au calcul par créneaux) ; la charge demande l'un des deux ; les analyses attendent
  // les temps réellement passés.
  const MODULES = [
    ["staff", "Mécaniciens", "Planning de l'équipe : horaires, absences, compétences, affectations et charge de chacun.", "team"],
    ["equip", "Ponts et équipements", "Planning des postes : occupation, maintenances, conflits.", "equip"],
    ["track", "Suivi des interventions", "Avancement des travaux par état, retards, attentes de pièces.", "track"],
    ["load", "Charge et capacité", "Heures disponibles, planifiées et restantes ; mécaniciens et postes comptés à part.", "load"],
    ["stats", "Analyses", "Durées réelles, écarts, rendez-vous honorés, répartition par canal.", null],
  ];
  const modulesOf = () => ({ staff: true, equip: true, track: true, load: true, stats: false, ...((data && data.rdv && data.rdv.modules) || {}) });
  let armed = null; // module dont la désactivation attend sa confirmation
  function moduleRule(key, on, m) {
    const byRes = mode === "advanced";
    if (key === "stats") return { locked: true, why: "Prochainement : il faut d'abord noter les heures réelles de début et de fin des travaux." };
    if ((key === "staff" || key === "equip") && on && byRes) return { locked: true, why: "Utilisé par le calcul de vos disponibilités en ligne : revenez d'abord au calcul par créneaux pour le couper." };
    if (key === "load" && !on && !m.staff && !m.equip) return { locked: true, why: "Demande le module Mécaniciens ou Ponts et équipements." };
    return { locked: false, why: "" };
  }
  function modules() {
    const m = modulesOf();
    $("mgModules").replaceChildren(
      ...MODULES.map(([key, name, text, space]) => {
        const on = !!m[key];
        const rule = moduleRule(key, on, m);
        const id = `mgMod-${key}`;
        const sw = el("button", { type: "button", role: "switch", class: "mg-switch", id, "aria-checked": String(on), "aria-describedby": `${id}-d`, disabled: rule.locked, onclick: () => toggleModule(key, !on) }, el("span", { class: "sr-only", text: name }));
        return el(
          "li",
          { class: `mg-module${on ? " is-on" : ""}${armed === key ? " is-armed" : ""}` },
          el("div", {}, el("b", { text: name }), el("small", { id: `${id}-d`, text: rule.why ? `${text} ${rule.why}` : text })),
          el("span", { class: `pill ${on ? "ok" : "off"}`, text: key === "stats" ? "Bientôt" : on ? "Actif" : "Inactif" }),
          sw,
          armed === key
            ? el(
                "div",
                { class: "mg-mod-ask", role: "alert" },
                el("p", { text: `Couper « ${name} » masque son espace dans l'affichage avancé. Rien n'est effacé ; vous pourrez le réactiver.` }),
                el("button", { type: "button", class: "btn small danger", onclick: () => toggleModule(key, false, true) }, "Couper le module"),
                el("button", { type: "button", class: "btn small", onclick: () => ((armed = null), modules(), $(id).focus()) }, "Garder"),
              )
            : on && space && data && data.rdv
              ? el("button", { type: "button", class: "link-btn mg-mod-go", onclick: () => panel("planning", { space }) }, "Ouvrir")
              : null,
        );
      }),
    );
  }
  async function toggleModule(key, on, confirmed = false) {
    if (!on && !confirmed) {
      armed = key;
      modules();
      return;
    }
    armed = null;
    try {
      const out = await api.calSettings(data.garage.id, { modules: { ...modulesOf(), [key]: on } });
      data.rdv.modules = out.modules;
      plan.reset();
      modules();
      alertBox(on ? "Module activé." : "Module coupé : ses données restent enregistrées.", "info");
      $(`mgMod-${key}`).focus();
    } catch (e) {
      modules();
      if (!apiProblem(e)) alertBox(e.message);
    }
  }
  const tabButtons = () => [...document.querySelectorAll("#mgTabs [role=tab]")].filter((t) => !t.hidden);
  function showTab(name, { focus = false } = {}) {
    if (!TABS[name] || $(`mgTab-${name}`).hidden) name = "hours";
    tab = name;
    for (const t of document.querySelectorAll("#mgTabs [role=tab]")) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(`mgPanel-${t.dataset.tab}`).hidden = !on;
    }
    $("crumb").textContent = `${CRUMBS.garage} / ${TABS[name]}`;
    if (focus) $(`mgTab-${name}`).focus();
  }
  $("mgTabs").addEventListener("click", (ev) => {
    const t = ev.target.closest("[role=tab]");
    if (t) showTab(t.dataset.tab);
  });
  // clavier (motif « onglets » de l'ARIA) : flèches haut et bas (gauche et droite sur téléphone, où les onglets sont en ligne), début, fin
  $("mgTabs").addEventListener("keydown", (ev) => {
    const list = tabButtons();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    showTab(list[(next + list.length) % list.length].dataset.tab, { focus: true });
  });
  for (const b of document.querySelectorAll("[data-mg-tab]")) b.addEventListener("click", () => showTab(b.dataset.mgTab, { focus: true }));
  // « Retour à l'atelier » : la gestion d'atelier quand les rendez-vous en ligne sont ouverts, sinon le tableau de bord
  $("mgBack").addEventListener("click", () => panel(data && data.rdv ? "planning" : "top"));
  // ordinateur : barre latérale dépliée (libellés) ou repliée (icônes, libellé en infobulle) ; le choix est gardé dans ce navigateur
  const RAIL = "pixcar-pro-rail";
  function rail(min, { save = false } = {}) {
    document.body.classList.toggle("rail-min", min);
    const t = $("dashRail");
    t.setAttribute("aria-expanded", String(!min));
    $("dashRailText").textContent = min ? "Déplier le menu" : "Replier le menu";
    for (const b of document.querySelectorAll("#dashNav .dash-link")) {
      const label = b.querySelector("span:not(.dash-count):not(.narrow-only)");
      if (min && label) b.title = label.textContent.trim();
      else b.removeAttribute("title");
    }
    if (save)
      try {
        localStorage.setItem(RAIL, min ? "min" : "full");
      } catch {
        // stockage refusé (navigation privée…) : le choix vaut pour cette visite
      }
  }
  let railMin = false;
  try {
    railMin = localStorage.getItem(RAIL) === "min";
  } catch {
    railMin = false;
  }
  rail(railMin);
  $("dashRail").addEventListener("click", () => rail(!document.body.classList.contains("rail-min"), { save: true }));

  // téléphone, avec les rendez-vous : « Plus » ouvre Mon garage et Mes garages au-dessus de la barre du bas
  function more(open) {
    $("dashNav").classList.toggle("more-open", open);
    $("dashMore").setAttribute("aria-expanded", String(open));
  }

  // prix annoncés (Mon garage › Prestations), et le nombre de prix à confirmer dans le menu et sur la rubrique
  function render() {
    const prices = data.prices.slice().sort((a, b) => (ORDER.get(a.service) ?? 99) - (ORDER.get(b.service) ?? 99));
    const due = prices.filter((p) => p.state === "due");
    const stale = prices.filter((p) => p.state === "stale");
    const toConfirm = due.length + stale.length;
    $("dashDue").hidden = !toConfirm;
    if (stale.length) {
      $("dashDueTitle").textContent = `${stale.length} prix marqué${stale.length > 1 ? "s" : ""} « ancien » sur Pixcar${due.length ? `, ${due.length} autre${due.length > 1 ? "s" : ""} à confirmer` : ""}`;
      $("dashDueText").textContent = "Confirmez-les s'ils n'ont pas changé : un clic suffit.";
    } else if (due.length) {
      const first = due.reduce((m, p) => (p.staleAt < m ? p.staleAt : m), due[0].staleAt);
      $("dashDueTitle").textContent = `${due.length} prix à confirmer avant le ${date(first, DAY_MONTH)}`;
      $("dashDueText").textContent = "Sans confirmation, ils seront marqués « ancien » sur Pixcar. Un clic suffit s'ils n'ont pas changé.";
    }
    for (const count of [$("dashDueCount"), $("mgDueCount")]) {
      count.hidden = !toConfirm;
      count.textContent = toConfirm ? String(toConfirm) : "";
      count.setAttribute("aria-label", `${toConfirm} à confirmer`);
    }

    // chiffres
    const v = data.visits;
    $("statViews").textContent = String(v.views.recent);
    $("statViewsDelta").textContent = evolution(v.views);
    $("statViewsDelta").classList.toggle("down", v.views.recent < v.views.previous);
    $("statCalls").textContent = String(v.calls.recent);
    $("statCallsDelta").textContent = evolution(v.calls);
    $("statCallsDelta").classList.toggle("down", v.calls.recent < v.calls.previous);
    const live = prices.filter((p) => p.status !== "rejected");
    $("statFresh").textContent = live.length ? `${live.filter((p) => p.state === "ok").length} / ${live.length}` : "—";
    const pairs = prices.filter((p) => p.price !== null && data.paid[p.service]);
    if (pairs.length) {
      const gap = Math.round((pairs.reduce((s, p) => s + (data.paid[p.service].median - p.price) / p.price, 0) / pairs.length) * 100);
      $("statPaid").textContent = `${gap > 0 ? "+" : gap < 0 ? "−" : ""}${Math.abs(gap)} %`;
      $("statPaidNote").textContent = "par rapport à vos prix";
    } else {
      $("statPaid").textContent = "—";
      $("statPaidNote").textContent = "pas encore de comparaison";
    }

    // mes prix
    $("noPrice").hidden = prices.length > 0;
    $("priceTable").hidden = !prices.length;
    const rows = $("priceRows");
    rows.replaceChildren();
    for (const p of prices) {
      const paid = data.paid[p.service];
      const st = STATE[p.state] || STATE.ok;
      const kind = PRICE_KINDS.find((k) => k.id === p.kind);
      const inc = INCLUDES.filter((i) => p.includes.includes(i.id)).map((i, n) => (n ? i.label.toLowerCase() : i.label));
      rows.append(
        el(
          "tr",
          { class: "st-" + st.cls },
          el("th", { scope: "row", "data-l": "Prestation" }, serviceLabel(p.service)),
          el("td", { class: "c-kind", "data-l": "Type" }, kind ? kind.label : p.kind),
          el("td", { class: "c-price", "data-l": "Prix TTC" }, p.price === null ? "—" : euros(p.price)),
          el("td", { class: "c-inc", "data-l": "Inclus" }, inc.length ? inc.join(" + ") : "—"),
          el(
            "td",
            { class: "c-paid", "data-l": "Payé par vos clients" },
            paid ? el("span", {}, el("b", { text: euros(paid.median) }), el("small", { text: ` médiane · ${paid.n}` })) : el("span", { class: "muted", text: "Pas encore de déclaration" }),
          ),
          el("td", { class: "c-state", "data-l": "Mis à jour" }, el("span", { class: "state " + st.cls, text: st.text(p) })),
          el("td", { class: "c-act" }, el("button", { type: "button", class: "btn small", "aria-label": `Modifier : ${serviceLabel(p.service)}`, onclick: () => openEditor(p.service) }, icon("i-edit"), "Modifier")),
        ),
      );
    }
    $("addPrice").disabled = PRO_SERVICES.every((s) => prices.some((p) => p.service === s.id));
  }

  // ---- « Tout confirmer »
  async function confirmAll() {
    await busy($("confirmAll"), async () => {
      try {
        const out = await api.confirm(data.garage.id);
        data = await api.garage(data.garage.id);
        render();
        alertBox(out.confirmed > 1 ? `${out.confirmed} prix confirmés pour 6 mois.` : "Prix confirmé pour 6 mois.", "info");
      } catch (e) {
        if (!apiProblem(e)) alertBox(e.message);
      }
    });
  }

  // ---- saisie d'un prix
  const kindOf = () => (document.querySelector('#priceForm input[name="kind"]:checked') || {}).value || "fixed";
  const checked = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);
  const priceNumber = () => {
    const raw = $("priceValue").value.replace(/\s| /g, "").replace(",", ".").replace(/€$/, "");
    return raw === "" ? NaN : Number(raw);
  };
  function formBody() {
    const kind = kindOf();
    const body = { kind, vehicles: checked($("priceVehicles")), includes: checked($("priceIncludes")) };
    if (kind !== "quote") body.price = priceNumber();
    return body;
  }
  function updatePreview() {
    const kind = kindOf();
    $("priceBox").hidden = kind === "quote";
    const n = priceNumber();
    $("previewPrice").textContent = kind === "quote" ? "Sur devis" : Number.isFinite(n) && n > 0 ? announcedText(kind, Math.round(n * 100) / 100) : "— €";
    $("previewDetail").textContent = announcedDetail(kind, checked($("priceIncludes")));
  }

  function buildChoices() {
    const veh = $("priceVehicles");
    for (const v of VEHICLES) veh.append(el("label", { class: "chip" }, el("input", { type: "checkbox", name: "veh", value: v.id }), el("span", { text: v.label })));
    const inc = $("priceIncludes");
    for (const i of INCLUDES) inc.append(el("label", { class: "check" }, el("input", { type: "checkbox", name: "inc", value: i.id }), el("span", { text: i.label })));
    const groups = new Map();
    for (const s of PRO_SERVICES) (groups.get(s.g) || groups.set(s.g, []).get(s.g)).push(s);
    const sel = $("priceService");
    for (const [g, list] of groups) sel.append(el("optgroup", { label: g }, ...list.map((s) => el("option", { value: s.id, text: s.label }))));
  }

  // serviceId : prix à modifier, ou prestation choisie d'avance (« Annoncer un prix » dans Mon garage) ; null : ajout libre
  function openEditor(serviceId) {
    alertBox("");
    editing = serviceId;
    removeArmed = false;
    const p = serviceId ? data.prices.find((x) => x.service === serviceId) : null;
    $("priceDlgKind").textContent = p ? "Modifier un prix" : serviceId ? "Annoncer un prix" : "Ajouter une prestation";
    $("priceDlgTitle").textContent = serviceId ? serviceLabel(serviceId) : "Nouvelle prestation";
    $("pickService").hidden = !!serviceId;
    if (!serviceId) {
      const taken = new Set(data.prices.map((x) => x.service));
      let first = null;
      for (const o of $("priceService").querySelectorAll("option")) {
        o.disabled = taken.has(o.value);
        if (!o.disabled && !first) first = o;
      }
      if (first) $("priceService").value = first.value;
    }
    for (const r of document.querySelectorAll('#priceForm input[name="kind"]')) r.checked = r.value === (p ? p.kind : "fixed");
    $("priceValue").value = p && p.price !== null ? String(p.price).replace(".", ",") : "";
    for (const c of $("priceVehicles").querySelectorAll("input")) c.checked = !p || !p.vehicles.length || p.vehicles.includes(c.value);
    for (const c of $("priceIncludes").querySelectorAll("input")) c.checked = p ? p.includes.includes(c.value) : c.value !== "extras";
    $("priceDelete").hidden = !p;
    $("priceDelete").textContent = "Retirer ce prix";
    $("priceErr").hidden = true;
    $("priceValue").removeAttribute("aria-invalid");
    updatePreview();
    dlg.showModal();
    (serviceId ? $("priceValue") : $("priceService")).focus();
  }

  async function savePrice(ev) {
    ev.preventDefault();
    const service = editing || $("priceService").value;
    const body = formBody();
    const parsed = parseProPrice(service, body);
    const err = $("priceErr");
    if (parsed.error) {
      err.textContent = parsed.error;
      err.hidden = false;
      if (parsed.field === "price") {
        $("priceValue").setAttribute("aria-invalid", "true");
        $("priceValue").focus();
      }
      return;
    }
    err.hidden = true;
    $("priceValue").removeAttribute("aria-invalid");
    await busy($("priceSave"), async () => {
      try {
        const saved = await api.putPrice(data.garage.id, service, body);
        data.prices = data.prices.filter((x) => x.service !== service).concat(saved);
        dlg.close();
        render();
        garage.refresh(); // la prestation est maintenant cochée dans « Mon garage »
        alertBox(
          saved.status === "review"
            ? `${serviceLabel(service)} : prix enregistré. Il est très éloigné des prix payés dans le secteur ; nous le relisons avant de le publier.`
            : `${serviceLabel(service)} : prix enregistré, visible sur Pixcar.`,
          "info",
        );
      } catch (e) {
        if (e.status === 401) {
          dlg.close();
          return apiProblem(e);
        }
        err.textContent = e.message;
        err.hidden = false;
      }
    });
  }

  async function removePrice() {
    const btn = $("priceDelete");
    if (!removeArmed) {
      removeArmed = true;
      btn.textContent = "Confirmer : retirer ce prix de Pixcar";
      return;
    }
    await busy(btn, async () => {
      try {
        await api.deletePrice(data.garage.id, editing);
        data.prices = data.prices.filter((x) => x.service !== editing);
        dlg.close();
        render();
        garage.refresh();
        alertBox(`${serviceLabel(editing)} : prix retiré.`, "info");
      } catch (e) {
        if (e.status === 401) {
          dlg.close();
          return apiProblem(e);
        }
        $("priceErr").textContent = e.message;
        $("priceErr").hidden = false;
      }
    });
  }

  // ---- branchements
  buildChoices();
  $("priceForm").addEventListener("submit", savePrice);
  $("priceForm").addEventListener("input", updatePreview);
  $("priceForm").addEventListener("change", updatePreview);
  $("priceClose").addEventListener("click", () => dlg.close());
  $("priceDelete").addEventListener("click", removePrice);
  $("addPrice").addEventListener("click", () => openEditor(null));
  $("confirmAll").addEventListener("click", confirmAll);
  for (const b of document.querySelectorAll(".dash-link[data-panel]")) b.addEventListener("click", () => panel(b.dataset.panel));
  $("calBack").addEventListener("click", () => panel("garage", { tab: "modules" }));
  $("dashMore").addEventListener("click", () => more($("dashMore").getAttribute("aria-expanded") !== "true"));
  $("dashNav").addEventListener("keydown", (e) => e.key === "Escape" && more(false));
  $("priceValue").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^\d,.\s]/g, "");
    e.target.removeAttribute("aria-invalid"); // l'erreur affichée ne vaut plus pour ce qui est en cours de saisie
    $("priceErr").hidden = true;
  });

  return { open };
}
