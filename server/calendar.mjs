// Calendrier avancé (docs/calendrier-avance.md, lot 3a). Routes du garage, appelées par server/rdv.mjs (compte vérifié, garage rattaché) :
//   GET    /v1/pro/garages/:id/rdv/calendar                  tout l'état (réglages, mécaniciens, compétences, postes, exigences, contrôles, conflits)
//   POST   …/calendar/start                                   ouvre l'assistant (réglages, compétences proposées, exigences par défaut)
//   PUT    …/calendar/settings                                { receptionMin?, returnMin?, loadPct?, maxDay?, autoAssign?, step?, modules? }
//                                                             (modules : ceux de l'affichage avancé de Gestion d'atelier, pour le garage)
//   POST   …/calendar/staff · PUT, DELETE …/staff/:id         mécaniciens
//   POST   …/calendar/skills · PUT, DELETE …/skills/:id       compétences et habilitations
//   POST   …/calendar/resources · PUT, DELETE …/resources/:id postes et équipements
//   PUT    …/calendar/services/:service                       exigences d'une prestation
//   POST   …/calendar/unavail · DELETE …/unavail/:id          absences et maintenances
//   POST   …/calendar/check                                   contrôles et affectation proposée des rendez-vous à venir (rien n'est écrit)
//   POST   …/calendar/activate                                { placements?: [{ requestId, staff: [ids], station }] } : mode avancé
//   POST   …/calendar/simple                                  retour au mode simple
//   GET    …/calendar/agenda?from=AAAA-MM-JJ&to=AAAA-MM-JJ    planning d'une période : rendez-vous, blocs, affectations, ouverture, absences, conflits
//   POST   …/calendar/blocks · PUT, DELETE …/blocks/:id        blocs internes : rendez-vous saisis par le garage, créneaux bloqués (lot 3b),
//                                                             dans les deux calculs des disponibilités (Gestion d'atelier)
//   POST   …/rdv/requests/:req/move                           { day, time, staff?, station?, confirm? } : déplacer ou réaffecter
//   POST   …/calendar/work/:id                                { status, notify? } : état de l'intervention (lot 3c) d'un rendez-vous Pixcar
//                                                             confirmé ou d'un rendez-vous saisi, dans les deux calculs
// Et pour server/rdv.mjs : world() (ce que lit le moteur, dans la transaction de la prise d'horaire), writePlan(), planInfo().
import { apiError, json } from "./lib/http.mjs";
import { isUuid } from "./lib/validate.mjs";
import { DEFAULT_CAL } from "./calendar-repo.mjs";
import * as P from "../src/js/shared/plan.js";
import * as R from "../src/js/shared/rdv.js";
import * as W from "../src/js/shared/work.js";
import { PRO_SERVICES, VEHICLES } from "../src/js/shared/pro-prices.js";

const NO_STORE = { "cache-control": "no-store" };
const SERVICE_BY_ID = new Map(PRO_SERVICES.map((s) => [s.id, s]));
const AGENDA_MAX_DAYS = 42;
const MODULE_NAMES = { staff: "Mécaniciens", equip: "Ponts et équipements", track: "Suivi des interventions", load: "Charge et capacité" };

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
    // un client noté absent (lot 3c) ne retient plus ses ressources
    const busy = withBusy ? data.busy.filter((x) => !x.noShow && !ex.has(x.requestId) && !ex.has(x.blockId) && (x.blockId || (x.requestId && R.holds({ status: x.status, deadline: x.deadline }, nowMs)))) : [];
    // créneau bloqué de tout l'atelier (Gestion d'atelier) : chaque mécanicien et chaque poste, y compris ceux ajoutés après lui
    if (withBusy)
      for (const h of (data.whole || []).filter((x) => !ex.has(x.blockId)))
        busy.push(
          ...data.staff.map((m) => ({ blockId: h.blockId, target: "staff", targetId: m.id, role: "labour", start: h.start, end: h.end })),
          ...data.resources.map((x) => ({ blockId: h.blockId, target: "resource", targetId: x.id, role: "station", start: h.start, end: h.end })),
        );
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
        modules: W.modulesOf(b.settings && b.settings.modules),
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

  // modules (Gestion d'atelier) : enregistrés avec les réglages des rendez-vous (rdv_settings), pas dans rdv_calendar, dont l'existence
  // dit que l'assistant du calcul par ressources a été ouvert
  async function putSettings(garageId, sub, body) {
    const hasModules = !!body && typeof body === "object" && !Array.isArray(body) && body.modules !== undefined;
    const rest = hasModules ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "modules")) : body;
    const p = hasModules && !Object.keys(rest).length ? null : P.parseCalendar(rest);
    if (p && p.error) return invalid(p);
    if (hasModules) {
      const out = await repo.tx(async (r) => {
        await r.lockGarage(garageId);
        const b = await r.bundle(garageId, today());
        const was = W.modulesOf(b.settings && b.settings.modules);
        const m = W.parseModules(body.modules, { current: b.settings && b.settings.modules, byResources: advanced(b) });
        if (m.error) return m;
        await r.saveSettings(garageId, sub, { modules: JSON.stringify(m.value) });
        const changed = W.MODULE_KEYS.filter((k) => was[k] !== m.value[k]);
        if (changed.length) await r.cal.log(garageId, sub, "modules", null, `Modules : ${changed.map((k) => `${MODULE_NAMES[k]} ${m.value[k] ? "activé" : "coupé"}`).join(", ")}.`);
        return { ok: true };
      });
      if (out.error) return out.code ? apiError(409, out.code, out.error, { field: out.field }) : invalid(out);
    }
    if (p) await repo.cal.saveCalendar(garageId, sub, p.value);
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
    const who = [...data.staff, ...data.resources].find((x) => x.id === p.value.targetId);
    // une même personne (ou un même poste) n'est pas absente deux fois au même moment : la période déjà saisie est nommée
    const clash = data.unavail.find((u) => u.targetId === p.value.targetId && u.start < p.value.end && u.end > p.value.start);
    if (clash) {
      const staff = p.value.target === "staff";
      return apiError(409, "overlap", `${who ? who.name : staff ? "Ce mécanicien" : "Ce poste"} est déjà ${staff ? "absent" : "indisponible"} sur cette période (${unavailView(clash).text}). Choisissez d'autres dates ou heures, ou retirez d'abord cette ${staff ? "absence" : "indisponibilité"}.`, { field: "first", overlap: unavailView(clash) });
    }
    if ((await repo.cal.countUnavail(garageId)) >= P.MAX_UNAVAIL) return apiError(409, "too_many", `${P.MAX_UNAVAIL} absences et indisponibilités à venir au plus.`);
    const id = await repo.tx(async (r) => {
      const out = await r.cal.createUnavail(garageId, p.value);
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

  // Tout ce qu'il faut placer pour passer au calcul par ressources : les demandes à venir, et les rendez-vous saisis à venir qui n'ont pas
  // d'affectation (pris en calcul par créneaux), dans l'ordre des heures. viewOf(échec ou placement) : la ligne montrée au garage.
  async function toPlace(r, garageId, fut, w, manual) {
    const jobs = await r.cal.futureJobs(garageId);
    const jrows = await r.cal.blockAssignments(garageId, jobs.map((k) => k.id));
    const loose = jobs.filter((k) => !jrows.some((a) => a.blockId === k.id));
    const items = [
      ...(await itemsOf(r, garageId, fut, w, manual)),
      ...loose.map((k) => ({ requestId: k.id, day: k.day, start: k.start, mode: "hour", job: P.buildJob(k.services, w.reqs, k.vehicle), forced: null, vehicle: k.vehicle, manual: false, block: k })),
    ].sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.start - y.start));
    const blockView0 = (k) => ({ id: k.id, block: true, status: "confirmed", when: { day: k.day, label: R.whenLabel(k.day, k.start), start: R.hm(k.start), end: R.hm(k.end), mode: "hour" }, services: k.services.map((x) => ({ id: x.id, qty: x.qty, label: R.serviceText(x) })), client: k.label || k.car, car: k.car });
    const viewOf = (f) => {
      const it = items.find((x) => x.requestId === f.requestId);
      const base = it.block ? blockView0(it.block) : reqView(fut.find((q) => q.id === f.requestId));
      return f.reasons ? { ...base, reasons: f.reasons.map((x) => x.text) } : base;
    };
    return { items, viewOf };
  }

  async function check(garageId, body) {
    const nowMs = now();
    const b = await repo.bundle(garageId, today());
    const data = await repo.cal.load(garageId, today(), today());
    const manual = parsePlacements(body, data);
    if (manual.error) return apiError(422, "validation", manual.error);
    const fut = await repo.cal.futureRequests(garageId);
    const w = await world(repo, b, nowMs, { exclude: new Set(fut.map((q) => q.id)) });
    const { items, viewOf } = await toPlace(repo, garageId, fut, w, manual.value);
    const out = P.placeExisting(w, items);
    return json(
      200,
      {
        readiness: P.readiness(w, b.offered || []),
        placed: out.placed.map((p) => ({ ...viewOf(p), staff: p.plan.steps.flatMap((s) => s.staff).map((id) => w.names.get(id)), posts: p.plan.steps.map((s) => s.station).filter(Boolean).map((id) => w.names.get(id)), workStart: R.hm(p.plan.workStart), back: R.hm(p.plan.back) })),
        failed: out.failed.map((f) => viewOf(f)),
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
      const { items, viewOf } = await toPlace(r, garageId, fut, w, manual.value);
      const res = P.placeExisting(w, items);
      if (res.failed.length) return { kind: "unplaced", failed: res.failed.map((f) => viewOf(f)) };
      for (const p of res.placed) {
        const it = items.find((x) => x.requestId === p.requestId);
        if (!it.block) {
          await writePlan(r, garageId, p.requestId, p.plan, it.vehicle, it.manual);
          continue;
        }
        const k = it.block, end = Math.max(k.end, p.plan.back);
        await r.cal.saveBlock(garageId, sub, k.id, { ...k, end, endsAt: R.parisInstant(k.day, end), slotId: null });
        await r.cal.replaceBlockAssignments(garageId, k.id, rowsOf(p.plan));
      }
      await r.cal.saveCalendar(garageId, sub, { mode: "advanced", step: 6, activated: true });
      // le calcul par ressources s'appuie sur les mécaniciens et les postes : leurs modules reviennent s'ils avaient été coupés
      const mods = W.modulesOf(b.settings && b.settings.modules);
      if (!mods.staff || !mods.equip) await r.saveSettings(garageId, sub, { modules: JSON.stringify(Object.fromEntries(W.MODULE_KEYS.map((k) => [k, k === "staff" || k === "equip" ? true : mods[k]]))) });
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
      // rendez-vous saisis : comptés dans le créneau qui contient leur heure (même plein : le garage les avait acceptés), sinon hors créneau
      const t = today();
      const bookings = await r.bookings(garageId, t, R.addDays(t, 400));
      for (const k of await r.cal.futureJobs(garageId)) {
        const minutes = k.minutes ?? Math.max(5, k.end - k.start);
        const pl = R.placeInSlot({ slots: b.slots, bookings, nowMs: now(), day: k.day, start: k.start, minutes, services: k.services, exclude: k.id });
        const slot = pl.slot || pl.full || null;
        if ((slot ? slot.id : null) !== k.slotId) await r.cal.setBlockSlot(garageId, k.id, slot ? slot.id : null);
        bookings.push({ id: k.id, slotId: slot ? slot.id : null, day: k.day, start: k.start, end: Math.min(1440, k.start + minutes), status: "confirmed", deadline: null });
      }
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
  // état de l'intervention (lot 3c) : null tant que rien n'a changé pour un rendez-vous hors Pixcar
  const workView = (o) => (o ? { status: o.status, at: iso(o.statusAt), noShow: o.noShow } : null);
  // rendez-vous saisi : label est le titre (client, sinon véhicule), client le nom tel que saisi ; back : restitution choisie par le
  // garage (absente : à la fin des travaux) ; slot : le créneau qui le compte (calcul par créneaux)
  const blockView = (k, rows, names, orders = [], slots = []) => {
    const plan = rows.filter((a) => a.blockId === k.id).map(planView(names));
    const job = k.kind === "job";
    return {
      id: k.id,
      kind: k.kind,
      label: job ? k.label || k.car || "Rendez-vous" : k.label,
      services: k.services.map((s) => ({ id: s.id, qty: s.qty, label: R.serviceText(s) })),
      vehicle: k.vehicle,
      when: { day: k.day, label: R.whenLabel(k.day, k.start), start: R.hm(k.start), end: R.hm(k.end) },
      startsAt: iso(k.startsAt),
      endsAt: iso(k.endsAt),
      fixed: k.fixed,
      ...(job
        ? {
            client: k.label, car: k.car, plate: k.plate, phone: k.phone, note: k.note, channel: k.channel, minutes: k.minutes,
            back: k.minutes !== null && k.end === Math.min(1440, k.start + k.minutes) ? null : R.hm(k.end),
            slot: (slots.find((x) => x.id === k.slotId) || { name: null }).name,
            work: workView(orders.find((o) => o.requestId === k.id)),
          }
        : { whole: !plan.length }),
      plan,
    };
  };
  // horaires encore proposés en ligne, jour par jour (calcul par créneaux) : les heures de début distinctes qu'au moins une prestation
  // proposée trouve libres, avec les mêmes règles que la réservation en ligne (délai minimal, pas, rendez-vous et blocages comptés)
  async function freeByDay(b, from, to, nowMs) {
    const s = b.settings;
    if (!s || !s.enabled || s.paused) return null;
    const t = R.parisParts(nowMs).iso;
    const settings = settingsOf(b);
    const args = { nowMs, ctx: ctxOf(b), settings, slots: b.slots, bookings: await repo.bookings(b.garageId, t, R.addDays(t, settings.horizonDays + 1)) };
    const seen = new Map();
    for (const id of b.offered || []) {
      const minutes = R.neededMinutes([{ id, qty: 1 }], b.minutes);
      if (minutes === null) continue;
      for (const d of R.freeTimes({ ...args, need: { services: [{ id, qty: 1 }], minutes } })) {
        if (d.day < from || d.day > to) continue;
        const set = seen.get(d.day) || new Set();
        for (const x of d.times) set.add(`${x.mode}:${x.start}`);
        seen.set(d.day, set);
      }
    }
    const out = {};
    for (let d = from; d <= to; d = R.addDays(d, 1)) out[d] = (seen.get(d) || new Set()).size;
    return out;
  }
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
    const ids = list.map((q) => q.id), jobs = blocks.filter((k) => k.kind === "job").map((k) => k.id);
    const [rows, orders, brows, conflicts, jobOrders] = await Promise.all([
      repo.cal.assignmentsOf(garageId, ids), repo.cal.workOrders(garageId, ids), repo.cal.blockAssignments(garageId, blocks.map((k) => k.id)), conflictsOf(garageId, b, data, nowMs), repo.cal.workOrders(garageId, jobs),
    ]);
    const names = new Map([...data.staff, ...data.resources].map((x) => [x.id, x.name]));
    const w = worldFrom(b, data, nowMs, { withBusy: false });
    const days = [];
    for (let d = from; d <= to; d = R.addDays(d, 1)) days.push({ day: d, open: P.openOn(w, d).map(([a, z]) => [R.hm(a), R.hm(z)]) });
    const adv = advanced(b);
    const free = adv ? null : await freeByDay(b, from, to, nowMs);
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
        // calcul par ressources : les prestations qui ont leurs exigences ; par créneaux : celles que le garage fait, avec leur temps moyen
        engine: adv ? "resources" : "slots",
        services: (b.offered || [])
          .filter((id) => !adv || data.reqs[id])
          .map((id) => ({ id, label: SERVICE_BY_ID.get(id).label, unit: SERVICE_BY_ID.get(id).unit || "", byVehicle: adv && Object.keys(data.reqs[id].vehicles || {}).length > 0, ...(adv ? {} : { minutes: Number.isInteger(b.minutes[id]) ? b.minutes[id] : null }) })),
        slots: adv ? [] : b.slots.map((x) => ({ id: x.id, name: x.name, days: x.days, start: R.hm(x.start), end: R.hm(x.end), mode: x.mode, capacity: x.capacity })),
        ...(free ? { free } : {}),
        vehicles: VEHICLES,
        unavail: data.unavail.filter((u) => u.start < toMs && u.end > fromMs).map((u) => ({ ...unavailView(u), name: names.get(u.targetId) || "" })),
        conflicts: [
          ...conflicts.map((c) => ({ id: c.id, reasons: c.reasons })),
          ...blockConflicts(w, brows, blocks, nowMs),
        ],
        blocks: blocks.map((k) => blockView(k, brows, names, jobOrders, b.slots)),
        appointments: list.map((q) => {
          const o = orders.find((x) => x.requestId === q.id);
          return {
            ...reqView(q),
            phone: q.phone || "",
            plate: q.plate || "",
            vehicle: (o && o.vehicle) || "",
            work: o ? { start: o.workStart && new Date(o.workStart).toISOString(), ready: o.readyAt && new Date(o.readyAt).toISOString(), back: o.returnAt && new Date(o.returnAt).toISOString(), labour: o.labour, ...workView(o) } : null,
            plan: rows.filter((a) => a.requestId === q.id).map(planView(names)),
          };
        }),
      },
      NO_STORE,
    );
  }

  // ---------------------------------------------------------------- blocs internes (lot 3b, Gestion d'atelier)
  // job, calcul par ressources : planifié par le moteur comme une demande, sans les règles de la réservation en ligne, travaux à l'heure
  // du dépôt ; si les ressources sont prises à cette heure-là, travaux au premier moment libre après le dépôt, mais seulement après
  // confirmation du garage (409 « shifted » : la cause, les horaires des travaux et de la restitution, d'autres horaires sans attente).
  // job, calcul par créneaux (docs/gestion-atelier.md 2.4) : compté dans le créneau qui contient son heure (R.placeInSlot), sur sa
  // durée estimée ; créneau plein : 409 « full » (la cause, d'autres heures du jour), enregistré quand même après confirmation.
  // hold : ses mécaniciens et postes doivent être libres ; sans choix, tout l'atelier : en calcul par ressources tous doivent l'être,
  // en calcul par créneaux les rendez-vous déjà là restent (409 « overlap », bloqué quand même après confirmation) et plus aucun
  // horaire en ligne n'est proposé pendant la plage.
  // ref : identifiant choisi par l'écran pour une création ; rejouée (double clic, reprise réseau), elle ne crée pas un second bloc.
  // Modification : les champs du client absents du corps sont gardés (un glisser-déposer n'envoie que le jour, l'heure et l'affectation).
  const holdRows = (v) => P.holdAssignments(v).map((a) => ({ target: a.target, targetId: a.targetId, role: a.role, day: v.day, start: R.parisInstant(v.day, a.a), end: R.parisInstant(v.day, a.b) }));
  const jobEnd = (k) => (k.minutes !== null && k.minutes !== undefined ? Math.min(1440, k.start + k.minutes) : k.end); // fin des travaux d'un rendez-vous saisi
  // d'autres heures du même jour où le rendez-vous trouve une place dans un créneau (les plus proches de l'heure voulue)
  function slotAlternatives(b, bookings, nowMs, v, minutes, exclude) {
    const cands = [];
    for (let t = 0; t < 1440; t += 15) if (t !== v.start && R.parisInstant(v.day, t) > nowMs) cands.push(t);
    cands.sort((x, y) => Math.abs(x - v.start) - Math.abs(y - v.start) || x - y);
    const out = [];
    for (const t of cands) {
      if (R.placeInSlot({ slots: b.slots, bookings, nowMs, day: v.day, start: t, minutes, services: v.services, exclude }).slot) out.push({ day: v.day, start: t, end: Math.min(1440, t + minutes) });
      if (out.length >= 3) break;
    }
    return out.sort((x, y) => x.start - y.start);
  }
  const fullText = (slot, busy, start) =>
    `« ${slot.name} » est complet à ${R.timeLabel(start)} : ${busy} ${busy > 1 ? "voitures déjà prévues" : "voiture déjà prévue"} pour ${slot.capacity} ${slot.capacity > 1 ? "places" : "place"}.`;
  async function saveBlock(garageId, sub, id, body) {
    const nowMs = now();
    const ref = !id && body && typeof body.ref === "string" && isUuid(body.ref) ? body.ref.toLowerCase() : null;
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      if (ref) {
        const seen = await r.cal.blockById(ref);
        if (seen) return seen.garageId === garageId ? { kind: "ok", saved: ref, replay: true } : { kind: "invalid", p: { error: "Identifiant de création déjà utilisé : rechargez la page.", field: "ref" } };
      }
      const b = await r.bundle(garageId, R.parisParts(nowMs).iso);
      const adv = advanced(b);
      const prev = id ? await r.cal.getBlock(garageId, id) : null;
      if (id && !prev) return { kind: "not_found" };
      if (!id && (await r.cal.countBlocks(garageId)) >= P.MAX_BLOCKS) return { kind: "too_many" };
      const w = adv ? await world(r, b, nowMs, { exclude: id }) : null;
      const p = P.parseBlock(
        body,
        adv
          ? { staffIds: new Set(w.staff.map((m) => m.id)), resourceIds: new Set(w.resources.map((x) => x.id)), serviceIds: new Set(Object.keys(w.reqs)), nowMs }
          : { staffIds: new Set(), resourceIds: new Set(), serviceIds: new Set(b.offered || []), nowMs, serviceText: "Prestation inconnue : cochez-la d'abord dans Mon garage › Prestations." },
      );
      if (p.error) return { kind: "invalid", p };
      const v = p.value;
      if (prev && prev.kind !== v.kind) return { kind: "invalid", p: { error: "Un rendez-vous ne devient pas un créneau bloqué, ni l'inverse : supprimez-le, puis créez l'autre.", field: "kind" } };
      // une intervention commencée ne change plus d'heure ni de jour (lot 3c)
      if (prev && (prev.day !== v.day || prev.start !== v.start) && W.workState(await r.cal.workOrder(prev.id)) !== "planned") return { kind: "started" };
      // client déjà sur place (lot 3c) : rendez-vous saisi d'aujourd'hui, au plus tard au prochain quart d'heure, reçu aussitôt
      const arrived = body.received === true;
      if (arrived && (id || v.kind !== "job" || v.day !== R.parisParts(nowMs).iso || R.parisInstant(v.day, v.start) > nowMs + 15 * 60e3))
        return { kind: "invalid", p: { error: "Client déjà sur place : un rendez-vous d'aujourd'hui, à l'heure actuelle.", field: "time" } };
      let row, rows = [];
      if (v.kind === "job") {
        const was = prev;
        const keep = (k, dflt) => (v[k] !== undefined ? v[k] : was ? was[k] : dflt);
        const f = { client: v.client !== undefined ? v.client : was ? was.label : "", car: keep("car", ""), plate: keep("plate", ""), phone: keep("phone", ""), note: keep("note", ""), channel: keep("channel", "phone") };
        if ([...f.client].length < 2 && [...f.car].length < 2) return { kind: "invalid", p: { error: "Indiquez le nom du client ou le véhicule.", field: "label" } };
        const base = { kind: "job", label: f.client, services: v.services, vehicle: v.vehicle, mode: "hour", day: v.day, start: v.start, ...f };
        if (adv) {
          const job = P.buildJob(v.services, w.reqs, v.vehicle);
          if (job.error) return { kind: "not_configured" };
          if (job.needVehicle && !v.vehicle) return { kind: "invalid", p: { error: "Type de véhicule : une prestation en dépend.", field: "vehicle" } };
          const forced = v.staff.length || v.station ? { staff: v.staff, station: v.station } : null;
          const at = { day: v.day, start: v.start, mode: "hour", forced };
          const exact = P.explain(w, job, { ...at, float: false });
          let plan = exact.plan;
          if (!plan) {
            const later = P.explain(w, job, { ...at, float: true });
            if (!later.plan) return { kind: "conflict", reasons: later.reasons.map((x) => x.text), alternatives: later.alternatives.map(altView) };
            // une modification qui garde l'heure de dépôt (libellé, prestation…) ne redemande pas : l'attente était déjà acceptée
            const kept = prev && prev.day === v.day && prev.start === v.start;
            if (body.confirm !== true && !kept) return { kind: "shifted", plan: later.plan, reasons: exact.reasons.map((x) => x.text), alternatives: exact.alternatives.map(altView) };
            plan = later.plan;
          }
          // restitution annoncée par le garage : gardée si elle vient après celle du moteur
          const end = v.back !== undefined && v.back !== null && v.back > plan.back ? v.back : plan.back;
          row = { ...base, end, startsAt: R.parisInstant(v.day, v.start), endsAt: R.parisInstant(v.day, end), fixed: !!forced, slotId: null, minutes: keep("minutes", null) ?? plan.labour };
          rows = rowsOf(plan);
        } else {
          const minutes = keep("minutes", null) ?? R.neededMinutes(v.services, b.minutes) ?? 60;
          // restitution : celle du corps ; sinon, en modification, le même écart avec l'heure de dépôt s'il avait été choisi ; sinon la fin des travaux
          let back = v.back;
          if (back === undefined) back = was && was.minutes !== null && was.end !== Math.min(1440, was.start + was.minutes) ? Math.min(1440, v.start + (was.end - was.start)) : null;
          if (back !== null && back < v.start + minutes) {
            if (v.back !== undefined) return { kind: "invalid", p: { error: `Restitution : après la fin des travaux (${R.timeLabel(Math.min(1440, v.start + minutes))}).`, field: "back" } };
            back = null;
          }
          const end = back ?? Math.min(1440, v.start + minutes);
          const bookings = await r.bookings(garageId, v.day, v.day);
          const pl = R.placeInSlot({ slots: b.slots, bookings, nowMs, day: v.day, start: v.start, minutes, services: v.services, exclude: id });
          // une modification qui ne change ni l'heure ni le jour et n'allonge pas les travaux ne redemande pas : le garage avait accepté
          const kept = prev && prev.day === v.day && prev.start === v.start && minutes <= (prev.minutes ?? minutes);
          if (pl.full && body.confirm !== true && !kept) return { kind: "full", text: fullText(pl.full, pl.busy, v.start), alternatives: slotAlternatives(b, bookings, nowMs, v, minutes, id).map(altView) };
          row = { ...base, end, startsAt: R.parisInstant(v.day, v.start), endsAt: R.parisInstant(v.day, end), fixed: false, slotId: (pl.slot || pl.full || {}).id || null, minutes };
        }
      } else {
        const hold = { kind: "hold", label: v.label, services: [], vehicle: "", mode: "hour", day: v.day, start: v.start, end: v.end, startsAt: R.parisInstant(v.day, v.start), endsAt: R.parisInstant(v.day, v.end), fixed: true };
        if (adv) {
          // tout l'atelier : chaque mécanicien et chaque poste actifs doivent être libres
          const all = v.whole ? { ...v, staff: w.staff.filter((m) => m.active).map((m) => m.id), resources: w.resources.filter((x) => x.active).map((x) => x.id) } : v;
          const c = P.checkHold(w, all);
          if (c.fail) return { kind: "conflict", reasons: c.fail.map((x) => x.text), alternatives: [] };
          rows = v.whole ? [] : holdRows(v);
        } else {
          const bookings = await r.bookings(garageId, v.day, v.day);
          const jobs = (await r.cal.blocksBetween(garageId, v.day, v.day)).filter((k) => k.kind === "job" && k.id !== id && !k.slotId);
          const there = [...bookings.filter((x) => !x.hold && x.id !== id && R.holds(x, nowMs)), ...jobs.map((k) => ({ id: k.id, start: k.start, end: jobEnd(k) }))].filter((x) => x.start < v.end && x.end > v.start);
          const kept = prev && prev.day === v.day && prev.start <= v.start && prev.end >= v.end;
          if (there.length && body.confirm !== true && !kept) {
            const at = [...new Set(there.map((x) => x.start))].sort((x, y) => x - y).map(R.timeLabel);
            return { kind: "overlap", text: `${there.length > 1 ? `${there.length} rendez-vous sont déjà prévus` : "Un rendez-vous est déjà prévu"} pendant cette plage (${at.slice(0, 4).join(", ")}${at.length > 4 ? "…" : ""}) : ${there.length > 1 ? "ils restent" : "il reste"} à ${there.length > 1 ? "leur" : "sa"} place.`, count: there.length };
          }
        }
        row = hold;
      }
      const saved = await r.cal.saveBlock(garageId, sub, id, row, { newId: ref });
      if (!saved) return { kind: "not_found" };
      await r.cal.replaceBlockAssignments(garageId, saved, rows);
      await r.cal.log(garageId, sub, "block", saved, `${v.kind === "job" ? "Rendez-vous hors Pixcar" : v.whole ? "Créneau bloqué (tout l'atelier)" : "Créneau bloqué"} ${id ? "modifié" : "ajouté"} : ${R.whenLabel(v.day, v.start)}.`);
      if (arrived) {
        await r.cal.setWork(garageId, saved, "received", nowMs);
        await r.cal.log(garageId, sub, "work", saved, `Intervention hors Pixcar du ${R.whenLabel(v.day, v.start)} : ${W.workLabel("received")}.`);
      }
      return { kind: "ok", saved };
    });
    switch (out.kind) {
      case "not_found":
        return notFound("Bloc introuvable.");
      case "started":
        return apiError(409, "started", "L'intervention a commencé : elle ne change plus de jour ni d'heure.");
      case "too_many":
        return apiError(409, "too_many", `${P.MAX_BLOCKS} blocs à venir au plus.`);
      case "invalid":
        return invalid(out.p);
      case "not_configured":
        return apiError(409, "not_configured", "Une prestation n'a pas ses exigences (Calendrier › Prestations).");
      case "conflict":
        return apiError(409, "conflict", out.reasons[0] || "Impossible à cette heure-là.", { reasons: out.reasons, alternatives: out.alternatives });
      case "full":
        return apiError(409, "full", `${out.text} Enregistrez quand même, ou choisissez une autre heure.`, { reasons: [out.text], alternatives: out.alternatives });
      case "overlap":
        return apiError(409, "overlap", `${out.text} Bloquez quand même pour ne plus rien proposer en ligne pendant cette plage, ou choisissez-en une autre.`, { reasons: [out.text], count: out.count });
      case "shifted": {
        const work = { start: R.hm(out.plan.workStart), end: R.hm(out.plan.workEnd) }, back = R.hm(out.plan.back);
        const cause = out.reasons[0] ? `${out.reasons[0]} ` : "";
        return apiError(
          409,
          "shifted",
          `${cause}Travaux de ${R.timeLabel(out.plan.workStart)} à ${R.timeLabel(out.plan.workEnd)}, voiture prête vers ${R.timeLabel(out.plan.back)} : confirmez, ou choisissez un horaire sans attente.`,
          { reasons: out.reasons, alternatives: out.alternatives, work, back },
        );
      }
      default:
        if (!out.replay) log({ level: "info", msg: id ? "calendrier : bloc modifié" : "calendrier : bloc ajouté", event: "cal_block", garageId });
        return json(id || out.replay ? 200 : 201, { saved: out.saved, ...(out.replay ? { replay: true } : {}) }, NO_STORE);
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
  // Calcul par créneaux (Gestion d'atelier) : compté dans le créneau qui contient la nouvelle heure (R.placeInSlot) ; plein, le
  // garage le déplace quand même s'il confirme (la confirmation est demandée de toute façon : le client est prévenu par e-mail).
  async function moveInSlots(r, b, q, { day, start, forced, confirm, nowMs, sub }) {
    if (forced) return { kind: "simple" };
    if (W.workState(await r.cal.workOrder(q.id)) !== "planned") return { kind: "started" };
    if (day === q.day && start === q.start_min) return { kind: "ok", moved: false };
    if (R.parisInstant(day, start) <= nowMs) return { kind: "past" };
    const minutes = q.minutes || q.end_min - q.start_min;
    const pl = R.placeInSlot({ slots: b.slots, bookings: await r.bookings(b.garageId, day, day), nowMs, day, start, minutes, services: q.services, exclude: q.id });
    const slot = pl.slot || pl.full || null;
    const end = q.mode === "drop" && slot && slot.mode === "drop" ? slot.end : Math.min(1440, start + minutes);
    if (!confirm) return { kind: "confirm", when: { label: R.whenLabel(day, start), back: R.hm(end) }, full: pl.full ? fullText(pl.full, pl.busy, start) : "" };
    await r.reschedule(q.id, b.garageId, { day, start, end, startsAt: R.parisInstant(day, start), endsAt: R.parisInstant(day, end), slotId: slot ? slot.id : P.NIL_SLOT });
    await r.cal.log(b.garageId, sub, "move", q.id, `Rendez-vous déplacé au ${R.whenLabel(day, start)}${slot ? ` (${slot.name}${pl.full ? ", complet" : ""})` : " (hors des créneaux)"}.`);
    return { kind: "ok", moved: true };
  }
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
      if (!advanced(b)) return moveInSlots(r, b, q, { day: b0.day, start, forced, confirm: b0.confirm === true, nowMs, sub });
      const w = await world(r, b, nowMs, { exclude: id });
      if (forced && (forced.staff.some((x) => !w.staff.some((m) => m.id === x)) || (forced.station && !w.resources.some((x) => x.id === forced.station)))) return { kind: "unknown" };
      const order = await r.cal.workOrder(id);
      if (W.workState(order) !== "planned") return { kind: "started" };
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
      case "started":
        return apiError(409, "started", "L'intervention a commencé : le rendez-vous ne se déplace plus.");
      case "simple":
        return apiError(409, "simple_mode", "Choisir un mécanicien ou un poste demande le calcul par ressources.");
      case "past":
        return apiError(409, "conflict", "Cet horaire est passé.", { reasons: ["Cet horaire est passé."], alternatives: [] });
      case "unknown":
        return apiError(422, "validation", "Mécanicien ou poste inconnu.");
      case "not_configured":
        return apiError(409, "not_configured", "Une prestation de ce rendez-vous n'a pas ses exigences (Calendrier › Prestations).");
      case "conflict":
        return apiError(409, "conflict", out.reasons[0] || "Impossible à cette heure-là.", { reasons: out.reasons, alternatives: out.alternatives });
      case "confirm":
        return apiError(409, "confirm", `${out.full ? `${out.full} ` : ""}Le client sera prévenu par e-mail du nouvel horaire : ${out.when.label} (restitution prévue vers ${R.timeLabel(R.minOf(out.when.back))}). Confirmez le déplacement.`, { when: out.when, ...(out.full ? { full: true } : {}) });
      default:
        break;
    }
    if (out.moved) await drain({ requestIds: [id] });
    log({ level: "info", msg: out.moved ? "calendrier : rendez-vous déplacé" : "calendrier : rendez-vous réaffecté", event: "cal_move", garageId, moved: out.moved });
    return json(200, garageView(await repo.getForGarage(garageId, id)), NO_STORE);
  }

  // ---------------------------------------------------------------- suivi des interventions (lot 3c, src/js/shared/work.js)
  // id : une demande Pixcar confirmée, ou un rendez-vous saisi par le garage (bloc « job »), dans les deux calculs des disponibilités
  // (Gestion d'atelier). Passé « Prête », le client d'un rendez-vous Pixcar est prévenu par e-mail sauf notify: false (une seule fois).
  async function setWork(garageId, sub, id, body) {
    const p = W.parseWork(body);
    if (p.error) return invalid(p);
    const nowMs = now();
    const t = R.parisParts(nowMs).iso;
    const out = await repo.tx(async (r) => {
      await r.lockGarage(garageId);
      const q = await r.getForGarage(garageId, id);
      const k = q ? null : await r.cal.getBlock(garageId, id);
      if (!q && (!k || k.kind !== "job")) return { kind: "not_found" };
      if (q && q.status !== "confirmed") return { kind: "not_confirmed" };
      const at = q ? { day: q.day, start: q.start_min, startsAt: q.starts_at } : { day: k.day, start: k.start, startsAt: k.startsAt };
      const from = W.workState(await r.cal.workOrder(id));
      const c = W.checkWork({ from, to: p.value.status, day: at.day, today: t, started: nowMs >= at.startsAt });
      if (c.error) return { kind: "refused", c };
      await r.cal.setWork(garageId, id, p.value.status, nowMs);
      const notified = !!q && p.value.status === "done" && p.value.notify && !!q.email && (await r.readyMail(id, garageId));
      await r.cal.log(garageId, sub, "work", id, `Intervention ${q ? "Pixcar" : "hors Pixcar"} du ${R.whenLabel(at.day, at.start)} : ${W.workLabel(p.value.status)}${notified ? " (client prévenu par e-mail)" : ""}.`);
      return { kind: "ok", notified, order: await r.cal.workOrder(id) };
    });
    switch (out.kind) {
      case "not_found":
        return notFound("Rendez-vous introuvable.");
      case "not_confirmed":
        return apiError(409, "state", "Ce rendez-vous n'est pas confirmé : répondez d'abord à la demande.");
      case "refused":
        return apiError(409, out.c.code, out.c.error);
      default:
        break;
    }
    if (out.notified) await drain({ requestIds: [id] });
    log({ level: "info", msg: "calendrier : état d'une intervention", event: "cal_work", garageId, status: p.value.status, notified: out.notified });
    return json(200, { id, work: workView(out.order), notified: out.notified }, NO_STORE);
  }

  // ---------------------------------------------------------------- aiguillage
  async function route(request, sub, garageId, parts, readBody) {
    const method = request.method;
    const [what, id, extra] = parts;
    if (extra || (id && !["staff", "skills", "resources", "unavail", "services", "blocks", "work"].includes(what))) return notFound("Route inconnue.");
    if (!what) return method === "GET" ? state(garageId) : allow("GET");
    if (what === "agenda") return method === "GET" ? agenda(garageId, new URL(request.url)) : allow("GET");
    if (what === "start") return method === "POST" ? start(garageId, sub) : allow("POST");
    if (what === "settings") return method === "PUT" ? putSettings(garageId, sub, await readBody()) : allow("PUT");
    if (what === "check") return method === "POST" ? check(garageId, await readBody(16384)) : allow("POST");
    if (what === "activate") return method === "POST" ? activate(garageId, sub, await readBody(16384)) : allow("POST");
    if (what === "simple") return method === "POST" ? toSimple(garageId, sub) : allow("POST");
    if (what === "work") {
      if (!id || !isUuid(id)) return notFound("Rendez-vous introuvable.");
      return method === "POST" ? setWork(garageId, sub, id.toLowerCase(), await readBody(512)) : allow("POST");
    }
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
