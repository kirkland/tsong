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
  WORLD_PARCELS,
  ROBVILLE_BULBS,
  PARCEL_PRICE,
  BANK_PARCEL_CAP,
  WORLD_SAY_MAX,
  type LandParcelView,
  JAIL,
  JAIL_WALL,
  BAIL_COST,
  WorldAvatar,
  WorldBuilding,
  WorldBuildingKind,
  CarSpec,
  carById,
  petById,
  type PetKind,
  NETIZEN_DIALOGUE,
  STOCKS,
  type ChatLine,
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
  openFeature(feature: 'roulette' | 'blackjack' | 'craps' | 'crash' | 'slots' | 'plinko' | 'horse' | 'hilo' | 'mines' | 'stocks' | 'loans' | 'petshop' | 'doom' | 'fishing' | 'campaign' | 'typedie' | 'racing' | 'superbros'): void; // open a Casino/Bank/Pet-Shop/DOOM/Fishing/Arcade feature
  openParliament(): void;        // walk into the Parliament → open the Nomic rules game overlay
  claimQuest(quest: string): void; // tell the server to grant a World objective reward (once)
  onNetizenClick?(netizenId: string): void; // user tapped a netizen avatar in the world (→ challenge)
  buyBeer(): void;               // buy a beer at the Tavern (server charges 20🪙 + ups drunk level)
  drunkLevel(): number;          // current drunkenness 0–6 (drives movement wobble + camera sway)
  jail(): void;                  // self-report a drunk-drive attempt (server jails you if 2+ beers in)
  bail(targetId: string): void;  // pay 500🪙 to bail a jailed avatar out (id; may be your own)
  amJailed(): boolean;           // are WE currently locked in the jail cell?
  dayNightOffset(): number;      // ms offset for the day/night clock (randomized per server boot)
  // --- Robville land ---
  landReq(): void;                          // ask the server for the current parcel book
  landBuyBank(id: string): void;            // buy an empty lot from the bank (PARCEL_PRICE)
  landList(id: string, ask: number): void;  // list your lot for sale at `ask` coins
  landUnlist(id: string): void;             // take your lot back off the market
  landBuy(id: string): void;                // buy a listed lot from its owner at the asking price
  say(text: string): void;                  // → speech bubble over your avatar (+ to others in-world)
  sendChat(text: string): void;             // → main game chat, so the line also shows in the side feed
  chatHistory(): ChatLine[];                // recent chat backlog, seeded (hidden) so it's there on T
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  feedLand(parcels: LandParcelView[], bankBought: number, bankCap: number): void; // Robville land book
  feedSay(id: string, name: string, text: string): void; // an in-world chat line → speech bubble
  feedChat(line: ChatLine): void; // a new chat line (mirrors the main chat into the side feed)
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

/** Push the latest Robville land book (from a `land` server message) into the live overlay. */
export function feedLand(parcels: LandParcelView[], bankBought: number, bankCap: number): void {
  controller?.feedLand(parcels, bankBought, bankCap);
}

/** Pop a speech bubble over a world avatar (from a `worldSay` server message). */
export function feedSay(id: string, name: string, text: string): void {
  controller?.feedSay(id, name, text);
}

/** Mirror a chat line (from a `chat` server message) into the in-world side feed. No-op if closed. */
export function feedWorldChat(line: ChatLine): void {
  controller?.feedChat(line);
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
  { x: 1060, y: 1300, w: 110, h: 300 }, // spur down to the Tavern (south of centre)
  { x: 585, y: 640, w: 110, h: 560 },   // spur up to Parliament (NW)
  { x: 985, y: 630, w: 110, h: 570 },   // spur up to the Arcade (N, between Parliament & Arena)
  // --- Robville (the suburban neighborhood, east side) ---
  { x: 2640, y: 1180, w: 1270, h: 120 }, // connector avenue off the main street
  { x: 3790, y: 700,  w: 120,  h: 1010 }, // residential spine (vertical)
  { x: 3500, y: 720,  w: 300,  h: 80 },   // stem → Maple Court (west, upper)
  { x: 3910, y: 720,  w: 390,  h: 80 },   // stem → Birch Circle (east, upper)
  { x: 3500, y: 1600, w: 300,  h: 80 },   // stem → Willow Court (west, lower)
  { x: 3910, y: 1600, w: 390,  h: 80 },   // stem → Cedar Circle (east, lower)
];
const PLAZA = { x: 1600, y: 1100, r: 240 }; // paved circle + fountain at town center
// The Tavern's INTERIOR lives off the main map. When you step inside, the camera bounds switch to
// this rect (so the town never shows) and movement is clamped to it. Its NPCs sit here permanently
// with roam 0, so the world-bounds clamp never drags them back onto the map.
// The jail's solid walls — back + sides + a barred front. Both jailed (kept in) and free (kept out)
// avatars collide with these; the cell interior between them stays clear so a jailed avatar can shuffle.
const JAIL_WALLS: Rect[] = [
  { x: JAIL.x, y: JAIL.y, w: JAIL.w, h: JAIL_WALL },                       // back
  { x: JAIL.x, y: JAIL.y, w: JAIL_WALL, h: JAIL.h },                       // left
  { x: JAIL.x + JAIL.w - JAIL_WALL, y: JAIL.y, w: JAIL_WALL, h: JAIL.h },  // right
  { x: JAIL.x, y: JAIL.y + JAIL.h - JAIL_WALL, w: JAIL.w, h: JAIL_WALL },  // front bars
];
// The Tavern interior lives OFF the playable map. It used to sit at x:4200, but Robville widened
// the world to 4800, so it was relocated east of the new bounds to stay out of sight.
const TAVERN_INT = { x: 5400, y: 300, w: 880, h: 560 };
const TAVERN_WALL = 28; // interior wall thickness (play area is inset by this)
const TAVERN_ZOOM = 3;  // zoom in while inside so the small cozy room fills the viewport

function pointInRect(px: number, py: number, r: Rect, pad = 0): boolean {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}
function onRoad(px: number, py: number, pad = 0): boolean {
  return ROADS.some((r) => pointInRect(px, py, r, pad));
}
function nearPlaza(px: number, py: number, pad = 0): boolean {
  return Math.hypot(px - PLAZA.x, py - PLAZA.y) <= PLAZA.r + pad;
}
// Inside a Robville cul-de-sac bulb (the paved circle at a street's dead end).
function nearBulb(px: number, py: number, pad = 0): boolean {
  return ROBVILLE_BULBS.some((b) => Math.hypot(px - b.cx, py - b.cy) <= b.r + pad);
}
// On a Robville lot footprint (kept clear of scattered scenery so houses have room).
function onParcel(px: number, py: number, pad = 0): boolean {
  return WORLD_PARCELS.some((p) => pointInRect(px, py, p, pad));
}
function inAnyBuilding(px: number, py: number, pad = 0): boolean {
  return WORLD_BUILDINGS.some((b) => pointInRect(px, py, b, pad));
}
function inJail(px: number, py: number, pad = 0): boolean {
  return pointInRect(px, py, JAIL, pad);
}
// "Bare" ground = roads + the plaza + Robville cul-de-sac bulbs: dirt under your feet, autotiled
// against the surrounding grass.
function isBare(px: number, py: number): boolean {
  return onRoad(px, py) || nearPlaza(px, py) || nearBulb(px, py);
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
      if (inAnyBuilding(x, y, 90) || inJail(x, y, 40) || onRoad(x, y, 28) || nearPlaza(x, y, 28)) continue;
      if (onParcel(x, y, 16) || nearBulb(x, y, 20)) continue; // keep Robville lots + cul-de-sacs clear
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
  kind?: 'minion' | 'kenny' | 'demon' | 'soul' | 'angler' | 'protester' | 'fed'; // special one-off sprite; default is the little-person
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
    // Permanent fixture outside the Tavern, swaying gently (his roam makes him stumble about).
    id: 'barfly', name: 'Sloshed Sal', shirt: 0x8a3b2e, hair: 0x3a2a1a, skin: SKINS[2],
    hairStyle: 'short', x: 1130, y: 1830, roam: 55,
    lines: [
      '*hic* …you ever REALLY look at a pong ball? I mean really?',
      "I'm not drunk, you're drunk. The FOUNTAIN'S drunk.",
      'One more an\' I\'m goin\' home. Said that six beers ago.',
      'I could beat anyone at pong right now. *falls over*',
      'The room\'s spinnin\' but in a GOOD way, y\'know?',
      'Shhh… the ball can hear us.',
      'Buy me a beer? …no? …fair.',
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
  // --- Tavern INTERIOR cast (stationary, off-map at TAVERN_INT; only reachable once you're inside) ---
  {
    id: 'bartender', name: 'Barkeep', shirt: 0x3a3f4a, hair: 0x2a2a2a, skin: SKINS[2],
    hairStyle: 'short', x: TAVERN_INT.x + TAVERN_INT.w / 2, y: TAVERN_INT.y + 95, roam: 0,
    lines: ['What\'ll it be?'], // talking to him opens the beer dialog (handled in triggerNear)
  },
  {
    id: 'bar-drunk', name: 'Wobbly Pete', shirt: 0x9c4a2e, hair: 0x4a3320, skin: SKINS[1],
    hairStyle: 'spiky', x: TAVERN_INT.x + TAVERN_INT.w * 0.30, y: TAVERN_INT.y + TAVERN_INT.h - 95, roam: 0,
    lines: [
      'heyyy… *hic*… you got beautiful paddles, anyone ever tell you that?',
      'I had ONE beer. …ok maybe the one was a six.',
      'The trick to pong is… is… wait where\'d the ball go.',
      'I\'m gonna challenge the fountain to a duel. it\'s been LOOKIN at me.',
      '*slides off stool* …I meant to do that.',
      'You ever notice the floor is also the ceiling if you lie down?',
    ],
  },
  {
    id: 'bar-suit', name: 'Stressed Exec', shirt: 0x202833, hair: 0x1a1a1a, skin: SKINS[3],
    hairStyle: 'short', glasses: true, x: TAVERN_INT.x + TAVERN_INT.w * 0.72, y: TAVERN_INT.y + TAVERN_INT.h - 120, roam: 0,
    lines: [
      'The market\'s down. The market\'s ALWAYS down. *downs drink*',
      'I had it all in OMEGADAVIS. Don\'t. Just don\'t.',
      'My portfolio and my marriage, both underwater. Same week.',
      'Do you know what a margin call FEELS like? I do now.',
      'I\'m not crying, it\'s the… the hops. It\'s the hops.',
      'One more and I\'m emailing my broker something I\'ll regret.',
    ],
  },
  {
    // The Fed Chair, stationed outside Parliament (x:470,y:420,w:340,h:240). Speaks in careful riddles.
    id: 'fed', name: 'The Fed', shirt: 0x222a36, hair: 0xb9bdc6, skin: SKINS[1], kind: 'fed',
    x: 640, y: 700, roam: 70,
    lines: [
      '*adjusts glasses* The committee has decided to hold rates steady.',
      'I see you\'ve been accumulating. Interesting choice. We are… watching.',
      'Market conditions warrant… continued observation.',
      'We have the tools. We will use them as needed.',
      'Wealth concentration is a number. Numbers can be adjusted.',
      'Broker fees fund the House. The House funds everyone. Circulate.',
      'Price stability is a marathon, not a pump.',
      'I cannot confirm or deny the existence of a stimulus check.',
    ],
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
  // --- Tavern interior state ---
  let inInterior = false;   // true while inside the Tavern (camera + collision switch to TAVERN_INT)
  let interiorBuilt = false;// the interior's Phaser props are lazily built on first entry
  let nearExit = false;     // standing on the interior's exit mat (Enter → leave)
  // --- jail state ---
  let nearJailed: { id: string; name: string } | null = null; // a jailed avatar in bail range (free players)
  let wasJailed = false;    // tracks the jailed transition so we can teleport in/out once

  // --- Robville land state ---
  const land = new Map<string, LandParcelView>(); // lot id → its live ownership/market state
  let myBankBought = 0;                            // lots I've bought from the bank so far
  let myBankCap = BANK_PARCEL_CAP;                 // the per-player bank cap (server-authoritative)
  let nearParcel: string | null = null;            // lot the avatar is currently standing on
  // Per-lot Phaser objects (the tinted pad + its hovering sign), built once in create().
  const parcelGfx = new Map<string, { pad: Phaser.GameObjects.Rectangle; sign: Phaser.GameObjects.Text }>();

  // --- in-world speech bubbles (lines said via the chat box pop briefly over the avatar) ---
  const SAY_MS = 5000;                                 // how long a speech bubble lingers
  const says = new Map<string, { text: string; until: number }>(); // avatar id → its current bubble

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

  // --- in-world chat (middle-left, no background — just floating text). It's the SAME chat as the
  // main game: lines stream in via feedChat() (mirrored from the server `chat` message). Press T to
  // pop a minimal input; what you send goes to the main chat (so it lands here) AND pops a speech
  // bubble over your avatar. Lines fade when you're idle; opening the input reveals the backlog. ---
  const FADE_HOLD = 7000, FADE_OUT = 1200; // ms a line stays solid, then fades out
  let chatActive = false;
  const fades = new WeakMap<HTMLElement, Animation>();
  const chatWrap = document.createElement('div');
  chatWrap.style.cssText =
    'position:absolute;left:16px;top:50%;transform:translateY(-50%);z-index:3;' +
    'width:min(42vw,440px);display:flex;flex-direction:column;pointer-events:none;';
  const chatLines = document.createElement('div');
  chatLines.style.cssText =
    'display:flex;flex-direction:column;gap:2px;max-height:26vh;overflow-y:auto;overflow-x:hidden;' +
    'scrollbar-width:thin;scrollbar-color:#ffffff44 transparent;';
  const chatInputRow = document.createElement('div');
  chatInputRow.style.cssText = 'display:none;align-items:center;gap:7px;margin-top:8px;';
  const chatPrompt = document.createElement('span');
  chatPrompt.textContent = 'Say:';
  chatPrompt.style.cssText =
    'color:#ffe14d;font:800 14px system-ui,sans-serif;text-shadow:0 1px 3px #000,0 0 5px #000;';
  const chatInput = document.createElement('input');
  chatInput.maxLength = 200;
  chatInput.autocomplete = 'off';
  chatInput.placeholder = 'press Enter to send · Esc to cancel';
  chatInput.style.cssText =
    'flex:1;pointer-events:auto;background:#0c1330b0;border:none;border-bottom:2px solid #ffe14d;' +
    'color:#fff;font:600 15px system-ui,sans-serif;padding:5px 8px;outline:none;border-radius:5px 5px 0 0;' +
    'text-shadow:0 1px 2px #000;';
  chatInputRow.append(chatPrompt, chatInput);
  chatWrap.append(chatLines, chatInputRow);
  overlay.appendChild(chatWrap);

  function armFade(el: HTMLElement) {
    const anim = el.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: FADE_HOLD / (FADE_HOLD + FADE_OUT) },
        { opacity: 0, offset: 1 },
      ],
      { duration: FADE_HOLD + FADE_OUT, easing: 'linear', fill: 'forwards' },
    );
    fades.set(el, anim);
    anim.onfinish = () => { if (!chatActive) el.style.visibility = 'hidden'; };
  }
  function pushChatLine(line: ChatLine, seed = false) {
    const row = document.createElement('div');
    row.style.cssText =
      'font:600 14px system-ui,sans-serif;line-height:1.35;word-break:break-word;' +
      'text-shadow:0 1px 3px #000,0 0 5px #000,0 0 2px #000;';
    const who = document.createElement('span');
    who.textContent = line.player ? `${line.from} (playing)` : line.from;
    who.style.color = line.color || '#cdd8f5';
    who.style.fontWeight = '800';
    const body = document.createElement('span');
    body.textContent = `: ${line.text}`;
    body.style.color = line.command ? '#ffd27d' : '#f3f6ff';
    row.append(who, body);
    chatLines.append(row);
    while (chatLines.childElementCount > 60) chatLines.firstElementChild!.remove();
    chatLines.scrollTop = chatLines.scrollHeight; // keep the newest line in view
    // Seeded backlog: park it hidden so it's instantly there when you press T, but doesn't flash on
    // entry. Live lines either show solid (if you're already typing) or fade after a beat.
    if (seed) { row.style.visibility = 'hidden'; row.style.opacity = '0'; }
    else if (chatActive) { row.style.opacity = '1'; }
    else { armFade(row); }
  }
  // Seed the recent backlog (hidden). Pressing T reveals it; otherwise it stays out of the way.
  for (const line of net.chatHistory()) pushChatLine(line, true);

  function openChat(initial = '') {
    if (chatActive || sayActive || talkOpen || dialogOpen) return;
    chatActive = true;
    keys.clear(); joyActive = false; // stop any walk-in-progress while typing
    for (const el of Array.from(chatLines.children) as HTMLElement[]) {
      fades.get(el)?.cancel();
      el.style.visibility = 'visible';
      el.style.opacity = '1';
    }
    chatLines.style.pointerEvents = 'auto'; // let the wheel/drag scroll the backlog while typing
    chatLines.scrollTop = chatLines.scrollHeight;
    chatInputRow.style.display = 'flex';
    prompt.style.display = 'none';
    chatBtn.style.display = 'none';
    chatInput.value = initial; // '/' opens pre-filled with a slash so you can type a command
    chatInput.focus();
    chatInput.setSelectionRange(initial.length, initial.length);
  }
  function closeChat() {
    if (!chatActive) return;
    chatActive = false;
    chatLines.style.pointerEvents = 'none'; // back to click-through so drag-to-walk works
    chatInputRow.style.display = 'none';
    chatBtn.style.display = 'flex';
    chatInput.blur();
    for (const el of Array.from(chatLines.children) as HTMLElement[]) {
      if (el.style.visibility === 'hidden') continue; // already faded out — leave it gone
      armFade(el);
    }
  }
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the world's capture handler from acting on what we type
    if (e.key === 'Enter') {
      const text = chatInput.value.trim();
      chatInput.value = '';
      if (text) {
        net.sendChat(text);                    // → main game chat → shows in this side feed (+ main chat)
        // Slash commands (e.g. /whisper) are private/functional — never pop a public speech bubble.
        if (!text.startsWith('/')) {
          const said = text.slice(0, WORLD_SAY_MAX);
          net.say(said);                       // → speech bubble over your avatar for everyone in-world
          // Optimistic local echo so your own bubble pops instantly (the server also echoes it back).
          says.set(net.selfId(), { text: said, until: performance.now() + SAY_MS });
        }
      }
      closeChat();
    } else if (e.key === 'Escape') {
      chatInput.value = '';
      closeChat();
    }
  });
  chatInput.addEventListener('blur', () => { if (chatActive) closeChat(); });

  // --- "Say something" popup (press Y): the classic bottom-center box that ONLY pops a speech
  // bubble over your avatar — it does NOT go into the chat feed. (T/'/' is the full chat.) ---
  let sayActive = false;
  const sayBox = document.createElement('input');
  sayBox.type = 'text';
  sayBox.maxLength = WORLD_SAY_MAX;
  sayBox.placeholder = 'Say something…  (Enter to send · Esc to cancel)';
  sayBox.style.cssText =
    'position:absolute;left:50%;bottom:84px;transform:translateX(-50%);display:none;width:min(440px,82vw);' +
    'background:#0c1330ee;color:#eef3ff;border:1px solid #3a4ea8;border-radius:10px;padding:11px 14px;' +
    'font-size:15px;font-family:inherit;outline:none;box-shadow:0 6px 20px #0008;z-index:4;';
  overlay.appendChild(sayBox);
  function openSay() {
    if (sayActive || chatActive || talkOpen || dialogOpen) return;
    sayActive = true;
    keys.clear(); joyActive = false; // stop walking while typing
    sayBox.value = '';
    sayBox.style.display = 'block';
    prompt.style.display = 'none';
    chatBtn.style.display = 'none';
    sayBox.focus();
  }
  function closeSay() {
    if (!sayActive) return;
    sayActive = false;
    sayBox.style.display = 'none';
    chatBtn.style.display = 'flex';
    sayBox.blur();
  }
  sayBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = sayBox.value.trim();
      if (text) {
        const said = text.slice(0, WORLD_SAY_MAX);
        net.say(said);                          // bubble only — not added to the chat feed
        says.set(net.selfId(), { text: said, until: performance.now() + SAY_MS }); // instant local echo
      }
      closeSay();
    } else if (e.key === 'Escape') {
      closeSay();
    }
  });
  sayBox.addEventListener('blur', () => { if (sayActive) closeSay(); });

  // Touch affordance: a little 💬 button (bottom-right) opens the chat for players without a
  // keyboard. Hidden while the box is already open.
  const chatBtn = document.createElement('button');
  chatBtn.type = 'button';
  chatBtn.textContent = '💬';
  chatBtn.title = 'Say something (T)';
  chatBtn.style.cssText =
    'position:absolute;right:14px;bottom:14px;display:flex;align-items:center;justify-content:center;' +
    'width:48px;height:48px;cursor:pointer;background:#243a6bcc;color:#cfe0ff;border:1px solid #3a558f;' +
    'border-radius:50%;font-size:22px;box-shadow:0 6px 20px #0008;z-index:3;';
  chatBtn.onclick = () => openChat();
  overlay.appendChild(chatBtn);

  // Jail banner (top-center) — shown while you're locked up. You can't bail yourself; you have to
  // wait for another player to walk up to the bars and post your bail.
  const jailBanner = document.createElement('div');
  jailBanner.style.cssText =
    'position:absolute;left:50%;top:64px;transform:translateX(-50%);display:none;align-items:center;gap:12px;' +
    'background:#3a1414ee;color:#ffd9d0;border:2px solid #8a2a2a;border-radius:12px;padding:12px 18px;' +
    'font-size:15px;font-weight:700;box-shadow:0 8px 28px #000a;z-index:3;max-width:80vw;text-align:center;';
  const jailText = document.createElement('span');
  jailText.textContent = `🚔 You're in the drunk tank. Only another player can post your ${BAIL_COST}🪙 bail — sit tight.`;
  jailBanner.append(jailText);
  overlay.appendChild(jailBanner);

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

  // --- minimap (always-on, top-right) + full map (toggled with M) ---
  const minimap = document.createElement('canvas');
  minimap.width = 200; minimap.height = Math.round(200 * WORLD.h / WORLD.w);
  minimap.style.cssText =
    'position:absolute;top:10px;right:10px;width:200px;border:2px solid #2a3550;border-radius:8px;' +
    'box-shadow:0 6px 20px #0008;background:#1a2a1c;cursor:pointer;z-index:3;';
  minimap.title = 'Open full map (M)';
  overlay.appendChild(minimap);
  const fullMap = document.createElement('div');
  fullMap.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:#060a12d8;z-index:9;flex-direction:column;gap:10px;';
  const fullMapCanvas = document.createElement('canvas');
  fullMapCanvas.style.cssText = 'border:2px solid #38508f;border-radius:10px;box-shadow:0 12px 40px #000b;background:#1a2a1c;max-width:92vw;max-height:80vh;';
  const fullMapTitle = document.createElement('div');
  fullMapTitle.textContent = '🗺️  TSONG WORLD';
  fullMapTitle.style.cssText = 'color:#e8eefc;font:700 20px ui-monospace,monospace;letter-spacing:1px;';
  const fullMapHint = document.createElement('div');
  fullMapHint.textContent = 'Press M or Esc to close';
  fullMapHint.style.cssText = 'color:#8aa0d8;font:600 12px ui-monospace,monospace;';
  fullMap.append(fullMapTitle, fullMapCanvas, fullMapHint);
  overlay.appendChild(fullMap);
  let fullMapOpen = false;
  let lastMapDraw = 0;
  minimap.addEventListener('click', () => toggleFullMap());
  fullMap.addEventListener('click', () => toggleFullMap());
  function toggleFullMap() {
    fullMapOpen = !fullMapOpen;
    fullMap.style.display = fullMapOpen ? 'flex' : 'none';
    if (fullMapOpen) {
      const sz = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.78 * WORLD.w / WORLD.h);
      fullMapCanvas.width = Math.round(sz); fullMapCanvas.height = Math.round(sz * WORLD.h / WORLD.w);
      drawMap(fullMapCanvas, true);
    }
  }
  // Draw the world to a canvas (scaled): grass, roads, plaza, building icons, jail, avatars, you.
  function drawMap(cv: HTMLCanvasElement, full: boolean) {
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width, H = cv.height, sx = W / WORLD.w, sy = H / WORLD.h;
    ctx.fillStyle = '#2f5d36'; ctx.fillRect(0, 0, W, H); // grass
    ctx.fillStyle = '#8a7448';                            // roads
    for (const r of ROADS) ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
    ctx.fillStyle = '#a8975e';                            // plaza
    ctx.beginPath(); ctx.arc(PLAZA.x * sx, PLAZA.y * sy, PLAZA.r * sx, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const b of WORLD_BUILDINGS) {                    // buildings: footprint + emoji icon
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x * sx, b.y * sy, Math.max(2, b.w * sx), Math.max(2, b.h * sy));
      const cx = (b.x + b.w / 2) * sx, cy = (b.y + b.h / 2) * sy;
      ctx.font = `${full ? 24 : 13}px serif`; ctx.fillText(b.emoji, cx, cy);
      if (full) { ctx.fillStyle = '#fff'; ctx.font = '700 12px system-ui'; ctx.fillText(b.name, cx, cy + 22); }
    }
    ctx.fillStyle = '#6b7079';                            // jail
    ctx.fillRect(JAIL.x * sx, JAIL.y * sy, JAIL.w * sx, JAIL.h * sy);
    ctx.font = `${full ? 22 : 12}px serif`; ctx.fillStyle = '#6b7079';
    ctx.fillText('🚔', (JAIL.x + JAIL.w / 2) * sx, (JAIL.y + JAIL.h / 2) * sy);
    ctx.fillStyle = 'rgba(220,230,255,0.55)';             // other avatars
    for (const a of others) { ctx.beginPath(); ctx.arc(a.x * sx, a.y * sy, full ? 4 : 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#ffe14d';                            // you (bright dot)
    ctx.beginPath(); ctx.arc(selfX * sx, selfY * sy, full ? 7 : 4, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = full ? 2 : 1.5; ctx.strokeStyle = '#1a1408'; ctx.stroke();
  }

  document.body.appendChild(overlay);

  // --- collision: keep the avatar/car outside every building rectangle ---
  function resolveCollisions(x: number, y: number, rad: number): { x: number; y: number; hit: boolean } {
    let hit = false;
    for (const b of WORLD_BUILDINGS as readonly Rect[]) {
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
    // ...and the jail's solid walls/bars (same circle-vs-rect pushout)
    for (const b of JAIL_WALLS) {
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
    if (inInterior || net.amJailed()) return; // no cars in the bar or the slammer
    if (!driving) {
      // Drunk driving (2+ beers): a coin-flip says whether the cops catch you.
      if (net.drunkLevel() >= 2) {
        if (Math.random() < 0.5) {
          // BUSTED → off to the drunk tank (server verifies + jails; a popup explains what happened).
          openDialog('🚨 BUSTED FOR DRUNK DRIVING',
            'The cops pulled you over before you even hit the gas. You\'ve been thrown in the drunk tank — ' +
            'you can\'t play, drive, or leave until another player posts your 500🪙 bail. Should\'ve called a cab.',
            []);
          net.jail();
          return;
        }
        // Got away with it — but driving this wasted is a white-knuckle disaster (see stepCar).
        flashHelp('😵 You slipped past the cops… but you can barely keep it on the road.');
      }
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
      ? 'W/S or ↑/↓ throttle · A/D or ←/→ steer · drag to drive · <b>F</b> get out · <b>T</b> chat · <b>Y</b> say'
      : 'WASD / arrows or drag to walk · <b>F</b> drive · <b>Space</b> enter · <b>T</b> chat · <b>Y</b> say';
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
      case 'bar': return '🍺 Enter the Tavern — grab a beer';
      case 'parliament': return '🏛️ Enter Parliament — play Nomic';
      case 'arcade': return '🎮 Enter the Arcade';
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
        { label: '🎯 Plinko',     onPick: () => { exit(); net.openFeature('plinko');    } },
        { label: '🏇 Horse Racing', onPick: () => { exit(); net.openFeature('horse');   } },
        { label: '🃏 Hi-Lo',      onPick: () => { exit(); net.openFeature('hilo');      } },
        { label: '💣 Mines',      onPick: () => { exit(); net.openFeature('mines');     } },
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
    if (kind === 'bar') { enterTavern(); return; }
    if (kind === 'parliament') {
      openDialog('🏛️ Parliament', 'The perpetual game of Nomic is in session. The only rule that cannot change is that the rules can.', [
        { label: '🏛️ Take your seat', onPick: () => { exit(); net.openParliament(); } },
      ]);
      return;
    }
    if (kind === 'arcade') {
      openDialog('🎮 The Arcade', 'Rows of glowing cabinets hum and bleep. Pick your poison.', [
        { label: '🏓 Davis Collects (Campaign)', onPick: () => { exit(); net.openFeature('campaign'); } },
        { label: '⌨️ Type or Die', onPick: () => { exit(); net.openFeature('typedie'); } },
        { label: '🏎️ Street Demons (Racing)', onPick: () => { exit(); net.openFeature('racing'); } },
        { label: '🥊 Super Tsong Bros', onPick: () => { exit(); net.openFeature('superbros'); } },
      ]);
      return;
    }
  }

  // --- Robville lots: each lot's tint + hovering sign reflect its ownership/market state. ---
  // bank-owned (for sale) = green · yours = gold · listed by a neighbor = amber · owned, not listed = blue.
  function refreshParcels() {
    for (const p of WORLD_PARCELS) {
      const g = parcelGfx.get(p.id);
      if (!g) continue;
      const st = land.get(p.id);
      let fill = 0x6fbf73, fa = 0.16, stroke = 0xeaf7ea, label = `🪧 ${PARCEL_PRICE.toLocaleString()}🪙`;
      if (st && st.ownerName) {
        if (st.mine) {
          fill = 0xe8c84b; fa = 0.22; stroke = 0xfff3c4;
          label = st.ask != null ? `🏠 Yours · ${st.ask.toLocaleString()}🪙` : '🏠 Your lot';
        } else if (st.ask != null) {
          fill = 0xe09a3a; fa = 0.20; stroke = 0xffe0b0;
          label = `🪧 ${st.ask.toLocaleString()}🪙\n${st.ownerName}`;
        } else {
          fill = 0x5a78c8; fa = 0.16; stroke = 0xcdd8f5;
          label = `🏠 ${st.ownerName}`;
        }
      }
      g.pad.setFillStyle(fill, fa);
      g.pad.setStrokeStyle(3, stroke, 0.9);
      g.sign.setText(label);
    }
  }

  // The bottom-of-screen prompt text when standing on a lot.
  function parcelPrompt(id: string): string {
    const st = land.get(id);
    if (!st || !st.ownerName) return `🏡 Buy this lot — ${PARCEL_PRICE.toLocaleString()}🪙`;
    if (st.mine) return st.ask != null ? '🏠 Your lot — manage listing' : '🏠 Your lot — sell?';
    if (st.ask != null) return `🏡 Buy ${st.ownerName}'s lot — ${st.ask.toLocaleString()}🪙`;
    return `🏠 ${st.ownerName}'s lot`;
  }

  // Walk onto a lot + press E → this dialog. Branches on who owns it (bank / you / a neighbor).
  function openLandDialog(id: string) {
    if (!WORLD_PARCELS.some((x) => x.id === id)) return;
    const st = land.get(id);
    // Empty lot, owned by the bank → buy it (subject to the anti-monopoly cap).
    if (!st || !st.ownerName) {
      if (myBankBought >= myBankCap) {
        openDialog('🏦 Robville Land Office',
          `You've hit the bank's limit of ${myBankCap} lot${myBankCap === 1 ? '' : 's'} per buyer. You can still buy any number of lots directly from other owners.`, []);
        return;
      }
      openDialog('🏡 Empty Lot for Sale',
        `A tidy patch of Robville, yours from the bank for ${PARCEL_PRICE.toLocaleString()}🪙. (You've bought ${myBankBought} of your ${myBankCap} from the bank.)`, [
        { label: `🤝 Buy this lot — ${PARCEL_PRICE.toLocaleString()}🪙`, onPick: () => { closeDialog(); net.landBuyBank(id); } },
      ]);
      return;
    }
    // Your own lot → manage the listing.
    if (st.mine) {
      const choices: { label: string; onPick: () => void }[] = [
        { label: st.ask != null ? '🏷️ Change asking price…' : '🏷️ List for sale…', onPick: () => {
          const raw = window.prompt('Set an asking price for your Robville lot (in coins):', st.ask != null ? String(st.ask) : '2000');
          const ask = Math.floor(Number(raw));
          if (raw != null && Number.isFinite(ask) && ask > 0) net.landList(id, ask);
          closeDialog();
        } },
      ];
      if (st.ask != null) choices.push({ label: '🚫 Take off the market', onPick: () => { closeDialog(); net.landUnlist(id); } });
      openDialog('🏠 Your Robville Lot',
        st.ask != null ? `Listed for sale at ${st.ask.toLocaleString()}🪙.` : "A fine plot. Build a house here soon™ — for now you can put it on the market.", choices);
      return;
    }
    // A neighbor's lot — buyable only if they've listed it (no bank cap on private sales).
    if (st.ask != null) {
      openDialog(`🏡 ${st.ownerName}'s Lot`,
        `${st.ownerName} is asking ${st.ask.toLocaleString()}🪙. No bank limit when you buy from a neighbor.`, [
        { label: `🤝 Buy for ${st.ask.toLocaleString()}🪙`, onPick: () => { closeDialog(); net.landBuy(id); } },
      ]);
    } else {
      openDialog(`🏠 ${st.ownerName}'s Lot`, `This lot belongs to ${st.ownerName}, and it isn't for sale right now.`, []);
    }
  }

  // --- Tavern interior: a walkable room off the map. Entering swaps the camera bounds + collision
  // to TAVERN_INT and drops you by the door; the bartender (an NPC) sells beer; an exit mat leaves. ---
  function buildInterior(sc: Phaser.Scene) {
    if (interiorBuilt) return;
    interiorBuilt = true;
    const T = TAVERN_WALL, ix = TAVERN_INT.x, iy = TAVERN_INT.y, iw = TAVERN_INT.w, ih = TAVERN_INT.h;
    // tiled surface helper (floor / wall / rug), tiles repeat at TEXEL scale to match the world
    const tile = (key: string, x: number, y: number, w: number, h: number, depth: number) =>
      sc.add.tileSprite(x, y, w, h, key).setOrigin(0, 0).setTileScale(TEXEL, TEXEL).setDepth(depth);
    // baseline-anchored pixel prop (y is the floor contact point; depth sorts with the avatar)
    const prop = (key: string, x: number, y: number, depth = y) =>
      sc.add.image(x, y, key).setScale(TEXEL).setOrigin(0.5, 1).setDepth(depth);

    // dark surround so a large viewport never shows green grass past the room edges
    sc.add.rectangle(ix - 800, iy - 800, iw + 1600, ih + 1600, 0x140d08).setOrigin(0, 0).setDepth(iy - 1000);
    tile('w-tav-floor', ix, iy, iw, ih, iy - 900);                          // plank floor
    tile('w-tav-rug', ix + iw / 2 - 190, iy + ih - 250, 380, 190, iy - 880); // hearth rug
    // back + side walls (drawn; collision is a clamp to the inset play area)
    tile('w-tav-wall', ix, iy, iw, 76, iy - 800);                           // back wall band
    tile('w-tav-wall', ix, iy, T + 10, ih, iy - 800);                       // left wall
    tile('w-tav-wall', ix + iw - T - 10, iy, T + 10, ih, iy - 800);         // right wall
    tile('w-tav-wall', ix, iy + ih - T, iw, T, iy - 790);                   // bottom baseboard
    // window + warm wall lanterns on the back wall
    sc.add.image(ix + 130, iy + 50, 'w-tav-window').setScale(TEXEL).setOrigin(0.5, 0.5).setDepth(iy - 795);
    const lantern = (x: number) => {
      sc.add.circle(x, iy + 44, 30, 0xffd98a, 0.16).setDepth(iy - 794);
      sc.add.image(x, iy + 44, 'w-tav-lantern').setScale(TEXEL).setOrigin(0.5, 0.5).setDepth(iy - 793);
    };
    lantern(ix + iw * 0.5); lantern(ix + iw * 0.78);
    // the bar: a shelf of bottles, then the paneled counter in front of it
    const barX = ix + 210, barW = iw - 420;
    tile('w-tav-shelf', barX, iy + 70, barW, 32, iy + 84);                  // bottle shelf
    tile('w-tav-bar', barX, iy + 120, barW, 46, iy + 166);                 // counter (front baseline = depth)
    // barrels stacked in the left corner
    prop('w-tav-barrel', ix + 70, iy + ih - 60); prop('w-tav-barrel', ix + 104, iy + ih - 46);
    prop('w-tav-barrel', ix + 86, iy + ih - 96);
    // stools at the bar + a couple of tables with mugs
    prop('w-tav-stool', barX + 80, iy + 196); prop('w-tav-stool', barX + barW - 80, iy + 196);
    const table = (cx: number, cy: number) => {
      prop('w-tav-table', cx, cy);
      prop('w-tav-stool', cx - 44, cy + 8, cy + 8); prop('w-tav-stool', cx + 44, cy + 8, cy + 8);
    };
    table(ix + iw * 0.30, iy + ih - 130); table(ix + iw * 0.72, iy + ih - 165);
    // exit mat by the door
    tile('w-tav-rug', ix + iw / 2 - 70, iy + ih - T - 70, 140, 60, iy - 870);
    sc.add.text(ix + iw / 2, iy + ih - T - 38, '🚪 EXIT', { fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold', color: '#ffe2b0', stroke: '#1a0f08', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(iy - 200);
  }
  function enterTavern() {
    const sc = petScene; if (!sc) return;
    buildInterior(sc);
    enterChime();
    inInterior = true;
    driving = false; vx = 0; vy = 0; // you're on foot inside
    keys.clear(); joyActive = false;
    selfX = TAVERN_INT.x + TAVERN_INT.w / 2;
    selfY = TAVERN_INT.y + TAVERN_INT.h - 180; // by the door, clear of the exit mat
    mainCam?.setBounds(TAVERN_INT.x, TAVERN_INT.y, TAVERN_INT.w, TAVERN_INT.h);
  }
  function leaveTavern() {
    inInterior = false;
    nearExit = false;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    const bar = WORLD_BUILDINGS.find((b) => b.kind === 'bar');
    if (bar) { selfX = bar.x + bar.w / 2; selfY = bar.y + bar.h + 44; } // step back out the door
    enterChime();
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
    // The bartender takes your order (the beer dialog) instead of plain chatter.
    if (nearNpc && nearNpc.def.id === 'bartender') { orderBeer(); return; }
    if (nearNpc) { startTalk(nearNpc); return; }
    if (nearExit) { leaveTavern(); return; }
    if (nearJailed) { net.bail(nearJailed.id); return; } // post their bail
    const b = WORLD_BUILDINGS.find((x) => x.id === nearId);
    if (b) { enterBuilding(b.kind); return; }
    if (nearParcel) openLandDialog(nearParcel); // walk onto a Robville lot → buy/sell it
  }

  // The Barkeep's order dialog: a quip + a buy button. Buying keeps you IN the bar (closeDialog,
  // not exit) — it just sends the purchase; the wallet/drunk updates arrive from the server.
  function orderBeer() {
    const lvl = net.drunkLevel();
    if (lvl >= 6) {
      openDialog('🍺 Barkeep', "\"You're done, pal. Cut off. Go home.\"", []);
      return;
    }
    const quips = [
      '"What\'ll it be?"', '"Rough day? …yeah, you have the look."',
      '"You sure? You\'re lookin\' a little sideways already."', '"First one\'s still 20. So\'s the sixth."',
      '"Drink up. The House thanks you for your patronage."',
    ];
    openDialog('🍺 Barkeep', quips[Math.floor(Math.random() * quips.length)], [
      { label: '🍺 Buy a beer (20🪙)', onPick: () => { closeDialog(); net.buyBeer(); showToast('🍺 *glug glug glug*'); } },
    ]);
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
    // While a chat/say input is open it owns the keyboard — let every keystroke (incl. Esc/Enter,
    // handled by the input itself) flow through untouched, and never treat them as movement.
    if (chatActive || sayActive) return;
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      if (fullMapOpen) toggleFullMap(); else if (talkOpen) npcClose?.(); else if (dialogOpen) closeDialog(); else exit();
      return;
    }
    if (k === 'm') { e.preventDefault(); e.stopPropagation(); toggleFullMap(); return; } // M → full map
    // T opens the chat input; '/' opens it pre-filled with a slash (for chat commands). Both swallow
    // the key so it isn't typed into the box twice.
    if (k === 't' && !talkOpen && !dialogOpen) { e.preventDefault(); e.stopPropagation(); openChat(); return; }
    if (k === '/' && !talkOpen && !dialogOpen) { e.preventDefault(); e.stopPropagation(); openChat('/'); return; }
    // Y opens the classic "Say something" popup — a speech bubble over your head, NOT into the chat.
    if (k === 'y' && !talkOpen && !dialogOpen) { e.preventDefault(); e.stopPropagation(); openSay(); return; }
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
      if (nearId || nearNpc || nearNetizen || nearParcel) triggerNear();
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
    // A tap anywhere but the open input dismisses it (and doesn't also start a walk).
    if (chatActive) { if (!(e.target instanceof Node && chatWrap.contains(e.target))) closeChat(); return; }
    if (sayActive) { if (e.target !== sayBox) closeSay(); return; }
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
    // Drunk stagger: rotate your intended heading by a wandering angle that grows with the level, so
    // walking a straight line gets harder the more you've had.
    const drunk = net.drunkLevel();
    if (drunk > 0) {
      const w = Date.now() / 1000;
      const wob = (Math.sin(w * 3.1) * 0.06 + Math.sin(w * 1.3 + 1) * 0.03) * drunk; // radians, up to ~0.54 at lvl 6
      const ca = Math.cos(wob), sa = Math.sin(wob);
      const ndx = dx * ca - dy * sa, ndy = dx * sa + dy * ca;
      dx = ndx; dy = ndy;
    }
    facing = Math.atan2(dy, dx);
    if (inInterior) {
      // inside the Tavern: no town collision, just clamp to the inset play area
      selfX = clamp(selfX + dx * SPEED * dt, TAVERN_INT.x + TAVERN_WALL + R, TAVERN_INT.x + TAVERN_INT.w - TAVERN_WALL - R);
      selfY = clamp(selfY + dy * SPEED * dt, TAVERN_INT.y + TAVERN_WALL + R, TAVERN_INT.y + TAVERN_INT.h - TAVERN_WALL - R);
      stepSound();
      return;
    }
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
    // Drunk driving (you got away with the stop, but you're hammered): a violent, ever-worsening
    // weave layered on top, so keeping it on the road is brutal. Scales hard with the booze.
    const drunk = net.drunkLevel();
    if (drunk > 0) {
      const w = Date.now() / 1000;
      facing += (Math.sin(w * 3.7) * 0.9 + Math.sin(w * 9.3 + 1.7) * 0.6) * drunk * dt;
    }

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
    // nearest building door — skipped inside the Tavern (town buildings are off-map from here)
    let best: string | null = null;
    let bestD = Infinity;
    if (!inInterior) {
      for (const b of WORLD_BUILDINGS) {
        const d = distToBuilding(b);
        const reach = (driving ? CAR_LEN * 0.5 : R) + TRIGGER_PAD;
        if (d <= reach && d < bestD) { bestD = d; best = b.id; }
      }
    }
    nearId = best;
    // nearest townsperson (can't chat from inside a car) — buildings win ties.
    nearNpc = null;
    nearNetizen = null;
    if (!best && !driving) {
      let bD = R + TRIGGER_PAD + (inInterior ? 80 : 12); // reach across the bar counter when inside
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
    // Inside the Tavern: standing on the exit mat (and not chatting up someone) → leave prompt.
    nearExit = false;
    if (inInterior && !nearNpc) {
      const mx = TAVERN_INT.x + TAVERN_INT.w / 2, my = TAVERN_INT.y + TAVERN_INT.h - TAVERN_WALL - 50;
      if (Math.abs(selfX - mx) < 110 && Math.abs(selfY - my) < 80) nearExit = true;
    }
    // A jailed avatar within reach (and we're free) → offer to post their bail.
    nearJailed = null;
    if (!best && !nearNpc && !nearNetizen && !driving && !net.amJailed() && !inInterior) {
      let jD = R + TRIGGER_PAD + 90; // reach through the bars
      for (const a of others) {
        if (!a.jailed) continue;
        const d = Math.hypot(a.x - selfX, a.y - selfY);
        if (d < jD) { jD = d; nearJailed = { id: a.id, name: a.name }; }
      }
    }
    // A Robville lot you're standing on (or right beside) → buy/sell prompt. Lowest priority so it
    // never steals focus from a door, person, or jailed neighbor.
    nearParcel = null;
    if (!best && !nearNpc && !nearNetizen && !nearJailed && !inInterior && !net.amJailed()) {
      let pD = Infinity;
      for (const p of WORLD_PARCELS) {
        if (!pointInRect(selfX, selfY, p, R + 8)) continue; // must be on (or hugging) the lot
        const d = Math.hypot(p.cx - selfX, p.cy - selfY);
        if (d < pD) { pD = d; nearParcel = p.id; }
      }
    }
    if (best) {
      const b = WORLD_BUILDINGS.find((x) => x.id === best)!;
      prompt.textContent = labelFor(b.kind);
    } else if (nearNetizen) {
      const a = others.find((o) => o.id === nearNetizen);
      prompt.textContent = `💬 Talk to ${a?.name ?? 'Netizen'}`;
    } else if (nearNpc) {
      prompt.textContent = nearNpc.def.id === 'bartender' ? '🍺 Order from the Barkeep' : `💬 Talk to ${nearNpc.def.name}`;
    } else if (nearExit) {
      prompt.textContent = '🚪 Leave the Tavern';
    } else if (nearJailed) {
      prompt.textContent = `🔓 Bail out ${nearJailed.name} (${BAIL_COST}🪙)`;
    } else if (nearParcel) {
      prompt.textContent = parcelPrompt(nearParcel);
    }
    prompt.style.display = (nearId || nearNpc || nearNetizen || nearExit || nearJailed || nearParcel) && !dialogOpen && !talkOpen ? 'block' : 'none';
  }

  function maybeSendMove(now: number) {
    if (inInterior) return; // don't stream off-map interior coords — others see you parked at the door
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
    bubbleBg: Phaser.GameObjects.NineSlice; // rounded panel drawn behind the bubble text
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
  // A flock of birds that occasionally drifts across the sky (camera-fixed, gentle flap). Ambience only.
  const birds: { img: Phaser.GameObjects.Image; vx: number; phase: number }[] = [];
  let nextBirdsAt = 0;
  // Warm/neon glows that fade in after dark (alpha = nightFactor × max, with a per-light fire flicker).
  const nightLights: { obj: Phaser.GameObjects.Image; max: number; phase: number; fire: number }[] = [];
  // Casino marquee: colorful bulbs that chase around the building + cycle colors (lit day & night).
  const casinoBulbs: { obj: Phaser.GameObjects.Image; i: number }[] = [];
  const CASINO_PAL = [0xff2a6a, 0xffd11a, 0x2ad1ff, 0xb23aff, 0x3aff7a, 0xff7a1a];
  // Day/night overlays (camera-fixed, set in create(), animated in update()).
  let nightOverlay: Phaser.GameObjects.Rectangle | null = null;
  let warmOverlay: Phaser.GameObjects.Rectangle | null = null;
  let drunkOverlay: Phaser.GameObjects.Rectangle | null = null; // amber booze haze, alpha scales with drunk level
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
  // Speech-bubble panel ('w-bubble' 9-slice): authored big (radius 16, corner region 24) then shrunk
  // on the avatar so the on-screen radius is small (~16·0.3·ZOOM ≈ 10px, like the '/' chat popup) and
  // the border stays a thin hairline (~3·0.3·ZOOM ≈ 1.8px).
  const BUBBLE_CORNER = 24;
  const BUBBLE_BG_SCALE = 0.3;

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

    // --- The Fed Chair: dark suit, grey comb-over, glasses, a little flag pin. Picture of restraint. ---
    {
      const SUIT = 0x222a36, SUIT_D = 0x161c26, SHIRT = 0xe8ecf2, TIE = 0x8a1f2a, SKN = 0xe7c2a0;
      const HAIR = 0xb9bdc6, GLASS = 0x2a2f3a, FLAG = 0x3a5bbf;
      g.clear();
      px(5, 13, 2, 3, SUIT_D); px(8, 13, 2, 3, SUIT_D); px(5, 15, 2, 1, 0x12161e); px(8, 15, 2, 1, 0x12161e); // trousers + shoes
      px(4, 7, 7, 6, SUIT); px(4, 12, 7, 1, SUIT_D);          // jacket
      px(6, 7, 3, 6, SHIRT); px(7, 7, 1, 4, TIE);             // shirt placket + tie
      px(3, 8, 1, 4, SUIT); px(11, 8, 1, 4, SUIT);            // sleeves
      px(4, 7, 1, 1, FLAG);                                   // lapel flag pin
      px(5, 3, 5, 4, SKN);                                    // head
      px(5, 2, 5, 1, HAIR); px(4, 3, 1, 2, HAIR); px(9, 3, 1, 2, HAIR); px(5, 3, 4, 1, HAIR); // neat comb-over
      px(5, 4, 4, 1, GLASS); px(5, 5, 1, 1, GLASS); px(8, 5, 1, 1, GLASS); // glasses
      px(6, 6, 3, 1, 0x6b4f3a);                               // measured frown
      g.generateTexture('w-fed', 16, 16);
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
    {
      // distant bird — a little dark seagull chevron (11×5), flap is done by squashing scaleY
      const B = 0x2a2f3a;
      g.clear();
      px(0, 3, 2, 1, B); px(2, 2, 2, 1, B); px(4, 1, 3, 1, B); px(7, 2, 2, 1, B); px(9, 3, 2, 1, B);
      g.generateTexture('w-bird', 11, 5);
    }

    // ============================================================================================
    // TAVERN INTERIOR PROPS — cozy SNES/FF6 pixel art, baked once and assembled in buildInterior().
    // ============================================================================================
    {
      // wood plank floor tile (16×16), warm browns with seams + a little grain
      const F1 = 0x8a5a32, F2 = 0x7a4d2a, SEAM = 0x5c3a20, GR = 0x96663a;
      g.clear();
      px(0, 0, 16, 8, F1); px(0, 8, 16, 8, F2);
      px(0, 7, 16, 1, SEAM); px(0, 15, 16, 1, SEAM);
      px(5, 0, 1, 8, SEAM); px(11, 8, 1, 8, SEAM);          // staggered plank ends
      px(2, 2, 3, 1, GR); px(9, 3, 4, 1, GR); px(6, 10, 4, 1, GR); px(12, 12, 2, 1, GR); // grain flecks
      g.generateTexture('w-tav-floor', 16, 16);
    }
    {
      // patterned rug tile (16×16): deep red field, cream border + diamond motif
      const RUG = 0x7e2b2b, RUG_D = 0x5e1d1d, CREAM = 0xd9b779, GOLD = 0xb98b3a;
      g.clear();
      px(0, 0, 16, 16, RUG); px(0, 0, 16, 2, CREAM); px(0, 14, 16, 2, CREAM);
      px(0, 0, 2, 16, CREAM); px(14, 0, 2, 16, CREAM);
      px(2, 2, 12, 12, RUG_D);
      px(7, 4, 2, 2, GOLD); px(5, 6, 2, 2, GOLD); px(9, 6, 2, 2, GOLD); px(7, 8, 2, 2, GOLD); // diamond
      g.generateTexture('w-tav-rug', 16, 16);
    }
    {
      // dark wood wall panel tile (16×16) for the top wall band
      const W1 = 0x4a3220, W2 = 0x3c281a, LINE = 0x2a1b10, HI = 0x5a3e28;
      g.clear();
      px(0, 0, 16, 16, W1); px(0, 0, 16, 1, HI);
      px(0, 0, 8, 16, W1); px(8, 0, 8, 16, W2);
      px(7, 0, 1, 16, LINE); px(15, 0, 1, 16, LINE); px(0, 15, 16, 1, LINE);
      g.generateTexture('w-tav-wall', 16, 16);
    }
    {
      // bar counter segment (24×20): wood front with a paneled face + a lighter countertop lip
      const C = 0x6e4827, C_D = 0x553619, TOP = 0x8a5e34, TOP_HI = 0xa6764a, PANEL = 0x4d3016;
      g.clear();
      px(0, 0, 24, 4, TOP); px(0, 0, 24, 1, TOP_HI); px(0, 4, 24, 1, C_D); // countertop + lip
      px(0, 5, 24, 15, C);
      px(2, 8, 8, 9, PANEL); px(14, 8, 8, 9, PANEL);        // two recessed panels
      px(11, 5, 2, 15, C_D);                                 // center stile
      g.generateTexture('w-tav-bar', 24, 20);
    }
    {
      // back shelf with bottles (28×16)
      const SH = 0x3a2616, SH_HI = 0x4d3320;
      g.clear();
      px(0, 11, 28, 3, SH); px(0, 11, 28, 1, SH_HI);         // shelf board
      const cols = [0x5fae6f, 0xb9794a, 0x8aa0d8, 0xd0607a, 0x6fae6f, 0xc9a23a];
      for (let i = 0; i < 6; i++) { const x = 2 + i * 4.5 | 0; px(x, 4, 2, 7, cols[i]); px(x, 3, 2, 1, 0xffffff); } // bottles + glint
      g.generateTexture('w-tav-shelf', 28, 16);
    }
    {
      // barrel/keg (16×18): banded cask
      const BR = 0x8a5a30, BR_D = 0x6e4423, BAND = 0x42566a, BAND_HI = 0x5b7088, LID = 0x9c6a3c;
      g.clear();
      px(2, 1, 12, 16, BR); px(2, 1, 12, 2, LID); px(3, 0, 10, 1, LID);
      px(1, 4, 14, 2, BR); px(1, 11, 14, 2, BR);             // bulge
      px(2, 5, 12, 1, BAND); px(2, 12, 12, 1, BAND); px(2, 5, 12, 1, BAND_HI);
      px(13, 2, 1, 14, BR_D);                                 // shadow side
      g.generateTexture('w-tav-barrel', 16, 18);
    }
    {
      // round table top with a frothy mug on it (20×16)
      const T = 0x7a4d2a, T_HI = 0x96663a, T_SH = 0x5c3a20, MUG = 0xcaa05a, FOAM = 0xf3ead2;
      g.clear();
      px(3, 4, 14, 8, T); px(3, 4, 14, 2, T_HI); px(3, 11, 14, 1, T_SH);
      px(2, 6, 1, 4, T); px(17, 6, 1, 4, T);                 // rounded edges
      px(9, 2, 4, 4, MUG); px(9, 1, 4, 1, FOAM); px(13, 3, 1, 2, MUG); // little mug + foam + handle
      g.generateTexture('w-tav-table', 20, 16);
    }
    {
      // stool (10×10)
      const S = 0x6e4827, S_D = 0x523417;
      g.clear();
      px(1, 2, 8, 3, S); px(1, 2, 8, 1, 0x8a5e34); px(2, 5, 1, 4, S_D); px(7, 5, 1, 4, S_D);
      g.generateTexture('w-tav-stool', 10, 10);
    }
    {
      // wall lantern (10×12): little caged candle that throws warm light (glow added separately)
      const FR = 0x2a1c10, GLASS = 0xffd98a, FLAME = 0xffb43a;
      g.clear();
      px(3, 0, 4, 1, FR); px(4, 1, 2, 1, FR);                 // hook
      px(2, 2, 6, 8, FR); px(3, 3, 4, 6, GLASS); px(4, 5, 2, 3, FLAME); px(4, 4, 2, 1, 0xfff0c0);
      px(2, 9, 6, 1, FR);
      g.generateTexture('w-tav-lantern', 10, 12);
    }
    {
      // window onto a warm dusk sky (24×20)
      const FRM = 0x3a2616, SKY = 0x3d5a8a, SKY2 = 0x8a6a9a, GLOW = 0xe7b97a;
      g.clear();
      px(0, 0, 24, 20, FRM);
      px(2, 2, 20, 16, SKY); px(2, 12, 20, 6, SKY2); px(2, 16, 20, 2, GLOW); // sky gradient + horizon glow
      px(11, 2, 2, 16, FRM); px(2, 9, 20, 2, FRM);            // muntins
      g.generateTexture('w-tav-window', 24, 20);
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

    // --- speech-bubble panel: a rounded rect drawn on a 2D canvas (which anti-aliases properly,
    // unlike Phaser's pixel-art Graphics) and used as a LINEAR-filtered 9-slice. That keeps the
    // corners smooth at any bubble size and any camera zoom, instead of the chunky vector jaggies. ---
    {
      const S = 96, rad = 16, bw = 3; // authored big so the AA is dense; scaled down on the avatar
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(27,37,66,0.97)';  // #1b2542 panel (nearly opaque)
        ctx.strokeStyle = 'rgba(11,16,32,0.9)'; // #0b1020 hairline border
        ctx.lineWidth = bw;
        const o = bw / 2;
        ctx.beginPath();
        ctx.roundRect(o, o, S - bw, S - bw, rad);
        ctx.fill();
        ctx.stroke();
      }
      scene.textures.addCanvas('w-bubble', cv);
      scene.textures.get('w-bubble').setFilter(Phaser.Textures.FilterMode.LINEAR);
    }

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

      // --- the drunk tank: a tiny barred stone cell; jailed avatars are visible behind the bars ---
      {
        const { x, y, w, h } = JAIL, T = JAIL_WALL;
        sc.add.rectangle(x + 12, y + 16, w, h, 0x0a1226, 0.32).setOrigin(0, 0).setDepth(y + h - 1); // ground shadow
        sc.add.rectangle(x, y, w, h, 0x6b7079).setOrigin(0, 0).setDepth(y - 2);          // floor base
        sc.add.rectangle(x + T, y + T, w - 2 * T, h - 2 * T, 0x7c828c).setOrigin(0, 0).setDepth(y - 1); // cell floor
        const wallC = 0x3a3e46, wallHi = 0x4a4f59;
        sc.add.rectangle(x, y, w, T, wallC).setOrigin(0, 0).setDepth(y); sc.add.rectangle(x, y, w, 3, wallHi).setOrigin(0, 0).setDepth(y); // back
        sc.add.rectangle(x, y, T, h, wallC).setOrigin(0, 0).setDepth(y);                  // left
        sc.add.rectangle(x + w - T, y, T, h, wallC).setOrigin(0, 0).setDepth(y);          // right
        // front face = metal bars (in front of the jailed avatar so they read as "behind bars")
        const barC = 0xaab0ba, fd = y + h + 1;
        sc.add.rectangle(x, y + h - T, w, 4, barC).setOrigin(0, 0).setDepth(fd);          // top rail
        sc.add.rectangle(x, y + h - 5, w, 5, 0x2a2e36).setOrigin(0, 0).setDepth(fd);      // bottom rail
        for (let bx = x + T; bx <= x + w - T; bx += 17) sc.add.rectangle(bx, y + 8, 4, h - 14, barC).setOrigin(0, 0).setDepth(fd);
        sc.add.text(x + w / 2, y - 6, '🚔 JAIL', { fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontStyle: 'bold', color: '#ffffff', stroke: '#0b1020', strokeThickness: 5, resolution: 2 }).setOrigin(0.5, 1).setDepth(100000);
      }

      // --- Robville: the suburban neighborhood (cul-de-sac planters + buyable lots) ---
      {
        // A leafy planter island in the middle of each cul-de-sac bulb.
        for (const b of ROBVILLE_BULBS) {
          sc.add.image(b.cx, b.cy, 'w-shadow').setScale(TEXEL * 1.6).setOrigin(0.5, 0.4).setDepth(b.cy - 1).setAlpha(0.4);
          sc.add.image(b.cx, b.cy, 'townFrames', TT.bush).setScale(TEXEL * 1.5).setOrigin(0.5, 0.85).setDepth(b.cy);
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + 0.4;
            sc.add.image(b.cx + Math.cos(a) * 30, b.cy + Math.sin(a) * 22, 'townFrames', TT.mushroom)
              .setScale(TEXEL * 0.9).setOrigin(0.5, 0.85).setDepth(b.cy + Math.sin(a) * 22);
          }
        }
        // Each buyable lot: a tinted pad with a picket-fence border + a hovering sign. Colors/text are
        // set by refreshParcels() from the live land book (here we just build the objects).
        for (const p of WORLD_PARCELS) {
          const pad = sc.add.rectangle(p.x, p.y, p.w, p.h, 0x6fbf73, 0.16).setOrigin(0, 0).setDepth(-5);
          pad.setStrokeStyle(3, 0xeaf7ea, 0.9);
          const sign = sc.add.text(p.cx, p.y - 6, '', {
            fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold',
            color: '#ffffff', stroke: '#13240f', strokeThickness: 4, align: 'center', resolution: 2,
          });
          sign.setOrigin(0.5, 1).setDepth(100000);
          parcelGfx.set(p.id, { pad, sign });
        }
        refreshParcels();
        // Neighborhood entrance sign where the avenue meets the residential spine.
        sc.add.text(3850, 1150, '🏘️ ROBVILLE', {
          fontFamily: 'system-ui, sans-serif', fontSize: '17px', fontStyle: 'bold',
          color: '#ffffff', stroke: '#0b1020', strokeThickness: 5, resolution: 2,
        }).setOrigin(0.5, 1).setDepth(100000);
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

      // amber booze haze that fades in with drunkenness (above everything else)
      const booze = sc.add.rectangle(0, 0, 10, 10, 0xd98b2b).setOrigin(0).setScrollFactor(0)
        .setBlendMode(Phaser.BlendModes.MULTIPLY).setAlpha(0).setDepth(50004);
      drunkOverlay = booze;

      const fitAtmo = (w: number, h: number) => {
        warm.setSize(w, h); vig.setDisplaySize(w, h); night.setSize(w, h); booze.setSize(w, h);
      };
      fitAtmo(sc.scale.width, sc.scale.height);
      sc.scale.on('resize', (gs: Phaser.Structs.Size) => fitAtmo(gs.width, gs.height));

      // --- cozy night lighting: soft glows that bloom after dark (drawn ABOVE the night wash so they
      // shine through it). A soft radial-gradient texture, tinted + ADD-blended per light. ---
      const GLOW = 'w-glow';
      if (!sc.textures.exists(GLOW)) {
        const sz = 128;
        const ct = sc.textures.createCanvas(GLOW, sz, sz);
        if (ct) {
          const c2 = ct.getContext();
          const g2 = c2.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
          g2.addColorStop(0, 'rgba(255,255,255,1)');
          g2.addColorStop(0.45, 'rgba(255,255,255,0.45)');
          g2.addColorStop(1, 'rgba(255,255,255,0)');
          c2.fillStyle = g2; c2.fillRect(0, 0, sz, sz); ct.refresh();
        }
      }
      // `fire` is the flicker depth (0 = steady neon, ~0.2 = lively firelight). Each light gets its
      // own random phase so they shimmer out of sync, like real flames.
      const glow = (x: number, y: number, radius: number, color: number, max: number, fire = 0.05) => {
        const im = sc.add.image(x, y, GLOW).setTint(color).setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(50003).setAlpha(0).setDisplaySize(radius * 2, radius * 2);
        nightLights.push({ obj: im, max, phase: hash(x | 0, y | 0) * 6.28, fire });
      };
      // a little lamp post: dark pole + head (always visible) and a warm bulb glow that flickers like a flame
      const lampPost = (x: number, y: number) => {
        sc.add.rectangle(x, y, 4, 30, 0x26221c).setOrigin(0.5, 1).setDepth(y);
        sc.add.rectangle(x, y - 30, 11, 7, 0x363029).setOrigin(0.5, 0.5).setDepth(y);
        sc.add.circle(x, y - 30, 3, 0xffe7b0).setDepth(y);
        glow(x, y - 30, 34, 0xffb347, 1.05, 0.2); // warm, fiery flicker
      };
      const bm = (b: WorldBuilding) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });
      const byKind = (k: string) => WORLD_BUILDINGS.find((b) => b.kind === k);
      // Plaza: a ring of warm lamp posts around the fountain — the cozy heart of town at night.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        lampPost(PLAZA.x + Math.cos(a) * (PLAZA.r - 14), PLAZA.y + Math.sin(a) * (PLAZA.r - 14));
      }
      glow(PLAZA.x, PLAZA.y, 230, 0xffb86a, 0.4, 0.12); // soft, breathing fire-warmth over the whole plaza
      // Tavern: a lantern by the door + glowing windows.
      const bar = byKind('bar'); if (bar) {
        lampPost(bar.x + bar.w + 16, bar.y + bar.h - 10);
        lampPost(bar.x - 16, bar.y + bar.h - 10);
        glow(bar.x + bar.w * 0.32, bar.y + bar.h * 0.55, 36, 0xffb648, 0.9, 0.1); // windows
        glow(bar.x + bar.w * 0.68, bar.y + bar.h * 0.55, 36, 0xffb648, 0.9, 0.1);
        glow(bar.x + bar.w / 2, bar.y + bar.h, 46, 0xffc24a, 0.85, 0.12);          // doorway spill
      }
      // Casino: FULL VEGAS — a big colored bloom plus a marquee of chasing, color-cycling bulbs
      // strung right around the building (lit day and night so it always screams "CASINO").
      const cas = byKind('casino'); if (cas) { const { cx, cy } = bm(cas);
        glow(cx, cy, 150, 0xff2a6a, 0.45, 0.08); glow(cx, cas.y + 10, 110, 0xb23aff, 0.4, 0.08);
        // bulbs evenly around the rectangle perimeter
        const inset = 8, x0 = cas.x - inset, y0 = cas.y - inset, x1 = cas.x + cas.w + inset, y1 = cas.y + cas.h + inset;
        const per = [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]; // closed loop of corners
        let idx = 0;
        for (let s = 0; s < 4; s++) {
          const ax = per[s * 2], ay = per[s * 2 + 1], bx = per[s * 2 + 2], by = per[s * 2 + 3];
          const segLen = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.round(segLen / 34));
          for (let k = 0; k < n; k++) {
            const t = k / n, px2 = ax + (bx - ax) * t, py2 = ay + (by - ay) * t;
            const im = sc.add.image(px2, py2, GLOW).setBlendMode(Phaser.BlendModes.ADD).setDepth(50003).setDisplaySize(34, 34).setAlpha(0);
            casinoBulbs.push({ obj: im, i: idx++ });
          }
        }
      }
      // Hell portal: an angry red bloom.
      const doom = byKind('doomportal'); if (doom) { const { cx, cy } = bm(doom); glow(cx, cy, 110, 0xff3a0a, 1.0, 0.22); glow(cx, cy + 20, 70, 0xffa020, 0.7, 0.22); }
      // Arena / Bank / Pet shack: a modest warm window glow each, for cohesion.
      for (const k of ['arena', 'bank', 'petshop']) { const b = byKind(k); if (b) { const { cx, cy } = bm(b); glow(cx, cy, 70, 0xffd081, 0.55); } }
      // A few street lamps lining the main road by the plaza (just south of the tarmac).
      lampPost(PLAZA.x - 360, 1330); lampPost(PLAZA.x + 360, 1330); lampPost(PLAZA.x - 700, 1330); lampPost(PLAZA.x + 700, 1330);
    },

    update(this: Phaser.Scene, time: number, delta: number) {
      const sc = this;
      const now = performance.now();
      const dt = Math.min(delta / 1000, 0.05);
      if (helpFlash && now >= helpFlashUntil) { helpFlash = ''; updateHelp(); }

      // --- day/night: derive purely from the wall clock so every client's sky matches ---
      {
        const night = nightFactor(Date.now() + net.dayNightOffset());
        if (nightOverlay) nightOverlay.setAlpha(night * 0.62);           // darker after dusk
        if (warmOverlay) warmOverlay.setAlpha(0.34 * (1 - night * 0.8)); // golden glow fades after dark
        // lights bloom in as it gets dark, each flickering like a flame on its own phase
        for (const l of nightLights) {
          const t = now / 1000;
          const f = 1 + l.fire * (Math.sin(t * 7.3 + l.phase) * 0.6 + Math.sin(t * 2.9 + l.phase * 1.7) * 0.4);
          l.obj.setAlpha(night * l.max * f);
        }
        // casino marquee: bulbs chase around the building and cycle colors — lit always, louder at night
        if (casinoBulbs.length) {
          const t = now / 1000, brightness = 0.5 + 0.5 * night;
          for (const b of casinoBulbs) {
            b.obj.setTint(CASINO_PAL[(b.i + Math.floor(t * 4)) % CASINO_PAL.length]);
            const chase = 0.45 + 0.55 * Math.max(0, Math.sin(t * 6 - b.i * 0.6)); // running light
            b.obj.setAlpha(brightness * chase);
          }
        }
      }

      // --- birds: every so often a little flock drifts across the sky (camera-fixed, flapping) ---
      {
        if (now >= nextBirdsAt) {
          nextBirdsAt = now + 12000 + Math.random() * 16000;
          const sw = sc.scale.width, sh = sc.scale.height;
          const dir = Math.random() < 0.5 ? 1 : -1;
          const speed = (42 + Math.random() * 28) * dir;
          const baseY = 50 + Math.random() * sh * 0.28;
          const n = 4 + Math.floor(Math.random() * 4);
          for (let k = 0; k < n; k++) {
            const img = sc.add.image(dir > 0 ? -40 - k * 28 : sw + 40 + k * 28, baseY + (k % 2) * 18 + k * 3, 'w-bird')
              .setScrollFactor(0).setScale(2.2).setDepth(60000).setAlpha(0.85).setFlipX(dir < 0);
            birds.push({ img, vx: speed, phase: k * 0.7 });
          }
        }
        for (let i = birds.length - 1; i >= 0; i--) {
          const b = birds[i];
          b.img.x += b.vx * dt;
          b.img.scaleY = 2.2 * (1 + Math.sin(now / 110 + b.phase) * 0.45); // wing flap
          const sw = sc.scale.width;
          if ((b.vx > 0 && b.img.x > sw + 60) || (b.vx < 0 && b.img.x < -60)) { b.img.destroy(); birds.splice(i, 1); }
        }
      }

      // --- drunkenness: an amber haze + a woozy camera sway that grow with the level ---
      {
        const drunk = net.drunkLevel();
        if (drunkOverlay) drunkOverlay.setAlpha(drunk > 0 ? Math.min(0.5, drunk * 0.06) : 0);
        if (mainCam) {
          const w = time / 1000;
          const baseZoom = inInterior ? TAVERN_ZOOM : ZOOM; // zoomed-in & cozy while inside the Tavern
          mainCam.setRotation(drunk > 0 ? Math.sin(w * 1.1) * 0.012 * drunk : 0);            // tilt sway (~4° at lvl 6)
          mainCam.setZoom(drunk > 0 ? baseZoom * (1 + Math.sin(w * 0.8) * 0.02 * drunk) : baseZoom); // breathing zoom
        }
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

      // jail transitions: snap into the cell when busted, out the front when bailed
      const jailedNow = net.amJailed();
      if (jailedNow !== wasJailed) {
        wasJailed = jailedNow;
        driving = false; vx = vy = 0; keys.clear(); joyActive = false;
        if (jailedNow) { selfX = JAIL.x + JAIL.w / 2; selfY = JAIL.y + JAIL.h / 2; }
        else { selfX = JAIL.x + JAIL.w / 2; selfY = JAIL.y + JAIL.h + R + 18; } // released out front
        jailBanner.style.display = jailedNow ? 'flex' : 'none';
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
      if (self) { placeAvatar(self, selfX, selfY, facing, driving, net.color(), net.name() || 'you'); applySay(self, net.selfId(), now); }

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
        applySay(av, a.id, now); // pop their speech bubble if they've said something recently
      }
      // drop avatars that left
      for (const [id, av] of remote) if (!seen.has(id)) { av.c.destroy(); remote.delete(id); }

      updatePets(dt);

      // redraw the minimap ~8×/s (and the full map while it's open)
      if (now - lastMapDraw > 120) {
        lastMapDraw = now;
        drawMap(minimap, false);
        if (fullMapOpen) drawMap(fullMapCanvas, true);
      }
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
    // Rounded speech bubble: the smooth panel is the 'w-bubble' 9-slice (drawn behind the text);
    // the text just carries the words. drawBubbleBg() re-fits the panel to the text on each change.
    const bubbleBg = sc.add.nineslice(0, -R - 32, 'w-bubble', undefined, 48, 48, BUBBLE_CORNER, BUBBLE_CORNER, BUBBLE_CORNER, BUBBLE_CORNER)
      .setOrigin(0.5, 0.5).setScale(BUBBLE_BG_SCALE).setVisible(false);
    const bubble = sc.add.text(0, -R - 32, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#ffeb3b',
      padding: { x: 9, y: 5 }, align: 'center',
      stroke: '#0b1020', strokeThickness: 2, resolution: 2,
      wordWrap: { width: 180 },
    }).setOrigin(0.5, 1).setVisible(false).setDepth(1);
    const c = sc.add.container(selfX, selfY, [shadow, car, person, label, bubbleBg, bubble]);
    return { c, person, car, carBody, carRoof, label, bubble, bubbleBg, bubbleNextAt: 0, rx: selfX, ry: selfY, ra: 0 };
  }

  // Re-fit the rounded panel to the bubble text (which already bakes in its padding). The 9-slice
  // size is pre-scale, so we divide the desired local size by the panel's scale; corners stay crisp.
  function drawBubbleBg(av: Av) {
    const b = av.bubble;
    const pad = 2; // local units of breathing room around the text
    av.bubbleBg.setSize((b.width + pad * 2) / BUBBLE_BG_SCALE, (b.height + pad * 2) / BUBBLE_BG_SCALE);
    av.bubbleBg.setPosition(b.x, b.y - b.height / 2); // center the panel on the text
  }

  // Show/hide an avatar's speech bubble from the live `says` book (expiring lines auto-clear).
  function applySay(av: Av, id: string, now: number) {
    const s = says.get(id);
    if (s && s.until > now) {
      const changed = av.bubble.text !== s.text;
      if (changed) av.bubble.setText(s.text);
      if (changed || !av.bubble.visible) {
        av.bubble.setVisible(true);
        drawBubbleBg(av);          // re-fit the pill whenever the text (and thus its size) changes
        av.bubbleBg.setVisible(true);
      }
    } else {
      if (s) says.delete(id);
      if (av.bubble.visible) { av.bubble.setVisible(false); av.bubbleBg.setVisible(false); }
    }
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
    } else if (def.kind === 'fed') {
      parts = [sc.add.image(0, 0, 'w-fed').setScale(TEXEL * 1.2).setOrigin(0.5, 0.95)];
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
    if (net.amJailed()) { flashHelp('🚔 You\'re in jail. You can\'t leave until someone posts your bail.'); return; }
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
    feedLand(parcels, bankBought, bankCap) {
      land.clear();
      for (const p of parcels) land.set(p.id, p);
      myBankBought = bankBought;
      myBankCap = bankCap;
      refreshParcels();
    },
    feedSay(id, _name, text) {
      const now = performance.now();
      for (const [k, v] of says) if (v.until <= now) says.delete(k); // drop stale lines (e.g. speakers who left)
      says.set(id, { text, until: now + SAY_MS });
    },
    feedChat(line) { pushChatLine(line); },
    reenter() { net.enter(); net.landReq(); },
  };
  syncDriveBtn();
  net.enter();
}
