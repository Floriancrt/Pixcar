"""Chargement des trois sources pour un département : Overture (S3 public), OpenStreetMap (Overpass, sinon extrait Geofabrik), registre SIRENE (API recherche-entreprises).

Chaque chargeur rend des « garages » au même format : {src, id, name, lat, lon, phone, web, hours, tels, hosts, ...}.
Aucune donnée brute n'est écrite sur le disque en dehors d'un extrait Geofabrik temporaire (solution de repli) ; la sortie du programme ne contient que des agrégats.
"""
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402
import ovt_io as O  # noqa: E402

UA = "pixcar-eval/1.0 (+https://github.com/Floriancrt/Pixcar; mesure ponctuelle de couverture de données ouvertes)"
# Enseignes de réseau que la page reconnaît en plus des balises (même liste que la requête Overpass de src/js/shared/overpass.js).
CHAIN = re.compile(r"norauto|feu.?vert|speedy|midas|roady|euromaster|point s|first.?stop|vulco|profil|siligom|euro.?tyre|best.?drive|driver.?cent|leclerc|carter|euro.?repar|motrio|bosch|top.?garage|pr.cisium|delko|auto.?primo|avatacar", re.I)


def http(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def entity(src, id_, name, lat, lon, phones, webs, hours, address=None, postcode=None, **extra):
    """Garage normalisé. phones : textes bruts ; webs : adresses brutes ; hours : texte ou '' ; address : adresse libre (pour le rapprochement par adresse)."""
    t = M.tels(phones)
    h = sorted({M.host_of(w) for w in webs if w} - {""})
    addr = M.addr_parts(address, postcode) if address else None
    return {"src": src, "id": id_, "name": name or "", "lat": lat, "lon": lon, "phone": bool(t), "web": bool(h), "hours": bool(hours), "tels": t, "hosts": h, "addr": addr, **extra}


# ---------------------------------------------------------------------------------------------------------------------------- polygone
def dept_polygon(name, rough_bbox, log=print):
    """Contour du département d'après les divisions d'Overture (sous-type « county », pays FR) : le même contour sert à toutes les sources."""
    from shapely import from_wkb

    rel = O.latest_release()
    fs = O.open_fs()
    found = []
    for k in O.theme_files(rel, "divisions", "division_area"):
        hits, _, _ = O.row_group_hits(fs, k, rough_bbox)
        if not hits:
            continue
        for r in O.read_groups(fs, k, hits, ["country", "subtype", "names", "geometry"]):
            if r.get("country") == "FR" and r.get("subtype") == "county" and (r.get("names") or {}).get("primary") == name:
                found.append(r["geometry"])
    if not found:
        raise RuntimeError("contour introuvable pour " + name)
    geom = from_wkb(found[0])
    log("Contour de %s : %s, boîte %s" % (name, geom.geom_type, [round(v, 3) for v in geom.bounds]))
    return geom, rel


# ---------------------------------------------------------------------------------------------------------------------------- Overture
OVT_COLS = ["id", "names", "taxonomy", "basic_category", "confidence", "websites", "phones", "addresses", "sources", "bbox", "brand", "operating_status"]
OVT_AUTO = {"automotive_service", "vehicle_service"}
OVT_CORE = {"automotive_repair", "tire_dealer_and_repair", "auto_body_shop", "auto_glass_service"}


def _ovt_keep(r):
    t = r.get("taxonomy") or {}
    return r.get("basic_category") == "automotive_service" or bool(set(t.get("hierarchy") or []) & OVT_AUTO)


def load_overture(poly, release=None, log=print):
    """Lieux Overture de type automobile dans le polygone. Rend (entités, version, nombre de lieux lus)."""
    import numpy as np
    from shapely import contains_xy

    release = release or O.latest_release()
    fs = O.open_fs()
    minx, miny, maxx, maxy = poly.bounds
    bbox = (minx - 0.01, miny - 0.01, maxx + 0.01, maxy + 0.01)
    out, scanned, groups, t0 = [], 0, 0, time.time()
    for k in O.theme_files(release, "places", "place"):
        hits, _, _ = O.row_group_hits(fs, k, bbox)
        if not hits:
            continue
        rows = O.read_groups(fs, k, hits, OVT_COLS)
        scanned += len(rows)
        groups += len(hits)
        if not rows:
            continue
        xs = np.array([(r["bbox"]["xmin"] + r["bbox"]["xmax"]) / 2 for r in rows])
        ys = np.array([(r["bbox"]["ymin"] + r["bbox"]["ymax"]) / 2 for r in rows])
        for r, ok in zip(rows, contains_xy(poly, xs, ys)):
            if not ok or not _ovt_keep(r):
                continue
            b, t = r["bbox"], r.get("taxonomy") or {}
            out.append(
                entity(
                    "ovt", r["id"], (r.get("names") or {}).get("primary"), (b["ymin"] + b["ymax"]) / 2, (b["xmin"] + b["xmax"]) / 2,
                    [p for p in (r.get("phones") or []) if p], [w for w in (r.get("websites") or []) if w], "",
                    address=((r.get("addresses") or [{}])[0] or {}).get("freeform"), postcode=((r.get("addresses") or [{}])[0] or {}).get("postcode"),
                    cat=t.get("primary"), conf=r.get("confidence"), brand=((r.get("brand") or {}).get("names") or {}).get("primary"),
                    ds=sorted({(s or {}).get("dataset") for s in (r.get("sources") or []) if (s or {}).get("dataset") not in (None, "Overture")}),
                )
            )
    log("Overture %s : %d groupes de lignes, %d lieux lus, %d de type automobile dans le département (%.0f s)" % (release, groups, scanned, len(out), time.time() - t0))
    return out, release, scanned


# ---------------------------------------------------------------------------------------------------------------------------- OpenStreetMap
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
GEOFABRIK = "https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf"
OSM_SELECT = (("shop", "car_repair"), ("shop", "tyres"), ("craft", "car_repair"), ("shop", "car_parts"), ("shop", "car"))


def overpass_text(bbox):
    box = "(%.5f,%.5f,%.5f,%.5f)" % (bbox[1], bbox[0], bbox[3], bbox[2])  # sud, ouest, nord, est
    return "[out:json][timeout:240][maxsize:1073741824];(" + "".join('nwr["%s"="%s"]%s;' % (k, v, box) for k, v in OSM_SELECT) + ");out center tags;"


def osm_overpass(bbox, log=print, mirrors=None):
    body = urllib.parse.urlencode({"data": overpass_text(bbox)}).encode()
    for url in mirrors or OVERPASS:
        host = urllib.parse.urlparse(url).hostname
        for attempt in (1, 2):
            try:
                st, raw = http(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=300)
                js = json.loads(raw)
                if isinstance(js.get("elements"), list) and not str(js.get("remark", "")).lower().startswith("runtime error"):
                    log("OpenStreetMap : %d éléments reçus de %s (HTTP %d)" % (len(js["elements"]), host, st))
                    return js["elements"], host
                log("OpenStreetMap : réponse inutilisable de %s (%s)" % (host, str(js.get("remark", ""))[:80]))
                break
            except urllib.error.HTTPError as e:
                log("OpenStreetMap : %s répond HTTP %d (essai %d)" % (host, e.code, attempt))
                if e.code in (429, 502, 503, 504) and attempt == 1:
                    time.sleep(20)
                    continue
                break
            except Exception as e:  # noqa: BLE001
                log("OpenStreetMap : %s injoignable (%s)" % (host, type(e).__name__))
                break
    return None, None


def osm_pbf(bbox, log=print, url=GEOFABRIK, path="osm-extract.osm.pbf"):
    """Solution de repli : extrait régional de Geofabrik lu avec pyosmium (nœuds et chemins ; les relations sont ignorées)."""
    import osmium

    t0 = time.time()
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        log("OpenStreetMap : extrait téléchargé (%d Mo, %.0f s)" % (os.path.getsize(path) >> 20, time.time() - t0))
    elems, skipped = [], 0
    keys = {k for k, _ in OSM_SELECT}
    fp = osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.KeyFilter(*sorted(keys)))
    for o in fp:
        tags = {t.k: t.v for t in o.tags}
        if not any(tags.get(k) == v for k, v in OSM_SELECT):
            continue
        if o.is_node():
            lat, lon, kind = o.lat, o.lon, "node"
        elif o.is_way():
            pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
            if not pts:
                skipped += 1
                continue
            lat, lon, kind = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), "way"
        else:
            skipped += 1
            continue
        if bbox[1] <= lat <= bbox[3] and bbox[0] <= lon <= bbox[2]:
            elems.append({"type": kind, "id": o.id, "lat": lat, "lon": lon, "tags": tags})
    log("OpenStreetMap : %d éléments lus dans l'extrait (%d ignorés : relations ou chemins sans position), %.0f s" % (len(elems), skipped, time.time() - t0))
    return elems, "geofabrik"


def osm_class(t):
    """(classe, niveau) d'un élément OSM : « core » = ce que la page range d'office parmi les garages, « ext » = ajouts par nom, réseau ou prestations."""
    shop, craft = t.get("shop"), t.get("craft")
    if shop in ("car_repair", "tyres"):
        return shop, "core"
    if craft == "car_repair":
        return "car_repair", "core"
    name = M.fold(t.get("name") or "")
    if shop == "car_parts":
        if re.search(r"\bpneu", name):
            return "tyres", "ext"
        if re.search(r"\b(garage|mecani\w*|centre auto)\b", name):
            return "car_repair", "ext"
    if shop in ("car", "car_parts"):
        if re.search(r"(^|;)\s*repair\b", t.get("service") or "") or any(k.startswith("service:vehicle:") and v == "yes" for k, v in t.items()):
            return "car_repair", "ext"
        if CHAIN.search(" | ".join(x for x in (t.get("name"), t.get("brand"), t.get("operator"), t.get("brand:fr")) if x)):
            return "car_repair", "ext"
    return None, None


def osm_entities(elements, poly=None):
    from shapely.geometry import Point

    out, rejected = [], 0
    for e in elements:
        t = e.get("tags") or {}
        cls, lvl = osm_class(t)
        if not cls:
            rejected += 1
            continue
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lon = e.get("lon", (e.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            continue
        if poly is not None and not poly.contains(Point(lon, lat)):
            continue
        phones = [t.get(k) for k in ("phone", "contact:phone", "mobile", "contact:mobile", "phone:mobile") if t.get(k)]
        webs = [t.get(k) for k in ("website", "contact:website") if t.get(k)][:1]
        street = " ".join(x for x in ((t.get("addr:housenumber") or t.get("contact:housenumber")), (t.get("addr:street") or t.get("contact:street") or t.get("addr:place"))) if x)
        out.append(entity("osm", "%s/%s" % (e.get("type"), e.get("id")), t.get("name") or t.get("brand") or t.get("operator"), float(lat), float(lon), phones, webs, t.get("opening_hours") or "", address=street or t.get("addr:full"), postcode=t.get("addr:postcode") or t.get("contact:postcode"), cls=cls, lvl=lvl))
    return out, rejected


# ---------------------------------------------------------------------------------------------------------------------------- SIRENE
SIRENE = "https://recherche-entreprises.api.gouv.fr/"
SIRENE_NAF = "45.20A,45.20B,45.32Z"


def _json(url, tries=4, log=print):
    last = None
    for i in range(tries):
        try:
            return json.loads(http(url, timeout=60)[1])
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(2 * (i + 1))
                continue
            if e.code >= 500:
                time.sleep(3 * (i + 1))
                continue
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (i + 1))
    raise last


def sirene_pages(endpoint, params, log=print, pace=0.25, cap_pages=400):
    page, seen_pages = 1, 0
    while True:
        js = _json(SIRENE + endpoint + "?" + urllib.parse.urlencode(dict(params, page=str(page))), log=log)
        yield js
        seen_pages += 1
        total = min(int(js.get("total_pages") or 1), cap_pages)
        if page >= total:
            return
        page += 1
        time.sleep(pace)


def sirene_add(e, out, stats):
    """Établissements d'une entreprise du résultat, comme la page (src/js/app.js, fonction de lecture des résultats). Les actifs vont dans out ;
    les fermés (même NAF, même position) sont gardés à part dans stats["closed"] : ils servent à repérer des lieux qui ont probablement fermé."""
    for s in e.get("matching_etablissements") or []:
        closed = bool(s.get("etat_administratif") and s["etat_administratif"] != "A")
        if closed:
            stats["inactifs"] += 1
        siret = s.get("siret")
        try:
            lat, lon = float(s.get("latitude")), float(s.get("longitude"))
            if not (math.isfinite(lat) and math.isfinite(lon)):
                raise ValueError
        except (TypeError, ValueError):
            if not closed:
                stats["sans_position"] += 1
            continue
        target = stats.setdefault("closed", {}) if closed else out
        if not siret or siret in target:
            continue
        naf = str(s.get("activite_principale") or e.get("activite_principale") or "")
        ens = [x for x in (s.get("liste_enseignes") or []) if x]
        nom = ens[0] if ens else (s.get("nom_commercial") or e.get("nom_complet") or e.get("nom_raison_sociale") or "")
        chain = bool(CHAIN.search(" | ".join(ens + [s.get("nom_commercial") or "", e.get("nom_complet") or "", e.get("nom_raison_sociale") or "", e.get("sigle") or ""])))
        if not closed:
            stats["naf"][naf] = stats["naf"].get(naf, 0) + 1
        if naf.startswith("45.20") or (naf == "45.32Z" and chain):
            target[siret] = entity(
                "sir", "siret:" + siret, nom, lat, lon, [], [], "", address=s.get("adresse"), naf=naf, ens=bool(ens), cp=bool(re.search(r"\b31\d{3}\b", s.get("adresse") or "")),
                nj=str(e.get("nature_juridique") or ""), emp=str(e.get("caractere_employeur") or ""),
            )
        elif not closed:
            stats["ecartes"] += 1


def load_sirene(dept, poly, log=print):
    """Établissements SIRENE : /search?departement=… ; si l'API refuse ce filtre, repli sur des cercles /near_point."""
    out, stats = {}, {"inactifs": 0, "sans_position": 0, "ecartes": 0, "naf": {}, "closed": {}}
    base = {"activite_principale": SIRENE_NAF, "per_page": "25", "limite_matching_etablissements": "25", "minimal": "true", "include": "matching_etablissements"}
    t0 = time.time()
    try:
        total = None
        for js in sirene_pages("search", dict(base, departement=dept), log=log):
            total = js.get("total_results", total)
            for e in js.get("results") or []:
                sirene_add(e, out, stats)
        log("SIRENE : %s entreprises annoncées, %d établissements retenus (filtre département, %.0f s)" % (total, len(out), time.time() - t0))
        if out and (total or 0) < 9900:
            return list(out.values()), stats, "search"
        log("SIRENE : résultat vide ou plafonné, repli sur les cercles")
    except Exception as e:  # noqa: BLE001
        log("SIRENE : le filtre département échoue (%s), repli sur les cercles" % type(e).__name__)
    out.clear()
    stats.update({"inactifs": 0, "sans_position": 0, "ecartes": 0, "naf": {}, "closed": {}})
    minx, miny, maxx, maxy = poly.bounds
    from shapely.geometry import Point

    la = miny
    while la <= maxy + 0.1:
        lo = minx
        while lo <= maxx + 0.1:
            if poly.buffer(0.08).contains(Point(lo, la)):
                for js in sirene_pages("near_point", dict(base, lat="%.4f" % la, long="%.4f" % lo, radius="15"), log=log):
                    for e in js.get("results") or []:
                        sirene_add(e, out, stats)
            lo += 0.2
        la += 0.2
    log("SIRENE : %d établissements retenus (cercles, %.0f s)" % (len(out), time.time() - t0))
    return list(out.values()), stats, "near_point"
