// Unit tests of cityTidy and cityFromAddr (src/js/modules/city.js), run in Node.
const path = require("path"), { pathToFileURL } = require("url");
(async () => {
// PIXCAR_SRC: sources to test (the mutation runner points it at a modified copy)
const SRC = process.env.PIXCAR_SRC || path.join(__dirname, "..", "src");
const { cityTidy, cityFromAddr } = await import(pathToFileURL(path.join(SRC, "js/modules/city.js")).href);
let bad = 0, n = 0;
const eq = (fn, kind, name, raw, want) => {
  n++;
  const got = fn(raw);
  if (got !== want) { bad++; console.log(`  FAIL: ${kind}:${name.replace(/\W+/g, "_")} | ${JSON.stringify(raw)} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const tidy = (name, raw, want) => eq(cityTidy, "tidy", name, raw, want);
const from = (name, raw, want) => eq(cityFromAddr, "from", name, raw, want);

// ----- cityTidy -----
tidy("already well written", "Villeurbanne", "Villeurbanne");
tidy("accents kept as they are", "Saint-Étienne", "Saint-Étienne");
tidy("mixed case is not re-cased (only the arrondissement is shortened)", "Lyon 8ème", "Lyon 8e");
tidy("capitals, 4 letters (q() leaves those alone)", "LYON", "Lyon");
tidy("capitals, 4 letters, other", "BRON", "Bron");
tidy("capitals, hyphens", "SAINT-GENIS-LAVAL", "Saint-Genis-Laval");
tidy("particle after a hyphen", "VILLEFRANCHE-SUR-SAONE", "Villefranche-sur-Saone");
tidy("several particles", "SAINT-ETIENNE-DU-ROUVRAY", "Saint-Etienne-du-Rouvray");
tidy("« lès » particle", "SAINTE-FOY-LÈS-LYON", "Sainte-Foy-lès-Lyon");
tidy("« les » inside a name", "SAINTE-FOY-LES-LYON", "Sainte-Foy-les-Lyon");
tidy("first word keeps its capital even if a particle", "LES ABRETS", "Les Abrets");
tidy("first word « La »", "LA TOUR-DU-PIN", "La Tour-du-Pin");
tidy("elisions", "L'ISLE-D'ABEAU", "L'Isle-d'Abeau");
tidy("typographic apostrophe", "L’ISLE-D’ABEAU", "L’Isle-d’Abeau");
tidy("spaces collapsed and trimmed", "  Saint   Priest ", "Saint Priest");
tidy("cedex removed", "VILLEURBANNE CEDEX", "Villeurbanne");
tidy("cedex with a number removed", "Villeurbanne cedex 2", "Villeurbanne");
tidy("arrondissement « 3EME »", "LYON 3EME", "Lyon 3e");
tidy("arrondissement « 03 »", "LYON 03", "Lyon 3e");
tidy("arrondissement « 1ER »", "LYON 1ER", "Lyon 1er");
tidy("arrondissement « 01 »", "LYON 01", "Lyon 1er");
tidy("arrondissement spelt out", "Lyon 3e Arrondissement", "Lyon 3e");
tidy("arrondissement spelt out, capitals", "LYON 3EME ARRONDISSEMENT", "Lyon 3e");
tidy("two digits", "PARIS 15", "Paris 15e");
tidy("a postcode is not an arrondissement", "Lyon 69003", "Lyon 69003");
tidy("empty", "", "");
tidy("null", null, "");
tidy("undefined", undefined, "");
tidy("a postcode alone is not a city", "69007", "");
tidy("digits only", "12", "");
tidy("punctuation only", "—", "");
tidy("too long to be a city", "A".repeat(61), "");
tidy("60 characters are still accepted", "Saint-" + "a".repeat(54), "Saint-" + "a".repeat(54));
tidy("a number is turned to text", 42, "");
tidy("html is kept as text (escaped when displayed)", "<b>Lyon</b>", "<b>Lyon</b>");

// ----- cityFromAddr -----
from("street, postcode city", "12 Cours Lafayette, 69006 Lyon", "Lyon");
from("no comma", "3 place Jean Macé 69007 Lyon", "Lyon");
from("postcode and city only", "69007 Lyon", "Lyon");
from("place name", "Les Pins, 69100 Villeurbanne", "Villeurbanne");
from("title-cased SIRENE address", "9 Rue Des Freres Lumiere 69100 Villeurbanne", "Villeurbanne");
from("capitals, as the technical-inspection data has them", "10 avenue du Test, 69007 LYON", "Lyon");
from("country after the city", "1 rue X, 69003 Lyon, France", "Lyon");
from("cedex", "ZI Les Platanes 69800 Saint-Priest Cedex", "Saint-Priest");
from("arrondissement", "10 RUE X 69003 LYON 3EME", "Lyon 3e");
from("two postcodes: the last one wins", "75008 Paris, 69003 Lyon", "Lyon");
from("BAN label", "12 Rue du Test 69007 Lyon", "Lyon");
from("postcode without a city", "12 rue X 69006", "");
from("postcode without a city, comma after", "12 rue X 69006, France", "");
from("no postcode", "12 rue de la République", "");
from("city only (no postcode): not guessed", "Lyon", "");
from("four-digit number is not a postcode", "12 rue X 6900 Lyon", "");
from("six-digit number is not a postcode", "12 rue X 690012 Lyon", "");
from("postcode glued to the city", "69007Lyon", "");
from("empty", "", "");
from("null", null, "");
from("undefined", undefined, "");

console.log(`${n - bad}/${n} city cases ok`);
process.exit(bad ? 1 : 0);
})();
