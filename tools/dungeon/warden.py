from PIL import Image, ImageDraw, ImageFilter
import random, math
random.seed(7)
W, H = 72, 132
im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(im)

cloak   = (38, 46, 44)
cloakHi = (54, 64, 60)
cloakLo = (22, 28, 27)
void    = (6, 8, 8)

# tall tattered cloak: narrow shoulders, widening to a ragged hem
cx = W // 2
for y in range(18, H):
    t = (y - 18) / (H - 18)
    half = int(8 + t * 26)                       # widen toward the hem
    # ragged bottom edge
    if y > H - 16 and random.random() < 0.5:
        half -= random.randint(0, 8)
    col = cloak
    d.line([(cx - half, y), (cx + half, y)], fill=col)
    d.point((cx - half, y), fill=cloakLo); d.point((cx + half, y), fill=cloakLo)  # rim shade
    if random.random() < 0.18:                   # faint vertical fold highlights
        fx = cx + random.randint(-half + 2, half - 2)
        im.putpixel((fx, y), cloakHi)

# hood: a peaked dark cowl over a black void where a face should be
d.polygon([(cx, 2), (cx - 16, 30), (cx + 16, 30)], fill=cloak)         # peak
d.ellipse([cx - 13, 12, cx + 13, 46], fill=cloak)                      # cowl
d.ellipse([cx - 9, 18, cx + 9, 44], fill=void)                        # the void inside the hood

# two glowing pinprick eyes in the void
for ex in (cx - 4, cx + 4):
    im.putpixel((ex, 30), (190, 235, 230))
    for dx, dy in [(-1,0),(1,0),(0,-1),(0,1)]:
        x, y = ex+dx, 30+dy
        o = im.getpixel((x, y)); im.putpixel((x, y), (min(255,o[0]+70), min(255,o[1]+110), min(255,o[2]+105), 255))

# long thin pale hands emerging near the hem
hand = (150, 158, 150)
for hx in (cx - 24, cx + 22):
    d.line([(hx, 78), (hx + (2 if hx < cx else -2), 96)], fill=hand)   # gaunt forearm
    for k in range(3):                                                  # spindly fingers
        d.line([(hx + (k-1)*2, 96), (hx + (k-1)*3, 104)], fill=hand)

# soft outer glow pass so it reads in the dark
glow = im.filter(ImageFilter.GaussianBlur(3))
out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
out = Image.alpha_composite(out, Image.eval(glow, lambda p: p))  # faint halo
out = Image.alpha_composite(out, im)
# upscale chunky to match the pixel style
out = out.resize((W*3, H*3), Image.NEAREST)
out.save('client/public/dungeon/mob_warden.png')
print('wrote client/public/dungeon/mob_warden.png', out.size)
