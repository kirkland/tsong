// The free-roam "World" overworld — client side. A shared Pokémon-style town you walk around
// as a little avatar (name floating above), seeing everyone else in the world live. Buy a car in
// the shop and you can drive it around at ~2× walking speed, with arcade drift. Walk/drive up to
// a building and an in-world prompt lets you enter it: the Arena (the classic tsong game), the
// Casino (roulette), or the Bank (stocks / loans).
//
// RENDERING: this overlay is drawn with **Phaser 3** (pixelArt mode) for a crunchy GBA-Pokémon
// look. All the art is generated procedurally at a low "texel" resolution and upscaled with
// nearest-neighbour sampling — so there are no external image assets to license, and the whole
// thing stays self-contained like the other arcade toys (doom.ts / nuketown.ts). Phaser owns the
// game loop, camera and the canvas; the surrounding chrome (top bar, Drive button, door prompt,
// building dialog) is still plain DOM layered over the canvas.
//
// Networking is client-authoritative: we own our avatar's position (+ heading + driven car when
// in a car), stream it ~15/s, and the server fans everyone's state back to whoever's in the
// world. We render ourselves straight from local input (zero latency), everyone else from the
// latest `world` broadcast (fed in via feedWorld).
//
// Built to grow: a new venue is a WORLD_BUILDINGS entry (shared/types.ts) + a branch in
// enterBuilding() and a building-texture case here. The map/camera/collision/labels key off
// shared data.

import Phaser from 'phaser';
import {
  WORLD,
  WORLD_AVATAR,
  WORLD_BUILDINGS,
  WorldAvatar,
  WorldBuilding,
  WorldBuildingKind,
  CarSpec,
  carById,
} from '../shared/types';

// What the world needs from the rest of the app. main.ts supplies these (see startWorld call).
export interface WorldNet {
  enter(): void;                 // tell the server we're now in the world
  leave(): void;                 // tell the server we've left
  move(x: number, y: number, a?: number, car?: string | null): void; // stream our state
  name(): string;                // our nickname (for our own label)
  color(): string;               // our avatar color
  selfId(): string;              // our connection id (to skip our own avatar in the broadcast)
  car(): string | null;          // our equipped car id (null = none → can't drive)
  onExit(): void;                // the overlay closed (lets main.ts reset the toggle button)
  enterArena(): void;            // walk into the Arena → return to Pong + join the queue
  openFeature(feature: 'roulette' | 'blackjack' | 'craps' | 'crash' | 'slots' | 'stocks' | 'loans'): void; // open a Casino/Bank feature
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  reenter(): void; // re-send worldEnter after a socket reconnect (server forgot us on drop)
}
let controller: Controller | null = null;

export function isWorldOpen(): boolean {
  return controller !== null;
}

/** Push the latest avatar roster (from a `world` server message) into the live overlay. */
export function feedWorld(avatars: WorldAvatar[]): void {
  controller?.feed(avatars);
}

/** Re-assert our presence in the world after a reconnect (the server drops us on socket close). */
export function reenterWorld(): void {
  controller?.reenter();
}

const SPEED = WORLD_AVATAR.speed; // on-foot walk speed
const R = WORLD_AVATAR.r;
const TRIGGER_PAD = 34;     // how close (world units, beyond the wall) counts as "at the door"
const JOY_DEADZONE = 14;    // screen px of drag before the virtual joystick engages
const CAR_LEN = 52;         // car body length, world units (for drawing + collision feel)
const CAR_WID = 28;         // car body width, world units

// --- pixel-art scale knobs -------------------------------------------------------------------
// Everything is authored in "texels". One texel = TEXEL world units; sprites are drawn at their
// texel resolution and scaled up by TEXEL, then the camera zooms by ZOOM. The net result is each
// source texel covers TEXEL*ZOOM screen pixels — crank that ratio up for a chunkier GBA look.
const TEXEL = 2;            // world units per source texel (also the Kenney sprite/tile upscale)
const ZOOM = 2;            // camera zoom (screen px per world unit)
const TILE = 32;           // ground tile size, world units (a 16px Kenney tile drawn at TEXEL×)

// --- Kenney "Tiny Town" tileset (16×16, packed 12×11). Frame indices we use, named for clarity. ---
const TT = {
  grass: [0, 1, 2],                       // plain / textured / flowered grass
  // grass-bordered dirt, as a 3×3 autotile: [topLeft,top,topRight, left,center,right, botL,bot,botR]
  dirt: [12, 13, 14, 24, 25, 26, 36, 37, 38],
  trees: [16, 4], pines: [27, 15], bush: 5, mushroom: 29, sapling: 17,
} as const;

// --- the town layout: roads + decorations, computed once and shared by every session ---

interface Rect { x: number; y: number; w: number; h: number }
// Road network (tan strips) connecting the plaza to each building. Tuned to the shared building
// coordinates: a horizontal "main street" spine with spurs up to the Arena and down to the
// Casino / Bank, all crossing the central plaza.
const ROADS: Rect[] = [
  { x: 560, y: 1180, w: 2080, h: 120 }, // main street (spine)
  { x: 1560, y: 630, w: 110, h: 600 },  // spur up to the Arena
  { x: 605, y: 1290, w: 110, h: 200 },  // spur down to the Casino
  { x: 2485, y: 1290, w: 110, h: 200 }, // spur down to the Bank
];
const PLAZA = { x: 1600, y: 1100, r: 240 }; // paved circle + fountain at town center

function pointInRect(px: number, py: number, r: Rect, pad = 0): boolean {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}
function onRoad(px: number, py: number, pad = 0): boolean {
  return ROADS.some((r) => pointInRect(px, py, r, pad));
}
function nearPlaza(px: number, py: number, pad = 0): boolean {
  return Math.hypot(px - PLAZA.x, py - PLAZA.y) <= PLAZA.r + pad;
}
function inAnyBuilding(px: number, py: number, pad = 0): boolean {
  return WORLD_BUILDINGS.some((b) => pointInRect(px, py, b, pad));
}
// "Bare" ground = roads + the plaza: dirt under your feet, autotiled against the surrounding grass.
function isBare(px: number, py: number): boolean {
  return onRoad(px, py) || nearPlaza(px, py);
}

// Deterministic 0..1 hash so decoration placement is stable across frames/sessions without any
// Math.random (which would make the scenery jitter every repaint).
function hash(i: number, j: number): number {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 1000) / 1000;
}

type DecorType = 'tree' | 'pine' | 'bush' | 'flower' | 'shrub';
type Decor = { type: DecorType; x: number; y: number; s: number };
// Scatter scenery across the grass on a tight jittered grid, skipping roads, the plaza and building
// footprints. Decoration is non-solid (you can walk/drift over the grass freely) — only buildings
// and the map border collide, which keeps driving fun.
const DECOR: Decor[] = (() => {
  const out: Decor[] = [];
  const cell = 96; // tight grid → a full, lush map
  for (let gx = 70; gx < WORLD.w - 50; gx += cell) {
    for (let gy = 70; gy < WORLD.h - 50; gy += cell) {
      const x = gx + (hash(gx, gy * 3) - 0.5) * 80;
      const y = gy + (hash(gx * 3, gy) - 0.5) * 80;
      if (inAnyBuilding(x, y, 90) || onRoad(x, y, 28) || nearPlaza(x, y, 28)) continue;
      // Leave some cells empty so it reads organic rather than wall-to-wall.
      if (hash(gx + 5, gy + 9) < 0.2) continue;
      const r = hash(gx, gy);
      const type: DecorType =
        r < 0.34 ? 'tree' : r < 0.5 ? 'pine' : r < 0.7 ? 'bush' :
        r < 0.86 ? 'shrub' : 'flower';
      out.push({ type, x, y, s: 0.85 + hash(gy, gx) * 0.5 });
    }
  }
  return out;
})();

// A ring of bushes hugging the plaza paving (leaving gaps where the roads enter).
const HEDGE_RING: { x: number; y: number }[] = (() => {
  const out: { x: number; y: number }[] = [];
  const ringR = PLAZA.r + 24;
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    const x = PLAZA.x + Math.cos(a) * ringR, y = PLAZA.y + Math.sin(a) * ringR;
    if (onRoad(x, y, 36)) continue;
    out.push({ x, y });
  }
  return out;
})();

// --- townsfolk: client-side NPCs that wander near a home spot and have a few lines. A couple of
// them ask a question you can actually answer (two reply choices, each with its own comeback).
// Purely local flavour — never networked, so they cost the server nothing. ---
interface NpcChoice { label: string; reply: string }
interface NpcDef {
  id: string;
  name: string;
  shirt: number;        // body/shirt tint (ignored for the minion)
  hair: number;         // hair tint (ignored for the minion)
  kind?: 'minion';      // special one-off sprite; default is the little-person
  glasses?: boolean;    // overlay specs on the little-person head
  stripes?: boolean;    // red/white striped shirt instead of a flat tinted one (Waldo!)
  x: number; y: number; // home anchor (NPC roams around this)
  roam: number;         // wander radius, world units
  lines: string[];      // flavour one-liners, cycled each chat
  ask?: { q: string; choices: [NpcChoice, NpcChoice] }; // optional: a question you can answer
}
const NPCS: NpcDef[] = [
  {
    id: 'pip', name: 'Pip', shirt: 0xe05a6d, hair: 0x4a2f1a, x: 1470, y: 1170, roam: 120,
    lines: [
      'I walked around the fountain. Twice!',
      'Did you know the ball has eyes? It watches you sleep.',
      'When I grow up I wanna be a ball too.',
    ],
  },
  {
    id: 'vito', name: 'Coach Vito', shirt: 0x3a78c2, hair: 0x2a2a2a, x: 1710, y: 720, roam: 90,
    lines: ["Back in my day the ball was square. We liked it that way."],
    ask: {
      q: 'Want the secret to winning at tsong?',
      choices: [
        { label: 'Yes, coach!', reply: 'Hit the ball. Do NOT miss it. ...That\'ll be 500 coins.' },
        { label: "I got this", reply: 'Cocky. I respect it. Cry quietly when you lose, okay?' },
      ],
    },
  },
  {
    id: 'lou', name: 'Lucky Lou', shirt: 0x2faf6a, hair: 0x6b4a1f, x: 770, y: 1380, roam: 110,
    lines: [
      "I'm up BIG. Don't tell my wife.",
      'The house always wins. But not today. ...Probably today.',
      'You ever put your whole wallet on black? Character-building.',
    ],
  },
  {
    id: 'edna', name: 'Banker Edna', shirt: 0x8a5cf6, hair: 0x9a9aa8, x: 2430, y: 1380, roam: 90,
    lines: ['A penny saved is a penny we hold for you. Indefinitely.'],
    ask: {
      q: 'Care to make an investment today?',
      choices: [
        { label: 'Tell me more', reply: 'Buy low, sell high. Consulting fee: 4,000 coins. Pleasure doing business.' },
        { label: 'Just browsing', reply: "Of course. We'll be watching. ...Fondly." },
      ],
    },
  },
  {
    id: 'drift', name: 'Drift', shirt: 0xff8a3d, hair: 0x1f1f1f, x: 1150, y: 1255, roam: 130,
    lines: [
      'Nice car. Mine corners better, though.',
      'I drifted the whole plaza once. No witnesses, but it happened.',
      'Grip is for cowards. ...My insurance disagrees.',
    ],
  },
  {
    id: 'mush', name: 'Mush', shirt: 0xc24a8a, hair: 0x3a6b2f, x: 2120, y: 820, roam: 120,
    lines: [
      "Don't eat the red mushrooms. ...Or do. I'm not your dad.",
      'I talk to the trees. They sway back. We have an understanding.',
    ],
  },
  {
    id: 'waldo', name: 'Waldo', shirt: 0xd23b3b, hair: 0x3a2a1a, glasses: true, stripes: true,
    x: 980, y: 980, roam: 150,
    lines: [
      'You FOUND me?! Took you long enough.',
      'Red-and-white stripes in a town full of grass. Worst camouflage ever.',
      'Have you seen my dog? His tail is striped too. It gets confusing.',
      'Somewhere out there is a guy in my exact outfit. We do not speak.',
      'Quick — look away and I bet you lose me again.',
    ],
  },
  {
    // Matt's custom guy: a distinguished older gent (grey hair, specs, teal cardigan) who never
    // strays from the fountain — the office nag reminding you there's work to do.
    id: 'burt', name: 'Burt', shirt: 0x2e8b8b, hair: 0xb9bcc4, glasses: true, x: 1600, y: 1235, roam: 34,
    lines: [
      "Don't you have to get back to work?",
      "Aren't you on Ops-Task Rotation this week?",
      'Those Tech Services guys sure like to slack off!',
    ],
  },
  {
    id: 'kevin', name: 'Kevin', shirt: 0xfdd835, hair: 0x111111, kind: 'minion', x: 1880, y: 1240, roam: 140,
    lines: [
      'Bello! ...Banana?',
      'Poopaye! (that means goodbye)',
      'Bee-do! Bee-do! Bee-do!',
      'Tank yu! Para tú!',
    ],
    ask: {
      q: 'BA-NA-NA?!',
      choices: [
        { label: '🍌 Banana!', reply: 'BANANAAAAAA! *happy minion noises*' },
        { label: 'No thanks', reply: '...Poopaye. (he looks devastated)' },
      ],
    },
  },
];

// A spawned, live townsperson.
interface LiveNpc {
  def: NpcDef;
  x: number; y: number;
  tx: number; ty: number;   // current wander target
  pauseUntil: number;       // ms timestamp; stand still until then
  faceLeft: boolean;
  walking: boolean;
  lineIdx: number;          // which flavour line to say next
  c: Phaser.GameObjects.Container;
  bob: Phaser.GameObjects.Container; // body sprites (bobbed/flipped); shadow+label sit outside it
}

// --- small helpers ---
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function hexToInt(c: string): number {
  if (c[0] === '#') c = c.slice(1);
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  return parseInt(c, 16) >>> 0;
}
// Shade a 0xRRGGBB color toward black (f<1) or white (f>1) — for cheap pixel-art highlights/shadows.
function shade(int: number, f: number): number {
  const ch = (v: number) => clamp(Math.round(v * Math.min(f, 1) + (f > 1 ? 255 * (f - 1) : 0)), 0, 255);
  const r = ch((int >> 16) & 0xff);
  const g = ch((int >> 8) & 0xff);
  const b = ch(int & 0xff);
  return (r << 16) | (g << 8) | b;
}

export function startWorld(net: WorldNet): void {
  if (controller) return; // already open

  // --- local avatar state ---
  let selfX: number = WORLD.spawnX;
  let selfY: number = WORLD.spawnY;
  let facing = -Math.PI / 2; // radians; on foot = look dir, in car = heading. Start facing "up".
  let others: WorldAvatar[] = [];

  // --- car state ---
  let driving = false;
  let vx = 0, vy = 0; // car velocity, world units / s (drives the drift physics)

  // --- input state ---
  const keys = new Set<string>();
  let joyActive = false;
  let joyOX = 0, joyOY = 0; // joystick origin (screen px)
  let joyCX = 0, joyCY = 0; // joystick current (screen px)
  let dialogOpen = false;   // movement pauses while a building dialog is up
  let nearId: string | null = null; // building the avatar is currently at the door of

  // --- NPC state ---
  const npcs: LiveNpc[] = [];          // populated in create()
  let nearNpc: LiveNpc | null = null;  // townsperson within talking range
  let talkOpen = false;                // an NPC dialogue box is up → movement pauses
  let npcAdvance: (() => void) | null = null; // set while a dialogue is live; called on Enter/click
  let npcClose: (() => void) | null = null;   // closes the live dialogue (Esc)

  // --- network send throttle ---
  let lastSentX = NaN, lastSentY = NaN, lastSentAt = 0;

  // --- DOM chrome (everything but the canvas, which Phaser injects) ---
  const overlay = document.createElement('div');
  overlay.id = 'worldOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9998;background:#0b1020;overflow:hidden;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;touch-action:none;user-select:none;';

  // Phaser mounts its canvas into this host (kept behind the chrome).
  const gameHost = document.createElement('div');
  gameHost.style.cssText = 'position:absolute;inset:0;';
  overlay.appendChild(gameHost);

  // --- atmosphere: a warm sun tint + a soft vignette, blended over the canvas. This is the single
  // biggest "it looks lit, not flat" win and costs nothing (two non-interactive CSS layers). ---
  const sunTint = document.createElement('div');
  sunTint.style.cssText =
    'position:absolute;inset:0;z-index:1;pointer-events:none;mix-blend-mode:soft-light;' +
    'background:radial-gradient(120% 90% at 64% 24%, rgba(255,236,170,.85), rgba(255,180,120,.25) 55%, rgba(40,60,120,.35) 100%);';
  overlay.appendChild(sunTint);
  const vignette = document.createElement('div');
  vignette.style.cssText =
    'position:absolute;inset:0;z-index:1;pointer-events:none;' +
    'background:radial-gradient(120% 100% at 50% 46%, rgba(0,0,0,0) 52%, rgba(8,12,30,.42) 100%);';
  overlay.appendChild(vignette);

  // Top bar: title + live player count + drive toggle + exit.
  const topbar = document.createElement('div');
  topbar.style.cssText =
    'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;' +
    'padding:10px 14px;background:linear-gradient(#0b1020dd,#0b102000);pointer-events:none;z-index:2;';
  const title = document.createElement('div');
  title.innerHTML = '🌍 <b>TSONG WORLD</b> <span style="opacity:.6;font-size:12px">beta</span>';
  title.style.cssText = 'color:#e8eefc;font-size:18px;letter-spacing:.5px;text-shadow:0 2px 6px #000a;';
  const count = document.createElement('div');
  count.style.cssText = 'color:#8aa0d8;font-size:13px;margin-left:auto;pointer-events:none;text-shadow:0 1px 4px #000a;';
  const driveBtn = document.createElement('button');
  driveBtn.type = 'button';
  driveBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#243a6b;color:#cfe0ff;border:1px solid #3a558f;' +
    'border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '← Back to Pong';
  backBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;' +
    'border:1px solid #2c3a63;border-radius:8px;padding:7px 12px;font-size:13px;';
  topbar.append(title, count, driveBtn, backBtn);
  overlay.appendChild(topbar);

  // Controls hint (bottom-left).
  const help = document.createElement('div');
  help.style.cssText =
    'position:absolute;left:14px;bottom:12px;color:#cdd8f5;font-size:12px;pointer-events:none;line-height:1.5;z-index:2;text-shadow:0 1px 4px #000a;';
  overlay.appendChild(help);

  // Door prompt (bottom-center). A real button so tapping works on touch; Enter/E does the same.
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.style.cssText =
    'position:absolute;left:50%;bottom:42px;transform:translateX(-50%);display:none;cursor:pointer;' +
    'background:#e8b84b;color:#1a1408;border:none;border-radius:10px;padding:11px 18px;font-size:15px;' +
    'font-weight:700;box-shadow:0 6px 20px #0008;z-index:2;';
  overlay.appendChild(prompt);

  // Building dialog ("what do you want to do?") — a centered modal over the map.
  const dialog = document.createElement('div');
  dialog.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#0008;z-index:3;';
  const dialogBox = document.createElement('div');
  dialogBox.style.cssText =
    'min-width:260px;max-width:90vw;background:#141c33;border:1px solid #2c3a63;border-radius:14px;' +
    'padding:22px;box-shadow:0 16px 50px #000a;text-align:center;';
  dialog.appendChild(dialogBox);
  overlay.appendChild(dialog);

  // NPC dialogue — a Pokémon-style box pinned to the bottom: name tag, typewritten line, a blinking
  // ▼, and (for the interactive folks) a couple of reply buttons. Tap / Enter / Space advances.
  const npcBox = document.createElement('div');
  npcBox.style.cssText =
    'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:min(92vw,720px);display:none;' +
    'background:#0c1330ee;border:3px solid #e8eefc;border-radius:14px;padding:18px 22px 20px;' +
    'box-shadow:0 12px 40px #000a;z-index:4;cursor:pointer;';
  const npcName = document.createElement('div');
  npcName.style.cssText =
    'position:absolute;top:-14px;left:18px;background:#e8b84b;color:#1a1408;font-weight:800;' +
    'font-size:14px;letter-spacing:.5px;padding:3px 12px;border-radius:8px;box-shadow:0 3px 0 #00000033;';
  const npcText = document.createElement('div');
  npcText.style.cssText = 'color:#eef2ff;font-size:18px;line-height:1.5;min-height:54px;font-family:ui-monospace,monospace;';
  const npcChoices = document.createElement('div');
  npcChoices.style.cssText = 'display:none;gap:8px;margin-top:10px;';
  const npcHint = document.createElement('div');
  npcHint.textContent = '▼';
  npcHint.style.cssText = 'position:absolute;right:16px;bottom:8px;color:#9fd1ff;font-size:15px;animation:wBlink 1s steps(2) infinite;';
  npcBox.append(npcName, npcText, npcChoices, npcHint);
  overlay.appendChild(npcBox);
  if (!document.getElementById('wKeyframes')) {
    const st = document.createElement('style');
    st.id = 'wKeyframes';
    st.textContent = '@keyframes wBlink{0%,49%{opacity:.25}50%,100%{opacity:1}}';
    document.head.appendChild(st);
  }

  document.body.appendChild(overlay);

  // --- collision: keep the avatar/car outside every building rectangle ---
  function resolveCollisions(x: number, y: number, rad: number): { x: number; y: number; hit: boolean } {
    let hit = false;
    for (const b of WORLD_BUILDINGS) {
      const nx = clamp(x, b.x, b.x + b.w);
      const ny = clamp(y, b.y, b.y + b.h);
      const dx = x - nx, dy = y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rad * rad) continue;
      hit = true;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        x = nx + (dx / d) * rad;
        y = ny + (dy / d) * rad;
      } else {
        const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bottom = b.y + b.h - y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) x = b.x - rad;
        else if (m === right) x = b.x + b.w + rad;
        else if (m === top) y = b.y - rad;
        else y = b.y + b.h + rad;
      }
    }
    return {
      x: clamp(x, rad, WORLD.w - rad),
      y: clamp(y, rad, WORLD.h - rad),
      hit,
    };
  }

  function distToBuilding(b: WorldBuilding): number {
    const nx = clamp(selfX, b.x, b.x + b.w);
    const ny = clamp(selfY, b.y, b.y + b.h);
    return Math.hypot(selfX - nx, selfY - ny);
  }

  // --- driving ---
  function myCar(): CarSpec | null {
    return carById(net.car());
  }
  function toggleDrive() {
    if (!driving) {
      if (!myCar()) { flashHelp("You don't own a car — buy one in the 🪙 Shop (Cars tab)."); return; }
      driving = true;
      vx = vy = 0;
      revSound(true);
    } else {
      driving = false;
      vx = vy = 0;
      revSound(false);
    }
    syncDriveBtn();
  }
  function syncDriveBtn() {
    const car = myCar();
    if (driving) {
      driveBtn.textContent = '🚶 Get out';
    } else {
      driveBtn.textContent = car ? `🚗 Drive ${car.name}` : '🚗 Drive';
    }
    driveBtn.style.opacity = car || driving ? '1' : '0.6';
    updateHelp();
  }

  let helpFlash = '';
  let helpFlashUntil = 0;
  function flashHelp(msg: string) { helpFlash = msg; helpFlashUntil = performance.now() + 2600; updateHelp(); }
  function updateHelp() {
    const now = performance.now();
    if (helpFlash && now < helpFlashUntil) { help.innerHTML = `<span style="color:#ffd166">${helpFlash}</span>`; return; }
    help.innerHTML = driving
      ? 'W/S or ↑/↓ throttle · A/D or ←/→ steer · drag to drive · <b>F</b> get out'
      : 'WASD / arrows or drag to walk · <b>F</b> to drive · <b>Space</b> to talk / enter';
  }

  // --- building entry ---
  function labelFor(kind: WorldBuildingKind): string {
    switch (kind) {
      case 'arena': return '🏓 Enter the Arena (play tsong)';
      case 'casino': return '🎰 Enter the Casino';
      case 'bank': return '🏦 Enter the Bank';
    }
  }
  function enterBuilding(kind: WorldBuildingKind) {
    enterChime();
    if (kind === 'arena') { exit(); net.enterArena(); return; }
    if (kind === 'casino') {
      openDialog('🎰 Casino', 'What are you feeling lucky for?', [
        { label: '🎡 Roulette',   onPick: () => { exit(); net.openFeature('roulette');  } },
        { label: '🃏 Blackjack',  onPick: () => { exit(); net.openFeature('blackjack'); } },
        { label: '🎲 Craps',      onPick: () => { exit(); net.openFeature('craps');     } },
        { label: '🚀 Crash',      onPick: () => { exit(); net.openFeature('crash');     } },
        { label: '🎰 Slots',      onPick: () => { exit(); net.openFeature('slots');     } },
      ]);
      return;
    }
    if (kind === 'bank') {
      openDialog('🏦 Bank', 'How can we help you today?', [
        { label: '📈 Crypto Market', onPick: () => { exit(); net.openFeature('stocks'); } },
        { label: '💸 Get a Loan', onPick: () => { exit(); net.openFeature('loans'); } },
      ]);
      return;
    }
  }
  function openDialog(heading: string, sub: string, choices: { label: string; onPick: () => void }[]) {
    dialogOpen = true;
    keys.clear(); joyActive = false;
    dialogBox.replaceChildren();
    const h = document.createElement('div');
    h.textContent = heading;
    h.style.cssText = 'font-size:22px;color:#e8eefc;margin-bottom:6px;';
    const s = document.createElement('div');
    s.textContent = sub;
    s.style.cssText = 'font-size:13px;color:#8aa0d8;margin-bottom:18px;';
    dialogBox.append(h, s);
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.style.cssText =
        'display:block;width:100%;margin:8px 0;cursor:pointer;background:#21305a;color:#e8eefc;' +
        'border:1px solid #38508f;border-radius:10px;padding:13px;font-size:15px;font-weight:600;';
      b.onmouseenter = () => { b.style.background = '#2c4079'; };
      b.onmouseleave = () => { b.style.background = '#21305a'; };
      b.onclick = () => { selectBlip(); c.onPick(); };
      dialogBox.appendChild(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Cancel';
    close.style.cssText =
      'display:block;width:100%;margin-top:10px;cursor:pointer;background:transparent;color:#7c8ab5;' +
      'border:none;padding:8px;font-size:13px;';
    close.onclick = closeDialog;
    dialogBox.appendChild(close);
    dialog.style.display = 'flex';
  }
  function closeDialog() {
    dialogOpen = false;
    dialog.style.display = 'none';
  }

  // --- NPC dialogue (Pokémon-style bottom box: typewriter line(s), then optional reply choices) ---
  function startTalk(n: LiveNpc) {
    if (talkOpen || dialogOpen) return;
    talkOpen = true;
    keys.clear(); joyActive = false;
    prompt.style.display = 'none';
    n.faceLeft = selfX < n.x; // turn to face the player

    // Build the page list: one flavour line, then (if any) the question + its chosen reply.
    type Page = { text: string; choices?: readonly [NpcChoice, NpcChoice] };
    const pages: Page[] = [{ text: n.def.lines[n.lineIdx % n.def.lines.length] }];
    n.lineIdx++;
    if (n.def.ask) pages.push({ text: n.def.ask.q, choices: n.def.ask.choices });

    npcName.textContent = n.def.name;
    npcBox.style.display = 'block';

    let pageI = 0;
    let typing = false;
    let timer = 0;
    let full = '';

    const renderChoices = (choices: readonly [NpcChoice, NpcChoice]) => {
      npcHint.style.display = 'none';
      npcChoices.style.display = 'flex';
      npcChoices.replaceChildren();
      for (const ch of choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = ch.label;
        b.style.cssText =
          'flex:1;cursor:pointer;background:#21305a;color:#e8eefc;border:2px solid #4a64a0;' +
          'border-radius:10px;padding:11px;font-size:15px;font-weight:700;font-family:ui-monospace,monospace;';
        b.onmouseenter = () => { b.style.background = '#2c4079'; };
        b.onmouseleave = () => { b.style.background = '#21305a'; };
        b.onclick = (ev) => {
          ev.stopPropagation();
          selectBlip();
          npcChoices.style.display = 'none';
          pages.push({ text: ch.reply }); // append the comeback as the next page
          pageI++; showPage();
        };
        npcChoices.appendChild(b);
      }
    };

    function showPage() {
      const page = pages[pageI];
      if (!page) { closeTalk(); return; }
      npcChoices.style.display = 'none';
      // typewriter with a campaign-style blip every couple of characters
      full = page.text;
      let shown = 0;
      typing = true;
      npcText.textContent = '';
      npcHint.style.display = 'none';
      timer = window.setInterval(() => {
        shown++;
        npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) textBlip();
        if (shown >= full.length) {
          window.clearInterval(timer);
          typing = false;
          if (page.choices) renderChoices(page.choices);
          else npcHint.style.display = 'block';
        }
      }, 30);
    }

    // Advance: finish the typewriter instantly, else move to the next page (choice pages wait for a tap).
    npcAdvance = () => {
      if (typing) {
        window.clearInterval(timer);
        typing = false;
        npcText.textContent = full;
        const page = pages[pageI];
        if (page?.choices) renderChoices(page.choices);
        else npcHint.style.display = 'block';
        return;
      }
      if (pages[pageI]?.choices) return; // must pick a choice, not skip
      pageI++;
      if (pageI >= pages.length) closeTalk();
      else showPage();
    };

    function closeTalk() {
      window.clearInterval(timer);
      talkOpen = false;
      npcAdvance = null;
      npcClose = null;
      npcBox.style.display = 'none';
      npcChoices.style.display = 'none';
    }
    npcClose = closeTalk;

    showPage();
  }
  npcBox.onclick = () => npcAdvance?.();

  function triggerNear() {
    if (dialogOpen || talkOpen) return;
    if (nearNpc) { startTalk(nearNpc); return; }
    const b = WORLD_BUILDINGS.find((x) => x.id === nearId);
    if (b) enterBuilding(b.kind);
  }
  prompt.onclick = triggerNear;
  driveBtn.onclick = toggleDrive;

  // --- input (capture phase so the main game's global shortcuts don't also fire) ---
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKeyDown(e: KeyboardEvent) {
    unlockAudio();
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      if (talkOpen) npcClose?.(); else if (dialogOpen) closeDialog(); else exit();
      return;
    }
    // While chatting, Enter / Space / E advances the dialogue; movement is frozen.
    if (talkOpen) {
      if (k === 'enter' || k === ' ' || k === 'e') { e.preventDefault(); e.stopPropagation(); npcAdvance?.(); }
      else if (MOVE_KEYS.has(k)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (dialogOpen) return;
    if (k === 'f') { e.preventDefault(); e.stopPropagation(); toggleDrive(); return; }
    if (k === 'enter' || k === 'e' || k === ' ') {
      // Always swallow Space so the page never scrolls; interact if something's in range.
      e.preventDefault(); e.stopPropagation();
      if (nearId || nearNpc) triggerNear();
      return;
    }
    if (MOVE_KEYS.has(k)) { keys.add(k); e.preventDefault(); e.stopPropagation(); }
  }
  function onKeyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) { keys.delete(k); e.stopPropagation(); }
  }
  function onPointerDown(e: PointerEvent) {
    unlockAudio();
    // Ignore drags that start on a chrome button or while a modal/dialogue is up.
    if (dialogOpen || talkOpen || (e.target instanceof Element && e.target.closest('button'))) return;
    joyActive = true;
    joyOX = joyCX = e.clientX;
    joyOY = joyCY = e.clientY;
  }
  function onPointerMove(e: PointerEvent) {
    if (!joyActive) return;
    joyCX = e.clientX; joyCY = e.clientY;
  }
  function onPointerUp() { joyActive = false; }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  overlay.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  backBtn.onclick = exit;

  // --- movement physics (identical to the canvas version; Phaser just renders the result) ---

  // Walk: 8-direction movement at a constant speed.
  function stepFoot(dt: number) {
    let dx = 0, dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    if (dx === 0 && dy === 0 && joyActive) {
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      if (Math.hypot(jx, jy) > JOY_DEADZONE) { dx = jx; dy = jy; }
    }
    const mag = Math.hypot(dx, dy);
    if (mag === 0) return;
    dx /= mag; dy /= mag;
    facing = Math.atan2(dy, dx);
    const moved = resolveCollisions(selfX + dx * SPEED * dt, selfY + dy * SPEED * dt, R);
    selfX = moved.x; selfY = moved.y;
    if (moved.hit) bumpSound(false);
    else stepSound();
  }

  // Drive: arcade physics with drift. Throttle accelerates along the heading; steering rotates the
  // heading (more authority the faster you go); the velocity's sideways component is bled off by
  // the car's grip each frame — low grip = long slides (drift), high grip = it sticks.
  function stepCar(car: CarSpec, dt: number) {
    let throttle = 0, steer = 0;
    if (keys.has('w') || keys.has('arrowup')) throttle += 1;
    if (keys.has('s') || keys.has('arrowdown')) throttle -= 1;
    if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
    if (keys.has('d') || keys.has('arrowright')) steer += 1;
    if (joyActive) {
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      if (Math.hypot(jx, jy) > JOY_DEADZONE) {
        throttle += clamp(-jy / 60, -1, 1); // push up = forward
        steer += clamp(jx / 60, -1, 1);     // push right = steer right
      }
    }
    throttle = clamp(throttle, -1, 1);
    steer = clamp(steer, -1, 1);

    const sp = Math.hypot(vx, vy);
    // Steering needs speed to bite; near-stationary you can barely turn.
    const authority = Math.min(1, sp / 120);
    facing += steer * car.turn * authority * dt;

    const hx = Math.cos(facing), hy = Math.sin(facing);
    // Accelerate along the heading (reverse at 60% power).
    const power = throttle >= 0 ? car.accel : car.accel * 0.6;
    vx += hx * power * throttle * dt;
    vy += hy * power * throttle * dt;

    // Split velocity into forward (along heading) + lateral (sideways) and bleed the lateral part
    // off by grip — this is what makes the car drift instead of moving like an air-hockey puck.
    let fwd = vx * hx + vy * hy;
    let lat = -vx * hy + vy * hx;
    const k = Math.pow(car.grip, dt * 60); // grip applied per ~frame, dt-correct
    lat *= k;
    fwd *= Math.pow(0.99, dt * 60);        // mild rolling drag
    fwd = clamp(fwd, -car.speed * 0.5, car.speed);
    vx = hx * fwd - hy * lat;
    vy = hy * fwd + hx * lat;

    const moved = resolveCollisions(selfX + vx * dt, selfY + vy * dt, CAR_WID * 0.5);
    if (moved.hit) {
      if (Math.hypot(vx, vy) > 60) bumpSound(true); // crunch (skip silent scrapes when crawling)
      vx *= 0.3; vy *= 0.3;                          // kill most momentum
    }
    selfX = moved.x; selfY = moved.y;
  }

  function updateNearBuilding() {
    if (talkOpen) { prompt.style.display = 'none'; return; } // freeze targeting mid-chat
    // nearest building door
    let best: string | null = null;
    let bestD = Infinity;
    for (const b of WORLD_BUILDINGS) {
      const d = distToBuilding(b);
      const reach = (driving ? CAR_LEN * 0.5 : R) + TRIGGER_PAD;
      if (d <= reach && d < bestD) { bestD = d; best = b.id; }
    }
    nearId = best;
    // nearest townsperson (can't chat from inside a car) — buildings win ties.
    nearNpc = null;
    if (!best && !driving) {
      let bD = R + TRIGGER_PAD + 12;
      for (const n of npcs) {
        const d = Math.hypot(n.x - selfX, n.y - selfY);
        if (d < bD) { bD = d; nearNpc = n; }
      }
    }
    if (best) {
      const b = WORLD_BUILDINGS.find((x) => x.id === best)!;
      prompt.textContent = labelFor(b.kind);
    } else if (nearNpc) {
      prompt.textContent = `💬 Talk to ${nearNpc.def.name}`;
    }
    prompt.style.display = (nearId || nearNpc) && !dialogOpen && !talkOpen ? 'block' : 'none';
  }

  function maybeSendMove(now: number) {
    if (now - lastSentAt < 66) return; // ~15 Hz cap
    if (Math.abs(selfX - lastSentX) < 0.5 && Math.abs(selfY - lastSentY) < 0.5) return;
    lastSentX = selfX; lastSentY = selfY; lastSentAt = now;
    net.move(selfX, selfY, driving ? facing : undefined, driving ? net.car() : null);
  }

  // ============================================================================================
  // AUDIO — Pokémon-style chiptune SFX, synthesized on the fly (same WebAudio idiom as doom.ts /
  // campaign.ts: a lazy AudioContext + tiny square/saw one-shots and filtered-noise bursts). The
  // star is the bump: walk into a tree/wall/lake and you get that satisfying low GBA "boop".
  // ============================================================================================
  let actx: AudioContext | null = null;
  const ac = () => (actx ??= new AudioContext());
  function unlockAudio() { try { const a = ac(); if (a.state === 'suspended') void a.resume(); } catch { /* ignore */ } }
  // One note with an exponential decay; optional pitch slide gives the chirpy GBA character.
  function tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    try {
      const a = ac(); const t = a.currentTime;
      const o = a.createOscillator(); const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch { /* ignore */ }
  }
  // A short band-passed noise burst — grass rustle on foot, tyre skid in a car.
  function noise(dur: number, vol: number, cutoff: number) {
    try {
      const a = ac(); const t = a.currentTime;
      const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = cutoff; bp.Q.value = 0.7;
      const g = a.createGain(); g.gain.value = vol;
      src.connect(bp); bp.connect(g); g.connect(a.destination); src.start(t);
    } catch { /* ignore */ }
  }
  let lastBumpAt = 0, lastStepAt = 0, stepToggle = false;
  // The collision "boop" — a quick low square that drops in pitch. Throttled so holding against a
  // wall doesn't machine-gun. `hard` (a car crunch) is louder and adds a little skid.
  function bumpSound(hard: boolean) {
    const now = performance.now();
    if (now - lastBumpAt < 150) return;
    lastBumpAt = now;
    tone(hard ? 150 : 138, 0.11, 'square', hard ? 0.22 : 0.16, hard ? 68 : 92);
    if (hard) noise(0.13, 0.13, 520);
  }
  // Soft alternating grass-shuffle footsteps while walking.
  function stepSound() {
    const now = performance.now();
    if (now - lastStepAt < 250) return;
    lastStepAt = now;
    stepToggle = !stepToggle;
    noise(0.05, 0.03, stepToggle ? 1700 : 1300);
  }
  // The "step through the door" jingle — a bright ascending square arpeggio.
  function enterChime() {
    tone(523, 0.09, 'square', 0.16);
    window.setTimeout(() => tone(659, 0.09, 'square', 0.16), 85);
    window.setTimeout(() => tone(784, 0.15, 'square', 0.16), 170);
  }
  function revSound(starting: boolean) {
    if (starting) tone(80, 0.26, 'sawtooth', 0.18, 230);
    else tone(210, 0.22, 'sawtooth', 0.15, 80);
  }
  function selectBlip() { tone(660, 0.05, 'square', 0.12, 880); }
  // The dialogue typewriter blip — lifted straight from campaign.ts's text chatter (square 440→720).
  function textBlip() { tone(440, 0.04, 'square', 0.05, 720); }

  // ============================================================================================
  // PHASER SCENE — texture generation + rendering. All draw state lives in `scene`-scoped vars
  // assigned in create() and read in update(); movement/physics above stay the source of truth.
  // ============================================================================================

  // One rendered avatar (self or remote): a container with a shadow, a person sprite, a car sprite
  // and a name label. We toggle person/car visibility by whether they're driving.
  interface Av {
    c: Phaser.GameObjects.Container;
    person: Phaser.GameObjects.Image;
    car: Phaser.GameObjects.Container;
    carBody: Phaser.GameObjects.Image;
    carRoof: Phaser.GameObjects.Image;
    label: Phaser.GameObjects.Text;
    // smoothed render position for remote avatars (we lerp toward the broadcast)
    rx: number; ry: number; ra: number;
  }
  const remote = new Map<string, Av>();
  let self: Av | null = null;
  const swayers: Phaser.GameObjects.Image[] = []; // trees/pines that gently sway in update()

  const NAME_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#ffffff',
    stroke: '#0b1020', strokeThickness: 4, resolution: 2,
  };

  function makeTextures(scene: Phaser.Scene) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const px = (x: number, y: number, w: number, h: number, color: number, a = 1) => {
      g.fillStyle(color, a); g.fillRect(x, y, w, h);
    };

    // Ground tiles + scenery now come from the Kenney "Tiny Town" sheet (loaded in preload). What's
    // left here is the bits Kenney doesn't provide: the tsong-ball avatar, the cars, the themed
    // fountain, and shadows.

    // --- fountain: stone basin + animated water (two frames, 24×24 texels) ---
    const STONEC = 0xb8b2a4, STONEC_D = 0x938d80, WTR = 0x4a93d6, WTR_L = 0x8fc6ee;
    for (let f = 0; f < 2; f++) {
      g.clear();
      px(2, 14, 20, 8, STONEC_D); px(3, 12, 18, 9, STONEC);     // basin
      px(5, 13, 14, 6, WTR); px(6, 13, 12, 2, WTR_L);            // water pool
      px(10, 4, 4, 11, STONEC); px(11, 4, 2, 11, STONEC_D);     // central pillar
      // spray plume — alternates between frames for a little shimmer
      if (f === 0) { px(10, 1, 4, 3, WTR_L); px(8, 3, 2, 2, WTR_L); px(14, 3, 2, 2, WTR_L); }
      else { px(9, 0, 6, 3, WTR_L); px(7, 4, 2, 2, WTR_L); px(15, 4, 2, 2, WTR_L); }
      g.generateTexture(`w-fountain-${f}`, 24, 24);
    }

    // --- NPC townsperson: three stacked 12×16 layers (all same canvas so they align in a
    // container). 'head' is fixed skin + eyes + dark legs; 'hair' and 'body' are white so they can
    // be tinted per-NPC. Distinct little-person silhouette vs the ball-players. ---
    const SKIN = 0xf1c9a0, SKIN_D = 0xd9a87e;
    g.clear(); // head + face + legs/feet (untinted)
    px(4, 2, 5, 5, SKIN); px(4, 6, 5, 1, SKIN_D);   // head
    px(5, 4, 1, 1, 0x2a1f1a); px(7, 4, 1, 1, 0x2a1f1a); // eyes
    px(4, 13, 2, 3, 0x39424f); px(7, 13, 2, 3, 0x39424f); // legs
    px(4, 15, 2, 1, 0x222831); px(7, 15, 2, 1, 0x222831); // shoes
    g.generateTexture('w-npc-head', 12, 16);
    g.clear(); // hair cap (tint = hair color)
    px(4, 1, 5, 2, 0xffffff); px(3, 2, 1, 2, 0xffffff); px(8, 2, 1, 2, 0xffffff);
    g.generateTexture('w-npc-hair', 12, 16);
    g.clear(); // round specs across the eyes (overlay; Waldo & friends)
    px(4, 4, 2, 2, 0x20242c); px(7, 4, 2, 2, 0x20242c); px(6, 4, 1, 1, 0x20242c); // two rims + bridge
    px(5, 5, 1, 1, 0xbfe0ff); px(8, 5, 1, 1, 0xbfe0ff);                            // glint
    g.generateTexture('w-npc-glasses', 12, 16);
    g.clear(); // torso + arms (tint = shirt color)
    px(3, 7, 6, 6, 0xffffff); px(2, 8, 1, 4, 0xffffff); px(9, 8, 1, 4, 0xffffff);
    g.generateTexture('w-npc-body', 12, 16);
    g.clear(); // Waldo's red/white striped torso (baked, not tinted)
    const RED = 0xd23b3b, WHT = 0xf4f4f4;
    for (let yy = 0; yy < 6; yy++) px(3, 7 + yy, 6, 1, yy % 2 === 0 ? RED : WHT);
    px(2, 8, 1, 4, RED); px(9, 8, 1, 4, RED); // arms (solid red sleeves)
    px(3, 7, 6, 1, RED);
    g.generateTexture('w-npc-body-stripe', 12, 16);

    // --- Kevin the minion: yellow capsule, blue overalls, single goggle (12×16) ---
    const YEL = 0xfdd835, YEL_D = 0xe0bd2a, DENIM = 0x2f6fc4, DENIM_D = 0x255aa0;
    g.clear();
    px(3, 2, 6, 12, YEL); px(2, 4, 8, 9, YEL); px(3, 13, 6, 1, YEL_D); // body
    px(2, 9, 1, 3, YEL); px(9, 9, 1, 3, YEL);                          // arms
    px(3, 11, 6, 4, DENIM); px(3, 14, 6, 1, DENIM_D);                  // overalls
    px(4, 9, 1, 3, DENIM); px(7, 9, 1, 3, DENIM);                      // straps
    px(2, 6, 8, 1, 0x595959);                                          // goggle strap
    px(4, 5, 4, 3, 0xc9ccd4); px(5, 6, 2, 2, 0xffffff); px(6, 6, 1, 1, 0x1a1a1a); // goggle + eye
    px(4, 2, 1, 1, 0x111111); px(6, 1, 1, 1, 0x111111); px(8, 2, 1, 1, 0x111111); // hair tufts
    px(4, 15, 2, 1, 0x1a1a1a); px(7, 15, 2, 1, 0x1a1a1a);              // feet
    g.generateTexture('w-minion', 12, 16);

    // --- soft round shadow (12×6 texels) ---
    g.clear();
    px(2, 1, 8, 4, 0x000000, 0.28); px(1, 2, 10, 2, 0x000000, 0.28);
    g.generateTexture('w-shadow', 12, 6);

    // --- avatar: the tsong ball with eyes (tintable white body) (10×10 texels) ---
    g.clear();
    px(2, 1, 6, 8, 0xffffff); px(1, 2, 8, 6, 0xffffff); // round body
    px(3, 3, 1, 2, 0x1a1a1a); px(6, 3, 1, 2, 0x1a1a1a); // eyes (kept dark even when tinted? no — tint
    // multiplies; eyes drawn dark stay near-dark. good enough for the charm.)
    g.generateTexture('w-avatar', 10, 10);

    // --- car body + roof (tintable) — pointing +x (east), 26×14 texels ---
    g.clear();
    px(1, 4, 24, 6, 0xffffff); px(3, 2, 20, 10, 0xffffff); px(0, 5, 26, 4, 0xffffff);
    g.generateTexture('w-car-body', 26, 14);
    g.clear();
    px(8, 4, 11, 6, 0xffffff);   // cabin/roof patch (tinted with the accent color)
    px(20, 6, 4, 2, 0xffffff);   // a little nose stripe
    g.generateTexture('w-car-roof', 26, 14);

    g.destroy();
  }

  // Build a pixel building image keyed by id, sized to its footprint (in texels).
  function makeBuildingTexture(scene: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const px = (x: number, y: number, w: number, h: number, color: number, a = 1) => {
      g.fillStyle(color, a); g.fillRect(x, y, w, h);
    };
    const wall = hexToInt(b.color);
    const roof = shade(wall, 1.28);
    const dark = shade(wall, 0.62);
    const roofH = Math.round(H * 0.42);

    // body + base shadow + outline
    px(0, 0, W, H, dark);
    px(1, roofH, W - 2, H - roofH - 1, shade(wall, 0.92));
    px(2, roofH + 1, W - 4, H - roofH - 3, wall);
    // roof block with a lighter cap + eave line
    px(2, 1, W - 4, roofH, roof);
    px(2, 1, W - 4, 2, shade(wall, 1.5));
    px(1, roofH - 1, W - 2, 2, dark);

    if (b.kind === 'arena') {
      // a green pitch with a center net stripe set into the wall
      const fx = Math.round(W * 0.16), fy = roofH + Math.round(H * 0.18);
      const fw = W - fx * 2, fh = Math.round(H * 0.42);
      px(fx, fy, fw, fh, 0x2f8f43); px(fx + 1, fy + 1, fw - 2, fh - 2, 0x3fa850);
      px(Math.round(W / 2), fy, 1, fh, 0xffffff);
      // light towers
      px(3, 0, 2, 4, 0xdfe6f0); px(W - 5, 0, 2, 4, 0xdfe6f0);
    } else if (b.kind === 'casino') {
      // marquee bulbs + a 777 panel
      for (let x = 4; x < W - 4; x += 5) px(x, 2, 2, 2, 0xffe14d);
      const pw = Math.round(W * 0.4), pxx = Math.round((W - pw) / 2), pyy = roofH + 4;
      px(pxx, pyy, pw, Math.round(H * 0.28), 0x1a1020);
      px(pxx + 2, pyy + 2, pw - 4, Math.round(H * 0.28) - 4, 0xffd23f);
    } else if (b.kind === 'bank') {
      // marble columns + pediment
      const colTop = roofH + 2, colH = H - roofH - 6;
      for (let x = 4; x < W - 4; x += 6) px(x, colTop, 3, colH, 0xeef0e8);
      px(2, roofH - 3, W - 4, 4, shade(wall, 1.1));
    }
    // door (bottom center)
    const dw = Math.max(4, Math.round(W * 0.12)), dh = Math.round(H * 0.22);
    px(Math.round((W - dw) / 2), H - dh - 1, dw, dh, 0x241a12);
    px(Math.round((W - dw) / 2), H - dh - 1, dw, 2, 0x000000);

    const key = `w-bldg-${b.id}`;
    g.generateTexture(key, W, H);
    g.destroy();
    return key;
  }

  // --- the Phaser scene ---
  let game: Phaser.Game | null = null;

  const scene = {
    preload(this: Phaser.Scene) {
      // The Kenney "Tiny Town" sheet, served from client/public. Loaded both as a tilemap tileset
      // (for the ground layer) and as a 16×16 spritesheet (for scenery frames).
      this.load.image('townTiles', '/tiles/tiny-town.png');
      this.load.spritesheet('townFrames', '/tiles/tiny-town.png', { frameWidth: 16, frameHeight: 16 });
    },

    create(this: Phaser.Scene) {
      const sc = this;
      makeTextures(sc);

      sc.cameras.main.setBounds(0, 0, WORLD.w, WORLD.h);
      sc.cameras.main.setZoom(ZOOM);
      sc.cameras.main.setBackgroundColor(0x3f7a3a);

      // --- ground tilemap: grass + grass-bordered dirt (roads + plaza), from Kenney tiles ---
      const COLS = Math.ceil(WORLD.w / TILE), ROWS = Math.ceil(WORLD.h / TILE);
      const map = sc.make.tilemap({ tileWidth: 16, tileHeight: 16, width: COLS, height: ROWS });
      const ts = map.addTilesetImage('townTiles', 'townTiles', 16, 16, 0, 0)!;
      const layer = map.createBlankLayer('ground', ts, 0, 0)!;
      layer.setScale(TILE / 16).setDepth(-1000); // 16px tile → TILE world units
      const bareCell = (c: number, r: number) => isBare(c * TILE + TILE / 2, r * TILE + TILE / 2);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        let idx: number;
        if (bareCell(c, r)) {
          // 3×3 autotile: pick the frame whose grass border matches the grass neighbours.
          const col = !bareCell(c - 1, r) ? 0 : !bareCell(c + 1, r) ? 2 : 1;
          const row = !bareCell(c, r - 1) ? 0 : !bareCell(c, r + 1) ? 2 : 1;
          idx = TT.dirt[row * 3 + col];
        } else {
          const h = hash(c, r); // mostly plain/textured grass, occasional flower tile
          idx = h > 0.93 ? TT.grass[2] : h > 0.5 ? TT.grass[1] : TT.grass[0];
        }
        layer.putTileAt(idx, c, r);
      }

      // --- pixel fountain at the plaza center (animated water shimmer) ---
      const fountain = sc.add.image(PLAZA.x, PLAZA.y, 'w-fountain-0').setScale(TEXEL * 1.6).setDepth(PLAZA.y);
      sc.time.addEvent({
        delay: 320, loop: true,
        callback: () => fountain.setTexture(fountain.texture.key === 'w-fountain-0' ? 'w-fountain-1' : 'w-fountain-0'),
      });

      // --- scenery (Kenney frames, placed once; depth-sorted by y so you walk "behind" them) ---
      const frameFor = (d: Decor): number => {
        switch (d.type) {
          case 'tree': return TT.trees[Math.floor(hash(d.x | 0, d.y | 0) * TT.trees.length)];
          case 'pine': return TT.pines[Math.floor(hash(d.y | 0, d.x | 0) * TT.pines.length)];
          case 'bush': return TT.bush;
          case 'shrub': return TT.sapling;
          case 'flower': return TT.mushroom;
        }
      };
      const tallType = (t: DecorType) => t === 'tree' || t === 'pine';
      for (const d of DECOR) {
        const tall = tallType(d.type);
        const boost = tall ? 1.7 : d.type === 'bush' ? 1.15 : 1;
        if (tall || d.type === 'bush') {
          sc.add.image(d.x + 3, d.y + 1, 'w-shadow')
            .setScale(TEXEL * d.s * (tall ? 1.5 : 1)).setOrigin(0.5, 0.4).setDepth(d.y - 1).setAlpha(0.45);
        }
        const img = sc.add.image(d.x, d.y, 'townFrames', frameFor(d)).setScale(TEXEL * d.s * boost);
        img.setOrigin(0.5, 0.92).setDepth(d.y);
        if (tall) swayers.push(img); // pivots near the trunk → canopy sways, trunk stays
      }

      // --- bush hedge ring hugging the plaza ---
      for (const p of HEDGE_RING) {
        sc.add.image(p.x, p.y, 'townFrames', TT.bush).setScale(TEXEL * 1.1).setOrigin(0.5, 0.92).setDepth(p.y);
      }

      // --- buildings + name signs ---
      for (const b of WORLD_BUILDINGS) {
        const key = makeBuildingTexture(sc, b);
        // ground shadow cast down-right
        sc.add.rectangle(b.x + 14, b.y + 18, b.w, b.h, 0x0a1226, 0.32)
          .setOrigin(0, 0).setDepth(b.y + b.h - 1);
        sc.add.image(b.x, b.y, key).setOrigin(0, 0).setScale(TEXEL).setDepth(b.y + b.h);
        const sign = sc.add.text(b.x + b.w / 2, b.y - 6, b.name, {
          fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
          color: '#ffffff', stroke: '#0b1020', strokeThickness: 5, resolution: 2,
        });
        sign.setOrigin(0.5, 1).setDepth(100000);
      }

      // --- townsfolk ---
      for (const def of NPCS) npcs.push(makeNpc(sc, def));

      // --- our own avatar ---
      self = makeAvatar(sc, net.name() || 'you', net.color());
      sc.cameras.main.startFollow(self.c, true, 0.18, 0.18);
      sc.cameras.main.roundPixels = true;
    },

    update(this: Phaser.Scene, time: number, delta: number) {
      const sc = this;
      const now = performance.now();
      const dt = Math.min(delta / 1000, 0.05);
      if (helpFlash && now >= helpFlashUntil) { helpFlash = ''; updateHelp(); }

      // gentle breeze: each tree sways on its own phase (cheap, ~150 rotations/frame)
      for (const t of swayers) t.rotation = Math.sin(time / 700 + t.x * 0.012) * 0.035;

      if (!dialogOpen && !talkOpen) {
        const car = driving ? myCar() : null;
        if (car) stepCar(car, dt);
        else stepFoot(dt);
      }

      updateNpcs(now, dt);
      updateNearBuilding();
      maybeSendMove(now);

      // place our avatar straight from authoritative state (zero latency)
      if (self) placeAvatar(self, selfX, selfY, facing, driving, net.color(), net.name() || 'you');

      // reconcile + lerp remote avatars
      const seen = new Set<string>();
      const selfId = net.selfId();
      for (const a of others) {
        if (a.id === selfId) continue;
        seen.add(a.id);
        let av = remote.get(a.id);
        if (!av) { av = makeAvatar(sc, a.name, a.color); av.rx = a.x; av.ry = a.y; av.ra = a.a ?? 0; remote.set(a.id, av); }
        // smooth toward the latest broadcast
        av.rx += (a.x - av.rx) * Math.min(1, dt * 12);
        av.ry += (a.y - av.ry) * Math.min(1, dt * 12);
        const ta = a.a ?? av.ra;
        av.ra += angDelta(av.ra, ta) * Math.min(1, dt * 12);
        placeAvatar(av, av.rx, av.ry, av.ra, !!a.car, a.color, a.name);
      }
      // drop avatars that left
      for (const [id, av] of remote) if (!seen.has(id)) { av.c.destroy(); remote.delete(id); }
    },
  };

  function angDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function makeAvatar(sc: Phaser.Scene, name: string, color: string): Av {
    const tint = hexToInt(color);
    const shadow = sc.add.image(0, R * 0.7, 'w-shadow').setScale(TEXEL);
    const person = sc.add.image(0, 0, 'w-avatar').setScale(TEXEL).setOrigin(0.5, 0.7).setTint(tint);
    const carBody = sc.add.image(0, 0, 'w-car-body').setScale(TEXEL);
    const carRoof = sc.add.image(0, 0, 'w-car-roof').setScale(TEXEL);
    const car = sc.add.container(0, 0, [carBody, carRoof]).setVisible(false);
    const label = sc.add.text(0, -R - 14, name, NAME_STYLE).setOrigin(0.5, 1);
    const c = sc.add.container(selfX, selfY, [shadow, car, person, label]);
    return { c, person, car, carBody, carRoof, label, rx: selfX, ry: selfY, ra: 0 };
  }

  function placeAvatar(av: Av, x: number, y: number, a: number, drivingNow: boolean, color: string, name: string) {
    av.c.setPosition(x, y).setDepth(y);
    if (av.label.text !== name) av.label.setText(name);
    const tint = hexToInt(color);
    av.person.setVisible(!drivingNow).setTint(tint);
    av.car.setVisible(drivingNow);
    if (drivingNow) {
      av.car.setRotation(a);
      const spec = carById((others.find((o) => o.name === name)?.car) ?? net.car());
      av.carBody.setTint(spec ? hexToInt(spec.body) : tint);
      av.carRoof.setTint(spec ? hexToInt(spec.accent) : 0xffffff);
    }
  }

  // --- townsfolk: build sprite + per-frame wander ---
  function makeNpc(sc: Phaser.Scene, def: NpcDef): LiveNpc {
    const shadow = sc.add.image(0, -1, 'w-shadow').setScale(TEXEL * 1.05).setAlpha(0.4);
    let parts: Phaser.GameObjects.Image[];
    if (def.kind === 'minion') {
      parts = [sc.add.image(0, 0, 'w-minion').setScale(TEXEL * 1.15).setOrigin(0.5, 0.95)];
    } else {
      const bodyKey = def.stripes ? 'w-npc-body-stripe' : 'w-npc-body';
      const body = sc.add.image(0, 0, bodyKey).setScale(TEXEL).setOrigin(0.5, 0.95);
      if (!def.stripes) body.setTint(def.shirt);
      const head = sc.add.image(0, 0, 'w-npc-head').setScale(TEXEL).setOrigin(0.5, 0.95);
      const hair = sc.add.image(0, 0, 'w-npc-hair').setScale(TEXEL).setOrigin(0.5, 0.95).setTint(def.hair);
      parts = [body, head, hair];
      if (def.glasses) parts.push(sc.add.image(0, 0, 'w-npc-glasses').setScale(TEXEL).setOrigin(0.5, 0.95));
    }
    const bob = sc.add.container(0, 0, parts);
    const label = sc.add.text(0, -R - 26, def.name, NAME_STYLE).setOrigin(0.5, 1);
    const c = sc.add.container(def.x, def.y, [shadow, bob, label]);
    return { def, x: def.x, y: def.y, tx: def.x, ty: def.y, pauseUntil: 0, faceLeft: false, walking: false, lineIdx: 0, c, bob };
  }

  function updateNpcs(now: number, dt: number) {
    for (const n of npcs) {
      const talking = talkOpen && nearNpc === n;
      if (!talking && now >= n.pauseUntil) {
        const dx = n.tx - n.x, dy = n.ty - n.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 6) {
          n.walking = false;
          n.pauseUntil = now + 700 + Math.random() * 2400;       // loiter, then pick a new spot
          const a = Math.random() * Math.PI * 2, r = Math.random() * n.def.roam;
          n.tx = n.def.x + Math.cos(a) * r; n.ty = n.def.y + Math.sin(a) * r;
        } else {
          n.walking = true;
          const sp = 64; // gentle stroll
          const m = resolveCollisions(n.x + (dx / dist) * sp * dt, n.y + (dy / dist) * sp * dt, R * 0.7);
          if (m.hit) { n.pauseUntil = now + 400; n.tx = n.def.x; n.ty = n.def.y; }
          n.x = m.x; n.y = m.y;
          n.faceLeft = dx < 0;
        }
      } else if (talking) {
        n.walking = false;
      }
      n.c.setPosition(n.x, n.y).setDepth(n.y);
      n.bob.scaleX = n.faceLeft ? -1 : 1;
      n.bob.y = n.walking ? Math.sin(now / 110) * 1.4 - 1 : 0; // little walk bob
    }
  }

  // --- launch Phaser ---
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: gameHost,
    backgroundColor: '#3f7a3a',
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    scene: { preload: scene.preload, create: scene.create, update: scene.update },
    banner: false,
    audio: { noAudio: true },
  });

  function exit() {
    if (!controller) return;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    overlay.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    game?.destroy(true);
    game = null;
    try { void actx?.close(); } catch { /* ignore */ }
    actx = null;
    overlay.remove();
    controller = null;
    net.leave();
    net.onExit();
  }

  controller = {
    feed(avatars) {
      others = avatars;
      const n = avatars.length;
      count.textContent = n === 1 ? '1 player here' : `${n} players here`;
    },
    reenter() { net.enter(); },
  };
  syncDriveBtn();
  net.enter();
}
