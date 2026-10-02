"""Contrast audit computed from the SHIPPED tokens (build/app.css light block + build/dark.tokens.css)."""
import re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
from contrast_px import ratio, blend, lum, rgb

def parse(block):
    t = {}
    for k, v in re.findall(r'(--[a-z0-9-]+):\s*([^;]+);', block):
        t[k] = v.strip()
    return t
css = open(ROOT / 'src/css/app.css', encoding='utf8').read()
m = re.search(r'  color-scheme: light;\n(.*?)  --shadow-lg: [^\n]*\n', css, re.S)
LIGHT = parse(m.group(1)); DARK = parse(open(ROOT / 'src/css/tokens.dark.css', encoding='utf8').read())

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
def glass_ends(T):
    stops = re.findall(r'rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)', T['--glass'])
    return [blend('#%02X%02X%02X' % tuple(int(x) for x in s[:3]), solid(T['--canvas'], '#000000'), float(s[3])) for s in (stops[0], stops[-1])] + \
           [blend('#%02X%02X%02X' % tuple(int(x) for x in s[:3]), solid(T['--canvas'], '#000000'), float(s[3])) for s in stops[1:-1]]

def audit(name, T):
    canvas = solid(T['--canvas'], '#000000')
    g = glass_ends(T)
    glows = [solid(T[k], canvas) for k in ('--glow-a', '--glow-b', '--glow-c')]
    peaks = [blend(*(hexof(T[k])[0], canvas, hexof(T[k])[1])) if isinstance(hexof(T[k]), tuple) else canvas for k in ('--glow-a', '--glow-b', '--glow-c')]
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
        for bn in ('card', 'glass0', 'glass1'):
            pass
    chk('promo-fg on promo-bg', hexof(T['--promo-fg']), hexof(T['--promo-bg']))
    chk('on-btn on btn', hexof(T['--on-btn']), hexof(T['--btn']))
    chk('tip-fg on tip-bg', hexof(T['--tip-fg']), hexof(T['--tip-bg']))
    chk('red on card', hexof(T['--red']), hexof(T['--card']))
    chk('ink-2 on card-2 (tag.info, svc.likely)', hexof(T['--ink-2']), hexof(T['--card-2']))
    chk('ink on card-2 (act-route)', hexof(T['--ink']), hexof(T['--card-2']))
    chk('accent-ink on card (links in tinted boxes)', hexof(T['--accent-ink']), hexof(T['--card']))
    # chrome (always black)
    rail = solid(T['--rail-bg'], '#000000')
    chk('chrome-ink on rail', '#F2F2F2', rail); chk('chrome-ink-2 on rail', hexof(T['--chrome-ink-2']), rail)
    hov = blend('#FFFFFF', rail, 0.10); chk('chrome-ink-2 on hover', hexof(T['--chrome-ink-2']), hov); chk('chrome-ink on hover', '#F2F2F2', hov)
    chk('black on lime', '#000000', '#79FA52'); chk('mint on chrome-tint (desktop add button)', '#9DFC8C', blend('#9DFC8C', rail, 0.16))
    chk('lime focus ring on rail (non-text)', '#79FA52', rail, 3.0); chk('mint symbol on black (non-text)', '#9DFC8C', '#000000', 3.0)
    chk('lime "car" on black plate', '#79FA52', '#000000'); chk('ice "pix" on black plate', '#F2F2F2', '#000000')
    bad = [r for r in rows if not r[0]]
    print(f'=== {name}: {len(rows) - len(bad)}/{len(rows)} pass')
    for ok, label, fg, bg, r, need in bad: print(f'  LOW {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
    if '--all' in sys.argv:
        for ok, label, fg, bg, r, need in rows: print(f'  {"OK " if ok else "LOW"} {label:50s} {fg} on {bg} {r:5.2f} (need {need})')
audit('LIGHT (shipped tokens)', LIGHT); audit('DARK (shipped tokens)', DARK)
