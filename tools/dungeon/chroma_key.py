#!/usr/bin/env python3
# Chroma-key a flat-magenta Gemini sprite to a clean transparent PNG.
#  - flood-fills the background from the borders (so magenta-ish pixels INSIDE the
#    character are kept), then keeps only the largest opaque blob (drops sparkles),
#    then despills the purple fringe around the edges.
# usage: chroma_key.py <in.png> <out.png> [keycolor_hex]
import sys
from collections import deque
from PIL import Image

inp, outp = sys.argv[1], sys.argv[2]
im = Image.open(inp).convert('RGBA')
W, H = im.size
px = im.load()

# key colour = the top-left corner unless overridden
key = tuple(int(sys.argv[3][i:i+2], 16) for i in (0, 2, 4)) if len(sys.argv) > 3 else px[0, 0][:3]
kr, kg, kb = key

def near_bg(c, thr=120):
    r, g, b = c[0], c[1], c[2]
    # magenta-ish: high R+B, low G, and close-ish to the key
    d2 = (r-kr)**2 + (g-kg)**2 + (b-kb)**2
    return d2 < thr*thr or (r > 110 and b > 110 and g < min(r, b) - 30)

# 1) flood-fill bg from the border
bg = bytearray(W*H)
q = deque()
for x in range(W):
    for y in (0, H-1):
        if near_bg(px[x, y]) and not bg[y*W+x]:
            bg[y*W+x] = 1; q.append((x, y))
for y in range(H):
    for x in (0, W-1):
        if near_bg(px[x, y]) and not bg[y*W+x]:
            bg[y*W+x] = 1; q.append((x, y))
while q:
    x, y = q.popleft()
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < W and 0 <= ny < H and not bg[ny*W+nx] and near_bg(px[nx, ny]):
            bg[ny*W+nx] = 1; q.append((nx, ny))

for i in range(W*H):
    if bg[i]:
        x, y = i % W, i // W
        c = px[x, y]; px[x, y] = (c[0], c[1], c[2], 0)

# 2) keep only the largest opaque component (drops floating sparkles)
seen = bytearray(W*H)
best = []
for sy in range(H):
    for sx in range(W):
        i0 = sy*W+sx
        if seen[i0] or px[sx, sy][3] == 0:
            continue
        comp = []; seen[i0] = 1; st = [(sx, sy)]
        while st:
            x, y = st.pop(); comp.append((x, y))
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                j = ny*W+nx
                if 0 <= nx < W and 0 <= ny < H and not seen[j] and px[nx, ny][3] != 0:
                    seen[j] = 1; st.append((nx, ny))
        if len(comp) > len(best):
            best = comp
keepmask = set(best)
for sy in range(H):
    for sx in range(W):
        if px[sx, sy][3] != 0 and (sx, sy) not in keepmask:
            c = px[sx, sy]; px[sx, sy] = (c[0], c[1], c[2], 0)

# 3) despill: pull TRUE-magenta fringe back toward neutral — but only on EDGE pixels (next to
#    transparency) and only when the pixel is genuinely magenta (R≈B, both well above G). This avoids
#    nuking red/crimson skin (high R, low B), which an over-eager despill would otherwise desaturate.
def is_edge(x, y):
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < W and 0 <= ny < H and px[nx, ny][3] == 0:
            return True
    return False
for y in range(H):
    for x in range(W):
        c = px[x, y]
        if c[3] == 0 or not is_edge(x, y):
            continue
        r, g, b, a = c
        if (r - g) > 55 and (b - g) > 55 and abs(r - b) < 55:   # genuinely magenta fringe (not red skin)
            g2 = g + 14
            px[x, y] = (min(r, g2), g, min(b, g2), a)

# 4) crop to content + save
bbox = im.getbbox()
if bbox:
    im = im.crop(bbox)
im.save(outp)
print(f'wrote {outp} {im.size} (key #{kr:02x}{kg:02x}{kb:02x})')

# preview over dark stone so we can eyeball the cutout
prev = Image.new('RGBA', im.size, (24, 26, 30, 255))
prev.alpha_composite(im)
prev.convert('RGB').save('/tmp/warden_preview.png')
