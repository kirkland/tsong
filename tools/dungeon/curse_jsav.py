from PIL import Image, ImageEnhance, ImageChops, ImageDraw, ImageOps
import math, random
random.seed(13)

src = Image.open('client/public/jsav.jpg').convert('RGB')   # 128x128 smiling face
N = 42          # pixelation grid
OUT = 256       # final sprite px (chunky 4x blocks)

# 1) pixelate (downscale average -> upscale nearest = blocky)
small = src.resize((N, N), Image.BILINEAR)

# 2) sickly grade: crush saturation, push contrast, darken, cold green-grey cast
g = ImageEnhance.Color(small).enhance(0.30)
g = ImageEnhance.Contrast(g).enhance(1.35)
g = ImageEnhance.Brightness(g).enhance(0.72)
cast = Image.new('RGB', (N, N), (120, 150, 120))           # green-grey corpse cast
g = ImageChops.multiply(g, cast)
g = ImageChops.add(g, Image.new('RGB', (N, N), (24, 14, 14)))  # lift blacks toward dried-blood brown

px = g.load()

# 3) glowing hollow eyes — the face is centered; eyes sit ~ (0.38,0.46) and (0.62,0.46)
def glow(cx, cy, r, col):
    for yy in range(N):
        for xx in range(N):
            d = math.hypot(xx - cx, yy - cy)
            if d < r:
                f = 1 - d / r
                o = px[xx, yy]
                px[xx, yy] = (min(255, int(o[0] + col[0]*f)), min(255, int(o[1] + col[1]*f)), min(255, int(o[2] + col[2]*f)))
for ex in (0.385, 0.625):
    glow(ex*N, 0.455*N, 4.2, (200, 30, 20))     # red socket glow
    px[int(ex*N), int(0.455*N)] = (255, 240, 180)  # hot white pupil

# 4) grime / blood drips: a few dark vertical streaks
for _ in range(7):
    sx = random.randint(6, N-6); sy = random.randint(8, N-20); ln = random.randint(4, 14)
    for k in range(ln):
        o = px[sx, sy+k]
        px[sx, sy+k] = (int(o[0]*0.5+40), int(o[1]*0.35), int(o[2]*0.35))

# 5) upscale blocky
big = g.resize((OUT, OUT), Image.NEAREST)

# 6) RGB glitch — shift red channel a couple blocks
r, gr, b = big.split()
r = ImageChops.offset(r, 5, -3)
big = Image.merge('RGB', (r, gr, b))

# 7) vignette + circular alpha (floating cursed head)
big = big.convert('RGBA')
mask = Image.new('L', (OUT, OUT), 0)
md = ImageDraw.Draw(mask)
cx = cy = OUT/2; R = OUT*0.47
for yy in range(OUT):
    for xx in range(OUT):
        d = math.hypot(xx-cx, yy-cy)
        if d <= R:
            md.point((xx, yy), 255)
        elif d <= R+10:
            md.point((xx, yy), int(255*(1-(d-R)/10)))
# darken toward the rim
vg = big.load()
for yy in range(OUT):
    for xx in range(OUT):
        d = math.hypot(xx-cx, yy-cy)/R
        if d > 0.6:
            f = max(0.25, 1-(d-0.6)*1.4)
            o = vg[xx, yy]; vg[xx, yy] = (int(o[0]*f), int(o[1]*f), int(o[2]*f), o[3])
big.putalpha(mask)

big.save('client/public/dungeon/mob_jsav.png')
print('wrote client/public/dungeon/mob_jsav.png', big.size)
