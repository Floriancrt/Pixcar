#!/usr/bin/env python3
"""Mutations sur la tuile des cartes (logo et pastille de distance), jugées par tests/logos.js : voir lib.py."""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("the logo fills the large tile, under the chip", "  .g-main > .avatar .lg {\n    height: calc(100% - 38px);", "  .g-main > .avatar .lg {\n    height: 100%;", "", "B21"),
 ("the logo fills the small tile, under the chip", ".g-main > .avatar .lg {\n  height: calc(100% - 34px);", ".g-main > .avatar .lg {\n  height: 100%;", "", "B22"),
]

if __name__ == "__main__":
    run(M, "logos.js", max(len(m[0]) for m in M))
