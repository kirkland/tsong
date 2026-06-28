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
import { startEncounter, DUNGEON_MOBS, isEncounterOpen } from './dungeon-battle';
import {
  WORLD,
  WORLD_AVATAR,
  WORLD_BUILDINGS,
  WORLD_PARCELS,
  ROBVILLE_BULBS,
  PARCEL_PRICE,
  BANK_PARCEL_CAP,
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
  DUNGEON_TIER_COINS,
  DUNGEON_CHEST_CONTENTS,
  COSMETICS,
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
  dungeonSync(): void;             // entering the Ruins → ask which chests we've opened
  dungeonChest(chest: string, captured?: boolean): void; // open a chest ('B1:col,row') → server pays coins / grants prize (once). captured=true → a monster box caught (grant the pet)
  dungeonWin(floor: string, tier: number): void; // won an encounter → adds a TIER-ranged amount to the run purse
  dungeonTakeKey(): void; // took the key from the dying B3 adventurer (server marks the run-key)
  dungeonExit(escaped: boolean): void; // left the Ruins (escaped → server pays the run purse from the House)
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
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  feedLand(parcels: LandParcelView[], bankBought: number, bankCap: number): void; // Robville land book
  reenter(): void; // re-send worldEnter after a socket reconnect (server forgot us on drop)
  dungeonChests(opened: string[]): void;                          // server's list of chests we've opened
  chestAccepted(chest: string, coins: number, potions: number, spin?: boolean, prize?: string, prizes?: string[]): void; // server accepted a chest open (prize/prizes = cosmetic names)
  dungeonSpinLoot(reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string }): void; // a spin chest's reward → run loot
  dungeonPurse(coins: number): void;                              // current run-purse total from the server
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

/** The server's list of dungeon chests this player has already opened (reply to dungeonSync). */
export function feedDungeonChests(opened: string[]): void {
  controller?.dungeonChests(opened);
}

/** The server accepted a chest open (added the coins to the run purse / granted the potion). */
export function dungeonChestAccepted(chest: string, coins: number, potions: number, spin?: boolean, prize?: string, prizes?: string[]): void {
  controller?.chestAccepted(chest, coins, potions, spin, prize, prizes);
}
export function dungeonSpinLoot(reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string }): void {
  controller?.dungeonSpinLoot(reward);
}

/** The current run-purse total (paid out only when you escape the Ruins). */
export function feedDungeonPurse(coins: number): void {
  controller?.dungeonPurse(coins);
}

/** Push the latest Robville land book (from a `land` server message) into the live overlay. */
export function feedLand(parcels: LandParcelView[], bankBought: number, bankCap: number): void {
  controller?.feedLand(parcels, bankBought, bankCap);
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

// --- The Ruins dungeon: off-map tile floors (same trick as the Tavern interior). Tile legend —
// '#'/'T'/'o' = wall, '.' = floor, '~' = tall-grass encounter, 'c' chest, '>' stairs DOWN,
// '<' stairs UP, 'L' locked door, 'D' door, '@' arrival/world-exit, 'T' torch. Rendered with the
// 0x72 stone tiles; each floor descends into a darker, colder theme (see DUNGEON_THEME). ---
const DUNGEON_TILE = 32; // world units per dungeon tile
const DUNGEON_ZOOM = 2.6; // close camera so you only see your lit surroundings
const DUNGEON_B1 = [
  '#######################',
  '#T....#.......#.....T.#',
  '#.@...D..~~~..D...c...#',
  '#.....D..~~~..D.......#',
  '#.....#..~~~..#.......#',
  '#..####..DD#..####....#',
  '#..#...........#...#..#',
  '#..#..######...#.#.#..#',
  '#..#..#....#...#.#.#..#',
  '#..#..#..c.#...#...#..#',
  '#..#..#....#...#####..#',
  '#..#..##DD##.........>#',
  '#..#............#....##',
  '#T.###############..T.#',
  '#######################',
];
// B2 — ~3× B1's area (39×27 = 1053 vs 345), maze-trickier, with a SEALED locked room (the 'L' door
// blocks; the chest behind it waits on the key system). Carved + connectivity-validated offline.
const DUNGEON_B2 = [
  '#######################################',
  '#T##################T################T#',
  '##.......####...D...####.......#.....##',
  '##..<....####..~~~..####..c....#.....##',
  '##.......D.....~~~......D............##',
  '##...................................##',
  '##.......####.......####.......#.....##',
  '##.......#######..######.......###..###',
  '####..##########..#########..#####..###',
  '####..####T#####..#########..#####..###',
  '####..#########.......###......###..###',
  '##.......######.......###......##...###',
  '##.~~~...######.......###......##..####',
  '##.~c~...D.........................####',
  '##.~~~.............................####',
  '#T.......##..##.......###......##..##T#',
  '##.......##..####..########..####..####',
  '#####..####..####..########..####..####',
  '#####..####..####..####.....>......####',
  '#####..####.....D...###..~~~......#####',
  '##.......##....~~~..###..~~~..#########',
  '##.............c~~..###..~~~...########',
  '##.......D.....~~~.............########',
  '##.............~~~............###....##',
  '#T.......####.......#########...L.c..##',
  '#############################...#....##',
  '#######################################',
];
// B3 — bigger than B2 (43×29 = 1247), darker still, 2-wide corridors. The key to B2's locked room
// comes from an NPC down here (not a floor pickup). Carved + connectivity-validated offline.
const DUNGEON_B3 = [
  '###########################################',
  '#T####################T##################T#',
  '##.......####....D...####.......###......##',
  '##..<....####..~~~~..####...c...###......##',
  '##.......D.....~~~~................D.....##',
  '##.............~~~~......................##',
  '##.......####........####.......###......##',
  '##.......####........########..####.......#',
  '#####..##########..##########.......#..#..#',
  '#####..##########..##########.......#..#..#',
  '#####..##########..########........##..#..#',
  '##.......#####........#####........##..#..#',
  '##.~~~...#####........#####..~~~~..#####..#',
  '##.~c~...D...................~~~~.....##..#',
  '##.~~~.......................~~~~.....##..#',
  '##.~~~...##..#........##..#..~~~~..#####..#',
  '#T.......##..#........##..#........###....#',
  '#####..####..#........##..####..######....#',
  '#####..####..####..#####..####..######....#',
  '#####..####..####D.#####..####..####......#',
  '##........#..####..#####..........##...>.##',
  '##........#..#........####..~~~~..##.....##',
  '##........####..~~~...####..~~~~....D....##',
  '##..............~~~.....D...~c~~.........##',
  '##..............~~~.........~~~~......c..##',
  '##........####..~~~...####...............##',
  '#T........####........####........#######T#',
  '###########################################',
  '###########################################',
];
// B4 — the deep floor, ~4× B1 (47×31 = 1457), darkest + bloodiest. '<' up to B3 (reached via B3's
// tucked-away '>'). Tier-4 mobs. Carved + connectivity-validated offline.
// B4 carries a switch puzzle: 'X' = the chest-room door (OPEN only when the switch is thrown), 'Y' = the
// boss-room door (OPEN by default, SHUTS when the switch is thrown), 'W' = the wall lever that toggles
// both. So: throw the switch → grab the fart-trail chest behind 'X' → throw it back → '>' to the boss.
const DUNGEON_B4 = [
  '###############################################',
  '#T######################T###########T########T#',
  '##.......######..D...####.......####........###',
  '##..<.c..##...#~~~~..####....c~~~~##........###',
  '##.......DX.c.#~~~~...........~~~~..D.......###',
  '##........#...#~~~~...........~~~~..........###',
  '##.......######......####.....~~~~##........###',
  '##.......####........####.......####........###',
  '#####..##########..##########..#####..........#',
  '#####..##########..##########..#####......##..#',
  '#####..##########..##########..#####......##..#',
  '##.......#####.........#####........####..##..#',
  '##.......#####.........#####........###.......#',
  '##.~~~...#####.........#####........###.......#',
  '##.~c~...D..................c.......D...~~~~..#',
  '##.~~~..................................~~~~W.#',
  '##.~~~...##..#.........##..#..........#.~~~~..#',
  '#T.......##..#.........##..#..........#.~~~~..#',
  '#####..####..#.........##..####..###..#.......#',
  '#####..####..#####..#####..####..###..####..###',
  '#####..####..#####D.#####..####.......####..###',
  '##........#..#####..#####.............####..###',
  '##........#..#.........###........##.D.########',
  '##........####..~~~~...###...~~~~.###..#....###',
  '##..............~~~~.....D...~~~~.##...Y....###',
  '##..............~~~~.........~~~~......#..>.###',
  '##........####..~~~~...###...~~~~......#....###',
  '##..c.....####.........###........###..########',
  '#T........####.........###........###........T#',
  '###############################################',
  '###############################################',
];
// B5 — the BOSS floor. A long, thin, torch-lined approach hallway ('<' back to B4) that opens into a
// grand pillared chamber where the boss waits. No loot, no wandering mobs, NO music — just dread.
const DUNGEON_B5 = [
  '#################################################',
  '#################################################',
  '##############################T###T###T###T###T##',
  '###########################....................##',
  '###########################....................##',
  '##########################T.....c....c....c....##',
  '###########################....................T#',
  '###########################....o...o...o...o...##',
  '###########################....................##',
  '#####T###T###T###T###T###T#....................##',
  '##<.........................................>..T#',
  '#####T###T###T###T###T###T#....................##',
  '###########################....................##',
  '###########################....o...o...o...o...##',
  '###########################....................T#',
  '##########################T....................##',
  '###########################....................##',
  '###########################....................##',
  '##############################T###T###T###T###T##',
  '#################################################',
  '#################################################',
];
// B6 — THE FINAL ROOM: Rob's home office (the plot twist). Bright, mundane, one desk. 'o' tiles are
// solid furniture (the desk+Rob mass, the bookshelf, the plant); '<' returns to B5. No mobs roam here —
// Rob himself is the boss, fought only when you interrupt him at his PC.
const DUNGEON_B6 = [
  '##################',
  '#.oo.........o...#',
  '#......ooo.......#',
  '#......ooo.......#',
  '#......ooo.......#',
  '#................#',
  '#................#',
  '#................#',
  '#................#',
  '#................#',
  '#................#',
  '#.......<........#',
  '##################',
];
const DUNGEON_FLOORS: Record<string, string[]> = { B1: DUNGEON_B1, B2: DUNGEON_B2, B3: DUNGEON_B3, B4: DUNGEON_B4, B5: DUNGEON_B5, B6: DUNGEON_B6 };
const DUNGEON_TOTAL_CHESTS = Object.keys(DUNGEON_CHEST_CONTENTS).filter((k) => !k.endsWith(':boss')).length; // for the x/y counter (the boss reward isn't a tile chest)
// Locked 'L' doors → the chest they guard. A door stays open FOREVER once that chest is account-opened
// (committed), exactly like the chest itself — no need to re-key it on later runs.
const DUNGEON_LOCKED_DOORS: Record<string, string> = { 'B2:32,24': 'B2:34,24' };
const DUNGEON_ORDER = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']; // descent order; '>' goes to the next, '<' to the previous
// Each descent gets darker + colder in THEME (not lighting — the actual stone palette). `props`
// turns on the deeper-floor ambient decals (bones, fungus, cobwebs, drips); `gore` adds blood + claw
// marks on the bloodier floors.
const DUNGEON_THEME: Record<string, { wall: number; floor: number; surround: number; props: boolean; gore?: boolean; silent?: boolean; lit?: boolean; office?: boolean }> = {
  B1: { wall: 0xffd49a, floor: 0xffffff, surround: 0x070905, props: false }, // warm amber sandstone
  B2: { wall: 0xa07b86, floor: 0x9aa0b4, surround: 0x05060a, props: true },  // colder, blue-grey, dimmer
  B3: { wall: 0x866e7c, floor: 0x7c7690, surround: 0x05050c, props: true, gore: true }, // darker than B2, sickly + bloodied, still readable
  B4: { wall: 0x6a5660, floor: 0x645f74, surround: 0x040309, props: true, gore: true }, // the deep: coldest, darkest, most blood
  B5: { wall: 0x564a68, floor: 0x423a56, surround: 0x010008, props: false, silent: true }, // the BOSS sanctum: grand regal stone, torch-lit, dead silent
  B6: { wall: 0xe6dcc6, floor: 0xffffff, surround: 0x2a2620, props: false, silent: true, lit: true, office: true }, // THE OFFICE: bright, warm, fully lit — the plot twist
};
// Fog-of-war darkness (the dim ambient OUTSIDE your light pool), ramped per descent: each floor is
// genuinely darker than the last, but all lighter than the old flat 0.8 so nothing's a black void.
const DUNGEON_DARK: Record<string, number> = { B1: 0.55, B2: 0.63, B3: 0.70, B4: 0.76, B5: 0.8 }; // the boss sanctum: darkest, lit only by its torches
const dungeonIsWall = (ch: string): boolean => ch === '#' || ch === 'T' || ch === 'o' || ch === ' ' || ch === 'W';
// what blocks movement: walls + solid props (a chest you bump into) + a locked door ('L'). Switch-doors
// ('X'/'Y') are handled per-state in dungeonBlocked (open/shut depends on the lever).
const dungeonBlocks = (ch: string): boolean => dungeonIsWall(ch) || ch === 'c' || ch === 'L';
// Each floor's NEW-mob tier. Its roster = the 2 mobs of THIS tier (new) + the 2 of the tier above,
// carried down (tier-1). Rewards key off the mob's tier (DUNGEON_TIER_COINS), not the floor. The
// "new" mobs are forced first: you must meet BOTH new mobs before a carried-over mob can reappear.
const DUNGEON_FLOOR_TIER: Record<string, number> = { B1: 1, B2: 2, B3: 3, B4: 4 };
const mobsOfTier = (t: number): number[] => DUNGEON_MOBS.map((m, i) => (m.tier === t ? i : -1)).filter((i) => i >= 0);
const floorNewMobs = (floor: string): number[] => mobsOfTier(DUNGEON_FLOOR_TIER[floor] ?? 1);
const floorCarryMobs = (floor: string): number[] => { const t = DUNGEON_FLOOR_TIER[floor] ?? 1; return t > 1 ? mobsOfTier(t - 1) : []; };
// Potions held are still a light client-side consumable (per browser).
// Potions are a RUN resource (like the purse) — held in memory only, reset on entry, lost on leave.

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
  let inDungeon = false;    // true while inside the Ruins dungeon (camera + tile collision → dInt)
  // --- current-floor geometry (swapped by setFloorGeom on entry/descent) ---
  let currentFloor = 'B1';
  let dmap: string[] = DUNGEON_FLOORS.B1;       // the active floor's tile rows
  let dCols = 0, dRows = 0;                       // its dimensions in tiles
  let dInt = { x: 7200, y: 300, w: 0, h: 0 };    // its world-space rect (off-map, EAST of the Tavern so they don't overlap)
  const setFloorGeom = (id: string) => {
    currentFloor = id; dmap = DUNGEON_FLOORS[id];
    dCols = Math.max(...dmap.map((r) => r.length)); dRows = dmap.length;
    dInt = { x: 7200, y: 300, w: dCols * DUNGEON_TILE, h: dRows * DUNGEON_TILE };
  };
  const dungeonCell = (cx: number, cy: number): string => (dmap[cy] && dmap[cy][cx]) || ' ';
  const chestCells = (): string[] => { // the 'c' tiles on the active floor → ['col,row', …]
    const out: string[] = [];
    for (let r = 0; r < dRows; r++) for (let c = 0; c < dCols; c++) if (dungeonCell(c, r) === 'c') out.push(c + ',' + r);
    return out;
  };
  const cellWorldOf = (ch: string): { x: number; y: number } | null => { // world centre of the first `ch` tile
    for (let r = 0; r < dRows; r++) for (let c = 0; c < dCols; c++)
      if (dungeonCell(c, r) === ch) return { x: dInt.x + (c + 0.5) * DUNGEON_TILE, y: dInt.y + (r + 0.5) * DUNGEON_TILE };
    return null;
  };
  let dungeonHP = 100;      // run health — chipped by points a mob scores on you (0 → expelled)
  let potionCount = 0;      // 🧪 potions held this run (in-memory; reset on entry, not carried out); P drinks one for +10 HP
  const lootItems: { item: string; name: string }[] = []; // 🎁 cosmetics won from spin chests this run (granted on escape)
  let dungeonPurseDisplay = 0; // server's run-purse total (banner display); paid out only on a clean escape
  const dungeonObjs: Phaser.GameObjects.GameObject[] = []; // every sprite for the active floor (cleared on rebuild)
  const dungeonChestSprites: Record<string, Phaser.GameObjects.Image> = {}; // 'c,r' → sprite (to swap on open)
  const dungeonLockSprites: Record<string, Phaser.GameObjects.Image> = {};   // 'c,r' → locked-door sprite (to remove on unlock)
  let nearChestCell: { c: number; r: number } | null = null; // unopened chest within reach (→ Open prompt)
  let nearStairs: { dir: 'down' | 'up'; to: string } | null = null; // a stair tile within reach (→ descend/ascend)
  let nearBossStairs = false; // standing on the deepest floor's '>' (the boss stairwell — sealed until the boss floor exists)
  let nearLockedDoor: { c: number; r: number } | null = null; // an 'L' locked door within reach (→ "needs a key")
  let nearSwitch: { c: number; r: number } | null = null;     // a 'W' wall lever within reach (→ flip it)
  let nearSwitchDoor: { c: number; r: number } | null = null; // a sealed 'X'/'Y' switch-door within reach (→ "find a switch")
  let switchOn = false;       // B4 puzzle: false → boss door 'Y' open / chest door 'X' shut; true → flipped (run-scoped)
  let clarenceDefeated = false; // B5: beaten the Gatekeeper this run? (run-scoped; he stays down once bested)
  let clarenceArmed = false;    // re-arms when you retreat into the hallway, so a flee doesn't instantly re-trigger
  let clarenceSprite: Phaser.GameObjects.Image | null = null; // his world sprite, standing at the chamber's far end
  let clarenceAnim: { t: number; fromX: number; toX: number; y: number } | null = null; // his approach slide → opens dialogue when done
  let robBoss: { x: number; y: number; sprite: Phaser.GameObjects.Image } | null = null; // B6: Rob, seated at his PC
  let nearRob = false;          // standing next to Rob (→ "Interrupt him" prompt)
  let robDefeated = false;      // B6: beaten Rob this run? (run-scoped)
  const b6Minions: { spr: Phaser.GameObjects.Image; x: number; y: number; vx: number; vy: number }[] = []; // little minions milling about the office
  let dungeonImp: { x: number; y: number } | null = null; // the friendly B2 imp's world position (talk for a potion)
  let nearDungeonImp = false; // the imp is within talk range
  let impGavePotion = false;  // he hands out one potion per run (no farming)
  let dungeonImp2: { x: number; y: number } | null = null; // a 2nd imp in the B5 chamber (post-Clarence) — 3 potions
  let nearDungeonImp2 = false;
  let imp2Gave = false;       // the B5 imp hands over his 3 potions once per run
  let dyingMan: { x: number; y: number } | null = null; // the bleeding B3 NPC who gives the key
  let dyingManSprite: Phaser.GameObjects.Image | null = null;
  let nearDyingMan = false;
  let hasKey = false;         // holding the key to B2's locked room (run-scoped; consumed on unlock)
  let keyTaken = false;       // already looted the dying man this run → he's a corpse now
  const unlockedDoors = new Set<string>(); // 'floor:c,r' of 'L' doors opened with the key this run
  const openedChestsServer = new Set<string>(); // 'floor:col,row' the server says this account has opened
  const runOpens = new Set<string>();           // chests opened THIS run (provisional) — rolled back on death, banked on escape
  const chestIsOpen = (c: number, r: number) => openedChestsServer.has(`${currentFloor}:${c},${r}`);
  // a locked door is open if unlocked THIS run (with the key) OR its guarded chest is already banked
  const doorIsOpen = (c: number, r: number) => {
    const id = `${currentFloor}:${c},${r}`;
    if (unlockedDoors.has(id)) return true;
    const guarded = DUNGEON_LOCKED_DOORS[id];
    return !!guarded && openedChestsServer.has(guarded);
  };
  let lastGrassKey = '';    // last tall-grass cell rolled, so each new '~' tile rolls one encounter
  let grassDanger = 0;      // ramps per grass tile crossed → rising encounter odds; resets on a fight
  let recentMob = -1, recentMobRun = 0; // shuffle-bag: never the same mob more than twice in a row
  const newMobsSeen = new Set<number>(); // this floor's NEW mobs already met (both required before carry mobs reappear)
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

  // Small fixed banner naming the current dungeon floor (top-center). Hidden outside the Ruins.
  const dungeonBanner = document.createElement('div');
  dungeonBanner.style.cssText =
    'position:absolute;left:50%;top:10px;transform:translateX(-50%);display:none;pointer-events:none;z-index:3;' +
    'background:#0c0d0acc;border:1px solid #3a3320;border-radius:8px;padding:4px 12px;' +
    'color:#cdb98a;font-size:12px;font-weight:700;letter-spacing:1px;text-shadow:0 1px 3px #000a;';
  overlay.appendChild(dungeonBanner);

  // Chests-opened progress counter (top-right) — persists across runs so you know if you left loot behind.
  const dungeonChestCounter = document.createElement('div');
  dungeonChestCounter.style.cssText =
    'position:absolute;right:96px;bottom:14px;display:none;pointer-events:none;z-index:4;' +
    'background:#0c0d0acc;border:1px solid #3a3320;border-radius:8px;padding:7px 12px;' +
    'color:#cdb98a;font-size:12px;font-weight:700;letter-spacing:.5px;text-shadow:0 1px 3px #000a;';
  overlay.appendChild(dungeonChestCounter);

  // Tiny controls panel (bottom-left) shown only in the Ruins.
  const dungeonControls = document.createElement('div');
  dungeonControls.style.cssText =
    'position:absolute;left:14px;bottom:12px;display:none;pointer-events:none;z-index:3;' +
    'background:#0c0d0acc;border:1px solid #3a3320;border-radius:8px;padding:7px 12px;' +
    'color:#cdb98a;font-size:12px;line-height:1.7;text-shadow:0 1px 3px #000a;';
  overlay.appendChild(dungeonControls);

  // 🎒 Loot button (bottom-right) + a toggled panel of everything collected this run.
  const lootBtn = document.createElement('button');
  lootBtn.type = 'button';
  lootBtn.textContent = '🎒 Loot';
  lootBtn.style.cssText =
    'position:absolute;right:14px;bottom:12px;display:none;pointer-events:auto;z-index:4;cursor:pointer;' +
    'background:#1b1710;border:1px solid #5a4a2a;border-radius:8px;padding:8px 14px;color:#f0d8a0;' +
    'font-size:13px;font-weight:700;text-shadow:0 1px 3px #000a;';
  overlay.appendChild(lootBtn);
  const lootPanel = document.createElement('div');
  lootPanel.style.cssText =
    'position:absolute;right:14px;bottom:52px;display:none;pointer-events:none;z-index:4;min-width:220px;max-width:300px;' +
    'background:#0c0d0aee;border:1px solid #5a4a2a;border-radius:10px;padding:12px 14px;color:#cdb98a;' +
    'font-size:13px;line-height:1.6;text-shadow:0 1px 3px #000a;box-shadow:0 6px 24px #000a;';
  overlay.appendChild(lootPanel);
  let lootOpen = false;
  function renderLootPanel() {
    if (!lootOpen) return;
    const items = lootItems.length ? lootItems.map((i) => `🎁 ${i.name}`).join('<br>') : '<span style="opacity:.55">— none yet —</span>';
    lootPanel.innerHTML =
      '<div style="font-weight:800;color:#f0d8a0;margin-bottom:6px;border-bottom:1px solid #3a3320;padding-bottom:5px;">🎒 RUN LOOT</div>' +
      `💰 Coins: <b>${dungeonPurseDisplay}</b>🪙<br>🧪 Potions: <b>${potionCount}</b><br>📦 Chests found: <b>${chestsFound()}/${DUNGEON_TOTAL_CHESTS}</b>` +
      `<div style="margin-top:6px;">${items}</div>` +
      '<div style="margin-top:9px;font-size:11px;color:#8fae9b;opacity:.9;">Climb out through the B1 entrance — or beat the boss — to claim it. Die or bail and you lose it all.</div>';
  }
  function toggleLoot() { lootOpen = !lootOpen; lootPanel.style.display = lootOpen ? 'block' : 'none'; renderLootPanel(); }
  lootBtn.onclick = toggleLoot;

  // Door prompt (bottom-center). A real button so tapping works on touch; Enter/E does the same.
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.style.cssText =
    'position:absolute;left:50%;bottom:42px;transform:translateX(-50%);display:none;cursor:pointer;' +
    'background:#e8b84b;color:#1a1408;border:none;border-radius:10px;padding:11px 18px;font-size:15px;' +
    'font-weight:700;box-shadow:0 6px 20px #0008;z-index:2;';
  overlay.appendChild(prompt);

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
  // Optional character portrait that floats above the text box (visual-novel style; used by the imp).
  const npcPortrait = document.createElement('img');
  npcPortrait.style.cssText =
    'position:absolute;left:50%;bottom:calc(100% - 12px);transform:translateX(-50%);height:200px;display:none;' +
    'image-rendering:pixelated;filter:drop-shadow(0 6px 12px #000b);pointer-events:none;';
  npcBox.append(npcName, npcText, npcChoices, npcHint, npcPortrait);
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
    if (inInterior || inDungeon || net.amJailed()) return; // no cars in the bar, the dungeon, or the slammer
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
      case 'bar': return '🍺 Enter the Tavern — grab a beer';
      case 'parliament': return '🏛️ Enter Parliament — play Nomic';
      case 'arcade': return '🎮 Enter the Arcade';
      case 'dungeon': return '🏚️ Enter the Ruins — descend the dungeon';
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
    if (kind === 'dungeon') { enterDungeon(); return; }
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

  // --- The Ruins dungeon interior: an off-map tile room rendered from DUNGEON_B1. Same camera/
  // collision swap as the Tavern, but movement collides per-tile against the walls. ---
  const dungeonEntry = () => {                      // world centre of the '@' arrival cell
    for (let r = 0; r < dRows; r++) for (let c = 0; c < dCols; c++)
      if (dungeonCell(c, r) === '@') return { x: dInt.x + (c + 0.5) * DUNGEON_TILE, y: dInt.y + (r + 0.5) * DUNGEON_TILE };
    return { x: dInt.x + dInt.w / 2, y: dInt.y + dInt.h / 2 };
  };
  // wall test at a world point, with the avatar's body radius checked at its corners
  function dungeonBlocked(wx: number, wy: number): boolean {
    const rad = R * 0.42; // forgiving body radius so 1-tile doorways are easy to thread
    for (const ox of [-rad, rad]) for (const oy of [-rad, rad]) {
      const c = Math.floor((wx + ox - dInt.x) / DUNGEON_TILE);
      const r = Math.floor((wy + oy - dInt.y) / DUNGEON_TILE);
      const ch = dungeonCell(c, r);
      if (ch === 'L' && doorIsOpen(c, r)) continue; // an opened door is passable
      if (ch === 'X') { if (switchOn) continue; return true; }   // chest door: open only when the lever's thrown
      if (ch === 'Y') { if (!switchOn) continue; return true; }  // boss door: shut once the lever's thrown
      if (dungeonBlocks(ch)) return true;
    }
    // NPCs are solid — you bump into them rather than walking through
    if (dungeonImp && Math.hypot(wx - dungeonImp.x, wy - dungeonImp.y) < rad + DUNGEON_TILE * 0.4) return true;
    if (dungeonImp2 && Math.hypot(wx - dungeonImp2.x, wy - dungeonImp2.y) < rad + DUNGEON_TILE * 0.4) return true;
    if (dyingMan && Math.hypot(wx - dyingMan.x, wy - dyingMan.y) < rad + DUNGEON_TILE * 0.4) return true;
    return false;
  }
  // (Re)build the ACTIVE floor's geometry. Destroys the previous floor's sprites first, so it can be
  // called on entry and on every descent/ascent. Theme (wall/floor tint, ambient props) per-floor.
  function buildFloor(sc: Phaser.Scene) {
    for (const o of dungeonObjs) o.destroy();
    dungeonObjs.length = 0;
    dungeonTorches.length = 0; dungeonFlies.length = 0; dungeonImp = null; nearDungeonImp = false; dungeonImp2 = null; nearDungeonImp2 = false;
    dyingMan = null; dyingManSprite = null; nearDyingMan = false;
    clarenceSprite = null; clarenceAnim = null; robBoss = null; nearRob = false; b6Minions.length = 0;
    for (const k in dungeonChestSprites) delete dungeonChestSprites[k];
    for (const k in dungeonLockSprites) delete dungeonLockSprites[k];
    dungeonDarkRT?.destroy(); dungeonDarkRT = null;
    const theme = DUNGEON_THEME[currentFloor] ?? DUNGEON_THEME.B1;
    const ox = dInt.x, oy = dInt.y, T = DUNGEON_TILE, base = oy - 1000, sl = T / 16;
    const keep = (o: Phaser.GameObjects.GameObject) => { dungeonObjs.push(o); return o; };
    // dark surround so a big viewport never shows grass past the room
    keep(sc.add.rectangle(ox - 900, oy - 900, dInt.w + 1800, dInt.h + 1800, theme.surround).setOrigin(0, 0).setDepth(base - 1));
    // world-space darkness layer covering the room — filled dark + light holes erased each frame
    dungeonDarkRT = sc.add.renderTexture(ox, oy, dInt.w, dInt.h).setOrigin(0, 0).setDepth(50002).setVisible(false);
    for (let r = 0; r < dRows; r++) for (let c = 0; c < dCols; c++) {
      const ch = dungeonCell(c, r);
      if (ch === ' ') continue;
      const wx = ox + c * T, wy = oy + r * T;
      // office 'o' tiles are solid FURNITURE, not wall — draw the wood floor under them (the sprite covers it)
      if (dungeonIsWall(ch) && !(theme.office && ch === 'o')) {
        const key = theme.office ? 'w-owall' : 'd-w' + (Math.floor(hash(c, r * 7) * 4) % 4);
        keep(sc.add.image(wx, wy, key).setOrigin(0, 0).setScale(sl).setTint(theme.office ? 0xffffff : theme.wall).setDepth(base + 1));
        if (ch === 'T' && sc.textures.exists('d-glow')) { // a wall torch: small bright flame + a light source
          const lx = wx + T / 2, ly = wy + T / 2;
          keep(sc.add.image(lx, ly, 'd-glow').setTint(0xffcf6e).setBlendMode(Phaser.BlendModes.ADD).setDepth(50003).setAlpha(0.8).setDisplaySize(T * 0.7, T * 0.7)); // the small flame itself
          dungeonTorches.push({ x: lx, y: ly, phase: hash(c, r) * 6.28, fire: 0.24 });
        }
        if (ch === 'W') { // the wall lever that drives the switch puzzle — a steel plate + a handle (leans one way thrown)
          const lx = wx + T / 2, ly = wy + T / 2;
          keep(sc.add.image(lx, ly, 'd-glow').setTint(switchOn ? 0x8effa0 : 0xff8a4a).setBlendMode(Phaser.BlendModes.ADD).setDepth(50003).setAlpha(0.6).setDisplaySize(T * 0.55, T * 0.55)); // a glow so it's findable in the dark
          keep(sc.add.rectangle(lx, ly, T * 0.36, T * 0.52, 0x2a2530).setStrokeStyle(2, 0x6b7480).setDepth(base + 3)); // the steel mounting plate
          const handle = sc.add.rectangle(lx, ly + T * 0.18, T * 0.11, T * 0.38, switchOn ? 0xbfe6c4 : 0xd9a06a).setOrigin(0.5, 1).setDepth(base + 4); // the throw handle
          handle.rotation = switchOn ? -0.6 : 0.6; // leans left thrown, right at rest
          keep(handle);
        }
      } else {
        const fr = hash(c * 3, r);
        const fkey = theme.office ? 'w-wood' // the office gets warm wood planks instead of stone
          : fr > 0.95 ? 'd-f5' : fr > 0.92 ? 'd-f6' : fr > 0.7 ? 'd-f' + (1 + Math.floor(fr * 40) % 4) : 'd-f0';
        keep(sc.add.image(wx, wy, fkey).setOrigin(0, 0).setScale(sl).setTint(theme.floor).setDepth(base));
        if ((ch === '>' || ch === '<') && sc.textures.exists('d-stairs')) { // a proper stone stairwell
          keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-stairs').setScale(sl).setOrigin(0.5).setDepth(base + 2)
            .setFlipY(ch === '<').setTint(ch === '>' ? 0xffe6b0 : 0xbfe4ff)); // down = warm, up = cool
        }
        if (ch === 'L' && sc.textures.exists('d-lock') && !doorIsOpen(c, r)) { // a sealed, barred locked door (gone once opened)
          const ls = sc.add.image(wx + T / 2, wy + T / 2, 'd-lock').setScale(sl).setOrigin(0.5).setDepth(base + 3);
          dungeonLockSprites[`${c},${r}`] = ls; keep(ls);
        }
        if ((ch === 'X' || ch === 'Y') && sc.textures.exists('d-lock') && (ch === 'X' ? !switchOn : switchOn)) { // a switch-sealed door — same barred look, cool steel tint so it reads mechanical (not key-locked)
          keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-lock').setScale(sl).setOrigin(0.5).setDepth(base + 3).setTint(0x9fb6c4));
        }
        if (theme.props) addFloorProp(sc, c, r, wx, wy, T, sl, base, keep, !!theme.gore); // deeper-floor ambient decals
        if (ch === 'c' && !(currentFloor === 'B5' && !clarenceDefeated)) { // a chest (B5's appear only after Clarence falls)
          const spr = sc.add.image(wx + T / 2, wy + T - 3, chestIsOpen(c, r) ? 'w-chest-open' : 'w-chest').setScale(sl).setOrigin(0.5, 1).setDepth(base + 2);
          dungeonChestSprites[`${c},${r}`] = spr; keep(spr);
        }
      }
    }
    // B2: a friendly imp loiters in the arrival room (talk → a free potion + the potion tutorial).
    // Kept in the open room (not a 1-wide corridor) since he's solid — you walk around, not through.
    if (currentFloor === 'B2' && sc.textures.exists('w-demon')) {
      const ic = 6, ir = 6; // an open floor tile a little deeper into the arrival room
      const ix = ox + (ic + 0.5) * T, iy = oy + (ir + 0.5) * T;
      const spr = sc.add.image(ix, iy, 'w-demon').setScale(sl).setOrigin(0.5, 0.62).setDepth(base + 4);
      dungeonObjs.push(spr);
      dungeonImp = { x: ix, y: iy };
    }
    // B3: a dying adventurer slumped in a far room — talk to him for the key (then he passes).
    if (currentFloor === 'B3' && sc.textures.exists('d-fallen')) {
      const mc = 4, mr = 23; // slumped in the quiet bottom-left room
      const mx = ox + (mc + 0.5) * T, my = oy + (mr + 0.5) * T;
      const spr = sc.add.image(mx, my, 'd-fallen').setScale(sl).setOrigin(0.5, 0.62).setDepth(base + 4);
      if (keyTaken) spr.setTint(0x6a6a72); // already looted this run → a cold corpse
      dungeonObjs.push(spr);
      dyingMan = { x: mx, y: my }; dyingManSprite = spr;
    }
    // B5: the Gatekeeper stands waiting at the far end of the grand chamber (until you've bested him).
    if (currentFloor === 'B5' && !clarenceDefeated && sc.textures.exists('w-clarence')) {
      const cc = 43, cr = 10; // dead centre of the chamber's far wall, facing the entrance
      const cxw = ox + (cc + 0.5) * T, cyw = oy + (cr + 0.5) * T;
      const spr = sc.add.image(cxw, cyw, 'w-clarence').setOrigin(0.5, 0.92).setScale(sl * 1.5).setDepth(cyw); // a tall standing figure
      dungeonObjs.push(spr); clarenceSprite = spr; clarenceAnim = null;
    }
    // B5: once Clarence is down, a friendly imp loiters by the chamber's reward chests (talk → 3 potions).
    if (currentFloor === 'B5' && clarenceDefeated && sc.textures.exists('w-demon')) {
      const ic = 30, ir = 9; // a clear floor tile near the chests/aisle
      const ix = ox + (ic + 0.5) * T, iy = oy + (ir + 0.5) * T;
      const spr = sc.add.image(ix, iy, 'w-demon').setScale(sl).setOrigin(0.5, 0.62).setDepth(base + 4);
      dungeonObjs.push(spr); dungeonImp2 = { x: ix, y: iy };
    }
    // B6: dress Rob's home office — desk + monitor, Rob seated at his PC (back to the door), a rug,
    // bookshelf, plant, a sunny window and his own grandiose framed portrait on the wall.
    if (currentFloor === 'B6') {
      const at = (cc: number, cr: number) => ({ x: ox + (cc + 0.5) * T, y: oy + (cr + 0.5) * T });
      const place = (key: string, cc: number, cr: number, scale: number, oy2 = 0.92, depthAdd = 0) => {
        const p = at(cc, cr); const s = sc.add.image(p.x, p.y, key).setOrigin(0.5, oy2).setScale(sl * scale).setDepth(p.y + depthAdd);
        dungeonObjs.push(s); return s;
      };
      // a rug under the workstation (low, flat on the floor)
      const rug = at(8, 5); keep(sc.add.image(rug.x, rug.y, 'w-rug').setOrigin(0.5).setScale(sl * 1.7).setDepth(base + 0.5));
      // wall décor on the top wall: a sunny window + Rob's framed presidential portrait
      const win = at(3, 1); keep(sc.add.image(win.x, win.y - T * 0.2, 'w-window').setOrigin(0.5).setScale(sl * 1.1).setDepth(base + 1));
      if (sc.textures.exists('w-rob-portrait')) {
        const pf = at(12, 1);
        keep(sc.add.rectangle(pf.x, pf.y - T * 0.2, T * 1.25, T * 1.5, 0xcaa14a).setDepth(base + 1)); // gilt frame
        keep(sc.add.image(pf.x, pf.y - T * 0.2, 'w-rob-portrait').setDisplaySize(T * 1.05, T * 1.3).setDepth(base + 1.1));
      }
      place('w-bookshelf', 2, 1, 1.4, 0.95);            // bookshelf against the top-left wall
      place('w-plant', 13, 1, 1.1, 0.95);               // a potted plant
      place('w-deskpc', 8, 2.4, 1.5, 0.95);             // desk + monitor (its map screen glowing) up top
      const rob = place('w-robpc', 8, 4.3, 1.15, 0.95, 1); // Rob, seated below it, back to the door
      robBoss = { x: rob.x, y: rob.y, sprite: rob };
      // a few minions milling about the office, just for fun (they wander the open floor)
      if (sc.textures.exists('w-minion')) for (let i = 0; i < 3; i++) {
        const mx = ox + (3 + Math.random() * 11) * T, my = oy + (6 + Math.random() * 4) * T;
        const spr = sc.add.image(mx, my, 'w-minion').setScale(sl * 1.1).setOrigin(0.5, 0.95).setDepth(my);
        dungeonObjs.push(spr);
        const a = Math.random() * 6.28;
        b6Minions.push({ spr, x: mx, y: my, vx: Math.cos(a) * 26, vy: Math.sin(a) * 26 });
      }
    }
    // a few drifting fireflies (red / orange / purple) — twinkle over the darkness
    if (sc.textures.exists('d-glow')) {
      const FLY_COLS = [0xff5a4a, 0xffa838, 0xc176ff];
      for (let i = 0; i < 9; i++) {
        const fx = dInt.x + 40 + Math.random() * (dInt.w - 80);
        const fy = dInt.y + 40 + Math.random() * (dInt.h - 80);
        const col = FLY_COLS[i % 3];
        const glow = keep(sc.add.image(fx, fy, 'd-glow').setTint(col).setBlendMode(Phaser.BlendModes.ADD).setDepth(50006).setAlpha(0).setDisplaySize(T * 0.45, T * 0.45)) as Phaser.GameObjects.Image;
        const core = keep(sc.add.image(fx, fy, 'd-glow').setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD).setDepth(50007).setAlpha(0).setDisplaySize(T * 0.14, T * 0.14)) as Phaser.GameObjects.Image; // bright solid core
        dungeonFlies.push({ glow, core, x: fx, y: fy, vx: (Math.random() * 2 - 1) * 12, vy: (Math.random() * 2 - 1) * 12, phase: Math.random() * 6.28 });
      }
    }
  }
  // Deeper-floor ambient decals (B2+): bones, pale cave fungus, cobwebs in corners, ceiling drips,
  // and on `gore` floors (B3+) dried blood + claw marks. Deterministic by cell hash (stable across
  // rebuilds), subtle, and never block movement.
  function addFloorProp(sc: Phaser.Scene, c: number, r: number, wx: number, wy: number, T: number, sl: number, base: number, keep: (o: Phaser.GameObjects.GameObject) => Phaser.GameObjects.GameObject, gore: boolean) {
    const h = hash(c * 13 + 5, r * 17 + 3);
    if (gore && h > 0.9 && sc.textures.exists('d-blood')) { // dried blood pooled / smeared on the stone
      keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-blood').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.62).setAngle((hash(c * 2, r) * 360) | 0));
    } else if (h > 0.93 && sc.textures.exists('d-bones')) {
      keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-bones').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.85).setAngle((hash(c, r) * 360) | 0));
    } else if (h > 0.86 && sc.textures.exists('d-mush')) { // pale glowing fungus clusters near walls
      const wallAdj = dungeonIsWall(dungeonCell(c, r - 1)) || dungeonIsWall(dungeonCell(c, r + 1)) || dungeonIsWall(dungeonCell(c - 1, r)) || dungeonIsWall(dungeonCell(c + 1, r));
      if (wallAdj) keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-mush').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.9));
    } else if (h > 0.82 && sc.textures.exists('d-drip')) { // a slow ceiling drip + faint puddle
      keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-drip').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.5));
    }
    // claw marks raked across a wall-adjacent floor tile (gore floors only)
    if (gore && h > 0.5 && h < 0.56 && sc.textures.exists('d-claw')) {
      keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-claw').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.5).setFlipX(h < 0.53));
    }
    // cobwebs cling in inside corners (a wall on two adjacent sides)
    if (h < 0.16 && sc.textures.exists('d-web')) {
      const up = dungeonIsWall(dungeonCell(c, r - 1)), dn = dungeonIsWall(dungeonCell(c, r + 1));
      const lf = dungeonIsWall(dungeonCell(c - 1, r)), rt = dungeonIsWall(dungeonCell(c + 1, r));
      const corner = (up && lf) ? { fx: false, fy: false } : (up && rt) ? { fx: true, fy: false } : (dn && lf) ? { fx: false, fy: true } : (dn && rt) ? { fx: true, fy: true } : null;
      if (corner) keep(sc.add.image(wx + T / 2, wy + T / 2, 'd-web').setScale(sl).setOrigin(0.5).setDepth(base + 1).setAlpha(0.5).setFlipX(corner.fx).setFlipY(corner.fy));
    }
  }
  // A descent/ascent: rebuild for the new floor and drop the player at the matching stairwell. Does
  // NOT touch the run-purse — your loot rides with you between floors; you still must escape via B1.
  function changeFloor(toId: string, arriveChar: string) {
    const sc = petScene; if (!sc) return;
    setFloorGeom(toId);
    buildFloor(sc);
    const p = cellWorldOf(arriveChar) ?? { x: dInt.x + dInt.w / 2, y: dInt.y + dInt.h / 2 };
    selfX = p.x; selfY = p.y;
    vx = 0; vy = 0; keys.clear(); joyActive = false;
    mainCam?.setBounds(dInt.x, dInt.y, dInt.w, dInt.h);
    lastGrassKey = ''; grassDanger = 0; nearStairs = null; nearLockedDoor = null;
    nearSwitch = null; nearSwitchDoor = null; switchOn = false; // each floor's switch puzzle resets to default
    newMobsSeen.clear(); recentMob = -1; recentMobRun = 0; // each floor re-forces its new mobs first
    stairSound(arriveChar === '<'); // arriving at an up-stair means we descended
    setDungeonMusic(true); // re-evaluate per floor: silence on the boss sanctum, the loop everywhere else
    // NB: no dungeonSync here — that would reset the purse + provisional chests. The client already
    // holds every committed-open chest (from the entry sync) plus its own run-opens, so the rebuilt
    // floor renders chests correctly. The run (purse + provisional chests) rides between floors.
    updateDungeonHud();
  }
  function enterDungeon() {
    const sc = petScene; if (!sc) return;
    setFloorGeom('B1');
    buildFloor(sc);
    enterChime();
    inDungeon = true;
    driving = false; vx = 0; vy = 0;
    keys.clear(); joyActive = false;
    const e = dungeonEntry();
    selfX = e.x; selfY = e.y;
    mainCam?.setBounds(dInt.x, dInt.y, dInt.w, dInt.h);
    // dungeon theme (FFVI "Mines of Narshe") — loops while exploring
    if (!dungeonMusic) { dungeonMusic = new Audio('/dungeon.mp3'); dungeonMusic.loop = true; dungeonMusic.volume = 0.45; }
    dungeonMusic.currentTime = 0; encounterPending = false;
    setDungeonMusic(true);
    minimap.style.display = 'none'; help.style.display = 'none'; // no overworld minimap / drive hint underground
    dungeonHP = 100; lastGrassKey = ''; grassDanger = 0; potionCount = 0; // fresh run: no potions carried in
    newMobsSeen.clear(); recentMob = -1; recentMobRun = 0; impGavePotion = false; imp2Gave = false;
    hasKey = false; keyTaken = false; unlockedDoors.clear(); switchOn = false; // fresh run: re-fetch the key, doors re-lock, lever resets
    clarenceDefeated = false; clarenceArmed = false; robDefeated = false; // fresh run: the Gatekeeper bars the way again, Rob's back at his PC
    lootItems.length = 0; lootOpen = false; lootPanel.style.display = 'none'; // fresh run loot
    openedChestsServer.clear(); runOpens.clear();
    net.dungeonSync(); // ask the server which chests this account has already opened
    dungeonBanner.style.display = 'block'; dungeonControls.style.display = 'block'; lootBtn.style.display = 'block';
    dungeonChestCounter.style.display = 'block';
    updateDungeonHud(); updateDungeonControls();
  }
  const chestsFound = () => [...openedChestsServer].filter((id) => DUNGEON_CHEST_CONTENTS[id] && !id.endsWith(':boss')).length;
  function updateDungeonHud() {
    dungeonBanner.textContent = `🏚️ THE RUINS · ${currentFloor}   ·   ❤️ ${Math.round(dungeonHP)}   ·   🧪 ${potionCount}`
      + (dungeonPurseDisplay ? `   ·   💰 ${dungeonPurseDisplay}🪙 (escape to keep!)` : '');
    dungeonChestCounter.textContent = `📦 Chests opened  ${chestsFound()}/${DUNGEON_TOTAL_CHESTS}`;
    renderLootPanel();
  }
  function updateDungeonControls() {
    dungeonControls.innerHTML = `<b>WASD</b> / arrows — move &nbsp;·&nbsp; <b>P</b> — drink potion (×${potionCount}) &nbsp;·&nbsp; <b>L</b> — loot`;
  }
  // synthesized chest-open: a wooden creak then an ascending gold chime
  function chestSound() {
    tone(150, 0.12, 'square', 0.14, 92);
    window.setTimeout(() => tone(660, 0.07, 'square', 0.12, 880), 100);
    window.setTimeout(() => tone(880, 0.07, 'square', 0.12, 1180), 180);
    window.setTimeout(() => tone(1180, 0.13, 'square', 0.11, 1560), 260);
  }
  // stone-stair footsteps: a short three-note run — descending pitch going down, ascending going up.
  function stairSound(down: boolean) {
    const seq = down ? [440, 330, 247] : [247, 330, 440];
    seq.forEach((f, i) => window.setTimeout(() => tone(f, 0.09, 'triangle', 0.12, f * 0.7), i * 90));
  }
  // The B2 imp — short, snappy chat through the world's NPC text box. Hands you one potion per run.
  function impTalk() {
    if (talkOpen || dialogOpen) return;
    const gave = !impGavePotion;
    const pages = gave
      ? ['Easy — not here to fight.', 'Plenty came through. Few came back.', 'Here — 3 potions. Press P. +10 HP each, even mid-fight.']
      : ['Still alive? Good.', 'P to drink. Works mid-fight. +10 HP.'];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = 'Imp'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/imp_portrait.png')) npcPortrait.src = '/dungeon/imp_portrait.png';
    npcPortrait.style.display = 'block'; // his portrait floats above the box
    let pageI = 0, typing = false, timer = 0, full = '';
    const grantIfNeeded = () => { // he hands the potions over on his last line (once per run)
      if (gave && pageI === pages.length - 1 && !impGavePotion) {
        impGavePotion = true; potionCount += 3;
        tone(523, 0.08, 'square', 0.12, 784); window.setTimeout(() => tone(784, 0.13, 'square', 0.12, 1046), 80);
        updateDungeonHud(); updateDungeonControls();
      }
    };
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => {
        shown++; npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) textBlip();
        if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; grantIfNeeded(); }
      }, 30);
    }
    npcAdvance = () => {
      if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; grantIfNeeded(); return; }
      pageI++; if (pageI >= pages.length) closeTalk(); else showPage();
    };
    function closeTalk() { window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null; npcBox.style.display = 'none'; npcChoices.style.display = 'none'; npcPortrait.style.display = 'none'; }
    npcClose = closeTalk;
    showPage();
  }
  // The B5 chamber imp (post-Clarence): reassures you he's NOT the boss, hands over 3 potions, and
  // really hammers home that you should DRINK them mid-fight.
  function b5ImpTalk() {
    if (talkOpen || dialogOpen) return;
    const gave = !imp2Gave;
    const pages = gave
      ? ['Whoa, whoa — relax. I\'m not the boss.', "You look rattled. Here — three potions. On the house.", 'Now LISTEN to me. Press P to drink one. MID-fight. Even when the room\'s spinning. +10 HP each.', "People die clutching a full stash like it's a souvenir. Don't be a hero — USE them."]
      : ['Still hoarding those potions? Press P. Mid-fight. I mean it.'];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = 'Imp'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/imp_portrait.png')) npcPortrait.src = '/dungeon/imp_portrait.png';
    npcPortrait.style.display = 'block';
    let pageI = 0, typing = false, timer = 0, full = '';
    const grantIfNeeded = () => {
      if (gave && pageI === pages.length - 1 && !imp2Gave) {
        imp2Gave = true; potionCount += 3;
        tone(523, 0.08, 'square', 0.12, 784); window.setTimeout(() => tone(784, 0.13, 'square', 0.12, 1046), 80);
        updateDungeonHud(); updateDungeonControls();
      }
    };
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => { shown++; npcText.textContent = full.slice(0, shown); if (shown % 2 === 0) textBlip(); if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; grantIfNeeded(); } }, 30);
    }
    npcAdvance = () => { if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; grantIfNeeded(); return; } pageI++; if (pageI >= pages.length) closeTalk(); else showPage(); };
    function closeTalk() { window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null; npcBox.style.display = 'none'; npcChoices.style.display = 'none'; npcPortrait.style.display = 'none'; nearDungeonImp2 = false; }
    npcClose = closeTalk;
    showPage();
  }
  // The B3 dying adventurer — grim-but-funny. Hands over the key to B2's locked room, then expires.
  function dyingManTalk() {
    if (talkOpen || dialogOpen || keyTaken) return;
    const pages = [
      '*wet cough* …oh thank god. an audience.',
      "Don't make that face. You'd reek too — gut's been open since Tuesday.",
      "There's a thing down here wearing Fritz's face. Big grin. Came at me off the wall and opened me up like a letter.",
      'But I grabbed the vault key first. Small victories. Take it — *presses a warm, sticky iron key into your hand*. Locked room upstairs is yours.',
      'If you see that demon Fritz… ah, just run. Hits like my ex-wife. *he settles back and goes still*',
    ];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = 'Dying Adventurer'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/npc_dying.png')) npcPortrait.src = '/dungeon/npc_dying.png';
    npcPortrait.style.display = 'block';
    let pageI = 0, typing = false, timer = 0, full = '';
    const giveKey = () => { // he hands it over on the 4th line (once)
      if (keyTaken) return;
      keyTaken = true; hasKey = true; net.dungeonTakeKey();
      tone(660, 0.09, 'square', 0.12, 990); window.setTimeout(() => tone(880, 0.12, 'square', 0.12, 1320), 110); // got-key chime
      dyingManSprite?.setTint(0x6a6a72); // he's a corpse now
      updateDungeonHud();
    };
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => {
        shown++; npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) textBlip();
        if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; if (pageI >= 3) giveKey(); }
      }, 30);
    }
    npcAdvance = () => {
      if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; if (pageI >= 3) giveKey(); return; }
      pageI++; if (pageI >= pages.length) closeTalk(); else showPage();
    };
    function closeTalk() { window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null; npcBox.style.display = 'none'; npcChoices.style.display = 'none'; npcPortrait.style.display = 'none'; nearDyingMan = false; }
    npcClose = closeTalk;
    showPage();
  }
  // B6 FINAL BOSS: interrupt Rob at his PC. He's deep in a MapTap run and FURIOUS you barged in. A few
  // annoyed (and geography-flavored) lines, his portrait above the box. (The duel itself is wired next.)
  function robInterrupt() {
    if (talkOpen || dialogOpen) return;
    // pages: a string is a line; a {q,opts} is an interactive MapTap question (pick an answer, he reacts)
    type RobPage = string | { q: string; opts: { t: string; ok?: boolean }[] };
    const pages: RobPage[] = [
      'Mmf— do you MIND? I was on a streak.',
      "This is my office. The one door that stays SHUT. In here it's just me and MapTap — a name, a blank globe, one tap. It's the one thing that's mine.",
      "And you barged in mid-drop. Fine. You think you could do what I do? Quick:",
      { q: 'Capital of Australia?', opts: [{ t: 'Sydney' }, { t: 'Canberra', ok: true }, { t: 'Melbourne' }] },
      "…A list gives you options. The globe doesn't. Sit down — we settle this MY way.",
    ];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = 'Rob'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/mob_rob.png')) npcPortrait.src = '/dungeon/mob_rob.png';
    npcPortrait.style.display = 'block';
    let pageI = 0, typing = false, timer = 0, full = '', awaitingAnswer = false, pendingDone: (() => void) | null = null;
    function typeOut(text: string, done: () => void) {
      full = text; let shown = 0; typing = true; pendingDone = done; npcText.textContent = ''; npcHint.style.display = 'none'; npcChoices.style.display = 'none';
      timer = window.setInterval(() => {
        shown++; npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) textBlip();
        if (shown >= full.length) { window.clearInterval(timer); typing = false; pendingDone = null; done(); }
      }, 28);
    }
    function showPage() {
      const pg = pages[pageI];
      if (pg === undefined) { closeTalk(); return; }
      awaitingAnswer = false; npcChoices.replaceChildren();
      if (typeof pg === 'string') { typeOut(pg, () => { npcHint.style.display = 'block'; }); return; }
      typeOut(pg.q, () => { // a question → lay out the answer buttons
        awaitingAnswer = true; npcChoices.style.display = 'flex'; npcChoices.style.flexWrap = 'wrap';
        for (const o of pg.opts) {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = o.t;
          b.style.cssText = 'cursor:pointer;background:#21305a;color:#e8eefc;border:1px solid #3a508f;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;';
          b.onmouseenter = () => { b.style.background = '#2c4079'; }; b.onmouseleave = () => { b.style.background = '#21305a'; };
          b.onclick = (e) => {
            e.stopPropagation(); if (!awaitingAnswer) return; awaitingAnswer = false;
            const right = pg.opts.find((x) => x.ok)!.t;
            npcChoices.style.display = 'none';
            tone(o.ok ? 880 : 160, 0.1, o.ok ? 'square' : 'sawtooth', 0.12, o.ok ? 1180 : 110);
            typeOut(o.ok ? `${o.t}. …Correct. Lucky.` : `${o.t}? No. It's ${right}. Of course it's ${right}.`, () => { npcHint.style.display = 'block'; });
          };
          npcChoices.appendChild(b);
        }
      });
    }
    npcAdvance = () => {
      if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; const d = pendingDone; pendingDone = null; d?.(); return; } // finish typing → run its done (lay out options / show hint)
      if (awaitingAnswer) return; // must pick an answer first
      pageI++; if (pageI >= pages.length) closeTalk(); else showPage();
    };
    function closeTalk() {
      window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null;
      npcBox.style.display = 'none'; npcChoices.style.display = 'none'; npcChoices.replaceChildren(); npcPortrait.style.display = 'none'; nearRob = false;
      // the dialogue's over → the duel. Beating Rob conquers the Ruins (escape with everything).
      const rob = DUNGEON_MOBS.find((m) => m.id === 'rob');
      triggerEncounter({ mob: rob, song: '/inthend.mp3', onWin: robVictory });
    }
    npcClose = closeTalk;
    showPage();
  }
  // Beat Rob → his defeated monologue, then a big "spoils" GUI, then the prizes are granted + you escape.
  function robVictory() {
    robDefeated = true; robBoss?.sprite.destroy(); robBoss = null;
    const pages = [
      '…Hah. Beaten. In my own office. By someone who kicked the door in mid-drop.',
      'You want to know the worst part? It was never about the interruption. Out there, everyone wants something from me. In here it was just me, a blank globe, and a name to find. The one thing that was mine.',
      'And you took even that. …Go on. Take whatever you came down here for. I have a daily to re-run anyway.',
      "But for the record? It's still Canberra. It is ALWAYS Canberra.",
    ];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = 'Rob'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/mob_rob.png')) npcPortrait.src = '/dungeon/mob_rob.png';
    npcPortrait.style.display = 'block';
    let pageI = 0, typing = false, timer = 0, full = '';
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => { shown++; npcText.textContent = full.slice(0, shown); if (shown % 2 === 0) textBlip(); if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; } }, 30);
    }
    npcAdvance = () => { if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; return; } pageI++; if (pageI >= pages.length) closeTalk(); else showPage(); };
    function closeTalk() { window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null; npcBox.style.display = 'none'; npcPortrait.style.display = 'none'; showBossRewards(); }
    npcClose = closeTalk; showPage();
  }
  // The big "THE RUINS — CONQUERED" spoils screen: victory fanfare + every reward listed, click to claim.
  function showBossRewards() {
    try { const f = new Audio('/victory.mp3'); f.volume = 0.85; f.play().catch(() => {}); } catch { /* ignore */ }
    const reward = DUNGEON_CHEST_CONTENTS['B6:boss'];
    const rows = [`💰 ${(reward?.coins ?? 0).toLocaleString()} coins`];
    for (const id of reward?.items ?? []) rows.push(COSMETICS.find((c) => c.id === id)?.name ?? id);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100003;background:radial-gradient(circle at 50% 35%,#1a1330ee,#05030cf2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:ui-monospace,Menlo,monospace;';
    const h = document.createElement('div'); h.textContent = '🏆 THE RUINS — CONQUERED'; h.style.cssText = 'font-size:30px;font-weight:900;color:#ffd24a;text-shadow:0 2px 10px #000;letter-spacing:1px;';
    const sub = document.createElement('div'); sub.textContent = 'You beat Rob. Your spoils:'; sub.style.cssText = 'font-size:14px;color:#b9c4e6;margin-bottom:4px;';
    const box = document.createElement('div'); box.style.cssText = 'background:#0e1224;border:2px solid #3a508f;border-radius:14px;padding:16px 26px;display:flex;flex-direction:column;gap:9px;min-width:280px;';
    for (const r of rows) { const row = document.createElement('div'); row.textContent = '✦ ' + r; row.style.cssText = 'font-size:17px;color:#eef2ff;font-weight:600;'; box.appendChild(row); }
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '▶ Claim & climb out';
    btn.style.cssText = 'margin-top:10px;cursor:pointer;background:#c0392b;color:#fff;border:none;border-radius:10px;padding:13px 26px;font-size:16px;font-weight:800;';
    btn.onmouseenter = () => { btn.style.background = '#d8472f'; }; btn.onmouseleave = () => { btn.style.background = '#c0392b'; };
    btn.onclick = () => { wrap.remove(); net.dungeonChest('B6:boss'); window.setTimeout(() => leaveDungeon(true), 300); };
    wrap.append(h, sub, box, btn);
    overlay.appendChild(wrap);
  }
  // a Pokémon-style "!" pops over your head + a two-note sting the instant the Gatekeeper notices you
  function exclaimAlert() {
    const sc = petScene; if (!sc) return;
    const mark = sc.add.text(selfX, selfY - R - 12, '❗', { fontSize: '30px', fontStyle: 'bold' }).setOrigin(0.5, 1).setDepth(60000);
    let pop = 0; const iv = window.setInterval(() => { pop++; mark.setScale(1 + Math.max(0, 0.4 - pop * 0.05)); if (pop > 8) window.clearInterval(iv); }, 30);
    window.setTimeout(() => mark.destroy(), 950);
    tone(880, 0.08, 'square', 0.14, 1180); window.setTimeout(() => tone(1320, 0.13, 'square', 0.12, 1620), 110);
  }
  // B5 GATEKEEPER: stepping into the chamber alerts Clarence ("!"), he strides over from the far wall,
  // THEN bars the way with a few ominous lines (portrait above the box) → the fight, on the battle theme.
  function summonClarence() {
    if (talkOpen || dialogOpen || isEncounterOpen() || encounterPending) return;
    talkOpen = true; // freeze the player for the cutscene (no dialogue box shown yet)
    keys.clear(); joyActive = false; vx = 0; vy = 0; prompt.style.display = 'none';
    exclaimAlert();
    if (clarenceSprite) clarenceAnim = { t: 0, fromX: clarenceSprite.x, toX: selfX + DUNGEON_TILE * 2.7, y: selfY }; // stride in, stop a few tiles off
    else clarenceDialogue(); // no sprite (texture missing) → straight to the words
  }
  function clarenceDialogue() {
    const pages = [
      'Far enough.',
      'I know what waits past that door. You are not ready — none of you ever are.',
      'I am Clarence. The last lock. And I do not turn.',
      'Here — let me show you which way is up.',
    ];
    talkOpen = true; keys.clear(); joyActive = false; vx = 0; vy = 0; prompt.style.display = 'none';
    npcName.textContent = 'Clarence, the Gatekeeper'; npcBox.style.display = 'block'; npcChoices.style.display = 'none';
    if (!npcPortrait.src.endsWith('/dungeon/mob_clarence.png')) npcPortrait.src = '/dungeon/mob_clarence.png';
    npcPortrait.style.display = 'block';
    let pageI = 0, typing = false, timer = 0, full = '';
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => {
        shown++; npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) textBlip();
        if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; }
      }, 30);
    }
    npcAdvance = () => {
      if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; return; }
      pageI++; if (pageI >= pages.length) closeTalk(); else showPage();
    };
    function closeTalk() {
      window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null;
      npcBox.style.display = 'none'; npcChoices.style.display = 'none'; npcPortrait.style.display = 'none';
      const clarence = DUNGEON_MOBS.find((m) => m.id === 'clarence'); // → the fight, on the battle theme
      triggerEncounter({ mob: clarence, song: '/battle.mp3', winPotions: 5, onWin: () => { clarenceDefeated = true; clarenceSprite?.destroy(); clarenceSprite = null; const sc = petScene; if (sc) buildFloor(sc); } }); // fleeWins is TEMP for testing; rebuild → the chamber's chests appear
    }
    npcClose = closeTalk;
    showPage();
  }
  // Open B2's locked room with the key in hand: remove the door + sprite, spend the key, clunk open.
  function unlockDoor(c: number, r: number) {
    if (!hasKey) return;
    hasKey = false;
    unlockedDoors.add(`${currentFloor}:${c},${r}`);
    dungeonLockSprites[`${c},${r}`]?.destroy(); delete dungeonLockSprites[`${c},${r}`];
    tone(170, 0.1, 'square', 0.16, 90); window.setTimeout(() => tone(440, 0.13, 'triangle', 0.14, 660), 130); // clunk → unlatch
    showToast('🔓 The lock turns over with a heavy clunk. The door grinds open.');
    nearLockedDoor = null; updateNearBuilding();
  }
  // a heavy, immovable lock: a dull iron thunk then a dead rattle (it does NOT give)
  function lockedSound() {
    tone(90, 0.13, 'square', 0.16, 60);
    window.setTimeout(() => tone(70, 0.16, 'sawtooth', 0.10, 48), 120);
    window.setTimeout(() => tone(150, 0.05, 'square', 0.06, 120), 180);
  }
  // Try the sealed door with no key — it won't budge. A creepy line + the dead-lock sound.
  const LOCKED_LINES = [
    "🔒 The lock is cold and won't turn. You need a key.",
    "🔒 Something heavy holds this door shut. There's a key for it — not on you.",
    "🔒 You rattle the iron. It doesn't give. A key must be down here somewhere…",
    "🔒 Sealed tight. Whatever's behind it wants to stay behind it — find the key.",
  ];
  function tryLockedDoor() {
    lockedSound();
    showToast(LOCKED_LINES[Math.floor(Math.random() * LOCKED_LINES.length)]);
  }
  // the lever throw: a chunky mechanical clack, then a long grinding-stone rumble of distant doors
  function switchSound() {
    tone(120, 0.09, 'square', 0.18, 70);
    window.setTimeout(() => noise(0.7, 0.14, 240), 80);                  // the grind of stone on stone
    window.setTimeout(() => tone(58, 0.55, 'sawtooth', 0.10, 40), 120); // a low rumble underneath it
  }
  // Throw the B4 wall lever: flip which switch-door is sealed, jolt the camera (earthquake-style),
  // rumble + grind, and rebuild the floor so both doors + the lever re-render in their new state.
  function flipSwitch() {
    const sc = petScene; if (!sc) return;
    switchOn = !switchOn;
    buildFloor(sc);
    mainCam?.shake(620, 0.011);
    switchSound();
    showToast('🔧 <b>KA-CHUNK.</b> Deep in the dark, stone grinds on stone — somewhere a door opens, and somewhere another slams shut…');
    nearSwitch = null; updateNearBuilding();
  }
  // Try a switch-sealed 'X'/'Y' door by hand — no keyhole, won't budge. A nudge toward the lever.
  function trySwitchDoor() {
    lockedSound();
    showToast("🔒 No keyhole — just a heavy mechanism, jammed shut. There's a switch somewhere on this floor that works it.");
  }
  function openChest(c: number, r: number) {
    if (chestIsOpen(c, r)) return;
    const id = `${currentFloor}:${c},${r}`;
    const contents = DUNGEON_CHEST_CONTENTS[id];
    if (contents?.monster) { // a monster box! it lunges out into a fight instead of handing over loot
      nearChestCell = null; updateNearBuilding();
      chestSound();
      keys.clear(); joyActive = false; vx = 0; vy = 0; // freeze the player for the reveal
      showToast('📦😱 A monster jumped out of the box!');
      const mob = DUNGEON_MOBS.find((m) => m.id === contents.monster) ?? DUNGEON_MOBS[0];
      const win = contents.coins ?? 0;
      encounterPending = true; // hold off any other encounter while the reveal line is on screen
      window.setTimeout(() => { // let the toast breathe ~1.1s, THEN the battle overlay takes over
        encounterPending = false;
        triggerEncounter({ mob, capturable: !!contents.pet, chestId: id, chestC: c, chestR: r, coins: [win, win] });
      }, 1100);
      return;
    }
    openedChestsServer.add(id); runOpens.add(id);      // optimistic (provisional this run) — the server confirms + pays/grants
    dungeonChestSprites[`${c},${r}`]?.setTexture('w-chest-open');
    chestSound();
    net.dungeonChest(id);                              // → server: pay the coins from the House / grant the potion
    nearChestCell = null;
    updateNearBuilding();
  }
  function usePotion() {
    if (potionCount <= 0) { showToast('🧪 No potions to drink.'); return; }
    if (dungeonHP >= 100) { showToast('❤️ Already at full HP.'); return; }
    potionCount = Math.max(0, potionCount - 1);
    dungeonHP = Math.min(100, dungeonHP + 10);
    tone(523, 0.08, 'square', 0.12, 784); window.setTimeout(() => tone(784, 0.13, 'square', 0.12, 1046), 80);
    showToast('🧪 +10 HP');
    updateDungeonHud(); updateDungeonControls();
  }
  // Pick a mob from the floor's pool, shuffle-bagged: re-rolls if it would be the same mob 3× running.
  function pickMobIdx(pool: number[]): number {
    let idx = pool[Math.floor(Math.random() * pool.length)];
    if (idx === recentMob && recentMobRun >= 2 && pool.length > 1) {
      do { idx = pool[Math.floor(Math.random() * pool.length)]; } while (idx === recentMob);
    }
    recentMobRun = idx === recentMob ? recentMobRun + 1 : 1;
    recentMob = idx;
    return idx;
  }
  // Floor mob selection: force BOTH of this floor's NEW mobs (random order) before any carried-over
  // mob can appear. Once both new mobs are met, spawn from the full pool (new + carry), shuffle-bagged.
  function pickFloorMob(): number {
    const unseen = floorNewMobs(currentFloor).filter((i) => !newMobsSeen.has(i));
    if (unseen.length > 0) {
      const idx = unseen[Math.floor(Math.random() * unseen.length)];
      newMobsSeen.add(idx); recentMob = idx; recentMobRun = 1;
      return idx;
    }
    return pickMobIdx([...floorNewMobs(currentFloor), ...floorCarryMobs(currentFloor)]);
  }
  // Play/pause the dungeon theme race-safely. Calling pause() while a previous play() promise is still
  // settling is silently ignored by the browser (the track keeps playing over the battle/fanfare), so
  // we track the DESIRED state and re-assert it once the play promise resolves.
  let dungeonMusicWanted = false;
  function setDungeonMusic(on: boolean) {
    if (on && DUNGEON_THEME[currentFloor]?.silent) on = false; // the boss sanctum (B5) plays NO music — silence is the dread
    dungeonMusicWanted = on;
    if (!dungeonMusic) return;
    if (on) dungeonMusic.play().then(() => { if (!dungeonMusicWanted) dungeonMusic?.pause(); }).catch(() => { /* gesture */ });
    else dungeonMusic.pause();
  }
  let encounterPending = false; // a battle is being set up (snapshot in flight) — block re-triggering
  // A tall-grass encounter: pause the dungeon theme and drop into a Pong duel vs a mob. `cfg` lets a
  // "monster box" chest force a specific mob, mark it capturable, and route its reward through the chest.
  type EncounterCfg = { mob?: (typeof DUNGEON_MOBS)[number]; capturable?: boolean; chestId?: string; chestC?: number; chestR?: number; coins?: [number, number]; song?: string; winPotions?: number; onWin?: () => void; fleeWins?: boolean };
  function triggerEncounter(cfg?: EncounterCfg) {
    if (isEncounterOpen() || encounterPending) return;
    encounterPending = true;
    keys.clear(); joyActive = false; vx = 0; vy = 0;
    setDungeonMusic(false);
    const mob = cfg?.mob ?? DUNGEON_MOBS[pickFloorMob()]; // new mobs forced first, then full pool, shuffle-bagged
    // Snapshot the live dungeon view FIRST (loop must still be running), then sleep + open the
    // battle — the snapshot is the world frame the Pokémon strip-transition animates apart.
    const begin = (snap: HTMLImageElement | null) => {
      game?.loop.sleep(); // freeze the World's render loop so the battle gets full frames (this client only)
      if (game?.canvas) game.canvas.style.display = 'none'; // and stop the browser compositing it
      startEncounter({
        mob, hp: dungeonHP, introImage: snap,
        coins: cfg?.coins ?? [...(DUNGEON_TIER_COINS[mob.tier] ?? DUNGEON_TIER_COINS[1])] as [number, number], // display only — server is authoritative
        itemChance: cfg?.chestId ? 0 : (mob.dropChance ?? 0), // most mobs drop only coins; some (Demon Fritz) drop a potion on a win
        capturable: cfg?.capturable,
        song: cfg?.song, // a boss fight overrides the cycled theme (Clarence → the battle theme)
        potions: { // drink a potion mid-battle (P): consumes one of the run's potions for +10 HP
          count: () => potionCount,
          consume: () => { if (potionCount <= 0) return false; potionCount -= 1; updateDungeonHud(); updateDungeonControls(); return true; },
        },
        onResult: (r) => {
          encounterPending = false;
          if (game?.canvas) game.canvas.style.display = 'block';
          game?.loop.wake();
          dungeonHP = Math.max(0, dungeonHP - r.hpLost);
          const markBox = () => { // the monster box is consumed only once its fight resolves (flee/death → retryable)
            if (cfg?.chestId == null) return;
            openedChestsServer.add(cfg.chestId); runOpens.add(cfg.chestId);
            dungeonChestSprites[`${cfg.chestC},${cfg.chestR}`]?.setTexture('w-chest-open');
          };
          if (r.result === 'capture' && cfg?.chestId) {            // caught it → server grants the pet (run-scoped)
            markBox(); net.dungeonChest(cfg.chestId, true);
            showToast(`🎉 Gotcha! The ${mob.name} is yours — escape the Ruins to keep it!`);
          } else if (r.result === 'win' || (r.result === 'flee' && cfg?.fleeWins)) { // TEMP: flee counts as a win for the Clarence boss (testing)
            if (cfg?.chestId) {                                    // killed the box-mob → server pays the chest's coins
              markBox(); net.dungeonChest(cfg.chestId);
              showToast(`📦 You smashed it! ${cfg.coins?.[0] ?? 0}🪙 — escape to keep!`);
            } else if (cfg?.winPotions != null) {                  // a boss (Clarence) → potions, not coins; no server credit
              potionCount += cfg.winPotions;
              showToast(`🏆 You bested ${mob.name}! +${cfg.winPotions} 🧪 Potions — the way is open.`);
            } else if (!cfg?.onWin) {
              net.dungeonWin(currentFloor, mob.tier);              // a normal mob win → coins by tier from the House
            }
            cfg?.onWin?.();                                        // bosses (Clarence/Rob) run their own follow-up
            if (r.item) potionCount += 1;
          }
          if (dungeonHP <= 0) { showToast('💀 You black out — your loot is lost in the dark…'); leaveDungeon(false); }
          else { setDungeonMusic(true); updateDungeonHud(); updateDungeonControls(); }
        },
      });
    };
    const renderer = game?.renderer as unknown as { snapshot?: (cb: (img: unknown) => void) => void } | undefined;
    if (renderer?.snapshot) {
      let done = false;
      const finish = (img: unknown) => { if (done) return; done = true; begin(img instanceof HTMLImageElement ? img : null); };
      renderer.snapshot(finish);
      window.setTimeout(() => finish(null), 250); // fallback if the snapshot never fires
    } else begin(null);
  }
  function leaveDungeon(escaped = true) {
    net.dungeonExit(escaped); // escaped (walked out via B1 / beat the boss) → server pays the purse; else forfeit
    // Bank or roll back this run's chest opens client-side, mirroring the server: escape commits them,
    // death forfeits them (so openedChestsServer always reflects what's actually banked to the account).
    if (!escaped) for (const id of runOpens) openedChestsServer.delete(id);
    runOpens.clear();
    inDungeon = false;
    nearExit = false;
    dungeonPurseDisplay = 0;
    encounterPending = false;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    setDungeonMusic(false);
    minimap.style.display = 'block'; help.style.display = 'block'; // restore overworld HUD
    dungeonBanner.style.display = 'none'; dungeonControls.style.display = 'none';
    dungeonChestCounter.style.display = 'none';
    lootBtn.style.display = 'none'; lootPanel.style.display = 'none'; lootOpen = false;
    const d = WORLD_BUILDINGS.find((b) => b.kind === 'dungeon');
    if (d) { selfX = d.x + d.w / 2; selfY = d.y + d.h + 44; } // step back out the doorway
    enterChime();
    renderObjectives(); // refresh the count after committing/rolling back this run's opens
    if (escaped) checkProgressObjectives(); // only a clean escape banks chests → can complete "open every chest in the Ruins"
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
  interface Objective { id: string; label: string; reward: number; done: boolean; progress?: () => [number, number]; hideProgress?: boolean }
  const PONG_WINS_KEY = 'tsong.world.pongWins'; // bumped by main.ts on each match win
  const pongWins = () => { try { return parseInt(localStorage.getItem(PONG_WINS_KEY) || '0', 10) || 0; } catch { return 0; } };
  const objectives: Objective[] = [
    { id: 'find-waldo', label: 'Find Waldo', reward: 400, done: false },
    { id: 'give-banana', label: 'Give Kevin a banana', reward: 400, done: false },
    { id: 'win-ten', label: 'Win 10 tsong games', reward: 1000, done: false, progress: () => [Math.min(pongWins(), 10), 10] },
    { id: 'ruins-chests', label: 'Open every chest in the Ruins', reward: 50000, done: false, progress: () => [chestsFound(), DUNGEON_TOTAL_CHESTS], hideProgress: true },
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
      const prog = !o.done && o.progress && !o.hideProgress ? ` (${o.progress()[0]}/${o.progress()[1]})` : '';
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
    npcPortrait.style.display = 'none'; // world NPCs have no portrait (only the imp, for now)

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
    if (nearExit) { if (inDungeon) leaveDungeon(); else leaveTavern(); return; }
    if (nearStairs) { changeFloor(nearStairs.to, nearStairs.dir === 'down' ? '<' : '>'); return; }
    if (nearBossStairs) { // the deepest stairwell — boss floor not carved yet, so it just breathes at you
      tone(48, 0.7, 'sawtooth', 0.12, 32); window.setTimeout(() => tone(40, 0.9, 'sine', 0.10, 28), 200);
      showToast('⬇️ The stairs drop into a blackness that swallows your light. Something vast shifts far below… <i>not yet.</i>');
      return;
    }
    if (nearChestCell) { openChest(nearChestCell.c, nearChestCell.r); return; }
    if (nearLockedDoor) { if (hasKey) unlockDoor(nearLockedDoor.c, nearLockedDoor.r); else tryLockedDoor(); return; }
    if (nearSwitch) { flipSwitch(); return; }
    if (nearSwitchDoor) { trySwitchDoor(); return; }
    if (nearDungeonImp) { impTalk(); return; }
    if (nearDungeonImp2) { b5ImpTalk(); return; }
    if (nearDyingMan) { dyingManTalk(); return; }
    if (nearRob) { robInterrupt(); return; }
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
    if (isEncounterOpen()) return; // the battle overlay owns input while it's up
    unlockAudio();
    const k = e.key.toLowerCase();
    if (inDungeon && k === 'p') { e.preventDefault(); usePotion(); return; } // drink a potion (+10 HP)
    if (inDungeon && k === 'l') { e.preventDefault(); toggleLoot(); return; } // 🎒 toggle the run-loot panel
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      if (fullMapOpen) toggleFullMap(); else if (talkOpen) npcClose?.(); else if (dialogOpen) closeDialog(); else exit();
      return;
    }
    if (k === 'm') { e.preventDefault(); e.stopPropagation(); toggleFullMap(); return; } // M → full map
    // While chatting, Enter / Space / E advances the dialogue; movement is frozen.
    if (talkOpen) {
      if (k === 'enter' || k === ' ' || k === 'e') { e.preventDefault(); e.stopPropagation(); npcAdvance?.(); }
      else if (MOVE_KEYS.has(k)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (dialogOpen) return;
    if (k === 'f') { e.preventDefault(); e.stopPropagation(); toggleDrive(); return; }
    if (k === 'enter' || k === 'e' || k === ' ') {
      // Always swallow Space so the page never scrolls; interact with whatever's in range
      // (building, NPC, netizen, exit, chest, or jail — triggerNear no-ops if nothing is).
      e.preventDefault(); e.stopPropagation();
      triggerNear(); // no-ops if nothing's in range; also covers dungeon chests/stairs/exit + parcels
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
    if (isEncounterOpen()) return; // frozen while a battle overlay is up
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
    if (inDungeon) {
      // inside the Ruins: collide per-tile against the walls/chests (slide along each axis), and
      // play the overworld's synthesized "boop" when you bump something solid.
      const nx = selfX + dx * SPEED * dt, ny = selfY + dy * SPEED * dt;
      let hit = false;
      if (!dungeonBlocked(nx, selfY)) selfX = nx; else hit = true;
      if (!dungeonBlocked(selfX, ny)) selfY = ny; else hit = true;
      if (hit) bumpSound(false); else stepSound();
      // Cave-style encounters: every new tile you step onto bumps a rising danger meter and rolls.
      // Tall grass (~) ramps faster. The meter resets to 0 on a fight, so you get safe steps then
      // the odds climb — never instant-spammy, never dead-quiet. The boss sanctum (B5) has none.
      const cc = Math.floor((selfX - dInt.x) / DUNGEON_TILE), cr = Math.floor((selfY - dInt.y) / DUNGEON_TILE);
      const cell = dungeonCell(cc, cr), key = cc + ',' + cr;
      if (currentFloor !== 'B5' && currentFloor !== 'B6' && key !== lastGrassKey) {
        lastGrassKey = key;
        if (cell !== '@' && cell !== '>' && cell !== '<' && cell !== 'X' && cell !== 'Y') { // no ambush on entry/stairs/door tiles
          grassDanger += cell === '~' ? 2 : 1;
          // After a fight the meter resets to 0, and the first ~14 tiles are a GUARANTEED breather
          // (no roll at all) so you never get jumped twice in a row. Past that the odds ramp gently —
          // ~50 tiles (~10s) avg between fights, faster in grass. Big floors stay explorable, not spammy.
          const steps = grassDanger - 14;
          if (steps > 0 && Math.random() < Math.min(0.6, steps * 0.0011)) { grassDanger = 0; triggerEncounter(); }
        }
      }
      // B5: stepping out of the long hall into the grand chamber summons the Gatekeeper. He re-arms only
      // once you've retreated back down the hall, so fleeing doesn't instantly re-trigger him.
      if (currentFloor === 'B5' && !clarenceDefeated && !talkOpen && !dialogOpen && !isEncounterOpen() && !encounterPending) {
        const pcol = Math.floor((selfX - dInt.x) / DUNGEON_TILE);
        if (pcol < 24) clarenceArmed = true;
        else if (clarenceArmed && pcol >= 27) { clarenceArmed = false; summonClarence(); }
      }
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
    if (!inInterior && !inDungeon) {
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
    if (inDungeon && cellWorldOf('@')) { // the '@' arrival cell (B1 only) doubles as the way out
      const e = dungeonEntry();
      if (Math.abs(selfX - e.x) < 44 && Math.abs(selfY - e.y) < 44) nearExit = true;
    }
    // Stairs within reach: '>' descends to the next floor, '<' ascends to the previous one.
    nearStairs = null; nearBossStairs = false;
    if (inDungeon && !nearExit) {
      const idx = DUNGEON_ORDER.indexOf(currentFloor);
      const down = cellWorldOf('>'), up = cellWorldOf('<');
      const onDown = down && Math.abs(selfX - down.x) < 40 && Math.abs(selfY - down.y) < 40;
      const downSealed = currentFloor === 'B5' && !clarenceDefeated; // the office door opens only once the Gatekeeper falls
      if (onDown && idx < DUNGEON_ORDER.length - 1 && !downSealed) nearStairs = { dir: 'down', to: DUNGEON_ORDER[idx + 1] };
      else if (onDown) nearBossStairs = true; // deepest floor: the '>' plunges to the (not-yet-built) boss level
      else if (up && Math.abs(selfX - up.x) < 40 && Math.abs(selfY - up.y) < 40 && idx > 0)
        nearStairs = { dir: 'up', to: DUNGEON_ORDER[idx - 1] };
    }
    nearChestCell = null;
    if (inDungeon && !nearExit && !nearStairs && !(currentFloor === 'B5' && !clarenceDefeated)) { // nearest unopened chest within reach → Open prompt (B5 chests are sealed until Clarence falls)
      let best = (DUNGEON_TILE * 1.5) ** 2;
      for (const k of chestCells()) {
        const [cc, cr] = k.split(',').map(Number);
        if (chestIsOpen(cc, cr)) continue;
        const cxw = dInt.x + (cc + 0.5) * DUNGEON_TILE, cyw = dInt.y + (cr + 0.5) * DUNGEON_TILE;
        const d2 = (selfX - cxw) ** 2 + (selfY - cyw) ** 2;
        if (d2 < best) { best = d2; nearChestCell = { c: cc, r: cr }; }
      }
    }
    nearLockedDoor = null; nearSwitch = null; nearSwitchDoor = null;
    if (inDungeon && !nearExit && !nearStairs && !nearChestCell) { // a sealed door / wall lever within reach
      const pc = Math.floor((selfX - dInt.x) / DUNGEON_TILE), pr = Math.floor((selfY - dInt.y) / DUNGEON_TILE);
      for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]] as const) {
        const ch = dungeonCell(pc + dc, pr + dr);
        if (ch === 'L' && !doorIsOpen(pc + dc, pr + dr)) { nearLockedDoor = { c: pc + dc, r: pr + dr }; break; }
        if (ch === 'W') { nearSwitch = { c: pc + dc, r: pr + dr }; break; }
        if ((ch === 'X' && !switchOn) || (ch === 'Y' && switchOn)) { nearSwitchDoor = { c: pc + dc, r: pr + dr }; break; } // a switch-sealed door
      }
    }
    const nearDoorOrSwitch = nearLockedDoor || nearSwitch || nearSwitchDoor;
    nearDungeonImp = !!(inDungeon && dungeonImp && !nearExit && !nearStairs && !nearChestCell && !nearDoorOrSwitch
      && Math.hypot(selfX - dungeonImp.x, selfY - dungeonImp.y) < DUNGEON_TILE * 1.4);
    nearDungeonImp2 = !!(inDungeon && dungeonImp2 && !nearExit && !nearStairs && !nearChestCell && !nearDoorOrSwitch
      && Math.hypot(selfX - dungeonImp2.x, selfY - dungeonImp2.y) < DUNGEON_TILE * 1.4);
    nearDyingMan = !!(inDungeon && dyingMan && !keyTaken && !nearExit && !nearStairs && !nearChestCell && !nearDoorOrSwitch
      && Math.hypot(selfX - dyingMan.x, selfY - dyingMan.y) < DUNGEON_TILE * 1.4);
    nearRob = !!(inDungeon && robBoss && !robDefeated && !nearExit && !nearStairs && !nearChestCell && !nearDoorOrSwitch
      && Math.hypot(selfX - robBoss.x, selfY - robBoss.y) < DUNGEON_TILE * 1.7);
    // A jailed avatar within reach (and we're free) → offer to post their bail.
    nearJailed = null;
    if (!best && !nearNpc && !nearNetizen && !driving && !net.amJailed() && !inInterior && !inDungeon) {
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
      prompt.textContent = inDungeon ? '🚪 Leave the Ruins' : '🚪 Leave the Tavern';
    } else if (nearStairs) {
      prompt.textContent = nearStairs.dir === 'down' ? `⬇️ Descend to ${nearStairs.to}` : `⬆️ Climb up to ${nearStairs.to}`;
    } else if (nearBossStairs) {
      prompt.textContent = '⬇️ A stairwell into the black';
    } else if (nearChestCell) {
      prompt.textContent = '📦 Open the chest';
    } else if (nearLockedDoor) {
      prompt.textContent = hasKey ? '🔑 Unlock the door' : '🔒 Locked door';
    } else if (nearSwitch) {
      prompt.textContent = '🔧 Throw the switch';
    } else if (nearSwitchDoor) {
      prompt.textContent = '🔒 Sealed door';
    } else if (nearDungeonImp || nearDungeonImp2) {
      prompt.textContent = '💬 Talk to the Imp';
    } else if (nearDyingMan) {
      prompt.textContent = '🤢 Talk to the dying man (he reeks)';
    } else if (nearRob) {
      prompt.textContent = '💻 Interrupt him';
    } else if (nearJailed) {
      prompt.textContent = `🔓 Bail out ${nearJailed.name} (${BAIL_COST}🪙)`;
    } else if (nearParcel) {
      prompt.textContent = parcelPrompt(nearParcel);
    }
    prompt.style.display = (nearId || nearNpc || nearNetizen || nearExit || nearStairs || nearBossStairs || nearChestCell || nearLockedDoor || nearSwitch || nearSwitchDoor || nearDungeonImp || nearDungeonImp2 || nearDyingMan || nearRob || nearJailed || nearParcel) && !dialogOpen && !talkOpen ? 'block' : 'none';
  }

  function maybeSendMove(now: number) {
    if (inInterior || inDungeon) return; // don't stream off-map interior/dungeon coords — others see you parked at the door
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
    carWheels: Phaser.GameObjects.Image; // big untinted tires — only shown for the Monster Truck
    smokeT: number; sx: number; sy: number; // exhaust-smoke emit cooldown + last position (movement gate)
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
  // Dungeon lighting: a near-black camera-fixed wash + warm flickering torch glows + a light you
  // carry. All inert (alpha 0) unless you're in the Ruins. Built in create()/buildFloor().
  // Lighting = a camera-fixed darkness RenderTexture with soft holes ERASED at each torch + the
  // player, so lit areas reveal the real tiles at full brightness (not a foggy additive wash) and
  // unlit areas are only dimmed.
  let dungeonDarkRT: Phaser.GameObjects.RenderTexture | null = null;
  let dungeonLightBrush: Phaser.GameObjects.Image | null = null; // reused stamp for erasing light holes
  const dungeonTorches: { x: number; y: number; phase: number; fire: number }[] = [];
  // Drifting fireflies (red/orange/purple) that twinkle in the dark — a pleasant little touch.
  const dungeonFlies: { glow: Phaser.GameObjects.Image; core: Phaser.GameObjects.Image; x: number; y: number; vx: number; vy: number; phase: number }[] = [];
  // Looping FFVI "Mines of Narshe" dungeon theme — starts on entry, pauses on exit (encounter
  // music will pause/resume this later). Created lazily so it never autoplays before a gesture.
  let dungeonMusic: HTMLAudioElement | null = null;
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

    // --- Clarence, the B5 Gatekeeper, as a proper standing NPC (16×24): swept dark hair, tan skin,
    //     cold glowing-violet eyes, a tailored navy suit with white shirt + dark tie, slacks + shoes. ---
    {
      const HAIR = 0x17171f, SKN = 0xd6a172, SKN_D = 0xb07c52, SUIT = 0x232b48, SUIT_D = 0x151b32,
        SUIT_L = 0x3a487c, SHIRT = 0xeaeef7, TIE = 0x111119, SHOE = 0x0c0c12, EYE = 0xc198ff, EYEC = 0xfff2ff;
      g.clear();
      // hair (rounded crown + side sweep)
      px(5, 0, 6, 1, HAIR); px(4, 1, 8, 1, HAIR); px(4, 2, 8, 1, HAIR);
      px(4, 3, 1, 2, HAIR); px(11, 3, 1, 2, HAIR);
      // face
      px(5, 3, 6, 5, SKN);
      px(5, 3, 3, 1, HAIR); px(10, 3, 1, 1, HAIR);          // swept fringe + part
      px(6, 4, 1, 1, HAIR); px(9, 4, 1, 1, HAIR);            // brows
      px(4, 5, 1, 1, SKN); px(11, 5, 1, 1, SKN);             // ears
      // glowing violet eyes (bright pixels read as a glow in the dark)
      px(6, 5, 2, 1, EYE); px(9, 5, 2, 1, EYE); px(6, 5, 1, 1, EYEC); px(10, 5, 1, 1, EYEC);
      px(7, 6, 1, 1, SKN_D);                                 // nose
      px(6, 7, 4, 1, SKN_D);                                 // a flat, grim mouth
      px(6, 8, 4, 1, SKN); px(7, 9, 2, 1, SKN_D);            // jaw + neck
      // suit: shoulders, torso, sleeves, hands
      px(3, 10, 10, 1, SUIT); px(3, 11, 10, 6, SUIT);
      px(2, 10, 1, 1, SUIT); px(2, 11, 1, 6, SUIT_D); px(13, 10, 1, 1, SUIT); px(13, 11, 1, 6, SUIT_D);
      px(2, 17, 1, 1, SKN); px(13, 17, 1, 1, SKN);
      px(5, 11, 1, 4, SUIT_L); px(10, 11, 1, 4, SUIT_L);     // lapels
      // white shirt + dark tie
      px(6, 11, 4, 1, SHIRT); px(6, 12, 1, 3, SHIRT); px(9, 12, 1, 3, SHIRT);
      px(7, 11, 2, 1, TIE); px(7, 12, 2, 1, TIE); px(7, 13, 2, 1, TIE); px(8, 14, 1, 2, TIE);
      px(3, 16, 10, 1, SUIT_D);                              // jacket hem
      // slacks + shoes
      px(4, 17, 3, 5, SUIT_D); px(9, 17, 3, 5, SUIT_D);
      px(5, 17, 1, 5, 0x202848); px(10, 17, 1, 5, 0x202848);
      px(3, 22, 4, 2, SHOE); px(9, 22, 4, 2, SHOE);
      g.generateTexture('w-clarence', 16, 24);
    }

    // === The final room: ROB'S HOME OFFICE. A mundane, brightly-lit one-man office — the plot twist
    //     after all that dread. Rob sits at his PC playing MapTap (a geography game), back to the door. ===
    // --- the desk + monitor (the screen shows a little world map, a red pin dropped on it) ---
    {
      const WOOD = 0x8a5a30, WOOD_L = 0xa97040, WOOD_D = 0x66401e, BEZEL = 0x16161c, SCRN = 0x2f6fc8,
        LAND = 0x57a64a, LAND_L = 0x6cba5c, KEY = 0xcdd2da, MUG = 0xc23a2a;
      g.clear();
      // monitor
      px(8, 1, 12, 9, BEZEL); px(9, 2, 10, 7, SCRN);                       // bezel + ocean screen
      px(10, 3, 3, 2, LAND); px(14, 3, 2, 1, LAND_L); px(13, 5, 4, 2, LAND); px(10, 6, 2, 1, LAND_L); px(16, 5, 2, 1, LAND); // continents
      px(15, 4, 1, 1, 0xff3030); px(15, 3, 1, 1, 0xffffff);                // a dropped red pin + glint
      px(9, 8, 10, 1, 0x1a3a6a);                                          // the MapTap UI strip
      px(13, 10, 2, 1, 0x24242c);                                         // monitor stand
      // desk slab + legs
      px(2, 11, 24, 4, WOOD); px(2, 11, 24, 1, WOOD_L); px(2, 14, 24, 1, WOOD_D);
      px(3, 15, 2, 3, WOOD_D); px(23, 15, 2, 3, WOOD_D);
      // keyboard + a coffee mug
      px(9, 12, 10, 2, 0x2a2a30); px(10, 12, 8, 1, KEY);
      px(22, 8, 3, 3, MUG); px(22, 8, 3, 1, 0xd85a4a);
      g.generateTexture('w-deskpc', 28, 18);
    }
    // --- Rob, seated at his PC seen from behind: a tall ergonomic office chair (headrest, mesh back,
    //     armrests, chrome 5-star base) with Rob's dark-haired head + navy suit shoulders rising above
    //     it, one arm out to the desk. Detailed + shaded (20×26). ---
    {
      const CH = 0x24242e, CH_D = 0x15151c, CH_L = 0x33333f, MESH = 0x2c2c3a, CHROME = 0x70747e, CHROME_D = 0x4a4e57,
        HAIR = 0x241a10, HAIR_L = 0x3c2c19, SKIN = 0xc99a72, SKIN_D = 0xa87c56,
        SUIT = 0x232b48, SUIT_L = 0x33406a, SUIT_D = 0x18203a, SHIRT = 0xe8e8ee, WHEEL = 0x101015;
      g.clear();
      // chair: headrest, winged backrest with a mesh centre, armrests
      px(6, 0, 8, 3, CH); px(7, 0, 6, 1, CH_L);                                  // headrest
      px(3, 3, 14, 15, CH); px(3, 3, 2, 15, CH_D); px(15, 3, 2, 15, CH_D);       // backrest + side wings
      px(6, 4, 8, 13, MESH); px(8, 4, 1, 13, CH_D); px(11, 4, 1, 13, CH_D);      // mesh panel + ribs
      px(1, 11, 2, 5, CH_D); px(1, 11, 2, 1, CH_L); px(17, 11, 2, 5, CH_D); px(17, 11, 2, 1, CH_L); // armrests
      // chair: gas cylinder + chrome 5-star base with castors
      px(9, 18, 2, 3, CHROME); px(9, 18, 1, 3, CHROME_D);
      px(4, 21, 12, 1, CHROME_D); px(3, 22, 3, 1, CHROME_D); px(9, 22, 2, 2, CHROME_D); px(14, 22, 3, 1, CHROME_D);
      px(3, 23, 2, 1, WHEEL); px(15, 23, 2, 1, WHEEL); px(9, 24, 2, 1, WHEEL);
      // Rob: navy suit shoulders/back (drawn in front of the chair), white collar, one arm to the desk
      px(4, 9, 12, 8, SUIT); px(4, 9, 12, 1, SUIT_L); px(9, 10, 2, 7, SUIT_D);
      px(7, 9, 6, 1, SHIRT);                                                     // shirt collar at the nape
      px(3, 11, 2, 4, SUIT); px(15, 11, 3, 4, SUIT); px(17, 14, 2, 2, SKIN); px(17, 15, 2, 1, SKIN_D); // arms; right hand toward the keyboard
      // Rob: dark-haired head (full head of hair, back view), neck
      px(6, 2, 8, 6, HAIR); px(7, 2, 6, 1, HAIR_L); px(10, 3, 1, 4, HAIR_L);     // hair mass + a centre part
      px(6, 3, 1, 4, HAIR); px(13, 3, 1, 4, HAIR);                               // sides
      px(8, 8, 4, 1, SKIN_D);                                                    // nape of the neck
      g.generateTexture('w-robpc', 20, 26);
    }
    // --- a bookshelf packed with colourful spines (office ambiance) ---
    {
      g.clear();
      px(1, 0, 14, 24, 0x6a4a2a); px(2, 1, 12, 22, 0x3a2614);               // frame + dark interior
      const spine = [0x6e3a30, 0x33455e, 0x3f5640, 0x7a6038, 0x4a3a4e, 0x5a4632]; // muted, bookish spines (no rainbow)
      for (const sy of [1, 7, 13, 19]) { for (let x = 3; x <= 12; x++) px(x, sy, 1, 5, spine[(x + sy) % spine.length]); px(2, sy + 5, 12, 1, 0x6a4a2a); }
      g.generateTexture('w-bookshelf', 16, 24);
    }
    // --- a leafy potted plant for the corner ---
    {
      g.clear();
      px(3, 11, 6, 4, 0xb5662e); px(2, 10, 8, 1, 0xc97a3e);                 // terracotta pot
      px(2, 3, 8, 7, 0x3a8a3a); px(3, 1, 6, 3, 0x4aa84a); px(1, 5, 2, 3, 0x357f35); px(9, 5, 2, 3, 0x357f35); px(5, 0, 2, 2, 0x5ab85a);
      g.generateTexture('w-plant', 12, 16);
    }
    // --- a warm wood-plank floor tile for the office (replaces the stone underfoot) ---
    {
      g.clear();
      px(0, 0, 16, 16, 0x9a6a3a);
      for (let y = 0; y < 16; y += 4) { px(0, y, 16, 1, 0x855a30); for (let x = (y % 8 ? 0 : 8); x < 16; x += 8) px(x, y, 1, 4, 0x8d6034); } // planks + staggered seams
      px(2, 1, 5, 1, 0xa5713e); px(9, 5, 4, 1, 0xa5713e); px(3, 9, 6, 1, 0xa5713e); px(10, 13, 4, 1, 0xa5713e); // faint grain highlights
      g.generateTexture('w-wood', 16, 16);
    }
    // --- a plush patterned rug to sit under the desk ---
    {
      g.clear();
      px(0, 0, 24, 16, 0x7a2030); px(1, 1, 22, 14, 0x9a2c3e);               // border + field
      px(3, 3, 18, 10, 0x73505a); px(5, 5, 14, 6, 0x9a2c3e);               // inner panels
      px(11, 6, 2, 4, 0xe0c060); px(8, 7, 8, 2, 0xe0c060);                 // a gold medallion
      g.generateTexture('w-rug', 24, 16);
    }
    // --- a bright daytime window (the office looks out on a sunny sky) ---
    {
      g.clear();
      px(0, 0, 20, 16, 0x7a5a36);                                          // wood frame
      px(2, 2, 16, 12, 0xbfe6ff); px(2, 2, 16, 6, 0xd8f0ff);              // sky (lighter up top)
      px(3, 10, 14, 4, 0x8fcf6a); px(3, 12, 14, 2, 0x79bd57);            // a sliver of green lawn
      px(9, 2, 2, 12, 0x7a5a36); px(2, 7, 16, 2, 0x7a5a36);              // muntins (cross bars)
      g.generateTexture('w-window', 20, 16);
    }
    // --- a light drywall wall tile for the office (warm beige, faint panel seams, a wood baseboard) ---
    {
      g.clear();
      px(0, 0, 16, 16, 0xdfd3bb); px(0, 0, 16, 1, 0xebe0c9); px(0, 1, 16, 1, 0xd2c5a8); // wall + top shadow line
      px(4, 0, 1, 13, 0xd6cab0); px(11, 0, 1, 13, 0xd6cab0);                              // faint vertical seams
      px(0, 13, 16, 3, 0x8a5a30); px(0, 13, 16, 1, 0xa97040);                             // wood baseboard
      g.generateTexture('w-owall', 16, 16);
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

    // --- soft smoke puff (white, tinted grey + faded at render) ---
    g.clear();
    g.fillStyle(0xffffff, 0.22); g.fillCircle(10, 10, 10);
    g.fillStyle(0xffffff, 0.35); g.fillCircle(10, 10, 6.5);
    g.fillStyle(0xffffff, 0.55); g.fillCircle(10, 10, 3.5);
    g.generateTexture('w-smoke', 20, 20);

    // --- avatar: the tsong ball with eyes (tintable white body) (10×10 texels) ---
    g.clear();
    px(2, 1, 6, 8, 0xffffff); px(1, 2, 8, 6, 0xffffff); // round body
    px(3, 3, 1, 2, 0x1a1a1a); px(6, 3, 1, 2, 0x1a1a1a); // eyes (kept dark even when tinted? no — tint
    // multiplies; eyes drawn dark stay near-dark. good enough for the charm.)
    g.generateTexture('w-avatar', 10, 10);

    // --- dungeon treasure chest: wooden body + gold bands + lock plate w/ keyhole (16×14 texels) ---
    {
      g.clear();
      const wd = 0x6e3f1c, wo = 0x8a5226, wl = 0xa86a32, gd = 0xe9c34d, gl = 0xf6e08a, gk = 0xa9852b;
      px(1, 1, 14, 12, 0x241006);                                  // dark outline silhouette
      px(2, 2, 12, 4, wo); px(2, 2, 12, 1, wl); px(2, 5, 12, 1, wd); // lid (highlight + shade)
      px(2, 7, 12, 5, wo); px(2, 7, 12, 1, wl); px(2, 11, 12, 1, wd); // body (highlight + shade)
      px(3, 2, 2, 4, gd); px(3, 2, 2, 1, gl);                       // left band — lid
      px(11, 2, 2, 4, gd); px(11, 2, 2, 1, gl);                     // right band — lid
      px(3, 7, 2, 5, gd); px(3, 11, 2, 1, gk);                      // left band — body
      px(11, 7, 2, 5, gd); px(11, 11, 2, 1, gk);                    // right band — body
      px(7, 5, 2, 4, gl); px(7, 5, 2, 1, gd); px(7, 7, 2, 1, 0x140a04); // lock plate + keyhole
      g.generateTexture('w-chest', 16, 14);
    }
    // --- opened chest: lid swung back, gold treasure spilling out (16×15 texels) ---
    {
      g.clear();
      const wd = 0x6e3f1c, wo = 0x8a5226, wl = 0xa86a32, gd = 0xe9c34d, gl = 0xf6e08a, gk = 0xa9852b;
      px(2, 0, 12, 4, 0x241006); px(3, 1, 10, 2, wo); px(3, 1, 10, 1, wl); px(4, 3, 8, 1, gk); // open lid + gold trim
      px(1, 6, 14, 8, 0x241006);                                                                // body outline
      px(2, 7, 12, 6, wo); px(2, 7, 12, 1, wl); px(2, 12, 12, 1, wd);                            // body
      px(3, 7, 2, 6, gd); px(3, 12, 2, 1, gk); px(11, 7, 2, 6, gd); px(11, 12, 2, 1, gk);        // body bands
      px(4, 5, 8, 2, gl); px(5, 4, 6, 1, gd); px(6, 5, 1, 1, 0xffffff); px(9, 5, 1, 1, 0xffffff); // gold mound + sparkles
      g.generateTexture('w-chest-open', 16, 15);
    }

    // --- dungeon stairwell: stone steps descending into a dark hole (tinted warm=down / cool=up) ---
    {
      g.clear();
      px(2, 2, 12, 12, 0x090a0e);                                  // dark pit
      px(2, 2, 12, 2, 0x8a8470); px(4, 4, 8, 2, 0x726c5c);         // top two steps (bright→dim)
      px(5, 6, 6, 2, 0x5a5547); px(6, 8, 4, 2, 0x423d31);          // deeper steps
      px(7, 10, 2, 2, 0x14120d);                                   // bottom into black
      px(2, 2, 12, 1, 0xa59a80); px(4, 4, 8, 1, 0x8c8268);         // step highlights
      g.generateTexture('d-stairs', 16, 16);
    }
    // --- locked door: dark wood, iron bars, a brass padlock (the sealed-room gate) ---
    {
      g.clear();
      px(2, 1, 12, 14, 0x241608); px(3, 2, 10, 12, 0x523a20);      // frame + planks
      px(4, 2, 1, 12, 0x6b7079); px(7, 2, 1, 12, 0x6b7079); px(10, 2, 1, 12, 0x6b7079); // iron bars
      px(4, 7, 7, 1, 0x7a808a);                                    // cross brace
      px(6, 6, 4, 2, 0xb38b2e); px(7, 8, 2, 3, 0xc9a13c);          // padlock shackle + body
      px(7, 9, 2, 1, 0x20180a);                                    // keyhole
      g.generateTexture('d-lock', 16, 16);
    }
    // --- bones: a little skull + scattered ribs (deeper-floor decor) ---
    {
      g.clear();
      px(6, 7, 4, 4, 0xd9d3c2); px(6, 11, 4, 1, 0xb7b1a0);         // skull + jaw
      px(7, 8, 1, 1, 0x2a2622); px(9, 8, 1, 1, 0x2a2622);         // eye sockets
      px(2, 12, 8, 1, 0xcdc7b6); px(4, 13, 6, 1, 0xb7b1a0);       // ribs/long bones
      px(3, 11, 1, 2, 0xcdc7b6); px(11, 12, 1, 2, 0xcdc7b6);
      g.generateTexture('d-bones', 16, 16);
    }
    // --- pale cave fungus: a few glowing mushroom caps on slender stems ---
    {
      g.clear();
      px(5, 10, 1, 3, 0x8fae9b); px(8, 9, 1, 4, 0x8fae9b); px(11, 11, 1, 2, 0x8fae9b); // stems
      px(4, 8, 3, 2, 0x9fe6d0); px(7, 6, 3, 2, 0xb4f0dc); px(10, 9, 3, 2, 0x9fe6d0);   // caps
      px(5, 7, 1, 1, 0xe8fff6); px(8, 5, 1, 1, 0xe8fff6);                               // glints
      g.generateTexture('d-mush', 16, 16);
    }
    // --- cobweb (top-left corner orientation; flipped to reach the other three) ---
    {
      g.clear();
      px(0, 0, 8, 1, 0xc2c8d2); px(0, 0, 1, 8, 0xc2c8d2);          // anchor edges
      px(2, 2, 1, 1, 0xb0b6c0); px(4, 4, 1, 1, 0xb0b6c0); px(6, 6, 1, 1, 0xb0b6c0); // diagonal
      px(5, 1, 1, 1, 0x9aa0aa); px(1, 5, 1, 1, 0x9aa0aa); px(3, 1, 1, 1, 0x9aa0aa); px(1, 3, 1, 1, 0x9aa0aa); // strands
      px(6, 2, 1, 1, 0x8a909a); px(2, 6, 1, 1, 0x8a909a);
      g.generateTexture('d-web', 16, 16);
    }
    // --- water drip: a falling bead above a small puddle ---
    {
      g.clear();
      px(8, 3, 1, 2, 0x6a86b8); px(8, 5, 1, 1, 0x466294);          // bead
      px(5, 11, 6, 2, 0x37486a); px(6, 11, 3, 1, 0x6a86b8);        // puddle + glint
      g.generateTexture('d-drip', 16, 16);
    }
    // --- dried blood: an irregular dark-red pool with a few spatter flecks (gore floors) ---
    {
      const BL = 0x6e0f12, BL_D = 0x4a0a0d, BL_S = 0x8a1518;
      g.clear();
      px(5, 6, 6, 4, BL); px(4, 7, 8, 2, BL); px(6, 5, 4, 1, BL_D); px(5, 10, 5, 1, BL_D); // main pool
      px(6, 7, 3, 1, BL_S);                                          // wet highlight
      px(3, 5, 1, 1, BL); px(12, 8, 1, 1, BL); px(11, 4, 1, 1, BL_D); px(4, 11, 1, 1, BL_D); // spatter
      px(13, 6, 1, 1, BL); px(2, 9, 1, 1, BL_D);
      g.generateTexture('d-blood', 16, 16);
    }
    // --- claw marks: three parallel gashes raked across the stone (gore floors) ---
    {
      const CL = 0x2a1f22, CL_D = 0x140d0f;
      g.clear();
      px(4, 3, 1, 9, CL); px(4, 3, 1, 2, CL_D); px(4, 11, 1, 1, CL_D);
      px(7, 4, 1, 9, CL); px(7, 4, 1, 2, CL_D); px(7, 12, 1, 1, CL_D);
      px(10, 3, 1, 9, CL); px(10, 3, 1, 2, CL_D); px(10, 11, 1, 1, CL_D);
      g.generateTexture('d-claw', 16, 16);
    }
    // --- a slumped, bleeding adventurer propped against a wall (B3 key NPC) — 16×16 ---
    {
      const CLK = 0x6b5a3a, CLK_D = 0x4a3d27, SKIN = 0xd6a982, HAIR = 0x7a5a36, BL = 0x6e0f12;
      g.clear();
      px(4, 14, 9, 2, BL); px(3, 15, 11, 1, 0x4a0a0d);          // blood pool under him
      px(5, 6, 7, 8, CLK); px(5, 6, 7, 1, 0x7d6b46); px(5, 13, 7, 1, CLK_D); // hunched cloaked body
      px(4, 8, 1, 5, CLK_D); px(12, 8, 1, 5, CLK_D);            // arms hanging
      px(7, 9, 3, 3, BL);                                       // blood soaking the gut
      px(7, 2, 4, 4, SKIN); px(7, 2, 4, 1, HAIR); px(6, 3, 1, 2, HAIR); // head lolled, hair
      px(8, 4, 1, 1, 0x20140c); px(9, 5, 2, 1, BL);             // shut eye + blood at the mouth
      g.generateTexture('d-fallen', 16, 16);
    }

    // --- car body + roof (tintable) — pointing +x (east), 26×14 texels ---
    g.clear();
    px(1, 4, 24, 6, 0xffffff); px(3, 2, 20, 10, 0xffffff); px(0, 5, 26, 4, 0xffffff);
    g.generateTexture('w-car-body', 26, 14);
    g.clear();
    px(8, 4, 11, 6, 0xffffff);   // cabin/roof patch (tinted with the accent color)
    px(20, 6, 4, 2, 0xffffff);   // a little nose stripe
    g.generateTexture('w-car-roof', 26, 14);

    // --- MONSTER TRUCK (the Ruins vault prize) — top-down, pointing +x, 34×24 texels. Three layers:
    //     untinted knobby wheels, a tintable beefy body, a dark cab roof. ---
    {
      // wheels: four huge black knobby tires at the corners (NOT tinted — baked dark)
      g.clear();
      const TY = 0x141414, TG = 0x2e2e2e;
      const tire = (x: number, y: number) => {
        px(x, y, 9, 8, TY);                                   // tire
        px(x + 1, y + 1, 1, 6, TG); px(x + 4, y + 1, 1, 6, TG); px(x + 7, y + 1, 1, 6, TG); // tread lugs
        px(x + 2, y + 3, 5, 2, 0x4a4a4a);                     // hub
      };
      tire(2, 1); tire(2, 15); tire(23, 1); tire(23, 15);     // FL, RL, FR, RR
      g.generateTexture('w-monster-body-wheels', 34, 24);
      // body: a tall, chunky lifted truck body (white → tinted with the car's body color)
      g.clear();
      px(7, 5, 21, 14, 0xffffff);                              // main body slab
      px(9, 3, 17, 18, 0xffffff);                              // a touch wider midsection
      px(28, 8, 3, 8, 0xffffff);                               // blunt front nose
      g.generateTexture('w-monster-body', 34, 24);
      // cab + roll bar (tinted with the accent color — dark on the green truck)
      g.clear();
      px(12, 8, 9, 8, 0xffffff);                               // cab
      px(22, 10, 2, 4, 0xffffff);                              // windshield strip
      px(10, 7, 11, 1, 0xffffff); px(10, 16, 11, 1, 0xffffff); // roll bars
      g.generateTexture('w-monster-roof', 34, 24);
    }

    // --- Pets ---------------------------------------------------------------------------
    // Pet Rock: a grey pebble with two googly eyes (12×10 texels).
    g.clear();
    px(2, 4, 8, 5, 0x8a8d92); px(3, 3, 6, 1, 0x9aa0a6); px(1, 5, 10, 3, 0x8a8d92); // body + highlight
    px(2, 8, 8, 1, 0x6f7378);                                                       // shaded base
    px(3, 2, 3, 3, 0xffffff); px(4, 3, 1, 1, 0x111111);                             // left googly eye
    px(6, 2, 3, 3, 0xffffff); px(7, 3, 1, 1, 0x111111);                             // right googly eye
    g.generateTexture('w-pet-rock', 12, 10);

    // Crypt Slime: a green gelatinous blob with two dark eyes (12×10 texels) — the Ruins capture pet.
    g.clear();
    px(3, 2, 6, 1, 0x7ed06a); px(2, 3, 8, 2, 0x6fc25a);             // domed top
    px(1, 5, 10, 3, 0x5fae54); px(1, 8, 10, 1, 0x4d9444);          // wide body + shaded base
    px(3, 2, 2, 1, 0x9fe28a);                                       // highlight
    px(3, 4, 1, 2, 0x16210f); px(7, 4, 1, 2, 0x16210f);            // two beady eyes
    g.generateTexture('w-pet-slime', 12, 10);

    // Dragon: a little red wyvern with spread bat-wings, a gold belly + horn (16×12). Flies above you.
    {
      const DR = 0x9a2a2a, DR_D = 0x6e1717, DR_L = 0xc23a3a, WING = 0x7a1f1f, BELLY = 0xd8a050, HORN = 0xe8d8b0, EYE = 0xffe14d;
      g.clear();
      px(0, 2, 5, 1, WING); px(1, 1, 3, 1, WING); px(0, 3, 6, 2, WING);          // left wing
      px(11, 2, 5, 1, WING); px(12, 1, 3, 1, WING); px(10, 3, 6, 2, WING);       // right wing
      px(6, 4, 4, 5, DR); px(6, 4, 4, 1, DR_L); px(7, 7, 2, 2, BELLY);           // body + belly
      px(4, 2, 3, 3, DR); px(4, 2, 3, 1, DR_L); px(3, 3, 1, 1, DR);              // head
      px(5, 1, 1, 1, HORN); px(5, 3, 1, 1, EYE); px(2, 3, 1, 1, DR_D);           // horn, eye, snout
      px(10, 6, 2, 1, DR); px(12, 7, 2, 1, DR_D); px(14, 6, 1, 1, DR_L);         // tail
      px(6, 9, 1, 1, DR_D); px(9, 9, 1, 1, DR_D);                                // feet
      g.generateTexture('w-pet-dragon', 16, 12);
    }

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
      // Dungeon (the Ruins): 0x72 stone-floor variants (f0–f6) + wall variants (w0–w3).
      for (let i = 0; i < 7; i++) this.load.image('d-f' + i, '/dungeon/f' + i + '.png');
      for (let i = 0; i < 4; i++) this.load.image('d-w' + i, '/dungeon/w' + i + '.png');
      this.load.image('w-rob-portrait', '/dungeon/mob_rob.png'); // Rob's grandiose framed portrait on his office wall
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
      // A crisper glow than the town's soft 'w-glow': big bright plateau + a tight falloff, so
      // dungeon torch pools read as defined light circles rather than fog.
      const DGLOW = 'd-glow';
      if (!sc.textures.exists(DGLOW)) {
        const sz = 128, ct = sc.textures.createCanvas(DGLOW, sz, sz);
        if (ct) {
          const c2 = ct.getContext();
          const g2 = c2.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
          g2.addColorStop(0, 'rgba(255,255,255,1)');
          g2.addColorStop(0.46, 'rgba(255,255,255,0.95)'); // wide bright core
          g2.addColorStop(0.72, 'rgba(255,255,255,0.30)'); // then a tight edge
          g2.addColorStop(1, 'rgba(255,255,255,0)');
          c2.fillStyle = g2; c2.fillRect(0, 0, sz, sz); ct.refresh();
        }
      }
      // A reusable soft-circle stamp for erasing light holes into the dungeon darkness layer. The
      // RenderTexture itself is created in buildFloor, sized to the room, in WORLD space (so the
      // holes track world positions exactly — no camera-projection lag).
      dungeonLightBrush = sc.make.image({ key: DGLOW, add: false }).setOrigin(0.5);

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
        const t = now / 1000;
        const flick = (l: { phase: number; fire: number }) =>
          1 + l.fire * (Math.sin(t * 7.3 + l.phase) * 0.6 + Math.sin(t * 2.9 + l.phase * 1.7) * 0.4);
        if (inDungeon && DUNGEON_THEME[currentFloor]?.lit) {
          // A LIT floor (the office): no fog of war at all — it's just a bright, normal room.
          if (nightOverlay) nightOverlay.setAlpha(0);
          if (warmOverlay) warmOverlay.setAlpha(0);
          if (dungeonDarkRT) dungeonDarkRT.setVisible(false);
          // minions mill about the open floor, bouncing off the walls with a little waddle
          const xlo = dInt.x + 2.2 * DUNGEON_TILE, xhi = dInt.x + 15.5 * DUNGEON_TILE, ylo = dInt.y + 5.4 * DUNGEON_TILE, yhi = dInt.y + 10.6 * DUNGEON_TILE;
          for (const m of b6Minions) {
            if (Math.random() < 0.02) { const a = Math.random() * 6.28; m.vx = Math.cos(a) * 26; m.vy = Math.sin(a) * 26; } // occasional turn
            m.x += m.vx * dt; m.y += m.vy * dt;
            if (m.x < xlo || m.x > xhi) { m.vx *= -1; m.x = clamp(m.x, xlo, xhi); }
            if (m.y < ylo || m.y > yhi) { m.vy *= -1; m.y = clamp(m.y, ylo, yhi); }
            m.spr.setPosition(m.x, m.y + Math.sin(t * 9 + m.x) * 1.2).setDepth(m.y).setFlipX(m.vx < 0);
          }
        } else if (inDungeon) {
          // The Ruins: a dim ambient dark with bright holes erased at the torches + the player, so
          // you see the real tiles normally inside the light and dimly (not black) outside it.
          if (nightOverlay) nightOverlay.setAlpha(0);
          if (warmOverlay) warmOverlay.setAlpha(0.10);
          if (dungeonDarkRT && dungeonLightBrush) {
            // World-space layer: erase at room-local coords (worldPos − room origin), radii in world
            // units — holes track exactly, zero camera lag. Darker ambient so the light matters.
            const rt = dungeonDarkRT, brush = dungeonLightBrush;
            rt.setVisible(true); rt.clear(); rt.fill(0x05070b, DUNGEON_DARK[currentFloor] ?? 0.7);
            const stamp = (wx: number, wy: number, worldR: number) => {
              brush.setPosition(wx - dInt.x, wy - dInt.y).setDisplaySize(worldR * 2, worldR * 2);
              rt.erase(brush);
            };
            for (const tr of dungeonTorches) stamp(tr.x, tr.y, 78 * flick(tr)); // torch pools — same reveal as you
            stamp(selfX, selfY, 90);                                            // your light — slightly bigger radius
            stamp(selfX, selfY, 60);                                            // second pass brightens the core (fuller reveal)
          }
          for (const f of dungeonFlies) {
            f.vx = clamp(f.vx + (Math.random() * 2 - 1) * 9 * dt, -16, 16);
            f.vy = clamp(f.vy + (Math.random() * 2 - 1) * 9 * dt, -16, 16);
            f.x += f.vx * dt; f.y += f.vy * dt;
            if (f.x < dInt.x + 24 || f.x > dInt.x + dInt.w - 24) f.vx *= -1;
            if (f.y < dInt.y + 24 || f.y > dInt.y + dInt.h - 24) f.vy *= -1;
            f.x = clamp(f.x, dInt.x + 24, dInt.x + dInt.w - 24);
            f.y = clamp(f.y, dInt.y + 24, dInt.y + dInt.h - 24);
            const tw = 0.3 + 0.6 * Math.max(0, Math.sin(t * 2.1 + f.phase));
            f.glow.setPosition(f.x, f.y).setAlpha(0.5 * tw);
            f.core.setPosition(f.x, f.y).setAlpha(0.95 * tw);
          }
          // B5: the Gatekeeper striding in from the far wall → opens the dialogue once he arrives
          if (clarenceAnim && clarenceSprite) {
            clarenceAnim.t = Math.min(1, clarenceAnim.t + dt / 1.15);
            const e = clarenceAnim.t < 0.5 ? 2 * clarenceAnim.t * clarenceAnim.t : 1 - Math.pow(-2 * clarenceAnim.t + 2, 2) / 2; // easeInOut
            const bob = Math.abs(Math.sin(clarenceAnim.t * Math.PI * 5)) * 4; // a little walking bob
            const x = clarenceAnim.fromX + (clarenceAnim.toX - clarenceAnim.fromX) * e;
            clarenceSprite.setPosition(x, clarenceAnim.y - bob).setDepth(clarenceAnim.y + 1);
            if (clarenceAnim.t >= 1) { clarenceAnim = null; clarenceDialogue(); }
          }
        } else {
          if (dungeonDarkRT) dungeonDarkRT.setVisible(false);
          for (const f of dungeonFlies) { f.glow.setAlpha(0); f.core.setAlpha(0); }
          if (nightOverlay) nightOverlay.setAlpha(night * 0.62);           // darker after dusk
          if (warmOverlay) warmOverlay.setAlpha(0.34 * (1 - night * 0.8)); // golden glow fades after dark
          // lights bloom in as it gets dark, each flickering like a flame on its own phase
          for (const l of nightLights) l.obj.setAlpha(night * l.max * flick(l));
          // casino marquee: bulbs chase around the building and cycle colors — lit always, louder at night
          if (casinoBulbs.length) {
            const brightness = 0.5 + 0.5 * night;
            for (const b of casinoBulbs) {
              b.obj.setTint(CASINO_PAL[(b.i + Math.floor(t * 4)) % CASINO_PAL.length]);
              const chase = 0.45 + 0.55 * Math.max(0, Math.sin(t * 6 - b.i * 0.6)); // running light
              b.obj.setAlpha(brightness * chase);
            }
          }
        }
      }

      // --- birds: every so often a little flock drifts across the sky (camera-fixed, flapping) ---
      {
        if (now >= nextBirdsAt && !inDungeon) {
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
          b.img.setVisible(!inDungeon); // no birds flying through the dungeon
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
          const baseZoom = inInterior ? TAVERN_ZOOM : inDungeon ? DUNGEON_ZOOM : ZOOM; // cozy in the Tavern, close-in in the dungeon
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
      updateSmoke(dt);

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
  // Exhaust smoke — EVERY Monster Truck belches grey puffs from the back while it's moving (self + remotes).
  const smokePuffs: { spr: Phaser.GameObjects.Image; t: number; max: number; vx: number; vy: number }[] = [];
  function updateSmoke(dt: number) {
    const sc = petScene; if (!sc) return;
    const emitFor = (av: Av) => {
      const x = av.c.x, y = av.c.y;
      const drivingMonster = av.car.visible && av.carWheels.visible; // wheels are only shown for the monster truck
      const moved = Math.hypot(x - av.sx, y - av.sy); av.sx = x; av.sy = y;
      av.smokeT -= dt;
      if (drivingMonster && moved > 0.7 && av.smokeT <= 0) {
        av.smokeT = 0.05;
        const a = av.car.rotation;
        const bx = x - Math.cos(a) * CAR_LEN * 0.5, by = y - Math.sin(a) * CAR_LEN * 0.5;
        const spr = sc.add.image(bx + (Math.random() - 0.5) * 6, by + (Math.random() - 0.5) * 6, 'w-smoke')
          .setScale(0.7).setTint(0x4a4a4a).setAlpha(0.55).setDepth(by - 3);
        smokePuffs.push({ spr, t: 0, max: 0.65 + Math.random() * 0.35,
          vx: -Math.cos(a) * 16 + (Math.random() - 0.5) * 16, vy: -Math.sin(a) * 16 - 14 + (Math.random() - 0.5) * 16 });
      }
    };
    if (self) emitFor(self);
    for (const av of remote.values()) emitFor(av);
    for (let i = smokePuffs.length - 1; i >= 0; i--) {
      const p = smokePuffs[i]; p.t += dt; const k = p.t / p.max;
      if (k >= 1) { p.spr.destroy(); smokePuffs.splice(i, 1); continue; }
      p.spr.x += p.vx * dt; p.spr.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.95;
      p.spr.setScale(0.7 + k * 1.6).setAlpha(0.55 * (1 - k)).setDepth(p.spr.y - 3);
    }
  }
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
        const tex = pet.kind === 'rock' ? 'w-pet-rock' : pet.kind === 'pikachu' ? 'w-pet-pikachu' : pet.kind === 'slime' ? 'w-pet-slime' : pet.kind === 'dragon' ? 'w-pet-dragon' : 'w-pet-pacman-0';
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
      if (ps.kind === 'dragon') { // a dragon FLIES: it hovers above you, bobbing gently on its wingbeats
        const fly = 24 + Math.sin(performance.now() / 280) * 4; // time-only phase → smooth bob (no per-pixel jitter)
        if (pvx < -0.4) ps.sprite.setFlipX(true); else if (pvx > 0.4) ps.sprite.setFlipX(false); // flip only on real travel
        ps.sprite.setPosition(ps.x, ps.y - fly).setDepth(ps.y + 5000); // always drawn on top
      } else
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
    const carWheels = sc.add.image(0, 0, 'w-monster-body-wheels').setScale(TEXEL).setVisible(false); // monster-truck tires (under the body)
    const carBody = sc.add.image(0, 0, 'w-car-body').setScale(TEXEL);
    const carRoof = sc.add.image(0, 0, 'w-car-roof').setScale(TEXEL);
    const car = sc.add.container(0, 0, [carWheels, carBody, carRoof]).setVisible(false);
    const label = sc.add.text(0, -R - 14, name, NAME_STYLE).setOrigin(0.5, 1);
    const bubble = sc.add.text(0, -R - 32, '', {
      fontFamily: 'system-ui, sans-serif', fontSize: '11px', color: '#ffeb3b',
      backgroundColor: '#1b2542e6', padding: { x: 6, y: 3 }, align: 'center',
      stroke: '#0b1020', strokeThickness: 2, resolution: 2,
    }).setOrigin(0.5, 1).setVisible(false);
    const c = sc.add.container(selfX, selfY, [shadow, car, person, label, bubble]);
    return { c, person, car, carBody, carRoof, carWheels, label, bubble, bubbleNextAt: 0, rx: selfX, ry: selfY, ra: 0, smokeT: 0, sx: selfX, sy: selfY };
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
      const monster = spec?.id === 'car-monster';
      av.carWheels.setVisible(monster);
      av.carBody.setTexture(monster ? 'w-monster-body' : 'w-car-body');
      av.carRoof.setTexture(monster ? 'w-monster-roof' : 'w-car-roof');
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
    if (inDungeon) net.dungeonExit(false); // bailed out of the World mid-dungeon → forfeit the run purse
    setDungeonMusic(false); dungeonMusic = null; inDungeon = false;
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
    reenter() { net.enter(); net.landReq(); },
    dungeonChests(opened) {
      openedChestsServer.clear();
      for (const id of opened) openedChestsServer.add(id);
      for (const key in dungeonChestSprites) dungeonChestSprites[key].setTexture(openedChestsServer.has(currentFloor + ':' + key) ? 'w-chest-open' : 'w-chest');
      updateDungeonHud(); // refresh the "📦 X/Y chests opened" counter now the banked list arrived
      updateNearBuilding();
    },
    chestAccepted(chest, coins, potions, _spin, prize, prizes) {
      openedChestsServer.add(chest); runOpens.add(chest);
      if (chest.startsWith(currentFloor + ':')) dungeonChestSprites[chest.slice(currentFloor.length + 1)]?.setTexture('w-chest-open');
      if (prizes) for (const p of prizes) lootItems.push({ item: 'cosmetic', name: p }); // a multi-item haul (boss reward) → loot panel
      if (prize) { lootItems.push({ item: 'cosmetic', name: prize }); showToast(`📦✨ You found ${prize} — escape to keep it!`); }
      else if (potions > 0) { potionCount += potions; showToast(potions > 1 ? `📦 Found ${potions} 🧪 Potions!` : '📦 Found a 🧪 Potion!'); }
      else if (coins) showToast(`📦 ${coins}🪙 added to your purse — escape to keep it!`);
      // spin chests (coins:0/potions:0) say nothing here — the wheel + its own toast handle it
      updateDungeonHud(); updateDungeonControls();
    },
    dungeonSpinLoot(reward) {
      if (reward.kind === 'item') { lootItems.push({ item: reward.item, name: reward.name }); }
      // coins from the spin flow in via the dungeonPurse message; just refresh the panel if open
      renderLootPanel();
    },
    dungeonPurse(coins) { dungeonPurseDisplay = coins; updateDungeonHud(); renderLootPanel(); },
    feedLand(parcels, bankBought, bankCap) {
      land.clear();
      for (const p of parcels) land.set(p.id, p);
      myBankBought = bankBought;
      myBankCap = bankCap;
      refreshParcels();
    },
  };
  syncDriveBtn();
  net.enter();
}
