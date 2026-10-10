#!/usr/bin/env python3
"""Mutations sur le premier affichage (rien ne bouge quand la police Manrope arrive), jugées par tests/prerender.js : voir lib.py."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("no metric-matched fallback while Manrope loads", '--font: "Manrope", "Manrope Fallback", system-ui', '--font: "Manrope", system-ui', "", "P6"),
 ("home title width in ch (it changes when the font arrives)", "max-width: 8.76em;", "max-width: 13ch;", "", "P6"),
]

if __name__ == "__main__":
    run(M, "prerender.js", max(len(m[0]) for m in M))
