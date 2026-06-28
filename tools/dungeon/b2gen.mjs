// B2 with WIDER (2-tile) corridors. Carve solid→open, 2-wide halls, then stamp features and print
// their coordinates so the code (DUNGEON_CHEST_CONTENTS, imp cell) can be synced.
const W=39,H=27;
const g=Array.from({length:H},()=>Array(W).fill('#'));
const carve=(x0,y0,x1,y1,ch='.')=>{for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(x>=0&&y>=0&&x<W&&y<H)g[y][x]=ch;};
const hall=(y,x0,x1)=>carve(Math.min(x0,x1),y,Math.max(x0,x1),y+1);   // 2 tiles tall
const vall=(x,y0,y1)=>carve(x,Math.min(y0,y1),x+1,Math.max(y0,y1));   // 2 tiles wide
// ---- rooms (interiors) ----
carve(2,2,8,7);     // top-left arrival room
carve(13,2,19,6);   // top-mid room
carve(24,2,30,7);   // top-right room
carve(32,2,36,6);   // far top-right room
carve(2,11,8,16);   // mid-left room
carve(15,10,21,15); // central hub
carve(25,10,30,15); // mid-right room
carve(2,20,8,24);   // bottom-left room
carve(13,19,19,24); // bottom-mid room
carve(23,18,29,23); // lower-central room
// ---- 2-wide corridors ----
hall(4,8,13); hall(4,19,24); hall(4,30,32);
vall(16,6,10); vall(27,7,10); vall(34,6,11);
hall(13,8,15); hall(13,21,25); vall(4,7,11);
vall(17,15,19); vall(27,15,18); hall(21,8,13);
vall(5,16,20); hall(22,8,13); hall(22,19,23);
vall(33,11,18); hall(18,30,33); hall(13,30,34);
vall(11,13,21); hall(21,29,33);
// ---- sealed locked room (bottom-right), stamped LAST ----
for(let y=21;y<=26;y++)for(let x=31;x<=37;x++)g[y][x]='#';
carve(33,23,36,25);          // interior
g[24][32]='L';               // locked door (west wall); (31,24)/(30,24) outside is corridor
hall(24,29,31);              // reach the door
// ---- features ----
carve(15,3,17,4,'~'); carve(3,12,5,14,'~'); carve(15,20,17,23,'~'); carve(25,19,27,21,'~');
g[3][4]='<';                 // up to B1
g[18][28]='>';               // DOWN to B3
g[3][26]='c'; g[13][4]='c'; g[21][15]='c'; // three open-area chests
g[24][34]='c';               // locked-room prize
[[1,1],[37,1],[1,15],[1,24],[20,1],[37,15],[10,9]].forEach(([x,y])=>{if(g[y]&&g[y][x]==='#')g[y][x]='T';});
g[4][9]='D'; g[2][16]='D'; g[4][24]='D'; g[13][9]='D'; g[19][16]='D'; g[22][9]='D';
const rows=g.map(r=>r.join(''));
// ---- validate ----
const wall=ch=>ch==='#'||ch==='T'||ch==='o'||ch===' '||ch==='L'||ch==='c';
let sx,sy; rows.forEach((r,y)=>{const x=r.indexOf('<'); if(x>=0){sx=x;sy=y;}});
const seen=Array.from({length:H},()=>Array(W).fill(false));const st=[[sx,sy]];seen[sy][sx]=true;
while(st.length){const[x,y]=st.pop();for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H||seen[ny][nx]||wall(rows[ny][nx]))continue;seen[ny][nx]=true;st.push([nx,ny]);}}
let orphan=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++){const ch=rows[y][x];if((ch==='.'||ch==='~'||ch==='D')&&!seen[y][x])orphan.push(`${x},${y}`);}
const chests=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(rows[y][x]==='c'){const adj=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen[y+dy]&&seen[y+dy][x+dx]);chests.push(`${x},${y}${adj?'(reach)':'(SEALED)'}`);}
let Lx,Ly;rows.forEach((r,y)=>{const x=r.indexOf('L');if(x>=0){Lx=x;Ly=y;}});
const Lout=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>seen[Ly+dy]&&seen[Ly+dy][Lx+dx]);
console.log(rows.map(r=>`  '${r}',`).join('\n'));
console.log(`\n${W}x${H}=${W*H}`);
console.log('chests:',chests.join('  '));
console.log('locked door reachable:',Lout,' orphan(=locked room):',orphan.length, orphan.join(' '));
