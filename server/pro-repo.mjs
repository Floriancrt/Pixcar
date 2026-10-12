// Espace Pro : tout le SQL de la vérification des garagistes (même règles que server/repo.mjs : paramètres à part, SQL portable
// PostgreSQL / PGlite / Aurora DSQL, fonctions passées à tx() rejouables sans effet hors de la base).
import { cellOf, cellsAround } from "./lib/geo.mjs";

export const IMPORT_BATCH_MAX = 500; // lignes de contacts par appel de l'op « import-contacts » (DSQL : 3 000 lignes au plus par transaction)
const PURGE_BATCH = 1000;
const ROW_PARAMS = 13;

const meters = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
export { meters };

const CONTACT_COLUMNS = "garage_id, name, addr, pc, lat, lon, brand, emails, phones, web_domain";
const CLAIM_COLUMNS = "c.id, c.garage_id, c.siret, c.status, c.channel, c.holder_name, c.holder_role, c.target_hint, c.code_expires_at, c.attempts, c.sends, c.last_sent_at, c.created_at, c.verified_at";

export function createProRepo(db) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;

  // Compteurs des limites d'envoi, sur 24 h glissantes (1 h pour le plafond du service) :
  //  - « garage » : ce compte, vers ce garage. Chaque demandeur a ses propres envois : un tiers ne peut pas épuiser ceux du vrai garagiste ;
  //  - « garage_total » : tous comptes, vers ce garage (plafond plus haut : le garage n'est pas harcelé, et le bloquer demande plusieurs comptes) ;
  //  - « account » : ce compte, tous garages ; « global » : tout le service.
  async function sendCounts(t, { garageId, accountId }) {
    const n = async (sql, params) => (await t.query(sql, params)).rows[0].n;
    return {
      garage: await n("SELECT count(*)::int AS n FROM pro_events WHERE kind = 'send' AND garage_id = $1 AND account_id = $2 AND at > now() - interval '24 hours'", [garageId, accountId]),
      garageTotal: await n("SELECT count(*)::int AS n FROM pro_events WHERE kind = 'send' AND garage_id = $1 AND at > now() - interval '24 hours'", [garageId]),
      account: await n("SELECT count(*)::int AS n FROM pro_events WHERE kind = 'send' AND account_id = $1 AND at > now() - interval '24 hours'", [accountId]),
      global: await n("SELECT count(*)::int AS n FROM pro_events WHERE kind = 'send' AND at > now() - interval '1 hour'", []),
    };
  }
  const overLimit = (n, limits) =>
    n.garage >= limits.perGarageAccountPerDay
      ? "garage"
      : n.garageTotal >= limits.perGaragePerDay
        ? "garage_total"
        : n.account >= limits.perAccountPerDay
          ? "account"
          : n.global >= limits.globalPerHour
            ? "global"
            : "";
  // Nombre de comptes distincts qui ont fait envoyer un code vers ce garage sur 24 h (deux ou plus : litige ou abus, à regarder)
  const accountsOnGarage = async (t, garageId) =>
    (await t.query("SELECT count(DISTINCT account_id)::int AS n FROM pro_events WHERE kind = 'send' AND garage_id = $1 AND at > now() - interval '24 hours'", [garageId])).rows[0].n;

  return {
    // ---- contacts
    getContact: (garageId) => one(`SELECT ${CONTACT_COLUMNS} FROM garage_contacts WHERE garage_id = $1`, [garageId]),
    // garages à moins de radiusM du point, du plus proche au plus loin
    async contactsNear({ lat, lon, radiusM }) {
      const box = cellsAround(lat, lon, radiusM / 1000);
      // les cases (index) puis le carré du rayon : même en ville dense, seuls les garages du carré sont lus
      const dLat = radiusM / 111_320, dLon = radiusM / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
      const { rows } = await db.query(
        `SELECT ${CONTACT_COLUMNS} FROM garage_contacts
         WHERE area_y BETWEEN $1 AND $2 AND area_x BETWEEN $3 AND $4 AND lat BETWEEN $5 AND $6 AND lon BETWEEN $7 AND $8 LIMIT 500`,
        [box.y0, box.y1, box.x0, box.x1, lat - dLat, lat + dLat, lon - dLon, lon + dLon],
      );
      return rows
        .map((r) => ({ ...r, distanceM: Math.round(meters({ lat, lon }, r)) }))
        .filter((r) => r.distanceM <= radiusM)
        .sort((a, b) => a.distanceM - b.distanceM || (a.garage_id < b.garage_id ? -1 : 1));
    },
    contactsByPostcode: (pc) => db.query(`SELECT ${CONTACT_COLUMNS} FROM garage_contacts WHERE pc = $1 ORDER BY garage_id LIMIT 300`, [pc]).then((r) => r.rows),
    domainCount: (domain) => one("SELECT count(*)::int AS n FROM garage_contacts WHERE web_domain = $1", [domain]).then((r) => r.n),

    // Écrit (ou met à jour) un lot de contacts déjà validés. Renvoie le nombre de lignes écrites.
    upsertContacts(rows, importId) {
      if (!rows.length) return Promise.resolve(0);
      if (rows.length > IMPORT_BATCH_MAX) throw new Error(`au plus ${IMPORT_BATCH_MAX} contacts par lot`);
      return db.tx(async (t) => {
        let written = 0;
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100);
          const params = [];
          const values = chunk.map((r, k) => {
            const cell = cellOf(r.lat, r.lon);
            params.push(r.garageId, r.name, r.addr, r.pc, r.lat, r.lon, cell.y, cell.x, r.brand, JSON.stringify(r.emails), JSON.stringify(r.phones), r.webDomain, importId);
            const b = k * ROW_PARAMS;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}::jsonb, $${b + 11}::jsonb, $${b + 12}, $${b + 13}, now())`;
          });
          const out = await t.query(
            `INSERT INTO garage_contacts (garage_id, name, addr, pc, lat, lon, area_y, area_x, brand, emails, phones, web_domain, import_id, updated_at)
             VALUES ${values.join(", ")}
             ON CONFLICT (garage_id) DO UPDATE SET name = EXCLUDED.name, addr = EXCLUDED.addr, pc = EXCLUDED.pc, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
               area_y = EXCLUDED.area_y, area_x = EXCLUDED.area_x, brand = EXCLUDED.brand, emails = EXCLUDED.emails, phones = EXCLUDED.phones,
               web_domain = EXCLUDED.web_domain, import_id = EXCLUDED.import_id, updated_at = now()`,
            params,
          );
          written += out.rowCount;
        }
        return written;
      });
    },
    contactStats: (importId) =>
      one("SELECT count(*)::int AS total, sum(CASE WHEN import_id = $1 THEN 1 ELSE 0 END)::int AS kept FROM garage_contacts", [importId]).then((r) => ({ total: r.total, kept: r.kept || 0 })),
    // Retire les contacts qu'un chargement complet n'a pas réécrits (garages disparus, fermés ou exclus depuis).
    async pruneContacts(importId) {
      let total = 0;
      for (let pass = 0; pass < 200; pass++) {
        const { rowCount } = await db.query(
          "DELETE FROM garage_contacts WHERE garage_id IN (SELECT garage_id FROM garage_contacts WHERE import_id <> $2 LIMIT $1)",
          [PURGE_BATCH, importId],
        );
        total += rowCount;
        if (rowCount < PURGE_BATCH) break;
      }
      return total;
    },

    // ---- demandes
    verifiedOwner: (garageId) => one("SELECT account_id FROM pro_claims WHERE garage_id = $1 AND status = 'verified'", [garageId]),
    getClaim: (id, accountId) =>
      one(`SELECT ${CLAIM_COLUMNS}, now() AS db_now, g.name AS garage_name FROM pro_claims c LEFT JOIN garage_contacts g ON g.garage_id = c.garage_id WHERE c.id = $1 AND c.account_id = $2`, [id, accountId]),
    listClaims: (accountId) =>
      db
        .query(
          `SELECT ${CLAIM_COLUMNS}, now() AS db_now, g.name AS garage_name, g.addr AS garage_addr FROM pro_claims c LEFT JOIN garage_contacts g ON g.garage_id = c.garage_id
           WHERE c.account_id = $1 AND c.status IN ('pending', 'verified') ORDER BY c.created_at DESC LIMIT 50`,
          [accountId],
        )
        .then((r) => r.rows),

    // Nouvelle demande et son premier code. c : { id, accountId, garageId, siret, channel, holderName, holderRole, target, targetHash,
    // targetHint, codeHash, ttlSeconds, maxPending, limits }. Résultat : { kind: "created", accounts } | { kind: "owned" } | { kind: "mine" } | { kind: "limited", scope }
    // | { kind: "too_many" }. Rien n'est envoyé ici : l'envoi suit la transaction (elle peut être rejouée).
    createClaim(c) {
      return db.tx(async (t) => {
        const owner = (await t.query("SELECT account_id FROM pro_claims WHERE garage_id = $1 AND status = 'verified'", [c.garageId])).rows[0];
        if (owner) return { kind: owner.account_id === c.accountId ? "mine" : "owned" };
        const pending = (
          await t.query("SELECT count(*)::int AS n FROM pro_claims WHERE account_id = $1 AND garage_id <> $2 AND status = 'pending' AND code_expires_at > now()", [c.accountId, c.garageId])
        ).rows[0].n;
        if (pending >= c.maxPending) return { kind: "too_many" }; // une demande pour CE garage sera remplacée : elle ne compte pas
        const scope = overLimit(await sendCounts(t, c), c.limits);
        if (scope) return { kind: "limited", scope };
        // une demande en cours du même compte pour le même garage est remplacée : un seul code valable à la fois
        await t.query("UPDATE pro_claims SET status = 'failed', code_hash = NULL, target = NULL WHERE account_id = $1 AND garage_id = $2 AND status = 'pending'", [c.accountId, c.garageId]);
        await t.query(
          `INSERT INTO pro_claims (id, account_id, garage_id, siret, status, channel, holder_name, holder_role, certified_at, target, target_hash, target_hint, code_hash, code_expires_at, attempts, sends, last_sent_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $11, $12, now(), $6, $7, $8, $9, now() + $10::int * interval '1 second', 0, 1, now())`,
          [c.id, c.accountId, c.garageId, c.siret, c.channel, c.target, c.targetHash, c.targetHint, c.codeHash, c.ttlSeconds, c.holderName, c.holderRole],
        );
        await t.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) VALUES ('send', $1, $2, $3)", [c.accountId, c.garageId, c.channel]);
        return { kind: "created", accounts: await accountsOnGarage(t, c.garageId) };
      });
    },

    // Nouveau code pour une demande en cours. Résultat : { kind: "sent", target, channel } | { kind: "wait", retryAfter } |
    // { kind: "limited", scope } | { kind: "closed" } | { kind: "not_found" }
    resend({ id, accountId, codeHash, ttlSeconds, resendAfterSeconds, maxSends, limits }) {
      return db.tx(async (t) => {
        const c = (
          await t.query(
            "SELECT garage_id, status, channel, target, sends, last_sent_at, now() AS db_now FROM pro_claims WHERE id = $1 AND account_id = $2",
            [id, accountId],
          )
        ).rows[0];
        if (!c) return { kind: "not_found" };
        if (c.status !== "pending" || !c.target) return { kind: "closed" };
        const since = c.last_sent_at ? (new Date(c.db_now).getTime() - new Date(c.last_sent_at).getTime()) / 1000 : Infinity;
        if (since < resendAfterSeconds) return { kind: "wait", retryAfter: Math.max(1, Math.ceil(resendAfterSeconds - since)) };
        if (c.sends >= maxSends) return { kind: "limited", scope: "claim" };
        const scope = overLimit(await sendCounts(t, { garageId: c.garage_id, accountId }), limits);
        if (scope) return { kind: "limited", scope };
        await t.query(
          "UPDATE pro_claims SET code_hash = $3, code_expires_at = now() + $4::int * interval '1 second', attempts = 0, sends = sends + 1, last_sent_at = now() WHERE id = $1 AND account_id = $2",
          [id, accountId, codeHash, ttlSeconds],
        );
        await t.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) VALUES ('send', $1, $2, $3)", [accountId, c.garage_id, c.channel]);
        return { kind: "sent", target: c.target, channel: c.channel, garageId: c.garage_id, accounts: await accountsOnGarage(t, c.garage_id) };
      });
    },

    // Après un envoi raté : la demande ne peut plus aboutir (son code n'est jamais parti).
    abandon: (id) => db.query("UPDATE pro_claims SET status = 'failed', code_hash = NULL, target = NULL WHERE id = $1 AND status = 'pending'", [id]),

    // Essai d'un code. matches(codeHash) → Promise<boolean> compare le code saisi à l'empreinte enregistrée.
    // Résultat : { kind: "verified" } | { kind: "already" } | { kind: "bad", attemptsLeft } | { kind: "locked" } | { kind: "expired" } |
    // { kind: "closed" } | { kind: "owned" } | { kind: "busy" } (un autre essai passait au même instant) | { kind: "not_found" }
    tryCode({ id, accountId, maxAttempts, matches }) {
      return db.tx(async (t) => {
        const c = (
          await t.query(
            "SELECT garage_id, status, channel, code_hash, attempts, (code_expires_at IS NOT NULL AND code_expires_at > now()) AS live FROM pro_claims WHERE id = $1 AND account_id = $2",
            [id, accountId],
          )
        ).rows[0];
        if (!c) return { kind: "not_found" };
        if (c.status === "verified") return { kind: "already" };
        if (c.status !== "pending") return { kind: "closed" };
        if (c.attempts >= maxAttempts) return { kind: "locked" };
        if (!c.code_hash || !c.live) return { kind: "expired" };
        // l'essai est compté AVANT la comparaison, et seulement si personne ne l'a compté entre-temps : des essais en parallèle ne
        // dépassent jamais la limite
        const counted = await t.query("UPDATE pro_claims SET attempts = attempts + 1 WHERE id = $1 AND attempts = $2 AND status = 'pending'", [id, c.attempts]);
        if (!counted.rowCount) return { kind: "busy" };
        if (await matches(c.code_hash)) {
          const owner = (await t.query("SELECT account_id FROM pro_claims WHERE garage_id = $1 AND status = 'verified'", [c.garage_id])).rows[0];
          if (owner) {
            await t.query("UPDATE pro_claims SET status = 'failed', code_hash = NULL, target = NULL WHERE id = $1", [id]);
            return { kind: "owned" };
          }
          await t.query("UPDATE pro_claims SET status = 'verified', verified_at = now(), code_hash = NULL, code_expires_at = NULL, target = NULL WHERE id = $1", [id]);
          await t.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) VALUES ('verified', $1, $2, $3)", [accountId, c.garage_id, c.channel]);
          return { kind: "verified" };
        }
        await t.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) VALUES ('bad_code', $1, $2, $3)", [accountId, c.garage_id, c.channel]);
        const left = maxAttempts - (c.attempts + 1);
        if (left <= 0) {
          await t.query("UPDATE pro_claims SET status = 'failed', code_hash = NULL, target = NULL WHERE id = $1", [id]);
          await t.query("INSERT INTO pro_events (kind, account_id, garage_id, channel) VALUES ('locked', $1, $2, $3)", [accountId, c.garage_id, c.channel]);
          return { kind: "locked" };
        }
        return { kind: "bad", attemptsLeft: left };
      });
    },

    // ---- exploitation
    // Rattachements et demandes d'un garage (op « pro-claims ») ; jamais la cible en clair.
    claimsOfGarage: (garageId) =>
      db
        .query(`SELECT ${CLAIM_COLUMNS}, c.account_id FROM pro_claims c WHERE c.garage_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [garageId])
        .then((r) => r.rows),
    // Retire un rattachement vérifié (vérification contestée) : le garage redevient libre.
    async revoke(garageId) {
      return db.tx(async (t) => {
        const r = await t.query("UPDATE pro_claims SET status = 'revoked' WHERE garage_id = $1 AND status = 'verified' RETURNING account_id", [garageId]);
        if (r.rowCount) await t.query("INSERT INTO pro_events (kind, account_id, garage_id) VALUES ('revoked', $1, $2)", [r.rows[0].account_id, garageId]);
        return r.rowCount;
      });
    },
    proStats: () =>
      db
        .query("SELECT status, count(*)::int AS n FROM pro_claims GROUP BY status ORDER BY status")
        .then(async (r) => ({ claims: Object.fromEntries(r.rows.map((x) => [x.status, x.n])), contacts: (await one("SELECT count(*)::int AS n FROM garage_contacts")).n })),

    // Entretien : journal de plus de 90 jours, demandes non abouties de plus de 30 jours.
    async purge() {
      const run = async (sql) => {
        let total = 0;
        for (let pass = 0; pass < 100; pass++) {
          const { rowCount } = await db.query(sql, [PURGE_BATCH]);
          total += rowCount;
          if (rowCount < PURGE_BATCH) break;
        }
        return total;
      };
      return {
        proEvents: await run("DELETE FROM pro_events WHERE id IN (SELECT id FROM pro_events WHERE at < now() - interval '90 days' LIMIT $1)"),
        proClaims: await run("DELETE FROM pro_claims WHERE id IN (SELECT id FROM pro_claims WHERE status IN ('pending', 'failed') AND created_at < now() - interval '30 days' LIMIT $1)"),
      };
    },
  };
}
