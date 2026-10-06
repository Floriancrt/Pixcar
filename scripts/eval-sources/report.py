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
def overlap_table(sets, near_m, spot_m):
    names = list(sets)
    out = ["| Garages de ↓ trouvés dans → | " + " | ".join(LABEL[n] for n in names) + " |", "|---|" + "---:|" * len(names)]
    for a in names:
        cells = []
        for b in names:
            if a == b:
                cells.append("—")
                continue
            m = M.link(sets[a], sets[b], near_m, spot_m)
            hit = [p for p in m if p]
            cells.append("%s, dont avec téléphone %d" % (cell(len(hit), len(sets[a])), sum(1 for p in hit if p["phone"])))
        out.append("| %s (%d) | %s |" % (LABEL[a], len(sets[a]), " | ".join(cells)))
    return out


# ---------------------------------------------------------------------------------------------------------------------------- garages réunis
def entities(sets, near_m, spot_m):
    """Garages réunis : deux éléments de sources différentes sont un même garage quand la règle de la page les apparie dans un sens ou l'autre."""
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
            for x, p in zip(A, M.link(A, B, near_m, spot_m)):
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
                "size": len(c),
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
        "hours_today": sum(1 for e in L if e["hours"]),
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
