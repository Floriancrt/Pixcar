// Rendez-vous en ligne (docs/rendez-vous.md, lot 2).
//
// Garage (compte de l'Espace Pro, garage rattaché ; appelé par server/pro.mjs) :
//   GET    /v1/pro/garages/:id/rdv                          réglages, semaine type, fermetures, adresse de notification, demandes à traiter
//   PUT    /v1/pro/garages/:id/rdv/settings                 { enabled?, minDelayH?, horizonDays?, stepMin?, holidays? }
//   POST   /v1/pro/garages/:id/rdv/slots                    créneau ; PUT, DELETE …/slots/:slot
//   POST   /v1/pro/garages/:id/rdv/closures                 fermeture (annule les demandes de la période) ; PUT, DELETE …/closures/:closure
//   POST   /v1/pro/garages/:id/rdv/notify                   { email } : code vers l'adresse qui recevra les demandes ; …/notify/code { code }
//   GET    /v1/pro/garages/:id/rdv/requests?view=todo|upcoming|past
//   POST   /v1/pro/garages/:id/rdv/requests/:req/accept     …/decline { reason, note? } · …/cancel { reason, note? }
// Automobiliste (sans compte) :
//   GET    /v1/rdv/garages/:id/times?services=vidange,montage:2   horaires libres, heure limite si l'on demandait maintenant
//   POST   /v1/rdv/requests                                 coordonnées et horaire : code par e-mail (201)
//   POST   /v1/rdv/requests/:id/code                        { code, day?, time? } : la demande part (horaire et capacité revérifiés)
//   POST   /v1/rdv/requests/:id/resend                      nouveau code
//   GET    /v1/rdv/me · POST /v1/rdv/me/cancel              suivi et annulation (en-tête x-rdv-token : jeton de l'automobiliste)
//   GET    /v1/rdv/action · POST /v1/rdv/action/accept · …/decline   page du garage ouverte depuis l'e-mail (jeton du garage)
// Tâche horaire (server/lambda.mjs, planification AWS) : tick() — expirations, rappels, relances de prix, e-mails restés en file.
//
// Les jetons des liens ne sont gardés qu'en empreinte ; ils sont recalculés (HMAC du secret de l'API et de l'identifiant de la demande)
// pour les e-mails envoyés plus tard. Ils ne passent jamais dans un chemin d'URL (les journaux notent le chemin) : en-tête x-rdv-token.
import { apiError, json, readJson } from "./lib/http.mjs";
import { hmac, sha256, toHex } from "./lib/crypto.mjs";
import { isUuid } from "./lib/validate.mjs";
import { bookingOf, createRdvRepo } from "./rdv-repo.mjs";
import { clientCodeMail, notifyCodeMail, requestMail } from "./lib/rdv-mail.mjs";
import { PRO_SERVICES, serviceLabel } from "../src/js/shared/pro-prices.js";
import { addrText, parseEmail, parsePhone, phoneText } from "../src/js/shared/garage-profile.js";
import { MODEL_MAX, MODEL_MIN, PLATE_RE, YEAR_MIN } from "../src/js/shared/rules.js";
import * as R from "../src/js/shared/rdv.js";
import * as W from "../src/js/shared/work.js";
import { NIL_SLOT, buildJob, pickPlan, planTimes } from "../src/js/shared/plan.js";
import { VEHICLES } from "../src/js/shared/pro-prices.js";
import { createCalendar } from "./calendar.mjs";

const NO_STORE = { "cache-control": "no-store" };
const GARAGE_RE = /^[0-9a-f-]{8,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAIL_BUDGET_MS = 4000; // envoi des e-mails juste après une action : au-delà, la tâche horaire prend le relais
const TICK_BUDGET_MS = 9000; // la fonction de l'API s'arrête à 15 s
const DAY_MS = 864e5;
const MESSAGE_MAX = 500;
const NOTE_MAX = 300;

const clean = (v) => String(v ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const cleanMultiline = (v) => String(v ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const chars = (s) => [...s].length;
const isoOf = (msv) => (msv === null || msv === undefined ? null : new Date(msv).toISOString());
const maskEmail = (e) => {
  const [u, d] = String(e).split("@");
  return u && d ? `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}` : "";
};
const kmText = (m) => (m < 1000 ? `${Math.max(100, Math.round(m / 100) * 100)} m` : `${(m / 1000).toFixed(1).replace(".", ",").replace(",0", "")} km`);
const meters = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
const withTimeout = (promise, msv) =>
  Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("délai dépassé")), msv); t.unref && t.unref(); })]);

// Coordonnées et choix de l'automobiliste → { value } ou { error, field }
export function parseBooking(b, { thisYear }) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Objet attendu.", field: "body" };
  if (typeof b.garageId !== "string" || !GARAGE_RE.test(b.garageId.toLowerCase())) return { error: "Garage inconnu.", field: "garageId" };
  const services = R.parseServices(b.services);
  if (services.error) return { error: services.error, field: "services" };
  if (!R.isIsoDay(b.day) || !Number.isFinite(R.minOf(b.time))) return { error: "Choisissez un horaire.", field: "time" };
  const name = clean(b.name);
  if (chars(name) < 2 || chars(name) > 80 || !/\p{L}/u.test(name)) return { error: "Indiquez votre nom (80 caractères au plus).", field: "name" };
  const email = parseEmail(b.email);
  if (email.error || !email.value) return { error: "Adresse e-mail invalide.", field: "email" };
  const phone = parsePhone(b.phone);
  if (phone.error) return { error: "Téléphone : un numéro, par exemple 06 12 34 56 78.", field: "phone" };
  const car = clean(b.car);
  if (chars(car) < MODEL_MIN || chars(car) > MODEL_MAX) return { error: `Votre voiture : de ${MODEL_MIN} à ${MODEL_MAX} caractères (ex. Peugeot 208).`, field: "car" };
  const year = b.year;
  if (!Number.isInteger(year) || year < YEAR_MIN || year > thisYear + 1) return { error: `Année du modèle : de ${YEAR_MIN} à ${thisYear + 1}.`, field: "year" };
  const plate = typeof b.plate === "string" ? b.plate.trim().toUpperCase() : "";
  if (plate && !PLATE_RE.test(plate)) return { error: "Immatriculation au format AB-123-CD, ou rien.", field: "plate" };
  const message = cleanMultiline(b.message);
  if (chars(message) > MESSAGE_MAX) return { error: `Message : ${MESSAGE_MAX} caractères au plus.`, field: "message" };
  if (b.remindPrice !== undefined && typeof b.remindPrice !== "boolean") return { error: "remindPrice : true ou false.", field: "remindPrice" };
  const vehicle = b.vehicle === undefined || b.vehicle === null ? "" : b.vehicle;
  if (vehicle && !VEHICLES.some((x) => x.id === vehicle)) return { error: "Type de véhicule inconnu.", field: "vehicle" };
  return {
    value: {
      garageId: b.garageId.toLowerCase(),
      services: services.value,
      day: b.day,
      start: R.minOf(b.time),
      mode: b.drop === true ? "drop" : undefined,
      name,
      email: email.value,
      phone: phone.value,
      car,
      year,
      plate,
      message,
      remindPrice: b.remindPrice === true,
      vehicle,
      trap: typeof b.website === "string" && b.website.trim() !== "",
    },
  };
}

// Motif d'un refus ou d'une annulation : { reason (code), note (facultatif) } → { value } ou { error }
function parseReason(b, list, { required = true } = {}) {
  const reason = b && typeof b.reason === "string" ? b.reason : "";
  if (reason && !list.some((r) => r[0] === reason)) return { error: "Motif inconnu." };
  if (required && !reason) return { error: "Choisissez un motif." };
  const note = cleanMultiline(b && b.note);
  if (chars(note) > NOTE_MAX) return { error: `Mot facultatif : ${NOTE_MAX} caractères au plus.` };
  return { value: { reason, note } };
}

export function createRdv({ db, config, now = Date.now, log = () => {}, send, secret, proRepo, newCode }) {
  const cfg = config.rdv;
  const repo = createRdvRepo(db, { now });
  const digest = async (text) => toHex(await hmac(await secret(), text));
  const tokenFor = async (kind, id) => Buffer.from(await hmac(await secret(), `rdv-link:${kind}:${id}`)).toString("base64url");
  const tokenHash = async (token) => toHex(await sha256(token));
  const today = () => R.parisParts(now()).iso;
  const links = async (r, b) => {
    const site = cfg.siteUrl;
    const contact = b && b.contact;
    return {
      site: site + "/",
      pro: site + "/pro/",
      track: `${site}/rendez-vous/#c=${await tokenFor("c", r.id)}`,
      action: `${site}/rendez-vous/#g=${await tokenFor("g", r.id)}`,
      route: contact && Number.isFinite(contact.lat) ? `https://www.google.com/maps/dir/?api=1&destination=${contact.lat},${contact.lon}` : "",
    };
  };

  // ---- ce qu'un garage montre et peut offrir
  const ctxOf = (b) => ({ hours: (b.profile && b.profile.hours) || null, closures: b.closures, holidays: b.settings ? b.settings.holidays : R.DEFAULT_SETTINGS.holidays });
  const settingsOf = (b) => {
    const s = b.settings;
    return s ? { minDelayH: s.minDelayH, horizonDays: s.horizonDays, stepMin: s.stepMin, holidays: s.holidays } : { ...R.DEFAULT_SETTINGS };
  };
  const garageInfo = (b) => {
    const p = b.profile || {}, c = b.contact || {};
    return { name: p.name || c.name || "", addr: p.street ? addrText(p) : [c.addr, c.pc].filter(Boolean).join(", "), phone: p.phone ? phoneText(p.phone) : "" };
  };
  // ce qui manque pour ouvrir les rendez-vous en ligne (en mode avancé, les créneaux sont remplacés par les ressources de l'atelier)
  const missing = (b) => [
    ...(b.profile && b.profile.hours && Object.keys(b.profile.hours).length ? [] : ["hours"]),
    ...(b.settings && b.settings.notifyEmail ? [] : ["notify"]),
    ...(b.slots.length || calendar.advanced(b) ? [] : ["slots"]),
  ];
  const isOpen = (b) => !!(b && b.settings && b.settings.enabled && !b.settings.paused && !missing(b).length);
  async function engine(r, b, nowMs) {
    const t = R.parisParts(nowMs).iso;
    const settings = settingsOf(b);
    return { nowMs, ctx: ctxOf(b), settings, slots: b.slots, bookings: await r.bookings(b.garageId, t, R.addDays(t, settings.horizonDays + 1)) };
  }
  // Calendrier avancé (server/calendar.mjs) : mêmes réglages et même vue d'une demande
  const calendar = createCalendar({ repo, now, log, drain: (o) => drain(o), ctxOf, settingsOf, garageView: (r) => garageView(r) });

  // ---- horaires des deux modes derrière une même façade : semaine type en créneaux (simple) ou ressources de l'atelier (avancé)
  async function planner(r, b, nowMs) {
    if (!calendar.advanced(b)) return { kind: "simple", args: await engine(r, b, nowMs) };
    return { kind: "advanced", w: await calendar.world(r, b, nowMs) };
  }
  // ce que demandent ces prestations : { need } | { needVehicle, need } | { error: "not_open" }
  function needOf(p, b, services, vehicle = "") {
    if (p.kind === "simple") {
      const minutes = R.neededMinutes(services, b.minutes);
      if (minutes === null || !b.slots.some((s) => services.every((x) => s.services.includes(x.id)))) return { error: "not_open" };
      return { need: { services, minutes } };
    }
    if (services.some((x) => !p.w.reqs[x.id] || !p.w.reqs[x.id].online)) return { error: "not_open" };
    const job = buildJob(services, p.w.reqs, vehicle);
    if (job.error) return { error: "not_open" };
    const need = { services, minutes: Math.min(2400, Math.max(15, job.labour)), job };
    return job.needVehicle && !vehicle ? { needVehicle: true, need } : { need };
  }
  const daysOf = (p, need, opts = {}) => (p.kind === "simple" ? R.freeTimes({ ...p.args, need, ...opts }) : planTimes(p.w, need.job, opts));
  const pickOf = (p, need, wanted) => (p.kind === "simple" ? R.pickOffer({ ...p.args, need }, wanted) : pickPlan(p.w, need.job, wanted));
  const daysView = (days) =>
    days.map((d) => ({
      day: d.day,
      label: R.dayLabel(d.day, { short: true }),
      times: d.times.map((t) => ({ t: R.hm(t.start), ...(t.mode === "drop" ? { drop: true, until: R.hm(t.until), end: R.hm(t.end) } : t.plan ? { end: R.hm(t.end) } : {}) })),
    }));
  const servicesView = (list) => list.map((s) => ({ id: s.id, qty: s.qty, label: R.serviceText(s) }));

  // Les prestations qu'un garage ouvert prend en ligne avec au moins un horaire libre dans les 14 jours (quantité 1) : lecture publique.
  // Map(id → { services, auto? }) ; auto : celles qu'il confirme aussitôt (calendrier avancé).
  async function openServices(garageIds) {
    const open = await repo.openAmong(garageIds);
    const out = new Map();
    const nowMs = now();
    for (const id of open) {
      const b = await repo.bundle(id, today());
      if (!isOpen(b)) continue;
      const p = await planner(repo, b, nowMs);
      const list = [], auto = [];
      for (const s of PRO_SERVICES) {
        const n = needOf(p, b, [{ id: s.id, qty: 1 }]);
        if (n.error) continue;
        if (!daysOf(p, n.need, { maxDays: 14, first: true }).length) continue;
        list.push(s.id);
        if (n.need.job && n.need.job.auto) auto.push(s.id);
      }
      if (list.length) out.set(id, { services: list, ...(auto.length ? { auto } : {}) });
    }
    return out;
  }

  // ---------------------------------------------------------------- e-mails (file)
  // Envoie les e-mails en attente : ceux de ces demandes (juste après une action), ou tous (tâche horaire), dans le temps donné.
  async function drain({ requestIds, budgetMs = MAIL_BUDGET_MS } = {}) {
    const t0 = Date.now();
    const out = { sent: 0, failed: 0, skipped: 0 };
    const due = await repo.dueMails(50, requestIds);
    for (const m of due) {
      if (Date.now() - t0 > budgetMs) break;
      if (!(await repo.claimMail(m.id, m.attempts))) continue;
      try {
        const done = await deliver(m);
        if (done === "skipped") out.skipped++;
        else out.sent++;
        await repo.mailSent(m.id);
      } catch (e) {
        out.failed++;
        await repo.mailFailed(m.id, (e && e.message) || e).catch(() => {});
        log({ level: "warn", msg: "rendez-vous : e-mail non envoyé", event: "rdv_mail_failed", kind: m.kind, attempt: m.attempts + 1, error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    return out;
  }
  async function deliver(m) {
    const r = m.request_id ? await repo.getRequest(m.request_id) : null;
    if (m.request_id && (!r || r.anonymized_at)) return "skipped"; // demande effacée entre-temps : plus rien à dire
    const b = await repo.bundle(m.garage_id, today());
    const garage = r ? { name: r.garage_name, addr: r.garage_addr, phone: r.garage_phone ? phoneText(r.garage_phone) : "" } : b ? garageInfo(b) : { name: "", addr: "", phone: "" };
    const toGarage = m.kind.startsWith("garage_");
    const to = toGarage ? b && b.settings && b.settings.notifyEmail : r && r.email;
    if (!to) return "skipped"; // garage sans adresse de notification (retiré entre-temps), demande sans e-mail
    const c = { r: r || {}, garage, links: await links(r || { id: "none" }, b), alternatives: [], reason: "" };
    if (r && r.reason) c.reason = R.reasonText(r.cancelled_by === "client" ? R.CLIENT_CANCEL_REASONS : r.status === "declined" ? R.DECLINE_REASONS : R.GARAGE_CANCEL_REASONS, r.reason);
    if (["client_declined", "client_expired", "client_cancelled"].includes(m.kind) && b) c.alternatives = await alternatives(r, b).catch(() => []);
    if ((m.kind === "garage_new" || m.kind === "garage_booked") && b) {
      const info = r.slot_id === NIL_SLOT || calendar.advanced(b) ? (await calendar.planInfo(b.garageId, [r.id])).get(r.id) : null;
      if (info || r.slot_id === NIL_SLOT) c.plan = info ? { ...info, proposed: !info.fixed && !!b.calendar && b.calendar.autoAssign === false } : null;
      else c.slot = slotInfo(r, b, await repo.bookings(b.garageId, r.day, r.day));
    }
    if (m.kind === "client_confirmed") c.ics = R.icsCalendar([icsEvent(r)], now());
    if (m.kind === "client_moved") c.ics = R.icsCalendar([{ ...icsEvent(r), sequence: Math.floor(now() / 60000) % 2147483647 }], now());
    if (m.kind === "client_confirmed" && r.slot_id === NIL_SLOT && r.sent_at && r.decided_at === r.sent_at) c.auto = true;
    if (m.kind === "client_ready") c.opening = b ? W.nextOpening(ctxOf(b), now()) : ""; // lot 3c : quand venir la chercher
    const mail = requestMail(m.kind, c);
    await withTimeout(send.mail({ to, from: cfg.emailFrom, subject: mail.subject, text: mail.text, html: mail.html, replyTo: m.kind === "garage_new" ? r.email : undefined, attachments: mail.attachments, channel: "rdv" }), MAIL_BUDGET_MS);
    log({ level: "info", msg: "rendez-vous : e-mail envoyé", event: "rdv_mail", kind: m.kind });
    return "sent";
  }
  const icsEvent = (r) => ({
    uid: `${r.id}@pixcar.fr`,
    start: r.starts_at,
    end: r.ends_at,
    summary: `${R.servicesText(r.services)} · ${r.garage_name}`,
    location: r.garage_addr,
    description: [r.mode === "drop" ? `Voiture déposée entre ${R.timeLabel(r.start_min)} et ${R.timeLabel(Math.min(r.start_min + 60, r.end_min))}.` : "", r.garage_phone ? `Garage : ${phoneText(r.garage_phone)}` : "", "Rendez-vous pris sur Pixcar."].filter(Boolean).join("\n"),
  });
  // créneau de la demande et places restantes à cette heure (e-mail et liste du garage)
  function slotInfo(r, b, bookings) {
    const slot = b.slots.find((s) => s.id === r.slot_id);
    if (!slot) return null;
    const mine = bookings.filter((x) => x.slotId === slot.id && x.day === r.day && R.holds(x, now()));
    // à l'heure : le plus grand nombre de voitures en même temps pendant la demande (elle comprise) ; dépôt : les voitures du jour
    const points = [r.start_min, ...mine.map((x) => x.start).filter((p) => p > r.start_min && p < r.end_min)];
    const busy = slot.mode === "drop" ? mine.length : Math.max(0, ...points.map((p) => mine.filter((x) => x.start <= p && p < x.end).length));
    return { name: slot.name, capacity: slot.capacity, left: Math.max(0, slot.capacity - busy) };
  }
  // jusqu'à 3 autres garages à moins de 20 km qui prennent ces prestations en ligne, avec leur premier horaire libre
  async function alternatives(r, b) {
    const c = b.contact;
    if (!c || !Number.isFinite(c.lat)) return [];
    const near = (await repo.openGaragesNear({ lat: c.lat, lon: c.lon, radiusM: 20_000, exclude: b.garageId }))
      .map((g) => ({ ...g, d: meters(c, g) }))
      .filter((g) => g.d <= 20_000)
      .sort((x, y) => x.d - y.d)
      .slice(0, 10);
    const out = [];
    const nowMs = now();
    for (const g of near) {
      if (out.length >= 3) break;
      const ob = await repo.bundle(g.garage_id, today());
      if (!isOpen(ob)) continue;
      const p = await planner(repo, ob, nowMs);
      const n = needOf(p, ob, r.services);
      if (n.error) continue;
      const first = daysOf(p, n.need, { first: true })[0];
      if (!first) continue;
      const info = garageInfo(ob);
      out.push({ name: info.name, km: kmText(g.d), city: ob.profile && ob.profile.city ? ob.profile.city : "", first: `${R.dayLabel(first.day, { short: true })} dès ${R.timeLabel(first.times[0].start)}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- tâche horaire
  async function tick() {
    const t0 = Date.now();
    const left = () => TICK_BUDGET_MS - (Date.now() - t0);
    const out = { expired: 0, reminded: 0, followedUp: 0, mails: null };
    for (const x of await repo.dueExpiries(100)) {
      if (left() < 4000) break;
      if (await repo.tx((r) => r.expire(x.id, x.garage_id, cfg.pauseAfter))) out.expired++;
    }
    const p = R.parisParts(now());
    if (p.min >= 12 * 60) {
      for (const x of await repo.dueReminders(R.addDays(p.iso, 1), 100)) {
        if (left() < 4000) break;
        if (await repo.tx((r) => r.remind(x.id, x.garage_id))) out.reminded++;
      }
    }
    if (p.min >= 10 * 60) {
      for (const x of await repo.dueFollowUps(R.addDays(p.iso, -7), R.addDays(p.iso, -1), 100)) {
        if (left() < 4000) break;
        if (await repo.tx((r) => r.followUp(x.id, x.garage_id))) out.followedUp++;
      }
    }
    out.mails = await drain({ budgetMs: Math.max(1000, left() - 500) });
    log({ level: "info", msg: "rendez-vous : tâche horaire", event: "rdv_tick", ...out, mails: undefined, sent: out.mails.sent, failed: out.mails.failed });
    return out;
  }

  // ---------------------------------------------------------------- vues
  const effective = (r, nowMs) => (r.status === "pending" && r.deadline <= nowMs ? "expired" : r.status);
  const reasonOf = (r) => (r.reason ? R.reasonText(r.cancelled_by === "client" ? R.CLIENT_CANCEL_REASONS : r.status === "declined" ? R.DECLINE_REASONS : R.GARAGE_CANCEL_REASONS, r.reason) : "");
  const whenView = (r) => ({
    day: r.day,
    label: R.whenLabel(r.day, r.start_min),
    start: R.hm(r.start_min),
    end: R.hm(r.end_min),
    mode: r.mode,
    ...(r.mode === "drop" ? { until: R.hm(Math.min(r.start_min + 60, r.end_min)) } : r.slot_id === NIL_SLOT ? { back: R.hm(r.end_min) } : {}),
    startsAt: isoOf(r.starts_at),
    endsAt: isoOf(r.ends_at),
  });
  const garageView = (r) => ({
    status: effective(r, now()),
    id: r.id,
    when: whenView(r),
    services: servicesView(r.services),
    minutes: r.minutes,
    client: { name: r.name, email: r.email, phone: r.phone, phoneText: phoneText(r.phone), car: r.car, year: r.car_year, plate: r.plate },
    message: r.message,
    deadline: isoOf(r.deadline),
    deadlineText: r.deadline ? R.instantLabel(r.deadline) : "",
    sentAt: isoOf(r.sent_at),
    decidedAt: isoOf(r.decided_at),
    ...(r.reason ? { reason: r.reason, reasonText: reasonOf(r) } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
  });

  // ---------------------------------------------------------------- routes du garage (appelées par pro.mjs, compte vérifié)
  const noGarage = () => apiError(404, "not_found", "Garage introuvable, ou pas rattaché à ce compte.");
  const allow = (methods) => apiError(405, "method_not_allowed", "Méthode non autorisée.", {}, { allow: methods });
  async function garageRoute(request, sub, garageId, rest) {
    if (!cfg.enabled) return apiError(404, "rdv_disabled", "Les rendez-vous en ligne ne sont pas encore ouverts.");
    const owned = await proRepo.ownedGarage(garageId, sub);
    if (!owned) return noGarage();
    const method = request.method;
    const parts = rest.split("/").filter(Boolean);
    const body = async (max = 2048) => {
      const out = await readJson(request, max);
      return out.error ? null : out.value;
    };
    if (!parts.length) return method === "GET" ? getAgenda(garageId) : allow("GET");
    const [what, id, act] = parts;
    if (what === "settings" && !id) return method === "PUT" ? putSettings(garageId, sub, await body()) : allow("PUT");
    if (what === "slots") {
      if (!id) return method === "POST" ? saveSlot(garageId, sub, null, await body()) : allow("POST");
      if (!isUuid(id) || act) return apiError(404, "not_found", "Créneau introuvable.");
      return method === "PUT" ? saveSlot(garageId, sub, id, await body()) : method === "DELETE" ? deleteSlot(garageId, id) : allow("PUT, DELETE");
    }
    if (what === "closures") {
      if (!id) return method === "POST" ? saveClosure(garageId, sub, null, await body()) : allow("POST");
      if (!isUuid(id) || act) return apiError(404, "not_found", "Fermeture introuvable.");
      return method === "PUT" ? saveClosure(garageId, sub, id, await body()) : method === "DELETE" ? deleteClosure(garageId, id) : allow("PUT, DELETE");
    }
    if (what === "notify") {
      if (method !== "POST") return allow("POST");
      if (!id) return postNotify(garageId, sub, owned, await body(512));
      if (id === "code" && !act) return postNotifyCode(garageId, await body(256));
      return apiError(404, "not_found", "Route inconnue.");
    }
    if (what === "requests") {
      if (!id) return method === "GET" ? listRequests(garageId, new URL(request.url).searchParams.get("view")) : allow("GET");
      if (!isUuid(id) || !["accept", "decline", "cancel", "move"].includes(act) || parts.length > 3) return apiError(404, "not_found", "Route inconnue.");
      if (method !== "POST") return allow("POST");
      if (act === "move") return calendar.move(garageId, sub, id.toLowerCase(), await body(1024));
      return decide(garageId, id.toLowerCase(), act, act === "accept" ? {} : (await body(1024)) || {});
    }
    if (what === "calendar") return calendar.route(request, sub, garageId, parts.slice(1), body);
    return apiError(404, "not_found", "Route inconnue.");
  }

  async function getAgenda(garageId) {
    const t = today();
    const b = await repo.bundle(garageId, t);
    const s = b.settings;
    const settings = settingsOf(b);
    return json(
      200,
      {
        today: t,
        enabled: !!(s && s.enabled),
        paused: !!(s && s.paused),
        open: isOpen(b),
        missing: missing(b),
        settings,
        slots: b.slots.map((x) => ({ id: x.id, name: x.name, days: x.days, start: R.hm(x.start), end: R.hm(x.end), mode: x.mode, capacity: x.capacity, services: x.services })),
        closures: b.closures.map((c) => ({ id: c.id, first: c.first, last: c.last, label: c.label })),
        holidays: R.nextHolidays(t, 3),
        hours: (b.profile && b.profile.hours) || null,
        services: PRO_SERVICES.filter((x) => Number.isInteger(b.minutes[x.id])).map((x) => ({ id: x.id, minutes: b.minutes[x.id] })),
        notify: {
          email: (s && s.notifyEmail) || "",
          ...(s && s.notifyPending ? { pending: s.notifyPending, codeLive: !!(s.notifyCodeHash && s.notifyCodeExpiresAt > now()) } : {}),
        },
        garage: garageInfo(b),
        todo: await repo.countTodo(garageId),
        calendar: { mode: (b.calendar && b.calendar.mode) || "simple", started: !!b.calendar },
      },
      NO_STORE,
    );
  }

  async function putSettings(garageId, sub, b) {
    const parsed = R.parseSettings(b);
    if (parsed.error) return apiError(422, "validation", parsed.error);
    const v = parsed.value;
    if (v.enabled === true) {
      const bundle = await repo.bundle(garageId, today());
      const miss = missing(bundle);
      if (miss.length)
        return apiError(409, "not_ready", miss[0] === "hours" ? "Renseignez d'abord vos horaires d'ouverture (Mon garage)." : miss[0] === "notify" ? "Vérifiez d'abord l'adresse qui recevra les demandes." : "Ajoutez d'abord un créneau à votre semaine type.", { missing: miss });
    }
    const cols = {};
    if (v.enabled !== undefined) Object.assign(cols, { enabled: v.enabled }, v.enabled ? { paused: false, missed: 0 } : {}); // rouvrir lève la pause
    if (v.minDelayH !== undefined) cols.min_delay_h = v.minDelayH;
    if (v.horizonDays !== undefined) cols.horizon_days = v.horizonDays;
    if (v.stepMin !== undefined) cols.step_min = v.stepMin;
    if (v.holidays !== undefined) cols.holidays = v.holidays;
    await repo.saveSettings(garageId, sub, cols);
    if (v.enabled !== undefined) log({ level: "info", msg: v.enabled ? "rendez-vous en ligne ouverts" : "rendez-vous en ligne fermés", event: "rdv_enabled", garageId, enabled: v.enabled });
    return getAgenda(garageId);
  }

  async function saveSlot(garageId, sub, id, b) {
    const bundle = await repo.bundle(garageId, today());
    const parsed = R.parseSlot(b, { hours: bundle.profile && bundle.profile.hours, offered: bundle.minutes });
    if (parsed.error) return apiError(422, "validation", parsed.error, { field: parsed.field });
    if (!id && (await repo.countSlots(garageId)) >= R.MAX_SLOTS) return apiError(409, "too_many", `${R.MAX_SLOTS} créneaux au plus.`);
    if (!bundle.settings) await repo.saveSettings(garageId, sub, {});
    const saved = id ? await repo.updateSlot(garageId, id, parsed.value) : await repo.createSlot(garageId, parsed.value);
    if (!saved) return apiError(404, "not_found", "Créneau introuvable.");
    return getAgenda(garageId);
  }
  async function deleteSlot(garageId, id) {
    if (!(await repo.deleteSlot(garageId, id))) return apiError(404, "not_found", "Créneau introuvable.");
    return getAgenda(garageId);
  }

  async function saveClosure(garageId, sub, id, b) {
    const parsed = R.parseClosure(b, today());
    if (parsed.error) return apiError(422, "validation", parsed.error);
    if (!id && (await repo.countClosures(garageId, today())) >= R.MAX_CLOSURES) return apiError(409, "too_many", `${R.MAX_CLOSURES} fermetures à venir au plus.`);
    const c = parsed.value;
    const cancelled = await repo.tx(async (r) => {
      const saved = id ? await r.updateClosure(garageId, id, c) : await r.createClosure(garageId, c);
      if (!saved) return null;
      return r.cancelForClosure(garageId, c.first, c.last);
    });
    if (cancelled === null) return apiError(404, "not_found", "Fermeture introuvable.");
    if (cancelled) {
      log({ level: "info", msg: "rendez-vous annulés par une fermeture", event: "rdv_closure_cancel", garageId, count: cancelled });
      await drain({});
    }
    const res = await getAgenda(garageId);
    const out = await res.json();
    return json(200, { ...out, cancelled }, NO_STORE);
  }
  async function deleteClosure(garageId, id) {
    if (!(await repo.deleteClosure(garageId, id))) return apiError(404, "not_found", "Fermeture introuvable.");
    return getAgenda(garageId);
  }

  async function postNotify(garageId, sub, owned, b) {
    const email = parseEmail(b && b.email);
    if (email.error || !email.value) return apiError(422, "validation", "Adresse e-mail invalide.", { field: "email" });
    const code = newCode();
    const out = await repo.startNotify({
      garageId,
      accountId: sub,
      email: email.value,
      codeHash: await digest(`rdv-notify:${garageId}:${code}`),
      limits: { ttlSeconds: cfg.codeTtlSeconds, resendAfterSeconds: cfg.resendAfterSeconds, maxPerDay: cfg.notifyCodesPerDay },
    });
    if (out.kind === "wait") return apiError(429, "resend_too_soon", `Attendez ${out.retryAfter} s avant de redemander un code.`, { retryAfter: out.retryAfter }, { "retry-after": String(out.retryAfter) });
    if (out.kind === "limited") return apiError(429, "send_limited", "Trop de codes envoyés aujourd'hui pour ce garage. Réessayez demain.", {}, { "retry-after": "86400" });
    const garageName = (await repo.bundle(garageId, today())).profile?.name || (owned.contact && owned.contact.name) || "";
    const mail = notifyCodeMail({ code, garageName, minutes: Math.round(cfg.codeTtlSeconds / 60) });
    try {
      await withTimeout(send.mail({ to: email.value, from: cfg.emailFrom, subject: mail.subject, text: mail.text, channel: "rdv" }), MAIL_BUDGET_MS);
    } catch (e) {
      log({ level: "error", msg: "rendez-vous : code de l'adresse de notification non envoyé", error: String((e && e.message) || e).slice(0, 200) });
      return apiError(502, "send_failed", "Le code n'a pas pu être envoyé. Vérifiez l'adresse et réessayez.");
    }
    return json(200, { pending: email.value, expiresInSeconds: cfg.codeTtlSeconds, resendInSeconds: cfg.resendAfterSeconds }, NO_STORE);
  }
  async function postNotifyCode(garageId, b) {
    const code = String((b && b.code) || "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return apiError(422, "validation", "Le code compte 6 chiffres.");
    const out = await repo.tx((r) =>
      r.tryNotify({ garageId, maxAttempts: cfg.maxAttempts, matches: async (stored) => stored === (await digest(`rdv-notify:${garageId}:${code}`)) }),
    );
    if (out.kind === "verified") {
      log({ level: "info", msg: "rendez-vous : adresse de notification vérifiée", event: "rdv_notify_verified", garageId });
      return getAgenda(garageId);
    }
    if (out.kind === "bad") return apiError(422, "bad_code", out.attemptsLeft > 1 ? `Code incorrect. Encore ${out.attemptsLeft} essais.` : "Code incorrect. Dernier essai.", { attemptsLeft: out.attemptsLeft });
    if (out.kind === "locked") return apiError(423, "locked", "Trop de codes incorrects. Demandez un nouveau code.");
    if (out.kind === "expired") return apiError(410, "code_expired", "Ce code a expiré. Demandez-en un nouveau.");
    return apiError(409, "no_code", "Aucun code en cours : saisissez l'adresse et demandez un code.");
  }

  async function listRequests(garageId, view) {
    if (!["todo", "upcoming", "past"].includes(view)) return apiError(400, "bad_request", "view : todo, upcoming ou past.");
    const t = today();
    const [rows, b, todo] = await Promise.all([repo.listRequests(garageId, view, t), repo.bundle(garageId, t), repo.countTodo(garageId)]);
    const days = [...new Set(rows.filter((r) => r.status === "pending").map((r) => r.day))];
    const bookings = days.length ? (await Promise.all(days.map((d) => repo.bookings(garageId, d, d)))).flat() : [];
    const usePlan = (r) => r.slot_id === NIL_SLOT || calendar.advanced(b); // mode avancé : l'affectation remplace le créneau
    const plans = await calendar.planInfo(garageId, rows.filter(usePlan).map((r) => r.id));
    return json(
      200,
      {
        view,
        todo,
        requests: rows.map((r) => {
          const v = garageView(r);
          if (usePlan(r) && plans.has(r.id)) {
            const plan = plans.get(r.id);
            if (plan) v.plan = { ...plan, proposed: !plan.fixed && !!b.calendar && b.calendar.autoAssign === false }; // affectation à confirmer
          } else if (r.status === "pending") {
            const slot = slotInfo(r, b, bookings);
            if (slot) v.slot = slot;
          } else {
            const slot = b.slots.find((s) => s.id === r.slot_id);
            if (slot) v.slot = { name: slot.name };
          }
          return v;
        }),
      },
      NO_STORE,
    );
  }

  // accept | decline | cancel, par le garage (Espace Pro ou page de l'e-mail)
  async function decide(garageId, id, act, b) {
    let reason = { value: { reason: "", note: "" } };
    if (act === "decline") reason = parseReason(b, R.DECLINE_REASONS);
    if (act === "cancel") reason = parseReason(b, R.GARAGE_CANCEL_REASONS);
    if (reason.error) return apiError(422, "validation", reason.error);
    const out = await repo.tx(async (r) => {
      if (act === "accept") return r.accept(id, garageId);
      if (act === "decline") return r.decline(id, garageId, reason.value.reason, reason.value.note);
      return r.cancelByGarage(id, garageId, reason.value.reason, reason.value.note, cfg.pauseAfter);
    });
    if (!out) {
      const cur = await repo.getForGarage(garageId, id);
      if (!cur) return apiError(404, "not_found", "Demande introuvable.");
      const st = effective(cur, now());
      // lot 3c : la voiture est déjà au garage (ou plus loin) : on n'annule plus depuis l'Espace Pro
      if (act === "cancel" && st === "confirmed" && W.workState(await repo.cal.workOrder(id)) !== "planned") return apiError(409, "started", "L'intervention a commencé : ce rendez-vous ne s'annule plus ici. Appelez le client.", { status: st });
      return apiError(409, "state", st === "expired" ? "L'heure limite est passée : la demande est annulée et le client prévenu." : act === "cancel" ? "Ce rendez-vous ne peut plus être annulé." : "Cette demande a déjà reçu une réponse.", { status: st });
    }
    log({ level: "info", msg: `rendez-vous : ${act}`, event: "rdv_decision", garageId, decision: act });
    await drain({ requestIds: [id] });
    return json(200, garageView(out), NO_STORE);
  }

  // ---------------------------------------------------------------- routes publiques (/v1/rdv)
  const notOpen = () => apiError(404, "not_open", "Ce garage ne prend pas de rendez-vous en ligne pour ces prestations.");
  async function publicRoute(request, path, ctx) {
    if (!cfg.enabled || !config.pro.enabled) return apiError(404, "rdv_disabled", "Les rendez-vous en ligne ne sont pas encore ouverts.");
    const method = request.method;
    let m;
    if ((m = /^\/v1\/rdv\/garages\/([^/]+)\/times$/.exec(path))) {
      if (method !== "GET") return allow("GET");
      const id = m[1].toLowerCase();
      if (!GARAGE_RE.test(id)) return notOpen();
      return getTimes(request, id);
    }
    if (path === "/v1/rdv/requests") return method === "POST" ? postRequest(request, ctx) : allow("POST");
    if ((m = /^\/v1\/rdv\/requests\/([^/]+)\/(code|resend)$/.exec(path))) {
      if (method !== "POST") return allow("POST");
      const id = m[1].toLowerCase();
      if (!isUuid(id)) return apiError(404, "not_found", "Demande introuvable.");
      return m[2] === "code" ? postCode(request, id) : postResend(id);
    }
    if (path === "/v1/rdv/me" || path === "/v1/rdv/me/cancel") {
      const r = await byToken(request, "client");
      if (r.error) return r.error;
      if (path === "/v1/rdv/me") return method === "GET" ? json(200, await clientView(r.row), NO_STORE) : allow("GET");
      return method === "POST" ? clientCancel(request, r.row) : allow("POST");
    }
    if (path === "/v1/rdv/action" || path === "/v1/rdv/action/accept" || path === "/v1/rdv/action/decline") {
      const r = await byToken(request, "garage");
      if (r.error) return r.error;
      if (path === "/v1/rdv/action") return method === "GET" ? json(200, actionView(r.row), NO_STORE) : allow("GET");
      if (method !== "POST") return allow("POST");
      const act = path.endsWith("/accept") ? "accept" : "decline";
      let b = {};
      if (act === "decline") {
        const out = await readJson(request, 1024);
        if (out.error) return apiError(400, "bad_json", "JSON attendu.");
        b = out.value || {};
      }
      const res = await decide(r.row.garage_id, r.row.id, act, b);
      if (!res.ok) return res;
      return json(200, actionView(await repo.getRequest(r.row.id)), NO_STORE);
    }
    return apiError(404, "not_found", "Route inconnue.");
  }

  async function getTimes(request, garageId) {
    const parsed = R.parseServices(new URL(request.url).searchParams.get("services") || "");
    if (parsed.error) return apiError(400, "bad_request", parsed.error);
    const vehicle = new URL(request.url).searchParams.get("vehicle") || "";
    if (vehicle && !VEHICLES.some((x) => x.id === vehicle)) return apiError(400, "bad_request", "Type de véhicule inconnu.");
    const b = await repo.bundle(garageId, today());
    if (!isOpen(b)) return notOpen();
    const nowMs = now();
    const p = await planner(repo, b, nowMs);
    const n = needOf(p, b, parsed.value, vehicle);
    if (n.error) return notOpen();
    const deadline = R.deadlineAfter(nowMs, ctxOf(b));
    const g = garageInfo(b);
    const head = { garage: { id: garageId, name: g.name, addr: g.addr }, services: servicesView(parsed.value), deadline: isoOf(deadline), deadlineText: R.instantLabel(deadline) };
    // mode avancé : type de véhicule à demander d'abord (durées par type), confirmation immédiate ou non
    const extra = p.kind === "advanced" ? { auto: n.need.job.auto, needVehicle: !!n.needVehicle, ...(n.needVehicle || vehicle ? { vehicles: VEHICLES, vehicle } : {}) } : {};
    if (n.needVehicle) return json(200, { ...head, ...extra, days: [] }, NO_STORE);
    return json(200, { ...head, ...extra, days: daysView(daysOf(p, n.need)) }, NO_STORE);
  }

  const limitedCodes = (scope) =>
    apiError(429, "send_limited", scope === "global" ? "Trop de demandes en ce moment. Réessayez dans une heure." : scope === "email" ? "Trop de codes envoyés à cette adresse aujourd'hui. Réessayez demain." : "Trop de demandes depuis cette connexion. Réessayez plus tard.", { scope }, { "retry-after": scope === "global" || scope === "ip_hour" ? "3600" : "86400" });
  async function timeTaken(p, need) {
    return apiError(409, "time_taken", "Cet horaire n'est plus libre. Choisissez-en un autre.", { days: daysView(daysOf(p, need)) });
  }

  async function postRequest(request, ctx) {
    const body = await readJson(request, 4096);
    if (body.error) return apiError(400, "bad_json", "JSON attendu (4 Ko au plus).");
    const parsed = parseBooking(body.value, { thisYear: Number(today().slice(0, 4)) });
    if (parsed.error) return apiError(422, "validation", parsed.error, { field: parsed.field });
    const v = parsed.value;
    const draftView = (id) => ({ id, email: v.email, expiresInSeconds: cfg.codeTtlSeconds, resendInSeconds: cfg.resendAfterSeconds, resendsLeft: cfg.maxSends - 1 });
    if (v.trap) {
      log({ level: "info", msg: "rendez-vous : champ piège rempli", event: "rdv_trap" });
      return json(201, draftView(crypto.randomUUID()), NO_STORE); // le robot croit avoir réussi ; rien n'est enregistré ni envoyé
    }
    const [ipHash, emailHash] = await Promise.all([digest(`rdv-ip:${ctx.ip || "unknown"}`), digest(`rdv-email:${v.email}`)]);
    const n = await repo.codeCounts({ ipHash, emailHash });
    if (n.globalHour >= cfg.codesGlobalPerHour) return limitedCodes("global");
    if (n.ipHour >= cfg.codesPerIpPerHour) return limitedCodes("ip_hour");
    if (n.ipDay >= cfg.codesPerIpPerDay) return limitedCodes("ip_day");
    if (n.emailDay >= cfg.codesPerEmailPerDay) return limitedCodes("email");
    const b = await repo.bundle(v.garageId, today());
    if (!isOpen(b)) return notOpen();
    const p = await planner(repo, b, now());
    const wish = needOf(p, b, v.services, v.vehicle);
    if (wish.error) return notOpen();
    if (wish.needVehicle) return apiError(422, "validation", "Choisissez le type de votre véhicule.", { field: "vehicle" });
    const need = wish.need;
    const offer = pickOf(p, need, { day: v.day, start: v.start, mode: v.mode });
    if (!offer) return timeTaken(p, need);
    if ((await repo.pendingAtGarage(v.garageId)) >= cfg.pendingPerGarage) return apiError(409, "garage_busy", "Ce garage a déjà beaucoup de demandes en attente. Réessayez plus tard ou appelez-le.");
    const id = crypto.randomUUID();
    const code = newCode();
    const g = garageInfo(b);
    const profile = b.profile || {};
    await repo.tx(async (r) => {
      await r.createDraft({
        id, garageId: v.garageId, slotId: offer.slotId || NIL_SLOT, day: v.day, start: offer.start, end: offer.end,
        startsAt: R.parisInstant(v.day, offer.start), endsAt: R.parisInstant(v.day, offer.end), mode: offer.mode,
        services: v.services, minutes: need.minutes, name: v.name, email: v.email, phone: v.phone, car: v.car, carYear: v.year, plate: v.plate, message: v.message, remindPrice: v.remindPrice,
        codeHash: await digest(`rdv-code:${id}:${code}`), ttlSeconds: cfg.codeTtlSeconds, ipHash,
        garageName: g.name.slice(0, 120), garageAddr: g.addr.slice(0, 300), garagePhone: profile.phone || "",
      });
      await r.logCode({ ipHash, emailHash, garageId: v.garageId });
      if (offer.plan) await r.cal.saveWorkOrder(v.garageId, id, { vehicle: v.vehicle }); // le type de véhicule, jusqu'à l'envoi
    });
    const mail = clientCodeMail({ code, garageName: g.name, minutes: Math.round(cfg.codeTtlSeconds / 60) });
    try {
      await withTimeout(send.mail({ to: v.email, from: cfg.emailFrom, subject: mail.subject, text: mail.text, channel: "rdv" }), MAIL_BUDGET_MS);
    } catch (e) {
      await repo.burnCode(id).catch(() => {});
      log({ level: "error", msg: "rendez-vous : code non envoyé", error: String((e && e.message) || e).slice(0, 200) });
      return apiError(502, "send_failed", "Le code n'a pas pu être envoyé. Vérifiez votre adresse e-mail et réessayez.");
    }
    log({ level: "info", msg: "rendez-vous : code envoyé", event: "rdv_code", garageId: v.garageId });
    return json(201, draftView(id), NO_STORE);
  }

  async function postResend(id) {
    const code = newCode();
    const out = await repo.resendCode({ id, codeHash: await digest(`rdv-code:${id}:${code}`), ttlSeconds: cfg.codeTtlSeconds, resendAfterSeconds: cfg.resendAfterSeconds, maxSends: cfg.maxSends });
    if (out.kind === "closed") return apiError(409, "closed", "Cette demande est close. Recommencez.");
    if (out.kind === "wait") return apiError(429, "resend_too_soon", `Attendez ${out.retryAfter} s avant de redemander un code.`, { retryAfter: out.retryAfter }, { "retry-after": String(out.retryAfter) });
    if (out.kind === "limited") return apiError(429, "send_limited", "Plus de nouvel envoi possible pour cette demande. Recommencez.");
    const r = await repo.getRequest(id);
    const mail = clientCodeMail({ code, garageName: r.garage_name, minutes: Math.round(cfg.codeTtlSeconds / 60) });
    try {
      await withTimeout(send.mail({ to: r.email, from: cfg.emailFrom, subject: mail.subject, text: mail.text, channel: "rdv" }), MAIL_BUDGET_MS);
    } catch (e) {
      log({ level: "error", msg: "rendez-vous : code non envoyé", error: String((e && e.message) || e).slice(0, 200) });
      return apiError(502, "send_failed", "Le code n'a pas pu être envoyé. Réessayez.");
    }
    return json(200, { id, email: r.email, expiresInSeconds: cfg.codeTtlSeconds, resendInSeconds: cfg.resendAfterSeconds, resendsLeft: Math.max(0, cfg.maxSends - r.sends) }, NO_STORE);
  }

  // Le bon code fait partir la demande : horaire et capacité revérifiés (un autre horaire peut être choisi avec le même code s'il a été
  // pris entre-temps), limites par adresse e-mail, heure limite calculée maintenant, jetons, e-mails.
  async function postCode(request, id) {
    const body = await readJson(request, 512);
    if (body.error) return apiError(400, "bad_json", "JSON attendu.");
    const b0 = body.value || {};
    const code = String(b0.code || "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return apiError(422, "validation", "Le code compte 6 chiffres.");
    const change = b0.day !== undefined || b0.time !== undefined ? { day: b0.day, start: R.minOf(b0.time), mode: b0.drop === true ? "drop" : undefined } : null;
    if (change && (!R.isIsoDay(change.day) || !Number.isFinite(change.start))) return apiError(422, "validation", "Horaire invalide.");
    const nowMs = now();
    const out = await repo.tx(async (r) => {
      const q = await r.getRequest(id);
      if (!q) return { kind: "not_found" };
      if (q.status !== "code") return { kind: "closed" };
      if (q.attempts >= cfg.maxAttempts) return { kind: "locked" };
      if (!q.code_hash || !(q.code_expires_at > nowMs)) return { kind: "expired" };
      if (!(await r.countAttempt(id, q.attempts))) return { kind: "busy" };
      if (q.code_hash !== (await digest(`rdv-code:${id}:${code}`))) {
        const left = cfg.maxAttempts - q.attempts - 1;
        if (left <= 0) await r.burnCode(id);
        return left <= 0 ? { kind: "locked" } : { kind: "bad", attemptsLeft: left };
      }
      await r.lockGarage(q.garage_id);
      const mine = await r.pendingOf(q.email, q.garage_id);
      if (mine.here >= cfg.pendingPerEmailPerGarage) return { kind: "too_many", scope: "garage" };
      if (mine.total >= cfg.pendingPerEmail) return { kind: "too_many", scope: "total" };
      if ((await r.pendingAtGarage(q.garage_id)) >= cfg.pendingPerGarage) return { kind: "garage_busy" };
      const b = await r.bundle(q.garage_id, R.parisParts(nowMs).iso);
      if (!isOpen(b)) return { kind: "not_open" };
      const p = await planner(r, b, nowMs);
      const order = p.kind === "advanced" ? await r.cal.workOrder(id) : null;
      const vehicle = (order && order.vehicle) || "";
      const n = needOf(p, b, q.services, vehicle);
      if (n.error || n.needVehicle) return { kind: "not_open" };
      const need = n.need;
      const wanted = change || { day: q.day, start: q.start_min, mode: q.mode };
      const offer = pickOf(p, need, wanted);
      if (!offer) return { kind: "time_taken", days: daysView(daysOf(p, need)) }; // le code reste valable pour choisir un autre horaire
      const deadline = R.deadlineAfter(nowMs, ctxOf(b));
      const auto = p.kind === "advanced" && need.job.auto;
      const [clientToken, garageToken] = await Promise.all([tokenFor("c", id), tokenFor("g", id)]);
      const sent = await r.send({
        id,
        garageId: q.garage_id,
        offer: { ...offer, slotId: offer.slotId || NIL_SLOT, day: wanted.day, startsAt: R.parisInstant(wanted.day, offer.start), endsAt: R.parisInstant(wanted.day, offer.end) },
        deadline,
        clientTokenHash: await tokenHash(clientToken),
        garageTokenHash: await tokenHash(garageToken),
        auto,
      });
      if (!sent) return { kind: "closed" };
      if (offer.plan) await calendar.writePlan(r, q.garage_id, id, offer.plan, vehicle); // ressources retenues dans la même transaction
      return { kind: "sent", clientToken };
    });
    switch (out.kind) {
      case "sent": {
        log({ level: "info", msg: "rendez-vous : demande envoyée au garage", event: "rdv_request" });
        await drain({ requestIds: [id] });
        const r = await repo.getRequest(id);
        return json(200, { token: out.clientToken, ...(await clientView(r)) }, NO_STORE);
      }
      case "bad":
        return apiError(422, "bad_code", out.attemptsLeft > 1 ? `Code incorrect. Encore ${out.attemptsLeft} essais.` : "Code incorrect. Dernier essai.", { attemptsLeft: out.attemptsLeft });
      case "locked":
        return apiError(423, "locked", "Trop de codes incorrects : recommencez la demande.");
      case "expired":
        return apiError(410, "code_expired", "Ce code a expiré. Demandez-en un nouveau.");
      case "busy":
        return apiError(409, "busy", "Un autre essai est en cours. Réessayez.");
      case "too_many":
        return apiError(409, "too_many_pending", out.scope === "garage" ? "Vous avez déjà une demande en attente chez ce garage. Attendez sa réponse, ou annulez-la depuis le lien reçu par e-mail." : "Vous avez déjà 3 demandes en attente. Attendez une réponse, ou annulez-en une depuis le lien reçu par e-mail.", { scope: out.scope });
      case "garage_busy":
        return apiError(409, "garage_busy", "Ce garage a déjà beaucoup de demandes en attente. Réessayez plus tard ou appelez-le.");
      case "not_open":
        return notOpen();
      case "time_taken":
        return apiError(409, "time_taken", "Cet horaire vient d'être pris. Choisissez-en un autre : votre code reste valable.", { days: out.days });
      case "closed":
        return apiError(409, "closed", "Cette demande est déjà envoyée, ou close. Recommencez si besoin.");
      default:
        return apiError(404, "not_found", "Demande introuvable.");
    }
  }

  // ---- accès par jeton (en-tête x-rdv-token)
  async function byToken(request, kind) {
    const token = request.headers.get("x-rdv-token") || "";
    const gone = () => ({ error: apiError(404, "link_invalid", "Ce lien ne fonctionne plus : il a expiré, ou la demande a été effacée.") });
    if (!TOKEN_RE.test(token)) return gone();
    const hash = await tokenHash(token);
    const row = kind === "client" ? await repo.byClientToken(hash) : await repo.byGarageToken(hash);
    if (!row) return gone();
    const nowMs = now();
    // l'automobiliste : jusqu'à 7 jours après le rendez-vous ; le garage : jusqu'à l'heure limite (puis l'Espace Pro)
    if (kind === "client" && nowMs > Math.max(row.ends_at, row.decided_at || 0) + 7 * DAY_MS) return gone();
    if (kind === "garage" && row.status === "pending" && nowMs > row.deadline + DAY_MS) return gone();
    return { row };
  }
  async function clientView(r) {
    const nowMs = now();
    const st = effective(r, nowMs);
    const b = await repo.bundle(r.garage_id, today());
    const c = b && b.contact;
    const view = {
      status: st,
      when: whenView(r),
      services: servicesView(r.services),
      garage: { name: r.garage_name, addr: r.garage_addr, phone: r.garage_phone, phoneText: r.garage_phone ? phoneText(r.garage_phone) : "", ...(c && Number.isFinite(c.lat) ? { lat: c.lat, lon: c.lon } : {}) },
      car: { model: r.car, year: r.car_year, plate: r.plate },
      email: r.email,
      deadline: isoOf(r.deadline),
      deadlineText: r.deadline ? R.instantLabel(r.deadline) : "",
      sentAt: isoOf(r.sent_at),
      sentText: r.sent_at ? R.dayLabel(R.parisParts(r.sent_at).iso) : "",
      decidedAt: isoOf(r.decided_at),
      decidedText: r.decided_at ? R.dayLabel(R.parisParts(r.decided_at).iso) : "",
      canCancel: (st === "pending" || st === "confirmed") && r.starts_at > nowMs,
      past: r.ends_at < nowMs,
      remindPrice: r.remind_price,
      ...(r.reason ? { reasonText: reasonOf(r) } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
    };
    if (["declined", "expired", "cancelled"].includes(st) && r.cancelled_by !== "client" && b) view.alternatives = await alternatives(r, b).catch(() => []);
    // lot 3c : l'avancement de l'intervention, dès « Voiture reçue » (rien pour un client noté absent)
    if (st === "confirmed") {
      const o = await repo.cal.workOrder(r.id);
      const state = W.workState(o);
      if (W.clientWorkLabel(state)) view.progress = { status: state, label: W.clientWorkLabel(state), at: isoOf(o.statusAt), atText: o.statusAt ? R.instantLabel(o.statusAt) : "" };
    }
    return view;
  }
  async function clientCancel(request, row) {
    const body = await readJson(request, 512);
    const reason = parseReason(body.error ? {} : body.value || {}, R.CLIENT_CANCEL_REASONS, { required: false });
    if (reason.error) return apiError(422, "validation", reason.error);
    const out = await repo.tx((r) => r.cancelByClient(row.id, reason.value.reason));
    if (!out) return apiError(409, "state", "Ce rendez-vous ne peut plus être annulé ici. Appelez le garage.");
    log({ level: "info", msg: "rendez-vous : annulé par l'automobiliste", event: "rdv_client_cancel" });
    await drain({ requestIds: [row.id] });
    return json(200, await clientView(out), NO_STORE);
  }
  const actionView = (r) => ({ ...garageView(r), garage: { name: r.garage_name }, open: effective(r, now()) === "pending" });

  return {
    garageRoute,
    publicRoute,
    openServices,
    todo: (garageId) => (cfg.enabled ? repo.countTodo(garageId) : Promise.resolve(null)),
    // résumé pour le tableau de bord : demandes à traiter et mode du calendrier (l'écran Planning n'existe qu'en mode avancé)
    summary: async (garageId) => {
      const [todo, c] = await Promise.all([repo.countTodo(garageId), repo.cal.getCalendar(garageId)]);
      return { todo, mode: (c && c.mode) || "simple" };
    },
    tick,
    drain,
    purge: () => repo.purge(),
    revoke: (garageId) => repo.revoke(garageId),
    stats: () => repo.stats(),
    repo,
    tokenFor,
  };
}
