"""Rapprochement garage <-> lieu : port exact de src/js/modules/mapbox-fiches.js (sameName, hasRealName, pickPlace, meters).

Le même critère que celui de la page est utilisé pour l'évaluation, afin que « 40 % des garages trouvent un lieu » veuille dire
ce que la page ferait réellement (position à 150 m ET même nom ; garage sans nom : seul lieu à moins de 40 m).
"""
import math
import re
import unicodedata

NEAR_M = 150
SAME_SPOT_M = 40
GENERIC = {
    "garage", "garages", "auto", "autos", "automobile", "automobiles", "sarl", "eurl", "sas", "sasu", "ets", "centre", "station",
    "service", "services", "reparation", "mecanique", "atelier", "societe", "entreprise", "carrosserie", "carosserie", "pneu",
    "pneus", "tires", "controle", "technique", "peinture", "depannage", "vitrage", "pieces", "accessoires", "multimarque",
    "multimarques", "express", "les", "des", "du", "de", "la", "le", "et", "and", "pro",
}


def meters(a, b):
    r = math.radians
    h = math.sin(r(b["lat"] - a["lat"]) / 2) ** 2 + math.cos(r(a["lat"])) * math.cos(r(b["lat"])) * math.sin(r(b["lon"] - a["lon"]) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def fold(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    return re.sub("[̀-ͯ]", "", s).lower()


def tokens(s):
    t = re.sub(r"['’`-]", " ", fold(s))
    return {x for x in re.split(r"[^a-z0-9]+", t) if len(x) >= 3 and x not in GENERIC}


def compact(s):
    return re.sub(r"[^a-z0-9]+", "", fold(s))


def same_name(a, b):
    tb = tokens(b)
    for t in tokens(a):
        if t in tb:
            return True
    ca, cb = compact(a), compact(b)
    return len(ca) >= 5 and len(cb) >= 5 and (cb in ca or ca in cb)


def has_real_name(name):
    return bool(name) and not re.match(r"^(Garage \(nom|Spécialiste pneus \(sans)", name)


def pick_place(garage, places, near_m=NEAR_M, spot_m=SAME_SPOT_M):
    """Le lieu qui correspond au garage {name, lat, lon}, ou None (même règle que la page ; near_m et spot_m réglables pour mesurer la sensibilité)."""
    near = [(p, meters(garage, p)) for p in places]
    near = [x for x in near if x[1] <= near_m]
    spot = [x for x in near if x[1] <= spot_m]
    named = has_real_name(garage.get("name"))
    best = None
    for p, d in near:
        ok = same_name(garage.get("name"), p.get("name")) if named else (d <= spot_m and len(spot) == 1)
        if ok and (best is None or d < best[1]):
            best = (p, d)
    return best[0] if best else None


# ---- Téléphone : port de phoneParse (src/js/modules/phone.js), pour ne compter que les numéros que la page saurait afficher ----
_SPLIT = re.compile(r"\s*(?:[;,/|]|\bou\b|\bet\b)\s*", re.I)
_NUM = re.compile(r"(\+|00)?[\s(]*\d[\d\s().-]*\d")


def phone_parse(raw):
    out, seen = [], set()
    for part in _SPLIT.split(str(raw or "")):
        part = re.sub(r"\(\s*0\s*\)", " ", part)
        m = _NUM.search(part)
        if not m:
            continue
        d = re.sub(r"\D", "", m.group(0))
        pref = m.group(1)
        if pref == "00":
            d = d[2:]
        tel = None
        if pref:
            if d.startswith("33"):
                d = re.sub(r"^0", "", d[2:])
                if len(d) != 9:
                    continue
                d = "0" + d
            elif len(d) < 10 or len(d) > 15:
                continue
            else:
                tel = "+" + d
        if not tel:
            if not re.fullmatch(r"0[1-9]\d{8}", d):
                continue
            tel = "+33" + d[1:]
        if tel not in seen:
            seen.add(tel)
            out.append(tel)
    return out


def phone_ok(raw):
    """Vrai si au moins un numéro est reconnu (raw : texte ou liste de textes)."""
    if isinstance(raw, (list, tuple)):
        raw = " ; ".join(str(x) for x in raw if x)
    return bool(phone_parse(raw))


def mobile_only(raw):
    """Vrai si tous les numéros reconnus sont des mobiles français (06/07) : utile mais moins stable qu'un fixe d'atelier."""
    if isinstance(raw, (list, tuple)):
        raw = " ; ".join(str(x) for x in raw if x)
    t = phone_parse(raw)
    return bool(t) and all(re.match(r"\+33[67]", x) for x in t)


# ---- Outils d'évaluation ----------------------------------------------------------------------------------------------------------
def tels(raw):
    """Numéros reconnus (format +33…), dédoublonnés."""
    if isinstance(raw, (list, tuple)):
        raw = " ; ".join(str(x) for x in raw if x)
    return phone_parse(raw)


def host_of(url):
    """Domaine d'une adresse web (sans « www. »), '' si illisible."""
    from urllib.parse import urlparse

    u = str(url or "").strip()
    if not u:
        return ""
    try:
        h = urlparse(u if "//" in u else "//" + u).hostname or ""
    except ValueError:
        return ""
    return re.sub(r"^www\.", "", h.lower())


class Grid:
    """Index spatial en cases de 0,003° de latitude sur 0,004° de longitude (environ 330 m sur 320 m) : near() rend les éléments proches."""

    LAT, LON = 0.003, 0.004

    def __init__(self, items):
        self.cells = {}
        for it in items:
            self.cells.setdefault(self._key(it["lat"], it["lon"]), []).append(it)

    def _key(self, lat, lon):
        return (math.floor(lat / self.LAT), math.floor(lon / self.LON))

    def near(self, lat, lon, radius_m=NEAR_M):
        dlat = int(math.ceil((radius_m / 111320) / self.LAT))
        dlon = int(math.ceil((radius_m / (111320 * max(0.01, math.cos(math.radians(lat))))) / self.LON))
        ky, kx = self._key(lat, lon)
        out = []
        for i in range(ky - dlat, ky + dlat + 1):
            for j in range(kx - dlon, kx + dlon + 1):
                out.extend(self.cells.get((i, j), ()))
        return out


def link(a_items, b_items, near_m=NEAR_M, spot_m=SAME_SPOT_M):
    """Pour chaque élément de a_items, l'élément de b_items que la règle de la page retient (ou None)."""
    g = Grid(b_items)
    return [pick_place(a, g.near(a["lat"], a["lon"], near_m), near_m, spot_m) for a in a_items]


# ---- Rapprochement par adresse (plafond du recouvrement : le nom du registre est souvent la raison sociale, pas l'enseigne) -------------------
STREET_STOP = {
    "rue", "avenue", "chemin", "route", "impasse", "allee", "boulevard", "place", "zone", "lotissement", "rond", "point", "quai", "cours", "lieu",
    "residence", "centre", "commercial", "parc", "industrielle", "artisanale", "activites", "bis", "ter", "lieudit", "sans", "nom",
}


def addr_parts(freeform, postcode=None):
    """(numéro, mots de la voie, code postal) d'une adresse libre. Le texte après le code postal (la commune) est ignoré."""
    t = fold(freeform)
    pc = None
    m = re.search(r"\b(\d{5})\b", t)
    if m:
        pc = m.group(1)
        t = t[: m.start()]
    if not pc and postcode:
        pc = re.sub(r"\D", "", str(postcode))[:5] or None
    n = re.match(r"\s*(\d{1,4})\b", t)
    words = {w for w in re.split(r"[^a-z]+", t) if len(w) >= 4 and w not in STREET_STOP}
    return (n.group(1) if n else None), words, pc


def same_address(a, b):
    """Même numéro dans la même voie : deux adresses qui donnent un numéro et au moins un mot de voie en commun."""
    na, wa, _ = a
    nb, wb, _ = b
    return bool(na and nb and na == nb and wa & wb)


def link_loose(a_items, b_items, near_m=NEAR_M, spot_m=SAME_SPOT_M):
    """Comme link(), mais deux éléments proches (≤ near_m) qui donnent la même adresse (numéro + voie) sont aussi appariés, même sans nom commun."""
    g = Grid(b_items)
    out = []
    for a in a_items:
        cand = g.near(a["lat"], a["lon"], near_m)
        p = pick_place(a, cand, near_m, spot_m)
        if p is None and a.get("addr") and a["addr"][0]:
            best = None
            for c in cand:
                if c.get("addr") and same_address(a["addr"], c["addr"]):
                    d = meters(a, c)
                    if d <= near_m and (best is None or d < best[1]):
                        best = (c, d)
            p = best[0] if best else None
        out.append(p)
    return out


def nearest_within(a_items, b_items, radius_m):
    """Pour chaque élément de a_items : nombre d'éléments de b_items à moins de radius_m (sans condition de nom)."""
    g = Grid(b_items)
    return [sum(1 for c in g.near(a["lat"], a["lon"], radius_m) if meters(a, c) <= radius_m) for a in a_items]
