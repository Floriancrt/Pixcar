// Espace Pro, tableau de bord (docs/calendrier-avance.md, « Tableau de bord “Pilotage” »), d'après la proposition « 03 · Pilotage » du
// fichier de l'utilisateur du 25 octobre 2026 : une période (jour, semaine ou mois, choisie aussi dans un calendrier en ligne), actions
// rapides, capacité de l'atelier et quatre chiffres, équipe et postes, rendez-vous de la période (état de chaque intervention et ses
// actions), demandes à traiter, points d'attention. Trois formes selon le garage : mode avancé (tout), mode simple (rendez-vous sans
// ressources), sans rendez-vous en ligne (fiche et prix). Les chiffres viennent des routes existantes et des mêmes calculs que le Planning
// (workshop.js). Que du TEXTE écrit dans la page.
import { addDays, minOf, parisParts, timeLabel } from "../shared/rdv.js";
import { WORK_LIVE, workActions, workLabel } from "../shared/work.js";
import * as K from "./workshop.js";

const RES_ICON = { lift: "i-car", quick: "i-wrench", tyre: "i-tyre", diag: "i-screen", align: "i-gauge", clim: "i-gauge", other: "i-wrench" };
// pastille d'état d'une ligne : [libellé, ton]
const CHIP = {
  pending: ["À confirmer", "amber"],
  planned: ["Prévue", "grey"],
  received: ["Voiture reçue", "blue"],
  in_progress: ["En cours", "blue"],
  waiting_parts: ["Attente pièces", "amber"],
  suspended: ["Suspendue", "amber"],
  done: ["Prête", "green"],
  returned: ["Restituée", "grey"],
  no_show: ["Client absent", "grey"],
  confirmed: ["Confirmé", "green"],
};
const FILTERS = { expected: "Véhicules attendus", live: "Interventions en cours", ready: "Véhicules prêts", returned: "Véhicules restitués" };
// la période : son nom, les boutons qui la déplacent, l'aide du calendrier
const NOUN = { day: "la journée", week: "la semaine", month: "le mois" };
const THIS = { day: "cette journée", week: "cette semaine", month: "ce mois" };
const PICK = { day: "Choisir un jour", week: "Choisir une semaine", month: "Choisir un mois" };
const PREV = { day: "Jour précédent", week: "Semaine précédente", month: "Mois précédent" };
const NEXT = { day: "Jour suivant", week: "Semaine suivante", month: "Mois suivant" };
const NOW = { day: "Aujourd'hui", week: "Cette semaine", month: "Ce mois" };
const HELP = {
  day: "Choisissez une date : le tableau de bord se met à jour aussitôt.",
  week: "Choisissez une ligne : la semaine va du lundi au dimanche, même à cheval sur deux mois.",
  month: "Choisissez un mois : rendez-vous et heures sont comptés sur le mois civil.",
};
const TONE_ORDER = { red: 0, amber: 1, blue: 2 };
const ROWS_SHOWN = 3; // rendez-vous montrés avant « Voir les N rendez-vous »
const LATE_MIN = 15; // voiture pas arrivée 15 minutes après l'heure de dépôt
const AGENDA_MAX_DAYS = 42; // la route de l'agenda (server/calendar.mjs) lit 42 jours au plus
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const hrs = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(Math.round(m % 60)).padStart(2, "0") : ""}` : m > 0 ? `${Math.round(m)} min` : "0 h");
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
const svcLine = (services) => services.map((s) => s.label).join(" + ");
const evolution = (v) => (v.previous ? `${v.recent >= v.previous ? "+" : "−"}${Math.abs(Math.round(((v.recent - v.previous) / v.previous) * 100))} % sur 30 jours` : "");
const cls = (...xs) => xs.filter(Boolean).join(" ");
const pad = (n) => String(n).padStart(2, "0");

// ================================================================= dates (jours ISO, calculés en UTC à midi)
const noon = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
const fmt = (iso, o) => noon(iso).toLocaleDateString("fr-FR", { timeZone: "UTC", ...o });
const longDay = (iso) => cap(fmt(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
const monday = (iso) => addDays(iso, -((noon(iso).getUTCDay() + 6) % 7));
const firstOf = (iso) => iso.slice(0, 8) + "01";
const lastOf = (iso) => {
  const d = noon(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
};
function rangeOf(gran, anchor) {
  if (gran === "week") return { start: monday(anchor), end: addDays(monday(anchor), 6) };
  if (gran === "month") return { start: firstOf(anchor), end: lastOf(anchor) };
  return { start: anchor, end: anchor };
}
function daysOf({ start, end }) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
// « Mercredi 4 novembre 2026 », « 2 – 8 novembre 2026 », « 26 oct. – 1 nov. 2026 », « Novembre 2026 »
function periodLabel(gran, anchor) {
  const { start, end } = rangeOf(gran, anchor);
  if (gran === "day") return longDay(anchor);
  if (gran === "month") return cap(fmt(start, { month: "long", year: "numeric" }));
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${fmt(start, { day: "numeric", month: "short", year: "numeric" })} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`;
  if (start.slice(0, 7) !== end.slice(0, 7)) return `${fmt(start, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`;
  return `${fmt(start, { day: "numeric" })} – ${fmt(end, { day: "numeric", month: "long", year: "numeric" })}`;
}
// le même jour du mois suivant (ou le dernier, 31 janvier → 28 février)
function shiftMonth(iso, n) {
  const d = noon(iso), day = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  return `${first.toISOString().slice(0, 8)}${pad(Math.min(day, Number(lastOf(first.toISOString().slice(0, 10)).slice(8))))}`;
}
const MONTHS = Array.from({ length: 12 }, (_, i) => cap(fmt(`2026-${pad(i + 1)}-01`, { month: "long" })));

export function createHome({ api, $, el, icon, alertBox, busy, apiProblem, goPanel, decline, onTodo }) {
  let g = null; // réponse de GET /v1/pro/garages/:id
  let mode = "none"; // advanced | simple | none
  let ag = null; // agenda d'aujourd'hui et de demain : état maintenant, points d'attention
  let agP = null; // agenda de la période affichée (le même objet quand une lecture suffit)
  let st = null, todo = [], upcoming = [], past = [], rdvState = null;
  let gran = "day", anchor = null, calOpen = false, calMonth = null; // calMonth : premier jour du mois montré par le calendrier
  let filter = null; // expected | live | ready | returned : la liste filtrée par un chiffre
  let allRows = false, allAlerts = false;
  let loading = 0;
  const id = () => g.garage.id;
  const nowP = () => parisParts(Date.now());
  const today = () => (ag ? ag.today : nowP().iso);
  const range = () => rangeOf(gran, anchor);
  const fail = (e) => {
    if (!apiProblem(e)) alertBox(e.message);
  };
  const live = (text) => ($("dbLive").textContent = text);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ================================================================= chargement
  async function open(garageData, { focus = true } = {}) {
    // la période reste celle choisie tant qu'on revient au même garage
    if (!g || g.garage.id !== garageData.garage.id || !anchor) {
      gran = "day";
      anchor = nowP().iso;
      calOpen = false;
    }
    g = garageData;
    filter = null;
    allRows = allAlerts = false;
    calMonth = firstOf(anchor);
    renderHead();
    renderCal();
    await load();
    if (focus) $("dashTitle").focus();
  }
  // false : une lecture plus récente l'a remplacée
  async function load() {
    const on = !!g.rdv;
    mode = on ? (g.rdv.mode === "advanced" ? "advanced" : "simple") : "none";
    const adv = mode === "advanced", t = nowP().iso, n = ++loading;
    const { start, end } = range();
    // une seule lecture de l'agenda quand la période, aujourd'hui et demain tiennent dans la fenêtre de la route
    const from = start < t ? start : t, to = end > addDays(t, 1) ? end : addDays(t, 1);
    const one = addDays(from, AGENDA_MAX_DAYS) >= to;
    try {
      const [a, p, s, td, up, ps, rs] = await Promise.all([
        adv ? (one ? api.calAgenda(id(), from, to) : api.calAgenda(id(), t, addDays(t, 1))) : null,
        adv && !one ? api.calAgenda(id(), start, end) : null,
        adv ? api.calendar(id()) : null,
        on ? api.requests(id(), "todo") : null,
        on && !adv ? api.requests(id(), "upcoming") : null,
        on && !adv && start < t ? api.requests(id(), "past") : null,
        on && !adv ? api.agenda(id()) : null,
      ]);
      if (n !== loading) return false;
      [ag, agP, st, rdvState] = [a, p || a, s, rs];
      [todo, upcoming, past] = [td, up, ps].map((x) => (x ? x.requests || [] : []));
    } catch (e) {
      if (n !== loading) return false;
      [ag, agP, st, rdvState, todo, upcoming, past] = [null, null, null, null, [], [], []];
      if (mode !== "none") mode = "simple";
      fail(e);
    }
    if (on) onTodo(todo.length);
    render();
    // la dernière lecture lève l'attente, même lancée par une action pendant un changement de période
    $("dbBody").removeAttribute("aria-busy");
    return true;
  }
  // après une action : rechargé, le focus revient sur la ligne (ou le premier bouton) concernée
  async function reload(message, focusId = null) {
    await load();
    if (message) live(message);
    const target = focusId && document.querySelector(`#dbList [data-id="${focusId}"] .db-more-btn`);
    if (target) target.focus();
  }
  // une autre période : l'en-tête et le calendrier tout de suite, le contenu une fois lu
  async function setPeriod({ syncMonth = true } = {}) {
    filter = null;
    allRows = false;
    if (syncMonth) calMonth = firstOf(anchor);
    renderHead();
    renderCal();
    live(`Période affichée : ${periodLabel(gran, anchor)}.`);
    const body = $("dbBody");
    body.setAttribute("aria-busy", "true");
    if ((await load()) === false) return;
    if (!reduced()) body.animate([{ opacity: 0.88, transform: "translateY(2px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.75,.25,1)" });
  }

  // ================================================================= ce qui est compté
  const byWhen = (a, b) => a.day.localeCompare(b.day) || a.start - b.start || a.title.localeCompare(b.title);
  const deadlines = () => new Map(todo.map((r) => [r.id, Date.parse(r.deadline)]));
  // rendez-vous et blocs de la période (sans les créneaux bloqués), dans l'ordre du jour et de l'heure de dépôt
  function periodItems() {
    const { start, end } = range();
    if (mode === "advanced" && agP) return K.itemsOf(agP, deadlines()).filter((it) => it.day >= start && it.day <= end && it.type !== "hold").sort(byWhen);
    if (mode === "simple") {
      const mk = (r, state) => ({
        id: r.id, type: "rdv", origin: "pixcar", state, day: r.when.day, start: minOf(r.when.start), end: minOf(r.when.end || r.when.start), title: r.client.name || "Client",
        services: r.services, plan: [], work: null, noShow: false, deadline: Date.parse(r.deadline) || null, src: { car: r.client.car, plate: r.client.plate },
      });
      const inside = (r) => r.when.day >= start && r.when.day <= end;
      const confirmed = new Map([...past, ...upcoming].filter((r) => inside(r) && r.status === "confirmed").map((r) => [r.id, mk(r, "confirmed")]));
      return [...confirmed.values(), ...todo.filter(inside).map((r) => mk(r, "pending"))].sort(byWhen);
    }
    return [];
  }
  // aujourd'hui (points d'attention) : rendez-vous et blocs du jour, sans les créneaux bloqués
  const all = () => (mode === "advanced" && ag ? K.itemsOf(ag) : []);
  const todayItems = () => (mode === "advanced" && ag ? K.itemsOf(ag, deadlines()).filter((it) => it.day === today() && it.type !== "hold").sort(byWhen) : []);
  const chipOf = (it) => (it.state === "pending" ? "pending" : it.noShow ? "no_show" : it.work ? it.work : "confirmed");
  const carOf = (it) => {
    if (it.type === "rdv") return [it.src.car, it.src.plate].filter(Boolean).join(" · ");
    return it.src.vehicle && agP ? (agP.vehicles.find((x) => x.id === it.src.vehicle) || { label: "" }).label : "";
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

  function counts(items) {
    const expected = items.filter((it) => !it.noShow);
    const pending = expected.filter((it) => it.state === "pending");
    return {
      items, pending,
      waiting: expected.filter((it) => it.state === "pending" || (it.state === "confirmed" && it.work === "planned")), // pas encore arrivées
      live: expected.filter((it) => WORK_LIVE.includes(it.work)),
      ready: expected.filter((it) => it.work === "done"),
      returned: expected.filter((it) => it.work === "returned"),
    };
  }
  // la capacité de la période, mécanicien par mécanicien : heures de travail, main-d'œuvre planifiée, heures encore libres (à partir de
  // maintenant ; un jour passé n'en a plus), présence
  function capacity() {
    const list = K.itemsOf(agP), now = nowP(), days = daysOf(range());
    const team = agP.staff.filter((m) => m.active).map((m) => {
      let total = 0, booked = 0, free = 0, works = false, away = false;
      for (const d of days) {
        const work = K.workOf(agP, st, m, d), rows = K.rowsOn(list, "staff", m.id, d, "labour");
        total += K.total(work);
        booked += K.total(rows);
        if (d >= now.iso) free += K.total(K.minus(K.inter(work, [[d === now.iso ? now.min : 0, 1440]]), rows));
        if (K.total(work)) works = true;
        else if (K.hoursFor(agP, st, m, d).length) away = true; // ses heures, toutes prises par une absence
      }
      return { m, total, booked, free, works, away: away && !works, past: days[days.length - 1] < now.iso };
    });
    const posts = agP.resources.filter((x) => x.active && days.some((d) => K.total(K.workOf(agP, st, x, d)) > 0)).length;
    const sum = (k) => team.reduce((n, p) => n + p[k], 0);
    return { team, total: sum("total"), booked: sum("booked"), free: sum("free"), present: team.filter((p) => p.works).length, posts, allPosts: agP.resources.length };
  }

  // ================================================================= points d'attention, les plus urgents d'abord (toujours ceux d'aujourd'hui)
  function points() {
    const out = [];
    const t = today(), now = nowP();
    const pricesDue = g.prices.filter((p) => p.state === "due" || p.state === "stale");
    if (mode === "advanced" && ag) {
      const items = all();
      for (const c of ag.conflicts) {
        const it = items.find((x) => x.id === c.id);
        out.push({ tone: "red", icon: "i-flag", title: it ? `En conflit : ${it.title}` : "Rendez-vous en conflit", sub: c.reasons[0] || "Une affectation ne tient plus.", act: "Ouvrir dans le planning", go: () => goPanel("planning", it ? { day: it.day, item: it.id } : {}) });
      }
      for (const it of todayItems()) {
        if (it.noShow || it.state !== "confirmed") continue;
        if (it.work === "planned" && now.min >= it.start + LATE_MIN)
          out.push({ tone: "amber", icon: "i-car", title: `Voiture pas arrivée : ${it.title}`, sub: `Attendue à ${timeLabel(it.start)}. « Voiture reçue » ou « Client absent » dans ses actions.`, act: "Voir le rendez-vous", go: () => focusRow(it) });
        if (WORK_LIVE.includes(it.work) && now.min > readyAt(it))
          out.push({ tone: "red", icon: "i-clock", title: `Pas prête à l'heure : ${it.title}`, sub: `Prévue à ${timeLabel(readyAt(it))}. Prévenez le client si besoin.`, act: "Voir le rendez-vous", go: () => focusRow(it) });
      }
      for (const p of (st && st.readiness && st.readiness.problems) || []) {
        const [label, ...rest] = p.text.split(" : ");
        out.push({ kind: "ready", label, tone: p.blocking ? "red" : "amber", icon: "i-alert", title: rest.length ? `${label} non planifiable` : p.text, sub: rest.length ? cap(rest.join(" : ")) : "Rendez-vous en ligne arrêtés tant que ce n'est pas réglé.", act: "Vérifier les compétences", go: () => goPanel("calendar") });
      }
      const tomorrow = addDays(t, 1);
      for (const u of ag.unavail.filter((x) => x.first <= tomorrow && tomorrow <= x.last)) {
        const staff = u.target === "staff";
        const from = u.first === tomorrow && u.from ? u.from : "", to = u.last === tomorrow && u.to ? u.to : "";
        const when = from || to ? `De ${timeLabel(minOf(from || "00:00"))} à ${to ? timeLabel(minOf(to)) : "la fermeture"}` : "Toute la journée";
        const kind = u.label || ((st && st.catalogs.kinds.find((k) => k.id === u.kind)) || { label: "" }).label;
        out.push({ tone: "amber", icon: staff ? "i-user" : "i-wrench", title: `${u.name || (staff ? "Un mécanicien" : "Un poste")} ${staff ? "absent" : "indisponible"} demain`, sub: `${when}${kind ? ` (${kind.toLowerCase()})` : ""}`, act: "Voir demain", go: () => goPanel("planning", { day: tomorrow }) });
      }
    }
    if (mode !== "none") {
      const soon = todo.filter((r) => Date.parse(r.deadline) - Date.now() < 24 * 3600e3);
      if (soon.length)
        out.push({
          tone: "blue", icon: "i-inbox", title: `${plural(soon.length, "client")} à confirmer`,
          sub: soon.slice(0, 2).map((r) => [r.client.name, r.client.car].filter(Boolean).join(" — ")).join(" · ") + (soon.length > 2 ? "…" : ""),
          act: "Répondre aux demandes", go: () => goPanel("requests"),
        });
    }
    if (mode === "simple" && rdvState) {
      if (!rdvState.notify || !rdvState.notify.email) out.push({ tone: "amber", icon: "i-mail", title: "Adresse de notification à vérifier", sub: "Sans elle, les demandes de rendez-vous ne vous arrivent pas.", act: "Vérifier l'adresse", go: () => goPanel("agenda") });
      else if (!rdvState.enabled) out.push({ tone: "blue", icon: "i-calendar", title: "Rendez-vous en ligne fermés", sub: "Ouvrez-les dans Mon garage › Horaires quand vous êtes prêt.", act: "Ouvrir les horaires", go: () => goPanel("agenda") });
    }
    if (pricesDue.length) out.push({ tone: "amber", icon: "i-tag", title: `${plural(pricesDue.length, "prix", "prix")} à confirmer`, sub: "Sans confirmation, ils sont marqués « ancien » sur Pixcar.", act: "Confirmer les prix", go: () => goPanel("prices") });
    return out.map((p, i) => ({ ...p, i })).sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.i - b.i);
  }
  // les prestations non planifiables ne font qu'un point quand elles sont plusieurs (comme la maquette : « 3 prestations non planifiables »)
  function grouped(pts) {
    const ready = pts.filter((p) => p.kind === "ready");
    if (ready.length < 2) return pts.map((p) => ({ ...p, size: 1 }));
    const reasons = new Set(ready.map((p) => p.sub));
    const group = {
      tone: ready.some((p) => p.tone === "red") ? "red" : "amber", icon: "i-alert", title: `${ready.length} prestations non planifiables`,
      sub: reasons.size === 1 ? ready[0].sub : "Les ressources actives ne couvrent pas leurs exigences.", items: ready.map((p) => p.label), act: ready[0].act, go: ready[0].go, size: ready.length,
    };
    const out = [];
    for (const p of pts) {
      if (p.kind !== "ready") out.push({ ...p, size: 1 });
      else if (p === ready[0]) out.push(group);
    }
    return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
  }

  // ================================================================= en-tête : la période et son calendrier
  function renderHead() {
    const box = $("dbGran");
    box.dataset.gran = gran;
    for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.gran === gran));
    $("dbPrev").setAttribute("aria-label", PREV[gran]);
    $("dbNext").setAttribute("aria-label", NEXT[gran]);
    $("dbPicker").setAttribute("aria-label", PICK[gran]);
    $("dbPicker").setAttribute("aria-expanded", String(calOpen));
    $("dbToday").textContent = periodLabel(gran, anchor);
    $("dbNow").textContent = NOW[gran];
    $("dbPeriod").hidden = !!g && !g.rdv;
  }
  function renderCal() {
    const box = $("dbCal");
    const open = calOpen && !(g && !g.rdv);
    box.dataset.open = String(open);
    box.setAttribute("aria-hidden", String(!open));
    box.inert = !open;
    $("dbPicker").setAttribute("aria-expanded", String(open));
    $("dbCalBody").replaceChildren(...calContent());
  }
  function calContent() {
    const y = Number(calMonth.slice(0, 4)), mo = Number(calMonth.slice(5, 7)) - 1, t = nowP().iso, r = range();
    const inMonth = (d) => d.slice(0, 7) === calMonth.slice(0, 7);
    let grid;
    if (gran === "month")
      grid = [
        el("div", { class: "pv-months", role: "group", "aria-label": PICK.month }, ...MONTHS.map((name, i) => {
          const v = `${y}-${pad(i + 1)}`, on = anchor.slice(0, 7) === v;
          return el("button", { type: "button", "data-month": v, "aria-pressed": String(on), class: cls(on && "is-chosen", t.slice(0, 7) === v && "is-current") }, name);
        })),
      ];
    else {
      const days = Array.from({ length: 42 }, (_, i) => addDays(monday(calMonth), i));
      const head = el("div", { class: "pv-wd", "aria-hidden": "true" }, ...["L", "M", "M", "J", "V", "S", "D"].map((d) => el("span", { text: d })));
      grid =
        gran === "day"
          ? [head, el("div", { class: "pv-days", role: "group", "aria-label": PICK.day }, ...days.map((d) => el("button", { type: "button", "data-day": d, "aria-label": longDay(d), "aria-pressed": String(d === anchor), class: cls(!inMonth(d) && "is-out", d === anchor && "is-chosen", d === t && "is-current") }, String(Number(d.slice(8))))))]
          : [head, el("div", { class: "pv-weeks", role: "group", "aria-label": PICK.week }, ...Array.from({ length: 6 }, (_, i) => {
              const w = days.slice(i * 7, i * 7 + 7), on = w[0] === r.start;
              return el("button", { type: "button", "data-week": w[0], "aria-label": `Semaine du ${fmt(w[0], { day: "numeric", month: "long" })} au ${fmt(w[6], { day: "numeric", month: "long", year: "numeric" })}`, "aria-pressed": String(on), class: on ? "is-chosen" : "" },
                ...w.map((d) => el("span", { class: cls(!inMonth(d) && "is-out", d === t && "is-current"), text: String(Number(d.slice(8))) })));
            }))];
    }
    roving(grid[grid.length - 1]);
    const years = Array.from({ length: 15 }, (_, i) => y - 7 + i);
    const unit = gran === "month" ? "Année" : "Mois";
    return [
      el("div", { class: "pv-cal-head" },
        el("h2", { id: "dbCalTitle" }, icon("i-calendar"), PICK[gran]),
        el("button", { type: "button", class: "pv-cal-x", "data-cal-close": "", "aria-label": "Replier le calendrier" }, icon("i-close"))),
      el("div", { class: "pv-cal-layout" },
        el("div", { class: "pv-cal-grid" },
          el("div", { class: "pv-browse" },
            el("button", { type: "button", "data-cal-shift": "-1", "aria-label": `${unit} précédent${unit === "Année" ? "e" : ""} du calendrier` }, icon("i-back")),
            el("div", {},
              gran === "month" ? null : el("select", { id: "dbCalMonth", "aria-label": "Mois du calendrier" }, ...MONTHS.map((name, i) => el("option", { value: String(i), selected: i === mo }, name))),
              el("select", { id: "dbCalYear", "aria-label": "Année du calendrier" }, ...years.map((v) => el("option", { value: String(v), selected: v === y }, String(v))))),
            el("button", { type: "button", "data-cal-shift": "1", "aria-label": `${unit} suivant${unit === "Année" ? "e" : ""} du calendrier` }, icon("i-next"))),
          ...grid),
        el("div", { class: "pv-cal-sel" },
          el("span", { class: "pv-caption", text: "Période affichée" }),
          el("strong", { text: periodLabel(gran, anchor) }),
          el("p", { text: HELP[gran] }),
          el("button", { type: "button", class: "pv-link pv-fold", "data-cal-close": "" }, "Replier le calendrier", icon("i-chevron")))),
    ];
  }
  // un seul arrêt de tabulation dans la grille (le choix, sinon le premier jour du mois) ; les flèches s'y déplacent
  function roving(grid) {
    const bs = [...grid.querySelectorAll("button")];
    const stop = bs.find((b) => b.classList.contains("is-chosen")) || bs.find((b) => !b.classList.contains("is-out")) || bs[0];
    for (const b of bs) b.tabIndex = b === stop ? 0 : -1;
  }
  function onCalKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      return toggleCal(false);
    }
    const grid = ev.target.closest(".pv-days, .pv-weeks, .pv-months");
    if (!grid) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: grid.matches(".pv-days") ? -7 : grid.matches(".pv-months") ? -3 : -1, ArrowDown: grid.matches(".pv-days") ? 7 : grid.matches(".pv-months") ? 3 : 1 }[ev.key];
    if (!step || (grid.matches(".pv-weeks") && (ev.key === "ArrowLeft" || ev.key === "ArrowRight"))) return;
    ev.preventDefault();
    const bs = [...grid.querySelectorAll("button")], i = bs.indexOf(ev.target), next = bs[Math.max(0, Math.min(bs.length - 1, i + step))];
    for (const b of bs) b.tabIndex = b === next ? 0 : -1;
    next.focus();
  }
  function toggleCal(open = !calOpen) {
    calOpen = open;
    if (calOpen) calMonth = firstOf(anchor);
    renderCal();
    if (calOpen) {
      const stop = $("dbCalBody").querySelector('.pv-days [tabindex="0"], .pv-weeks [tabindex="0"], .pv-months [tabindex="0"]');
      if (stop) stop.focus({ preventScroll: true });
    } else $("dbPicker").focus({ preventScroll: true });
  }
  function onCalClick(ev) {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-cal-close")) return toggleCal(false);
    if (b.dataset.calShift) {
      const n = Number(b.dataset.calShift);
      calMonth = gran === "month" ? `${Number(calMonth.slice(0, 4)) + n}-${calMonth.slice(5)}` : shiftMonth(calMonth, n);
      renderCal();
      return focusCal(`[data-cal-shift="${n}"]`);
    }
    const value = b.dataset.day || b.dataset.week || (b.dataset.month && `${b.dataset.month}-01`);
    if (!value) return;
    const key = b.dataset.day ? `[data-day="${value}"]` : b.dataset.week ? `[data-week="${value}"]` : `[data-month="${b.dataset.month}"]`;
    anchor = value;
    setPeriod({ syncMonth: !!b.dataset.month || !!b.dataset.day });
    focusCal(key);
  }
  function onCalChange(ev) {
    const v = Number(ev.target.value);
    if (ev.target.id === "dbCalMonth") calMonth = `${calMonth.slice(0, 5)}${pad(v + 1)}-01`;
    else if (ev.target.id === "dbCalYear") calMonth = `${v}-${calMonth.slice(5)}`;
    else return;
    const sel = ev.target.id;
    renderCal();
    focusCal(`#${sel}`);
  }
  const focusCal = (sel) => {
    const n = $("dbCalBody").querySelector(sel);
    if (n) n.focus({ preventScroll: true });
  };

  // ================================================================= rendu
  function render() {
    const gg = g.garage;
    $("dashVerified").replaceChildren(icon("i-shield"), `Garage vérifié le ${new Date(gg.verifiedAt).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "long", year: "numeric" })}`);
    const first = String(gg.holderName || "").trim().split(/\s+/)[0] || "";
    $("dashGarage").replaceChildren(
      [first ? `Bonjour ${first}` : "", gg.name].filter(Boolean).join(" · "),
      gg.addr ? el("span", { class: "pv-addr", text: `, ${gg.addr}` }) : "",
    );
    renderHead();
    const pts = points();
    const adv = mode === "advanced" && !!agP;
    const c = adv ? capacity() : null;
    renderActions();
    renderCapa(c);
    renderKpis(pts, adv);
    $("dbResources").hidden = !adv;
    if (adv) {
      renderTeam(c);
      renderPosts();
    }
    renderList();
    renderRequests();
    renderAlerts(pts);
    $("dbBottom").classList.toggle("is-solo", mode === "none");
  }

  // ---- actions rapides : les formulaires du Planning, de Mon garage ou des prix
  function renderActions() {
    const act = (primary, ic, title, onclick) => el("button", { type: "button", class: cls("db-act", primary && "is-primary"), onclick }, icon(ic), el("b", { text: title }));
    let list;
    if (mode === "advanced")
      list = [
        act(true, "i-plus", "Nouveau rendez-vous", () => goPanel("planning", { form: { kind: "job" } })),
        act(false, "i-car", "Client déjà sur place", () => goPanel("planning", { form: { kind: "job", arrived: true } })),
        act(false, "i-calendar", "Bloquer un créneau", () => goPanel("planning", { form: { kind: "hold" } })),
        act(false, "i-user", "Déclarer une absence", () => goPanel("planning", { form: { kind: "staff" } })),
      ];
    else if (mode === "simple")
      list = [
        act(true, "i-inbox", todo.length ? "Répondre aux demandes" : "Mes horaires et créneaux", () => goPanel(todo.length ? "requests" : "agenda")),
        act(false, "i-lock", "Fermer une journée", () => goPanel("agenda", { closure: true })),
        act(false, "i-tag", "Annoncer un prix", () => goPanel("prices", { add: true })),
        act(false, "i-planning", "Planning avancé", () => goPanel("calendar")),
      ];
    else
      list = [
        act(true, "i-tag", "Annoncer un prix", () => goPanel("prices", { add: true })),
        act(false, "i-settings", "Mon garage", () => goPanel("garage")),
      ];
    const box = $("dbActions");
    box.dataset.n = String(list.length);
    box.replaceChildren(...list);
  }

  // ---- la grande carte : capacité de l'atelier (mode avancé), rendez-vous en ligne (mode simple), fiche Pixcar (sans rendez-vous)
  // « 8 h 30 » : l'unité en petit, comme la maquette
  function bigHours(m) {
    const h = Math.floor(m / 60), r = Math.round(m % 60);
    if (m > 0 && m < 60) return [String(r), el("small", { text: " min" })];
    return [String(h), el("small", { text: " h" }), r ? ` ${pad(r)}` : ""];
  }
  function capaCard({ eyebrow, value, title, text, facts, meter = null, link }) {
    const bottom = [];
    if (meter) {
      const bar = el("i");
      K.css(bar, { width: `${Math.min(100, meter.p)}%` });
      bottom.push(
        el("span", { class: cls("pv-meter", meter.p > 100 && "is-over"), role: "img", "aria-label": meter.label }, bar),
        el("p", { class: "pv-scale" }, el("span", { text: meter.left }), el("span", { text: meter.right })),
      );
    }
    bottom.push(el("button", { type: "button", class: "pv-link", onclick: link.go }, icon("i-next"), link.text));
    $("dbCapa").replaceChildren(
      el("div", { class: "pv-capa-main" },
        el("div", {},
          el("h2", { class: "pv-eyebrow", id: "dbCapaTitle", text: eyebrow }),
          el("p", { class: "pv-capa-v" }, ...value),
          el("h3", { text: title }),
          el("p", { class: "pv-capa-text", text: text })),
        el("dl", { class: "pv-facts" }, ...facts.map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))))),
      el("div", { class: "pv-capa-bottom" }, ...bottom),
    );
  }
  function freshText() {
    const live = g.prices.filter((p) => p.status !== "rejected");
    return live.length ? `${live.filter((p) => p.state === "ok").length} / ${live.length}` : "—";
  }
  function renderCapa(c) {
    if (c) {
      const day = gran === "day";
      const done = c.team.length && c.team.every((p) => p.past);
      capaCard({
        eyebrow: "La capacité de votre atelier",
        value: bigHours(c.free),
        title: c.free ? (day ? "de main-d'œuvre encore disponible" : "de main-d'œuvre non planifiée") : "Aucune capacité disponible",
        text: done ? "Période passée : plus de capacité à planifier." : c.present ? "Capacité libre calculée sur la période, selon les horaires et les absences de l'équipe." : "Aucun mécanicien n'est disponible sur la période affichée.",
        facts: [
          [day ? "Mécaniciens présents" : "Mécaniciens sur la période", `${c.present} / ${c.team.length}`],
          ["Postes disponibles", `${c.posts} / ${c.allPosts}`],
          ["Charge planifiée", hrs(c.booked)],
        ],
        meter: { p: pct(c.booked, c.total), label: `Charge planifiée : ${pct(c.booked, c.total)} % de la capacité`, left: `${hrs(c.booked)} planifiées`, right: `${hrs(c.total)} de capacité` },
        link: { text: "Ajuster les disponibilités", go: () => goPanel("calendar") },
      });
    } else if (mode === "simple") {
      const items = periodItems();
      const ok = items.filter((it) => it.state === "confirmed").length, wait = items.filter((it) => it.state === "pending").length;
      capaCard({
        eyebrow: "Vos rendez-vous en ligne",
        value: [String(ok)],
        title: `${ok > 1 ? "rendez-vous confirmés" : "rendez-vous confirmé"} sur ${NOUN[gran]}`,
        text: rdvState && !rdvState.enabled ? "Rendez-vous en ligne fermés : ouvrez-les dans Mon garage › Horaires." : "Les demandes acceptées de la période, en plus de celles à confirmer.",
        facts: [
          ["À confirmer sur la période", String(wait)],
          ["Vues de la fiche · 30 j", String(g.visits.views.recent)],
          ["Prix à jour", freshText()],
        ],
        link: { text: "Horaires et créneaux", go: () => goPanel("agenda") },
      });
    } else {
      const v = g.visits;
      capaCard({
        eyebrow: "Votre fiche Pixcar",
        value: [String(v.views.recent)],
        title: "vues de votre fiche sur 30 jours",
        text: evolution(v.views) ? `${cap(evolution(v.views))} par rapport aux 30 jours d'avant.` : "Les automobilistes qui ont ouvert la fiche de votre garage sur Pixcar.",
        facts: [
          ["Les 30 jours d'avant", String(v.views.previous || 0)],
          ["Clics « Appeler » · 30 j", String(v.calls.recent)],
          ["Rendez-vous en ligne", "Non proposés"],
        ],
        link: { text: "Annoncer un prix", go: () => goPanel("prices", { add: true }) },
      });
    }
  }

  // ---- quatre chiffres ; ceux de l'atelier filtrent la liste
  function kpi({ key, value, label, sub, pressed = null, onclick }) {
    return el(
      "li",
      { class: "db-kpi" },
      el(
        "button",
        { type: "button", class: "db-kpi-btn", "data-kpi": key, ...(pressed === null ? {} : { "aria-pressed": String(pressed) }), onclick },
        el("span", { class: "db-kpi-l", text: label }),
        el("strong", { class: "db-kpi-v", text: String(value) }),
        el("small", { class: "db-kpi-s", text: sub }),
      ),
    );
  }
  const toggle = (key) => () => {
    filter = filter === key ? null : key;
    allRows = false;
    renderKpis(points(), mode === "advanced" && !!agP);
    renderList();
    live(filter ? `Liste : ${FILTERS[filter].toLowerCase()}.` : "Liste : tout.");
  };
  function renderKpis(pts, adv) {
    const alert = { key: "alerts", value: pts.length, label: "Points d'attention", sub: pts.length ? "à vérifier" : "rien à signaler", onclick: () => $("dbAlertsTitle").focus() };
    let cards;
    if (adv) {
      const c = counts(periodItems()), noun = NOUN[gran];
      cards =
        gran === "day"
          ? [
              { key: "expected", value: c.waiting.length, label: "Véhicules attendus", sub: c.pending.length ? `à recevoir, dont ${c.pending.length} à confirmer` : "à recevoir", pressed: filter === "expected", onclick: toggle("expected") },
              { key: "live", value: c.live.length, label: "Interventions en cours", sub: "dans l'atelier", pressed: filter === "live", onclick: toggle("live") },
              { key: "ready", value: c.ready.length, label: "Véhicules prêts", sub: "à restituer", pressed: filter === "ready", onclick: toggle("ready") },
              alert,
            ]
          : [
              { key: "all", value: c.items.filter((it) => !it.noShow).length, label: "Rendez-vous planifiés", sub: `sur ${noun}`, onclick: () => $("dbTodayTitle").focus() },
              { key: "returned", value: c.returned.length, label: "Véhicules restitués", sub: `sur ${noun}`, pressed: filter === "returned", onclick: toggle("returned") },
              { key: "ready", value: c.ready.length, label: "Véhicules prêts", sub: "à restituer", pressed: filter === "ready", onclick: toggle("ready") },
              alert,
            ];
    } else if (mode === "simple") {
      const v = g.visits;
      cards = [
        { key: "todo", value: todo.length, label: "Demandes à traiter", sub: todo.length ? "avant l'heure limite" : "tout est à jour", onclick: () => goPanel("requests") },
        { key: "views", value: v.views.recent, label: "Vues de la fiche", sub: evolution(v.views) || "sur 30 jours", onclick: () => goPanel("prices") },
        { key: "calls", value: v.calls.recent, label: "Clics « Appeler »", sub: evolution(v.calls) || "sur 30 jours", onclick: () => goPanel("prices") },
        alert,
      ];
    } else
      cards = [
        { key: "calls", value: g.visits.calls.recent, label: "Clics « Appeler »", sub: evolution(g.visits.calls) || "sur 30 jours", onclick: () => goPanel("prices") },
        { key: "prices", value: g.prices.length, label: "Prix annoncés", sub: "visibles sur Pixcar", onclick: () => goPanel("prices") },
        { key: "fresh", value: freshText(), label: "Prix à jour", sub: "Mon garage › Prestations", onclick: () => goPanel("prices") },
        alert,
      ];
    $("dbKpis").replaceChildren(...cards.map(kpi));
  }

  // ---- les rendez-vous de la période
  function renderList() {
    const card = $("dbTodayCard");
    card.hidden = mode === "none";
    if (mode === "none") return;
    const adv = mode === "advanced" && !!agP;
    $("dbTodayText").textContent = gran === "day" ? (anchor === nowP().iso ? "Aujourd'hui à l'atelier" : "La journée à l'atelier") : gran === "week" ? "Les rendez-vous de la semaine" : "Les rendez-vous du mois";
    $("dbPlanLink").hidden = !adv;
    const c = counts(periodItems());
    const items = filter === "expected" ? c.waiting : filter === "live" ? c.live : filter === "ready" ? c.ready : filter === "returned" ? c.returned : c.items;
    const f = $("dbFilter");
    f.hidden = !filter;
    if (filter) f.replaceChildren(el("span", { text: `Filtre : ${FILTERS[filter]}` }), el("button", { type: "button", class: "link-btn", onclick: toggle(filter) }, "Tout afficher"));
    const shown = allRows ? items : items.slice(0, ROWS_SHOWN);
    $("dbList").replaceChildren(...shown.map((it) => row(it, adv)));
    $("dbList").hidden = !items.length;
    const empty = $("dbListEmpty");
    empty.hidden = items.length > 0;
    if (!items.length) {
      $("dbListEmptyTitle").textContent = filter === "live" ? "Aucune intervention en cours." : filter === "ready" ? "Aucune voiture prête pour l'instant." : filter === "returned" ? "Aucune voiture restituée sur la période." : filter === "expected" ? "Plus aucune voiture attendue." : `Aucun rendez-vous sur ${THIS[gran]}.`;
      $("dbListEmptyText").textContent = filter ? "« Tout afficher » pour revoir tous les rendez-vous de la période." : adv ? "Aucune intervention prévue sur cette période. Le planning reste accessible pour préparer les prochaines dates." : "Les rendez-vous confirmés de la période apparaîtront ici.";
      const go = $("dbListEmptyGo");
      go.hidden = !!filter;
      go.querySelector("span").textContent = adv ? "Consulter le planning" : "Voir les demandes";
    }
    const more = $("dbListMore");
    more.hidden = items.length <= ROWS_SHOWN;
    $("dbListCount").textContent = `${plural(items.length, "rendez-vous", "rendez-vous")} sur ${NOUN[gran]}`;
    const btn = $("dbMoreRows");
    btn.setAttribute("aria-expanded", String(allRows));
    btn.querySelector("span").textContent = allRows ? "Voir moins" : `Voir les ${items.length} rendez-vous`;
  }
  function row(it, adv) {
    const key = chipOf(it);
    const [label, tone] = CHIP[key] || CHIP.planned;
    const pixcar = it.type === "rdv";
    return el(
      "li",
      { class: cls("db-row", `is-${key}`, it.noShow && "is-noshow"), "data-id": it.id },
      el("span", { class: "db-time" }, gran === "day" ? null : el("small", { class: "db-day", text: fmt(it.day, { weekday: "short", day: "numeric" }) }), timeLabel(it.start)),
      el(
        "span",
        { class: "db-main" },
        el("b", {}, el("span", { class: cls("db-origin", pixcar ? "is-pixcar" : "is-off"), title: pixcar ? "Pris sur Pixcar" : "Hors Pixcar" }, icon(pixcar ? "i-globe" : "i-phone"), el("span", { class: "sr-only", text: pixcar ? "Pixcar : " : "Hors Pixcar : " })), el("span", { class: "db-svc", text: svcLine(it.services) || "Rendez-vous hors Pixcar" })),
        el("small", { class: "db-who", text: [it.title, carOf(it)].filter(Boolean).join(" · ") }),
      ),
      el("span", { class: `db-chip tone-${tone}`, text: label }),
      adv || it.state === "pending" ? moreMenu(it) : el("span", { class: "db-more" }),
    );
  }
  // menu « Actions » d'une ligne : les passages possibles, puis le planning (ou Demandes pour une demande à confirmer)
  function moreMenu(it) {
    const acts = [];
    if (it.state === "pending") acts.push({ label: "Répondre à la demande", run: () => goPanel("requests") });
    else if (mode === "advanced" && it.work && it.day >= addDays(today(), -30) && it.day <= today()) for (const a of workActions(it.work)) if (a.to !== "no_show" || started(it)) acts.push({ label: a.label, back: a.back, run: (b) => doWork(it, a.to, b) });
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
  // un point d'attention d'aujourd'hui : la journée affichée, toute la liste, puis le rendez-vous
  async function focusRow(it) {
    if (gran !== "day" || anchor !== it.day) {
      gran = "day";
      anchor = it.day;
      await setPeriod();
    }
    filter = null;
    allRows = true;
    renderList();
    const b = document.querySelector(`#dbList [data-id="${it.id}"] .db-more-btn`);
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
    $("dbRq").hidden = !todo.length;
    $("dbRq").replaceChildren(
      ...list.map((r) =>
        el(
          "li",
          { class: "db-rq-row", "data-id": r.id },
          el("span", { class: "db-rq-text" }, el("b", { text: r.client.name }), el("small", { text: `${svcLine(r.services)} · ${cap(r.when.label)}` }), el("small", { text: [r.client.car, r.client.plate].filter(Boolean).join(" · ") })),
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

  // ---- équipe : charge de la période, heures encore libres ; aujourd'hui, ce que fait chacun maintenant
  function staffNow(m) {
    const t = today(), now = nowP().iso === t ? nowP().min : -1;
    const hours = K.hoursFor(ag, st, m, t);
    if (!hours.length) return null;
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
  function renderTeam(c) {
    const isToday = gran === "day" && anchor === nowP().iso && !!ag;
    $("dbTeam").replaceChildren(
      ...(c.team.length
        ? c.team.map((p, i) => {
            const bar = el("i");
            K.css(bar, { width: `${Math.min(100, pct(p.booked, p.total))}%` });
            const text = p.away ? "Absence déclarée" : !p.works ? (gran === "day" ? "Ne travaille pas ce jour" : "Aucune disponibilité sur la période") : p.past ? `${hrs(p.booked)} planifiées` : `${hrs(p.free)} disponibles`;
            const now = isToday ? staffNow(p.m) : null;
            return el(
              "li",
              { class: "pv-person" },
              el("span", { class: `pv-avatar av-${i % 5}`, "aria-hidden": "true", text: initials(p.m.name) }),
              el(
                "span",
                { class: "pv-person-main" },
                el("span", { class: "pv-person-top" }, el("b", { text: p.m.name }), el("small", { text: p.works ? `${hrs(p.booked)} / ${hrs(p.total)}` : "—" })),
                el("span", { class: cls("pv-meter", p.booked > p.total && "is-over"), role: "img", "aria-label": p.total ? `Charge : ${pct(p.booked, p.total)} %` : "Charge : aucune heure de travail" }, bar),
                el("span", { class: "pv-person-sub" }, el("span", { text }), now ? el("span", { class: `db-chip tone-${now.tone}`, text: now.text }) : null),
              ),
            );
          })
        : [el("li", { class: "pv-calm", text: "Aucun mécanicien actif : ajoutez-les dans Mon garage › Ressources." })]),
    );
    $("dbTeamFoot").textContent = c.present ? "Charge planifiée sur la période affichée." : "Aucune main-d'œuvre disponible sur cette période.";
  }

  // ---- postes et équipements : aujourd'hui, leur état maintenant ; sinon, sur la période
  function postNow(x) {
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
  function postState(x) {
    if (!x.active) return { chip: "Hors service", tone: "grey", sub: "" };
    if (gran === "day" && anchor === nowP().iso && ag) return postNow(x);
    const days = daysOf(range());
    if (!days.some((d) => K.hoursFor(agP, st, x, d).length)) return { chip: "Fermé", tone: "grey", sub: "" };
    if (!days.some((d) => K.total(K.workOf(agP, st, x, d)) > 0)) return { chip: "Indisponible", tone: "red", sub: "" };
    return { chip: "Disponible", tone: "green", sub: days.some((d) => K.awayOn(agP, x.id, d).length) ? "Indisponible une partie de la période" : "" };
  }
  function renderPosts() {
    const posts = agP.resources;
    $("dbPosts").replaceChildren(
      ...(posts.length
        ? posts.map((x) => {
            const s = postState(x);
            return el(
              "li",
              { class: "pv-post" },
              el("span", { class: "pv-post-name" }, icon(RES_ICON[x.type] || "i-wrench"), el("span", {}, el("b", { text: x.name }), s.sub ? el("small", { text: s.sub }) : null)),
              el("span", { class: `db-chip tone-${s.tone}`, text: s.chip }),
            );
          })
        : [el("li", { class: "pv-calm", text: "Aucun poste : ajoutez-les dans Mon garage › Ressources." })]),
    );
  }

  // ---- points d'attention : le plus urgent en encart, les autres derrière « N autres points d'attention »
  function renderAlerts(pts) {
    const list = grouped(pts);
    const count = $("dbAlertsCount");
    count.hidden = !pts.length;
    count.textContent = String(pts.length);
    count.setAttribute("aria-label", plural(pts.length, "point"));
    $("dbAlertsEmpty").hidden = pts.length > 0;
    const top = $("dbAlertTop");
    top.hidden = !list.length;
    if (list.length) {
      const p = list[0];
      top.className = `pv-alert-top tone-${p.tone}`;
      top.replaceChildren(
        ...[
          el("div", { class: "pv-alert-head" }, icon(p.icon), el("div", {}, el("b", { text: p.title }), el("p", { text: p.sub }))),
          p.items ? el("ul", {}, ...p.items.map((x) => el("li", { text: x }))) : null,
          el("button", { type: "button", class: "pv-alert-go", onclick: p.go }, icon("i-next"), p.act),
        ].filter(Boolean),
      );
    }
    const rest = list.slice(1), others = pts.length - (list.length ? list[0].size : 0);
    const ul = $("dbAlerts");
    ul.hidden = !allAlerts || !rest.length;
    ul.replaceChildren(
      ...rest.map((p) =>
        el("li", {}, el("button", { type: "button", class: `db-alert tone-${p.tone}`, onclick: p.go }, el("span", { class: "db-alert-ic" }, icon(p.icon)), el("span", { class: "db-alert-t" }, el("b", { text: p.title }), el("small", { text: p.sub })), icon("i-next"))),
      ),
    );
    const more = $("dbAlertsMore");
    more.hidden = !rest.length;
    more.setAttribute("aria-expanded", String(allAlerts));
    more.querySelector("span").textContent = allAlerts ? "Masquer les autres points" : others > 1 ? `${others} autres points d'attention` : "1 autre point d'attention";
  }

  // ---- branchements
  for (const b of $("dbGran").querySelectorAll("button"))
    b.addEventListener("click", () => {
      if (gran === b.dataset.gran) return;
      gran = b.dataset.gran;
      setPeriod();
    });
  const shift = (n) => {
    anchor = gran === "day" ? addDays(anchor, n) : gran === "week" ? addDays(anchor, 7 * n) : shiftMonth(anchor, n);
    setPeriod();
  };
  $("dbPrev").addEventListener("click", () => shift(-1));
  $("dbNext").addEventListener("click", () => shift(1));
  $("dbNow").addEventListener("click", () => {
    anchor = nowP().iso;
    setPeriod();
  });
  $("dbPicker").addEventListener("click", () => toggleCal());
  $("dbCal").addEventListener("click", onCalClick);
  $("dbCal").addEventListener("change", onCalChange);
  $("dbCal").addEventListener("keydown", onCalKey);
  $("dbPlanLink").addEventListener("click", () => goPanel("planning", { day: range().start <= nowP().iso && nowP().iso <= range().end ? nowP().iso : range().start }));
  $("dbListEmptyGo").addEventListener("click", () => (mode === "advanced" ? goPanel("planning", { day: range().start }) : goPanel("requests")));
  $("dbMoreRows").addEventListener("click", () => {
    allRows = !allRows;
    renderList();
    live(allRows ? "Tous les rendez-vous de la période sont affichés." : "Les trois premiers rendez-vous sont affichés.");
  });
  $("dbRqLink").addEventListener("click", () => goPanel("requests"));
  for (const b of document.querySelectorAll("#dash-top [data-goto]")) b.addEventListener("click", () => goPanel(b.dataset.goto === "team" ? "calendar" : b.dataset.goto));
  $("dbAlertsMore").addEventListener("click", () => {
    allAlerts = !allAlerts;
    renderAlerts(points());
  });
  $("workForm").addEventListener("submit", submitReady);
  $("workClose").addEventListener("click", () => $("workDlg").close());
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#dbList .db-more")) closeMenus();
  });

  return { open, reload: () => (g ? load() : null), refreshPrices: (garageData) => ((g = garageData), g && render()) };
}
