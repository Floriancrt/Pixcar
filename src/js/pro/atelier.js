// Gestion d'atelier (docs/gestion-atelier.md, 25 octobre 2026) : les vues qui s'ajoutent à la grille horaire du Planning.
//   - Liste : les rendez-vous de la période, jour par jour, avec l'état et une action rapide (l'étape suivante, appeler).
//   - Équipe et Équipements : une ligne par mécanicien (ou par poste), les heures de la journée en abscisse ; horaires, pauses,
//     absences ou maintenances, interventions côte à côte quand elles se chevauchent ; la charge du jour ; glisser une intervention
//     vers une autre ligne ou une autre heure la réaffecte (l'API contrôle tout). La semaine : un tableau ligne × jour.
//   - Suivi des interventions : une colonne par état, retards et attentes signalés, les travaux restés ouverts des jours précédents.
//   - Charge et capacité : heures de travail disponibles, planifiées, restantes, pour les mécaniciens et, séparément, l'occupation des
//     postes ; alertes de surcharge et rendez-vous à affecter.
// Fonctions de rendu pures (TEXTE seulement) : l'état (agenda, réglages, filtres, période) et les actions (fiche, création, état,
// déplacement) viennent du Planning, par h.
import { addDays, dayLabel, hm, parisParts, timeLabel } from "../shared/rdv.js";
import { WORK_LIVE, workActions } from "../shared/work.js";
import * as K from "./workshop.js";

const { cap, css, hrs, lanes, merge, minus, pct, plural, range } = K;
const SNAP = 15;
const snap = (m) => Math.round(m / SNAP) * SNAP;
const LANE_PX = 54; // hauteur d'un couloir d'une ligne (Équipe, Équipements)
const nowMin = () => parisParts(Date.now()).min;

// l'étape suivante du chemin ordinaire (prévue → reçue → en cours → prête → restituée ; reprise après une attente), pour un bouton seul
const NEXT = { planned: "received", received: "in_progress", in_progress: "done", waiting_parts: "in_progress", suspended: "in_progress", done: "returned" };
const nextStep = (state) => workActions(state).find((x) => x.to === NEXT[state]) || null;

// ================================================================= liste
// h.days() : les jours de la période ; h.items() : rendez-vous et blocs filtrés
export function listView(h) {
  const { el } = h;
  const days = h.days();
  const list = h.items().filter((it) => days.includes(it.day));
  if (!list.length) return el("div", { class: "pl-scroll pl-lwrap" }, el("p", { class: "pl-empty", text: h.emptyText() }));
  const out = el("div", { class: "pl-lwrap" });
  for (const d of days) {
    const xs = list.filter((it) => it.day === d).sort((a, b) => a.start - b.start || (a.title < b.title ? -1 : 1)); // l'heure du rendez-vous
    if (!xs.length) continue;
    const n = xs.filter((it) => it.type !== "hold").length;
    out.append(
      el(
        "section",
        { class: "pl-lday", "aria-labelledby": `planLd-${d}` },
        el("h3", { class: "pl-lday-h", id: `planLd-${d}` }, el("span", { text: cap(dayLabel(d)) }), d === h.today() ? el("small", { text: "Aujourd'hui" }) : null, el("span", { class: "pl-lday-n", text: plural(n, "rendez-vous", "rendez-vous") })),
        el("ul", { class: "pl-list" }, ...xs.map((it) => listRow(h, it))),
      ),
    );
  }
  return out;
}
function listRow(h, it) {
  const { el, icon } = h;
  const s = h.status(it);
  const [chanLabel, chanIcon] = h.chan(it);
  const car = h.carText(it);
  const who = [it.type === "hold" ? "" : it.title, ...(h.display() === "advanced" ? [...h.peopleOf(it), ...h.postsOf(it)] : [])].filter(Boolean).join(" · ");
  // l'heure du rendez-vous (dépôt de la voiture) et la restitution prévue ; la fin pour un créneau bloqué
  const a = it.start, b = it.type === "hold" ? it.end : h.backOf(it);
  const label = [b ? `${range(a, b)}` : timeLabel(a), h.what(it), car, who, chanLabel, s.label, it.conflict ? "En conflit" : ""].filter(Boolean).join(", ");
  const main = el(
    "button",
    { type: "button", class: "pl-li-main", "data-id": it.id, "aria-label": `${label}. Ouvrir la fiche.`, onclick: () => h.openSheet(it) },
    el("span", { class: "pl-li-time" }, el("b", { text: hm(a) }), b ? el("small", { text: b >= 1440 ? "fin de journée" : `→ ${hm(b)}` }) : null),
    el("span", { class: "pl-li-chan", title: chanLabel }, icon(chanIcon)),
    el("span", { class: "pl-li-body" }, el("b", { class: "pl-li-what", text: h.what(it) }), el("span", { class: "pl-li-sub", text: [car, who].filter(Boolean).join(" · ") })),
    el("span", { class: `pl-li-st tone-${s.tone}` }, el("i", { class: "pl-dot", "aria-hidden": "true" }), s.label),
    it.conflict ? el("span", { class: "pl-li-alert" }, icon("i-flag"), "Conflit") : null,
  );
  const acts = [];
  const next = h.workable(it) ? nextStep(it.work) : null;
  if (next) acts.push(el("button", { type: "button", class: "pl-li-act", "data-work": next.to, onclick: (ev) => h.setWork(it, next.to, ev.currentTarget, { quick: true }) }, next.label));
  const phone = h.phoneOf(it);
  if (phone) acts.push(el("a", { class: "pl-li-icon", href: `tel:${phone}`, "aria-label": `Appeler ${it.title}`, title: "Appeler" }, icon("i-phone")));
  return el("li", { class: `pl-li${h.shown() === it.id ? " is-open" : ""}${it.noShow ? " is-noshow" : ""}` }, main, acts.length ? el("span", { class: "pl-li-acts" }, ...acts) : null);
}

// ================================================================= équipe et équipements : une ligne par ressource
// kind : "staff" (Équipe) ou "resource" (Équipements). Jour : les heures en abscisse ; semaine : un tableau ligne × jour.
export function resourceView(h, kind) {
  const { el } = h;
  const pool = kind === "staff" ? h.data().staff : h.data().resources;
  if (!pool.length)
    return el(
      "div",
      { class: "pl-scroll pl-none" },
      el("p", { class: "pl-empty", text: kind === "staff" ? "Aucun mécanicien n'est enregistré : ajoutez votre équipe pour planifier par personne." : "Aucun poste n'est enregistré : ajoutez vos ponts et équipements pour planifier leur occupation." }),
      el("p", { class: "pl-none-act" }, el("button", { type: "button", class: "btn small", onclick: () => h.goResources() }, "Mon garage › Ressources")),
    );
  return h.view() === "week" ? resourceWeek(h, kind, pool) : resourceDay(h, kind, pool);
}
function resourceDay(h, kind, pool) {
  const { el, icon } = h;
  const day = h.anchor();
  const target = kind === "staff" ? "staff" : "resource";
  const list = h.items();
  // créneau bloqué de tout l'atelier : sur chaque ligne (sans affectation propre, il ne se glisse pas d'une ligne à l'autre)
  const whole = list.filter((it) => it.whole && it.day === day).map((it) => ({ item: it, a: it.start, b: Math.max(it.end, it.start + 5) }));
  const segsOf = (id) => [...list.flatMap((it) => it.plan.filter((r) => r.target === target && r.id === id && r.day === day && (target !== "staff" || r.role === "labour")).map((r) => ({ item: it, row: r, a: r.a, b: Math.max(r.b, r.a + 5) }))), ...whole];
  const used = new Set(list.flatMap((it) => it.plan.filter((r) => r.target === target && r.day === day).map((r) => r.id)));
  const skill = kind === "staff" ? h.skillFilter() : "";
  const hasSkill = (m) => !skill || ((h.st() && h.st().staff.find((x) => x.id === m.id)) || { skills: [] }).skills.some((k) => k.id === skill && (!k.until || k.until >= day));
  const rows = pool.filter((x) => (x.active || used.has(x.id)) && (kind !== "staff" || hasSkill(x))).map((x) => ({ x, segs: segsOf(x.id) }));
  // ce qui n'a pas de mécanicien (ou de poste) ce jour-là : « À affecter »
  // (mécaniciens seulement : une prestation peut se faire sans poste)
  const loose = kind !== "staff" ? [] : list.filter((it) => it.day === day && it.type !== "hold" && !it.noShow && !it.plan.some((r) => r.target === target && r.day === day));
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of h.openOn(day)) (lo = Math.min(lo, a)), (hi = Math.max(hi, b));
  for (const r of rows) for (const s of r.segs) (lo = Math.min(lo, s.a)), (hi = Math.max(hi, s.b));
  for (const it of loose) (lo = Math.min(lo, it.start)), (hi = Math.max(hi, it.end > it.start ? it.end : it.start + 60));
  if (!Number.isFinite(lo)) [lo, hi] = [8 * 60, 18 * 60];
  lo = Math.max(0, Math.floor(lo / 60) * 60);
  hi = Math.min(1440, Math.max(lo + 60, Math.ceil(hi / 60) * 60));
  const span = hi - lo;
  const at = (m) => `${((Math.min(Math.max(m, lo), hi) - lo) / span) * 100}%`;
  const width = (a, b) => `${((Math.min(b, hi) - Math.max(a, lo)) / span) * 100}%`;
  const hours = [];
  for (let m = lo; m < hi; m += 60) hours.push(css(el("span", { text: hm(m) }), { left: at(m) }));
  const past = day < h.today() ? [[0, 1440]] : day === h.today() ? [[0, nowMin()]] : [];
  const nowLine = day === h.today() && nowMin() > lo && nowMin() < hi ? css(el("i", { class: "pl-tl-now", "aria-hidden": "true" }), { left: at(nowMin()) }) : null;
  const head = el("div", { class: "pl-tl-row pl-tl-head", "aria-hidden": "true" }, el("span", { class: "pl-tl-who" }), el("div", { class: "pl-tl-track pl-tl-hours" }, ...hours));
  const grid = el("div", { class: "pl-tl", "data-lo": String(lo), "data-hi": String(hi), "data-day": day, "data-kind": kind }, head);
  css(grid, { "--hours": String(span / 60) });
  for (const { x, segs } of rows) {
    const l = kind === "staff" ? h.staffLoad(x, day) : h.postLoad(x, day);
    const avail = h.hoursFor(x, day);
    const away = h.awayOn(x.id, day);
    const p = l.avail ? pct(l.planned, l.avail) : null;
    const hoursText = avail.length ? merge(avail).map(([a, b]) => range(a, b)).join(" · ") : "";
    const state = !x.active ? "Inactif" : away.length && !l.avail ? (kind === "staff" ? "Absent" : "Indisponible") : !avail.length ? (kind === "staff" ? "Ne travaille pas ce jour" : "Fermé") : "";
    const loadText = l.avail ? `${hrs(l.planned)} / ${hrs(l.avail)} · ${p} %` : state;
    const who = el(
      "div",
      { class: "pl-tl-who" },
      el("span", { class: "pl-tl-name" }, kind === "staff" ? el("span", { class: "pl-tl-av", "aria-hidden": "true", text: x.name.charAt(0).toUpperCase() }) : icon("i-wrench"), el("b", { text: x.name })),
      el("small", { text: hoursText || state }),
      l.avail ? el("span", { class: "pl-tl-load" }, css(el("span", { class: `pl-meter${p > 100 ? " is-over" : p >= 85 ? " is-high" : ""}` }, css(el("i"), { width: `${Math.min(100, p)}%` })), {}), el("span", { text: loadText })) : state && hoursText ? el("span", { class: "pl-tl-state", text: state }) : null,
    );
    const track = el("div", { class: "pl-tl-track", role: "group", "aria-label": `${x.name}, ${dayLabel(day)}${loadText ? `, ${loadText}` : ""}`, [kind === "staff" ? "data-staff" : "data-post"]: x.id });
    const band = (cls, [a, b], text = "") => {
      if (Math.min(b, hi) <= Math.max(a, lo)) return;
      track.append(css(el("div", { class: cls, title: text || null }, text ? el("span", { text }) : null), { left: at(a), width: width(a, b) }));
    };
    const awayR = away.map((u) => [u.a, u.b]);
    const opens = merge(avail);
    for (const r of minus([[lo, hi]], merge([...avail, ...awayR]))) band("pl-off", r, opens.length > 1 && r[0] >= opens[0][1] && r[1] <= opens[opens.length - 1][0] ? "Pause" : "");
    for (const u of away) band("pl-away", [u.a, u.b], u.text);
    for (const r of K.inter(minus(avail, awayR), past)) band("pl-past", r);
    const ls = lanes(segs);
    const n = Math.max(1, ...ls.map((s) => s.lanes || 1));
    for (const s of ls) track.append(tlBlock(h, s, kind, at, width));
    if (nowLine) track.append(nowLine.cloneNode());
    css(track, { "--rows": String(n), height: `${n * LANE_PX + 8}px` });
    track.addEventListener("click", (ev) => {
      if (ev.target !== track && !/\bpl-(off|past)\b/.test(ev.target.className)) return;
      if (h.swallow()) return;
      const r = track.getBoundingClientRect();
      const m = snap(lo + ((ev.clientX - r.left) / r.width) * span);
      h.openCreate({ day, start: m, staff: kind === "staff" ? x.id : null, post: kind === "resource" ? x.id : null });
    });
    grid.append(el("div", { class: `pl-tl-row${x.active ? "" : " is-off"}` }, who, track));
  }
  if (loose.length) {
    const ls = lanes(loose.map((it) => ({ item: it, a: it.start, b: it.end > it.start ? it.end : Math.min(1440, it.start + 60) })));
    const n = Math.max(1, ...ls.map((s) => s.lanes || 1));
    const track = el("div", { class: "pl-tl-track is-loose", role: "group", "aria-label": `À affecter, ${plural(loose.length, "rendez-vous", "rendez-vous")}` }, ...ls.map((s) => tlBlock(h, s, kind, at, width)));
    css(track, { height: `${n * LANE_PX + 8}px` });
    grid.append(el("div", { class: "pl-tl-row is-loose" }, el("div", { class: "pl-tl-who" }, el("span", { class: "pl-tl-name" }, icon("i-alert"), el("b", { text: "À affecter" })), el("small", { text: kind === "staff" ? "Sans mécanicien ce jour-là" : "Sans poste ce jour-là" })), track));
  }
  if (!rows.length && !loose.length) grid.append(el("p", { class: "pl-empty", text: skill ? "Personne n'a cette compétence ce jour-là." : "Rien à afficher ce jour-là." }));
  return el("div", { class: "pl-scroll", tabindex: "0", role: "region", "aria-label": kind === "staff" ? "Planning de l'équipe" : "Planning des équipements" }, grid);
}
// une intervention dans une ligne : horaires, prestation, voiture ; teinte de l'avancement ; glissable
function tlBlock(h, s, kind, at, width) {
  const { el, icon } = h;
  const it = s.item;
  const st = h.status(it);
  const [chanLabel, chanIcon] = h.chan(it);
  const car = h.carText(it);
  const others = kind === "staff" ? h.postsOf(it) : h.peopleOf(it);
  const role = s.row && s.row.role === "tool" ? "équipement" : "";
  const full = [`${range(s.a, s.b)}${role ? ` (${role})` : ""}`, h.what(it), car, it.type === "hold" ? "" : it.title, ...others, chanLabel, st.label, it.conflict ? "En conflit" : ""].filter(Boolean);
  const b = el(
    "button",
    { type: "button", class: `pl-tl-ev pl-ev tone-${st.tone}${it.conflict ? " is-conflict tone-conflict" : ""}${h.shown() === it.id ? " is-open" : ""}`, "data-id": it.id, "aria-label": full.join(", "), title: full.join("\n") },
    el("span", { class: "pl-ev-h" }, el("b", { text: `${hm(s.a)}–${s.b >= 1440 ? "24:00" : hm(s.b)}` }), icon(chanIcon)),
    el("span", { class: "pl-ev-t", text: h.what(it) }),
    el("span", { class: "pl-ev-s", text: [car || (it.type === "hold" ? "" : it.title), st.key !== "planned" && st.key !== "confirmed" ? st.label : ""].filter(Boolean).join(" · ") }),
  );
  css(b, { left: at(s.a), width: width(s.a, s.b), top: `${(s.lane || 0) * LANE_PX + 4}px` });
  b.addEventListener("click", () => !h.swallow() && h.openSheet(it));
  b.addEventListener("pointerdown", (ev) => tlDrag(h, ev, b, s, kind));
  return b;
}
// glisser dans le planning en lignes : l'heure suit l'abscisse (pas de 15 min), la ligne d'arrivée impose le mécanicien (ou le poste)
let drag = null;
function tlDrag(h, ev, node, seg, kind) {
  const it = seg.item;
  if (ev.button !== 0 || it.day < h.today() || (it.work && it.work !== "planned") || !seg.row) return;
  const track = node.parentNode;
  drag = { h, node, seg, kind, x: ev.clientX, y: ev.clientY, id: ev.pointerId, on: false, dx: ev.clientX - node.getBoundingClientRect().left, from: track, touch: ev.pointerType === "touch", timer: null };
  if (drag.touch) drag.timer = setTimeout(() => drag && tlBegin(), 350);
  window.addEventListener("pointermove", tlMove);
  window.addEventListener("pointerup", tlEnd);
  window.addEventListener("pointercancel", tlCancel);
}
function tlBegin() {
  drag.on = true;
  drag.node.classList.add("is-dragging");
  const g = drag.node.cloneNode(true);
  g.removeAttribute("aria-label");
  g.setAttribute("aria-hidden", "true");
  g.classList.add("pl-ghost");
  css(g, { left: drag.node.style.left, width: drag.node.style.width, top: "4px" });
  drag.ghost = g;
}
function tlTarget(ev) {
  const track = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList && n.classList.contains("pl-tl-track") && (n.dataset.staff || n.dataset.post));
  if (!track) return null;
  const grid = track.closest(".pl-tl");
  const lo = Number(grid.dataset.lo), hi = Number(grid.dataset.hi);
  const r = track.getBoundingClientRect();
  const len = drag.seg.b - drag.seg.a;
  const m = Math.min(Math.max(snap(lo + ((ev.clientX - drag.dx - r.left) / r.width) * (hi - lo)), lo), Math.max(lo, hi - len));
  return { track, min: m, day: grid.dataset.day, staff: track.dataset.staff || null, post: track.dataset.post || null };
}
function tlMove(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const far = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 6;
  if (!drag.on) {
    if (drag.touch) return void (far && tlCancel());
    if (!far) return;
    tlBegin();
  }
  ev.preventDefault();
  const t = tlTarget(ev);
  if (!t) return;
  drag.target = t;
  if (drag.ghost.parentNode !== t.track) t.track.append(drag.ghost);
  const grid = t.track.closest(".pl-tl");
  const lo = Number(grid.dataset.lo), hi = Number(grid.dataset.hi);
  drag.ghost.style.left = `${((t.min - lo) / (hi - lo)) * 100}%`;
  drag.ghost.querySelector(".pl-ev-h b").textContent = hm(t.min);
}
function tlStop() {
  window.removeEventListener("pointermove", tlMove);
  window.removeEventListener("pointerup", tlEnd);
  window.removeEventListener("pointercancel", tlCancel);
}
function tlCancel() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.ghost) drag.ghost.remove();
  drag.node.classList.remove("is-dragging");
  drag = null;
  tlStop();
}
function tlEnd(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const d = drag;
  tlCancel();
  if (!d.on || !d.target) return;
  d.h.swallowNext();
  d.h.drop(d.seg, { day: d.target.day, min: d.target.min, staff: d.target.staff, post: d.target.post });
}
// la semaine : une ligne par ressource, une colonne par jour ; la charge de chaque jour (un clic ouvre la journée)
function resourceWeek(h, kind, pool) {
  const { el } = h;
  const days = h.days();
  const all = h.allItems();
  const rows = pool.filter((x) => x.active);
  const table = el(
    "table",
    { class: "pl-mx" },
    el("caption", { class: "sr-only", text: kind === "staff" ? "Charge de l'équipe, jour par jour" : "Occupation des postes, jour par jour" }),
    el("thead", {}, el("tr", {}, el("th", { scope: "col", text: kind === "staff" ? "Mécanicien" : "Poste" }), ...days.map((d) => el("th", { scope: "col", class: d === h.today() ? "is-today" : null, text: cap(dayLabel(d, { short: true })) })), el("th", { scope: "col", text: "Semaine" }))),
  );
  const body = el("tbody");
  for (const x of rows) {
    let P = 0, A = 0;
    const cells = days.map((d) => {
      const l = kind === "staff" ? h.staffLoad(x, d) : h.postLoad(x, d);
      P += l.planned;
      A += l.avail;
      const n = all.filter((it) => it.day === d && it.plan.some((r) => r.id === x.id)).length;
      const away = h.awayOn(x.id, d).length > 0;
      const p = l.avail ? pct(l.planned, l.avail) : null;
      const text = p !== null ? `${p} %` : away ? (kind === "staff" ? "Absent" : "Indispo.") : "—";
      const label = `${x.name}, ${dayLabel(d)} : ${p !== null ? `${hrs(l.planned)} sur ${hrs(l.avail)} (${p} %)` : away ? (kind === "staff" ? "absent" : "indisponible") : "pas d'heures ce jour"}${n ? `, ${plural(n, "intervention")}` : ""}. Ouvrir la journée.`;
      return el(
        "td",
        { class: d === h.today() ? "is-today" : null },
        el("button", { type: "button", class: `pl-mx-cell${p === null ? " is-none" : p > 100 ? " is-over" : p >= 85 ? " is-high" : ""}${away ? " is-away" : ""}`, "aria-label": label, onclick: () => h.goDay(d) },
          el("b", { text }),
          p !== null ? css(el("span", { class: "pl-meter" }, css(el("i"), { width: `${Math.min(100, p)}%` })), {}) : null,
          n ? el("small", { text: plural(n, "intervention") }) : null),
      );
    });
    body.append(el("tr", {}, el("th", { scope: "row", text: x.name }), ...cells, el("td", { class: "pl-mx-sum", text: A ? `${hrs(P)} / ${hrs(A)} · ${pct(P, A)} %` : "—" })));
  }
  table.append(body);
  return el("div", { class: "pl-scroll pl-mx-wrap", tabindex: "0", role: "region", "aria-label": kind === "staff" ? "Charge de l'équipe sur la semaine" : "Occupation des postes sur la semaine" }, table);
}

// ================================================================= suivi des interventions : une colonne par état
const STAGES = [
  ["planned", "À venir", (w) => w === "planned"],
  ["received", "Arrivés", (w) => w === "received"],
  ["in_progress", "En cours", (w) => w === "in_progress"],
  ["wait", "En attente", (w) => w === "waiting_parts" || w === "suspended"],
  ["done", "Prêts", (w) => w === "done"],
  ["returned", "Restitués", (w) => w === "returned"],
];
// ce qui est en retard : pas arrivé 15 minutes après l'heure de dépôt ; travaux qui dépassent leur fin prévue ; travaux d'un jour passé
// encore ouverts (attente de pièces comprise, signalée à part)
export function lateness(h, it) {
  const today = h.today();
  if (it.type === "hold" || it.state !== "confirmed" || it.noShow) return null;
  const w = it.work || "planned";
  if (it.day < today) return WORK_LIVE.includes(w) ? { text: `Depuis ${dayLabel(it.day, { short: true })}`, late: w !== "waiting_parts" } : null;
  if (it.day > today) return null;
  const now = nowMin();
  if (w === "planned" && now > it.start + 15) return { text: `Pas arrivé · ${hrs(now - it.start)}`, late: true };
  const end = h.dueOf(it);
  if ((w === "received" || w === "in_progress") && end && now > end) return { text: `En retard · ${hrs(now - end)}`, late: true };
  return null;
}
export function trackView(h) {
  const { el } = h;
  const day = h.anchor();
  const today = h.today();
  // la journée choisie, plus les travaux restés ouverts des jours précédents (voiture encore à l'atelier)
  const list = h.items().filter((it) => it.type !== "hold" && it.state === "confirmed" && !it.noShow && (it.day === day || (day === today && it.day < day && WORK_LIVE.includes(it.work || "planned"))));
  const mode = h.trackFilter();
  const shown = list.filter((it) => (mode === "late" ? lateness(h, it) && lateness(h, it).late : mode === "todo" ? ["planned", "received", "waiting_parts", "suspended", "done"].includes(it.work || "planned") : true));
  const cols = STAGES.map(([key, title, test]) => {
    const xs = shown.filter((it) => test(it.work || "planned")).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
    return el(
      "section",
      { class: `pl-kb-col is-${key}`, "aria-labelledby": `planKb-${key}` },
      el("h3", { class: "pl-kb-h", id: `planKb-${key}` }, el("span", { text: title }), el("b", { text: String(xs.length) })),
      xs.length ? el("ul", { class: "pl-kb-list" }, ...xs.map((it) => kbCard(h, it))) : el("p", { class: "pl-kb-empty", text: "—" }),
    );
  });
  return el("div", { class: "pl-kb", role: "region", "aria-label": `Suivi des interventions, ${dayLabel(day)}` }, ...cols);
}
function kbCard(h, it) {
  const { el, icon } = h;
  const s = h.status(it);
  const late = lateness(h, it);
  const [chanLabel, chanIcon] = h.chan(it);
  const [a, b] = h.workSpan(it);
  const est = h.labourOf(it);
  const back = h.backOf(it);
  const people = h.peopleOf(it);
  const acts = h.workable(it) ? workActions(it.work).filter((x) => !x.back && (x.to !== "no_show" || nowMin() >= it.start || it.day < h.today())) : [];
  return el(
    "li",
    { class: `pl-kb-card tone-${s.tone}${late && late.late ? " is-late" : ""}${h.shown() === it.id ? " is-open" : ""}` },
    el(
      "button",
      { type: "button", class: "pl-kb-main", "data-id": it.id, onclick: () => h.openSheet(it), "aria-label": [h.carText(it) || it.title, h.what(it), it.title, s.label, late ? late.text : "", "Ouvrir la fiche"].filter(Boolean).join(", ") },
      el("span", { class: "pl-kb-top" }, el("b", { text: h.carText(it) || it.title }), el("span", { title: chanLabel }, icon(chanIcon))),
      el("span", { class: "pl-kb-what", text: h.what(it) }),
      el("span", { class: "pl-kb-who", text: [h.carText(it) ? it.title : "", ...people].filter(Boolean).join(" · ") }),
      el(
        "dl",
        { class: "pl-kb-facts" },
        el("div", {}, el("dt", { text: "Prévu" }), el("dd", { text: `${it.day !== h.today() ? cap(dayLabel(it.day, { short: true })) + " " : ""}${range(a, b)}` })),
        est ? el("div", {}, el("dt", { text: "Estimé" }), el("dd", { text: hrs(est) })) : null,
        back ? el("div", {}, el("dt", { text: "Restitution" }), el("dd", { text: timeLabel(back) })) : null,
      ),
      late ? el("span", { class: `pl-kb-late${late.late ? "" : " is-info"}` }, icon(late.late ? "i-alert" : "i-clock"), late.text) : null,
    ),
    acts.length ? el("div", { class: "pl-kb-acts" }, ...acts.slice(0, 2).map((x) => el("button", { type: "button", class: x.to === "done" ? "btn primary small" : "btn small", "data-work": x.to, onclick: (ev) => h.setWork(it, x.to, ev.currentTarget, { quick: true }) }, x.label))) : null,
  );
}

// ================================================================= charge et capacité (jour ou semaine)
export function loadView(h) {
  const { el, icon } = h;
  const days = h.view() === "day" ? [h.anchor()] : h.days();
  const all = h.allItems();
  const staff = h.data().staff.filter((m) => m.active);
  const posts = h.data().resources.filter((x) => x.active);
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
  const per = (x, f) => days.reduce((acc, d) => {
    const l = f(x, d);
    acc.planned += l.planned;
    acc.avail += l.avail;
    acc.away = acc.away || l.absent || l.down;
    return acc;
  }, { planned: 0, avail: 0, away: false });
  const sl = staff.map((m) => ({ x: m, ...per(m, h.staffLoad) }));
  const pl = posts.map((x) => ({ x, ...per(x, h.postLoad) }));
  const cap0 = sum(sl, (r) => r.avail), plan0 = sum(sl, (r) => r.planned);
  const set = new Set(days);
  const loose = all.filter((it) => set.has(it.day) && it.type !== "hold" && !it.noShow && it.state === "confirmed" && !it.plan.some((r) => r.target === "staff"));
  const conflicts = all.filter((it) => set.has(it.day) && it.conflict);
  const card = (title, value, sub, tone = "") => el("li", { class: `pl-ld-card${tone ? " is-" + tone : ""}` }, el("span", { class: "pl-ld-l", text: title }), el("b", { class: "pl-ld-v", text: value }), el("small", { text: sub }));
  const p0 = pct(plan0, cap0);
  const tableOf = (rows, kind) =>
    el(
      "table",
      { class: "pl-ld-table" },
      el("caption", { text: kind === "staff" ? "Mécaniciens · heures de travail" : "Postes et équipements · occupation" }),
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: kind === "staff" ? "Mécanicien" : "Poste" }), el("th", { scope: "col", text: kind === "staff" ? "Disponible" : "Ouvert" }), el("th", { scope: "col", text: kind === "staff" ? "Planifié" : "Occupé" }), el("th", { scope: "col", text: "Restant" }), el("th", { scope: "col", text: "Charge" }))),
      el(
        "tbody",
        {},
        ...rows.map((r) => {
          const p = r.avail ? pct(r.planned, r.avail) : null;
          const flag = p === null ? (r.away ? (kind === "staff" ? "Absent" : "Indisponible") : "—") : p > 100 ? "Surcharge" : p >= 90 ? "Saturé" : "";
          return el(
            "tr",
            { class: p > 100 ? "is-over" : p >= 90 ? "is-high" : null },
            el("th", { scope: "row", text: r.x.name }),
            el("td", { text: hrs(r.avail) }),
            el("td", { text: hrs(r.planned) }),
            el("td", { text: r.avail ? hrs(Math.max(0, r.avail - r.planned)) : "—" }),
            el("td", {}, el("div", { class: "pl-ld-pct" }, p !== null ? css(el("span", { class: `pl-meter${p > 100 ? " is-over" : p >= 85 ? " is-high" : ""}` }, css(el("i"), { width: `${Math.min(100, p)}%` })), {}) : null, el("span", { text: p !== null ? `${p} %` : "" }), flag ? el("em", { text: flag }) : null)),
          );
        }),
      ),
    );
  const alerts = [];
  for (const r of sl) if (r.avail && r.planned > r.avail) alerts.push(["i-alert", `${r.x.name} : ${hrs(r.planned - r.avail)} de plus que ses heures de travail.`]);
  for (const r of pl) if (r.avail && pct(r.planned, r.avail) >= 90) alerts.push(["i-wrench", `${r.x.name} : occupé à ${pct(r.planned, r.avail)} %.`]);
  if (loose.length) alerts.push(["i-users", `${plural(loose.length, "rendez-vous confirmé", "rendez-vous confirmés")} sans mécanicien.`]);
  if (conflicts.length) alerts.push(["i-flag", `${plural(conflicts.length, "rendez-vous", "rendez-vous")} en conflit de ressource.`]);
  const when = days.length === 1 ? (days[0] === h.today() ? "aujourd'hui" : dayLabel(days[0])) : "sur la semaine";
  return el(
    "div",
    { class: "pl-ld", role: "region", "aria-label": `Charge et capacité ${when}` },
    el(
      "ul",
      { class: "pl-ld-cards" },
      card("Heures de travail", hrs(cap0), `${plural(staff.length, "mécanicien")} ${when}`),
      card("Planifiées", hrs(plan0), "main-d'œuvre affectée"),
      card("Restantes", hrs(Math.max(0, cap0 - plan0)), "à planifier", cap0 - plan0 < 60 ? "high" : ""),
      card("Charge", cap0 ? `${p0} %` : "—", cap0 ? (p0 > 100 ? "au-delà de la capacité" : p0 >= 85 ? "atelier presque plein" : "de la capacité") : "atelier fermé", p0 > 100 ? "over" : p0 >= 85 ? "high" : ""),
    ),
    el("div", { class: "pl-ld-grid" }, staff.length ? tableOf(sl, "staff") : null, posts.length ? tableOf(pl, "post") : null),
    el(
      "section",
      { class: "pl-ld-alerts", "aria-labelledby": "planLdAl" },
      el("h3", { id: "planLdAl", text: "Alertes" }),
      alerts.length ? el("ul", {}, ...alerts.map(([i, t]) => el("li", {}, icon(i), t))) : el("p", { class: "muted", text: "Aucune surcharge ni rendez-vous à affecter." }),
      el("p", { class: "pl-ld-note", text: "Charge des mécaniciens et occupation des postes sont comptées à part : un pont occupé n'est pas un mécanicien occupé. Ce sont des heures planifiées, pas un temps réellement passé." }),
    ),
  );
}

export { LANE_PX };
export const lateNow = (h, it) => lateness(h, it);
export const dayKeys = (from) => Array.from({ length: 7 }, (_, i) => addDays(from, i));
