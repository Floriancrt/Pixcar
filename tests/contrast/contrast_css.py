"""Contrast audit computed from the SHIPPED tokens (src/css/app.css light block + src/css/tokens.dark.css).
WCAG AA : 4.5:1 for text, 3:1 for non-text (borders, focus ring, markers, symbol). Charte Orange & Marine."""
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
# la marque (--px-*) n'est définie que dans le bloc clair : le thème sombre l'hérite
BRAND = {k: LIGHT[k] for k in ('--px-mint', '--px-lime', '--px-ice')}

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
    canvas = solid(T['--canvas'], '#000000')
    g = glass_stops(T)
    peaks = []
    for k in ('--glow-a', '--glow-b', '--glow-c'):
        h = hexof(T[k]); peaks.append(blend(h[0], canvas, h[1]) if isinstance(h, tuple) else canvas)
    bgs = {'card': hexof(T['--card']), 'card-2': hexof(T['--card-2']), 'canvas': canvas}
    for i, c in enumerate(g): bgs[f'glass{i}'] = c
    for i, c in enumerate(peaks): bgs[f'canvas+glow{i}'] = c
    rows = []
    def chk(label, fg, bg, need=4.5):
        r = ratio(fg, bg); rows.append((r >= need, label, fg, bg, r, need))
    for bn, bg in bgs.items():
        for tk in ('--ink', '--ink-2', '--ink-3', '--accent'):
            chk(f'{tk} on {bn}', hexof(T[tk]), bg)
        for tk in ('--line-strong', '--accent'):
            chk(f'{tk} non-text on {bn}', hexof(T[tk]), bg, 3.0)
    for tone in ('accent', 'promo', 'mint', 'amber'):
        chk(f'{tone}-ink on {tone}-soft', hexof(T[f'--{tone}-ink']), hexof(T[f'--{tone}-soft']))
    chk('promo-fg on promo-bg', hexof(T['--promo-fg']), hexof(T['--promo-bg']))
    chk('on-btn on btn (orange button, navy text)', hexof(T['--on-btn']), hexof(T['--btn']))
    chk('tip-fg on tip-bg', hexof(T['--tip-fg']), hexof(T['--tip-bg']))
    chk('red on card', hexof(T['--red']), hexof(T['--card']))
    chk('red on card-2 (history Supprimer, hover)', hexof(T['--red']), hexof(T['--card-2']))
    chk('ink-2 on card-2 (tag.info, svc.likely)', hexof(T['--ink-2']), hexof(T['--card-2']))
    chk('ink on card-2 (act-route)', hexof(T['--ink']), hexof(T['--card-2']))
    chk('accent-ink on card (links in tinted boxes)', hexof(T['--accent-ink']), hexof(T['--card']))
    # anneau de focus et marqueurs (non textuel)
    chk('focus ring non-text on card', hexof(T['--focus']), hexof(T['--card']), 3.0)
    chk('focus ring non-text on glass', hexof(T['--focus']), g[1], 3.0)
    mapbg = hexof(T['--map-bg']); ring = hexof(T['--mk-ring'])
    sel = hexof(T['--mk-sel'])
    chk('selected marker (fill or ring) non-text on map bg', sel if ratio(sel, mapbg) >= ratio(ring, mapbg) else ring, mapbg, 3.0)
    chk('priced marker non-text on map bg', hexof(T['--mk-priced']), mapbg, 3.0)
    # chrome (rail, barres) : marine en clair comme en sombre
    rail = solid(T['--rail-bg'], '#000000')
    ci, ci2 = hexof(T['--chrome-ink']), hexof(T['--chrome-ink-2'])
    chk('chrome-ink on rail', ci, rail); chk('chrome-ink-2 on rail', ci2, rail)
    hov = blend('#FFFFFF', rail, 0.10); chk('chrome-ink-2 on hover', ci2, hov); chk('chrome-ink on hover', ci, hov)
    lime, mint, ice = hexof(B['--px-lime']), hexof(B['--px-mint']), hexof(B['--px-ice'])
    plate, onlime = hexof(B['--plate']), hexof(B['--on-lime'])
    chk('on-lime text on orange (active tab, add button)', onlime, lime)
    chk('mint on chrome-tint (desktop add button)', mint, blend(lime, rail, 0.18))
    chk('orange focus ring on rail (non-text)', lime, rail, 3.0); chk('mint symbol on rail (non-text)', mint, rail, 3.0)
    chk('orange "car" on plate', lime, plate); chk('ice "pix" on plate', ice, plate)
    bad = [r for r in rows if not r[0]]
    print(f'=== {name}: {len(rows) - len(bad)}/{len(rows)} pass')
    for ok, label, fg, bg, r, need in bad: print(f'  LOW {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
    if '--all' in sys.argv:
        for ok, label, fg, bg, r, need in rows: print(f'  {"OK " if ok else "LOW"} {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
audit('LIGHT (shipped tokens)', LIGHT); audit('DARK (shipped tokens)', DARK)
