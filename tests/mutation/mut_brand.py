#!/usr/bin/env python3
"""Mutations sur les marqueurs de la carte (jetons de la charte, garage le moins cher en orange), jugées par tests/brand.js : voir lib.py."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("the cheapest garage's marker stays black", 'fillColor: t || scale.best === e.id\n        ? Ct("--mk-sel")', 'fillColor: t\n        ? Ct("--mk-sel")', "", "B10b"),
 ("the cheapest garage's marker is drawn under the others", ".sort((e, t) => mt(e) + (scale.best === e.id) - (mt(t) + (scale.best === t.id)))", ".sort((e, t) => mt(e) - mt(t))", "", "B10b"),
 ("the selected marker loses its token colour", '    s &&\n      ((Hl = L.circleMarker(s.getLatLng(), {', '    s &&\n      (s.setStyle({ fillColor: "#000000" }), (Hl = L.circleMarker(s.getLatLng(), {', "", "B10"),
]

if __name__ == "__main__":
    run(M, "brand.js", max(len(m[0]) for m in M))
