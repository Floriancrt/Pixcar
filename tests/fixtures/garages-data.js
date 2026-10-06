// Données d'essai de la table de garages, partagées par tests/garages.js (page, tuiles simulées) et tests/garages-build.js (site construit, vraies
// tuiles sur disque) : cinq garages d'OpenStreetMap, dix lieux de la table dans cinq cases, autour de la même adresse (Lyon).
const { CENTER } = require("../mocks");

// OpenStreetMap : cinq garages au nord du point de recherche.
const ADDR = { "addr:housenumber": "4", "addr:street": "rue Test", "addr:postcode": "69002", "addr:city": "Lyon" };
const osm = (n, name, dLat, dLon, tags = {}) => ({ type: "node", id: 9300 + n, lat: CENTER.lat + dLat, lon: CENTER.lon + dLon, tags: { name, shop: "car_repair", ...tags } });
const OSM = [
  osm(1, "Garage Martin", 0.004, 0),                                                                                                  // ni téléphone, ni site, ni adresse
  osm(2, "Auto Plus Lyon", 0.008, 0, { phone: "+33 4 72 11 22 33", website: "https://autoplus-lyon.example", ...ADDR }),              // complet : rien à compléter
  osm(3, "Garage Dubois", 0.012, 0, { website: "https://dubois.example", ...ADDR }),                                                  // il ne manque que le téléphone
  osm(4, "Atelier 69", 0.016, 0, { phone: "+33 4 72 00 00 04", ...ADDR }),                                                            // un lieu de la table, d'un autre nom, est à 27 m
  osm(5, "Garage du Parc", 0.02, 0, { phone: "+33 4 72 00 00 05", website: "https://garage-du-parc.example", ...ADDR }),            // absent de la table
];
const oid = (n) => `osm:node/${9300 + n}`;

// La table : dix lieux (identifiants Overture : des UUID).
const uid = (n) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ovtId = (n) => "custom:ovt-" + uid(n).replace(/-/g, "");
const rec = (n, name, dLat, dLon, o = {}) => ({ id: uid(n), name, lat: +(CENTER.lat + dLat).toFixed(6), lon: +(CENTER.lon + dLon).toFixed(6), kind: "r", phones: [], web: "", addr: "", pc: "", loc: "", brand: "", conf: 0.9, src: "mf", ...o });
const R = {
  martin: rec(1, "Garage Martin", 0.0041, 0.0001, { phones: ["+33561000001"], web: "https://garage-martin.example/", addr: "12 rue de la Paix", pc: "69002", loc: "Lyon" }),
  plus: rec(2, "AUTO PLUS LYON", 0.0082, 0.0002, { phones: ["+33478998877"], web: "https://autoplus.example/", addr: "8 rue Auto", pc: "69002", loc: "Lyon" }),
  dubois: rec(3, "Garage Dubois SARL", 0.0122, 0.0001, { phones: ["+33478555555"], addr: "9 rue Dubois", pc: "69002", loc: "Lyon" }),
  atelier: rec(4, "Mécanique Express", 0.0162, 0.0002, { phones: ["+33478444444"] }),
  soleil: rec(5, "Carrosserie du Soleil", -0.006, 0.004, { kind: "b", phones: ["+33472000005"], web: "https://carrosserie-soleil.example/", addr: "3 rue du Soleil", pc: "69003", loc: "Lyon" }),
  loin: rec(6, "Garage Lointain", 0.3, 0, { phones: ["+33472000006"] }),                                                                // à 33 km : une autre case, hors du rayon
  sud: rec(7, "Auto Service Sud", -0.021, 0, { phones: ["+33472000007"], pc: "69003", loc: "Lyon" }),                                    // sans adresse de rue
  ouest: rec(8, "Garage de l'Ouest", 0, -0.1157, { phones: ["+33472000008"], web: "https://garage-ouest.example/", addr: "1 route de l'Ouest", pc: "69130", loc: "Écully" }),
  sudouest: rec(9, "Auto Sud-Ouest", -0.03, -0.1, { phones: ["+33472000009"], addr: "2 rue du Sud-Ouest", pc: "69230", loc: "Saint-Genis-Laval" }),
  eloigne: rec(10, "Garage Éloigné Nord", 0.186, 0, { phones: ["+33472000010"] }),                                                      // dans la case voulue, mais à 20,7 km : hors du rayon
};
const TILES = { "183-59": [R.martin, R.plus, R.dubois, R.atelier, R.soleil, R.eloigne], "182-59": [R.sud], "183-58": [R.ouest], "182-58": [R.sudouest], "184-59": [R.loin] };
const FOUR = ["182-58", "182-59", "183-58", "183-59"]; // les cases qu'un rayon de 10 km autour de Lyon rencontre
const dayStr = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10);

// L'index d'un jeu de tuiles (même forme que celui de scripts/garages/build.py)
const indexOf = ({ built = dayStr(20), tiles = TILES, extra = {} } = {}) => {
  const counts = {};
  for (const [k, v] of Object.entries(tiles)) counts[k] = v.length;
  Object.assign(counts, extra);
  return { v: 1, built, source: "Overture Maps (essai)", step: 0.25, x0: -10, closure: "sirene", count: Object.values(counts).reduce((a, b) => a + b, 0), tiles: counts };
};

module.exports = { CENTER, ADDR, OSM, oid, uid, ovtId, rec, R, TILES, FOUR, dayStr, indexOf };
