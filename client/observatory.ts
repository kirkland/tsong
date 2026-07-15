// The Observatory's charts: pure DOM/SVG rendering of GET /api/usage (UsageStats). No chart
// library — a few hand-rolled SVG builders following the house dataviz rules: thin marks
// (2px lines, ≤24px bars with 4px rounded data-ends), hairline recessive grid, one hue per
// single-series chart (validated against the dialog surface #141c33), direct labels on bar
// tips, hover tooltips that enhance (never gate — each time chart has a table toggle), and
// text in ink tokens, never the series color. world.ts owns the dialog shell; this module
// fills its body.

import { UsageStats } from '../shared/types';

// Chart chrome on the game's dialog surface (#141c33).
const INK = '#e8eefc';     // primary ink
const INK2 = '#aab6dd';    // secondary ink
const MUTED = '#7c8ab5';   // axis labels / captions
const GRID = '#26325a';    // hairline gridline, one step off the surface
const BLUE = '#3987e5';    // series slot 1 — validated vs #141c33 (contrast ≥3:1, CVD clear)
const AQUA = '#199e70';    // series slot 2 — validated; used for the second magnitude context
const SURFACE = '#141c33'; // the dialog surface (bar gaps read as this color)

const SVGNS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------------------
// small helpers

function el(tag: string, css: string, text?: string): HTMLElement {
  const d = document.createElement(tag);
  d.style.cssText = css;
  if (text !== undefined) d.textContent = text;
  return d;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Compact figure: 1,284 / 12.9K / 4.2M. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

function timeAgo(t: number): string {
  let s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const steps: [number, string][] = [[60, 'm'], [60, 'h'], [24, 'd']];
  s /= 60;
  let unit = 'm';
  for (const [size, name] of steps) {
    unit = name;
    if (s < size || name === 'd') break;
    s /= size;
  }
  return `${Math.floor(s)}${unit} ago`;
}

/** Round an axis ceiling up to a clean number (1/2/5 × 10^k). */
function niceCeil(v: number): number {
  if (v <= 4) return 4;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

// Event-name → human line for the ticker (prefix fallbacks keep new names readable).
const FEED_VERBS: Record<string, string> = {
  'session.join': 'arrived in town',
  'game.pong.match': 'settled a pong duel',
  'game.arena.match': 'survived an arena round',
  'game.tournament.match': 'won a World Cup match',
  'game.tournament.join': 'signed up for the World Cup',
  'game.doom.play': 'descended into DOOM',
  'game.fishing.catch': 'landed a fish',
  'game.dungeon.chest': 'cracked a chest in the Ruins',
  'game.dungeon.fight': 'fought something in the Ruins',
  'game.nomic.propose': 'proposed a law in Parliament',
  'game.nomic.vote': 'voted in Parliament',
  'economy.wish': 'made a wish at the fountain',
  'economy.beer': 'bought a beer',
  'economy.mcfood': "ordered at McDonald's",
  'economy.clubjoin': 'joined the Country Club',
  'economy.clubdrink': "sipped the '52 Reserve",
  'economy.tip': 'tipped someone',
  'economy.bounty': 'placed a bounty',
  'economy.dailyspin': 'spun the daily wheel',
  'economy.lootbox': 'opened a loot box',
  'world.enter': 'stepped into the World',
  'world.roadrage': 'started Road Rage',
  'social.chat': 'said something',
  'social.reaction': 'reacted',
};
function humanize(name: string): string {
  if (FEED_VERBS[name]) return FEED_VERBS[name];
  const seg = name.split('.');
  if (seg[0] === 'visit') return `walked into ${PLACE_NAMES[seg[1]] ?? `the ${seg[1]}`}`;
  if (seg[0] === 'game') return `played ${seg[1]}`;
  if (seg[0] === 'casino') return `gambled on ${seg[1]}`;
  if (seg[0] === 'economy') return `did some ${seg[1]} business`;
  return name;
}

// Pretty names for building ids/kinds in the visits chart.
const PLACE_NAMES: Record<string, string> = {
  arena: 'Tsong Arena', casino: 'Casino', bank: 'Bank', petshop: 'Pet Shop',
  doomportal: 'DOOM Portal', pond: 'Fishing Pond', bar: 'The Tavern',
  parliament: 'Parliament', arcade: 'Arcade', dungeon: 'The Ruins', temple: 'The Temple',
  bowling: 'Bolwoing Alley', mcdonald: "McDonald's", shop: 'General Store',
  hall: 'Hall of Fame', noticeboard: 'Notice Board', observatory: 'The Observatory',
  clubhouse: 'The Clubhouse',
};
const GAME_NAMES: Record<string, string> = {
  pong: 'Pong', arena: 'Arena', tournament: 'World Cup', doom: 'DOOM',
  nuketown: 'Nuketown', streetdemons: 'Street Demons', superbros: 'Super Tsong Bros',
  tron: 'Tron', artillery: 'Worms', tnt: 'TNT Rally', monsterjam: 'Monster Jam',
  boardgame: 'Board games', typeordie: 'Type or Die', bowling: 'Bolwoing',
  citytycoon: 'City Tycoon', tsonghero: 'Tsong Hero', campaign: 'Davis Collects',
  fishing: 'Fishing', nomic: 'Nomic', dungeon: 'The Ruins',
};

// ---------------------------------------------------------------------------------------
// shared tooltip (one per render, positioned inside the relatively-positioned root)

function makeTooltip(root: HTMLElement) {
  const tip = el('div',
    `position:absolute;display:none;pointer-events:none;z-index:5;background:#0c1330f2;border:1px solid ${GRID};` +
    `border-radius:8px;padding:6px 9px;font-size:12px;color:${INK};text-align:left;white-space:nowrap;box-shadow:0 6px 18px #0009;`);
  root.appendChild(tip);
  return {
    show(html: string, clientX: number, clientY: number) {
      tip.innerHTML = html;
      tip.style.display = 'block';
      const r = root.getBoundingClientRect();
      const x = Math.min(clientX - r.left + 12, root.clientWidth - tip.offsetWidth - 6);
      const y = Math.max(4, clientY - r.top - tip.offsetHeight - 10);
      tip.style.left = `${Math.max(4, x)}px`;
      tip.style.top = `${y}px`;
    },
    hide() { tip.style.display = 'none'; },
  };
}
type Tooltip = ReturnType<typeof makeTooltip>;

// ---------------------------------------------------------------------------------------
// chart cards

function card(title: string, sub?: string): { root: HTMLElement; body: HTMLElement; head: HTMLElement } {
  const root = el('div',
    `background:#111a30;border:1px solid ${GRID};border-radius:12px;padding:12px 14px 10px;text-align:left;min-width:0;`);
  const head = el('div', 'display:flex;align-items:baseline;gap:8px;margin-bottom:2px;');
  head.appendChild(el('div', `font-size:13px;font-weight:700;color:${INK};`, title));
  if (sub) head.appendChild(el('div', `font-size:11px;color:${MUTED};`, sub));
  const body = el('div', 'position:relative;');
  root.append(head, body);
  return { root, body, head };
}

/** A small "table" toggle in a card head — the WCAG-clean twin of a time chart. */
function tableToggle(head: HTMLElement, body: HTMLElement, chart: HTMLElement, table: HTMLElement) {
  table.style.display = 'none';
  body.append(chart, table);
  const btn = el('button', `margin-left:auto;background:transparent;border:1px solid ${GRID};border-radius:6px;` +
    `color:${MUTED};font-size:10px;padding:2px 7px;cursor:pointer;`, 'table') as HTMLButtonElement;
  btn.type = 'button';
  btn.onclick = () => {
    const showTable = table.style.display === 'none';
    table.style.display = showTable ? 'block' : 'none';
    chart.style.display = showTable ? 'none' : 'block';
    btn.textContent = showTable ? 'chart' : 'table';
  };
  head.appendChild(btn);
}

function dataTable(headers: string[], rows: (string | number)[][]): HTMLElement {
  const wrap = el('div', 'max-height:170px;overflow-y:auto;');
  const t = el('table', `width:100%;border-collapse:collapse;font-size:11px;color:${INK2};font-variant-numeric:tabular-nums;`);
  const tr = document.createElement('tr');
  for (const h of headers) {
    const th = el('th', `text-align:left;color:${MUTED};font-weight:600;padding:2px 8px 4px 0;border-bottom:1px solid ${GRID};`, h);
    tr.appendChild(th);
  }
  t.appendChild(tr);
  for (const row of rows) {
    const r = document.createElement('tr');
    for (const c of row) r.appendChild(el('td', `padding:3px 8px 3px 0;border-bottom:1px solid ${GRID}44;`, String(c)));
    t.appendChild(r);
  }
  wrap.appendChild(t);
  return wrap;
}

/** Stat tile: label over value (proportional figures, no tabular-nums at display size). */
function tile(label: string, value: string): HTMLElement {
  const d = el('div', `background:#111a30;border:1px solid ${GRID};border-radius:12px;padding:10px 12px;text-align:left;min-width:0;`);
  d.appendChild(el('div', `font-size:11px;color:${MUTED};margin-bottom:2px;white-space:nowrap;`, label));
  d.appendChild(el('div', `font-size:24px;font-weight:600;color:${INK};line-height:1.15;`, value));
  return d;
}

/** Area chart of events per hour (single series → slot 1, no legend). Crosshair + tooltip. */
function hourlyChart(hourly: UsageStats['hourly'], tipLayer: Tooltip): HTMLElement {
  const W = 560, H = 150, L = 34, R = 8, T = 10, B = 22;
  const now = Date.now(), HOUR = 3600_000, SPAN = 48;
  const start = Math.floor(now / HOUR) * HOUR - (SPAN - 1) * HOUR;
  // Re-bucket onto a dense 48-slot axis so gaps render as zero, not as a skipped x step.
  const buckets = Array.from({ length: SPAN }, (_, i) => {
    const t = start + i * HOUR;
    const hit = hourly.find((p) => p.t === t);
    return { t, events: hit?.events ?? 0, players: hit?.players ?? 0 };
  });
  const yMax = niceCeil(Math.max(1, ...buckets.map((b) => b.events)));
  const x = (i: number) => L + (i / (SPAN - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);

  const wrap = el('div', 'position:relative;');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: 'display:block;' });
  // hairline grid: 3 horizontal lines + y tick labels (they carry the unlabeled values)
  for (const f of [0, 0.5, 1]) {
    const v = yMax * f;
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: GRID, 'stroke-width': 1 }));
    const lbl = svgEl('text', { x: L - 5, y: y(v) + 3.5, fill: MUTED, 'font-size': 9.5, 'text-anchor': 'end', style: 'font-variant-numeric:tabular-nums;' });
    lbl.textContent = fmt(v);
    svg.appendChild(lbl);
  }
  // x labels: sparse (every 12h)
  for (let i = 0; i < SPAN; i += 12) {
    const h = new Date(buckets[i].t).getHours();
    const lbl = svgEl('text', { x: x(i), y: H - 7, fill: MUTED, 'font-size': 9.5, 'text-anchor': 'middle' });
    lbl.textContent = `${String(h).padStart(2, '0')}:00`;
    svg.appendChild(lbl);
  }
  // area wash (~10% opacity) + 2px line
  const pts = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.events).toFixed(1)}`);
  svg.appendChild(svgEl('polygon', {
    points: `${L},${y(0)} ${pts.join(' ')} ${W - R},${y(0)}`, fill: BLUE, opacity: 0.1,
  }));
  svg.appendChild(svgEl('polyline', {
    points: pts.join(' '), fill: 'none', stroke: BLUE, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  // end marker: ≥8px dot with a 2px surface ring
  const last = buckets[SPAN - 1];
  svg.appendChild(svgEl('circle', { cx: x(SPAN - 1), cy: y(last.events), r: 6, fill: SURFACE }));
  svg.appendChild(svgEl('circle', { cx: x(SPAN - 1), cy: y(last.events), r: 4, fill: BLUE }));
  // crosshair (hidden until hover)
  const cross = svgEl('line', { x1: 0, x2: 0, y1: T, y2: H - B, stroke: MUTED, 'stroke-width': 1, opacity: 0 });
  const dotRing = svgEl('circle', { r: 6, fill: SURFACE, opacity: 0 });
  const dot = svgEl('circle', { r: 4, fill: BLUE, opacity: 0 });
  svg.append(cross, dotRing, dot);
  wrap.appendChild(svg);

  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(SPAN - 1, Math.round(((e.clientX - r.left) / r.width * W - L) / ((W - L - R) / (SPAN - 1)))));
    const b = buckets[i];
    cross.setAttribute('x1', String(x(i))); cross.setAttribute('x2', String(x(i)));
    cross.setAttribute('opacity', '0.5');
    dotRing.setAttribute('cx', String(x(i))); dotRing.setAttribute('cy', String(y(b.events))); dotRing.setAttribute('opacity', '1');
    dot.setAttribute('cx', String(x(i))); dot.setAttribute('cy', String(y(b.events))); dot.setAttribute('opacity', '1');
    const when = new Date(b.t);
    tipLayer.show(
      `<b>${b.events.toLocaleString('en-US')}</b> actions · ${b.players} player${b.players === 1 ? '' : 's'}` +
      `<br><span style="color:${MUTED}">${when.toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}</span>`,
      e.clientX, e.clientY);
  });
  wrap.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', '0'); dot.setAttribute('opacity', '0'); dotRing.setAttribute('opacity', '0');
    tipLayer.hide();
  });
  return wrap;
}

/** Daily unique players, last 14 days — columns ≤24px, 4px rounded caps, 2px surface gaps. */
function dailyChart(daily: UsageStats['daily'], tipLayer: Tooltip): HTMLElement {
  const W = 560, H = 130, L = 30, R = 8, T = 10, B = 20, DAYS = 14, DAY = 86_400_000;
  const todayKey = new Date().toISOString().slice(0, 10);
  const startMs = Date.parse(`${todayKey}T00:00:00Z`) - (DAYS - 1) * DAY;
  const buckets = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(startMs + i * DAY).toISOString().slice(0, 10);
    const hit = daily.find((d) => d.day === day);
    return { day, players: hit?.players ?? 0, events: hit?.events ?? 0 };
  });
  const yMax = niceCeil(Math.max(1, ...buckets.map((b) => b.players)));
  const slot = (W - L - R) / DAYS;
  const barW = Math.min(24, slot - 2); // ≤24px thick; ≥2px surface gap between neighbors
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);

  const wrap = el('div', 'position:relative;');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: 'display:block;' });
  for (const f of [0, 1]) {
    const v = yMax * f;
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: GRID, 'stroke-width': 1 }));
    const lbl = svgEl('text', { x: L - 5, y: y(v) + 3.5, fill: MUTED, 'font-size': 9.5, 'text-anchor': 'end', style: 'font-variant-numeric:tabular-nums;' });
    lbl.textContent = fmt(v);
    svg.appendChild(lbl);
  }
  buckets.forEach((b, i) => {
    const cx = L + i * slot + slot / 2;
    const h = Math.max(0, y(0) - y(b.players));
    if (h > 0) {
      // rounded data-end, square baseline: a path with top-corner arcs only
      const r = Math.min(4, barW / 2, h);
      const x0 = cx - barW / 2, x1 = cx + barW / 2, yTop = y(b.players), y0 = y(0);
      svg.appendChild(svgEl('path', {
        d: `M${x0},${y0} L${x0},${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} L${x1 - r},${yTop} Q${x1},${yTop} ${x1},${yTop + r} L${x1},${y0} Z`,
        fill: BLUE,
      }));
    }
    // sparse x labels: first, middle, today
    if (i === 0 || i === 7 || i === DAYS - 1) {
      const lbl = svgEl('text', { x: cx, y: H - 6, fill: MUTED, 'font-size': 9.5, 'text-anchor': 'middle' });
      lbl.textContent = i === DAYS - 1 ? 'today' : b.day.slice(5).replace('-', '/');
      svg.appendChild(lbl);
    }
    // generous hover hit target: the full column slot
    const hit = svgEl('rect', { x: L + i * slot, y: T, width: slot, height: H - T - B, fill: 'transparent' });
    hit.addEventListener('mousemove', (e: MouseEvent) => {
      tipLayer.show(
        `<b>${b.players}</b> player${b.players === 1 ? '' : 's'} · ${b.events.toLocaleString('en-US')} actions` +
        `<br><span style="color:${MUTED}">${b.day}</span>`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => tipLayer.hide());
    svg.appendChild(hit);
  });
  wrap.appendChild(svg);
  return wrap;
}

/** Horizontal bars with the value at the tip (magnitude across categories → one hue). */
function hBars(rows: { label: string; value: number }[], color: string, tipLayer: Tooltip, unit: string): HTMLElement {
  const wrap = el('div', 'display:flex;flex-direction:column;gap:6px;padding:4px 0 2px;');
  const max = Math.max(1, ...rows.map((r) => r.value));
  for (const r of rows) {
    const row = el('div', 'display:flex;align-items:center;gap:8px;min-width:0;cursor:default;');
    row.appendChild(el('div', `flex:0 0 96px;font-size:11px;color:${INK2};text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`, r.label));
    const track = el('div', 'flex:1;display:flex;align-items:center;gap:6px;min-width:0;');
    const bar = el('div', `height:12px;border-radius:0 4px 4px 0;background:${color};` +
      `width:${Math.max(2, (r.value / max) * 100 * 0.82).toFixed(1)}%;`);
    track.appendChild(bar);
    // direct label at the bar tip, in ink (never the series color)
    track.appendChild(el('div', `font-size:11px;color:${INK};font-variant-numeric:tabular-nums;`, fmt(r.value)));
    row.appendChild(track);
    row.addEventListener('mousemove', (e) => tipLayer.show(`<b>${r.label}</b> — ${r.value.toLocaleString('en-US')} ${unit}`, e.clientX, e.clientY));
    row.addEventListener('mouseleave', () => tipLayer.hide());
    wrap.appendChild(row);
  }
  if (!rows.length) wrap.appendChild(el('div', `font-size:12px;color:${MUTED};padding:8px 0;`, 'Nothing yet — go make some noise.'));
  return wrap;
}

// ---------------------------------------------------------------------------------------
// the telescope: peer through it to reveal the Star of the Week on a tiny starfield

function telescope(stats: UsageStats): HTMLElement {
  const root = el('div', `background:#111a30;border:1px solid ${GRID};border-radius:12px;padding:12px 14px;text-align:center;`);
  const btn = el('button',
    `background:#1a2547;border:1px solid ${GRID};border-radius:10px;color:${INK};font-size:13px;font-weight:700;` +
    'padding:9px 16px;cursor:pointer;', '🔭 Peer through the telescope') as HTMLButtonElement;
  btn.type = 'button';
  root.appendChild(btn);
  btn.onclick = () => {
    root.replaceChildren();
    const sky = el('div', 'position:relative;height:110px;border-radius:10px;overflow:hidden;background:radial-gradient(ellipse at 50% 120%, #16204a 0%, #0a1026 70%);');
    for (let i = 0; i < 40; i++) {
      const s = el('div', `position:absolute;width:2px;height:2px;border-radius:50%;background:#e8eefc;` +
        `left:${(i * 37 + 13) % 100}%;top:${(i * 53 + 7) % 100}%;opacity:${0.3 + ((i * 29) % 60) / 100};` +
        `animation:wBlink ${1.5 + ((i * 17) % 20) / 10}s steps(2) infinite;`);
      sky.appendChild(s);
    }
    const star = stats.starOfWeek;
    const big = el('div', 'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);font-size:26px;text-shadow:0 0 18px #ffd166;', '⭐');
    sky.appendChild(big);
    root.appendChild(sky);
    root.appendChild(el('div', `font-size:11px;color:${MUTED};margin-top:8px;`, 'STAR OF THE WEEK'));
    root.appendChild(el('div', `font-size:16px;font-weight:700;color:${INK};`,
      star ? star.who : 'The sky is empty…'));
    root.appendChild(el('div', `font-size:11px;color:${MUTED};`,
      star ? `${star.events.toLocaleString('en-US')} things done in the last 7 days` : 'no one has done anything notable all week'));
  };
  return root;
}

// ---------------------------------------------------------------------------------------

/** Render the whole Observatory readout into the dialog body. */
export function renderObservatoryInto(body: HTMLElement, stats: UsageStats): void {
  body.replaceChildren();
  body.style.cssText = 'position:relative;width:min(640px,84vw);text-align:left;';
  const tipLayer = makeTooltip(body);

  // stat tiles
  const tiles = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px;');
  tiles.append(
    tile('Online now', String(stats.onlineNow)),
    tile('Players · 24h', fmt(stats.players24h)),
    tile('Games · 24h', fmt(stats.games24h)),
    tile('Actions · 24h', fmt(stats.events24h)),
  );
  body.appendChild(tiles);

  const grid = el('div', 'display:grid;grid-template-columns:1fr;gap:10px;');
  body.appendChild(grid);

  // activity over time
  const act = card('Town activity', 'actions per hour · last 48h');
  const actChart = hourlyChart(stats.hourly, tipLayer);
  const actTable = dataTable(['hour', 'actions', 'players'],
    stats.hourly.slice(-24).reverse().map((h) => [new Date(h.t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' }), h.events, h.players]));
  tableToggle(act.head, act.body, actChart, actTable);
  grid.appendChild(act.root);

  // daily players
  const day = card('Players per day', 'unique visitors · last 14 days');
  const dayChart = dailyChart(stats.daily, tipLayer);
  const dayTable = dataTable(['day', 'players', 'actions'],
    [...stats.daily].reverse().map((d) => [d.day, d.players, d.events]));
  tableToggle(day.head, day.body, dayChart, dayTable);
  grid.appendChild(day.root);

  // games + places, side by side where there's room
  const pair = el('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;');
  const games = card('What people play', 'plays · last 7 days');
  games.body.appendChild(hBars(
    stats.games7d.map((g) => ({ label: GAME_NAMES[g.game] ?? g.game, value: g.plays })), BLUE, tipLayer, 'plays'));
  const places = card('Where people go', 'walk-ins · last 7 days');
  places.body.appendChild(hBars(
    stats.visits7d.map((v) => ({ label: PLACE_NAMES[v.building] ?? v.building, value: v.visits })), AQUA, tipLayer, 'visits'));
  pair.append(games.root, places.root);
  grid.appendChild(pair);

  // live ticker
  const feed = card('Through the eyepiece', 'the last few things that happened');
  const list = el('div', 'display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto;');
  for (const f of stats.feed) {
    const line = el('div', `font-size:12px;color:${INK2};display:flex;gap:6px;align-items:baseline;min-width:0;`);
    line.appendChild(el('span', `color:${INK};font-weight:600;white-space:nowrap;`, f.who || 'someone'));
    line.appendChild(el('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', humanize(f.name)));
    line.appendChild(el('span', `color:${MUTED};margin-left:auto;white-space:nowrap;font-size:11px;`, timeAgo(f.t)));
    list.appendChild(line);
  }
  if (!stats.feed.length) list.appendChild(el('div', `font-size:12px;color:${MUTED};`, 'All quiet. Suspiciously quiet.'));
  feed.body.appendChild(list);
  grid.appendChild(feed.root);

  // the telescope
  grid.appendChild(telescope(stats));

  // provenance
  body.appendChild(el('div', `font-size:10px;color:${MUTED};margin-top:8px;text-align:center;`,
    stats.source === 'memory'
      ? 'counting since the last server restart (no database attached)'
      : `updated ${timeAgo(stats.generatedAt)}`));
}
