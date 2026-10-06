"""Lecture d'Overture Maps (thème « places ») sur S3, par plages d'octets : seuls les groupes de lignes (row groups) dont la boîte englobante touche la zone
sont téléchargés. Le fichier est public, sans compte ni clé. Colonnes lues : celles dont la table a besoin, jamais les e-mails ni les réseaux sociaux.
"""
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com/"
NS = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}

# Catégories Overture retenues (taxonomy.primary) et leur lettre dans les tuiles : r réparation, t pneus, b carrosserie, v vitrage.
# Écartées exprès : « automotive_service » (fourre-tout : un lieu sur deux n'est pas un garage, beaucoup sont des centres de contrôle technique, que la
# page traite à part avec les prix officiels), car_inspection, car_wash, motorcycle_repair, truck_repair, towing_service.
KINDS = {
    "automotive_repair": "r",
    "tire_dealer_and_repair": "t",
    "tire_shop": "t",
    "auto_body_shop": "b",
    "auto_glass_service": "v",
}
COLUMNS = ["id", "names", "taxonomy", "confidence", "websites", "phones", "addresses", "sources", "bbox", "brand"]


def _get(url, tries=4, timeout=60):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pixcar-garages/1.0 (+https://github.com/Floriancrt/Pixcar)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise last


def s3_list(prefix, delimiter=None):
    out_keys, out_prefixes, token = [], [], None
    while True:
        q = {"list-type": "2", "prefix": prefix}
        if delimiter:
            q["delimiter"] = delimiter
        if token:
            q["continuation-token"] = token
        root = ET.fromstring(_get(BUCKET + "?" + urllib.parse.urlencode(q)))
        for c in root.findall("s:Contents", NS):
            out_keys.append((c.find("s:Key", NS).text, int(c.find("s:Size", NS).text)))
        for p in root.findall("s:CommonPrefixes/s:Prefix", NS):
            out_prefixes.append(p.text)
        nxt = root.find("s:NextContinuationToken", NS)
        if nxt is None:
            return out_keys, out_prefixes
        token = nxt.text


def latest_release():
    _, prefixes = s3_list("release/", "/")
    return sorted(p.rstrip("/") for p in prefixes)[-1]


def theme_files(release, theme, typ):
    keys, _ = s3_list(f"{release}/theme={theme}/type={typ}/")
    return [k for k, _ in keys if k.endswith(".parquet")]


def open_fs():
    import fsspec

    return fsspec.filesystem("https", client_kwargs={"trust_env": True})


def row_group_hits(fs, key, bbox):
    """Numéros des groupes de lignes dont la boîte englobante (statistiques du pied de page) touche bbox = (ouest, sud, est, nord)."""
    import pyarrow.parquet as pq

    with fs.open(BUCKET + key, "rb", block_size=8 * 1024 * 1024, cache_type="readahead") as f:
        pf = pq.ParquetFile(f)
        md = pf.metadata
        names = [md.schema.column(i).path for i in range(md.num_columns)]
        idx = {n: i for i, n in enumerate(names)}
        need = ["bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"]
        if not all(n in idx for n in need):
            return list(range(md.num_row_groups))
        hits = []
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            s = {n: rg.column(idx[n]).statistics for n in need}
            if any(v is None or not v.has_min_max for v in s.values()):
                hits.append(g)
                continue
            if s["bbox.xmin"].min <= bbox[2] and s["bbox.xmax"].max >= bbox[0] and s["bbox.ymin"].min <= bbox[3] and s["bbox.ymax"].max >= bbox[1]:
                hits.append(g)
        return hits


def read_groups(fs, key, groups, columns, tries=3):
    import pyarrow.parquet as pq

    rows = []
    for g in groups:
        for t in range(tries):
            try:
                with fs.open(BUCKET + key, "rb", block_size=16 * 1024 * 1024, cache_type="readahead") as f:
                    pf = pq.ParquetFile(f)
                    cols = [c for c in columns if c in pf.schema_arrow.names]
                    rows.extend(pf.read_row_group(g, columns=cols).to_pylist())
                break
            except Exception:  # noqa: BLE001
                if t == tries - 1:
                    raise
                time.sleep(3 * (t + 1))
    return rows


def county_polygon(name, rough_bbox, release, log=print):
    """Contour d'un département (sous-type « county » des divisions d'Overture, pays FR) ; rough_bbox = boîte large qui le contient."""
    from shapely import from_wkb

    fs = open_fs()
    for k in theme_files(release, "divisions", "division_area"):
        hits = row_group_hits(fs, k, rough_bbox)
        if not hits:
            continue
        for r in read_groups(fs, k, hits, ["country", "subtype", "names", "geometry"]):
            if r.get("country") == "FR" and r.get("subtype") == "county" and (r.get("names") or {}).get("primary") == name:
                geom = from_wkb(r["geometry"])
                log("Contour de %s : %s, boîte %s" % (name, geom.geom_type, [round(v, 3) for v in geom.bounds]))
                return geom
    raise RuntimeError("contour introuvable pour " + name)


def read_places(poly, release, log=print, country="FR"):
    """Lieux de garage de la zone « poly » (forme shapely) : lignes brutes (dict) avec la position au centre de la boîte du lieu."""
    import numpy as np
    from shapely import contains_xy

    fs = open_fs()
    minx, miny, maxx, maxy = poly.bounds
    bbox = (minx - 0.01, miny - 0.01, maxx + 0.01, maxy + 0.01)
    out, scanned, groups, t0 = [], 0, 0, time.time()
    for k in theme_files(release, "places", "place"):
        hits = row_group_hits(fs, k, bbox)
        if not hits:
            continue
        rows = read_groups(fs, k, hits, COLUMNS)
        scanned += len(rows)
        groups += len(hits)
        if not rows:
            continue
        xs = np.array([(r["bbox"]["xmin"] + r["bbox"]["xmax"]) / 2 for r in rows])
        ys = np.array([(r["bbox"]["ymin"] + r["bbox"]["ymax"]) / 2 for r in rows])
        for r, ok in zip(rows, contains_xy(poly, xs, ys)):
            if not ok:
                continue
            if ((r.get("taxonomy") or {}).get("primary")) not in KINDS:
                continue
            addr = (r.get("addresses") or [{}])[0] or {}
            if country and addr.get("country") not in (country, None):
                continue
            b = r["bbox"]
            r["_lat"], r["_lon"] = (b["ymin"] + b["ymax"]) / 2, (b["xmin"] + b["xmax"]) / 2
            out.append(r)
    log("Overture %s : %d groupes de lignes, %d lieux lus, %d garages dans la zone (%.0f s)" % (release, groups, scanned, len(out), time.time() - t0))
    return out, scanned
