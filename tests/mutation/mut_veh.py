#!/usr/bin/env python3
"""Mutation checks for the vehicle block: break one thing in the built page, the matching check must fail."""
import pathlib, subprocess, sys, re
T = pathlib.Path(__file__).parent
src = (T.parent / "build_out.html").read_text()
M = [
 # name, find, replace, sections, must-fail check prefix
 ("digits accepted in the letter groups", 'fits = 1 === g ? c >= "0" && c <= "9" : c >= "A" && c <= "Z";', 'fits = true;', "P", "P6"),
 ("8th character let through", 'const room = groups[g].length < (1 === g ? 3 : 2),', 'const room = true,', "P", "P8"),
 ("dangling dash posed after a full group", 'return { value: groups.filter(Boolean).join("-"), dropped };', 'return { value: groups.join("-"), dropped };', "P", "P5"),
 ("typed separators do not move to the next group", 'if (groups[g] && g < 2) g++;', '', "P", "P12"),
 ("caret not restored after masking", 'el.setSelectionRange(caret, caret);', '', "P", "P11"),
 ("lowercase not turned into capitals", 'const c = ch.toUpperCase(),', 'const c = ch,', "P", "P1"),
 ("no reminder on a refused keystroke", 'Tt(el, Pt.plateErr, masked.dropped ? PLATE_LIVE : "");', 'Tt(el, Pt.plateErr, "");', "P", "P6b"),
 ("reminder survives leaving the field", 'Tt(Pt.plate, Pt.plateErr, "");\n        Pt.plateSay.textContent = "";', 'Pt.plateSay.textContent = "";', "P", "P10"),
 ("no screen-reader announcement", 'Pt.plateSay.textContent = masked.dropped ? PLATE_LIVE : "";', '', "P", "P6d"),
 ("plate pattern loosened (1 to 3 characters per group)", '/^[A-Z]{2}-\\d{3}-[A-Z]{2}$/,\n    PLATE_SEP', '/^[A-Z]{1,2}-\\d{1,3}-[A-Z]{1,2}$/,\n    PLATE_SEP', "V", "V6d"),
 ("plate not validated on submit", 'PLATE_RE.test(pl),', 'true,', "V", "V1"),
 ("year range ignored", 'if (+year < YEAR_MIN || +year > YEAR_MAX)', 'if (false)', "Y", "Y5"),
 ("year after the repair date accepted", 'if (/^\\d{4}-/.test(date) && +year > +date.slice(0, 4))', 'if (false)', "Y", "Y7"),
 ("year not validated on submit", 'd(!ym, Pt.year, Pt.yearErr, ym),', 'd(true, Pt.year, Pt.yearErr, ym),', "V", "V1"),
 ("year keeps non-digits", 'const digits = Pt.year.value.replace(/\\D/g, "").slice(0, 4);', 'const digits = Pt.year.value.slice(0, 4);', "Y", "Y1"),
 ("stale year message after the date is corrected", 'Pt.yearErr.hidden || Tt(Pt.year, Pt.yearErr, yearMsg(Pt.year.value.trim(), Pt.date.value));', '', "Y", "Y8"),
 ("year not saved", 'year: +yr,', '', "V", "V11"),
 ("plate not saved", 'immat: pl,', '', "V", "V11"),
 ("suggestions not folded (case, accents)", 'const q = H(\n      String(query || "")', 'const q = String(\n      String(query || "")', "M", "M3b"),
 ("exact name not ranked first", 'if (c.k === q || c.mk === q) return 0;', '', "M", "M4"),
 ("declared models not put first", '.sort((x1, x2) => x1.r - x1.c.own - (x2.r - x2.c.own) || x1.c.i - x2.c.i)', '.sort((x1, x2) => x1.r - x2.r || x1.c.i - x2.c.i)', "M", "M24"),
 ("more than 12 suggestions", '.slice(0, 12)\n      .map((x) => x.c);', '.slice(0, 50)\n      .map((x) => x.c);', "M", "M9"),
 ("list kept open for a single identical suggestion", 'mdl.items = 1 === items.length && H(items[0].m) === H(Pt.model.value) ? [] : items;', 'mdl.items = items;', "M", "M25c"),
 ("Escape closes the dialog together with the list", 'e.preventDefault();\n        e.stopPropagation();\n        Pt.listClosedAt = Date.now();\n        return void mdlHide();', 'return void mdlHide();', "M", "M17"),
 ("Enter does not pick the active option", 'if (open && mdl.index >= 0) return void mdlPick(mdl.index);', '', "M", "M15"),
 ("Enter without an active option does not move on", 'mdlHide();\n        return void Pt.plate.focus();', 'mdlHide();', "M", "M15c"),
 ("no aria-activedescendant", 'Pt.model.setAttribute("aria-activedescendant", li.id);', '', "M", "M13"),
 ("click on an option does nothing", 'li && mdlPick(+li.dataset.i);', '', "M", "M18"),
 ("stale options left in the closed list", 'Pt.mList.innerHTML = "";\n    Pt.model.setAttribute("aria-expanded", "false");', 'Pt.model.setAttribute("aria-expanded", "false");', "M", "M10"),
 ("ArrowUp from nothing skips the last option", 'mdl.index = mdl.index < 0 ? (step > 0 ? 0 : n - 1) : (mdl.index + step + n) % n;', 'mdl.index = (mdl.index + step + n) % n;', "M", "M16"),
 ("active option not scrolled into view", 'else if (bottom > Pt.mList.scrollTop + Pt.mList.clientHeight - 6)', 'else if (false)', "M", "M16b"),
 ("one-character model names guess the brand", 'if (r.length < 2) continue;', '', "C", "C6"),
 ("brand list not extended with the catalogue", 'O = ["Mercedes-Benz", ...CARS.map(([brand]) => brand)]', 'O = ["Mercedes-Benz", "Renault", "Peugeot"]', "CM", "C5"),
 ("plate leaks into the model label (garage sheet, tooltip)", 'model: e.model || "",\n      year: e.year || 0,', 'model: (e.model || "") + (e.immat ? " " + e.immat : ""),\n      year: e.year || 0,', "S", "S8"),
 ("old « plate » migration disabled", 'if (t.some((e) => "plate" in e)) {', 'if (t.some((e) => "plateX" in e)) {', "S", "S13"),
 ("stored plates not sanitised", 'if (!/^[A-Z]{2}-\\d{3}-[A-Z]{2}$/.test(r.immat)) delete r.immat;', '', "S", "S10"),
 ("stored years not sanitised", 'if (!(Number.isInteger(r.year) && r.year >= 1950 && r.year <= 2100)) delete r.year;', '', "S", "S11"),
 ("plate not prefilled", 'Pt.plate.value = (last && last.immat) || "";', 'Pt.plate.value = "";', "S", "S1"),
 ("plate chip missing in Mes réparations", '<span class="rep-plate">', '<span class="rep-plateX">', "S", "S4"),
 ("history note forgets the plate", "et l'immatriculation n'y figurent jamais", "n'y figurent jamais", "S", "S8b"),
 ("year span missing in Mes réparations", '<span class="rep-year">', '<span class="rep-yearX">', "S", "S4"),
 ("plate and year row misaligned", '  gap: 12px;\n  align-items: start;\n}', '  gap: 12px;\n}', "L", "L2"),
 ("forced colours: no outline on the active option", '.suggest li[aria-selected="true"],\n  .suggest li:hover {\n    outline: 2px solid Highlight;', '.suggest li[aria-selected="true"],\n  .suggest li:hover {\n    outline: 2px solid Canvas;', "L", "L8"),
]
only = sys.argv[1:]
bad = 0
for name, find, rep, secs, must in M:
    if only and not any(o.lower() in name.lower() for o in only): continue
    n = src.count(find)
    if n != 1:
        print(f"[skip] {name}: anchor found {n} times"); bad += 1; continue
    (T / "site" / "mut.html").write_text(src.replace(find, rep))
    r = subprocess.run(["node", "veh.js", "mut.html", secs], cwd=T, capture_output=True, text=True, timeout=900)
    fails = re.findall(r"FAIL: (\S+)", r.stdout)
    ok = any(f.startswith(must) for f in fails)
    print(f"[{'killed' if ok else 'SURVIVED'}] {name:62s} expect {must:4s} -> failing: {', '.join(sorted(set(fails))) or 'none'}", flush=True)
    bad += (not ok)
print("mutations not killed:", bad)
sys.exit(1 if bad else 0)
