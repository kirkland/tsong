#!/usr/bin/env python3
# Possess the (black-keyed) Noam portrait: blacked-out demon eyes, dark veins crawling up the face,
# sickly cold grade. Keeps him recognizable. Output: client/public/dungeon/mob_noam.png. PIL-only.
from PIL import Image, ImageEnhance, ImageChops, ImageDraw, ImageFilter
import math, random
random.seed(404)

src = Image.open('/tmp/noam_cropped.png').convert('RGBA')
W, H = src.size
rgb = src.convert('RGB'); alpha = src.split()[3]

# 1) sickly cold grade — desaturate part-way, deepen, drain warmth
g = ImageEnhance.Color(rgb).enhance(0.5)
g = ImageEnhance.Contrast(g).enhance(1.2)
g = ImageEnhance.Brightness(g).enhance(0.72)
cast = Image.new('RGB', (W, H), (140, 150, 142))     # cold grey-green
g = ImageChops.multiply(g, cast)
g = ImageChops.add(g, Image.new('RGB', (W, H), (12, 10, 16)))
px = g.load()

def blob(cx, cy, rx, ry, fn):
    for y in range(max(0, int(cy-ry)), min(H, int(cy+ry))):
        for x in range(max(0, int(cx-rx)), min(W, int(cx+rx))):
            d = ((x-cx)/rx)**2 + ((y-cy)/ry)**2
            if d <= 1: fn(x, y, 1-math.sqrt(d))

EYES = [(0.275*W, 0.465*H), (0.555*W, 0.465*H)]
# 2) (eye effect removed for now — keep his real eyes; design to be revisited later)

# 3) veins crawling up from the eyes/temples — dark branching random walks
def vein(x, y, steps, ang):
    for _ in range(steps):
        if 0 <= int(x) < W and 0 <= int(y) < H:
            o = px[int(x), int(y)]; px[int(x), int(y)] = (int(o[0]*0.42), int(o[1]*0.5), int(o[2]*0.45))
        ang += random.uniform(-0.5, 0.5); x += math.cos(ang)*1.4; y += math.sin(ang)*1.4
for ex, ey in EYES:
    for _ in range(5):
        vein(ex + random.uniform(-10, 10), ey + random.uniform(-6, 6), random.randint(10, 26), random.uniform(-1.8, -1.0))  # up
        vein(ex + random.uniform(-10, 10), ey + random.uniform(-6, 6), random.randint(8, 18), random.uniform(2.6, 3.6))     # down-out

# 4) deepen + faintly widen the grin (darken the mouth corners so it reads too-wide)
blob(0.5*W, 0.70*H, 0.30*W, 0.07*H, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.3*f)) for c in px[x, y])))

# 5) grain + sharpen for a crawling texture
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=70))
gp = g.load()
for y in range(H):
    for x in range(W):
        n = random.randint(-9, 9); o = gp[x, y]
        gp[x, y] = (max(0, min(255, o[0]+n)), max(0, min(255, o[1]+n)), max(0, min(255, o[2]+n)))

# 6) keep the original silhouette alpha, darken toward its edges, drop stray specks (largest blob)
out = Image.merge('RGBA', (*g.split(), alpha))
ap = out.load()
# largest connected opaque component
seen = bytearray(W*H); best = []
for sy in range(H):
    for sx in range(W):
        if seen[sy*W+sx] or ap[sx, sy][3] == 0: continue
        comp = []; seen[sy*W+sx] = 1; stk = [(sx, sy)]
        while stk:
            x, y = stk.pop(); comp.append((x, y))
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                if 0 <= nx < W and 0 <= ny < H and not seen[ny*W+nx] and ap[nx, ny][3] != 0:
                    seen[ny*W+nx] = 1; stk.append((nx, ny))
        if len(comp) > len(best): best = comp
keep = set(best)
for sy in range(H):
    for sx in range(W):
        if ap[sx, sy][3] != 0 and (sx, sy) not in keep:
            c = ap[sx, sy]; ap[sx, sy] = (c[0], c[1], c[2], 0)

out.save('client/public/dungeon/mob_noam.png')
print('wrote client/public/dungeon/mob_noam.png', out.size)
prev = Image.new('RGBA', (W, H), (22, 20, 26, 255)); prev.alpha_composite(out)
prev.convert('RGB').save('/tmp/noam_preview.png')
