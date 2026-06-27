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

EYES = [(0.46*W, 0.305*H), (0.715*W, 0.305*H)]
# 2) (eye effect removed for now — keep his real eyes; design to be revisited later)

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
