// Rendez-vous en ligne : tout le SQL (mêmes règles que server/repo.mjs : paramètres à part, SQL portable PostgreSQL / PGlite / Aurora
// DSQL, fonctions passées à tx() rejouables sans effet hors de la base). repo.tx(fn) donne à fn le même dépôt, lié à la transaction.
// Les dates (date) reviennent en texte AAAA-MM-JJ, les instants (timestamptz) en millisecondes.

import { bindCalendar } from "./calendar-repo.mjs";
import { PRO_SERVICES } from "../src/js/shared/pro-prices.js";

const PRO_IDS = PRO_SERVICES.map((s) => s.id);

const PURGE_BATCH = 1000;
const placeholders = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");
const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());

const SETTINGS_COLUMNS =
  "garage_id, enabled, paused, missed, min_delay_h, horizon_days, step_min, holidays, notify_email, notify_pending, notify_code_hash, notify_code_expires_at, notify_attempts, notify_sends, notify_window_at, notify_last_sent_at, version, updated_at";
const SLOT_COLUMNS = "id, garage_id, name, days, start_min, end_min, mode, capacity, services, updated_at";
const CLOSURE_COLUMNS = "id, garage_id, first_day::text AS first, last_day::text AS last, label";
export const REQUEST_COLUMNS =
  "id, garage_id, slot_id, status, day::text AS day, start_min, end_min, starts_at, ends_at, mode, services, minutes, name, email, phone, car, car_year, plate, message, remind_price, code_hash, code_expires_at, attempts, sends, last_sent_at, client_token_hash, garage_token_hash, deadline, reason, note, cancelled_by, garage_name, garage_addr, garage_phone, created_at, sent_at, decided_at, reminded_at, followed_up_at, anonymized_at";

export const settingsOf = (r) =>
  r && {
    garageId: r.garage_id,
    enabled: r.enabled,
    paused: r.paused,
    missed: r.missed,
    minDelayH: r.min_delay_h,
    horizonDays: r.horizon_days,
    stepMin: r.step_min,
    holidays: r.holidays,
    notifyEmail: r.notify_email,
    notifyPending: r.notify_pending,
    notifyCodeHash: r.notify_code_hash,
    notifyCodeExpiresAt: ms(r.notify_code_expires_at),
    notifyAttempts: r.notify_attempts,
    notifySends: r.notify_sends,
    notifyWindowAt: ms(r.notify_window_at),
    notifyLastSentAt: ms(r.notify_last_sent_at),
    version: r.version,
  };
export const slotOf = (r) => ({ id: r.id, name: r.name, days: String(r.days).split(",").filter(Boolean), start: r.start_min, end: r.end_min, mode: r.mode, capacity: r.capacity, services: Array.isArray(r.services) ? r.services : [] });
export const requestOf = (r) =>
  r && {
    ...r,
    services: Array.isArray(r.services) ? r.services : [],
    starts_at: ms(r.starts_at),
    ends_at: ms(r.ends_at),
    deadline: ms(r.deadline),
    code_expires_at: ms(r.code_expires_at),
    last_sent_at: ms(r.last_sent_at),
    created_at: ms(r.created_at),
    sent_at: ms(r.sent_at),
    decided_at: ms(r.decided_at),
    reminded_at: ms(r.reminded_at),
    followed_up_at: ms(r.followed_up_at),
    anonymized_at: ms(r.anonymized_at),
  };
// Une demande telle que le moteur des horaires la compte (src/js/shared/rdv.js)
export const bookingOf = (r) => ({ slotId: r.slot_id, day: r.day, start: r.start_min, end: r.end_min, status: r.status, deadline: ms(r.deadline) });

// now() : horloge de l'application (ms). Toutes les comparaisons d'heure passent par elle ($n::timestamptz), jamais par now() de la base :
// heure limite, heure du rendez-vous et validité d'un code se jugent à la même horloge que le calcul des horaires (et les tests la fixent).
export function createRdvRepo(db, { now = Date.now } = {}) {
  const T = () => new Date(now()).toISOString();
  const bind = (q) => {
    const one = async (sql, params) => (await q.query(sql, params)).rows[0] || null;
    const all = async (sql, params) => (await q.query(sql, params)).rows;
    const enqueue = (mails) =>
      Promise.all(
        mails.map((m) => q.query("INSERT INTO rdv_mails (id, request_id, garage_id, kind, created_at) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), m.requestId || null, m.garageId, m.kind, T()])),
      );

    // libère les ressources réservées par ces demandes (mode avancé ; sans effet sinon)
    const release = (ids) => (ids.length ? q.query(`DELETE FROM rdv_assignments WHERE request_id IN (${placeholders(ids.length)})`, ids) : Promise.resolve());
    return {
      enqueue,
      cal: bindCalendar(q, { now }),

      // ---- ce qu'il faut pour calculer les horaires d'un garage : rattachement vérifié, réglages, créneaux, fermetures à venir, horaires
      // d'ouverture et coordonnées déclarés, temps moyens des prestations faites, fiche des données publiques
      async bundle(garageId, todayIso) {
        const claim = await one("SELECT account_id FROM pro_claims WHERE garage_id = $1 AND status = 'verified'", [garageId]);
        if (!claim) return null;
        const [settings, slots, closures, profile, services, contact, calendar] = await Promise.all([
          one(`SELECT ${SETTINGS_COLUMNS} FROM rdv_settings WHERE garage_id = $1`, [garageId]),
          all(`SELECT ${SLOT_COLUMNS} FROM rdv_slots WHERE garage_id = $1 ORDER BY created_at, id`, [garageId]),
          all(`SELECT ${CLOSURE_COLUMNS} FROM rdv_closures WHERE garage_id = $1 AND last_day >= $2::date ORDER BY first_day, id`, [garageId, todayIso]),
          one("SELECT name, street, pc, city, phone, hours FROM pro_profiles WHERE garage_id = $1", [garageId]),
          all("SELECT service_id, offered, minutes FROM pro_services WHERE garage_id = $1", [garageId]),
          one("SELECT name, addr, pc, lat, lon FROM garage_contacts WHERE garage_id = $1", [garageId]),
          this.cal.getCalendar(garageId),
        ]);
        const minutes = {};
        for (const s of services) if (s.offered && Number.isInteger(s.minutes)) minutes[s.service_id] = s.minutes;
        const offered = PRO_IDS.filter((id) => services.some((s) => s.offered && s.service_id === id));
        return { garageId, accountId: claim.account_id, settings: settingsOf(settings), slots: slots.map(slotOf), closures, profile, minutes, offered, contact, calendar };
      },
      // demandes qui peuvent retenir un horaire, du jour fromIso au jour toIso
      bookings: (garageId, fromIso, toIso) =>
        all(
          "SELECT slot_id, day::text AS day, start_min, end_min, status, deadline FROM rdv_requests WHERE garage_id = $1 AND day BETWEEN $2::date AND $3::date AND status IN ('pending', 'confirmed')",
          [garageId, fromIso, toIso],
        ).then((rows) => rows.map(bookingOf)),

      // ---- réglages (garage rattaché : vérifié par l'appelant)
      getSettings: (garageId) => one(`SELECT ${SETTINGS_COLUMNS} FROM rdv_settings WHERE garage_id = $1`, [garageId]).then(settingsOf),
      // fields : { enabled, paused, missed, min_delay_h, horizon_days, step_min, holidays } (colonnes présentes seulement)
      async saveSettings(garageId, accountId, fields) {
        const cols = Object.keys(fields);
        const sets = cols.map((c, i) => `${c} = $${i + 3}`);
        const row = await one(
          `INSERT INTO rdv_settings (garage_id, account_id${cols.map((c) => ", " + c).join("")}, updated_at) VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join("")}, now())
           ON CONFLICT (garage_id) DO UPDATE SET account_id = EXCLUDED.account_id${sets.map((s) => ", " + s).join("")}, updated_at = now()
           RETURNING ${SETTINGS_COLUMNS}`,
          [garageId, accountId, ...cols.map((c) => fields[c])],
        );
        return settingsOf(row);
      },
      // Adresse de notification : nouveau code vers une adresse en cours de vérification. limits : { ttlSeconds, resendAfterSeconds, maxPerDay }.
      // Résultat : { kind: "ok" } | { kind: "wait", retryAfter } | { kind: "limited" }
      async startNotify({ garageId, accountId, email, codeHash, limits }) {
        await q.query("INSERT INTO rdv_settings (garage_id, account_id) VALUES ($1, $2) ON CONFLICT (garage_id) DO NOTHING", [garageId, accountId]);
        const s = await one("SELECT notify_sends, notify_window_at, notify_last_sent_at FROM rdv_settings WHERE garage_id = $1", [garageId]);
        const t = now();
        const since = s.notify_last_sent_at ? (t - ms(s.notify_last_sent_at)) / 1000 : Infinity;
        if (since < limits.resendAfterSeconds) return { kind: "wait", retryAfter: Math.max(1, Math.ceil(limits.resendAfterSeconds - since)) };
        const fresh = !s.notify_window_at || t - ms(s.notify_window_at) > 864e5;
        if (!fresh && s.notify_sends >= limits.maxPerDay) return { kind: "limited" };
        await q.query(
          `UPDATE rdv_settings SET notify_pending = $2, notify_code_hash = $3, notify_code_expires_at = $7::timestamptz + $4::int * interval '1 second', notify_attempts = 0,
             notify_sends = CASE WHEN $5 THEN 1 ELSE notify_sends + 1 END, notify_window_at = CASE WHEN $5 THEN $7::timestamptz ELSE notify_window_at END,
             notify_last_sent_at = $7::timestamptz, account_id = $6, updated_at = now() WHERE garage_id = $1`,
          [garageId, email, codeHash, limits.ttlSeconds, fresh, accountId, T()],
        );
        return { kind: "ok" };
      },
      // Essai du code de l'adresse de notification. matches(hash) → Promise<boolean>.
      // Résultat : { kind: "verified", email } | { kind: "bad", attemptsLeft } | { kind: "locked" } | { kind: "expired" } | { kind: "none" }
      async tryNotify({ garageId, matches, maxAttempts }) {
        const s = await one("SELECT notify_pending, notify_code_hash, notify_attempts, (notify_code_expires_at > $2::timestamptz) AS live FROM rdv_settings WHERE garage_id = $1", [garageId, T()]);
        if (!s || !s.notify_pending || !s.notify_code_hash) return { kind: "none" };
        if (s.notify_attempts >= maxAttempts) return { kind: "locked" };
        if (!s.live) return { kind: "expired" };
        const counted = await q.query("UPDATE rdv_settings SET notify_attempts = notify_attempts + 1 WHERE garage_id = $1 AND notify_attempts = $2", [garageId, s.notify_attempts]);
        if (!counted.rowCount) return { kind: "bad", attemptsLeft: Math.max(0, maxAttempts - s.notify_attempts - 1) };
        if (await matches(s.notify_code_hash)) {
          await q.query(
            "UPDATE rdv_settings SET notify_email = notify_pending, notify_pending = '', notify_code_hash = NULL, notify_code_expires_at = NULL, notify_attempts = 0, updated_at = now() WHERE garage_id = $1",
            [garageId],
          );
          return { kind: "verified", email: s.notify_pending };
        }
        const left = maxAttempts - s.notify_attempts - 1;
        if (left <= 0) {
          await q.query("UPDATE rdv_settings SET notify_code_hash = NULL WHERE garage_id = $1", [garageId]);
          return { kind: "locked" };
        }
        return { kind: "bad", attemptsLeft: left };
      },

      // ---- créneaux
      countSlots: (garageId) => one("SELECT count(*)::int AS n FROM rdv_slots WHERE garage_id = $1", [garageId]).then((r) => r.n),
      createSlot: (garageId, s) =>
        one(
          `INSERT INTO rdv_slots (id, garage_id, name, days, start_min, end_min, mode, capacity, services) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING ${SLOT_COLUMNS}`,
          [crypto.randomUUID(), garageId, s.name, s.days.join(","), s.start, s.end, s.mode, s.capacity, JSON.stringify(s.services)],
        ).then(slotOf),
      updateSlot: (garageId, id, s) =>
        one(
          `UPDATE rdv_slots SET name = $3, days = $4, start_min = $5, end_min = $6, mode = $7, capacity = $8, services = $9::jsonb, updated_at = now()
           WHERE id = $1 AND garage_id = $2 RETURNING ${SLOT_COLUMNS}`,
          [id, garageId, s.name, s.days.join(","), s.start, s.end, s.mode, s.capacity, JSON.stringify(s.services)],
        ).then((r) => (r ? slotOf(r) : null)),
      deleteSlot: (garageId, id) => q.query("DELETE FROM rdv_slots WHERE id = $1 AND garage_id = $2", [id, garageId]).then((r) => r.rowCount > 0),

      // ---- fermetures
      listClosures: (garageId, fromIso) => all(`SELECT ${CLOSURE_COLUMNS} FROM rdv_closures WHERE garage_id = $1 AND last_day >= $2::date ORDER BY first_day, id`, [garageId, fromIso]),
      countClosures: (garageId, fromIso) => one("SELECT count(*)::int AS n FROM rdv_closures WHERE garage_id = $1 AND last_day >= $2::date", [garageId, fromIso]).then((r) => r.n),
      createClosure: (garageId, c) =>
        one(`INSERT INTO rdv_closures (id, garage_id, first_day, last_day, label) VALUES ($1, $2, $3::date, $4::date, $5) RETURNING ${CLOSURE_COLUMNS}`, [crypto.randomUUID(), garageId, c.first, c.last, c.label]),
      updateClosure: (garageId, id, c) =>
        one(`UPDATE rdv_closures SET first_day = $3::date, last_day = $4::date, label = $5 WHERE id = $1 AND garage_id = $2 RETURNING ${CLOSURE_COLUMNS}`, [id, garageId, c.first, c.last, c.label]),
      deleteClosure: (garageId, id) => q.query("DELETE FROM rdv_closures WHERE id = $1 AND garage_id = $2", [id, garageId]).then((r) => r.rowCount > 0),
      // Une fermeture annule les demandes et rendez-vous de la période (client prévenu). Renvoie le nombre de demandes annulées.
      async cancelForClosure(garageId, first, last) {
        const rows = await all(
          `UPDATE rdv_requests SET status = 'cancelled', cancelled_by = 'closure', decided_at = $4::timestamptz
           WHERE garage_id = $1 AND day BETWEEN $2::date AND $3::date AND status IN ('pending', 'confirmed') AND starts_at > $4::timestamptz RETURNING id`,
          [garageId, first, last, T()],
        );
        await enqueue(rows.map((r) => ({ requestId: r.id, garageId, kind: "client_cancelled" })));
        await release(rows.map((r) => r.id));
        return rows.length;
      },

      // ---- demandes : création (code), essais, envoi
      // Envois de codes récents, pour les limites : { ipHour, ipDay, emailDay, globalHour }
      codeCounts: ({ ipHash, emailHash }) =>
        one(
          `SELECT sum(CASE WHEN ip_hash = $1 AND at > $3::timestamptz - interval '1 hour' THEN 1 ELSE 0 END)::int AS ip_hour,
                  sum(CASE WHEN ip_hash = $1 THEN 1 ELSE 0 END)::int AS ip_day,
                  sum(CASE WHEN email_hash = $2 THEN 1 ELSE 0 END)::int AS email_day,
                  sum(CASE WHEN at > $3::timestamptz - interval '1 hour' THEN 1 ELSE 0 END)::int AS global_hour
           FROM rdv_events WHERE kind = 'code' AND at > $3::timestamptz - interval '24 hours'`,
          [ipHash, emailHash, T()],
        ).then((r) => ({ ipHour: r.ip_hour || 0, ipDay: r.ip_day || 0, emailDay: r.email_day || 0, globalHour: r.global_hour || 0 })),
      logCode: ({ ipHash, emailHash, garageId }) => q.query("INSERT INTO rdv_events (kind, ip_hash, email_hash, garage_id, at) VALUES ('code', $1, $2, $3, $4)", [ipHash, emailHash, garageId, T()]),
      // d : { id, garageId, slotId, day, start, end, startsAt, endsAt, mode, services, minutes, name, email, phone, car, carYear, plate, message,
      // remindPrice, codeHash, ttlSeconds, ipHash, garageName, garageAddr, garagePhone }
      createDraft: (d) =>
        q.query(
          `INSERT INTO rdv_requests (id, garage_id, slot_id, status, day, start_min, end_min, starts_at, ends_at, mode, services, minutes, name, email, phone, car, car_year, plate, message,
             remind_price, code_hash, code_expires_at, attempts, sends, last_sent_at, ip_hash, garage_name, garage_addr, garage_phone, created_at)
           VALUES ($1, $2, $3, 'code', $4::date, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $26::timestamptz + $21::int * interval '1 second', 0, 1, $26::timestamptz, $22, $23, $24, $25, $26::timestamptz)`,
          [d.id, d.garageId, d.slotId, d.day, d.start, d.end, new Date(d.startsAt).toISOString(), new Date(d.endsAt).toISOString(), d.mode, JSON.stringify(d.services), d.minutes, d.name, d.email, d.phone, d.car, d.carYear,
            d.plate, d.message, d.remindPrice, d.codeHash, d.ttlSeconds, d.ipHash, d.garageName, d.garageAddr, d.garagePhone, T()],
        ),
      getRequest: (id) => one(`SELECT ${REQUEST_COLUMNS} FROM rdv_requests WHERE id = $1`, [id]).then(requestOf),
      // nouveau code pour une demande pas encore envoyée : { kind: "ok" } | { kind: "wait", retryAfter } | { kind: "limited" } | { kind: "closed" }
      async resendCode({ id, codeHash, ttlSeconds, resendAfterSeconds, maxSends }) {
        const r = await one("SELECT status, sends, last_sent_at FROM rdv_requests WHERE id = $1", [id]);
        if (!r || r.status !== "code") return { kind: "closed" };
        const since = r.last_sent_at ? (now() - ms(r.last_sent_at)) / 1000 : Infinity;
        if (since < resendAfterSeconds) return { kind: "wait", retryAfter: Math.max(1, Math.ceil(resendAfterSeconds - since)) };
        if (r.sends >= maxSends) return { kind: "limited" };
        await q.query(
          "UPDATE rdv_requests SET code_hash = $2, code_expires_at = $4::timestamptz + $3::int * interval '1 second', attempts = 0, sends = sends + 1, last_sent_at = $4::timestamptz WHERE id = $1 AND status = 'code'",
          [id, codeHash, ttlSeconds, T()],
        );
        return { kind: "ok" };
      },
      // l'essai est compté avant la comparaison, et seulement si personne ne l'a compté entre-temps
      countAttempt: (id, seen) => q.query("UPDATE rdv_requests SET attempts = attempts + 1 WHERE id = $1 AND attempts = $2 AND status = 'code'", [id, seen]).then((r) => r.rowCount > 0),
      burnCode: (id) => q.query("UPDATE rdv_requests SET code_hash = NULL WHERE id = $1", [id]),
      // prend le « jeton » du garage : deux prises d'horaire simultanées sur un même garage ne passent pas ensemble
      lockGarage: (garageId) => q.query("UPDATE rdv_settings SET version = version + 1 WHERE garage_id = $1", [garageId]),
      // Demandes en attente de cette adresse e-mail : { here (ce garage), total }
      pendingOf: (email, garageId) =>
        one(
          "SELECT count(*)::int AS total, sum(CASE WHEN garage_id = $2 THEN 1 ELSE 0 END)::int AS here FROM rdv_requests WHERE email = $1 AND status = 'pending' AND deadline > $3::timestamptz",
          [email, garageId, T()],
        ).then((r) => ({ total: r.total || 0, here: r.here || 0 })),
      pendingAtGarage: (garageId) => one("SELECT count(*)::int AS n FROM rdv_requests WHERE garage_id = $1 AND status = 'pending' AND deadline > $2::timestamptz", [garageId, T()]).then((r) => r.n),
      // la demande part : horaire retenu (créneau éventuellement changé), heure limite, jetons ; e-mails à l'automobiliste et au garage.
      // auto (mode avancé, prestations à confirmation automatique) : confirmée tout de suite.
      async send({ id, garageId, offer, deadline, clientTokenHash, garageTokenHash, auto = false }) {
        const r = await q.query(
          `UPDATE rdv_requests SET status = $13, slot_id = $2, day = $3::date, start_min = $4, end_min = $5, starts_at = $6, ends_at = $7, mode = $8, deadline = $9,
             client_token_hash = $10, garage_token_hash = $11, code_hash = NULL, code_expires_at = NULL, sent_at = $12::timestamptz, decided_at = CASE WHEN $14 THEN $12::timestamptz ELSE NULL END
           WHERE id = $1 AND status = 'code'`,
          [id, offer.slotId, offer.day, offer.start, offer.end, new Date(offer.startsAt).toISOString(), new Date(offer.endsAt).toISOString(), offer.mode, new Date(deadline).toISOString(), clientTokenHash, garageTokenHash, T(), auto ? "confirmed" : "pending", auto],
        );
        if (!r.rowCount) return false;
        await enqueue(auto ? [{ requestId: id, garageId, kind: "client_confirmed" }, { requestId: id, garageId, kind: "garage_booked" }] : [{ requestId: id, garageId, kind: "client_sent" }, { requestId: id, garageId, kind: "garage_new" }]);
        return true;
      },

      // Le garage change l'heure d'un rendez-vous (mode avancé) : le client est prévenu ; le rappel de la veille repart.
      async reschedule(id, garageId, { day, start, end, startsAt, endsAt }) {
        const r = await one(
          `UPDATE rdv_requests SET day = $3::date, start_min = $4, end_min = $5, starts_at = $6::timestamptz, ends_at = $7::timestamptz, reminded_at = NULL
           WHERE id = $1 AND garage_id = $2 AND status IN ('pending', 'confirmed') RETURNING ${REQUEST_COLUMNS}`,
          [id, garageId, day, start, end, new Date(startsAt).toISOString(), new Date(endsAt).toISOString()],
        );
        if (!r) return null;
        await enqueue([{ requestId: id, garageId, kind: "client_moved" }]);
        return requestOf(r);
      },

      // ---- accès par jeton
      byClientToken: (hash) => one(`SELECT ${REQUEST_COLUMNS} FROM rdv_requests WHERE client_token_hash = $1 AND anonymized_at IS NULL`, [hash]).then(requestOf),
      byGarageToken: (hash) => one(`SELECT ${REQUEST_COLUMNS} FROM rdv_requests WHERE garage_token_hash = $1 AND anonymized_at IS NULL`, [hash]).then(requestOf),

      // ---- décisions. Chacune ne passe que depuis l'état attendu ; renvoie la demande à jour, ou null.
      // Le garage accepte (avant l'heure limite) : la série de demandes sans réponse repart de zéro.
      async accept(id, garageId) {
        const r = await one(
          `UPDATE rdv_requests SET status = 'confirmed', decided_at = $3::timestamptz WHERE id = $1 AND garage_id = $2 AND status = 'pending' AND deadline > $3::timestamptz RETURNING ${REQUEST_COLUMNS}`,
          [id, garageId, T()],
        );
        if (!r) return null;
        await q.query("UPDATE rdv_settings SET missed = 0 WHERE garage_id = $1", [garageId]);
        await enqueue([{ requestId: id, garageId, kind: "client_confirmed" }]);
        return requestOf(r);
      },
      async decline(id, garageId, reason, note) {
        const r = await one(
          `UPDATE rdv_requests SET status = 'declined', reason = $3, note = $4, decided_at = $5::timestamptz WHERE id = $1 AND garage_id = $2 AND status = 'pending' AND deadline > $5::timestamptz RETURNING ${REQUEST_COLUMNS}`,
          [id, garageId, reason, note, T()],
        );
        if (!r) return null;
        await q.query("UPDATE rdv_settings SET missed = 0 WHERE garage_id = $1", [garageId]);
        await enqueue([{ requestId: id, garageId, kind: "client_declined" }]);
        await release([id]);
        return requestOf(r);
      },
      // Le garage annule un rendez-vous confirmé (motif) : compté comme une demande sans réponse pour la mise en pause automatique.
      async cancelByGarage(id, garageId, reason, note, pauseAfter) {
        const r = await one(
          `UPDATE rdv_requests SET status = 'cancelled', cancelled_by = 'garage', reason = $3, note = $4, decided_at = $5::timestamptz
           WHERE id = $1 AND garage_id = $2 AND status = 'confirmed' AND starts_at > $5::timestamptz RETURNING ${REQUEST_COLUMNS}`,
          [id, garageId, reason, note, T()],
        );
        if (!r) return null;
        await enqueue([{ requestId: id, garageId, kind: "client_cancelled" }]);
        await release([id]);
        await this.missedOne(garageId, id, pauseAfter);
        return requestOf(r);
      },
      // L'automobiliste annule (jusqu'à l'heure du rendez-vous) ; le garage est prévenu.
      async cancelByClient(id, reason) {
        const r = await one(
          `UPDATE rdv_requests SET status = 'cancelled', cancelled_by = 'client', reason = $2, decided_at = $3::timestamptz
           WHERE id = $1 AND status IN ('pending', 'confirmed') AND starts_at > $3::timestamptz AND (status = 'confirmed' OR deadline > $3::timestamptz) RETURNING ${REQUEST_COLUMNS}`,
          [id, reason, T()],
        );
        if (!r) return null;
        await enqueue([{ requestId: id, garageId: r.garage_id, kind: "garage_cancelled" }]);
        await release([id]);
        return requestOf(r);
      },
      // Une demande sans réponse de plus ; à la 3e de suite, les rendez-vous en ligne du garage sont mis en pause (garage prévenu).
      async missedOne(garageId, requestId, pauseAfter) {
        const s = await one("UPDATE rdv_settings SET missed = missed + 1 WHERE garage_id = $1 RETURNING missed, paused, enabled", [garageId]);
        if (s && s.enabled && !s.paused && s.missed >= pauseAfter) {
          await q.query("UPDATE rdv_settings SET paused = true WHERE garage_id = $1", [garageId]);
          await enqueue([{ requestId, garageId, kind: "garage_paused" }]);
          return true;
        }
        return false;
      },

      // ---- liste du garage. view : « todo » (en attente), « upcoming » (confirmés à venir), « past » (le reste, encore nominatif)
      listRequests(garageId, view, todayIso) {
        const [where, params] =
          view === "todo"
            ? ["status = 'pending' AND deadline > $2::timestamptz", [T()]]
            : view === "upcoming"
              ? ["status = 'confirmed' AND day >= $2::date", [todayIso]]
              : ["status <> 'code' AND NOT (status = 'pending' AND deadline > $3::timestamptz) AND NOT (status = 'confirmed' AND day >= $2::date)", [todayIso, T()]];
        const order = view === "past" ? "starts_at DESC" : "starts_at";
        return all(`SELECT ${REQUEST_COLUMNS} FROM rdv_requests WHERE garage_id = $1 AND anonymized_at IS NULL AND ${where} ORDER BY ${order} LIMIT 100`, [garageId, ...params]).then((rows) =>
          rows.map(requestOf),
        );
      },
      countTodo: (garageId) => one("SELECT count(*)::int AS n FROM rdv_requests WHERE garage_id = $1 AND status = 'pending' AND deadline > $2::timestamptz", [garageId, T()]).then((r) => r.n),
      getForGarage: (garageId, id) => one(`SELECT ${REQUEST_COLUMNS} FROM rdv_requests WHERE id = $1 AND garage_id = $2 AND anonymized_at IS NULL`, [id, garageId]).then(requestOf),

      // ---- tâche horaire
      dueExpiries: (limit) => all("SELECT id, garage_id FROM rdv_requests WHERE status = 'pending' AND deadline <= $2::timestamptz ORDER BY deadline LIMIT $1", [limit, T()]),
      async expire(id, garageId, pauseAfter) {
        const r = await q.query("UPDATE rdv_requests SET status = 'expired', decided_at = $2::timestamptz WHERE id = $1 AND status = 'pending' AND deadline <= $2::timestamptz", [id, T()]);
        if (!r.rowCount) return false;
        await enqueue([{ requestId: id, garageId, kind: "client_expired" }]);
        await release([id]);
        await this.missedOne(garageId, id, pauseAfter);
        return true;
      },
      dueReminders: (tomorrowIso, limit) =>
        all("SELECT id, garage_id FROM rdv_requests WHERE status = 'confirmed' AND day = $1::date AND reminded_at IS NULL AND anonymized_at IS NULL LIMIT $2", [tomorrowIso, limit]),
      async remind(id, garageId) {
        const r = await q.query("UPDATE rdv_requests SET reminded_at = $2::timestamptz WHERE id = $1 AND status = 'confirmed' AND reminded_at IS NULL", [id, T()]);
        if (r.rowCount) await enqueue([{ requestId: id, garageId, kind: "client_reminder" }]);
        return r.rowCount > 0;
      },
      dueFollowUps: (fromIso, toIso, limit) =>
        all(
          "SELECT id, garage_id FROM rdv_requests WHERE status = 'confirmed' AND remind_price AND followed_up_at IS NULL AND anonymized_at IS NULL AND day BETWEEN $1::date AND $2::date LIMIT $3",
          [fromIso, toIso, limit],
        ),
      async followUp(id, garageId) {
        const r = await q.query("UPDATE rdv_requests SET followed_up_at = $2::timestamptz WHERE id = $1 AND status = 'confirmed' AND followed_up_at IS NULL", [id, T()]);
        if (r.rowCount) await enqueue([{ requestId: id, garageId, kind: "client_followup" }]);
        return r.rowCount > 0;
      },
      // e-mails à envoyer (5 essais, 3 jours au plus), les plus anciens d'abord ; ids : seulement ceux-là (envoi juste après une action)
      dueMails: (limit, ids) =>
        ids && ids.length
          ? all(`SELECT id, request_id, garage_id, kind, attempts FROM rdv_mails WHERE sent_at IS NULL AND attempts < 5 AND request_id IN (${placeholders(ids.length, 2)}) ORDER BY created_at LIMIT $1`, [limit, ...ids])
          : all("SELECT id, request_id, garage_id, kind, attempts FROM rdv_mails WHERE sent_at IS NULL AND attempts < 5 AND created_at > $2::timestamptz - interval '3 days' ORDER BY created_at LIMIT $1", [limit, T()]),
      // l'e-mail est pris (essai compté) avant l'envoi : deux envois simultanés du même ne passent pas
      claimMail: (id, attempts) => q.query("UPDATE rdv_mails SET attempts = attempts + 1 WHERE id = $1 AND attempts = $2 AND sent_at IS NULL", [id, attempts]).then((r) => r.rowCount > 0),
      mailSent: (id) => q.query("UPDATE rdv_mails SET sent_at = $2::timestamptz, last_error = '' WHERE id = $1", [id, T()]),
      mailFailed: (id, error) => q.query("UPDATE rdv_mails SET last_error = $2 WHERE id = $1", [id, String(error).slice(0, 200)]),

      // ---- autres garages qui prennent ces prestations en ligne, autour d'un point (e-mails de refus et d'expiration)
      openGaragesNear: ({ lat, lon, radiusM, exclude }) => {
        const dLat = radiusM / 111_320, dLon = radiusM / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
        return all(
          `SELECT s.garage_id, g.lat, g.lon FROM rdv_settings s JOIN garage_contacts g ON g.garage_id = s.garage_id
           WHERE s.enabled AND NOT s.paused AND s.notify_email <> '' AND s.garage_id <> $5 AND g.lat BETWEEN $1 AND $2 AND g.lon BETWEEN $3 AND $4 LIMIT 30`,
          [lat - dLat, lat + dLat, lon - dLon, lon + dLon, exclude],
        );
      },
      // garages de cette liste qui prennent des rendez-vous en ligne (lecture publique du comparateur)
      openAmong: (ids) =>
        ids.length
          ? all(`SELECT garage_id FROM rdv_settings WHERE enabled AND NOT paused AND notify_email <> '' AND garage_id IN (${placeholders(ids.length)})`, ids).then((r) => r.map((x) => x.garage_id))
          : Promise.resolve([]),

      // ---- entretien : codes jamais saisis (24 h), coordonnées effacées à l'échéance, lignes anonymes de plus de 24 mois, journal, file
      async purge() {
        const run = async (sql) => {
          let total = 0;
          for (let pass = 0; pass < 100; pass++) {
            const { rowCount } = await q.query(sql, [PURGE_BATCH, T()]);
            total += rowCount;
            if (rowCount < PURGE_BATCH) break;
          }
          return total;
        };
        const ANON = `name = '', email = '', phone = '', car = '', car_year = NULL, plate = '', message = '', ip_hash = '', code_hash = NULL, client_token_hash = NULL,
          garage_token_hash = NULL, note = '', anonymized_at = $2::timestamptz`;
        return {
          rdvDrafts: await run("DELETE FROM rdv_requests WHERE id IN (SELECT id FROM rdv_requests WHERE status = 'code' AND created_at < $2::timestamptz - interval '24 hours' LIMIT $1)"),
          rdvAnonymized: await run(
            `UPDATE rdv_requests SET ${ANON} WHERE id IN (SELECT id FROM rdv_requests WHERE anonymized_at IS NULL AND (
               (status IN ('confirmed', 'pending') AND day < ($2::timestamptz - interval '30 days')::date)
               OR (status IN ('declined', 'expired', 'cancelled') AND coalesce(decided_at, created_at) < $2::timestamptz - interval '7 days')) LIMIT $1)`,
          ),
          rdvOld: await run("DELETE FROM rdv_requests WHERE id IN (SELECT id FROM rdv_requests WHERE anonymized_at IS NOT NULL AND anonymized_at < $2::timestamptz - interval '24 months' LIMIT $1)"),
          rdvEvents: await run("DELETE FROM rdv_events WHERE id IN (SELECT id FROM rdv_events WHERE at < $2::timestamptz - interval '2 days' LIMIT $1)"),
          rdvMails: await run("DELETE FROM rdv_mails WHERE id IN (SELECT id FROM rdv_mails WHERE created_at < $2::timestamptz - interval '30 days' LIMIT $1)"),
          ...(await this.cal.purge()),
        };
      },
      // Retrait d'un rattachement (op « pro-revoke ») : réglages, créneaux et fermetures partent ; les demandes à venir sont annulées
      // (clients prévenus par la file, à la prochaine tâche horaire).
      async revoke(garageId) {
        const rows = await all(
          "UPDATE rdv_requests SET status = 'cancelled', cancelled_by = 'garage', reason = 'closed', decided_at = $2::timestamptz WHERE garage_id = $1 AND status IN ('pending', 'confirmed') AND starts_at > $2::timestamptz RETURNING id",
          [garageId, T()],
        );
        await enqueue(rows.map((r) => ({ requestId: r.id, garageId, kind: "client_cancelled" })));
        await release(rows.map((r) => r.id));
        await q.query("DELETE FROM rdv_settings WHERE garage_id = $1", [garageId]);
        await q.query("DELETE FROM rdv_slots WHERE garage_id = $1", [garageId]);
        await q.query("DELETE FROM rdv_closures WHERE garage_id = $1", [garageId]);
        return rows.length;
      },
      stats: () =>
        all("SELECT status, count(*)::int AS n FROM rdv_requests GROUP BY status ORDER BY status").then(async (rows) => ({
          requests: Object.fromEntries(rows.map((r) => [r.status, r.n])),
          garages: (await one("SELECT count(*)::int AS n FROM rdv_settings WHERE enabled AND NOT paused")).n,
          mailsWaiting: (await one("SELECT count(*)::int AS n FROM rdv_mails WHERE sent_at IS NULL AND attempts < 5")).n,
          mailsFailed: (await one("SELECT count(*)::int AS n FROM rdv_mails WHERE sent_at IS NULL AND attempts >= 5")).n,
        })),
    };
  };
  const base = bind(db);
  base.tx = (fn) => db.tx((t) => fn(bind(t)));
  return base;
}
