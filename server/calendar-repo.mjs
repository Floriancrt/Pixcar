// Calendrier avancé (docs/calendrier-avance.md, lot 3a) : le SQL des mécaniciens, compétences, postes, exigences des prestations,
// absences, affectations, interventions et historique. Mêmes règles que server/rdv-repo.mjs (SQL portable PostgreSQL / PGlite / Aurora
// DSQL, horloge de l'application en $n::timestamptz) ; bindCalendar(q) est lié à la même requête ou transaction que le dépôt des
// rendez-vous (r.cal dans rdv-repo), pour que la prise d'horaire relise et écrive les affectations dans la même transaction.

const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
const iso = (msv) => new Date(msv).toISOString();
const placeholders = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");
const PURGE_BATCH = 1000;

const CAL_COLUMNS = "garage_id, mode, step, reception_min, return_min, load_pct, max_day, auto_assign, activated_at, updated_at";
export const calOf = (r) =>
  r && { mode: r.mode, step: r.step, receptionMin: r.reception_min, returnMin: r.return_min, loadPct: r.load_pct, maxDay: r.max_day, autoAssign: r.auto_assign, activatedAt: ms(r.activated_at) };
export const DEFAULT_CAL = { mode: "simple", step: 0, receptionMin: 10, returnMin: 15, loadPct: 100, maxDay: 0, autoAssign: true, activatedAt: null };
const CAL_FIELDS = { mode: "mode", step: "step", receptionMin: "reception_min", returnMin: "return_min", loadPct: "load_pct", maxDay: "max_day", autoAssign: "auto_assign" };

const staffOf = (r, skills) => ({ id: r.id, name: r.name, active: r.active, hours: r.hours || null, services: Array.isArray(r.services) ? r.services : null, position: r.position, skills: skills.filter((s) => s.staff_id === r.id).map((s) => ({ id: s.skill_id, until: s.until || null })) });
const resourceOf = (r) => ({ id: r.id, name: r.name, type: r.type, active: r.active, hours: r.hours || null, services: Array.isArray(r.services) ? r.services : null, position: r.position });
const reqOf = (r) => ({
  online: r.online, labour: r.labour_min, shared: r.shared_min, immob: r.immob_min, staffN: r.staff_n, skills: r.skills || [], stations: r.stations || [], tools: r.tools || [], margin: r.margin_min,
  auto: r.auto, parts: r.parts, partsH: r.parts_h, drop: r.drop_off, vehicles: r.vehicles || {},
});
const unavailOf = (r) => ({ id: r.id, target: r.target, targetId: r.target_id, start: ms(r.starts_at), end: ms(r.ends_at), kind: r.kind, label: r.label });
const workOrderOf = (r) =>
  r && {
    requestId: r.request_id, status: r.status, vehicle: r.vehicle, workStart: ms(r.work_start), workEnd: ms(r.work_end), readyAt: ms(r.ready_at), returnAt: ms(r.return_at), labour: r.labour_min, immob: r.immob_min,
    statusAt: ms(r.status_at), noShow: !!r.no_show_at,
  };

const blockOf = (r) =>
  r && {
    id: r.id, kind: r.kind, label: r.label, services: Array.isArray(r.services) ? r.services : [], vehicle: r.vehicle, mode: r.mode, day: r.day, start: r.start_min, end: r.end_min,
    startsAt: ms(r.starts_at), endsAt: ms(r.ends_at), fixed: r.fixed,
  };
const BLOCK_COLUMNS = "id, kind, label, services, vehicle, mode, day::text AS day, start_min, end_min, starts_at, ends_at, fixed";

// inTx : lié à la connexion d'une transaction (les requêtes passent l'une après l'autre), sinon au pool (en parallèle)
export function bindCalendar(q, { now = Date.now, inTx = false } = {}) {
  const T = () => new Date(now()).toISOString();
  const one = async (sql, params) => (await q.query(sql, params)).rows[0] || null;
  const all = async (sql, params) => (await q.query(sql, params)).rows;
  const each = async (thunks) => {
    if (!inTx) return Promise.all(thunks.map((f) => f()));
    const out = [];
    for (const f of thunks) out.push(await f());
    return out;
  };

  return {
    // ---- réglages
    getCalendar: (garageId) => one(`SELECT ${CAL_COLUMNS} FROM rdv_calendar WHERE garage_id = $1`, [garageId]).then(calOf),
    // fields : { mode, step, receptionMin, returnMin, loadPct, maxDay, autoAssign, activated } (présents seulement)
    async saveCalendar(garageId, accountId, fields) {
      const cols = Object.keys(fields).filter((k) => CAL_FIELDS[k]).map((k) => [CAL_FIELDS[k], fields[k]]);
      if (fields.activated) cols.push(["activated_at", T()]);
      const sets = cols.map(([c], i) => `${c} = $${i + 3}`);
      const row = await one(
        `INSERT INTO rdv_calendar (garage_id, account_id${cols.map(([c]) => ", " + c).join("")}, updated_at) VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join("")}, now())
         ON CONFLICT (garage_id) DO UPDATE SET account_id = EXCLUDED.account_id${sets.map((s) => ", " + s).join("")}, updated_at = now() RETURNING ${CAL_COLUMNS}`,
        [garageId, accountId, ...cols.map(([, v]) => v)],
      );
      return calOf(row);
    },

    // ---- ce que le moteur lit pour un garage (src/js/shared/plan.js) ; fromIso / toIso : jours des affectations
    async load(garageId, fromIso, toIso) {
      const [staff, skillRows, skills, resources, reqs, unavail, busy] = await each([
        () => all("SELECT id, name, active, hours, services, position FROM rdv_staff WHERE garage_id = $1 ORDER BY position, created_at, id", [garageId]),
        () => all("SELECT staff_id, skill_id, until::text AS until FROM rdv_staff_skills WHERE garage_id = $1", [garageId]),
        () => all("SELECT id, label, cert FROM rdv_skills WHERE garage_id = $1 ORDER BY created_at, id", [garageId]),
        () => all("SELECT id, name, type, active, hours, services, position FROM rdv_resources WHERE garage_id = $1 ORDER BY position, created_at, id", [garageId]),
        () => all("SELECT * FROM rdv_service_reqs WHERE garage_id = $1", [garageId]),
        () => all("SELECT id, target, target_id, starts_at, ends_at, kind, label FROM rdv_unavail WHERE garage_id = $1 AND ends_at > $2::timestamptz ORDER BY starts_at, id", [garageId, T()]),
        () => this.busy(garageId, fromIso, toIso),
      ]);
      return {
        staff: staff.map((r) => staffOf(r, skillRows)),
        skills: skills.map((r) => ({ id: r.id, label: r.label, cert: r.cert })),
        resources: resources.map(resourceOf),
        reqs: Object.fromEntries(reqs.map((r) => [r.service_id, reqOf(r)])),
        unavail: unavail.map(unavailOf),
        busy,
      };
    },
    // Affectations du jour fromIso au jour toIso, avec l'état de leur demande (le moteur ne garde que celles qui retiennent encore) et le
    // client absent (lot 3c : sa place se reprend), noté sur l'intervention de la demande ou du rendez-vous hors Pixcar
    busy: (garageId, fromIso, toIso) =>
      all(
        `SELECT a.request_id, a.block_id, a.target, a.target_id, a.role, a.starts_at, a.ends_at, a.fixed, r.status, r.deadline, w.no_show_at, wb.no_show_at AS block_no_show_at
         FROM rdv_assignments a LEFT JOIN rdv_requests r ON r.id = a.request_id
           LEFT JOIN rdv_work_orders w ON w.request_id = a.request_id LEFT JOIN rdv_work_orders wb ON wb.request_id = a.block_id
         WHERE a.garage_id = $1 AND a.day BETWEEN $2::date AND $3::date`,
        [garageId, fromIso, toIso],
      ).then((rows) =>
        rows.map((r) => ({
          requestId: r.request_id, blockId: r.block_id, target: r.target, targetId: r.target_id, role: r.role, start: ms(r.starts_at), end: ms(r.ends_at), fixed: r.fixed, status: r.status, deadline: ms(r.deadline),
          noShow: !!(r.no_show_at || r.block_no_show_at),
        })),
      ),

    // ---- mécaniciens
    countStaff: (garageId) => one("SELECT count(*)::int AS n FROM rdv_staff WHERE garage_id = $1", [garageId]).then((r) => r.n),
    async saveStaff(garageId, id, s) {
      const row = id
        ? await one("UPDATE rdv_staff SET name = $3, active = $4, hours = $5::jsonb, services = $6::jsonb, updated_at = now() WHERE id = $1 AND garage_id = $2 RETURNING id", [id, garageId, s.name, s.active, JSON.stringify(s.hours), JSON.stringify(s.services)])
        : await one(
            "INSERT INTO rdv_staff (id, garage_id, name, active, hours, services, position) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, (SELECT coalesce(max(position) + 1, 0) FROM rdv_staff WHERE garage_id = $2)) RETURNING id",
            [crypto.randomUUID(), garageId, s.name, s.active, JSON.stringify(s.hours), JSON.stringify(s.services)],
          );
      if (!row) return null;
      await q.query("DELETE FROM rdv_staff_skills WHERE staff_id = $1 AND garage_id = $2", [row.id, garageId]);
      for (const k of s.skills) await q.query("INSERT INTO rdv_staff_skills (garage_id, staff_id, skill_id, until) VALUES ($1, $2, $3, $4::date)", [garageId, row.id, k.id, k.until]);
      return row.id;
    },
    async deleteStaff(garageId, id) {
      const r = await q.query("DELETE FROM rdv_staff WHERE id = $1 AND garage_id = $2", [id, garageId]);
      if (!r.rowCount) return false;
      await q.query("DELETE FROM rdv_staff_skills WHERE staff_id = $1 AND garage_id = $2", [id, garageId]);
      await q.query("DELETE FROM rdv_unavail WHERE target_id = $1 AND garage_id = $2", [id, garageId]);
      return true;
    },

    // ---- compétences
    countSkills: (garageId) => one("SELECT count(*)::int AS n FROM rdv_skills WHERE garage_id = $1", [garageId]).then((r) => r.n),
    async saveSkill(garageId, id, s) {
      const row = id
        ? await one("UPDATE rdv_skills SET label = $3, cert = $4 WHERE id = $1 AND garage_id = $2 RETURNING id", [id, garageId, s.label, s.cert])
        : await one("INSERT INTO rdv_skills (id, garage_id, label, cert, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id", [crypto.randomUUID(), garageId, s.label, s.cert, s.at || T()]);
      return row && row.id;
    },
    // une compétence supprimée disparaît des fiches et des exigences
    async deleteSkill(garageId, id) {
      const r = await q.query("DELETE FROM rdv_skills WHERE id = $1 AND garage_id = $2", [id, garageId]);
      if (!r.rowCount) return false;
      await q.query("DELETE FROM rdv_staff_skills WHERE skill_id = $1 AND garage_id = $2", [id, garageId]);
      for (const row of await all("SELECT service_id, skills FROM rdv_service_reqs WHERE garage_id = $1", [garageId]))
        if ((row.skills || []).includes(id)) await q.query("UPDATE rdv_service_reqs SET skills = $3::jsonb, updated_at = now() WHERE garage_id = $1 AND service_id = $2", [garageId, row.service_id, JSON.stringify(row.skills.filter((x) => x !== id))]);
      return true;
    },

    // ---- postes et équipements
    countResources: (garageId) => one("SELECT count(*)::int AS n FROM rdv_resources WHERE garage_id = $1", [garageId]).then((r) => r.n),
    async saveResource(garageId, id, s) {
      const row = id
        ? await one("UPDATE rdv_resources SET name = $3, type = $4, active = $5, hours = $6::jsonb, services = $7::jsonb, updated_at = now() WHERE id = $1 AND garage_id = $2 RETURNING id", [id, garageId, s.name, s.type, s.active, JSON.stringify(s.hours), JSON.stringify(s.services)])
        : await one(
            "INSERT INTO rdv_resources (id, garage_id, name, type, active, hours, services, position) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, (SELECT coalesce(max(position) + 1, 0) FROM rdv_resources WHERE garage_id = $2)) RETURNING id",
            [crypto.randomUUID(), garageId, s.name, s.type, s.active, JSON.stringify(s.hours), JSON.stringify(s.services)],
          );
      return row && row.id;
    },
    async deleteResource(garageId, id) {
      const r = await q.query("DELETE FROM rdv_resources WHERE id = $1 AND garage_id = $2", [id, garageId]);
      if (!r.rowCount) return false;
      await q.query("DELETE FROM rdv_unavail WHERE target_id = $1 AND garage_id = $2", [id, garageId]);
      return true;
    },
    // affectations à venir d'un mécanicien ou d'un poste (on ne supprime pas une ressource engagée)
    futureUses: (garageId, targetId) =>
      one(
        `SELECT count(DISTINCT a.request_id)::int AS n FROM rdv_assignments a JOIN rdv_requests r ON r.id = a.request_id
         WHERE a.garage_id = $1 AND a.target_id = $2 AND a.ends_at > $3::timestamptz AND r.status IN ('pending', 'confirmed')`,
        [garageId, targetId, T()],
      ).then((r) => r.n),

    // ---- exigences des prestations
    saveReq: (garageId, serviceId, v) =>
      q.query(
        `INSERT INTO rdv_service_reqs (garage_id, service_id, online, labour_min, shared_min, immob_min, staff_n, skills, stations, tools, margin_min, auto, parts, parts_h, drop_off, vehicles, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, now())
         ON CONFLICT (garage_id, service_id) DO UPDATE SET online = EXCLUDED.online, labour_min = EXCLUDED.labour_min, shared_min = EXCLUDED.shared_min, immob_min = EXCLUDED.immob_min,
           staff_n = EXCLUDED.staff_n, skills = EXCLUDED.skills, stations = EXCLUDED.stations, tools = EXCLUDED.tools, margin_min = EXCLUDED.margin_min, auto = EXCLUDED.auto, parts = EXCLUDED.parts,
           parts_h = EXCLUDED.parts_h, drop_off = EXCLUDED.drop_off, vehicles = EXCLUDED.vehicles, updated_at = now()`,
        [garageId, serviceId, v.online, v.labour, v.shared, v.immob, v.staffN, JSON.stringify(v.skills), JSON.stringify(v.stations), JSON.stringify(v.tools), v.margin, v.auto, v.parts, v.partsH, v.drop, JSON.stringify(v.vehicles)],
      ),

    // ---- absences et maintenances
    countUnavail: (garageId) => one("SELECT count(*)::int AS n FROM rdv_unavail WHERE garage_id = $1 AND ends_at > $2::timestamptz", [garageId, T()]).then((r) => r.n),
    createUnavail: (garageId, u) =>
      one("INSERT INTO rdv_unavail (id, garage_id, target, target_id, starts_at, ends_at, kind, label) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8) RETURNING id", [
        crypto.randomUUID(), garageId, u.target, u.targetId, iso(u.start), iso(u.end), u.kind, u.label,
      ]).then((r) => r.id),
    deleteUnavail: (garageId, id) => q.query("DELETE FROM rdv_unavail WHERE id = $1 AND garage_id = $2", [id, garageId]).then((r) => r.rowCount > 0),
    getUnavail: (garageId, id) => one("SELECT id, target, target_id, starts_at, ends_at, kind, label FROM rdv_unavail WHERE id = $1 AND garage_id = $2", [id, garageId]).then((r) => r && unavailOf(r)),
    // rendez-vous à venir dont une affectation touche cette ressource pendant [start, end[ (conflits à montrer, jamais déplacés)
    conflicts: (garageId, targetIds, start, end) =>
      targetIds.length
        ? all(
            `SELECT DISTINCT a.request_id FROM rdv_assignments a JOIN rdv_requests r ON r.id = a.request_id
             WHERE a.garage_id = $1 AND a.target_id IN (${placeholders(targetIds.length, 4)}) AND a.starts_at < $3::timestamptz AND a.ends_at > $2::timestamptz AND r.status IN ('pending', 'confirmed')`,
            [garageId, iso(start), iso(end), ...targetIds],
          ).then((rows) => rows.map((r) => r.request_id))
        : Promise.resolve([]),

    // ---- affectations d'un rendez-vous : rows [{ target, targetId, role, day, start, end (ms) }]
    async replaceAssignments(garageId, requestId, rows, { fixed = false } = {}) {
      await q.query("DELETE FROM rdv_assignments WHERE request_id = $1 AND garage_id = $2", [requestId, garageId]);
      for (const a of rows)
        await q.query("INSERT INTO rdv_assignments (id, garage_id, request_id, target, target_id, role, day, starts_at, ends_at, fixed) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::timestamptz, $9::timestamptz, $10)", [
          crypto.randomUUID(), garageId, requestId, a.target, a.targetId, a.role, a.day, iso(a.start), iso(a.end), fixed,
        ]);
    },
    assignmentsOf: (garageId, requestIds) =>
      requestIds.length
        ? all(`SELECT request_id, target, target_id, role, starts_at, ends_at, fixed FROM rdv_assignments WHERE garage_id = $1 AND request_id IN (${placeholders(requestIds.length, 2)}) ORDER BY starts_at, role`, [garageId, ...requestIds]).then((rows) =>
            rows.map((r) => ({ requestId: r.request_id, target: r.target, targetId: r.target_id, role: r.role, start: ms(r.starts_at), end: ms(r.ends_at), fixed: r.fixed })),
          )
        : Promise.resolve([]),

    // ---- blocs internes (lot 3b) : b = { kind, label, services, vehicle, mode, day, start, end, startsAt, endsAt, fixed }
    countBlocks: (garageId) => one("SELECT count(*)::int AS n FROM rdv_blocks WHERE garage_id = $1 AND ends_at > $2::timestamptz", [garageId, T()]).then((r) => r.n),
    async saveBlock(garageId, accountId, id, b) {
      const vals = [b.kind, b.label, JSON.stringify(b.services || []), b.vehicle || "", b.mode || "hour", b.day, b.start, b.end, iso(b.startsAt), iso(b.endsAt), !!b.fixed];
      const row = id
        ? await one(
            `UPDATE rdv_blocks SET kind = $3, label = $4, services = $5::jsonb, vehicle = $6, mode = $7, day = $8::date, start_min = $9, end_min = $10, starts_at = $11::timestamptz,
               ends_at = $12::timestamptz, fixed = $13, account_id = $14, updated_at = $15::timestamptz WHERE id = $1 AND garage_id = $2 RETURNING id`,
            [id, garageId, ...vals, accountId || "", T()],
          )
        : await one(
            `INSERT INTO rdv_blocks (id, garage_id, kind, label, services, vehicle, mode, day, start_min, end_min, starts_at, ends_at, fixed, account_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::date, $9, $10, $11::timestamptz, $12::timestamptz, $13, $14, $15::timestamptz, $15::timestamptz) RETURNING id`,
            [crypto.randomUUID(), garageId, ...vals, accountId || "", T()],
          );
      return row && row.id;
    },
    getBlock: (garageId, id) => one(`SELECT ${BLOCK_COLUMNS} FROM rdv_blocks WHERE id = $1 AND garage_id = $2`, [id, garageId]).then(blockOf),
    blocksBetween: (garageId, fromIso, toIso) =>
      all(`SELECT ${BLOCK_COLUMNS} FROM rdv_blocks WHERE garage_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY starts_at, id`, [garageId, fromIso, toIso]).then((rows) => rows.map(blockOf)),
    async deleteBlock(garageId, id) {
      const r = await q.query("DELETE FROM rdv_blocks WHERE id = $1 AND garage_id = $2", [id, garageId]);
      if (!r.rowCount) return false;
      await q.query("DELETE FROM rdv_assignments WHERE block_id = $1 AND garage_id = $2", [id, garageId]);
      await q.query("DELETE FROM rdv_work_orders WHERE request_id = $1 AND garage_id = $2", [id, garageId]); // état du rendez-vous hors Pixcar (lot 3c)
      return true;
    },
    // rows [{ target, targetId, role, day, start, end (ms) }]
    async replaceBlockAssignments(garageId, blockId, rows) {
      await q.query("DELETE FROM rdv_assignments WHERE block_id = $1 AND garage_id = $2", [blockId, garageId]);
      for (const a of rows)
        await q.query("INSERT INTO rdv_assignments (id, garage_id, block_id, target, target_id, role, day, starts_at, ends_at, fixed) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::timestamptz, $9::timestamptz, false)", [
          crypto.randomUUID(), garageId, blockId, a.target, a.targetId, a.role, a.day, iso(a.start), iso(a.end),
        ]);
    },
    blockAssignments: (garageId, blockIds) =>
      blockIds.length
        ? all(`SELECT block_id, target, target_id, role, starts_at, ends_at FROM rdv_assignments WHERE garage_id = $1 AND block_id IN (${placeholders(blockIds.length, 2)}) ORDER BY starts_at, role`, [garageId, ...blockIds]).then((rows) =>
            rows.map((r) => ({ blockId: r.block_id, target: r.target, targetId: r.target_id, role: r.role, start: ms(r.starts_at), end: ms(r.ends_at) })),
          )
        : Promise.resolve([]),

    // ---- interventions
    // fields : { vehicle, workStart, workEnd, readyAt, returnAt, labour, immob } (instants en ms)
    saveWorkOrder: (garageId, requestId, f) =>
      q.query(
        `INSERT INTO rdv_work_orders (request_id, garage_id, vehicle, work_start, work_end, ready_at, return_at, labour_min, immob_min, created_at, updated_at)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9, $10::timestamptz, $10::timestamptz)
         ON CONFLICT (request_id) DO UPDATE SET vehicle = EXCLUDED.vehicle, work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end, ready_at = EXCLUDED.ready_at,
           return_at = EXCLUDED.return_at, labour_min = EXCLUDED.labour_min, immob_min = EXCLUDED.immob_min, updated_at = EXCLUDED.updated_at`,
        [requestId, garageId, f.vehicle || "", f.workStart ? iso(f.workStart) : null, f.workEnd ? iso(f.workEnd) : null, f.readyAt ? iso(f.readyAt) : null, f.returnAt ? iso(f.returnAt) : null, f.labour ?? null, f.immob ?? null, T()],
      ),
    workOrder: (requestId) => one("SELECT * FROM rdv_work_orders WHERE request_id = $1", [requestId]).then(workOrderOf),
    // état d'une intervention (lot 3c) : id d'une demande, ou d'un rendez-vous hors Pixcar (sa ligne naît au premier changement) ;
    // state : un état de src/js/shared/work.js, « no_show » compris (l'état reste « planned », le client est noté absent)
    setWork: (garageId, id, state, atMs) =>
      q.query(
        `INSERT INTO rdv_work_orders (request_id, garage_id, status, no_show_at, status_at, created_at, updated_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $5::timestamptz, $5::timestamptz)
         ON CONFLICT (request_id) DO UPDATE SET status = EXCLUDED.status, no_show_at = EXCLUDED.no_show_at, status_at = EXCLUDED.status_at, updated_at = EXCLUDED.updated_at`,
        [id, garageId, state === "no_show" ? "planned" : state, state === "no_show" ? iso(atMs) : null, iso(atMs)],
      ),
    workOrders: (garageId, requestIds) =>
      requestIds.length ? all(`SELECT * FROM rdv_work_orders WHERE garage_id = $1 AND request_id IN (${placeholders(requestIds.length, 2)})`, [garageId, ...requestIds]).then((rows) => rows.map(workOrderOf)) : Promise.resolve([]),

    // ---- rendez-vous à venir qui retiennent un horaire (bascule de mode), dans l'ordre
    futureRequests: (garageId) =>
      all(
        `SELECT id, slot_id, status, day::text AS day, start_min, end_min, starts_at, ends_at, mode, services, minutes, deadline, name, car FROM rdv_requests
         WHERE garage_id = $1 AND starts_at > $2::timestamptz AND (status = 'confirmed' OR (status = 'pending' AND deadline > $2::timestamptz)) ORDER BY starts_at, id`,
        [garageId, T()],
      ).then((rows) => rows.map((r) => ({ ...r, services: Array.isArray(r.services) ? r.services : [], starts_at: ms(r.starts_at), ends_at: ms(r.ends_at), deadline: ms(r.deadline) }))),
    // rendez-vous d'une période (calendrier) : en attente avant l'heure limite, ou confirmés
    requestsBetween: (garageId, fromIso, toIso) =>
      all(
        `SELECT id, slot_id, status, day::text AS day, start_min, end_min, starts_at, ends_at, mode, services, minutes, deadline, name, phone, car, plate FROM rdv_requests
         WHERE garage_id = $1 AND day BETWEEN $2::date AND $3::date AND (status = 'confirmed' OR (status = 'pending' AND deadline > $4::timestamptz)) ORDER BY starts_at, id`,
        [garageId, fromIso, toIso, T()],
      ).then((rows) => rows.map((r) => ({ ...r, services: Array.isArray(r.services) ? r.services : [], starts_at: ms(r.starts_at), ends_at: ms(r.ends_at), deadline: ms(r.deadline) }))),
    setSlot: (garageId, requestId, slotId) => q.query("UPDATE rdv_requests SET slot_id = $3 WHERE id = $1 AND garage_id = $2", [requestId, garageId, slotId]),

    // ---- historique (jamais de donnée de client)
    log: (garageId, accountId, what, refId, detail) =>
      q.query("INSERT INTO rdv_history (id, garage_id, at, account_id, what, ref_id, detail) VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)", [crypto.randomUUID(), garageId, T(), accountId || "", what, refId || null, String(detail || "").slice(0, 300)]),
    history: (garageId, limit = 50) => all("SELECT at, what, ref_id, detail FROM rdv_history WHERE garage_id = $1 ORDER BY at DESC, id LIMIT $2", [garageId, limit]).then((rows) => rows.map((r) => ({ at: ms(r.at), what: r.what, refId: r.ref_id, detail: r.detail }))),

    // ---- entretien : historique de plus de 12 mois ; affectations et interventions dont la demande (ou le bloc) n'existe plus
    async purge() {
      const run = async (sql) => {
        let n = 0;
        for (let pass = 0; pass < 100; pass++) {
          const { rowCount } = await q.query(sql, [PURGE_BATCH, T()]);
          n += rowCount;
          if (rowCount < PURGE_BATCH) break;
        }
        return n;
      };
      return {
        calHistory: await run("DELETE FROM rdv_history WHERE id IN (SELECT id FROM rdv_history WHERE at < $2::timestamptz - interval '12 months' LIMIT $1)"),
        calAssignments: await run(
          "DELETE FROM rdv_assignments WHERE id IN (SELECT a.id FROM rdv_assignments a LEFT JOIN rdv_requests r ON r.id = a.request_id WHERE a.request_id IS NOT NULL AND r.id IS NULL AND a.created_at < $2::timestamptz LIMIT $1)",
        ),
        // l'intervention d'une demande, ou d'un rendez-vous hors Pixcar (lot 3c) : effacée quand ni l'une ni l'autre n'existe plus
        calWorkOrders: await run(
          "DELETE FROM rdv_work_orders WHERE request_id IN (SELECT w.request_id FROM rdv_work_orders w LEFT JOIN rdv_requests r ON r.id = w.request_id LEFT JOIN rdv_blocks k ON k.id = w.request_id WHERE r.id IS NULL AND k.id IS NULL AND w.created_at < $2::timestamptz LIMIT $1)",
        ),
        // blocs internes comme les demandes : libellé effacé 30 jours après le jour, ligne effacée après 24 mois
        calBlocksAnonymized: await run(
          "UPDATE rdv_blocks SET label = '', anonymized_at = $2::timestamptz WHERE id IN (SELECT id FROM rdv_blocks WHERE anonymized_at IS NULL AND ends_at < $2::timestamptz - interval '30 days' LIMIT $1)",
        ),
        calBlocks: await run("DELETE FROM rdv_blocks WHERE id IN (SELECT id FROM rdv_blocks WHERE ends_at < $2::timestamptz - interval '24 months' LIMIT $1)"),
        calBlockAssignments: await run(
          "DELETE FROM rdv_assignments WHERE id IN (SELECT a.id FROM rdv_assignments a LEFT JOIN rdv_blocks k ON k.id = a.block_id WHERE a.block_id IS NOT NULL AND k.id IS NULL AND a.created_at < $2::timestamptz LIMIT $1)",
        ),
      };
    },
    // retrait d'un rattachement : tout le calendrier du garage part (les demandes sont annulées par rdv-repo). Hors transaction, par lots
    // (DSQL : 3 000 lignes modifiées au plus par transaction).
    async revoke(garageId) {
      const KEYS = { rdv_calendar: "garage_id", rdv_staff: "id", rdv_staff_skills: "staff_id, skill_id", rdv_skills: "id", rdv_resources: "id", rdv_service_reqs: "service_id", rdv_unavail: "id", rdv_assignments: "id", rdv_work_orders: "request_id", rdv_history: "id", rdv_blocks: "id" };
      let n = 0;
      for (const [t, key] of Object.entries(KEYS))
        for (let pass = 0; pass < 1000; pass++) {
          const { rowCount } = await q.query(`DELETE FROM ${t} WHERE garage_id = $1 AND (${key}) IN (SELECT ${key} FROM ${t} WHERE garage_id = $1 LIMIT ${PURGE_BATCH})`, [garageId]);
          n += rowCount;
          if (rowCount < PURGE_BATCH) break;
        }
      return n;
    },
  };
}
