// Auto-contrôle de la base : rejoue, avec le vrai code de l'API (repo.mjs), tout ce que l'application demande à la base, et dit ligne par
// ligne ce qui marche. Sert à valider Amazon Aurora DSQL (dont on ne peut pas tout vérifier sans le service : syntaxe réellement acceptée,
// conflits de concurrence réels, index uniques partiels) ; il tourne aussi sur PostgreSQL et PGlite, ce qui prouve que les vérifications
// elles-mêmes sont justes : un échec sur DSQL est alors une vraie différence du service.
// Écrit des données d'essai (garages « custom:selfcheck-… », empreinte d'adresse « 5e1fc4ec… ») et les supprime toutes à la fin.
import { randomHex } from "./lib/crypto.mjs";
import { createRepo } from "./repo.mjs";

const TEST_IP = "5e1fc4ec".repeat(8);
const LAT = 0.5; // plein Atlantique : aucune vraie zone d'utilisateurs
const LON = -20.5;
const INDEXES = ["garages_area_idx", "repairs_garage_service_idx", "repairs_no_duplicate_idx", "repairs_pending_idx", "write_log_ip_idx", "write_log_at_idx"];

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
  await check("suppression d'un garage : ses réparations disparaissent avec lui (clé étrangère, ON DELETE CASCADE)", async () => {
    await db.query("DELETE FROM garages WHERE id = $1", [garageB]);
    expect((await count("SELECT count(*) AS n FROM repairs WHERE garage_id = $1", [garageB])) === 0, "plus aucune réparation");
  });

  await check("nettoyage : plus aucune donnée d'essai", async () => {
    await db.query("DELETE FROM repairs WHERE garage_id LIKE 'custom:selfcheck-%'");
    await db.query("DELETE FROM garages WHERE id LIKE 'custom:selfcheck-%'");
    await db.query("DELETE FROM write_log WHERE ip_hash = $1", [TEST_IP]);
    await db.query("DELETE FROM upstream_cache WHERE key LIKE 'selfcheck:%'");
    const left = (await count("SELECT count(*) AS n FROM garages WHERE id LIKE 'custom:selfcheck-%'")) + (await count("SELECT count(*) AS n FROM write_log WHERE ip_hash = $1", [TEST_IP]));
    expect(left === 0, "reste " + left);
  });

  return { ok: checks.every((c) => c.ok), db: db.kind, passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
}
