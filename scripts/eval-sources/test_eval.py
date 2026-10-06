"""Tests de l'évaluation, sans réseau : python scripts/eval-sources/test_eval.py

Un scénario synthétique dont les réponses sont connues d'avance (douze garages fictifs répartis entre trois sources) vérifie le rapprochement,
la réunion des garages, la liste de la page et la lecture des réponses d'Overpass et de l'API SIRENE. Les numéros utilisés sont fictifs (+33 1 99 …).
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402
import report as R  # noqa: E402
import run as RUN  # noqa: E402
import sources as S  # noqa: E402

OK = 0


def check(cond, label):
    global OK
    if not cond:
        raise AssertionError(label)
    OK += 1


# ------------------------------------------------------------------------------------------------------------------ rapprochement
check(M.same_name("Solsona", "Carosserie Solsona"), "mot distinctif commun")
check(M.same_name("L'ATELIER AUTO-MOBILE", "L’Atelier automobile"), "nom contenu dans l'autre")
check(not M.same_name("Carrosserie Martin", "Carrosserie Dupont"), "mots génériques seuls ne suffisent pas")
check(M.phone_parse("01 99 00 00 01 / 06 99 00 00 02") == ["+33199000001", "+33699000002"], "deux numéros")
check(M.phone_parse("pas un numéro") == [] and M.phone_parse("0123") == [], "numéro invalide ignoré")
check(M.host_of("https://www.Exemple.fr/a?b=1") == "exemple.fr" and M.host_of("exemple.fr/x") == "exemple.fr" and M.host_of("") == "", "domaine")

# Grille : tout élément à moins de 150 m est retrouvé, y compris de l'autre côté d'une limite de case
pts = [{"lat": 43.2 + i * 0.0003, "lon": 1.1 + i * 0.0004, "name": "p%d" % i} for i in range(-12, 13)]
g = M.Grid(pts)
for c in pts:
    want = {p["name"] for p in pts if M.meters(c, p) <= 150}
    got = {p["name"] for p in g.near(c["lat"], c["lon"], 150) if M.meters(c, p) <= 150}
    check(want == got, "la grille retrouve tous les voisins de %s" % c["name"])


# ------------------------------------------------------------------------------------------------------------------ scénario synthétique
def at(i, dlat=0.0, dlon=0.0):
    """Position du garage fictif i : une grille de points distants d'au moins 2 km."""
    return 43.0 + (i // 4) * 0.02 + dlat, 1.0 + (i % 4) * 0.03 + dlon


NAMES = ["Martin", "Dupont", "Solsona", "Pelletier", "Garcia", "Lopez", "Bernard", "Moreau", "Girard", "Faure", "Roux", "Blanc"]


def mk(src, i, name, phone=False, web=False, hours=False, dlat=0.0, dlon=0.0, **extra):
    lat, lon = at(i, dlat, dlon)
    tel = ["01 99 00 00 %02d" % i] if phone else []
    return S.entity(src, "%s%d" % (src, i), name, lat, lon, tel, ["https://garage%d.example.fr" % i] if web else [], "Mo-Fr 08:00-18:00" if hours else "", **extra)


osm = [
    mk("osm", 0, "Garage Martin", phone=True, web=True, hours=True, cls="car_repair", lvl="core"),
    mk("osm", 1, "Dupont Auto", phone=True, cls="car_repair", lvl="core"),
    mk("osm", 2, "Solsona", cls="car_repair", lvl="core"),
    mk("osm", 3, "Pelletier", cls="tyres", lvl="core"),
    mk("osm", 4, "Garage Garcia", phone=True, cls="car_repair", lvl="core"),
    mk("osm", 5, "", dlat=0.00018, cls="car_repair", lvl="core"),  # sans nom, à 20 m de l'établissement SIRENE n° 5
    mk("osm", 6, "Lopez", cls="car_repair", lvl="ext"),
    mk("osm", 8, "Garage Girard", phone=True, hours=True, cls="car_repair", lvl="core"),
]
ovt = [
    mk("ovt", 0, "Martin Garage", phone=True, web=True, cat="automotive_repair", conf=0.9, ds=["meta"], brand=None),
    mk("ovt", 2, "Garage Solsona", phone=True, cat="automotive_repair", conf=0.8, ds=["meta"], brand=None),
    mk("ovt", 3, "Pelletier Pneus", phone=True, cat="tire_dealer_and_repair", conf=0.7, ds=["Foursquare"], brand=None),
    mk("ovt", 6, "Garage Lopez", phone=True, web=True, cat="automotive_repair", conf=0.6, ds=["meta"], brand=None),
    mk("ovt", 7, "Moreau Auto", phone=True, cat="automotive_repair", conf=0.5, ds=["meta"], brand=None),
    mk("ovt", 9, "Faure Carrosserie", phone=True, cat="auto_body_shop", conf=0.9, ds=["meta"], brand=None),
    mk("ovt", 1, "Controle technique Dupont", phone=True, cat="car_inspection", conf=0.9, ds=["meta"], brand=None, dlat=0.0004),
]
sir = [
    mk("sir", 0, "MARTIN", naf="45.20A", ens=False, cp=True),
    mk("sir", 1, "DUPONT", naf="45.20A", ens=False, cp=True),
    mk("sir", 2, "SARL SOLSONA", naf="45.20A", ens=True, cp=True),
    mk("sir", 3, "PELLETIER SAS", naf="45.20A", ens=False, cp=True),
    mk("sir", 4, "GARCIA", naf="45.20A", ens=False, cp=True),
    mk("sir", 5, "ROUX", naf="45.20A", ens=False, cp=True),
    mk("sir", 7, "MOREAU", naf="45.20B", ens=False, cp=True),
    mk("sir", 10, "BLANC", naf="45.20A", ens=False, cp=True),
    mk("sir", 11, "ATELIER DE REPARATION AUTOMOBILE", naf="45.20A", ens=False, cp=True),
    S.entity("sir", "sir-far", "MARTIN", at(0)[0] + 0.05, at(0)[1], [], [], "", naf="45.20A", ens=False, cp=True),  # même nom, 5,5 km plus loin : ne doit pas s'apparier
]
# Attendu (à la main) : garages réunis = 13 (douze fictifs + le distracteur) ; la liste (OSM ou SIRENE) en compte 12 (tous sauf le seul garage d'Overture)
sets = {"osm": osm, "ovt": [x for x in ovt if x["cat"] in S.OVT_CORE], "sir": sir}
check(len(sets["ovt"]) == 6, "le contrôle technique est à part")
ents = R.entities(sets, 150, 40)
by = lambda *s: [e for e in ents if set(e["srcs"]) == set(s)]  # noqa: E731
combos = {tuple(sorted(e["srcs"])): 0 for e in ents}
for e in ents:
    combos[tuple(sorted(e["srcs"]))] += 1
check(combos == {("osm", "ovt", "sir"): 3, ("osm", "sir"): 3, ("osm", "ovt"): 1, ("ovt", "sir"): 1, ("osm",): 1, ("ovt",): 1, ("sir",): 3}, "répartition des garages réunis : %r" % combos)
check(len(ents) == 13, "treize garages réunis (douze + distracteur), obtenu %d" % len(ents))
r = R.pixcar_list(ents)
check(r["n"] == 12, "liste de la page : 12, obtenu %d" % r["n"])
check(r["phone_today"] == 4, "téléphones d'OpenStreetMap dans la liste : 4, obtenu %d" % r["phone_today"])
check(r["phone_ovt"] == 8, "téléphones avec Overture : 8, obtenu %d" % r["phone_ovt"])
check(r["web_today"] == 1 and r["web_ovt"] == 2, "sites : %r" % r)
check(r["orphans"] == 3 and r["ovt_only"] == 1 and r["ovt_only_phone"] == 1, "orphelins SIRENE et ajouts d'Overture : %r" % r)
check(r["hours_today"] == 2, "horaires : 2")
a = R.agreement(sets["osm"], sets["ovt"], 150, 40)
check(a["pairs"] == 4 and a["tel_both"] == 1 and a["tel_same"] == 1, "concordance OSM↔Overture : %r" % a)
check(R.duplicates(sets["sir"], 150, 40) == 0, "pas de doublon dans SIRENE")
dup = sets["ovt"] + [mk("ovt", 0, "Garage Martin", phone=True, cat="automotive_repair", conf=0.4, ds=["Foursquare"], brand=None, dlat=0.0004)]
check(R.duplicates(dup, 150, 40) == 2, "doublon Overture détecté dans les deux sens")
check(R.shared_phones([mk("ovt", 0, "A1", phone=True), mk("ovt", 0, "B2", phone=True), mk("ovt", 0, "C3", phone=True), mk("ovt", 1, "D4", phone=True)]) == 3, "numéro partagé par trois lieux")
# À 300 m les paires décalées se rejoignent
far = [mk("osm", 4, "Garage Garcia", phone=True, dlat=0.002, cls="car_repair", lvl="core")]
check(M.link(far, sets["sir"], 150, 40)[0] is None and M.link(far, sets["sir"], 300, 40)[0] is not None, "tolérance de 300 m")

# Rapprochement par adresse et plafond par proximité
a1 = S.entity("sir", "s-a", "ROUX SARL", 43.5, 1.5, [], [], "", address="5 RUE DE LA PAIX 31000 TOULOUSE", naf="45.20A", ens=False, cp=True)
b1 = S.entity("ovt", "o-a", "Garage du Centre", 43.5005, 1.5, ["01 99 00 00 77"], [], "", address="5 Rue de la Paix", postcode="31000", cat="automotive_repair", conf=0.9, ds=["meta"], brand=None)
c1 = S.entity("ovt", "o-b", "Garage du Marché", 43.5, 1.5005, [], [], "", address="9 Avenue des Pins", cat="automotive_repair", conf=0.9, ds=["meta"], brand=None)
check(M.link([a1], [b1, c1], 150, 40)[0] is None, "sans nom commun, la règle de la page n'apparie pas")
check(M.link_loose([a1], [b1, c1], 150, 40)[0] is b1, "même numéro dans la même voie : apparié")
check(M.link_loose([a1], [c1], 150, 40)[0] is None, "adresse différente : pas apparié")
check(M.nearest_within([a1], [b1, c1], 100) == [2] and M.nearest_within([a1], [b1, c1], 40) == [0], "garages à moins de r mètres, sans condition de nom")
check(M.nearest_within([a1], [b1, c1], 100) == [2], "proximité")
yl = "\n".join(R.yield_lines(sets, 150, 40))
check("OpenStreetMap sans téléphone : 4 ; 3 (75 %) trouvent un téléphone dans Overture" in yl, "apport d'Overture aux fiches OSM sans téléphone : %s" % yl.splitlines()[0])
bands = R.agreement_bands(sets["osm"], sets["ovt"], 150, 40, lambda q: "meta" if "meta" in q["ds"] else "autre")
check(bands == {"meta": [1, 1]}, "concordance par origine : %r" % bands)
sk = R.site_kinds([S.entity("x", "1", "a", 0, 0, [], ["https://www.facebook.com/p"], ""), S.entity("x", "2", "b", 0, 0, [], ["https://garage.example.fr"], ""), S.entity("x", "3", "c", 0, 0, [], ["https://www.pagesjaunes.fr/x"], ""), S.entity("x", "4", "d", 0, 0, [], [], "")])
check(sk == {"réseau social": 1, "domaine propre": 1, "annuaire": 1}, "nature des sites : %r" % sk)
prof = "\n".join(R.overture_only_profile(ents))
check("1 lieux Overture sans équivalent ailleurs : téléphone 1 (100 %)" in prof, "profil des garages d'Overture seul : %s" % prof)
ct = "\n".join(R.sirene_class_table([dict(x, nj="1000" if i < 4 else "5710", emp="N" if i < 4 else "O") for i, x in enumerate(sir)], osm, sets["ovt"], 150, 40))
check("| entrepreneur individuel (nature 1000) | 4 |" in ct and "| employeur | 6 |" in ct, "classes SIRENE : %s" % ct)
pt = "\n".join(R.proximity_table(sets))
check("SIRENE (10)" in pt and "25 m" in pt, "tableau de proximité")

# ------------------------------------------------------------------------------------------------------------------ OpenStreetMap
els = [
    {"type": "node", "id": 1, "lat": 43.2, "lon": 1.1, "tags": {"shop": "car_repair", "name": "Garage Un", "phone": "01 99 00 00 01; 06 99 00 00 02", "website": "https://un.example.fr", "opening_hours": "Mo-Fr 08:00-18:00"}},
    {"type": "way", "id": 2, "center": {"lat": 43.21, "lon": 1.11}, "tags": {"craft": "car_repair", "brand": "Deux Auto", "contact:phone": "+33 1 99 00 00 03"}},
    {"type": "node", "id": 3, "lat": 43.22, "lon": 1.12, "tags": {"shop": "tyres"}},
    {"type": "node", "id": 4, "lat": 43.23, "lon": 1.13, "tags": {"shop": "car_parts", "name": "Garage Quatre Pièces"}},
    {"type": "node", "id": 5, "lat": 43.24, "lon": 1.14, "tags": {"shop": "car_parts", "name": "Pièces Auto"}},
    {"type": "node", "id": 6, "lat": 43.25, "lon": 1.15, "tags": {"shop": "car", "name": "Concession", "service:vehicle:repairs": "yes"}},
    {"type": "node", "id": 7, "lat": 43.26, "lon": 1.16, "tags": {"shop": "car", "name": "Concession Simple"}},
    {"type": "node", "id": 8, "lat": 43.27, "lon": 1.17, "tags": {"shop": "car", "name": "Norauto Concession"}},
    {"type": "node", "id": 9, "lat": 43.28, "lon": 1.18, "tags": {"shop": "car_parts", "name": "Pneu Express"}},
    {"type": "way", "id": 10, "tags": {"shop": "car_repair"}},  # sans position : ignoré
]
oe, rej = S.osm_entities(els)
check(len(oe) == 7 and rej == 2, "classement OSM : 7 retenus, 2 rejetés, obtenu %d/%d" % (len(oe), rej))
byid = {x["id"]: x for x in oe}
check(byid["node/1"]["phone"] and byid["node/1"]["web"] and byid["node/1"]["hours"] and len(byid["node/1"]["tels"]) == 2, "balises phone, website, opening_hours")
check(byid["way/2"]["phone"] and byid["way/2"]["name"] == "Deux Auto" and byid["way/2"]["lvl"] == "core", "chemin avec centre et téléphone de contact")
check(byid["node/3"]["name"] == "" and byid["node/3"]["cls"] == "tyres", "garage de pneus sans nom")
check(byid["node/4"]["lvl"] == "ext" and byid["node/6"]["lvl"] == "ext" and byid["node/8"]["lvl"] == "ext" and byid["node/9"]["cls"] == "tyres", "extensions : nom, prestations, réseau, pneus")
check("node/5" not in byid and "node/7" not in byid, "pièces seules et concession sans atelier écartées")

# Extrait régional lu avec pyosmium (petit fichier .osm)
xml = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test">
 <node id="1" version="1" lat="43.2" lon="1.1"><tag k="shop" v="car_repair"/><tag k="name" v="Garage Un"/><tag k="phone" v="01 99 00 00 01"/></node>
 <node id="2" version="1" lat="43.3" lon="1.2"/><node id="3" version="1" lat="43.3002" lon="1.2"/><node id="4" version="1" lat="43.3002" lon="1.2002"/><node id="5" version="1" lat="43.3" lon="1.2002"/>
 <node id="6" version="1" lat="43.4" lon="1.3"><tag k="shop" v="bakery"/></node>
 <node id="7" version="1" lat="48.0" lon="2.0"><tag k="shop" v="car_repair"/><tag k="name" v="Hors zone"/></node>
 <way id="10" version="1"><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/><tag k="craft" v="car_repair"/><tag k="name" v="Atelier Chemin"/></way>
</osm>
"""
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "t.osm")
    open(p, "w", encoding="utf-8").write(xml)
    pe, how = S.osm_pbf((1.0, 43.0, 2.0, 44.0), log=lambda m: None, path=p)
pids = sorted(("%s/%s" % (e["type"], e["id"])) for e in pe)
check(pids == ["node/1", "way/10"], "extrait : %r" % pids)
check(abs([e for e in pe if e["type"] == "way"][0]["lat"] - 43.3001) < 1e-4, "centre d'un chemin")

# ------------------------------------------------------------------------------------------------------------------ SIRENE
e = {
    "nom_complet": "GARAGE MARTIN", "nom_raison_sociale": "GARAGE MARTIN", "sigle": None, "activite_principale": "45.20A", "nature_juridique": "1000", "caractere_employeur": "N",
    "matching_etablissements": [
        {"siret": "11111111100011", "latitude": "43.2", "longitude": "1.1", "etat_administratif": "A", "activite_principale": "45.20A", "adresse": "1 RUE X 31220 CAZERES", "liste_enseignes": ["MARTIN AUTO"], "nom_commercial": None},
        {"siret": "11111111100011", "latitude": "43.2", "longitude": "1.1", "etat_administratif": "A", "activite_principale": "45.20A", "adresse": "1 RUE X 31220 CAZERES"},  # doublon
        {"siret": "11111111100029", "latitude": None, "longitude": None, "etat_administratif": "A", "activite_principale": "45.20A"},
        {"siret": "11111111100037", "latitude": "43.2", "longitude": "1.1", "etat_administratif": "F", "activite_principale": "45.20A"},
        {"siret": "11111111100045", "latitude": "43.21", "longitude": "1.11", "etat_administratif": "A", "activite_principale": "45.11Z"},
        {"siret": "11111111100052", "latitude": "43.22", "longitude": "1.12", "etat_administratif": "A", "activite_principale": "45.32Z", "liste_enseignes": ["NORAUTO"]},
        {"siret": "11111111100060", "latitude": "43.23", "longitude": "1.13", "etat_administratif": "A", "activite_principale": "45.32Z", "liste_enseignes": ["BRICO"]},
        {"siret": "11111111100078", "latitude": "43.24", "longitude": "1.14", "etat_administratif": "A", "adresse": "2 RUE Y 09100 PAMIERS"},  # NAF de l'entreprise (45.20A)
    ],
}
out, st = {}, {"inactifs": 0, "sans_position": 0, "ecartes": 0, "naf": {}}
S.sirene_add(e, out, st)
check(sorted(out) == ["11111111100011", "11111111100052", "11111111100078"], "établissements retenus : %r" % sorted(out))
check(st["inactifs"] == 1 and st["sans_position"] == 1 and st["ecartes"] == 2, "décomptes SIRENE : %r" % st)
check(out["11111111100011"]["name"] == "MARTIN AUTO" and out["11111111100011"]["ens"] and out["11111111100011"]["cp"], "enseigne et code postal")
check(out["11111111100078"]["name"] == "GARAGE MARTIN" and not out["11111111100078"]["cp"], "nom de l'entreprise, hors département")
check(not out["11111111100011"]["phone"] and not out["11111111100011"]["web"], "SIRENE ne donne ni téléphone ni site")
check(out["11111111100011"]["nj"] == "1000" and out["11111111100011"]["emp"] == "N", "forme juridique et employeur")

# ------------------------------------------------------------------------------------------------------------------ rapport complet
lines = RUN.build(osm, ovt, sir, {"name": "Test", "release": "release/test", "osm_how": "essai", "sirene_mode": "essai", "osm_rejected": 0, "sir_discarded": 0, "sir_inactive": 0, "sir_nopos": 0})
text = "\n".join(lines)
for needle in ("Profil des garages que seul Overture connaît", "Selon leur nature", "## 1.", "## 2. Recouvrement (150 m", "## 2. Recouvrement (300 m", "## 2b. Plafond", "## 2c. Garages réunis, nom ou adresse", "Ce que chaque source apporte", "## 3. Garages réunis (150 m)", "## 4. Par zone", "## 5. Qualité", "## 6. Disque de 10 km autour de Cazères", "Total"):
    check(needle in text, "le rapport contient « %s »" % needle)
check("01 99" not in text and "garage0.example" not in text and "+33" not in text, "le rapport ne contient ni numéro ni adresse web")
print("\n".join(lines[:60]))
print("\n%d contrôles passés." % OK)
