// Espace Pro, côté comparateur (maquette 6 du 11 octobre 2026) : le badge « Garage vérifié », l'étiquette « Annoncé 89 € » à côté du prix
// payé, et le bloc « Prix annoncés par le garage » dans la fiche. Les prix annoncés restent à part : ils n'entrent ni dans l'échelle de prix
// ni dans les médianes. Seuls les garages de la table (lieux d'Overture, identifiant tableId ou ovtId) peuvent être vérifiés.
//
// Lecture : GET /v1/pro/public/garages?ids=… (100 au plus par appel), une fois par garage et par visite de la page. Visites : POST
// /v1/pro/public/visits quand la fiche d'un garage vérifié s'ouvre (« view ») et quand on touche « Appeler » (« call »), une fois par garage,
// par type et par visite de la page (l'API, elle, ne compte qu'une fois par jour). Sans API, ou Espace Pro fermé : rien, sans erreur.
import { PRO_SERVICES, announcedText, serviceLabel } from "../shared/pro-prices.js";

const MAX_IDS = 100;
const ORDER = new Map(PRO_SERVICES.map((s, i) => [s.id, i]));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dayText = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};

// Identifiant Overture d'un garage de la liste : celui du lieu de la table qui le complète, ou celui du lieu ajouté par la table.
export const proKey = (g) => (g && (g.tableId || g.ovtId)) || "";

export function createProPublic({ base = "", fetchImpl = (...a) => fetch(...a), onUpdate = () => {}, delayMs = 30 } = {}) {
  const known = new Map(); // id Overture → { prices: { service: prix } } (vérifié) | null (pas vérifié, ou réponse impossible)
  const waiting = new Set();
  const counted = new Set();
  let timer = null;
  let off = !base; // pas d'API, ou Espace Pro fermé (404) : plus aucun appel

  async function flush() {
    timer = null;
    if (off || !waiting.size) return;
    const ids = [...waiting].slice(0, MAX_IDS);
    for (const id of ids) waiting.delete(id);
    let out = null;
    try {
      const res = await fetchImpl(`${base}/v1/pro/public/garages?ids=${ids.map(encodeURIComponent).join(",")}`, { headers: { accept: "application/json" } });
      if (res.status === 404) off = true;
      out = res.ok ? await res.json() : null;
    } catch {
      out = null; // réseau : ces garages restent sans badge pour cette visite, la page n'en souffre pas
    }
    let found = false;
    for (const id of ids) known.set(id, null);
    for (const g of (out && Array.isArray(out.garages) && out.garages) || []) {
      if (!g || typeof g.id !== "string" || g.verified !== true) continue;
      const prices = {};
      for (const p of Array.isArray(g.prices) ? g.prices : []) if (p && ORDER.has(p.service) && ["fixed", "from", "quote"].includes(p.kind)) prices[p.service] = p;
      known.set(g.id, { prices });
      found = true;
    }
    if (waiting.size) timer = setTimeout(flush, 0);
    if (found) onUpdate();
  }

  return {
    // À appeler avec les garages affichés : ceux qu'on ne connaît pas encore partent dans la prochaine requête (regroupées).
    need(garages) {
      if (off) return;
      for (const g of garages || []) {
        const k = proKey(g);
        if (k && !known.has(k)) waiting.add(k);
      }
      if (waiting.size && !timer) timer = setTimeout(flush, delayMs);
    },
    // { prices } si le garage est vérifié, sinon null
    info: (g) => known.get(proKey(g)) || null,
    // le prix annoncé pour cette prestation, ou null
    price(g, serviceId) {
      const i = known.get(proKey(g));
      return (i && serviceId && i.prices[serviceId]) || null;
    },
    visit(g, kind) {
      const k = proKey(g);
      if (off || !k || !known.get(k) || counted.has(k + kind)) return;
      counted.add(k + kind);
      fetchImpl(`${base}/v1/pro/public/visits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ garageId: k, kind }), keepalive: true }).catch(() => {});
    },
    // ---- ce que la page affiche (HTML ; tout texte venu de l'API est échappé)
    badgeHtml(g, icon = "") {
      return known.get(proKey(g)) ? `<p class="v-badge">${icon}Garage vérifié</p>` : "";
    },
    // « Annoncé 89 € », à côté du prix payé (ou seul, quand aucun prix payé n'est déclaré)
    chipHtml(p) {
      return `<span class="tag annonce" title="Prix annoncé par le garage, sous sa responsabilité ; il n'entre pas dans l'échelle des prix payés${p.stale ? ". Non confirmé depuis 6 mois" : ""}">Annoncé ${esc(announcedText(p.kind, p.price))}${p.stale ? " · ancien" : ""}</span>`;
    },
    // Bloc de la fiche : tous les prix annoncés du garage, la prestation cherchée en premier
    ficheHtml(g, serviceId, icon = "") {
      const i = known.get(proKey(g));
      if (!i) return "";
      const list = Object.values(i.prices).sort((a, b) => (b.service === serviceId) - (a.service === serviceId) || ORDER.get(a.service) - ORDER.get(b.service));
      if (!list.length) return "";
      const last = list.reduce((m, p) => (p.updated > m ? p.updated : m), list[0].updated);
      return `<section class="pro-ann" aria-label="Prix annoncés par le garage">
        <div class="pa-head"><h4>Prix annoncés par le garage</h4><span class="v-badge">${icon}Vérifié</span></div>
        <ul class="pa-list">${list
          .map((p) => `<li${p.service === serviceId ? ' class="is-cur"' : ""}><span>${esc(serviceLabel(p.service))}${p.stale ? ' <small class="pa-old">ancien</small>' : ""}</span><b>${esc(announcedText(p.kind, p.price))}</b></li>`)
          .join("")}</ul>
        <p class="pa-note">Mis à jour le ${esc(dayText(last))}. Communiqués par le garage, sous sa responsabilité ; ils n'entrent pas dans les prix médians de Pixcar.</p>
      </section>`;
    },
  };
}
