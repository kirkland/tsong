import sys
from collections import deque
from PIL import Image
inp, outp = sys.argv[1], sys.argv[2]
THR = int(sys.argv[3]) if len(sys.argv) > 3 else 60   # luminance below this (and border-connected) = bg
im = Image.open(inp).convert('RGBA'); W, H = im.size; px = im.load()
def dark(c): return (c[0]*0.30 + c[1]*0.59 + c[2]*0.11) < THR
bg = bytearray(W*H); q = deque()
for x in range(W):
    for y in (0, H-1):
        if dark(px[x, y]) and not bg[y*W+x]: bg[y*W+x] = 1; q.append((x, y))
for y in range(H):
    for x in (0, W-1):
        if dark(px[x, y]) and not bg[y*W+x]: bg[y*W+x] = 1; q.append((x, y))
while q:
    x, y = q.popleft()
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < W and 0 <= ny < H and not bg[ny*W+nx] and dark(px[nx, ny]):
            bg[ny*W+nx] = 1; q.append((nx, ny))
for i in range(W*H):
    if bg[i]: x, y = i % W, i // W; c = px[x, y]; px[x, y] = (c[0], c[1], c[2], 0)
# soften the cut edge a touch (fade alpha where a transparent neighbor exists)
bb = im.getbbox()
if bb: im = im.crop(bb)
im.save(outp); print('wrote', outp, im.size)
prev = Image.new('RGBA', im.size, (60, 62, 70, 255)); prev.alpha_composite(im); prev.convert('RGB').save('/tmp/noam_preview.png')
