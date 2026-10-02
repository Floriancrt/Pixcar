"""WCAG checks for the Pixcar palette (black + #9DFC8C + #79FA52 + #F2F2F2)."""
def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def rgb(h):
    h = h.lstrip('#'); return [int(h[i:i+2], 16) for i in (0, 2, 4)]
def lum(h):
    r, g, b = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
def ratio(a, b):
    la, lb = lum(a), lum(b)
    if la < lb: la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)
def blend(fg, bg, a):
    f, b = rgb(fg), rgb(bg)
    return '#%02X%02X%02X' % tuple(round(f[i] * a + b[i] * (1 - a)) for i in range(3))

LIGHT = dict(
  canvas='#EDF1EC', card='#FFFFFF', card2='#F2F5F1', glassA='#FFFFFF', glassB='#EEF8EB',
  glow_mint=('#9DFC8C', 0.50), glow_lime=('#79FA52', 0.26), glow_pale=('#B4E1C8', 0.45),
  ink='#0A0D0A', ink2='#3A4139', ink3='#485047', line_strong='#6B7568',
  accent='#0B7A2A', accent_soft='#DCF8D3', accent_ink='#0A4D1B',
  promo_soft='#E3FCD3', promo_ink='#0F5A1E',
  mint_soft='#CDF5C2', mint_ink='#0B5D22',
  amber_soft='#FDEBC8', amber_ink='#7A4A00',
  red='#B3101A', red_soft='#FDE8E8',
  btn='#0A0D0A', on_btn='#FFFFFF',
  chrome='#000000', chrome_ink='#F2F2F2', chrome_ink3='#B4BAB2', lime='#79FA52', mint='#9DFC8C',
  tip_bg='#0A0D0A', tip_fg='#FFFFFF',
)
DARK = dict(
  canvas='#040604', card='#101410', card2='#181E18', glassA='#101410', glassB='#0A120A',
  glow_mint=('#79FA52', 0.16), glow_lime=('#9DFC8C', 0.10), glow_pale=('#1E8C46', 0.18),
  ink='#F2F2F2', ink2='#C8CDC6', ink3='#A1A89F', line_strong='#7A8577',
  accent='#79FA52', accent_soft='#12260F', accent_ink='#B4FD9F',
  promo_soft='#162A10', promo_ink='#B4FD9F',
  mint_soft='#11301A', mint_ink='#8EF0A8',
  amber_soft='#3A2C0E', amber_ink='#F2C062',
  red='#FF8A8A', red_soft='#3F1B1D',
  btn='#79FA52', on_btn='#031003',
  chrome='#000000', chrome_ink='#F2F2F2', chrome_ink3='#B4BAB2', lime='#79FA52', mint='#9DFC8C',
  tip_bg='#F2F2F2', tip_fg='#0A0D0A',
)

def report(name, T):
    rows = []
    def chk(label, fg, bg, need=4.5):
        r = ratio(fg, bg); rows.append(('OK ' if r >= need else 'LOW', label, fg, bg, r, need))
    # effective backgrounds: canvas with the strongest glow on top, panel glass
    bgs = {'card': T['card'], 'card2': T['card2'], 'canvas': T['canvas'], 'glassA': T['glassA'], 'glassB': T['glassB']}
    for k in ('glow_mint', 'glow_lime', 'glow_pale'):
        col, a = T[k]; bgs['canvas+' + k] = blend(col, T['canvas'], a)
    for bgname, bg in bgs.items():
        for tn in ('ink', 'ink2', 'ink3'):
            chk(f'{tn} on {bgname}', T[tn], bg)
        chk(f'accent (links) on {bgname}', T['accent'], bg)
    for tone in ('accent', 'promo', 'mint', 'amber'):
        chk(f'{tone}_ink on {tone}_soft', T[tone + '_ink'], T[tone + '_soft'])
    # soft chips sit on cards / glass
    for tone in ('accent', 'promo', 'mint'):
        for bgname in ('card', 'glassA', 'glassB'):
            chk(f'{tone}_soft chip boundary vs {bgname} (info, not required)', T[tone + '_soft'], bgs[bgname], 1.0)
    chk('red on card', T['red'], T['card']); chk('red on red_soft', T['red'], T['red_soft'])
    chk('btn label', T['on_btn'], T['btn'])
    chk('tooltip', T['tip_fg'], T['tip_bg'])
    chk('chrome text (ice on black)', T['chrome_ink'], T['chrome']); chk('chrome muted text', T['chrome_ink3'], T['chrome'])
    hov = blend('#FFFFFF', '#000000', 0.10)
    chk('chrome muted text on hover', T['chrome_ink3'], hov); chk('chrome text on hover', T['chrome_ink'], hov)
    chk('black on lime (active tab / add / count)', '#000000', T['lime']); chk('mint symbol on black (non-text)', T['mint'], T['chrome'], 3.0)
    chk('lime on black (focus ring in chrome, non-text)', T['lime'], T['chrome'], 3.0)
    mint_tint = blend('#9DFC8C', '#000000', 0.16); chk('mint on mint-tint (add button desktop)', T['mint'], mint_tint)
    for bgname in ('card', 'glassA', 'canvas', 'glassB'):
        chk(f'line_strong (input border) vs {bgname} (non-text)', T['line_strong'], bgs[bgname], 3.0)
    for bgname in ('card', 'glassA', 'canvas', 'glassB'):
        chk(f'accent (focus / selected outline) vs {bgname} (non-text)', T['accent'], bgs[bgname], 3.0)
    print('=== ', name)
    bad = [r for r in rows if r[0] == 'LOW' and r[5] > 1.0]
    for ok, label, fg, bg, r, need in rows:
        if need <= 1.0: continue
        if ok == 'LOW' or '--all' in __import__('sys').argv:
            print(f'  {ok} {label:62s} {fg} on {bg}  {r:5.2f} (need {need})')
    print(f'  -> {len([r for r in rows if r[5] > 1.0]) - len(bad)}/{len([r for r in rows if r[5] > 1.0])} pass')
    return rows
if __name__ == '__main__':
    report('LIGHT', LIGHT); report('DARK', DARK)
