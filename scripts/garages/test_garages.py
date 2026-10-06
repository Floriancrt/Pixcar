"""Tests de la construction de la table de garages, sans réseau : python scripts/garages/test_garages.py

Les lieux, noms et numéros ci-dessous sont fictifs (numéros en +33 1 99 …). Les réponses d'Overture et du registre sont simulées au niveau de leurs
fonctions de lecture ; le reste de la chaîne (mise en forme, doublons, fermés, écriture, contrôle) tourne pour de bon.
"""
import json
import math
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as B  # noqa: E402
import matching as M  # noqa: E402
import overture as O  # noqa: E402
import sirene as S  # noqa: E402
import tiles as T  # noqa: E402

OK = 0


def check(cond, label):
    global OK
    if not cond:
        raise AssertionError(label)
    OK += 1


def row(i, name, lat, lon, cat="automotive_repair", phones=None, websites=None, street="12 Rue de la Gare", pc="31220", loc="Cazères", brand=None, conf=0.8, ds=("meta",), country="FR"):
    """Une ligne telle que la rend la lecture d'Overture (« _lat » et « _lon » posés)."""
    return {
        "id": "%08x-0000-4000-8000-%012x" % (i, i), "names": {"primary": name}, "taxonomy": {"primary": cat, "hierarchy": ["vehicle_service", "automotive_service", cat]},
        "confidence": conf, "phones": phones, "websites": websites, "addresses": [{"freeform": street, "postcode": pc, "locality": loc, "region": "OCC", "country": country}],
        "sources": [{"dataset": "Overture"}] + [{"dataset": d} for d in ds], "bbox": {"xmin": lon, "xmax": lon, "ymin": lat, "ymax": lat},
        "brand": {"names": {"primary": brand}} if brand else None, "_lat": lat, "_lon": lon,
    }


# ------------------------------------------------------------------------------------------------------------------ cases
check(T.tile_key(43.2174, 1.1014) == "172-44", "case de Cazères : %s" % T.tile_key(43.2174, 1.1014))
check(T.tile_key(0.0, -10.0) == "0-0" and T.tile_key(-0.01, -10.01) == "-1--1", "origine et valeurs négatives")
keys = T.tile_keys_for(43.2174, 1.1014, 10)
check(keys == ["172-44", "172-45", "173-44", "173-45"] or len(keys) in (2, 4), "cases d'un rayon de 10 km : %r" % keys)
for dlat, dlon in ((0, 0), (0.07, 0.08), (-0.08, 0.09), (0.0899, -0.1234)):  # tout point à ≤ 10 km est dans une case demandée
    p = {"lat": 43.2174 + dlat, "lon": 1.1014 + dlon}
    if M.meters({"lat": 43.2174, "lon": 1.1014}, p) <= 10000:
        check(T.tile_key(p["lat"], p["lon"]) in keys, "le point %r est dans une case demandée" % p)
check(len(T.tile_keys_for(45.0, 2.0, 50)) > len(T.tile_keys_for(45.0, 2.0, 10)) >= 1, "plus le rayon grandit, plus il y a de cases")

# ------------------------------------------------------------------------------------------------------------------ nettoyage
check(T.clean_text("  Garage ​ Dupont \n\t& Fils  ", 50) == "Garage Dupont & Fils", "espaces et caractères invisibles")
check(len(T.clean_text("x" * 500, 120)) == 120, "longueur bornée")
check(T.clean_site("https://www.garage-dupont.fr/contact?utm_source=fb&id=3&fbclid=zz") == "https://www.garage-dupont.fr/contact?id=3", "paramètres de suivi retirés")
check(T.clean_site("garage-dupont.fr") == "https://garage-dupont.fr", "schéma ajouté")
check(T.clean_site("https://www.pagesjaunes.fr/pros/123") == "" and T.clean_site("https://fr.frmap.org/x") == "", "annuaires écartés")
check(T.clean_site("javascript:alert(1)") == "" and T.clean_site("ftp://x.example.fr") == "" and T.clean_site("https://user:pw@x.example.fr/") == "", "schémas et identifiants refusés")
check(T.clean_site("https://localhost/") == "" and T.clean_site("") == "" and T.clean_site("https://" + "a" * 300 + ".fr") == "", "adresses inutilisables")
check(T.clean_site("https://x.example.fr/" + "p" * 220) == "" and T.clean_site("https://x.example.fr/" + "p" * 150).endswith("p" * 150), "une adresse de plus de 200 caractères est refusée (la page n'en lit pas davantage), une de 170 est gardée")

# ------------------------------------------------------------------------------------------------------------------ numéros
check(M.phone_parse("05 61 97 65 45 ; +33561976545") == ["+33561976545"], "même numéro écrit de deux façons : une fois")
check(M.phone_parse("0561976545") == ["+33561976545"] and M.phone_parse("00 33 5 61 97 65 45") == ["+33561976545"] and M.phone_parse("+33 (0)5 61 97 65 45") == ["+33561976545"], "formes françaises reconnues")
check(M.phone_parse("+33 5 61 97 65") == [] and M.phone_parse("+33 5 61 97 65 45 6") == [] and M.phone_parse("01 23") == [] and M.phone_parse("0461976545 12") == [], "numéro français de la mauvaise longueur : ignoré")
check(M.phone_parse("+44 20 7946 0958") == ["+442079460958"] and M.phone_parse("+44 12") == [] and M.phone_parse("+" + "1" * 16) == [], "numéro étranger : gardé s'il est plausible, ignoré trop court ou trop long")
check(M.phone_parse(["0561976545", None, "", "05 61 97 65 46"]) == ["+33561976545", "+33561976546"] and M.phone_parse(None) == [], "liste et valeurs absentes")

# ------------------------------------------------------------------------------------------------------------------ enregistrement
r1 = row(1, "  GARAGE   DUPONT ", 43.21741234, 1.10146789, phones=["05 61 97 65 45", "+33 6 12 34 56 78", "0199000001"], websites=["https://www.annuaire.pagesjaunes.fr/x", "https://www.garage-dupont.fr/?utm_medium=x"],
         brand="Dupont Auto", conf=0.876, ds=("meta", "Foursquare"))
rec = T.build_record(r1, O.KINDS)
check(rec["name"] == "GARAGE DUPONT" and rec["lat"] == 43.21741 and rec["lon"] == 1.10147 and rec["kind"] == "r", "nom, position (5 décimales) et type : %r" % rec)
check(rec["phones"] == ["+33561976545", "+33612345678"], "deux numéros au plus, au format international : %r" % rec.get("phones"))
check(rec["web"] == "https://www.garage-dupont.fr/" and rec["addr"] == "12 Rue de la Gare" and rec["pc"] == "31220" and rec["loc"] == "Cazères", "site, adresse")
check(rec["brand"] == "Dupont Auto" and rec["conf"] == 0.88 and rec["src"] == "fm", "enseigne, confiance, origines : %r" % rec)
check(T.build_record(row(2, "", 43.2, 1.1), O.KINDS) is None and T.build_record(row(3, "1234", 43.2, 1.1), O.KINDS) is None, "nom vide ou sans lettre : écarté")
check(T.build_record(row(4, "Garage X", 43.2, 1.1, cat="car_wash"), O.KINDS) is None, "catégorie non retenue : écartée")
check(T.build_record(row(66, "A", 43.2, 1.1), O.KINDS) is None, "nom d'une seule lettre : écarté")
check("pc" not in T.build_record(row(61, "Garage Pc", 43.2, 1.1, pc="3122"), O.KINDS) and "pc" not in T.build_record(row(62, "Garage Pc", 43.2, 1.1, pc="311220"), O.KINDS) and T.build_record(row(63, "Garage Pc", 43.2, 1.1, pc="31 220"), O.KINDS)["pc"] == "31220", "code postal : cinq chiffres ou rien")
check(T.build_record(dict(row(64, "Garage N", 43.2, 1.1), _lat=float("nan")), O.KINDS) is None and T.build_record(dict(row(65, "Garage N", 43.2, 1.1), _lon=float("inf")), O.KINDS) is None, "position qui n'est pas un nombre fini : écartée")
check(T.build_record(dict(row(5, "Garage Y", 43.2, 1.1), _lat=None), O.KINDS) is None, "position absente : écartée")
minimal = T.build_record(row(6, "Pneus Express", 43.3, 1.2, cat="tire_dealer_and_repair", phones=None, websites=None, street="", pc="", loc=""), O.KINDS)
check(minimal == {"id": row(6, "x", 0, 0)["id"], "name": "Pneus Express", "lat": 43.3, "lon": 1.2, "kind": "t", "conf": 0.8, "src": "m"}, "champs vides omis : %r" % minimal)
check({T.build_record(row(7, "A garage", 43.2, 1.1, cat=c), O.KINDS)["kind"] for c in O.KINDS} == set("rtbv"), "les quatre types")
check(T.build_record(row(8, "Garage Z", 43.2, 1.1, phones=["pas un numéro", "01 23"]), O.KINDS).get("phones") is None, "numéros invalides ignorés, jamais devinés")

# ------------------------------------------------------------------------------------------------------------------ doublons
a = dict(T.build_record(row(10, "Garage Martin", 43.2000, 1.1000, phones=["0199000010"], conf=0.6), O.KINDS))
b = dict(T.build_record(row(11, "Martin Automobiles", 43.2005, 1.1004, phones=["0199000011"], websites=["https://martin-auto.fr"], conf=0.9, ds=("Foursquare",)), O.KINDS))
c = dict(T.build_record(row(12, "Carrosserie Pelletier", 43.2005, 1.1004), O.KINDS))
d = dict(T.build_record(row(13, "Garage Martin", 43.5000, 1.5000, phones=["0199000013"]), O.KINDS))  # même nom, 40 km plus loin
out, absorbed, big = T.merge_duplicates([a, b, c, d])
check(len(out) == 3 and absorbed == 1 and big == 0, "deux fiches du même garage réunies, les autres intactes : %d/%d" % (len(out), absorbed))
m = next(r for r in out if r["name"] in ("Garage Martin", "Martin Automobiles") and r["lat"] < 43.4)
check(m["id"] == b["id"] and m["phones"] == ["+33199000011", "+33199000010"] and m["web"] == "https://martin-auto.fr" and "f" in m["src"] and "m" in m["src"], "la fiche la plus complète garde la main, numéros réunis : %r" % m)
e1 = dict(T.build_record(row(70, "Garage Roux", 43.2000, 1.1000, phones=["0199000070"], conf=0.9), O.KINDS))
e2 = dict(T.build_record(row(71, "Roux Automobiles", 43.2003, 1.1002, websites=["https://roux-auto.example.fr"], brand="Roux", conf=0.5), O.KINDS))
mm, _, _ = T.merge_duplicates([e1, e2])
check(len(mm) == 1 and mm[0]["id"] == e1["id"] and mm[0].get("web") == "https://roux-auto.example.fr" and mm[0].get("brand") == "Roux", "la fiche gardée reprend le site et l'enseigne que l'autre avait seule : %r" % mm)
five = [dict(T.build_record(row(20 + i, "Garage Durand", 43.2 + i * 0.0001, 1.1), O.KINDS)) for i in range(5)]
out5, ab5, big5 = T.merge_duplicates(five)
check(len(out5) == 5 and ab5 == 0 and big5 == 1, "un amas de plus de trois lieux n'est pas réuni : %d/%d/%d" % (len(out5), ab5, big5))

# ------------------------------------------------------------------------------------------------------------------ grille
def at(north_m, east_m, base=(43.2174, 1.1014)):
    return {"lat": base[0] + north_m / 111320, "lon": base[1] + east_m / (111320 * math.cos(math.radians(base[0])))}


pts = [dict(name="p%d" % i, **at(i * 30, i * 41)) for i in range(-12, 13)]
grid = M.Grid(pts)
for c0 in pts:
    want = sorted(p["name"] for p in pts if M.meters(c0, p) <= M.NEAR_M)
    got = sorted(p["name"] for p in grid.near(c0["lat"], c0["lon"]) if M.meters(c0, p) <= M.NEAR_M)
    check(got == want, "l'index en cases rend tous les voisins, d'une case à l'autre : %s %r %r" % (c0["name"], got, want))

# ------------------------------------------------------------------------------------------------------------------ lignes d'Overture
fr = {"taxonomy": {"primary": "automotive_repair"}, "addresses": [{"country": "FR"}]}
check(O.keep_place(fr) and O.keep_place(dict(fr, addresses=[])) and O.keep_place(dict(fr, addresses=None)) and O.keep_place(dict(fr, addresses=[{"country": None}])), "lieu de garage français, ou sans pays : gardé")
check(not O.keep_place(dict(fr, addresses=[{"country": "ES"}])) and not O.keep_place(dict(fr, taxonomy={"primary": "car_wash"})) and not O.keep_place({"addresses": [{"country": "FR"}]}), "autre pays ou autre catégorie : écarté")
check(O.keep_place(dict(fr, addresses=[{"country": "ES"}]), country=None), "country=None : tout pays")
# lecture d'une zone, sans réseau : les fichiers et les groupes de lignes sont simulés, le tri des lignes (zone, catégorie, pays) tourne pour de bon
from shapely.geometry import box  # noqa: E402

rows_in = [row(80, "Garage Dans", 43.2, 1.1), row(81, "Garage Hors", 44.2, 2.1), row(82, "Garage Espagnol", 43.21, 1.11, country="ES"), row(83, "Lavage", 43.22, 1.12, cat="car_wash")]
saved_io = (O.open_fs, O.theme_files, O.row_group_hits, O.read_groups)
O.open_fs = lambda: None
O.theme_files = lambda release, theme, typ: ["places/part-1.parquet"]
O.row_group_hits = lambda fs, k, bbox: [0]
O.read_groups = lambda fs, k, hits, columns: [dict(r) for r in rows_in]
try:
    got, scanned = O.read_places(box(0.9, 43.0, 1.3, 43.4), "release/essai", log=lambda *a: None)
finally:
    O.open_fs, O.theme_files, O.row_group_hits, O.read_groups = saved_io
check([r["names"]["primary"] for r in got] == ["Garage Dans"] and scanned == 4 and (got[0]["_lat"], got[0]["_lon"]) == (43.2, 1.1), "lecture d'une zone : seul le garage français de la zone est gardé : %r" % [r["names"]["primary"] for r in got])

# ------------------------------------------------------------------------------------------------------------------ fermés
recs = [dict(T.build_record(row(30 + i, nm, 43.20 + i * 0.01, 1.10), O.KINDS)) for i, nm in enumerate(["Garage Fermé", "Garage Ouvert", "Garage Renommé", "Garage Inconnu"])]
closed = [{"name": "FERMÉ SARL GARAGE FERME", "lat": recs[0]["lat"], "lon": recs[0]["lon"]}, {"name": "Garage Ouvert", "lat": recs[1]["lat"], "lon": recs[1]["lon"]}, {"name": "Garage Renommé", "lat": recs[2]["lat"], "lon": recs[2]["lon"]}]
active = [{"name": "Garage Ouvert", "lat": recs[1]["lat"], "lon": recs[1]["lon"]}, {"name": "RENOMME", "lat": recs[2]["lat"], "lon": recs[2]["lon"]}]
kept, dropped = T.drop_closed(recs, closed, active)
check([r["name"] for r in dropped] == ["Garage Fermé"], "seul le lieu rapproché d'un établissement fermé sans actif est retiré : %r" % [r["name"] for r in dropped])
check([r["name"] for r in kept] == ["Garage Ouvert", "Garage Renommé", "Garage Inconnu"], "les autres restent")
check(T.drop_closed(recs, [], active) == (recs, []), "sans registre, rien n'est retiré")

# ------------------------------------------------------------------------------------------------------------------ écriture et contrôle
tmp = tempfile.mkdtemp(prefix="garages-test-")
try:
    allrecs = [dict(T.build_record(row(40 + i, "Garage Test %s" % "ABCDEFGHIJ"[i], 43.10 + i * 0.07, 1.00 + i * 0.09, phones=["0199000%03d" % i] if i % 2 else None), O.KINDS)) for i in range(10)]
    meta = {"built": "2026-10-06", "source": "essai", "closure": "sirene", "closure_missing": []}
    st = T.write_tiles(allrecs, tmp, meta)
    check(st["tiles"] >= 2 and st["bytes"] > 0 and st["gz"] < st["bytes"], "cases écrites : %r" % {k: v for k, v in st.items() if k != "sizes"})
    check(T.validate_dir(tmp) == [], "sortie conforme : %r" % T.validate_dir(tmp))
    index = json.load(open(os.path.join(tmp, "index.json"), encoding="utf-8"))
    check(index["count"] == 10 and sum(index["tiles"].values()) == 10 and index["step"] == 0.25 and index["x0"] == -10.0 and "closure_missing" not in index, "index : %r" % index)
    first = {f: open(os.path.join(tmp, "t", f), "rb").read() for f in os.listdir(os.path.join(tmp, "t"))}
    first["index"] = open(os.path.join(tmp, "index.json"), "rb").read()
    T.write_tiles(list(reversed(allrecs)), tmp, meta)  # l'ordre d'entrée ne change rien
    again = {f: open(os.path.join(tmp, "t", f), "rb").read() for f in os.listdir(os.path.join(tmp, "t"))}
    again["index"] = open(os.path.join(tmp, "index.json"), "rb").read()
    check(first == again, "deux constructions des mêmes données donnent les mêmes octets")
    T.write_tiles(allrecs[:3], tmp, meta)
    check(len(os.listdir(os.path.join(tmp, "t"))) == len(json.load(open(os.path.join(tmp, "index.json")))["tiles"]), "les anciennes cases sont supprimées")
    T.write_tiles(allrecs, tmp, dict(meta, closure="partial", closure_missing=["13", "06"]))
    check(json.load(open(os.path.join(tmp, "index.json")))["closure_missing"] == ["06", "13"], "départements sans registre notés dans l'index")
    check(any("minimum" in p for p in T.validate_dir(tmp, min_entries=50)), "minimum de garages contrôlé")
    # sorties abîmées : chacune doit être vue
    t0 = sorted(os.listdir(os.path.join(tmp, "t")))[0]
    p0 = os.path.join(tmp, "t", t0)
    good = open(p0, "rb").read()
    def broken(mutate, needle):
        data = json.loads(good)
        mutate(data)
        open(p0, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False))
        probs = T.validate_dir(tmp)
        open(p0, "wb").write(good)
        check(any(needle in p for p in probs), "défaut vu (%s) : %r" % (needle, probs))
    broken(lambda d: d["g"][0].update(phones=["0561976545"]), "format international")
    broken(lambda d: d["g"][0].update(lat=10.0), "hors de sa case")
    broken(lambda d: d["g"][0].update(kind="z"), "type inconnu")
    broken(lambda d: d["g"][0].update(secret="x"), "champs inconnus")
    broken(lambda d: d["g"][0].update(web="javascript:alert(1)"), "site inattendu")
    broken(lambda d: d["g"].append(dict(d["g"][0])), "en double")
    broken(lambda d: d["g"].pop(), "l'index en annonce")
    ipath = os.path.join(tmp, "index.json")
    igood = open(ipath, "rb").read()

    def broken_index(mutate, needle):
        data = json.loads(igood)
        mutate(data)
        open(ipath, "w", encoding="utf-8").write(json.dumps(data))
        probs = T.validate_dir(tmp)
        open(ipath, "wb").write(igood)
        check(any(needle in p for p in probs), "défaut d'index vu (%s) : %r" % (needle, probs))

    broken_index(lambda d: d.update(step=0.5), "pas ou origine")
    broken_index(lambda d: d.update(x0=0), "pas ou origine")
    broken_index(lambda d: d.update(count=d["count"] + 1), "dans les cases, l'index en annonce")
    broken_index(lambda d: d["tiles"].update({t0[:-5]: d["tiles"][t0[:-5]] + 1}), "l'index en annonce")
    broken_index(lambda d: d.update(closure="peut-être"), "closure")
    broken_index(lambda d: d.update(v=2), "version inconnue")
    broken_index(lambda d: d.pop("built"), "« built » manque")
    heavy = T.MAX_TILE_BYTES
    T.MAX_TILE_BYTES = 50
    try:
        check(any("au-delà de" in p for p in T.validate_dir(tmp)), "case trop lourde vue")
    finally:
        T.MAX_TILE_BYTES = heavy
    check(T.validate_dir(tmp) == [], "après réparation, la sortie est de nouveau conforme")
    os.remove(os.path.join(tmp, "index.json"))
    check(any("index.json illisible" in p for p in T.validate_dir(tmp)), "index absent vu")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ------------------------------------------------------------------------------------------------------------------ registre
page = {
    "total_results": 3, "total_pages": 1,
    "results": [{
        "nom_complet": "GARAGE MARTIN SARL", "activite_principale": "45.20A",
        "matching_etablissements": [
            {"siret": "11111111100011", "latitude": "43.2", "longitude": "1.1", "etat_administratif": "A", "activite_principale": "45.20A", "liste_enseignes": ["MARTIN AUTO"]},
            {"siret": "11111111100029", "latitude": "43.3", "longitude": "1.2", "etat_administratif": "F", "activite_principale": "45.20A"},
            {"siret": "11111111100037", "latitude": None, "longitude": None, "etat_administratif": "A", "activite_principale": "45.20A"},
            {"siret": "11111111100045", "latitude": "43.4", "longitude": "1.3", "etat_administratif": "A", "activite_principale": "47.11F"},
            {"siret": "11111111100011", "latitude": "43.2", "longitude": "1.1", "etat_administratif": "A", "activite_principale": "45.20A"},
        ],
    }],
}
act, clo, stt = {}, {}, {"sans_position": 0}
S.parse_page(page, act, clo, stt)
check(sorted(act) == ["11111111100011"] and act["11111111100011"]["name"] == "MARTIN AUTO", "établissement actif lu : %r" % act)
check(sorted(clo) == ["11111111100029"] and clo["11111111100029"]["name"] == "GARAGE MARTIN SARL", "établissement fermé lu à part")
check(stt["sans_position"] == 1, "sans position : compté, pas retenu")
check(S.DEPTS_METRO[0] == "01" and "2A" in S.DEPTS_METRO and "20" not in S.DEPTS_METRO and len(S.DEPTS_METRO) == 96, "départements de métropole")

calls = []
def fake_get_json(url, limiter, tries=6, timeout=60):
    q = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))
    calls.append(q)
    big = q.get("activite_principale") == "45.20A" and "etat_administratif" not in q
    total = 12000 if big else 30
    pages = 400 if big else 2
    pg = int(q["page"])
    et = q.get("etat_administratif", "A")
    return {"total_results": total, "total_pages": pages, "results": [{"nom_complet": "X %s%d" % (q["activite_principale"], pg), "activite_principale": q["activite_principale"], "matching_etablissements": [
        {"siret": "%s%s%d" % (q["activite_principale"].replace(".", ""), et, pg), "latitude": "43.1", "longitude": "1.2", "etat_administratif": et, "activite_principale": q["activite_principale"]}]}]}
real = S.get_json
S.get_json = fake_get_json
try:
    a2, c2, s2 = S.fetch_dept("31", S.Limiter(0.0))
finally:
    S.get_json = real
check(s2["coupees"] == 1 and s2["requetes"] == 5, "une recherche à plus de 9 900 résultats est coupée par état administratif : %r" % s2)
check(any(q.get("etat_administratif") == "C" for q in calls) and len(c2) > 0 and len(a2) > 0, "actifs et fermés recueillis")

def fetcher(code, limiter, log):
    if code == "13":
        raise RuntimeError("panne")
    return ({"s%s" % code: {"name": "n", "lat": 1.0, "lon": 1.0, "siret": "s%s" % code}}, {}, {"requetes": 1, "coupees": 0})
ac, cl, miss = S.load(["31", "13", "09"], log=lambda m: None, workers=2, fetcher=fetcher)
check(miss == ["13"] and len(ac) == 2, "un département en échec n'arrête pas la lecture : %r" % miss)

# ------------------------------------------------------------------------------------------------------------------ construction de bout en bout (lectures simulées)
fake_rows = [
    row(50, "Garage Dupont", 43.2174, 1.1014, phones=["0199000050"], websites=["https://dupont-auto.example.fr"]),
    row(51, "Garage Dupont Auto", 43.2176, 1.1016, phones=["0199000051"]),                       # doublon du précédent
    row(52, "Carrosserie Solsona", 43.2300, 1.1200, cat="auto_body_shop"),
    row(53, "Pneus Rapides", 43.2500, 1.0900, cat="tire_dealer_and_repair", phones=["0199000053"]),
    row(54, "Garage Fermé Depuis Longtemps", 43.2000, 1.0800, phones=["0199000054"]),
    row(55, "Garage Exclu", 43.2100, 1.0700, phones=["0199000055"]),
    row(56, "", 43.2100, 1.0600),
]
saved = (O.latest_release, O.read_places, S.load)
O.latest_release = lambda: "release/2026-09-23.1"
O.read_places = lambda poly, release, log=print, country="FR": (fake_rows, 5000)
S.load = lambda codes, log=print, workers=4, fetcher=None: ([{"name": "Garage Dupont", "lat": 43.2174, "lon": 1.1014, "siret": "1"}], [{"name": "Garage Fermé Depuis Longtemps", "lat": 43.2000, "lon": 1.0800, "siret": "2"}], [])
tmp = tempfile.mkdtemp(prefix="garages-test-")
try:
    excl = os.path.join(tmp, "excl.json")
    json.dump({"ids": [fake_rows[5]["id"]]}, open(excl, "w"))
    out_dir = os.path.join(tmp, "out")
    summary = os.path.join(tmp, "summary.md")
    code = B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--dept-codes", "31", "--out", out_dir, "--exclude", excl, "--built", "2026-10-06", "--probe", "43.2174,1.1014,10", "--print-dropped", "--summary", summary])
    check(code == 0, "construction de bout en bout : code %r" % code)
    idx = json.load(open(os.path.join(out_dir, "index.json"), encoding="utf-8"))
    ids = {g["id"]: g for f in os.listdir(os.path.join(out_dir, "t")) for g in json.load(open(os.path.join(out_dir, "t", f), encoding="utf-8"))["g"]}
    check(idx["count"] == 3 and idx["closure"] == "sirene" and idx["built"] == "2026-10-06" and "version 2026-09-23.1" in idx["source"], "index : %r" % {k: v for k, v in idx.items() if k != "tiles"})
    check(fake_rows[5]["id"] not in ids and fake_rows[4]["id"] not in ids and fake_rows[6]["id"] not in ids, "exclu, fermé et sans nom : absents")
    check(len([g for g in ids.values() if g["name"].startswith("Garage Dupont")]) == 1 and next(g for g in ids.values() if g["name"].startswith("Garage Dupont"))["phones"] == ["+33199000050", "+33199000051"], "doublon réuni")
    text = open(summary, encoding="utf-8").read()
    check("3 garages" in text and "1 doublons réunis" in text and "Contrôle de la sortie : conforme" in text and "Sonde 43.2174,1.1014" in text and fake_rows[4]["id"] in text, "résumé : %s" % text[:400])
    check("Dupont" not in text and "0199" not in text and "dupont-auto" not in text, "le résumé ne contient ni nom ni numéro ni adresse web")
    # un registre muet sur trop de départements : construction refusée
    S.load = lambda codes, log=print, workers=4, fetcher=None: ([], [], ["31", "09", "11", "32", "65", "81"])
    try:
        B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--dept-codes", "31", "--out", out_dir + "2", "--built", "2026-10-06"])
        check(False, "la construction aurait dû être refusée")
    except SystemExit as e:
        check("sans réponse" in str(e), "refus quand le registre est muet : %s" % e)
    # un registre muet sur quelques départements seulement : construction acceptée, et l'index le dit
    S.load = lambda codes, log=print, workers=4, fetcher=None: ([{"name": "Garage Dupont", "lat": 43.2174, "lon": 1.1014, "siret": "1"}], [], ["09"])
    code = B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--dept-codes", "31,09", "--out", out_dir + "5", "--built", "2026-10-06"])
    idx5 = json.load(open(os.path.join(out_dir + "5", "index.json"), encoding="utf-8"))
    check(code == 0 and idx5["closure"] == "partial" and idx5["closure_missing"] == ["09"], "registre partiel : %r" % {k: v for k, v in idx5.items() if k != "tiles"})
    # le registre demande les départements de la zone
    try:
        B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--out", out_dir + "6", "--built", "2026-10-06"])
        check(False, "la construction aurait dû demander les codes de département")
    except SystemExit as e:
        check("--dept-codes" in str(e), "sans codes de département : %s" % e)
    # --sirene off : aucun retrait, closure « none »
    code = B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--sirene", "off", "--out", out_dir + "3", "--built", "2026-10-06"])
    idx3 = json.load(open(os.path.join(out_dir + "3", "index.json"), encoding="utf-8"))
    check(code == 0 and idx3["closure"] == "none" and idx3["count"] == 5, "sans registre : %r" % {k: v for k, v in idx3.items() if k != "tiles"})
    # garde contre une lecture partielle
    code = B.main(["--area", "bbox:0.9,43.0,1.3,43.4", "--sirene", "off", "--out", out_dir + "4", "--built", "2026-10-06", "--min-entries", "1000"])
    check(code == 2, "moins de garages que le minimum demandé : code %r" % code)
finally:
    O.latest_release, O.read_places, S.load = saved
    shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------------------------------------------------------ même règle que la page
import random  # noqa: E402
import shutil as _sh  # noqa: E402
import subprocess  # noqa: E402

if _sh.which("node"):
    rnd = random.Random(7)
    names = ["", "Garage (nom non renseigné)", "Spécialiste pneus (sans nom)", "Solsona", "Carosserie Solsona", "Carrosserie Martin", "Carrosserie Dupont", "L'ATELIER AUTO-MOBILE", "L’Atelier automobile",
             "Garage Éole", "EOLE AUTO", "Auto Expert Cazères", "Eurorepar Garage Portet C.C.E", "Pneus Express", "Renault", "Garage Renault", "Berges Pneus 31", "SARL Duchamp Auto", "Ets Lopez & Fils",
             "Centre Auto Pyrénées", "Garage des Pyrénées", "Mécanique Générale Perrache", "Garage du Parc", "Auto-École du Parc", "Speedy Toulouse", "Norauto Fenouillet", "Point S Muret", "A", "ÉTS Çà Là"]
    names += ["%s %s" % (rnd.choice(["Garage", "Auto", "Carrosserie", "Pneus", "Atelier", "Mécanique", ""]), rnd.choice(["Dupont", "Martin", "Garcia", "Bernard", "Lopez", "Moreau", "Girard", "Faure", "Roux", "Blanc", "Mercier", "Lambert"])) for _ in range(40)]
    centre = (43.2174, 1.1014)
    def pt(spread):
        return centre[0] + rnd.uniform(-spread, spread), centre[1] + rnd.uniform(-spread, spread)
    recs = []
    for i in range(300):
        la, lo = pt(0.004)
        recs.append({"id": "r%03d" % i, "name": rnd.choice(names), "lat": la, "lon": lo})
    garages = []
    for i in range(300):
        la, lo = pt(0.004)
        garages.append({"name": rnd.choice(names), "lat": la, "lon": lo})
    pairs = [[{"lat": g["lat"], "lon": g["lon"]}, {"lat": r["lat"], "lon": r["lon"]}] for g, r in zip(garages, recs)]
    points = [[43.2174 + rnd.uniform(-0.3, 0.3), 1.1014 + rnd.uniform(-0.3, 0.3), rnd.choice([3, 5, 10, 20, 30, 50])] for _ in range(60)] + [[0.0, -10.0, 5], [-0.01, -10.01, 5], [51.0, 9.75, 50]]
    tmpd = tempfile.mkdtemp(prefix="garages-diff-")
    try:
        cp, op = os.path.join(tmpd, "cases.json"), os.path.join(tmpd, "out.json")
        json.dump({"names": names, "garages": garages, "recs": recs, "pairs": pairs, "points": points}, open(cp, "w", encoding="utf-8"))
        subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "diff_js.mjs"), cp, op], check=True, cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
        js = json.load(open(op, encoding="utf-8"))
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)
    bad = 0
    for i, a in enumerate(names):
        bad += js["real"][i] != M.has_real_name(a)
        bad += js["fold"][i] != M.fold(a)
        for j, b in enumerate(names):
            bad += js["same"][i][j] != M.same_name(a, b)
    for k, g in enumerate(garages):
        p = M.pick_place(g, recs)
        bad += (p["id"] if p else None) != js["pick"][k]
    for k, (a, b) in enumerate(pairs):
        bad += abs(M.meters(a, b) - js["dist"][k]) > 1e-6
    for k, (la, lo, km) in enumerate(points):
        bad += js["keys"][k] != T.tile_keys_for(la, lo, km)
        bad += js["key"][k] != T.tile_key(la, lo)
    picked = sum(1 for x in js["pick"] if x)
    check(bad == 0, "le module JavaScript et matching.py/tiles.py divergent sur %d points" % bad)
    check(picked > 20, "le jeu d'essai produit des rapprochements (%d sur %d garages)" % (picked, len(garages)))
    print("comparaison JavaScript ↔ Python : %d paires de noms, %d garages (dont %d rapprochés), %d distances, %d cases, aucun écart." % (len(names) ** 2, len(garages), picked, len(pairs), len(points)))
else:
    print("node introuvable : comparaison avec le module JavaScript ignorée")

print("%d contrôles passés." % OK)
