// B5 — the BOSS floor. No loot, no music, no wandering mobs: a long, thin, torch-lined approach
// hallway that opens into a grand pillared chamber where the boss waits. Carve → torches → validate
// connectivity from '<' → print rows. Dead silent + dead empty by design (the dread is the point).
const W = 49, H = 21;
const g = Array.from({ length: H }, () => Array(W).fill('#'));
const carve = (x0, y0, x1, y1, ch = '.') => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = ch; };

// --- the long thin approach hallway (1 tile wide, dead centre) ---
carve(2, 10, 26, 10);
g[10][2] = '<';                                   // back up to B4
for (const c of [5, 9, 13, 17, 21, 25]) { g[9][c] = 'T'; g[11][c] = 'T'; } // torches marching down both walls

// --- the grand boss chamber ---
carve(27, 3, 46, 17);
// a colonnade of pillars flanking the central aisle → a processional path to the boss
for (const c of [31, 35, 39, 43]) { g[7][c] = 'o'; g[13][c] = 'o'; }
// torch sconces around the chamber: top + bottom walls, the far wall behind the boss, the entrance jambs
for (const c of [30, 34, 38, 42, 46]) { g[2][c] = 'T'; g[18][c] = 'T'; }
for (const r of [6, 10, 14]) g[r][47] = 'T';      // the far wall (behind where the boss stands)
g[5][26] = 'T'; g[15][26] = 'T';                  // flanking the hallway's mouth into the chamber

const rows = g.map((r) => r.join(''));
// --- validate: every floor/torch tile reachable from '<' (torches sit on walls, so flood floors only) ---
const blocked = (ch) => ch === '#' || ch === 'T' || ch === 'o' || ch === ' ';
let sx, sy; rows.forEach((r, y) => { const x = r.indexOf('<'); if (x >= 0) { sx = x; sy = y; } });
const seen = Array.from({ length: H }, () => Array(W).fill(false));
const st = [[sx, sy]]; seen[sy][sx] = true;
while (st.length) { const [x, y] = st.pop(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx] || blocked(rows[ny][nx])) continue; seen[ny][nx] = true; st.push([nx, ny]); } }
let orphan = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ch = rows[y][x]; if ((ch === '.' || ch === '<') && !seen[y][x]) orphan++; }
let torches = 0; rows.forEach((r) => { for (const ch of r) if (ch === 'T') torches++; });
console.log(rows.map((r) => `  '${r}',`).join('\n'));
console.log(`\n${W}x${H}  torches=${torches}  orphan floor tiles (should be 0)=${orphan}`);
