// Espace Pro : tout le SQL de la vérification des garagistes (même règles que server/repo.mjs : paramètres à part, SQL portable
// PostgreSQL / PGlite / Aurora DSQL, fonctions passées à tx() rejouables sans effet hors de la base).
import { cellOf, cellsAround } from "./lib/geo.mjs";
import { decideStatus } from "./repo.mjs";
import { NEAR_M, pickRec } from "../src/js/modules/garages-table.js";

export const IMPORT_BATCH_MAX = 500; // lignes de contacts par appel de l'op « import-contacts » (DSQL : 3 000 lignes au plus par transaction)
const PURGE_BATCH = 1000;
const ROW_PARAMS = 13;

// « IN ($2, $3, …) » pour une liste de valeurs passées à part (pas de tableau en paramètre : DSQL n'en garde pas)
const placeholders = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");
const median = (values) => {
  const v = values.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const meters = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
};
export { meters };

const CONTACT_COLUMNS = "garage_id, name, addr, pc, lat, lon, brand, emails, phones, web_domain";
const PRICE_COLUMNS = "garage_id, service_id, kind, price_cents, vehicles, includes, status, confirmed_at, updated_at";
const PROFILE_COLUMNS = "garage_id, name, street, pc, city, phone, website, email, hours, updated_at";
const CHANGE_COLUMNS = "id, garage_id, field, value, status, reason, created_at, decided_at";
const PROFILE_FIELDS = { website: "website", email: "email", hours: "hours" }; // écrits directement par le garage (le reste passe par une relecture)
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

  // garages à moins de radiusM du point, du plus proche au plus loin
  async function contactsNear({ lat, lon, radiusM }) {
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
  }

  return {
    // ---- contacts
    getContact: (garageId) => one(`SELECT ${CONTACT_COLUMNS} FROM garage_contacts WHERE garage_id = $1`, [garageId]),
    contactsNear,
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
        if (r.rowCount) {
          await t.query("INSERT INTO pro_events (kind, account_id, garage_id) VALUES ('revoked', $1, $2)", [r.rows[0].account_id, garageId]);
          // les prix annoncés et la fiche déclarée étaient sous la responsabilité de ce compte : ils partent avec lui (un nouveau titulaire
          // repart de zéro)
          await t.query("DELETE FROM pro_prices WHERE garage_id = $1", [garageId]);
          await t.query("DELETE FROM pro_profiles WHERE garage_id = $1", [garageId]);
          await t.query("DELETE FROM pro_profile_changes WHERE garage_id = $1", [garageId]);
          await t.query("DELETE FROM pro_services WHERE garage_id = $1", [garageId]);
          await t.query("DELETE FROM pro_prefs WHERE garage_id = $1", [garageId]); // raccourcis du tableau de bord (lot 3c)
        }
        return r.rowCount;
      });
    },
    proStats: () =>
      db
        .query("SELECT status, count(*)::int AS n FROM pro_claims GROUP BY status ORDER BY status")
        .then(async (r) => ({ claims: Object.fromEntries(r.rows.map((x) => [x.status, x.n])), contacts: (await one("SELECT count(*)::int AS n FROM garage_contacts")).n })),

    // ---- prix annoncés (le garage est rattaché au compte : c'est à l'appelant de l'avoir vérifié)
    // Le rattachement vérifié d'un garage à ce compte : { claim, contact } ou null.
    async ownedGarage(garageId, accountId) {
      const claim = await one("SELECT id, siret, holder_name, verified_at FROM pro_claims WHERE garage_id = $1 AND account_id = $2 AND status = 'verified'", [garageId, accountId]);
      if (!claim) return null;
      return { claim, contact: await one(`SELECT ${CONTACT_COLUMNS}, area_y, area_x FROM garage_contacts WHERE garage_id = $1`, [garageId]) };
    },
    listPrices: (garageId) => db.query(`SELECT ${PRICE_COLUMNS}, now() AS db_now FROM pro_prices WHERE garage_id = $1 ORDER BY service_id`, [garageId]).then((r) => r.rows),
    // Enregistre (ou remplace) un prix ; un prix très éloigné des prix payés du secteur attend une relecture (« review »), comme une déclaration.
    // p : { garageId, serviceId, kind, priceCents, vehicles, includes, accountId, area: { y, x } | null }. Renvoie la ligne enregistrée.
    savePrice(p) {
      return db.tx(async (t) => {
        const status = p.priceCents !== null && p.area ? ((await decideStatus(t, p.serviceId, p.priceCents, p.area.y, p.area.x)) === "pending" ? "review" : "published") : "published";
        const r = await t.query(
          `INSERT INTO pro_prices (garage_id, service_id, kind, price_cents, vehicles, includes, status, account_id, confirmed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, now(), now())
           ON CONFLICT (garage_id, service_id) DO UPDATE SET kind = EXCLUDED.kind, price_cents = EXCLUDED.price_cents, vehicles = EXCLUDED.vehicles,
             includes = EXCLUDED.includes, status = EXCLUDED.status, account_id = EXCLUDED.account_id, confirmed_at = now(), updated_at = now()
           RETURNING ${PRICE_COLUMNS}, now() AS db_now`,
          [p.garageId, p.serviceId, p.kind, p.priceCents, JSON.stringify(p.vehicles), JSON.stringify(p.includes), status, p.accountId],
        );
        // annoncer un prix, c'est dire qu'on fait la prestation (« Mon garage » la coche ; son temps moyen ne change pas)
        await t.query(
          `INSERT INTO pro_services (garage_id, service_id, offered, updated_at) VALUES ($1, $2, true, now())
           ON CONFLICT (garage_id, service_id) DO UPDATE SET offered = true, updated_at = now()`,
          [p.garageId, p.serviceId],
        );
        return r.rows[0];
      });
    },
    deletePrice: (garageId, serviceId) => db.query("DELETE FROM pro_prices WHERE garage_id = $1 AND service_id = $2", [garageId, serviceId]).then((r) => r.rowCount > 0),
    // « Tout confirmer » : les prix publiés ou en relecture repartent pour 6 mois (un prix refusé reste refusé).
    confirmPrices: (garageId) =>
      db.query("UPDATE pro_prices SET confirmed_at = now() WHERE garage_id = $1 AND status IN ('published', 'review')", [garageId]).then((r) => r.rowCount),

    // Prix payés (déclarations approuvées) de ce garage, par prestation : { serviceId: { median (€), n } }. Les déclarations sont rangées sous
    // l'identifiant du garage dans la page (OpenStreetMap le plus souvent) : on retrouve ces garages par la règle de rapprochement de la page
    // (src/js/modules/garages-table.js : même nom à moins de 150 m, ou seul lieu à moins de 40 m), plus l'identifiant que la page donne à un
    // lieu de la table qu'OpenStreetMap n'a pas (custom:ovt-…).
    async paidPrices(contact) {
      if (!contact) return {};
      const own = "custom:ovt-" + contact.garage_id.replace(/-/g, "");
      const box = cellsAround(contact.lat, contact.lon, (NEAR_M + 50) / 1000);
      const dLat = (NEAR_M + 50) / 111_320, dLon = (NEAR_M + 50) / (111_320 * Math.max(0.05, Math.cos((contact.lat * Math.PI) / 180)));
      const near = (
        await db.query(
          `SELECT id, name, lat, lon FROM garages
           WHERE id = $9 OR (area_y BETWEEN $1 AND $2 AND area_x BETWEEN $3 AND $4 AND lat BETWEEN $5 AND $6 AND lon BETWEEN $7 AND $8) LIMIT 200`,
          [box.y0, box.y1, box.x0, box.x1, contact.lat - dLat, contact.lat + dLat, contact.lon - dLon, contact.lon + dLon, own],
        )
      ).rows;
      if (!near.length) return {};
      // les lieux de la table autour : un garage se rapproche du plus proche de même nom, pas forcément de celui-ci
      const recs = (await contactsNear({ lat: contact.lat, lon: contact.lon, radiusM: 2 * NEAR_M + 50 })).map((r) => ({ id: r.garage_id, name: r.name, lat: r.lat, lon: r.lon }));
      if (!recs.some((r) => r.id === contact.garage_id)) recs.push({ id: contact.garage_id, name: contact.name, lat: contact.lat, lon: contact.lon });
      const ids = near.filter((g) => g.id === own || (g.lat !== null && g.lon !== null && (pickRec(g, recs) || {}).id === contact.garage_id)).map((g) => g.id);
      if (!ids.length) return {};
      const rows = (
        await db.query(`SELECT service_id, price_cents FROM repairs WHERE status = 'approved' AND garage_id IN (${placeholders(ids.length)})`, ids)
      ).rows;
      const by = new Map();
      for (const r of rows) (by.get(r.service_id) || by.set(r.service_id, []).get(r.service_id)).push(Number(r.price_cents));
      return Object.fromEntries([...by].map(([k, v]) => [k, { median: Math.round(median(v)) / 100, n: v.length }]));
    },

    // ---- visites des fiches (tableau de bord)
    // Compte une visite si le garage est rattaché à un compte vérifié ; une seule par visiteur, jour, garage et type. Renvoie true si comptée.
    async recordVisit({ garageId, day, kind, visitor }) {
      if (!(await one("SELECT 1 AS ok FROM pro_claims WHERE garage_id = $1 AND status = 'verified'", [garageId]))) return false;
      const r = await db.query("INSERT INTO pro_visits (garage_id, day, kind, visitor) VALUES ($1, $2::date, $3, $4) ON CONFLICT DO NOTHING", [garageId, day, kind, visitor]);
      return r.rowCount > 0;
    },
    // { view: { recent, previous }, call: { … } } : visiteurs des 30 derniers jours (recent, jour même compris) et des 30 d'avant.
    // since30 / since60 : dates ISO (AAAA-MM-JJ) des jours qui précèdent chaque période.
    async visitStats(garageId, { since30, since60 }) {
      const { rows } = await db.query(
        `SELECT kind, sum(CASE WHEN day > $2::date THEN 1 ELSE 0 END)::int AS recent, sum(CASE WHEN day <= $2::date THEN 1 ELSE 0 END)::int AS previous
         FROM pro_visits WHERE garage_id = $1 AND day > $3::date GROUP BY kind`,
        [garageId, since30, since60],
      );
      const out = { view: { recent: 0, previous: 0 }, call: { recent: 0, previous: 0 } };
      for (const r of rows) out[r.kind] = { recent: r.recent || 0, previous: r.previous || 0 };
      return out;
    },

    // ---- lecture publique : garages vérifiés parmi ces identifiants, et leurs prix publiés
    async publicGarages(garageIds) {
      if (!garageIds.length) return [];
      const claims = (
        await db.query(`SELECT garage_id, verified_at FROM pro_claims WHERE status = 'verified' AND garage_id IN (${placeholders(garageIds.length)})`, garageIds)
      ).rows;
      if (!claims.length) return [];
      const ids = claims.map((c) => c.garage_id);
      const [prices, profiles, services] = await Promise.all([
        db.query(`SELECT ${PRICE_COLUMNS} FROM pro_prices WHERE status = 'published' AND garage_id IN (${placeholders(ids.length)}) ORDER BY garage_id, service_id`, ids),
        db.query(`SELECT ${PROFILE_COLUMNS} FROM pro_profiles WHERE garage_id IN (${placeholders(ids.length)})`, ids),
        // jamais les temps moyens : ils restent privés
        db.query(`SELECT garage_id, service_id, offered FROM pro_services WHERE garage_id IN (${placeholders(ids.length)}) ORDER BY garage_id, service_id`, ids),
      ]).then((all) => all.map((r) => r.rows));
      return claims.map((c) => ({
        ...c,
        prices: prices.filter((p) => p.garage_id === c.garage_id),
        profile: profiles.find((p) => p.garage_id === c.garage_id) || null,
        services: services.filter((s) => s.garage_id === c.garage_id),
      }));
    },

    // ---- « Mon garage » : fiche déclarée, changements relus, prestations (le garage est rattaché au compte : vérifié par l'appelant)
    // préférences d'un compte pour un garage (lot 3c) : raccourcis du tableau de bord ; null tant que rien n'a été choisi
    // et affichage de Gestion d'atelier (view, 009 : simple ou advanced, null tant que rien n'a été choisi)
    getPrefs: (garageId, accountId) =>
      one("SELECT shortcuts, view FROM pro_prefs WHERE garage_id = $1 AND account_id = $2", [garageId, accountId]).then((r) =>
        r ? { shortcuts: Array.isArray(r.shortcuts) ? r.shortcuts : [], view: r.view === "simple" || r.view === "advanced" ? r.view : null } : null,
      ),
    // prefs : { shortcuts?, view? } ; ce qui manque ne change pas (une première ligne prend les raccourcis par défaut : defaults)
    savePrefs: (garageId, accountId, prefs, defaults = []) =>
      db.query(
        `INSERT INTO pro_prefs (garage_id, account_id, shortcuts, view, updated_at) VALUES ($1, $2, coalesce($3::jsonb, $5::jsonb), $4, now())
         ON CONFLICT (garage_id, account_id) DO UPDATE SET shortcuts = coalesce($3::jsonb, pro_prefs.shortcuts),
           view = CASE WHEN $6 THEN $4 ELSE pro_prefs.view END, updated_at = EXCLUDED.updated_at`,
        [garageId, accountId, prefs.shortcuts ? JSON.stringify(prefs.shortcuts) : null, prefs.view ?? null, JSON.stringify(defaults), prefs.view !== undefined],
      ),
    getProfile: (garageId) => one(`SELECT ${PROFILE_COLUMNS} FROM pro_profiles WHERE garage_id = $1`, [garageId]),
    // Site, e-mail affiché, horaires : seuls les champs présents dans fields sont écrits (null efface les horaires, "" le reste).
    saveProfile(garageId, accountId, fields) {
      const keys = Object.keys(fields).filter((k) => PROFILE_FIELDS[k]);
      if (!keys.length) throw new Error("aucun champ à écrire");
      const cols = keys.map((k) => PROFILE_FIELDS[k]);
      const vals = keys.map((k) => (k === "hours" ? (fields.hours === null ? null : JSON.stringify(fields.hours)) : fields[k]));
      const casts = keys.map((k, i) => (k === "hours" ? `$${i + 3}::jsonb` : `$${i + 3}`));
      return db
        .query(
          `INSERT INTO pro_profiles (garage_id, account_id, ${cols.join(", ")}, updated_at) VALUES ($1, $2, ${casts.join(", ")}, now())
           ON CONFLICT (garage_id) DO UPDATE SET account_id = EXCLUDED.account_id, ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, updated_at = now()
           RETURNING ${PROFILE_COLUMNS}`,
          [garageId, accountId, ...vals],
        )
        .then((r) => r.rows[0]);
    },
    // Changements en attente, et ceux décidés depuis moins de 30 jours (le garagiste voit la décision, et le motif d'un refus)
    listChanges: (garageId) =>
      db
        .query(
          `SELECT ${CHANGE_COLUMNS} FROM pro_profile_changes WHERE garage_id = $1
           AND (status = 'pending' OR (status IN ('approved', 'rejected') AND decided_at > now() - interval '30 days')) ORDER BY created_at DESC LIMIT 20`,
          [garageId],
        )
        .then((r) => r.rows),
    // Nouveau changement à relire ; il remplace celui qui attendait pour le même champ.
    requestChange({ id, garageId, field, value, accountId }) {
      return db.tx(async (t) => {
        await t.query("UPDATE pro_profile_changes SET status = 'cancelled', decided_at = now() WHERE garage_id = $1 AND field = $2 AND status = 'pending'", [garageId, field]);
        const r = await t.query(
          `INSERT INTO pro_profile_changes (id, garage_id, field, value, status, account_id, created_at) VALUES ($1, $2, $3, $4, 'pending', $5, now()) RETURNING ${CHANGE_COLUMNS}`,
          [id, garageId, field, value, accountId],
        );
        return r.rows[0];
      });
    },
    // Demandes de changement d'un garage sur les dernières 24 h (toutes, même remplacées ou annulées) : plafond des e-mails de relecture
    countRecentChanges: (garageId) =>
      one("SELECT count(*)::int AS n FROM pro_profile_changes WHERE garage_id = $1 AND created_at > now() - interval '1 day'", [garageId]).then((r) => (r ? r.n : 0)),
    cancelChange: (garageId, id) =>
      db.query("UPDATE pro_profile_changes SET status = 'cancelled', decided_at = now() WHERE id = $1 AND garage_id = $2 AND status = 'pending'", [id, garageId]).then((r) => r.rowCount > 0),
    listServices: (garageId) => db.query("SELECT service_id, offered, minutes FROM pro_services WHERE garage_id = $1 ORDER BY service_id", [garageId]).then((r) => r.rows),
    // Prestation faite ou non, et son temps moyen. Décocher retire le prix annoncé (une prestation qu'on ne fait pas n'a pas de prix).
    // Renvoie { row, priceRemoved }.
    saveService({ garageId, serviceId, offered, minutes }) {
      return db.tx(async (t) => {
        const r = await t.query(
          `INSERT INTO pro_services (garage_id, service_id, offered, minutes, updated_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (garage_id, service_id) DO UPDATE SET offered = EXCLUDED.offered, minutes = EXCLUDED.minutes, updated_at = now()
           RETURNING service_id, offered, minutes`,
          [garageId, serviceId, offered, minutes],
        );
        const removed = offered ? 0 : (await t.query("DELETE FROM pro_prices WHERE garage_id = $1 AND service_id = $2", [garageId, serviceId])).rowCount;
        return { row: r.rows[0], priceRemoved: removed > 0 };
      });
    },

    // ---- relecture des changements de fiche (op « pro-changes », « pro-change »)
    changesToReview: () =>
      db
        .query(
          `SELECT c.id, c.garage_id, c.field, c.value, c.created_at, g.name AS garage_name, g.addr AS garage_addr, p.name AS profile_name, p.street, p.pc, p.city, p.phone
           FROM pro_profile_changes c LEFT JOIN garage_contacts g ON g.garage_id = c.garage_id LEFT JOIN pro_profiles p ON p.garage_id = c.garage_id
           WHERE c.status = 'pending' ORDER BY c.created_at LIMIT 50`,
        )
        .then((r) => r.rows),
    // Approuve (publie dans la fiche) ou refuse un changement en attente. Résultat : { kind: "approved" | "rejected" | "not_found" }.
    decideChange({ id, decision, reason = "" }) {
      return db.tx(async (t) => {
        const c = (await t.query(`SELECT ${CHANGE_COLUMNS}, account_id FROM pro_profile_changes WHERE id = $1 AND status = 'pending'`, [id])).rows[0];
        if (!c) return { kind: "not_found" };
        if (decision === "approve") {
          const set = c.field === "addr" ? JSON.parse(c.value) : { [c.field]: c.value };
          const cols = c.field === "addr" ? ["street", "pc", "city"] : [c.field];
          const vals = cols.map((k) => set[k]);
          await t.query(
            `INSERT INTO pro_profiles (garage_id, account_id, ${cols.join(", ")}, updated_at) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, now())
             ON CONFLICT (garage_id) DO UPDATE SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}, updated_at = now()`,
            [c.garage_id, c.account_id, ...vals],
          );
        }
        await t.query("UPDATE pro_profile_changes SET status = $2, reason = $3, decided_at = now() WHERE id = $1", [id, decision === "approve" ? "approved" : "rejected", reason]);
        return { kind: decision === "approve" ? "approved" : "rejected" };
      });
    },

    // ---- relecture des prix très éloignés (op « pro-prices », « pro-price »)
    pricesToReview: () =>
      db
        .query(`SELECT p.garage_id, p.service_id, p.kind, p.price_cents, p.updated_at, g.name AS garage_name FROM pro_prices p LEFT JOIN garage_contacts g ON g.garage_id = p.garage_id
                WHERE p.status = 'review' ORDER BY p.updated_at LIMIT 50`)
        .then((r) => r.rows),
    setPriceStatus: (garageId, serviceId, status) =>
      db.query("UPDATE pro_prices SET status = $3 WHERE garage_id = $1 AND service_id = $2", [garageId, serviceId, status]).then((r) => r.rowCount > 0),

    // Entretien : journal de plus de 90 jours, demandes non abouties de plus de 30 jours, visites de plus de 60 jours, changements de fiche
    // décidés ou annulés depuis plus de 90 jours.
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
        proVisits: await run("DELETE FROM pro_visits WHERE id IN (SELECT id FROM pro_visits WHERE day < (now() - interval '60 days')::date LIMIT $1)"),
        proChanges: await run(
          "DELETE FROM pro_profile_changes WHERE id IN (SELECT id FROM pro_profile_changes WHERE status <> 'pending' AND coalesce(decided_at, created_at) < now() - interval '90 days' LIMIT $1)",
        ),
      };
    },
  };
}
