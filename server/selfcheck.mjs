// Auto-contrôle de la base : rejoue, avec le vrai code de l'API (repo.mjs), tout ce que l'application demande à la base, et dit ligne par
// ligne ce qui marche. Sert à valider Amazon Aurora DSQL (dont on ne peut pas tout vérifier sans le service : syntaxe réellement acceptée,
// conflits de concurrence réels, index uniques partiels) ; il tourne aussi sur PostgreSQL et PGlite, ce qui prouve que les vérifications
// elles-mêmes sont justes : un échec sur DSQL est alors une vraie différence du service.
// Écrit des données d'essai (garages « custom:selfcheck-… », empreinte d'adresse « 5e1fc4ec… ») et les supprime toutes à la fin.
import { randomHex } from "./lib/crypto.mjs";
import { createRepo } from "./repo.mjs";
import { createProRepo } from "./pro-repo.mjs";
import { createRdvRepo } from "./rdv-repo.mjs";
import { addDays, freeTimes, parisInstant, parisParts } from "../src/js/shared/rdv.js";
import { defaultReq, parseResource, parseSkill, parseStaff, parseUnavail } from "../src/js/shared/plan.js";

const TEST_IP = "5e1fc4ec".repeat(8);
const LAT = 0.5; // plein Atlantique : aucune vraie zone d'utilisateurs
const LON = -20.5;
const INDEXES = [
  "garages_area_idx", "repairs_garage_service_idx", "repairs_no_duplicate_idx", "repairs_pending_idx", "write_log_ip_idx", "write_log_at_idx",
  "garage_contacts_area_idx", "garage_contacts_domain_idx", "garage_contacts_import_idx", "pro_claims_account_idx", "pro_claims_garage_idx",
  "pro_claims_one_owner_idx", "pro_events_garage_idx", "pro_events_account_idx", "pro_events_at_idx", "pro_prices_status_idx", "pro_visits_once_idx",
  "pro_visits_day_idx", "pro_profile_changes_one_pending_idx", "pro_profile_changes_garage_idx", "pro_profile_changes_status_idx",
  "rdv_slots_garage_idx", "rdv_closures_garage_idx", "rdv_requests_garage_day_idx", "rdv_requests_status_deadline_idx", "rdv_requests_status_day_idx",
  "rdv_requests_email_idx", "rdv_requests_client_token_idx", "rdv_requests_garage_token_idx", "rdv_events_ip_idx", "rdv_events_email_idx", "rdv_events_at_idx",
  "rdv_mails_due_idx", "rdv_mails_request_idx",
  "rdv_staff_garage_idx", "rdv_skills_garage_idx", "rdv_staff_skills_garage_idx", "rdv_resources_garage_idx", "rdv_unavail_garage_idx", "rdv_assignments_garage_day_idx",
  "rdv_assignments_request_idx", "rdv_assignments_target_idx", "rdv_work_orders_garage_idx", "rdv_history_garage_idx", "rdv_history_at_idx",
  "rdv_blocks_garage_day_idx", "rdv_blocks_day_idx",
];

export async function selfcheck(db, { log = () => {} } = {}) {
  const repo = createRepo(db);
  const tag = randomHex(4);
  const garageA = `custom:selfcheck-${tag}-a`;
  const garageB = `custom:selfcheck-${tag}-b`;
  const garageC = `custom:selfcheck-${tag}-c`;
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: Date.now() - t0, detail: detail === undefined ? "" : String(detail) });
    } catch (e) {
      checks.push({ name, ok: false, ms: Date.now() - t0, detail: `${e.message}${e.code ? ` [${e.code}]` : ""}` });
    }
    log(`${checks[checks.length - 1].ok ? "✔" : "✘"} ${name}`);
  };
  const expect = (cond, what) => {
    if (!cond) throw new Error("attendu : " + what);
  };
  const garage = (id) => ({ id, name: "Garage d'auto-contrôle", addr: "", lat: LAT, lon: LON, chainId: "" });
  const repair = (over = {}) => ({
    id: crypto.randomUUID(), garage: garage(garageA), pos: { lat: LAT, lon: LON }, serviceId: "vidange", priceCents: 4250, date: "2026-09-12", rating: 5, comment: "auto-contrôle", model: "Essai", year: 2020, ...over,
  });
  const ctx = (over = {}) => ({ tokenHash: randomHex(32), plateHash: randomHex(32), ipHash: TEST_IP, limitPerHour: 100000, limitGlobalPerMinute: 100000, moderate: true, ...over });
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

  await check("connexion et rôle de base", async () => (await db.query("SELECT current_user AS who")).rows[0].who);

  await check(`les ${INDEXES.length} index de l'application existent et sont valides`, async () => {
    const marks = INDEXES.map((_, i) => `$${i + 1}`).join(", ");
    const rows = (await db.query(`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN (${marks})`, INDEXES)).rows;
    const missing = INDEXES.filter((n) => !rows.some((r) => r.name === n));
    expect(!missing.length, "index absents : " + missing.join(", "));
    expect(rows.every((r) => r.valid === true || r.valid === "t"), "index invalides : " + rows.filter((r) => !(r.valid === true || r.valid === "t")).map((r) => r.name).join(", "));
    return rows.map((r) => r.name).join(", ");
  });

  const first = repair({ id: crypto.randomUUID() });
  const firstCtx = ctx();
  await check("déclaration enregistrée (garage + réparation + journal d'écritures, une transaction)", async () => {
    const out = await repo.insertRepair(first, firstCtx);
    expect(out.kind === "created" && out.status === "approved", "created/approved, reçu " + JSON.stringify(out));
  });
  await check("la même déclaration renvoyée est un rejeu, sans écriture", async () => {
    const before = await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1", [TEST_IP]);
    const out = await repo.insertRepair(first, firstCtx);
    expect(out.kind === "replay", "replay, reçu " + out.kind);
    expect((await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1", [TEST_IP])) === before, "journal inchangé");
  });
  await check("le même identifiant avec un autre jeton est refusé (conflit)", async () => {
    const out = await repo.insertRepair(first, ctx({ plateHash: firstCtx.plateHash }));
    expect(out.kind === "conflict", "conflict, reçu " + out.kind);
  });
  await check("même plaque, garage, prestation et jour sous un autre identifiant : doublon (index unique partiel)", async () => {
    const out = await repo.insertRepair(repair(), ctx({ plateHash: firstCtx.plateHash }));
    expect(out.kind === "duplicate", "duplicate, reçu " + out.kind);
  });
  await check("même plaque un autre jour : acceptée", async () => {
    const out = await repo.insertRepair(repair({ date: "2026-09-13" }), ctx({ plateHash: firstCtx.plateHash }));
    expect(out.kind === "created", "created, reçu " + out.kind);
  });
  await check("lecture publique d'une zone : le mois seulement, les champs documentés seulement", async () => {
    const area = await repo.listArea({ lat: LAT, lon: LON, radiusKm: 3 });
    const g = area.garages.find((x) => x.id === garageA);
    expect(g && g.repairs.length >= 2, "au moins 2 réparations du garage d'essai");
    const r = g.repairs[0];
    expect(/^\d{4}-\d{2}$/.test(r.month), "mois AAAA-MM, reçu " + r.month);
    expect(Object.keys(r).sort().join() === "id,model,month,price,rating,serviceId,year", "champs : " + Object.keys(r).join());
    return `${g.repairs.length} réparations`;
  });
  await check("concurrence : deux déclarations simultanées d'un même NOUVEAU garage sont toutes deux enregistrées (reprise sur conflit)", async () => {
    const [a, b] = await Promise.all([
      repo.insertRepair(repair({ garage: garage(garageB) }), ctx()),
      repo.insertRepair(repair({ garage: garage(garageB) }), ctx()),
    ]);
    expect(a.kind === "created" && b.kind === "created", `created + created, reçu ${a.kind} + ${b.kind}`);
    expect((await count("SELECT count(*) AS n FROM garages WHERE id = $1", [garageB])) === 1, "un seul garage");
  });
  await check("concurrence : deux déclarations identiques simultanées → une enregistrée, une refusée comme doublon", async () => {
    const plateHash = randomHex(32);
    const [a, b] = await Promise.all([
      repo.insertRepair(repair({ garage: garage(garageC), serviceId: "revision" }), ctx({ plateHash })),
      repo.insertRepair(repair({ garage: garage(garageC), serviceId: "revision" }), ctx({ plateHash })),
    ]);
    const kinds = [a.kind, b.kind].sort().join("+");
    expect(kinds === "created+duplicate", "created+duplicate, reçu " + kinds);
    expect((await count("SELECT count(*) AS n FROM repairs WHERE garage_id = $1 AND service_id = 'revision'", [garageC])) === 1, "une seule ligne");
  });
  const oddPlate = randomHex(32);
  const oddRepair = repair({ garage: garage(garageB), serviceId: "pneus", priceCents: 90000 });
  await check("modération : un prix à plus de 3 fois la médiane attend une relecture, un prix normal est accepté", async () => {
    for (let i = 0; i < 6; i++) await repo.insertRepair(repair({ garage: garage(garageB), serviceId: "pneus", priceCents: 5000 + i * 100 }), ctx());
    const odd = await repo.insertRepair(oddRepair, ctx({ plateHash: oddPlate }));
    const normal = await repo.insertRepair(repair({ garage: garage(garageB), serviceId: "pneus", priceCents: 5200 }), ctx());
    expect(odd.status === "pending", "pending, reçu " + odd.status);
    expect(normal.status === "approved", "approved, reçu " + normal.status);
    return "médiane lue par décalage (OFFSET / LIMIT)";
  });
  await check("modération : liste d'attente, statistiques, approbation / rejet, nouvelle déclaration après rejet", async () => {
    const pending = (await repo.listPending(100)).filter((r) => r.garage_id.startsWith("custom:selfcheck-"));
    expect(pending.length === 1, "1 déclaration en attente, reçu " + pending.length);
    const stats = await repo.stats();
    expect(stats.approved > 0 && stats.pending >= 1, "statistiques : " + JSON.stringify(stats));
    expect(await repo.setStatus(pending[0].id, "rejected"), "rejet pris en compte");
    expect((await repo.listPending(100)).every((r) => r.id !== pending[0].id), "plus en attente");
    // une déclaration rejetée libère l'index unique partiel (status <> 'rejected') : la même plaque peut la redéposer
    const again = await repo.insertRepair({ ...oddRepair, id: crypto.randomUUID(), priceCents: 5100 }, ctx({ plateHash: oddPlate }));
    expect(again.kind === "created", "created après rejet, reçu " + again.kind);
  });
  await check("suppression par l'auteur : refusée avec un autre jeton, acceptée avec le bon", async () => {
    const mine = repair({ garage: garage(garageC), serviceId: "freins" });
    const mineCtx = ctx();
    await repo.insertRepair(mine, mineCtx);
    expect(!(await repo.deleteRepair(mine.id, randomHex(32))), "mauvais jeton refusé");
    expect(await repo.deleteRepair(mine.id, mineCtx.tokenHash), "bon jeton accepté");
    expect(!(await repo.deleteRepair(mine.id, mineCtx.tokenHash)), "déjà supprimée");
  });
  await check("effacement à la demande d'une personne (toutes les déclarations d'une empreinte de plaque)", async () => {
    const plateHash = randomHex(32);
    await repo.insertRepair(repair({ garage: garage(garageC), serviceId: "batterie" }), ctx({ plateHash }));
    await repo.insertRepair(repair({ garage: garage(garageC), serviceId: "courroie" }), ctx({ plateHash }));
    expect((await repo.deleteByPlate(plateHash)) === 2, "2 déclarations supprimées");
  });
  await check("cache Overpass (jsonb) : écriture, mise à jour, relecture avec son âge", async () => {
    await repo.putUpstream(`selfcheck:${tag}`, { a: 1 });
    await repo.putUpstream(`selfcheck:${tag}`, { a: 2, liste: [1, 2, 3] });
    const got = await repo.getUpstream(`selfcheck:${tag}`);
    expect(got && got.body.a === 2 && got.body.liste.length === 3, "contenu mis à jour");
    expect(got.ageSeconds >= 0 && got.ageSeconds < 120, "âge plausible : " + got.ageSeconds);
  });
  await check("purge par lots : 1 200 entrées anciennes du journal sont supprimées, les récentes restent", async () => {
    const rows = Array.from({ length: 400 }, () => "(gen_random_uuid(), $1, now() - interval '40 days')").join(", ");
    for (let chunk = 0; chunk < 3; chunk++) await db.query(`INSERT INTO write_log (id, ip_hash, at) VALUES ${rows}`, [TEST_IP]); // 3 × 400 lignes, chacune sous la limite de DSQL
    const recent = await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1 AND at > now() - interval '1 day'", [TEST_IP]);
    const out = await repo.purge();
    expect(out.writeLog >= 1200, "au moins 1 200 supprimées, reçu " + out.writeLog);
    expect((await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1 AND at > now() - interval '1 day'", [TEST_IP])) === recent, "les récentes sont intactes");
  });
  await check("purge de conservation : une déclaration de plus de 24 mois est supprimée, une plus récente reste, et 0 mois ne supprime rien", async () => {
    const old = repair({ id: crypto.randomUUID(), garage: garage(garageB), serviceId: "freins" });
    const recent = repair({ id: crypto.randomUUID(), garage: garage(garageB), serviceId: "pneus" });
    await repo.insertRepair(old, ctx());
    await repo.insertRepair(recent, ctx());
    await db.query("UPDATE repairs SET created_at = now() - interval '30 months' WHERE id = $1", [old.id]);
    await db.query("UPDATE repairs SET created_at = now() - interval '12 months' WHERE id = $1", [recent.id]);
    const there = (id) => count("SELECT count(*) AS n FROM repairs WHERE id = $1", [id]);
    expect((await repo.purge({ repairRetentionMonths: 0 })).repairs === 0 && (await there(old.id)) === 1, "0 mois : rien n'est supprimé");
    const out = await repo.purge({ repairRetentionMonths: 24 });
    expect(out.repairs >= 1, "au moins 1 déclaration supprimée, reçu " + out.repairs);
    expect((await there(old.id)) === 0 && (await there(recent.id)) === 1, "l'ancienne a disparu, la récente reste");
  });
  await check("suppression d'un garage : ses réparations disparaissent avec lui (clé étrangère, ON DELETE CASCADE)", async () => {
    await db.query("DELETE FROM garages WHERE id = $1", [garageB]);
    expect((await count("SELECT count(*) AS n FROM repairs WHERE garage_id = $1", [garageB])) === 0, "plus aucune réparation");
  });

  // ---- Espace Pro : contacts privés, demande, code, rattachement unique (garages « 5e1fc4ec-…-<tag> », comptes « selfcheck-<tag>-… »)
  const pro = createProRepo(db);
  const proGarage = `5e1fc4ec-0000-4000-8000-0000${tag}`;
  const proGarage2 = `5e1fc4ec-0000-4000-8001-0000${tag}`;
  const acc = (x) => `selfcheck-${tag}-${x}`;
  const proLimits = { perGarageAccountPerDay: 1000, perGaragePerDay: 1000, perAccountPerDay: 1000, globalPerHour: 1_000_000 };
  const claimA = crypto.randomUUID();
  const claimB = crypto.randomUUID();
  const newClaim = (id, who, codeHash) =>
    pro.createClaim({ id, accountId: acc(who), garageId: proGarage, siret: "73282932000074", channel: "email", holderName: "Auto Contrôle", holderRole: "other", target: "selfcheck@example.invalid", targetHash: randomHex(32), targetHint: "s•••••@example.invalid", codeHash, ttlSeconds: 600, maxPending: 3, limits: proLimits });
  await check("Espace Pro : contacts privés écrits par lot (jsonb), relus autour d'un point et par domaine", async () => {
    const row = (garageId, n) => ({ garageId, name: "Garage d'auto-contrôle", addr: "", pc: "", lat: LAT + n / 10000, lon: LON, brand: false, emails: ["selfcheck@example.invalid"], phones: ["+33600000000"], webDomain: `selfcheck-${tag}.invalid` });
    expect((await pro.upsertContacts([row(proGarage, 0), row(proGarage2, 1)], `selfcheck-${tag}`)) === 2, "2 lignes écrites");
    expect((await pro.upsertContacts([row(proGarage, 0)], `selfcheck-${tag}`)) === 1, "mise à jour (ON CONFLICT DO UPDATE)");
    const near = await pro.contactsNear({ lat: LAT, lon: LON, radiusM: 300 });
    expect(near.some((g) => g.garage_id === proGarage && Array.isArray(g.emails) && g.emails[0] === "selfcheck@example.invalid"), "garage retrouvé avec ses e-mails");
    expect((await pro.domainCount(`selfcheck-${tag}.invalid`)) === 2, "domaine porté par 2 garages");
  });
  await check("Espace Pro : demande créée avec son code, essai faux compté, nouveau code, bon code : garage rattaché", async () => {
    expect((await newClaim(claimA, "a", "a".repeat(64))).kind === "created", "demande créée");
    const bad = await pro.tryCode({ id: claimA, accountId: acc("a"), maxAttempts: 5, matches: async (h) => h === "f".repeat(64) });
    expect(bad.kind === "bad" && bad.attemptsLeft === 4, "essai faux : " + JSON.stringify(bad));
    const sent = await pro.resend({ id: claimA, accountId: acc("a"), codeHash: "b".repeat(64), ttlSeconds: 600, resendAfterSeconds: 0, maxSends: 3, limits: proLimits });
    expect(sent.kind === "sent" && sent.target === "selfcheck@example.invalid", "nouveau code : " + sent.kind);
    const ok = await pro.tryCode({ id: claimA, accountId: acc("a"), maxAttempts: 5, matches: async (h) => h === "b".repeat(64) });
    expect(ok.kind === "verified", "rattaché : " + ok.kind);
    const row = (await db.query("SELECT status, target, code_hash, attempts FROM pro_claims WHERE id = $1", [claimA])).rows[0];
    expect(row.status === "verified" && row.target === null && row.code_hash === null, "cible et code effacés");
  });
  await check("Espace Pro : un second compte ne peut pas rattacher le même garage (index unique partiel)", async () => {
    expect((await newClaim(claimB, "b", "c".repeat(64))).kind === "owned", "refusé à la création");
    let refused = false;
    try {
      await db.query(
        "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', 'Auto Contrôle', 'other', $4, 'x')",
        [claimB, acc("b"), proGarage, randomHex(32)],
      );
    } catch (e) {
      refused = /^23/.test(String(e.code || "")) || /duplicate|unique/i.test(e.message);
    }
    expect(refused, "second compte vérifié refusé par la base");
    expect((await pro.revoke(proGarage)) === 1 && !(await pro.verifiedOwner(proGarage)), "rattachement retiré");
  });

  // ---- Espace Pro, « Vos premiers prix » : un garage vérifié (proGarage2) annonce ses prix ; ses visites sont comptées
  const ovt = "custom:ovt-" + proGarage2.replace(/-/g, "");
  const area = (await db.query("SELECT area_y, area_x FROM garage_contacts WHERE garage_id = $1", [proGarage2])).rows[0] || {};
  const price = (serviceId, kind, priceCents) => pro.savePrice({ garageId: proGarage2, serviceId, kind, priceCents, vehicles: ["city"], includes: ["parts", "labour"], accountId: acc("c"), area: { y: area.area_y, x: area.area_x } });
  await check("Espace Pro : prix annoncé enregistré puis remplacé (clé double, jsonb), « sur devis » sans prix, prix très éloigné mis en relecture, prix payés du garage retrouvés", async () => {
    await db.query(
      "INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, target_hash, target_hint, verified_at) VALUES ($1, $2, $3, '73282932000074', 'verified', 'email', 'Auto Contrôle', 'other', $4, 'x', now())",
      [crypto.randomUUID(), acc("c"), proGarage2, randomHex(32)],
    );
    expect((await price("vidange", "fixed", 8900)).status === "published", "prix publié");
    const again = await price("vidange", "from", 9900);
    expect(again.kind === "from" && again.price_cents === 9900 && Array.isArray(again.vehicles) && again.vehicles[0] === "city", "prix remplacé");
    expect((await count("SELECT count(*) AS n FROM pro_prices WHERE garage_id = $1", [proGarage2])) === 1, "une seule ligne par prestation");
    expect((await price("diag", "quote", null)).price_cents === null, "sur devis, sans prix");
    for (let i = 0; i < 5; i++) await repo.insertRepair(repair({ garage: garage(ovt), serviceId: "clim", priceCents: 7000 + i * 100 }), ctx());
    expect((await price("clim", "fixed", 70000)).status === "review", "700 € contre une médiane de 72 € : relecture");
    const paid = await pro.paidPrices((await pro.ownedGarage(proGarage2, acc("c"))).contact);
    expect(paid.clim && paid.clim.n === 5 && paid.clim.median === 72, "médiane payée du garage : " + JSON.stringify(paid));
    expect((await pro.confirmPrices(proGarage2)) === 3, "trois prix confirmés");
  });
  await check("Espace Pro : lecture publique (garages vérifiés, prix publiés seulement) et visites comptées une fois par visiteur, jour et garage", async () => {
    const pub = await pro.publicGarages([proGarage2, proGarage]);
    expect(pub.length === 1 && pub[0].garage_id === proGarage2, "seul le garage vérifié");
    expect(pub[0].prices.map((p) => p.service_id).sort().join() === "diag,vidange", "sans le prix en relecture");
    const day = new Date().toISOString().slice(0, 10);
    const v1 = randomHex(32), v2 = randomHex(32);
    expect((await pro.recordVisit({ garageId: proGarage2, day, kind: "view", visitor: v1 })) === true, "visite comptée");
    expect((await pro.recordVisit({ garageId: proGarage2, day, kind: "view", visitor: v1 })) === false, "même visiteur le même jour : une fois");
    await pro.recordVisit({ garageId: proGarage2, day, kind: "view", visitor: v2 });
    await pro.recordVisit({ garageId: proGarage2, day, kind: "call", visitor: v1 });
    expect((await pro.recordVisit({ garageId: proGarage, day, kind: "view", visitor: v1 })) === false, "garage non vérifié : rien");
    const old = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    await pro.recordVisit({ garageId: proGarage2, day: old, kind: "view", visitor: v1 });
    const since = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    const st = await pro.visitStats(proGarage2, { since30: since(30), since60: since(60) });
    expect(st.view.recent === 2 && st.view.previous === 1 && st.call.recent === 1, "statistiques : " + JSON.stringify(st));
  });
  await check("Mon garage : fiche (horaires jsonb), un seul changement en attente par champ (index unique partiel), approbation, prestations (décocher retire le prix), lecture publique", async () => {
    const hours = { mo: [["08:00", "12:00"], ["14:00", "18:30"]], sa: [["08:00", "12:00"]] };
    const p = await pro.saveProfile(proGarage2, acc("c"), { website: "https://garage.example/", hours });
    expect(p.website === "https://garage.example/" && p.hours && p.hours.mo[1][1] === "18:30", "fiche écrite, horaires relus : " + JSON.stringify(p.hours));
    expect((await pro.saveProfile(proGarage2, acc("c"), { email: "atelier@garage.example" })).website === "https://garage.example/", "écriture partielle : le site reste");
    const first = await pro.requestChange({ id: crypto.randomUUID(), garageId: proGarage2, field: "phone", value: "+33561000002", accountId: acc("c") });
    const second = await pro.requestChange({ id: crypto.randomUUID(), garageId: proGarage2, field: "phone", value: "+33561000003", accountId: acc("c") });
    const pending = (await db.query("SELECT id FROM pro_profile_changes WHERE garage_id = $1 AND status = 'pending'", [proGarage2])).rows;
    expect(pending.length === 1 && pending[0].id === second.id && first.id !== second.id, "le second changement remplace le premier");
    let refused = false;
    try {
      await db.query("INSERT INTO pro_profile_changes (id, garage_id, field, value, status, account_id) VALUES ($1, $2, 'phone', '+33561000004', 'pending', $3)", [crypto.randomUUID(), proGarage2, acc("c")]);
    } catch {
      refused = true;
    }
    expect(refused, "l'index unique partiel refuse un second changement en attente");
    expect((await pro.countRecentChanges(proGarage2)) === 2, "demandes des dernières 24 h comptées (plafond des e-mails de relecture)");
    expect((await pro.decideChange({ id: second.id, decision: "approve" })).kind === "approved", "approuvé");
    expect((await pro.getProfile(proGarage2)).phone === "+33561000003", "téléphone publié");
    const s1 = await pro.saveService({ garageId: proGarage2, serviceId: "vidange", offered: false, minutes: null });
    expect(s1.priceRemoved === true, "décocher retire le prix annoncé");
    await pro.saveService({ garageId: proGarage2, serviceId: "montage", offered: true, minutes: 30 });
    const pub = (await pro.publicGarages([proGarage2]))[0];
    // vidange, diag et clim ont été cochées par l'annonce de leur prix (vérification précédente), vidange décochée ici, montage cochée
    const offered = Object.fromEntries(pub.services.map((x) => [x.service_id, x.offered]));
    expect(JSON.stringify(offered) === JSON.stringify({ clim: true, diag: true, montage: true, vidange: false }), "prestations : " + JSON.stringify(offered));
    expect(pub.profile && pub.profile.phone === "+33561000003" && !pub.services.some((x) => "minutes" in x), "lecture publique sans les temps moyens");
  });
  // ---- rendez-vous en ligne (lot 2) : un garage vérifié (proGarage2) ouvre ses rendez-vous ; une demande va jusqu'à son expiration.
  // Horloge de l'application fixée à un lundi 10:00 (heure de Paris) dans 3 semaines : aucune date réelle n'en dépend.
  const nextMonday = (() => {
    let d = parisParts(Date.now()).iso;
    d = addDays(d, 21);
    while (new Date(d + "T12:00:00Z").getUTCDay() !== 1) d = addDays(d, 1);
    return d;
  })();
  let rdvClock = parisInstant(nextMonday, 600);
  const rdv = createRdvRepo(db, { now: () => rdvClock });
  const rdvEmail = `selfcheck-${tag}@example.invalid`;
  let rdvId = null;
  await check("Rendez-vous : réglages, créneau (jsonb), fermeture (dates), demande avec code, horaires libres (moteur partagé), envoi (verrou du garage), file d'e-mails", async () => {
    await pro.saveProfile(proGarage2, acc("c"), { hours: { mo: [["08:00", "12:00"]], tu: [["08:00", "12:00"]], we: [["08:00", "12:00"]], th: [["08:00", "12:00"]], fr: [["08:00", "12:00"]] } });
    await pro.saveService({ garageId: proGarage2, serviceId: "vidange", offered: true, minutes: 45 });
    const st = await rdv.saveSettings(proGarage2, acc("c"), { enabled: true, min_delay_h: 0 });
    expect(st.enabled === true && st.minDelayH === 0 && st.horizonDays === 28, "réglages : " + JSON.stringify(st));
    await db.query("UPDATE rdv_settings SET notify_email = $2 WHERE garage_id = $1", [proGarage2, rdvEmail]);
    const slot = await rdv.createSlot(proGarage2, { name: "Auto-contrôle", days: ["mo", "tu", "we", "th", "fr"], start: 480, end: 720, mode: "hour", capacity: 1, services: ["vidange"] });
    expect(slot.services[0] === "vidange" && slot.days.length === 5, "créneau relu");
    const closed = addDays(nextMonday, 3);
    await rdv.createClosure(proGarage2, { first: closed, last: closed, label: "auto-contrôle" });
    const b = await rdv.bundle(proGarage2, nextMonday);
    expect(b && b.closures.length === 1 && b.closures[0].first === closed && b.minutes.vidange === 45 && b.slots.length === 1, "lecture groupée du garage");
    const ctx = { hours: b.profile.hours, closures: b.closures, holidays: true };
    const days = freeTimes({ nowMs: rdvClock, ctx, settings: { minDelayH: 0, horizonDays: 28, stepMin: 30 }, slots: b.slots, need: { services: [{ id: "vidange", qty: 1 }], minutes: 45 }, bookings: [] });
    // pas avant le surlendemain (heure limite : mardi midi, le créneau finit à midi), jamais le jour fermé
    expect(days.length && days[0].day >= addDays(nextMonday, 2) && !days.some((d) => d.day === closed), "horaires : " + JSON.stringify(days.slice(0, 2).map((d) => d.day)));
    rdvId = crypto.randomUUID();
    const day = days[0].day;
    await rdv.tx(async (r) => {
      await r.createDraft({ id: rdvId, garageId: proGarage2, slotId: slot.id, day, start: 480, end: 525, startsAt: parisInstant(day, 480), endsAt: parisInstant(day, 525), mode: "hour", services: [{ id: "vidange", qty: 1 }], minutes: 45,
        name: "Auto Contrôle", email: rdvEmail, phone: "+33600000000", car: "Essai", carYear: 2020, plate: "", message: "auto-contrôle", remindPrice: true, codeHash: "d".repeat(64), ttlSeconds: 600, ipHash: TEST_IP, garageName: "Garage d'auto-contrôle", garageAddr: "", garagePhone: "" });
      await r.logCode({ ipHash: TEST_IP, emailHash: "e".repeat(64), garageId: proGarage2 });
    });
    const n = await rdv.codeCounts({ ipHash: TEST_IP, emailHash: "e".repeat(64) });
    expect(n.ipHour === 1 && n.emailDay === 1, "envois de codes comptés : " + JSON.stringify(n));
    const q = await rdv.getRequest(rdvId);
    expect(q.status === "code" && q.code_expires_at > rdvClock && Array.isArray(q.services) && q.day === day, "brouillon relu");
    expect(await rdv.countAttempt(rdvId, 0), "essai compté");
    expect(!(await rdv.countAttempt(rdvId, 0)), "essai déjà compté par un autre : refusé");
    const sent = await rdv.tx(async (r) => {
      await r.lockGarage(proGarage2);
      const mine = await r.pendingOf(rdvEmail, proGarage2);
      expect(mine.total === 0, "aucune demande en attente");
      return r.send({ id: rdvId, garageId: proGarage2, offer: { slotId: slot.id, day, start: 480, end: 525, startsAt: parisInstant(day, 480), endsAt: parisInstant(day, 525), mode: "hour" }, deadline: parisInstant(addDays(nextMonday, 1), 720), clientTokenHash: randomHex(32), garageTokenHash: randomHex(32) });
    });
    expect(sent === true, "demande envoyée");
    expect((await rdv.pendingAtGarage(proGarage2)) === 1 && (await rdv.countTodo(proGarage2)) === 1, "une demande à traiter");
    const booked = await rdv.bookings(proGarage2, nextMonday, addDays(nextMonday, 28));
    expect(booked.length === 1 && booked[0].day === day && booked[0].start === 480, "horaire retenu");
    const due = await rdv.dueMails(10, [rdvId]);
    expect(due.length === 2 && due.every((m) => m.attempts === 0), "deux e-mails en file : " + due.map((m) => m.kind).join(", "));
    expect((await rdv.claimMail(due[0].id, 0)) && !(await rdv.claimMail(due[0].id, 0)), "un e-mail n'est pris qu'une fois");
    await rdv.mailSent(due[0].id);
    expect((await rdv.listRequests(proGarage2, "todo", nextMonday)).length === 1 && (await rdv.listRequests(proGarage2, "upcoming", nextMonday)).length === 0, "listes du garage");
  });
  await check("Rendez-vous : deux prises d'horaire simultanées sur un même garage passent l'une après l'autre (verrou du garage, reprise sur conflit)", async () => {
    const before = (await rdv.getSettings(proGarage2)).version;
    await Promise.all([1, 2].map(() => rdv.tx(async (r) => {
      await r.lockGarage(proGarage2);
      await r.pendingOf(rdvEmail, proGarage2);
    })));
    expect((await rdv.getSettings(proGarage2)).version === before + 2, "compteur incrémenté deux fois");
  });
  let calIds = null;
  await check("Calendrier avancé : réglages, compétence, mécanicien (jsonb, compétence datée), poste, exigences, absence, affectations et intervention (transaction), lecture groupée, conflits, historique", async () => {
    const q0 = await rdv.getRequest(rdvId);
    const at = parisInstant(q0.day, 480);
    const end = at + 45 * 6e4;
    calIds = await rdv.tx(async (r) => {
      const c = r.cal;
      const cal = await c.saveCalendar(proGarage2, acc("c"), { step: 3, receptionMin: 0, autoAssign: false });
      expect(cal.mode === "simple" && cal.step === 3 && cal.receptionMin === 0 && cal.autoAssign === false && cal.returnMin === 15, "réglages : " + JSON.stringify(cal));
      const skill = await c.saveSkill(proGarage2, null, parseSkill({ label: "Auto-contrôle", cert: true }).value);
      const staff = await c.saveStaff(proGarage2, null, parseStaff({ name: "Auto", skills: [{ id: skill, until: addDays(nextMonday, 365) }] }, { skillIds: new Set([skill]) }).value);
      const lift = await c.saveResource(proGarage2, null, parseResource({ name: "Pont n°1", type: "lift" }).value);
      await c.saveReq(proGarage2, "vidange", { ...defaultReq("vidange", 45), skills: [skill], vehicles: { suv: 60 } });
      await c.replaceAssignments(proGarage2, rdvId, [
        { target: "staff", targetId: staff, role: "labour", day: q0.day, start: at, end },
        { target: "resource", targetId: lift, role: "station", day: q0.day, start: at, end },
      ]);
      await c.saveWorkOrder(proGarage2, rdvId, { vehicle: "suv", workStart: at, workEnd: end, readyAt: end, returnAt: end + 15 * 6e4, labour: 45, immob: 45 });
      await c.log(proGarage2, acc("c"), "staff", staff, "auto-contrôle");
      // bloc interne (lot 3b) : créneau bloqué sur le pont, l'après-midi
      const hold = await c.saveBlock(proGarage2, acc("c"), null, { kind: "hold", label: "Auto-contrôle", services: [], day: q0.day, start: 840, end: 900, startsAt: parisInstant(q0.day, 840), endsAt: parisInstant(q0.day, 900), fixed: true });
      await c.replaceBlockAssignments(proGarage2, hold, [{ target: "resource", targetId: lift, role: "station", day: q0.day, start: parisInstant(q0.day, 840), end: parisInstant(q0.day, 900) }]);
      return { skill, staff, lift, hold };
    });
    const w = await rdv.tx(async (r) => ({
      data: await r.cal.load(proGarage2, nextMonday, addDays(nextMonday, 28)),
      uses: await r.cal.futureUses(proGarage2, calIds.staff),
      order: await r.cal.workOrder(rdvId),
      mine: await r.cal.assignmentsOf(proGarage2, [rdvId]),
      history: await r.cal.history(proGarage2),
      blocks: await r.cal.blocksBetween(proGarage2, q0.day, q0.day),
      blockRows: await r.cal.blockAssignments(proGarage2, [calIds.hold]),
    }));
    const p = w.data.staff[0];
    expect(w.data.staff.length === 1 && p.name === "Auto" && p.hours === null && p.skills[0].id === calIds.skill && p.skills[0].until === addDays(nextMonday, 365), "mécanicien relu : " + JSON.stringify(p));
    expect(w.data.skills[0].cert === true && w.data.resources[0].type === "lift", "compétence et poste relus");
    expect(w.data.reqs.vidange.labour === 45 && w.data.reqs.vidange.skills[0] === calIds.skill && w.data.reqs.vidange.vehicles.suv === 60, "exigences relues (jsonb) : " + JSON.stringify(w.data.reqs.vidange));
    const own = w.data.busy.filter((b) => b.requestId === rdvId);
    expect(own.length === 2 && own.every((b) => b.status === "pending" && b.start === at && b.end === end), "affectations relues avec l'état de la demande (LEFT JOIN) : " + JSON.stringify(w.data.busy));
    expect(w.uses === 1 && w.mine.length === 2, "mécanicien engagé par 1 rendez-vous");
    expect(w.order.vehicle === "suv" && w.order.status === "planned" && w.order.returnAt === end + 15 * 6e4, "intervention relue : " + JSON.stringify(w.order));
    expect(w.history.length === 1 && w.history[0].refId === calIds.staff, "historique relu");
    expect(w.blocks.length === 1 && w.blocks[0].kind === "hold" && w.blocks[0].day === q0.day && w.blocks[0].start === 840 && w.blocks[0].startsAt === parisInstant(q0.day, 840), "bloc interne relu : " + JSON.stringify(w.blocks[0]));
    expect(w.blockRows.length === 1 && w.blockRows[0].targetId === calIds.lift && w.data.busy.some((x) => x.blockId === calIds.hold), "affectation du bloc relue, comptée par le moteur");
    const un = parseUnavail({ target: "staff", targetId: calIds.staff, kind: "training", first: q0.day }, { staffIds: new Set([calIds.staff]), resourceIds: new Set(), nowMs: rdvClock });
    expect(!un.error, "absence : " + JSON.stringify(un));
    const hit = await rdv.tx(async (r) => {
      const id = await r.cal.createUnavail(proGarage2, un.value);
      return { id, conflicts: await r.cal.conflicts(proGarage2, [calIds.staff], parisInstant(q0.day, 0), parisInstant(addDays(q0.day, 1), 0)), n: await r.cal.countUnavail(proGarage2) };
    });
    expect(hit.n === 1 && hit.conflicts.length === 1 && hit.conflicts[0] === rdvId, "absence enregistrée, rendez-vous signalé en conflit : " + JSON.stringify(hit));
  });
  // lot 3c : sans rien envoyer (la mise en file de l'e-mail « prête » est annulée avec la transaction)
  await check("Lot 3c : état d'une intervention (client absent ignoré par le moteur : double jointure), e-mail « prête » une seule fois, préférences du tableau de bord", async () => {
    if (!calIds) throw new Error("le contrôle du calendrier n'a pas abouti");
    const q0 = await rdv.getRequest(rdvId);
    const ROLLBACK = new Error("annulation voulue");
    let seen = null;
    await rdv
      .tx(async (r) => {
        await r.cal.setWork(proGarage2, rdvId, "no_show", rdvClock);
        const busy = await r.cal.busy(proGarage2, q0.day, q0.day);
        const order = await r.cal.workOrder(rdvId);
        seen = { busy, order, first: await r.readyMail(rdvId, proGarage2), second: await r.readyMail(rdvId, proGarage2) };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    const mine = seen.busy.filter((b) => b.requestId === rdvId);
    expect(mine.length === 2 && mine.every((b) => b.noShow) && seen.busy.filter((b) => b.blockId).every((b) => !b.noShow), "client absent lu sur les affectations : " + JSON.stringify(seen.busy));
    expect(seen.order.status === "planned" && seen.order.noShow && seen.order.statusAt === rdvClock, "intervention : absent noté, état « planned » : " + JSON.stringify(seen.order));
    expect(seen.first === true && seen.second === false, "e-mail « prête » mis en file une seule fois");
    expect((await count("SELECT count(*) AS n FROM rdv_mails WHERE request_id = $1 AND kind = 'client_ready'", [rdvId])) === 0, "rien dans la file après l'annulation");
    // ligne d'intervention rattachée à un bloc (celle d'un rendez-vous hors Pixcar ; le dépôt ne regarde pas le genre du bloc)
    await rdv.tx((r) => r.cal.setWork(proGarage2, calIds.hold, "received", rdvClock));
    expect((await rdv.cal.workOrder(calIds.hold)).status === "received", "intervention d'un bloc relue");
    await pro.savePrefs(proGarage2, acc("c"), { shortcuts: ["planning", "site"] });
    await pro.savePrefs(proGarage2, acc("c"), { shortcuts: ["site", "planning", "prices"] });
    const prefs = await pro.getPrefs(proGarage2, acc("c"));
    expect(prefs && prefs.shortcuts.join() === "site,planning,prices", "préférences relues (jsonb, ON CONFLICT sur la clé double) : " + JSON.stringify(prefs));
  });
  // Gestion d'atelier (009) : tout dans une transaction annulée, rien ne reste ; pas d'effacement ici (la purge vise toute la base)
  await check("Gestion d'atelier : rendez-vous saisi (colonnes de 009) compté dans son créneau, créneau bloqué de tout l'atelier (UNION ALL, NOT EXISTS), modules (jsonb), affichage du compte", async () => {
    if (!calIds) throw new Error("le contrôle du calendrier n'a pas abouti");
    const q0 = await rdv.getRequest(rdvId);
    const ROLLBACK = new Error("annulation voulue");
    const jobId = crypto.randomUUID();
    let seen = null;
    await rdv
      .tx(async (r) => {
        const span = (a, b) => ({ day: q0.day, start: a, end: b, startsAt: parisInstant(q0.day, a), endsAt: parisInstant(q0.day, b) });
        const job = await r.cal.saveBlock(proGarage2, acc("c"), null, { kind: "job", label: "Auto-contrôle", services: [{ id: "vidange", qty: 1 }], vehicle: "", mode: "hour", ...span(600, 660), fixed: false, slotId: q0.slot_id, channel: "walkin", minutes: 45, car: "Auto", plate: "AA-000-AA", phone: "0600000000", note: "essai" }, { newId: jobId });
        const whole = await r.cal.saveBlock(proGarage2, acc("c"), null, { kind: "hold", label: "Auto-contrôle", services: [], vehicle: "", mode: "hour", ...span(960, 1020), fixed: true });
        await r.saveSettings(proGarage2, acc("c"), { modules: JSON.stringify({ staff: true, equip: false, track: true, load: true }) });
        seen = { job, whole, bookings: await r.bookings(proGarage2, q0.day, q0.day), block: await r.cal.getBlock(proGarage2, job), byId: await r.cal.blockById(job), holds: await r.cal.wholeHolds(proGarage2, q0.day, q0.day), settings: await r.getSettings(proGarage2) };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    const k = seen.block;
    expect(seen.job === jobId && seen.byId.garageId === proGarage2, "identifiant choisi par l'écran gardé, retrouvé sans le garage");
    expect(k.channel === "walkin" && k.minutes === 45 && k.car === "Auto" && k.plate === "AA-000-AA" && k.phone === "0600000000" && k.note === "essai" && k.slotId === q0.slot_id, "rendez-vous saisi relu (colonnes de 009) : " + JSON.stringify(k));
    const b = seen.bookings;
    expect(b.some((x) => x.id === jobId && x.slotId === q0.slot_id && x.start === 600 && x.end === 645 && x.status === "confirmed" && !x.hold), "compté dans son créneau pour ses 45 min (UNION ALL) : " + JSON.stringify(b));
    expect(b.some((x) => x.id === seen.whole && x.hold && x.start === 960 && x.end === 1020) && !b.some((x) => x.id === calIds.hold) && b.some((x) => x.id === rdvId && !x.hold), "blocage de tout l'atelier compté, celui du pont non (NOT EXISTS)");
    expect(seen.holds.length === 1 && seen.holds[0].blockId === seen.whole, "blocage de tout l'atelier vu par le calcul par ressources");
    expect(seen.settings.modules && seen.settings.modules.equip === false && seen.settings.modules.track === true, "modules relus (jsonb) : " + JSON.stringify(seen.settings.modules));
    expect((await count("SELECT count(*) AS n FROM rdv_blocks WHERE id = $1", [jobId])) === 0, "rien ne reste après l'annulation");
    await pro.savePrefs(proGarage2, acc("c"), { view: "advanced" }, ["planning"]);
    let prefs = await pro.getPrefs(proGarage2, acc("c"));
    expect(prefs.view === "advanced" && prefs.shortcuts.join() === "site,planning,prices", "affichage enregistré, raccourcis gardés : " + JSON.stringify(prefs));
    await pro.savePrefs(proGarage2, acc("c"), { shortcuts: ["site"] });
    prefs = await pro.getPrefs(proGarage2, acc("c"));
    expect(prefs.view === "advanced" && prefs.shortcuts.join() === "site", "raccourcis changés, affichage gardé : " + JSON.stringify(prefs));
  });
  await check("Rendez-vous : heure limite passée (expiration, série sans réponse), effacement des coordonnées, purge par lots", async () => {
    rdvClock = parisInstant(addDays(nextMonday, 1), 725); // mardi 12:05
    const due = await rdv.dueExpiries(10);
    expect(due.some((x) => x.id === rdvId), "demande à expirer");
    expect(await rdv.tx((r) => r.expire(rdvId, proGarage2, 3)), "expirée");
    expect((await rdv.getRequest(rdvId)).status === "expired" && (await rdv.getSettings(proGarage2)).missed === 1, "série sans réponse : 1");
    if (calIds) expect((await count("SELECT count(*) AS n FROM rdv_assignments WHERE request_id = $1", [rdvId])) === 0, "affectations libérées à l'expiration");
    rdvClock += 8 * 864e5;
    const out = await rdv.purge();
    expect(out.rdvAnonymized >= 1, "coordonnées effacées : " + JSON.stringify(out));
    const row = (await db.query("SELECT name, email, phone, client_token_hash, anonymized_at FROM rdv_requests WHERE id = $1", [rdvId])).rows[0];
    expect(row.name === "" && row.email === "" && row.client_token_hash === null && row.anonymized_at, "ligne anonyme");
    expect((await rdv.tx((r) => r.revoke(proGarage2))) === 0 && !(await rdv.getSettings(proGarage2)), "retrait : réglages, créneaux et fermetures partent");
    if (calIds) {
      const gone = await rdv.cal.revoke(proGarage2);
      const left = await rdv.tx(async (r) => ({ cal: await r.cal.getCalendar(proGarage2), staff: await r.cal.countStaff(proGarage2), skills: await r.cal.countSkills(proGarage2), res: await r.cal.countResources(proGarage2) }));
      // réglages, compétence, mécanicien, lien de compétence, poste, exigence, absence, intervention, historique, bloc et son affectation
      // (les affectations de la demande sont déjà parties)
      // + l'intervention du bloc (lot 3c)
      expect(gone === 12 && !left.cal && left.staff + left.skills + left.res === 0, `retrait du calendrier par lots : ${gone} lignes, reste ${JSON.stringify(left)}`);
      expect((await count("SELECT count(*) AS n FROM rdv_work_orders WHERE garage_id = $1", [proGarage2])) === 0, "intervention retirée");
    }
  });
  await check("Accord de sous-traitance : acceptation (la première fait foi), relue, preuve close depuis plus de 5 ans purgée", async () => {
    const first = await pro.acceptAgreement({ garageId: proGarage, version: "selfcheck", accountId: acc("a"), signer: "Auto Contrôle" });
    expect(first.created && first.row.signer === "Auto Contrôle" && !!first.row.accepted_at, "acceptation enregistrée");
    expect(!(await pro.acceptAgreement({ garageId: proGarage, version: "selfcheck", accountId: acc("a"), signer: "Autre" })).created, "une seule par version");
    expect((await pro.agreementOf(proGarage, "selfcheck")).signer === "Auto Contrôle", "relue");
    await db.query("UPDATE pro_agreements SET ended_at = now() - interval '5 years 1 day' WHERE garage_id = $1", [proGarage]);
    expect(!(await pro.agreementOf(proGarage, "selfcheck")), "close : plus en vigueur");
    await pro.purge();
    expect((await count("SELECT count(*) AS n FROM pro_agreements WHERE garage_id = $1", [proGarage])) === 0, "preuve de plus de 5 ans purgée");
  });

  await check("Espace Pro : purge des visites de plus de 60 jours ; retrait d'un rattachement : ses prix et sa fiche partent avec lui", async () => {
    await pro.recordVisit({ garageId: proGarage2, day: new Date(Date.now() - 70 * 864e5).toISOString().slice(0, 10), kind: "view", visitor: randomHex(32) });
    await pro.purge();
    expect((await count("SELECT count(*) AS n FROM pro_visits WHERE garage_id = $1", [proGarage2])) === 4, "les 4 visites de moins de 60 jours restent");
    await pro.acceptAgreement({ garageId: proGarage2, version: "selfcheck", accountId: acc("a"), signer: "Auto Contrôle" });
    expect((await pro.revoke(proGarage2)) === 1 && (await count("SELECT count(*) AS n FROM pro_prices WHERE garage_id = $1", [proGarage2])) === 0, "prix retirés");
    expect((await count("SELECT count(*) AS n FROM pro_agreements WHERE garage_id = $1 AND ended_at IS NOT NULL", [proGarage2])) === 1, "accord de sous-traitance clos, preuve gardée");
    for (const table of ["pro_profiles", "pro_profile_changes", "pro_services", "pro_prefs"])
      expect((await count(`SELECT count(*) AS n FROM ${table} WHERE garage_id = $1`, [proGarage2])) === 0, `${table} vidée pour ce garage`);
  });

  await check("nettoyage : plus aucune donnée d'essai", async () => {
    await db.query("DELETE FROM pro_claims WHERE account_id LIKE $1", [`selfcheck-${tag}-%`]);
    await db.query("DELETE FROM pro_events WHERE account_id LIKE $1", [`selfcheck-${tag}-%`]);
    await db.query("DELETE FROM garage_contacts WHERE import_id = $1", [`selfcheck-${tag}`]);
    await db.query("DELETE FROM pro_prices WHERE garage_id IN ($1, $2)", [proGarage, proGarage2]);
    await db.query("DELETE FROM pro_visits WHERE garage_id IN ($1, $2)", [proGarage, proGarage2]);
    for (const table of ["pro_profiles", "pro_profile_changes", "pro_services", "pro_prefs", "pro_agreements"]) await db.query(`DELETE FROM ${table} WHERE garage_id IN ($1, $2)`, [proGarage, proGarage2]);
    for (const table of ["rdv_settings", "rdv_slots", "rdv_closures", "rdv_requests", "rdv_mails"]) await db.query(`DELETE FROM ${table} WHERE garage_id IN ($1, $2)`, [proGarage, proGarage2]);
    for (const g of [proGarage, proGarage2]) await rdv.cal.revoke(g);
    await db.query("DELETE FROM rdv_events WHERE ip_hash = $1", [TEST_IP]);
    await db.query("DELETE FROM repairs WHERE garage_id = $1", [ovt]);
    await db.query("DELETE FROM garages WHERE id = $1", [ovt]);
    await db.query("DELETE FROM repairs WHERE garage_id LIKE 'custom:selfcheck-%'");
    await db.query("DELETE FROM garages WHERE id LIKE 'custom:selfcheck-%'");
    await db.query("DELETE FROM write_log WHERE ip_hash = $1", [TEST_IP]);
    await db.query("DELETE FROM upstream_cache WHERE key LIKE 'selfcheck:%'");
    const left =
      (await count("SELECT count(*) AS n FROM garages WHERE id LIKE 'custom:selfcheck-%' OR id = $1", [ovt])) +
      (await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1", [TEST_IP])) +
      (await count("SELECT count(*) AS n FROM pro_prices WHERE garage_id IN ($1, $2)", [proGarage, proGarage2])) +
      (await count("SELECT count(*) AS n FROM pro_visits WHERE garage_id IN ($1, $2)", [proGarage, proGarage2])) +
      (await count("SELECT count(*) AS n FROM pro_agreements WHERE garage_id IN ($1, $2)", [proGarage, proGarage2])) +
      (await count("SELECT count(*) AS n FROM rdv_requests WHERE garage_id IN ($1, $2)", [proGarage, proGarage2])) +
      (await count("SELECT count(*) AS n FROM rdv_events WHERE ip_hash = $1", [TEST_IP]));
    expect(left === 0, "reste " + left);
  });

  return { ok: checks.every((c) => c.ok), db: db.kind, passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
}
