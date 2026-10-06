"""Statistiques de couverture : taux de remplissage, recouvrement entre sources, garages réunis, apport d'Overture à la liste de Pixcar.

Le rapprochement est celui de la page (même nom ET à 150 m ; garage sans nom : seul lieu à moins de 40 m), réglable pour mesurer la sensibilité.
Toutes les sorties sont des agrégats : aucun numéro de téléphone ni adresse web n'est écrit.
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402

LABEL = {"osm": "OpenStreetMap", "ovt": "Overture", "sir": "SIRENE"}
TOULOUSE = {"lat": 43.6045, "lon": 1.4442}
CAZERES = {"lat": 43.217426, "lon": 1.10145}  # centre du banc d'essai de Cazères


def pct(a, b):
    return 100.0 * a / b if b else 0.0


def cell(a, b):
    return "%d (%.0f %%)" % (a, pct(a, b))


def zone(e):
    d = M.meters(TOULOUSE, e)
    return "Toulouse ≤ 12 km" if d <= 12000 else ("couronne 12–30 km" if d <= 30000 else "reste (> 30 km)")


ZONES = ["Toulouse ≤ 12 km", "couronne 12–30 km", "reste (> 30 km)"]


# ---------------------------------------------------------------------------------------------------------------------------- remplissage
def fill_table(rows):
    """rows : [(libellé, liste, horaires_possibles)]"""
    out = ["| Source | Garages | Avec nom | Téléphone | Site | Horaires |", "|---|---:|---:|---:|---:|---:|"]
    for label, L, hours_ok in rows:
        n = len(L)
        out.append(
            "| %s | %d | %s | %s | %s | %s |"
            % (label, n, cell(sum(1 for x in L if x["name"]), n), cell(sum(x["phone"] for x in L), n), cell(sum(x["web"] for x in L), n), cell(sum(x["hours"] for x in L), n) if hours_ok else "sans objet")
        )
    return out


# ---------------------------------------------------------------------------------------------------------------------------- recouvrement
def overlap_table(sets, near_m, spot_m, linker=None):
    linker = linker or M.link
    names = list(sets)
    out = ["| Garages de ↓ trouvés dans → | " + " | ".join(LABEL[n] for n in names) + " |", "|---|" + "---:|" * len(names)]
    for a in names:
        cells = []
        for b in names:
            if a == b:
                cells.append("—")
                continue
            m = linker(sets[a], sets[b], near_m, spot_m)
            hit = [p for p in m if p]
            cells.append("%s, dont avec téléphone %d" % (cell(len(hit), len(sets[a])), sum(1 for p in hit if p["phone"])))
        out.append("| %s (%d) | %s |" % (LABEL[a], len(sets[a]), " | ".join(cells)))
    return out


# ---------------------------------------------------------------------------------------------------------------------------- garages réunis
def entities(sets, near_m, spot_m, linker=None):
    """Garages réunis : deux éléments de sources différentes sont un même garage quand la règle de la page les apparie dans un sens ou l'autre."""
    linker = linker or M.link
    nodes = [(s, it) for s, L in sets.items() for it in L]
    index = {id(it): i for i, (_, it) in enumerate(nodes)}
    parent = list(range(len(nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, A in sets.items():
        for b, B in sets.items():
            if a == b:
                continue
            for x, p in zip(A, linker(A, B, near_m, spot_m)):
                if p:
                    ra, rb = find(index[id(x)]), find(index[id(p)])
                    if ra != rb:
                        parent[ra] = rb
    comps = collections.defaultdict(list)
    for i, (s, it) in enumerate(nodes):
        comps[find(i)].append((s, it))
    ents = []
    for c in comps.values():
        srcs = frozenset(s for s, _ in c)
        first = c[0][1]
        ents.append(
            {
                "srcs": srcs,
                "lat": first["lat"],
                "lon": first["lon"],
                "phone": any(it["phone"] for _, it in c),
                "web": any(it["web"] for _, it in c),
                "hours": any(it["hours"] for _, it in c),
                "phone_by": {s: any(it["phone"] for s2, it in c if s2 == s) for s in srcs},
                "web_by": {s: any(it["web"] for s2, it in c if s2 == s) for s in srcs},
                "hours_by": {s: any(it["hours"] for s2, it in c if s2 == s) for s in srcs},
                "size": len(c),
                "items": c,
            }
        )
    return ents


COMBOS = [
    ({"osm", "ovt", "sir"}, "OSM + Overture + SIRENE"),
    ({"osm", "ovt"}, "OSM + Overture"),
    ({"osm", "sir"}, "OSM + SIRENE"),
    ({"ovt", "sir"}, "Overture + SIRENE"),
    ({"osm"}, "OSM seul"),
    ({"ovt"}, "Overture seul"),
    ({"sir"}, "SIRENE seul"),
]


def combo_table(ents):
    out = ["| Présent dans | Garages | Téléphone (une source au moins) | Site | Horaires |", "|---|---:|---:|---:|---:|"]
    for srcs, label in COMBOS:
        L = [e for e in ents if set(e["srcs"]) == srcs]
        if not L:
            continue
        out.append("| %s | %d | %s | %s | %s |" % (label, len(L), cell(sum(e["phone"] for e in L), len(L)), cell(sum(e["web"] for e in L), len(L)), cell(sum(e["hours"] for e in L), len(L))))
    out.append("| **Total** | **%d** | %s | %s | %s |" % (len(ents), cell(sum(e["phone"] for e in ents), len(ents)), cell(sum(e["web"] for e in ents), len(ents)), cell(sum(e["hours"] for e in ents), len(ents))))
    return out


# ---------------------------------------------------------------------------------------------------------------------------- liste de Pixcar
def pixcar_list(ents):
    """La liste d'aujourd'hui = garages présents dans OpenStreetMap ou SIRENE. Que gagnerait-elle d'une table qui y joint Overture ?"""
    L = [e for e in ents if "osm" in e["srcs"] or "sir" in e["srcs"]]
    n = len(L)
    r = {
        "n": n,
        "phone_today": sum(1 for e in L if e["phone_by"].get("osm")),
        "phone_ovt": sum(1 for e in L if e["phone_by"].get("osm") or e["phone_by"].get("ovt")),
        "web_today": sum(1 for e in L if e["web_by"].get("osm")),
        "web_ovt": sum(1 for e in L if e["web_by"].get("osm") or e["web_by"].get("ovt")),
        "hours_today": sum(1 for e in L if e["hours_by"].get("osm")),
        "orphans": sum(1 for e in L if set(e["srcs"]) == {"sir"}),
        "ovt_only": sum(1 for e in ents if set(e["srcs"]) == {"ovt"}),
        "ovt_only_phone": sum(1 for e in ents if set(e["srcs"]) == {"ovt"} and e["phone"]),
    }
    return r


def list_lines(label, r):
    n = r["n"]
    return [
        "- %s : liste de %d garages. Téléphone aujourd'hui (OpenStreetMap seul) %s ; avec Overture %s. Site %s puis %s. Horaires %s. "
        "Garages sans aucune coordonnée possible dans les sources ouvertes (SIRENE seul) : %s. Garages qu'Overture ajouterait à la liste : %d, dont %d avec téléphone."
        % (label, n, cell(r["phone_today"], n), cell(r["phone_ovt"], n), cell(r["web_today"], n), cell(r["web_ovt"], n), cell(r["hours_today"], n), cell(r["orphans"], n), r["ovt_only"], r["ovt_only_phone"])
    ]


# ---------------------------------------------------------------------------------------------------------------------------- qualité
def agreement(A, B, near_m, spot_m):
    """Sur les paires A→B appariées : concordance des téléphones et des sites quand les deux en ont."""
    pairs = [(a, p) for a, p in zip(A, M.link(A, B, near_m, spot_m)) if p]
    both_t = [(a, p) for a, p in pairs if a["tels"] and p["tels"]]
    same_t = sum(1 for a, p in both_t if set(a["tels"]) & set(p["tels"]))
    both_w = [(a, p) for a, p in pairs if a["hosts"] and p["hosts"]]
    same_w = sum(1 for a, p in both_w if set(a["hosts"]) & set(p["hosts"]))
    return {"pairs": len(pairs), "tel_both": len(both_t), "tel_same": same_t, "web_both": len(both_w), "web_same": same_w}


def duplicates(L, near_m, spot_m):
    """Éléments d'une source qui en recoupent un autre de la même source (même nom à 150 m)."""
    g = M.Grid(L)
    n = 0
    for x in L:
        others = [y for y in g.near(x["lat"], x["lon"], near_m) if y is not x]
        if M.pick_place(x, others, near_m, spot_m):
            n += 1
    return n


def shared_phones(L, k=3):
    c = collections.Counter(t for x in L for t in set(x["tels"]))
    return sum(1 for x in L if any(c[t] >= k for t in x["tels"]))


# ---------------------------------------------------------------------------------------------------------------------------- zones
def zone_table(sets, ents):
    out = ["| Zone | OSM | dont tél. | Overture | dont tél. | SIRENE | Liste Pixcar | tél. aujourd'hui | tél. avec Overture | Overture ajoute |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for z in ZONES + ["Haute-Garonne entière"]:
        pick = (lambda e: True) if z == "Haute-Garonne entière" else (lambda e, z=z: zone(e) == z)
        S = {k: [x for x in L if pick(x)] for k, L in sets.items()}
        E = [e for e in ents if pick(e)]
        r = pixcar_list(E)
        out.append(
            "| %s | %d | %s | %d | %s | %d | %d | %s | %s | %d |"
            % (z, len(S["osm"]), cell(sum(x["phone"] for x in S["osm"]), len(S["osm"])), len(S["ovt"]), cell(sum(x["phone"] for x in S["ovt"]), len(S["ovt"])), len(S["sir"]), r["n"], cell(r["phone_today"], r["n"]), cell(r["phone_ovt"], r["n"]), r["ovt_only"])
        )
    return out


# ---------------------------------------------------------------------------------------------------------------------------- plafond du recouvrement
def proximity_table(sets, radii=(25, 50, 100)):
    """Part des garages de ↓ qui ont au moins un garage de l'autre source à moins de r mètres, sans condition de nom (borne haute du recouvrement)."""
    names = list(sets)
    out = ["| Garages de ↓ avec un garage de → à moins de " + " / ".join("%d m" % r for r in radii) + " | " + " | ".join(LABEL[n] for n in names) + " |", "|---|" + "---:|" * len(names)]
    for a in names:
        cells = []
        for b in names:
            if a == b:
                cells.append("—")
                continue
            per = [M.nearest_within(sets[a], sets[b], r) for r in radii]
            cells.append(" / ".join(cell(sum(1 for c in p if c), len(sets[a])) for p in per))
        out.append("| %s (%d) | %s |" % (LABEL[a], len(sets[a]), " | ".join(cells)))
    return out


def yield_lines(sets, near_m, spot_m, linker=None):
    """Parmi les garages de A qui n'ont pas de téléphone (ou de site), combien en trouvent un dans B ?"""
    linker = linker or M.link
    out = []
    for a, b in (("osm", "ovt"), ("sir", "ovt"), ("sir", "osm"), ("ovt", "osm")):
        m = linker(sets[a], sets[b], near_m, spot_m)
        no_tel = [(x, p) for x, p in zip(sets[a], m) if not x["phone"]]
        no_web = [(x, p) for x, p in zip(sets[a], m) if not x["web"]]
        no_hrs = [(x, p) for x, p in zip(sets[a], m) if not x["hours"]]
        out.append(
            "- %s sans téléphone : %d ; %s trouvent un téléphone dans %s. Sans site : %d ; %s. Sans horaires : %d ; %s."
            % (
                LABEL[a], len(no_tel), cell(sum(1 for _, p in no_tel if p and p["phone"]), len(no_tel)), LABEL[b],
                len(no_web), cell(sum(1 for _, p in no_web if p and p["web"]), len(no_web)),
                len(no_hrs), cell(sum(1 for _, p in no_hrs if p and p["hours"]), len(no_hrs)),
            )
        )
    return out


def agreement_bands(A, B, near_m, spot_m, key):
    """Concordance des téléphones sur les paires A→B où les deux ont un numéro, par tranche de B (key(lieu) → libellé)."""
    res = collections.defaultdict(lambda: [0, 0])
    for a, p in zip(A, M.link(A, B, near_m, spot_m)):
        if p and a["tels"] and p["tels"]:
            k = key(p)
            res[k][0] += 1
            res[k][1] += bool(set(a["tels"]) & set(p["tels"]))
    return dict(res)


SOCIAL = {"facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "wa.me", "whatsapp.com"}
DIRECTORIES = {"frmap.org", "pagesjaunes.fr", "mappy.com", "118712.fr", "118218.fr", "cylex.fr", "hoodspot.fr", "societe.com", "pappers.fr", "infogreffe.fr", "yelp.com", "yelp.fr", "tripadvisor.com", "tripadvisor.fr", "foursquare.com", "mapquest.com", "waze.com", "google.com", "goo.gl", "g.page"}


def _under(host, names):
    return any(host == n or host.endswith("." + n) for n in names)


def site_kinds(L):
    """Nature du premier site de chaque garage : domaine propre, réseau social, annuaire."""
    c = collections.Counter()
    for x in L:
        if not x["hosts"]:
            continue
        h = x["hosts"][0]
        c["réseau social" if _under(h, SOCIAL) else ("annuaire" if _under(h, DIRECTORIES) else "domaine propre")] += 1
    return c


def site_kinds_text(L):
    c = site_kinds(L)
    n = sum(c.values())
    return ", ".join("%s %s" % (k, cell(c[k], n)) for k in ("domaine propre", "réseau social", "annuaire")) + " (sur %d sites)" % n


def overture_only_profile(ents):
    """Qui sont les garages que seul Overture connaît ? (origine, confiance, réseau, téléphone, nature du site)"""
    L = [it for e in ents if set(e["srcs"]) == {"ovt"} for s, it in e["items"] if s == "ovt"]
    n = len(L)
    if not n:
        return ["- Aucun garage connu d'Overture seul."]
    conf = lambda lo, hi: sum(1 for x in L if x["conf"] is not None and lo <= x["conf"] < hi)  # noqa: E731
    return [
        "- %d lieux Overture sans équivalent ailleurs : téléphone %s, site %s ; avec marque %s ; confiance < 0,5 : %s, 0,5–0,7 : %s, ≥ 0,7 : %s ; origine meta %s, Foursquare %s, AllThePlaces %s ; sites : %s."
        % (
            n, cell(sum(x["phone"] for x in L), n), cell(sum(x["web"] for x in L), n), cell(sum(1 for x in L if x.get("brand")), n),
            cell(conf(0, 0.5), n), cell(conf(0.5, 0.7), n), cell(conf(0.7, 1.01), n),
            cell(sum(1 for x in L if "meta" in x["ds"]), n), cell(sum(1 for x in L if "Foursquare" in x["ds"]), n), cell(sum(1 for x in L if "AllThePlaces" in x["ds"]), n),
            site_kinds_text(L),
        )
    ]


def sirene_class_table(sir, osm, ovt, near_m, spot_m, linker=None):
    """Taux de rapprochement des établissements SIRENE (à OpenStreetMap ou Overture) selon leur nature : forme juridique, employeur, enseigne."""
    linker = linker or M.link
    mo = linker(sir, osm, near_m, spot_m)
    mv = linker(sir, ovt, near_m, spot_m)
    classes = [
        ("tous", lambda x: True),
        ("entrepreneur individuel (nature 1000)", lambda x: x.get("nj") == "1000"),
        ("autre forme (société…)", lambda x: x.get("nj") not in ("", "1000")),
        ("employeur", lambda x: x.get("emp") == "O"),
        ("non employeur", lambda x: x.get("emp") == "N"),
        ("enseigne renseignée", lambda x: x.get("ens")),
        ("sans enseigne", lambda x: not x.get("ens")),
    ]
    out = ["| Établissements SIRENE | Nombre | Trouvés dans OSM | dans Overture | dans l'un ou l'autre | avec téléphone d'Overture ou OSM |", "|---|---:|---:|---:|---:|---:|"]
    for label, f in classes:
        idx = [i for i, x in enumerate(sir) if f(x)]
        n = len(idx)
        o = sum(1 for i in idx if mo[i])
        v = sum(1 for i in idx if mv[i])
        either = sum(1 for i in idx if mo[i] or mv[i])
        tel = sum(1 for i in idx if (mo[i] and mo[i]["phone"]) or (mv[i] and mv[i]["phone"]))
        out.append("| %s | %d | %s | %s | %s | %s |" % (label, n, cell(o, n), cell(v, n), cell(either, n), cell(tel, n)))
    return out
