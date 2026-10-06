"""Tuiles de la table de garages : mise en forme des lieux d'Overture, dédoublonnage, filtre des établissements fermés, écriture et contrôle.

Format (version 1) — voir docs/exploitation.md, section « Table de garages » :
  garages/index.json      {"v":1,"built":"2026-10-06","source":"…","step":0.25,"x0":-10,"closure":"sirene|none|partial","count":N,"tiles":{"172-44":58,…}}
  garages/t/<y>-<x>.json  {"v":1,"g":[{"id","name","lat","lon","kind","phones","web","addr","pc","loc","brand","conf","src"}, …]}
  case : y = floor(lat / 0,25), x = floor((lon + 10) / 0,25) ; kind : r réparation, t pneus, b carrosserie, v vitrage.
Un champ vide est omis. Les fichiers sont déterministes (tri, séparateurs fixes) : deux constructions des mêmes données donnent les mêmes octets.
"""
import gzip
import json
import math
import os
import re
import sys
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402

STEP = 0.25
X0 = -10.0
VERSION = 1
MAX_TILE_BYTES = 600_000  # une case plus lourde fait penser à une erreur de construction (zone mal bornée, doublons)
KIND_LETTERS = "rtbv"
SOURCE_LETTERS = {"meta": "m", "foursquare": "f", "alltheplaces": "a", "pinmeto": "p", "dac": "d"}
# Annuaires et agrégateurs : un « site » qui n'est pas celui du garage (même liste que src/js/modules/mapbox-fiches.js sur la branche mapbox-fiches).
DENY_SITES = ["frmap.org", "pagesjaunes.fr", "mappy.com", "118712.fr", "118218.fr", "cylex.fr", "hoodspot.fr", "societe.com", "pappers.fr", "infogreffe.fr",
              "yelp.com", "yelp.fr", "tripadvisor.com", "tripadvisor.fr", "foursquare.com", "mapquest.com", "waze.com", "google.com", "goo.gl", "g.page"]
TRACKING = re.compile(r"^(utm_|y_source$|fbclid$|gclid$|ref$)", re.I)


# ---------------------------------------------------------------------------------------------------------------------------- cases
def tile_key(lat, lon):
    return "%d-%d" % (math.floor(lat / STEP), math.floor((lon - X0) / STEP))


def tile_keys_for(lat, lon, km):
    """Cases touchées par le carré de ±km autour du point (même calcul que la page)."""
    dlat = km / 111.2
    dlon = km / (111.2 * max(0.01, math.cos(math.radians(lat))))
    y0, y1 = math.floor((lat - dlat) / STEP), math.floor((lat + dlat) / STEP)
    x0, x1 = math.floor((lon - dlon - X0) / STEP), math.floor((lon + dlon - X0) / STEP)
    return ["%d-%d" % (y, x) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


# ---------------------------------------------------------------------------------------------------------------------------- nettoyage
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ - ﻿]")


def clean_text(s, limit):
    t = _CTRL.sub(" ", str(s or ""))
    t = re.sub(r"\s+", " ", t).strip()
    return t[:limit].rstrip()


def clean_site(raw):
    """Adresse web présentable : http(s) seulement, sans identifiants, hors annuaires, sans paramètres de suivi ; sinon ''."""
    s = str(raw or "").strip()
    if not s or len(s) > 300:
        return ""
    if "//" not in s:
        s = "https://" + s
    try:
        u = urlparse(s)
        host = (u.hostname or "").lower()
    except ValueError:
        return ""
    if u.scheme not in ("http", "https") or not host or "." not in host or u.username or u.password:
        return ""
    bare = re.sub(r"^www\.", "", host)
    if any(bare == d or bare.endswith("." + d) for d in DENY_SITES):
        return ""
    q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if not TRACKING.match(k)]
    out = urlunparse((u.scheme, u.netloc.lower(), u.path, u.params, urlencode(q), ""))
    return out if len(out) <= 200 else ""


def source_letters(row):
    ds = {(s or {}).get("dataset") for s in (row.get("sources") or [])}
    letters = {SOURCE_LETTERS.get(str(d).lower(), "x") for d in ds if d and str(d).lower() != "overture"}
    return "".join(sorted(letters))


def build_record(row, kinds):
    """Enregistrement de la tuile pour une ligne d'Overture (« _lat », « _lon » posés par la lecture), ou None si le lieu est inutilisable."""
    name = clean_text((row.get("names") or {}).get("primary"), 120)
    if len(name) < 2 or not re.search(r"[A-Za-zÀ-ÿ]", name):
        return None
    kind = kinds.get((row.get("taxonomy") or {}).get("primary"))
    if not kind:
        return None
    lat, lon = row.get("_lat"), row.get("_lon")
    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and math.isfinite(lat) and math.isfinite(lon)):
        return None
    addr = (row.get("addresses") or [{}])[0] or {}
    rec = {"id": str(row["id"]), "name": name, "lat": round(lat, 5), "lon": round(lon, 5), "kind": kind}
    phones = M.phone_parse([p for p in (row.get("phones") or []) if p])[:2]
    if phones:
        rec["phones"] = phones
    web = ""
    for w in row.get("websites") or []:
        web = clean_site(w)
        if web:
            break
    if web:
        rec["web"] = web
    street = clean_text(addr.get("freeform"), 140)
    if street:
        rec["addr"] = street
    pc = re.sub(r"\D", "", str(addr.get("postcode") or ""))
    if len(pc) == 5:
        rec["pc"] = pc
    loc = clean_text(addr.get("locality"), 80)
    if loc:
        rec["loc"] = loc
    brand = clean_text(((row.get("brand") or {}).get("names") or {}).get("primary"), 60)
    if brand:
        rec["brand"] = brand
    if isinstance(row.get("confidence"), (int, float)) and math.isfinite(row["confidence"]):
        rec["conf"] = round(float(row["confidence"]), 2)
    src = source_letters(row)
    if src:
        rec["src"] = src
    return rec


# ---------------------------------------------------------------------------------------------------------------------------- doublons
def merge_duplicates(records, max_cluster=3):
    """Réunit les lieux qui se recoupent (même nom à 150 m : règle de la page). Renvoie (liste, nombre de lieux absorbés, amas trop gros laissés tels quels)."""
    n = len(records)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    grid = M.Grid(records)
    index = {id(r): i for i, r in enumerate(records)}
    for i, r in enumerate(records):
        # tous les lieux du même nom à 150 m (et non le seul plus proche) : un amas se voit à sa taille
        for o in grid.near(r["lat"], r["lon"]):
            if o is not r and M.meters(r, o) <= M.NEAR_M and M.same_name(r["name"], o["name"]):
                a, b = find(i), find(index[id(o)])
                if a != b:
                    parent[a] = b
    clusters = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(records[i])
    out, absorbed, too_big = [], 0, 0
    for members in clusters.values():
        if len(members) == 1 or len(members) > max_cluster:
            too_big += len(members) > max_cluster
            out.extend(members)
            continue
        members.sort(key=lambda r: (not r.get("phones"), not r.get("web"), -(r.get("conf") or 0), r["id"]))
        head = dict(members[0])
        phones = []
        for m in members:
            for p in m.get("phones", []):
                if p not in phones:
                    phones.append(p)
        if phones:
            head["phones"] = phones[:2]
        for field in ("web", "addr", "pc", "loc", "brand"):
            if not head.get(field):
                v = next((m[field] for m in members if m.get(field)), "")
                if v:
                    head[field] = v
        src = "".join(sorted({c for m in members for c in m.get("src", "")}))
        if src:
            head["src"] = src
        out.append(head)
        absorbed += len(members) - 1
    return out, absorbed, too_big


# ---------------------------------------------------------------------------------------------------------------------------- établissements fermés
def drop_closed(records, closed, active):
    """Retire les lieux qui rejoignent un établissement fermé du registre (même nom à 150 m) sans en rejoindre un actif. Renvoie (gardés, retirés)."""
    if not closed:
        return records, []
    gc, ga = M.Grid(closed), M.Grid(active)
    kept, dropped = [], []
    for r in records:
        c = M.pick_place(r, gc.near(r["lat"], r["lon"]))
        if c is not None and M.pick_place(r, ga.near(r["lat"], r["lon"])) is None:
            dropped.append(r)
        else:
            kept.append(r)
    return kept, dropped


# ---------------------------------------------------------------------------------------------------------------------------- écriture
def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False) + "\n"


def write_tiles(records, out_dir, meta):
    """Écrit index.json et t/<case>.json sous out_dir (vidé des anciennes cases). Renvoie les statistiques d'écriture."""
    tdir = os.path.join(out_dir, "t")
    os.makedirs(tdir, exist_ok=True)
    for f in os.listdir(tdir):
        if f.endswith(".json"):
            os.remove(os.path.join(tdir, f))
    by_tile = {}
    for r in records:
        by_tile.setdefault(tile_key(r["lat"], r["lon"]), []).append(r)
    sizes = {}
    for key in sorted(by_tile, key=lambda k: tuple(int(x) for x in k.split("-"))):
        items = sorted(by_tile[key], key=lambda r: (r["lat"], r["lon"], r["id"]))
        body = dumps({"v": VERSION, "g": items}).encode("utf-8")
        with open(os.path.join(tdir, key + ".json"), "wb") as f:
            f.write(body)
        sizes[key] = (len(body), len(gzip.compress(body, 9, mtime=0)))
    index = {
        "v": VERSION,
        "built": meta["built"],
        "source": meta["source"],
        "step": STEP,
        "x0": X0,
        "closure": meta["closure"],
        "count": len(records),
        "tiles": {k: len(by_tile[k]) for k in sizes},
    }
    if meta.get("closure_missing"):
        index["closure_missing"] = sorted(meta["closure_missing"])
    with open(os.path.join(out_dir, "index.json"), "wb") as f:
        f.write(dumps(index).encode("utf-8"))
    return {"tiles": len(sizes), "bytes": sum(a for a, _ in sizes.values()), "gz": sum(b for _, b in sizes.values()), "sizes": sizes}


# ---------------------------------------------------------------------------------------------------------------------------- contrôle
def validate_dir(out_dir, min_entries=0):
    """Problèmes d'une sortie (liste vide : conforme). Utilisé par la construction, par les tests et par le workflow."""
    problems = []
    try:
        index = json.load(open(os.path.join(out_dir, "index.json"), encoding="utf-8"))
    except (OSError, ValueError) as e:
        return ["index.json illisible : %s" % e]
    if index.get("v") != VERSION:
        problems.append("version inconnue : %r" % index.get("v"))
    for k in ("built", "source", "step", "x0", "closure", "count", "tiles"):
        if k not in index:
            problems.append("index.json : « %s » manque" % k)
    if problems:
        return problems
    if index["step"] != STEP or index["x0"] != X0:
        problems.append("index.json : pas ou origine différents de ceux de la page")
    if index["closure"] not in ("sirene", "none", "partial"):
        problems.append("index.json : « closure » inconnu : %r" % index["closure"])
    seen, total = set(), 0
    tdir = os.path.join(out_dir, "t")
    files = sorted(f for f in os.listdir(tdir) if f.endswith(".json")) if os.path.isdir(tdir) else []
    if sorted(index["tiles"]) != sorted(f[:-5] for f in files):
        problems.append("index.json et dossier t/ ne listent pas les mêmes cases")
    for f in files:
        key = f[:-5]
        path = os.path.join(tdir, f)
        if os.path.getsize(path) > MAX_TILE_BYTES:
            problems.append("%s : %d octets, au-delà de %d" % (f, os.path.getsize(path), MAX_TILE_BYTES))
        try:
            tile = json.load(open(path, encoding="utf-8"))
        except ValueError as e:
            problems.append("%s illisible : %s" % (f, e))
            continue
        items = tile.get("g")
        if tile.get("v") != VERSION or not isinstance(items, list):
            problems.append("%s : forme inattendue" % f)
            continue
        if index["tiles"].get(key) != len(items):
            problems.append("%s : %d garages, l'index en annonce %r" % (f, len(items), index["tiles"].get(key)))
        for g in items:
            total += 1
            where = "%s/%s" % (f, g.get("id"))
            if not re.fullmatch(r"[0-9a-f-]{8,40}", str(g.get("id", ""))):
                problems.append("%s : identifiant inattendu" % where)
            if g.get("id") in seen:
                problems.append("%s : identifiant en double" % where)
            seen.add(g.get("id"))
            if not (isinstance(g.get("name"), str) and 2 <= len(g["name"]) <= 120):
                problems.append("%s : nom inattendu" % where)
            if not (isinstance(g.get("lat"), (int, float)) and isinstance(g.get("lon"), (int, float))) or tile_key(g["lat"], g["lon"]) != key:
                problems.append("%s : position hors de sa case" % where)
            if g.get("kind") not in tuple(KIND_LETTERS):
                problems.append("%s : type inconnu %r" % (where, g.get("kind")))
            for p in g.get("phones", []):
                if not re.fullmatch(r"\+\d{10,15}", p):
                    problems.append("%s : numéro hors format international" % where)
            if "phones" in g and not (1 <= len(g["phones"]) <= 2):
                problems.append("%s : 1 ou 2 numéros attendus" % where)
            if g.get("web") and not re.match(r"https?://[^\s/]+", g["web"]):
                problems.append("%s : site inattendu" % where)
            extra = set(g) - {"id", "name", "lat", "lon", "kind", "phones", "web", "addr", "pc", "loc", "brand", "conf", "src"}
            if extra:
                problems.append("%s : champs inconnus %s" % (where, sorted(extra)))
    if total != index["count"]:
        problems.append("%d garages dans les cases, l'index en annonce %r" % (total, index["count"]))
    if total < min_entries:
        problems.append("%d garages seulement (minimum demandé : %d)" % (total, min_entries))
    return problems
