"""Generate Obfuscate icons: menu bar template glyphs + full-color app icon."""
import math, os, sys, random
import cairosvg

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def coverage(x0, y0, size, cx, cy, R, r, ss=12):
    """Fraction of a square block covered by the annulus."""
    hit = 0
    for i in range(ss):
        for j in range(ss):
            x = x0 + (i + 0.5) * size / ss
            y = y0 + (j + 0.5) * size / ss
            d = math.hypot(x - cx, y - cy)
            if r <= d <= R and x >= cx:
                hit += 1
    return hit / (ss * ss)


def mosaic(cols, rows, x0, y0, size, cx, cy, R, r, blur=0.35):
    grid = {}
    for c in range(cols):
        for k in range(rows):
            grid[(c, k)] = coverage(x0 + c * size, y0 + k * size, size, cx, cy, R, r)
    # light box blur so edges smear like a real pixelate filter
    out = {}
    for (c, k), v in grid.items():
        nb = [grid.get((c + dc, k + dk), 0) for dc in (-1, 0, 1) for dk in (-1, 0, 1) if (dc or dk)]
        out[(c, k)] = (1 - blur) * v + blur * (sum(nb) / len(nb))
    return out


def quant(v, levels):
    # levels: list of (threshold, alpha) descending
    for t, a in levels:
        if v >= t:
            return a
    return 0


# ---------------------------------------------------------------- tray glyphs
# Canvas 19 x 18 pt (odd width so a 1pt divider sits exactly on the pixel grid).
W, H = 19, 18
CX, CY = 9.5, 9.0


# Hand-tuned 2pt pixel map for the right half: (col, row) -> alpha.
# cols x = 10,12,14,16 ; rows y = 1,3,...,15. Follows the ring's right arc,
# with a few low-alpha "smear" blocks so it reads as pixelate-blur, not a D.
TRAY_MAP = {
    (0,0):1.0, (1,0):0.55,            (2,0):0.25,
    (0,1):0.3, (1,1):1.0, (2,1):1.0,
               (1,2):0.25,(2,2):1.0, (3,2):0.55,
                          (2,3):0.55,(3,3):1.0,
                          (2,4):0.55,(3,4):1.0,
               (1,5):0.25,(2,5):1.0, (3,5):0.55,
    (0,6):0.3, (1,6):1.0, (2,6):1.0,
    (0,7):1.0, (1,7):0.55,            (3,6):0.25,
}

def tray_svg(block=2, divider=True, R=8.0, r=6.0, gap=False):
    parts = []
    parts.append(
        f'<clipPath id="L"><rect x="0" y="0" width="{CX - (0.5 if gap else 0)}" height="{H}"/></clipPath>'
        f'<path clip-path="url(#L)" fill-rule="evenodd" d="M{CX - R},{CY} a{R},{R} 0 1,0 {2*R},0 a{R},{R} 0 1,0 {-2*R},0 Z '
        f'M{CX - r},{CY} a{r},{r} 0 1,0 {2*r},0 a{r},{r} 0 1,0 {-2*r},0 Z" fill="#000"/>'
    )
    if divider:
        parts.append(f'<rect x="{CX-0.5}" y="0" width="1" height="{H}" fill="#000"/>')
    for (c,k),a in TRAY_MAP.items():
        x, y = CX + 0.5 + c*2, 1 + k*2
        parts.append(f'<rect x="{x}" y="{y}" width="2" height="2" fill="#000" fill-opacity="{a}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">{"".join(parts)}</svg>'


variants = {
    "A": tray_svg(),                         # with divider (recommended)
    "B": tray_svg(divider=False, gap=True),  # no divider, 1pt gap
}
for k, svg in variants.items():
    p = f"{OUT}/tray_{k}.svg"
    open(p, "w").write(svg)
    for scale, suf in ((1, ""), (2, "@2x"), (3, "@3x")):
        cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/ObfuscateTemplate_{k}{suf}.png",
                         output_width=W * scale, output_height=H * scale)

# ---------------------------------------------------------------- app icon
S = 1024


def squircle(x, y, w, h, n=5.0, steps=360):
    pts = []
    a, b = w / 2, h / 2
    cx, cy = x + a, y + b
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        px = cx + a * math.copysign(abs(ct) ** (2 / n), ct)
        py = cy + b * math.copysign(abs(st) ** (2 / n), st)
        pts.append(f"{px:.2f},{py:.2f}")
    return "M" + " L".join(pts) + " Z"


def app_svg(full_bleed=False):
    cx, cy, R, r = 512, 512, 300, 196
    shape = f'<rect width="{S}" height="{S}"/>' if full_bleed else f'<path d="{squircle(100, 100, 824, 824)}"/>'
    p = []
    p.append("""<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
  <stop offset="0" stop-color="#1A2540"/><stop offset="1" stop-color="#0A0F1E"/></linearGradient>
<radialGradient id="glowbg" cx="0.5" cy="0.42" r="0.6">
  <stop offset="0" stop-color="#2B3E6B" stop-opacity="0.55"/><stop offset="1" stop-color="#2B3E6B" stop-opacity="0"/></radialGradient>
<linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9D6F2"/></linearGradient>
<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#4FF2CF" stop-opacity="0"/><stop offset="0.12" stop-color="#4FF2CF"/>
  <stop offset="0.88" stop-color="#4FF2CF"/><stop offset="1" stop-color="#4FF2CF" stop-opacity="0"/></linearGradient>
<filter id="blur" x="-2" y="-0.2" width="5" height="1.4"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="shadow" x="-0.3" y="-0.3" width="1.6" height="1.6"><feGaussianBlur stdDeviation="10"/></filter>
""")
    p.append(f'<clipPath id="shape">{shape}</clipPath>')
    p.append(f'<clipPath id="left"><rect x="0" y="0" width="{cx}" height="{S}"/></clipPath></defs>')
    p.append('<g clip-path="url(#shape)">')
    p.append(f'<rect width="{S}" height="{S}" fill="url(#bg)"/><rect width="{S}" height="{S}" fill="url(#glowbg)"/>')
    ring_d = (f"M{cx-R},{cy} a{R},{R} 0 1,0 {2*R},0 a{R},{R} 0 1,0 {-2*R},0 Z "
              f"M{cx-r},{cy} a{r},{r} 0 1,0 {2*r},0 a{r},{r} 0 1,0 {-2*r},0 Z")
    # soft shadow + left half ring
    p.append(f'<g clip-path="url(#left)"><path d="{ring_d}" fill-rule="evenodd" fill="#000" opacity="0.45" '
             f'transform="translate(0,14)" filter="url(#shadow)"/>'
             f'<path d="{ring_d}" fill-rule="evenodd" fill="url(#ring)"/></g>')
    # right half mosaic
    block, gap = 40, 3
    x0 = cx + 8
    cols = 8
    rows = 18
    y0 = cy - rows // 2 * block
    m = mosaic(cols, rows, x0, y0, block, cx, cy, R + 22, r - 22, blur=0.4)
    palette = ["#5B8CFF", "#7A6CFF", "#4FB8FF", "#9C7BFF", "#6FA0FF", "#C9D6F2"]
    rnd = random.Random(7)
    for (c, k), v in sorted(m.items()):
        a = quant(v, [(0.55, 1.0), (0.32, 0.62), (0.15, 0.32)])
        col = palette[rnd.randrange(len(palette))]
        if a:
            p.append(f'<rect x="{x0+c*block+gap/2}" y="{y0+k*block+gap/2}" width="{block-gap}" height="{block-gap}" '
                     f'rx="5" fill="{col}" fill-opacity="{a}"/>')
    # bisecting beam with glow
    p.append(f'<rect x="{cx-9}" y="150" width="18" height="724" fill="url(#beam)" filter="url(#blur)" opacity="0.9"/>')
    p.append(f'<rect x="{cx-5}" y="150" width="10" height="724" rx="5" fill="url(#beam)"/>')
    p.append(f'<rect x="{cx-1.5}" y="190" width="3" height="644" fill="#E9FFF9" opacity="0.8"/>')
    # top sheen on the tile
    p.append(f'<rect width="{S}" height="{S}" fill="url(#bg)" opacity="0"/></g>')
    if not full_bleed:
        p.append(f'<path d="{squircle(100,100,824,824)}" fill="none" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">{"".join(p)}</svg>'


for name, fb in (("AppIcon", False), ("AppIcon_fullbleed", True)):
    svg = app_svg(fb)
    open(f"{OUT}/{name}.svg", "w").write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f"{OUT}/{name}_1024.png", output_width=1024, output_height=1024)

# macOS .appiconset sizes
iconset = f"{OUT}/AppIcon.appiconset"
os.makedirs(iconset, exist_ok=True)
svg = open(f"{OUT}/AppIcon.svg").read().encode()
entries = []
for pt in (16, 32, 128, 256, 512):
    for sc in (1, 2):
        px = pt * sc
        fn = f"icon_{pt}x{pt}{'@2x' if sc == 2 else ''}.png"
        cairosvg.svg2png(bytestring=svg, write_to=f"{iconset}/{fn}", output_width=px, output_height=px)
        entries.append(f'{{"idiom":"mac","size":"{pt}x{pt}","scale":"{sc}x","filename":"{fn}"}}')
open(f"{iconset}/Contents.json", "w").write('{"images":[' + ",".join(entries) + '],"info":{"version":1,"author":"xcode"}}')
print("done")
