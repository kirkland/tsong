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

// Namespace import (not default): Phaser's real ESM build (the CDN one used in prod via the
// index.html import map) exports only NAMED members and has NO default export. `import Phaser
// from 'phaser'` only worked in dev because Vite synthesises a default; in prod the browser loads
// the real ESM, finds no default, and the World chunk fails to instantiate (button does nothing).
import * as Phaser from 'phaser';
import {
  WORLD,
  WORLD_AVATAR,
  WORLD_BUILDINGS,
  WorldAvatar,
  WorldBuilding,
  WorldBuildingKind,
  CarSpec,
  carById,
  petById,
  type PetKind,
  NETIZEN_DIALOGUE,
  STOCKS,
} from '../shared/types';

// What the world needs from the rest of the app. main.ts supplies these (see startWorld call).
export interface WorldNet {
  enter(): void;                 // tell the server we're now in the world
  leave(): void;                 // tell the server we've left
  move(x: number, y: number, a?: number, car?: string | null, pet?: string | null): void; // stream our state
  name(): string;                // our nickname (for our own label)
  color(): string;               // our avatar color
  selfId(): string;              // our connection id (to skip our own avatar in the broadcast)
  car(): string | null;          // our equipped car id (null = none → can't drive)
  pet(): string | null;          // our equipped pet id (null = none → nothing trails us)
  onExit(): void;                // the overlay closed (lets main.ts reset the toggle button)
  enterArena(): void;            // walk into the Arena → return to Pong + join the queue
  openFeature(feature: 'roulette' | 'blackjack' | 'craps' | 'crash' | 'slots' | 'stocks' | 'loans' | 'petshop' | 'doom' | 'fishing'): void; // open a Casino/Bank/Pet-Shop/DOOM/Fishing feature
  claimQuest(quest: string): void; // tell the server to grant a World objective reward (once)
  onNetizenClick?(netizenId: string): void; // user tapped a netizen avatar in the world (→ challenge)
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  reenter(): void; // re-send worldEnter after a socket reconnect (server forgot us on drop)
}
let controller: Controller | null = null;
let _exitWorld: (() => void) | null = null;

export function isWorldOpen(): boolean {
  return controller !== null;
}

/** Tear down the world overlay if it's open. No-op if already closed. */
export function exitWorld(): void {
  _exitWorld?.();
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
  { x: 2475, y: 600, w: 110, h: 600 },  // spur up to the Pet shack (NE), clearing the pond to its west
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

// --- Day/night cycle + weather (all clients agree by deriving purely from the wall clock) ---
const HOUR_MS = 3_600_000;
// A full day→night→day loop takes 8 real hours, so it's "day" for ~4h then "night" for ~4h:
// the world flips between bright and dark every 4 hours, smoothly through dawn/dusk.
const DAYNIGHT_CYCLE_MS = 8 * HOUR_MS;

// 0 = full daylight … 1 = deepest night, as a smooth cosine over the cycle.
function nightFactor(nowMs: number): number {
  const t = (nowMs % DAYNIGHT_CYCLE_MS) / DAYNIGHT_CYCLE_MS; // 0..1 across the 8h loop
  return (1 - Math.cos(t * Math.PI * 2)) / 2;                // bright at t=0/1, darkest at t=0.5 (4h in)
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
interface NpcChoice { label: string; reply: string; claim?: string } // claim → completes an objective
type HairStyle = 'short' | 'long' | 'bun' | 'spiky' | 'pony' | 'bald';
interface NpcDef {
  id: string;
  name: string;
  shirt: number;        // shirt/dress tint (ignored for the minion)
  hair: number;         // hair tint
  skin?: number;        // skin tone tint (default a mid tone)
  hairStyle?: HairStyle;// default 'short'
  body?: 'pants' | 'dress'; // silhouette, default 'pants'
  hat?: 'cap' | 'sun';  // optional headwear
  hatColor?: number;    // cap tint (sun hat is fixed straw)
  kind?: 'minion' | 'kenny' | 'demon' | 'soul' | 'angler' | 'protester'; // special one-off sprite; default is the little-person
  glasses?: boolean;    // overlay specs
  stripes?: boolean;    // red/white striped shirt instead of a flat tinted one (Waldo!)
  x: number; y: number; // home anchor (NPC roams around this)
  roam: number;         // wander radius, world units
  lines: string[];      // flavour one-liners, cycled each chat
  ask?: { q: string; choices: [NpcChoice, NpcChoice] }; // optional: a question you can answer
}
// Skin-tone palette to spread across the cast.
const SKINS = [0xf6d3b0, 0xeebb91, 0xd29b6e, 0xb87a4f, 0x8d5a34] as const;
const NPCS: NpcDef[] = [
  {
    id: 'pip', name: 'Pip', shirt: 0xe05a6d, hair: 0x4a2f1a, skin: SKINS[0], hairStyle: 'spiky',
    x: 1470, y: 1170, roam: 120,
    lines: [
      'I walked around the fountain. Twice!',
      'Did you know the ball has eyes? It watches you sleep.',
      'When I grow up I wanna be a ball too.',
    ],
  },
  {
    id: 'vito', name: 'Coach Vito', shirt: 0x3a78c2, hair: 0x2a2a2a, skin: SKINS[3],
    hat: 'cap', hatColor: 0x14306a, x: 1710, y: 720, roam: 90,
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
    id: 'lou', name: 'Lucky Lou', shirt: 0x2faf6a, hair: 0x6b4a1f, skin: SKINS[2], hairStyle: 'bald',
    x: 770, y: 1380, roam: 110,
    lines: [
      "I'm up BIG. Don't tell my wife.",
      'The house always wins. But not today. ...Probably today.',
      'You ever put your whole wallet on black? Character-building.',
    ],
  },
  {
    id: 'edna', name: 'Banker Edna', shirt: 0x8a5cf6, hair: 0x9a9aa8, skin: SKINS[1],
    body: 'dress', hairStyle: 'bun', glasses: true, x: 2430, y: 1380, roam: 90,
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
    id: 'drift', name: 'Drift', shirt: 0xff8a3d, hair: 0x1f1f1f, skin: SKINS[2], hairStyle: 'spiky',
    glasses: true, x: 1150, y: 1255, roam: 130,
    lines: [
      'Nice car. Mine corners better, though.',
      'I drifted the whole plaza once. No witnesses, but it happened.',
      'Grip is for cowards. ...My insurance disagrees.',
    ],
  },
  {
    id: 'mush', name: 'Mush', shirt: 0xc24a8a, hair: 0x3a6b2f, skin: SKINS[1], hairStyle: 'long',
    x: 2120, y: 820, roam: 120,
    lines: [
      "Don't eat the red mushrooms. ...Or do. I'm not your dad.",
      'I talk to the trees. They sway back. We have an understanding.',
    ],
  },
  // --- the women of tsong ---
  {
    id: 'rosa', name: 'Rosa', shirt: 0xff8fb3, hair: 0x5a3416, skin: SKINS[2],
    body: 'dress', hairStyle: 'long', hat: 'sun', x: 880, y: 760, roam: 130,
    lines: [
      'I planted every flower you see. You\'re welcome.',
      'A little water, a little sun, a lot of yelling at the weeds.',
      'If you pick a flower I WILL know.',
    ],
  },
  {
    id: 'mei', name: 'Mei', shirt: 0x46c2b0, hair: 0x161616, skin: SKINS[1],
    body: 'dress', hairStyle: 'bun', x: 2380, y: 980, roam: 110,
    lines: [
      'I beat the casino once. Spent it all on shoes. No regrets.',
      'Wanna race? ...No? Coward.',
    ],
    ask: {
      q: 'Heads or tails — call it.',
      choices: [
        { label: 'Heads', reply: 'Tails. Ha! ...Best of one, I always say.' },
        { label: 'Tails', reply: 'Heads! The house — I mean, *I* — always win.' },
      ],
    },
  },
  {
    id: 'gwen', name: 'Gwen', shirt: 0x9b6cff, hair: 0xc9a23a, skin: SKINS[0],
    body: 'dress', hairStyle: 'pony', glasses: true, x: 1380, y: 1520, roam: 120,
    lines: [
      'I read every changelog. Yes, ALL of them. Someone has to.',
      'There\'s a hidden mode, you know. I won\'t say where. ...Octagon.',
      'Beta this, beta that. When does it become a gamma?',
      'That tortured soul sure is irritating!',
    ],
  },
  {
    id: 'opal', name: 'Granny Opal', shirt: 0x7a8cc0, hair: 0xdedede, skin: SKINS[4],
    body: 'dress', hairStyle: 'bun', glasses: true, x: 2000, y: 1500, roam: 70,
    lines: [
      'Back in MY day we had ONE paddle and we were grateful.',
      'You kids and your "drift physics." In my day we just crashed.',
      'Come closer, dear. ...No, too close. There.',
    ],
  },
  {
    id: 'waldo', name: 'Waldo', shirt: 0xd23b3b, hair: 0x3a2a1a, glasses: true, stripes: true,
    hat: 'cap', hatColor: 0xd23b3b, x: 470, y: 470, roam: 150, // far NW corner — properly hard to find
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
    id: 'burt', name: 'Burt', shirt: 0x2e8b8b, hair: 0xb9bcc4, skin: SKINS[1], glasses: true,
    x: 1600, y: 1235, roam: 34,
    lines: [
      "Don't you have to get back to work?",
      "Aren't you on Ops-Task Rotation this week?",
      'Those Tech Services guys sure like to slack off!',
    ],
  },
  {
    id: 'kenny', name: 'Kenny', shirt: 0x2bbfae, hair: 0x171717, kind: 'kenny', x: 1500, y: 720, roam: 70,
    lines: [
      'Strike zone? Never met her.',
      'Wheels just mean a lower center of gravity. Pure science. Pure offense.',
      'Put me on the mound in the 9th. I close it out. Every time.',
    ],
    ask: {
      q: 'Pickin\' teams — am I your first overall?',
      choices: [
        { label: 'First pick', reply: 'Smart. I don\'t lose. Grab a glove.' },
        { label: 'Maybe later', reply: 'Your funeral. Enjoy the L from the dugout.' },
      ],
    },
  },
  {
    // The doorman of the damned: a little imp pacing in front of the hellgate, north of the portal.
    id: 'imp', name: 'Imp', shirt: 0xc0271f, hair: 0x8a160f, kind: 'demon', x: 1600, y: 1320, roam: 110,
    lines: [
      'Your soul looks delicious.',
      'Rip and tear, friend.',
      "It's warm down there. Come see.",
      'I get paid in screams.',
      'Step through… I dare you.',
      'Hell has great Wi-Fi.',
      "I'm not the worst thing through that gate.",
    ],
  },
  {
    // A damned soul clawing at the edge of the hellgate, opposite the imp — begging passers-by.
    id: 'tortured-soul', name: 'Tortured Soul', shirt: 0xc8d0d8, hair: 0x9aa4b0, kind: 'soul',
    x: 1460, y: 1480, roam: 90,
    lines: [
      'Please… help me.',
      'It burns… it burns…',
      'Get me out of here.',
      "Why won't anyone listen?",
      'I was just like you once.',
      "Don't go through the gate… please.",
      'So cold. So hot. Both. Always.',
      'Has it been a thousand years yet?',
    ],
  },
  {
    // Planted on the fishing pond's pier, rod permanently in the water. Does NOT want to chat.
    id: 'grumpy-angler', name: 'Andy', shirt: 0x3f6f4a, hair: 0x6a5235, kind: 'angler',
    x: 2000, y: 990, roam: 0,
    lines: [
      "Fuck off, I'm fishing.",
      "...I'm fishing. Go away.",
      "You're scaring the fish. Beat it.",
    ],
  },
  {
    // Picketing the east edge of the central plaza, sign held high, perpetually mid-chant.
    id: 'protester', name: 'Protester', shirt: 0xc0392b, hair: 0x33271a, kind: 'protester',
    x: 1820, y: 1090, roam: 36,
    lines: [
      'TAX THE RICH!',
      'Lasso has gone too far!',
      'Boam has too much money!',
      'Whose coins? OUR coins!',
      'Redistribute the treasury!',
      'No kings in the arena!',
      'Eat the rich… ball!',
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
        { label: '🍌 Banana!', reply: 'BANANAAAAAA! *happy minion noises*', claim: 'give-banana' },
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
  let nearNetizen: string | null = null; // netizen id within talking range
  let talkNetizenId: string | null = null; // netizen id currently in conversation (frozen)
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

  // (Atmosphere — the warm sun tint + vignette — is rendered on the GPU inside the Phaser scene
  // now, not as DOM blend layers. That keeps it fast and consistent across Chromium/Firefox/Safari
  // instead of each engine compositing a soft-light DOM layer over the WebGL canvas differently.)

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

  // Weekly objectives panel (top-left, under the title).
  const objPanel = document.createElement('div');
  objPanel.style.cssText =
    'position:absolute;top:46px;left:14px;z-index:2;min-width:188px;background:#0c1330d9;' +
    'border:1px solid #2c3a63;border-radius:10px;padding:9px 12px 10px;box-shadow:0 6px 20px #0006;pointer-events:none;';
  const objTitle = document.createElement('div');
  objTitle.textContent = '📋 Weekly Objectives';
  objTitle.style.cssText = 'color:#cfe0ff;font-size:12px;font-weight:700;letter-spacing:.4px;margin-bottom:6px;opacity:.85;';
  const objList = document.createElement('div');
  objPanel.append(objTitle, objList);
  overlay.appendChild(objPanel);

  // Objective-complete toast (slides in top-center).
  const toast = document.createElement('div');
  toast.style.cssText =
    'position:absolute;top:-80px;left:50%;transform:translateX(-50%);z-index:5;pointer-events:none;' +
    'background:linear-gradient(#1b2b14,#10210c);border:2px solid #6bd06b;border-radius:12px;' +
    'padding:12px 20px;color:#eafbe6;font-weight:700;box-shadow:0 10px 30px #000a;text-align:center;' +
    'transition:top .45s cubic-bezier(.2,1.3,.4,1);';
  overlay.appendChild(toast);

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
      case 'petshop': return '🐾 Enter the Pet Shop';
      case 'doomportal': return '🔥 Enter the gates of DOOM';
      case 'pond': return '🎣 Cast a line';
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
    if (kind === 'petshop') {
      // The Pet Shop just opens the Shop panel on the Pets tab — a single choice keeps it tidy.
      openDialog('🐾 Pet Shop', 'Looking for a little companion?', [
        { label: '🐾 Browse Pets', onPick: () => { exit(); net.openFeature('petshop'); } },
      ]);
      return;
    }
    if (kind === 'doomportal') {
      openDialog('🔥 The Gates of DOOM', 'A hot wind howls up from below…', [
        { label: '🔥 Descend', onPick: () => { exit(); net.openFeature('doom'); } },
      ]);
      return;
    }
    if (kind === 'pond') {
      openDialog('🎣 Fishing Pond', 'The water is calm. A good day for fishing.', [
        { label: '🎣 Fish', onPick: () => { exit(); net.openFeature('fishing'); } },
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

  // --- weekly objectives (top-left panel + reward toast) ---
  // `progress` (optional) returns "[done, total]" for objectives that count toward a goal (e.g.
  // winning 10 games) so the panel can show "(7/10)".
  interface Objective { id: string; label: string; reward: number; done: boolean; progress?: () => [number, number] }
  const PONG_WINS_KEY = 'tsong.world.pongWins'; // bumped by main.ts on each match win
  const pongWins = () => { try { return parseInt(localStorage.getItem(PONG_WINS_KEY) || '0', 10) || 0; } catch { return 0; } };
  const objectives: Objective[] = [
    { id: 'find-waldo', label: 'Find Waldo', reward: 400, done: false },
    { id: 'give-banana', label: 'Give Kevin a banana', reward: 400, done: false },
    { id: 'win-ten', label: 'Win 10 tsong games', reward: 1000, done: false, progress: () => [Math.min(pongWins(), 10), 10] },
  ];
  const questKey = (id: string) => `tsong.world.quest.${id}`;
  for (const o of objectives) { try { o.done = localStorage.getItem(questKey(o.id)) === '1'; } catch { /* ignore */ } }
  const chaching = new Audio('/chaching.mp3'); chaching.volume = 0.7;
  function renderObjectives() {
    objList.replaceChildren();
    for (const o of objectives) {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:8px;font-size:13px;margin:3px 0;color:${o.done ? '#8fe08f' : '#dbe4f7'};`;
      const box = document.createElement('span');
      box.textContent = o.done ? '☑' : '☐';
      box.style.cssText = `font-size:15px;color:${o.done ? '#6bd06b' : '#9fb0d8'};`;
      const lab = document.createElement('span');
      const prog = !o.done && o.progress ? ` (${o.progress()[0]}/${o.progress()[1]})` : '';
      lab.textContent = o.label + prog;
      if (o.done) lab.style.textDecoration = 'line-through';
      const rew = document.createElement('span');
      rew.textContent = `+${o.reward}🪙`;
      rew.style.cssText = 'margin-left:auto;font-size:11px;opacity:.7;';
      row.append(box, lab, rew);
      objList.appendChild(row);
    }
  }
  // Auto-complete any progress objective whose goal is already met (e.g. you hit 10 wins, then
  // wandered back into town). Called on open.
  function checkProgressObjectives() {
    for (const o of objectives) {
      if (!o.done && o.progress) { const [d, t] = o.progress(); if (d >= t) completeObjective(o.id); }
    }
  }
  let toastTimer = 0;
  function showToast(html: string) {
    toast.innerHTML = html;
    toast.style.top = '64px';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.style.top = '-90px'; }, 3400);
  }
  function completeObjective(id: string) {
    const o = objectives.find((x) => x.id === id);
    if (!o || o.done) return;
    o.done = true;
    try { localStorage.setItem(questKey(id), '1'); } catch { /* ignore */ }
    renderObjectives();
    net.claimQuest(id);                                   // server grants the coins (once)
    try { chaching.currentTime = 0; void chaching.play(); } catch { /* ignore */ }
    showToast(`✅ Objective complete!<br><b>${o.label}</b> &nbsp;<span style="color:#ffe14d">+${o.reward} 🪙</span>`);
  }
  renderObjectives();
  checkProgressObjectives(); // claim "win 10 games" if you finished it before coming back to town

  // --- NPC dialogue (Pokémon-style bottom box: typewriter line(s), then optional reply choices) ---
  function startTalk(n: LiveNpc) {
    if (talkOpen || dialogOpen) return;
    talkOpen = true;
    keys.clear(); joyActive = false;
    prompt.style.display = 'none';
    n.faceLeft = selfX < n.x; // turn to face the player
    if (n.def.id === 'waldo') completeObjective('find-waldo'); // found him!

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
          if (ch.claim) completeObjective(ch.claim); // e.g. actually giving Kevin a banana
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
    if (nearNetizen) {
      const a = others.find((o) => o.id === nearNetizen);
      if (!a) return;
      startNetizenTalk(a);
      return;
    }
    if (nearNpc) { startTalk(nearNpc); return; }
    const b = WORLD_BUILDINGS.find((x) => x.id === nearId);
    if (b) enterBuilding(b.kind);
  }

  /** Start a simple dialogue with a netizen: flavor text, then challenge option. */
  function startNetizenTalk(a: WorldAvatar) {
    if (talkOpen || dialogOpen) return;
    talkOpen = true;
    talkNetizenId = a.id;
    keys.clear(); joyActive = false;
    prompt.style.display = 'none';

    const flavor = NETIZEN_DIALOGUE.idleBanter[Math.floor(Math.random() * NETIZEN_DIALOGUE.idleBanter.length)]
      .replace('{ticker}', STOCKS[Math.floor(Math.random() * STOCKS.length)].ticker);

    npcName.textContent = a.name;
    npcBox.style.display = 'block';

    let pageI = 0;
    let typing = false;
    let timer = 0;
    let full = '';

    const showChoices = () => {
      npcHint.style.display = 'none';
      npcChoices.style.display = 'flex';
      npcChoices.replaceChildren();
      const challengeBtn = document.createElement('button');
      challengeBtn.type = 'button';
      challengeBtn.textContent = '⚔️ Challenge to a duel!';
      challengeBtn.style.cssText =
        'flex:1;cursor:pointer;background:#2a4a20;color:#e8eefc;border:2px solid #4a8a40;' +
        'border-radius:10px;padding:11px;font-size:15px;font-weight:700;font-family:ui-monospace,monospace;';
      challengeBtn.onmouseenter = () => { challengeBtn.style.background = '#3a5a30'; };
      challengeBtn.onmouseleave = () => { challengeBtn.style.background = '#2a4a20'; };
      challengeBtn.onclick = () => {
        try {
          selectBlip();
          const nid = nearNetizen || a.id;
          closeNetizenTalk();
          if (nid) net.onNetizenClick?.(nid);
        } catch {
          closeNetizenTalk();
        }
      };
      const passBtn = document.createElement('button');
      passBtn.type = 'button';
      passBtn.textContent = '👋 Not right now';
      passBtn.style.cssText =
        'flex:1;cursor:pointer;background:#21305a;color:#e8eefc;border:2px solid #4a64a0;' +
        'border-radius:10px;padding:11px;font-size:15px;font-weight:700;font-family:ui-monospace,monospace;';
      passBtn.onmouseenter = () => { passBtn.style.background = '#2c4079'; };
      passBtn.onmouseleave = () => { passBtn.style.background = '#21305a'; };
      passBtn.onclick = () => { selectBlip(); closeNetizenTalk(); };
      npcChoices.append(challengeBtn, passBtn);
    };

    const showPage = () => {
      npcChoices.style.display = 'none';
      if (pageI === 0) {
        full = flavor;
      } else if (pageI === 1) {
        full = 'Looking for a challenge? Put your coins where your mouth is.';
        showChoices();
        return;
      } else {
        closeNetizenTalk();
        return;
      }
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
          npcHint.style.display = 'block';
        }
      }, 30);
    };

    npcAdvance = () => {
      if (typing) {
        window.clearInterval(timer);
        typing = false;
        npcText.textContent = full;
        npcHint.style.display = 'block';
        return;
      }
      pageI++;
      showPage();
    };

    npcClose = closeNetizenTalk;

    function closeNetizenTalk() {
      window.clearInterval(timer);
      talkOpen = false;
      talkNetizenId = null;
      npcAdvance = null;
      npcClose = null;
      npcBox.style.display = 'none';
      npcChoices.style.display = 'none';
    }

    showPage();
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
    // Tapped a netizen avatar? → fire the challenge hook instead of starting to walk.
    if (mainCam && net.onNetizenClick) {
      const wp = mainCam.getWorldPoint(e.clientX, e.clientY);
      for (const a of others) {
        if (!(a.bot || a.id.startsWith('netizen:'))) continue;
        if (Math.hypot(wp.x - a.x, wp.y - a.y) <= R * 2.5) { net.onNetizenClick(a.id); return; }
      }
    }
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
    nearNetizen = null;
    if (!best && !driving) {
      let bD = R + TRIGGER_PAD + 12;
      for (const n of npcs) {
        const d = Math.hypot(n.x - selfX, n.y - selfY);
        if (d < bD) { bD = d; nearNpc = n; }
      }
      // Also check for netizen avatars within range.
      for (const a of others) {
        if (!a.bot) continue;
        const d = Math.hypot(a.x - selfX, a.y - selfY);
        if (d < bD) { bD = d; nearNetizen = a.id; nearNpc = null; }
      }
    }
    if (best) {
      const b = WORLD_BUILDINGS.find((x) => x.id === best)!;
      prompt.textContent = labelFor(b.kind);
    } else if (nearNetizen) {
      const a = others.find((o) => o.id === nearNetizen);
      prompt.textContent = `💬 Talk to ${a?.name ?? 'Netizen'}`;
    } else if (nearNpc) {
      prompt.textContent = `💬 Talk to ${nearNpc.def.name}`;
    }
    prompt.style.display = (nearId || nearNpc || nearNetizen) && !dialogOpen && !talkOpen ? 'block' : 'none';
  }

  function maybeSendMove(now: number) {
    if (now - lastSentAt < 66) return; // ~15 Hz cap
    if (Math.abs(selfX - lastSentX) < 0.5 && Math.abs(selfY - lastSentY) < 0.5) return;
    lastSentX = selfX; lastSentY = selfY; lastSentAt = now;
    net.move(selfX, selfY, driving ? facing : undefined, driving ? net.car() : null, net.pet());
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
    bubble: Phaser.GameObjects.Text;  // netizen speech bubble (hidden for humans)
    bubbleNextAt: number;             // when this bot picks its next line
    // smoothed render position for remote avatars (we lerp toward the broadcast)
    rx: number; ry: number; ra: number;
  }
  const remote = new Map<string, Av>();
  let self: Av | null = null;

  // Trailing pets: one little emoji sprite per avatar that has a pet equipped. The sprite chases a
  // point ~36 world units BEHIND its owner each frame, so it reads as a companion padding along.
  // Keyed by avatar id; entries are torn down when their owner leaves or unequips. With the PETS
  // list empty this stays empty too (petById returns null) — it lights up once pets are authored.
  interface PetSprite {
    sprite: Phaser.GameObjects.Image;
    id: string;            // which pet (so we can swap the sprite if the owner re-equips)
    kind: PetKind;         // drives the look + whether it animates (pacman)
    x: number; y: number;  // smoothed world position of the pet
    lastX: number; lastY: number; // owner's last position, for a fallback "behind" direction
    chomp: number;         // pac-man chomp animation phase (seconds, looping)
  }
  const PET_TRAIL = 36; // world units the pet hangs back behind its owner
  let petScene: Phaser.Scene | null = null; // set in create(); needed to spawn pet text objects
  const petSprites = new Map<string, PetSprite>();
  const swayers: Phaser.GameObjects.Image[] = []; // trees/pines that gently sway in update()
  // Strays milling around the pet shack: each ambles to a random spot near home, pauses, repeats.
  interface Critter {
    spr: Phaser.GameObjects.Image; shadow: Phaser.GameObjects.Image;
    hx: number; hy: number; tx: number; ty: number; spd: number; pause: number;
  }
  const critters: Critter[] = [];
  // Day/night overlays (camera-fixed, set in create(), animated in update()).
  let nightOverlay: Phaser.GameObjects.Rectangle | null = null;
  let warmOverlay: Phaser.GameObjects.Rectangle | null = null;
  // DOOM-portal flame sprites: little orange/yellow tongues layered over the archway. Each carries
  // its own phase/anchor so update() can jitter alpha/scale/offset and make them dance ("on fire").
  interface Flame { img: Phaser.GameObjects.Image; bx: number; by: number; phase: number; amp: number; base: number }
  const flames: Flame[] = [];
  // Fishing-pond ripples: faint expanding rings on the water, each on its own phase, animated in
  // update() the same per-frame way the flames/swayers are.
  interface Ripple { ring: Phaser.GameObjects.Arc; cx: number; cy: number; phase: number; maxR: number }
  const ripples: Ripple[] = [];

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

    // --- NPC townsperson: stacked 12×16 layers (all on the same canvas so they align in a
    // container). Skin / hair / clothes are white so each can be TINTED per-NPC; mix-and-match of
    // skin tone + hairstyle + body (pants/dress) + hat + glasses gives lots of distinct people. ---
    g.clear(); // skin: head + neck (tint = skin tone)
    px(4, 2, 5, 5, 0xffffff); px(5, 6, 3, 1, 0xffffff);
    g.generateTexture('w-npc-skin', 12, 16);
    g.clear(); // face: eyes (fixed)
    px(5, 4, 1, 1, 0x2a1f1a); px(7, 4, 1, 1, 0x2a1f1a);
    g.generateTexture('w-npc-face', 12, 16);
    g.clear(); // legs + shoes (fixed; pants bodies)
    px(4, 13, 2, 3, 0x39424f); px(7, 13, 2, 3, 0x39424f);
    px(4, 15, 2, 1, 0x222831); px(7, 15, 2, 1, 0x222831);
    g.generateTexture('w-npc-legs', 12, 16);

    // hairstyles (all white → tint = hair color)
    const hair = (key: string, draw: () => void) => { g.clear(); draw(); g.generateTexture(key, 12, 16); };
    hair('w-hair-short', () => { px(4, 1, 5, 2, 0xffffff); px(3, 2, 1, 2, 0xffffff); px(8, 2, 1, 2, 0xffffff); });
    hair('w-hair-long', () => { px(3, 1, 6, 2, 0xffffff); px(3, 2, 1, 6, 0xffffff); px(8, 2, 1, 6, 0xffffff); });
    hair('w-hair-bun', () => { px(4, 1, 5, 2, 0xffffff); px(3, 2, 1, 2, 0xffffff); px(8, 2, 1, 2, 0xffffff); px(5, 0, 3, 1, 0xffffff); });
    hair('w-hair-spiky', () => { px(4, 1, 5, 2, 0xffffff); px(4, 0, 1, 1, 0xffffff); px(6, 0, 1, 1, 0xffffff); px(8, 0, 1, 1, 0xffffff); px(3, 2, 1, 2, 0xffffff); px(8, 2, 1, 2, 0xffffff); });
    hair('w-hair-pony', () => { px(4, 1, 5, 2, 0xffffff); px(3, 2, 1, 2, 0xffffff); px(8, 2, 1, 2, 0xffffff); px(9, 2, 1, 6, 0xffffff); });

    g.clear(); // round specs across the eyes (overlay)
    px(4, 4, 2, 2, 0x20242c); px(7, 4, 2, 2, 0x20242c); px(6, 4, 1, 1, 0x20242c);
    px(5, 5, 1, 1, 0xbfe0ff); px(8, 5, 1, 1, 0xbfe0ff);
    g.generateTexture('w-npc-glasses', 12, 16);
    g.clear(); // torso + arms (tint = shirt) — pants silhouette
    px(3, 7, 6, 6, 0xffffff); px(2, 8, 1, 4, 0xffffff); px(9, 8, 1, 4, 0xffffff);
    g.generateTexture('w-npc-body', 12, 16);
    g.clear(); // dress: bodice + flared skirt to the hem (tint = dress) — female silhouette
    px(3, 7, 6, 4, 0xffffff); px(2, 8, 1, 3, 0xffffff); px(9, 8, 1, 3, 0xffffff);
    px(3, 11, 6, 1, 0xffffff); px(2, 12, 8, 2, 0xffffff); px(1, 14, 10, 2, 0xffffff);
    g.generateTexture('w-npc-dress', 12, 16);
    g.clear(); // baseball cap (tint = hat color)
    px(3, 1, 6, 2, 0xffffff); px(2, 2, 7, 1, 0xffffff); px(2, 3, 4, 1, 0xffffff);
    g.generateTexture('w-npc-hat-cap', 12, 16);
    g.clear(); // straw sun hat (fixed)
    px(1, 3, 10, 1, 0xe2c074); px(2, 2, 8, 1, 0xead08a); px(4, 0, 4, 2, 0xd9b15f);
    g.generateTexture('w-npc-hat-sun', 12, 16);
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

    // --- Kenny: a wheelchair ballplayer (cap, glasses, bat over the shoulder). Original 16×16
    // pixel tribute. ---
    const TIRE = 0x2a2a2a, RIM = 0x9097a0, HUB = 0xcdd2da, FRAME = 0xb8bcc4;
    const JER = 0x2bbfae, JER_D = 0x1f8f83, PANTS = 0x2f4a6b, CAPC = 0xd23b3b, CAP_D = 0xa8202c;
    const SKN = 0xf1c9a0, BAT = 0xc8a05a, BAT_D = 0x9c7a36;
    g.clear();
    // wheels (big side wheels) + hubs
    const wheel = (cx: number) => {
      px(cx - 2, 9, 5, 6, TIRE); px(cx - 3, 10, 7, 4, TIRE);  // tyre
      px(cx - 1, 10, 3, 4, RIM); px(cx, 11, 1, 2, HUB);        // rim + hub
    };
    wheel(3); wheel(12);
    // chair frame: seat, backrest, push handle, footplate
    px(5, 9, 6, 2, FRAME); px(5, 5, 1, 5, FRAME); px(5, 4, 2, 1, FRAME); px(6, 13, 4, 1, FRAME);
    // seated body (jersey) + lap/shorts + resting feet
    px(6, 7, 5, 4, JER); px(6, 10, 1, 1, JER_D); px(5, 8, 1, 2, JER); px(10, 8, 1, 2, JER);
    px(6, 11, 5, 2, PANTS); px(6, 13, 1, 1, 0x222222); px(9, 13, 1, 1, 0x222222);
    // head + cap + glasses
    px(6, 2, 5, 4, SKN); px(6, 3, 1, 1, 0x171717); px(10, 4, 1, 2, 0x171717); // hair edges
    px(5, 1, 6, 2, CAPC); px(5, 2, 6, 1, CAP_D); px(11, 2, 2, 1, CAPC);        // cap + forward brim
    px(7, 4, 2, 1, 0x20242c); px(9, 4, 2, 1, 0x20242c); px(6, 4, 1, 1, 0x20242c); // glasses
    // baseball bat held over the right shoulder, angled up-right
    px(10, 6, 1, 1, BAT_D); px(11, 5, 1, 1, BAT); px(12, 4, 1, 1, BAT);
    px(13, 3, 2, 1, BAT); px(13, 1, 2, 2, 0xd8b56a); px(12, 2, 1, 1, BAT);
    g.generateTexture('w-kenny', 16, 16);

    // --- the demon: a squat red imp with two horns, white eyes, a barbed tail + tiny pitchfork
    // (12×16). Same pixel idiom as the minion/Kenny one-offs; baked (not tinted). ---
    {
      const RD = 0xc0271f, RD_D = 0x8a160f, RD_L = 0xe04a36, HORN = 0xf0e0c0, EYE = 0xfff4d6;
      const PUP = 0x140000, FORK = 0xb8bcc4;
      g.clear();
      // barbed tail curling out to the right (behind the body)
      px(9, 11, 2, 1, RD_D); px(10, 9, 1, 2, RD_D); px(11, 8, 1, 1, RD_D); px(10, 7, 2, 1, RD);
      // pitchfork in the left hand
      px(1, 6, 1, 8, FORK); px(0, 4, 1, 3, FORK); px(2, 4, 1, 3, FORK); px(1, 4, 1, 1, FORK);
      // horns
      px(3, 0, 1, 2, HORN); px(8, 0, 1, 2, HORN); px(3, 2, 1, 1, RD_D); px(8, 2, 1, 1, RD_D);
      // head
      px(3, 2, 6, 4, RD); px(3, 2, 6, 1, RD_L); px(4, 5, 4, 1, RD_D);
      // eyes (white, glowing) + pupils
      px(4, 3, 2, 2, EYE); px(7, 3, 2, 2, EYE); px(5, 4, 1, 1, PUP); px(7, 4, 1, 1, PUP);
      // wicked grin
      px(4, 5, 4, 1, 0x3a0000);
      // body + little arms + clawed feet
      px(3, 6, 6, 6, RD); px(3, 6, 6, 1, RD_L); px(2, 7, 1, 3, RD); px(9, 7, 1, 3, RD);
      px(3, 11, 6, 1, RD_D);
      px(4, 12, 2, 3, RD_D); px(7, 12, 2, 3, RD_D); // legs
      px(3, 15, 3, 1, 0x120000); px(7, 15, 3, 1, 0x120000); // clawed feet
      g.generateTexture('w-demon', 12, 16);
    }

    // --- the tortured soul: a pale, hunched, gaunt wretch with sunken dark eye-sockets, reaching
    // arms and a tattered hem (12×16). Drawn near-white so the renderer can fade it to a ghost. ---
    {
      const PALE = 0xc8d0d8, PALE_D = 0x9aa4b0, PALE_L = 0xe6ecf2, SHAD = 0x6a7280, EYE = 0x101418;
      g.clear();
      // hunched head
      px(4, 1, 5, 4, PALE); px(4, 1, 5, 1, PALE_L); px(4, 4, 5, 1, PALE_D);
      // sunken hollow eyes + gaping moan
      px(5, 2, 1, 2, EYE); px(7, 2, 1, 2, EYE); px(6, 4, 1, 1, SHAD);
      // thin body
      px(4, 5, 5, 6, PALE); px(4, 5, 5, 1, PALE_L); px(4, 10, 5, 1, PALE_D);
      // gaunt arms reaching out for help
      px(2, 6, 2, 1, PALE); px(3, 7, 1, 2, PALE); px(9, 6, 2, 1, PALE); px(8, 7, 1, 2, PALE);
      // tattered, ragged lower half
      px(4, 11, 5, 3, SHAD); px(4, 11, 5, 1, PALE_D);
      px(4, 14, 1, 1, SHAD); px(6, 14, 1, 2, SHAD); px(8, 14, 1, 1, SHAD);
      g.generateTexture('w-tortured-soul', 12, 16);
    }

    // --- Grizzled Angler: straw sun hat, green vest, a fishing rod with a line in the water
    // (16×16 so the rod can reach off to the side). ---
    {
      const VEST = 0x3f6f4a, VEST_D = 0x2c5236, SKN2 = 0xf1c9a0, HAT = 0xd8c690, HAT_D = 0xb09a5e;
      const ROD = 0x8a5a2a, PANTS2 = 0x394a5a, LINE = 0xdddddd;
      g.clear();
      px(6, 13, 2, 3, PANTS2); px(9, 13, 2, 3, PANTS2); px(6, 15, 2, 1, 0x222222); px(9, 15, 2, 1, 0x222222); // legs + boots
      px(5, 7, 7, 6, VEST); px(5, 12, 7, 1, VEST_D);          // vest body
      px(4, 8, 1, 4, SKN2); px(12, 8, 1, 3, SKN2);            // arms
      px(6, 3, 5, 4, SKN2);                                   // head
      px(7, 4, 1, 1, 0x222222); px(9, 4, 1, 1, 0x222222); px(7, 6, 3, 1, 0x6b4f3a); // grumpy eyes + frown
      px(4, 2, 9, 1, HAT_D); px(5, 1, 6, 2, HAT); px(5, 0, 6, 1, HAT);              // straw sun hat
      px(12, 8, 1, 1, ROD); px(13, 6, 1, 1, ROD); px(14, 4, 1, 1, ROD); px(15, 2, 1, 1, ROD); // rod shaft
      px(15, 3, 1, 7, LINE);                                  // line dangling to the water
      g.generateTexture('w-angler', 16, 16);
    }

    // --- Protester: an angry little person hoisting a cardboard picket sign on a stick, mouth open
    // mid-chant (16×16 so the raised sign can sit up top). ---
    {
      const SHIRT = 0xc0392b, SHIRT_D = 0x8e2a20, SKN3 = 0xe7b98e, HAIR3 = 0x33271a;
      const PANTS3 = 0x2f3a4a, BOOT = 0x1b2230, POLE = 0x8a5a2a, CARD = 0xeae0c8, CARD_D = 0xc7b990, INK = 0x222428;
      g.clear();
      // picket sign — board across the top, a few ink strokes hinting at slogans
      px(7, 0, 9, 4, CARD); px(7, 0, 9, 1, CARD_D); px(7, 3, 9, 1, CARD_D);
      px(8, 1, 2, 1, INK); px(11, 1, 1, 2, INK); px(13, 1, 2, 1, INK); px(9, 2, 4, 1, INK);
      px(10, 4, 1, 4, POLE);                                  // pole down to the raised hand
      // body
      px(4, 13, 2, 3, PANTS3); px(7, 13, 2, 3, PANTS3); px(4, 15, 2, 1, BOOT); px(7, 15, 2, 1, BOOT); // legs + boots
      px(3, 7, 7, 6, SHIRT); px(3, 12, 7, 1, SHIRT_D);        // shirt
      px(2, 8, 1, 4, SKN3);                                   // lowered fist (left)
      px(9, 6, 1, 3, SKN3); px(10, 7, 1, 1, SKN3);            // raised arm gripping the pole
      px(4, 3, 5, 4, SKN3);                                   // head
      px(4, 2, 5, 1, HAIR3); px(4, 3, 1, 2, HAIR3);           // tousled hair
      px(5, 4, 1, 1, INK); px(7, 4, 1, 1, INK);               // furious eyes
      px(5, 6, 3, 1, INK);                                    // mouth open, shouting
      g.generateTexture('w-protester', 16, 16);
    }

    // --- shelter critters: little dogs & cats milling around the pet shack (14×10, face +x) ---
    {
      const DOG = 0x9a6b3f, DOG_D = 0x744d28, EAR = 0x5e3d20, NOSE = 0x2a1c12;
      g.clear();
      px(2, 4, 8, 4, DOG); px(2, 7, 8, 1, DOG_D);            // body
      px(9, 3, 4, 4, DOG); px(12, 4, 1, 2, NOSE);            // head + snout (right)
      px(9, 2, 2, 2, EAR);                                   // floppy ear
      px(11, 4, 1, 1, NOSE);                                 // eye
      px(2, 4, 2, 2, DOG); px(1, 3, 1, 3, DOG_D);            // upright tail (left)
      px(3, 8, 1, 2, DOG_D); px(5, 8, 1, 2, DOG_D); px(7, 8, 1, 2, DOG_D); px(9, 8, 1, 2, DOG_D); // legs
      g.generateTexture('w-dog', 14, 12);
    }
    {
      const CAT = 0x6b6b73, CAT_D = 0x4c4c54, EAR = 0x39393f, NOSE = 0xe79ab0;
      g.clear();
      px(3, 5, 7, 3, CAT); px(3, 7, 7, 1, CAT_D);            // body
      px(9, 4, 3, 3, CAT); px(11, 5, 1, 1, NOSE);            // head + pink nose (right)
      px(9, 2, 1, 2, EAR); px(11, 2, 1, 2, EAR);             // pointy ears
      px(10, 5, 1, 1, NOSE);                                 // eye
      px(2, 3, 1, 3, CAT); px(1, 2, 1, 2, CAT_D);            // curled tail (left, raised)
      px(4, 8, 1, 2, CAT_D); px(6, 8, 1, 2, CAT_D); px(8, 8, 1, 2, CAT_D); // legs
      g.generateTexture('w-cat', 14, 12);
    }

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

    // --- Pets ---------------------------------------------------------------------------
    // Pet Rock: a grey pebble with two googly eyes (12×10 texels).
    g.clear();
    px(2, 4, 8, 5, 0x8a8d92); px(3, 3, 6, 1, 0x9aa0a6); px(1, 5, 10, 3, 0x8a8d92); // body + highlight
    px(2, 8, 8, 1, 0x6f7378);                                                       // shaded base
    px(3, 2, 3, 3, 0xffffff); px(4, 3, 1, 1, 0x111111);                             // left googly eye
    px(6, 2, 3, 3, 0xffffff); px(7, 3, 1, 1, 0x111111);                             // right googly eye
    g.generateTexture('w-pet-rock', 12, 10);

    // Pikachu: yellow body, black-tipped ears, red cheeks (14×16 texels).
    {
      const PK = 0xf6d020, PK_D = 0xe0b800, BLK = 0x1a1a1a, RED = 0xe23b3b, BRN = 0x9c6b1f;
      g.clear();
      px(3, 0, 2, 4, PK); px(9, 0, 2, 4, PK); px(3, 0, 2, 1, BLK); px(9, 0, 2, 1, BLK); // ears + black tips
      px(3, 4, 8, 9, PK); px(2, 6, 10, 6, PK); px(3, 13, 8, 1, PK_D);                   // head/body
      px(3, 6, 8, 1, BRN); px(3, 8, 8, 1, BRN);                                         // back stripes
      px(2, 9, 2, 2, RED); px(10, 9, 2, 2, RED);                                        // cheeks
      px(5, 7, 1, 2, BLK); px(8, 7, 1, 2, BLK); px(6, 9, 2, 1, BLK);                    // eyes + nose/mouth
      px(4, 15, 2, 1, PK_D); px(8, 15, 2, 1, PK_D);                                     // feet
      g.generateTexture('w-pet-pikachu', 14, 16);
    }

    // Pac-Man: three chomp frames (mouth opens toward +x; the sprite is rotated to face travel).
    const bakePac = (key: string, mouth: number) => {
      g.clear();
      g.fillStyle(0xffe23a, 1);
      g.slice(6, 6, 6, mouth, Math.PI * 2 - mouth, false);
      g.fillPath();
      px(5, 2, 1, 1, 0x1a1a1a); // eye
      g.generateTexture(key, 12, 12);
    };
    bakePac('w-pet-pacman-0', 0.02); // ~closed
    bakePac('w-pet-pacman-1', 0.38); // half-open
    bakePac('w-pet-pacman-2', 0.72); // wide-open

    // --- DOOM flame tongues: two teardrop shapes (orange outer, yellow core) baked at 8×12 texels.
    // The renderer scatters a handful of these around the portal and update() jitters them so they
    // flicker like fire. Two variants give the flame field a bit of organic variety. ---
    const bakeFlame = (key: string, lean: number) => {
      g.clear();
      const OUT = 0xff5a1e, MID = 0xff9d2a, COR = 0xffe85a;
      // outer body: a tapering tongue, widest at the base, leaning by `lean`
      px(3 + lean, 0, 2, 2, OUT);                       // tip
      px(2 + lean, 2, 4, 2, OUT);
      px(1, 4, 6, 3, OUT);
      px(1, 7, 6, 4, OUT); px(2, 11, 4, 1, OUT);        // base
      // mid glow
      px(3, 3, 2, 3, MID); px(2, 6, 4, 4, MID);
      // bright core
      px(3, 6, 2, 3, COR); px(3, 9, 2, 1, COR);
      g.generateTexture(key, 8, 12);
    };
    bakeFlame('w-flame-0', 0);
    bakeFlame('w-flame-1', 1);

    g.destroy();
  }

  // Build a pixel building image keyed by id, sized to its footprint (in texels).
  // Compose a building out of Kenney "Tiny Town" tiles: a roof band over wall rows, a framed door
  // at bottom-centre, scattered windows, then a themed flourish (marquee bulbs / sign emoji).
  function buildBuilding(sc: Phaser.Scene, b: WorldBuilding) {
    const bw = Math.max(3, Math.round(b.w / TILE));
    const bh = Math.max(3, Math.round(b.h / TILE));
    const roofRows = Math.max(2, Math.round(bh * 0.5)); // a taller roof reads as a building, not a wall
    const depth = b.y + b.h;
    const scale = TILE / 16;

    // per-venue palette: casino = red roof + wood walls; arena = grey roof + wood walls;
    // bank = grey roof + stone walls (institutional).
    const red = b.kind === 'casino';
    const roofTop = red ? [52, 53, 54] : [48, 49, 50];
    const roofMid = red ? [64, 65, 66] : [60, 61, 62];
    const wood = b.kind !== 'bank';
    const wallL = wood ? 72 : 76, wallM = wood ? 73 : 77, wallR = wood ? 75 : 79;
    const doorF = wood ? 85 : 89, windowF = wood ? 84 : 88;
    const doorCol = Math.floor(bw / 2);

    const place = (col: number, row: number, frame: number, d = depth) =>
      sc.add.image(b.x + col * TILE + TILE / 2, b.y + row * TILE + TILE / 2, 'townFrames', frame)
        .setScale(scale).setDepth(d);

    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const left = col === 0, right = col === bw - 1;
        if (row < roofRows) {
          const set = row === 0 ? roofTop : roofMid;
          place(col, row, left ? set[0] : right ? set[2] : set[1]);
        } else {
          const bottom = row === bh - 1;
          // a single tidy band of windows on the upper wall row, evenly spaced, clear of the door
          const windowRow = row === roofRows + 1;
          const isWindow = windowRow && !left && !right && col !== doorCol && (col - 1) % 4 === 0;
          if (bottom && col === doorCol) place(col, row, doorF);
          else if (isWindow) place(col, row, windowF);
          else place(col, row, left ? wallL : right ? wallR : wallM);
        }
      }
    }

    // the venue glyph on a little hanging sign above the door (🏦 for the bank)
    const doorX = b.x + doorCol * TILE + TILE / 2;
    sc.add.text(doorX, b.y + b.h - TILE * 1.7, b.emoji, { fontSize: '22px' })
      .setOrigin(0.5, 1).setDepth(b.y + b.h + 2);
  }

  // The Casino and Arena need to read as what they ARE, not as generic houses — so they're custom
  // pixel facades (drawn at texel res, upscaled ×TEXEL) plus animated Phaser overlays on top.
  function px9(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, c: number, a = 1) {
    g.fillStyle(c, a); g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function buildCasino(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    // dark glam facade + neon trim
    P(0, 0, W, H, 0x140a24);
    P(3, 3, W - 6, H - 6, 0x271447);
    P(3, 3, W - 6, 2, 0xff3ea5); P(3, H - 5, W - 6, 2, 0xff3ea5);       // magenta neon top/bottom
    P(3, 3, 2, H - 6, 0xff3ea5); P(W - 5, 3, 2, H - 6, 0xff3ea5);
    // gold marquee band across the top (bulbs are added live, on top)
    const band = Math.round(H * 0.17);
    P(6, 6, W - 12, band, 0xe8b84b); P(6, 6, W - 12, 3, 0xffd87a);
    P(6, 6 + band, W - 12, 2, 0x7a5a18);
    // central 777 sign panel
    const sx = Math.round(W * 0.28), sy = Math.round(H * 0.3), sw = Math.round(W * 0.44), sh = Math.round(H * 0.34);
    P(sx - 3, sy - 3, sw + 6, sh + 6, 0xffd23f); P(sx, sy, sw, sh, 0x0a0612);
    const seven = (cx: number, cy: number, sw7: number, sh7: number, col: number) => {
      P(cx, cy, sw7, 2, col);                                   // top bar
      for (let i = 0; i < sh7; i++) P(cx + sw7 - 2 - Math.round(i * (sw7 - 2) / sh7), cy + i, 2, 1, col);
    };
    const sevenH = Math.round(sh * 0.6), sevenW = Math.round(sw * 0.18), gap = Math.round(sw * 0.1);
    const startX = sx + Math.round((sw - (sevenW * 3 + gap * 2)) / 2), sevenY = sy + Math.round((sh - sevenH) / 2);
    for (let i = 0; i < 3; i++) seven(startX + i * (sevenW + gap), sevenY, sevenW, sevenH, 0xff4d4d);
    // glowing windows along the lower wall
    const wy = Math.round(H * 0.72), ww = Math.round(W * 0.07), wh = Math.round(H * 0.12);
    for (let x = Math.round(W * 0.1); x < W - ww - 6; x += Math.round(W * 0.2)) {
      P(x, wy, ww, wh, 0x3a2a12); P(x + 1, wy + 1, ww - 2, wh - 2, 0xffcf5a);
    }
    // gold doorway + red carpet
    const dw = Math.round(W * 0.16), dx = Math.round((W - dw) / 2), dh = Math.round(H * 0.26);
    P(dx - 2, H - dh - 4, dw + 4, dh + 2, 0xe8b84b); P(dx, H - dh - 2, dw, dh, 0x1a0a14);
    P(dx + 2, H - dh, dw - 4, dh, 0xb01030);
    g.generateTexture(`w-casino`, W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-casino').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // live marquee bulbs chasing along the gold band
    const by = b.y + 8 * TEXEL;
    const n = Math.max(6, Math.round(b.w / 44));
    for (let i = 0; i < n; i++) {
      const bx = b.x + 14 + (i / (n - 1)) * (b.w - 28);
      const bulb = sc.add.circle(bx, by, 5, 0xfff2a8).setDepth(depth + 1);
      sc.tweens.add({ targets: bulb, alpha: 0.2, duration: 360, yoyo: true, repeat: -1, delay: i * 90 });
    }
  }

  function buildArena(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    const roofH = Math.round(H * 0.34);
    // concrete bowl
    P(0, roofH - 4, W, H - roofH + 4, 0x9aa1b0);
    P(3, roofH, W - 6, H - roofH - 3, 0xc6ccd8);
    // tiered seating hint (diagonal banding)
    for (let r = 0; r < 4; r++) P(6, roofH + 4 + r * Math.round((H - roofH) * 0.12), W - 12, 2, 0xb0b7c4);
    // big curved blue roof
    P(0, 0, W, roofH, 0x2c3e8f);
    P(0, 0, W, 3, 0x4a5fc0);
    for (let i = 0; i < W; i++) { const dip = Math.round(Math.sin((i / W) * Math.PI) * 6); P(i, roofH - dip, 1, dip + 3, 0x24337a); }
    // floodlight towers (poles + lamp panels) at the top corners
    const towerX = [Math.round(W * 0.12), Math.round(W * 0.88)];
    for (const tx of towerX) { P(tx - 1, 2, 3, roofH, 0x3a4252); P(tx - 5, 0, 11, 5, 0x2b3140); }
    // central arched entrance with a glimpse of the green pitch + net
    const ax = Math.round(W * 0.33), aw = Math.round(W * 0.34), ay = roofH + Math.round(H * 0.12), ah = H - ay - Math.round(H * 0.04);
    P(ax - 3, ay - 3, aw + 6, ah + 6, 0xe8eef6); P(ax, ay, aw, ah, 0x2f8f43);
    P(ax + 1, ay + 1, aw - 2, ah - 2, 0x3fa850); P(Math.round(W / 2), ay, 1, ah, 0xffffff);
    g.generateTexture('w-arena', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-arena').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // glowing floodlights that pulse, with a soft halo
    for (const tx of towerX) {
      sc.add.circle(b.x + tx * TEXEL, b.y + 3 * TEXEL, 16, 0xfff0c0, 0.18).setDepth(depth + 1);
      const lamp = sc.add.rectangle(b.x + tx * TEXEL, b.y + 2 * TEXEL, 12, 7, 0xfff6c8).setDepth(depth + 2);
      sc.tweens.add({ targets: lamp, alpha: 0.55, duration: 900, yoyo: true, repeat: -1 });
    }
  }

  // The hellgate: a dark red-black stone archway with a glowing portal mouth, then live flames
  // layered over/around it (pushed into `flames`, danced each frame in update()). Mirrors the
  // buildCasino/buildArena idiom — bake the static facade as a texture, add animated sprites on top.
  function buildDoomPortal(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    // dark stone block + bevelled edges
    P(0, 0, W, H, 0x180404);
    P(2, 2, W - 4, H - 4, 0x2a0808);
    P(4, 4, W - 8, 3, 0x431010); P(4, 4, 3, H - 8, 0x431010);   // top/left highlight
    P(W - 7, 4, 3, H - 8, 0x120303); P(4, H - 7, W - 8, 3, 0x120303); // bottom/right shadow
    // carved stone courses (rough brick lines)
    for (let yy = 10; yy < H - 8; yy += 12) P(5, yy, W - 10, 1, 0x140404);
    // the arch: a tall opening, rounded at the top, with a glowing red→yellow portal mouth
    const ax = Math.round(W * 0.22), aw = W - ax * 2;
    const ay = Math.round(H * 0.22), ah = H - ay - Math.round(H * 0.1);
    // stone arch frame (lighter ring around the mouth)
    P(ax - 3, ay - 3, aw + 6, ah + 6, 0x501414);
    // portal mouth — concentric glow from deep red rim to molten yellow core
    P(ax, ay + 2, aw, ah, 0x6e0d0d);
    P(ax + 2, ay + 4, aw - 4, ah - 4, 0xb01818);
    P(ax + 4, ay + 7, aw - 8, ah - 9, 0xff3a14);
    P(ax + 6, ay + 11, aw - 12, ah - 15, 0xff7a1e);
    P(ax + 8, ay + 16, aw - 16, ah - 22, 0xffd23f);
    // round the top of the arch by trimming the upper corners back to stone
    P(ax, ay + 2, 3, 4, 0x2a0808); P(ax + aw - 3, ay + 2, 3, 4, 0x2a0808);
    // a couple of skull-ish notches on the keystone for menace
    P(Math.round(W / 2) - 4, 5, 3, 3, 0x0c0202); P(Math.round(W / 2) + 1, 5, 3, 3, 0x0c0202);
    g.generateTexture('w-doomportal', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-doomportal').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // soft red hellglow behind the mouth
    sc.add.circle(b.x + b.w / 2, b.y + b.h * 0.5, b.w * 0.5, 0xff2a0a, 0.16).setDepth(depth + 1);

    // Flames: a row dancing along the base of the gate plus a couple licking up the jambs. Each
    // gets a phase so they don't flicker in lockstep. update() jitters alpha/scale/offset.
    const addFlame = (fx: number, fy: number, base: number, amp: number) => {
      const key = Math.random() < 0.5 ? 'w-flame-0' : 'w-flame-1';
      const img = sc.add.image(fx, fy, key).setScale(TEXEL).setOrigin(0.5, 1).setDepth(depth + 2)
        .setBlendMode(Phaser.BlendModes.ADD);
      flames.push({ img, bx: fx, by: fy, phase: Math.random() * Math.PI * 2, amp, base });
    };
    const baseY = b.y + b.h - 6;
    const n = Math.max(4, Math.round(b.w / 26));
    for (let i = 0; i < n; i++) {
      const fx = b.x + 12 + (i / (n - 1)) * (b.w - 24);
      addFlame(fx, baseY, 0.9 + Math.random() * 0.5, 1);
    }
    // jamb flames climbing each side
    for (const side of [0.16, 0.84]) {
      addFlame(b.x + b.w * side, b.y + b.h * 0.62, 1.0, 1.2);
      addFlame(b.x + b.w * side, b.y + b.h * 0.40, 0.8, 1.3);
    }
  }

  // The fishing pond: a rounded body of water (a couple of blue tones + a lighter rim) instead of
  // a building, with a small wooden pier/dock jutting from its west (plaza-facing) edge. It's still
  // solid (the WORLD_BUILDINGS rect collides), so you stand at the pier edge — you can't wade in.
  // Live ripples (pushed into `ripples`, animated each frame in update()) make the water shimmer.
  function buildPond(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y; // low depth: water sits on the ground, avatars/pier render over it as they pass
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    // An organic pond: concentric ellipses for a sandy shore, a shallow rim, the main water and a
    // deep centre — plus a couple of lily pads, so it reads as a pond and not a blue rectangle.
    const cx = W / 2, cy = H / 2;
    const SAND = 0xcdb892, SAND_D = 0xb39b73, SHALLOW = 0x5fb0dd, MID = 0x2a6f97, DEEP = 0x143f5c;
    const SHIM = 0xafe0fb, PAD = 0x3f9d52, PAD_D = 0x2c7a3c;
    g.fillStyle(SAND_D, 1); g.fillEllipse(cx, cy + 2, W, H);                       // shore shadow
    g.fillStyle(SAND, 1);   g.fillEllipse(cx, cy, W - 2, H - 6);                   // sandy shore
    g.fillStyle(SHALLOW, 1); g.fillEllipse(cx, cy, W - 14, H - 16);                // shallow water rim
    g.fillStyle(MID, 1);    g.fillEllipse(cx, cy, W - 22, H - 26);                 // main water
    g.fillStyle(DEEP, 1);   g.fillEllipse(cx, cy, (W - 22) * 0.58, (H - 26) * 0.58); // deep centre
    P(Math.round(W * 0.34), Math.round(H * 0.34), Math.round(W * 0.16), 2, SHIM, 0.55); // shimmer
    P(Math.round(W * 0.52), Math.round(H * 0.58), Math.round(W * 0.12), 2, SHIM, 0.45);
    const pad = (lx: number, ly: number, r: number) => {
      g.fillStyle(PAD, 1); g.fillEllipse(lx, ly, r * 2, r * 1.6);
      g.fillStyle(PAD_D, 1); g.fillEllipse(lx, ly + 1, r * 1.3, r * 1.0);
      g.fillStyle(MID, 1); g.fillRect(lx, ly - 1, r + 1, 2); // pie-slice notch
    };
    pad(Math.round(W * 0.40), Math.round(H * 0.46), 5);
    pad(Math.round(W * 0.62), Math.round(H * 0.40), 4);
    pad(Math.round(W * 0.50), Math.round(H * 0.66), 4);
    g.generateTexture('w-pond', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-pond').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // Reed/cattail clusters dotted around the shore so the edge looks planted, not cut out.
    const rg = sc.make.graphics({ x: 0, y: 0 }, false);
    const REED = 0x4a7d3a, REED_D = 0x3a6330, CAT = 0x7a4a26;
    rg.fillStyle(REED, 1); rg.fillRect(2, 4, 1, 11); rg.fillRect(4, 2, 1, 13); rg.fillRect(6, 5, 1, 10);
    rg.fillStyle(REED_D, 1); rg.fillRect(3, 8, 1, 7);
    rg.fillStyle(CAT, 1); rg.fillRect(4, 0, 1, 3); rg.fillRect(6, 4, 1, 2);
    rg.generateTexture('w-reeds', 8, 16);
    rg.destroy();
    for (const [fx, fy] of [[0.16, 0.20], [0.82, 0.26], [0.30, 0.86], [0.72, 0.80]] as const) {
      sc.add.image(b.x + b.w * fx, b.y + b.h * fy, 'w-reeds')
        .setOrigin(0.5, 1).setScale(TEXEL).setDepth(b.y + b.h * fy);
    }

    // Live ripple rings drifting on the water.
    const n = 4;
    for (let i = 0; i < n; i++) {
      const cx = b.x + b.w * (0.35 + Math.random() * 0.5);
      const cy = b.y + b.h * (0.3 + Math.random() * 0.5);
      const maxR = 10 + Math.random() * 14;
      const ring = sc.add.circle(cx, cy, 1).setStrokeStyle(2, 0xbfe6ff, 0.5).setDepth(depth + 1);
      ripples.push({ ring, cx, cy, phase: Math.random() * Math.PI * 2, maxR });
    }

    // Wooden pier/dock on the west (plaza-facing) side: planks reaching out over the water from the
    // shore, with two posts at the tip. Drawn as its own texture so it layers cleanly over the water.
    const pg = sc.make.graphics({ x: 0, y: 0 }, false);
    const PLANK = 0x9c6b3f, PLANK_D = 0x7a4f2c, POST = 0x5e3c20;
    const pierW = 24, pierH = 14; // texels
    pg.fillStyle(PLANK_D, 1); pg.fillRect(0, 0, pierW, pierH);
    pg.fillStyle(PLANK, 1);
    for (let py = 1; py < pierH - 1; py += 3) pg.fillRect(1, py, pierW - 2, 2); // plank slats
    pg.fillStyle(POST, 1); pg.fillRect(pierW - 3, 0, 2, pierH); pg.fillRect(pierW - 3, 0, 2, 2);
    pg.generateTexture('w-pier', pierW, pierH);
    pg.destroy();
    // Anchor the pier so it sticks out from the pond's west edge toward the plaza, vertically centered.
    sc.add.image(b.x, b.y + b.h / 2, 'w-pier').setOrigin(1, 0.5).setScale(TEXEL).setDepth(b.y + b.h / 2);
  }

  // --- the Phaser scene ---
  let game: Phaser.Game | null = null;
  let mainCam: Phaser.Cameras.Scene2D.Camera | null = null; // for screen→world hit-testing on tap

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
      mainCam = sc.cameras.main;

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

      // --- buildings + name signs (Casino & Arena are custom-themed; Bank is a Kenney house) ---
      for (const b of WORLD_BUILDINGS) {
        // ground shadow cast down-right (skip the pond — water is flush with the ground)
        if (b.kind !== 'pond') {
          sc.add.rectangle(b.x + 14, b.y + 18, b.w, b.h, 0x0a1226, 0.32)
            .setOrigin(0, 0).setDepth(b.y + b.h - 1);
        }
        if (b.kind === 'casino') buildCasino(sc, b);
        else if (b.kind === 'arena') buildArena(sc, b);
        else if (b.kind === 'doomportal') buildDoomPortal(sc, b);
        else if (b.kind === 'pond') buildPond(sc, b);
        else buildBuilding(sc, b);
        const sign = sc.add.text(b.x + b.w / 2, b.y - 6, b.name, {
          fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold',
          color: '#ffffff', stroke: '#0b1020', strokeThickness: 5, resolution: 2,
        });
        sign.setOrigin(0.5, 1).setDepth(100000);
      }

      // --- strays around the pet shack: a few dogs & cats ambling about outside ---
      {
        const shack = WORLD_BUILDINGS.find((x) => x.kind === 'petshop');
        if (shack) {
          const cx = shack.x + shack.w / 2, cy = shack.y + shack.h + 70; // gather just south of the shack (toward the path)
          const kinds = ['w-dog', 'w-cat', 'w-dog', 'w-cat', 'w-dog'];
          for (let i = 0; i < kinds.length; i++) {
            const a = (i / kinds.length) * Math.PI * 2;
            const x = cx + Math.cos(a) * 60, y = cy + Math.sin(a) * 40;
            const shadow = sc.add.image(x, y + 2, 'w-shadow').setScale(TEXEL * 0.7).setDepth(y - 1).setAlpha(0.5);
            const spr = sc.add.image(x, y, kinds[i]).setScale(TEXEL * 1.1).setOrigin(0.5, 0.9).setDepth(y);
            critters.push({ spr, shadow, hx: cx, hy: cy, tx: x, ty: y, spd: 26 + (i % 3) * 8, pause: i * 0.4 });
          }
        }
      }

      // --- townsfolk ---
      for (const def of NPCS) npcs.push(makeNpc(sc, def));

      // --- our own avatar ---
      petScene = sc; // remember the scene so pet sprites can be spawned on demand in update()
      self = makeAvatar(sc, net.name() || 'you', net.color());
      sc.cameras.main.startFollow(self.c, true, 0.18, 0.18);
      sc.cameras.main.roundPixels = true;

      // --- atmosphere on the GPU: a warm Multiply tint + a radial vignette, both pinned to the
      // camera (scrollFactor 0). Replaces the old DOM soft-light layers — same lit look, but it
      // renders identically and fast on every browser instead of compositing DOM over the canvas. ---
      const VIG = 'w-vignette';
      if (!sc.textures.exists(VIG)) {
        const sz = 256;
        const ct = sc.textures.createCanvas(VIG, sz, sz);
        if (ct) {
          const c2 = ct.getContext();
          const grd = c2.createRadialGradient(sz / 2, sz * 0.46, sz * 0.28, sz / 2, sz * 0.46, sz * 0.64);
          grd.addColorStop(0, 'rgba(0,0,0,0)');
          grd.addColorStop(1, 'rgba(8,12,30,0.42)');
          c2.fillStyle = grd; c2.fillRect(0, 0, sz, sz);
          ct.refresh();
        }
      }
      const warm = sc.add.rectangle(0, 0, 10, 10, 0xffe2b0).setOrigin(0).setScrollFactor(0)
        .setBlendMode(Phaser.BlendModes.MULTIPLY).setAlpha(0.34).setDepth(50000);
      const vig = sc.add.image(0, 0, VIG).setOrigin(0).setScrollFactor(0).setDepth(50001);
      warmOverlay = warm;

      // --- night overlay: a deep-navy wash whose alpha rises after dark (depth above the warm/vignette
      // light layer so it actually darkens the scene). Animated each frame in update(). ---
      const night = sc.add.rectangle(0, 0, 10, 10, 0x0a1530).setOrigin(0).setScrollFactor(0)
        .setAlpha(0).setDepth(50002);
      nightOverlay = night;

      const fitAtmo = (w: number, h: number) => {
        warm.setSize(w, h); vig.setDisplaySize(w, h); night.setSize(w, h);
      };
      fitAtmo(sc.scale.width, sc.scale.height);
      sc.scale.on('resize', (gs: Phaser.Structs.Size) => fitAtmo(gs.width, gs.height));
    },

    update(this: Phaser.Scene, time: number, delta: number) {
      const sc = this;
      const now = performance.now();
      const dt = Math.min(delta / 1000, 0.05);
      if (helpFlash && now >= helpFlashUntil) { helpFlash = ''; updateHelp(); }

      // --- day/night: derive purely from the wall clock so every client's sky matches ---
      {
        const night = nightFactor(Date.now());
        if (nightOverlay) nightOverlay.setAlpha(night * 0.6);            // darker after dusk
        if (warmOverlay) warmOverlay.setAlpha(0.34 * (1 - night * 0.8)); // golden glow fades after dark
      }

      // strays amble around the pet shack: walk toward a target, pause, then pick a new nearby spot
      for (const c of critters) {
        if (c.pause > 0) { c.pause -= dt; continue; }
        const dx = c.tx - c.spr.x, dy = c.ty - c.spr.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 3) {
          c.pause = 0.6 + Math.random() * 2.4; // loiter a beat
          const a = Math.random() * Math.PI * 2, r = Math.random() * 90;
          c.tx = c.hx + Math.cos(a) * r; c.ty = c.hy + Math.sin(a) * r * 0.6; // wander an oval patch
        } else {
          const step = Math.min(dist, c.spd * dt);
          c.spr.x += (dx / dist) * step; c.spr.y += (dy / dist) * step;
          c.spr.setFlipX(dx < 0); // face travel direction (sprites are drawn facing +x)
          c.spr.setDepth(c.spr.y);
          c.shadow.setPosition(c.spr.x, c.spr.y + 2).setDepth(c.spr.y - 1);
        }
      }

      // gentle breeze: each tree sways on its own phase (cheap, ~150 rotations/frame)
      for (const t of swayers) t.rotation = Math.sin(time / 700 + t.x * 0.012) * 0.035;

      // the gates of DOOM are on fire: flicker each flame's height, brightness and a tiny horizontal
      // waver, on its own phase, so the whole gate dances.
      for (const f of flames) {
        const t1 = time / 90 + f.phase;
        const flick = Math.sin(t1) * 0.5 + Math.sin(t1 * 2.3 + 1) * 0.5; // ~[-1,1], chunkier than a pure sine
        f.img.setScale(TEXEL * (f.base + flick * 0.18 * f.amp), TEXEL * (f.base + 0.3 + flick * 0.45 * f.amp));
        f.img.setAlpha(0.7 + flick * 0.3);
        f.img.x = f.bx + Math.sin(t1 * 1.7) * 2.2 * f.amp;
        f.img.y = f.by - Math.max(0, flick) * 1.5;
      }

      // pond ripples: each ring slowly expands and fades, then resets — a gentle shimmer.
      for (const rp of ripples) {
        const cycle = ((time / 2600 + rp.phase / (Math.PI * 2)) % 1 + 1) % 1; // 0→1 loop
        rp.ring.setRadius(2 + cycle * rp.maxR);
        rp.ring.setStrokeStyle(2, 0xbfe6ff, 0.5 * (1 - cycle));
      }

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
        if (a.id === talkNetizenId) {
          // freeze the netizen being spoken to — don't update its position from the broadcast.
          // Give it a gentle idle bob so it still looks alive.
          av.ry += Math.sin(now / 180) * 0.3;
        } else {
          av.rx += (a.x - av.rx) * Math.min(1, dt * 12);
          av.ry += (a.y - av.ry) * Math.min(1, dt * 12);
        }
        const ta = a.a ?? av.ra;
        av.ra += angDelta(av.ra, ta) * Math.min(1, dt * 12);
        placeAvatar(av, av.rx, av.ry, av.ra, !!a.car, a.color, a.name);
        // Netizens are silent until approached — no auto speech bubbles.
      }
      // drop avatars that left
      for (const [id, av] of remote) if (!seen.has(id)) { av.c.destroy(); remote.delete(id); }

      updatePets(dt);
    },
  };

  // Trail a pet behind every avatar that has one equipped. The target is a point PET_TRAIL world
  // units behind the owner along its heading (`a`); when there's no heading (on foot) we fall back
  // to the owner's recent move direction, and finally to "below" so a standing-still pet still sits
  // in a sensible spot. Each pet lerps toward its target so it lags and swings like a real tagalong.
  function updatePets(dt: number) {
    const sc = petScene;
    if (!sc) return;
    const selfId = net.selfId();
    const live = new Set<string>(); // pet owners present this frame
    for (const a of others) {
      // Our own pet id comes from the wallet (net.pet()), not the broadcast echo — same as cars.
      const isSelf = a.id === selfId;
      const petId = isSelf ? net.pet() : (a.pet ?? null);
      const pet = petById(petId);
      if (!pet || !petId) continue; // no pet (or an unknown id — e.g. before PETS is populated)
      // Where the owner is right now, and which way it's heading.
      const ox = isSelf ? selfX : (remote.get(a.id)?.rx ?? a.x);
      const oy = isSelf ? selfY : (remote.get(a.id)?.ry ?? a.y);
      const heading = isSelf ? facing : a.a;

      live.add(a.id);
      let ps = petSprites.get(a.id);
      if (!ps || ps.id !== petId) {
        // First sight of this owner's pet (or it changed) — (re)create the custom sprite.
        if (ps) ps.sprite.destroy();
        const tex = pet.kind === 'rock' ? 'w-pet-rock' : pet.kind === 'pikachu' ? 'w-pet-pikachu' : 'w-pet-pacman-0';
        const sprite = sc.add.image(ox, oy, tex).setScale(TEXEL).setOrigin(0.5, 0.6);
        ps = { sprite, id: petId, kind: pet.kind, x: ox, y: oy, lastX: ox, lastY: oy, chomp: 0 };
        petSprites.set(a.id, ps);
      }

      // Pick the "behind" direction: heading if driving, else recent motion, else straight down.
      let dx = ps.lastX - ox, dy = ps.lastY - oy; // owner's last-frame motion (points "backward")
      if (typeof heading === 'number' && Number.isFinite(heading)) { dx = -Math.cos(heading); dy = -Math.sin(heading); }
      const mag = Math.hypot(dx, dy);
      if (mag > 0.001) { dx /= mag; dy /= mag; } else { dx = 0; dy = 1; } // default: just below the owner
      const tx = ox + dx * PET_TRAIL, ty = oy + dy * PET_TRAIL;

      // The pet's OWN travel this frame (for facing + flip), before we overwrite ps.x/ps.y.
      const pvx = tx - ps.x, pvy = ty - ps.y;
      ps.x += pvx * Math.min(1, dt * 8); // lazy chase so the pet lags + swings behind
      ps.y += pvy * Math.min(1, dt * 8);
      ps.lastX = ox; ps.lastY = oy;
      ps.sprite.setPosition(ps.x, ps.y).setDepth(ps.y); // depth-sort with everything else by y

      if (ps.kind === 'pacman') {
        // Chomp: cycle closed→half→open→half on a ~5 Hz loop, and rotate to face travel direction.
        ps.chomp += dt;
        const frame = [0, 1, 2, 1][Math.floor(ps.chomp * 8) % 4];
        ps.sprite.setTexture(`w-pet-pacman-${frame}`);
        if (Math.hypot(pvx, pvy) > 0.5) ps.sprite.setRotation(Math.atan2(pvy, pvx));
      } else if (ps.kind === 'pikachu') {
        // Face the way it's walking (flip horizontally) so it doesn't moonwalk.
        if (Math.abs(pvx) > 0.5) ps.sprite.setFlipX(pvx < 0);
      }
    }
    // Tear down pets whose owner left the world or unequipped.
    for (const [id, ps] of petSprites) if (!live.has(id)) { ps.sprite.destroy(); petSprites.delete(id); }
  }

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
    const bubble = sc.add.text(0, -R - 32, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#ffeb3b',
      backgroundColor: '#1b2542e6', padding: { x: 6, y: 3 }, align: 'center',
      stroke: '#0b1020', strokeThickness: 2, resolution: 2,
    }).setOrigin(0.5, 1).setVisible(false);
    const c = sc.add.container(selfX, selfY, [shadow, car, person, label, bubble]);
    return { c, person, car, carBody, carRoof, label, bubble, bubbleNextAt: 0, rx: selfX, ry: selfY, ra: 0 };
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
    } else if (def.kind === 'kenny') {
      parts = [sc.add.image(0, 0, 'w-kenny').setScale(TEXEL * 1.2).setOrigin(0.5, 0.95)];
    } else if (def.kind === 'demon') {
      parts = [sc.add.image(0, 0, 'w-demon').setScale(TEXEL * 1.05).setOrigin(0.5, 0.95)];
    } else if (def.kind === 'soul') {
      parts = [sc.add.image(0, 0, 'w-tortured-soul').setScale(TEXEL * 1.05).setOrigin(0.5, 0.95).setAlpha(0.82)];
    } else if (def.kind === 'angler') {
      parts = [sc.add.image(0, 0, 'w-angler').setScale(TEXEL * 1.2).setOrigin(0.5, 0.95)];
    } else if (def.kind === 'protester') {
      parts = [sc.add.image(0, 0, 'w-protester').setScale(TEXEL * 1.2).setOrigin(0.5, 0.95)];
    } else {
      const layer = (key: string, tint?: number) => {
        const im = sc.add.image(0, 0, key).setScale(TEXEL).setOrigin(0.5, 0.95);
        if (tint !== undefined) im.setTint(tint);
        return im;
      };
      parts = [];
      const dress = def.body === 'dress';
      if (!dress) parts.push(layer('w-npc-legs'));                          // pants legs (under skirt-less bodies)
      parts.push(def.stripes ? layer('w-npc-body-stripe') : layer(dress ? 'w-npc-dress' : 'w-npc-body', def.shirt));
      parts.push(layer('w-npc-skin', def.skin ?? SKINS[1]));                // head
      parts.push(layer('w-npc-face'));                                      // eyes
      const style = def.hairStyle ?? 'short';
      if (style !== 'bald') parts.push(layer(`w-hair-${style}`, def.hair)); // hair
      if (def.hat === 'cap') parts.push(layer('w-npc-hat-cap', def.hatColor ?? 0xd23b3b));
      else if (def.hat === 'sun') parts.push(layer('w-npc-hat-sun'));
      if (def.glasses) parts.push(layer('w-npc-glasses'));
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
    _exitWorld = null;
    net.leave();
    net.onExit();
  }
  _exitWorld = exit;

  controller = {
    feed(avatars) {
      others = avatars;
      const n = avatars.filter((a) => !a.bot).length; // netizens don't count as players
      count.textContent = n === 1 ? '1 player here' : `${n} players here`;
    },
    reenter() { net.enter(); },
  };
  syncDriveBtn();
  net.enter();
}
