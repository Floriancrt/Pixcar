// Calendrier avancé (docs/calendrier-avance.md, lot 3a) : horaires calculés à partir des ressources de l'atelier (mécaniciens, compétences,
// postes et équipements, absences, rendez-vous déjà affectés) et de ce que demande chaque prestation. Une seule définition, partagée par
// l'API (dernier mot, dans la transaction de la prise d'horaire) et la page Pro (aperçus, explications). Fonctions pures : l'heure vient
// de l'appelant. Les calculs se font en minutes de la journée (heure murale de Paris), puis sont convertis en instants (parisInstant).
import { parseHours, parsePhone } from "./garage-profile.js";
import { PRO_SERVICES, VEHICLES } from "./pro-prices.js";
import { addDays, earliestStart, isIsoDay, isOpenDay, openRanges, parisInstant, parisParts, timeLabel } from "./rdv.js";

export const NIL_SLOT = "00000000-0000-0000-0000-000000000000"; // slot_id d'une demande prise en mode avancé
export const DROP_WINDOW = 60; // fenêtre d'arrivée d'un dépôt (minutes), comme au lot 2
export const MAX_STAFF = 30;
export const MAX_RESOURCES = 30;
export const MAX_SKILLS = 40;
export const MAX_UNAVAIL = 300;
export const UNAVAIL_MAX_DAYS = 90;
const SERVICE_IDS = PRO_SERVICES.map((s) => s.id);
const SERVICE_BY_ID = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const VEHICLE_IDS = VEHICLES.map((v) => v.id);
const COMBOS_MAX = 120;
const STEP_ORDER = ["diag", "lift", "quick", "tyre", "other", "clim", "align"]; // équipes essayées pour une étape à plusieurs mécaniciens

export const RESOURCE_TYPES = [
  { id: "lift", label: "Pont élévateur" },
  { id: "quick", label: "Poste de mécanique rapide" },
  { id: "tyre", label: "Zone pneumatiques" },
  { id: "diag", label: "Poste de diagnostic" },
  { id: "align", label: "Banc de géométrie" },
  { id: "clim", label: "Station de climatisation" },
  { id: "other", label: "Autre équipement" },
];
const TYPE_IDS = RESOURCE_TYPES.map((t) => t.id);
export const typeLabel = (id) => (RESOURCE_TYPES.find((t) => t.id === id) || { label: id }).label;
export const UNAVAIL_KINDS = [
  { id: "absence", label: "Absence", for: "staff" },
  { id: "leave", label: "Congés", for: "staff" },
  { id: "training", label: "Formation", for: "staff" },
  { id: "maintenance", label: "Maintenance", for: "resource" },
  { id: "breakdown", label: "Panne", for: "resource" },
  { id: "other", label: "Autre", for: "both" },
];
const kindLabel = (id) => (UNAVAIL_KINDS.find((k) => k.id === id) || { label: "" }).label;
export const PARTS_DELAYS_H = [0, 24, 48, 72, 120, 168];

// Valeurs initiales proposées par l'assistant (le garage les change). Compétences : les exemples du cahier des charges, et deux
// habilitations courantes (à faire vérifier par le garage : leur intitulé exact dépend de ses formations).
export const SKILL_SEEDS = [
  { key: "maint", label: "Entretien courant" },
  { key: "brakes", label: "Freinage" },
  { key: "tyres", label: "Pneumatiques" },
  { key: "timing", label: "Distribution" },
  { key: "diag", label: "Diagnostic électronique" },
  { key: "elec", label: "Électricité automobile" },
  { key: "clim", label: "Climatisation (fluides frigorigènes)", cert: true },
  { key: "ev", label: "Véhicules hybrides et électriques", cert: true },
];
const TYRE_POSTS = ["tyre", "lift"];
const LIFT_POSTS = ["lift", "quick"];
export const SERVICE_DEFAULTS = {
  geo_av: { skill: "tyres", stations: ["align"] },
  geo_4: { skill: "tyres", stations: ["align"] },
  geo_ctrl: { skill: "tyres", stations: ["align"] },
  montage: { skill: "tyres", stations: TYRE_POSTS, shared: 10 },
  equil: { skill: "tyres", stations: TYRE_POSTS, shared: 5 },
  crevaison: { skill: "tyres", stations: TYRE_POSTS, shared: 5 },
  vidange: { skill: "maint", stations: LIFT_POSTS, shared: 10 },
  revision: { skill: "maint", stations: LIFT_POSTS, shared: 10 },
  clim: { skill: "clim", stations: [], tools: ["clim"] },
  diag: { skill: "diag", stations: ["diag"] },
  batterie: { skill: "elec", stations: [] },
  plaq_av: { skill: "brakes", stations: ["lift"], shared: 15 },
  disq_av: { skill: "brakes", stations: ["lift"], shared: 15 },
  liq_frein: { skill: "brakes", stations: ["lift"], shared: 10 },
  amortisseurs: { skill: "maint", stations: ["lift"], shared: 15 },
  distribution: { skill: "timing", stations: ["lift"], shared: 15, parts: true },
  embrayage: { skill: null, stations: ["lift"], shared: 15, parts: true },
};
// Exigences par défaut d'une prestation, à partir du temps moyen de « Mon garage » ; skillIds : { clé de SKILL_SEEDS: id }
export function defaultReq(serviceId, minutes, skillIds = {}) {
  const d = SERVICE_DEFAULTS[serviceId] || { stations: [] };
  const labour = Math.max(5, Math.round((Number.isInteger(minutes) ? minutes : 60) / 5) * 5);
  return {
    online: true,
    labour,
    shared: Math.min(d.shared || 0, labour),
    immob: labour,
    staffN: 1,
    skills: d.skill && skillIds[d.skill] ? [skillIds[d.skill]] : [],
    stations: [...d.stations],
    tools: [...(d.tools || [])],
    margin: 0,
    auto: false,
    parts: !!d.parts,
    partsH: d.parts ? 48 : 0,
    drop: labour >= 120,
    vehicles: {},
  };
}

// ---------------------------------------------------------------- plages de minutes [a, b[
const merge = (list) => {
  const out = [];
  for (const [a, b] of list.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};
const inter = (A, B) => {
  const out = [];
  for (let i = 0, j = 0; i < A.length && j < B.length; ) {
    const a = Math.max(A[i][0], B[j][0]), b = Math.min(A[i][1], B[j][1]);
    if (a < b) out.push([a, b]);
    if (A[i][1] < B[j][1]) i++;
    else j++;
  }
  return out;
};
const minus = (A, B) => {
  let out = A.map((r) => [...r]);
  for (const [c, d] of B) out = out.flatMap(([a, b]) => (d <= a || c >= b ? [[a, b]] : [...(c > a ? [[a, c]] : []), ...(d < b ? [[d, b]] : [])]));
  return out;
};
const total = (R) => R.reduce((t, [a, b]) => t + b - a, 0);
const tl = (m) => timeLabel(m);

// ---------------------------------------------------------------- ce qu'une demande demande à l'atelier
// services : [{ id, qty }] ; reqs : { serviceId: exigences } ; vehicle : id de VEHICLES ou "".
// → { steps, drop, auto, partsH, labour, staffMinutes, needVehicle } ou { error: "not_configured", service }
//  - étape : { services, stations (types possibles, [] : sans poste), tools, skills, staffN, margin, labour, immob }
export function buildJob(services, reqs, vehicle = "") {
  const list = [...services].sort((a, b) => SERVICE_IDS.indexOf(a.id) - SERVICE_IDS.indexOf(b.id));
  const groups = [];
  const loose = [];
  let needVehicle = false;
  for (const s of list) {
    const r = reqs[s.id];
    if (!r) return { error: "not_configured", service: s.id };
    if (Object.keys(r.vehicles || {}).length) needVehicle = true;
    const v = vehicle && r.vehicles && r.vehicles[vehicle];
    const L0 = v ? v.labour : r.labour, I0 = v ? v.immob : r.immob;
    const S = Math.min(r.shared, L0);
    const L = s.qty > 1 ? S + (L0 - S) * s.qty : L0;
    const item = { id: s.id, r, L, S, passive: Math.max(0, I0 - L0) };
    if (!r.stations.length) {
      loose.push(item);
      continue;
    }
    const g = groups.find((x) => x.stations.some((t) => r.stations.includes(t)));
    if (g) {
      g.stations = g.stations.filter((t) => r.stations.includes(t));
      g.items.push(item);
    } else groups.push({ stations: [...r.stations], items: [item] });
  }
  if (loose.length) {
    if (groups.length) groups[0].items.push(...loose);
    else groups.push({ stations: [], items: loose });
  }
  // ordre des étapes : diagnostic d'abord, géométrie en dernier (elle se règle sur une voiture remise en état)
  const rank = (g) => (g.stations.length ? Math.min(...g.stations.map((t) => STEP_ORDER.indexOf(t))) : -1);
  groups.sort((a, b) => rank(a) - rank(b));
  const steps = groups.map((g) => {
    const sumL = g.items.reduce((t, x) => t + x.L, 0), sumS = g.items.reduce((t, x) => t + x.S, 0), maxS = Math.max(...g.items.map((x) => x.S));
    const labour = sumL - sumS + maxS;
    return {
      services: g.items.map((x) => x.id),
      stations: g.stations,
      tools: [...new Set(g.items.flatMap((x) => x.r.tools))],
      skills: [...new Set(g.items.flatMap((x) => x.r.skills))],
      staffN: Math.max(...g.items.map((x) => x.r.staffN)),
      margin: Math.max(...g.items.map((x) => x.r.margin)),
      labour,
      immob: labour + Math.max(...g.items.map((x) => x.passive)),
    };
  });
  const all = list.map((s) => reqs[s.id]);
  return {
    services: list.map((s) => ({ id: s.id, qty: s.qty })),
    steps,
    drop: all.some((r) => r.drop),
    auto: all.every((r) => r.auto) && !all.some((r) => r.parts),
    partsH: Math.max(0, ...all.map((r) => (r.parts ? r.partsH : 0))),
    labour: steps.reduce((t, s) => t + s.labour, 0),
    staffMinutes: steps.reduce((t, s) => t + s.labour * s.staffN, 0),
    needVehicle,
  };
}

// ---------------------------------------------------------------- l'atelier un jour donné
// world : { nowMs, ctx: { hours, closures, holidays }, settings: { minDelayH, horizonDays, stepMin },
//           cal: { receptionMin, returnMin, loadPct, maxDay }, staff: [{ id, name, active, hours, services, skills: [{ id, until }] }],
//           resources: [{ id, name, type, active, hours, services }], skills: [{ id, label, cert }], reqs: { serviceId: … },
//           unavail: [{ id, target, targetId, start, end, kind, label }], busy: [{ requestId, blockId, target, targetId, role, start, end }] }
// (instants en ms ; busy : affectations qui retiennent encore leur ressource). makeWorld prépare les recherches.
export function makeWorld(w) {
  const at = (ms) => parisParts(ms);
  return {
    ...w,
    staff: [...w.staff],
    resources: [...w.resources],
    unavail: (w.unavail || []).map((u) => ({ ...u, ps: at(u.start), pe: at(u.end) })),
    busy: (w.busy || []).map((x) => ({ ...x, ps: at(x.start), pe: at(x.end) })),
    names: new Map([...w.staff, ...w.resources].map((x) => [x.id, x.name])),
    days: new Map(),
  };
}
// [a, b] en minutes de la journée iso pour l'intervalle [ps, pe] (heures de Paris), ou null
function clip(iso, ps, pe) {
  if (ps.iso > iso || pe.iso < iso) return null;
  const a = ps.iso < iso ? 0 : ps.min, b = pe.iso > iso ? 1440 : pe.min;
  return b > a ? [a, b] : null;
}
function dayOf(w, iso) {
  if (w.days.has(iso)) return w.days.get(iso);
  const open = isOpenDay(iso, w.ctx) ? merge(openRanges(iso, w.ctx.hours)) : [];
  const work = new Map();
  for (const x of [...w.staff, ...w.resources]) work.set(x.id, x.active && open.length ? inter(open, x.hours ? merge(openRanges(iso, x.hours)) : open) : []);
  const blocks = new Map();
  const add = (id, k) => (blocks.has(id) ? blocks.get(id).push(k) : blocks.set(id, [k]));
  for (const u of w.unavail) {
    const s = clip(iso, u.ps, u.pe);
    if (s) add(u.targetId, { a: s[0], b: s[1], unavail: u });
  }
  const requests = new Set();
  let staffBusy = 0;
  for (const x of w.busy) {
    const s = clip(iso, x.ps, x.pe);
    if (!s) continue;
    add(x.targetId, { a: s[0], b: s[1], busy: x });
    if (x.requestId) requests.add(x.requestId);
    if (x.target === "staff") staffBusy += s[1] - s[0];
  }
  // capacité : minutes de travail des mécaniciens actifs, absences retirées
  let capacity = 0;
  for (const m of w.staff) capacity += total(minus(work.get(m.id), (blocks.get(m.id) || []).filter((k) => k.unavail).map((k) => [k.a, k.b])));
  const day = { iso, open, close: open.length ? open[open.length - 1][1] : 0, work, blocks, requests, staffBusy, capacity };
  w.days.set(iso, day);
  return day;
}
// ajoute un plan aux occupations (affectation des rendez-vous existants, l'un après l'autre)
export function addPlan(w, requestId, plan) {
  for (const a of assignmentsOf(plan)) {
    const start = parisInstant(plan.day, a.a), end = parisInstant(plan.day, a.b);
    w.busy.push({ requestId, target: a.target, targetId: a.targetId, role: a.role, start, end, ps: parisParts(start), pe: parisParts(end) });
  }
  w.days.delete(plan.day);
}

// ---------------------------------------------------------------- une étape à une heure donnée
const staffCan = (m, step, iso) =>
  m.active &&
  (!m.services || step.services.every((id) => m.services.includes(id))) &&
  step.skills.every((k) => m.skills.some((s) => s.id === k && (!s.until || s.until >= iso)));
const resCan = (r, types, services) => r.active && types.includes(r.type) && (!r.services || services.every((id) => r.services.includes(id)));

// Main-d'œuvre de need minutes à partir de s pile, sur les plages work (interrompue par leurs coupures) : segments, ou null
function walk(work, s, need) {
  const segs = [];
  let left = need;
  for (const [a, b] of work) {
    if (b <= s) continue;
    const from = Math.max(a, s);
    if (!segs.length && from !== s) return null;
    const take = Math.min(left, b - from);
    segs.push([from, from + take]);
    left -= take;
    if (!left) return segs;
  }
  return null;
}
// premier empêchement de la ressource id pendant ces plages
function clash(day, id, spans) {
  for (const k of day.blocks.get(id) || []) for (const [a, b] of spans) if (k.a < b && a < k.b) return k;
  return null;
}
const why = (k, w) => {
  const name = w.names.get(k.unavail ? k.unavail.targetId : k.busy.targetId) || "";
  return k.unavail ? { code: "down", name, kind: k.unavail.kind, label: k.unavail.label } : { code: "busy", name, a: k.a, b: k.b };
};
function* combos(list, n, from = 0, cur = []) {
  if (cur.length === n) {
    yield cur;
    return;
  }
  for (let i = from; i < list.length; i++) yield* combos(list, n, i + 1, [...cur, list[i]]);
}

// L'étape commence pile à s. → { start, segs, end, ready, margin, staff: [ids], station, tools: [ids] } ou null (raisons dans out)
function stepAt(w, day, step, s, { prev = [], forced = null, out }) {
  const iso = day.iso;
  let stations = [null];
  if (step.stations.length) {
    const fs = forced && forced.station ? w.resources.find((r) => r.id === forced.station) : null;
    const only = fs && step.stations.includes(fs.type) ? fs.id : null; // poste choisi par le garage, pour l'étape qui en demande ce type
    stations = w.resources.filter((r) => resCan(r, step.stations, step.services) && (!only || r.id === only));
    if (!stations.length) return void out.push({ code: only ? "forced_station" : "no_station", types: step.stations });
  }
  let mechs = w.staff.filter((m) => staffCan(m, step, iso));
  if (forced && forced.staff && forced.staff.length) {
    const bad = forced.staff.find((id) => !mechs.some((m) => m.id === id));
    if (bad) return void out.push({ code: "forced_staff", name: w.names.get(bad) || "" });
    mechs = forced.staff.map((id) => mechs.find((m) => m.id === id));
  }
  if (mechs.length < step.staffN) return void out.push({ code: "no_staff", services: step.services, n: step.staffN });
  mechs = [...mechs.filter((m) => prev.includes(m.id)), ...mechs.filter((m) => !prev.includes(m.id))]; // même équipe d'une étape à l'autre
  if (forced && forced.staff && forced.staff.length) mechs = mechs.slice(0, Math.max(step.staffN, forced.staff.length));
  for (const st of stations) {
    const base = st ? day.work.get(st.id) : day.open;
    if (!base.some(([a, b]) => s >= a && s < b)) {
      out.push(st ? { code: "station_off", name: st.name } : { code: "closed" });
      continue;
    }
    let tried = 0;
    for (const team of combos(mechs, step.staffN)) {
      if (++tried > COMBOS_MAX) break;
      const work = team.reduce((acc, m) => inter(acc, day.work.get(m.id)), base);
      const segs = walk(work, s, step.labour);
      if (!segs) {
        out.push(work.some(([a, b]) => s >= a && s < b) ? { code: "day_end" } : { code: "staff_off" });
        continue;
      }
      const end = segs[segs.length - 1][1];
      const ready = end + (step.immob - step.labour);
      if (ready > day.close) {
        out.push({ code: "day_end" });
        continue;
      }
      const spans = step.margin ? [...segs, [end, end + step.margin]] : segs;
      let k = null;
      for (const m of team) if ((k = clash(day, m.id, spans))) break;
      if (k) {
        out.push(why(k, w));
        continue;
      }
      if (st && (k = clash(day, st.id, [[s, ready + step.margin]]))) {
        out.push(why(k, w));
        continue;
      }
      const tools = [];
      let missing = null;
      for (const type of step.tools) {
        const cands = w.resources.filter((r) => resCan(r, [type], step.services) && !tools.includes(r.id));
        const ok = cands.find((r) => total(inter(day.work.get(r.id), segs)) === step.labour && !clash(day, r.id, spans));
        if (!ok) {
          const busy = cands.map((r) => clash(day, r.id, spans)).find(Boolean);
          missing = busy ? why(busy, w) : { code: "no_tool", types: [type] };
          break;
        }
        tools.push(ok.id);
      }
      if (missing) {
        out.push(missing);
        continue;
      }
      return { start: s, segs, end, ready, margin: step.margin, staff: team.map((m) => m.id), station: st ? st.id : null, tools };
    }
  }
  return null;
}
// L'étape commence à s, ou (float) au premier moment après s où tout est libre (début de plage, fin d'un empêchement)
function planStep(w, day, step, s, opts) {
  if (!opts.float) return stepAt(w, day, step, s, opts);
  const points = new Set([s]);
  for (const [a] of day.open) if (a > s) points.add(a);
  for (const list of day.blocks.values()) for (const k of list) if (k.b > s) points.add(k.b);
  for (const [, ranges] of day.work) for (const [a] of ranges) if (a > s) points.add(a);
  for (const t of [...points].sort((a, b) => a - b)) {
    if (t >= day.close) break;
    const sp = stepAt(w, day, step, t, opts);
    if (sp) return sp;
  }
  return null;
}

// ---------------------------------------------------------------- un rendez-vous complet
// Plan d'un rendez-vous déposé à arrival (minutes) le jour iso. mode : « hour » (travaux à arrival + accueil, pile) ou « drop » (arrivée
// au début d'une plage d'ouverture, travaux après la fenêtre d'arrivée). forced : { staff: [ids], station } (choix du garage) ; float :
// premier moment libre même à l'heure (rendez-vous déjà pris, à affecter).
// → { day, mode, arrival, until?, workStart, workEnd, ready, back, steps, labour } ou { fail: [raisons] }
export function planAt(w, job, iso, arrival, { mode, forced = null, float = false } = {}) {
  const m = mode || (job.drop ? "drop" : "hour");
  const day = dayOf(w, iso);
  const out = [];
  const range = day.open.find(([a, b]) => arrival >= a && arrival < b);
  if (!range) return { fail: reasons([{ code: "closed" }], w) };
  let s0, until;
  if (m === "drop") {
    if (arrival !== range[0] && !float) return { fail: reasons([{ code: "window" }], w) };
    until = Math.min(arrival + DROP_WINDOW, range[1]);
    s0 = until;
  } else s0 = arrival + w.cal.receptionMin;
  const steps = [];
  let t = s0, prev = [];
  for (let i = 0; i < job.steps.length; i++) {
    const sp = planStep(w, day, job.steps[i], t, { float: float || m === "drop" || i > 0, prev, forced, out });
    if (!sp) return { fail: reasons(out, w) };
    steps.push(sp);
    prev = sp.staff;
    t = sp.ready;
  }
  const ready = steps[steps.length - 1].ready;
  // restitution : véhicule prêt + marge, pendant une plage d'ouverture (sinon à la réouverture ; au plus tard à la fermeture)
  const target = Math.ceil((ready + w.cal.returnMin) / 5) * 5;
  const next = day.open.find(([a, b]) => target <= b);
  const back = !next ? day.close : target >= next[0] ? target : next[0];
  return { day: iso, mode: m, arrival, ...(m === "drop" ? { until } : {}), workStart: steps[0].start, workEnd: Math.max(...steps.map((s) => s.end)), ready, back, steps, labour: job.labour };
}
// Lignes d'affectation d'un plan (minutes de sa journée) : mécaniciens par segment de main-d'œuvre (marge comprise), poste pendant
// l'immobilisation (marge comprise), équipements comme les mécaniciens.
export function assignmentsOf(plan) {
  const out = [];
  for (const st of plan.steps) {
    const spans = merge(st.margin ? [...st.segs, [st.end, st.end + st.margin]] : st.segs.map((x) => [...x]));
    for (const id of st.staff) for (const [a, b] of spans) out.push({ target: "staff", targetId: id, role: "labour", a, b });
    if (st.station) out.push({ target: "resource", targetId: st.station, role: "station", a: st.start, b: st.ready + st.margin });
    for (const id of st.tools) for (const [a, b] of spans) out.push({ target: "resource", targetId: id, role: "tool", a, b });
  }
  return out;
}

// ---------------------------------------------------------------- horaires proposés
// Limites de la réservation en ligne pour ce jour : rendez-vous par jour, part de la capacité des mécaniciens
function roomOnline(w, day, job) {
  if (w.cal.maxDay && day.requests.size >= w.cal.maxDay) return { code: "max_day" };
  if (w.cal.loadPct < 100 && day.staffBusy + job.staffMinutes > (day.capacity * w.cal.loadPct) / 100) return { code: "load" };
  return null;
}
const earliestFor = (w, job, online) => {
  if (!online) return w.nowMs;
  const e = earliestStart(w.nowMs, w.ctx, w.settings.minDelayH);
  return job.partsH ? Math.max(e, w.nowMs + job.partsH * 3600e3) : e;
};
// Horaires d'un jour : [{ start, end (restitution), mode, until?, plan }]
function offersOn(w, job, iso, { online, earliest }) {
  const day = dayOf(w, iso);
  if (!day.open.length || (online && roomOnline(w, day, job))) return [];
  const out = [];
  const drop = job.drop;
  for (const [a, b] of day.open) {
    for (let t = a; t < b; t += drop ? b - a : w.settings.stepMin) {
      if (parisInstant(iso, t) < earliest) continue;
      const p = planAt(w, job, iso, t, { mode: drop ? "drop" : "hour" });
      if (!p.fail) out.push({ start: t, end: p.back, mode: p.mode, ...(drop ? { until: p.until } : {}), plan: p });
    }
  }
  return out;
}
// Comme freeTimes (src/js/shared/rdv.js) : [{ day, times }] jour par jour (jours sans horaire omis). online : règles de la réservation
// en ligne (délai minimum, heure limite, pièces, charge) ; sans, celles d'un déplacement par le garage (seulement : pas dans le passé).
export function planTimes(w, job, { maxDays = Infinity, first = false, online = true, from = null } = {}) {
  const earliest = earliestFor(w, job, online);
  const today = parisParts(w.nowMs).iso;
  const out = [];
  const days = Math.min(w.settings.horizonDays, maxDays);
  for (let i = 0; i < days; i++) {
    const iso = addDays(today, i);
    if (from && iso < from) continue;
    const times = offersOn(w, job, iso, { online, earliest });
    if (!times.length) continue;
    out.push({ day: iso, times });
    if (first) break;
  }
  return out;
}
// L'horaire choisi est-il encore possible ? → l'offre (avec son plan) ou null
export function pickPlan(w, job, { day, start, mode }, { online = true } = {}) {
  if (!isIsoDay(day) || (mode && mode !== (job.drop ? "drop" : "hour"))) return null;
  const today = parisParts(w.nowMs).iso;
  if (day < today || day >= addDays(today, w.settings.horizonDays)) return null;
  return offersOn(w, job, day, { online, earliest: earliestFor(w, job, online) }).find((o) => o.start === start) || null;
}
// Pourquoi cet horaire n'est pas possible (déplacement par le garage), et les plus proches qui le sont
// float : la même heure de dépôt, les travaux au premier moment libre (réaffectation sans changer l'heure)
export function explain(w, job, { day, start, mode, forced = null, float = false }) {
  if (!isIsoDay(day)) return { reasons: reasons([{ code: "closed" }], w), alternatives: [] };
  const atMs = parisInstant(day, start);
  const p = atMs <= w.nowMs ? { fail: reasons([{ code: "past" }], w) } : planAt(w, job, day, start, { mode, forced, float });
  if (!p.fail) return { plan: p, reasons: [], alternatives: [] };
  return { reasons: p.fail, alternatives: nearest(w, job, { day, start, mode, forced }) };
}
function nearest(w, job, { day, start, mode, forced, count = 3 }) {
  const out = [];
  const today = parisParts(w.nowMs).iso;
  const m = mode || (job.drop ? "drop" : "hour");
  for (let i = 0; i < w.settings.horizonDays && out.length < count; i++) {
    const iso = addDays(day > today ? day : today, i);
    const d = dayOf(w, iso);
    for (const [a, b] of d.open) {
      for (let t = a; t < b && out.length < count; t += m === "drop" ? b - a : w.settings.stepMin) {
        if ((iso === day && t <= start) || parisInstant(iso, t) <= w.nowMs) continue;
        const p = planAt(w, job, iso, t, { mode: m, forced });
        if (!p.fail) out.push({ day: iso, start: t, end: p.back });
      }
    }
  }
  return out;
}

// Affecte les rendez-vous déjà pris (activation du mode avancé), dans l'ordre : items [{ requestId, day, start, mode, job, backBy?, forced? }]
// (backBy : restitution promise, en minutes). Chaque plan trouvé occupe ses ressources pour les suivants. → { placed, failed }
export function placeExisting(w, items) {
  const placed = [], failed = [];
  for (const it of items) {
    if (it.job.error) {
      failed.push({ requestId: it.requestId, reasons: reasons([{ code: "not_configured", services: [it.job.service] }], w) });
      continue;
    }
    const p = planAt(w, it.job, it.day, it.start, { mode: it.mode, forced: it.forced || null, float: true });
    if (p.fail || (it.backBy && p.ready > it.backBy)) {
      failed.push({ requestId: it.requestId, reasons: p.fail || reasons([{ code: "late", b: it.backBy }], w) });
      continue;
    }
    addPlan(w, it.requestId, p);
    placed.push({ requestId: it.requestId, plan: p });
  }
  return { placed, failed };
}

// Affectations déjà écrites qui ne tiennent plus avec la configuration actuelle (absence, maintenance, fiche désactivée ou supprimée,
// heures changées). Rien n'est déplacé : le garage décide. rows : [{ requestId, target, targetId, start, end }] → [{ requestId, text }]
export function staleAssignments(w, rows) {
  const out = [];
  const seen = new Set();
  const push = (requestId, text) => {
    if (seen.has(requestId + text)) return;
    seen.add(requestId + text);
    out.push({ requestId, text });
  };
  for (const a of rows) {
    const x = (a.target === "staff" ? w.staff : w.resources).find((e) => e.id === a.targetId);
    if (!x) {
      push(a.requestId, a.target === "staff" ? "Mécanicien supprimé." : "Poste ou équipement supprimé.");
      continue;
    }
    if (!x.active) {
      push(a.requestId, `${x.name} : fiche désactivée.`);
      continue;
    }
    const ps = parisParts(a.start), pe = parisParts(a.end);
    const day = dayOf(w, ps.iso);
    const span = clip(ps.iso, ps, pe);
    if (!span) continue;
    const k = (day.blocks.get(x.id) || []).find((b) => b.unavail && b.a < span[1] && span[0] < b.b);
    if (k) push(a.requestId, TEXT.down(why(k, w)));
    else if (a.role !== "station" && !day.work.get(x.id).some(([s, e]) => span[0] >= s && span[0] < e)) push(a.requestId, `${x.name} : ne travaille plus à cette heure-là.`);
  }
  return out;
}

// ---------------------------------------------------------------- raisons, en clair
const svcList = (ids) => (ids || []).map((id) => (SERVICE_BY_ID.get(id) || { label: id }).label).join(", ");
const types = (ids) => (ids || []).map(typeLabel).join(" ou ");
const TEXT = {
  past: () => "Cet horaire est passé.",
  closed: () => "Le garage est fermé à cette heure-là.",
  window: () => "Le dépôt se fait au début d'une plage d'ouverture.",
  not_configured: (r) => `${svcList(r.services)} : exigences à compléter (Calendrier › Prestations).`,
  no_staff: (r) => `Aucun mécanicien actif ne peut faire ${svcList(r.services)}${r.n > 1 ? ` à ${r.n}` : ""} (compétences, habilitations ou prestations autorisées).`,
  forced_staff: (r) => `${r.name} ne peut pas faire cette intervention (compétences, habilitations ou prestations autorisées).`,
  no_station: (r) => `Aucun poste compatible disponible (${types(r.types)}).`,
  forced_station: () => "Ce poste ne convient pas à cette intervention.",
  station_off: (r) => `${r.name} : hors de ses heures d'utilisation.`,
  no_tool: (r) => `Équipement manquant : ${types(r.types)}.`,
  staff_off: () => "Aucun mécanicien qualifié ne travaille à cette heure-là.",
  day_end: () => "L'intervention ne se termine pas avant la fermeture.",
  late: (r) => `L'intervention ne serait pas prête pour la restitution promise (${tl(r.b)}).`,
  busy: (r) => `${r.name} : déjà occupé de ${tl(r.a)} à ${tl(r.b)}.`,
  down: (r) => `${r.name} : indisponible (${(r.label || kindLabel(r.kind)).toLowerCase()}).`,
  delay: () => "Trop tôt : délai minimum avant un rendez-vous.",
  load: () => "Charge maximale en ligne atteinte ce jour-là.",
  max_day: () => "Nombre maximal de rendez-vous en ligne atteint ce jour-là.",
};
const ORDER = ["past", "closed", "window", "not_configured", "no_staff", "forced_staff", "no_station", "forced_station", "no_tool", "down", "busy", "station_off", "staff_off", "day_end", "late", "delay", "load", "max_day"];
// Les raisons trouvées, les plus parlantes d'abord, sans doublon (3 au plus) : [{ code, text }]
function reasons(list, w) {
  const seen = new Set();
  return list
    .map((r) => ({ code: r.code, text: TEXT[r.code](r, w) }))
    .filter((r) => !seen.has(r.text) && seen.add(r.text))
    .sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code))
    .slice(0, 3);
}

// ---------------------------------------------------------------- contrôles avant activation
// → { ok (activation possible), ready: [ids des prestations proposées en ligne], problems: [{ service?, text, blocking }] }
export function readiness(w, offered) {
  const problems = [];
  const active = w.staff.filter((m) => m.active);
  if (!active.length) problems.push({ text: "Ajoutez au moins un mécanicien actif.", blocking: true });
  const ready = [];
  for (const id of offered) {
    const r = w.reqs[id];
    if (!r) {
      problems.push({ service: id, text: `${svcList([id])} : exigences à compléter.`, blocking: false });
      continue;
    }
    if (!r.online) continue;
    const job = buildJob([{ id, qty: 1 }], w.reqs);
    const step = job.steps[0];
    const label = svcList([id]);
    if (active.filter((m) => !m.services || m.services.includes(id)).filter((m) => step.skills.every((k) => m.skills.some((s) => s.id === k))).length < step.staffN)
      problems.push({ service: id, text: `${label} : aucun mécanicien actif n'a les compétences demandées${step.staffN > 1 ? ` (il en faut ${step.staffN})` : ""}.`, blocking: false });
    else if (step.stations.length && !w.resources.some((x) => resCan(x, step.stations, [id])))
      problems.push({ service: id, text: `${label} : aucun poste compatible (${types(step.stations)}).`, blocking: false });
    else if (step.tools.some((t) => !w.resources.some((x) => resCan(x, [t], [id]))))
      problems.push({ service: id, text: `${label} : équipement manquant (${types(step.tools.filter((t) => !w.resources.some((x) => resCan(x, [t], [id]))))}).`, blocking: false });
    else ready.push(id);
  }
  if (active.length && !ready.length) problems.push({ text: "Aucune prestation ne peut encore être proposée en ligne.", blocking: true });
  return { ok: !problems.some((p) => p.blocking), ready, problems };
}

// ---------------------------------------------------------------- ce que règle le garage
const clean = (v) => String(v ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const chars = (s) => [...s].length;
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const step5 = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi && v % 5 === 0;
const bool = (v, name) => (typeof v === "boolean" ? null : `${name} : oui ou non.`);
// liste d'identifiants du catalogue, sans doublon, dans l'ordre du catalogue ; null si invalide
const pick = (list, all) => (Array.isArray(list) && list.every((x) => all.includes(x)) ? all.filter((x) => list.includes(x)) : null);

// Réglages du calendrier (champs présents seulement) → { value } ou { error }
export function parseCalendar(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu." };
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "receptionMin" || k === "returnMin") {
      if (!step5(v, 0, 60)) return { error: `${k === "receptionMin" ? "Accueil du véhicule" : "Marge de restitution"} : de 0 à 60 min, par 5 min.` };
    } else if (k === "loadPct") {
      if (!step5(v, 50, 100)) return { error: "Part de la capacité ouverte en ligne : de 50 à 100 %, par 5 %." };
    } else if (k === "maxDay") {
      if (!Number.isInteger(v) || v < 0 || v > 50) return { error: "Rendez-vous en ligne par jour : de 0 (sans limite) à 50." };
    } else if (k === "step") {
      if (!Number.isInteger(v) || v < 0 || v > 6) return { error: "Étape : de 0 à 6." };
    } else if (k === "autoAssign") {
      if (typeof v !== "boolean") return { error: "Affectation automatique : oui ou non." };
    } else return { error: `Réglage inconnu : ${String(k).slice(0, 20)}.` };
    out[k] = v;
  }
  if (!Object.keys(out).length) return { error: "Rien à enregistrer." };
  return { value: out };
}

// Prestations : null (toutes) ou une liste non vide du catalogue
function parseServiceList(v, what) {
  if (v === null || v === undefined) return { value: null };
  const list = pick(v, SERVICE_IDS);
  if (!list) return { error: `${what} : prestations inconnues.` };
  if (!list.length) return { error: `${what} : au moins une prestation, ou « toutes ».` };
  return { value: list.length === SERVICE_IDS.length ? null : list };
}
// Semaine type propre : null (celle du garage) ou des horaires valides avec au moins un jour
function parseOwnHours(v) {
  if (v === null || v === undefined) return { value: null };
  const h = parseHours(v);
  if (h.error) return h;
  if (!h.value || !Object.keys(h.value).length) return { error: "Horaires : au moins un jour, ou « comme le garage »." };
  return { value: h.value };
}

// Un mécanicien → { value: { name, active, hours, services, skills: [{ id, until }] } } ou { error, field } ; skillIds : Set du garage
export function parseStaff(b, { skillIds }) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "staff" };
  const name = clean(b.name);
  if (chars(name) < 2 || chars(name) > 60 || !/\p{L}/u.test(name)) return { error: "Nom : de 2 à 60 caractères (le prénom suffit).", field: "name" };
  const active = b.active === undefined ? true : b.active;
  if (bool(active, "Actif")) return { error: bool(active, "Actif"), field: "active" };
  const hours = parseOwnHours(b.hours);
  if (hours.error) return { error: hours.error, field: "hours" };
  const services = parseServiceList(b.services, "Prestations autorisées");
  if (services.error) return { error: services.error, field: "services" };
  const raw = b.skills === undefined ? [] : b.skills;
  if (!Array.isArray(raw) || raw.length > MAX_SKILLS) return { error: "Compétences : une liste.", field: "skills" };
  const skills = [];
  for (const s of raw) {
    const id = s && typeof s === "object" ? s.id : s;
    if (!isUuid(id) || !skillIds.has(id.toLowerCase())) return { error: "Compétence inconnue.", field: "skills" };
    const until = s && typeof s === "object" && s.until ? s.until : null;
    if (until !== null && !isIsoDay(until)) return { error: "Fin de validité : AAAA-MM-JJ.", field: "skills" };
    if (!skills.some((x) => x.id === id.toLowerCase())) skills.push({ id: id.toLowerCase(), until });
  }
  return { value: { name, active, hours: hours.value, services: services.value, skills } };
}

export function parseSkill(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "skill" };
  const label = clean(b.label);
  if (chars(label) < 2 || chars(label) > 50) return { error: "Intitulé : de 2 à 50 caractères.", field: "label" };
  const cert = b.cert === undefined ? false : b.cert;
  if (bool(cert, "Habilitation")) return { error: bool(cert, "Habilitation"), field: "cert" };
  return { value: { label, cert } };
}

export function parseResource(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "resource" };
  const name = clean(b.name);
  if (chars(name) < 1 || chars(name) > 40) return { error: "Nom : 40 caractères au plus (ex. Pont n°1).", field: "name" };
  if (!TYPE_IDS.includes(b.type)) return { error: "Type d'équipement inconnu.", field: "type" };
  const active = b.active === undefined ? true : b.active;
  if (bool(active, "Disponible")) return { error: bool(active, "Disponible"), field: "active" };
  const hours = parseOwnHours(b.hours);
  if (hours.error) return { error: hours.error, field: "hours" };
  const services = parseServiceList(b.services, "Prestations compatibles");
  if (services.error) return { error: services.error, field: "services" };
  return { value: { name, type: b.type, active, hours: hours.value, services: services.value } };
}

// Exigences d'une prestation → { value } ou { error, field }
export function parseReq(serviceId, b, { skillIds }) {
  const s = SERVICE_BY_ID.get(serviceId);
  if (!s) return { error: "Prestation inconnue.", field: "service" };
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "req" };
  const v = { ...b };
  const unit = s.unit ? ` (${s.unit})` : "";
  for (const k of ["online", "auto", "parts", "drop"]) {
    if (v[k] === undefined) v[k] = k === "online";
    if (typeof v[k] !== "boolean") return { error: `${k} : oui ou non.`, field: k };
  }
  if (!step5(v.labour, 5, 600)) return { error: `Main-d'œuvre${unit} : de 5 min à 10 h, par 5 min.`, field: "labour" };
  if (v.shared === undefined) v.shared = 0;
  if (!step5(v.shared, 0, 120) || v.shared > v.labour) return { error: "Temps commun : de 0 à 2 h, par 5 min, et pas plus que la main-d'œuvre.", field: "shared" };
  if (v.immob === undefined) v.immob = v.labour;
  if (!step5(v.immob, 5, 720) || v.immob < v.labour) return { error: "Immobilisation : au moins la main-d'œuvre, 12 h au plus, par 5 min.", field: "immob" };
  if (v.staffN === undefined) v.staffN = 1;
  if (!Number.isInteger(v.staffN) || v.staffN < 1 || v.staffN > 3) return { error: "Mécaniciens nécessaires : de 1 à 3.", field: "staffN" };
  if (v.margin === undefined) v.margin = 0;
  if (!step5(v.margin, 0, 60)) return { error: "Marge de sécurité : de 0 à 60 min, par 5 min.", field: "margin" };
  const skills = Array.isArray(v.skills === undefined ? [] : v.skills) ? [...new Set((v.skills || []).map((x) => String(x).toLowerCase()))] : null;
  if (!skills || skills.some((id) => !skillIds.has(id))) return { error: "Compétence inconnue.", field: "skills" };
  const stations = pick(v.stations === undefined ? [] : v.stations, TYPE_IDS);
  if (!stations) return { error: "Type de poste inconnu.", field: "stations" };
  const tools = pick(v.tools === undefined ? [] : v.tools, TYPE_IDS);
  if (!tools) return { error: "Type d'équipement inconnu.", field: "tools" };
  if (tools.some((t) => stations.includes(t))) return { error: "Un même type ne peut pas être à la fois le poste et un équipement en plus.", field: "tools" };
  if (v.parts && v.auto) return { error: "Pièces à vérifier : la confirmation reste au garage.", field: "auto" };
  const partsH = v.partsH === undefined ? (v.parts ? 48 : 0) : v.partsH;
  if (!PARTS_DELAYS_H.includes(partsH)) return { error: "Délai des pièces : aucun, 1, 2, 3, 5 ou 7 jours.", field: "partsH" };
  const vehicles = {};
  if (v.vehicles !== undefined && v.vehicles !== null) {
    if (typeof v.vehicles !== "object" || Array.isArray(v.vehicles)) return { error: "Durées par véhicule : un objet.", field: "vehicles" };
    for (const [id, d] of Object.entries(v.vehicles)) {
      if (!VEHICLE_IDS.includes(id)) return { error: "Type de véhicule inconnu.", field: "vehicles" };
      const labour = d && d.labour, immob = d && d.immob !== undefined ? d.immob : labour;
      if (!step5(labour, 5, 600) || !step5(immob, 5, 720) || immob < labour || labour < v.shared)
        return { error: `${VEHICLES.find((x) => x.id === id).label} : main-d'œuvre et immobilisation (par 5 min, l'immobilisation au moins égale).`, field: "vehicles" };
      vehicles[id] = { labour, immob };
    }
  }
  return {
    value: { online: v.online, labour: v.labour, shared: v.shared, immob: v.immob, staffN: v.staffN, skills, stations, tools, margin: v.margin, auto: v.auto, parts: v.parts, partsH: v.parts ? partsH : 0, drop: v.drop, vehicles },
  };
}

// Absence d'un mécanicien ou indisponibilité d'un poste : { target, targetId, kind, label?, first, last, from?, to? } (jours AAAA-MM-JJ,
// heures HH:MM facultatives : sans heure, journées entières). → { value: { target, targetId, start, end (ms), kind, label } } ou { error }
export function parseUnavail(b, { staffIds, resourceIds, nowMs }) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "unavail" };
  if (b.target !== "staff" && b.target !== "resource") return { error: "Mécanicien ou poste ?", field: "target" };
  const ids = b.target === "staff" ? staffIds : resourceIds;
  if (!isUuid(b.targetId) || !ids.has(b.targetId.toLowerCase())) return { error: b.target === "staff" ? "Mécanicien inconnu." : "Poste inconnu.", field: "targetId" };
  const kind = UNAVAIL_KINDS.find((k) => k.id === b.kind && (k.for === "both" || k.for === b.target));
  if (!kind) return { error: "Motif inconnu.", field: "kind" };
  const first = b.first, last = b.last === undefined || b.last === "" ? b.first : b.last;
  if (!isIsoDay(first) || !isIsoDay(last) || last < first) return { error: "Dates : AAAA-MM-JJ, la fin après le début.", field: "first" };
  const mins = (t, dflt) => {
    if (t === undefined || t === null || t === "") return dflt;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t));
    return m && Number(m[2]) % 5 === 0 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const from = mins(b.from, 0), to = mins(b.to, null);
  if (!Number.isFinite(from) || (to !== null && !Number.isFinite(to))) return { error: "Heures : HH:MM, par 5 min.", field: "from" };
  const start = parisInstant(first, from);
  const end = to === null ? parisInstant(addDays(last, 1), 0) : parisInstant(last, to);
  if (end <= start) return { error: "La fin précède le début.", field: "to" };
  if (end <= nowMs) return { error: "Cette période est passée.", field: "last" };
  if (end - start > UNAVAIL_MAX_DAYS * 864e5) return { error: `${UNAVAIL_MAX_DAYS} jours au plus.`, field: "last" };
  if (start > nowMs + 366 * 864e5) return { error: "Dans l'année qui vient seulement.", field: "first" };
  const label = clean(b.label);
  if (chars(label) > 60) return { error: "Précision : 60 caractères au plus.", field: "label" };
  return { value: { target: b.target, targetId: b.targetId.toLowerCase(), start, end, kind: kind.id, label } };
}

// ---------------------------------------------------------------- blocs internes (lot 3b, Gestion d'atelier)
// « job » : rendez-vous saisi par le garage (téléphone, comptoir…), compté comme une demande (sans les règles de la réservation en
// ligne) ; « hold » : créneau bloqué sur des mécaniciens ou des postes, ou sur tout l'atelier (aucun des deux choisi).
export const BLOCK_KINDS = ["job", "hold"];
export const BLOCK_LABEL_MAX = 40;
export const MAX_BLOCK_SERVICES = 8;
export const MAX_BLOCK_TARGETS = 10;
export const MAX_BLOCKS = 1000; // blocs à venir par garage
// origine d'un rendez-vous saisi (Gestion d'atelier) ; les demandes Pixcar ont la leur (« pixcar »)
export const CHANNELS = ["phone", "walkin", "other"];
export const JOB_FIELDS_MAX = { client: BLOCK_LABEL_MAX, car: 40, plate: 15, phone: 20, note: 300 };
export const JOB_MINUTES_MAX = 1440;
const hhmm = (t) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t ?? ""));
  return m && Number(m[2]) % 5 === 0 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const ids = (v, known, max, what) => {
  const raw = v === undefined || v === null ? [] : v;
  if (!Array.isArray(raw) || raw.length > max) return { error: `${what} : une liste.` };
  const out = [];
  for (const x of raw) {
    if (!isUuid(x) || !known.has(x.toLowerCase())) return { error: `${what} : inconnu.` };
    if (!out.includes(x.toLowerCase())) out.push(x.toLowerCase());
  }
  return { value: out };
};
// Champs d'un rendez-vous saisi que la modification garde quand ils sont absents du corps (un glisser-déposer ne les envoie pas) :
// → { value: { client?, car?, plate?, phone?, note?, channel?, minutes?, back? } } (clé absente : non fournie ; back null : à calculer)
function jobFields(b) {
  const out = {};
  const client = b.client !== undefined ? b.client : b.label; // « label » : ancien nom du champ (lot 3b)
  for (const [k, raw] of [["client", client], ["car", b.car], ["plate", b.plate], ["phone", b.phone], ["note", b.note]]) {
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== "string") return { error: "Texte attendu.", field: k === "client" ? "label" : k };
    let v = k === "note" ? String(raw ?? "").normalize("NFC").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ").replace(/[ \t]+/g, " ").trim() : clean(raw);
    if (k === "plate") v = v.toUpperCase();
    if (chars(v) > JOB_FIELDS_MAX[k]) return { error: `${{ client: "Client", car: "Véhicule", plate: "Immatriculation", phone: "Téléphone", note: "Commentaire" }[k]} : ${JOB_FIELDS_MAX[k]} caractères au plus.`, field: k === "client" ? "label" : k };
    if (k === "plate" && v && !/^[A-Z0-9][A-Z0-9 -]*$/.test(v)) return { error: "Immatriculation : lettres, chiffres, tirets.", field: "plate" };
    // téléphone : un numéro, gardé comme ceux des demandes Pixcar (+33…), pour l'appeler d'un clic et l'afficher pareil partout
    if (k === "phone" && v) {
      const p = parsePhone(v);
      if (p.error) return { error: "Téléphone : un numéro, par exemple 06 12 34 56 78.", field: "phone" };
      v = p.value;
    }
    out[k] = v;
  }
  if (b.channel !== undefined && b.channel !== null) {
    if (!CHANNELS.includes(b.channel)) return { error: "Origine : téléphone, sur place ou autre.", field: "channel" };
    out.channel = b.channel;
  }
  if (b.minutes !== undefined) {
    if (b.minutes !== null && (!Number.isInteger(b.minutes) || b.minutes < 5 || b.minutes > JOB_MINUTES_MAX || b.minutes % 5)) return { error: "Durée estimée : de 5 min à 24 h, par 5 min.", field: "minutes" };
    out.minutes = b.minutes;
  }
  if (b.back !== undefined) {
    const back = b.back === null || b.back === "" ? null : b.back === "24:00" ? 1440 : hhmm(b.back);
    if (back === null && b.back !== null && b.back !== "") return { error: "Restitution : HH:MM, par 5 min.", field: "back" };
    out.back = back;
  }
  return { value: out };
}
// → { value: { kind, day, start, … } } ou { error, field }.
//  job : services, vehicle, staff (imposés), station, et les champs de jobFields (absents : gardés en modification) ;
//  hold : label, end, staff, resources (aucun des deux : tout l'atelier, whole: true).
// staffIds / resourceIds vides : affectation refusée (calcul par créneaux) ; serviceText : la phrase quand une prestation est inconnue.
export function parseBlock(b, { staffIds, resourceIds, serviceIds, nowMs, serviceText = "Prestation inconnue ou sans exigences (Calendrier › Prestations)." }) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "block" };
  if (!BLOCK_KINDS.includes(b.kind)) return { error: "Rendez-vous ou créneau bloqué ?", field: "kind" };
  if (!isIsoDay(b.day)) return { error: "Jour : AAAA-MM-JJ.", field: "day" };
  const start = hhmm(b.time);
  if (start === null) return { error: "Heure : HH:MM, par 5 min.", field: "time" };
  if (parisInstant(b.day, start) <= nowMs) return { error: "Cet horaire est passé.", field: "time" };
  if (parisInstant(b.day, start) > nowMs + 366 * 864e5) return { error: "Dans l'année qui vient seulement.", field: "day" };
  const assignable = staffIds.size + resourceIds.size > 0;
  const noAssign = (v) => (Array.isArray(v) ? v.length : v) && !assignable;
  if (b.kind === "job") {
    const raw = b.services;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BLOCK_SERVICES) return { error: "Choisissez au moins une prestation.", field: "services" };
    const services = [];
    for (const s of raw) {
      const id = s && typeof s === "object" ? s.id : s;
      const qty = s && typeof s === "object" && s.qty !== undefined ? s.qty : 1;
      if (!serviceIds.has(id)) return { error: serviceText, field: "services" };
      if (!Number.isInteger(qty) || qty < 1 || qty > 4) return { error: "Quantité : de 1 à 4.", field: "services" };
      if (!services.some((x) => x.id === id)) services.push({ id, qty });
    }
    const vehicle = b.vehicle === undefined || b.vehicle === null ? "" : b.vehicle;
    if (vehicle !== "" && !VEHICLE_IDS.includes(vehicle)) return { error: "Type de véhicule inconnu.", field: "vehicle" };
    if (noAssign(b.staff) || noAssign(b.station)) return { error: "Choisir un mécanicien ou un poste demande le calcul par ressources.", field: "staff" };
    const staff = ids(b.staff, staffIds, 3, "Mécanicien");
    if (staff.error) return { error: staff.error, field: "staff" };
    if (b.station !== undefined && b.station !== null && (!isUuid(b.station) || !resourceIds.has(b.station.toLowerCase()))) return { error: "Poste : inconnu.", field: "station" };
    const extra = jobFields(b);
    if (extra.error) return extra;
    if (extra.value.back !== undefined && extra.value.back !== null && extra.value.back <= start) return { error: "Restitution : après l'heure du rendez-vous.", field: "back" };
    return { value: { kind: "job", day: b.day, start, services, vehicle, staff: staff.value, station: b.station ? b.station.toLowerCase() : null, ...extra.value } };
  }
  const label = clean(b.label);
  if (chars(label) < 2 || chars(label) > BLOCK_LABEL_MAX) return { error: `Libellé : de 2 à ${BLOCK_LABEL_MAX} caractères.`, field: "label" };
  const end = b.to === "24:00" ? 1440 : hhmm(b.to);
  if (end === null || end <= start) return { error: "Fin : HH:MM, après le début.", field: "to" };
  if (noAssign(b.staff) || noAssign(b.resources)) return { error: "Bloquer un mécanicien ou un poste demande le calcul par ressources : sans choix, tout l'atelier est bloqué.", field: "staff" };
  const staff = ids(b.staff, staffIds, MAX_BLOCK_TARGETS, "Mécanicien");
  if (staff.error) return { error: staff.error, field: "staff" };
  const resources = ids(b.resources, resourceIds, MAX_BLOCK_TARGETS, "Poste");
  if (resources.error) return { error: resources.error, field: "resources" };
  if (staff.value.length + resources.value.length > MAX_BLOCK_TARGETS) return { error: `${MAX_BLOCK_TARGETS} mécaniciens ou postes au plus.`, field: "staff" };
  return { value: { kind: "hold", label, day: b.day, start, end, staff: staff.value, resources: resources.value, whole: !staff.value.length && !resources.value.length } };
}
// Créneau bloqué : ses ressources sont-elles libres (ni prises, ni absentes, ni en maintenance) ? → { ok } ou { fail: [raisons] }
export function checkHold(w, { day, start, end, staff, resources }) {
  if (parisInstant(day, start) <= w.nowMs) return { fail: reasons([{ code: "past" }], w) };
  const d = dayOf(w, day);
  const out = [];
  for (const id of [...staff, ...resources]) {
    const k = clash(d, id, [[start, end]]);
    if (k) out.push(why(k, w));
  }
  return out.length ? { fail: reasons(out, w) } : { ok: true };
}
// Lignes d'affectation d'un créneau bloqué (minutes de sa journée)
export const holdAssignments = ({ start, end, staff, resources }) => [
  ...staff.map((id) => ({ target: "staff", targetId: id, role: "labour", a: start, b: end })),
  ...resources.map((id) => ({ target: "resource", targetId: id, role: "station", a: start, b: end })),
];
// Plages d'ouverture d'un jour (minutes), pour la grille du planning
export const openOn = (w, iso) => dayOf(w, iso).open;
