"""Calculs de contraste WCAG (luminance relative, rapport, mélange alpha), partagés par contrast_css.py."""
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
