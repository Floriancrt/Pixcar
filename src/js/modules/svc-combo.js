// Plusieurs prestations à la fois : ce qu'un garage offre pour l'ensemble choisi dans la fenêtre « Quelles prestations souhaitez-vous
// réaliser ? » (modules/service-picker.js). La page calcule déjà, pour une prestation seule, le niveau de disponibilité (« Au catalogue de
// l'enseigne », « prestation probable », « à vérifier ») et le prix (déclaré, enseigne, sur devis) ; ces fonctions les combinent.
// Fonctions pures, testées sans navigateur (tests/unit/svc-combo.test.mjs).
//
// Règles :
//   - un garage qui ne fait aucune des prestations est écarté ; s'il n'en fait qu'une partie, il reste dans la liste avec « 1 prestation
//     sur 2 » (ce qu'il ne fait pas est nommé) ;
//   - sinon son niveau est le plus faible des prestations (une seule « à vérifier » suffit à le mettre « à vérifier ») ;
//   - le total n'additionne que des prix connus ; il est « partiel » (jamais présenté comme complet, ni retenu par le filtre « Avec prix ») dès
//     qu'une prestation est sans prix, non faite, ou affichée « pièces en plus » ;
//   - les promotions de l'enseigne sur chacune des prestations sont réunies, sans doublon.

const RANK = { no: 0, check: 1, likely: 2, yes: 3 };
const list = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} et ${a[a.length - 1]}`);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// offers : [{ label, lvl, why }] pour chaque prestation choisie, dans l'ordre du choix
export function comboOffer(offers) {
  if (offers.length < 2) return offers[0] ? { lvl: offers[0].lvl, why: offers[0].why } : { lvl: "no" };
  const done = offers.filter((o) => o.lvl !== "no");
  if (!done.length) return { lvl: "no" };
  if (done.length < offers.length) {
    const not = offers.filter((o) => o.lvl === "no").map((o) => lower(o.label));
    return { lvl: "part", why: `${done.length} prestation${done.length > 1 ? "s" : ""} sur ${offers.length} : ne propose pas ${list(not)}`, n: done.length, of: offers.length };
  }
  const low = Math.min(...offers.map((o) => RANK[o.lvl] ?? 1));
  const worst = offers.filter((o) => (RANK[o.lvl] ?? 1) === low);
  const lvl = worst[0].lvl;
  const whys = [...new Set(worst.map((o) => o.why).filter(Boolean))];
  // même raison pour toutes : on la met au pluriel ; sinon on dit pour quelles prestations elle vaut
  if (worst.length === offers.length && whys.length === 1) return { lvl, why: whys[0].replace("prestation probable", "prestations probables") };
  if (whys.length === 1) return { lvl, why: `${whys[0]} (${list(worst.map((o) => lower(o.label)))})` };
  return { lvl, why: whys.join(" · ") };
}

// parts : [{ id, label, unit, price, no }] pour chaque prestation choisie ; price est le prix d'une prestation seule (kind « declared »,
// « chain », « center », « none ») et no dit que le garage ne la fait pas. Une prestation seule garde son prix tel quel.
export function comboPrice(parts) {
  if (parts.length < 2) return parts[0] ? parts[0].price : { kind: "none" };
  const has = (p) => !p.no && p.price && Number.isFinite(p.price.amount);
  const known = parts.filter(has);
  const missing = parts.length - known.length;
  if (!known.length) return { kind: parts.some((p) => !p.no && p.price && p.price.kind === "center") ? "center" : "none", parts, missing };
  const amount = Math.round(known.reduce((s, p) => s + p.price.amount, 0) * 100) / 100;
  const kinds = new Set(known.map((p) => p.price.kind));
  return {
    kind: "combo",
    amount,
    partial: missing > 0 || known.some((p) => p.price.partial),
    missing,
    approx: known.some((p) => p.price.approx),
    declared: known.filter((p) => p.price.kind === "declared").length,
    src: kinds.size === 1 ? [...kinds][0] : "mixed",
    parts,
  };
}

// Promotions réunies : une même offre peut couvrir deux prestations choisies (géométrie avant et 4 roues, vidange et révision…)
export function comboPromos(lists) {
  const seen = new Set(),
    out = [];
  for (const p of lists.flat()) {
    const k = `${p.label}|${p.src}|${p.start || ""}|${p.end || ""}`;
    if (!seen.has(k)) (seen.add(k), out.push(p));
  }
  return out.sort((a, b) => (a.st === "soon") - (b.st === "soon"));
}

// Fourchette des grandes enseignes pour l'ensemble : seulement celles qui publient un prix complet (sans « pièces en plus ») pour chaque
// prestation choisie. prices : { idPrestation: [{ c, p, partial }] }. Renvoie { min: { c, p }, max: { c, p }, n } ou null.
export function comboRange(ids, prices) {
  if (ids.length < 2) return null;
  const totals = new Map();
  for (const [i, id] of ids.entries())
    for (const r of prices[id] || []) {
      if (r.partial || !Number.isFinite(r.p)) continue;
      const t = totals.get(r.c) || { c: r.c, p: 0, n: 0 };
      if (t.n !== i) continue; // l'enseigne doit avoir un prix pour chaque prestation précédente
      ((t.p += r.p), t.n++, totals.set(r.c, t));
    }
  const all = [...totals.values()].filter((t) => t.n === ids.length).map((t) => ({ c: t.c, p: Math.round(t.p * 100) / 100 }));
  if (!all.length) return null;
  const min = all.reduce((a, b) => (b.p < a.p ? b : a)),
    max = all.reduce((a, b) => (b.p > a.p ? b : a));
  return { min, max, n: all.length };
}

// « Total 2 prestations », « Total partiel » : étiquette du prix combiné
export const comboTag = (price) => (price.partial ? "Total partiel" : `Total ${price.parts.length} prestations`);
