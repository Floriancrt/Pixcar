"""Contrast audit computed from the SHIPPED tokens (src/css/app.css light block + src/css/tokens.dark.css).
WCAG AA : 4.5:1 for text, 3:1 for large text (>= 24 px, or >= 18.67 px bold) and for non-text (borders, focus ring,
markers, symbol, price bar). Design « tableau » : en-tête noir, fond crème, tableau blanc, actions orange.
Le blanc sur orange (3.12:1) n'est permis qu'en grand texte gras : la suite a11y vérifie dans la page que chaque texte
blanc sur orange l'est (taille et graisse calculées)."""
import re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
from contrast_px import ratio, blend, lum, rgb

def parse(block):
    t = {}
    for k, v in re.findall(r'(--[a-z0-9-]+):\s*([^;]+);', block):
        t[k] = v.strip()
    return t
css = open(ROOT / 'src/css/app.css', encoding='utf8').read()
m = re.search(r':root \{\n  color-scheme: light;\n(.*?)\n\}', css, re.S)
LIGHT = parse(m.group(1)); DARK = parse(open(ROOT / 'src/css/tokens.dark.css', encoding='utf8').read())
# la marque (--px-*, plaque du logo) n'est définie que dans le bloc clair : le thème sombre l'hérite
BRAND = {k: LIGHT[k] for k in ('--px-mint', '--px-lime', '--px-ice', '--plate')}

def hexof(v):
    v = v.strip()
    if v.startswith('#'):
        return v.upper() if len(v) == 7 else '#' + ''.join(c * 2 for c in v[1:]).upper()
    mm = re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)', v)
    if mm:
        return '#%02X%02X%02X' % tuple(int(mm.group(i)) for i in (1, 2, 3)), float(mm.group(4) or 1)
    raise ValueError(v)
def solid(v, over):
    h = hexof(v)
    if isinstance(h, tuple): return blend(h[0], over, h[1])
    return h
def glass_stops(T):
    canvas = solid(T['--canvas'], '#000000')
    stops = re.findall(r'rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)', T['--glass'])
    return [blend('#%02X%02X%02X' % tuple(int(x) for x in s[:3]), canvas, float(s[3])) for s in stops]

def audit(name, T):
    B = {**BRAND, **T}
    H = lambda k: hexof(B[k])
    canvas = solid(T['--canvas'], '#000000')
    # fonds sur lesquels on écrit du texte courant (encres 1 à 3, orange des liens)
    bgs = {'canvas': canvas, 'card': H('--card'), 'card-2': H('--card-2'), 'thead': H('--thead-bg'), 'best row': H('--best-bg'),
           'row hover': H('--row-hover'), 'pill': H('--pill-bg'), 'search segment': H('--seg-bg')}
    for i, c in enumerate(glass_stops(T)): bgs[f'glass{i} (map info)'] = c
    rows = []
    def chk(label, fg, bg, need=4.5):
        r = ratio(fg, bg); rows.append((r >= need, label, fg, bg, r, need))
    for bn, bg in bgs.items():
        for tk in ('--ink', '--ink-2', '--ink-3', '--accent'):
            chk(f'{tk} on {bn}', H(tk), bg)
        chk(f'--line-strong non-text on {bn}', H('--line-strong'), bg, 3.0)
    chk('accent-strong on canvas (eyebrow, 13.8 px bold)', H('--accent-strong'), canvas)
    chk('accent on accent-soft (hero tag)', H('--accent'), H('--accent-soft'))
    chk('ink-2 on accent-soft (hint of a ticked service, suggestion text)', H('--ink-2'), H('--accent-soft'))
    chk('ink on accent-soft (ticked service, hovered suggestion)', H('--ink'), H('--accent-soft'))
    for tone in ('accent', 'promo', 'mint', 'amber'):
        chk(f'{tone}-ink on {tone}-soft', H(f'--{tone}-ink'), H(f'--{tone}-soft'))
    chk('promo-fg on promo-bg', H('--promo-fg'), H('--promo-bg'))
    # orange : blanc en grand texte gras seulement (Ajouter, Appeler de la ligne la moins chère, chiffre « Le moins cher »)
    chk('on-btn on btn: LARGE BOLD TEXT ONLY (>= 18.67 px, 700)', H('--on-btn'), H('--btn'), 3.0)
    chk("on-btn-2 on btn (current tab, skip link, « Le moins cher » label)", H('--on-btn-2'), H('--btn'))
    chk('act-ink on act-bg (Appeler / Demander)', H('--act-ink'), H('--act-bg'))
    chk('note-ink on note-bg (note under the table)', H('--note-ink'), H('--note-bg'))
    chk('stat-dark-ink on stat-dark (home, label)', H('--stat-dark-ink'), H('--stat-dark'))
    chk('orange number on stat-dark (home, 32.8 px 800: large text)', H('--px-lime'), H('--stat-dark'), 3.0)
    chk('step-ink on step-bg (step numbers)', H('--step-ink'), H('--step-bg'))
    for t in ('blue', 'orange', 'gray'):
        chk(f'tile-{t}-ink on tile-{t} (tile letter)', H(f'--tile-{t}-ink'), H(f'--tile-{t}'))
    chk('tip-fg on tip-bg', H('--tip-fg'), H('--tip-bg'))
    chk('red on card', H('--red'), H('--card'))
    chk('red on card-2 (history Supprimer, hover)', H('--red'), H('--card-2'))
    chk('accent-ink on card (links in tinted boxes)', H('--accent-ink'), H('--card'))
    # échelle de prix, anneau de focus et marqueurs (non textuel)
    chk('price bar non-text on track', H('--bar'), H('--track'), 3.0)
    chk('price bar non-text on best row', H('--bar'), H('--best-bg'), 3.0)
    chk('focus ring non-text on card', H('--focus'), H('--card'), 3.0)
    chk('focus ring non-text on canvas', H('--focus'), canvas, 3.0)
    chk('focus ring non-text on search segment', H('--focus'), H('--seg-bg'), 3.0)
    mapbg = H('--map-bg'); ring = H('--mk-ring'); sel = H('--mk-sel')
    chk('selected marker (fill or ring) non-text on map bg', sel if ratio(sel, mapbg) >= ratio(ring, mapbg) else ring, mapbg, 3.0)
    chk('priced marker non-text on map bg', H('--mk-priced'), mapbg, 3.0)
    # en-tête noir (clair comme sombre)
    top = solid(T['--topbar-bg'], '#000000')
    ci, ci2 = H('--chrome-ink'), H('--chrome-ink-2')
    chk('chrome-ink on topbar', ci, top); chk('chrome-ink-2 on topbar', ci2, top)
    hov = blend('#FFFFFF', top, 0.10); chk('chrome-ink-2 on hover', ci2, hov); chk('chrome-ink on hover', ci, hov)
    lime, mint, ice, plate = H('--px-lime'), H('--px-mint'), H('--px-ice'), H('--plate')
    chk('orange focus ring on topbar (non-text)', lime, top, 3.0); chk('mint symbol on plate (non-text)', mint, plate, 3.0)
    chk('orange "car" on plate', lime, plate); chk('ice "pix" on plate', ice, plate)
    bad = [r for r in rows if not r[0]]
    print(f'=== {name}: {len(rows) - len(bad)}/{len(rows)} pass')
    for ok, label, fg, bg, r, need in bad: print(f'  LOW {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
    if '--all' in sys.argv:
        for ok, label, fg, bg, r, need in rows: print(f'  {"OK " if ok else "LOW"} {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
    return len(bad)
n = audit('LIGHT (shipped tokens)', LIGHT) + audit('DARK (shipped tokens)', DARK)
sys.exit(1 if n else 0)
