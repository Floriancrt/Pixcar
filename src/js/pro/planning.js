// Espace Pro, écran « Gestion d'atelier » (docs/gestion-atelier.md, 25 octobre 2026 ; avant : « Planning », docs/calendrier-avance.md,
// lot 3b). Deux affichages, choisis par le compte, sur les mêmes données et sans effet sur les horaires proposés en ligne : Simple (Jour,
// Semaine, Liste ; ni mécaniciens ni postes) et Avancé (un espace par besoin : Agenda, Équipe, Équipements, Suivi des interventions,
// Charge et capacité ; atelier.js). Ce qui suit décrit l'agenda, commun aux deux.
// Planning (lot 3b) : une vue d'ensemble (rendez-vous, charge
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
import * as A from "./atelier.js";
import * as K from "./workshop.js";

const { cap, css, dur, hrs, inter, lanes, merge, minus, pct, plural, range, total } = K;

// les vues de chaque affichage (Simple) et de chaque espace (Avancé)
const VIEWS = {
  simple: [["day", "Jour"], ["week", "Semaine"], ["list", "Liste"]],
  agenda: [["day", "Jour"], ["week", "Semaine"], ["month", "Mois"], ["list", "Liste"]],
  team: [["day", "Jour"], ["week", "Semaine"]],
  equip: [["day", "Jour"], ["week", "Semaine"]],
  track: [["day", "Jour"]],
  load: [["day", "Jour"], ["week", "Semaine"]],
};
const SPACES = [["agenda", "Agenda", "i-calendar"], ["team", "Équipe", "i-users"], ["equip", "Équipements", "i-wrench"], ["track", "Suivi", "i-list"], ["load", "Charge", "i-gauge"]];
// trois dimensions, séparées à l'écran : origine (canal), confirmation (et l'alerte), état de l'intervention (ordres de réparation, lot 3c).
// Une seule icône d'origine ; le canal (Pixcar, téléphone, sur place, autre) et la méthode (réservé en ligne par le client, saisi par le
// garage) sont enregistrés à part.
const CHANNEL = { pixcar: ["Pixcar", "i-globe"], phone: ["Téléphone", "i-phone"], walkin: ["Sur place", "i-car"], other: ["Autre", "i-edit"], hold: ["Créneau bloqué", "i-lock"] };
const STATE = { pending: ["À confirmer", "i-clock"], confirmed: ["Confirmé", "i-check"], conflict: ["En conflit", "i-flag"] };
// filtre « État » : la confirmation, l'avancement, l'alerte, l'affectation
const STATES = [["pending", "À confirmer"], ["live", "À l'atelier"], ["planned", "À venir"], ["received", "Voiture reçue"], ["in_progress", "En cours"], ["wait", "En attente"], ["done", "Prête"], ["returned", "Restituée"], ["no_show", "Client absent"], ["conflict", "En conflit"], ["unassigned", "À affecter"]];
// affichage choisi (Simple, Avancé), gardé dans ce navigateur en attendant la préférence du compte
const DISPLAY_KEY = "pixcar-pro-display";
// durées proposées à la saisie d'un rendez-vous (minutes)
const DURATIONS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480];
const WEEK = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const SNAP = 15; // pas du glisser-déposer, en minutes
const HOLD_MS = 350; // appui long avant de glisser au doigt
const ROLE = { labour: "main-d'œuvre", station: "poste", tool: "équipement" };
let PPM = 68 / 60; // pixels par minute des grilles horaires : 68 px par heure comme la maquette (1 px par minute sur téléphone)
const monday = (iso) => addDays(iso, -WEEK.indexOf(weekday(iso)));
const snap = (m, step = SNAP) => Math.round(m / step) * step;
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
// accountView() : l'affichage enregistré pour ce compte (préférence « view » de GET /v1/pro/garages/:id) ; onView(v) : l'affichage choisi
export function createPlanning({ api, $, el, icon, alertBox, busy, apiProblem, goPanel, accountView = () => null, onView = () => {} }) {
  let garageId = null;
  let data = null; // réponse de GET …/calendar/agenda
  let st = null; // réponse de GET …/calendar (horaires des mécaniciens et postes, fenêtre de réservation, motifs d'absence)
  let deadlines = new Map(); // demande à confirmer → heure limite (ms)
  let view = null;
  let anchor = null; // jour de référence (AAAA-MM-JJ)
  let display = null; // affichage : "simple" ou "advanced" (choix du compte, jamais un réglage du garage)
  let space = "agenda"; // affichage avancé : agenda, team, equip, track, load
  let dayBy = "staff"; // vue Jour de l'agenda avancé : colonnes par mécanicien, par poste, ou « all » (une seule)
  let skill = ""; // Équipe : compétence demandée
  let trackMode = "all"; // Suivi : tout, en retard, à traiter
  let weekend = false; // week-end fermé affiché quand même
  const filters = { staff: "", post: "", service: "", origin: "", state: "" };
  let query = ""; // recherche (client, véhicule, immatriculation, prestation), sans accents
  let stripOff = null; // bandeau de chiffres masqué (lu une fois dans le navigateur)
  let sheet = null; // { item, mode, … } fiche ouverte
  let shown = null; // identifiant du rendez-vous ou du bloc dont le panneau parle (mis en évidence dans la grille)
  let closing = 0; // fermeture du panneau en cours (minuterie)
  let opener = null; // ce qui avait le focus avant l'ouverture du panneau
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
  // l'espace affiché : l'agenda en affichage simple
  const kind = () => (display === "advanced" ? space : "agenda");
  const viewsOf = () => VIEWS[display === "advanced" ? space : "simple"];
  const advanced = () => display === "advanced";
  // des mécaniciens ou des postes à montrer (calcul par ressources, ou fiches saisies pour l'affichage avancé)
  const hasRes = () => !!data && (data.staff.length > 0 || data.resources.length > 0);
  // calcul des disponibilités par ressources : seul cas où l'on choisit un mécanicien ou un poste (l'API le refuse sinon)
  const byRes = () => !!st && st.mode === "advanced";

  // ================================================================= ouverture et chargement
  // space : un espace de l'affichage avancé à ouvrir (Mon garage › Modules › « Ouvrir ») ; l'affichage passe alors en avancé
  async function open(id, { focus = true, space: want = null } = {}) {
    if (garageId !== id) {
      garageId = id;
      view = null;
      anchor = null;
      display = null;
      space = "agenda";
      skill = "";
      trackMode = "all";
      for (const k of Object.keys(filters)) filters[k] = "";
      setQuery("");
      showFilters(false);
    }
    focusMode(false);
    closeSide({ now: true, refocus: false });
    anchor ||= today();
    // l'affichage du compte (préférence enregistrée par l'API, sinon celle gardée dans ce navigateur) ; à la première visite, celui qui
    // va avec le calcul des disponibilités du garage (par ressources : avancé ; par créneaux : simple), d'où les réglages lus d'abord
    if (!display) {
      const mine = accountView();
      display = mine === "simple" || mine === "advanced" ? mine : readDisplay();
      if (!display) {
        st = await api.calendar(id);
        display = st.mode === "advanced" ? "advanced" : "simple";
      }
    }
    if (want) {
      space = want;
      if (display !== "advanced") remember((display = "advanced"));
    }
    view ||= narrow() ? (display === "simple" ? "list" : "day") : "week";
    if (!viewsOf().some(([k]) => k === view)) view = viewsOf()[0][0];
    // les réglages et la période en même temps (une seule attente au lieu de deux)
    const [cal, ok] = await Promise.all([api.calendar(id), load({ todo: true })]);
    st = cal;
    if (!ok) return;
    render();
    if (focus) $("planTitle").focus();
  }
  function readDisplay() {
    try {
      const v = localStorage.getItem(DISPLAY_KEY);
      return v === "simple" || v === "advanced" ? v : null;
    } catch {
      return null;
    }
  }
  function writeDisplay(v) {
    try {
      localStorage.setItem(DISPLAY_KEY, v);
    } catch {
      // stockage refusé : le choix ne vaut que pour cette visite
    }
  }
  // le choix d'affichage suit le compte (d'un ordinateur ou d'un téléphone à l'autre) ; s'il ne s'enregistre pas, il vaut dans ce navigateur
  function remember(v) {
    writeDisplay(v);
    onView(v);
    Promise.resolve(api.putPrefs(garageId, { view: v })).catch(() => {});
  }
  // changer d'affichage ne touche à rien d'autre que l'écran : ni rendez-vous, ni affectations, ni horaires proposés en ligne
  async function setDisplay(v) {
    if (v === display) return;
    display = v;
    remember(v);
    if (v === "simple") {
      filters.staff = filters.post = "";
      if (filters.state === "unassigned") filters.state = "";
    }
    if (!viewsOf().some(([k]) => k === view)) view = viewsOf()[0][0];
    closeSide({ now: true, refocus: false });
    await go(() => {});
    live(v === "simple" ? "Affichage simple : vos rendez-vous, sans mécaniciens ni postes." : "Affichage avancé : agenda, équipe, équipements, suivi et charge.");
  }
  async function setSpace(v) {
    if (v === space) return;
    space = v;
    if (!viewsOf().some(([k]) => k === view)) view = viewsOf()[0][0];
    closeSide({ now: true, refocus: false });
    await go(() => {});
    live(`${SPACES.find(([k]) => k === v)[1]}.`);
  }
  function period() {
    // suivi : la journée, plus les deux semaines d'avant (voitures encore à l'atelier)
    if (kind() === "track") return [addDays(anchor, -13), anchor];
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
    const k = it.src || {};
    const v = k.vehicle ? (data.vehicles.find((x) => x.id === k.vehicle) || { label: "" }).label : "";
    return fold([it.title, svcText(it), k.car, k.plate, k.plate && k.plate.replace(/[\s-]/g, ""), v].filter(Boolean).join(" "));
  }
  // l'avancement tel que le filtre « État » le lit
  function stateKey(it) {
    if (it.type === "hold") return "hold";
    if (it.noShow) return "no_show";
    if (it.state === "pending") return "pending";
    const w = it.work || "planned";
    return w === "waiting_parts" || w === "suspended" ? "wait" : w;
  }
  const unassigned = (it) => it.type !== "hold" && !it.noShow && it.state === "confirmed" && !it.plan.some((r) => r.target === "staff");
  function match(it) {
    if (query && !hay(it).includes(query)) return false;
    if (filters.staff && !it.plan.some((r) => r.target === "staff" && r.id === filters.staff)) return false;
    if (filters.post && !it.plan.some((r) => r.target === "resource" && r.id === filters.post)) return false;
    if (filters.service && !it.services.some((s) => s.id === filters.service)) return false;
    if (filters.origin && it.channel !== filters.origin) return false;
    if (filters.state === "conflict") return !!it.conflict;
    if (filters.state === "unassigned") return unassigned(it);
    if (filters.state === "live") return it.type !== "hold" && !it.noShow && ["received", "in_progress", "waiting_parts", "suspended"].includes(it.work);
    return !filters.state || stateKey(it) === filters.state;
  }
  const svcText = (it) => it.services.map((s) => s.label).join(" + ");
  // ce que montrent les vues : origine (canal), avancement (libellé et teinte), voiture, prestation, téléphone, durées
  const chan = (it) => CHANNEL[it.channel] || CHANNEL.phone;
  function status(it) {
    const key = stateKey(it);
    if (key === "hold") return { key, label: "Créneau bloqué", tone: "hold" };
    if (key === "pending") return { key, label: STATE.pending[0], tone: "pending" };
    if (key === "planned") return { key, label: "À venir", tone: toneOf(it) };
    return { key, label: workLabel(it.noShow ? "no_show" : it.work), tone: toneOf(it) };
  }
  function carText(it) {
    const k = it.src || {};
    const type = k.vehicle ? (data.vehicles.find((v) => v.id === k.vehicle) || { label: "" }).label : "";
    return [k.car, k.plate].filter(Boolean).join(" · ") || type;
  }
  const what = (it) => (it.type === "hold" ? it.title : svcText(it) || it.title);
  const phoneOf = (it) => (it.type === "hold" ? "" : (it.src && it.src.phone) || "");
  // main-d'œuvre prévue, fin des travaux et restitution (minutes du jour) quand on les connaît
  function labourOf(it) {
    const w = it.type === "rdv" && it.src.work;
    if (w && w.labour) return w.labour;
    const rows = it.plan.filter((r) => r.target === "staff" && r.role === "labour");
    if (rows.length) return total(rows.map((r) => [r.a, r.b]));
    return (it.src && it.src.minutes) || 0;
  }
  function dueOf(it) {
    const w = it.type === "rdv" && it.src.work;
    if (w && w.ready) return parisParts(Date.parse(w.ready)).min;
    return workSpan(it)[1];
  }
  const backOf = (it) => (it.type !== "hold" && it.end > it.start ? it.end : null);
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
    renderHead();
    renderSpaces();
    renderSummary();
    $("planSummary").hidden = kind() === "load";
    renderBar();
    renderFilters();
    renderLegend();
    const grid = $("planGrid");
    const k = kind();
    if (k === "team") grid.replaceChildren(A.resourceView(views, "staff"));
    else if (k === "equip") grid.replaceChildren(A.resourceView(views, "resource"));
    else if (k === "track") grid.replaceChildren(A.trackView(views));
    else if (k === "load") grid.replaceChildren(A.loadView(views));
    else if (view === "list") grid.replaceChildren(A.listView(views));
    else grid.replaceChildren(view === "month" ? month() : timeGrid(columns()));
    $("planLegend").hidden = k === "load" || k === "track";
  }
  // ce que les vues d'atelier.js lisent du Planning (état et actions)
  const views = {
    el: (...a) => el(...a),
    icon: (...a) => icon(...a),
    data: () => data,
    st: () => st,
    today: () => data.today,
    anchor: () => anchor,
    view: () => view,
    display: () => display,
    days: () => (view === "day" ? [anchor] : weekDays(allItems())),
    items: () => items(),
    allItems: () => allItems(),
    emptyText: () => (query ? "Aucun rendez-vous ne correspond à la recherche sur cette période." : Object.values(filters).some(Boolean) ? "Rien ne correspond aux filtres sur cette période." : "Rien de prévu sur cette période."),
    openOn: (d) => openOn(d),
    awayOn: (id, d) => awayOn(id, d),
    hoursFor: (x, d) => hoursFor(x, d),
    staffLoad: (m, d) => staffLoad(m, d),
    postLoad: (x, d) => postLoad(x, d),
    status,
    chan,
    what,
    carText,
    phoneOf,
    labourOf,
    dueOf,
    backOf,
    peopleOf: (it) => peopleOf(it),
    postsOf: (it) => postsOf(it),
    workSpan: (it) => workSpan(it),
    workable: (it) => workable(it),
    shown: () => shown,
    skillFilter: () => skill,
    trackFilter: () => trackMode,
    openSheet: (it) => openSheet(it),
    openCreate: (at) => openCreate(at),
    setWork: (it, to, button, opts) => setWork(it, to, button, opts),
    drop: (seg, target) => applyDrop(seg, target),
    swallow: () => swallowClick,
    swallowNext: () => {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    },
    goDay: (d) => go(() => ((anchor = d), (view = "day"))),
    goResources: () => goPanel("garage", { tab: "resources" }),
  };

  // ---- en-tête : garage et date consultée ; affichage Simple | Avancé ; ce que propose « Nouveau »
  function renderHead() {
    const garage = ($("navGarage") && $("navGarage").textContent.trim()) || "";
    const when = view === "day" || kind() === "track" ? cap(dayLabel(anchor, { year: true })) : kind() === "agenda" && view === "month" ? cap(new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" })) : `Semaine ${spanLabel(weekDays(allItems()))}`;
    $("planSub").textContent = [garage, when].filter(Boolean).join(" · ");
    for (const b of $("planMode").querySelectorAll("button")) {
      const on = b.dataset.display === display;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    // absences et indisponibilités : dans l'affichage avancé, quand il y a des mécaniciens ou des postes
    for (const b of menu().querySelectorAll("[data-res]")) b.hidden = !advanced() || !(b.dataset.new === "staff" ? activeStaff().length : activePosts().length);
  }
  // ---- espaces de l'affichage avancé : ceux des modules actifs du garage (Mon garage › Modules)
  const MODULE_OF = { team: "staff", equip: "equip", track: "track", load: "load" };
  const spaceOn = (k) => k === "agenda" || !!({ staff: true, equip: true, track: true, load: true, ...((st && st.modules) || {}) })[MODULE_OF[k]];
  function renderSpaces() {
    const box = $("planSpaces");
    box.hidden = !advanced();
    if (!advanced()) return box.replaceChildren();
    if (!spaceOn(space)) space = "agenda";
    box.replaceChildren(...SPACES.filter(([k]) => spaceOn(k)).map(([k, name, ic]) => el("button", { type: "button", class: "pl-space", "aria-pressed": String(k === space), onclick: () => setSpace(k) }, icon(ic), name)));
  }

  // ---- vue d'ensemble de la période affichée (tout compté, sans les filtres)
  function summaryDays() {
    if (view === "day" || kind() === "track") return [anchor];
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
    const when = days.length === 1 ? (days[0] === data.today ? "aujourd'hui" : dayLabel(days[0])) : view === "month" ? new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" }) : days.includes(data.today) ? "cette semaine" : `semaine du ${dayLabel(days[0], { short: true })}`;
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
    let cards;
    if (!advanced()) {
      // affichage simple : rendez-vous de la période, voitures à l'atelier maintenant, terminés, disponibilités
      const live = allItems().filter((it) => it.type !== "hold" && !it.noShow && it.day <= data.today && ["received", "in_progress", "waiting_parts", "suspended"].includes(it.work));
      const done = appts.filter((it) => it.work === "done" || it.work === "returned");
      const free = data.free ? days.reduce((n, d) => n + (data.free[d] || 0), 0) : null;
      let freeCard;
      if (free !== null) freeCard = card("free", "Disponibilités", String(free), `${free > 1 ? "horaires encore réservables" : "horaire encore réservable"} en ligne`);
      else if (avail) freeCard = card("free", "Disponibilités", hrs(Math.max(0, avail - planned)), "de main-d'œuvre encore libre");
      else freeCard = card("free", "Disponibilités", "—", st && st.enabled ? "rien d'ouvert sur la période" : "rendez-vous en ligne fermés");
      cards = [
        card("rdv", days.length === 1 && days[0] === data.today ? "Rendez-vous du jour" : "Rendez-vous", String(appts.length), pending.length ? `dont ${pending.length} à confirmer` : "aucun à confirmer", pending.length ? () => setFilter("state", "pending") : null),
        card("live", "À l'atelier", String(live.length), live.length > 1 ? "voitures arrivées ou en cours" : "voiture arrivée ou en cours", live.length ? () => setFilter("state", "live") : null),
        card("done", "Terminés", String(done.length), done.length > 1 ? "prêts ou restitués" : "prêt ou restitué"),
        freeCard,
      ];
    } else
      cards = [
        card("rdv", "Rendez-vous", String(appts.length), pending.length ? `${plural(pending.length, "à confirmer", "à confirmer")}` : "Aucun à confirmer", pending.length ? () => setFilter("state", "pending") : null),
        card("load", "Charge atelier", avail ? `${load} %` : "—", avail ? `${hrs(planned)} / ${hrs(avail)}` : staff.length ? "Atelier fermé" : "Aucun mécanicien"),
        days.length === 1
          ? card("staff", "Mécaniciens", `${staff.length - absent.length}/${staff.length}`, absent.length ? `${plural(absent.length, "absent")} : ${absent.map((m) => m.name).join(", ")}` : "Tous présents")
          : card("staff", "Mécaniciens", String(staff.length), absent.length ? `${plural(absent.length, "absent")} sur la période` : "Aucune absence"),
        card(
          "alert",
          "Alertes",
          String(conflicts.length + urgent.length),
          conflicts.length || urgent.length ? [conflicts.length ? plural(conflicts.length, "conflit") : "", urgent.length ? `${urgent.length} à confirmer ${deadlineText(urgent[0].deadline)}` : ""].filter(Boolean).join(" · ") : "Rien à signaler",
          conflicts.length ? () => setFilter("state", "conflict") : urgent.length ? () => setFilter("state", "pending") : null,
        ),
      ];
    $("planSummary").replaceChildren(
      title,
      el("div", { class: "pl-strip" }, el("ul", { class: "pl-cards" }, ...cards), el("button", { type: "button", class: "pl-icon pl-strip-hide", id: "planStripHide", "aria-label": "Masquer les indicateurs", onclick: () => setStrip(false) }, icon("i-close"))),
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
      ...viewsOf().map(([k, name]) => el("button", { type: "button", class: "pl-view", "aria-pressed": String(k === view), onclick: () => go(() => (view = k)) }, name)),
    );
    $("planViews").hidden = viewsOf().length < 2;
    let label;
    const daily = view === "day" || kind() === "track";
    if (daily) label = dayLabel(anchor, { year: true });
    else if (view === "month") label = new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" });
    else label = spanLabel(weekDays());
    $("planRange").textContent = cap(label);
    const step = daily ? 1 : view === "month" ? 0 : 7;
    $("planPrev").onclick = () => go(() => (anchor = step ? addDays(anchor, -step) : shiftMonth(-1)));
    $("planNext").onclick = () => go(() => (anchor = step ? addDays(anchor, step) : shiftMonth(1)));
    $("planToday").onclick = () => go(() => (anchor = today()));
    $("planPrev").setAttribute("aria-label", daily ? "Jour précédent" : view === "month" ? "Mois précédent" : "Semaine précédente");
    $("planNext").setAttribute("aria-label", daily ? "Jour suivant" : view === "month" ? "Mois suivant" : "Semaine suivante");
    const pick = $("planPick");
    const k = kind();
    if (k === "agenda" && view === "day" && advanced() && hasRes())
      pick.replaceChildren(
        selectBox("planBy", "Colonnes", [["all", "Ensemble"], ["staff", "Par mécanicien"], ["post", "Par poste"]], dayBy, (v) => {
          dayBy = v;
          render();
        }),
      );
    else if (k === "team" && st && st.skills && st.skills.length)
      pick.replaceChildren(
        selectBox("planSkill", "Compétence", [["", "Toutes"], ...st.skills.map((x) => [x.id, x.label])], skill, (v) => {
          skill = v;
          render();
        }),
      );
    else if (k === "track")
      pick.replaceChildren(
        el(
          "div",
          { class: "pl-seg", role: "group", "aria-label": "Interventions" },
          ...[["all", "Toutes"], ["late", "En retard"], ["todo", "À traiter"]].map(([v, t]) =>
            el("button", { type: "button", "aria-pressed": String(trackMode === v), onclick: () => ((trackMode = v), render(), live(`Suivi : ${t.toLowerCase()}.`)) }, t),
          ),
        ),
      );
    else pick.replaceChildren();
    const we = $("planWeekend");
    we.hidden = daily || view === "month" || k === "load" || (!weekend && !hiddenWeekend());
    we.textContent = weekend ? "Masquer le week-end" : "Afficher le week-end";
    // filtres et recherche : pour les vues qui listent des rendez-vous
    const filterable = k !== "load";
    $("planFToggle").hidden = !filterable;
    $("planSearch").closest(".pl-search").hidden = !filterable;
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

  // ---- filtres : un panneau à gauche de la grille, entièrement repliable (la grille prend alors toute la place) ; chaque filtre actif
  // reste visible en puce sous la barre d'outils, qui le retire d'un clic ; « Réinitialiser les filtres » les retire tous
  const FILTERS = () => [
    ["state", "planFState", "État", STATES.filter(([k]) => advanced() || k !== "unassigned")],
    ["origin", "planFOrigin", "Origine", Object.entries(CHANNEL).map(([k, [t]]) => [k, t])],
    ["service", "planFService", "Prestation", data.services.map((s) => [s.id, s.label])],
    ...(advanced() && data.staff.length ? [["staff", "planFStaff", "Mécanicien", data.staff.map((m) => [m.id, m.name])]] : []),
    ...(advanced() && data.resources.length ? [["post", "planFPost", "Poste", data.resources.map((x) => [x.id, x.name])]] : []),
  ];
  function showFilters(on) {
    $("planFilters").hidden = !on;
    $("planFToggle").setAttribute("aria-expanded", String(on));
    $("planLayout").classList.toggle("has-filters", on);
  }
  function setFilter(key, value, { focus = null } = {}) {
    filters[key] = value;
    render();
    const n = items().length;
    live(Object.values(filters).some(Boolean) ? `Filtre appliqué : ${plural(n, "élément")} affiché${n > 1 ? "s" : ""}.` : "Filtres retirés.");
    if (focus) ($(focus) || $("planFToggle")).focus();
  }
  function resetFilters({ focus = null } = {}) {
    for (const k of Object.keys(filters)) filters[k] = "";
    render();
    live("Filtres réinitialisés.");
    if (focus) ($(focus) || $("planFToggle")).focus();
  }
  function renderFilters() {
    const defs = FILTERS();
    for (const k of Object.keys(filters)) if (filters[k] && !defs.some(([d]) => d === k)) filters[k] = "";
    const active = defs.filter(([k]) => filters[k]);
    $("planFCount").hidden = !active.length;
    $("planFCount").textContent = active.length ? String(active.length) : "";
    $("planFToggle").setAttribute("aria-label", active.length ? `Filtres, ${plural(active.length, "actif")}` : "Filtres");
    $("planChips").replaceChildren(
      ...active.map(([k, , labelText, options]) => {
        const text = `${labelText} : ${(options.find(([v]) => v === filters[k]) || ["", "?"])[1]}`;
        return el("li", {}, el("button", { type: "button", class: "pl-chip", "aria-label": `Retirer le filtre ${text}`, onclick: () => setFilter(k, "", { focus: "planFToggle" }) }, text, icon("i-close")));
      }),
      ...(active.length > 1 ? [el("li", {}, el("button", { type: "button", class: "pl-chip is-reset", onclick: () => resetFilters({ focus: "planFToggle" }) }, "Tout retirer"))] : []),
    );
    $("planFilters").replaceChildren(
      el("div", { class: "pl-f-head" }, el("h2", { id: "planFTitle", text: "Filtres" }), el("button", { type: "button", class: "pl-icon", id: "planFClose", "aria-label": "Replier les filtres", onclick: () => (showFilters(false), $("planFToggle").focus()) }, icon("i-close"))),
      ...defs.map(([k, id, labelText, options]) =>
        k === "state" || k === "origin"
          ? el(
              "fieldset",
              { class: "pl-f-group" },
              el("legend", { text: labelText }),
              ...[["", "Tous"], ...options].map(([v, t]) =>
                el("label", { class: "pl-f-opt" }, el("input", { type: "radio", name: id, value: v, checked: filters[k] === v, onchange: () => setFilter(k, v, { focus: null }) }), el("span", { text: t })),
              ),
            )
          : el("div", { class: "pl-f-group" }, selectBox(id, labelText, [["", "Tous"], ...options], filters[k], (v) => setFilter(k, v))),
      ),
      el("button", { type: "button", class: "btn small pl-f-reset", id: "planFReset", disabled: !active.length, onclick: () => resetFilters({ focus: "planFToggle" }) }, "Réinitialiser les filtres"),
    );
  }
  // ---- légende sous la grille, comme la maquette : l'avancement (pastilles de couleur), les créneaux, puis l'origine et le nombre
  function renderLegend() {
    const dot = (tone, text) => el("li", {}, el("i", { class: `pl-dot tone-${tone}`, "aria-hidden": "true" }), text);
    const sw = (cls, text) => el("li", {}, el("span", { class: `pl-sw ${cls}`, "aria-hidden": "true" }), text);
    const n = items().filter((it) => it.type !== "hold").length;
    const used = new Set(allItems().map((it) => it.channel));
    const chans = ["pixcar", "phone", "walkin", "other"].filter((c) => c === "pixcar" || c === "phone" || used.has(c));
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
      ...(advanced() ? [sw("sw-away", "Absence ou maintenance")] : []),
      el("li", { class: "pl-lg-r" }, ...chans.flatMap((c, i) => [i ? " · " : null, icon(CHANNEL[c][1]), CHANNEL[c][0]].filter(Boolean)), ` · ${plural(n, "rendez-vous", "rendez-vous")}`),
    );
  }

  // ---- colonnes des grilles horaires : { key, head, sub, load, day, staff?, post?, segs, avail, away }
  function columns() {
    const list = items(), all = allItems();
    const rowsFor = (pred) => list.flatMap((it) => it.plan.filter(pred).map((r) => ({ item: it, a: r.a, b: Math.max(r.b, r.a + 5), row: r })));
    const todayText = (d) => (d === data.today ? "Aujourd'hui" : "");
    const loadText = (l, verb = "") => (l.avail ? `${verb}${hrs(l.planned)} / ${hrs(l.avail)}` : "");
    const spanOf = (it) => {
      const [a, b] = workSpan(it);
      return { item: it, a, b: Math.max(b, a + 5) };
    };
    if (view === "week")
      return weekDays(list).map((d) => {
        const l = dayLoad(d, all), n = all.filter((it) => it.day === d && it.type !== "hold").length;
        // semaine : chaque bloc montre le travail (un seul mécanicien : rien ne se superpose), le dépôt et la restitution sont dans son texte
        const text = l.avail && advanced() ? `${loadText(l)} · ${plural(n, "rdv", "rdv")}` : openOn(d).length ? plural(n, "rendez-vous", "rendez-vous") : "Fermé";
        return { key: d, head: dayLabel(d, { short: true }), sub: todayText(d), load: { ...l, avail: advanced() ? l.avail : 0, text }, day: d, avail: openOn(d), segs: list.filter((it) => it.day === d).map(spanOf) };
      });
    // jour, affichage simple (ou rien à répartir) : une seule colonne, les rendez-vous qui se chevauchent côte à côte
    const d = anchor;
    if (!advanced() || !hasRes() || dayBy === "all") {
      const n = all.filter((it) => it.day === d && it.type !== "hold").length;
      return [{ key: "all", head: dayLabel(d), sub: todayText(d), load: { planned: 0, avail: 0, text: openOn(d).length ? plural(n, "rendez-vous", "rendez-vous") : "Fermé" }, day: d, avail: openOn(d), segs: list.filter((it) => it.day === d).map(spanOf) }];
    }
    // jour, affichage avancé : une colonne par mécanicien (ou par poste), et « À affecter » s'il en faut une
    const byStaff = dayBy === "staff";
    const target = byStaff ? "staff" : "resource";
    const pool = byStaff ? data.staff : data.resources;
    const used = new Set(list.flatMap((it) => it.plan.filter((r) => r.target === target && r.day === d).map((r) => r.id)));
    const cols = pool
      .filter((x) => x.active || used.has(x.id))
      .map((x) => {
        const l = byStaff ? staffLoad(x, d, all) : postLoad(x, d, all);
        const text = l.avail ? `${byStaff ? "" : "occupé "}${loadText(l)}` : l.absent || l.down ? (byStaff ? "Absent" : "Indisponible") : x.active ? "Hors horaires" : "inactif";
        const whole = list.filter((it) => it.whole && it.day === d).map(spanOf); // tout l'atelier : dans chaque colonne
        return { key: x.id, head: x.name, sub: "", load: { ...l, text }, day: d, [byStaff ? "staff" : "post"]: x.id, avail: hoursFor(x, d), away: awayOn(x.id, d), segs: [...rowsFor((r) => r.target === target && r.id === x.id && r.day === d && (!byStaff || r.role === "labour")), ...whole] };
      });
    const loose = list.filter((it) => it.day === d && !it.whole && !it.plan.some((r) => r.target === target && r.day === d));
    if (loose.length) cols.push({ key: "none", head: "À affecter", sub: "", load: null, day: d, avail: openOn(d), segs: loose.map((it) => ({ item: it, a: it.start, b: it.end > it.start ? it.end : 1440 })) });
    return cols;
  }

  // ---- grille horaire (Jour, Semaine)
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
    const headRow = el("div", { class: "pl-head", "aria-hidden": "true" }, el("span", { class: "pl-corner" }), ...cols.map(head));
    const bodyRow = el("div", { class: "pl-body" }, el("div", { class: "pl-times", "aria-hidden": "true" }, ...hours), ...cols.map((c) => column(c, lo, hi, px)));
    const wrap = el("div", { class: "pl-grid", "data-lo": String(lo), "data-hi": String(hi) }, headRow, bodyRow);
    css(wrap, { "--cols": String(cols.length), "--h": `${(hi - lo) * PPM}px`, "--hour": `${60 * PPM}px` });
    // semaine : un jour où des rendez-vous se chevauchent prend plus de largeur (jusqu'à deux fois et demie), pour rester lisible
    if (view === "week" && cols.length > 1) {
      const weight = (c) => Math.min(2.5, Math.max(1, ...lanes(c.segs.map((x) => ({ a: x.a, b: x.b }))).map((x) => x.lanes || 1)) * 0.75 + 0.25);
      const tracks = `44px ${cols.map((c) => `minmax(var(--colw), ${weight(c).toFixed(2)}fr)`).join(" ")}`;
      css(headRow, { "grid-template-columns": tracks });
      css(bodyRow, { "grid-template-columns": tracks });
    }
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
    // affichage simple : ni mécanicien ni poste sur le bloc (ils restent dans la fiche)
    const others = !advanced() ? [] : c.staff ? postsOf(it) : c.post ? peopleOf(it) : [...peopleOf(it), ...postsOf(it)];
    const car = carText(it);
    const who = [it.type === "hold" ? "" : it.title, ...others].filter(Boolean).join(" · ");
    const state = it.conflict ? "conflict" : it.state;
    const work = it.work && it.work !== "planned" ? `Intervention : ${workLabel(it.work)}` : "";
    const stay = it.type !== "hold" && (it.start !== s.a || it.end !== s.b) ? `dépôt ${timeLabel(it.start)} · restitution ${it.end > it.start ? timeLabel(it.end) : "fin de journée"}` : "";
    return { what: what(it), car, who, state, work, stay, when: range(s.a, s.b), len: dur(s.b - s.a), role: s.row && s.row.role !== "labour" ? ROLE[s.row.role] : "" };
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
    const full = [`${t.when} (${t.len}${t.role ? `, ${t.role}` : ""})`, t.what, t.car, t.who, chan(it)[0], stateLabel, t.work, t.stay && cap(t.stay)].filter(Boolean);
    // l'avancement dit en mots : l'intervention quand elle a commencé, sinon la confirmation
    const status = it.type === "hold" ? "" : it.conflict ? STATE.conflict[0] : it.work && it.work !== "planned" ? workLabel(it.work) : stateLabel;
    const top = el("span", { class: "pl-ev-h" }, el("b", { text: `${hm(s.a)}–${s.b >= 1440 ? "24:00" : hm(s.b)}` }), icon(chan(it)[1]));
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
        class: `pl-ev tone-${tone} st-${it.type === "hold" ? "hold" : it.state}${it.conflict ? " is-conflict" : ""}${it.noShow ? " is-noshow" : ""}${lines === 1 ? " is-tiny" : ""}${shown === it.id ? " is-open" : ""}`,
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
          ...day.slice(0, 3).map((it) => el("span", { class: `pl-mitem tone-${toneOf(it)} st-${it.type === "hold" ? "hold" : it.state}${it.conflict ? " is-conflict" : ""}` }, icon(it.conflict ? STATE.conflict[1] : it.state ? STATE[it.state][1] : CHANNEL.hold[1]), `${timeLabel(it.start)} ${it.title}`)),
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
    const c = d.target.col.dataset;
    // semaine, une seule colonne : le moteur choisit mécanicien et poste ; colonne d'un mécanicien ou d'un poste : celui-là
    applyDrop(d.seg, { day: c.day, min: d.target.min, staff: c.staff || null, post: c.post || null, auto: view === "week" || (!c.staff && !c.post) });
  }
  // ce que la ligne ou la colonne d'arrivée impose (planning en colonnes, Équipe et Équipements en lignes) : target { day, min (début du
  // segment glissé), staff | post, auto }
  function applyDrop(seg, target) {
    const it = seg.item, row = seg.row;
    const start = Math.max(0, Math.round((it.start + (target.min - seg.a)) / 5) * 5);
    const day = target.day;
    const from = row ? row.id : null;
    let change;
    if (target.auto) change = { day, start, auto: true };
    else if (target.staff) change = { day, start, staff: from && row.target === "staff" ? swap(currentStaff(it), from, target.staff) : [target.staff], post: null, swapStaff: from && from !== target.staff ? [from, target.staff] : null };
    else change = { day, start, staff: currentStaff(it), post: target.post, swapPost: from && from !== target.post ? [from, target.post] : null };
    if (day === it.day && start === it.start && !change.swapStaff && !change.swapPost && !(row === undefined && (target.staff || target.post))) return;
    // un rendez-vous pris sur Pixcar ne change jamais sans validation dans le panneau (demande du 25 octobre 2026) : autre jour ou autre
    // heure, l'API annonce le nouvel horaire et le client reçoit l'e-mail « Nouvel horaire » une fois validé ; même jour et même heure
    // (autre mécanicien ou poste), le panneau le dit et rien n'est envoyé au client
    if (it.type === "rdv" && day === it.day && start === it.start) return void openSheet(it, { mode: "move", change, problem: { code: "assign", message: "Même jour, même heure : le client n'est pas dérangé, aucun e-mail ne lui est envoyé." } });
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
    // rendez-vous saisi : le jour, l'heure et l'affectation ; le client, le véhicule, la durée et le commentaire restent (l'API les garde)
    if (it.type === "job") return { kind: "job", services: k.services.map((s) => ({ id: s.id, qty: s.qty })), vehicle: k.vehicle || null, day: change.day, time: hm(change.start), staff, station, ...(confirm ? { confirm: true } : {}) };
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
        closeSide();
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
  // id : le rendez-vous ou le bloc dont parle le panneau (null pour une création)
  function frame(title, eyebrow, body, actions, id = null) {
    $("planForm").replaceChildren(
      el("div", { class: "sheet-head" }, el("div", {}, eyebrow ? el("p", { class: "eyebrow", text: eyebrow }) : null, el("h2", { id: "planDlgTitle", text: title })), el("button", { type: "button", class: "icon-btn", id: "planSideClose", "aria-label": "Fermer le panneau", onclick: () => closeSide() }, icon("i-close"))),
      ...body.filter((b) => b != null),
      el("p", { class: "field-err", id: "planErr", role: "alert", hidden: true }),
      el("div", { class: "sheet-actions" }, ...actions.filter((a) => a != null)),
    );
    shown = id;
    openSide();
  }

  // ---- le panneau (demande du 24 octobre 2026) : il s'ajoute à droite de la grille et la rétrécit au lieu de la couvrir, pour garder
  // le planning sous les yeux ; quand la place manque (téléphone, tablette), il se place au-dessus d'elle. Ouverture et fermeture en
  // transition (aucune si le système demande moins d'animations) ; Échap ou « Fermer » le referment et rendent le focus.
  const layout = () => $("planLayout");
  const stacked = () => getComputedStyle(layout()).getPropertyValue("--pl-stacked").trim() === "1";
  function openSide() {
    clearTimeout(closing);
    closing = 0;
    const d = dlg();
    if (!d.open) {
      if (!d.contains(document.activeElement)) opener = document.activeElement;
      d.show();
      void layout().offsetWidth; // la transition part du panneau fermé
    }
    layout().classList.add("has-side");
    mark();
    if (stacked()) d.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  function closeSide({ now = false, refocus = true } = {}) {
    const d = dlg();
    if (!d.open) return;
    const inside = d.contains(document.activeElement) || document.activeElement === document.body;
    layout().classList.remove("has-side");
    shown = null;
    mark();
    const done = () => {
      closing = 0;
      d.close();
    };
    // durée de la transition (0 s quand le système demande moins d'animations)
    const ms = now ? 0 : Math.max(0, ...getComputedStyle(layout()).transitionDuration.split(",").map((t) => parseFloat(t) * (t.trim().endsWith("ms") ? 1 : 1000)));
    clearTimeout(closing);
    if (ms) closing = setTimeout(done, ms + 20);
    else done();
    if (!refocus || !inside) return;
    const back = opener && opener.isConnected && !d.contains(opener) ? opener : (opener && opener.dataset && opener.dataset.id && $("planGrid").querySelector(`.pl-ev[data-id="${opener.dataset.id}"]`)) || $("planTitle");
    back.focus({ preventScroll: true });
  }
  const sideOpen = () => dlg().open && !closing;
  // le bloc dont parle le panneau, mis en évidence dans la grille
  function mark() {
    for (const b of $("planGrid").querySelectorAll(".pl-ev")) b.classList.toggle("is-open", !!shown && b.dataset.id === shown);
  }
  function err(message) {
    $("planErr").textContent = message || "";
    $("planErr").hidden = !message;
  }
  // détail en deux colonnes, comme le panneau de la maquette (intitulé au-dessus de la valeur)
  const kv = (k, ...v) => (v.some(Boolean) ? el("div", {}, el("dt", { text: k }), el("dd", {}, ...v.filter((x) => x !== "" && x != null))) : null);

  function openSheet(it, opts = {}) {
    sheet = { item: it, mode: opts.mode || "view", armed: false };
    if (sheet.mode === "move") return moveForm(it, opts);
    const a = it.type === "rdv" ? it.src : null;
    const k = it.type === "rdv" ? null : it.src;
    const facts = [];
    const tel = phoneOf(it);
    if (it.type !== "hold") {
      facts.push(kv("Client", a ? a.client || "effacé" : it.title, tel ? " · " : null, tel ? el("a", { href: `tel:${tel}`, text: phoneText(tel) || tel }) : null));
      const car = it.src || {};
      facts.push(kv(a ? "Voiture" : "Véhicule", [car.car, car.plate, car.vehicle ? (data.vehicles.find((v) => v.id === car.vehicle) || { label: "" }).label : ""].filter(Boolean).join(" · ")));
    }
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
    if (it.type !== "hold" && labourOf(it)) facts.push(kv("Temps estimé", dur(labourOf(it))));
    if (k && k.note) facts.push(kv("Commentaire interne", k.note));
    if (it.deadline) {
      const p = parisParts(it.deadline);
      facts.push(kv("À confirmer avant", `${dayLabel(p.iso, { short: true })} à ${timeLabel(p.min)}`));
    }
    const rows = it.plan.map((r) => el("li", {}, el("b", { text: r.name || "?" }), ` · ${ROLE[r.role]} · ${r.day !== it.day ? dayLabel(r.day, { short: true }) + " " : ""}${range(r.a, r.b)}${r.fixed ? " · choisi par vous" : ""}`));
    const body = [
      el(
        "p",
        { class: "pl-status" },
        el("span", { class: `pl-tag or-${it.origin}` }, icon(chan(it)[1]), chan(it)[0]),
        it.state ? el("span", { class: `pl-pill is-${it.state}` }, icon(STATE[it.state][1]), STATE[it.state][0]) : null,
        it.conflict ? el("span", { class: "pl-pill is-conflict" }, icon(STATE.conflict[1]), STATE.conflict[0]) : null,
        it.work ? el("span", { class: `pl-tag wk-${it.work}`, text: `Intervention : ${workLabel(it.work)}` }) : null,
      ),
      it.conflict ? el("div", { class: "pl-conflict", role: "note" }, el("p", {}, icon("i-flag"), el("b", { text: "En conflit : " }), "une affectation ne tient plus. Déplacez ou réaffectez."), el("ul", {}, ...it.conflict.map((t) => el("li", { text: t })))) : null,
      el("dl", { class: "pl-facts" }, ...facts),
      progress(it),
      // affichage simple : les affectations restent enregistrées mais ne s'affichent pas
      advanced() && rows.length ? el("h3", { text: "Affectations" }) : null,
      advanced() ? (rows.length ? el("ul", { class: "pl-rows" }, ...rows) : it.type !== "hold" ? el("p", { class: "muted", text: "Pas encore d'affectation : à affecter." }) : null) : null,
    ];
    const past = it.day < data.today;
    const actions = [];
    const started = !!it.work && it.work !== "planned";
    if (!past && !started) actions.push(el("button", { type: "button", class: "btn primary", id: "planMove", onclick: () => openSheet(it, { mode: "move" }) }, icon("i-calendar"), advanced() ? "Déplacer ou réaffecter" : "Changer l'horaire"));
    if (tel) actions.push(el("a", { class: "btn", href: `tel:${tel}` }, icon("i-phone"), "Appeler"));
    if (a && !past && !started && a.status === "confirmed") actions.push(el("button", { type: "button", class: "link-btn danger", onclick: () => cancelForm(it, "cancel") }, "Annuler ce rendez-vous"));
    if (a && a.status === "pending") actions.push(el("button", { type: "button", class: "btn", onclick: () => (closeSide(), goPanel("requests")) }, icon("i-inbox"), "Répondre dans Demandes"));
    if (!a && !past) actions.push(el("button", { type: "button", class: "btn", onclick: () => blockForm({ item: it }) }, icon("i-edit"), "Modifier"));
    if (!a) actions.push(el("button", { type: "button", class: "link-btn danger", id: "planDel", onclick: () => removeBlock(it) }, it.type === "job" ? "Supprimer ce rendez-vous" : "Supprimer ce créneau"));
    frame(it.title, it.type === "hold" ? "Planning" : "Rendez-vous", body, actions, it.id);
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
  // quick : depuis la liste ou le suivi (sans fiche ouverte) ; « Voiture prête » d'un rendez-vous Pixcar prévient alors le client (le
  // réglage par défaut de la fiche)
  async function setWork(it, to, button, { quick = false } = {}) {
    const box = !quick && $("planNotify");
    const body = { status: to, ...(to === "done" && it.type === "rdv" ? { notify: box ? !!box.checked : true } : {}) };
    await busy(button, async () => {
      try {
        const out = await api.work(garageId, it.id, body);
        const text = `${it.title} : ${workLabel(out.work.noShow ? "no_show" : out.work.status)}${out.notified ? ", client prévenu par e-mail" : ""}.`;
        await reload(text);
        alertBox(text, "info");
        const next = allItems().find((x) => x.id === it.id);
        if (next && sideOpen() && !quick) openSheet(next);
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && !quick && sideOpen()) return err(e.message);
        if (e.status === 409 || e.status === 422) return alertBox(e.message);
        closeSide();
        fail(e);
      }
    });
  }

  // déplacer au clavier : jour, heure, mécanicien, poste ; puis les retours de l'API (confirmation, conflit et autres horaires)
  function moveForm(it, { change = null, problem = null } = {}) {
    const ch = change || { day: it.day, start: it.start, staff: currentStaff(it), post: currentPost(it) };
    // confirm : le client sera prévenu ; shifted : les travaux attendent que le mécanicien (ou le poste) se libère
    // full : la place du créneau est prise à cette heure-là (rendez-vous saisi, calcul par créneaux) : enregistrer quand même
    const confirmAsk = problem && (problem.code === "confirm" || problem.code === "shifted" || problem.code === "full");
    const shifted = problem && problem.code === "shifted";
    const fullAsk = problem && problem.code === "full";
    // assign : réaffectation glissée dans la grille (même heure), à valider ; le formulaire non retouché garde exactement ce qui a été glissé
    const assign = problem && problem.code === "assign";
    const reasons = (problem && problem.details && problem.details.reasons) || [];
    const alts = (problem && problem.details && problem.details.alternatives) || [];
    const staffSel = el("select", { id: "planMvStaff" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activeStaff().map((m) => el("option", { value: m.id, text: m.name, selected: !ch.auto && ch.staff[0] === m.id })));
    const postSel = el("select", { id: "planMvPost" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activePosts().map((x) => el("option", { value: x.id, text: x.name, selected: !ch.auto && ch.post === x.id })));
    const hold = it.type === "hold";
    const body = [
      el("p", { class: "help", text: it.type === "rdv" ? "Même heure, autre mécanicien ou poste : le client n'est pas dérangé. Autre heure : il est prévenu par e-mail, après votre confirmation." : "Pixcar vérifie que les mécaniciens et postes sont libres." }),
      el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planMvDay", text: "Jour" }), el("input", { id: "planMvDay", type: "date", value: ch.day, min: data.today, required: true })), el("span", {}, el("label", { for: "planMvTime", text: hold ? "De" : "Dépôt à" }), el("input", { id: "planMvTime", type: "time", step: "300", value: hm(ch.start), required: true }))),
      hold || !advanced() || !byRes() || !hasRes() ? null : el("div", { class: "mg-row2" }, el("span", {}, el("label", { for: "planMvStaff", text: "Mécanicien" }), staffSel), el("span", {}, el("label", { for: "planMvPost", text: "Poste" }), postSel)),
      problem && !confirmAsk && !assign ? el("div", { class: "pl-conflict", role: "alert" }, el("p", {}, icon("i-flag"), el("b", { text: problem.message })), reasons.length > 1 ? el("ul", {}, ...reasons.slice(1).map((t) => el("li", { text: t }))) : null) : null,
      assign ? el("p", { class: "pl-ask is-info", role: "status" }, icon("i-user"), problem.message) : null,
      alts.length
        ? el(
            "div",
            { class: "pl-alts" },
            el("p", { text: "Autres horaires possibles :" }),
            ...alts.map((x) =>
              el("button", { type: "button", class: "btn small", onclick: () => {
                $("planMvDay").value = x.day;
                $("planMvTime").value = x.time;
                if ($("planMvStaff")) $("planMvStaff").value = $("planMvPost").value = "";
                $("planMvSave").focus();
              } }, `${x.label}${x.back ? ` · rendue vers ${timeLabel(minOf(x.back))}` : ""}`),
            ),
          )
        : null,
      confirmAsk ? el("p", { class: "pl-ask", role: "alert" }, icon(shifted ? "i-clock" : fullAsk ? "i-alert" : "i-mail"), problem.message || "Le client sera prévenu par e-mail du nouvel horaire.") : null,
    ];
    frame(it.title, advanced() ? "Déplacer ou réaffecter" : "Changer l'horaire", body, [
      el("button", { type: "submit", class: "btn primary", id: "planMvSave" }, shifted ? "Confirmer ces horaires" : fullAsk ? "Enregistrer quand même" : confirmAsk ? "Confirmer et prévenir le client" : assign ? "Enregistrer l'affectation" : "Enregistrer"),
      el("button", { type: "button", class: "btn", onclick: () => openSheet(it) }, "Retour"),
    ], it.id);
    const pickable = () => !!$("planMvStaff");
    const initial = [$("planMvDay").value, $("planMvTime").value, pickable() ? staffSel.value : "", pickable() ? postSel.value : ""].join();
    $("planForm").onsubmit = (ev) => {
      ev.preventDefault();
      const day = $("planMvDay").value, start = minOf($("planMvTime").value);
      if (!day || !Number.isFinite(start)) return err("Choisissez un jour et une heure.");
      const s = pickable() ? $("planMvStaff").value : "", p = pickable() ? $("planMvPost").value : "";
      // affichage simple : même mécanicien et même poste s'ils restent libres, sinon le moteur choisit
      const keep = !hold && !pickable() && ch.day === day && ch.start === start && !ch.auto;
      const next = hold ? { day, start } : keep ? { ...ch } : { day, start, staff: s ? [s] : [], post: p || null, auto: !s && !p };
      if (assign && [day, $("planMvTime").value, s, p].join() === initial) return void tryMove(it, ch, { button: $("planMvSave") });
      // la confirmation ne vaut que pour le déplacement annoncé : s'il a changé, l'API redemande
      const same = JSON.stringify(moveBody(it, next)) === JSON.stringify(moveBody(it, ch));
      void tryMove(it, confirmAsk && same ? ch : next, { confirm: confirmAsk && same, button: $("planMvSave") });
    };
    (confirmAsk || assign ? $("planMvSave") : $("planMvDay")).focus();
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
    ], it.id);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const picked = $("planForm").querySelector('input[name="planWhy"]:checked');
      if (!picked) return err("Choisissez un motif : il est transmis au client.");
      await busy($("planWhySave"), async () => {
        try {
          await api.decide(garageId, it.id, act, { reason: picked.value, note: $("planWhyNote").value.trim() });
          closeSide();
          alertBox(`Rendez-vous annulé. ${it.title} est prévenu(e) par e-mail, avec votre motif.`, "info");
          await reload("Rendez-vous annulé.");
        } catch (e) {
          if (e.status === 409 || e.status === 422) return err(e.message);
          closeSide();
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
  // durée proposée d'après les prestations : temps de main-d'œuvre du calcul par ressources, sinon temps moyen de Mon garage (× quantité)
  function suggest(services) {
    let n = 0;
    for (const x of services) {
      const s = st && st.services.find((y) => y.id === x.id);
      if (!s) continue;
      const m = st.mode === "advanced" && s.req ? s.req.labour : s.minutes;
      if (!m) return null;
      n += m * (s.unit ? x.qty || 1 : 1);
    }
    return n || null;
  }
  const nearest = (m) => DURATIONS.reduce((best, x) => (Math.abs(x - m) < Math.abs(best - m) ? x : best), DURATIONS[0]);
  // Rendez-vous saisi par le garage (téléphone, comptoir, autre) : prestations, jour et heure, durée proposée d'après les prestations et
  // modifiable, client, téléphone, véhicule et immatriculation (le nom ou le véhicule suffit), canal, restitution estimée, commentaire
  // interne ; mécanicien et poste seulement en affichage avancé, jamais obligatoires. Créneau bloqué : libellé, de… à… ; tout l'atelier en
  // affichage simple, des mécaniciens ou des postes choisis en affichage avancé.
  function blockForm({ item = null, at = null, problem = null, draft = null, refocus = null }) {
    const k = item ? item.src : null;
    const d = draft || {
      kind: k ? k.kind : at.kind || "job",
      label: k ? (k.kind === "job" && k.client !== undefined ? k.client : k.label) : "",
      day: k ? k.when.day : at.day,
      start: k ? minOf(k.when.start) : at.start,
      end: k ? minOf(k.when.end) : Math.min(1440, at.start + 60),
      services: k ? k.services.map((s) => ({ id: s.id, qty: s.qty })) : [],
      vehicle: k ? k.vehicle : "",
      staff: k ? (k.kind === "hold" ? idsOf(item, "staff") : currentStaff(item)) : at.staff ? [at.staff] : [],
      posts: k ? (k.kind === "hold" ? idsOf(item, "resource") : [currentPost(item)].filter(Boolean)) : at.post ? [at.post] : [],
      phone: k && k.phone ? phoneText(k.phone) || k.phone : "",
      car: (k && k.car) || "",
      plate: (k && k.plate) || "",
      channel: (k && k.channel) || (at && at.arrived ? "walkin" : "phone"),
      minutes: (k && k.minutes) || null,
      touched: !!(k && k.minutes),
      back: k && k.back ? minOf(k.back) : null,
      note: (k && k.note) || "",
    };
    const job = d.kind === "job";
    const proposed = suggest(d.services);
    const minutes = d.touched && d.minutes ? d.minutes : proposed || d.minutes || 60;
    const radio = (v, t) => el("label", { class: "pl-seg-opt" }, el("input", { type: "radio", name: "planKind", value: v, checked: d.kind === v, onchange: () => blockForm({ item, at, draft: { ...read(), kind: v }, refocus: `input[name="planKind"][value="${v}"]` }) }), el("span", { text: t }));
    const svc = data.services.map((s) =>
      el(
        "label",
        { class: "chip pl-svc" },
        el("input", { type: "checkbox", name: "planSvc", value: s.id, checked: d.services.some((x) => x.id === s.id), onchange: () => blockForm({ item, at, draft: read(), refocus: `input[name="planSvc"][value="${s.id}"]` }) }),
        el("span", { text: s.label }),
        s.unit && d.services.some((x) => x.id === s.id)
          ? el("select", { class: "pl-qty", "data-qty": s.id, "aria-label": `Quantité : ${s.label}`, onchange: () => blockForm({ item, at, draft: read(), refocus: `select[data-qty="${s.id}"]` }) }, ...[1, 2, 3, 4].map((n) => el("option", { value: String(n), text: `× ${n}`, selected: (d.services.find((x) => x.id === s.id) || {}).qty === n })))
          : null,
      ),
    );
    const needVehicle = d.services.some((x) => (data.services.find((s) => s.id === x.id) || {}).byVehicle);
    const checks = (name, list, chosen) => list.map((x) => el("label", { class: "chip" }, el("input", { type: "checkbox", name, value: x.id, checked: chosen.includes(x.id) }), el("span", { text: x.name })));
    const reasons = (problem && problem.details && problem.details.reasons) || [];
    const alts = (problem && problem.details && problem.details.alternatives) || [];
    const shifted = problem && problem.code === "shifted";
    // full : la place du créneau est prise ; overlap : des rendez-vous sont déjà là pendant le blocage. Le garage peut confirmer.
    const full = problem && (problem.code === "full" || problem.code === "overlap");
    const durations = [...new Set([...DURATIONS, minutes])].sort((x, y) => x - y);
    const pickRes = advanced() && byRes() && hasRes();
    const field = (id, labelText, input, hint = null) => el("span", {}, el("label", { for: id }, labelText, hint ? el("small", { text: ` ${hint}` }) : null), input);
    const body = [
      item || (at && at.arrived) ? null : el("fieldset", { class: "pl-seg pl-kind" }, el("legend", { class: "sr-only", text: "Quoi ?" }), radio("job", "Rendez-vous"), radio("hold", "Créneau bloqué")),
      at && at.arrived ? el("p", { class: "pl-ask" }, icon("i-car"), "Client déjà sur place : la voiture est notée « reçue » dès l'enregistrement.") : null,
      job ? el("fieldset", { class: "chips pl-svcs" }, el("legend", { text: "Prestations" }), ...(svc.length ? svc : [el("p", { class: "muted", text: "Aucune prestation n'est cochée dans Mon garage › Prestations." })])) : el("label", { for: "planLabel" }, "Libellé ", el("small", { text: "40 caractères" })),
      job ? null : el("input", { id: "planLabel", type: "text", maxlength: "40", value: d.label, placeholder: "Livraison pièces", autocomplete: "off", required: true }),
      el("div", { class: "mg-row2" }, field("planDay", "Date", el("input", { id: "planDay", type: "date", value: d.day, min: data.today, required: true })), field("planTime", job ? "Heure" : "De", el("input", { id: "planTime", type: "time", step: "300", value: hm(d.start), required: true }))),
      job
        ? el(
            "div",
            { class: "mg-row2" },
            field("planMinutes", "Durée estimée", el("select", { id: "planMinutes", onchange: () => ($("planMinutes").dataset.touched = "1") }, ...durations.map((m) => el("option", { value: String(m), text: dur(m), selected: m === minutes })))),
            field("planBack", "Restitution", el("input", { id: "planBack", type: "time", step: "300", value: d.back ? hm(d.back) : "" }), "facultatif"),
          )
        : el("div", { class: "mg-row2" }, field("planTo", "À", el("input", { id: "planTo", type: "time", step: "300", value: hm(Math.min(d.end, 1435)), required: true })), el("span")),
      job && proposed ? el("p", { class: "help pl-hint", text: `Durée proposée d'après les prestations : ${dur(proposed)}. Modifiable.` }) : null,
      job ? el("div", { class: "mg-row2" }, field("planLabel", "Client", el("input", { id: "planLabel", type: "text", maxlength: "40", value: d.label, placeholder: "M. Martin", autocomplete: "off" })), field("planPhone", "Téléphone", el("input", { id: "planPhone", type: "tel", maxlength: "20", value: d.phone, placeholder: "06 12 34 56 78", autocomplete: "off" }), "facultatif")) : null,
      job ? el("div", { class: "mg-row2" }, field("planCar", "Véhicule", el("input", { id: "planCar", type: "text", maxlength: "40", value: d.car, placeholder: "Renault Clio IV", autocomplete: "off" })), field("planPlate", "Immatriculation", el("input", { id: "planPlate", type: "text", maxlength: "15", value: d.plate, placeholder: "AB-123-CD", autocomplete: "off", spellcheck: "false" }), "facultatif")) : null,
      job ? el("p", { class: "help pl-hint", text: "Le nom du client ou le véhicule suffit." }) : null,
      job && needVehicle ? el("label", { for: "planVehicle", text: "Type de véhicule" }) : null,
      job && needVehicle ? el("select", { id: "planVehicle" }, el("option", { value: "", text: "Choisir…" }), ...data.vehicles.map((v) => el("option", { value: v.id, text: v.label, selected: d.vehicle === v.id }))) : null,
      job
        ? el(
            "fieldset",
            { class: "pl-seg pl-chan" },
            el("legend", { text: "Canal" }),
            ...["phone", "walkin", "other"].map((c) => el("label", { class: "pl-seg-opt" }, el("input", { type: "radio", name: "planChannel", value: c, checked: d.channel === c }), icon(CHANNEL[c][1]), el("span", { text: CHANNEL[c][0] }))),
          )
        : null,
      job ? el("label", { for: "planNote" }, "Commentaire interne ", el("small", { text: "facultatif, vu du garage seulement" })) : null,
      job ? el("textarea", { id: "planNote", rows: "2", maxlength: "300", text: d.note }) : null,
      job && pickRes
        ? el("div", { class: "mg-row2" },
            field("planStaff", "Mécanicien", el("select", { id: "planStaff" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activeStaff().map((m) => el("option", { value: m.id, text: m.name, selected: d.staff[0] === m.id })))),
            field("planPost", "Poste", el("select", { id: "planPost" }, el("option", { value: "", text: "Au choix de Pixcar" }), ...activePosts().map((x) => el("option", { value: x.id, text: x.name, selected: d.posts[0] === x.id })))))
        : null,
      !job && pickRes ? el("fieldset", { class: "chips pl-who" }, el("legend", { text: "Qui ou quoi est bloqué ? (aucun choix : tout l'atelier)" }), ...checks("planHoldStaff", activeStaff(), d.staff), ...checks("planHoldPost", activePosts(), d.posts)) : null,
      !job && !pickRes ? el("p", { class: "pl-ask is-info" }, icon("i-lock"), "Tout l'atelier est bloqué sur cette plage : aucun horaire n'y est proposé en ligne.") : null,
      problem && !shifted ? el("div", { class: full ? "pl-ask" : "pl-conflict", role: "alert" }, el("p", {}, icon(full ? "i-alert" : "i-flag"), el("b", { text: problem.message })), reasons.length > 1 ? el("ul", {}, ...reasons.slice(1).map((t) => el("li", { text: t }))) : null) : null,
      shifted ? el("p", { class: "pl-ask", role: "alert" }, icon("i-clock"), problem.message) : null,
      alts.length
        ? el("div", { class: "pl-alts" }, el("p", { text: shifted ? "Ou un dépôt sans attente :" : "Autres horaires possibles :" }), ...alts.map((x) => el("button", { type: "button", class: "btn small", onclick: () => {
            $("planDay").value = x.day;
            $("planTime").value = x.time;
            $("planSave").focus();
          } }, `${x.label}${x.back ? ` · rendue vers ${timeLabel(minOf(x.back))}` : ""}`)))
        : null,
      el("p", { class: "help", text: job ? "Il prend sa place dans l'agenda et réduit les horaires proposés en ligne, comme une réservation Pixcar. Aucun e-mail n'est envoyé au client." : pickRes ? "Refusé si un rendez-vous ou un autre bloc occupe déjà ces mécaniciens ou postes. Pour une absence ou une maintenance, utilisez « Nouveau »." : byRes() ? "Refusé si un rendez-vous occupe déjà un mécanicien ou un poste pendant la plage." : "Les rendez-vous déjà prévus restent à leur place ; vous êtes prévenu s'il y en a." }),
    ];
    const saveText = shifted ? "Confirmer ces horaires" : full ? (problem.code === "overlap" ? "Bloquer quand même" : "Enregistrer quand même") : "Enregistrer";
    frame(item ? item.title : at && at.arrived ? "Client déjà sur place" : job ? "Nouveau rendez-vous" : "Créneau bloqué", item ? (job ? "Modifier le rendez-vous" : "Modifier le créneau bloqué") : "Gestion d'atelier", body, [
      el("button", { type: "submit", class: "btn primary", id: "planSave" }, saveText),
      el("button", { type: "button", class: "btn", onclick: () => (item ? openSheet(item) : closeSide()) }, item ? "Retour" : "Annuler"),
    ], item ? item.id : null);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const v = read();
      if (v.kind === "job") {
        if (!v.services.length) return err("Choisissez au moins une prestation.");
        if (v.label.length < 2 && v.car.length < 2) return err("Indiquez le nom du client ou le véhicule.");
      } else if (v.label.length < 2) return err("Libellé : 2 caractères au moins.");
      const body = { kind: v.kind, label: v.kind === "job" ? (v.label.length >= 2 ? v.label : v.car).slice(0, 40) : v.label, day: v.day, time: hm(v.start) };
      if (v.kind === "job")
        Object.assign(body, {
          services: v.services, vehicle: v.vehicle || null, staff: v.staff, station: v.posts[0] || null, channel: v.channel,
          client: v.label, phone: v.phone, car: v.car, plate: v.plate, minutes: v.minutes, back: Number.isFinite(v.back) ? hm(v.back) : null, note: v.note,
          ...(at && at.arrived && !item ? { received: true } : {}),
          // identifiant de la création : un double clic ou une reprise réseau ne crée pas deux rendez-vous
          ...(!item ? { ref: d.ref || (d.ref = newRef()) } : {}),
        });
      // la confirmation ne vaut que pour ce qui a été annoncé : si le formulaire a changé, l'API redemande
      const same = JSON.stringify({ ...v, touched: 0 }) === JSON.stringify({ ...d, minutes: v.minutes, touched: 0, ref: undefined });
      const confirmed = (shifted || full) && same;
      if (confirmed) body.confirm = true;
      if (v.kind === "hold") Object.assign(body, { to: v.end >= 1440 ? "24:00" : hm(v.end), staff: v.staff, resources: v.posts });
      await busy($("planSave"), async () => {
        try {
          await api.saveBlock(garageId, item ? item.id : null, body);
          closeSide();
          const what = at && at.arrived ? "Client déjà sur place, voiture reçue" : v.kind === "job" ? "Rendez-vous" : "Créneau bloqué";
          const w = confirmed && problem.details && problem.details.work;
          alertBox(`${what} ${item ? "modifié" : "ajouté"} : ${dayLabel(v.day, { short: true })} à ${timeLabel(v.start)}${w ? `, travaux de ${timeLabel(minOf(w.start))} à ${timeLabel(minOf(w.end))}` : ""}.`, "info");
          await reload(`${what} enregistré.`);
        } catch (e) {
          if (e.status === 409 && ["conflict", "shifted", "full", "overlap"].includes(e.code)) return blockForm({ item, at, draft: { ...v, ref: d.ref }, problem: e, refocus: e.code === "conflict" ? null : "#planSave" });
          if (e.status === 409 || e.status === 422) return err(e.message);
          closeSide();
          fail(e);
        }
      });
    };
    ($("planForm").querySelector(refocus || (job ? 'input[name="planSvc"]' : "#planLabel")) || $("planDay")).focus();
    function read() {
      const f = $("planForm");
      const kind = item ? d.kind : (f.querySelector('input[name="planKind"]:checked') || { value: d.kind }).value;
      const services = [...f.querySelectorAll('input[name="planSvc"]:checked')].map((i) => {
        const q = f.querySelector(`select[data-qty="${i.value}"]`);
        return { id: i.value, qty: q ? Number(q.value) : 1 };
      });
      const val = (id, dflt) => ($(id) ? $(id).value : dflt);
      const touched = d.touched || !!($("planMinutes") && $("planMinutes").dataset.touched);
      const back = val("planBack", d.back === null ? "" : hm(d.back));
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
        phone: val("planPhone", d.phone).trim(),
        car: val("planCar", d.car).trim(),
        plate: val("planPlate", d.plate).trim(),
        channel: (f.querySelector('input[name="planChannel"]:checked') || { value: d.channel }).value,
        minutes: touched ? Number(val("planMinutes", String(minutes))) : null,
        touched,
        back: back ? minOf(back) : null,
        note: val("planNote", d.note).trim(),
      };
    }
  }
  const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

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
        closeSide();
        alertBox(`${it.type === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué"} supprimé.`, "info");
        await reload("Supprimé.");
      } catch (e) {
        if (e.status === 409) return err(e.message);
        closeSide();
        fail(e);
      }
    });
  }

  // ---- absence d'un mécanicien, indisponibilité d'un poste (mêmes règles que dans Mon garage › Ressources ; rien n'est déplacé)
  function unavailForm(target, { day = null } = {}) {
    const pool = target === "staff" ? activeStaff() : activePosts();
    if (!pool.length) return alertBox(target === "staff" ? "Ajoutez d'abord un mécanicien (Mon garage › Ressources)." : "Ajoutez d'abord un poste (Mon garage › Ressources).");
    const kinds = ((st && st.catalogs && st.catalogs.kinds) || []).filter((k) => k.for === target || k.for === "both");
    const d0 = day && day >= data.today ? day : data.today;
    const who = target === "staff" ? filters.staff || pool[0].id : filters.post || pool[0].id;
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
      el("button", { type: "button", class: "btn", onclick: () => closeSide() }, "Annuler"),
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
          closeSide();
          const n = (out.touched || []).length;
          const what = target === "staff" ? "Absence enregistrée." : "Indisponibilité enregistrée.";
          alertBox(n ? `${what} ${plural(n, "rendez-vous à venir est touché : il apparaît", "rendez-vous à venir sont touchés : ils apparaissent")} « En conflit » dans le planning.` : `${what} Aucun rendez-vous n'est touché.`, "info");
          await reload(what);
        } catch (e) {
          if (e.status === 409 || e.status === 422) return err(e.message);
          closeSide();
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
    return { day, start: day === data.today ? Math.min(Math.max(9 * 60, soon), 23 * 60) : 9 * 60, staff: null, post: null };
  }
  $("planNew").addEventListener("click", () => newMenu(menu().hidden));
  // « Nouveau rendez-vous » : le formulaire tout de suite (le menu à côté propose le reste)
  $("planNewRdv").addEventListener("click", () => data && openCreate({ ...newAt(), kind: "job" }));
  menu().addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-new]");
    if (!b) return;
    newMenu(false, { focus: false });
    const at = newAt();
    if (b.dataset.new === "arrived") form("job", { arrived: true });
    else if (b.dataset.new === "job" || b.dataset.new === "hold") openCreate({ ...at, kind: b.dataset.new });
    else unavailForm(b.dataset.new, { day: at.day });
  });
  // affichage Simple | Avancé : un groupe de boutons radio (flèches pour passer de l'un à l'autre)
  $("planMode").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-display]");
    if (b && data) void setDisplay(b.dataset.display);
  });
  $("planMode").addEventListener("keydown", (ev) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key) || !data) return;
    ev.preventDefault();
    const next = display === "simple" ? "advanced" : "simple";
    void setDisplay(next).then(() => $("planMode").querySelector(`[data-display="${next}"]`).focus());
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
  // et, quand le navigateur le permet, le plein écran de l'écran (Échap en sort aussi)
  async function nativeFull(on) {
    try {
      if (on && document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // refusé (iframe, réglage du navigateur) : le plein écran reste celui de la page
    }
  }
  $("planFocus").addEventListener("click", () => {
    const on = !document.body.classList.contains("pl-focus");
    focusMode(on);
    void nativeFull(on);
    live(on ? "Plein écran. Échap pour en sortir." : "Plein écran quitté.");
  });
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement || !document.body.classList.contains("pl-focus")) return;
    focusMode(false);
    live("Plein écran quitté.");
  });
  // Échap : d'abord le panneau, puis le plein écran
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || $("dash-planning").hidden || !menu().hidden || drag || document.querySelector("dialog[open]:not(#planDlg)")) return;
    if (dlg().open) {
      if (!closing) closeSide();
      return;
    }
    if (!document.body.classList.contains("pl-focus")) return;
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
      for (const k of Object.keys(filters)) filters[k] = "";
      setQuery("");
      showFilters(false);
    }
    view = "day";
    space = "agenda";
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

  function reset() {
    data = null;
    closeSide({ now: true, refocus: false });
  }

  return { open, openDay, showItem, form, reset };
}
