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
    bot: { react: 0.10, error: 26, predict: true, idleCenter: false },
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

// --- Audio ---
const audioCache = new Map<string, HTMLAudioElement>();
function sound(src: string, loop = false, volume = 1): HTMLAudioElement {
  let a = audioCache.get(src);
  if (!a) { a = new Audio(src); audioCache.set(src, a); }
  a.loop = loop;
  a.volume = volume;
  return a;
}

let campaignOpen = false;

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

  function close() {
    if (!campaignOpen) return;
    campaignOpen = false;
    try { menuMusic.pause(); menuMusic.currentTime = 0; } catch { /* ignore */ }
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  renderTitle(overlay, net, close);
  document.body.appendChild(overlay);
  // Autoplay is gated until a user gesture; the launching click usually satisfies it.
  menuMusic.play().catch(() => { /* will start on first interaction */ });
}

// --- Title screen ---
function renderTitle(overlay: HTMLElement, net: CampaignNet, close: () => void) {
  overlay.innerHTML = '';

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
  start.style.cssText = btnStyle('#ffd166', '#5a4a1a', '#150f24');
  // The match + VN flow lands in the next build pass; for now the scaffold confirms the
  // overlay, leaderboard and teardown all work.
  start.onclick = () => renderComingSoon(overlay, net, close);

  const quit = document.createElement('button');
  quit.textContent = 'Quit (Esc)';
  quit.style.cssText = btnStyle('#9aa', '#333', '#0c0c14') + 'margin-left:10px;';
  quit.onclick = close;

  card.appendChild(title);
  card.appendChild(tag);
  card.appendChild(start);
  card.appendChild(quit);
  card.appendChild(renderBoard(net));
  overlay.appendChild(card);
}

function renderComingSoon(overlay: HTMLElement, net: CampaignNet, close: () => void) {
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.style.cssText = 'text-align:center;max-width:560px;padding:24px;';
  card.innerHTML =
    '<div style="font-size:42px;margin-bottom:8px">🚧</div>' +
    '<h2 style="letter-spacing:2px;margin:0 0 8px">THE GAUNTLET OPENS SOON</h2>' +
    `<p style="color:#c8b6ff;opacity:.85;line-height:1.5">Five challengers stand between you and Davis: ` +
    `${CAMPAIGN_STAGES.map((s) => s.name).join(' · ')}.<br>The matches and story are being wired up.</p>`;
  const back = document.createElement('button');
  back.textContent = '← Back';
  back.style.cssText = btnStyle('#ffd166', '#5a4a1a', '#150f24');
  back.onclick = () => renderTitle(overlay, net, close);
  card.appendChild(back);
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
