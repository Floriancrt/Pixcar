#!/usr/bin/env python3
"""Construit la table de garages de Pixcar : des tuiles statiques (JSON) tirées d'Overture Maps, que la page charge à côté d'OpenStreetMap.

  python scripts/garages/build.py --area dept:Haute-Garonne --rough 0.2,42.5,2.3,44.1 --dept-codes 31 --out build/garages
  python scripts/garages/build.py --area bbox:0.9,43.0,1.3,43.4 --sirene off --out build/garages
  python scripts/garages/build.py --area france --out build/garages          (une heure environ, surtout le registre ; voir docs/exploitation.md)

Étapes : lecture d'Overture (garages de la zone) → mise en forme (rien d'autre que nom, position, téléphones, site, adresse, enseigne) → retrait des
lieux sur liste d'exclusion → réunion des doublons → retrait des lieux fermés d'après le registre SIRENE → écriture des tuiles → contrôle.
Rien n'est publié : la sortie est un dossier, que `node scripts/build.mjs --garages <dossier>` joint au site (voir README).
Aucune donnée d'entreprise individuelle du registre n'est écrite ; le rapport (sortie standard) ne contient que des agrégats.
"""
import argparse
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matching as M  # noqa: E402
import overture as O  # noqa: E402
import sirene as S  # noqa: E402
import tiles as T  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FRANCE_BBOX = (-5.5, 41.2, 9.8, 51.2)  # métropole et Corse ; les lieux des pays voisins sont écartés par l'adresse (pays FR)
CREDIT = "Overture Maps Foundation (CDLA-Permissive-2.0), avec des données de Meta (CDLA-Permissive-2.0), Foursquare (Apache-2.0) et AllThePlaces (CC0-1.0)"


def area_polygon(spec, rough, release, log):
    from shapely.geometry import box

    kind, _, arg = spec.partition(":")
    if kind == "france":
        return box(*FRANCE_BBOX)
    if kind == "bbox":
        w, s, e, n = (float(v) for v in arg.split(","))
        if not (w < e and s < n):
            raise SystemExit("--area bbox:ouest,sud,est,nord : ouest < est et sud < nord attendus")
        return box(w, s, e, n)
    if kind == "dept":
        if not rough:
            raise SystemExit("--area dept:<nom> demande --rough ouest,sud,est,nord (boîte large qui contient le département)")
        return O.county_polygon(arg, tuple(float(v) for v in rough.split(",")), release, log)
    raise SystemExit("--area attend france, bbox:… ou dept:<nom>")


def load_exclusions(paths):
    ids = set()
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        data = json.load(open(p, encoding="utf-8"))
        ids.update(str(x).strip() for x in (data.get("ids", []) if isinstance(data, dict) else data) if str(x).strip())
    return ids


def probe_lines(records, dropped, probe):
    lat, lon, km = probe
    here = {"lat": lat, "lon": lon}
    inside = [r for r in records if M.meters(here, r) <= km * 1000]
    keys = T.tile_keys_for(lat, lon, km)
    lines = ["Sonde %.4f,%.4f, %g km : %d garages dans le rayon, %d cases à charger (%s)" % (lat, lon, km, len(inside), len(keys), ", ".join(keys))]
    lines.append("  avec téléphone %d, avec site %d ; retirés comme fermés dans le rayon : %d" % (sum(1 for r in inside if r.get("phones")), sum(1 for r in inside if r.get("web")), sum(1 for r in dropped if M.meters(here, r) <= km * 1000)))
    return lines, [r["id"] for r in dropped if M.meters(here, r) <= km * 1000]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--area", required=True, help="france | bbox:ouest,sud,est,nord | dept:<nom Overture>")
    ap.add_argument("--rough", help="avec dept: : boîte large ouest,sud,est,nord autour du département")
    ap.add_argument("--dept-codes", default="", help="codes INSEE des départements de la zone, séparés par des virgules (registre SIRENE) ; france : tous")
    ap.add_argument("--out", required=True, help="dossier de sortie (index.json et t/)")
    ap.add_argument("--release", default="auto", help="version d'Overture (ex. release/2026-09-23.1) ; auto : la dernière")
    ap.add_argument("--sirene", choices=("on", "off"), default="on", help="écarter les lieux fermés d'après le registre (on par défaut)")
    ap.add_argument("--max-sirene-missing", type=int, default=5, help="départements sans réponse du registre tolérés avant d'échouer")
    ap.add_argument("--exclude", action="append", default=[], help="fichier JSON d'identifiants Overture à ne jamais publier (en plus de exclusions.json)")
    ap.add_argument("--probe", help="lat,lon,km : décrit la zone autour d'un point (garages, cases à charger, lieux fermés retirés)")
    ap.add_argument("--print-dropped", action="store_true", help="avec --probe : écrit les identifiants Overture retirés comme fermés dans le rayon (ni nom ni numéro)")
    ap.add_argument("--min-entries", type=int, default=0, help="échoue si la table compte moins de garages (garde contre une lecture partielle)")
    ap.add_argument("--built", default=None, help="date de construction AAAA-MM-JJ (par défaut : aujourd'hui, UTC)")
    ap.add_argument("--summary", help="fichier où écrire le résumé en Markdown (ex. $GITHUB_STEP_SUMMARY)")
    a = ap.parse_args(argv)

    t0 = time.time()
    lines = []

    def log(m):
        print("[%4.0f s] %s" % (time.time() - t0, m), flush=True)

    release = O.latest_release() if a.release == "auto" else a.release
    log("version d'Overture : %s" % release)
    poly = area_polygon(a.area, a.rough, release, log)
    rows, scanned = O.read_places(poly, release, log)

    records, invalid = [], 0
    for r in rows:
        rec = T.build_record(r, O.KINDS)
        if rec is None:
            invalid += 1
        else:
            records.append(rec)
    excl = load_exclusions([os.path.join(HERE, "exclusions.json")] + a.exclude)
    before = len(records)
    records = [r for r in records if r["id"] not in excl]
    excluded = before - len(records)
    records, absorbed, too_big = T.merge_duplicates(records)

    closure, missing, dropped = "none", [], []
    if a.sirene == "on":
        codes = S.DEPTS_METRO if a.area.startswith("france") else [c.strip() for c in a.dept_codes.split(",") if c.strip()]
        if not codes:
            raise SystemExit("le registre SIRENE demande --dept-codes (ou --sirene off)")
        active, closed, missing = S.load(codes, log)
        if len(missing) > a.max_sirene_missing:
            raise SystemExit("registre SIRENE : %d départements sans réponse (%s), au-delà de %d : construction refusée" % (len(missing), ",".join(missing), a.max_sirene_missing))
        records, dropped = T.drop_closed(records, closed, active)
        closure = "partial" if missing else "sirene"

    built = a.built or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    meta = {"built": built, "source": "%s, thème places, version %s. %s" % ("Overture Maps", release.split("/")[-1], CREDIT), "closure": closure, "closure_missing": missing}
    stats = T.write_tiles(records, a.out, meta)
    problems = T.validate_dir(a.out, a.min_entries)

    n = len(records)
    by_kind = {k: sum(1 for r in records if r["kind"] == k) for k in T.KIND_LETTERS}
    lines += [
        "# Table de garages — %s (%s)" % (a.area, built),
        "",
        "- Overture %s : %d lieux lus, %d garages de la zone, %d inutilisables (nom ou position), %d sur liste d'exclusion, %d doublons réunis%s."
        % (release.split("/")[-1], scanned, len(rows), invalid, excluded, absorbed, (", %d amas trop gros laissés tels quels" % too_big) if too_big else ""),
        "- Registre SIRENE : %s ; %d lieux retirés comme fermés%s." % (closure, len(dropped), (" ; départements sans réponse : " + ",".join(missing)) if missing else ""),
        "- **%d garages** (réparation %d, pneus %d, carrosserie %d, vitrage %d) : téléphone %d (%.0f %%), site %d (%.0f %%), adresse %d (%.0f %%)."
        % (n, by_kind["r"], by_kind["t"], by_kind["b"], by_kind["v"], sum(1 for r in records if r.get("phones")), 100 * sum(1 for r in records if r.get("phones")) / max(1, n),
           sum(1 for r in records if r.get("web")), 100 * sum(1 for r in records if r.get("web")) / max(1, n), sum(1 for r in records if r.get("addr")), 100 * sum(1 for r in records if r.get("addr")) / max(1, n)),
        "- %d cases, %.1f Ko en JSON, %.1f Ko compressé (gzip) ; la plus lourde : %s." % (stats["tiles"], stats["bytes"] / 1024, stats["gz"] / 1024,
            ", ".join("%s %.1f Ko gz" % (k, v[1] / 1024) for k, v in sorted(stats["sizes"].items(), key=lambda kv: -kv[1][1])[:1])),
    ]
    ids = []
    if a.probe:
        pl, ids = probe_lines(records, dropped, tuple(float(v) for v in a.probe.split(",")))
        lines += [""] + pl
        if a.print_dropped:
            lines.append("  identifiants retirés (fermés) dans le rayon : " + (",".join(ids) if ids else "aucun"))
    if problems:
        lines += ["", "**Contrôle : %d problème(s)**" % len(problems)] + ["- " + p for p in problems[:30]]
    else:
        lines += ["", "Contrôle de la sortie : conforme."]
    print("\n".join(lines), flush=True)
    if a.summary:
        with open(a.summary, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
