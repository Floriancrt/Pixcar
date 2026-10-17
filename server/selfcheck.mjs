// Auto-contrôle de la base : rejoue, avec le vrai code de l'API (repo.mjs), tout ce que l'application demande à la base, et dit ligne par
// ligne ce qui marche. Sert à valider Amazon Aurora DSQL (dont on ne peut pas tout vérifier sans le service : syntaxe réellement acceptée,
// conflits de concurrence réels, index uniques partiels) ; il tourne aussi sur PostgreSQL et PGlite, ce qui prouve que les vérifications
// elles-mêmes sont justes : un échec sur DSQL est alors une vraie différence du service.
// Écrit des données d'essai (garages « custom:selfcheck-… », empreinte d'adresse « 5e1fc4ec… ») et les supprime toutes à la fin.
import { randomHex } from "./lib/crypto.mjs";
import { createRepo } from "./repo.mjs";
import { createProRepo } from "./pro-repo.mjs";

const TEST_IP = "5e1fc4ec".repeat(8);
const LAT = 0.5; // plein Atlantique : aucune vraie zone d'utilisateurs
const LON = -20.5;
const INDEXES = [
  "garages_area_idx", "repairs_garage_service_idx", "repairs_no_duplicate_idx", "repairs_pending_idx", "write_log_ip_idx", "write_log_at_idx",
  "garage_contacts_area_idx", "garage_contacts_domain_idx", "garage_contacts_import_idx", "pro_claims_account_idx", "pro_claims_garage_idx",
  "pro_claims_one_owner_idx", "pro_events_garage_idx", "pro_events_account_idx", "pro_events_at_idx", "pro_prices_status_idx", "pro_visits_once_idx",
  "pro_visits_day_idx", "pro_profile_changes_one_pending_idx", "pro_profile_changes_garage_idx", "pro_profile_changes_status_idx",
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
  await check("Espace Pro : purge des visites de plus de 60 jours ; retrait d'un rattachement : ses prix et sa fiche partent avec lui", async () => {
    await pro.recordVisit({ garageId: proGarage2, day: new Date(Date.now() - 70 * 864e5).toISOString().slice(0, 10), kind: "view", visitor: randomHex(32) });
    await pro.purge();
    expect((await count("SELECT count(*) AS n FROM pro_visits WHERE garage_id = $1", [proGarage2])) === 4, "les 4 visites de moins de 60 jours restent");
    expect((await pro.revoke(proGarage2)) === 1 && (await count("SELECT count(*) AS n FROM pro_prices WHERE garage_id = $1", [proGarage2])) === 0, "prix retirés");
    for (const table of ["pro_profiles", "pro_profile_changes", "pro_services"])
      expect((await count(`SELECT count(*) AS n FROM ${table} WHERE garage_id = $1`, [proGarage2])) === 0, `${table} vidée pour ce garage`);
  });

  await check("nettoyage : plus aucune donnée d'essai", async () => {
    await db.query("DELETE FROM pro_claims WHERE account_id LIKE $1", [`selfcheck-${tag}-%`]);
    await db.query("DELETE FROM pro_events WHERE account_id LIKE $1", [`selfcheck-${tag}-%`]);
    await db.query("DELETE FROM garage_contacts WHERE import_id = $1", [`selfcheck-${tag}`]);
    await db.query("DELETE FROM pro_prices WHERE garage_id IN ($1, $2)", [proGarage, proGarage2]);
    await db.query("DELETE FROM pro_visits WHERE garage_id IN ($1, $2)", [proGarage, proGarage2]);
    for (const table of ["pro_profiles", "pro_profile_changes", "pro_services"]) await db.query(`DELETE FROM ${table} WHERE garage_id IN ($1, $2)`, [proGarage, proGarage2]);
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
      (await count("SELECT count(*) AS n FROM pro_visits WHERE garage_id IN ($1, $2)", [proGarage, proGarage2]));
    expect(left === 0, "reste " + left);
  });

  return { ok: checks.every((c) => c.ok), db: db.kind, passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
}
