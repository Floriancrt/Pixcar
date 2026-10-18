// Espace Pro, côté comparateur (maquette 6 du 11 octobre 2026) : le badge « Garage vérifié », l'étiquette « Annoncé 89 € » à côté du prix
// payé, et le bloc « Prix annoncés par le garage » dans la fiche. Les prix annoncés restent à part : ils n'entrent ni dans l'échelle de prix
// ni dans les médianes. Seuls les garages de la table (lieux d'Overture, identifiant tableId ou ovtId) peuvent être vérifiés.
// « Mon garage » (docs/rendez-vous.md) : les coordonnées que le garage vérifié a déclarées (nom, adresse, téléphone, site, e-mail, horaires),
// et les prestations qu'il dit faire ou ne pas faire.
//
// Rendez-vous en ligne (lot 2) : les prestations que le garage prend en ligne avec un horaire libre dans les 14 jours (rdv.services) ;
// l'étiquette s'ajoute au badge, la fiche a un bloc « Prendre rendez-vous » dont le bouton charge la fenêtre (rdv-book.js) à la demande.
//
// Lecture : GET /v1/pro/public/garages?ids=… (100 au plus par appel), une fois par garage et par visite de la page. Visites : POST
// /v1/pro/public/visits quand la fiche d'un garage vérifié s'ouvre (« view ») et quand on touche « Appeler » (« call »), une fois par garage,
// par type et par visite de la page (l'API, elle, ne compte qu'une fois par jour). Sans API, ou Espace Pro fermé : rien, sans erreur.
import { DAYS } from "../shared/garage-profile.js";
import { PRO_SERVICES, announcedText, serviceLabel } from "../shared/pro-prices.js";

const MAX_IDS = 100;
const ORDER = new Map(PRO_SERVICES.map((s, i) => [s.id, i]));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dayText = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
};

// Profil publié : l'API l'a validé ; la page n'en garde que ce qui a la bonne forme (contrôles légers, le budget de la page compte), et
// jamais une adresse web autre que http(s).
const str = (v, max) => (typeof v === "string" && v.trim() && v.length <= max ? v : "");
const HM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DAY_KEYS = new Set(DAYS.map((d) => d[0]));
const hoursOk = (h) =>
  !!h && typeof h === "object" && !Array.isArray(h) && Object.keys(h).length > 0 &&
  Object.entries(h).every(([k, v]) => DAY_KEYS.has(k) && Array.isArray(v) && v.length <= 2 && v.every((x) => Array.isArray(x) && x.length === 2 && x.every((t) => HM.test(t))));
function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  const out = {};
  const a = p.addr;
  if (str(p.name, 120)) out.name = p.name;
  if (a && str(a.street, 200) && /^\d{5}$/.test(a.pc) && str(a.city, 80)) out.addr = { street: a.street, pc: a.pc, city: a.city };
  if (/^\+\d{6,15}$/.test(p.phone)) out.phone = p.phone;
  if (str(p.website, 200) && /^https?:\/\/[^\s"'<>]+$/i.test(p.website)) out.website = p.website;
  if (str(p.email, 254) && /^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i.test(p.email)) out.email = p.email;
  if (hoursOk(p.hours)) out.hours = p.hours;
  return Object.keys(out).length ? out : null;
}
const serviceSet = (list) => new Set((Array.isArray(list) ? list : []).filter((id) => ORDER.has(id)));

// Identifiant Overture d'un garage de la liste : celui du lieu de la table qui le complète, ou celui du lieu ajouté par la table.
export const proKey = (g) => (g && (g.tableId || g.ovtId)) || "";

export function createProPublic({ base = "", fetchImpl = (...a) => fetch(...a), onUpdate = () => {}, delayMs = 30 } = {}) {
  const known = new Map(); // id Overture → { prices: { service: prix }, profile, offered, notOffered } (vérifié) | null (pas vérifié, ou réponse impossible)
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
      const svc = g.services && typeof g.services === "object" ? g.services : {};
      known.set(g.id, { prices, profile: cleanProfile(g.profile), offered: serviceSet(svc.offered), notOffered: serviceSet(svc.notOffered), rdv: serviceSet(g.rdv && g.rdv.services) });
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
    // coordonnées déclarées par le garage vérifié (champs présents seulement), ou null
    profile: (g) => (known.get(proKey(g)) || {}).profile || null,
    // le garage dit faire (true) ou ne pas faire (false) cette prestation ; null : il n'a rien dit, ou pas vérifié
    offers(g, serviceId) {
      const i = known.get(proKey(g));
      return !i || !serviceId ? null : i.offered.has(serviceId) ? true : i.notOffered.has(serviceId) ? false : null;
    },
    // le garage prend en ligne toutes ces prestations
    books(g, ids) {
      const i = known.get(proKey(g));
      return !!(i && ids.length && ids.every((id) => i.rdv.has(id)));
    },
    visit(g, kind) {
      const k = proKey(g);
      if (off || !k || !known.get(k) || counted.has(k + kind)) return;
      counted.add(k + kind);
      fetchImpl(`${base}/v1/pro/public/visits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ garageId: k, kind }), keepalive: true }).catch(() => {});
    },
    // ---- ce que la page affiche (HTML ; tout texte venu de l'API est échappé)
    badgeHtml(g, icon = "", rdv = false) {
      return known.get(proKey(g)) ? `<p class="v-badge">${icon}Garage vérifié</p>${rdv ? '<p class="v-badge v-rdv">Rendez-vous en ligne</p>' : ""}` : "";
    },
    // Bloc de la fiche : le bouton ouvre la fenêtre de rendez-vous (horaire, coordonnées, code)
    rdvHtml: (icon = "") =>
      `<section class="rdv-box" aria-label="Rendez-vous en ligne"><div><h4>Prendre rendez-vous</h4><p>Choisissez un horaire libre. Le garage confirme au plus tard à midi le jour ouvré suivant ; sa réponse arrive par e-mail.</p></div><button type="button" class="btn dark" data-act="rdv" aria-haspopup="dialog">${icon}Choisir un horaire</button></section>`,
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
