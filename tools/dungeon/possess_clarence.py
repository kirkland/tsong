#!/usr/bin/env python3
# Turn the (grey-keyed) Clarence headshot into the boss-floor GATEKEEPER: a cold violet grade, dark
# veins, then clean glowing vertigo eyes laid down LAST (over the grain, so they stay crisp) right on
# his real eyes. Keeps him recognizable. Output: client/public/dungeon/mob_clarence.png. PIL-only.
from PIL import Image, ImageEnhance, ImageChops, ImageFilter
import math, random
random.seed(515)

src = Image.open('/tmp/clarence_keyed.png').convert('RGBA')
W, H = src.size
rgb = src.convert('RGB'); alpha = src.split()[3]

# 1) cold, otherworldly grade — drain warmth, deepen, push a violet cast
g = ImageEnhance.Color(rgb).enhance(0.55)
g = ImageEnhance.Contrast(g).enhance(1.18)
g = ImageEnhance.Brightness(g).enhance(0.7)
cast = Image.new('RGB', (W, H), (140, 130, 165))      # cold violet-grey
g = ImageChops.multiply(g, cast)
g = ImageChops.add(g, Image.new('RGB', (W, H), (14, 10, 22)))
px = g.load()

EYES = [(0.406 * W, 0.246 * H), (0.559 * W, 0.240 * H)]   # measured on his actual eyes

def blob(cx, cy, rx, ry, fn):
    for y in range(max(0, int(cy-ry)), min(H, int(cy+ry))):
        for x in range(max(0, int(cx-rx)), min(W, int(cx+rx))):
            d = ((x-cx)/rx)**2 + ((y-cy)/ry)**2
            if d <= 1: fn(x, y, 1-math.sqrt(d))

# 2) dark veins crawling from the eyes/temples (drawn before the glow so the glow sits on top)
def vein(x, y, steps, ang):
    for _ in range(steps):
        if 0 <= int(x) < W and 0 <= int(y) < H:
            o = px[int(x), int(y)]; px[int(x), int(y)] = (int(o[0]*0.45), int(o[1]*0.4), int(o[2]*0.55))
        ang += random.uniform(-0.5, 0.5); x += math.cos(ang)*1.5; y += math.sin(ang)*1.5
for ex, ey in EYES:
    for _ in range(5):
        vein(ex + random.uniform(-12, 12), ey + random.uniform(-6, 6), random.randint(12, 26), random.uniform(-1.9, -1.0))  # up into the brow
        vein(ex + random.uniform(-12, 12), ey + random.uniform(-4, 8), random.randint(8, 16), random.uniform(2.5, 3.7))     # down the cheek

# 3) grain + sharpen for an unstable texture
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=70))
gp = g.load()
for y in range(H):
    for x in range(W):
        n = random.randint(-8, 8); o = gp[x, y]
        gp[x, y] = (max(0, min(255, o[0]+n)), max(0, min(255, o[1]+n)), max(0, min(255, o[2]+n)))
px = g.load()

# 4) (eye glow removed for now — keep his real eyes; design to be revisited later)

# 5) keep the original silhouette alpha, drop stray specks (largest opaque blob only)
out = Image.merge('RGBA', (*g.split(), alpha))
ap = out.load()
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

out.save('client/public/dungeon/mob_clarence.png')
print('wrote client/public/dungeon/mob_clarence.png', out.size)
prev = Image.new('RGBA', (W, H), (18, 14, 26, 255)); prev.alpha_composite(out)
prev.convert('RGB').save('/tmp/clarence_preview.png')
