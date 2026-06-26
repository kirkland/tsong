#!/usr/bin/env python3
# Demonize the fritz photo into "Demon Fritz" — red infernal skin, horns, glowing eyes, fangs.
# Output: client/public/dungeon/mob_fritz.png (transparent floating demon head). PIL-only.
from PIL import Image, ImageEnhance, ImageChops, ImageDraw, ImageFilter
import math, random
random.seed(99)

S = 256
src = Image.open('client/public/fritz.jpg').convert('RGB').resize((S, S), Image.LANCZOS)

# 1) infernal grade — crush toward red, deep contrast, darker
g = ImageEnhance.Color(src).enhance(0.55)
g = ImageEnhance.Contrast(g).enhance(1.3)
g = ImageEnhance.Brightness(g).enhance(0.92)
r, gr, b = g.split()
r = r.point(lambda v: min(255, int(v * 1.55 + 40)))   # pump red
gr = gr.point(lambda v: int(v * 0.62))                 # kill green
b = b.point(lambda v: int(v * 0.55))                   # kill blue
g = Image.merge('RGB', (r, gr, b))
g = ImageChops.add(g, Image.new('RGB', (S, S), (28, 0, 0)))  # warm the blacks toward ember
px = g.load()

def blob(cx, cy, rx, ry, fn):
    for y in range(max(0, int(cy-ry)), min(S, int(cy+ry))):
        for x in range(max(0, int(cx-rx)), min(S, int(cx+rx))):
            d = ((x-cx)/rx)**2 + ((y-cy)/ry)**2
            if d <= 1: fn(x, y, 1-math.sqrt(d))

EYES = [(0.40*S, 0.42*S), (0.60*S, 0.42*S)]
# 2) sink/darken sockets then glowing infernal eyes (hot yellow core, orange halo)
for ex, ey in EYES:
    blob(ex, ey, 18, 15, lambda x, y, f: px.__setitem__((x, y), tuple(int(c*(1-0.45*f)) for c in px[x, y])))
def glow(cx, cy, rr, col):
    for y in range(max(0, int(cy-rr)), min(S, int(cy+rr))):
        for x in range(max(0, int(cx-rr)), min(S, int(cx+rr))):
            d = math.hypot(x-cx, y-cy)
            if d < rr:
                f = (1-d/rr)**1.5; o = px[x, y]
                px[x, y] = tuple(min(255, int(o[i]+col[i]*f)) for i in range(3))
for ex, ey in EYES:
    glow(ex, ey, 12, (190, 90, 10)); glow(ex, ey, 5, (255, 230, 120))

# 3) horns — two bony horns curving up & out from the top of the head
draw = ImageDraw.Draw(g)
HORN, HORN_D = (224, 206, 170), (150, 120, 80)
def horn(x0, y0, dirx):
    pts = []
    n = 16
    for i in range(n):
        t = i/(n-1)
        w = (1-t)*11 + 1                  # taper to a point
        x = x0 + dirx*(t*t*26) ; y = y0 - t*54
        pts.append((x - w, y));
    back = []
    for i in range(n):
        t = i/(n-1); w = (1-t)*11 + 1
        x = x0 + dirx*(t*t*26); y = y0 - t*54
        back.append((x + w, y))
    poly = pts + back[::-1]
    draw.polygon(poly, fill=HORN)
    draw.line(pts, fill=HORN_D, width=2)
horn(0.36*S, 0.20*S, -1)   # left horn curves left
horn(0.64*S, 0.20*S, 1)    # right horn curves right
px = g.load()

# 4) fangs — two little white triangles at the mouth
MW = 0.5*S; MY = 0.66*S
for fx in (MW-10, MW+6):
    draw.polygon([(fx, MY), (fx+5, MY), (fx+2, MY+9)], fill=(240, 235, 220))

# 5) grain + slight sharpen
g = g.filter(ImageFilter.UnsharpMask(radius=2, percent=70))
gp = g.load()
for y in range(S):
    for x in range(S):
        n = random.randint(-10, 10); o = gp[x, y]
        gp[x, y] = tuple(max(0, min(255, o[i]+n)) for i in range(3))

# 6) vignette + oval alpha (floating demon head); horns extend above so use a taller mask
out = g.convert('RGBA'); op = out.load()
cx, cy, rx, ry = S/2, S*0.52, S*0.46, S*0.46
for y in range(S):
    for x in range(S):
        # keep the horn region (upper center) even outside the face oval
        inHorn = (y < 0.5*S) and (0.28*S < x < 0.72*S)
        d = math.sqrt(((x-cx)/rx)**2 + ((y-cy)/ry)**2)
        o = op[x, y]
        if d <= 1:
            shade = 1 if d < 0.62 else max(0.35, 1-(d-0.62)*1.5)
            a = 255 if d < 0.93 else int(255*(1-(d-0.93)/0.07))
            op[x, y] = (int(o[0]*shade), int(o[1]*shade), int(o[2]*shade), max(0, a))
        elif inHorn and (g.getpixel((x, y))[0] > 120 and g.getpixel((x, y))[1] > 90):  # horn pixels
            op[x, y] = (o[0], o[1], o[2], 255)
        else:
            op[x, y] = (o[0], o[1], o[2], 0)

out.save('client/public/dungeon/mob_fritz.png')
print('wrote client/public/dungeon/mob_fritz.png', out.size)
prev = Image.new('RGBA', (S, S), (24, 22, 26, 255)); prev.alpha_composite(out)
prev.convert('RGB').save('/tmp/fritz_preview.png')
