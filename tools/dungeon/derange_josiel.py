#!/usr/bin/env python3
# Derange the (grey-keyed) Josiel portrait: bloodshot wild eyes, manic grin, feverish/sweaty grade.
# Keeps him recognizable. Output: client/public/dungeon/mob_josiel.png. PIL-only.
from PIL import Image, ImageEnhance, ImageChops, ImageFilter
import math, random
random.seed(777)

src = Image.open('/tmp/josiel_cropped.png').convert('RGBA')
W, H = src.size
rgb = src.convert('RGB'); alpha = src.split()[3]

# 1) feverish grade — drained, a touch sickly-yellow, sweaty highlights
g = ImageEnhance.Color(rgb).enhance(0.62)
g = ImageEnhance.Contrast(g).enhance(1.22)
g = ImageEnhance.Brightness(g).enhance(0.84)
cast = Image.new('RGB', (W, H), (158, 156, 134))   # sallow, feverish
g = ImageChops.multiply(g, cast)
g = ImageChops.add(g, Image.new('RGB', (W, H), (16, 12, 8)))
px = g.load()

def blob(cx, cy, rx, ry, fn):
    for y in range(max(0, int(cy-ry)), min(H, int(cy+ry))):
        for x in range(max(0, int(cx-rx)), min(W, int(cx+rx))):
            d = ((x-cx)/rx)**2 + ((y-cy)/ry)**2
            if d <= 1: fn(x, y, 1-math.sqrt(d))

EYES = [(0.385*W, 0.305*H), (0.64*W, 0.305*H)]
# 2) bloodshot wild eyes — brighten the whites (wide stare), red wash, a few veins, a tiny hot pupil glint
for ex, ey in EYES:
    blob(ex, ey, 16, 9, lambda x, y, f: px.__setitem__((x, y), (min(255, int(px[x, y][0]+85*f)), min(255, int(px[x, y][1]+55*f)), min(255, int(px[x, y][2]+45*f)))))  # bright wide sclera
    blob(ex, ey, 15, 8, lambda x, y, f: px.__setitem__((x, y), (min(255, int(px[x, y][0]+55*f)), int(px[x, y][1]*(1-0.18*f)), int(px[x, y][2]*(1-0.22*f)))))  # reddened bloodshot wash
    blob(ex, ey+11, 13, 7, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.4*f)) for c in px[x, y])))  # dark eyebag
    px[int(ex), int(ey)] = (250, 235, 220)            # manic glint
# a few red veins across each eye
def vein(x, y, steps, ang, col):
    for _ in range(steps):
        if 0 <= int(x) < W and 0 <= int(y) < H:
            o = px[int(x), int(y)]; px[int(x), int(y)] = (min(255, int(o[0]*0.5+col[0]*0.5)), int(o[1]*0.6), int(o[2]*0.6))
        ang += random.uniform(-0.5, 0.5); x += math.cos(ang)*1.2; y += math.sin(ang)*1.2
for ex, ey in EYES:
    for _ in range(4):
        vein(ex, ey, random.randint(5, 10), random.uniform(0, 6.28), (200, 20, 20))

# 3) manic grin — deepen + darken the corners so the smile reads unhinged
blob(0.5*W, 0.45*H, 0.30*W, 0.05*H, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.28*f)) for c in px[x, y])))

# 4) sweat sheen + grain
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=75))
gp = g.load()
for y in range(H):
    for x in range(W):
        n = random.randint(-9, 9); o = gp[x, y]
        gp[x, y] = (max(0, min(255, o[0]+n)), max(0, min(255, o[1]+n)), max(0, min(255, o[2]+n)))

out = Image.merge('RGBA', (*g.split(), alpha))
out.save('client/public/dungeon/mob_josiel.png')
print('wrote client/public/dungeon/mob_josiel.png', out.size)
prev = Image.new('RGBA', (W, H), (24, 18, 14, 255)); prev.alpha_composite(out)
prev.convert('RGB').save('/tmp/josiel_preview.png')
