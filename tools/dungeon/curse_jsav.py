#!/usr/bin/env python3
# Curse the REAL jsav photo in place — keep him recognizable, just dead. PIL-only.
# Output: client/public/dungeon/mob_jsav.png (transparent floating cursed head).
from PIL import Image, ImageEnhance, ImageChops, ImageDraw, ImageFilter, ImageOps
import math, random
random.seed(666)

S = 256
src = Image.open('client/public/jsav.jpg').convert('RGB').resize((S, S), Image.LANCZOS)

# 1) corpse grade — desaturate part-way (stay recognizable), cold green-grey cast, deepen
g = ImageEnhance.Color(src).enhance(0.45)
g = ImageEnhance.Contrast(g).enhance(1.18)
g = ImageEnhance.Brightness(g).enhance(0.82)
cast = Image.new('RGB', (S, S), (150, 165, 140))          # sickly green-grey
g = ImageChops.multiply(g, cast)
g = ImageChops.add(g, Image.new('RGB', (S, S), (18, 16, 14)))  # lift blacks to dried-blood brown
px = g.load()

def blob(cx, cy, rx, ry, fn):
    for y in range(max(0, int(cy-ry)), min(S, int(cy+ry))):
        for x in range(max(0, int(cx-rx)), min(S, int(cx+rx))):
            d = ((x-cx)/rx)**2 + ((y-cy)/ry)**2
            if d <= 1: fn(x, y, 1-math.sqrt(d))

# eye centres (his face is centred in the frame)
EYES = [(0.395*S, 0.455*S), (0.625*S, 0.455*S)]

# 2) sink the eye sockets (darken a ring), bruise the under-eyes
for ex, ey in EYES:
    blob(ex, ey, 22, 18, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.55*f)) for c in px[x, y])))
    blob(ex, ey+18, 16, 9, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.4*f)) for c in px[x, y])))  # eyebag hollow

# 3) (no glowing eyes — the sunken dark sockets above carry the cursed look)

# 4) necrotic blotches — a few dark green-grey patches multiplied onto cheeks/forehead
for _ in range(9):
    bx, by = random.randint(40, S-40), random.randint(40, S-50)
    rx, ry = random.randint(10, 26), random.randint(8, 22)
    tint = (random.randint(70, 110), random.randint(95, 130), random.randint(70, 100))
    blob(bx, by, rx, ry, lambda x, y, f, t=tint: px.__setitem__((x, y), tuple(int(px[x, y][i]*(1-0.5*f) + t[i]*0.5*f*px[x, y][i]/255) for i in range(3))))

# 5) cracked dead skin — thin dark random-walk veins
def vein(x, y, steps, ang):
    for _ in range(steps):
        if 0 <= int(x) < S and 0 <= int(y) < S:
            o = px[int(x), int(y)]; px[int(x), int(y)] = (int(o[0]*0.45), int(o[1]*0.42), int(o[2]*0.4))
        ang += random.uniform(-0.6, 0.6); x += math.cos(ang)*1.3; y += math.sin(ang)*1.3
for _ in range(22):
    vein(random.randint(50, S-50), random.randint(40, S-60), random.randint(8, 22), random.uniform(0, 6.28))

# 6) deepen the mouth so the smile reads as a rictus
blob(0.5*S, 0.72*S, 30, 12, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.35*f)) for c in px[x, y])))

# 7) grain + a touch of sharpen for that crawling texture
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=80))
gp = g.load()
for y in range(S):
    for x in range(S):
        n = random.randint(-12, 12); o = gp[x, y]
        gp[x, y] = (max(0, min(255, o[0]+n)), max(0, min(255, o[1]+n)), max(0, min(255, o[2]+n)))

# 8) vignette + oval alpha (floating cursed head)
out = g.convert('RGBA'); op = out.load()
cx, cy, rx, ry = S/2, S*0.5, S*0.46, S*0.5
for y in range(S):
    for x in range(S):
        d = math.sqrt(((x-cx)/rx)**2 + ((y-cy)/ry)**2)
        o = op[x, y]
        if d <= 1:
            shade = 1 if d < 0.62 else max(0.35, 1-(d-0.62)*1.5)   # darken toward rim
            a = 255 if d < 0.93 else int(255*(1-(d-0.93)/0.07))
            op[x, y] = (int(o[0]*shade), int(o[1]*shade), int(o[2]*shade), max(0, a))
        else:
            op[x, y] = (o[0], o[1], o[2], 0)

out.save('client/public/dungeon/mob_jsav.png')
print('wrote client/public/dungeon/mob_jsav.png', out.size)
prev = Image.new('RGBA', (S, S), (24, 26, 30, 255)); prev.alpha_composite(out)
prev.convert('RGB').save('/tmp/jsav_preview.png')
