// Espace Pro : règles qui décident par où un garage peut recevoir un code de vérification, et ce qu'on en montre au demandeur.
//  - e-mail public : une adresse connue du garage (Overture), propre à ce seul garage ; montrée masquée (« c•••@garage-dupont.fr ») ;
//  - e-mail sur le domaine du site : le demandeur choisit la partie locale, le domaine est imposé par nos données. Refusé pour les
//    plateformes de sites, les messageries grand public, les enseignes et réseaux (une adresse du réseau ne prouve pas CE garage),
//    les sites qui ne sont pas à la racine de leur domaine (page d'un annuaire ou d'un réseau) et un domaine porté par deux garages ;
//  - SMS : un portable français (06, 07) connu du garage ; montré masqué (« 06 •• •• •• 42 »). Un fixe ne reçoit pas de SMS.
// Aucune de ces fonctions ne touche au réseau ni à la base.

// Plateformes de sites et messageries : le domaine appartient à l'hébergeur, pas au garage.
const SHARED_DOMAINS = [
  // messageries
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.fr", "outlook.com", "outlook.fr", "live.com", "live.fr", "msn.com", "yahoo.com",
  "yahoo.fr", "icloud.com", "me.com", "aol.com", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "neuf.fr", "bbox.fr", "laposte.net",
  "gmx.fr", "gmx.com", "protonmail.com", "proton.me", "numericable.fr", "club-internet.fr", "aliceadsl.fr", "cegetel.net",
  // plateformes de sites et réseaux sociaux
  "wixsite.com", "wix.com", "business.site", "sites.google.com", "google.com", "facebook.com", "fb.com", "instagram.com", "linkedin.com",
  "jimdo.com", "jimdofree.com", "jimdosite.com", "webnode.fr", "webnode.com", "e-monsite.com", "over-blog.com", "wordpress.com",
  "blogspot.com", "site-solocal.com", "solocal.com", "pagesjaunes.fr", "mystrikingly.com", "weebly.com", "squarespace.com", "godaddysites.com",
  "ueniweb.com", "simplesite.com", "webself.net", "1and1.fr", "ionos.fr", "123website.fr", "linktr.ee", "carrd.co", "yolasite.com",
  "site123.me", "vroomvroom.fr", "idgarages.com", "vroomly.com", "autobutler.fr", "mondevisauto.fr",
];
// Enseignes, réseaux et constructeurs : leur domaine est commun à des centaines d'ateliers.
const NETWORK_DOMAINS = [
  "norauto.fr", "feuvert.fr", "speedy.fr", "midas.fr", "roady.fr", "euromaster.fr", "point-s.fr", "firststop.fr", "vulco.fr", "profilplus.fr",
  "siligom.com", "eurotyre.fr", "bestdrive.fr", "driver-center.fr", "e.leclerc", "leclerc.fr", "carter-cash.com", "eurorepar.fr", "motrio.fr",
  "ad.fr", "bosch-car-service.fr", "boschcarservice.fr", "topgarage.fr", "precisium.fr", "delko.fr", "autoprimo.fr", "avatacar.com",
  "carglass.fr", "france-pare-brise.fr", "mondial-pare-brise.fr", "rapid-pare-brise.fr", "abc-pare-brise.fr", "dyneff.fr", "total.fr",
  "totalenergies.fr", "renault.fr", "peugeot.fr", "citroen.fr", "dacia.fr", "volkswagen.fr", "toyota.fr", "ford.fr", "opel.fr", "fiat.fr",
  "nissan.fr", "kia.fr", "hyundai.fr", "skoda.fr", "seat.fr", "audi.fr", "bmw.fr", "mercedes-benz.fr", "ds-automobiles.fr", "stellantis.com",
  "garage-autodistribution.fr", "autodistribution.fr", "groupe-autodistribution.fr", "acr-garage.fr", "1-2-3-auto.fr", "garage-123auto.fr",
  "autobacs.fr", "autossimo.fr", "repar-auto.fr", "precisium.com", "mobivia.com", "dekra.fr", "autosur.fr", "securitest.fr", "autovision.fr",
];
const DENY = new Set([...SHARED_DOMAINS, ...NETWORK_DOMAINS]);
// Noms d'enseignes et de réseaux (même liste que la page, en plus court) : un atelier de réseau passe par l'e-mail public ou le SMS.
const NETWORK_NAME = /norauto|feu\s*-?\s*vert|speedy|midas|roady|euromaster|\bpoint\s*s\b|first\s*stop|vulco|profil\s*(\+|plus)|siligom|euro\s*tyre|best\s*drive|driver\s*cent(er|re)|leclerc|carter\s*-?\s*cash|euro\s*repar|motrio|bosch\s*(car\s*)?service|top\s*garage|precisium|delko|auto\s*primo|avatacar|carglass|(^|[\s|])AD(\s+(Expert|Garage|Carrosserie))?(?=$|[\s|])|renault|peugeot|citro[eë]n|dacia|toyota|volkswagen/i;

// Domaine « enregistrable » d'un nom d'hôte (sans www.). Les suffixes à deux niveaux courants en France sont pris en compte.
const TWO_LEVEL = /\.(?:co|com|org|gouv|asso|nom|tm)\.[a-z]{2}$|\.(?:co\.uk|com\.au)$/;
export function registrableDomain(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\d?\./, "");
  if (!/^[a-z0-9.-]{3,100}$/.test(h) || !h.includes(".") || h.startsWith(".") || h.includes("..")) return "";
  const parts = h.split(".");
  const keep = TWO_LEVEL.test(h) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

// Domaine d'un site s'il peut servir de preuve : site à la racine (pas une page d'annuaire ou de réseau), domaine hors listes.
// Renvoie le domaine ou "".
export function siteDomain(url) {
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(url || "")) ? String(url) : "https://" + url);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password || u.port) return "";
  if (!/^\/?(index\.(html?|php))?$/i.test(u.pathname)) return "";
  const host = u.hostname.toLowerCase().replace(/^www\d?\./, "");
  const domain = registrableDomain(host);
  if (!domain || host !== domain) return ""; // sous-domaine (garage.exemple-hebergeur.fr) : l'hébergeur détient le domaine
  return domainAllowed(domain) ? domain : "";
}

export function domainAllowed(domain) {
  const d = String(domain || "").toLowerCase();
  if (!d || DENY.has(d)) return false;
  for (const x of DENY) if (d.endsWith("." + x)) return false;
  return true;
}

export const isNetworkName = (name) => NETWORK_NAME.test(String(name || ""));

// ---- e-mails
const EMAIL = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase().replace(/^mailto:/, "");
  return e.length <= 254 && EMAIL.test(e) && !e.includes("..") ? e : "";
}

// Partie locale choisie par le demandeur pour l'option « domaine » : lettres, chiffres, point, tiret, soulignés ; ni début ni fin par un point.
export const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const normalizeLocalPart = (raw) => {
  const l = String(raw || "").trim().toLowerCase();
  return LOCAL_PART.test(l) && !l.includes("..") ? l : "";
};

// « contact@garage-dupont.fr » → « c•••••@garage-dupont.fr » : la première lettre seulement, et une longueur fixe qui ne révèle rien.
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}•••••@${domain}`;
}

// ---- téléphones
// Numéro français au format international (« +33612345678 ») ; "" si ce n'en est pas un.
export function normalizeFrPhone(raw) {
  const d = String(raw || "").replace(/[\s.()-]/g, "");
  let m = /^(?:\+33|0033)(\d{9})$/.exec(d);
  if (m) return m[1].startsWith("0") ? "" : "+33" + m[1];
  m = /^0([1-9]\d{8})$/.exec(d);
  return m ? "+33" + m[1] : "";
}
export const isFrMobile = (e164) => /^\+33[67]\d{8}$/.test(String(e164 || ""));
// « +33612345678 » → « 06 •• •• •• 78 »
export const maskPhone = (e164) => `0${e164.slice(3, 4)} •• •• •• ${e164.slice(-2)}`;

// ---- options de vérification d'un garage
// contact : ligne de garage_contacts ({ name, brand, emails, phones, web_domain }) ; domainShared : le domaine est porté par un autre garage.
// Renvoie [{ id, channel, hint, domain? }] dans l'ordre où la page les propose (e-mails, domaine, SMS). Les identifiants restent stables
// d'un appel à l'autre (« email:0 » = première adresse de la liste) : la demande les renvoie, le serveur retrouve la cible lui-même.
export function verificationOptions(contact, { domainShared = false } = {}) {
  const out = [];
  const emails = Array.isArray(contact.emails) ? contact.emails : [];
  emails.forEach((raw, i) => {
    const e = normalizeEmail(raw);
    if (e) out.push({ id: `email:${i}`, channel: "email", hint: maskEmail(e) });
  });
  const domain = String(contact.web_domain || "");
  if (domain && !domainShared && !contact.brand && !isNetworkName(contact.name) && domainAllowed(domain)) out.push({ id: "domain", channel: "email_domain", hint: `…@${domain}`, domain });
  const phones = Array.isArray(contact.phones) ? contact.phones : [];
  phones.forEach((raw, i) => {
    const p = normalizeFrPhone(raw);
    if (p && isFrMobile(p)) out.push({ id: `sms:${i}`, channel: "sms", hint: maskPhone(p) });
  });
  return out;
}

// Cible réelle d'une option choisie (jamais renvoyée au demandeur, sauf l'adresse qu'il a lui-même composée pour l'option « domaine »).
// Renvoie { channel, target, hint } ou { error } (option inconnue, partie locale invalide).
export function resolveOption(contact, optionId, { localPart, domainShared = false } = {}) {
  const option = verificationOptions(contact, { domainShared }).find((o) => o.id === optionId);
  if (!option) return { error: "option" };
  if (option.channel === "email") return { channel: "email", target: normalizeEmail(contact.emails[Number(optionId.slice(6))]), hint: option.hint };
  if (option.channel === "sms") return { channel: "sms", target: normalizeFrPhone(contact.phones[Number(optionId.slice(4))]), hint: option.hint };
  const local = normalizeLocalPart(localPart);
  if (!local) return { error: "local_part" };
  const target = `${local}@${option.domain}`;
  return { channel: "email_domain", target, hint: target };
}

// ---- noms : même idée que scripts/garages/matching.py (un mot distinctif en commun, ou un nom contenu dans l'autre)
const GENERIC = new Set(
  "garage garages auto autos automobile automobiles sarl eurl sas sasu ets centre station service services reparation mecanique atelier societe entreprise carrosserie carosserie pneu pneus tires controle technique peinture depannage vitrage pieces accessoires multimarque multimarques express les des du de la le et and pro".split(" "),
);
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const tokens = (s) => new Set(fold(s).replace(/['’`-]/g, " ").split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
const compact = (s) => fold(s).replace(/[^a-z0-9]+/g, "");
export function sameName(a, b) {
  const tb = tokens(b);
  for (const t of tokens(a)) if (tb.has(t)) return true;
  const ca = compact(a), cb = compact(b);
  return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
}

// ---- import des contacts (op « import-contacts ») : chaque ligne est revalidée ici, quelle que soit sa provenance.
// Entrée : { id, name, addr?, pc?, lat, lon, brand?, emails?, phones?, web? } (sortie de scripts/garages/build.py --contacts-out).
// Sortie : { rows: [{ garageId, name, addr, pc, lat, lon, brand, emails, phones, webDomain }], rejected } ; une ligne invalide est écartée.
const coord = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN); // null n'est pas 0
export function parseContactRows(input) {
  const rows = [];
  let rejected = 0;
  for (const r of input) {
    const id = r && typeof r.id === "string" ? r.id : "";
    const name = r && typeof r.name === "string" ? r.name.trim() : "";
    const lat = coord(r && r.lat), lon = coord(r && r.lon);
    if (!/^[0-9a-f-]{8,40}$/.test(id) || name.length < 2 || name.length > 120 || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      rejected++;
      continue;
    }
    const emails = [...new Set((Array.isArray(r.emails) ? r.emails : []).map(normalizeEmail).filter(Boolean))].slice(0, 5);
    const phones = [...new Set((Array.isArray(r.phones) ? r.phones : []).map((p) => (/^\+\d{10,15}$/.test(String(p)) ? String(p) : "")).filter(Boolean))].slice(0, 4);
    rows.push({
      garageId: id,
      name,
      addr: typeof r.addr === "string" ? r.addr.trim().slice(0, 240) : "",
      pc: /^\d{5}$/.test(String(r.pc || "")) ? String(r.pc) : "",
      lat,
      lon,
      brand: r.brand === true,
      emails,
      phones,
      webDomain: r.web ? siteDomain(r.web) : "",
    });
  }
  return { rows, rejected };
}
