#!/usr/bin/env python3
"""Mutations sur la tuile des lignes du tableau (logo, et la distance dans sa propre colonne), jugées par tests/logos.js : voir lib.py."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("the logo touches the tile's edges (no inner margin)", ".g-main > .avatar .lg {\n  padding: 12%;", ".g-main > .avatar .lg {\n  padding: 0;", "", "B21"),
 ("the distance is put on the tile (desktop table)", "  .dist {\n    grid-column: 4;\n    grid-row: 1;", "  .dist {\n    grid-column: 1;\n    grid-row: 1;", "", "B21"),
]

if __name__ == "__main__":
    run(M, "logos.js", max(len(m[0]) for m in M))
