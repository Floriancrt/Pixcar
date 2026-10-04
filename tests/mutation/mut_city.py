#!/usr/bin/env python3
"""Mutations sur la ville de la puce distance : voir lib.py.

  python3 tests/mutation/mut_city.py          variantes jugées par la suite navigateur tests/city.js
  python3 tests/mutation/mut_city.py --unit   variantes de modules/city.js jugées par tests/city_unit.js (sans navigateur)
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from lib import run

M = [
 # name, find, replace, sections, must-fail check prefix
 ("tags ignored (addr:city, contact:city, addr:suburb)", '    if (g.city) return g.city;\n', '', "A", "A1"),
 ("address not read for the city", '    const fromAddr = cityFromAddr(g.addr);\n    if (fromAddr) return fromAddr;\n', '', "AE", "A1"),
 ("city of the answer ignored (only its address is read)", 'return (e && (e.c || cityFromAddr(e.a))) || "";', 'return (e && cityFromAddr(e.a)) || "";', "C", "C1"),
 ("cached address (old entry) no longer gives the city", 'return (e && (e.c || cityFromAddr(e.a))) || "";', 'return (e && e.c) || "";', "C", "C7"),
 ("city taken from an answer up to 50 m only", 'const cityRange = 250,', 'const cityRange = 50,', "C", "C1"),
 ("city taken from an answer up to 400 m", 'const cityRange = 250,', 'const cityRange = 400,', "C", "C3"),
 ("no limit on simultaneous requests", '    cityMax = 3,', '    cityMax = 50,', "B", "B3"),
 ("one request at a time", '    cityMax = 3,', '    cityMax = 1,', "B", "B3"),
 ("visit cap far too low", '    cityCap = 300,', '    cityCap = 5,', "B", "B9"),
 ("switch window.JG_CITY_LOOKUP ignored", 'cityLook = window.JG_CITY_LOOKUP !== !1,', 'cityLook = !0,', "C", "C12"),
 ("whole list looked up, not only the cards on screen", 'for (const e of es) e.isIntersecting && (io.unobserve(e.target), take(e.target));', 'for (const e of es) (io.unobserve(e.target), take(e.target));', "B", "B1"),
 ("garages that already have a city are looked up too", '      !cityOf(g) &&\n', '', "AB", "A2"),
 ("fresh answers asked again", '      cityStale(adMem[adId(g)]);', '      !0;', "C", "C4"),
 ("old entries without a city not asked again", 'const cityStale = (e) => !adFresh(e) || (!e.a && "string" != typeof e.c),', 'const cityStale = (e) => !adFresh(e),', "C", "C6"),
 ("no stop after 4 failures in a row", '    if (cityFails < 4) return !1;', '    if (cityFails < 4000) return !1;', "C", "C8"),
 ("pause after the stop ignored", '    if (Date.now() - cityFailAt < a.cityPause) return !0;\n', '', "C", "C10"),
 ("stop never lifted", '    return ((cityFails = 0), !1);', '    return !0;', "C", "C11"),
 ("failure count not reset by an answer", '          if (e) cityFails = 0;\n', '          if (e) cityFails += 0;\n', "C", "C14"),
 ("city of the answer not kept", 'cy = d >= 0 && d <= cityRange ? cityTidy(o.city) || cityFromAddr(o.label) : "",', 'cy = "",', "B", "B10"),
 ("city not read from the label when the answer has none", 'cy = d >= 0 && d <= cityRange ? cityTidy(o.city) || cityFromAddr(o.label) : "",', 'cy = d >= 0 && d <= cityRange ? cityTidy(o.city) : "",', "C", "C5"),
 ("late answer does not repaint the chip", '          cityRepaint(g);\n        })\n        .catch(() => {})', '        })\n        .catch(() => {})', "B", "B1"),
 ("address completion does not repaint the chip", '    (c && (c.href = adGoogle(g)), cityRepaint(g));', '    c && (c.href = adGoogle(g));', "C", "C13"),
 ("no comma for screen readers", '<span class="sr-only">, </span><span class="d-sep"', '<span class="d-sep"', "A", "A3"),
 ("separator read aloud", '<span class="d-sep" aria-hidden="true">·</span>', '<span class="d-sep">·</span>', "A", "A4"),
 ("chip not tied to its garage", '<span class="dist" data-dist="${y(e.id)}">', '<span class="dist">', "AB", "A5"),
 ("capitals not tidied", '  if (!/[a-zà-ÿ]/.test(s))\n    s = s', '  if (false)\n    s = s', "A", "A1"),
 ("cedex kept", '    .replace(/\\s*\\bcedex\\b.*$/i, "")\n', '', "E", "E2"),
 ("arrondissement kept long", '(m, n) => ` ${n}${+n === 1 ? "er" : "e"}`,', '(m) => m,', "E", "E2"),
 ("long city overflows the chip (track not bounded)", '  grid-template-columns: minmax(0, 1fr);\n  gap: 6px;', '  gap: 6px;', "AF", "A6"),
 ("chip cannot shrink", '  max-width: 100%;\n  min-width: 0;\n}\n.dist .ic {', '  max-width: 100%;\n}\n.dist .ic {', "AF", "A6"),
 ("long city cut without an ellipsis", '  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-weight: 600;', '  white-space: nowrap;\n  font-weight: 600;', "F", "F2"),
]

# Variantes du module pur modules/city.js : tests/city_unit.js, sans navigateur
U = [
 ("mixed-case texts re-cased", '  if (!/[a-zà-ÿ]/.test(s))\n    s = s', '  if (true)\n    s = s', "", "tidy:"),
 ("particles capitalised", '(LOW.has(w.toLowerCase()) ? w.toLowerCase() : w)', 'w', "", "tidy:particle"),
 ("first word lowercased when it is a particle", '.replace(/(?<=[\\s-])(\\p{Lu}\\p{Ll}*)(?=[\\s-]|$)/gu,', '.replace(/(\\p{Lu}\\p{Ll}*)(?=[\\s-]|$)/gu,', "", "tidy:first"),
 ("elisions not lowercased", "\n      .replace(/(?<=[\\s-])D(?=['’])/g, \"d\");", ";", "", "tidy:elisions"),
 ("cedex kept", '    .replace(/\\s*\\bcedex\\b.*$/i, "")\n', '', "", "tidy:cedex"),
 ("arrondissement not shortened", '(m, n) => ` ${n}${+n === 1 ? "er" : "e"}`,', '(m) => m,', "", "tidy:arrondissement"),
 ("1er written 1e", '${+n === 1 ? "er" : "e"}', '${"e"}', "", "tidy:arrondissement_1ER"),
 ("no length limit", 's.length > 60 || ', '', "", "tidy:too_long"),
 ("a postcode taken for a city", ' || !/\\p{L}/u.test(s)', '', "", "tidy:a_postcode"),
 ("four- or six-digit numbers taken for a postcode", '\\d{5}\\s+([^,]+)', '\\d{4,6}\\s+([^,]+)', "", "from:four"),
 ("first postcode used instead of the last", '([^,]+)/g)].pop();', '([^,]+)/g)][0];', "", "from:two"),
 ("postcode glued to the city accepted", '\\d{5}\\s+([^,]+)', '\\d{5}\\s*([^,]+)', "", "from:postcode_glued"),
 ("text after the comma kept", '\\d{5}\\s+([^,]+)', '\\d{5}\\s+(.+)', "", "from:country"),
]

if "--unit" in sys.argv:
    run(U, "city_unit.js", 52)
else:
    run(M, "city.js", 62)
