// Calendrier avancé (docs/calendrier-avance.md, lot 3a). Routes du garage, appelées par server/rdv.mjs (compte vérifié, garage rattaché) :
//   GET    /v1/pro/garages/:id/rdv/calendar                  tout l'état (réglages, mécaniciens, compétences, postes, exigences, contrôles, conflits)
//   POST   …/calendar/start                                   ouvre l'assistant (réglages, compétences proposées, exigences par défaut)
//   PUT    …/calendar/settings                                { receptionMin?, returnMin?, loadPct?, maxDay?, autoAssign?, step? }
//   POST   …/calendar/staff · PUT, DELETE …/staff/:id         mécaniciens
//   POST   …/calendar/skills · PUT, DELETE …/skills/:id       compétences et habilitations
//   POST   …/calendar/resources · PUT, DELETE …/resources/:id postes et équipements
//   PUT    …/calendar/services/:service                       exigences d'une prestation
//   POST   …/calendar/unavail · DELETE …/unavail/:id          absences et maintenances
//   POST   …/calendar/check                                   contrôles et affectation proposée des rendez-vous à venir (rien n'est écrit)
//   POST   …/calendar/activate                                { placements?: [{ requestId, staff: [ids], station }] } : mode avancé
//   POST   …/calendar/simple                                  retour au mode simple
//   GET    …/calendar/agenda?from=AAAA-MM-JJ&to=AAAA-MM-JJ    planning d'une période : rendez-vous, blocs, affectations, ouverture, absences, conflits
//   POST   …/calendar/blocks · PUT, DELETE …/blocks/:id        blocs internes : rendez-vous hors Pixcar, créneaux bloqués (lot 3b)
//   POST   …/rdv/requests/:req/move                           { day, time, staff?, station?, confirm? } : déplacer ou réaffecter
// Et pour server/rdv.mjs : world() (ce que lit le moteur, dans la transaction de la prise d'horaire), writePlan(), planInfo().
import { apiError, json } from "./lib/http.mjs";
import { isUuid } from "./lib/validate.mjs";
import { DEFAULT_CAL } from "./calendar-repo.mjs";
import * as P from "../src/js/shared/plan.js";
import * as R from "../src/js/shared/rdv.js";
import { PRO_SERVICES, VEHICLES } from "../src/js/shared/pro-prices.js";

const NO_STORE = { "cache-control": "no-store" };
const SERVICE_BY_ID = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const AGENDA_MAX_DAYS = 42;

export function createCalendar({ repo, now, log = () => {}, drain, ctxOf, settingsOf, garageView }) {
  const today = () => R.parisParts(now()).iso;
  const advanced = (b) => !!(b && b.calendar && b.calendar.mode === "advanced");
  const notFound = (what = "Introuvable.") => apiError(404, "not_found", what);
  const allow = (methods) => apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: methods });
  const invalid = (p) => apiError(422, "validation", p.error, p.field ? { field: p.field } : {});

  // ---------------------------------------------------------------- ce que lit le moteur
  // Dans la transaction r (ou le dépôt hors transaction) : fiches, exigences des prestations faites (Mon garage), absences à venir,
  // affectations qui retiennent encore leur ressource (exclude : demandes à ne pas compter, celle qu'on déplace par exemple).
  async function world(r, b, nowMs, { exclude = null } = {}) {
    const settings = settingsOf(b);
    const t = R.parisParts(nowMs).iso;
    const data = await r.cal.load(b.garageId, R.addDays(t, -1), R.addDays(t, settings.horizonDays + 1));
    return worldFrom(b, data, nowMs, { exclude });
  }
  function worldFrom(b, data, nowMs, { exclude = null, withBusy = true } = {}) {
    const ex = exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : []);
    const busy = withBusy ? data.busy.filter((x) => !ex.has(x.requestId) && !ex.has(x.blockId) && (x.blockId || (x.requestId && R.holds({ status: x.status, deadline: x.deadline }, nowMs)))) : [];
    const offered = new Set(b.offered || []);
    const reqs = Object.fromEntries(Object.entries(data.reqs).filter(([id]) => offered.has(id)));
    return P.makeWorld({ nowMs, ctx: ctxOf(b), settings: settingsOf(b), cal: b.calendar || DEFAULT_CAL, staff: data.staff, resources: data.resources, skills: data.skills, reqs, unavail: data.unavail, busy });
  }
  const rowsOf = (plan) =>
    P.assignmentsOf(plan).map((a) => ({ target: a.target, targetId: a.targetId, role: a.role, day: plan.day, start: R.parisInstant(plan.day, a.a), end: R.parisInstant(plan.day, a.b) }));
  // affectations et intervention d'un rendez-vous planifié
  async function writePlan(r, garageId, requestId, plan, vehicle = "", fixed = false) {
    await r.cal.replaceAssignments(garageId, requestId, rowsOf(plan), { fixed });
    await r.cal.saveWorkOrder(garageId, requestId, {
      vehicle,
      workStart: R.parisInstant(plan.day, plan.workStart),
      workEnd: R.parisInstant(plan.day, plan.workEnd),
      readyAt: R.parisInstant(plan.day, plan.ready),
      returnAt: R.parisInstant(plan.day, plan.back),
      labour: plan.labour,
      immob: plan.ready - plan.workStart,
    });
  }
  // qui et quoi pour ces demandes : Map(id → { staff: [noms], posts: [noms], fixed }) (liste des demandes, e-mail au garage)
  async function planInfo(garageId, requestIds) {
    const out = new Map();
    if (!requestIds.length) return out;
    const [rows, data] = await Promise.all([repo.cal.assignmentsOf(garageId, requestIds), repo.cal.load(garageId, today(), today())]);
    const names = new Map([...data.staff, ...data.resources].map((x) => [x.id, x.name]));
    for (const a of rows) {
      const v = out.get(a.requestId) || { staff: [], posts: [], fixed: false };
      const name = names.get(a.targetId) || "";
      const list = a.target === "staff" ? v.staff : v.posts;
      if (name && !list.includes(name)) list.push(name);
      v.fixed = v.fixed || a.fixed;
      out.set(a.requestId, v);
    }
    return out;
  }

  // ---------------------------------------------------------------- vues
  // une absence ou une maintenance, telle que la saisit le garage (jours, heures facultatives)
  function unavailView(u) {
    const ps = R.parisParts(u.start), pe = R.parisParts(u.end);
    const fullEnd = pe.min === 0;
    const first = ps.iso, last = fullEnd ? R.addDays(pe.iso, -1) : pe.iso;
    const from = ps.min ? R.hm(ps.min) : "", to = fullEnd ? "" : R.hm(pe.min);
    const span = first === last ? R.dayLabel(first, { short: true }) : `du ${R.dayLabel(first, { short: true })} au ${R.dayLabel(last, { short: true })}`;
    const hours = from || to ? ` (${from ? R.timeLabel(R.minOf(from)) : "0:00"}–${to ? R.timeLabel(R.minOf(to)) : "24:00"})` : "";
    const kind = (P.UNAVAIL_KINDS.find((k) => k.id === u.kind) || { label: "" }).label;
    return { id: u.id, target: u.target, targetId: u.targetId, kind: u.kind, label: u.label, first, last, from, to, text: `${u.label || kind} : ${span}${hours}` };
  }
  const when = (q) => ({ day: q.day, label: R.whenLabel(q.day, q.start_min), start: R.hm(q.start_min), end: R.hm(q.end_min), mode: q.mode });
  const reqView = (q) => ({ id: q.id, status: q.status, when: when(q), services: q.services.map((s) => ({ id: s.id, qty: s.qty, label: R.serviceText(s) })), client: q.name || "", car: q.car || "" });
  const altView = (a) => ({ day: a.day, time: R.hm(a.start), label: R.whenLabel(a.day, a.start, { short: true }), back: R.hm(a.end) });
  const failView = (q, f) => ({ ...reqView(q), reasons: f.reasons.map((x) => x.text) });

  // conflits : rendez-vous à venir dont une affectation ne tient plus (rien n'est déplacé)
  async function conflictsOf(garageId, b, data, nowMs) {
    if (!advanced(b)) return [];
    const fut = await repo.cal.futureRequests(garageId);
    if (!fut.length) return [];
    const rows = await repo.cal.assignmentsOf(garageId, fut.map((q) => q.id));
    const stale = P.staleAssignments(worldFrom(b, data, nowMs, { withBusy: false }), rows);
    const byId = new Map(fut.map((q) => [q.id, q]));
    const out = new Map();
    for (const s of stale) {
      const q = byId.get(s.requestId);
      if (!q) continue;
      const v = out.get(q.id) || { ...reqView(q), reasons: [] };
      v.reasons.push(s.text);
      out.set(q.id, v);
    }
    const unplanned = fut.filter((q) => !rows.some((a) => a.requestId === q.id)).map((q) => ({ ...reqView(q), reasons: ["Aucun mécanicien ni poste affecté."] }));
    return [...out.values(), ...unplanned];
  }

  async function state(garageId, extra = {}) {
    const nowMs = now();
    const t = R.parisParts(nowMs).iso;
    const b = await repo.bundle(garageId, t);
    if (!b) return notFound("Garage introuvable.");
    const data = await repo.cal.load(garageId, t, t);
    const cal = b.calendar || DEFAULT_CAL;
    const w = worldFrom(b, data, nowMs, { withBusy: false });
    const unavailOf = (id) => data.unavail.filter((u) => u.targetId === id).map(unavailView);
    return json(
      200,
      {
        today: t,
        mode: cal.mode,
        step: cal.step,
        started: !!b.calendar,
        settings: { receptionMin: cal.receptionMin, returnMin: cal.returnMin, loadPct: cal.loadPct, maxDay: cal.maxDay, autoAssign: cal.autoAssign },
        booking: settingsOf(b),
        enabled: !!(b.settings && b.settings.enabled),
        notify: (b.settings && b.settings.notifyEmail) || "",
        hours: (b.profile && b.profile.hours) || null,
        closures: b.closures.map((c) => ({ id: c.id, first: c.first, last: c.last, label: c.label })),
        staff: data.staff.map((m) => ({ ...m, unavail: unavailOf(m.id) })),
        skills: data.skills,
        resources: data.resources.map((x) => ({ ...x, unavail: unavailOf(x.id) })),
        services: (b.offered || []).map((id) => {
          const s = SERVICE_BY_ID.get(id);
          return { id, label: s.label, group: s.g, unit: s.unit || "", minutes: Number.isInteger(b.minutes[id]) ? b.minutes[id] : null, req: data.reqs[id] || null };
        }),
        readiness: P.readiness(w, b.offered || []),
        conflicts: await conflictsOf(garageId, b, data, nowMs),
        catalogs: {
          types: P.RESOURCE_TYPES,
          kinds: P.UNAVAIL_KINDS,
          vehicles: VEHICLES,
          partsDelays: P.PARTS_DELAYS_H,
          limits: { staff: P.MAX_STAFF, resources: P.MAX_RESOURCES, skills: P.MAX_SKILLS, unavail: P.MAX_UNAVAIL },
        },
        ...extra,
      },
      NO_STORE,
    );
  }

  // ---------------------------------------------------------------- assistant et fiches
  async function start(garageId, sub) {
    const b = await repo.bundle(garageId, today());
    await repo.tx(async (r) => {
      if (!b.settings) await r.saveSettings(garageId, sub, {});
      if (!b.calendar) await r.cal.saveCalendar(garageId, sub, {});
      const data = await r.cal.load(garageId, today(), today());
      const byKey = {};
      if (!data.skills.length) {
        const t0 = now();
        for (const [i, k] of P.SKILL_SEEDS.entries()) byKey[k.key] = await r.cal.saveSkill(garageId, null, { label: k.label, cert: !!k.cert, at: new Date(t0 + i).toISOString() });
      } else for (const k of P.SKILL_SEEDS) byKey[k.key] = (data.skills.find((s) => s.label === k.label) || {}).id;
      for (const id of b.offered || []) if (!data.reqs[id]) await r.cal.saveReq(garageId, id, P.defaultReq(id, b.minutes[id], byKey));
      if (!b.calendar) await r.cal.log(garageId, sub, "wizard", null, "Assistant du calendrier avancé ouvert.");
    });
    return state(garageId);
  }

  async function putSettings(garageId, sub, body) {
    const p = P.parseCalendar(body);
    if (p.error) return invalid(p);
    await repo.cal.saveCalendar(garageId, sub, p.value);
    return state(garageId);
  }

  const skillSet = async (garageId) => new Set((await repo.cal.load(garageId, today(), today())).skills.map((s) => s.id));
  async function saveStaff(garageId, sub, id, body) {
    const p = P.parseStaff(body, { skillIds: await skillSet(garageId) });
    if (p.error) return invalid(p);
    if (!id && (await repo.cal.countStaff(garageId)) >= P.MAX_STAFF) return apiError(409, "too_many", `${P.MAX_STAFF} mécaniciens au plus.`);
    const saved = await repo.tx(async (r) => {
      const out = await r.cal.saveStaff(garageId, id, p.value);
      if (out) await r.cal.log(garageId, sub, "staff", out, `${id ? "Fiche modifiée" : "Mécanicien ajouté"} : ${p.value.name}${p.value.active ? "" : " (désactivé)"}.`);
      return out;
    });
    if (!saved) return notFound("Mécanicien introuvable.");
    return state(garageId, { saved });
  }
  async function deleteStaff(garageId, sub, id) {
    const uses = await repo.cal.futureUses(garageId, id);
    if (uses) return apiError(409, "in_use", `Ce mécanicien a ${uses} rendez-vous à venir : désactivez sa fiche, ou réaffectez-les d'abord.`, { uses });
    const ok = await repo.tx(async (r) => {
      const done = await r.cal.deleteStaff(garageId, id);
      if (done) await r.cal.log(garageId, sub, "staff", id, "Mécanicien supprimé.");
      return done;
    });
    return ok ? state(garageId) : notFound("Mécanicien introuvable.");
  }

  async function saveSkill(garageId, sub, id, body) {
    const p = P.parseSkill(body);
    if (p.error) return invalid(p);
    if (!id && (await repo.cal.countSkills(garageId)) >= P.MAX_SKILLS) return apiError(409, "too_many", `${P.MAX_SKILLS} compétences au plus.`);
    const saved = await repo.cal.saveSkill(garageId, id, p.value);
    if (!saved) return notFound("Compétence introuvable.");
    return state(garageId, { saved });
  }
  async function deleteSkill(garageId, sub, id) {
    const ok = await repo.tx(async (r) => {
      const done = await r.cal.deleteSkill(garageId, id);
      if (done) await r.cal.log(garageId, sub, "skill", id, "Compétence supprimée (retirée des fiches et des prestations).");
      return done;
    });
    return ok ? state(garageId) : notFound("Compétence introuvable.");
  }

  async function saveResource(garageId, sub, id, body) {
    const p = P.parseResource(body);
    if (p.error) return invalid(p);
    if (!id && (await repo.cal.countResources(garageId)) >= P.MAX_RESOURCES) return apiError(409, "too_many", `${P.MAX_RESOURCES} postes et équipements au plus.`);
    const saved = await repo.tx(async (r) => {
      const out = await r.cal.saveResource(garageId, id, p.value);
      if (out) await r.cal.log(garageId, sub, "resource", out, `${id ? "Poste modifié" : "Poste ajouté"} : ${p.value.name}${p.value.active ? "" : " (indisponible)"}.`);
      return out;
    });
    if (!saved) return notFound("Poste introuvable.");
    return state(garageId, { saved });
  }
  async function deleteResource(garageId, sub, id) {
    const uses = await repo.cal.futureUses(garageId, id);
    if (uses) return apiError(409, "in_use", `Ce poste a ${uses} rendez-vous à venir : rendez-le indisponible, ou réaffectez-les d'abord.`, { uses });
    const ok = await repo.tx(async (r) => {
      const done = await r.cal.deleteResource(garageId, id);
      if (done) await r.cal.log(garageId, sub, "resource", id, "Poste supprimé.");
      return done;
    });
    return ok ? state(garageId) : notFound("Poste introuvable.");
  }

  async function saveReq(garageId, sub, serviceId, body) {
    const b = await repo.bundle(garageId, today());
    if (!SERVICE_BY_ID.has(serviceId)) return notFound("Prestation inconnue.");
    if (!(b.offered || []).includes(serviceId)) return apiError(409, "not_offered", "Indiquez d'abord que vous faites cette prestation (Mon garage › Prestations).");
    const p = P.parseReq(serviceId, body, { skillIds: await skillSet(garageId) });
    if (p.error) return invalid(p);
    await repo.cal.saveReq(garageId, serviceId, p.value);
    return state(garageId);
  }

  async function saveUnavail(garageId, sub, body) {
    const data = await repo.cal.load(garageId, today(), today());
    const p = P.parseUnavail(body, { staffIds: new Set(data.staff.map((x) => x.id)), resourceIds: new Set(data.resources.map((x) => x.id)), nowMs: now() });
    if (p.error) return invalid(p);
    if ((await repo.cal.countUnavail(garageId)) >= P.MAX_UNAVAIL) return apiError(409, "too_many", `${P.MAX_UNAVAIL} absences et indisponibilités à venir au plus.`);
    const id = await repo.tx(async (r) => {
      const out = await r.cal.createUnavail(garageId, p.value);
      const who = [...data.staff, ...data.resources].find((x) => x.id === p.value.targetId);
      await r.cal.log(garageId, sub, "unavail", out, unavailView({ ...p.value, id: out }).text.replace(/^/, `${who ? who.name : ""} · `));
      return out;
    });
    const touched = await repo.cal.conflicts(garageId, [p.value.targetId], p.value.start, p.value.end);
    if (touched.length) log({ level: "info", msg: "calendrier : absence en conflit avec des rendez-vous", event: "cal_unavail_conflict", garageId, count: touched.length });
    return state(garageId, { saved: id, touched });
  }
  async function deleteUnavail(garageId, sub, id) {
    const ok = await repo.tx(async (r) => {
      const done = await r.cal.deleteUnavail(garageId, id);
      if (done) await r.cal.log(garageId, sub, "unavail", id, "Absence ou indisponibilité retirée.");
      return done;
    });
    return ok ? state(garageId) : notFound("Absence introuvable.");
  }

  // ---------------------------------------------------------------- bascule de mode
  // Rendez-vous à venir → à placer, dans l'ordre. manual : { requestId: { staff, station } } (choix du garage) ; à défaut, les
  // affectations choisies à la main auparavant sont gardées.
  async function itemsOf(r, garageId, fut, w, manual = {}) {
    const rows = await r.cal.assignmentsOf(garageId, fut.map((q) => q.id));
    const orders = await r.cal.workOrders(garageId, fut.map((q) => q.id));
    return fut.map((q) => {
      const order = orders.find((o) => o.requestId === q.id);
      const fixed = rows.filter((a) => a.requestId === q.id && a.fixed);
      const forced = manual[q.id] || (fixed.length ? { staff: [...new Set(fixed.filter((a) => a.target === "staff").map((a) => a.targetId))], station: (fixed.find((a) => a.role === "station") || {}).targetId || null } : null);
      return {
        requestId: q.id,
        day: q.day,
        start: q.start_min,
        mode: q.mode,
        job: P.buildJob(q.services, w.reqs, (order && order.vehicle) || ""),
        backBy: q.mode === "drop" || q.slot_id === P.NIL_SLOT ? q.end_min : undefined,
        forced,
        vehicle: (order && order.vehicle) || "",
        manual: !!manual[q.id] || !!fixed.length,
      };
    });
  }
  function parsePlacements(body, data) {
    const list = body ? body.placements : undefined;
    if (list === undefined || list === null) return { value: {} };
    if (!Array.isArray(list) || list.length > 200) return { error: "placements : une liste." };
    const staffIds = new Set(data.staff.map((x) => x.id)), resIds = new Set(data.resources.map((x) => x.id));
    const out = {};
    for (const p of list) {
      if (!p || !isUuid(p.requestId)) return { error: "Rendez-vous inconnu." };
      const staff = Array.isArray(p.staff) ? p.staff.map((x) => String(x).toLowerCase()) : [];
      if (staff.some((id) => !staffIds.has(id)) || staff.length > 3) return { error: "Mécanicien inconnu." };
      const station = p.station ? String(p.station).toLowerCase() : null;
      if (station && !resIds.has(station)) return { error: "Poste inconnu." };
      out[p.requestId.toLowerCase()] = { staff, station };
    }
    return { value: out };
  }

  async function check(garageId, body) {
    const nowMs = now();
    const b = await repo.bundle(garageId, today());
    const data = await repo.cal.load(garageId, today(), today());
    const manual = parsePlacements(body, data);
    if (manual.error) return apiError(422, "validation", manual.error);
    const fut = await repo.cal.futureRequests(garageId);
    const w = await world(repo, b, nowMs, { exclude: new Set(fut.map((q) => q.id)) });
    const out = P.placeExisting(w, await itemsOf(repo, garageId, fut, w, manual.value));
    const byId = new Map(fut.map((q) => [q.id, q]));
    return json(
      200,
      {
        readiness: P.readiness(w, b.offered || []),
        placed: out.placed.map((p) => ({ ...reqView(byId.get(p.requestId)), staff: p.plan.steps.flatMap((s) => s.staff).map((id) => w.names.get(id)), posts: p.plan.steps.map((s) => s.station).filter(Boolean).map((id) => w.names.get(id)), workStart: R.hm(p.plan.workStart), back: R.hm(p.plan.back) })),
        failed: out.failed.map((f) => failView(byId.get(f.requestId), f)),
      },
      NO_STORE,
    );
  }

  async function activate(garageId, sub, body) {
    const nowMs = now();
    const data0 = await repo.cal.load(garageId, today(), today());
    const manual = parsePlacements(body, data0);
    if (manual.error) return apiError(422, "validation", manual.error);
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const b = await r.bundle(garageId, R.parisParts(nowMs).iso);
      if (!b.calendar) return { kind: "not_started" };
      const fut = await r.cal.futureRequests(garageId);
      const w = await world(r, b, nowMs, { exclude: new Set(fut.map((q) => q.id)) });
      const ready = P.readiness(w, b.offered || []);
      if (!ready.ok) return { kind: "not_ready", readiness: ready };
      const items = await itemsOf(r, garageId, fut, w, manual.value);
      const res = P.placeExisting(w, items);
      if (res.failed.length) return { kind: "unplaced", failed: res.failed.map((f) => failView(fut.find((q) => q.id === f.requestId), f)) };
      for (const p of res.placed) {
        const it = items.find((x) => x.requestId === p.requestId);
        await writePlan(r, garageId, p.requestId, p.plan, it.vehicle, it.manual);
      }
      await r.cal.saveCalendar(garageId, sub, { mode: "advanced", step: 6, activated: true });
      await r.cal.log(garageId, sub, "mode", null, `Mode avancé activé (${res.placed.length} rendez-vous à venir affectés).`);
      return { kind: "ok", placed: res.placed.length };
    });
    if (out.kind === "not_started") return apiError(409, "not_started", "Ouvrez d'abord l'assistant du calendrier avancé.");
    if (out.kind === "not_ready") return apiError(409, "not_ready", out.readiness.problems.filter((p) => p.blocking).map((p) => p.text).join(" "), { readiness: out.readiness });
    if (out.kind === "unplaced")
      return apiError(409, "unplaced", out.failed.length > 1 ? `${out.failed.length} rendez-vous à venir ne trouvent pas de place : placez-les à la main, ou annulez-les.` : "Un rendez-vous à venir ne trouve pas de place : placez-le à la main, ou annulez-le.", { failed: out.failed });
    log({ level: "info", msg: "calendrier avancé activé", event: "cal_mode", garageId, mode: "advanced", placed: out.placed });
    return state(garageId, { placed: out.placed });
  }

  // Retour au mode simple : chaque rendez-vous à venir pris en mode avancé (ou dont le créneau n'existe plus) est rattaché au premier
  // créneau compatible qui a encore de la place ; sinon il est listé et rien ne change.
  function slotFor(q, slots, taken) {
    const ids = q.services.map((s) => s.id);
    const wd = R.weekday(q.day);
    for (const s of slots) {
      if (!s.days.includes(wd) || !ids.every((id) => s.services.includes(id)) || s.mode !== q.mode) continue;
      if (q.mode === "drop" ? s.start !== q.start_min : q.start_min < s.start || q.start_min + q.minutes > s.end) continue;
      const mine = taken.filter((x) => x.slotId === s.id && x.day === q.day);
      const busy = q.mode === "drop" ? mine.length : Math.max(0, ...[q.start_min, ...mine.map((x) => x.start).filter((p) => p > q.start_min && p < q.end_min)].map((p) => mine.filter((x) => x.start <= p && p < x.end).length));
      if (busy < s.capacity) return s;
    }
    return null;
  }
  async function toSimple(garageId, sub) {
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const b = await r.bundle(garageId, today());
      if (!advanced(b)) return { kind: "already" };
      const fut = await r.cal.futureRequests(garageId);
      const slotIds = new Set(b.slots.map((s) => s.id));
      const taken = fut.filter((q) => slotIds.has(q.slot_id)).map((q) => ({ slotId: q.slot_id, day: q.day, start: q.start_min, end: q.end_min }));
      const moves = [], failed = [];
      for (const q of fut.filter((x) => !slotIds.has(x.slot_id))) {
        const s = slotFor(q, b.slots, taken);
        if (!s) {
          failed.push({ ...reqView(q), reasons: ["Aucun créneau de la semaine type ne couvre ce rendez-vous, ou il est plein. Ajoutez ou élargissez un créneau (Disponibilités), ou annulez ce rendez-vous."] });
          continue;
        }
        taken.push({ slotId: s.id, day: q.day, start: q.start_min, end: q.end_min });
        moves.push([q.id, s.id]);
      }
      if (failed.length) return { kind: "unplaced", failed };
      for (const [id, slotId] of moves) await r.cal.setSlot(garageId, id, slotId);
      await r.cal.saveCalendar(garageId, sub, { mode: "simple" });
      await r.cal.log(garageId, sub, "mode", null, `Retour au mode simple (${moves.length} rendez-vous rattachés à un créneau).`);
      return { kind: "ok", moved: moves.length };
    });
    if (out.kind === "already") return state(garageId);
    if (out.kind === "unplaced") return apiError(409, "unplaced", "Des rendez-vous à venir n'entrent dans aucun créneau de votre semaine type.", { failed: out.failed });
    log({ level: "info", msg: "calendrier : retour au mode simple", event: "cal_mode", garageId, mode: "simple" });
    return state(garageId, { moved: out.moved });
  }

  // ---------------------------------------------------------------- calendrier d'une période (écran Planning, lot 3b)
  const iso = (msv) => msv && new Date(msv).toISOString();
  const planView = (names) => (a) => ({ target: a.target, id: a.targetId, name: names.get(a.targetId) || "", role: a.role, start: iso(a.start), end: iso(a.end), ...(a.fixed !== undefined ? { fixed: a.fixed } : {}) });
  const blockView = (k, rows, names) => ({
    id: k.id,
    kind: k.kind,
    label: k.label,
    services: k.services.map((s) => ({ id: s.id, qty: s.qty, label: R.serviceText(s) })),
    vehicle: k.vehicle,
    when: { day: k.day, label: R.whenLabel(k.day, k.start), start: R.hm(k.start), end: R.hm(k.end) },
    startsAt: iso(k.startsAt),
    endsAt: iso(k.endsAt),
    fixed: k.fixed,
    plan: rows.filter((a) => a.blockId === k.id).map(planView(names)),
  });
  // blocs à venir dont une ressource n'est plus là (absence, fiche désactivée…) : signalés comme les rendez-vous, jamais déplacés
  function blockConflicts(w, brows, blocks, nowMs) {
    const fut = new Set(blocks.filter((k) => k.endsAt > nowMs).map((k) => k.id));
    const out = new Map();
    for (const s of P.staleAssignments(w, brows.filter((a) => fut.has(a.blockId)).map((a) => ({ ...a, requestId: a.blockId })))) {
      const v = out.get(s.requestId) || { id: s.requestId, block: true, reasons: [] };
      v.reasons.push(s.text);
      out.set(s.requestId, v);
    }
    return [...out.values()];
  }
  async function agenda(garageId, url) {
    const from = url.searchParams.get("from") || today(), to = url.searchParams.get("to") || from;
    if (!R.isIsoDay(from) || !R.isIsoDay(to) || to < from || R.addDays(from, AGENDA_MAX_DAYS) < to) return apiError(400, "bad_request", `from et to : AAAA-MM-JJ, ${AGENDA_MAX_DAYS} jours au plus.`);
    const nowMs = now();
    const [list, data, blocks, b] = await Promise.all([repo.cal.requestsBetween(garageId, from, to), repo.cal.load(garageId, today(), today()), repo.cal.blocksBetween(garageId, from, to), repo.bundle(garageId, today())]);
    if (!b) return notFound("Garage introuvable.");
    const ids = list.map((q) => q.id);
    const [rows, orders, brows, conflicts] = await Promise.all([repo.cal.assignmentsOf(garageId, ids), repo.cal.workOrders(garageId, ids), repo.cal.blockAssignments(garageId, blocks.map((k) => k.id)), conflictsOf(garageId, b, data, nowMs)]);
    const names = new Map([...data.staff, ...data.resources].map((x) => [x.id, x.name]));
    const w = worldFrom(b, data, nowMs, { withBusy: false });
    const days = [];
    for (let d = from; d <= to; d = R.addDays(d, 1)) days.push({ day: d, open: P.openOn(w, d).map(([a, z]) => [R.hm(a), R.hm(z)]) });
    const fromMs = R.parisInstant(from, 0), toMs = R.parisInstant(R.addDays(to, 1), 0);
    return json(
      200,
      {
        from,
        to,
        today: today(),
        days,
        staff: data.staff.map((m) => ({ id: m.id, name: m.name, active: m.active })),
        resources: data.resources.map((x) => ({ id: x.id, name: x.name, type: x.type, active: x.active })),
        services: (b.offered || [])
          .filter((id) => data.reqs[id])
          .map((id) => ({ id, label: SERVICE_BY_ID.get(id).label, unit: SERVICE_BY_ID.get(id).unit || "", byVehicle: Object.keys(data.reqs[id].vehicles || {}).length > 0 })),
        vehicles: VEHICLES,
        unavail: data.unavail.filter((u) => u.start < toMs && u.end > fromMs).map((u) => ({ ...unavailView(u), name: names.get(u.targetId) || "" })),
        conflicts: [
          ...conflicts.map((c) => ({ id: c.id, reasons: c.reasons })),
          ...blockConflicts(w, brows, blocks, nowMs),
        ],
        blocks: blocks.map((k) => blockView(k, brows, names)),
        appointments: list.map((q) => {
          const o = orders.find((x) => x.requestId === q.id);
          return {
            ...reqView(q),
            phone: q.phone || "",
            plate: q.plate || "",
            vehicle: (o && o.vehicle) || "",
            work: o ? { start: o.workStart && new Date(o.workStart).toISOString(), ready: o.readyAt && new Date(o.readyAt).toISOString(), back: o.returnAt && new Date(o.returnAt).toISOString(), labour: o.labour, status: o.status } : null,
            plan: rows.filter((a) => a.requestId === q.id).map(planView(names)),
          };
        }),
      },
      NO_STORE,
    );
  }

  // ---------------------------------------------------------------- blocs internes (lot 3b)
  // job : planifié par le moteur comme une demande, sans les règles de la réservation en ligne, travaux au premier moment libre après
  // le dépôt ; hold : ses ressources doivent être libres. Rien n'est forcé : en cas de conflit, la cause et d'autres horaires.
  const holdRows = (v) => P.holdAssignments(v).map((a) => ({ target: a.target, targetId: a.targetId, role: a.role, day: v.day, start: R.parisInstant(v.day, a.a), end: R.parisInstant(v.day, a.b) }));
  async function saveBlock(garageId, sub, id, body) {
    const nowMs = now();
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const b = await r.bundle(garageId, R.parisParts(nowMs).iso);
      if (!advanced(b)) return { kind: "simple" };
      if (id && !(await r.cal.getBlock(garageId, id))) return { kind: "not_found" };
      if (!id && (await r.cal.countBlocks(garageId)) >= P.MAX_BLOCKS) return { kind: "too_many" };
      const w = await world(r, b, nowMs, { exclude: id });
      const p = P.parseBlock(body, { staffIds: new Set(w.staff.map((m) => m.id)), resourceIds: new Set(w.resources.map((x) => x.id)), serviceIds: new Set(Object.keys(w.reqs)), nowMs });
      if (p.error) return { kind: "invalid", p };
      const v = p.value;
      let row, rows;
      if (v.kind === "job") {
        const job = P.buildJob(v.services, w.reqs, v.vehicle);
        if (job.error) return { kind: "not_configured" };
        if (job.needVehicle && !v.vehicle) return { kind: "invalid", p: { error: "Type de véhicule : une prestation en dépend.", field: "vehicle" } };
        const forced = v.staff.length || v.station ? { staff: v.staff, station: v.station } : null;
        const ex = P.explain(w, job, { day: v.day, start: v.start, mode: "hour", forced, float: true });
        if (!ex.plan) return { kind: "conflict", reasons: ex.reasons.map((x) => x.text), alternatives: ex.alternatives.map(altView) };
        row = { kind: "job", label: v.label, services: v.services, vehicle: v.vehicle, mode: "hour", day: v.day, start: v.start, end: ex.plan.back, startsAt: R.parisInstant(v.day, v.start), endsAt: R.parisInstant(v.day, ex.plan.back), fixed: !!forced };
        rows = rowsOf(ex.plan);
      } else {
        const c = P.checkHold(w, v);
        if (c.fail) return { kind: "conflict", reasons: c.fail.map((x) => x.text), alternatives: [] };
        row = { kind: "hold", label: v.label, services: [], vehicle: "", mode: "hour", day: v.day, start: v.start, end: v.end, startsAt: R.parisInstant(v.day, v.start), endsAt: R.parisInstant(v.day, v.end), fixed: true };
        rows = holdRows(v);
      }
      const saved = await r.cal.saveBlock(garageId, sub, id, row);
      if (!saved) return { kind: "not_found" };
      await r.cal.replaceBlockAssignments(garageId, saved, rows);
      await r.cal.log(garageId, sub, "block", saved, `${v.kind === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué"} ${id ? "modifié" : "ajouté"} : ${R.whenLabel(v.day, v.start)}.`);
      return { kind: "ok", saved };
    });
    switch (out.kind) {
      case "simple":
        return apiError(409, "simple_mode", "Les blocs du planning demandent le mode avancé.");
      case "not_found":
        return notFound("Bloc introuvable.");
      case "too_many":
        return apiError(409, "too_many", `${P.MAX_BLOCKS} blocs à venir au plus.`);
      case "invalid":
        return invalid(out.p);
      case "not_configured":
        return apiError(409, "not_configured", "Une prestation n'a pas ses exigences (Calendrier › Prestations).");
      case "conflict":
        return apiError(409, "conflict", out.reasons[0] || "Impossible à cette heure-là.", { reasons: out.reasons, alternatives: out.alternatives });
      default:
        log({ level: "info", msg: id ? "calendrier : bloc modifié" : "calendrier : bloc ajouté", event: "cal_block", garageId });
        return json(id ? 200 : 201, { saved: out.saved }, NO_STORE);
    }
  }
  async function deleteBlock(garageId, sub, id) {
    const done = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const k = await r.cal.getBlock(garageId, id);
      if (!k || !(await r.cal.deleteBlock(garageId, id))) return false;
      await r.cal.log(garageId, sub, "block", id, `${k.kind === "job" ? "Rendez-vous hors Pixcar" : "Créneau bloqué"} supprimé : ${R.whenLabel(k.day, k.start)}.`);
      return true;
    });
    if (!done) return notFound("Bloc introuvable.");
    return json(200, { deleted: true }, NO_STORE);
  }

  // ---------------------------------------------------------------- déplacer ou réaffecter un rendez-vous
  async function move(garageId, sub, id, body) {
    const b0 = body || {};
    if (!R.isIsoDay(b0.day) || !Number.isFinite(R.minOf(b0.time))) return apiError(422, "validation", "Choisissez un jour et une heure.", { field: "time" });
    const staff = b0.staff === undefined || b0.staff === null ? [] : b0.staff;
    if (!Array.isArray(staff) || staff.length > 3 || !staff.every(isUuid)) return apiError(422, "validation", "Mécanicien inconnu.", { field: "staff" });
    if (b0.station !== undefined && b0.station !== null && !isUuid(b0.station)) return apiError(422, "validation", "Poste inconnu.", { field: "station" });
    const forced = staff.length || b0.station ? { staff: staff.map((x) => x.toLowerCase()), station: b0.station ? b0.station.toLowerCase() : null } : null;
    const start = R.minOf(b0.time);
    const nowMs = now();
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const q = await r.getForGarage(garageId, id);
      if (!q) return { kind: "not_found" };
      if (!R.holds(q, nowMs) || q.starts_at <= nowMs) return { kind: "state" };
      const b = await r.bundle(garageId, R.parisParts(nowMs).iso);
      if (!advanced(b)) return { kind: "simple" };
      const w = await world(r, b, nowMs, { exclude: id });
      if (forced && (forced.staff.some((x) => !w.staff.some((m) => m.id === x)) || (forced.station && !w.resources.some((x) => x.id === forced.station)))) return { kind: "unknown" };
      const order = await r.cal.workOrder(id);
      const vehicle = (order && order.vehicle) || "";
      const job = P.buildJob(q.services, w.reqs, vehicle);
      if (job.error) return { kind: "not_configured" };
      const same = b0.day === q.day && start === q.start_min;
      const ex = P.explain(w, job, { day: b0.day, start, mode: q.mode, forced, float: same });
      if (!ex.plan) return { kind: "conflict", reasons: ex.reasons.map((x) => x.text), alternatives: ex.alternatives.map(altView) };
      if (!same && b0.confirm !== true) return { kind: "confirm", when: { label: R.whenLabel(b0.day, start), back: R.hm(ex.plan.back) } };
      if (!same) await r.reschedule(id, garageId, { day: b0.day, start, end: ex.plan.back, startsAt: R.parisInstant(b0.day, start), endsAt: R.parisInstant(b0.day, ex.plan.back) });
      await writePlan(r, garageId, id, ex.plan, vehicle, !!forced);
      const who = [...new Set(ex.plan.steps.flatMap((s) => [...s.staff, s.station]).filter(Boolean))].map((x) => w.names.get(x)).join(", ");
      await r.cal.log(garageId, sub, same ? "assign" : "move", id, same ? `Rendez-vous réaffecté : ${who}.` : `Rendez-vous déplacé au ${R.whenLabel(b0.day, start)} (${who}).`);
      return { kind: "ok", moved: !same };
    });
    switch (out.kind) {
      case "not_found":
        return notFound("Demande introuvable.");
      case "state":
        return apiError(409, "state", "Ce rendez-vous est passé, annulé ou sans réponse : il ne se déplace plus.");
      case "simple":
        return apiError(409, "simple_mode", "Le déplacement avec contrôle des ressources demande le mode avancé.");
      case "unknown":
        return apiError(422, "validation", "Mécanicien ou poste inconnu.");
      case "not_configured":
        return apiError(409, "not_configured", "Une prestation de ce rendez-vous n'a pas ses exigences (Calendrier › Prestations).");
      case "conflict":
        return apiError(409, "conflict", out.reasons[0] || "Impossible à cette heure-là.", { reasons: out.reasons, alternatives: out.alternatives });
      case "confirm":
        return apiError(409, "confirm", `Le client sera prévenu par e-mail du nouvel horaire : ${out.when.label} (restitution prévue vers ${R.timeLabel(R.minOf(out.when.back))}). Confirmez le déplacement.`, { when: out.when });
      default:
        break;
    }
    if (out.moved) await drain({ requestIds: [id] });
    log({ level: "info", msg: out.moved ? "calendrier : rendez-vous déplacé" : "calendrier : rendez-vous réaffecté", event: "cal_move", garageId, moved: out.moved });
    return json(200, garageView(await repo.getForGarage(garageId, id)), NO_STORE);
  }

  // ---------------------------------------------------------------- aiguillage
  async function route(request, sub, garageId, parts, readBody) {
    const method = request.method;
    const [what, id, extra] = parts;
    if (extra || (id && !["staff", "skills", "resources", "unavail", "services", "blocks"].includes(what))) return notFound("Route inconnue.");
    if (!what) return method === "GET" ? state(garageId) : allow("GET");
    if (what === "agenda") return method === "GET" ? agenda(garageId, new URL(request.url)) : allow("GET");
    if (what === "start") return method === "POST" ? start(garageId, sub) : allow("POST");
    if (what === "settings") return method === "PUT" ? putSettings(garageId, sub, await readBody()) : allow("PUT");
    if (what === "check") return method === "POST" ? check(garageId, await readBody(16384)) : allow("POST");
    if (what === "activate") return method === "POST" ? activate(garageId, sub, await readBody(16384)) : allow("POST");
    if (what === "simple") return method === "POST" ? toSimple(garageId, sub) : allow("POST");
    if (what === "services") {
      if (!id) return notFound("Route inconnue.");
      return method === "PUT" ? saveReq(garageId, sub, id, await readBody(4096)) : allow("PUT");
    }
    const crud = { staff: [saveStaff, deleteStaff], skills: [saveSkill, deleteSkill], resources: [saveResource, deleteResource], unavail: [saveUnavail, deleteUnavail], blocks: [saveBlock, deleteBlock] }[what];
    if (!crud) return notFound("Route inconnue.");
    if (!id) return method === "POST" ? crud[0](garageId, sub, ...(what === "unavail" ? [] : [null]), await readBody(4096)) : allow("POST");
    if (!isUuid(id)) return notFound();
    const key = id.toLowerCase();
    if (what === "unavail") return method === "DELETE" ? deleteUnavail(garageId, sub, key) : allow("DELETE");
    return method === "PUT" ? crud[0](garageId, sub, key, await readBody(4096)) : method === "DELETE" ? crud[1](garageId, sub, key) : allow("PUT, DELETE");
  }

  return { advanced, world, writePlan, planInfo, route, move };
}
