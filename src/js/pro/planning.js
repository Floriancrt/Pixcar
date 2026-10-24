// Espace Pro, écran « Planning » (docs/calendrier-avance.md, lot 3b ; mode avancé seulement) : une vue d'ensemble (rendez-vous, charge
// de l'atelier, mécaniciens, alertes) au-dessus de cinq vues — Jour (une colonne par mécanicien ou par poste), Semaine (une par jour
// ouvert, week-end à la demande), Mois (six semaines), Par mécanicien et Par poste (une colonne par jour). Chaque colonne dit sa charge ;
// la grille distingue le libre, ce qui n'est pas proposé en ligne (délai minimum, horizon, réservation fermée), l'indisponible (fermé,
// hors horaires) et les absences. Trois informations séparées par bloc : la provenance (Pixcar, hors Pixcar, créneau bloqué), la
// confirmation, l'alerte (conflit) ; et l'état de l'intervention quand il n'est plus « prévue ». Un bloc s'ouvre (fiche : détail,
// déplacer ou réaffecter au clavier, appeler, annuler) ou se glisse (souris ; doigt après un appui long ; pas de 15 min). L'API contrôle
// tout avant d'enregistrer. Données : GET …/calendar/agenda, GET …/calendar (horaires des mécaniciens et postes, fenêtre de réservation)
// et GET …/requests?view=todo (heures limites). Que du TEXTE écrit dans la page.
// Présentation de l'agenda « Gestion d'atelier » de la maquette de l'utilisateur (24 octobre 2026) : bandeau de chiffres (masquable),
// barre d'outils (période, vues, filtres, plein écran, recherche dans la période), 68 px par heure, blocs à filet coloré selon
// l'avancement (à confirmer, à venir, en cours, en attente, prête, conflit), pause déjeuner nommée, légende sous la grille.
import { phoneText } from "../shared/garage-profile.js";
import { GARAGE_CANCEL_REASONS, addDays, dayLabel, hm, minOf, parisParts, timeLabel, weekday } from "../shared/rdv.js";
import { workActions, workLabel } from "../shared/work.js";
import * as K from "./workshop.js";

const { css, inter, merge, minus, total } = K;

const VIEWS = [
  ["day", "Jour"],
  ["week", "Semaine"],
  ["month", "Mois"],
  ["staff", "Par mécanicien"],
  ["post", "Par poste"],
];
// trois dimensions, séparées à l'écran : provenance, confirmation (et l'alerte), état de l'intervention (ordres de réparation, lot 3c)
const ORIGIN = { pixcar: ["Pixcar", "i-globe"], job: ["Hors Pixcar", "i-phone"], hold: ["Créneau bloqué", "i-lock"] };
const STATE = { pending: ["À confirmer", "i-clock"], confirmed: ["Confirmé", "i-check"], conflict: ["En conflit", "i-flag"] };
const WEEK = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const SNAP = 15; // pas du glisser-déposer, en minutes
const HOLD_MS = 350; // appui long avant de glisser au doigt
const ROLE = { labour: "main-d'œuvre", station: "poste", tool: "équipement" };
let PPM = 68 / 60; // pixels par minute des grilles horaires : 68 px par heure comme la maquette (1 px par minute sur téléphone)
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const monday = (iso) => addDays(iso, -WEEK.indexOf(weekday(iso)));
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : `${m} min`);
const hrs = (m) => (m ? dur(Math.round(m)) : "0 h");
const range = (a, b) => `${timeLabel(a)}–${timeLabel(b)}`;
const snap = (m, step = SNAP) => Math.round(m / step) * step;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// recherche : sans accents ni majuscules
const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// bandeau de chiffres masqué (choix gardé dans ce navigateur)
const STRIP_KEY = "pixcar-pro-plan-kpis";
// teinte d'un bloc, comme la maquette : à confirmer (orange), à venir (bleu), en cours, en attente (jaune, pointillé), prête (vert),
// conflit (rouge), créneau bloqué (gris), client absent (estompé)
function toneOf(it) {
  if (it.type === "hold") return "hold";
  if (it.noShow) return "noshow";
  if (it.conflict) return "conflict";
  if (it.state === "pending") return "pending";
  if (it.work === "done" || it.work === "returned") return "done";
  if (it.work === "waiting_parts" || it.work === "suspended") return "wait";
  if (it.work === "received" || it.work === "in_progress") return "live";
  return "confirmed";
}
// côte à côte quand des blocs se chevauchent : couloir de chaque bloc et nombre de couloirs de son groupe
function lanes(segs) {
  segs.sort((x, y) => x.a - y.a || y.b - x.b);
  let group = [], end = -1;
  const close = () => {
    const n = Math.max(...group.map((s) => s.lane)) + 1;
    for (const s of group) s.lanes = n;
  };
  for (const s of segs) {
    if (group.length && s.a >= end) {
      close();
      group = [];
      end = -1;
    }
    const used = new Set(group.filter((g) => g.b > s.a).map((g) => g.lane));
    let l = 0;
    while (used.has(l)) l++;
    s.lane = l;
    group.push(s);
    end = Math.max(end, s.b);
  }
  if (group.length) close();
  return segs;
}

export function createPlanning({ api, $, el, icon, alertBox, busy, apiProblem, goPanel }) {
  let garageId = null;
  let data = null; // réponse de GET …/calendar/agenda
  let st = null; // réponse de GET …/calendar (horaires des mécaniciens et postes, fenêtre de réservation, motifs d'absence)
  let deadlines = new Map(); // demande à confirmer → heure limite (ms)
  let view = null;
  let anchor = null; // jour de référence (AAAA-MM-JJ)
  let dayBy = "staff"; // vue Jour : colonnes par mécanicien ou par poste
  let pickStaff = null, pickPost = null; // vues « Par mécanicien » et « Par poste »
  let weekend = false; // week-end fermé affiché quand même
  const filters = { staff: "", post: "", service: "", origin: "", state: "" };
  let query = ""; // recherche (client, véhicule, immatriculation, prestation), sans accents
  let stripOff = null; // bandeau de chiffres masqué (lu une fois dans le navigateur)
  let sheet = null; // { item, mode, … } fiche ouverte
  let drag = null; // glisser-déposer en cours
  let swallowClick = false;
  let loading = 0; // numéro du dernier chargement : une réponse plus ancienne, arrivée après, est ignorée
  const dlg = () => $("planDlg");
  const fail = (e) => {
    if (!apiProblem(e)) alertBox(e.message);
  };
  const live = (text) => ($("planLive").textContent = text);
  const narrow = () => window.matchMedia("(max-width: 599px)").matches;
  const today = () => parisParts(Date.now()).iso;
  const staffName = (id) => (data.staff.find((m) => m.id === id) || { name: "" }).name;
  const postName = (id) => (data.resources.find((x) => x.id === id) || { name: "" }).name;
  const activeStaff = () => data.staff.filter((m) => m.active);
  const activePosts = () => data.resources.filter((x) => x.active);

  // ================================================================= ouverture et chargement
  async function open(id, { focus = true } = {}) {
    if (garageId !== id) {
      garageId = id;
      view = null;
      anchor = null;
      pickStaff = pickPost = null;
      for (const k of Object.keys(filters)) filters[k] = "";
      setQuery("");
      showFilters(false);
    }
    focusMode(false);
    view ||= narrow() ? "day" : "week";
    anchor ||= today();
    st = await api.calendar(id);
    if (!(await load({ todo: true }))) return;
    render();
    if (focus) $("planTitle").focus();
  }
  function period() {
    if (view === "day") return [anchor, anchor];
    if (view === "month") {
      const first = monday(anchor.slice(0, 8) + "01");
      return [first, addDays(first, 41)];
    }
    const m = monday(anchor);
    return [m, addDays(m, 6)];
  }
  // les heures limites des demandes à confirmer (toutes périodes) : relues à l'ouverture et après un changement, pas à chaque navigation
  async function load({ todo = false } = {}) {
    const [from, to] = period();
    const n = ++loading;
    const [out, list] = await Promise.all([api.calAgenda(garageId, from, to), todo ? api.requests(garageId, "todo").catch(() => null) : null]);
    if (n !== loading) return false;
    data = out;
    if (list) deadlines = new Map((list.requests || []).map((r) => [r.id, Date.parse(r.deadline)]));
    if (!pickStaff || !data.staff.some((m) => m.id === pickStaff)) pickStaff = (activeStaff()[0] || data.staff[0] || { id: null }).id;
    if (!pickPost || !data.resources.some((x) => x.id === pickPost)) pickPost = (activePosts()[0] || data.resources[0] || { id: null }).id;
    return true;
  }
  async function reload(message, { state = false } = {}) {
    if (state) st = await api.calendar(garageId);
    if (!(await load({ todo: true }))) return;
    render();
    if (message) live(message);
  }
  async function go(fn) {
    try {
      fn();
      if (await load()) render();
    } catch (e) {
      fail(e);
    }
  }

  // ================================================================= ce qui est affiché
  // rendez-vous et blocs, sous une même forme (tous, sans les filtres : la charge et la vue d'ensemble les comptent tous)
  const allItems = () => K.itemsOf(data, deadlines);
  const items = () => allItems().filter(match);
  // ce que la recherche lit d'un bloc : client ou libellé, prestations, voiture, immatriculation (avec ou sans tirets), type de véhicule
  function hay(it) {
    const a = it.type === "rdv" ? it.src : null;
    const v = it.src && it.src.vehicle ? (data.vehicles.find((x) => x.id === it.src.vehicle) || { label: "" }).label : "";
    return fold([it.title, svcText(it), a && a.car, a && a.plate, a && a.plate && a.plate.replace(/[\s-]/g, ""), v].filter(Boolean).join(" "));
  }
  function match(it) {
    if (query && !hay(it).includes(query)) return false;
    if (filters.staff && !it.plan.some((r) => r.target === "staff" && r.id === filters.staff)) return false;
    if (filters.post && !it.plan.some((r) => r.target === "resource" && r.id === filters.post)) return false;
    if (filters.service && !it.services.some((s) => s.id === filters.service)) return false;
    if (filters.origin && it.origin !== filters.origin) return false;
    if (filters.state === "conflict") return !!it.conflict;
    return !filters.state || it.state === filters.state;
  }
  const svcText = (it) => it.services.map((s) => s.label).join(" + ");
  // le travail de l'atelier ce jour-là : du début à la fin de la main-d'œuvre des mécaniciens ; à défaut (créneau bloqué, rien
  // d'affecté), le séjour de la voiture, du dépôt à la restitution
  function workSpan(it) {
    const rows = it.plan.filter((r) => r.target === "staff" && r.role === "labour" && r.day === it.day);
    if (!rows.length) return [it.start, it.end > it.start ? it.end : 1440];
    return [Math.min(...rows.map((r) => r.a)), Math.max(...rows.map((r) => r.b))];
  }
  const peopleOf = (it) => [...new Set(it.plan.filter((r) => r.target === "staff").map((r) => r.name))];
  const postsOf = (it) => [...new Set(it.plan.filter((r) => r.target === "resource").map((r) => r.name))];
  const openOn = (day) => K.openOn(data, day);
  const awayOn = (targetId, day) => K.awayOn(data, targetId, day);
  // ---- charge : comme le moteur, heures d'ouverture ∩ horaires propres, moins les absences (un client absent ne compte plus)
  const hoursFor = (x, day) => K.hoursFor(data, st, x, day);
  const workOf = (x, day) => K.workOf(data, st, x, day);
  const rowsOn = K.rowsOn;
  function staffLoad(m, day, list = allItems()) {
    return { planned: total(rowsOn(list, "staff", m.id, day, "labour")), avail: total(workOf(m, day)), absent: awayOn(m.id, day).length > 0 };
  }
  function postLoad(x, day, list = allItems()) {
    return { planned: total(rowsOn(list, "resource", x.id, day)), avail: total(workOf(x, day)), down: awayOn(x.id, day).length > 0 };
  }
  function dayLoad(day, list = allItems()) {
    let planned = 0, avail = 0;
    for (const m of activeStaff()) {
      const l = staffLoad(m, day, list);
      planned += l.planned;
      avail += l.avail;
    }
    return { planned, avail };
  }
  // minutes de ce jour où rien n'est proposé en ligne : réservation fermée, avant le délai minimum, au-delà de l'horizon
  function noBook(day) {
    if (!st || !st.enabled) return [[0, 1440]];
    const first = parisParts(Date.now() + st.booking.minDelayH * 3600e3);
    if (day < first.iso || day > addDays(data.today, st.booking.horizonDays)) return [[0, 1440]];
    return day === first.iso ? [[0, first.min]] : [];
  }
  const pastOn = (day) => (day < data.today ? [[0, 1440]] : day === data.today ? [[0, parisParts(Date.now()).min]] : []);
  // jours affichés en Semaine, Par mécanicien et Par poste : les jours ouverts ; le week-end fermé à la demande (ou s'il y a quelque chose)
  function weekDays(list = items()) {
    const [from] = period();
    const week = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const shown = week.filter((d) => weekend || openOn(d).length || list.some((it) => it.day === d));
    return shown.length ? shown : week.slice(0, 5);
  }
  const hiddenWeekend = () => !weekend && ["sa", "su"].some((k) => !weekDays().some((d) => weekday(d) === k));

  // ================================================================= rendu
  function render() {
    PPM = narrow() ? 1 : 68 / 60;
    renderSummary();
    renderBar();
    renderFilters();
    renderLegend();
    const grid = $("planGrid");
    if (!data.staff.length && !data.resources.length) {
      grid.replaceChildren(el("p", { class: "empty", text: "Ajoutez d'abord vos mécaniciens et vos postes (Mon atelier)." }));
      return;
    }
    grid.replaceChildren(view === "month" ? month() : timeGrid(columns()));
  }

  // ---- vue d'ensemble de la période affichée (tout compté, sans les filtres)
  function summaryDays() {
    if (view === "day") return [anchor];
    const [from, to] = period();
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (view !== "month" || d.slice(0, 7) === anchor.slice(0, 7)) out.push(d);
    return out;
  }
  function renderSummary() {
    const days = summaryDays(), set = new Set(days), list = allItems().filter((it) => set.has(it.day));
    const appts = list.filter((it) => it.type !== "hold");
    const pending = appts.filter((it) => it.state === "pending");
    let planned = 0, avail = 0;
    for (const d of days) {
      const l = dayLoad(d);
      planned += l.planned;
      avail += l.avail;
    }
    const staff = activeStaff();
    const absent = staff.filter((m) => days.some((d) => awayOn(m.id, d).length));
    const conflicts = list.filter((it) => it.conflict);
    const now = Date.now();
    const urgent = pending.filter((it) => it.deadline && it.deadline > now && it.deadline - now < 24 * 3600e3).sort((a, b) => a.deadline - b.deadline);
    const when = view === "day" ? (anchor === data.today ? "aujourd'hui" : dayLabel(anchor)) : view === "month" ? new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" }) : days.includes(data.today) ? "cette semaine" : `semaine du ${dayLabel(days[0], { short: true })}`;
    const deadlineText = (ms) => {
      const p = parisParts(ms);
      return p.iso === data.today ? `avant ${timeLabel(p.min)}` : `avant ${dayLabel(p.iso, { short: true })} ${timeLabel(p.min)}`;
    };
    // bandeau de chiffres de la maquette : libellé, valeur et précision sur une ligne ; un chiffre qui mène quelque part est un bouton
    const card = (key, title, value, sub, onclick = null) => {
      const inner = [el("span", { class: "pl-card-l", text: title }), el("span", { class: "pl-card-n" }, el("b", { class: "pl-card-v", text: value }), el("small", { class: "pl-card-s", text: sub }))];
      return el("li", { class: `pl-card is-${key}` }, onclick ? el("button", { type: "button", class: "pl-card-btn", onclick }, ...inner) : el("div", { class: "pl-card-in" }, ...inner));
    };
    const load = pct(planned, avail);
    const title = el("h2", { id: "planSumTitle", class: "sr-only", text: `Vue d'ensemble · ${when}` });
    if (stripHidden()) {
      $("planSummary").replaceChildren(title, el("button", { type: "button", class: "pl-strip-show", id: "planStripShow", onclick: () => setStrip(true) }, "Afficher les indicateurs"));
      return;
    }
    $("planSummary").replaceChildren(
      title,
      el(
        "div",
        { class: "pl-strip" },
        el(
          "ul",
          { class: "pl-cards" },
          card("rdv", "Rendez-vous", String(appts.length), pending.length ? `${plural(pending.length, "à confirmer", "à confirmer")}` : "Aucun à confirmer", pending.length ? () => setFilter("state", "pending") : null),
          card("load", "Charge atelier", avail ? `${load} %` : "—", avail ? `${hrs(planned)} / ${hrs(avail)}` : "Atelier fermé"),
          view === "day"
            ? card("staff", "Mécaniciens", `${staff.length - absent.length}/${staff.length}`, absent.length ? `${plural(absent.length, "absent")} : ${absent.map((m) => m.name).join(", ")}` : "Tous présents")
            : card("staff", "Mécaniciens", String(staff.length), absent.length ? `${plural(absent.length, "absent")} sur la période` : "Aucune absence"),
          card(
            "alert",
            "Alertes",
            String(conflicts.length + urgent.length),
            conflicts.length || urgent.length ? [conflicts.length ? plural(conflicts.length, "conflit") : "", urgent.length ? `${urgent.length} à confirmer ${deadlineText(urgent[0].deadline)}` : ""].filter(Boolean).join(" · ") : "Rien à signaler",
            conflicts.length ? () => setFilter("state", "conflict") : urgent.length ? () => setFilter("state", "pending") : null,
          ),
        ),
        el("button", { type: "button", class: "pl-icon pl-strip-hide", id: "planStripHide", "aria-label": "Masquer les indicateurs", onclick: () => setStrip(false) }, icon("i-close")),
      ),
    );
  }
  function stripHidden() {
    if (stripOff === null) {
      try {
        stripOff = localStorage.getItem(STRIP_KEY) === "hidden";
      } catch {
        stripOff = false;
      }
    }
    return stripOff;
  }
  function setStrip(on) {
    stripOff = !on;
    try {
      if (on) localStorage.removeItem(STRIP_KEY);
      else localStorage.setItem(STRIP_KEY, "hidden");
    } catch {
      // stockage refusé : le choix ne vaut que pour cet affichage
    }
    renderSummary();
    live(on ? "Indicateurs affichés." : "Indicateurs masqués.");
    $(on ? "planStripHide" : "planStripShow").focus();
  }

  function renderBar() {
    $("planViews").replaceChildren(
      ...VIEWS.map(([k, name]) => el("button", { type: "button", class: "pl-view", "aria-pressed": String(k === view), onclick: () => go(() => (view = k)) }, name)),
    );
    let label;
    if (view === "day") label = dayLabel(anchor, { year: true });
    else if (view === "month") label = new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
    else label = spanLabel(weekDays());
    $("planRange").textContent = cap(label);
    const step = view === "day" ? 1 : view === "month" ? 0 : 7;
    $("planPrev").onclick = () => go(() => (anchor = step ? addDays(anchor, -step) : shiftMonth(-1)));
    $("planNext").onclick = () => go(() => (anchor = step ? addDays(anchor, step) : shiftMonth(1)));
    $("planToday").onclick = () => go(() => (anchor = today()));
    $("planPrev").setAttribute("aria-label", view === "day" ? "Jour précédent" : view === "month" ? "Mois précédent" : "Semaine précédente");
    $("planNext").setAttribute("aria-label", view === "day" ? "Jour suivant" : view === "month" ? "Mois suivant" : "Semaine suivante");
    const pick = $("planPick");
    if (view === "day")
      pick.replaceChildren(
        selectBox("planBy", "Colonnes", [["staff", "Par mécanicien"], ["post", "Par poste"]], dayBy, (v) => {
          dayBy = v;
          render();
        }),
      );
    else if (view === "staff") {
      const m = data.staff.find((x) => x.id === pickStaff);
      let p = 0, a = 0;
      if (m) for (const d of weekDays(allItems())) (p += staffLoad(m, d).planned), (a += staffLoad(m, d).avail);
      pick.replaceChildren(selectBox("planWho", "Mécanicien", data.staff.map((x) => [x.id, x.name + (x.active ? "" : " (inactif)")]), pickStaff, (v) => ((pickStaff = v), render())), el("span", { class: "pl-picksum", text: `Semaine : ${hrs(p)} planifiées sur ${hrs(a)}${a ? ` (${pct(p, a)} %)` : ""}` }));
    } else if (view === "post") {
      const x = data.resources.find((r) => r.id === pickPost);
      let p = 0, a = 0;
      if (x) for (const d of weekDays(allItems())) (p += postLoad(x, d).planned), (a += postLoad(x, d).avail);
      pick.replaceChildren(selectBox("planWhich", "Poste", data.resources.map((r) => [r.id, r.name + (r.active ? "" : " (inactif)")]), pickPost, (v) => ((pickPost = v), render())), el("span", { class: "pl-picksum", text: `Semaine : occupé ${hrs(p)} sur ${hrs(a)}${a ? ` (${pct(p, a)} %)` : ""}` }));
    } else pick.replaceChildren();
    const we = $("planWeekend");
    we.hidden = view === "day" || view === "month" || (!weekend && !hiddenWeekend());
    we.textContent = weekend ? "Masquer le week-end" : "Afficher le week-end";
  }
  // « 19 — 23 octobre 2026 » ; « 28 septembre — 2 octobre 2026 » ; d'une année sur l'autre, les deux années
  function spanLabel(days) {
    const f = (d, o) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", ...o });
    const a = days[0], b = days[days.length - 1];
    const end = f(b, { day: "numeric", month: "long", year: "numeric" });
    if (a === b) return end;
    if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8))} — ${end}`;
    return `${f(a, a.slice(0, 4) === b.slice(0, 4) ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" })} — ${end}`;
  }
  function shiftMonth(n) {
    const [y, m] = anchor.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 10);
  }
  function selectBox(id, labelText, options, value, onchange) {
    const s = el("select", { id }, ...options.map(([v, t]) => el("option", { value: v, text: t, selected: v === value })));
    s.addEventListener("change", () => {
      onchange(s.value);
      // la liste est redessinée avec le reste : le focus revient sur la nouvelle
      if (!document.activeElement || document.activeElement === document.body) $(id) && $(id).focus();
    });
    return el("span", { class: "pl-pick" }, el("label", { for: id, text: labelText }), s);
  }

  // ---- filtres : une barre repliée (bouton « Filtres » et puces des filtres actifs), le détail sur demande
  const FILTERS = () => [
    ["staff", "planFStaff", "Mécanicien", data.staff.map((m) => [m.id, m.name])],
    ["post", "planFPost", "Poste", data.resources.map((x) => [x.id, x.name])],
    ["service", "planFService", "Prestation", data.services.map((s) => [s.id, s.label])],
    ["origin", "planFOrigin", "Provenance", Object.entries(ORIGIN).map(([k, [t]]) => [k, t])],
    ["state", "planFState", "État", Object.entries(STATE).map(([k, [t]]) => [k, t])],
  ];
  function showFilters(on) {
    $("planFilters").hidden = !on;
    $("planFToggle").setAttribute("aria-expanded", String(on));
  }
  function setFilter(key, value, { focus = null } = {}) {
    filters[key] = value;
    render();
    const n = items().length;
    live(Object.values(filters).some(Boolean) ? `Filtre appliqué : ${plural(n, "élément")} affiché${n > 1 ? "s" : ""}.` : "Filtres retirés.");
    if (focus) ($(focus) || $("planFToggle")).focus();
  }
  function renderFilters() {
    const defs = FILTERS();
    const active = defs.filter(([k]) => filters[k]);
    $("planFCount").hidden = !active.length;
    $("planFCount").textContent = active.length ? String(active.length) : "";
    $("planFToggle").setAttribute("aria-label", active.length ? `Filtres, ${plural(active.length, "actif")}` : "Filtres");
    $("planChips").replaceChildren(
      ...active.map(([k, , labelText, options]) => {
        const text = `${labelText} : ${(options.find(([v]) => v === filters[k]) || ["", "?"])[1]}`;
        return el("li", {}, el("button", { type: "button", class: "pl-chip", "aria-label": `Retirer le filtre ${text}`, onclick: () => setFilter(k, "", { focus: "planFToggle" }) }, text, icon("i-close")));
      }),
    );
    $("planFilters").replaceChildren(
      ...defs.map(([k, id, labelText, options]) => selectBox(id, labelText, [["", "Tous"], ...options], filters[k], (v) => setFilter(k, v))),
      ...(active.length
        ? [el("button", { type: "button", class: "link-btn", onclick: () => {
            for (const k of Object.keys(filters)) filters[k] = "";
            render();
            live("Filtres retirés.");
            $("planFStaff").focus();
          } }, "Retirer les filtres")]
        : []),
    );
  }
  // ---- légende sous la grille, comme la maquette : l'avancement (pastilles de couleur), les créneaux, puis la provenance et le nombre
  function renderLegend() {
    const dot = (tone, text) => el("li", {}, el("i", { class: `pl-dot tone-${tone}`, "aria-hidden": "true" }), text);
    const sw = (cls, text) => el("li", {}, el("span", { class: `pl-sw ${cls}`, "aria-hidden": "true" }), text);
    const n = items().filter((it) => it.type !== "hold").length;
    $("planLegend").replaceChildren(
      dot("pending", "À confirmer"),
      dot("confirmed", "À venir"),
      dot("live", "En cours"),
      dot("wait", "En attente"),
      dot("done", "Prête"),
      dot("conflict", "En conflit"),
      dot("hold", "Créneau bloqué"),
      sw("sw-nobook", "Pas proposé en ligne"),
      sw("sw-off", "Fermé"),
      sw("sw-away", "Absence ou maintenance"),
      el("li", { class: "pl-lg-r" }, icon(ORIGIN.pixcar[1]), ORIGIN.pixcar[0], " · ", icon(ORIGIN.job[1]), ORIGIN.job[0], ` · ${plural(n, "rendez-vous", "rendez-vous")}`),
    );
  }

  // ---- colonnes des grilles horaires : { key, head, sub, load, day, staff?, post?, segs, avail, away }
  function columns() {
    const list = items(), all = allItems();
    const rowsFor = (pred) => list.flatMap((it) => it.plan.filter(pred).map((r) => ({ item: it, a: r.a, b: Math.max(r.b, r.a + 5), row: r })));
    const todayText = (d) => (d === data.today ? "Aujourd'hui" : "");
    const loadText = (l, verb = "") => (l.avail ? `${verb}${hrs(l.planned)} / ${hrs(l.avail)}` : "");
    if (view === "week")
      return weekDays(list).map((d) => {
        const l = dayLoad(d, all), n = all.filter((it) => it.day === d && it.type !== "hold").length;
        // semaine : chaque bloc montre le travail (un seul mécanicien : rien ne se superpose), le dépôt et la restitution sont dans son texte
        return { key: d, head: dayLabel(d, { short: true }), sub: todayText(d), load: l.avail ? { ...l, text: `${loadText(l)} · ${plural(n, "rdv", "rdv")}` } : { ...l, text: openOn(d).length ? "Personne" : "Fermé" }, day: d, avail: openOn(d), segs: list.filter((it) => it.day === d).map((it) => { const [a, b] = workSpan(it); return { item: it, a, b: Math.max(b, a + 5) }; }) };
      });
    if (view === "staff" || view === "post") {
      const isStaff = view === "staff";
      const x = (isStaff ? data.staff : data.resources).find((r) => r.id === (isStaff ? pickStaff : pickPost));
      if (!x) return [];
      return weekDays(list).map((d) => {
        const l = isStaff ? staffLoad(x, d, all) : postLoad(x, d, all);
        const conflicts = all.filter((it) => it.day === d && it.conflict && it.plan.some((r) => r.id === x.id)).length;
        const text = l.avail ? `${isStaff ? "" : "occupé "}${loadText(l)}${conflicts ? ` · ${plural(conflicts, "conflit")}` : ""}` : l.absent || l.down ? (isStaff ? "Absent" : "Indisponible") : "Fermé";
        return { key: d, head: dayLabel(d, { short: true }), sub: todayText(d), load: { ...l, text }, day: d, [isStaff ? "staff" : "post"]: x.id, avail: hoursFor(x, d), away: awayOn(x.id, d), segs: rowsFor((r) => r.target === (isStaff ? "staff" : "resource") && r.id === x.id && r.day === d) };
      });
    }
    // jour : une colonne par mécanicien (ou par poste), et « Sans affectation » s'il en faut une
    const d = anchor;
    const byStaff = dayBy === "staff";
    const target = byStaff ? "staff" : "resource";
    const pool = byStaff ? data.staff : data.resources;
    const used = new Set(list.flatMap((it) => it.plan.filter((r) => r.target === target && r.day === d).map((r) => r.id)));
    const cols = pool
      .filter((x) => x.active || used.has(x.id))
      .map((x) => {
        const l = byStaff ? staffLoad(x, d, all) : postLoad(x, d, all);
        const text = l.avail ? `${byStaff ? "" : "occupé "}${loadText(l)}` : l.absent || l.down ? (byStaff ? "Absent" : "Indisponible") : x.active ? "Hors horaires" : "inactif";
        return { key: x.id, head: x.name, sub: "", load: { ...l, text }, day: d, [byStaff ? "staff" : "post"]: x.id, avail: hoursFor(x, d), away: awayOn(x.id, d), segs: rowsFor((r) => r.target === target && r.id === x.id && r.day === d && (!byStaff || r.role === "labour")) };
      });
    const loose = list.filter((it) => it.day === d && !it.plan.some((r) => r.target === target && r.day === d));
    if (loose.length) cols.push({ key: "none", head: "Sans affectation", sub: "", load: null, day: d, avail: openOn(d), segs: loose.map((it) => ({ item: it, a: it.start, b: it.end > it.start ? it.end : 1440 })) });
    return cols;
  }

  // ---- grille horaire (Jour, Semaine, Par mécanicien, Par poste)
  function timeGrid(cols) {
    let lo = Infinity, hi = -Infinity;
    for (const c of cols) {
      for (const [a, b] of openOn(c.day)) (lo = Math.min(lo, a)), (hi = Math.max(hi, b));
      for (const s of c.segs) (lo = Math.min(lo, s.a)), (hi = Math.max(hi, s.b));
    }
    if (!Number.isFinite(lo)) [lo, hi] = [8 * 60, 18 * 60];
    lo = Math.max(0, Math.floor(lo / 60) * 60);
    hi = Math.min(1440, Math.max(lo + 60, Math.ceil(hi / 60) * 60));
    const px = (m) => `${(m - lo) * PPM}px`;
    const hours = [];
    for (let h = lo; h < hi; h += 60) hours.push(css(el("span", { text: hm(h) }), { top: px(h) }));
    const count = cols.reduce((n, c) => n + c.segs.length, 0);
    const head = (c) => {
      const p = c.load && c.load.avail ? pct(c.load.planned, c.load.avail) : null;
      return el(
        "div",
        { class: "pl-colhead" + (c.day === data.today && view !== "day" ? " is-today" : "") },
        el("b", { text: c.head }),
        c.sub ? el("small", { text: c.sub }) : null,
        c.load ? el("span", { class: "pl-load", text: c.load.text }) : null,
        p !== null ? css(el("span", { class: `pl-meter${p > 100 ? " is-over" : p >= 85 ? " is-high" : ""}` }, css(el("i"), { width: `${Math.min(100, p)}%` })), {}) : null,
      );
    };
    const wrap = el(
      "div",
      { class: "pl-grid", "data-lo": String(lo), "data-hi": String(hi) },
      el("div", { class: "pl-head", "aria-hidden": "true" }, el("span", { class: "pl-corner" }), ...cols.map(head)),
      el("div", { class: "pl-body" }, el("div", { class: "pl-times", "aria-hidden": "true" }, ...hours), ...cols.map((c) => column(c, lo, hi, px))),
    );
    css(wrap, { "--cols": String(cols.length), "--h": `${(hi - lo) * PPM}px`, "--hour": `${60 * PPM}px` });
    // atteignable au clavier : la grille défile dans sa boîte, même quand aucun rendez-vous (bouton) ne s'y trouve
    return el("div", { class: "pl-scroll", tabindex: "0", role: "region", "aria-label": "Grille du planning" }, count ? null : el("p", { class: "pl-empty", text: query ? "Aucun rendez-vous ne correspond à la recherche sur cette période." : Object.values(filters).some(Boolean) ? "Rien ne correspond aux filtres sur cette période." : "Rien de prévu sur cette période." }), wrap);
  }
  function column(c, lo, hi, px) {
    const name = [c.head, view === "day" ? dayLabel(c.day) : c.staff ? staffName(c.staff) : c.post ? postName(c.post) : "", c.load ? c.load.text : ""].filter(Boolean).join(", ");
    const col = el("div", { class: "pl-col", role: "group", "aria-label": name, "data-day": c.day, "data-staff": c.staff || null, "data-post": c.post || null, "data-key": c.key });
    const band = (cls, [a, b], title = "", text = "") => {
      a = Math.max(a, lo);
      b = Math.min(b, hi);
      if (b > a) col.append(css(el("div", { class: cls, title: title || null }, text ? el("span", { text }) : null), { top: px(a), height: `${(b - a) * PPM}px` }));
    };
    // indisponible (fermé, hors horaires du mécanicien ou du poste), absences, passé, pas proposé en ligne : le reste est libre
    const away = (c.away || []).map((u) => [u.a, u.b]);
    // entre deux périodes d'ouverture : « Pause déjeuner » (maquette) ; colonne sans ouverture : « Fermé »
    const opens = merge(c.avail);
    const named = ([a, b]) => (!opens.length ? "Fermé" : opens.length > 1 && a >= opens[0][1] && b <= opens[opens.length - 1][0] && !away.some(([x, y]) => x < b && y > a) ? "Pause déjeuner" : "");
    for (const r of minus([[lo, hi]], merge([...c.avail, ...away]))) band("pl-off", r, "", named(r));
    for (const u of c.away || []) band("pl-away", [u.a, u.b], u.text, u.text);
    const open = minus(c.avail, away);
    const past = inter(open, pastOn(c.day));
    for (const r of past) band("pl-past", r);
    for (const r of minus(inter(open, noBook(c.day)), past)) band("pl-nobook", r, "Pas proposé en ligne (délai minimum, horizon ou réservation fermée)");
    for (const s of lanes(c.segs)) col.append(block(s, c, px));
    col.addEventListener("click", (ev) => {
      if (ev.target !== col && !/\bpl-(off|past|nobook)\b/.test(ev.target.className)) return;
      if (swallowClick) return;
      const lo2 = Number(col.closest(".pl-grid").dataset.lo);
      const m = snap(lo2 + (ev.clientY - col.getBoundingClientRect().top) / PPM);
      openCreate({ day: c.day, start: m, staff: c.staff || null, post: c.post || null });
    });
    return col;
  }
  // ---- un bloc : heure et durée, confirmation ; prestation ; voiture ; client et poste (ou mécanicien) ; provenance et intervention.
  // Ce qui ne tient pas dans sa hauteur reste dans l'infobulle, le nom lu par les lecteurs d'écran et la fiche.
  function blockText(it, s, c) {
    const a = it.type === "rdv" ? it.src : null;
    const vehicle = it.type === "job" && it.src.vehicle ? (data.vehicles.find((v) => v.id === it.src.vehicle) || { label: "" }).label : "";
    const others = c.staff ? postsOf(it) : c.post ? peopleOf(it) : [...peopleOf(it), ...postsOf(it)];
    const what = it.type === "hold" ? it.title : svcText(it) || it.title;
    const car = a ? [a.car, a.plate].filter(Boolean).join(" · ") : vehicle;
    const who = [it.type === "hold" ? "" : it.title, ...others].filter(Boolean).join(" · ");
    const state = it.conflict ? "conflict" : it.state;
    const work = it.work && it.work !== "planned" ? `Intervention : ${workLabel(it.work)}` : "";
    const stay = it.type !== "hold" && (it.start !== s.a || it.end !== s.b) ? `dépôt ${timeLabel(it.start)} · restitution ${it.end > it.start ? timeLabel(it.end) : "fin de journée"}` : "";
    return { what, car, who, state, work, stay, when: range(s.a, s.b), len: dur(s.b - s.a), role: s.row && s.row.role !== "labour" ? ROLE[s.row.role] : "" };
  }
  // un bloc, comme la maquette : horaires et provenance (icône) ; prestation ; voiture et avancement ; client, mécanicien et poste ;
  // alerte. Autant de lignes que sa hauteur en permet, le reste dans l'infobulle, le nom lu par les lecteurs d'écran et la fiche.
  function block(s, c, px) {
    const it = s.item;
    const t = blockText(it, s, c);
    const h = (s.b - s.a) * PPM;
    // hauteurs de la maquette : marges 13 px, lignes de 11 à 13 px séparées de 4 px ; le bloc fait 2 px de moins que sa durée
    // (deux lignes dès 43 px, trois dès 58, quatre dès 73, cinq dès 88)
    const lines = h < 43 ? 1 : h < 58 ? 2 : h < 73 ? 3 : h < 88 ? 4 : 5;
    const stateLabel = t.state ? STATE[t.state][0] : "";
    const full = [`${t.when} (${t.len}${t.role ? `, ${t.role}` : ""})`, t.what, t.car, t.who, ORIGIN[it.origin][0], stateLabel, t.work, t.stay && cap(t.stay)].filter(Boolean);
    // l'avancement dit en mots : l'intervention quand elle a commencé, sinon la confirmation
    const status = it.type === "hold" ? "" : it.conflict ? STATE.conflict[0] : it.work && it.work !== "planned" ? workLabel(it.work) : stateLabel;
    const top = el("span", { class: "pl-ev-h" }, el("b", { text: `${hm(s.a)}–${s.b >= 1440 ? "24:00" : hm(s.b)}` }), icon(ORIGIN[it.origin][1]));
    const sub = [t.car, status].filter(Boolean).join(" · ");
    const parts = [
      top,
      el("span", { class: "pl-ev-t", text: t.what }),
      sub ? el("span", { class: "pl-ev-s", text: sub }) : null,
      t.who ? el("span", { class: "pl-ev-w", text: t.who }) : null,
      it.conflict ? el("span", { class: "pl-ev-a", text: "! Conflit de ressource" }) : null,
    ].filter(Boolean);
    const tone = toneOf(it);
    const b = el(
      "button",
      {
        type: "button",
        class: `pl-ev tone-${tone} st-${it.type === "hold" ? "hold" : it.state}${it.conflict ? " is-conflict" : ""}${it.noShow ? " is-noshow" : ""}${lines === 1 ? " is-tiny" : ""}`,
        "aria-label": full.join(", "),
        title: full.join("\n"),
        "data-id": it.id,
      },
      ...(lines === 1 ? [el("span", { class: "pl-ev-h" }, el("b", { text: hm(s.a) }), el("span", { class: "pl-ev-t", text: t.what }))] : parts.slice(0, lines)),
    );
    css(b, { top: px(s.a), height: `${Math.max(18, h - 2)}px`, "--lane": String(s.lane), "--lanes": String(s.lanes) });
    b.addEventListener("click", () => {
      if (swallowClick) return;
      openSheet(it);
    });
    b.addEventListener("pointerdown", (ev) => startDrag(ev, b, s, c));
    return b;
  }

  // ---- mois : six semaines, par jour le nombre, la charge et les trois premiers
  function month() {
    const list = items(), all = allItems();
    const [from] = period();
    const m = anchor.slice(0, 7);
    const grid = el("div", { class: "pl-month" }, ...WEEK.map((k, i) => el("span", { class: "pl-mhead", "aria-hidden": "true", text: dayLabel(addDays(from, i), { short: true }).split(" ")[0].replace(".", "") })));
    for (let i = 0; i < 42; i++) {
      const d = addDays(from, i);
      const day = list.filter((it) => it.day === d).sort((x, y) => x.start - y.start);
      const n = day.length;
      const closed = !openOn(d).length;
      const l = dayLoad(d, all);
      const p = l.avail ? pct(l.planned, l.avail) : null;
      grid.append(
        el(
          "button",
          { type: "button", class: `pl-mday${d.slice(0, 7) !== m ? " is-out" : ""}${d === data.today ? " is-today" : ""}${closed ? " is-closed" : ""}`, "aria-label": `${dayLabel(d)} : ${n ? plural(n, "élément") : "rien"}${p !== null ? `, charge ${p} %` : ""}${closed ? ", fermé" : ""}. Ouvrir le jour.`, onclick: () => go(() => ((anchor = d), (view = "day"))) },
          el("span", { class: "pl-mtop" }, el("b", { text: String(Number(d.slice(8))) }), p !== null && l.planned ? el("span", { class: "pl-mload", text: `${p} %` }) : null),
          n ? el("span", { class: "pl-mcount", text: plural(n, "élément") }) : null,
          ...day.slice(0, 3).map((it) => el("span", { class: `pl-mitem tone-${toneOf(it)} st-${it.type === "hold" ? "hold" : it.state}${it.conflict ? " is-conflict" : ""}` }, icon(it.conflict ? STATE.conflict[1] : it.state ? STATE[it.state][1] : ORIGIN.hold[1]), `${timeLabel(it.start)} ${it.title}`)),
          n > 3 ? el("span", { class: "pl-mmore", text: `+ ${n - 3}` }) : null,
        ),
      );
    }
    return grid;
  }

  // ================================================================= glisser-déposer
  function startDrag(ev, node, seg, col) {
    // une intervention commencée (voiture reçue…) ne se déplace plus (lot 3c)
    if (ev.button !== 0 || seg.item.day < data.today || (seg.item.work && seg.item.work !== "planned")) return;
    const r = node.getBoundingClientRect();
    drag = { node, seg, col, x: ev.clientX, y: ev.clientY, dy: ev.clientY - r.top, id: ev.pointerId, on: false, timer: null, touch: ev.pointerType === "touch" };
    if (drag.touch) drag.timer = setTimeout(() => drag && begin(), HOLD_MS);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", cancelDrag);
  }
  function begin() {
    drag.on = true;
    drag.node.classList.add("is-dragging");
    const g = drag.node.cloneNode(true);
    g.removeAttribute("aria-label");
    g.setAttribute("aria-hidden", "true");
    g.classList.add("pl-ghost");
    css(g, { "--lane": "0", "--lanes": "1", top: drag.node.style.top, height: drag.node.style.height }); // le clone ne garde pas forcément l'attribut style
    drag.ghost = g;
    try {
      drag.node.setPointerCapture(drag.id);
    } catch {
      // le pointeur peut déjà être relâché
    }
  }
  function moveDrag(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const far = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 6;
    if (!drag.on) {
      if (drag.touch) {
        if (far) cancelDrag(); // le doigt défile : pas de glisser
        return;
      }
      if (!far) return;
      begin();
    }
    ev.preventDefault();
    const target = dropTarget(ev);
    if (!target) return;
    drag.target = target;
    if (drag.ghost.parentNode !== target.col) target.col.append(drag.ghost);
    const lo = Number(target.col.closest(".pl-grid").dataset.lo);
    drag.ghost.style.top = `${(target.min - lo) * PPM}px`;
    drag.ghost.querySelector(".pl-ev-h b").textContent = hm(target.min);
  }
  function dropTarget(ev) {
    const col = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList && n.classList.contains("pl-col"));
    if (!col || col.dataset.key === "none") return null;
    const grid = col.closest(".pl-grid");
    const lo = Number(grid.dataset.lo), hi = Number(grid.dataset.hi);
    const len = drag.seg.b - drag.seg.a;
    const min = Math.min(Math.max(snap(lo + (ev.clientY - drag.dy - col.getBoundingClientRect().top) / PPM), lo), Math.max(lo, hi - SNAP));
    return { col, min, len };
  }
  function stopListening() {
    window.removeEventListener("pointermove", moveDrag);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", cancelDrag);
  }
  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    drag.node.classList.remove("is-dragging");
    drag = null;
    stopListening();
  }
  function endDrag(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    cancelDrag();
    if (!d.on || !d.target) return;
    swallowClick = true; // le clic qui suit le relâchement n'ouvre pas la fiche
    setTimeout(() => (swallowClick = false), 0);
    const it = d.seg.item, c = d.target.col.dataset, row = d.seg.row;
    const start = Math.max(0, Math.round((it.start + (d.target.min - d.seg.a)) / 5) * 5);
    const day = c.day;
    // ce que la colonne d'arrivée impose : semaine, le moteur choisit ; mécanicien ou poste, celui de la colonne
    const from = row ? row.id : null;
    let change;
    if (view === "week") change = { day, start, auto: true };
    else if (c.staff) change = { day, start, staff: from && row.target === "staff" ? swap(currentStaff(it), from, c.staff) : [c.staff], post: null, swapStaff: from && from !== c.staff ? [from, c.staff] : null };
    else change = { day, start, staff: view === "post" ? [] : currentStaff(it), post: c.post, swapPost: from && from !== c.post ? [from, c.post] : null };
    if (day === it.day && start === it.start && !change.swapStaff && !change.swapPost && !(row === undefined && (c.staff || c.post))) return;
    void tryMove(it, change);
  }
  const swap = (list, from, to) => [...new Set(list.map((x) => (x === from ? to : x)))];
  const currentStaff = (it) => [...new Set(it.plan.filter((r) => r.target === "staff" && r.role === "labour").map((r) => r.id))];
  const currentPost = (it) => (it.plan.find((r) => r.target === "resource" && r.role === "station") || { id: null }).id;
  const idsOf = (it, target) => [...new Set(it.plan.filter((r) => r.target === target).map((r) => r.id))];

  // ================================================================= déplacer (glisser ou fiche)
  // change : { day, start, staff: [id], post: id|null, auto?: true (le moteur choisit le mécanicien et le poste),
  //           swapStaff / swapPost : [ancien, nouveau] pour un créneau bloqué (ses autres mécaniciens et postes restent) }
  function moveBody(it, change, confirm) {
    const staff = change.auto ? [] : change.staff;
    const station = change.auto ? null : change.post;
    if (it.type === "rdv") return { day: change.day, time: hm(change.start), staff, station, ...(confirm ? { confirm: true } : {}) };
    const k = it.src;
    if (it.type === "job") return { kind: "job", label: k.label || "Rendez-vous", services: k.services.map((s) => ({ id: s.id, qty: s.qty })), vehicle: k.vehicle || null, day: change.day, time: hm(change.start), staff, station, ...(confirm ? { confirm: true } : {}) };
    const len = it.end - it.start;
    const people = change.swapStaff ? swap(idsOf(it, "staff"), ...change.swapStaff) : idsOf(it, "staff");
    const resources = change.swapPost ? swap(idsOf(it, "resource"), ...change.swapPost) : idsOf(it, "resource");
    return { kind: "hold", label: k.label || "Créneau bloqué", day: change.day, time: hm(change.start), to: change.start + len >= 1440 ? "24:00" : hm(change.start + len), staff: people, resources };
  }
  async function tryMove(it, change, { confirm = false, button = null } = {}) {
    const run = async () => {
      try {
        if (it.type === "rdv") await api.move(garageId, it.id, moveBody(it, change, confirm));
        else await api.saveBlock(garageId, it.id, moveBody(it, change, confirm));
        if (dlg().open) dlg().close();
        const text = `${it.title} : ${dayLabel(change.day, { short: true })} à ${timeLabel(change.start)}.`;
        alertBox(it.type === "rdv" && (change.day !== it.day || change.start !== it.start) ? `Déplacé. ${text} Le client est prévenu par e-mail.` : `Enregistré. ${text}`, "info");
        await reload(`Enregistré. ${text}`);
      } catch (e) {
        if (e.status === 409 || e.status === 422) return openSheet(it, { mode: "move", change, problem: e });
        fail(e);
      }
    };
    return button ? busy(button, run) : run();
  }

  // ================================================================= fiche (détail, déplacer, annuler, bloc)
  function frame(title, eyebrow, body, actions) {
    $("planForm").replaceChildren(
      el("div", { class: "sheet-head" }, el("div", {}, eyebrow ? el("p", { class: "eyebrow", text: eyebrow }) : null, el("h2", { id: "planDlgTitle", text: title })), el("button", { type: "button", class: "icon-btn", "aria-label": "Fermer", onclick: () => dlg().close() }, icon("i-close"))),
      ...body.filter((b) => b != null),
      el("p", { class: "field-err", id: "planErr", role: "alert", hidden: true }),
      el("div", { class: "sheet-actions" }, ...actions.filter((a) => a != null)),
    );
    if (!dlg().open) dlg().showModal();
  }
  function err(message) {
    $("planErr").textContent = message || "";
    $("planErr").hidden = !message;
  }
  const kv = (k, ...v) => (v.some(Boolean) ? el("li", {}, el("b", { text: k + " : " }), ...v.filter((x) => x !== "" && x != null)) : null);

  function openSheet(it, opts = {}) {
    sheet = { item: it, mode: opts.mode || "view", armed: false };
    if (sheet.mode === "move") return moveForm(it, opts);
    const a = it.type === "rdv" ? it.src : null;
    const k = it.type === "rdv" ? null : it.src;
    const facts = [];
    if (a) {
      facts.push(kv("Client", a.client || "effacé", a.phone ? " · " : null, a.phone ? el("a", { href: `tel:${a.phone}`, text: phoneText(a.phone) || a.phone }) : null));
      facts.push(kv("Voiture", [a.car, a.plate, a.vehicle ? (data.vehicles.find((v) => v.id === a.vehicle) || { label: "" }).label : ""].filter(Boolean).join(" · ")));
    } else if (k.vehicle) facts.push(kv("Véhicule", (data.vehicles.find((v) => v.id === k.vehicle) || { label: k.vehicle }).label));
    if (it.services.length) facts.push(kv("Prestations", svcText(it)));
    facts.push(kv(it.type === "hold" ? "Quand" : "Dépôt", `${dayLabel(it.day)} à ${timeLabel(it.start)}`));
    if (a && a.work && a.work.start) {
      const w0 = parisParts(Date.parse(a.work.start)), w1 = a.work.ready ? parisParts(Date.parse(a.work.ready)) : null;
      facts.push(kv("Travaux", `${timeLabel(w0.min)}${w1 ? "–" + timeLabel(w1.min) : ""}${a.work.labour ? ` (${dur(a.work.labour)} de main-d'œuvre)` : ""}`));
    } else if (it.type === "job" && it.plan.some((r) => r.role === "labour")) {
      const [w0, w1] = workSpan(it);
      facts.push(kv("Travaux", range(w0, w1)));
    }
    facts.push(kv(it.type === "hold" ? "Jusqu'à" : "Restitution", it.end > it.start ? timeLabel(it.end) : "fin de journée"));
    if (it.deadline) {
      const p = parisParts(it.deadline);
      facts.push(kv("À confirmer avant", `${dayLabel(p.iso, { short: true })} à ${timeLabel(p.min)}`));
    }
    const rows = it.plan.map((r) => el("li", {}, el("b", { text: r.name || "?" }), ` · ${ROLE[r.role]} · ${r.day !== it.day ? dayLabel(r.day, { short: true }) + " " : ""}${range(r.a, r.b)}${r.fixed ? " · choisi par vous" : ""}`));
    const body = [
      el(
        "p",
        { class: "pl-status" },
        el("span", { class: `pl-tag or-${it.origin}` }, icon(ORIGIN[it.origin][1]), ORIGIN[it.origin][0]),
        it.state ? el("span", { class: `pl-pill is-${it.state}` }, icon(STATE[it.state][1]), STATE[it.state][0]) : null,
        it.conflict ? el("span", { class: "pl-pill is-conflict" }, icon(STATE.conflict[1]), STATE.conflict[0]) : null,
        it.work ? el("span", { class: `pl-tag wk-${it.work}`, text: `Intervention : ${workLabel(it.work)}` }) : null,
      ),
      it.conflict ? el("div", { class: "pl-conflict", role: "note" }, el("p", {}, icon("i-flag"), el("b", { text: "En conflit : " }), "une affectation ne tient plus. Déplacez ou réaffectez."), el("ul", {}, ...it.conflict.map((t) => el("li", { text: t })))) : null,
      el("ul", { class: "pl-facts" }, ...facts),
      progress(it),
      rows.length ? el("h3", { text: "Affectations" }) : null,
      rows.length ? el("ul", { class: "pl-rows" }, ...rows) : el("p", { class: "muted", text: "Pas encore d'affectation." }),
    ];
    const past = it.day < data.today;
    const actions = [];
    const started = !!it.work && it.work !== "planned";
    if (!past && !started) actions.push(el("button", { type: "button", class: "btn primary", id: "planMove", onclick: () => openSheet(it, { mode: "move" }) }, icon("i-calendar"), "Déplacer ou réaffecter"));
    if (a && a.phone) actions.push(el("a", { class: "btn", href: `tel:${a.phone}` }, icon("i-phone"), "Appeler"));
    if (a && !past && !started && a.status === "confirmed") actions.push(el("button", { type: "button", class: "link-btn danger", onclick: () => cancelForm(it, "cancel") }, "Annuler ce rendez-vous"));
    if (a && a.status === "pending") actions.push(el("button", { type: "button", class: "btn", onclick: () => (dlg().close(), goPanel("requests")) }, icon("i-inbox"), "Répondre dans Demandes"));
    if (!a && !past) actions.push(el("button", { type: "button", class: "btn", onclick: () => blockForm({ item: it }) }, icon("i-edit"), "Modifier"));
    if (!a) actions.push(el("button", { type: "button", class: "link-btn danger", id: "planDel", onclick: () => removeBlock(it) }, it.type === "job" ? "Supprimer ce rendez-vous" : "Supprimer ce créneau"));
    frame(it.title, it.type === "hold" ? "Planning" : "Rendez-vous", body, actions);
    $("planForm").onsubmit = (ev) => ev.preventDefault();
    const first = $("planMove") || $("planForm").querySelector("[data-work], button.btn, a.btn");
    if (first) first.focus();
  }

  // ---- avancement de l'intervention (lot 3c) : les passages possibles ; « Voiture prête » d'un rendez-vous Pixcar prévient le client
  // par e-mail, case cochée par défaut. Du jour du rendez-vous à 30 jours après ; « Client absent » une fois l'heure de dépôt passée.
  const workable = (it) => !!it.work && it.state === "confirmed" && it.day <= data.today && it.day >= addDays(data.today, -30);
  function progress(it) {
    if (!workable(it)) return null;
    const started = it.day < data.today || parisParts(Date.now()).min >= it.start;
    const acts = workActions(it.work).filter((x) => x.to !== "no_show" || started);
    if (!acts.length) return null;
    const ready = it.type === "rdv" && acts.some((x) => x.to === "done");
    return el(
      "div",
      { class: "pl-work" },
      el("h3", { text: "Avancement" }),
      el("div", { class: "pl-work-acts" }, ...acts.map((x) => el("button", { type: "button", class: x.back ? "link-btn" : x.to === "done" ? "btn primary small" : "btn small", "data-work": x.to, onclick: (ev) => setWork(it, x.to, ev.currentTarget) }, x.label))),
      ready ? el("label", { class: "check pl-notify" }, el("input", { type: "checkbox", id: "planNotify", checked: true }), el("span", { text: "Prévenir le client par e-mail quand la voiture est prête" })) : null,
    );
  }
  async function setWork(it, to, button) {
    const body = { status: to, ...(to === "done" && it.type === "rdv" ? { notify: !!($("planNotify") && $("planNotify").checked) } : {}) };
    await busy(button, async () => {
      try {
        const out = await api.work(garageId, it.id, body);
        const text = `${it.title} : ${workLabel(out.work.noShow ? "no_show" : out.work.status)}${out.notified ? ", client prévenu par e-mail" : ""}.`;
        await reload(text);
        alertBox(text, "info");
        const next = allItems().find((x) => x.id === it.id);
        if (next && dlg().open) openSheet(next);
      } catch (e) {
        if (e.status === 409 || e.status === 422) return err(e.message);
        dlg().close();
        fail(e);
      }
    });
  }

  // déplacer au clavier : jour, heure, mécanicien, poste ; puis les retours de l'API (confirmation, conflit et autres horaires)
  function moveForm(it, { change = null, problem = null } = {}) {
    const ch = change || { day: it.day, start: it.start, staff: currentStaff(it), post: currentPost(it) };
    // confirm : le client sera prévenu ; shifted : les travaux attendent que le mécanicien (ou le poste) se libère
    const confirmAsk = problem && (problem.code === "confirm" || problem.code === "shifted");
    const shifted = problem && problem.code === "shifted";
    const reasons = (problem && problem.details && problem.details.reasons) || [];
    const alts = (problem && problem.details && problem.details.alternatives) || [];
    const staffSel = el("select", { id: "planMvStaff" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activeStaff().map((m) => el("option", { value: m.id, text: m.name, selected: !ch.auto && ch.staff[0] === m.id })));
    const postSel = el("select", { id: "planMvPost" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activePosts().map((x) => el("option", { value: x.id, text: x.name, selected: !ch.auto && ch.post === x.id })));
    const hold = it.type === "hold";
    const body = [
      el("p", { class: "help", text: it.type === "rdv" ? "Même heure, autre mécanicien ou poste : le client n'est pas dérangé. Autre heure : il est prévenu par e-mail, après votre confirmation." : "Pixcar vérifie que les mécaniciens et postes sont libres." }),
      el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planMvDay", text: "Jour" }), el("input", { id: "planMvDay", type: "date", value: ch.day, min: data.today, required: true })), el("span", {}, el("label", { for: "planMvTime", text: hold ? "De" : "Dépôt à" }), el("input", { id: "planMvTime", type: "time", step: "300", value: hm(ch.start), required: true }))),
      hold ? null : el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planMvStaff", text: "Mécanicien" }), staffSel), el("span", {}, el("label", { for: "planMvPost", text: "Poste" }), postSel)),
      problem && !confirmAsk ? el("div", { class: "pl-conflict", role: "alert" }, el("p", {}, icon("i-flag"), el("b", { text: problem.message })), reasons.length > 1 ? el("ul", {}, ...reasons.slice(1).map((t) => el("li", { text: t }))) : null) : null,
      alts.length
        ? el(
            "div",
            { class: "pl-alts" },
            el("p", { text: "Autres horaires possibles :" }),
            ...alts.map((x) =>
              el("button", { type: "button", class: "btn small", onclick: () => {
                $("planMvDay").value = x.day;
                $("planMvTime").value = x.time;
                if (!hold) $("planMvStaff").value = $("planMvPost").value = "";
                $("planMvSave").focus();
              } }, `${x.label}${x.back ? ` · rendue vers ${timeLabel(minOf(x.back))}` : ""}`),
            ),
          )
        : null,
      confirmAsk ? el("p", { class: "pl-ask", role: "alert" }, icon(shifted ? "i-clock" : "i-mail"), problem.message || "Le client sera prévenu par e-mail du nouvel horaire.") : null,
    ];
    frame(it.title, "Déplacer ou réaffecter", body, [
      el("button", { type: "submit", class: "btn primary", id: "planMvSave" }, shifted ? "Confirmer ces horaires" : confirmAsk ? "Confirmer et prévenir le client" : "Enregistrer"),
      el("button", { type: "button", class: "btn", onclick: () => openSheet(it) }, "Retour"),
    ]);
    $("planForm").onsubmit = (ev) => {
      ev.preventDefault();
      const day = $("planMvDay").value, start = minOf($("planMvTime").value);
      if (!day || !Number.isFinite(start)) return err("Choisissez un jour et une heure.");
      const s = hold ? "" : $("planMvStaff").value, p = hold ? "" : $("planMvPost").value;
      const next = hold ? { day, start } : { day, start, staff: s ? [s] : [], post: p || null, auto: !s && !p };
      // la confirmation ne vaut que pour le déplacement annoncé : s'il a changé, l'API redemande
      const same = JSON.stringify(moveBody(it, next)) === JSON.stringify(moveBody(it, ch));
      void tryMove(it, confirmAsk && same ? ch : next, { confirm: confirmAsk && same, button: $("planMvSave") });
    };
    (confirmAsk ? $("planMvSave") : $("planMvDay")).focus();
  }

  // annuler un rendez-vous confirmé, avec un motif transmis au client (une demande à confirmer se traite dans « Demandes »)
  function cancelForm(it, act) {
    const list = GARAGE_CANCEL_REASONS;
    frame(it.title, "Annuler le rendez-vous", [
      el("fieldset", { class: "ag-reasons" }, el("legend", { text: "Motif (transmis au client)" }), ...list.map(([code, label]) => el("label", { class: "choice-line" }, el("input", { type: "radio", name: "planWhy", value: code }), el("span", { text: label })))),
      el("label", { for: "planWhyNote" }, "Un mot pour le client ", el("small", { text: "facultatif" })),
      el("textarea", { id: "planWhyNote", rows: "3", maxlength: "300" }),
    ], [
      el("button", { type: "submit", class: "btn primary", id: "planWhySave" }, "Annuler le rendez-vous"),
      el("button", { type: "button", class: "btn", onclick: () => openSheet(it) }, "Retour"),
    ]);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const picked = $("planForm").querySelector('input[name="planWhy"]:checked');
      if (!picked) return err("Choisissez un motif : il est transmis au client.");
      await busy($("planWhySave"), async () => {
        try {
          await api.decide(garageId, it.id, act, { reason: picked.value, note: $("planWhyNote").value.trim() });
          dlg().close();
          alertBox(`Rendez-vous annulé. ${it.title} est prévenu(e) par e-mail, avec votre motif.`, "info");
          await reload("Rendez-vous annulé.");
        } catch (e) {
          if (e.status === 409 || e.status === 422) return err(e.message);
          dlg().close();
          fail(e);
        }
      });
    };
    $("planForm").querySelector('input[name="planWhy"]').focus();
  }

  // ================================================================= création rapide et modification d'un bloc
  function openCreate(at) {
    if (at.day < data.today) return;
    blockForm({ at });
  }
  function blockForm({ item = null, at = null, problem = null, draft = null, refocus = null }) {
    const k = item ? item.src : null;
    const d = draft || {
      kind: k ? k.kind : at.kind || "job",
      label: k ? k.label : "",
      day: k ? k.when.day : at.day,
      start: k ? minOf(k.when.start) : at.start,
      end: k ? minOf(k.when.end) : Math.min(1440, at.start + 60),
      services: k ? k.services.map((s) => ({ id: s.id, qty: s.qty })) : [],
      vehicle: k ? k.vehicle : "",
      staff: k ? (k.kind === "hold" ? idsOf(item, "staff") : currentStaff(item)) : at.staff ? [at.staff] : [],
      posts: k ? (k.kind === "hold" ? idsOf(item, "resource") : [currentPost(item)].filter(Boolean)) : at.post ? [at.post] : [],
    };
    const radio = (v, t) => el("label", { class: "choice-line" }, el("input", { type: "radio", name: "planKind", value: v, checked: d.kind === v, onchange: () => blockForm({ item, at, draft: { ...read(), kind: v }, refocus: `input[name="planKind"][value="${v}"]` }) }), el("span", { text: t }));
    const job = d.kind === "job";
    const svc = data.services.map((s) =>
      el(
        "label",
        { class: "chip pl-svc" },
        el("input", { type: "checkbox", name: "planSvc", value: s.id, checked: d.services.some((x) => x.id === s.id), onchange: () => blockForm({ item, at, draft: read(), refocus: `input[name="planSvc"][value="${s.id}"]` }) }),
        el("span", { text: s.label }),
        s.unit && d.services.some((x) => x.id === s.id)
          ? el("select", { class: "pl-qty", "data-qty": s.id, "aria-label": `Quantité : ${s.label}` }, ...[1, 2, 3, 4].map((n) => el("option", { value: String(n), text: `× ${n}`, selected: (d.services.find((x) => x.id === s.id) || {}).qty === n })))
          : null,
      ),
    );
    const needVehicle = d.services.some((x) => (data.services.find((s) => s.id === x.id) || {}).byVehicle);
    const checks = (name, list, chosen) => list.map((x) => el("label", { class: "chip" }, el("input", { type: "checkbox", name, value: x.id, checked: chosen.includes(x.id) }), el("span", { text: x.name })));
    const reasons = (problem && problem.details && problem.details.reasons) || [];
    const alts = (problem && problem.details && problem.details.alternatives) || [];
    const shifted = problem && problem.code === "shifted";
    const body = [
      item || (at && at.arrived) ? null : el("fieldset", { class: "ag-reasons pl-kind" }, el("legend", { text: "Quoi ?" }), radio("job", "Rendez-vous pris hors Pixcar (téléphone, comptoir)"), radio("hold", "Créneau bloqué (réunion, livraison, essai…)")),
      at && at.arrived ? el("p", { class: "pl-ask" }, icon("i-car"), "Client déjà sur place : la voiture est notée « reçue » dès l'enregistrement.") : null,
      el("label", { for: "planLabel" }, "Libellé ", el("small", { text: job ? "40 caractères, sans donnée sensible ; effacé 30 jours après" : "40 caractères" })),
      el("input", { id: "planLabel", type: "text", maxlength: "40", value: d.label, placeholder: job ? "M. Martin, Clio" : "Livraison pièces", autocomplete: "off", required: true }),
      el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planDay", text: "Jour" }), el("input", { id: "planDay", type: "date", value: d.day, min: data.today, required: true })), el("span", {}, el("label", { for: "planTime", text: job ? "Dépôt à" : "De" }), el("input", { id: "planTime", type: "time", step: "300", value: hm(d.start), required: true }))),
      job ? null : el("label", { for: "planTo", text: "À" }),
      job ? null : el("input", { id: "planTo", type: "time", step: "300", value: hm(Math.min(d.end, 1435)), required: true }),
      job ? el("fieldset", { class: "chips pl-svcs" }, el("legend", { text: "Prestations" }), ...(svc.length ? svc : [el("p", { class: "muted", text: "Aucune prestation n'a ses exigences (Mon atelier › Prestations)." })])) : null,
      job && needVehicle ? el("label", { for: "planVehicle", text: "Type de véhicule" }) : null,
      job && needVehicle ? el("select", { id: "planVehicle" }, el("option", { value: "", text: "Choisir…" }), ...data.vehicles.map((v) => el("option", { value: v.id, text: v.label, selected: d.vehicle === v.id }))) : null,
      job
        ? el("div", { class: "mg-row2" },
            el("span", {}, el("label", { for: "planStaff", text: "Mécanicien" }), el("select", { id: "planStaff" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activeStaff().map((m) => el("option", { value: m.id, text: m.name, selected: d.staff[0] === m.id })))),
            el("span", {}, el("label", { for: "planPost", text: "Poste" }), el("select", { id: "planPost" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activePosts().map((x) => el("option", { value: x.id, text: x.name, selected: d.posts[0] === x.id })))))
        : el("fieldset", { class: "chips pl-who" }, el("legend", { text: "Qui ou quoi est bloqué ?" }), ...checks("planHoldStaff", activeStaff(), d.staff), ...checks("planHoldPost", activePosts(), d.posts)),
      problem && !shifted ? el("div", { class: "pl-conflict", role: "alert" }, el("p", {}, icon("i-flag"), el("b", { text: problem.message })), reasons.length > 1 ? el("ul", {}, ...reasons.slice(1).map((t) => el("li", { text: t }))) : null) : null,
      shifted ? el("p", { class: "pl-ask", role: "alert" }, icon("i-clock"), problem.message) : null,
      alts.length
        ? el("div", { class: "pl-alts" }, el("p", { text: shifted ? "Ou un dépôt sans attente :" : "Autres horaires possibles :" }), ...alts.map((x) => el("button", { type: "button", class: "btn small", onclick: () => {
            $("planDay").value = x.day;
            $("planTime").value = x.time;
            $("planSave").focus();
          } }, `${x.label}${x.back ? ` · rendue vers ${timeLabel(minOf(x.back))}` : ""}`)))
        : null,
      el("p", { class: "help", text: job ? "Placé comme une demande (mêmes ressources, mêmes contrôles), sans les règles de la réservation en ligne. Aucun e-mail n'est envoyé." : "Refusé si un rendez-vous ou un autre bloc occupe déjà ces mécaniciens ou postes. Pour une absence ou une maintenance, utilisez leurs fiches." }),
    ];
    frame(item ? item.title : at && at.arrived ? "Client déjà sur place" : "Nouveau", item ? (job ? "Modifier le rendez-vous hors Pixcar" : "Modifier le créneau bloqué") : "Planning", body, [
      el("button", { type: "submit", class: "btn primary", id: "planSave" }, shifted ? "Confirmer ces horaires" : "Enregistrer"),
      el("button", { type: "button", class: "btn", onclick: () => (item ? openSheet(item) : dlg().close()) }, item ? "Retour" : "Annuler"),
    ]);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const v = read();
      const body = { kind: v.kind, label: v.label, day: v.day, time: hm(v.start) };
      if (v.kind === "job") Object.assign(body, { services: v.services, vehicle: v.vehicle || null, staff: v.staff, station: v.posts[0] || null, ...(at && at.arrived && !item ? { received: true } : {}) });
      // la confirmation ne vaut que pour ce qui a été annoncé : si le formulaire a changé, l'API redemande
      const confirmed = shifted && JSON.stringify(v) === JSON.stringify(d);
      if (confirmed) body.confirm = true;
      else Object.assign(body, { to: v.end >= 1440 ? "24:00" : hm(v.end), staff: v.staff, resources: v.posts });
      await busy($("planSave"), async () => {
        try {
          await api.saveBlock(garageId, item ? item.id : null, body);
          dlg().close();
          const what = at && at.arrived ? "Client déjà sur place, voiture reçue" : v.kind === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué";
          const w = confirmed && problem.details && problem.details.work;
          alertBox(`${what} ${item ? "modifié" : "ajouté"} : ${dayLabel(v.day, { short: true })} à ${timeLabel(v.start)}${w ? `, travaux de ${timeLabel(minOf(w.start))} à ${timeLabel(minOf(w.end))}` : ""}.`, "info");
          await reload(`${what} enregistré.`);
        } catch (e) {
          if (e.status === 409 && (e.code === "conflict" || e.code === "shifted")) return blockForm({ item, at, draft: v, problem: e, refocus: e.code === "shifted" ? "#planSave" : null });
          if (e.status === 409 || e.status === 422) return err(e.message);
          dlg().close();
          fail(e);
        }
      });
    };
    ($("planForm").querySelector(refocus || "#planLabel") || $("planLabel")).focus();
    function read() {
      const f = $("planForm");
      const kind = item ? d.kind : (f.querySelector('input[name="planKind"]:checked') || { value: d.kind }).value;
      const services = [...f.querySelectorAll('input[name="planSvc"]:checked')].map((i) => {
        const q = f.querySelector(`select[data-qty="${i.value}"]`);
        return { id: i.value, qty: q ? Number(q.value) : 1 };
      });
      const val = (id, dflt) => ($(id) ? $(id).value : dflt);
      return {
        kind,
        label: val("planLabel", d.label).trim(),
        day: val("planDay", d.day),
        start: minOf(val("planTime", hm(d.start))),
        end: $("planTo") ? minOf($("planTo").value) : d.end,
        services: d.kind === "job" ? services : d.services,
        vehicle: val("planVehicle", d.vehicle),
        staff: d.kind === "job" ? (val("planStaff", "") ? [val("planStaff", "")] : []) : [...f.querySelectorAll('input[name="planHoldStaff"]:checked')].map((i) => i.value),
        posts: d.kind === "job" ? (val("planPost", "") ? [val("planPost", "")] : []) : [...f.querySelectorAll('input[name="planHoldPost"]:checked')].map((i) => i.value),
      };
    }
  }

  async function removeBlock(it) {
    const btn = $("planDel");
    if (!sheet.armed) {
      sheet.armed = true;
      btn.textContent = "Confirmer la suppression";
      return;
    }
    await busy(btn, async () => {
      try {
        await api.deleteBlock(garageId, it.id);
        dlg().close();
        alertBox(`${it.type === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué"} supprimé.`, "info");
        await reload("Supprimé.");
      } catch (e) {
        if (e.status === 409) return err(e.message);
        dlg().close();
        fail(e);
      }
    });
  }

  // ---- absence d'un mécanicien, indisponibilité d'un poste (mêmes règles que dans Mon atelier ; rien n'est déplacé)
  function unavailForm(target, { day = null } = {}) {
    const pool = target === "staff" ? activeStaff() : activePosts();
    if (!pool.length) return alertBox(target === "staff" ? "Ajoutez d'abord un mécanicien (Mon atelier)." : "Ajoutez d'abord un poste (Mon atelier).");
    const kinds = ((st && st.catalogs && st.catalogs.kinds) || []).filter((k) => k.for === target || k.for === "both");
    const d0 = day && day >= data.today ? day : data.today;
    const who = target === "staff" ? (view === "staff" ? pickStaff : filters.staff || pool[0].id) : view === "post" ? pickPost : filters.post || pool[0].id;
    frame(target === "staff" ? "Absence d'un mécanicien" : "Indisponibilité d'un poste", "Planning", [
      el("label", { for: "planUnWho", text: target === "staff" ? "Mécanicien" : "Poste" }),
      el("select", { id: "planUnWho" }, ...pool.map((x) => el("option", { value: x.id, text: x.name, selected: x.id === who }))),
      el("label", { for: "planUnKind", text: "Motif" }),
      el("select", { id: "planUnKind" }, ...kinds.map((k) => el("option", { value: k.id, text: k.label }))),
      el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planUnFirst", text: "Du" }), el("input", { id: "planUnFirst", type: "date", value: d0, min: data.today, required: true })), el("span", {}, el("label", { for: "planUnLast", text: "Au" }), el("input", { id: "planUnLast", type: "date", value: d0, min: data.today }))),
      el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planUnFrom", text: "À partir de" }), el("input", { id: "planUnFrom", type: "time", step: "300" })), el("span", {}, el("label", { for: "planUnTo", text: "Jusqu'à" }), el("input", { id: "planUnTo", type: "time", step: "300" }))),
      el("p", { class: "help", text: "Sans heure : journées entières. Les rendez-vous déjà affectés ne bougent pas : ils apparaissent « En conflit » pour que vous décidiez." }),
      el("label", { for: "planUnLabel" }, "Précision ", el("small", { text: "facultatif" })),
      el("input", { id: "planUnLabel", type: "text", maxlength: "60", autocomplete: "off", "aria-describedby": "planUnHelp" }),
      el("p", { class: "help", id: "planUnHelp", text: target === "staff" ? "N'indiquez pas de motif médical ni d'information personnelle : « Congés », « Formation » ou « Absence » suffisent." : "Par exemple : révision du pont, attente d'une pièce." }),
    ], [
      el("button", { type: "submit", class: "btn primary", id: "planUnSave" }, "Enregistrer"),
      el("button", { type: "button", class: "btn", onclick: () => dlg().close() }, "Annuler"),
    ]);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      await busy($("planUnSave"), async () => {
        try {
          const first = $("planUnFirst").value;
          const out = await api.saveUnavail(garageId, {
            target,
            targetId: $("planUnWho").value,
            kind: $("planUnKind").value,
            first,
            last: $("planUnLast").value || first,
            from: $("planUnFrom").value || undefined,
            to: $("planUnTo").value || undefined,
            label: $("planUnLabel").value.trim(),
          });
          dlg().close();
          const n = (out.touched || []).length;
          const what = target === "staff" ? "Absence enregistrée." : "Indisponibilité enregistrée.";
          alertBox(n ? `${what} ${plural(n, "rendez-vous à venir est touché : il apparaît", "rendez-vous à venir sont touchés : ils apparaissent")} « En conflit » dans le planning.` : `${what} Aucun rendez-vous n'est touché.`, "info");
          await reload(what);
        } catch (e) {
          if (e.status === 409 || e.status === 422) return err(e.message);
          dlg().close();
          fail(e);
        }
      });
    };
    $("planUnWho").focus();
  }

  // ---- branchements
  // « Nouveau » : un petit menu ; le jour affiché (aujourd'hui s'il est dans la période), à 9:00 ou au prochain quart d'heure
  const menu = () => $("planNewMenu");
  function newMenu(on, { focus = true } = {}) {
    menu().hidden = !on;
    $("planNew").setAttribute("aria-expanded", String(on));
    if (on && focus) menu().querySelector("button").focus();
  }
  function newAt() {
    const [from, to] = period();
    const base = view === "day" ? anchor : data.today >= from && data.today <= to ? data.today : from;
    const day = base < data.today ? data.today : base;
    const soon = Math.ceil((parisParts(Date.now()).min + 15) / SNAP) * SNAP;
    return { day, start: day === data.today ? Math.min(Math.max(9 * 60, soon), 23 * 60) : 9 * 60, staff: view === "staff" ? pickStaff : null, post: view === "post" ? pickPost : null };
  }
  $("planNew").addEventListener("click", () => newMenu(menu().hidden));
  menu().addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-new]");
    if (!b) return;
    newMenu(false, { focus: false });
    const at = newAt();
    if (b.dataset.new === "job" || b.dataset.new === "hold") openCreate({ ...at, kind: b.dataset.new });
    else unavailForm(b.dataset.new, { day: at.day });
  });
  menu().addEventListener("keydown", (ev) => {
    const bs = [...menu().querySelectorAll("button")];
    const i = bs.indexOf(document.activeElement);
    if (ev.key === "Escape") {
      newMenu(false);
      $("planNew").focus();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      bs[(i + (ev.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus();
    }
  });
  document.addEventListener("click", (ev) => {
    if (!menu().hidden && !ev.target.closest(".pl-new")) newMenu(false, { focus: false });
  });
  $("planFToggle").addEventListener("click", () => showFilters($("planFilters").hidden));
  // recherche dans la période affichée : client ou libellé, voiture, immatriculation, prestation (sans accents ni majuscules)
  function setQuery(text) {
    query = fold(text.trim());
    if ($("planSearch").value !== text) $("planSearch").value = text;
  }
  $("planSearch").addEventListener("input", () => {
    setQuery($("planSearch").value);
    if (!data) return;
    render();
    const n = items().length;
    live(query ? (n ? `${plural(n, "élément")} correspond${n > 1 ? "ent" : ""} à la recherche.` : "Rien ne correspond à la recherche sur cette période.") : "Recherche effacée.");
  });
  // plein écran (maquette) : la barre latérale, le fil d'Ariane, le bandeau de chiffres et le pied de page s'effacent ; Échap en sort
  function focusMode(on) {
    document.body.classList.toggle("pl-focus", on);
    $("planFocus").setAttribute("aria-pressed", String(on));
    $("planFocusText").textContent = on ? "Quitter le plein écran" : "Plein écran";
    $("planFocus").querySelector("use").setAttribute("href", on ? "#i-unfull" : "#i-full");
  }
  $("planFocus").addEventListener("click", () => {
    const on = !document.body.classList.contains("pl-focus");
    focusMode(on);
    live(on ? "Plein écran. Échap pour en sortir." : "Plein écran quitté.");
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !document.body.classList.contains("pl-focus") || $("dash-planning").hidden || dlg().open || !menu().hidden || drag) return;
    focusMode(false);
    live("Plein écran quitté.");
    $("planFocus").focus();
  });
  $("planWeekend").addEventListener("click", () => {
    weekend = !weekend;
    render();
    live(weekend ? "Week-end affiché." : "Week-end masqué.");
  });
  // au doigt : une fois le glisser commencé (appui long), la page ne défile plus
  $("planGrid").addEventListener("touchmove", (ev) => drag && drag.on && ev.preventDefault(), { passive: false });
  $("planGrid").addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && drag) cancelDrag();
  });

  // depuis le tableau de bord (lot 3c) : la vue Jour d'une date (openDay, pendant le chargement de l'écran), puis, l'écran affiché, la
  // fiche d'un rendez-vous (showItem) ou un formulaire de création sur aujourd'hui (form : job, hold, staff, resource ; arrived : client
  // déjà sur place, au prochain multiple de 5 minutes)
  async function openDay(id, day) {
    if (garageId !== id) {
      garageId = id;
      pickStaff = pickPost = null;
      for (const k of Object.keys(filters)) filters[k] = "";
      setQuery("");
      showFilters(false);
    }
    view = "day";
    anchor = day;
    await open(id, { focus: false });
  }
  function showItem(itemId) {
    const it = data ? allItems().find((x) => x.id === itemId) : null;
    if (it) openSheet(it);
    return !!it;
  }
  function form(kind, { arrived = false } = {}) {
    if (!data) return;
    if (kind === "job" || kind === "hold") {
      const now = parisParts(Date.now()).min;
      openCreate(arrived ? { day: data.today, start: Math.min(1435, (Math.floor(now / 5) + 1) * 5), kind: "job", arrived: true } : { ...newAt(), kind });
    } else unavailForm(kind, { day: data.today });
  }

  return { open, openDay, showItem, form, reset: () => (data = null) };
}
