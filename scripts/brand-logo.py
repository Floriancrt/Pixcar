#!/usr/bin/env python3
# Logo Pixcar (charte graphique v2.1 du 23 octobre 2026) tiré de la version vectorielle noire de la maquette de l'utilisateur
# (docs/brand/pixcar-logo-trace-maquette.svg : un seul chemin en polylignes, 135 Ko). Simplifie chaque contour (Ramer-Douglas-Peucker,
# tolérance 0,8 unité du tracé, soit 0,18 unité d'affichage : écart de 0,7 % des pixels au sextuple de la taille), sépare le symbole
# (contours à gauche) du lettrage, et écrit dans docs/brand/ :
#   symbol-100.txt   le tracé du symbole dans un carré 0..100 (pour <symbol id="px-mark"> de src/partials/sprite.html)
#   word.json        le tracé du lettrage, sa boîte et la position du dégradé de la charte (haut et bas du logo complet)
#   logo.svg         le logo complet en dégradé (référence visuelle)
# Usage : python3 scripts/brand-logo.py   (sans dépendance ; à relancer si le fichier source change)
import json, math, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs/brand/pixcar-logo-trace-maquette.svg")
OUT = os.path.join(ROOT, "docs/brand")
EPS = 0.8
GRAD = [("0", "#F82B15"), ("0.5", "#FC4916"), ("1", "#FB8855")]  # charte, page 8 : vertical, un seul dégradé pour tout le logo

src = open(SRC).read()
a, b, c, d, e, f = map(float, re.search(r'transform="matrix\(([^)]*)\)"', src).group(1).split(","))
tok = re.findall(r"[MLHVZ]|-?\d*\.?\d+", re.search(r' d="([^"]+)"', src).group(1))
subs, cur, cmd, x, y, i = [], None, None, 0.0, 0.0, 0
while i < len(tok):
    t = tok[i]
    if t in "MLHVZ":
        cmd = t
        i += 1
        if t == "Z":
            subs.append(cur)
            cur = None
        continue
    if cmd == "M":
        x, y = float(tok[i]), float(tok[i + 1]); i += 2; cur = [(x, y)]; cmd = "L"
    elif cmd == "L":
        x, y = float(tok[i]), float(tok[i + 1]); i += 2; cur.append((x, y))
    elif cmd == "H":
        x = float(tok[i]); i += 1; cur.append((x, y))
    elif cmd == "V":
        y = float(tok[i]); i += 1; cur.append((x, y))

def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    L = math.hypot(x2 - x1, y2 - y1)
    best, idx = 0.0, 0
    for k in range(1, len(pts) - 1):
        px, py = pts[k]
        dist = abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1) / L if L > 1e-9 else math.hypot(px - x1, py - y1)
        if dist > best:
            best, idx = dist, k
    return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps) if best > eps else [pts[0], pts[-1]]

def simplify(pts):
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    far = max(range(len(pts)), key=lambda k: (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2)
    return rdp(pts[: far + 1], EPS)[:-1] + rdp(pts[far:] + [pts[0]], EPS)[:-1]

contours = [[(a * px + c * py + e, b * px + d * py + f) for px, py in simplify(s)] for s in subs]
box = lambda cs: (min(p[0] for s in cs for p in s), min(p[1] for s in cs for p in s), max(p[0] for s in cs for p in s), max(p[1] for s in cs for p in s))
symbol = [s for s in contours if max(p[0] for p in s) < 625]
word = [s for s in contours if min(p[0] for p in s) >= 625]
assert len(symbol) + len(word) == len(contours) == 22, "contours inattendus"
X0, Y0, X1, Y1 = box(contours)

def num(v, nd):
    s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s

def path(cs, fx, fy, nd):
    return "".join("M" + " ".join(f"{num(fx(px), nd)} {num(fy(py), nd)}" for px, py in s) + "Z" for s in cs)

# symbole : carré 0..100, centré verticalement
sx0, sy0, sx1, sy1 = box(symbol)
side = max(sx1 - sx0, sy1 - sy0)
k = 100 / side
oy = (side - (sy1 - sy0)) / 2
open(os.path.join(OUT, "symbol-100.txt"), "w").write(path(symbol, lambda v: (v - sx0) * k, lambda v: (v - sy0 + oy) * k, 1) + "\n")
grad_sym = [(Y0 - sy0 + oy) * k, (Y1 - sy0 + oy) * k]  # haut et bas du logo complet, dans le repère du symbole
# lettrage : origine au coin de sa boîte
wx0, wy0, wx1, wy1 = box(word)
w = {"d": path(word, lambda v: v - wx0, lambda v: v - wy0, 1), "w": round(wx1 - wx0, 1), "h": round(wy1 - wy0, 1), "grad": [round(Y0 - wy0, 1), round(Y1 - wy0, 1)], "symbolGrad": [round(v, 1) for v in grad_sym], "stops": GRAD}
json.dump(w, open(os.path.join(OUT, "word.json"), "w"), indent=1)
stops = "".join(f'<stop offset="{o}" stop-color="{col}"/>' for o, col in GRAD)
full = path(contours, lambda v: v - X0, lambda v: v - Y0, 1)
open(os.path.join(OUT, "logo.svg"), "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(X1 - X0, 1)} {num(Y1 - Y0, 1)}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">{stops}</linearGradient></defs><path fill="url(#g)" d="{full}"/></svg>\n'
)
print(f"symbole : {len(symbol)} contours, {sum(map(len, symbol))} points ; lettrage : {len(word)} contours, {sum(map(len, word))} points ; logo {X1 - X0:.1f} x {Y1 - Y0:.1f}")

# --apply : reporte le logo dans le site (symbole du sprite, mot-symbole .px-word de css/app.css, favicon.svg, source de
# l'icône Apple). Ensuite : node scripts/favicon-ico.mjs (favicon.ico) et node scripts/apple-touch-icon.mjs (apple-touch-icon.png).
import sys
if "--apply" in sys.argv:
    stops_q = "".join(f"<stop offset='{o}' stop-color='%23{col[1:]}'/>" for o, col in GRAD)
    def word_url(fill_def, fill):
        svg = f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {num(w['w'], 1)} {num(w['h'], 1)}'>{fill_def}<path fill='{fill}' d='{w['d']}'/></svg>"
        return 'url("data:image/svg+xml,' + svg + '")'
    grad_def = f"<linearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' y1='{num(w['grad'][0], 1)}' x2='0' y2='{num(w['grad'][1], 1)}'>{stops_q}</linearGradient>"
    css_path = os.path.join(ROOT, "src/css/app.css")
    css = open(css_path).read()
    block = re.search(r"/\* Mot-symbole[^\n]*\*/\n\.px-word \{[^}]*\}\n", css)
    assert block, ".px-word introuvable"
    new_block = (
        "/* Mot-symbole « pixcar » (charte du 23 octobre 2026 ; scripts/brand-logo.py) : dégradé de la charte pour les fonds sombres,\n"
        "   version noire (.px-word.ink) pour les fonds clairs */\n"
        ".px-word {\n  display: block;\n  flex: none;\n"
        f"  aspect-ratio: {num(w['w'], 1)} / {num(w['h'], 1)};\n"
        f"  background: {word_url(grad_def, 'url(%23g)')} center / contain no-repeat;\n"
        "}\n"
        ".px-word.ink {\n"
        f"  background-image: {word_url('', '%23000')};\n"
        "}\n"
    )
    css = css.replace(block.group(0), new_block)
    open(css_path, "w").write(css)
    g0, g1 = w["symbolGrad"]
    sym = open(os.path.join(OUT, "symbol-100.txt")).read().strip()
    stops = "".join(f'<stop offset="{o}" stop-color="{col}"/>' for o, col in GRAD)
    sprite_path = os.path.join(ROOT, "src/partials/sprite.html")
    sprite = open(sprite_path).read()
    sprite, n = re.subn(
        r'<symbol id="px-mark"[\s\S]*?</symbol>',
        f'<symbol id="px-mark" viewBox="0 0 100 100"><linearGradient id="px-grad" gradientUnits="userSpaceOnUse" x1="0" y1="{g0:.1f}" x2="0" y2="{g1:.1f}">{stops}</linearGradient><path d="{sym}"/></symbol>',
        sprite,
    )
    assert n == 1, "symbole px-mark introuvable"
    open(sprite_path, "w").write(sprite)
    fav = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="{g0:.1f}" x2="0" y2="{g1:.1f}">{stops}</linearGradient></defs><rect width="100" height="100" rx="22"/><path transform="translate(13 13) scale(.74)" fill="url(#g)" d="{sym}"/></svg>\n'
    open(os.path.join(ROOT, "src/assets/favicon.svg"), "w").write(fav)
    touch = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="{g0:.1f}" x2="0" y2="{g1:.1f}">{stops}</linearGradient></defs><rect width="100" height="100"/><path transform="translate(17 17) scale(.66)" fill="url(#g)" d="{sym}"/></svg>\n'
    open(os.path.join(OUT, "apple-touch-icon.svg"), "w").write(touch)
    print("reporté : src/css/app.css (.px-word), src/partials/sprite.html (#px-mark), src/assets/favicon.svg, docs/brand/apple-touch-icon.svg")
