"""Établissements du registre SIRENE (API « Recherche d'entreprises », publique, sans clé) pour repérer les lieux d'Overture qui ont disparu.

On ne garde rien du registre dans les tuiles : il sert seulement, le temps de la construction, à écarter un lieu d'Overture qui rejoint un établissement
FERMÉ (même nom, 150 m) sans en rejoindre un actif. Les établissements d'entrepreneurs individuels ne sont ni conservés ni publiés.
Limites de l'API : 7 requêtes par seconde, 10 000 résultats par recherche (400 pages de 25) ; au-delà, la recherche est coupée par état administratif.
"""
import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://recherche-entreprises.api.gouv.fr/search"
NAFS = ("45.20A", "45.20B", "45.32Z")  # entretien de véhicules légers, d'autres véhicules, commerce d'équipements automobiles
DEPTS_METRO = [("%02d" % i) for i in range(1, 96) if i != 20] + ["2A", "2B"]
CAP_RESULTS = 9900
UA = "pixcar-garages/1.0 (+https://github.com/Floriancrt/Pixcar)"


class Limiter:
    """Au plus une requête toutes les `interval` secondes, tous fils confondus."""

    def __init__(self, interval=0.18):
        self.interval, self.next_at, self.lock = interval, 0.0, threading.Lock()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            delay = max(0.0, self.next_at - now)
            self.next_at = max(now, self.next_at) + self.interval
        if delay:
            time.sleep(delay)


def get_json(url, limiter, tries=6, timeout=60):
    last = None
    for i in range(tries):
        limiter.wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(30, 2 * (i + 1) ** 2))
                continue
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (i + 1))
    raise last


def parse_page(js, active, closed, stats):
    """Range les établissements d'une page de résultats dans « active » et « closed » (dictionnaires par SIRET)."""
    for e in js.get("results") or []:
        for s in e.get("matching_etablissements") or []:
            siret = s.get("siret")
            if not siret:
                continue
            is_closed = bool(s.get("etat_administratif") and s["etat_administratif"] != "A")
            target = closed if is_closed else active
            if siret in target:
                continue
            try:
                lat, lon = float(s.get("latitude")), float(s.get("longitude"))
                if not (math.isfinite(lat) and math.isfinite(lon)):
                    raise ValueError
            except (TypeError, ValueError):
                stats["sans_position"] += 1
                continue
            naf = str(s.get("activite_principale") or e.get("activite_principale") or "")
            if not (naf.startswith("45.20") or naf == "45.32Z"):
                continue
            ens = [x for x in (s.get("liste_enseignes") or []) if x]
            name = ens[0] if ens else (s.get("nom_commercial") or e.get("nom_complet") or e.get("nom_raison_sociale") or "")
            target[siret] = {"name": str(name), "lat": lat, "lon": lon, "siret": str(siret)}


def fetch_query(params, limiter, active, closed, stats, log=print):
    """Toutes les pages d'une recherche. Renvoie le nombre de résultats annoncé."""
    base = {"per_page": "25", "limite_matching_etablissements": "25", "minimal": "true", "include": "matching_etablissements"}
    base.update(params)
    page, total = 1, 0
    while True:
        js = get_json(API + "?" + urllib.parse.urlencode(dict(base, page=str(page))), limiter)
        if page == 1:
            total = int(js.get("total_results") or 0)
        parse_page(js, active, closed, stats)
        pages = min(int(js.get("total_pages") or 1), 400)
        if page >= pages:
            return total
        page += 1


def fetch_dept(code, limiter, log=print):
    """(actifs, fermés, statistiques) d'un département, une recherche par NAF (coupée par état administratif si elle dépasse la limite de l'API)."""
    active, closed, stats = {}, {}, {"sans_position": 0, "requetes": 0, "coupees": 0}
    for naf in NAFS:
        total = fetch_query({"departement": code, "activite_principale": naf}, limiter, active, closed, stats)
        stats["requetes"] += 1
        if total >= CAP_RESULTS:
            stats["coupees"] += 1
            for etat in ("A", "C"):
                fetch_query({"departement": code, "activite_principale": naf, "etat_administratif": etat}, limiter, active, closed, stats)
                stats["requetes"] += 1
    return active, closed, stats


def load(codes, log=print, workers=4, fetcher=None):
    """Registre des départements demandés. Renvoie (actifs, fermés, codes sans réponse). Un département en échec n'arrête pas la construction."""
    fetcher = fetcher or fetch_dept
    limiter = Limiter()
    active, closed, missing = {}, {}, []
    t0 = time.time()

    def one(code):
        try:
            return code, fetcher(code, limiter, log), None
        except Exception as e:  # noqa: BLE001
            return code, None, e

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for code, res, err in pool.map(one, codes):
            if err is not None:
                missing.append(code)
                log("SIRENE : département %s sans réponse (%s)" % (code, type(err).__name__))
                continue
            a, c, st = res
            active.update(a)
            closed.update(c)
            log("SIRENE %s : %d actifs, %d fermés (%d requêtes%s)" % (code, len(a), len(c), st["requetes"], ", recherche coupée" if st["coupees"] else ""))
    log("SIRENE : %d établissements actifs et %d fermés pour %d départements, %d sans réponse (%.0f s)" % (len(active), len(closed), len(codes), len(missing), time.time() - t0))
    return list(active.values()), list(closed.values()), missing
