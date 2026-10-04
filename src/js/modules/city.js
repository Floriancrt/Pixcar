// ----- Ville d'un garage : mise en forme et lecture dans une adresse -----
// La puce distance des cartes dit « 2,5 km · Bron » : la ville situe le garage d'un coup d'œil. Les noms de commune
// arrivent d'OpenStreetMap, du registre SIRENE, du contrôle technique ou de la Base Adresse Nationale, écrits de façons
// très différentes (« SAINT-GENIS-LAVAL », « LYON 3EME », « Villeurbanne Cedex »).
//
// cityTidy met un nom de commune en forme d'affichage. Un texte qui contient déjà des minuscules reste tel quel
// (OpenStreetMap l'écrit correctement) ; un texte tout en majuscules est remis en casse de titre, particules comprises
// (« VILLEFRANCHE-SUR-SAONE » → « Villefranche-sur-Saone »). « Cedex » est retiré, un arrondissement s'écrit « 3e » ou
// « 1er ». Sans lettre, ou au-delà de 60 caractères, ce n'est pas un nom de commune : chaîne vide.
//
// cityFromAddr lit la commune dans une adresse : ce qui suit le dernier code postal à cinq chiffres, jusqu'à la virgule
// (« 12 rue X, 69100 Villeurbanne » → « Villeurbanne »). Sans code postal suivi d'un nom : chaîne vide, jamais deviné.
const LOW = new Set(["de", "du", "des", "la", "le", "les", "sur", "sous", "en", "lès", "lez", "aux", "au", "et"]);

export function cityTidy(s) {
  s = String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\bcedex\b.*$/i, "")
    .trim();
  if (!s || s.length > 60 || !/\p{L}/u.test(s)) return "";
  if (!/[a-zà-ÿ]/.test(s))
    s = s
      .toLowerCase()
      .replace(/(^|[\s\-'’(])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase())
      .replace(/(?<=[\s-])(\p{Lu}\p{Ll}*)(?=[\s-]|$)/gu, (w) => (LOW.has(w.toLowerCase()) ? w.toLowerCase() : w))
      .replace(/(?<=[\s-])D(?=['’])/g, "d");
  return s.replace(
    /\s+0?(\d{1,2})\s*(?:e|ème|eme|er|ère|ere)?(?:\s+arrondissement)?$/i,
    (m, n) => ` ${n}${+n === 1 ? "er" : "e"}`,
  );
}

export function cityFromAddr(s) {
  const m = [...String(s || "").matchAll(/(?:^|[\s,])\d{5}\s+([^,]+)/g)].pop();
  return m ? cityTidy(m[1]) : "";
}
