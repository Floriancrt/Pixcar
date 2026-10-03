// Accès aux données : tout le SQL de l'API est ici. Les paramètres passent toujours à part ($1, $2…).
// Le SQL est volontairement du plus courant : il tourne tel quel sur PostgreSQL, PGlite et Amazon Aurora DSQL (rank() plutôt que
// row_number(), médiane par décalage plutôt que percentile_cont, mois et délais calculés ici plutôt que par to_char / extract).
// Les empreintes (plaque, adresse IP, jeton) arrivent ici déjà en hexadécimal de 64 caractères (voir db/migrations/001_init.sql).
import { CELL_DEG, cellOf, cellsAround } from "./lib/geo.mjs";

export const MAX_PER_GARAGE_SERVICE = 30; // réparations renvoyées au plus par garage et par prestation (les plus récentes)
export const MAX_ROWS = 3000; // et au plus par réponse
// La page demande des cases entières de 0,05° : le centre de la case peut être à ~4 km du point de recherche réel,
// on élargit donc le rayon d'autant pour ne manquer aucun garage ; la page affine à la distance exacte.
export const CELL_MARGIN_KM = 4.5;
export const PURGE_BATCH = 1000; // lignes supprimées par instruction (DSQL : 3 000 lignes au plus par transaction)

const cellCenter = ({ y, x }) => ({ lat: (y + 0.5) * CELL_DEG - 90, lon: (x + 0.5) * CELL_DEG - 180 });
const seconds = (later, earlier) => (new Date(later).getTime() - new Date(earlier).getTime()) / 1000;

export function createRepo(db) {
  return {
    ping: () => db.query("SELECT 1 AS ok").then(() => true),

    // ---- lecture : tout ce qui est déclaré autour d'une case, groupé par garage
    async listArea({ lat, lon, radiusKm }) {
      const cell = cellOf(lat, lon);
      const c = cellCenter(cell);
      const box = cellsAround(c.lat, c.lon, radiusKm + CELL_MARGIN_KM);
      const { rows } = await db.query(
        `WITH ranked AS (
           SELECT r.id, r.garage_id, r.service_id, r.price_cents, r.repaired_on, r.rating, r.vehicle_model, r.vehicle_year,
                  rank() OVER (PARTITION BY r.garage_id, r.service_id ORDER BY r.repaired_on DESC, r.created_at DESC) AS rn
           FROM repairs r
           JOIN garages g ON g.id = r.garage_id
           WHERE r.status = 'approved' AND g.area_y BETWEEN $1 AND $2 AND g.area_x BETWEEN $3 AND $4
         )
         SELECT g.id AS garage_id, g.name, g.addr, g.lat, g.lon, g.chain_id,
                k.id, k.service_id, k.price_cents, k.repaired_on::text AS day, k.rating, k.vehicle_model, k.vehicle_year
         FROM ranked k JOIN garages g ON g.id = k.garage_id
         WHERE k.rn <= $5
         ORDER BY g.id, k.service_id, k.repaired_on DESC, k.id
         LIMIT $6`,
        [box.y0, box.y1, box.x0, box.x1, MAX_PER_GARAGE_SERVICE, MAX_ROWS + 1],
      );
      const truncated = rows.length > MAX_ROWS;
      const byGarage = new Map();
      for (const r of rows.slice(0, MAX_ROWS)) {
        let g = byGarage.get(r.garage_id);
        if (!g) {
          g = { id: r.garage_id, name: r.name, addr: r.addr, lat: r.lat, lon: r.lon, chainId: r.chain_id, repairs: [] };
          byGarage.set(r.garage_id, g);
        }
        // le mois seulement (« 2026-09 ») : le jour exact ne sort jamais de la base
        g.repairs.push({ id: r.id, serviceId: r.service_id, price: r.price_cents / 100, month: String(r.day).slice(0, 7), rating: r.rating, model: r.vehicle_model, year: r.vehicle_year });
      }
      return { cell, truncated, garages: [...byGarage.values()] };
    },

    // ---- écriture d'une déclaration
    // ctx : { tokenHash, plateHash, ipHash (hexadécimal), limitPerHour, limitGlobalPerMinute, moderate }
    // Résultat : { kind: "created" | "replay", status } | { kind: "conflict" | "duplicate" } | { kind: "limited", retryAfter }
    // La fonction peut être rejouée par la base (DSQL : conflit de concurrence) : elle ne fait rien hors de la transaction.
    insertRepair(v, ctx) {
      return db.tx(async (t) => {
        const known = (await t.query("SELECT delete_token_hash, status FROM repairs WHERE id = $1", [v.id])).rows[0];
        if (known) return known.delete_token_hash === ctx.tokenHash ? { kind: "replay", status: known.status } : { kind: "conflict" };

        const perIp = (await t.query(
          "SELECT count(*)::int AS n, min(at) AS oldest, now() AS db_now FROM write_log WHERE ip_hash = $1 AND at > now() - interval '1 hour'",
          [ctx.ipHash],
        )).rows[0];
        if (perIp.n >= ctx.limitPerHour) {
          const wait = perIp.oldest && perIp.db_now ? Math.ceil(3600 - seconds(perIp.db_now, perIp.oldest)) : 60; // l'heure glissante libère sa plus ancienne entrée
          return { kind: "limited", retryAfter: Math.max(1, wait || 60) };
        }
        const global = (await t.query("SELECT count(*)::int AS n FROM write_log WHERE at > now() - interval '1 minute'")).rows[0];
        if (global.n >= ctx.limitGlobalPerMinute) return { kind: "limited", retryAfter: 30 };

        const area = cellOf(v.pos.lat, v.pos.lon);
        await t.query(
          `INSERT INTO garages (id, name, addr, lat, lon, chain_id, area_y, area_x)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [v.garage.id, v.garage.name, v.garage.addr, v.garage.lat, v.garage.lon, v.garage.chainId, area.y, area.x],
        );
        // le garage garde l'emplacement de sa première déclaration : on retient la case qui est en base
        const stored = (await t.query("SELECT area_y, area_x FROM garages WHERE id = $1", [v.garage.id])).rows[0];
        const status = ctx.moderate ? await decideStatus(t, v.serviceId, v.priceCents, stored.area_y, stored.area_x) : "approved";

        const ins = await t.query(
          `INSERT INTO repairs (id, garage_id, service_id, price_cents, repaired_on, rating, comment, vehicle_model, vehicle_year, plate_hmac, status, delete_token_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT DO NOTHING RETURNING id`,
          [v.id, v.garage.id, v.serviceId, v.priceCents, v.date, v.rating, v.comment, v.model, v.year, ctx.plateHash, status, ctx.tokenHash],
        );
        if (!ins.rowCount) {
          // même identifiant posé entre-temps par une requête concurrente (rejeu ou conflit), ou même plaque / garage / prestation / jour
          const again = (await t.query("SELECT delete_token_hash, status FROM repairs WHERE id = $1", [v.id])).rows[0];
          if (again) return again.delete_token_hash === ctx.tokenHash ? { kind: "replay", status: again.status } : { kind: "conflict" };
          return { kind: "duplicate" };
        }
        await t.query("INSERT INTO write_log (ip_hash) VALUES ($1)", [ctx.ipHash]);
        return { kind: "created", status };
      });
    },

    async deleteRepair(id, tokenHash) {
      const r = await db.query("DELETE FROM repairs WHERE id = $1 AND delete_token_hash = $2 RETURNING id", [id, tokenHash]);
      return r.rowCount > 0;
    },

    // ---- modération
    listPending: (limit = 50) =>
      db
        .query(
          `SELECT r.id, r.service_id, r.price_cents, r.repaired_on::text AS date, r.rating, r.comment, r.vehicle_model, r.vehicle_year, r.created_at, g.id AS garage_id, g.name AS garage_name
           FROM repairs r JOIN garages g ON g.id = r.garage_id WHERE r.status = 'pending' ORDER BY r.created_at LIMIT $1`,
          [limit],
        )
        .then((r) => r.rows),
    setStatus: (id, status) => db.query("UPDATE repairs SET status = $2 WHERE id = $1", [id, status]).then((r) => r.rowCount > 0),
    // demande d'effacement d'une personne : toutes les déclarations portant cette empreinte de plaque (rejetées comprises)
    deleteByPlate: (plateHash) => db.query("DELETE FROM repairs WHERE plate_hmac = $1", [plateHash]).then((r) => r.rowCount),
    stats: () =>
      db
        .query("SELECT status, count(*)::int AS n FROM repairs GROUP BY status ORDER BY status")
        .then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n]))),

    // ---- cache des réponses d'Overpass (servies périmées quand tous les serveurs sont en panne)
    async getUpstream(key) {
      const r = await db.query("SELECT body, fetched_at, now() AS db_now FROM upstream_cache WHERE key = $1", [key]);
      const row = r.rows[0];
      return row ? { body: row.body, ageSeconds: Math.max(0, Math.floor(seconds(row.db_now, row.fetched_at))) } : null;
    },
    putUpstream: (key, body) =>
      db.query(
        "INSERT INTO upstream_cache (key, body, fetched_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = now()",
        [key, JSON.stringify(body)],
      ),

    // ---- entretien (idempotent : plusieurs instances peuvent l'exécuter), par lots pour rester sous la limite de DSQL
    // repairRetentionMonths : les déclarations déposées il y a plus longtemps sont supprimées, tous états confondus (0 : on les garde).
    async purge({ repairRetentionMonths = 0, now = Date.now } = {}) {
      const cutoff = retentionCutoff(repairRetentionMonths, now());
      return {
        writeLog: await deleteInBatches(db, "DELETE FROM write_log WHERE id IN (SELECT id FROM write_log WHERE at < now() - interval '30 days' LIMIT $1)"),
        upstreamCache: await deleteInBatches(db, "DELETE FROM upstream_cache WHERE key IN (SELECT key FROM upstream_cache WHERE fetched_at < now() - interval '14 days' LIMIT $1)"),
        // avant les garages : un garage resté sans déclaration part dans la même passe s'il a plus de 7 jours
        repairs: cutoff ? await deleteInBatches(db, "DELETE FROM repairs WHERE id IN (SELECT id FROM repairs WHERE created_at < $2::timestamptz LIMIT $1)", [cutoff]) : 0,
        garages: await deleteInBatches(
          db,
          "DELETE FROM garages WHERE id IN (SELECT g.id FROM garages g WHERE g.created_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM repairs r WHERE r.garage_id = g.id) LIMIT $1)",
        ),
      };
    },
  };
}

// Date limite de conservation (ISO) : maintenant moins N mois ; null quand N n'est pas un entier positif (pas de limite).
function retentionCutoff(months, nowMs) {
  if (!Number.isInteger(months) || months <= 0) return null;
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

async function deleteInBatches(db, sql, params = []) {
  let total = 0;
  for (let pass = 0; pass < 100; pass++) {
    const { rowCount } = await db.query(sql, [PURGE_BATCH, ...params]);
    total += rowCount;
    if (rowCount < PURGE_BATCH) break;
  }
  return total;
}

// Une déclaration au prix très éloigné de ce que les autres ont déclaré pour la même prestation dans le coin attend une
// relecture (« pending ») au lieu de fausser les médianes. Sans assez de données, on accepte.
// Médiane = ce que renvoie percentile_cont(0.5) : la valeur du milieu, ou la moyenne des deux du milieu ; lue par décalage.
export async function decideStatus(t, serviceId, priceCents, y, x) {
  const scope = `FROM repairs r JOIN garages g ON g.id = r.garage_id
                 WHERE r.status = 'approved' AND r.service_id = $1 AND g.area_y BETWEEN $2 AND $3 AND g.area_x BETWEEN $4 AND $5`;
  const args = [serviceId, y - 1, y + 1, x - 1, x + 1];
  const n = (await t.query(`SELECT count(*)::int AS n ${scope}`, args)).rows[0].n;
  if (n < 5) return "approved";
  const mid = (await t.query(`SELECT r.price_cents ${scope} ORDER BY r.price_cents OFFSET $6 LIMIT $7`, [...args, Math.floor((n - 1) / 2), n % 2 ? 1 : 2])).rows;
  const med = mid.reduce((sum, r) => sum + Number(r.price_cents), 0) / mid.length;
  if (med > 0 && (priceCents < med / 3 || priceCents > med * 3)) return "pending";
  return "approved";
}
