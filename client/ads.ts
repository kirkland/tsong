// A gloriously fake banner ad pinned to the bottom of the page. It cycles through spammy
// clickbait for the game's own features (DOOM, the campaign, Type or Die, the shop…), and —
// unlike a real ad — clicking it actually launches the thing it's hawking. Self-contained:
// builds its own DOM + styles, revealed only once the player has joined (so it never paints
// over the join screen). Dismissible via the ✕ (it gives up after a token protest).

// Which feature an ad links to. main.ts wires each key to the real launch action.
export type AdAction = 'doom' | 'campaign' | 'typedie' | 'shop';

interface Ad {
  action: AdAction;
  badge: string;     // little corner tag ("AD", "SPONSORED", …)
  headline: string;  // big spammy line
  sub: string;       // small print
  cta: string;       // the button-y call to action
  bg: string;        // CSS background (the garish part)
  fg: string;        // text color
}

// The inventory. Deliberately tacky; each one secretly opens a real feature.
const ADS: Ad[] = [
  { action: 'doom', badge: 'SPONSORED', headline: '😈 Doctors HATE him! One marine’s ONE WEIRD TRICK for inner peace',
    sub: 'Demons detected in your area · rip and tear, today only', cta: 'RIP & TEAR ▶',
    bg: 'linear-gradient(90deg,#2a0606,#5a1010,#2a0606)', fg: '#ff8a8a' },
  { action: 'doom', badge: 'AD', headline: '⚠️ 9 out of 10 demons recommend NOT clicking this',
    sub: 'Free shotgun with every playthrough*', cta: 'PLAY DOOM ▶',
    bg: 'linear-gradient(90deg,#3a0a0a,#7a1a1a)', fg: '#ffd0d0' },
  { action: 'campaign', badge: 'SPONSORED', headline: '💼 Davis is COLLECTING. Is your debt next?',
    sub: 'Clear the campaign before the 5pm deadline — financing available', cta: 'STORY MODE ▶',
    bg: 'linear-gradient(90deg,#06121f,#0e3050,#06121f)', fg: '#9ad0ff' },
  { action: 'campaign', badge: 'AD', headline: '🏓 This ONE paddle trick beats the final boss every time',
    sub: 'Bosses are FURIOUS · 5 stages of pure drama', cta: 'BEAT DAVIS ▶',
    bg: 'linear-gradient(90deg,#0a1828,#13405f)', fg: '#bfe6ff' },
  { action: 'typedie', badge: 'HOT', headline: '⌨️ Hot typists in YOUR court want to defend a base with you 😳',
    sub: 'Co-op horde defense · your WPM could be earning coins RIGHT NOW', cta: 'TYPE OR DIE ▶',
    bg: 'linear-gradient(90deg,#1a1405,#4a3a0c,#1a1405)', fg: '#ffe49a' },
  { action: 'typedie', badge: 'AD', headline: '🧙 They called him the Word Wizard. You can be next.',
    sub: 'Survive the swarm together — more typists, deeper waves', cta: 'JOIN THE RUN ▶',
    bg: 'linear-gradient(90deg,#241a06,#5a4410)', fg: '#ffefb8' },
  { action: 'shop', badge: 'SPONSORED', headline: '🪙 You have UNCLAIMED coins! Act before they "expire"',
    sub: 'Hats · skins · trails · the drip you deserve', cta: 'OPEN SHOP ▶',
    bg: 'linear-gradient(90deg,#1c1606,#4d3d0a,#1c1606)', fg: '#ffe08a' },
  { action: 'shop', badge: 'AD', headline: '🎰 CONGRATULATIONS! You’re our 1,000,000th player 🎁',
    sub: 'Claim your FREE daily spin (this one’s actually real)', cta: 'CLAIM PRIZE ▶',
    bg: 'linear-gradient(90deg,#160a22,#3a1060,#160a22)', fg: '#e0b8ff' },
  { action: 'shop', badge: 'FINANCE', headline: '📈 $DAVIS is up 4,000%?! Don’t miss the next moon 🚀',
    sub: 'Meme coins · loans · definitely-not-gambling', cta: 'TRADE NOW ▶',
    bg: 'linear-gradient(90deg,#06160c,#0d3a22,#06160c)', fg: '#9affc0' },
  { action: 'doom', badge: 'AD', headline: '🚨 SINGLE demons in your area are waiting to be deleted',
    sub: 'No signup · no commitment · just carnage', cta: 'CLICK HERE ▶',
    bg: 'linear-gradient(90deg,#2a0606,#601414)', fg: '#ffb0b0' },
];

let actions: Record<AdAction, () => void> | null = null;
let root: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let badgeEl: HTMLSpanElement | null = null;
let headlineEl: HTMLSpanElement | null = null;
let subEl: HTMLSpanElement | null = null;
let ctaEl: HTMLSpanElement | null = null;
let current: Ad | null = null;
let rotateTimer = 0;
let closeAttempts = 0;
let dismissed = false;

const ROTATE_MS = 13000;

/** Build the (hidden) banner and remember how to launch each feature. Call once at startup. */
export function initAds(launchers: Record<AdAction, () => void>) {
  if (root) return;
  actions = launchers;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes fakeAdGlow { 0%,100%{box-shadow:0 0 0 rgba(255,255,255,0)} 50%{box-shadow:0 -6px 22px rgba(255,255,255,0.12)} }
    @keyframes fakeAdBlink { 0%,49%{opacity:1} 50%,100%{opacity:0.35} }
    @keyframes fakeAdPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.06)} }
    #fakeAd {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 55;
      display: none; align-items: center; gap: 14px;
      height: 76px; padding: 0 52px 0 16px; box-sizing: border-box;
      border-top: 2px solid rgba(255,255,255,0.25);
      font: 700 15px system-ui, sans-serif; cursor: pointer; user-select: none;
      animation: fakeAdGlow 2.4s ease-in-out infinite; overflow: hidden;
    }
    #fakeAd .fakeAd-badge {
      flex: 0 0 auto; font-size: 10px; font-weight: 900; letter-spacing: 1px;
      padding: 3px 6px; border-radius: 3px; background: rgba(0,0,0,0.45);
      color: #fff; animation: fakeAdBlink 1.1s steps(1) infinite;
    }
    #fakeAd .fakeAd-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
    #fakeAd .fakeAd-headline { font-size: clamp(13px, 2.4vw, 19px); font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    #fakeAd .fakeAd-sub { font-size: clamp(10px, 1.6vw, 12px); font-weight: 600; opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #fakeAd .fakeAd-cta {
      flex: 0 0 auto; padding: 9px 16px; border-radius: 6px; font-weight: 900;
      font-size: clamp(11px, 1.7vw, 14px); letter-spacing: 0.5px; color: #0b0b0b;
      background: #fff; box-shadow: 0 2px 0 rgba(0,0,0,0.3);
      animation: fakeAdPulse 1.3s ease-in-out infinite;
    }
    #fakeAd .fakeAd-close {
      position: absolute; top: 6px; right: 10px; z-index: 1;
      width: 22px; height: 22px; line-height: 20px; text-align: center;
      border-radius: 50%; border: none; cursor: pointer;
      background: rgba(0,0,0,0.4); color: #fff; font: 700 13px system-ui; opacity: 0.6;
    }
    #fakeAd .fakeAd-close:hover { opacity: 1; }
    @media (max-width: 560px) { #fakeAd .fakeAd-sub { display: none; } #fakeAd { height: 64px; } }
  `;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.id = 'fakeAd';
  root.setAttribute('role', 'banner');

  badgeEl = document.createElement('span');
  badgeEl.className = 'fakeAd-badge';

  bodyEl = document.createElement('div');
  bodyEl.className = 'fakeAd-text';
  headlineEl = document.createElement('span');
  headlineEl.className = 'fakeAd-headline';
  subEl = document.createElement('span');
  subEl.className = 'fakeAd-sub';
  bodyEl.append(headlineEl, subEl);

  ctaEl = document.createElement('span');
  ctaEl.className = 'fakeAd-cta';

  const close = document.createElement('button');
  close.className = 'fakeAd-close';
  close.type = 'button';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close ad');
  close.addEventListener('click', (e) => { e.stopPropagation(); onClose(); });

  root.append(badgeEl, bodyEl, ctaEl, close);
  // Click anywhere on the banner (but the ✕) launches the advertised feature. Stop the event
  // here so it isn't seen as an "outside click" by panels that close on one (e.g. the shop).
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (current && actions) actions[current.action]();
  });

  document.body.appendChild(root);
}

/** Show the banner and start the rotation. Call once the player has joined. */
export function revealAds() {
  if (!root || dismissed) return;
  document.body.style.paddingBottom = '76px';
  root.style.display = 'flex';
  liftCorner('88px'); // float the bottom-right "Add bot" control clear of the banner
  showRandom();
  clearInterval(rotateTimer);
  rotateTimer = window.setInterval(showRandom, ROTATE_MS);
}

// The "Add bot" dropdown is pinned bottom-right above the banner; lift it so the ad's CTA
// doesn't collide with it (restored to the corner when the ad is dismissed).
function liftCorner(bottom: string) {
  const bot = document.getElementById('botControl');
  if (bot) bot.style.bottom = bottom;
}

function showRandom() {
  if (!root) return;
  // Pick a different ad than the one showing.
  let next = ADS[Math.floor(Math.random() * ADS.length)];
  let guard = 0;
  while (next === current && ADS.length > 1 && guard++ < 10) next = ADS[Math.floor(Math.random() * ADS.length)];
  current = next;
  root.style.background = next.bg;
  root.style.color = next.fg;
  badgeEl!.textContent = next.badge;
  headlineEl!.textContent = next.headline;
  subEl!.textContent = next.sub;
  ctaEl!.textContent = next.cta;
}

function onClose() {
  // The ✕ puts up a little fight first (it's a spammy ad, after all), then relents.
  closeAttempts++;
  if (closeAttempts === 1) {
    if (headlineEl) headlineEl.textContent = '😏 Nice try — you can’t escape the ads that easily';
    if (subEl) subEl.textContent = 'tap the ✕ again if you really mean it';
    return;
  }
  dismissed = true;
  clearInterval(rotateTimer);
  if (root) root.style.display = 'none';
  document.body.style.paddingBottom = '';
  liftCorner(''); // restore the "Add bot" control to the corner
}
