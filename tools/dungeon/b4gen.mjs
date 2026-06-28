// B4 — the deep floor, ~4x B1 (47x31 = 1457), darkest + bloodiest, 2-wide corridors. '<' back up to
// B3. Tier-4 mobs. Carve solid→open, stamp features, validate connectivity, print rows + coords.
const W=47,H=31;
const g=Array.from({length:H},()=>Array(W).fill('#'));
const carve=(x0,y0,x1,y1,ch='.')=>{for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(x>=0&&y>=0&&x<W&&y<H)g[y][x]=ch;};
const hall=(y,x0,x1)=>carve(Math.min(x0,x1),y,Math.max(x0,x1),y+1);
const vall=(x,y0,y1)=>carve(x,Math.min(y0,y1),x+1,Math.max(y0,y1));
// ---- rooms ----
carve(2,2,8,7);      // top-left arrival
carve(13,2,20,7);    // top-mid
carve(25,2,31,7);    // top-mid-right
carve(36,2,43,8);    // top-right
carve(2,11,8,17);    // mid-left
carve(14,11,22,18);  // central hub (big)
carve(28,11,35,17);  // mid-right
carve(39,12,44,18);  // far mid-right
carve(2,21,9,28);    // bottom-left
carve(14,22,22,28);  // bottom-mid
carve(26,21,33,28);  // bottom-mid-right
carve(37,22,44,28);  // bottom-right
// ---- 2-wide corridors ----
hall(4,8,13); hall(4,20,25); hall(4,31,36);
vall(17,7,11); vall(29,7,11); vall(40,8,12); vall(5,7,11);
hall(14,8,14); hall(14,22,28); hall(14,35,39);
vall(5,17,21); vall(18,18,22); vall(31,17,21); vall(42,18,22);
hall(24,9,14); hall(24,22,26); hall(25,33,37);
vall(11,14,22); vall(25,14,21); vall(36,14,22); hall(20,31,36);
hall(9,36,40); vall(44,8,18);
// ---- features ----
carve(15,3,18,5,'~'); carve(3,13,5,16,'~'); carve(16,23,19,26,'~'); carve(29,23,32,26,'~'); carve(30,3,33,6,'~'); carve(40,14,43,17,'~');
g[3][4]='<';                 // up to B3 (arrival, top-left)
g[3][6]='c'; g[3][29]='c'; g[14][4]='c'; g[27][4]='c'; g[14][28]='c'; // coin/potion/spin chests (bottom-right repurposed for the puzzle)
// ===== SWITCH PUZZLE =====
// seal a rectangular room: wall it + a 1-tile border, then hollow the interior (single door added after)
const sealRoom=(x0,y0,x1,y1)=>{for(let y=y0-1;y<=y1+1;y++)for(let x=x0-1;x<=x1+1;x++)if(x>=0&&y>=0&&x<W&&y<H)g[y][x]='#';carve(x0,y0,x1,y1);};
// CHEST ROOM — right by the entrance (so the sealed door is one of the first things you see). 'X' door
// opens only when the switch is ON. It hangs off the arrival room (open cols 2-8).
sealRoom(11,3,13,5);
carve(9,4,10,4);              // a stub from the arrival room (col 8 open) toward the door
g[4][10]='X';                 // the 'X' door (chest-room side)
g[4][12]='c';                 // the fart-trail chest
// SWITCH — a lever way over on the far-right grass room's wall (you explore past the sealed door to it)
g[15][44]='W';
// BOSS ROOM — bottom-right, sealed by 'Y' (OPEN by default; CLOSES when the switch is ON). Stairs inside.
sealRoom(40,23,43,26);
carve(36,24,39,24);          // a stub from the maze toward the door
g[24][39]='Y';               // the 'Y' door (boss-room side)
g[25][42]='>';               // the boss stairs (to the boss floor)
[[1,1],[45,1],[1,17],[1,28],[24,1],[45,17],[20,11],[45,28],[36,1]].forEach(([x,y])=>{if(g[y]&&g[y][x]==='#')g[y][x]='T';});
g[4][9]='D'; g[2][17]='D'; g[4][36]='D'; g[14][9]='D'; g[20][18]='D'; g[24][25]='D'; g[22][37]='D'; g[14][36]='D';
const rows=g.map(r=>r.join(''));
// ---- dual-state switch validation: 'X' open iff switchOn, 'Y' open iff !switchOn ----
function reach(switchOn){
  const blk=(ch)=>{ if(ch==='X') return !switchOn; if(ch==='Y') return switchOn; return ch==='#'||ch==='T'||ch==='o'||ch===' '||ch==='c'; };
  let sx,sy; rows.forEach((r,y)=>{const x=r.indexOf('<'); if(x>=0){sx=x;sy=y;}});
  const seen=Array.from({length:H},()=>Array(W).fill(false));const st=[[sx,sy]];seen[sy][sx]=1;
  while(st.length){const[x,y]=st.pop();for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]||blk(rows[ny][nx]))continue;seen[ny][nx]=1;st.push([nx,ny]);}}
  const adjAt=(cx,cy)=>[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen[cy+dy]&&seen[cy+dy][cx+dx]);
  const find=(ch)=>{let p=null;rows.forEach((r,y)=>{const x=r.indexOf(ch);if(x>=0)p=[x,y];});return p;};
  const w=find('W'), b=find('>'); // the fart chest is the puzzle one at 12,4
  return {W:w&&adjAt(w[0],w[1]), boss:b&&adjAt(b[0],b[1]), c:adjAt(12,4)};
}
const off=reach(false), on=reach(true);
console.log(rows.map(r=>`  '${r}',`).join('\n'));
console.log(`\nSWITCH OFF (default): switch reachable=${off.W}  boss '>' reachable=${off.boss}  fart chest reachable=${off.c} (want: T T F)`);
console.log(`SWITCH ON:            switch reachable=${on.W}  boss '>' reachable=${on.boss}  fart chest reachable=${on.c} (want: T F T)`);
// ---- validate ----
const blocked=ch=>ch==='#'||ch==='T'||ch==='o'||ch===' '||ch==='L'||ch==='c';
let sx,sy; rows.forEach((r,y)=>{const x=r.indexOf('<'); if(x>=0){sx=x;sy=y;}});
const seen=Array.from({length:H},()=>Array(W).fill(false));const st=[[sx,sy]];seen[sy][sx]=true;
while(st.length){const[x,y]=st.pop();for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]||blocked(rows[ny][nx]))continue;seen[ny][nx]=true;st.push([nx,ny]);}}
let orphan=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++){const ch=rows[y][x];if((ch==='.'||ch==='~'||ch==='D')&&!seen[y][x])orphan.push(`${x},${y}`);}
const chests=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(rows[y][x]==='c'){const adj=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen[y+dy]&&seen[y+dy][x+dx]);chests.push(`${x},${y}${adj?'(reach)':'(UNREACHABLE)'}`);}
console.log(rows.map(r=>`  '${r}',`).join('\n'));
console.log(`\n${W}x${H}=${W*H}  (B1=345, ~4x≈1380)`);
console.log('chests:',chests.join('  '));
console.log('orphan (should be 0):',orphan.length, orphan.join(' '));
