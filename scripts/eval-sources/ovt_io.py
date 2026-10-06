"""Lecture d'Overture Maps sur S3 par plages d'octets : on ne télécharge que les groupes de lignes (row groups) dont la boîte englobante touche la zone."""
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import fsspec
import pyarrow.parquet as pq

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com/"
NS = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}


def _get(url, tries=4, timeout=60):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pixcar-eval/1.0"})
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
    return fsspec.filesystem("https", client_kwargs={"trust_env": True})


def row_group_hits(fs, key, bbox):
    """Numéros des groupes de lignes dont la boîte englobante (statistiques du pied de page) touche bbox = (xmin, ymin, xmax, ymax)."""
    with fs.open(BUCKET + key, "rb", block_size=8 * 1024 * 1024, cache_type="readahead") as f:
        pf = pq.ParquetFile(f)
        md = pf.metadata
        names = [md.schema.column(i).path for i in range(md.num_columns)]
        idx = {n: i for i, n in enumerate(names)}
        need = ["bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"]
        if not all(n in idx for n in need):
            return list(range(md.num_row_groups)), md.num_row_groups, md.num_rows
        hits = []
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            s = {n: rg.column(idx[n]).statistics for n in need}
            if any(v is None or not v.has_min_max for v in s.values()):
                hits.append(g)
                continue
            if s["bbox.xmin"].min <= bbox[2] and s["bbox.xmax"].max >= bbox[0] and s["bbox.ymin"].min <= bbox[3] and s["bbox.ymax"].max >= bbox[1]:
                hits.append(g)
        return hits, md.num_row_groups, md.num_rows


def read_groups(fs, key, groups, columns, tries=3):
    """Lignes (dicts) des groupes demandés, colonnes limitées à celles utiles (minimisation : pas d'e-mails ni de réseaux sociaux)."""
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
