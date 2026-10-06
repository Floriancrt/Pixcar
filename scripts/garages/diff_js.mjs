// Calcule avec le module JavaScript de la page ce que scripts/garages/matching.py calcule en Python : test_garages.py compare les deux résultats.
//   node scripts/garages/diff_js.mjs cas.json sortie.json
import fs from "node:fs";
import { fold, hasRealName, meters, pickRec, sameName, tileKey, tileKeysFor } from "../../src/js/modules/garages-table.js";

const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = { same: [], real: cases.names.map((n) => hasRealName(n)), pick: [], dist: [], keys: [], key: [], fold: cases.names.map((n) => fold(n)) };
for (const a of cases.names) out.same.push(cases.names.map((b) => sameName(a, b)));
for (const g of cases.garages) {
  const r = pickRec(g, cases.recs);
  out.pick.push(r ? r.id : null);
}
for (const [a, b] of cases.pairs) out.dist.push(meters(a, b));
for (const [lat, lon, km] of cases.points) out.keys.push(tileKeysFor(lat, lon, km));
for (const [lat, lon] of cases.points) out.key.push(tileKey(lat, lon));
fs.writeFileSync(process.argv[3], JSON.stringify(out));
