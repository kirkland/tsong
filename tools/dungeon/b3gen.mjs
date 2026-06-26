// B3 — bigger than B2 (43x29 = 1247), darker, 2-wide corridors. No key tile (an NPC will hand the
// key over). '<' back up to B2. Carve solid→open, stamp features, print rows + coords to sync.
const W=43,H=29;
const g=Array.from({length:H},()=>Array(W).fill('#'));
const carve=(x0,y0,x1,y1,ch='.')=>{for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(x>=0&&y>=0&&x<W&&y<H)g[y][x]=ch;};
const hall=(y,x0,x1)=>carve(Math.min(x0,x1),y,Math.max(x0,x1),y+1);   // 2 tall
const vall=(x,y0,y1)=>carve(x,Math.min(y0,y1),x+1,Math.max(y0,y1));   // 2 wide
// ---- rooms ----
carve(2,2,8,7);     // top-left arrival
carve(13,2,20,7);   // top-mid
carve(25,2,31,6);   // top-right
carve(35,2,40,7);   // far top-right
carve(2,11,8,16);   // mid-left
carve(14,11,21,17); // central hub (big)
carve(27,10,34,16); // mid-right
carve(2,20,9,26);   // bottom-left
carve(14,21,21,26); // bottom-mid
carve(26,20,33,26); // bottom-right
carve(36,19,40,25); // far bottom-right
// ---- 2-wide corridors ----
hall(4,8,13); hall(4,20,25); hall(4,31,35);
vall(17,7,11); vall(29,6,10); vall(37,7,11); vall(5,7,11);
hall(13,8,14); hall(13,21,27); hall(13,34,37);
vall(5,16,20); vall(17,17,21); vall(30,16,20); vall(38,16,19);
hall(23,9,14); hall(23,21,26); hall(22,33,36);
vall(11,13,21); vall(24,13,20); hall(24,33,36);
hall(8,31,35); vall(40,7,19);
// ---- features ----
carve(15,3,18,5,'~'); carve(3,12,5,15,'~'); carve(16,22,18,25,'~'); carve(28,21,31,24,'~'); carve(29,12,32,15,'~');
g[3][4]='<';                 // up to B2 (arrival)
g[3][28]='c'; g[13][4]='c'; g[23][29]='c'; g[24][38]='c'; // four chests
// torches on border walls near rooms
[[1,1],[41,1],[1,16],[1,26],[22,1],[41,16],[18,10],[41,26]].forEach(([x,y])=>{if(g[y]&&g[y][x]==='#')g[y][x]='T';});
// a few doors at room mouths
g[4][9]='D'; g[2][17]='D'; g[4][35]='D'; g[13][9]='D'; g[19][17]='D'; g[23][24]='D'; g[22][36]='D';
// ---- down-stairs to B4: TUCKED AWAY in the far bottom-right room (opposite corner from the arrival),
//      so you have to wander the whole floor to find it — but it's in plain sight once you're there. ----
g[20][39]='>';
const rows=g.map(r=>r.join(''));
// ---- validate ----
const blocked=ch=>ch==='#'||ch==='T'||ch==='o'||ch===' '||ch==='L'||ch==='c';
let sx,sy; rows.forEach((r,y)=>{const x=r.indexOf('<'); if(x>=0){sx=x;sy=y;}});
const seen=Array.from({length:H},()=>Array(W).fill(false));const st=[[sx,sy]];seen[sy][sx]=true;
while(st.length){const[x,y]=st.pop();for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]||blocked(rows[ny][nx]))continue;seen[ny][nx]=true;st.push([nx,ny]);}}
let orphan=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++){const ch=rows[y][x];if((ch==='.'||ch==='~'||ch==='D')&&!seen[y][x])orphan.push(`${x},${y}`);}
const chests=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(rows[y][x]==='c'){const adj=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen[y+dy]&&seen[y+dy][x+dx]);chests.push(`${x},${y}${adj?'(reach)':'(UNREACHABLE)'}`);}
console.log(rows.map(r=>`  '${r}',`).join('\n'));
console.log(`\n${W}x${H}=${W*H}`);
console.log('chests:',chests.join('  '));
console.log('orphan (should be 0):',orphan.length, orphan.join(' '));
let gx,gy;rows.forEach((r,y)=>{const x=r.indexOf('>');if(x>=0){gx=x;gy=y;}});
const gopen=[[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dy])=>{const ch=rows[gy+dy]&&rows[gy+dy][gx+dx];return ch&&!blocked(ch);}).length;
console.log(`hidden > at ${gx},${gy} reachable:`,seen[gy][gx],' open neighbors:',gopen,'(1 = good dead-end)');
