#!/usr/bin/env python3
"""Mutation checks for the loading state: break one thing in the built page, the matching checks must fail."""
import pathlib, subprocess, sys, re
T = pathlib.Path(__file__).parent
src = (T.parent / "build_out.html").read_text()
Q = '<span class="wait-quote" aria-hidden="true">${y(waitQuote)}</span>'
M = [
 ("body class never set", 'document.body.classList.toggle("is-searching", e),', '', "L", "L1"),
 ("loading class never cleared", 'document.body.classList.toggle("is-searching", e)', 'document.body.classList.toggle("is-searching", true)', "C", "C1"),
 ("ring and car drawn when idle", '.ld {\n  display: none;\n}', '.ld {\n  display: inline;\n}', "I", "I1"),
 ("animation running when idle", 'body.is-searching .map-empty .ld-orbit,\n.wait-loader .ld-orbit {', '.ld-orbit {', "I", "I2"),
 ("car turns clockwise", 'transform: rotate(-360deg);', 'transform: rotate(360deg);', "L", "L6"),
 ("car turns around the wrong centre", '.ld-orbit {\n  transform-origin: 0 0;\n}', '.ld-orbit {\n  transform-origin: 50% 50%;\n}', "L", "L5"),
 ("car off the lane (group shifted)", '<g class="ld" transform="translate(1000 500) scale(1.35)"><g class="ld-orbit">', '<g class="ld" transform="translate(1000 540) scale(1.35)"><g class="ld-orbit">', "L", "L5"),
 ("ring not centred on the pin", '<g class="ld" transform="translate(1000 500) scale(1.35)"><circle class="ld-asphalt"', '<g class="ld" transform="translate(940 500) scale(1.35)"><circle class="ld-asphalt"', "L", "L4"),
 ("lap too fast (1.2 s)", 'animation: ld-lap 2.4s infinite;', 'animation: ld-lap 1.6s infinite;', "L", "L2"),
 ("map card still shown while searching", 'body.is-searching .map-hint,\nbody.is-searching .teaser {', 'body.is-searching .teaser {', "L", "L1"),
 ("teaser not hidden while searching", 'body.is-searching .map-hint,\nbody.is-searching .teaser {', 'body.is-searching .map-hint {', "L", "L3"),
 ("sentence missing from the card", Q, '', "E", "E1"),
 ("sentence readable by screen readers", '<span class="wait-quote" aria-hidden="true">', '<span class="wait-quote">', "E", "E4"),
 ("step missing from the card", '<span class="wait-step">${y(e)}</span>', '', "E", "E2"),
 ("sentence also on error cards", 'const wait = !!e && !t && me.busy;', 'const wait = !!e && me.busy;', "C", "C4"),
 ("sentence also on plain info messages", 'const wait = !!e && !t && me.busy;', 'const wait = !!e && !t;', "C", "C3"),
 ("no 0.35 s delay before the loader and the card", 'animation: ld-in 0.4s 0.35s both;', 'animation: none;', "C", "C6"),
 ("no delay before the card", 'animation: ld-in 0.3s 0.35s both;', 'animation: none;', "C", "C6"),
 ("pictogram shown on desktop too", '.wait-loader {\n  display: none;\n}', '.wait-loader {\n  display: block;\n}', "E", "E5"),
 ("pictogram never shown on mobile", '  .wait-loader {\n    display: block;', '  .wait-loader {\n    display: none;', "M", "M1"),
 ("red car", '--ld-road: #0a0d0a;\n  --ld-edge: transparent;\n  --ld-line: #f2f2f2;\n  --ld-car: #79fa52;', '--ld-road: #0a0d0a;\n  --ld-edge: transparent;\n  --ld-line: #f2f2f2;\n  --ld-car: #e2231a;', "A", "A1"),
 ("yellow lane markings", '--ld-edge: transparent;\n  --ld-line: #f2f2f2;', '--ld-edge: transparent;\n  --ld-line: #ffd100;', "A", "A2"),
 ("forced colours: car like the asphalt", '  .ld-island,\n  .ld-body,\n  .ld-hub {\n    fill: Canvas;', '  .ld-island,\n  .ld-body,\n  .ld-hub {\n    fill: CanvasText;', "X", "X1"),
 ("reduced motion not honoured", 'animation-duration: 0.001ms !important;', 'animation-duration: 2.4s !important;', "R", "R1"),
]
only = sys.argv[1:]
bad = 0
for name, find, rep, secs, must in M:
    if only and not any(o.lower() in name.lower() for o in only): continue
    n = src.count(find)
    if n != 1:
        print(f"[skip] {name}: anchor found {n} times"); bad += 1; continue
    (T / "site" / "mut.html").write_text(src.replace(find, rep))
    r = subprocess.run(["node", "load.js", "mut.html", secs], cwd=T, capture_output=True, text=True, timeout=900)
    fails = re.findall(r"FAIL: (\S+)", r.stdout)
    ok = any(f.startswith(must) for f in fails)
    print(f"[{'killed' if ok else 'SURVIVED'}] {name:52s} expect {must:3s} -> failing: {', '.join(sorted(set(fails))) or 'none'}")
    bad += (not ok)
print("mutations not killed:", bad)
sys.exit(1 if bad else 0)
