// "Davis Collects" — a self-contained, lazy-loaded story campaign.
//
// Like the DOOM minigame, this is deliberately isolated: its own fullscreen overlay, its own
// 2D Pong simulation + bots, its own VN (visual-novel) dialogue engine and game loop, all torn
// down on exit. It never touches the shared Pong game state. The server is used only to persist
// arcade scores and serve the campaign leaderboard (campaignScore / campaignLeaderboard).
//
// Story + design live in docs/campaign-script.md. This pass builds the scaffold: the launch
// overlay, title screen and leaderboard. The Pong sim, VN engine and stage flow land next.

import { CampaignScoreRow, CAMPAIGN_STAGE_COUNT } from '../shared/types';

// Networking hook into the shared websocket (provided by main.ts).
export interface CampaignNet {
  // Record a finished run: arcade `score`, furthest `stage` reached (1–5), and whether Davis fell.
  submitScore(score: number, stage: number, won: boolean): void;
  leaderboard(): CampaignScoreRow[]; // latest top campaign scores
  name(): string; // this client's display name
}

// --- Stage data (source of truth for the build; mirrors docs/campaign-script.md) ---

// Bot difficulty knobs, ported from the server's BOT_CFG. Higher `react`/`error` = easier.
export interface CampaignBot {
  react: number;      // seconds between re-aims (reaction lag)
  error: number;      // ± random court-unit aim error (bigger = easier)
  predict: boolean;   // predict the wall-bounced landing Y vs. track raw ball Y
  idleCenter: boolean; // drift to center when the ball heads away (true) or shadow it (false)
}

// One VN dialogue line: text shown in the box, an optional one-shot sfx fired as it appears.
export interface VNLine { text: string; sfx?: string; }

// A boss phase (Davis only): its own portrait, win score, modifiers and transition dialogue.
export interface BossPhase {
  portrait: string;
  winScore: number;
  mods: StageMods;
  fx: string | null;            // screen-fx class suffix applied during the phase
  transition: VNLine[];         // VN shown when entering this phase (empty = none)
}

export interface StageMods { turbo?: boolean; gravity?: boolean; fog?: boolean; }

export interface CampaignStage {
  id: string;
  name: string;        // opponent display name
  portrait: string;    // portrait image path (under /public)
  music: string;       // looping battle track for this stage
  fx: string | null;   // screen-fx class suffix ('glitch' | 'smoke' | 'blackout' | 'vortex' | null)
  mods: StageMods;     // gameplay modifiers active during the fight
  winScore: number;    // points to win this match
  bot: CampaignBot;    // opponent difficulty
  skin?: string;       // optional paddle skin id for the opponent (e.g. 'minion')
  intro: VNLine[];     // pre-fight dialogue
  defeat: VNLine[];    // post-win dialogue
  phases?: BossPhase[]; // boss only: subsequent phases after the first
}

const BATTLE = '/battle.mp3';

export const CAMPAIGN_STAGES: CampaignStage[] = [
  {
    id: 'fritz',
    name: 'Fritz',
    portrait: '/fritz.jpg',
    music: BATTLE,
    fx: null,
    mods: {},
    winScore: 3,
    bot: { react: 0.30, error: 95, predict: false, idleCenter: true },
    intro: [
      { text: "Oh, you're the new mark? Hah. Davis sent me. No offense, friend." },
      { text: "I'll be home before this ball cools off. Easy money." },
    ],
    defeat: [
      { text: 'Okay— okay. Huh. That actually... huh.' },
      { text: "Y'know what? Keep the win. Davis can deal with you himself." },
      { text: 'Heard it doesn’t matter anyway. The debt always comes back.' },
    ],
  },
  {
    id: 'otto',
    name: 'Otto',
    portrait: '/minion.png',
    music: BATTLE,
    fx: null,
    mods: { turbo: true },
    winScore: 3,
    bot: { react: 0.22, error: 70, predict: false, idleCenter: true },
    skin: 'minion',
    intro: [
      { text: 'BELLO! Davis say... pong-pong! Hee hee!', sfx: '/minion-laugh.mp3' },
      { text: 'Me play! Me WIN! Banana for winner!' },
    ],
    defeat: [
      { text: '...aww.' },
      { text: '...banana.' },
    ],
  },
  {
    id: 'jsav',
    name: 'JSav',
    portrait: '/jsav.jpg',
    music: BATTLE,
    fx: 'glitch',
    mods: { gravity: true },
    winScore: 3,
    bot: { react: 0.16, error: 48, predict: false, idleCenter: false },
    intro: [
      { text: "You think you're winning matches. You're settling accounts." },
      { text: 'Davis sees every rally. Every debt. He’s seen yours.', sfx: '/jumpscare.mp3' },
      { text: "It's... larger than you think." },
    ],
    defeat: [
      { text: "Good. Now I'm balanced." },
      { text: 'He’ll see you soon. He always does.' },
      { text: 'The debt always comes back. You’ll understand.' },
    ],
  },
  {
    id: 'avery',
    name: 'Avery',
    portrait: '/avery.webp',
    music: BATTLE,
    fx: 'smoke',
    mods: { fog: true },
    winScore: 3,
    bot: { react: 0.13, error: 40, predict: true, idleCenter: false },
    intro: [
      { text: "You shouldn't have made it this far. Listen— listen to me." },
      { text: 'Nobody pays Davis off. You win, you lose, doesn’t matter— the debt always—' },
      { text: "...he's listening. He's always listening. Just play. Please just play." },
    ],
    defeat: [
      { text: "You're really going to face him. God." },
      { text: 'Okay. Whatever you owe him — don’t let him tell you the number.' },
      { text: 'Once you hear it... it’s real.' },
    ],
  },
  {
    id: 'davis',
    name: 'Davis',
    portrait: '/davisclarke.jpg',
    music: '/davis-battle.mp3',
    fx: null,
    mods: { turbo: true },
    winScore: 3,
    bot: { react: 0.09, error: 22, predict: true, idleCenter: false },
    intro: [
      { text: 'There he is. The one who climbed my whole ladder just to avoid a conversation.' },
      { text: "Sit. Let's settle up. You want to know your balance with me?" },
      { text: "It's everything. It always was. Every coin. Every game. Every breath, on credit." },
      { text: 'Shall we?' },
    ],
    defeat: [
      { text: 'Well. Books are balanced. We’re square.' },
      { text: '...For now.' },
      { text: 'Debts have a way of accruing. Come see me again.' },
    ],
    phases: [
      {
        portrait: '/davis_glasses.jpg',
        winScore: 3,
        mods: { turbo: true },
        fx: 'glitch',
        transition: [
          { text: "Money? That's cute. Money's a tally I invented to keep you playing.", sfx: '/finish-him.mp3' },
          { text: "I don't lend coins, friend. I lend time." },
          { text: 'Existence runs on my ledger. And yours... is overdue.' },
        ],
      },
      {
        portrait: '/davis-cosmic.jpg',
        winScore: 7,
        mods: { turbo: true, gravity: true },
        fx: 'vortex',
        transition: [
          { text: 'No more forms. No more names.', sfx: '/jumpscare.mp3' },
          { text: 'I am the line every debt resolves to.' },
          { text: 'Balance me — if the universe lets you.' },
        ],
      },
    ],
  },
];

// --- Self-contained 2D Pong match ---
// The player is always LEFT; the opponent bot is RIGHT. Geometry mirrors the main game's
// court so the feel matches. Each match runs its own rAF loop and tears itself down on end.

const CW = 800, CH = 500;            // logical court size (court units)
const PADDLE_W = 14, PADDLE_H = 90;  // paddle thickness / length
const MARGIN = 24;                   // paddle center distance from its wall
const PADDLE_SPEED = 900;            // bot paddle travel, court units / second
const BALL_R = 9;
const BASE_SPEED = 480;              // serve speed
const SPEEDUP = 1.05;                // per-hit speed multiplier
const TURBO_MULT = 1.5;              // serve-speed multiplier in turbo
const TURBO_SPEEDUP = 1.1;           // per-hit speedup in turbo
const GRAVITY = 220;                 // downward accel in gravity mode (units/s²)
const SERVE_DELAY = 0.7;             // pause before each serve

export interface MatchResult { playerScore: number; oppScore: number; won: boolean; }
export interface MatchOpts {
  name: string;          // opponent name (shown in HUD)
  portrait: string;      // opponent portrait (shown in HUD corner)
  winScore: number;
  mods: StageMods;
  bot: CampaignBot;
  fx: string | null;     // screen-fx class suffix
  skin?: string;         // opponent paddle skin id (cosmetic)
  phaseLabel?: string;   // optional banner (e.g. "PHASE 2/3")
}

// Run one match. Calls onEnd once a side reaches winScore. Returns a stop() to abort/tear down.
export function playMatch(host: HTMLElement, opts: MatchOpts, onEnd: (r: MatchResult) => void): () => void {
  const turbo = !!opts.mods.turbo;
  const serveSpeed = BASE_SPEED * (turbo ? TURBO_MULT : 1);
  const speedup = turbo ? TURBO_SPEEDUP : SPEEDUP;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:min(96vw,1100px);aspect-ratio:8/5;';

  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  canvas.style.cssText = 'width:100%;height:100%;background:#0a0a14;border-radius:8px;' +
    'box-shadow:0 0 40px rgba(140,90,255,.25);cursor:none;';
  const ctx = canvas.getContext('2d')!;
  wrap.appendChild(canvas);

  // Screen-fx layer (reuses the global .fx-* background/animation classes).
  if (opts.fx) {
    const fx = document.createElement('div');
    fx.className = `fx-${opts.fx}`;
    fx.style.cssText = 'position:absolute;inset:0;border-radius:8px;pointer-events:none;';
    wrap.appendChild(fx);
  }

  // HUD: score + opponent name/portrait + optional phase banner.
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;top:10px;left:0;right:0;display:flex;align-items:center;' +
    'justify-content:center;gap:24px;pointer-events:none;font-family:ui-monospace,monospace;';
  const scoreEl = document.createElement('div');
  scoreEl.style.cssText = 'font-size:34px;font-weight:800;color:#fff;text-shadow:0 2px 8px #000;letter-spacing:6px;';
  hud.appendChild(scoreEl);
  wrap.appendChild(hud);

  const nameTag = document.createElement('div');
  nameTag.style.cssText = 'position:absolute;top:12px;right:14px;display:flex;align-items:center;gap:8px;' +
    'pointer-events:none;font-family:ui-monospace,monospace;color:#ffd166;font-size:13px;';
  nameTag.innerHTML =
    `<img src="${opts.portrait}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;border:1px solid #5a4a1a"/>` +
    `<span>${escapeHtml(opts.name)}</span>`;
  wrap.appendChild(nameTag);

  if (opts.phaseLabel) {
    const banner = document.createElement('div');
    banner.textContent = opts.phaseLabel;
    banner.style.cssText = 'position:absolute;top:14px;left:14px;color:#c8b6ff;font-size:12px;' +
      'letter-spacing:2px;pointer-events:none;font-family:ui-monospace,monospace;';
    wrap.appendChild(banner);
  }

  host.appendChild(wrap);

  // --- state ---
  let playerY = CH / 2, botY = CH / 2;
  let targetY = CH / 2;        // player's desired paddle center (from pointer)
  let ball = { x: CW / 2, y: CH / 2, vx: 0, vy: 0 };
  let pScore = 0, oScore = 0;
  let serveTimer = SERVE_DELAY; // counts down; ball frozen at center until 0
  let botReact = 0, botAim = CH / 2;
  let running = true;
  let last = performance.now();

  function serve(towardPlayer: boolean) {
    ball.x = CW / 2; ball.y = CH / 2;
    const angle = (Math.random() * 0.6 - 0.3); // ±~17°
    const dir = towardPlayer ? -1 : 1;
    ball.vx = Math.cos(angle) * serveSpeed * dir;
    ball.vy = Math.sin(angle) * serveSpeed;
    serveTimer = SERVE_DELAY;
  }
  serve(Math.random() < 0.5);

  // Bot aim: only chases an approaching ball; predicts wall bounces if configured; adds error.
  function predictY(): number {
    // Reflect the ball's path off top/bottom walls to estimate its Y at the bot's face.
    const faceX = CW - MARGIN;
    if (ball.vx <= 0) return CH / 2;
    let y = ball.y, vy = ball.vy, x = ball.x;
    const t = (faceX - x) / ball.vx;
    y += vy * t;
    // Fold y into [0, CH] via triangle wave (wall reflections).
    const span = 2 * CH;
    y = ((y % span) + span) % span;
    if (y > CH) y = span - y;
    return y;
  }
  function recomputeBotAim() {
    const cfg = opts.bot;
    const approaching = ball.vx > 0;
    if (!approaching) { botAim = cfg.idleCenter ? CH / 2 : ball.y; return; }
    const base = cfg.predict ? predictY() : ball.y;
    botAim = base + (Math.random() * 2 - 1) * cfg.error;
  }

  function step(dt: number) {
    // Player paddle: ease toward pointer target (snappy but not instant).
    playerY += (targetY - playerY) * Math.min(1, dt * 18);
    playerY = clamp(playerY, PADDLE_H / 2, CH - PADDLE_H / 2);

    // Bot paddle: re-aim on its reaction clock, then steer toward the aim.
    botReact -= dt;
    if (botReact <= 0) { botReact = opts.bot.react; recomputeBotAim(); }
    const dy = botAim - botY;
    const move = PADDLE_SPEED * dt;
    botY += clamp(dy, -move, move);
    botY = clamp(botY, PADDLE_H / 2, CH - PADDLE_H / 2);

    if (serveTimer > 0) { serveTimer -= dt; return; }

    if (opts.mods.gravity) ball.vy += GRAVITY * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Top / bottom walls.
    if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
    if (ball.y > CH - BALL_R) { ball.y = CH - BALL_R; ball.vy = -Math.abs(ball.vy); }

    // Player paddle (left).
    if (ball.vx < 0 && ball.x - BALL_R < MARGIN + PADDLE_W / 2 && ball.x > MARGIN) {
      if (Math.abs(ball.y - playerY) < PADDLE_H / 2 + BALL_R) bounce(playerY, 1);
    }
    // Bot paddle (right).
    if (ball.vx > 0 && ball.x + BALL_R > CW - MARGIN - PADDLE_W / 2 && ball.x < CW - MARGIN) {
      if (Math.abs(ball.y - botY) < PADDLE_H / 2 + BALL_R) bounce(botY, -1);
    }

    // Scoring.
    if (ball.x < -BALL_R) { oScore++; afterPoint(); }
    else if (ball.x > CW + BALL_R) { pScore++; afterPoint(); }
  }

  function bounce(paddleY: number, dir: 1 | -1) {
    const off = clamp((ball.y - paddleY) / (PADDLE_H / 2), -1, 1);
    const speed = Math.hypot(ball.vx, ball.vy) * speedup;
    const angle = off * (Math.PI / 3.2); // up to ~56°
    ball.vx = Math.cos(angle) * speed * dir;
    ball.vy = Math.sin(angle) * speed;
    ball.x = dir === 1 ? MARGIN + PADDLE_W / 2 + BALL_R : CW - MARGIN - PADDLE_W / 2 - BALL_R;
  }

  function afterPoint() {
    if (pScore >= opts.winScore || oScore >= opts.winScore) { finish(); return; }
    serve(Math.random() < 0.5);
  }

  function finish() {
    if (!running) return;
    running = false;
    cleanup();
    onEnd({ playerScore: pScore, oppScore: oScore, won: pScore > oScore });
  }

  function render() {
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, CW, CH);
    // Center dashed line.
    ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.lineWidth = 3; ctx.setLineDash([14, 16]);
    ctx.beginPath(); ctx.moveTo(CW / 2, 0); ctx.lineTo(CW / 2, CH); ctx.stroke();
    ctx.setLineDash([]);
    // Paddles.
    ctx.fillStyle = '#7fd1ff';
    ctx.fillRect(MARGIN - PADDLE_W / 2, playerY - PADDLE_H / 2, PADDLE_W, PADDLE_H);
    ctx.fillStyle = opts.skin === 'minion' ? '#ffe14d' : '#ff8a5c';
    ctx.fillRect(CW - MARGIN - PADDLE_W / 2, botY - PADDLE_H / 2, PADDLE_W, PADDLE_H);
    // Ball — fog mode hides it except near a paddle.
    let alpha = 1;
    if (opts.mods.fog) {
      const dNear = Math.min(ball.x, CW - ball.x);
      alpha = clamp(1 - (dNear - 90) / 220, 0.06, 1);
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    scoreEl.textContent = `${pScore}   ${oScore}`;
  }

  function loop(now: number) {
    if (!running) return;
    if (!document.body.contains(canvas)) { running = false; cleanup(); return; }
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    step(dt);
    render();
    raf = requestAnimationFrame(loop);
  }
  let raf = requestAnimationFrame(loop);

  // --- input ---
  function pointerY(e: { clientY: number }): number {
    const r = canvas.getBoundingClientRect();
    return clamp(((e.clientY - r.top) / r.height) * CH, 0, CH);
  }
  function onMove(e: MouseEvent) { targetY = pointerY(e); }
  function onTouch(e: TouchEvent) { if (e.touches[0]) { targetY = pointerY(e.touches[0]); e.preventDefault(); } }
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('touchmove', onTouch, { passive: false });

  function cleanup() {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('touchmove', onTouch);
    wrap.remove();
  }

  return () => { running = false; cleanup(); };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

// --- Audio ---
const audioCache = new Map<string, HTMLAudioElement>();
function sound(src: string, loop = false, volume = 1): HTMLAudioElement {
  let a = audioCache.get(src);
  if (!a) { a = new Audio(src); audioCache.set(src, a); }
  a.loop = loop;
  a.volume = volume;
  return a;
}

// VN text blip: the DOOM grenade-pickup synth, tuned shorter + quieter for per-character chatter.
let actx: AudioContext | null = null;
function blip() {
  try {
    const a = (actx ??= new AudioContext());
    const o = a.createOscillator(); const g = a.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(440, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(720, a.currentTime + 0.025);
    g.gain.setValueAtTime(0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.04);
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.05);
  } catch { /* ignore */ }
}

// --- Visual-novel dialogue ---
// A static character portrait + a bottom dialogue box with a speaker tag and typewriter text.
// Click / space / enter advances: mid-type it completes the line; otherwise it moves on, and
// after the last line calls onDone. Returns a stop() for teardown.
export function playVN(host: HTMLElement, speaker: string, portrait: string, lines: VNLine[], onDone: () => void): () => void {
  const scene = document.createElement('div');
  scene.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:flex-end;cursor:pointer;font-family:ui-monospace,monospace;';

  const portraitEl = document.createElement('img');
  portraitEl.src = portrait;
  portraitEl.style.cssText = 'position:absolute;top:6%;left:50%;transform:translateX(-50%);' +
    'max-height:58%;max-width:46%;object-fit:contain;border-radius:10px;' +
    'box-shadow:0 0 50px rgba(140,90,255,.35);filter:drop-shadow(0 8px 24px #000);' +
    'animation:vnPop .4s ease-out;';
  scene.appendChild(portraitEl);

  const box = document.createElement('div');
  box.style.cssText = 'position:relative;width:min(92vw,820px);margin:0 0 6vh;padding:18px 22px;' +
    'background:rgba(8,6,18,.92);border:1px solid #3a3258;border-radius:12px;' +
    'box-shadow:0 0 30px rgba(0,0,0,.6);min-height:96px;';
  const nameEl = document.createElement('div');
  nameEl.textContent = speaker;
  nameEl.style.cssText = 'position:absolute;top:-13px;left:18px;background:#150f24;border:1px solid #5a4a1a;' +
    'color:#ffd166;font-size:13px;font-weight:700;letter-spacing:1px;padding:3px 12px;border-radius:6px;';
  const textEl = document.createElement('div');
  textEl.style.cssText = 'color:#eee;font-size:17px;line-height:1.55;min-height:52px;';
  const hint = document.createElement('div');
  hint.textContent = '▼';
  hint.style.cssText = 'position:absolute;bottom:8px;right:14px;color:#7fd1ff;font-size:14px;' +
    'animation:vnBlink 1s steps(2) infinite;opacity:0;';
  box.appendChild(nameEl); box.appendChild(textEl); box.appendChild(hint);
  scene.appendChild(box);

  // Inject the small keyframes once.
  if (!document.getElementById('vnKeyframes')) {
    const st = document.createElement('style');
    st.id = 'vnKeyframes';
    st.textContent =
      '@keyframes vnPop{from{opacity:0;transform:translateX(-50%) scale(.94)}to{opacity:1;transform:translateX(-50%) scale(1)}}' +
      '@keyframes vnBlink{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}';
    document.head.appendChild(st);
  }

  host.appendChild(scene);

  let idx = -1;
  let typing = false;
  let full = '';
  let pos = 0;
  let timer: number | null = null;
  let alive = true;

  function typeTick() {
    if (!alive) return;
    pos++;
    textEl.textContent = full.slice(0, pos);
    if (pos % 2 === 0 && full[pos - 1] !== ' ') blip();
    if (pos >= full.length) { typing = false; timer = null; hint.style.opacity = '1'; return; }
    timer = window.setTimeout(typeTick, 22);
  }

  function showLine(i: number) {
    const line = lines[i];
    full = line.text; pos = 0; typing = true; hint.style.opacity = '0';
    textEl.textContent = '';
    if (line.sfx) { try { const s = sound(line.sfx); s.currentTime = 0; s.play().catch(() => {}); } catch { /* ignore */ } }
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(typeTick, 60);
  }

  function advance() {
    if (!alive) return;
    if (typing) { // finish the current line instantly
      if (timer) { clearTimeout(timer); timer = null; }
      pos = full.length; textEl.textContent = full; typing = false; hint.style.opacity = '1';
      return;
    }
    idx++;
    if (idx >= lines.length) { stop(); onDone(); return; }
    showLine(idx);
  }

  function onClick() { advance(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
  }
  scene.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  function stop() {
    if (!alive) return;
    alive = false;
    if (timer) clearTimeout(timer);
    scene.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
    scene.remove();
  }

  advance(); // show first line
  return stop;
}

let campaignOpen = false;

// Run context threaded through the flow: lets each step register a teardown and lets the
// flow bail the moment the player quits (Esc), without firing later VN boxes / matches.
interface RunCtx {
  overlay: HTMLElement;
  net: CampaignNet;
  token: { cancelled: boolean };
  setStop: (stop: (() => void) | null) => void;
}

// Framing dialogue (cold open) and endings — see docs/campaign-script.md.
const COLD_OPEN: VNLine[] = [
  { text: 'Rough year, huh? The coins, the loans, the bad bets. I’ve seen your books.' },
  { text: "Relax. I'm a reasonable man. Here's the deal, one time only." },
  { text: "Win my little tournament — five of my associates — and your debt's gone. Wiped clean." },
  { text: 'Lose?' },
  { text: "...Let's not lose. First table's waiting." },
];
const DEFEAT_ENDING: VNLine[] = [
  { text: 'Account closed.', sfx: '/you-lose.mp3' },
];

export function startCampaign(net: CampaignNet): void {
  if (campaignOpen) return;
  campaignOpen = true;

  const overlay = document.createElement('div');
  overlay.id = 'campaignOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:radial-gradient(circle at 50% 30%,#1a1230,#05030c 70%);' +
    'display:flex;align-items:center;justify-content:center;flex-direction:column;' +
    "font-family:ui-monospace,monospace;color:#ffd166;overflow:hidden;";

  const menuMusic = sound('/start-music.mp3', true, 0.5);
  let currentStop: (() => void) | null = null;
  const token = { cancelled: false };
  const ctx: RunCtx = { overlay, net, token, setStop: (s) => { currentStop = s; } };

  function close() {
    if (!campaignOpen) return;
    campaignOpen = false;
    token.cancelled = true;
    if (currentStop) { try { currentStop(); } catch { /* ignore */ } currentStop = null; }
    stopAllMusic();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  renderTitle(ctx, close);
  document.body.appendChild(overlay);
  // Autoplay is gated until a user gesture; the launching click usually satisfies it.
  menuMusic.play().catch(() => { /* will start on first interaction */ });
}

function stopAllMusic() {
  for (const a of audioCache.values()) { if (a.loop) { try { a.pause(); a.currentTime = 0; } catch { /* ignore */ } } }
}

// Promise wrappers so the flow reads top-to-bottom; each registers its stop() for teardown.
function vn(ctx: RunCtx, speaker: string, portrait: string, lines: VNLine[]): Promise<void> {
  return new Promise((res) => {
    const stop = playVN(ctx.overlay, speaker, portrait, lines, () => { ctx.setStop(null); res(); });
    ctx.setStop(stop);
  });
}
function match(ctx: RunCtx, opts: MatchOpts): Promise<MatchResult> {
  return new Promise((res) => {
    const stop = playMatch(ctx.overlay, opts, (r) => { ctx.setStop(null); res(r); });
    ctx.setStop(stop);
  });
}

// --- Title screen ---
function renderTitle(ctx: RunCtx, close: () => void) {
  const { overlay } = ctx;
  overlay.innerHTML = '';
  const menu = sound('/start-music.mp3', true, 0.5);
  menu.play().catch(() => { /* gated until gesture */ });

  const card = document.createElement('div');
  card.style.cssText = 'text-align:center;max-width:680px;padding:24px;';

  const title = document.createElement('h1');
  title.textContent = 'DAVIS COLLECTS';
  title.style.cssText =
    'font-size:clamp(32px,7vw,64px);letter-spacing:4px;margin:0 0 6px;' +
    'text-shadow:0 0 18px rgba(255,209,102,.5);';

  const tag = document.createElement('div');
  tag.textContent = 'Win his tournament — your debt is erased. Lose, and he owns you.';
  tag.style.cssText = 'opacity:.85;font-size:14px;margin-bottom:22px;color:#c8b6ff;';

  const start = document.createElement('button');
  start.textContent = '▶ ENTER THE GAUNTLET';
  start.style.cssText = btnStyle('#7fd1ff', '#2a5a6a', '#0e1a22');
  start.onclick = () => { void runCampaign(ctx, close); };

  const quit = document.createElement('button');
  quit.textContent = 'Quit (Esc)';
  quit.style.cssText = btnStyle('#9aa', '#333', '#0c0c14') + 'margin-left:10px;';
  quit.onclick = close;

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(start);
  card.appendChild(quit);
  card.appendChild(renderBoard(ctx.net));
  overlay.appendChild(card);
}

// --- The full run: cold open → 5 stages (Davis = 3 phases) → ending → score submit. ---
interface RunSummary { scored: number; allowed: number; finalScore: number; stageReached: number; won: boolean; }

async function runCampaign(ctx: RunCtx, close: () => void) {
  const { overlay } = ctx;
  const cancelled = () => ctx.token.cancelled;
  const clear = () => { overlay.innerHTML = ''; };
  stopAllMusic();

  let scored = 0, allowed = 0, stageReached = 1, won = false;

  clear();
  await vn(ctx, 'Davis', '/davisclarke.jpg', COLD_OPEN);
  if (cancelled()) return;

  for (let i = 0; i < CAMPAIGN_STAGES.length; i++) {
    const stage = CAMPAIGN_STAGES[i];
    const isDavis = i === CAMPAIGN_STAGES.length - 1;
    stageReached = i + 1;

    clear();
    await vn(ctx, stage.name, stage.portrait, stage.intro);
    if (cancelled()) return;

    // Phase list: normal stages have one; Davis has his base phase + stage.phases.
    const phases = [
      { portrait: stage.portrait, winScore: stage.winScore, mods: stage.mods, fx: stage.fx,
        label: stage.phases ? 'PHASE 1/3' : undefined, transition: [] as VNLine[] },
      ...(stage.phases ?? []).map((p, k) => ({
        portrait: p.portrait, winScore: p.winScore, mods: p.mods, fx: p.fx,
        label: `PHASE ${k + 2}/3`, transition: p.transition,
      })),
    ];

    // One continuous music track per stage (the boss track spans all 3 phases).
    const music = sound(stage.music, true, 0.45);
    music.currentTime = 0; music.play().catch(() => {});

    let lostRun = false;
    for (const ph of phases) {
      if (ph.transition.length) {
        clear();
        await vn(ctx, stage.name, ph.portrait, ph.transition);
        if (cancelled()) { music.pause(); return; }
      }
      clear();
      const r = await match(ctx, {
        name: stage.name, portrait: ph.portrait, winScore: ph.winScore,
        mods: ph.mods, bot: stage.bot, fx: ph.fx, skin: stage.skin, phaseLabel: ph.label,
      });
      if (cancelled()) { music.pause(); return; }
      scored += r.playerScore; allowed += r.oppScore;
      if (!r.won) { lostRun = true; break; }
    }
    music.pause();

    if (lostRun) {
      clear();
      await vn(ctx, 'Davis', '/davisclarke.jpg', DEFEAT_ENDING);
      if (cancelled()) return;
      break;
    }

    // Stage cleared. Davis's "defeat" lines double as the victory ending.
    if (isDavis) {
      won = true;
      try { const s = sound('/yay.mp3'); s.currentTime = 0; s.play().catch(() => {}); } catch { /* ignore */ }
    }
    clear();
    await vn(ctx, stage.name, isDavis ? '/davisclarke.jpg' : stage.portrait, stage.defeat);
    if (cancelled()) return;
  }

  if (cancelled()) return;
  const finalScore = (scored - allowed) * 1000;
  ctx.net.submitScore(finalScore, stageReached, won);
  renderResult(ctx, close, { scored, allowed, finalScore, stageReached, won });
}

function renderResult(ctx: RunCtx, close: () => void, s: RunSummary) {
  const { overlay } = ctx;
  overlay.innerHTML = '';
  const menu = sound('/start-music.mp3', true, 0.5);
  menu.currentTime = 0; menu.play().catch(() => { /* ignore */ });

  const card = document.createElement('div');
  card.style.cssText = 'text-align:center;max-width:560px;padding:24px;';
  const heading = s.won ? '🏆 DEBT CLEARED' : '💀 ACCOUNT CLOSED';
  card.innerHTML =
    `<div style="font-size:46px;margin-bottom:4px">${s.won ? '🏆' : '💀'}</div>` +
    `<h2 style="letter-spacing:2px;margin:0 0 4px">${heading}</h2>` +
    `<p style="color:#c8b6ff;font-size:14px;margin:0 0 14px">Reached stage ${s.stageReached}/${CAMPAIGN_STAGE_COUNT}</p>` +
    `<div style="font-size:13px;color:#bbb;line-height:1.8">` +
      `<div>Points scored: <b style="color:#7fd1ff">${s.scored}</b></div>` +
      `<div>Points allowed: <b style="color:#ff8a5c">${s.allowed}</b></div>` +
      `<div>(${s.scored} − ${s.allowed}) × 1000</div>` +
    `</div>` +
    `<div style="font-size:30px;font-weight:800;color:#ffd166;margin:10px 0 2px">${s.finalScore.toLocaleString()}</div>` +
    `<div style="font-size:12px;color:#776;letter-spacing:2px">FINAL SCORE</div>` +
    (s.won ? `<div style="margin-top:10px;color:#7fffa0;font-size:13px">+2500 coins on your first clear 🪙</div>` : '');

  const retry = document.createElement('button');
  retry.textContent = '↻ Run again';
  retry.style.cssText = btnStyle('#7fd1ff', '#2a5a6a', '#0e1a22');
  retry.onclick = () => { void runCampaign(ctx, close); };

  const back = document.createElement('button');
  back.textContent = 'Title';
  back.style.cssText = btnStyle('#9aa', '#333', '#0c0c14') + 'margin-left:10px;';
  back.onclick = () => renderTitle(ctx, close);

  card.appendChild(document.createElement('br'));
  card.appendChild(retry);
  card.appendChild(back);
  card.appendChild(renderBoard(ctx.net));
  overlay.appendChild(card);
}

// --- Leaderboard ---
function renderBoard(net: CampaignNet): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:28px;text-align:left;display:inline-block;min-width:280px;';
  const h = document.createElement('div');
  h.textContent = '🏆 TOP COLLECTORS';
  h.style.cssText = 'text-align:center;letter-spacing:2px;color:#c8b6ff;margin-bottom:8px;font-size:13px;';
  wrap.appendChild(h);

  const rows = net.leaderboard();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No runs yet — be the first to face Davis.';
    empty.style.cssText = 'text-align:center;color:#776;font-size:12px;';
    wrap.appendChild(empty);
    return wrap;
  }
  rows.slice(0, 10).forEach((r, i) => {
    const line = document.createElement('div');
    const crown = r.won ? ' 👑' : '';
    line.style.cssText = 'display:flex;justify-content:space-between;font-size:13px;padding:2px 6px;' +
      (i % 2 ? 'background:rgba(255,255,255,.03);' : '');
    line.innerHTML =
      `<span>${i + 1}. ${escapeHtml(r.name)}${crown}</span>` +
      `<span style="color:#ffd166">${r.score.toLocaleString()} <span style="color:#776;font-size:11px">· S${r.stage}/${CAMPAIGN_STAGE_COUNT}</span></span>`;
    wrap.appendChild(line);
  });
  return wrap;
}

// --- helpers ---
function btnStyle(color: string, border: string, bg: string): string {
  return `font:inherit;font-size:13px;font-weight:700;letter-spacing:1px;padding:10px 18px;` +
    `border-radius:8px;border:1px solid ${border};background:${bg};color:${color};cursor:pointer;margin-top:6px;`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
