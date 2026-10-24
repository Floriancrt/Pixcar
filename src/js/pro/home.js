// Espace Pro, tableau de bord (docs/calendrier-avance.md, « Lot 3c »), d'après la maquette de l'utilisateur du 19 octobre 2026 : cinq
// chiffres du jour, l'atelier aujourd'hui (état de chaque intervention et ses actions), actions rapides, demandes à traiter, équipe et
// charge, postes et équipements, points d'attention, raccourcis personnalisables. Trois formes selon le garage : mode avancé (tout),
// mode simple (rendez-vous sans ressources), sans rendez-vous en ligne (prix et visites). Les chiffres viennent des routes existantes et
// des mêmes calculs que le Planning (workshop.js). Que du TEXTE écrit dans la page.
import { addDays, dayLabel, minOf, parisParts, timeLabel } from "../shared/rdv.js";
import { MAX_SHORTCUTS, SHORTCUTS, WORK_LIVE, workActions, workLabel } from "../shared/work.js";
import * as K from "./workshop.js";

const SHORT_ICON = { planning: "i-planning", requests: "i-inbox", prices: "i-tag", agenda: "i-calendar", garage: "i-garage", team: "i-users", new: "i-plus", closure: "i-lock", site: "i-eye" };
const RES_ICON = { lift: "i-car", quick: "i-wrench", tyre: "i-tyre", diag: "i-screen", align: "i-gauge", clim: "i-gauge", other: "i-wrench" };
// pastille d'état d'une ligne du jour : [libellé, icône, ton]
const CHIP = {
  pending: ["À confirmer", "i-clock", "amber"],
  planned: ["Prévue", "i-clock", "grey"],
  received: ["Voiture reçue", "i-car", "blue"],
  in_progress: ["En cours", "i-wrench", "blue"],
  waiting_parts: ["Attente pièces", "i-clock", "amber"],
  suspended: ["Suspendue", "i-clock", "amber"],
  done: ["Prête", "i-check", "green"],
  returned: ["Restituée", "i-check", "grey"],
  no_show: ["Client absent", "i-user", "grey"],
  confirmed: ["Confirmé", "i-check", "green"],
};
const FILTERS = { expected: "Véhicules attendus", live: "Interventions en cours", ready: "Véhicules prêts" };
const TONE_ORDER = { red: 0, amber: 1, blue: 2 };
const ALERTS_SHOWN = 4;
const LATE_MIN = 15; // voiture pas arrivée 15 minutes après l'heure de dépôt
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const hrs = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : m > 0 ? `${Math.round(m)} min` : "0 h");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
const svcLine = (services) => services.map((s) => s.label).join(" + ");
const evolution = (v) => (v.previous ? `${v.recent >= v.previous ? "+" : "−"}${Math.abs(Math.round(((v.recent - v.previous) / v.previous) * 100))} % sur 30 jours` : "");

export function createHome({ api, $, el, icon, alertBox, busy, apiProblem, goPanel, decline, onTodo }) {
  let g = null; // réponse de GET /v1/pro/garages/:id
  let mode = "none"; // advanced | simple | none
  let ag = null, st = null, todo = [], upcoming = [], rdvState = null;
  let filter = null; // expected | live | ready : la liste du jour filtrée par un chiffre
  let allAlerts = false;
  let loading = 0;
  const id = () => g.garage.id;
  const nowP = () => parisParts(Date.now());
  const today = () => (ag ? ag.today : nowP().iso);
  const fail = (e) => {
    if (!apiProblem(e)) alertBox(e.message);
  };
  const live = (text) => ($("dbLive").textContent = text);

  // ================================================================= chargement
  async function open(garageData, { focus = true } = {}) {
    g = garageData;
    filter = null;
    allAlerts = false;
    await load();
    if (focus) $("dashTitle").focus();
  }
  async function load() {
    const on = !!g.rdv;
    mode = on ? (g.rdv.mode === "advanced" ? "advanced" : "simple") : "none";
    const t = nowP().iso, n = ++loading;
    const adv = mode === "advanced";
    try {
      const [a, s, td, up, rs] = await Promise.all([
        adv ? api.calAgenda(id(), t, addDays(t, 1)) : null,
        adv ? api.calendar(id()) : null,
        on ? api.requests(id(), "todo") : null,
        on && !adv ? api.requests(id(), "upcoming") : null,
        on && !adv ? api.agenda(id()) : null,
      ]);
      if (n !== loading) return;
      [ag, st, todo, upcoming, rdvState] = [a, s, td ? td.requests || [] : [], up ? up.requests || [] : [], rs];
    } catch (e) {
      if (n !== loading) return;
      [ag, st, todo, upcoming, rdvState] = [null, null, [], [], null];
      if (mode !== "none") mode = "simple";
      fail(e);
    }
    if (on) onTodo(todo.length);
    render();
  }
  // après une action : rechargé, le focus revient sur la ligne (ou le premier bouton) concernée
  async function reload(message, focusId = null) {
    await load();
    if (message) live(message);
    const target = focusId && document.querySelector(`#dbList [data-id="${focusId}"] .db-more-btn`);
    if (target) target.focus();
  }

  // ================================================================= ce qui est compté
  // rendez-vous et blocs du jour (sans les créneaux bloqués), dans l'ordre de l'heure de dépôt
  function dayItems() {
    if (mode === "advanced" && ag) {
      const deadlines = new Map(todo.map((r) => [r.id, Date.parse(r.deadline)]));
      return K.itemsOf(ag, deadlines).filter((it) => it.day === today() && it.type !== "hold").sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
    }
    if (mode === "simple") {
      const mk = (r, state) => ({
        id: r.id, type: "rdv", origin: "pixcar", state, day: r.when.day, start: minOf(r.when.start), end: minOf(r.when.end || r.when.start), title: r.client.name || "Client",
        services: r.services, plan: [], work: null, noShow: false, deadline: Date.parse(r.deadline) || null, src: { car: r.client.car, plate: r.client.plate },
      });
      const t = today();
      return [...upcoming.filter((r) => r.when.day === t && r.status === "confirmed").map((r) => mk(r, "confirmed")), ...todo.filter((r) => r.when.day === t).map((r) => mk(r, "pending"))].sort((a, b) => a.start - b.start);
    }
    return [];
  }
  const all = () => (mode === "advanced" && ag ? K.itemsOf(ag) : []);
  const chipOf = (it) => (it.state === "pending" ? "pending" : it.work ? it.work : "confirmed");
  const carOf = (it) => {
    if (it.type === "rdv") return [it.src.car, it.src.plate].filter(Boolean).join(" · ");
    const v = it.src.vehicle && ag ? (ag.vehicles.find((x) => x.id === it.src.vehicle) || { label: "" }).label : "";
    return v ? `${v} · hors Pixcar` : "Hors Pixcar";
  };
  // heure à laquelle la voiture devait être prête : celle de l'intervention, sinon la fin des affectations du jour
  function readyAt(it) {
    if (it.type === "rdv" && it.src.work && it.src.work.ready) {
      const p = parisParts(Date.parse(it.src.work.ready));
      return p.iso === it.day ? p.min : 1440;
    }
    const rows = it.plan.filter((r) => r.day === it.day);
    return rows.length ? Math.max(...rows.map((r) => r.b)) : it.end;
  }
  const started = (it) => it.day < today() || nowP().min >= it.start;
  // deuxième ligne d'une prestation seule : la main-d'œuvre prévue, sinon la restitution
  function workText(it) {
    const rows = it.plan.filter((r) => r.target === "staff" && r.role === "labour" && r.day === it.day);
    if (rows.length) return `Travaux ${timeLabel(Math.min(...rows.map((r) => r.a)))}–${timeLabel(Math.max(...rows.map((r) => r.b)))}`;
    return it.end > it.start ? `Restitution vers ${timeLabel(it.end)}` : "";
  }

  function counts() {
    const items = dayItems();
    const expected = items.filter((it) => !it.noShow);
    const live = expected.filter((it) => WORK_LIVE.includes(it.work));
    const ready = expected.filter((it) => it.work === "done");
    const toReceive = expected.filter((it) => it.state === "confirmed" && it.work === "planned");
    return { items, expected, live, ready, toReceive, pending: expected.filter((it) => it.state === "pending"), off: expected.filter((it) => it.type === "job") };
  }
  // heures de main-d'œuvre encore libres aujourd'hui, à partir de maintenant, pour les mécaniciens qui travaillent
  function capacity() {
    const t = today(), list = all();
    const from = nowP().iso === t ? nowP().min : 0;
    let free = 0;
    for (const m of ag.staff.filter((x) => x.active)) {
      const avail = K.inter(K.workOf(ag, st, m, t), [[from, 1440]]);
      free += K.total(K.minus(avail, K.rowsOn(list, "staff", m.id, t, "labour")));
    }
    return free;
  }

  // ================================================================= points d'attention, les plus urgents d'abord
  function points() {
    const out = [];
    const t = today(), now = nowP();
    const pricesDue = g.prices.filter((p) => p.state === "due" || p.state === "stale");
    if (mode === "advanced" && ag) {
      const items = all();
      for (const c of ag.conflicts) {
        const it = items.find((x) => x.id === c.id);
        out.push({ tone: "red", icon: "i-flag", title: it ? `En conflit : ${it.title}` : "Rendez-vous en conflit", sub: c.reasons[0] || "Une affectation ne tient plus.", go: () => goPanel("planning", it ? { day: it.day, item: it.id } : {}) });
      }
      for (const it of dayItems()) {
        if (it.noShow || it.state !== "confirmed") continue;
        if (it.work === "planned" && it.day === t && now.min >= it.start + LATE_MIN)
          out.push({ tone: "amber", icon: "i-car", title: `Voiture pas arrivée : ${it.title}`, sub: `Attendue à ${timeLabel(it.start)}. « Voiture reçue » ou « Client absent » dans ses actions.`, go: () => focusRow(it.id) });
        if (WORK_LIVE.includes(it.work) && it.day === t && now.min > readyAt(it))
          out.push({ tone: "red", icon: "i-clock", title: `Pas prête à l'heure : ${it.title}`, sub: `Prévue à ${timeLabel(readyAt(it))}. Prévenez le client si besoin.`, go: () => focusRow(it.id) });
      }
      for (const p of (st && st.readiness && st.readiness.problems) || []) {
        const [label, ...rest] = p.text.split(" : ");
        out.push({ tone: p.blocking ? "red" : "amber", icon: "i-alert", title: rest.length ? `${label} non planifiable` : p.text, sub: rest.length ? cap(rest.join(" : ")) : "Rendez-vous en ligne arrêtés tant que ce n'est pas réglé.", go: () => goPanel("calendar") });
      }
      const tomorrow = addDays(t, 1);
      for (const u of ag.unavail.filter((x) => x.first <= tomorrow && tomorrow <= x.last)) {
        const staff = u.target === "staff";
        const from = u.first === tomorrow && u.from ? u.from : "", to = u.last === tomorrow && u.to ? u.to : "";
        const when = from || to ? `De ${timeLabel(minOf(from || "00:00"))} à ${to ? timeLabel(minOf(to)) : "la fermeture"}` : "Toute la journée";
        const kind = u.label || ((st && st.catalogs.kinds.find((k) => k.id === u.kind)) || { label: "" }).label;
        out.push({ tone: "amber", icon: staff ? "i-user" : "i-wrench", title: `${u.name || (staff ? "Un mécanicien" : "Un poste")} ${staff ? "absent" : "indisponible"} demain`, sub: `${when}${kind ? ` (${kind.toLowerCase()})` : ""}`, go: () => goPanel("planning", { day: tomorrow }) });
      }
    }
    if (mode !== "none") {
      const soon = todo.filter((r) => Date.parse(r.deadline) - Date.now() < 24 * 3600e3);
      if (soon.length)
        out.push({
          tone: "blue", icon: "i-info", title: `${plural(soon.length, "client")} à confirmer`,
          sub: soon.slice(0, 2).map((r) => [r.client.name, r.client.car].filter(Boolean).join(" — ")).join(" · ") + (soon.length > 2 ? "…" : ""),
          go: () => goPanel("requests"),
        });
    }
    if (mode === "simple" && rdvState) {
      if (!rdvState.notify || !rdvState.notify.email) out.push({ tone: "amber", icon: "i-mail", title: "Adresse de notification à vérifier", sub: "Sans elle, les demandes de rendez-vous ne vous arrivent pas.", go: () => goPanel("agenda") });
      else if (!rdvState.enabled) out.push({ tone: "blue", icon: "i-calendar", title: "Rendez-vous en ligne fermés", sub: "Ouvrez-les dans Disponibilités quand vous êtes prêt.", go: () => goPanel("agenda") });
    }
    if (pricesDue.length) out.push({ tone: "amber", icon: "i-tag", title: `${plural(pricesDue.length, "prix", "prix")} à confirmer`, sub: "Sans confirmation, ils sont marqués « ancien » sur Pixcar.", go: () => goPanel("prices") });
    return out.map((p, i) => ({ ...p, i })).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.i - b.i);
  }

  // ================================================================= rendu
  function render() {
    const gg = g.garage;
    $("dashVerified").replaceChildren(icon("i-shield"), `Garage vérifié le ${new Date(gg.verifiedAt).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric" })}`);
    const first = String(gg.holderName || "").trim().split(/\s+/)[0] || "";
    $("dashGarage").textContent = [first ? `Bonjour ${first}` : "", [gg.name, gg.addr].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    $("dbToday").textContent = cap(dayLabel(today(), { short: true, year: true }));
    const pts = points();
    renderKpis(pts);
    renderToday();
    renderActions();
    renderRequests();
    const adv = mode === "advanced" && !!ag;
    $("dbTeamCard").hidden = !adv;
    $("dbPostsCard").hidden = !adv;
    if (adv) {
      renderTeam();
      renderPosts();
    }
    renderAlerts(pts);
    renderShortcuts();
  }

  function kpi({ key, tone, ic, value, label, sub, pressed = null, chevron = false, onclick }) {
    return el(
      "li",
      { class: `db-kpi tone-${tone}` },
      el(
        "button",
        { type: "button", class: "db-kpi-btn", "data-kpi": key, ...(pressed === null ? {} : { "aria-pressed": String(pressed) }), onclick },
        // bandeau de chiffres de la maquette « Parcours Atelier » : l'intitulé, puis la valeur et sa précision
        el("span", { class: "db-kpi-l", text: label }),
        el("span", { class: "db-kpi-top" }, el("b", { class: "db-kpi-v", text: String(value) }), sub ? el("span", { class: "db-kpi-s", text: sub }) : null, chevron ? icon("i-next") : null),
      ),
    );
  }
  const toggle = (key) => () => {
    filter = filter === key ? null : key;
    renderKpis(points());
    renderToday();
    live(filter ? `Liste du jour : ${FILTERS[filter].toLowerCase()}.` : "Liste du jour : tout.");
  };
  function renderKpis(pts) {
    const alert = { key: "alerts", tone: "red", ic: "i-alert", value: pts.length, label: "Alertes", sub: pts.length ? "Nécessitent votre attention" : "Rien à signaler", chevron: true, onclick: () => $("dbAlertsTitle").focus() };
    let cards;
    if (mode === "advanced" && ag) {
      const c = counts();
      const extra = [c.pending.length ? `${c.pending.length} à confirmer` : "", c.off.length ? `${c.off.length} hors Pixcar` : ""].filter(Boolean).join(" · ");
      cards = [
        { key: "expected", tone: "blue", ic: "i-car", value: c.expected.length, label: "Véhicules attendus aujourd'hui", sub: `${c.toReceive.length} à recevoir${extra ? " · " + extra : ""}`, pressed: filter === "expected", onclick: toggle("expected") },
        { key: "live", tone: "orange", ic: "i-wrench", value: c.live.length, label: "Interventions en cours", sub: `Sur ${plural(c.expected.length, "véhicule")} aujourd'hui`, pressed: filter === "live", onclick: toggle("live") },
        { key: "ready", tone: "green", ic: "i-check", value: c.ready.length, label: "Véhicules prêts", sub: "À remettre aux clients", pressed: filter === "ready", onclick: toggle("ready") },
        { key: "capacity", tone: "violet", ic: "i-clock", value: hrs(capacity()), label: "Capacité restante", sub: "Main-d'œuvre encore libre aujourd'hui", onclick: () => goPanel("planning", { day: today() }) },
        alert,
      ];
    } else if (mode === "simple") {
      const items = dayItems();
      const v = g.visits.views;
      cards = [
        { key: "today", tone: "blue", ic: "i-calendar", value: items.length, label: "Rendez-vous aujourd'hui", sub: items.length ? `${items.filter((it) => it.state === "confirmed").length} confirmé(s)` : "Aucun pour l'instant", onclick: () => goPanel("requests") },
        { key: "todo", tone: "orange", ic: "i-inbox", value: todo.length, label: "Demandes à traiter", sub: todo.length ? "Répondez avant l'heure limite" : "Tout est à jour", onclick: () => goPanel("requests") },
        { key: "views", tone: "green", ic: "i-eye", value: v.recent, label: "Vues de la fiche · 30 j", sub: evolution(v) || "Sur Pixcar", onclick: () => goPanel("prices") },
        { key: "fresh", tone: "violet", ic: "i-tag", value: freshText(), label: "Prix à jour", sub: "Prestations & tarifs", onclick: () => goPanel("prices") },
        alert,
      ];
    } else {
      const v = g.visits;
      cards = [
        { key: "views", tone: "blue", ic: "i-eye", value: v.views.recent, label: "Vues de la fiche · 30 j", sub: evolution(v.views) || "Sur Pixcar", onclick: () => goPanel("prices") },
        { key: "calls", tone: "orange", ic: "i-phone", value: v.calls.recent, label: "Clics « Appeler » · 30 j", sub: evolution(v.calls) || "Depuis votre fiche", onclick: () => goPanel("prices") },
        { key: "fresh", tone: "green", ic: "i-tag", value: freshText(), label: "Prix à jour", sub: "Prestations & tarifs", onclick: () => goPanel("prices") },
        { key: "garage", tone: "violet", ic: "i-garage", value: g.prices.length, label: "Prix annoncés", sub: "Visibles sur Pixcar", onclick: () => goPanel("prices") },
        alert,
      ];
    }
    $("dbKpis").replaceChildren(...cards.map(kpi));
  }
  function freshText() {
    const live = g.prices.filter((p) => p.status !== "rejected");
    return live.length ? `${live.filter((p) => p.state === "ok").length} / ${live.length}` : "—";
  }

  // ---- l'atelier aujourd'hui
  function renderToday() {
    const adv = mode === "advanced" && !!ag;
    $("dbTodayCard").hidden = mode === "none";
    if (mode === "none") return;
    $("dbTodayText").textContent = adv ? "Aujourd'hui à l'atelier" : "Rendez-vous d'aujourd'hui";
    $("dbPlanLink").hidden = !adv;
    let items = dayItems();
    if (filter === "expected") items = items.filter((it) => !it.noShow);
    if (filter === "live") items = items.filter((it) => !it.noShow && WORK_LIVE.includes(it.work));
    if (filter === "ready") items = items.filter((it) => !it.noShow && it.work === "done");
    const f = $("dbFilter");
    f.hidden = !filter;
    if (filter) f.replaceChildren(el("span", { text: `Filtre : ${FILTERS[filter]}` }), el("button", { type: "button", class: "link-btn", onclick: toggle(filter) }, "Tout afficher"));
    $("dbList").replaceChildren(...items.map((it) => row(it, adv)));
    const empty = $("dbListEmpty");
    empty.hidden = items.length > 0;
    empty.textContent = filter === "live" ? "Aucune intervention en cours." : filter === "ready" ? "Aucune voiture prête pour l'instant." : "Aucun rendez-vous aujourd'hui.";
  }
  function row(it, adv) {
    const key = chipOf(it);
    const [label, ic, tone] = CHIP[key] || CHIP.planned;
    const svc = it.services.map((s) => s.label);
    return el(
      "li",
      { class: `db-row is-${key}${it.noShow ? " is-noshow" : ""}`, "data-id": it.id },
      el("span", { class: "db-time", text: timeLabel(it.start) }),
      el("span", { class: `db-dot tone-${tone}`, "aria-hidden": "true" }),
      el("span", { class: "db-who" }, el("b", { text: it.title }), el("small", { text: carOf(it) })),
      el("span", { class: "db-what" }, el("b", { text: svc[0] || (it.type === "job" ? "Rendez-vous hors Pixcar" : "") }), el("small", { text: svc.length > 1 ? "+ " + svc.slice(1).join(" + ") : workText(it) })),
      el("span", { class: `db-chip tone-${tone}` }, icon(ic), el("span", { text: label })),
      adv || it.state === "pending" ? moreMenu(it) : el("span", { class: "db-more" }),
    );
  }
  // menu « Actions » d'une ligne : les passages possibles, puis le planning (ou Demandes pour une demande à confirmer)
  function moreMenu(it) {
    const acts = [];
    if (it.state === "pending") acts.push({ label: "Répondre à la demande", run: () => goPanel("requests") });
    else if (mode === "advanced" && it.work && it.day >= addDays(today(), -30)) for (const a of workActions(it.work)) if (a.to !== "no_show" || started(it)) acts.push({ label: a.label, back: a.back, run: (b) => doWork(it, a.to, b) });
    if (mode === "advanced") acts.push({ label: "Ouvrir dans le planning", sep: acts.length > 0, run: () => goPanel("planning", { day: it.day, item: it.id }) });
    const menuId = `dbm-${it.id}`;
    const btn = el("button", { type: "button", class: "db-more-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId, "aria-label": `Actions : ${it.title}` }, icon("i-more"));
    const list = el(
      "ul",
      { class: "db-menu", role: "menu", id: menuId, hidden: true, "aria-label": `Actions : ${it.title}` },
      ...acts.map((a) =>
        el("li", { role: "none", class: a.sep ? "is-sep" : "" }, el("button", { type: "button", role: "menuitem", class: a.back ? "is-back" : "", onclick: () => {
          closeMenus();
          a.run(btn);
        } }, a.label)),
      ),
    );
    btn.addEventListener("click", () => {
      const open = list.hidden;
      closeMenus();
      if (!open) return;
      list.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      const first = list.querySelector("button");
      if (first) first.focus();
    });
    list.addEventListener("keydown", (ev) => {
      const bs = [...list.querySelectorAll("button")];
      const i = bs.indexOf(document.activeElement);
      if (ev.key === "Escape") {
        closeMenus();
        btn.focus();
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        bs[(i + (ev.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
      } else if (ev.key === "Tab") closeMenus();
    });
    return el("span", { class: "db-more" }, btn, list);
  }
  function closeMenus() {
    for (const m of document.querySelectorAll("#dbList .db-menu")) m.hidden = true;
    for (const b of document.querySelectorAll("#dbList .db-more-btn")) b.setAttribute("aria-expanded", "false");
  }
  function focusRow(itemId) {
    const b = document.querySelector(`#dbList [data-id="${itemId}"] .db-more-btn`);
    if (b) {
      b.scrollIntoView({ block: "center" });
      b.focus();
    }
  }

  // ---- état d'une intervention : « Voiture prête » d'un rendez-vous Pixcar passe par la fenêtre (client prévenu, case cochée)
  let readyFor = null;
  function doWork(it, to, button) {
    if (to === "done" && it.type === "rdv") {
      readyFor = it;
      $("workDlgTitle").textContent = it.title;
      $("workDlgText").textContent = [svcLine(it.services), carOf(it)].filter(Boolean).join(" · ");
      $("workNotify").checked = true;
      $("workErr").hidden = true;
      $("workDlg").showModal();
      $("workSave").focus();
      return;
    }
    return send(it, { status: to }, button);
  }
  async function send(it, body, button) {
    const run = async () => {
      try {
        const out = await api.work(id(), it.id, body);
        const text = `${it.title} : ${workLabel(out.work.noShow ? "no_show" : out.work.status)}${out.notified ? ", client prévenu par e-mail" : ""}.`;
        alertBox(text, "info");
        await reload(text, it.id);
        return true;
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          alertBox(e.message);
          await reload("", it.id);
          return false;
        }
        fail(e);
        return false;
      }
    };
    return button ? busy(button, run) : run();
  }
  async function submitReady(ev) {
    ev.preventDefault();
    const it = readyFor;
    await busy($("workSave"), async () => {
      try {
        const out = await api.work(id(), it.id, { status: "done", notify: $("workNotify").checked });
        $("workDlg").close();
        const text = `${it.title} : voiture prête${out.notified ? ", client prévenu par e-mail" : ""}.`;
        alertBox(text, "info");
        await reload(text, it.id);
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          $("workErr").textContent = e.message;
          $("workErr").hidden = false;
          return;
        }
        $("workDlg").close();
        fail(e);
      }
    });
  }

  // ---- actions rapides : les formulaires du Planning, de Disponibilités ou des prix
  function renderActions() {
    const card = (primary, ic, title, sub, onclick) => el("button", { type: "button", class: `db-act${primary ? " is-primary" : ""}`, onclick }, el("span", { class: "db-act-ic" }, icon(ic)), el("span", {}, el("b", { text: title }), el("small", { text: sub })));
    let list;
    if (mode === "advanced")
      list = [
        card(true, "i-plus", "Nouveau rendez-vous", "Pris par téléphone ou au comptoir", () => goPanel("planning", { form: { kind: "job" } })),
        card(false, "i-car", "Client déjà sur place", "Voiture reçue maintenant", () => goPanel("planning", { form: { kind: "job", arrived: true } })),
        card(false, "i-calendar", "Bloquer un créneau", "Réunion, livraison, essai…", () => goPanel("planning", { form: { kind: "hold" } })),
        card(false, "i-user", "Déclarer une absence", "Un mécanicien de l'équipe", () => goPanel("planning", { form: { kind: "staff" } })),
      ];
    else if (mode === "simple")
      list = [
        card(true, "i-inbox", todo.length ? "Répondre aux demandes" : "Mes disponibilités", todo.length ? plural(todo.length, "demande") + " en attente" : "Créneaux et réglages", () => goPanel(todo.length ? "requests" : "agenda")),
        card(false, "i-lock", "Fermer une journée", "Congés, fermeture exceptionnelle", () => goPanel("agenda", { closure: true })),
        card(false, "i-tag", "Annoncer un prix", "Visible sur Pixcar", () => goPanel("prices", { add: true })),
        card(false, "i-planning", "Planning avancé", "Mécaniciens, postes, confirmation immédiate", () => goPanel("calendar")),
      ];
    else
      list = [
        card(true, "i-tag", "Annoncer un prix", "Visible sur Pixcar", () => goPanel("prices", { add: true })),
        card(false, "i-garage", "Mon garage", "Coordonnées, horaires", () => goPanel("garage")),
      ];
    $("dbActions").replaceChildren(...list);
  }

  // ---- demandes à traiter : les trois plus urgentes
  function renderRequests() {
    const on = mode !== "none";
    $("dbRqCard").hidden = !on;
    if (!on) return;
    const list = todo.slice().sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)).slice(0, 3);
    const c = $("dbRqCount");
    c.hidden = !todo.length;
    c.textContent = todo.length ? String(todo.length) : "";
    c.setAttribute("aria-label", `${todo.length} à traiter`);
    $("dbRq").replaceChildren(
      ...list.map((r) =>
        el(
          "li",
          { class: "db-rq-row", "data-id": r.id },
          el("span", { class: "db-who" }, el("b", { text: r.client.name }), el("small", { text: [r.client.car, r.client.plate].filter(Boolean).join(" · ") })),
          el("span", { class: "db-what" }, el("b", { text: svcLine(r.services) }), el("small", { text: cap(r.when.label) })),
          el(
            "span",
            { class: "db-rq-acts" },
            el("button", { type: "button", class: "btn small db-ok", "aria-label": `Confirmer : ${r.client.name}, ${r.when.label}`, onclick: (ev) => accept(r, ev.currentTarget) }, "Confirmer"),
            el("button", { type: "button", class: "btn small db-no", "aria-label": `Refuser : ${r.client.name}, ${r.when.label}`, onclick: () => decline(id(), r, () => reload("Demande refusée.")) }, "Refuser"),
          ),
        ),
      ),
    );
    $("dbRqEmpty").hidden = todo.length > 0;
  }
  async function accept(r, button) {
    await busy(button, async () => {
      try {
        await api.decide(id(), r.id, "accept");
        alertBox(`Rendez-vous du ${r.when.label} confirmé. ${r.client.name} reçoit la confirmation par e-mail.`, "info");
        await reload("Rendez-vous confirmé.");
      } catch (e) {
        if (e.status === 409) {
          alertBox(e.message);
          return reload("");
        }
        fail(e);
      }
    });
  }

  // ---- équipe : charge du jour et état maintenant
  function staffNow(m) {
    const t = today(), now = nowP().iso === t ? nowP().min : -1;
    const hours = K.hoursFor(ag, st, m, t);
    if (!hours.length) return { text: "Ne travaille pas aujourd'hui", tone: "grey" };
    const away = K.awayOn(ag, m.id, t);
    const end = Math.max(...hours.map(([, b]) => b));
    const cur = away.find((u) => u.a <= now && now < u.b);
    if (cur) return cur.b >= end ? { text: "Absent", tone: "red" } : { text: `De retour à ${timeLabel(cur.b)}`, tone: "red" };
    const later = away.filter((u) => u.a > now && u.a < end).sort((a, b) => a.a - b.a)[0];
    const busyNow = K.rowsOn(all(), "staff", m.id, t, "labour").some(([a, b]) => a <= now && now < b);
    if (busyNow) return { text: later ? `En intervention · absent à ${timeLabel(later.a)}` : "En intervention", tone: "blue" };
    if (later) return { text: `Absent à partir de ${timeLabel(later.a)}`, tone: "amber" };
    if (!hours.some(([a, b]) => a <= now && now < b)) return { text: now >= end ? "Journée terminée" : "Pas encore en service", tone: "grey" };
    return { text: "Disponible", tone: "green" };
  }
  function renderTeam() {
    const t = today(), list = all();
    const staff = ag.staff.filter((m) => m.active);
    $("dbTeam").replaceChildren(
      ...(staff.length
        ? staff.map((m, i) => {
            const planned = K.total(K.rowsOn(list, "staff", m.id, t, "labour")), avail = K.total(K.workOf(ag, st, m, t));
            const p = pct(planned, avail), s = staffNow(m);
            const bar = el("i");
            K.css(bar, { width: `${Math.min(100, p)}%` });
            return el(
              "li",
              { class: "db-team-row" },
              el("span", { class: `db-avatar av-${i % 5}`, "aria-hidden": "true", text: initials(m.name) }),
              el(
                "span",
                { class: "db-team-main" },
                el("b", { text: m.name }),
                el("span", { class: `db-meter${p > 100 ? " is-over" : p >= 85 ? " is-high" : ""}`, role: "img", "aria-label": `Charge : ${p} %` }, bar),
                el("span", { class: `db-now tone-${s.tone}`, text: s.text }),
              ),
              el("span", { class: "db-team-pct" }, el("b", { text: avail ? `${p} %` : "—" }), el("small", { text: avail ? `${hrs(planned)} / ${hrs(avail)}` : "" })),
            );
          })
        : [el("li", { class: "db-empty", text: "Aucun mécanicien actif : ajoutez-les dans Équipe et postes." })]),
    );
  }

  // ---- postes et équipements : état maintenant
  function postNow(x) {
    if (!x.active) return { chip: "Hors service", tone: "grey", sub: "" };
    const t = today(), now = nowP().iso === t ? nowP().min : -1;
    const away = K.awayOn(ag, x.id, t).find((u) => u.a <= now && now < u.b);
    if (away) return { chip: "Indisponible", tone: "red", sub: `${away.text.split(" : ")[0]}${away.b < 1440 ? ` · jusqu'à ${timeLabel(away.b)}` : ""}` };
    for (const it of all()) {
      if (it.noShow) continue;
      const r = it.plan.find((y) => y.target === "resource" && y.id === x.id && y.day === t && y.a <= now && now < y.b);
      if (r) return { chip: "Occupé", tone: "orange", sub: `${it.type === "hold" ? it.title : carOf(it) || it.title} · jusqu'à ${timeLabel(r.b)}` };
    }
    if (!K.hoursFor(ag, st, x, t).some(([a, b]) => a <= now && now < b)) return { chip: "Fermé", tone: "grey", sub: "" };
    return { chip: "Disponible", tone: "green", sub: "" };
  }
  function renderPosts() {
    const posts = ag.resources;
    $("dbPosts").replaceChildren(
      ...(posts.length
        ? posts.map((x) => {
            const s = postNow(x);
            return el(
              "li",
              { class: "db-post-row" },
              el("span", { class: "db-post-ic" }, icon(RES_ICON[x.type] || "i-wrench")),
              el("b", { text: x.name }),
              el("span", { class: "db-post-st" }, el("span", { class: `db-chip tone-${s.tone}`, text: s.chip }), s.sub ? el("small", { text: s.sub }) : null),
            );
          })
        : [el("li", { class: "db-empty", text: "Aucun poste : ajoutez-les dans Équipe et postes." })]),
    );
  }

  // ---- points d'attention
  function renderAlerts(pts) {
    const shown = allAlerts ? pts : pts.slice(0, ALERTS_SHOWN);
    $("dbAlerts").replaceChildren(
      ...shown.map((p) =>
        el("li", {}, el("button", { type: "button", class: `db-alert tone-${p.tone}`, onclick: p.go }, el("span", { class: "db-alert-ic" }, icon(p.icon)), el("span", { class: "db-alert-t" }, el("b", { text: p.title }), el("small", { text: p.sub })), icon("i-next"))),
      ),
    );
    $("dbAlertsEmpty").hidden = pts.length > 0;
    const more = $("dbAlertsMore");
    more.hidden = pts.length <= ALERTS_SHOWN;
    more.textContent = allAlerts ? "Voir moins" : `Voir tous les points (${pts.length})`;
    more.setAttribute("aria-expanded", String(allAlerts));
  }

  // ---- raccourcis : ceux du compte, parmi ceux qui ont un sens pour ce garage
  const available = (s) => (!s.rdv || mode !== "none") && (!s.adv || mode === "advanced");
  function renderShortcuts() {
    const chosen = (g.prefs && g.prefs.shortcuts) || [];
    const list = chosen.map((k) => SHORTCUTS.find((s) => s.id === k)).filter((s) => s && available(s));
    $("dbShortcuts").replaceChildren(
      ...list.map((s) => {
        const inner = [el("span", { class: "db-short-ic" }, icon(SHORT_ICON[s.id])), el("span", {}, el("b", { text: s.label }), el("small", { text: s.sub })), icon("i-next")];
        return el("li", {}, s.id === "site" ? el("a", { class: "db-short", href: "../" }, ...inner) : el("button", { type: "button", class: "db-short", "data-short": s.id, onclick: () => goShort(s.id) }, ...inner));
      }),
    );
    $("dbShortEmpty").hidden = list.length > 0;
  }
  function goShort(key) {
    if (key === "team") return goPanel("calendar");
    if (key === "new") return goPanel("planning", { form: { kind: "job" } });
    if (key === "closure") return goPanel("agenda", { closure: true });
    if (key === "planning") return goPanel("planning", { day: today() });
    return goPanel(key);
  }
  function openShortcuts() {
    const chosen = new Set((g.prefs && g.prefs.shortcuts) || []);
    const box = $("shortList");
    box.replaceChildren(
      el("legend", { text: `${MAX_SHORTCUTS} au plus` }),
      ...SHORTCUTS.filter(available).map((s) => el("label", { class: "choice-line" }, el("input", { type: "checkbox", name: "shortcut", value: s.id, checked: chosen.has(s.id) }), el("span", {}, el("b", { text: s.label }), " — ", s.sub))),
    );
    limitShortcuts();
    $("shortErr").hidden = true;
    $("shortDlg").showModal();
    const first = box.querySelector("input");
    if (first) first.focus();
  }
  function limitShortcuts() {
    const boxes = [...$("shortList").querySelectorAll("input")];
    const n = boxes.filter((b) => b.checked).length;
    for (const b of boxes) b.disabled = !b.checked && n >= MAX_SHORTCUTS;
    $("shortHelp").textContent = `${n} sur ${MAX_SHORTCUTS} choisis. Gardés sur votre compte : vous les retrouvez sur tous vos appareils.`;
  }
  async function saveShortcuts(ev) {
    ev.preventDefault();
    const picked = [...$("shortList").querySelectorAll("input:checked")].map((b) => b.value);
    // les raccourcis qui n'ont pas de sens dans ce mode (Planning en mode simple…) restent gardés
    const hidden = ((g.prefs && g.prefs.shortcuts) || []).filter((k) => !SHORTCUTS.some((s) => s.id === k && available(s)));
    const shortcuts = [...picked, ...hidden.filter((k) => !picked.includes(k))].slice(0, MAX_SHORTCUTS);
    await busy($("shortSave"), async () => {
      try {
        g.prefs = await api.putPrefs(id(), { shortcuts });
        $("shortDlg").close();
        renderShortcuts();
        live("Raccourcis enregistrés.");
        $("dbShortEdit").focus();
      } catch (e) {
        if (e.status === 422) {
          $("shortErr").textContent = e.message;
          $("shortErr").hidden = false;
          return;
        }
        $("shortDlg").close();
        fail(e);
      }
    });
  }

  // ---- branchements
  $("dbPlanLink").addEventListener("click", () => goPanel("planning", { day: today() }));
  $("dbRqLink").addEventListener("click", () => goPanel("requests"));
  for (const b of document.querySelectorAll("#dash-top [data-goto]")) b.addEventListener("click", () => goPanel(b.dataset.goto === "team" ? "calendar" : b.dataset.goto));
  $("dbAlertsMore").addEventListener("click", () => {
    allAlerts = !allAlerts;
    renderAlerts(points());
  });
  $("dbShortEdit").addEventListener("click", openShortcuts);
  $("shortList").addEventListener("change", limitShortcuts);
  $("shortForm").addEventListener("submit", saveShortcuts);
  $("shortClose").addEventListener("click", () => $("shortDlg").close());
  $("workForm").addEventListener("submit", submitReady);
  $("workClose").addEventListener("click", () => $("workDlg").close());
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#dbList .db-more")) closeMenus();
  });

  return { open, reload: () => (g ? load() : null), refreshPrices: (garageData) => ((g = garageData), g && render()) };
}
