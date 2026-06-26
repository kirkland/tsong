import sys
from collections import deque
from PIL import Image
inp, outp = sys.argv[1], sys.argv[2]
im = Image.open(inp).convert('RGBA'); W, H = im.size; px = im.load()
def isbg(c):
    r, g, b = c[0], c[1], c[2]
    sat = max(r, g, b) - min(r, g, b)
    lum = 0.3*r + 0.59*g + 0.11*b
    return sat < 16 and 22 < lum < 95       # low-saturation dark-grey studio backdrop
bg = bytearray(W*H); q = deque()
for x in range(W):
    for y in (0, H-1):
        if isbg(px[x, y]) and not bg[y*W+x]: bg[y*W+x] = 1; q.append((x, y))
for y in range(H):
    for x in (0, W-1):
        if isbg(px[x, y]) and not bg[y*W+x]: bg[y*W+x] = 1; q.append((x, y))
while q:
    x, y = q.popleft()
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < W and 0 <= ny < H and not bg[ny*W+nx] and isbg(px[nx, ny]):
            bg[ny*W+nx] = 1; q.append((nx, ny))
for i in range(W*H):
    if bg[i]: x, y = i % W, i // W; c = px[x, y]; px[x, y] = (c[0], c[1], c[2], 0)
# largest-blob keep to drop stray keyed islands
seen = bytearray(W*H); best = []
for sy in range(H):
    for sx in range(W):
        if seen[sy*W+sx] or px[sx, sy][3] == 0: continue
        comp = []; seen[sy*W+sx] = 1; stk = [(sx, sy)]
        while stk:
            x, y = stk.pop(); comp.append((x, y))
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                if 0 <= nx < W and 0 <= ny < H and not seen[ny*W+nx] and px[nx, ny][3] != 0:
                    seen[ny*W+nx] = 1; stk.append((nx, ny))
        if len(comp) > len(best): best = comp
keep = set(best)
for sy in range(H):
    for sx in range(W):
        if px[sx, sy][3] != 0 and (sx, sy) not in keep:
            c = px[sx, sy]; px[sx, sy] = (c[0], c[1], c[2], 0)
bb = im.getbbox()
if bb: im = im.crop(bb)
im.save(outp); print('wrote', outp, im.size)
prev = Image.new('RGBA', im.size, (60, 40, 40, 255)); prev.alpha_composite(im); prev.convert('RGB').save('/tmp/josiel_preview.png')
