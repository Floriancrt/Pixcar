#!/usr/bin/env python3
"""Mutations sur les prix du contrôle technique (jeu DGCCRF : voiture particulière, codes 0 / 999, contre-visite, ancienneté) : voir lib.py.

  python3 tests/mutation/mut_ct.py            variantes de src/ jugées par tests/ct.js
  options : --anchors  vérifie seulement que chaque ancre existe encore ; des mots : seulement les variantes dont le nom en contient un
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections (inutilisé), must-fail check prefix
 ("the old label test (« particulier » misses « particulière »): every category mixed, cheapest wins", "Ke = (e) => (isFinite(e.catId) ? e.catId === CT_VP : /particuli[eè]re?\\b|\\bvp\\b|tourisme/i.test(e.cat) && !Qe(e.cat));", "Ke = (e) => !Qe(e.cat);", "", "CT5"),
 ("the label fallback still misses the è", "/particuli[eè]re?\\b|\\bvp\\b|tourisme/i.test(e.cat)", "/particulier|\\bvp\\b|tourisme/i.test(e.cat)", "", "CT11"),
 ("0 € taken for a price", "CT_MIN = 20,", "CT_MIN = 0,", "", "CT6"),
 ("999 € taken for a price", "CT_MAX = 300,", "CT_MAX = 1000,", "", "CT8"),
 ("a 500 € counter-visit taken for a price", "CV_MAX = 200,", "CV_MAX = 1000,", "", "CT9"),
 ("prices outside the range kept when choosing", "const a = e.rows.filter((e) => Ke(e) && ctPriceOk(e.price)),", "const a = e.rows.filter((e) => Ke(e) && isFinite(e.price)),", "", "CT6"),
 ("energy menu built from every category", "for (const a of t.rows) a.energy && Ke(a) && ctPriceOk(a.price) && e.set(k(a.energy), a.energy);", "for (const a of t.rows) a.energy && !Qe(a.cat) && e.set(k(a.energy), a.energy);", "", "CT12"),
 ("a free counter-visit shown as 0 €", 'cv = (v) => (0 === v ? "gratuite" : C(v)),', "cv = (v) => C(v),", "", "CT10"),
 ("no warning on a price declared years ago", "old = !isNaN(when) && Date.now() - when.getTime() > 730 * 864e5;", "old = !1;", "", "CT3"),
 ("the warning on every price, even a recent one", "old = !isNaN(when) && Date.now() - when.getTime() > 730 * 864e5;", "old = !isNaN(when);", "", "CT10"),
 ("no fallback to another energy (a centre without the chosen energy shows no price)", "s = r.length ? r : a;\n    return s.length ? { ...s.reduce", "s = r;\n    return s.length ? { ...s.reduce", "", "CT8"),
]

run(M, "ct.js", 62)
