#!/usr/bin/env python3
"""Mutation checks for the UX round: break one thing in the built page, the matching checks must fail."""
import pathlib, subprocess, sys, re, json
T = pathlib.Path(__file__).parent
src = (T.parent / "build_out.html").read_text()
M = [
 # name, find, replace, sections, must-fail check prefix
 ("dès back on card prices", '<span class="amount">${n.approx', '<span class="amount">${n.from ? \'<span class="from">dès</span>\' : ""}${n.approx', "D", "D1"),
 ("dès back in the summary", 'à ${E(e.dist)}, <b>${C(e.price.amount)}</b>.</p>', 'à ${E(e.dist)}, ${e.price.from ? "dès " : ""}<b>${C(e.price.amount)}</b>.</p>', "D", "D2"),
 ("dès back on the Prix page", '<span class="ref-price">${t.approx', '<span class="ref-price">${t.from ? "<small>dès</small> " : ""}${t.approx', "D", "D8"),
 ("dès back in the « prix enseigne » note", 'prix enseigne ${C(s.p)}', 'prix enseigne ${s.from ? "dès " : ""}${C(s.p)}', "D", "D7"),
 ("dès back in the map bar / tooltip", '"declared" === e.price.kind ? "prix déclaré " : ""', '"declared" === e.price.kind ? "prix déclaré " : e.price.from ? "dès " : ""', "D", "D6"),
 ("mobile tag dropped from the saved-list whitelist", '|contact:mobile|mobile|website|', '|contact:mobile|website|', "P", "P13"),
 ("mobile tag ignored when reading phones", 't.mobile, ', '', "P", "P5"),
 ("duplicate numbers kept", 'seen.has(tel) || (seen.add(tel), out.push({ text, tel }));', 'out.push({ text, tel });', "P", "P2"),
 ("call button without accessible label", ' aria-label="Appeler le ${y(t)}"', '', "P", "P1"),
 ("copy fallback selects the first number of the card", '(t.parentElement || a).querySelector(".phone")', 'a.querySelector(".phone")', "P", "P4b"),
 ("label not on the number's baseline", 'grid-template-columns: auto minmax(0, 1fr);\n  align-items: baseline;', 'grid-template-columns: auto minmax(0, 1fr);\n  align-items: start;', "P", "P17"),
 ("no Google Maps link when the number is missing", '<a href="${y(adGoogle(e))}" target="_blank" rel="noopener">chercher sur Google Maps</a>', '', "P", "P8"),
 ("« Horaires » row dropped when missing", '["Horaires", e.hours ? y(I(e.hours)) : none("Non renseignés")]', 'e.hours ? ["Horaires", y(I(e.hours))] : null', "P", "P10"),
 ("chains' median tile missing", '<div class="cmp is-ref">', '<div class="cmp is-refx">', "S", "S1"),
 ("garage median marker at the chains' position", '<span class="scale-med" style="left:${l(m)}%">', '<span class="scale-med" style="left:${l(c)}%">', "S", "S4"),
 ("gap sign inverted", 'gap < 0 ? "sous les enseignes" : "au-dessus des enseignes"', 'gap < 0 ? "au-dessus des enseignes" : "sous les enseignes"', "S", "S3"),
 ("gap pill threshold ignored (5 %)", 'Math.abs(gap) < 0.05 ?', 'Math.abs(gap) < 0.0 ?', "S", "S13"),
 ("OpenStreetMap notice back (saved list)", '(me.cachedAt = e.t));', '(me.cachedAt = e.t), me.notes.push(`OpenStreetMap ne répond pas pour le moment (${De(d)}) : voici la liste enregistrée lors d\'une recherche précédente.`));', "N", "N2"),
 ("registry-only notice back", '((s = e.items), me.notes.push(...e.notes));', '((s = e.items), me.notes.push(`OpenStreetMap ne répond pas pour le moment (${De(d)}). Cette liste vient du registre des entreprises, sans téléphone ni horaires.`, ...e.notes));', "N", "N6"),
 ("server list unfolded in the error state", '<details class="detail"><summary>Détails techniques</summary>${y(n)}</details>', '<small class="detail">Détail : ${y(n)}</small>', "N", "N9"),
 ("scrollbar arrow buttons back", 'display: none;\n    width: 0;\n    height: 0;', 'display: block;\n    width: 15px;\n    height: 15px;', "B", "B2"),
 ("custom scrollbar on touch screens too", '@media (hover: hover) and (pointer: fine) {\n  .panel-col::-webkit-scrollbar,', '@media all {\n  .panel-col::-webkit-scrollbar,', "B", "B8"),
 ("scrollbar not inset from the curve", '--sb-inset: 18px;', '--sb-inset: 0px;', "B", "B4"),
 ("standard scrollbar properties for every browser", '@supports not selector(::-webkit-scrollbar) {', '@media all {', "B", "B3"),
 ("forced-colors markers not coloured", '  .scale-ref,\n  .k-ref {\n    background: CanvasText;', '  .scale-refx,\n  .k-refx {\n    background: CanvasText;', "F", "F2"),
]
only = sys.argv[1:] 
bad = 0
for name, find, rep, secs, must in M:
    if only and not any(o.lower() in name.lower() for o in only): continue
    n = src.count(find)
    if n != 1:
        print(f"[skip] {name}: anchor found {n} times"); bad += 1; continue
    (T / "site" / "mut.html").write_text(src.replace(find, rep))
    r = subprocess.run(["node", "ux.js", "mut.html", secs], cwd=T, capture_output=True, text=True, timeout=900)
    fails = re.findall(r"FAIL: (\S+)", r.stdout)
    ok = any(f.startswith(must) for f in fails)
    print(f"[{'killed' if ok else 'SURVIVED'}] {name:58s} expect {must:4s} -> failing: {', '.join(sorted(set(fails))) or 'none'}")
    bad += (not ok)
print("mutations not killed:", bad)
sys.exit(1 if bad else 0)
