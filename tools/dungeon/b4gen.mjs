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
g[3][29]='c'; g[14][4]='c'; g[24][29]='c'; g[24][42]='c'; g[27][4]='c'; // five chests
[[1,1],[45,1],[1,17],[1,28],[24,1],[45,17],[20,11],[45,28],[36,1]].forEach(([x,y])=>{if(g[y]&&g[y][x]==='#')g[y][x]='T';});
g[4][9]='D'; g[2][17]='D'; g[4][36]='D'; g[14][9]='D'; g[20][18]='D'; g[24][25]='D'; g[22][37]='D'; g[14][36]='D';
const rows=g.map(r=>r.join(''));
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
