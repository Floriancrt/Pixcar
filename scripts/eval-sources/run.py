"""Évaluation hors ligne d'un département : que donnent le registre SIRENE, OpenStreetMap et Overture en téléphone, site, horaires et couverture ?

Usage : python scripts/eval-sources/run.py [--dept 31] [--name Haute-Garonne] [--bbox 0.2,42.5,2.3,44.1]
Sortie : un rapport en Markdown (agrégats seulement) sur la sortie standard et dans $GITHUB_STEP_SUMMARY ; une ligne « CZ_OSM » par garage OpenStreetMap
du disque de 10 km autour de Cazères (nom, position, présence de téléphone/site/horaires : jamais de numéro) pour la jointure locale avec le banc d'essai.
"""
import argparse
import collections
import json
import os
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402
import report as R  # noqa: E402
import sources as S  # noqa: E402


def build(osm, ovt, sir, info):
    """Rapport (liste de lignes) à partir des trois listes de garages normalisés."""
    osm_core = [x for x in osm if x["lvl"] == "core"]
    ovt_core = [x for x in ovt if x["cat"] in S.OVT_CORE]
    ovt_insp = [x for x in ovt if x["cat"] == "car_inspection"]
    sets = {"osm": osm, "ovt": ovt_core, "sir": sir}
    L = []
    add = L.append
    add("# Évaluation des sources de garages — %s (%s)" % (info.get("name", "?"), date.today().isoformat()))
    add("")
    add("Sources : Overture %s ; OpenStreetMap via %s ; SIRENE via l'API recherche-entreprises (%s). Rapprochement : règle de la page (même nom ET ≤ 150 m ; sans nom : seul lieu ≤ 40 m)." % (info.get("release", "?"), info.get("osm_how", "?"), info.get("sirene_mode", "?")))
    add("")
    add("## 1. Ce que contient chaque source")
    add("")
    for line in R.fill_table(
        [
            ("OpenStreetMap, liste de la page (cœur + extensions)", osm, True),
            ("  dont cœur (shop=car_repair, shop=tyres, craft=car_repair)", osm_core, True),
            ("Overture, réparation + pneus + carrosserie + vitrage", ovt_core, False),
            ("Overture, contrôle technique (à part)", ovt_insp, False),
            ("SIRENE, NAF 45.20A/B + 45.32Z de réseau", sir, False),
        ]
    ):
        add(line)
    add("")
    add("Pour mémoire, banc d'essai de Cazères (10 km, 5 octobre) : Mapbox 34 garages, téléphone 97 %, horaires 91 %, site 65 % ; registre 37 garages sans aucune coordonnée.")
    add("")
    c = collections.Counter(x["cls"] for x in osm)
    add("OpenStreetMap par classe : %s ; éléments rejetés par le filtre de la page : %s." % (dict(c), info.get("osm_rejected")))
    add("Overture par catégorie (cœur) : %s." % dict(collections.Counter(x["cat"] for x in ovt_core).most_common()))
    add("Overture, origine des lieux (cœur) : %s." % dict(collections.Counter(tuple(x["ds"]) for x in ovt_core).most_common(6)))
    add("SIRENE par NAF retenu : %s ; établissements lus puis écartés : %s ; inactifs ignorés : %s ; sans position : %s." % (dict(collections.Counter(x["naf"] for x in sir)), info.get("sir_discarded"), info.get("sir_inactive"), info.get("sir_nopos")))
    add("SIRENE : %s avec enseigne, %s dont l'adresse porte un code postal en 31 (contrôle du filtre département)." % (R.cell(sum(1 for x in sir if x["ens"]), len(sir)), R.cell(sum(1 for x in sir if x["cp"]), len(sir))))
    no_tok = sum(1 for x in sir if not M.tokens(x["name"]))
    add("Noms sans mot distinctif (rapprochement par le nom impossible) : OSM %d/%d, Overture %d/%d, SIRENE %d/%d." % (sum(1 for x in osm if not M.tokens(x["name"])), len(osm), sum(1 for x in ovt_core if not M.tokens(x["name"])), len(ovt_core), no_tok, len(sir)))
    add("Nature des sites : OpenStreetMap — %s ; Overture — %s." % (R.site_kinds_text(osm), R.site_kinds_text(ovt_core)))
    add("Téléphones mobiles seulement (06/07) : OpenStreetMap %s, Overture %s." % (R.cell(sum(1 for x in osm if x["tels"] and M.mobile_only(x["tels"])), sum(1 for x in osm if x["tels"])), R.cell(sum(1 for x in ovt_core if x["tels"] and M.mobile_only(x["tels"])), sum(1 for x in ovt_core if x["tels"]))))
    add("")
    add("### Confiance et origine des lieux Overture (cœur)")
    add("")
    for line in R.fill_table(
        [("confiance < 0,5", [x for x in ovt_core if x["conf"] is not None and x["conf"] < 0.5], False), ("0,5 – 0,7", [x for x in ovt_core if x["conf"] is not None and 0.5 <= x["conf"] < 0.7], False), ("0,7 – 0,85", [x for x in ovt_core if x["conf"] is not None and 0.7 <= x["conf"] < 0.85], False), ("≥ 0,85", [x for x in ovt_core if x["conf"] is not None and x["conf"] >= 0.85], False)]
        + [("vient aussi de %s" % d, [x for x in ovt_core if d in x["ds"]], False) for d in ("meta", "Foursquare", "AllThePlaces")]
    ):
        add(line)
    for near, spot in ((M.NEAR_M, M.SAME_SPOT_M), (300, M.SAME_SPOT_M)):
        add("")
        add("## 2. Recouvrement (%d m, %d m sans nom)" % (near, spot))
        add("")
        for line in R.overlap_table(sets, near, spot):
            add(line)
    add("")
    add("## 2b. Plafond du recouvrement : ce que l'exigence d'un nom commun empêche de voir")
    add("")
    add("Adresse exploitable (numéro et voie) : %s." % ", ".join("%s %s" % (R.LABEL[k], R.cell(sum(1 for x in v if x["addr"] and x["addr"][0]), len(v))) for k, v in sets.items()))
    add("")
    for line in R.proximity_table(sets):
        add(line)
    add("")
    add("Avec l'adresse en plus du nom (même numéro dans la même voie, ≤ 150 m) :")
    add("")
    for line in R.overlap_table(sets, M.NEAR_M, M.SAME_SPOT_M, linker=M.link_loose):
        add(line)
    add("")
    add("### Ce que chaque source apporte aux fiches incomplètes")
    add("")
    add("Règle de la page (nom + 150 m) :")
    for line in R.yield_lines(sets, M.NEAR_M, M.SAME_SPOT_M):
        add(line)
    add("")
    add("Nom ou adresse (150 m) :")
    for line in R.yield_lines(sets, M.NEAR_M, M.SAME_SPOT_M, linker=M.link_loose):
        add(line)
    add("")
    ents_loose = R.entities(sets, M.NEAR_M, M.SAME_SPOT_M, linker=M.link_loose)
    add("## 2c. Garages réunis, nom ou adresse (150 m)")
    add("")
    for line in R.combo_table(ents_loose):
        add(line)
    add("")
    for line in R.list_lines("Haute-Garonne, nom ou adresse", R.pixcar_list(ents_loose)):
        add(line)
    add("")
    for near, spot in ((M.NEAR_M, M.SAME_SPOT_M), (300, M.SAME_SPOT_M)):
        ents = R.entities(sets, near, spot)
        add("## 3. Garages réunis (%d m)" % near)
        add("")
        for line in R.combo_table(ents):
            add(line)
        add("")
        for line in R.list_lines("Haute-Garonne, %d m" % near, R.pixcar_list(ents)):
            add(line)
        add("")
        if near == M.NEAR_M:
            ents150 = ents
    add("### Profil des garages que seul Overture connaît (règle de la page, 150 m)")
    add("")
    for line in R.overture_only_profile(ents150):
        add(line)
    add("")
    add("### Les établissements SIRENE trouvent-ils un équivalent ? Selon leur nature")
    add("")
    add("Règle de la page (nom + 150 m) :")
    add("")
    for line in R.sirene_class_table(sir, osm, ovt_core, M.NEAR_M, M.SAME_SPOT_M):
        add(line)
    add("")
    add("Nom ou adresse (150 m) :")
    add("")
    for line in R.sirene_class_table(sir, osm, ovt_core, M.NEAR_M, M.SAME_SPOT_M, linker=M.link_loose):
        add(line)
    add("")
    add("## 4. Par zone (150 m)")
    add("")
    for line in R.zone_table(sets, ents150):
        add(line)
    add("")
    add("## 5. Qualité")
    add("")
    for a, b in (("osm", "ovt"), ("ovt", "osm")):
        r = R.agreement(sets[a], sets[b], M.NEAR_M, M.SAME_SPOT_M)
        add("- %s → %s : %d paires ; téléphones comparables %d, identiques %s ; sites comparables %d, même domaine %s." % (R.LABEL[a], R.LABEL[b], r["pairs"], r["tel_both"], R.cell(r["tel_same"], r["tel_both"]), r["web_both"], R.cell(r["web_same"], r["web_both"])))
    band = lambda q: "confiance < 0,5" if (q["conf"] or 0) < 0.5 else ("confiance 0,5–0,7" if q["conf"] < 0.7 else "confiance ≥ 0,7")  # noqa: E731
    for label, key in (("selon la confiance d'Overture", band), ("selon l'origine du lieu Overture", lambda q: "meta" if "meta" in q["ds"] else ("Foursquare" if "Foursquare" in q["ds"] else "autre"))):
        res = R.agreement_bands(sets["osm"], sets["ovt"], M.NEAR_M, M.SAME_SPOT_M, key)
        add("- Téléphones identiques entre OpenStreetMap et Overture %s : %s." % (label, " ; ".join("%s : %d/%d" % (k, v[1], v[0]) for k, v in sorted(res.items()))))
    for k, L_ in (("OpenStreetMap", osm), ("Overture (cœur)", ovt_core), ("SIRENE", sir)):
        add("- %s : %d éléments recoupent un autre élément de la même source (même nom à 150 m)." % (k, R.duplicates(L_, M.NEAR_M, M.SAME_SPOT_M)))
    add("- Overture : %d lieux dont le numéro est partagé avec au moins deux autres lieux (standard de réseau)." % R.shared_phones(ovt_core))
    add("- OpenStreetMap : %d éléments dont le numéro est partagé avec au moins deux autres." % R.shared_phones(osm))
    add("")
    add("## 6. Disque de 10 km autour de Cazères (comparaison avec le banc)")
    add("")
    cz = {k: [x for x in v if M.meters(R.CAZERES, x) <= 10000] for k, v in sets.items()}
    for line in R.fill_table([("OpenStreetMap", cz["osm"], True), ("Overture (cœur)", cz["ovt"], False), ("SIRENE", cz["sir"], False)]):
        add(line)
    add("")
    ez = [e for e in ents150 if M.meters(R.CAZERES, e) <= 10000]
    for line in R.combo_table(ez):
        add(line)
    add("")
    for line in R.list_lines("Cazères 10 km, 150 m", R.pixcar_list(ez)):
        add(line)
    add("")
    for x in cz["osm"]:
        add("CZ_OSM " + json.dumps({k: x[k] for k in ("id", "name", "lat", "lon", "phone", "web", "hours", "cls", "lvl")}, ensure_ascii=False))
    return L


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dept", default="31")
    ap.add_argument("--name", default="Haute-Garonne")
    ap.add_argument("--bbox", default="0.2,42.5,2.3,44.1", help="boîte large autour du département (ouest,sud,est,nord), pour choisir les groupes de lignes d'Overture")
    a = ap.parse_args(argv)
    rough = tuple(float(v) for v in a.bbox.split(","))
    t0 = time.time()
    failed = []

    def log(m):
        print("[%4.0f s] %s" % (time.time() - t0, m), flush=True)

    from shapely.geometry import Point

    poly, rel = S.dept_polygon(a.name, rough, log)
    bbox = poly.bounds  # ouest, sud, est, nord
    info = {"name": a.name}
    ovt = osm = sir = []
    try:
        ovt, info["release"], _ = S.load_overture(poly, rel, log)
    except Exception as e:  # noqa: BLE001
        failed.append("overture")
        log("ÉCHEC Overture : %r" % e)
    try:
        elems, how = S.osm_overpass(bbox, log)
        if elems is None:
            log("OpenStreetMap : Overpass inaccessible, repli sur l'extrait Geofabrik")
            elems, how = S.osm_pbf(bbox, log)
        osm, info["osm_rejected"] = S.osm_entities(elems, poly)
        info["osm_how"] = how
        log("OpenStreetMap : %d garages dans le département (liste de la page)" % len(osm))
    except Exception as e:  # noqa: BLE001
        failed.append("osm")
        log("ÉCHEC OpenStreetMap : %r" % e)
    try:
        sir_raw, st, info["sirene_mode"] = S.load_sirene(a.dept, poly, log)
        sir = [x for x in sir_raw if poly.contains(Point(x["lon"], x["lat"]))]
        info.update({"sir_discarded": st["ecartes"], "sir_inactive": st["inactifs"], "sir_nopos": st["sans_position"]})
        log("SIRENE : %d établissements dont %d dans le contour" % (len(sir_raw), len(sir)))
    except Exception as e:  # noqa: BLE001
        failed.append("sirene")
        log("ÉCHEC SIRENE : %r" % e)
    lines = build(osm, ovt, sir, info)
    print("\n".join(lines), flush=True)
    out = os.environ.get("GITHUB_STEP_SUMMARY")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("\n".join(l for l in lines if not l.startswith("CZ_OSM")) + "\n")
    if failed:
        print("SOURCES EN ÉCHEC : %s" % ", ".join(failed), flush=True)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
