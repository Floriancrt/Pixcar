// Espace Pro, écran « Planning » (docs/calendrier-avance.md, lot 3b ; mode avancé seulement) : cinq vues sur les rendez-vous Pixcar, les
// rendez-vous pris hors Pixcar et les créneaux bloqués — Jour (une colonne par mécanicien ou par poste), Semaine (une par jour ouvert),
// Mois (grille de six semaines), Par mécanicien et Par poste (une colonne par jour). Un bloc s'ouvre (fiche : détail, déplacer ou
// réaffecter au clavier, appeler, annuler) ou se glisse (souris ; doigt après un appui long ; pas de 15 min). L'API contrôle tout avant
// d'enregistrer : un conflit donne sa cause et d'autres horaires, un changement d'heure d'un rendez-vous client demande confirmation.
// Que du TEXTE écrit dans la page.
import { phoneText } from "../shared/garage-profile.js";
import { GARAGE_CANCEL_REASONS, addDays, dayLabel, hm, minOf, parisParts, timeLabel, weekday } from "../shared/rdv.js";

const VIEWS = [
  ["day", "Jour"],
  ["week", "Semaine"],
  ["month", "Mois"],
  ["staff", "Par mécanicien"],
  ["post", "Par poste"],
];
const STATUS = {
  pending: ["À confirmer", "i-clock"],
  confirmed: ["Confirmé", "i-check"],
  job: ["Hors Pixcar", "i-phone"],
  hold: ["Bloqué", "i-lock"],
  conflict: ["En conflit", "i-flag"],
};
const WEEK = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const SNAP = 15; // pas du glisser-déposer, en minutes
const PPM = 1; // pixels par minute dans les grilles horaires (CSS : --ppm)
const HOLD_MS = 350; // appui long avant de glisser au doigt
const ROLE = { labour: "main-d'œuvre", station: "poste", tool: "équipement" };
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;
const monday = (iso) => addDays(iso, -WEEK.indexOf(weekday(iso)));
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") : ""}` : `${m} min`);
const range = (a, b) => `${timeLabel(a)}–${timeLabel(b)}`;
const snap = (m, step = SNAP) => Math.round(m / step) * step;
// positions et tailles posées par le CSSOM : la politique de sécurité de la page publiée (style-src 'self') refuse l'attribut style
const css = (node, props) => {
  for (const [k, v] of Object.entries(props)) node.style.setProperty(k, v);
  return node;
};
// une affectation de l'API (instants) → jour et minutes de Paris
function rowOf(r) {
  const a = parisParts(Date.parse(r.start)), b = parisParts(Date.parse(r.end));
  return { ...r, day: a.iso, a: a.min, b: b.iso === a.iso ? b.min : 1440 };
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
  let view = null;
  let anchor = null; // jour de référence (AAAA-MM-JJ)
  let dayBy = "staff"; // vue Jour : colonnes par mécanicien ou par poste
  let pickStaff = null, pickPost = null; // vues « Par mécanicien » et « Par poste »
  const filters = { staff: "", post: "", service: "", status: "" };
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
      $("planFBox").open = !narrow(); // sur téléphone, les filtres sont repliés
    }
    view ||= narrow() ? "day" : "week";
    anchor ||= today();
    if (!(await load())) return;
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
  async function load() {
    const [from, to] = period();
    const n = ++loading;
    const out = await api.calAgenda(garageId, from, to);
    if (n !== loading) return false;
    data = out;
    if (!pickStaff || !data.staff.some((m) => m.id === pickStaff)) pickStaff = (activeStaff()[0] || data.staff[0] || { id: null }).id;
    if (!pickPost || !data.resources.some((x) => x.id === pickPost)) pickPost = (activePosts()[0] || data.resources[0] || { id: null }).id;
    return true;
  }
  async function reload(message) {
    if (!(await load())) return;
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
  // rendez-vous et blocs, sous une même forme
  function items() {
    const conf = new Map(data.conflicts.map((c) => [c.id, c.reasons]));
    const out = [];
    for (const a of data.appointments)
      out.push({ id: a.id, type: "rdv", status: a.status, conflict: conf.get(a.id) || null, day: a.when.day, start: minOf(a.when.start), end: minOf(a.when.end), title: a.client || "Client", services: a.services, plan: a.plan.map(rowOf), src: a });
    for (const k of data.blocks)
      out.push({ id: k.id, type: k.kind, status: k.kind, conflict: conf.get(k.id) || null, day: k.when.day, start: minOf(k.when.start), end: minOf(k.when.end), title: k.label || (k.kind === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué"), services: k.services, plan: k.plan.map(rowOf), src: k });
    return out.filter(match);
  }
  function match(it) {
    if (filters.staff && !it.plan.some((r) => r.target === "staff" && r.id === filters.staff)) return false;
    if (filters.post && !it.plan.some((r) => r.target === "resource" && r.id === filters.post)) return false;
    if (filters.service && !it.services.some((s) => s.id === filters.service)) return false;
    if (filters.status === "conflict") return !!it.conflict;
    return !filters.status || it.status === filters.status;
  }
  const svcText = (it) => it.services.map((s) => s.label).join(" + ");
  const peopleOf = (it) => [...new Set(it.plan.filter((r) => r.target === "staff").map((r) => r.name))];
  const postsOf = (it) => [...new Set(it.plan.filter((r) => r.target === "resource").map((r) => r.name))];
  const openOn = (day) => (data.days.find((d) => d.day === day) || { open: [] }).open.map(([a, b]) => [minOf(a), minOf(b)]);
  // absences et maintenances d'un mécanicien ou d'un poste, ce jour-là (de leur début à leur fin, d'un seul tenant)
  function awayOn(targetId, day) {
    const out = [];
    for (const u of data.unavail) {
      if (u.targetId !== targetId || day < u.first || day > u.last) continue;
      out.push({ a: day === u.first && u.from ? minOf(u.from) : 0, b: day === u.last && u.to ? minOf(u.to) : 1440, text: u.text });
    }
    return out;
  }

  // ================================================================= rendu
  function render() {
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

  function renderBar() {
    $("planViews").replaceChildren(
      ...VIEWS.map(([k, name]) => el("button", { type: "button", class: "pl-view", "aria-pressed": String(k === view), onclick: () => go(() => (view = k)) }, name)),
    );
    const [from, to] = period();
    const label =
      view === "day"
        ? dayLabel(anchor, { year: true })
        : view === "month"
          ? new Date(anchor + "T12:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC", month: "long", year: "numeric" })
          : `du ${dayLabel(from, { short: true })} au ${dayLabel(to, { short: true })}`;
    $("planRange").textContent = label.charAt(0).toUpperCase() + label.slice(1);
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
    else if (view === "staff") pick.replaceChildren(selectBox("planWho", "Mécanicien", data.staff.map((m) => [m.id, m.name + (m.active ? "" : " (inactif)")]), pickStaff, (v) => ((pickStaff = v), render())));
    else if (view === "post") pick.replaceChildren(selectBox("planWhich", "Poste", data.resources.map((x) => [x.id, x.name + (x.active ? "" : " (inactif)")]), pickPost, (v) => ((pickPost = v), render())));
    else pick.replaceChildren();
  }
  function shiftMonth(n) {
    const [y, m] = anchor.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 10);
  }
  function selectBox(id, labelText, options, value, onchange) {
    const s = el("select", { id }, ...options.map(([v, t]) => el("option", { value: v, text: t, selected: v === value })));
    s.addEventListener("change", () => onchange(s.value));
    return el("span", { class: "pl-pick" }, el("label", { for: id, text: labelText }), s);
  }
  function renderFilters() {
    const any = Object.values(filters).some(Boolean);
    const n = Object.values(filters).filter(Boolean).length;
    $("planFCount").textContent = n ? ` · ${n} actif${n > 1 ? "s" : ""}` : "";
    const box = (id, labelText, key, options) =>
      selectBox(id, labelText, [["", "Tous"], ...options], filters[key], (v) => {
        filters[key] = v;
        render();
        const n = items().length;
        live(Object.values(filters).some(Boolean) ? `Filtre appliqué : ${plural(n, "élément")} affiché${n > 1 ? "s" : ""}.` : "Filtres retirés.");
      });
    $("planFilters").replaceChildren(
      ...[
      box("planFStaff", "Mécanicien", "staff", data.staff.map((m) => [m.id, m.name])),
      box("planFPost", "Poste", "post", data.resources.map((x) => [x.id, x.name])),
      box("planFService", "Prestation", "service", data.services.map((s) => [s.id, s.label])),
      box("planFStatus", "Statut", "status", Object.entries(STATUS).map(([k, [t]]) => [k, t])),
      any
        ? el("button", { type: "button", class: "link-btn", onclick: () => {
            for (const k of Object.keys(filters)) filters[k] = "";
            render();
            live("Filtres retirés.");
            $("planFStaff").focus();
          } }, "Retirer les filtres")
        : null,
      ].filter(Boolean), // replaceChildren écrirait « null »
    );
  }
  function renderLegend() {
    $("planLegend").replaceChildren(...Object.entries(STATUS).map(([k, [t, ic]]) => el("li", { class: `pl-key st-${k}` }, icon(ic), t)));
  }

  // ---- colonnes des grilles horaires : { key, head, sub, day, staff?, post?, segs }
  function columns() {
    const list = items();
    const [from] = period();
    const week = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const shown = week.filter((d) => openOn(d).length || list.some((it) => it.day === d));
    const days = shown.length ? shown : week.slice(0, 5);
    const rowsFor = (pred) => list.flatMap((it) => it.plan.filter(pred).map((r) => ({ item: it, a: r.a, b: Math.max(r.b, r.a + 5), row: r })));
    const head = (d) => [dayLabel(d, { short: true }), d === data.today ? "Aujourd'hui" : ""];
    if (view === "week")
      return days.map((d) => ({ key: d, head: head(d)[0], sub: head(d)[1], day: d, segs: list.filter((it) => it.day === d).map((it) => ({ item: it, a: it.start, b: it.end > it.start ? it.end : 1440 })) }));
    if (view === "staff" || view === "post") {
      const id = view === "staff" ? pickStaff : pickPost;
      const target = view === "staff" ? "staff" : "resource";
      return days.map((d) => ({ key: d, head: head(d)[0], sub: head(d)[1], day: d, [view === "staff" ? "staff" : "post"]: id, away: awayOn(id, d), segs: rowsFor((r) => r.target === target && r.id === id && r.day === d) }));
    }
    // jour : une colonne par mécanicien (ou par poste), et « Sans affectation » s'il en faut une
    const d = anchor;
    const target = dayBy === "staff" ? "staff" : "resource";
    const pool = dayBy === "staff" ? data.staff : data.resources;
    const used = new Set(list.flatMap((it) => it.plan.filter((r) => r.target === target && r.day === d).map((r) => r.id)));
    const cols = pool
      .filter((x) => x.active || used.has(x.id))
      .map((x) => ({ key: x.id, head: x.name, sub: x.active ? "" : "inactif", day: d, [dayBy === "staff" ? "staff" : "post"]: x.id, away: awayOn(x.id, d), segs: rowsFor((r) => r.target === target && r.id === x.id && r.day === d && (dayBy !== "staff" || r.role === "labour")) }));
    const loose = list.filter((it) => it.day === d && !it.plan.some((r) => r.target === target && r.day === d));
    if (loose.length) cols.push({ key: "none", head: "Sans affectation", sub: "", day: d, segs: loose.map((it) => ({ item: it, a: it.start, b: it.end > it.start ? it.end : 1440 })) });
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
    for (let h = lo; h < hi; h += 60) hours.push(css(el("span", { text: `${h / 60}:00` }), { top: px(h) }));
    const total = cols.reduce((n, c) => n + c.segs.length, 0);
    const wrap = el(
      "div",
      { class: "pl-grid", "data-lo": String(lo), "data-hi": String(hi) },
      el("div", { class: "pl-head", "aria-hidden": "true" }, el("span", { class: "pl-corner" }), ...cols.map((c) => el("div", { class: "pl-colhead" + (c.day === data.today && view !== "day" ? " is-today" : "") }, el("b", { text: c.head }), c.sub ? el("small", { text: c.sub }) : null))),
      el(
        "div",
        { class: "pl-body" },
        el("div", { class: "pl-times", "aria-hidden": "true" }, ...hours),
        ...cols.map((c) => column(c, lo, hi, px)),
      ),
    );
    css(wrap, { "--cols": String(cols.length), "--h": `${(hi - lo) * PPM}px` });
    return el("div", { class: "pl-scroll" }, total ? null : el("p", { class: "pl-empty", text: Object.values(filters).some(Boolean) ? "Rien ne correspond aux filtres sur cette période." : "Rien de prévu sur cette période." }), wrap);
  }
  function column(c, lo, hi, px) {
    const name = [c.head, view === "day" ? dayLabel(c.day) : c.staff ? staffName(c.staff) : c.post ? postName(c.post) : ""].filter(Boolean).join(", ");
    const col = el("div", { class: "pl-col", role: "group", "aria-label": name, "data-day": c.day, "data-staff": c.staff || null, "data-post": c.post || null, "data-key": c.key });
    // hors des heures d'ouverture : grisé
    let t = lo;
    for (const [a, b] of openOn(c.day)) {
      if (a > t) col.append(css(el("div", { class: "pl-off" }), { top: px(t), height: `${(Math.min(a, hi) - t) * PPM}px` }));
      t = Math.max(t, b);
    }
    if (t < hi) col.append(css(el("div", { class: "pl-off" }), { top: px(t), height: `${(hi - t) * PPM}px` }));
    for (const u of c.away || []) {
      const a = Math.max(u.a, lo), b = Math.min(u.b, hi);
      if (b > a) col.append(css(el("div", { class: "pl-away", title: u.text }, el("span", { text: u.text })), { top: px(a), height: `${(b - a) * PPM}px` }));
    }
    for (const s of lanes(c.segs)) col.append(block(s, c, px));
    col.addEventListener("click", (ev) => {
      if (ev.target !== col && !ev.target.classList.contains("pl-off")) return;
      if (swallowClick) return;
      const lo2 = Number(col.closest(".pl-grid").dataset.lo);
      const m = snap(lo2 + (ev.clientY - col.getBoundingClientRect().top) / PPM);
      openCreate({ day: c.day, start: m, staff: c.staff || null, post: c.post || null });
    });
    return col;
  }
  function block(s, c, px) {
    const it = s.item;
    const [stText, stIcon] = STATUS[it.status];
    const who = c.staff ? postsOf(it) : peopleOf(it);
    const when = s.row ? `${range(s.a, s.b)}${s.row.role !== "labour" ? ` (${ROLE[s.row.role]})` : ""}` : range(it.start, it.end > it.start ? it.end : 1440);
    const label = [when, it.title, svcText(it), who.join(", "), stText, it.conflict ? "En conflit" : ""].filter(Boolean).join(", ");
    const b = el(
      "button",
      {
        type: "button",
        class: `pl-ev st-${it.status}${it.conflict ? " is-conflict" : ""}${(s.b - s.a) * PPM < 34 ? " is-tiny" : (s.b - s.a) * PPM < 54 ? " is-short" : ""}`,
        "aria-label": label,
        "data-id": it.id,
      },
      el("span", { class: "pl-ev-t" }, icon(it.conflict ? STATUS.conflict[1] : stIcon), el("b", { text: timeLabel(s.a) }), el("span", { text: it.title })),
      el("span", { class: "pl-ev-s", text: [svcText(it), who.join(", ")].filter(Boolean).join(" · ") }),
      el("span", { class: "pl-ev-st", text: it.conflict ? `${stText} · en conflit` : stText }),
    );
    css(b, { top: px(s.a), height: `${Math.max(18, (s.b - s.a) * PPM - 2)}px`, "--lane": String(s.lane), "--lanes": String(s.lanes) });
    b.addEventListener("click", () => {
      if (swallowClick) return;
      openSheet(it);
    });
    b.addEventListener("pointerdown", (ev) => startDrag(ev, b, s, c));
    return b;
  }

  // ---- mois : six semaines, par jour le nombre et les trois premiers
  function month() {
    const list = items();
    const [from] = period();
    const m = anchor.slice(0, 7);
    const grid = el("div", { class: "pl-month" }, ...WEEK.map((k, i) => el("span", { class: "pl-mhead", "aria-hidden": "true", text: dayLabel(addDays(from, i), { short: true }).split(" ")[0].replace(".", "") })));
    for (let i = 0; i < 42; i++) {
      const d = addDays(from, i);
      const day = list.filter((it) => it.day === d).sort((x, y) => x.start - y.start);
      const n = day.length;
      const closed = !openOn(d).length;
      grid.append(
        el(
          "button",
          { type: "button", class: `pl-mday${d.slice(0, 7) !== m ? " is-out" : ""}${d === data.today ? " is-today" : ""}${closed ? " is-closed" : ""}`, "aria-label": `${dayLabel(d)} : ${n ? plural(n, "élément") : "rien"}${closed ? ", fermé" : ""}. Ouvrir le jour.`, onclick: () => go(() => ((anchor = d), (view = "day"))) },
          el("b", { text: String(Number(d.slice(8))) }),
          n ? el("span", { class: "pl-mcount", text: plural(n, "élément") }) : null,
          ...day.slice(0, 3).map((it) => el("span", { class: `pl-mitem st-${it.status}${it.conflict ? " is-conflict" : ""}` }, icon(it.conflict ? STATUS.conflict[1] : STATUS[it.status][1]), `${timeLabel(it.start)} ${it.title}`)),
          n > 3 ? el("span", { class: "pl-mmore", text: `+ ${n - 3}` }) : null,
        ),
      );
    }
    return grid;
  }

  // ================================================================= glisser-déposer
  function startDrag(ev, node, seg, col) {
    if (ev.button !== 0 || seg.item.day < data.today) return;
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
    drag.ghost.querySelector(".pl-ev-t b").textContent = timeLabel(target.min);
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
    if (it.type === "job") return { kind: "job", label: k.label || "Rendez-vous", services: k.services.map((s) => ({ id: s.id, qty: s.qty })), vehicle: k.vehicle || null, day: change.day, time: hm(change.start), staff, station };
    const len = it.end - it.start;
    const people = change.swapStaff ? swap(idsOf(it, "staff"), ...change.swapStaff) : idsOf(it, "staff");
    const resources = change.swapPost ? swap(idsOf(it, "resource"), ...change.swapPost) : idsOf(it, "resource");
    return { kind: "hold", label: k.label || "Créneau bloqué", day: change.day, time: hm(change.start), to: change.start + len >= 1440 ? "24:00" : hm(change.start + len), staff: people, resources };
  }
  async function tryMove(it, change, { confirm = false, button = null } = {}) {
    const run = async () => {
      try {
        if (it.type === "rdv") await api.move(garageId, it.id, moveBody(it, change, confirm));
        else await api.saveBlock(garageId, it.id, moveBody(it, change));
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
    const [stText, stIcon] = STATUS[it.status];
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
    }
    facts.push(kv(it.type === "hold" ? "Jusqu'à" : "Restitution", it.end > it.start ? timeLabel(it.end) : "fin de journée"));
    const rows = it.plan.map((r) => el("li", {}, el("b", { text: r.name || "?" }), ` · ${ROLE[r.role]} · ${r.day !== it.day ? dayLabel(r.day, { short: true }) + " " : ""}${range(r.a, r.b)}${r.fixed ? " · choisi par vous" : ""}`));
    const body = [
      el("p", { class: `pl-status st-${it.status}` }, icon(stIcon), stText),
      it.conflict ? el("div", { class: "pl-conflict", role: "note" }, el("p", {}, icon("i-flag"), el("b", { text: "En conflit : " }), "une affectation ne tient plus. Déplacez ou réaffectez."), el("ul", {}, ...it.conflict.map((t) => el("li", { text: t })))) : null,
      el("ul", { class: "pl-facts" }, ...facts),
      rows.length ? el("h3", { text: "Affectations" }) : null,
      rows.length ? el("ul", { class: "pl-rows" }, ...rows) : el("p", { class: "muted", text: "Pas encore d'affectation." }),
    ];
    const past = it.day < data.today;
    const actions = [];
    if (!past) actions.push(el("button", { type: "button", class: "btn primary", id: "planMove", onclick: () => openSheet(it, { mode: "move" }) }, icon("i-calendar"), "Déplacer ou réaffecter"));
    if (a && a.phone) actions.push(el("a", { class: "btn", href: `tel:${a.phone}` }, icon("i-phone"), "Appeler"));
    if (a && !past && a.status === "confirmed") actions.push(el("button", { type: "button", class: "link-btn danger", onclick: () => cancelForm(it, "cancel") }, "Annuler ce rendez-vous"));
    if (a && a.status === "pending") actions.push(el("button", { type: "button", class: "btn", onclick: () => (dlg().close(), goPanel("requests")) }, icon("i-inbox"), "Répondre dans Demandes"));
    if (!a && !past) actions.push(el("button", { type: "button", class: "btn", onclick: () => blockForm({ item: it }) }, icon("i-edit"), "Modifier"));
    if (!a) actions.push(el("button", { type: "button", class: "link-btn danger", id: "planDel", onclick: () => removeBlock(it) }, it.type === "job" ? "Supprimer ce rendez-vous" : "Supprimer ce créneau"));
    frame(it.title, it.type === "rdv" ? "Rendez-vous Pixcar" : it.type === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué", body, actions);
    $("planForm").onsubmit = (ev) => ev.preventDefault();
    const first = $("planMove") || $("planForm").querySelector("button.btn, a.btn");
    if (first) first.focus();
  }

  // déplacer au clavier : jour, heure, mécanicien, poste ; puis les retours de l'API (confirmation, conflit et autres horaires)
  function moveForm(it, { change = null, problem = null } = {}) {
    const ch = change || { day: it.day, start: it.start, staff: currentStaff(it), post: currentPost(it) };
    const confirmAsk = problem && problem.code === "confirm";
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
      confirmAsk ? el("p", { class: "pl-ask", role: "alert" }, icon("i-mail"), problem.message || "Le client sera prévenu par e-mail du nouvel horaire.") : null,
    ];
    frame(it.title, "Déplacer ou réaffecter", body, [
      el("button", { type: "submit", class: "btn primary", id: "planMvSave" }, confirmAsk ? "Confirmer et prévenir le client" : "Enregistrer"),
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
      kind: k ? k.kind : "job",
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
    const body = [
      item ? null : el("fieldset", { class: "ag-reasons pl-kind" }, el("legend", { text: "Quoi ?" }), radio("job", "Rendez-vous pris hors Pixcar (téléphone, comptoir)"), radio("hold", "Créneau bloqué (réunion, livraison, essai…)")),
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
      problem ? el("div", { class: "pl-conflict", role: "alert" }, el("p", {}, icon("i-flag"), el("b", { text: problem.message })), reasons.length > 1 ? el("ul", {}, ...reasons.slice(1).map((t) => el("li", { text: t }))) : null) : null,
      alts.length
        ? el("div", { class: "pl-alts" }, el("p", { text: "Autres horaires possibles :" }), ...alts.map((x) => el("button", { type: "button", class: "btn small", onclick: () => {
            $("planDay").value = x.day;
            $("planTime").value = x.time;
            $("planSave").focus();
          } }, `${x.label}${x.back ? ` · rendue vers ${timeLabel(minOf(x.back))}` : ""}`)))
        : null,
      el("p", { class: "help", text: job ? "Placé comme une demande (mêmes ressources, mêmes contrôles), sans les règles de la réservation en ligne. Aucun e-mail n'est envoyé." : "Refusé si un rendez-vous ou un autre bloc occupe déjà ces mécaniciens ou postes. Pour une absence ou une maintenance, utilisez leurs fiches." }),
    ];
    frame(item ? item.title : "Nouveau", item ? (job ? "Modifier le rendez-vous hors Pixcar" : "Modifier le créneau bloqué") : "Planning", body, [
      el("button", { type: "submit", class: "btn primary", id: "planSave" }, "Enregistrer"),
      el("button", { type: "button", class: "btn", onclick: () => (item ? openSheet(item) : dlg().close()) }, item ? "Retour" : "Annuler"),
    ]);
    $("planForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const v = read();
      const body = { kind: v.kind, label: v.label, day: v.day, time: hm(v.start) };
      if (v.kind === "job") Object.assign(body, { services: v.services, vehicle: v.vehicle || null, staff: v.staff, station: v.posts[0] || null });
      else Object.assign(body, { to: v.end >= 1440 ? "24:00" : hm(v.end), staff: v.staff, resources: v.posts });
      await busy($("planSave"), async () => {
        try {
          await api.saveBlock(garageId, item ? item.id : null, body);
          dlg().close();
          const what = v.kind === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué";
          alertBox(`${what} ${item ? "modifié" : "ajouté"} : ${dayLabel(v.day, { short: true })} à ${timeLabel(v.start)}.`, "info");
          await reload(`${what} enregistré.`);
        } catch (e) {
          if (e.status === 409 && e.code === "conflict") return blockForm({ item, at, draft: v, problem: e });
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

  // ---- branchements
  // « Nouveau » : le jour affiché (aujourd'hui s'il est dans la période), à 9:00 ou au prochain quart d'heure
  $("planNew").addEventListener("click", () => {
    const [from, to] = period();
    const base = view === "day" ? anchor : data.today >= from && data.today <= to ? data.today : from;
    const day = base < data.today ? data.today : base;
    const soon = Math.ceil((parisParts(Date.now()).min + 15) / SNAP) * SNAP;
    openCreate({ day, start: day === data.today ? Math.min(Math.max(9 * 60, soon), 23 * 60) : 9 * 60, staff: view === "staff" ? pickStaff : null, post: view === "post" ? pickPost : null });
  });
  // au doigt : une fois le glisser commencé (appui long), la page ne défile plus
  $("planGrid").addEventListener("touchmove", (ev) => drag && drag.on && ev.preventDefault(), { passive: false });
  $("planGrid").addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && drag) cancelDrag();
  });

  return { open, reset: () => (data = null) };
}
