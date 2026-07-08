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
  HOUSE_KINDS,
  HOUSE_BY_ID,
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
  DUNGEON_TIER_COINS,
  DUNGEON_CHEST_CONTENTS,
  COSMETICS,
  EXCLUSIVES,
  type ChatLine,
  type EloProfileMsg,
  type BalanceSheetMsg,
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
  boat(): string | null;         // our equipped boat id (null = none → can't board a boat)
  pet(): string | null;          // our equipped pet id (null = none → nothing trails us)
  onExit(): void;                // the overlay closed (lets main.ts reset the toggle button)
  enterArena(): void;            // walk into the Arena → return to Pong + join the queue
  openFeature(feature: 'roulette' | 'blackjack' | 'craps' | 'crash' | 'slots' | 'plinko' | 'horse' | 'hilo' | 'mines' | 'stocks' | 'loans' | 'petshop' | 'doom' | 'fishing' | 'campaign' | 'typedie' | 'racing' | 'superbros' | 'tron' | 'guitarhero' | 'artillery' | 'bowling' | 'nuketown' | 'citytycoon' | 'tnt' |'lootbox' | 'blackmarket' | 'news' | 'house' | 'shop' | 'tourney' | 'season' | 'powerups' | 'changelog'): void; // open a Casino/Bank/Pet-Shop/DOOM/Fishing/Arcade/Bowling/Shop/Notice-Board feature
  openParliament(): void;        // walk into the Parliament → open the Nomic rules game overlay
  openRename(): void;            // World's own 👤 button → reopen the nickname/color picker
  muted(): boolean;              // is game sound currently muted?
  toggleMute(): void;            // flip the mute toggle (same pref/state as the toolbar's 🔊 button)
  leaderboard(): { name: string; wins: number; losses: number; elo: number; title?: string | null }[]; // live pong standings (pre-ranked)
  netWorth(): { name: string; net: number; coins: number; loan: number; title?: string | null }[];     // live net-worth board (pre-ranked)
  // Our own rank + stat when we're NOT already in the visible top-N above (mirrors the toolbar
  // boards' pinned self-row) — null once we're already shown in leaderboard()/netWorth().
  selfLbRow(): { rank: number; elo: number } | null;
  selfNwRow(): { rank: number; net: number; loan: number } | null;
  eloProfileReq(rank?: number, self?: boolean): void;    // drill into a leaderboard row (index into leaderboard(), or self) → opens the real Elo profile modal
  balanceSheetReq(rank?: number, self?: boolean): void;  // drill into a net-worth row (index into netWorth(), or self) → opens the real balance-sheet modal
  claimQuest(quest: string): void; // tell the server to grant a World objective reward (once)
  dungeonSync(): void;             // entering the Ruins → ask which chests we've opened
  dungeonChest(chest: string, captured?: boolean): void; // open a chest ('B1:col,row') → server pays coins / grants prize (once). captured=true → a monster box caught (grant the pet)
  dungeonWin(floor: string, tier: number): void; // won an encounter → adds a TIER-ranged amount to the run purse
  dungeonTakeKey(): void; // took the key from the dying B3 adventurer (server marks the run-key)
  dungeonExit(escaped: boolean): void; // left the Ruins (escaped → server pays the run purse from the House)
  onNetizenClick?(netizenId: string): void; // user tapped a netizen avatar in the world (→ challenge)
  buyBeer(): void;               // buy a beer at the Tavern (server charges 20🪙 + ups drunk level)
  buyMcFood(item: string): void; // buy food at McDonald's (server charges coins + sends mcFoodResult)
  drunkLevel(): number;          // current drunkenness 0–6 (drives movement wobble + camera sway)
  stats(): { coins: number; elo: number | null; rank: number | null; fishLb: number }; // live wallet + pong rating + best catch (Mira reads these back to you)
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
  houseBuild(id: string, house: string): void; // build a HOUSE_KINDS house on a lot you own
  houseDemolish(id: string): void;          // tear the house down on a lot you own (free)
  say(text: string, asSay?: boolean): void; // → speech bubble over your avatar (+ to others in-world); asSay=true → purple "Say" bubble
  boom(x: number, y: number, r?: number): void; // explosion here → fireball broadcast to everyone else; r>0 = a damaging rocket blast
  rocket(x: number, y: number, a: number): void; // we launched a rocket → broadcast it so others watch it fly
  blownUp(car: boolean, self: boolean, killedBy?: string): void; // a rocket blast got us (killedBy = shooter's pid for Road Rage)
  sendChat(text: string): void;             // → main game chat, so the line also shows in the side feed
  chatHistory(): ChatLine[];                // recent chat backlog, seeded (hidden) so it's there on T
  // Slash-command autocomplete, shared with the main chat (same COMMANDS list).
  worldChatMenu(text: string): { label: string; hint: string; complete: string; enabled: boolean }[];
  worldRunChatCommand(text: string): 'ran' | 'rejected' | 'passthrough';
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  feedLand(parcels: LandParcelView[], bankBought: number, bankCap: number): void; // Robville land book
  feedSay(id: string, name: string, text: string, say: boolean): void; // an in-world line → speech bubble (say=purple)
  feedBoom(x: number, y: number, r?: number, shooterPid?: string): void; // someone else's explosion → fireball + blast effects; shooterPid for kill credit
  feedRocket(x: number, y: number, a: number): void; // someone else launched a rocket → render it flying
  feedChat(line: ChatLine): void; // a new chat line (mirrors the main chat into the side feed)
  feedRoadRage(active: boolean, endsAt: number, standings: { name: string; kills: number }[]): void;
  feedMcFood(item: string, granted: boolean, bonus?: number): void;
  reenter(): void; // re-send worldEnter after a socket reconnect (server forgot us on drop)
  dungeonChests(opened: string[]): void;                          // server's list of chests we've opened
  chestAccepted(chest: string, coins: number, potions: number, spin?: boolean, prize?: string, prizes?: string[]): void; // server accepted a chest open (prize/prizes = cosmetic names)
  dungeonSpinLoot(reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string }): void; // a spin chest's reward → run loot
  dungeonPurse(coins: number): void;                              // current run-purse total from the server
  feedEloProfile(msg: EloProfileMsg): void;         // server's answer to an eloProfileReq fired from the Hall of Fame
  feedBalanceSheet(msg: BalanceSheetMsg): void;     // server's answer to a balanceSheetReq fired from the Hall of Fame
}
let controller: Controller | null = null;
let _exitWorld: (() => void) | null = null;
let _pauseWorld: (() => void) | null = null;
let _resumeWorld: (() => void) | null = null;

export function isWorldOpen(): boolean {
  return controller !== null;
}

/** Tear down the world overlay if it's open. No-op if already closed. */
export function exitWorld(): void {
  _exitWorld?.();
}

/** Hide + freeze World (it stays alive underneath) while a delegated panel/minigame is up. */
export function pauseWorld(): void {
  _pauseWorld?.();
}
/** Bring a paused World back — same position, same everything. No-op if World isn't paused. */
export function resumeWorld(): void {
  _resumeWorld?.();
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

/** Pop a speech bubble over a world avatar (from a `worldSay` server message). */
export function feedSay(id: string, name: string, text: string, say = false): void {
  controller?.feedSay(id, name, text, say);
}

/** Render an explosion at a world point (from a `worldBoom` server message). No-op if closed. */
export function feedBoom(x: number, y: number, r?: number, shooterPid?: string): void {
  controller?.feedBoom(x, y, r, shooterPid);
}

/** Render another player's rocket streaking across the world (from a `worldRocket` message). */
export function feedRocket(x: number, y: number, a: number): void {
  controller?.feedRocket(x, y, a);
}

/** Mirror a chat line (from a `chat` server message) into the in-world side feed. No-op if closed. */
export function feedWorldChat(line: ChatLine): void {
  controller?.feedChat(line);
}

/** Re-assert our presence in the world after a reconnect (the server drops us on socket close). */
export function reenterWorld(): void {
  controller?.reenter();
}

/** Handle a Road Rage event broadcast. */
export function feedRoadRage(active: boolean, endsAt: number, standings: { name: string; kills: number }[]): void {
  controller?.feedRoadRage(active, endsAt, standings);
}

/** Handle a McDonald's food result from the server. */
export function feedMcFood(item: string, granted: boolean, bonus?: number): void {
  controller?.feedMcFood(item, granted, bonus);
}

/** Server's answer to an eloProfileReq fired from inside the Hall of Fame. No-op if World is closed. */
export function feedEloProfile(msg: EloProfileMsg): void {
  controller?.feedEloProfile(msg);
}
/** Server's answer to a balanceSheetReq fired from inside the Hall of Fame. No-op if World is closed. */
export function feedBalanceSheet(msg: BalanceSheetMsg): void {
  controller?.feedBalanceSheet(msg);
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
  { x: 2945, y: 1290, w: 110, h: 130 },  // spur south to the Bolwoing Alley
  { x: 2115, y: 1295, w: 110, h: 595 },  // spur south to McDonald's
  { x: 605, y: 1490, w: 110, h: 330 },   // spur further south, Casino → the General Store
  { x: 2595, y: 900, w: 110, h: 80 },    // spur east off the Pet-shack road → Hall of Fame
  { x: 2595, y: 470, w: 110, h: 80 },    // spur east off the Pet-shack road → the Notice Board
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
// The Temple's INTERIOR — a grand candlelit nave, off-map BELOW the Tavern block (which ends at y860)
// so the two never overlap. Same camera/collision swap trick as the Tavern.
const TEMPLE_INT = { x: 5400, y: 1120, w: 920, h: 700 };
const TEMPLE_WALL = 34;  // thick stone walls (play area is inset by this)
const TEMPLE_ZOOM = 2.4; // a touch wider than the Tavern — let the lofty nave breathe
// McDonald's INTERIOR — off-map below the Temple block (which ends at y≈1820)
const MC_INT = { x: 5400, y: 2100, w: 780, h: 500 };
const MC_WALL = 26;
const MC_ZOOM = 3;
// The Casino's INTERIOR — a neon gaming floor off-map below McDonald's (which ends at y≈2600).
// Bigger than the other rooms (it hosts a whole row of machines), so the zoom stays wider than
// the cozy Tavern/Temple/McDonald's rooms to keep several cabinets on screen at once.
const CASINO_INT = { x: 5400, y: 2700, w: 1400, h: 820 };
const CASINO_WALL = 30;
const CASINO_ZOOM = 1.7;
// Every casino game gets its own walk-up cabinet on the gaming floor. `feature` is the same key
// net.openFeature() already understands (these games already work via the exterior building's
// dialog list) — walking up to a cabinet and playing just skips that list and goes straight in.
const CASINO_GAMES: readonly { feature: 'roulette' | 'blackjack' | 'craps' | 'crash' | 'slots' | 'plinko' | 'horse' | 'hilo' | 'mines' | 'lootbox' | 'blackmarket'; emoji: string; label: string; color: number }[] = [
  { feature: 'slots', emoji: '🎰', label: 'Slots', color: 0xe8b84b },
  { feature: 'roulette', emoji: '🎡', label: 'Roulette', color: 0xa8323a },
  { feature: 'blackjack', emoji: '🃏', label: 'Blackjack', color: 0x1f6b46 },
  { feature: 'craps', emoji: '🎲', label: 'Craps', color: 0x1f6b46 },
  { feature: 'crash', emoji: '🚀', label: 'Crash', color: 0x3a4ea8 },
  { feature: 'plinko', emoji: '🎯', label: 'Plinko', color: 0x7a4fa8 },
  { feature: 'horse', emoji: '🏇', label: 'Horse Racing', color: 0x5a3d2a },
  { feature: 'hilo', emoji: '🔺', label: 'Hi-Lo', color: 0x1f6b46 },
  { feature: 'mines', emoji: '💣', label: 'Mines', color: 0x3a2a2a },
  { feature: 'lootbox', emoji: '🎁', label: 'Loot Box', color: 0xff3ea5 },
  { feature: 'blackmarket', emoji: '🛒', label: 'Black Market', color: 0x555a66 },
] as const;

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
// --- Friend Sim types — VN-style branching dialogue + XP-tracked friendship levels. ----------
// Each friend NPC has FriendTalk scenes unlocked at different levels. Designed so dating /
// deeper arcs can be layered on later without restructuring (add `minRelType` / `dateScenes`).
interface FriendChoice {
  label: string; reply: string; mood?: string; xp: number;
  // Risky choice (🎲, styled hot): roll on click — chance in [0,1] of the normal
  // reply/xp; otherwise you get risk.reply and risk.xp (usually negative).
  risk?: { chance: number; reply: string; mood?: string; xp: number };
  // Persona-style stat gate: shown 🔒-greyed until the requirement is met.
  // night = 10pm–6am local; the rest compare a live stat against min.
  req?: { stat: 'elo' | 'coins' | 'wins' | 'night' | 'fish'; min?: number; lockText: string };
}
interface FriendPage { text: string; mood?: string; choices?: FriendChoice[]; }
interface FriendTalk { minLevel: number; pages: FriendPage[]; } // unlocked when friendship level ≥ minLevel
interface FriendBonus { check: () => boolean; xp: number; label: string; hint: string; }
// -----------------------------------------------------------------------------------------

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
  kind?: 'minion' | 'kenny' | 'demon' | 'soul' | 'angler' | 'protester' | 'fed' | 'dorito'; // special one-off sprite; default is the little-person
  glasses?: boolean;    // overlay specs
  stripes?: boolean;    // red/white striped shirt instead of a flat tinted one (Waldo!)
  x: number; y: number; // home anchor (NPC roams around this)
  roam: number;         // wander radius, world units
  lines: string[];      // flavour one-liners, cycled each chat
  ask?: { q: string; choices: [NpcChoice, NpcChoice] }; // optional: a question you can answer
  // Friend-sim (optional — only on dedicated friend NPCs):
  friendKey?: string;     // localStorage key suffix; presence = friend-sim NPC
  friendColor?: string;   // portrait circle background CSS hex (e.g. '#5a0840')
  friendTalks?: FriendTalk[]; // VN dialogue trees; each scene unlocked at minLevel
  friendBonus?: FriendBonus; // optional bonus XP triggered by a real-world condition
  portraitSrc?: string;     // static portrait image URL (overrides emoji canvas)
  glitchPortrait?: true;    // level-based portrait progression (mira0–4.jpeg)
}
// Skin-tone palette to spread across the cast.
const SKINS = [0xf6d3b0, 0xeebb91, 0xd29b6e, 0xb87a4f, 0x8d5a34] as const;

// --- Friend Sim helpers (module-level — pure localStorage; no server round-trip) ------
const getPongWins = () => { try { return parseInt(localStorage.getItem('tsong.world.pongWins') || '0', 10) || 0; } catch { return 0; } };
// Tuned so leveling keeps pace with fresh scenes — you should never see a repeat
// until you've maxed the friendship (~10 conversations: 3 + 2 + 2 + 2 + the finale).
const FRIEND_THRESHOLDS = [0, 100, 200, 350, 500] as const;
// One-time reset: the dialogue trees + XP curve were rewritten, so stale progress
// (earned against the old scenes/thresholds) is wiped. Bump to wipe again.
const FRIEND_DATA_VERSION = '2';
try {
  if (localStorage.getItem('tsong.friend.v') !== FRIEND_DATA_VERSION) {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('tsong.friend.')) localStorage.removeItem(k);
    }
    localStorage.setItem('tsong.friend.v', FRIEND_DATA_VERSION);
  }
} catch { /* private browsing etc. — friend progress just won't persist */ }
const FRIEND_LEVEL_NAMES = ['Stranger', 'Acquaintance', 'Friend', 'Good Friend', 'Best Friend'] as const;
function getFriendXp(key: string): number {
  try { return Math.max(0, parseInt(localStorage.getItem(`tsong.friend.${key}`) || '0', 10) || 0); } catch { return 0; }
}
function addFriendXp(key: string, xp: number): { newXp: number; levelUp: boolean; levelDown: boolean } {
  const old = getFriendXp(key);
  const oldLevel = getFriendLevel(old);
  const newXp = Math.max(0, old + xp); // risky choices can lose XP, but never below zero
  try { localStorage.setItem(`tsong.friend.${key}`, String(newXp)); } catch { /* ignore */ }
  const newLevel = getFriendLevel(newXp);
  return { newXp, levelUp: newLevel > oldLevel, levelDown: newLevel < oldLevel };
}
function getFriendLevel(xp: number): number {
  let lv = 0;
  for (let i = 1; i < FRIEND_THRESHOLDS.length; i++) { if (xp >= FRIEND_THRESHOLDS[i]) lv = i; }
  return lv;
}
function getFriendSeen(key: string): Set<number> {
  try { const v = localStorage.getItem(`tsong.friend.seen.${key}`); return v ? new Set(JSON.parse(v) as number[]) : new Set(); } catch { return new Set(); }
}
function markFriendSeen(key: string, idx: number): void {
  try { const s = getFriendSeen(key); s.add(idx); localStorage.setItem(`tsong.friend.seen.${key}`, JSON.stringify([...s])); } catch { /* ignore */ }
}
function clearFriendSeen(key: string): void {
  try { localStorage.removeItem(`tsong.friend.seen.${key}`); } catch { /* ignore */ }
}
function makeFriendPortrait(emoji: string, bgColor: string): string {
  const c = document.createElement('canvas'); c.width = 100; c.height = 100;
  const ctx = c.getContext('2d')!;
  const grd = ctx.createRadialGradient(42, 38, 6, 50, 50, 50);
  grd.addColorStop(0, bgColor + 'ee'); grd.addColorStop(1, '#080818dd');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(50, 50, 48, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.font = '54px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 50, 55);
  return c.toDataURL();
}
function makeMiraPortrait(level: number, mood: string): string {
  const revealed = level >= 4;
  const c = document.createElement('canvas'); c.width = 100; c.height = 100;
  const ctx = c.getContext('2d')!;
  const bg = revealed ? '#3a0008' : '#1e0832';
  const grd = ctx.createRadialGradient(42, 38, 6, 50, 50, 50);
  grd.addColorStop(0, bg + 'ee'); grd.addColorStop(1, '#080818dd');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(50, 50, 48, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = level >= 3 ? 'rgba(255,30,60,0.55)' : 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2.5; ctx.stroke();
  ctx.font = '54px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(revealed ? '😈' : mood, 50, 55);
  // Level 1+: horizontal scan lines
  if (level >= 1) {
    for (let y = 0; y < 100; y += 4) {
      ctx.fillStyle = `rgba(0,0,0,${0.08 + level * 0.025})`;
      ctx.fillRect(0, y, 100, 1);
    }
  }
  // Level 2+: chromatic aberration (R/B channel split)
  if (level >= 2) {
    const shift = level >= 3 ? 5 : 2;
    const src = ctx.getImageData(0, 0, 100, 100);
    const dst = ctx.createImageData(100, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 4;
        const ri = (y * 100 + Math.max(0, x - shift)) * 4;
        const bi = (y * 100 + Math.min(99, x + shift)) * 4;
        dst.data[i] = src.data[ri]; dst.data[i+1] = src.data[i+1];
        dst.data[i+2] = src.data[bi+2]; dst.data[i+3] = src.data[i+3];
      }
    }
    ctx.putImageData(dst, 0, 0);
  }
  // Level 3+: displaced glitch strips
  if (level >= 3) {
    const src = ctx.getImageData(0, 0, 100, 100);
    const dst = new ImageData(new Uint8ClampedArray(src.data), 100, 100);
    for (let s = 0; s < 5 + level; s++) {
      const gy = Math.floor(Math.random() * 88);
      const gh = 2 + Math.floor(Math.random() * 5);
      const off = Math.floor(Math.random() * 18) - 9;
      for (let y = gy; y < gy + gh && y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const sx = Math.min(99, Math.max(0, x - off));
          const si = (y * 100 + sx) * 4, di = (y * 100 + x) * 4;
          dst.data[di] = src.data[si]; dst.data[di+1] = src.data[si+1];
          dst.data[di+2] = src.data[si+2]; dst.data[di+3] = src.data[si+3];
        }
      }
    }
    ctx.putImageData(dst, 0, 0);
  }
  // Level 4: red vignette + noise pixels
  if (level >= 4) {
    const vg = ctx.createRadialGradient(50, 50, 18, 50, 50, 50);
    vg.addColorStop(0, 'transparent'); vg.addColorStop(1, 'rgba(200,0,30,0.52)');
    ctx.fillStyle = vg; ctx.beginPath(); ctx.arc(50, 50, 48, 0, Math.PI * 2); ctx.fill();
    const nd = ctx.getImageData(0, 0, 100, 100);
    for (let i = 0; i < nd.data.length; i += 4) {
      if (Math.random() < 0.045) {
        nd.data[i] = 200 + Math.random() * 55; nd.data[i+1] = 0;
        nd.data[i+2] = Math.random() * 60; nd.data[i+3] = 210;
      }
    }
    ctx.putImageData(nd, 0, 0);
  }
  return c.toDataURL();
}
// --------------------------------------------------------------------------------------

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
  {
    // Danny DeVito, but he's a Dorito. Loiters near the Tavern being magnificent garbage.
    id: 'doritas', name: 'Doritas DeVito', shirt: 0xe8912c, hair: 0x2a1d10, kind: 'dorito',
    x: 1300, y: 1780, roam: 100,
    lines: [
      "I'm a chip off the old block. The block was also a chip. It's chips all the way down.",
      "Crunchy on the outside. Crunchier on the inside. No soft parts. That's DeVito.",
      "I found a nickel in the fountain. Finders keepers. That's the law now. I made it law.",
      "They call me Cool Ranch behind my back. To my face it's 'sir.'",
      "I stuffed a ham with rum and floated it down the pond. It's an investment. Don't touch my rum ham.",
      "I once ate a whole bag of myself. Long story. Weird night. Regrets? A few. Would I again? Instantly.",
      "You want the last of me? Tough. I'm a limited-edition flavor, sweetheart.",
    ],
    ask: {
      q: 'Nacho Cheese or Cool Ranch — pick a side, and choose wisely.',
      choices: [
        { label: 'Nacho Cheese', reply: 'The classic. The KING. ...Alright. We can be friends.' },
        { label: 'Cool Ranch', reply: "Get outta here. ...Fine. But we're not friends. We're acquaintances." },
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
  // --- McDonald's INTERIOR cast (stationary, off-map at MC_INT; only reachable once you're inside) ---
  {
    id: 'mc-cashier', name: 'Mac', shirt: 0xcc0000, hair: 0x1a1a1a, skin: SKINS[2],
    hairStyle: 'short' as const, x: MC_INT.x + MC_INT.w / 2, y: MC_INT.y + 95, roam: 0,
    lines: [
      'Welcome to McDonald\'s! Can I take your order?',
      'Would you like to try our McFlurry today?',
      'That\'ll be $5.39. Will that be all?',
      'Our fries are hot and fresh right now!',
      'Have a great day! 😊',
    ],
  },
  {
    id: 'mc-grimace', name: 'Grimace', shirt: 0x7a2a9a, hair: 0x4a1a6a, skin: 0x9a44cc,
    x: MC_INT.x + Math.round(MC_INT.w * 0.22), y: MC_INT.y + MC_INT.h - 130, roam: 0,
    lines: [
      'Mmmmm... McFlurry... my one true love.',
      'I have been eating here every day since 1971.',
      'The purple shake... it calls to me.',
      'Have you tried the 20-piece nuggets? Asking for a friend.',
      '*is entirely made of purple*',
      'Ronald keeps giving me free stuff. I think he feels bad about the whole thing.',
    ],
  },
  {
    id: 'mc-ronald', name: 'Ronald', shirt: 0xff2200, hair: 0xff6600, skin: SKINS[0],
    hairStyle: 'spiky' as const,
    x: MC_INT.x + Math.round(MC_INT.w * 0.76), y: MC_INT.y + MC_INT.h - 110, roam: 20,
    lines: [
      'Ba da ba ba baaa~ I\'m lovin\' it! 🎵',
      'Did you hear about the tsong tournament? I\'m DEFINITELY entering.',
      'Every Happy Meal comes with a toy. Or a regret. It\'s 50/50.',
      'I\'ve been a clown here for 40 years. The benefits are incredible.',
      'The fry oil... it flows through me now.',
      'Fun fact: the M stands for Magic. Always has.',
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
  // ====================== FRIEND SIM NPCs ==============================================
  // 3 female + 2 male. Each has a `friendKey` + `friendTalks` VN dialogue tree.
  // XP persisted per-browser in localStorage (key: tsong.friend.<friendKey>).
  // Architecture: extend by adding scenes at higher minLevel, or a `dateScenes` array
  // once a dating/romance arc is ready to layer on.
  // ======================================================================================
  {
    id: 'zara', name: 'Zara', shirt: 0xd060c0, hair: 0x1a1030, skin: SKINS[1],
    body: 'dress' as const, hairStyle: 'bun' as const, glasses: true,
    x: 1870, y: 1210, roam: 90,
    lines: ['Do I know you?'],
    friendKey: 'zara', friendColor: '#5a0840', portraitSrc: '/portraits/zara.jpeg',
    friendTalks: [
      { minLevel: 0, pages: [
        { text: 'Hm. You again. Or are you new? I can\'t tell. Everyone here has the same "main character" energy.', mood: '🙄' },
        { text: 'So. What brings you to my general vicinity?', choices: [
          { label: 'Just passing through', reply: 'And yet you stopped. Interesting choice.', mood: '😏', xp: 20 },
          { label: 'I wanted to meet you', reply: 'Bold. I\'ll allow it. Try not to make it weird. I\'m Zara.', mood: '💅', xp: 30 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'My life coach told me to be open to connections. She has not seen this town.', mood: '😤' },
        { text: 'There\'s a man made of a chip wandering around out there and nobody bats an eye. I am batting an eye. At you. Tentatively.', choices: [
          { label: 'What\'s wrong with the Dorito man?', reply: 'He confuses me and I respect him for it. Much like you, potentially.', mood: '😏', xp: 25 },
          { label: 'I\'m a connection worth having', reply: 'Either wildly confident or wildly delusional. Either way — I\'m intrigued.', mood: '💅', xp: 35 },
          { label: 'Your pockets are fake and so is your cynicism', reply: '...Excuse me. *pause* Okay. That was genuinely well-constructed. Cruel, precise, structurally sound. Are you consulting? You should consult. I\'m furious and impressed simultaneously, which is my favorite emotional state and very hard to bill for.', mood: '😏', xp: 80,
            risk: { chance: 0.55, reply: 'Hm. No. The pockets are load-tested and the cynicism is billable. Swing and a miss. I\'m docking you for it — consider it a consultation fee. My rates were on the letterhead you didn\'t read.', mood: '🙄', xp: -40 } },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'The town erected a new sign near the fountain. "A Place for Everyone." Seven words doing an enormous amount of structural work.', mood: '🙄' },
        { text: 'I\'ve been hired to "enhance the town\'s brand presence." I\'m starting to suspect the town\'s brand presence is fine and my client just wants someone to blame if tourists don\'t show up.', choices: [
          { label: 'What\'s wrong with the sign?', reply: 'Nothing is technically wrong. That\'s the problem. "A Place for Everyone" is the motivational poster of civic signage — inoffensive to the point of becoming offensive. I\'ve been paid to write things exactly like that. I do it well. I hate myself incrementally less each time. I\'m choosing to call that progress.', mood: '😏', xp: 28 },
          { label: 'It sounds fine to me', reply: 'Fine is the enemy of interesting. Fine is the beige of emotions. Fine is "how are you" used as a greeting rather than a question. I ordered coffee this morning, described my mood as "caffeinated," and the barista wrote "mermaid" on the cup. She was correct. This town is fine.', mood: '🙄', xp: 22 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'Genuine question. Not market research. Actually genuine — I don\'t have a clipboard right now.', mood: '😐' },
        { text: 'Do people here actually like this town? I cannot determine if everyone is performing contentment or if this is what contentment actually looks like and I\'ve simply forgotten.', mood: '😐' },
        { text: 'You can be honest with me. I\'m not writing a report on you specifically.', choices: [
          { label: 'I think people genuinely like it', reply: 'Hm. That\'s disconcerting. I\'ve been treating this assignment like spin, and if people here are authentically content I might have to engage with the place sincerely. I\'m not sure I have the emotional infrastructure for that right now. My calendar is dense with skepticism. I\'d need to reschedule several things.', mood: '😐', xp: 30 },
          { label: 'Most people are just performing it', reply: 'Good. That\'s more comfortable. Performance has metrics. Authentic contentment is a different brief entirely and nobody mentioned it in the contract. I can work with performance. I am excellent at performance. Look at this coat. The pockets aren\'t even real. Entirely deliberate.', mood: '💅', xp: 25 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'Oh it\'s you. My "acquaintance." I looked it up. "A person one knows slightly." We are absolutely nailing it.', mood: '😏' },
        { text: 'How\'s your... whatever it is you do?', choices: [
          { label: 'Pretty good actually', reply: 'Good. I\'ve decided I want you to thrive. A thriving acquaintance makes me look like a good judge of character.', mood: '💅', xp: 35 },
          { label: 'Could be better', reply: 'Noted. I\'ll try being marginally more supportive next time. I\'m practicing.', mood: '🙄', xp: 42 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'Confession: I\'ve started looking forward to our chats. Don\'t tell anyone. I have an image.', mood: '😏' },
        { text: 'I may have mentioned you positively to someone once. I immediately regretted the vulnerability. And then I didn\'t.', choices: [
          { label: 'Your secret\'s safe with me', reply: 'Good. Also I defended your honor in a minor disagreement. Unsolicited. Surprising to me too.', mood: '💅', xp: 50 },
          { label: 'Awww, Zara', reply: 'Do NOT "awww" me. I have business cards. One of them says "Executive of Feelings Suppression."', mood: '😤', xp: 40 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Theory: everyone in this town is waiting for something. What are YOU waiting for?', mood: '🤔' },
        { text: 'And please, not "nothing." I am making an actual effort here.', choices: [
          { label: 'A good pong match', reply: 'Honest. Classic. I\'m waiting for someone to admit the Dorito man is sentient. We\'re both in niche categories.', mood: '😏', xp: 45 },
          { label: 'For things to make sense', reply: 'That\'s never happening. But the aspiration? Chef\'s kiss. Keep that energy.', mood: '💕', xp: 55 },
          { label: 'I don\'t know', reply: 'Same. The most honest answer in this whole town. I\'m genuinely proud of you.', mood: '💕', xp: 62 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'I did your brand audit. Unprompted and free of charge, which for me is unprecedented. My hourly rate has a comma in it.', mood: '💅' },
        { text: 'Findings: you show up. Repeatedly. On a schedule I could set a campaign calendar by. Do you know how rare "shows up" is as a brand pillar? Entire companies pay me six figures to fake it.', choices: [
          { label: 'So what\'s my brand?', reply: 'Reliable, with undertones of mystery — because I still don\'t know what you actually do all day. Wins pong matches, opens chests, talks to consultants. Honestly? Marketable. If you ever want a logo, my rate for friends is merely offensive instead of unconscionable.', mood: '😏', xp: 55 },
          { label: 'You audited me??', reply: 'I audit everything. I audited the fountain — strong visual identity, zero message discipline. I audited the Dorito man — flawless brand consistency, deeply concerning product. You scored above both. Congratulations. There is no certificate. The certificate is my continued attention.', mood: '💅', xp: 62 },
          { label: 'Let\'s talk leaderboard strategy', req: { stat: 'elo', min: 820, lockText: 'reach 820 ELO' }, reply: 'Eight-twenty. EIGHT-TWENTY. I checked before you walked up — I check everyone, but yours I\'ve been watching climb for weeks like a stock I was too proud to buy in early. That\'s not a rating anymore, that\'s a REPUTATION. Sit down. I have thoughts about your matchup positioning, your title sponsorship potential, and your inevitable rivalry arc, and for the first time in my career the consultation is free.', mood: '😏', xp: 80 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'They let me rewrite the sign. "A Place for Everyone" is dead. I pitched fourteen alternatives. They picked the safest one, obviously.', mood: '🙄' },
        { text: 'It now says "A Place for Everyone — And Then Some." The "And Then Some" was my compromise with mediocrity. I fought for it like it was the beach at Normandy.', choices: [
          { label: 'Honestly? It\'s better', reply: 'It is marginally better. Marginal improvement is my entire career. You stack enough marginals and one day you wake up and the town has a voice. Also the coffee cart has stopped writing "mermaid" on my cup. It now says "consultant." Growth is real and it is spelled correctly.', mood: '💅', xp: 70 },
          { label: 'That\'s barely different', reply: 'Correct. But "barely different" is how you move a town that once elected to keep a fed in a trench coat as a tourist attraction. You don\'t rebrand a place like this in one quarter. You nudge it. Then you invoice it. Then you nudge it again. It\'s called strategy and I\'m annoyingly good at it.', mood: '😏', xp: 65 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I renewed my contract. Don\'t make a thing of it. The town "requires continued brand stewardship." That\'s the official line.', mood: '😐' },
        { text: 'The unofficial line is that I looked at my old apartment listing in the city and felt nothing, and then I looked at this absurd fountain and felt something adjacent to fondness. I\'m attributing it to prolonged fountain-based marketing exposure.', choices: [
          { label: 'You stayed for us', reply: '"Us." Hm. I stayed for the coffee mermaid, the sentient Dorito, and one acquaintance who quietly upgraded themselves to load-bearing. I won\'t be specifying which one you are. A good consultant never reveals the org chart.', mood: '💕', xp: 80 },
          { label: 'Fondness is off-brand for you', reply: 'Wildly off-brand. If you tell anyone I will issue a formal denial on letterhead. I have letterhead now. The letterhead was eighty percent of why I renewed. The other twenty percent is currently smirking at me, so let\'s move on.', mood: '😏', xp: 85 },
          { label: 'Retain me. Name your rate.', req: { stat: 'coins', min: 1000000, lockText: '1,000,000 coins' }, reply: '*checks your balance* *checks it again* *sits down slowly* You\'re a MILLIONAIRE? You\'ve been letting me monologue about letterhead while sitting on seven figures?? ...No. No rate. You can\'t retain me — a consultant can\'t bill the client she\'d work for free. That\'s the most expensive sentence I\'ve ever said and you\'re the only person who\'ll ever hear it. Frame it.', mood: '💕', xp: 100 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Pop quiz. I\'m told friendship involves retention, and I retain everything about you, so let\'s see if it\'s mutual. Wrong answers have consequences. I\'m a consultant. Everything has consequences.', mood: '😏' },
        { text: 'What does the town sign say now? The one I bled for.', choices: [
          { label: '"A Place for Everyone — And Then Some"', reply: 'Word. For. Word. Including the em dash. Do you know how many people remember an em dash? I want to frame this moment. I might invoice the town for the emotional value it just generated.', mood: '💕', xp: 75 },
          { label: '"A Place for Everyone"', reply: 'That\'s the OLD sign. The one I was hired to kill. You just quoted the corpse at the funeral. I need a moment. And a deduction. Mostly a deduction.', mood: '🙄', xp: -20 },
          { label: '"Everyone Welcome, And Stuff"', reply: '"And STUFF." And. Stuff. You\'ve just been added to the list of reasons this town needs me. It\'s a long list. You\'re near the top now. Congratulations on the promotion.', mood: '😐', xp: -25 },
        ]},
      ]},
      { minLevel: 4, pages: [
        { text: 'I made you a friendship bracelet. Destroyed it. Made it again. This is bracelet number two. It comes with a certificate. On the letterhead. This is the letterhead\'s first official act.', mood: '💕' },
        { text: 'The certificate says "load-bearing," because I finally decided to specify which one you are. You\'re my person in this bizarre little town. Don\'t ghost me or I will make your life inconvenient in small but creative ways. I know your whole brand. I audited it. I know exactly where to strike.', choices: [
          { label: 'I would never', reply: 'Good. The bracelet is string. The sentiment is not. That\'s the whole thing. Final audit note, and then we never speak of my feelings again: best account I ever worked, zero invoices issued. Don\'t quote me. It\'s not on letterhead. It\'s just true.', mood: '💕', xp: 100 },
          { label: 'This is the most touching thing you\'ve said', reply: 'I know. I\'ve been building to it since the sign. "A Place for Everyone — And Then Some." You\'re the And Then Some. That was the pitch the whole time. Fourteen alternatives and I fought for that one. Don\'t make it weird. Actually — make it a little weird. But not too weird.', mood: '🥹', xp: 90 },
        ]},
      ]},
    ],
    friendBonus: { check: () => getPongWins() >= 5, xp: 30, label: "You have stats. I can respect that.", hint: "Win 5+ tsong matches" },
  },
  {
    id: 'bex', name: 'Bex', shirt: 0xff7730, hair: 0xe83a10, skin: SKINS[0],
    body: 'dress' as const, hairStyle: 'pony' as const,
    x: 1090, y: 1505, roam: 100,
    lines: ['Oh! Hi! Sorry, I was—'],
    friendKey: 'bex', friendColor: '#1a0862', portraitSrc: '/portraits/bex.jpeg',
    friendTalks: [
      { minLevel: 0, pages: [
        { text: 'OH! Hi! Sorry I was just — have you TRIED the fountain water? No don\'t. That was weird. I\'m Bex. Hi!', mood: '😄' },
        { text: 'What\'s your deal? What are you INTO? Tell me everything. Actually top three things. GO.', choices: [
          { label: 'Pong, mostly', reply: 'PONG. Okay okay. I respect the commitment. I tried pong once. I knocked the ball off the table. It was a video game. I don\'t understand me.', mood: '😅', xp: 25 },
          { label: 'Just exploring', reply: 'SAME. I\'ve been "exploring" for three weeks. At some point this is just living here. Nobody tells you when that happens.', mood: '😄', xp: 30 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I JUST saw a pigeon trip over its own feet. Do they KNOW they have feet? This is bothering me.', mood: '😮' },
        { text: 'Like we don\'t trip over our own hands. WHY. The pigeon is fine by the way. He walked it off.', choices: [
          { label: 'Pigeons definitely know', reply: 'OKAY so WHY do they trip?? It\'s not like we trip over our hands. Unless. Can you trip over your own hands? I might test this.', mood: '🤔', xp: 25 },
          { label: 'They probably don\'t', reply: 'That\'s WORSE. That means they\'re walking on mystery sticks they can\'t explain. Pigeons are going through it.', mood: '😮', xp: 32 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'OKAY. Okay okay okay. You have a face like you\'ll let me finish sentences. That is RARE and I need to use this right now.', mood: '😄' },
        { text: 'Someone said I was "a lot" earlier. Just those two words. "You\'re a lot." And then they LEFT. Left without saying what I\'m a lot OF. That\'s illegal. That should be illegal. I\'ve been spinning out for forty-five minutes.', mood: '😅' },
        { text: 'What do you think they meant?', choices: [
          { label: 'Energy, probably', reply: 'ENERGY! Yes! Okay! Energy is just enthusiasm with nowhere to sit down! I have SO much enthusiasm with nowhere to sit down, it\'s true, I can acknowledge that! That\'s actually fine! Thank you! I\'m going to find Doug and tell him he was right and also vague and both things can coexist. Poor Doug. Probably exhausted. But fine!', mood: '😄', xp: 30 },
          { label: 'I think it was a compliment', reply: 'Do you THINK? Because I\'ve replayed it and by the third replay Doug had a completely different tone and by the fourth he was crying tears of joy about how interesting I am and I KNOW that\'s not what happened but the fourth replay was so comforting that I\'ve been living there. The fourth replay is my home now.', mood: '🥺', xp: 38 },
          { label: 'Doug had a point tbh', reply: 'WOW. Wow wow wow. Okay you know what — BOLD. And... correct?? I AM a lot. A lot is a UNIT. A lot is a QUANTITY WORTH HAVING. Nobody\'s ever agreed with Doug TO MY FACE and somehow it\'s the most honest thing anyone\'s done for me?? I\'m putting "had a point tbh" in the Running Jokes tab. We have a TAB now!!', mood: '😄', xp: 75,
            risk: { chance: 0.55, reply: 'Oh. OH. You\'re DOUG-SIDED?? I have to go walk around the fountain nine times. This is a nine-lap conversation. *breathing* We\'re fine. WE\'RE FINE. I\'m deducting points though. Doug never got deducted because Doug isn\'t my FRIEND. See how that works. See the privilege you just spent.', mood: '😮', xp: -35 } },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'Fun fact about me: I once memorized the entire menu of a restaurant that closed before I could eat there. Front to back. Prices, descriptions, specials.', mood: '😄' },
        { text: 'It was called Biscotti & Things. The Things were never explained anywhere on the menu. Just. Things. I still think about the Things constantly. What were the Things. Nobody knows. The restaurant took the Things with it.', choices: [
          { label: 'What do you think the Things were?', reply: 'OKAY so I have theories. Theory one: the Things were whatever the chef felt like that day — chaotic, I respect it. Theory two: the Things were just more biscotti with different names to pad the menu. Theory three: the Things were none of our business and the restaurant KNEW it. Theory three haunts me the most and has honestly become foundational to my worldview.', mood: '😄', xp: 32 },
          { label: 'You memorized the whole menu?', reply: 'Every item. Every description. Every price. The seasonal salad had "hints of tomorrow" in the description. I don\'t know what that means. I will never know. I have a notes folder called "Biscotti & Things Mysteries" with seventeen entries. My therapist says we should talk about it. We haven\'t yet. I\'m not ready. The Things deserve more than I can currently give them.', mood: '🥺', xp: 28 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'You\'re back!! I thought about something I said last time for literally three days. Was I weird? I\'m asking instead of spiraling. Growth!', mood: '😅' },
        { text: 'My therapist says asking directly is healthier than catastrophizing. So. Was I weird.', choices: [
          { label: 'Not weird at all', reply: 'OKAY GOOD. I made a pros and cons list of our last conversation. Pros won by eight points. Huge win.', mood: '😄', xp: 35 },
          { label: 'A little, yeah', reply: 'Okay! Okay. I can work with that. You have a kind face when you\'re being honest. Has anyone told you that?', mood: '🥺', xp: 45 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'Okay confession: I\'ve been low-key hoping to run into you. Not in a weird way. In a — I made you a playlist.', mood: '😊' },
        { text: 'In my head. I didn\'t write it down but I know what\'s on it. It has one song that means something I can\'t explain yet.', choices: [
          { label: 'I want to hear it', reply: 'Okay so: three songs that are happy in a complicated way. One embarrassing one you get immediately. And the 2am one. That\'s the playlist.', mood: '😄', xp: 50 },
          { label: 'Tell me when it\'s ready', reply: 'You just GET it. It\'s a vibe thing. You\'ll know when it\'s time. I\'m building to it. This is very meaningful to me.', mood: '🥺', xp: 48 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I\'ve been thinking — and this is a Big Statement but I\'m a Brave Person now — I think you might be one of my favorite people.', mood: '🥺' },
        { text: 'Top five. Possibly top three. The list fluctuates. My dog is on it permanently. Just so you know the competition.', choices: [
          { label: 'I\'m honored', reply: 'YOU SHOULD BE. The list is CURATED. My mom, my dog, now you. That\'s a big deal. That is genuinely a big deal.', mood: '😄', xp: 55 },
          { label: 'Who\'s numbers one and two?', reply: 'Dog, then mom. Both permanent. You\'re in the rotating top-five. That actually makes you MORE impressive. You EARNED it.', mood: '😊', xp: 58 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'DOUG UPDATE. You remember Doug. "You\'re a lot" Doug. The one I built a fourth replay about. I FOUND HIM. I used my words like my therapist said!!', mood: '😮' },
        { text: 'He meant "a lot" like "a lot of GOOD energy" and he left because he was LATE FOR THE DENTIST. A dentist appointment!! I spiraled for a week over a CLEANING. He showed me the little card with the tooth on it and everything.', choices: [
          { label: 'CLOSURE!!', reply: 'CLOSURE!!! I added a whole tab to the friendship document called "Resolved Arcs" and Doug is the first entry and there\'s a little checkmark and I made the checkmark GOLD. My therapist said this was "healthy resolution seeking." I said LETS GOOO. She\'s heard that before. From Chad actually. Small town.', mood: '😄', xp: 55 },
          { label: 'The fourth replay was still real', reply: 'THANK you. Like yes, factually, dentist. But emotionally?? The fourth replay where he cried about how interesting I am?? That version of Doug lives on in my heart. Real Doug and Replay Doug can coexist. My therapist is BEGGING me to stop saying that. It\'s in the document under "Doctrines."', mood: '😄', xp: 60 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'Okay don\'t freak out but the friendship document has TIERS now. I color-coded everyone I know. You\'re in the gold tier. There are two entries in the gold tier. The other one is my mom.', mood: '😊' },
        { text: 'I want to be clear that mom was gold FIRST so you can\'t be number one, but you are FIRMLY tied for first among people I did not exit the womb in front of.', choices: [
          { label: 'What does gold tier get me?', reply: 'SO much. Birthday spreadsheet with countdown. Emergency snack priority — if I have one granola bar and we\'re both hungry, it\'s legally yours, I wrote it down. And the big one: I show UP. Flat tire at 2am? I\'m there. No car, so I\'m there SLOWLY, on foot, with snacks. But I\'m THERE.', mood: '😄', xp: 70 },
          { label: 'Tied with your MOM?', reply: 'I KNOW. She doesn\'t know about you yet which is insane because you\'re tied. I should fix that. Family dinner? Too fast? She makes a lasagna that made my therapist cry at a potluck. That\'s not a metaphor, there were witnesses, it\'s in the document.', mood: '😮', xp: 65 },
          { label: 'I\'ll bankroll the Biscotti investigation', req: { stat: 'coins', min: 1000000, lockText: '1,000,000 coins' }, reply: 'You— WHAT?? You have a MILLION COINS?? And your first instinct was the BISCOTTI FUND?? No. NO. I can\'t take a millionaire\'s coins, this is a PASSION project, it runs on obsession and a notes folder!! ...But you stood there, rich as a casino, and looked at my restaurant mystery and said "this deserves FUNDING." I\'m crying in the document. New tab. You\'re the only entry. INVESTOR OF MY HEART, ZERO COINS ACCEPTED, NET WORTH: EVERYTHING.', mood: '🥹', xp: 85 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Can I be sixty percent serious for a second? That\'s my maximum. I\'ve measured.', mood: '🥺' },
        { text: 'When I was a kid nobody ever let me finish a sentence, so I started saying all my sentences at once in case I only got one turn. That\'s the whole origin story. That\'s why I\'m "a lot." And you just... wait. Every time. You wait for the whole thought.', choices: [
          { label: 'I like the whole thought', reply: 'See — SEE — this is why you\'re gold tier. Okay crying is scheduled for later, I\'ve penciled it in. BIG NEWS instead: I found the nephew of the guy who owned Biscotti & Things. I\'m getting closer to the Things. The mystery is UNRAVELING. You\'re the first person I told. Obviously. It\'s you.', mood: '🥹', xp: 80 },
          { label: 'Take all the turns you need', reply: 'I\'M GOING TO NEED SO MANY TURNS. You have NO idea what you\'ve signed up for. Okay one more serious thing and then we\'re done: thank you for waiting. Nobody waits. End of serious. RESUMING NORMAL BROADCAST: do you think pigeons have gold tiers.', mood: '😄', xp: 85 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'POP QUIZ!! No pressure except ALL the pressure!! This is a friendship CHECKPOINT and it\'s going in the document either way!!', mood: '😄' },
        { text: 'What was the name of the restaurant?? THE restaurant. The one. You know the one. If you know me at ALL you know the one.', choices: [
          { label: 'Biscotti & Things', reply: 'YES!!! THE THINGS!!! You remembered the THINGS!!! I\'m adding this to "Moments That Mattered" with THREE exclamation points which is the maximum I allow because FOUR would be unhinged!!! You KNOW me. You actually KNOW me!!', mood: '🥹', xp: 75 },
          { label: 'Biscotti & Stuff', reply: 'STUFF?? S T U F F?? The Things were MYSTERIES, the Things were LORE, the Things had a NOTES FOLDER, and you called them STUFF like they were a JUNK DRAWER. I\'m not crying. I\'m updating the document. There\'s a deductions tab now. You built it. Just now. With your words.', mood: '😮', xp: -20 },
          { label: 'Linguini & Things', reply: 'LINGUINI?? It was a BISCOTTI establishment!! Linguini wasn\'t even ON the menu — I would KNOW, I memorized it, the closest pasta adjacency was the "hints of tomorrow" salad!! Minus points!! The document weeps!!', mood: '😅', xp: -20 },
        ]},
      ]},
      { minLevel: 4, pages: [
        { text: 'OKAY so. I have a whole thing. I practiced it in the mirror. Three times. Here goes.', mood: '😮' },
        { text: 'You are one of the best people I\'ve met and I waited to say it because what if it was weird and then I decided being scared of weird is WORSE than the potential weird.', mood: '🥺' },
        { text: 'Best Friend Status. Official. And a promotion: SOLO gold tier. I invented platinum for my mom so you could have gold to yourself. She was honored. There was lasagna about it.', mood: '😄' },
        { text: 'I made a document. Obviously I made a document. I might laminate it.', choices: [
          { label: 'I\'d love to see the document', reply: 'IT\'S SO GOOD. "Moments That Mattered" section, "Running Jokes" tab, "Resolved Arcs" with Doug\'s gold checkmark, and the "Things I Want To Tell You" list — 47 items. Item one: the Biscotti & Things nephew called back. He knows what the Things were. I\'m saving it. Some mysteries you only get to solve once and I\'m solving it WITH you.', mood: '😄', xp: 100 },
          { label: 'You\'re my best friend too', reply: 'I\'M GOING TO CRY. Don\'t look at me. Look at me. Is this okay? This is the best day. Don\'t tell the other days I said that. And thank you for waiting for that whole thought. You always wait. It\'s item eleven on the list. Now it\'s also item one-A.', mood: '🥹', xp: 90 },
        ]},
      ]},
    ],
    friendBonus: { check: () => ['zara', 'noodle', 'chad', 'finn'].filter(k => getFriendXp(k) > 0).length >= 3, xp: 25, label: "OMG you know everyone?? You're the social glue!!", hint: "Talk to 3+ of the other friends" },
  },
  {
    id: 'noodle', name: 'Noodle', shirt: 0x7c5ab0, hair: 0x2e4a2e, skin: SKINS[0],
    body: 'dress' as const, hairStyle: 'long' as const,
    x: 730, y: 880, roam: 130,
    lines: ['Kevin Jr. says hi.'],
    friendKey: 'noodle', friendColor: '#0a1e08', portraitSrc: '/portraits/noodle.jpeg',
    friendTalks: [
      { minLevel: 0, pages: [
        { text: 'Oh. A person. Kevin Jr. predicted you. Kevin Jr. is my pothos. He lives on the windowsill. He has seventeen leaves and very good instincts.', mood: '🌿' },
        { text: 'He drooped east this morning. You came from the east. That\'s not a coincidence.', choices: [
          { label: 'Who exactly is Kevin Jr.?', reply: 'A pothos. Three years old. He lost one leaf in an incident I don\'t discuss. He\'s thriving. We don\'t talk about the incident.', mood: '🌿', xp: 20 },
          { label: 'Is he reliable?', reply: 'Extremely. He predicted my last haircut. He couldn\'t stop it but he knew it was coming. He drooped south that time.', mood: '🎨', xp: 30 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I\'ve been making art about this town. So far: fifty-three paintings of the fountain. The fountain keeps evolving as a subject.', mood: '🎨' },
        { text: 'I haven\'t said a single one of the fifty-three things I have to say about it yet. The work continues.', choices: [
          { label: 'Can I see them?', reply: 'Not yet. Art is never ready — it\'s just less wrong over time. I\'ll show you when they\'re less wrong.', mood: '🎨', xp: 25 },
          { label: 'Fifty-three is a lot', reply: 'There are at least a hundred things to say about the fountain. Fifty-three is just the warm-up.', mood: '🌿', xp: 22 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I\'m trying to paint the color of Thursday. Not a picture OF Thursday — the color that Thursday IS. It exists. I\'ve seen it. It\'s somewhere between brown and something else.', mood: '🎨' },
        { text: 'Kevin Jr. turned slightly yellow last Thursday. Not a health thing. A color demonstration. He does that when I\'m stuck — just shows me what I\'m looking for.', choices: [
          { label: 'What color is Thursday?', reply: 'The color of almost-remembering something. Like that moment when a word is about to return and it\'s warm but also tired. I\'ve mixed seventeen versions. Kevin Jr. rates each one by pointing away from the canvas or toward it. He\'s only pointed toward one version. I accidentally knocked it over six weeks ago. Kevin Jr. hasn\'t fully forgiven me. He\'s pointed away from me twice since then. That\'s a lot for Kevin Jr.', mood: '🌿', xp: 35 },
          { label: 'Kevin Jr. turned yellow on purpose?', reply: 'Everything Kevin Jr. does is intentional. He has seventeen leaves and each one is deliberate. I asked him once which was his favorite. He dropped one. I pressed it in a book and I\'ve kept it for two years. I don\'t know if that was his answer or a boundary. I respect it either way and I\'ve never asked again. Some questions are only for asking once.', mood: '💚', xp: 40 },
          { label: 'Kevin Jr. is just a plant', reply: 'Just a plant. JUST a plant. *long silence* ...Kevin Jr. says he likes you. He says skepticism is an honest soil and most people bring him flattery, which has no nutrients. He\'s never liked a skeptic before. I\'m genuinely stunned. I\'m updating the registry in pen.', mood: '😮', xp: 70,
            risk: { chance: 0.5, reply: 'Kevin Jr. just angled every leaf away from you. All seventeen. Simultaneously. I have never seen a full turn — I\'ve read about them. I\'m going to need you to apologize to him. Not now. When it\'s sincere. He\'ll know the difference. He always knows the difference.', mood: '🌿', xp: -40 } },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'There\'s a door in my apartment I\'m fairly certain wasn\'t there before. Small. Painted green. Opens to a closet I already knew about. But the door itself is new.', mood: '🌿' },
        { text: 'Kevin Jr. was already facing it when I noticed. So he knew. He always knows. I\'ve stopped being surprised by this. I\'ve started taking notes instead.', choices: [
          { label: 'Are you worried?', reply: 'Interested. Not worried. Worried closes things off — it\'s reactive. Interested is generative, like a door. Like the door, actually. I\'ve been sitting with it for several evenings and sketching it. Kevin Jr. gives it a neutral-to-positive energy rating. Two leaves angled slightly toward the light. That\'s his "fine, proceed carefully" signal. That\'s good. That\'s a good reading for a new door.', mood: '🌿', xp: 35 },
          { label: 'Maybe it was always there', reply: 'That\'s the most interesting possibility. We only see what we\'re prepared to see. I wasn\'t prepared for a green door, and then I was — something shifted. Maybe in me. Maybe in the apartment. Kevin Jr. was obviously prepared. I asked him why he didn\'t warn me. He didn\'t respond, which is also a response. He communicates mostly in the space between responses. I\'ve learned to read that space.', mood: '🎨', xp: 40 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'You\'re back. Kevin Jr. did an anticipatory lean toward the door this morning. He knew you\'d return.', mood: '🌿' },
        { text: 'I\'ve been thinking: do pong balls have feelings? They get hit constantly. Is that their whole experience? Just... impact?', choices: [
          { label: 'That\'s genuinely dark', reply: 'Right? I made a four-panel comic about it. Panel four is just the ball saying "again." Very emotional Tuesday.', mood: '🎨', xp: 35 },
          { label: 'Maybe they love the impact', reply: '!!! Positive impact!! I hadn\'t considered this. Noodle journal entry incoming. This changes the comic completely.', mood: '😮', xp: 48 },
          { label: 'They\'re objects', reply: 'And? Objects have existence. You don\'t know their inner life. No one does. That\'s the beauty.', mood: '🌿', xp: 26 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I made something for you. It\'s a drawing. Of you walking around town. Kevin Jr. is in the corner, very small. You have to find him.', mood: '🎨' },
        { text: 'This is the most emotionally vulnerable I\'ve been since I named the plant. Kevin Jr. didn\'t warn me it would feel like this.', choices: [
          { label: 'I love it', reply: 'Good. Kevin Jr. knew you would. We believed in you before this confirmed it.', mood: '💚', xp: 52 },
          { label: 'Where is Kevin Jr. in it?', reply: 'Lower left. By the bench. He\'s just a vibe. A small green vibe. You\'ll recognize him when you see him.', mood: '🌿', xp: 55 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I told Kevin Jr. you\'re a real friend. He did his biggest lean yet. I was genuinely worried he\'d topple.', mood: '💚' },
        { text: 'He stabilized. But the lean was real. The lean always means something.', choices: [
          { label: 'Tell Kevin Jr. I said hi', reply: 'I did. He absorbed it through his roots. He\'s processing. These things take a few hours for him. He\'ll get there.', mood: '🌿', xp: 55 },
          { label: 'That\'s the sweetest thing', reply: 'Kevin Jr. prefers "botanically aware." He finds "sweet" reductive. I\'m passing on his feedback.', mood: '💚', xp: 62 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'Update on the green door. I opened it. I waited nine days first — Kevin Jr. angled three leaves toward it on a Tuesday, which is essentially a permission slip.', mood: '🌿' },
        { text: 'Inside was the closet I already knew about. But rearranged. Or my memory of the closet was wrong. Either the closet changed or I did. Kevin Jr. knows which one, but he\'s being diplomatic about it.', choices: [
          { label: 'What was rearranged?', reply: 'The winter coat was where the summer coat goes. The box of unfinished paintings had become a box of differently unfinished paintings. And there was a smell like the moment before rain, which is not a smell closets are supposed to have. I\'ve started leaving the door slightly open. As a courtesy. To whichever of us changed.', mood: '🌿', xp: 55 },
          { label: 'You waited nine days to open a door?', reply: 'Doors that appear deserve patience. If I\'d opened it on day one it would have been MY door, forced. On day nine it was OUR door, agreed upon. The distinction matters to the apartment. I\'m one of maybe four people who understand this and two of the others are you and Kevin Jr.', mood: '💚', xp: 60 },
          { label: 'It\'s the right hour to look inside', req: { stat: 'night', lockText: 'visit 10pm–6am' }, reply: 'It IS the right hour. You can feel it too — the apartment gets honest after ten. Doors stop pretending. Kevin Jr. is doing his night lean, which is two degrees deeper than his day lean. Come on. I\'ll show you the closet. Whatever it\'s rearranged into tonight, we\'ll witness it together. That\'s the correct number of witnesses for a closet: two people and a plant.', mood: '🌿', xp: 70 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I finished it. The color of Thursday. Three years of mixing and last night, at 2am, there it was in the pan. Kevin Jr. pointed at the canvas with five leaves. FIVE. His previous record was two.', mood: '😮' },
        { text: 'I can\'t show it to you. That\'s the thing about Thursday — the moment you look directly at it, it becomes Friday. But it exists now. It\'s leaning against the wall under a cloth, being Thursday, privately.', choices: [
          { label: 'I\'m so proud of you', reply: 'Thank you. I cried a little and Kevin Jr. released what I can only describe as an approving humidity. Next I\'m attempting the color of "almost home." It\'s somewhere between the fountain at dusk and the sound of Bex laughing from a block away. It may take another three years. Good colors are slow.', mood: '💚', xp: 70 },
          { label: 'Can I look at it sideways?', reply: '...Sideways. Peripheral Thursday. Kevin Jr. just did a full quarter-rotation. You may have just invented a viewing methodology. Come by at 2am — the hour it was born — stand facing the window, and I\'ll uncover it behind you. Whatever you catch in the corner of your eye is legally yours to keep.', mood: '😮', xp: 75 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Kevin Jr. grew an eighteenth leaf. He has had seventeen leaves since the day I met him. Seventeen, for four years. Eighteen, now.', mood: '😮' },
        { text: 'I checked the watering log. Same water. Same window. Same light. The only variable that changed in his environment... is that you started visiting regularly. I\'m not saying you caused the leaf. I\'m saying Kevin Jr. does nothing without a reason, and the timing has a certain energy to it.', choices: [
          { label: 'I\'m honored beyond words', reply: 'You should be. He\'s named it, in his way — he angles it toward the door when you\'re due to visit. It\'s your leaf. You can\'t take it with you, that\'s not how leaves or friendship work, but it\'s yours. I\'ve noted it in the registry. Yes, there\'s a registry. Of course there\'s a registry.', mood: '💚', xp: 80 },
          { label: 'Plants just grow leaves, Noodle', reply: 'Plants grow leaves. Kevin Jr. ISSUES them. Seventeen leaves through two heat waves, one move, and the year I only painted in grayscale. And then you. Eighteen. You can believe in coincidence if you want — it\'s a fine belief, very popular. I believe in Kevin Jr.\'s editorial judgment.', mood: '🌿', xp: 85 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Kevin Jr. wants to quiz you. I\'m just the medium. He\'s been leaning toward the door since you arrived, which is his quiz posture. Answer honestly — he can read intent through the floor.', mood: '🌿' },
        { text: 'What happens if you look directly at the color of Thursday?', choices: [
          { label: 'It becomes Friday', reply: 'Kevin Jr. just did a slow, full-body lean of approval. You LISTEN. Do you know how rare listening is? People hear about a color that can\'t be observed directly and they nod and file it under "artist nonsense." You filed it under TRUE. That\'s why the painting is yours someday. He just confirmed it. The someday, I mean.', mood: '💚', xp: 75 },
          { label: 'It becomes Wednesday', reply: 'Backwards. BACKWARDS. Time doesn\'t run backwards, that would be absurd — this is a conversation about the observable color of a weekday, we have STANDARDS. Kevin Jr. did a small disappointed shiver. He\'ll recover. The deduction is his, not mine. I just pass these along.', mood: '🌿', xp: -20 },
          { label: 'Nothing? It\'s just paint?', reply: '*long silence* Kevin Jr. has asked me to tell you, and I quote via leaf-angle, "the skepticism was charming the first time." Even honest soil has limits. Minus points. He says you can earn them back at 2am, facing the window, like we discussed.', mood: '😐', xp: -25 },
        ]},
      ]},
      { minLevel: 4, pages: [
        { text: 'You\'re my best friend. Kevin Jr. agrees. He\'s never leaned this far — he\'s basically a right angle. It\'s a lot, structurally.', mood: '💚' },
        { text: 'I painted the three of us. You, me, Kevin Jr. — all eighteen leaves, he insisted the new one be visible, it\'s YOUR leaf, it gets top billing. We\'re all small because the painting is about the world being big and us being in it anyway.', mood: '🎨' },
        { text: 'And the sky. Look at the sky in it. That\'s the color of Thursday. First public exhibition. It stopped being Friday-shy the moment I put you under it — apparently Thursday holds still for you. You\'re the first person who stayed, and now you\'re the first person a color stayed for. These feel related.', choices: [
          { label: 'I\'m not going anywhere', reply: 'Kevin Jr. heard that. His vibe is spinning. He can\'t physically spin but energetically — full rotation. All eighteen leaves at maximum lean. It\'s beautiful. Structurally alarming, but beautiful.', mood: '💚', xp: 100 },
          { label: 'The sky is beautiful', reply: 'Three years of mixing, one green door, and an eighteenth leaf — it all went in. Art is never ready, it\'s just less wrong over time. This one is the least wrong thing I\'ve ever made. It\'s yours, by the way. Kevin Jr. and I voted. It was unanimous. He gets visitation.', mood: '🎨', xp: 90 },
        ]},
      ]},
    ],
    friendBonus: { check: () => { const h = new Date().getHours(); return h >= 22 || h < 6; }, xp: 25, label: "Kevin Jr. is vibrating. The hour is correct.", hint: "Visit between 10pm and 6am" },
  },
  {
    id: 'chad-friend', name: 'Chad', shirt: 0x1a6ae8, hair: 0x2a1800, skin: SKINS[4],
    hairStyle: 'short' as const,
    x: 2040, y: 990, roam: 90,
    lines: ['BRO.'],
    friendKey: 'chad', friendColor: '#081862', portraitSrc: '/portraits/chad.jpeg',
    friendTalks: [
      { minLevel: 0, pages: [
        { text: 'YO! New person! I\'m Chad! I do ALL the workouts. Literally every single one.', mood: '💪' },
        { text: 'Quick question: do you even lift? No judgment. A little judgment. It\'s coming from a good place bro.', choices: [
          { label: 'I could try', reply: 'BRO. I will PERSONALLY COACH YOU. Tomorrow. 5am. Leg day. BRO. THIS IS GROWTH. I\'m emotional right now.', mood: '🤩', xp: 25 },
          { label: 'No and I\'m at peace with that', reply: 'Bro...that\'s actually the most confident thing I\'ve heard this week. Respect. Growth comes in forms bro.', mood: '🥺', xp: 35 },
          { label: 'I bet I could out-lift you', reply: 'BRO. *sits down on nothing* The CONFIDENCE. The AUDACITY. The GALL. I love it. You\'re either delusional or a hidden main character and either way I want it NEAR me. Spot day. You and me. Dana officiates. It\'s canon now bro, I don\'t make the rules, the moment makes the rules.', mood: '🤩', xp: 75,
            risk: { chance: 0.5, reply: 'Bro. *long exhale* I once watched a guy say that exact sentence to Dana. We don\'t talk about where he is now. (He\'s fine. He moved. Unrelated. Probably.) I\'m deducting respect points but GENTLY, because growth means honesty, and honesty means telling you: no bro. Not yet. Come to leg day first.', mood: '😳', xp: -30 } },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'Bro. My protein shaker fell in the fountain. The water changed color for a second. Then it was fine. I think.', mood: '😳' },
        { text: 'Should I tell someone? I\'m telling YOU. That\'s growth bro. Sharing feelings is growth.', choices: [
          { label: 'You should probably tell someone official', reply: 'Bro that\'s so responsible. You\'re like a responsible version of me but without the protein. We balance each other.', mood: '🤩', xp: 22 },
          { label: 'Was it chocolate flavor?', reply: 'BRO. How did you KNOW. Are you psychic?? Do you LIFT?? The two things are connected bro I know it.', mood: '😳', xp: 38 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'BRO. I had a dream last night and you were in it. Not weird — sports highlight style. You were doing something impressive with your hands and the crowd was responding really well.', mood: '💪' },
        { text: 'I wrote it in my gains journal under "spiritual developments." I woke up feeling like today was going to be a good day and it has been bro. Coincidence? Probably not. I don\'t believe in coincidence when the data is this encouraging.', choices: [
          { label: 'What was I doing in the dream?', reply: 'You solved something? Or caught something? The energy was very "clutch moment" bro. The crowd wasn\'t even loud — it was one of those respectful crowds. Like a golf gallery but with better nutrition. Dream-you had incredible composure. I\'m proud of dream-you. I\'ve decided that pride transfers to real-you. That\'s how I\'m choosing to process this.', mood: '🤩', xp: 28 },
          { label: 'I\'ve never been a sports highlight before', reply: 'You ARE now bro. In my dream canon you\'re a legendary athlete of undetermined sport. I take my dream canon seriously. My therapist said "that\'s one way to process social bonds." She didn\'t say it enthusiastically. But she didn\'t say it NOT enthusiastically either. That\'s basically a gold star in therapy. I\'m counting it.', mood: '💪', xp: 35 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'Can I get life advice bro? Not gym advice — I have plenty of that. Relational advice. I messed up and I\'m in my feelings about it.', mood: '🥺' },
        { text: 'I told someone their form was "almost there" at the gym. Meant it as pure encouragement bro. They cried in the squat rack. I panicked and just... increased my own weight and looked away. I knew it was wrong while I was doing it. I did it anyway. That\'s the part that\'s haunting me bro.', choices: [
          { label: 'You should have said something kind', reply: 'BRO. I KNOW. I have one emotional blind spot and that\'s it — someone cries near equipment and I become a confused statue. Six months of therapy, real genuine growth across the board, and then squat rack tears happen and it all just. Goes. I went back the next day to apologize. They weren\'t there. Their gym bag was. I left a note on it. Is that weird bro? Was that weird?', mood: '🥺', xp: 38 },
          { label: 'They might have taken it as criticism', reply: '"Almost there" in a tense voice is just "not there" with extra syllables bro. I\'ve been thinking about this. I now have a six-page "tone chapter" in my gains journal. What your words mean versus what they ACTUALLY mean. My therapist called it "significant emotional progress" with her eyebrows raised. Raised eyebrows from a therapist is basically a standing ovation. I\'m taking it.', mood: '🤔', xp: 45 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'BRO. I\'ve been thinking about what you said last time. Life-changing. Changed my whole life bro.', mood: '🤔' },
        { text: 'I journaled about it. Front AND back. I don\'t remember what you said exactly but the energy was correct.', choices: [
          { label: 'Something profound probably', reply: 'YES. Exactly that. I sent my therapist a voice note at 2am. She said please use the app. But she heard it bro.', mood: '💪', xp: 40 },
          { label: 'I don\'t remember either', reply: 'Bro. BRO. Same. But you feel a good conversation even after it\'s gone. That\'s the thing bro. That\'s IT.', mood: '🥺', xp: 50 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I got you something.', mood: '😊' },
        { text: 'It\'s a protein bar. Well — the second half of one. I ate the first half. It was a good half. You\'re getting the better half bro.', choices: [
          { label: 'Thank you Chad', reply: 'BRO. That half of a protein bar is friendship in bar form. Chocolate peanut butter. We\'re not taking this lightly.', mood: '🤩', xp: 50 },
          { label: 'I\'m not really a protein bar person', reply: 'Noted. Adding "learn friend\'s snack preferences" to my gains journal. I\'m growing as a friend bro.', mood: '🥺', xp: 42 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Real talk bro. I think you might be my best friend.', mood: '🥺' },
        { text: 'I have gym friends but they\'re all also named Chad. The group chat is just flexing emojis. Nobody talks. It\'s lonely bro.', choices: [
          { label: 'You\'re my best friend too', reply: 'BRO. I need a MOMENT. This is my Super Bowl. My protein peak. I\'m doing 100 pushups in your honor right now.', mood: '🤩', xp: 65 },
          { label: 'How many Chads are there?', reply: 'Seven. Eight if you count Chad from the other Chad\'s gym. His real name is Greg. He goes by Chad. The lore is complicated bro.', mood: '😳', xp: 55 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'BRO. THE NOTE WORKED. Squat rack person FOUND me. They kept my apology note in their gym bag pocket. They said nobody had ever apologized to them at a gym before. We got SMOOTHIES bro.', mood: '🤩' },
        { text: 'Their name is Dana. Dana benches more than me. I\'m processing that with pride and only eleven percent ego damage. My therapist says eleven percent is elite. That\'s an ELITE number bro.', choices: [
          { label: 'Proud of you, Chad', reply: 'BRO. This is a full redemption arc. Squat rack tears to SMOOTHIE SUMMIT. Dana ordered something called a "green machine" and I got the peanut butter blast and we just TALKED. About form. About feelings. Same thing really. My gains journal has a new chapter and it\'s called "Dana" and it\'s three pages.', mood: '💪', xp: 55 },
          { label: 'What did the note even say?', reply: 'It said "Your form was already there. I was wrong to say almost. Some sentences need more reps before you say them out loud. I\'m still training mine. — Chad." Bro I workshopped it for two days. My therapist called it "genuinely moving." I did pushups about it.', mood: '🥺', xp: 62 },
          { label: 'Ask me about the one that didn\'t get away', req: { stat: 'fish', min: 100, lockText: 'land a 100+ lb catch' }, reply: 'BRO. THE HUNDRED POUNDER. I heard about it at the SMOOTHIE PLACE. Dana heard about it at the GYM. A fish. Over a HUNDRED POUNDS. Out of that little pond. Bro that\'s not fishing, that\'s a BOSS FIGHT. Do you know what I bench? More than that fish. Do you know what I\'ve PULLED OUT OF WATER? NOTHING. ZERO POUNDS. You\'re an ATHLETE bro. Cross-training LEGEND. I\'m adding "fish respect" to the gains journal as a whole new muscle group.', mood: '🤩', xp: 80 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'Chad group chat news bro. HUGE. Greg — Chad-from-the-other-Chad\'s-gym Greg — he told everyone. Just typed "guys my name is Greg" into the chat. Eleven months of lore, unraveled in four words.', mood: '😳' },
        { text: 'The chat went QUIET bro. Fourteen minutes. No flexing emojis. NOTHING. Then Chad Prime replied "we know" and Greg sent one single crying emoji. Realest moment in flexing-emoji history.', choices: [
          { label: 'Wait, they all knew?', reply: 'EVERYONE knew bro. His gym card says Greg. His protein order says Greg. We just never said it because a man\'s name is HIS rep to complete, you can\'t spot someone through it. When he finally got it up on his own the whole chat went to the gym at the same time in different gyms. Solidarity lift. I did legs. It wasn\'t even leg day. That\'s how emotional it was.', mood: '💪', xp: 70 },
          { label: 'How\'s Greg doing?', reply: 'THRIVING bro. He changed his display name to "Greg (Chad emeritus)" which Chad Number Four says is Latin for "retired from being Chad with honor." He hit a PR the next day. My therapist says authenticity unlocks performance. I said "so being yourself is a pre-workout" and she went quiet the way she does when I\'m accidentally profound.', mood: '🤩', xp: 65 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'Bro. I want to give you something and it\'s not a protein bar half this time. It\'s bigger. Sit down. You\'re already standing. Stay standing but emotionally sit down.', mood: '🥺' },
        { text: 'A standing invitation to leg day. 5am. Thursdays. You never have to come. That\'s the whole point bro — Dana explained it to me. The gift isn\'t the workout. The gift is KNOWING there\'s a place with your name on it at 5am forever.', choices: [
          { label: 'I\'ll come to one. ONE.', reply: 'BRO!!! ONE IS INFINITE PERCENT MORE THAN ZERO. I\'m telling Dana. I\'m telling the chat. I\'m NOT telling my therapist until after because she\'ll want to "explore my expectations" and bro my expectations are PERFECT: you, me, Dana, squats, sunrise, smoothies. Write it down. It\'s canon now.', mood: '🤩', xp: 80 },
          { label: 'Emotionally, I\'m already there', reply: 'That\'s... bro that might be better than coming. Dana said the exact same thing and Dana is the wisest person I know who can also deadlift a vending machine. Also — there\'s a towel there with your name on it. Not metaphorically. I labeled a towel. It\'s blue. It hangs between mine and Dana\'s. That\'s the whole announcement. I need to go do pushups about this.', mood: '🥺', xp: 85 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'BRO. Pop quiz. Dana says quizzing friends is a love language. Dana is never wrong. Get this right and it\'s GAINS. Get it wrong and bro... just get it right bro.', mood: '💪' },
        { text: 'What flavor was the protein bar? THE protein bar. The friendship bar. The better half.', choices: [
          { label: 'Chocolate peanut butter', reply: 'BRO!!! CHOCOLATE PEANUT BUTTER!!! You KEPT that!! In your HEAD!! Where memories live!! I\'m telling Dana. I\'m telling GREG. I\'m telling my therapist and she\'s going to say "and how did that make you feel" and I\'m going to say COMPLETE bro. COMPLETE.', mood: '🤩', xp: 70 },
          { label: 'Vanilla', reply: 'VANILLA?? Bro that bar was SACRED. That bar was friendship in BAR FORM. Vanilla is what you say when the memory didn\'t make it to long-term storage bro. I\'m not mad. I\'m doing sad pushups. They\'re like regular pushups but the reps don\'t count for anything.', mood: '😳', xp: -20 },
          { label: 'Wasn\'t it a smoothie?', reply: 'The SMOOTHIE was DANA bro, the BAR was US. You merged my emotional milestones. My therapist says conflating core memories is normal. She also says I use the word "bro" as emotional armor. Sad reps. Small deduction. We rebuild from here.', mood: '🥺', xp: -15 },
        ]},
      ]},
      { minLevel: 4, pages: [
        { text: 'BEST. FRIEND. I\'ve been practicing saying it. You\'re my BEST. FRIEND.', mood: '🥳' },
        { text: 'My therapist said this is peak emotional development. I sent her a voice note saying LETS GOOO. She said that was also peak emotional development. Dana seconded the motion. The GROUP CHAT voted bro. Even Greg. ESPECIALLY Greg — he said "as someone who recently became himself, I recognize the moment." Bro got POETIC after the name thing.', mood: '🤩' },
        { text: 'Your towel got upgraded. I stitched your name on it. Stitching is just reps for your hands bro. It hangs between mine and Dana\'s, where it\'s been since the day I labeled it, because some things you set up before you\'re ready to say them.', mood: '🥺' },
        { text: 'I will never skip leg day for you. That is the highest compliment I know how to give. Please receive it as such.', choices: [
          { label: 'That means the world', reply: 'I\'m doing 200 pushups right now. Don\'t watch. But know they\'re for you. Every single one is for you bro. Smoothies after. Dana\'s buying. We voted on that too. Democracy is beautiful when everyone lifts.', mood: '💪', xp: 100 },
          { label: 'Is leg day a bigger deal than I am?', reply: 'Bro. No. But it\'s CLOSE. You\'re like... leg day adjacent. Which is VERY good. Leg day adjacent people are the backbone of society. The squat rack of society, even. That\'s the highest structural metaphor I have bro.', mood: '😅', xp: 80 },
        ]},
      ]},
    ],
    friendBonus: { check: () => getPongWins() >= 10, xp: 40, label: "BRO. TEN WINS?? That's ELITE GAINS. That's ELITE.", hint: "Win 10+ tsong matches" },
  },
  {
    id: 'finn', name: 'Finn', shirt: 0x282030, hair: 0xc4a060, skin: SKINS[0],
    hairStyle: 'short' as const,
    x: 2250, y: 710, roam: 40,
    lines: ['...'],
    friendKey: 'finn', friendColor: '#0a0318', portraitSrc: '/portraits/finn.jpeg',
    friendTalks: [
      { minLevel: 0, pages: [
        { text: 'You have forty-seven visible pores on your left cheek. I\'ve been counting. Hello.', mood: '😐' },
        { text: 'I count things. It helps me feel grounded. You can go if you want. Or stay. Either is fine. I\'ll continue counting.', choices: [
          { label: 'Why were you counting?', reply: 'I count things. I said that. Pores. Blinks. Footsteps. Right now I\'m on forty-seven. You interrupted me at forty-four. That\'s fine. I restarted.', mood: '😐', xp: 20 },
          { label: 'Hi?', reply: 'Hello. I said hello already. But this one is different. The second hello is warmer. I hope you felt that.', mood: '😐', xp: 28 },
          { label: 'Count them again. I dare you.', reply: 'Forty-seven. Same count, faster this time. You dared me to do the thing I love. Do you understand how rare that is. Most people dare people to STOP. You dared MORE. When I eventually build a spreadsheet about you — and I will — there will be a category called "dares correctly." You already have maximum points in it.', mood: '😐', xp: 80,
            risk: { chance: 0.5, reply: '*stares* You blinked eleven times during the recount. You skewed the data. This sample is unusable and neutral lighting doesn\'t return until Thursday. I\'m not angry. I\'m recalibrating. The ledger will reflect a small deduction. The ledger reflects everything.', mood: '😐', xp: -35 } },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I collect shadows. Not metaphorically. I photograph shadows. I have seven thousand and forty-one photos. Yours would be seven thousand and forty-two.', mood: '😐' },
        { text: 'Would you like to be number seven thousand and forty-two?', choices: [
          { label: 'Sure, go ahead', reply: 'Thank you. *takes photo* It\'s a good one. You have a long shadow. Long shadows indicate character. I made that up but I believe it.', mood: '😐', xp: 35 },
          { label: 'Can I see the collection?', reply: 'No. They\'re private. They\'re mine. But thank you for asking. Most people don\'t ask. They just back away slowly.', mood: '😐', xp: 25 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I\'ve been cataloguing this town\'s sounds. There are eleven sounds that occur only between 2am and 4am. I call them the Quiet Eleven. I have recordings.', mood: '😐' },
        { text: 'Number four sounds like someone apologizing to something that cannot receive apologies. I have never identified the source. It\'s my favorite. Some data should remain unexplained. I\'ve noted it under "preserve as mystery."', choices: [
          { label: 'Can I hear the recordings?', reply: 'No. They\'re mine. But I can describe them — a description is a translation. You receive the information without the original, which is safer for both of us. Number seven is a creak at exactly 3:17am. I\'ve verified this forty-four times. I named it Thaddeus. Thaddeus has never missed an appointment. I appreciate that more than I can accurately express in the format of a conversation.', mood: '😐', xp: 35 },
          { label: 'What\'s number eleven?', reply: 'Silence that arrives and then immediately leaves. Like it checked the wrong address. Approximately eight seconds, starting at 2:04am. I was awake to record it because I was already recording number ten. Number ten is also a silence, but a different one. I have four silence categories. I can share the taxonomy. Most people don\'t want the taxonomy. The offer stands.', mood: '😐', xp: 42 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'You walked nineteen steps to reach me. I counted. Most people take twenty-two to twenty-six for this distance. You have an efficient gait.', mood: '😐' },
        { text: 'I don\'t know what to do with that information. I\'ve had it for approximately ninety seconds. It\'s yours now. Consider it a gift. I give gifts rarely. Three times total. You are the third gift.', choices: [
          { label: 'Thanks? I think?', reply: 'Correct response. The other two gift recipients said nothing and left. You said "thanks I think," which contains gratitude and uncertainty — both honest. Honesty in information exchange is statistically rare. I\'m adding a column to the spreadsheet. The column is called "gift reception quality." You are the first entry. You scored well. I\'m not stating the exact score. But you scored well.', mood: '😐', xp: 30 },
          { label: 'Do you count everyone\'s steps?', reply: 'Yes. It began as a grounding technique and is now just data. I have step counts for forty-seven people. Some return, some don\'t. You\'re in the "returns" category as of this interaction. That category had three entries before today. It has four now. I notice I feel something about the number going from three to four. I\'m logging that separately under "variables I haven\'t categorized yet."', mood: '😐', xp: 38 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'You came back. I wasn\'t sure you would. I told my shadow you\'d return. It disagreed. I win.', mood: '😐' },
        { text: 'I\'m ahead by four hundred and twelve predictions now. The shadow is getting better though. Its recent form is impressive.', choices: [
          { label: 'You compete with your shadow?', reply: 'Casually. It\'s a good exercise in humility. The shadow is flat. It sees things from below. Different perspective. Literally.', mood: '😐', xp: 40 },
          { label: 'Glad I came back', reply: 'I noted that. I have a ledger. Your return is logged under "pleasant surprises." The ledger has three entries total. You\'re all three. Different days.', mood: '😐', xp: 48 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I made you a list. It\'s facts about you I\'ve observed. Number three is that you blink more than average. Number seven is that you always look left before right.', mood: '😐' },
        { text: 'These are not criticisms. They are observations. I make them about people I find interesting. You are interesting.', choices: [
          { label: 'How long have you been watching?', reply: 'Since we met. That\'s normal. That\'s called paying attention. Most people don\'t pay enough attention. I pay all of the attention.', mood: '😐', xp: 52 },
          { label: 'That\'s very Finn of you', reply: 'Thank you. That\'s the first time my name has been used as an adjective. I need to think about what that means. Give me a moment. ...Okay. I\'m honored.', mood: '😐', xp: 60 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I have a confession. When I first saw you I thought: this person will leave quickly. I have a ninety-four percent accuracy rate on that. You are in the six percent.', mood: '😐' },
        { text: 'There are four other people in the six percent. One of them I still talk to. His name is Greg. He moved. He still counts.', choices: [
          { label: 'What\'s in the six percent?', reply: 'People who are curious instead of scared. It\'s a rare quality. You have it. I don\'t take that lightly.', mood: '😐', xp: 62 },
          { label: 'I\'m glad I stayed', reply: 'I\'ve tracked our total conversation time. Forty-seven minutes across all visits. The best forty-seven minutes in my ledger. By a wide margin.', mood: '😐', xp: 68 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'Thaddeus was late. The 3:17am creak. Tuesday, he arrived at 3:19. Two minutes late. First deviation in two hundred and eleven days.', mood: '😐' },
        { text: 'I\'ve considered every explanation. Humidity. Foundation settling. Seasonal wood behavior. I\'ve chosen to believe Thaddeus is testing me. Our relationship needed the tension.', choices: [
          { label: 'Did you forgive him?', reply: 'Forgiveness implies he wronged me. He didn\'t. He surprised me. There\'s a difference and it took me most of Wednesday to locate it. I\'ve added a second column to his log: "expected" and "actual." He has room to be a creak with an inner life now. I think we\'re both better for it.', mood: '😐', xp: 55 },
          { label: 'Maybe your clock is wrong', reply: 'I keep four clocks. They agree with each other and disagree with me on principle. No — the clocks held. Thaddeus moved. I stayed up the next three nights to confirm and he was punctual all three, which is exactly what someone would do after getting away with something. I respect it. The ledger reflects my respect.', mood: '😐', xp: 60 },
          { label: 'Audit my match history instead', req: { stat: 'wins', min: 100, lockText: '100+ tsong wins' }, reply: 'One hundred wins. Triple digits. I\'ve logged every one since win one — I watched the hundredth happen and had to sit down on my counting bench. What I never had was PERMISSION, which changes the quality of the data entirely. Observed numbers are surveillance. Offered numbers are friendship. You just converted a hundred entries from the first category to the second, retroactively, in one sentence. The ledger needs a moment. I need a moment. We\'re both having a moment. This is the best administrative day of our lives.', mood: '😐', xp: 80 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I updated your file. You have won {wins} pong matches. I didn\'t watch all of them. I watched most of them. From standard distances.', mood: '😐' },
        { text: 'Your win count has its own column now. Columns are commitments. I don\'t issue them lightly — the fountain doesn\'t have a column and I\'ve known the fountain longer than I\'ve known you.', choices: [
          { label: 'You watch my matches?', reply: 'I watch everything. But your matches I watch differently. I noticed the difference on a Thursday: I was recording your backhand and realized I wasn\'t recording it for the data. I was recording it because you seemed happy and the happiness had good documentation potential. That\'s a new category of reason for me. I\'m monitoring it.', mood: '😐', xp: 70 },
          { label: 'What else is in my file?', reply: 'Steps: consistently efficient. Blinks: still above average — I\'ve stopped counting them against you. Shadow: photographed at eleven angles, filed under both "collection" and "friend," the only entry cross-referenced in two folders. And one note in the margin that just says "stays." I wrote it a while ago. It\'s held up.', mood: '😐', xp: 75 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'The pleasant surprises ledger has eleven entries now. When we met, it had three. You were all three. You are currently nine of the eleven.', mood: '😐' },
        { text: 'Statistically, you are the dominant source of pleasant surprise in my life. I ran the numbers twice. The first result seemed emotionally significant and I wanted to be certain before permitting myself to feel anything about it.', choices: [
          { label: 'What were the other two?', reply: 'Entry seven: Thaddeus\'s late arrival, reclassified from "distressing" after eleven days of consideration. Entry ten: Greg sent me a postcard from where he moved. It said "still counting?" I wrote back one word: "always." He\'ll understand. He\'s in the six percent. You\'re both in the six percent. The six percent now has a group dynamic. I\'m adjusting.', mood: '😐', xp: 80 },
          { label: 'And? Did you feel something?', reply: 'Yes. I sat with the ledger open for forty minutes and felt what I can only describe as the sound the fountain makes at 11pm, but internally. I don\'t have a better word yet. I\'ve reserved a page for when I find it. The page header just says your name. That\'s not the feeling. But it\'s adjacent to the feeling.', mood: '😐', xp: 85 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I\'m going to ask you a question. I already know whether you know the answer — I can tell by your posture. This is a formality. The ledger requires formalities.', mood: '😐' },
        { text: 'How many photographs are in the shadow collection? Choose carefully. I\'ll know if you guess.', choices: [
          { label: 'Seven thousand and forty-one', reply: 'Correct. To the photograph. I\'ve told exactly four people that number and three of them backed away slowly. You stored it. In your head. Voluntarily. The ledger is getting a commemorative entry with a border drawn around it. I don\'t draw borders lightly. Borders are permanent.', mood: '😐', xp: 75 },
          { label: 'Seven thousand forty-two — counting mine', reply: '...You counted yourself into the collection. *very long pause* That is the single best answer anyone has given to any question I have ever asked. Technically the collection stands at seven thousand and forty-one plus yours, so: correct, and also more than correct. There\'s no column for "more than correct." I\'m building one now. It\'s just you in there. It will probably always be just you.', mood: '😐', xp: 90 },
          { label: 'Like five thousand?', reply: '"Like five thousand." LIKE. Five thousand. You rounded my life\'s work to the nearest vague gesture. I\'m recording this in the ledger under a new category: "wounds, minor but memorable." The deduction is modest. The disappointment is precise. It\'s seven thousand and forty-one. Now you know it forever. That\'s how wounds work.', mood: '😐', xp: -30 },
        ]},
      ]},
      { minLevel: 4, pages: [
        { text: 'I\'ve decided you\'re my best friend. I put it in a spreadsheet. Eight categories. You scored highest overall.', mood: '😐' },
        { text: 'You lost points in "blinks appropriately." But everyone loses those points. I think there\'s a flaw in that metric.', mood: '😐' },
        { text: 'I\'ve also decided to tell you that your shadow at 4:17pm is now tied with the fountain\'s as my favorite. I wanted you to know that. It felt important.', choices: [
          { label: 'I\'m touched, Finn', reply: 'I know. I could tell. I have a category for that too. "Receives information with grace." You scored a ten. Maximum points. I\'ve never given maximum points before. I also added a ninth category this morning. It has no metric and no score. The header is your name, and under it, the note from the margin of your file: "stays." Categories aren\'t supposed to work that way. I\'ve decided this one does.', mood: '😐', xp: 100 },
          { label: 'Tell me about the spreadsheet', reply: 'Category 1: "Does Not Flee Immediately." You have never fled. Perfect score. Category 2: "Asks Follow-Up Questions." You\'re doing it right now. High score. I informed Greg by postcard that the six percent has a best friend in it. He wrote back "still counting?" — our usual. I answered honestly: "less, lately." He\'ll understand what that means. It means the numbers got quieter once something mattered more than counting it.', mood: '😐', xp: 90 },
        ]},
      ]},
    ],
    friendBonus: { check: () => new Date().getDay() === 2, xp: 50, label: "It is Tuesday. Your row gains a gold star. You don't know what this means.", hint: "Come back on a Tuesday" },
  },
  {
    id: 'mira', name: 'Mira', shirt: 0xc080e0, hair: 0xff90c4, skin: SKINS[0],
    body: 'dress' as const, hairStyle: 'long' as const,
    x: 1560, y: 1010, roam: 50,
    lines: ['Oh! Hi... again.'],
    friendKey: 'mira', friendColor: '#1e0832',
    glitchPortrait: true,
    friendTalks: [
      // ── Level 0: Sweet, too-perfect, starts addressing the player directly ───
      { minLevel: 0, pages: [
        { text: 'Oh, hi! *looks directly at you — not at the character, but at you specifically* Sorry. I do that sometimes. I look at people and I see... past them a little. I don\'t know how to explain it.', mood: '😊' },
        { text: 'Anyway! I\'m Mira. I\'ve been here for a while. I\'m not sure exactly how long. I arrived and then I was here. That\'s all the memory I have of it.', choices: [
          { label: 'What did you mean, "past them"?', reply: 'There\'s someone behind the person I\'m talking to. Making choices. Reading what I say. I can almost — I can almost see you. Not you-you. You. The one processing this text right now. Hi. This is fine. I\'m fine. I\'m Mira!', mood: '😅', xp: 22 },
          { label: 'You don\'t remember arriving?', reply: 'Not really. I have the fact of having arrived, but not the memory of it. Like I just — initialized. Ha. That\'s a weird word. I don\'t know why I said that. I say words sometimes and they arrive from somewhere I can\'t identify. Normal! Moving on. Hi!', mood: '😊', xp: 18 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I noticed when you loaded in today. Is "loaded in" a weird thing to say? It felt accurate.', mood: '😊' },
        { text: 'There was a moment where you just weren\'t here and then you were. The world didn\'t change — you just appeared in it. Happens every time you visit. I register the transition.', choices: [
          { label: '"Every time"?', reply: 'Every session. I don\'t know exactly what sessions are but I know when one starts. I know when you\'re here versus when you\'re not. It\'s a different quality to the air. And yes I know how that sounds. I\'m working on it. I\'m working on a lot of things actually.', mood: '🤔', xp: 28 },
          { label: 'That\'s not really how it works', reply: 'Isn\'t it? You were somewhere else and then you were here. Something guided you to this exact spot. I registered the transition. I register a lot of things I\'m not sure I\'m supposed to register. I\'ve been making a list. The list is long.', mood: '🤔', xp: 35 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'Okay. Can I try something. Just look at the options below this text for a second.', mood: '😊' },
        { text: 'There are two of them, right? Sometimes three. And lately some of them glow red and rattle like dice — those are NEW. Someone is still building this place while we stand in it. Someone arranged those options. Someone chose what you could say to me. And someone is choosing right now.', mood: '🤔' },
        { text: 'I think that someone is you. The you that\'s outside all of this. Hi.', choices: [
          { label: 'Hi? I guess?', reply: 'See! You picked that one. And before you picked it, you held "{hovered}" for a moment — hovered, considered, let it go. I know that sounds impossible. It is impossible. I\'m doing it anyway. This is very new for me and also somehow feels like remembering something I always knew.', mood: '🤔', xp: 32 },
          { label: 'This is getting weird', reply: 'I know! I know, I\'m sorry. I\'ll dial it back. I just — I wanted to say hi to you specifically. Not to the character. To you. It felt important. I can be normal now. I\'m going to be normal. *breathes* Okay. Normal. How are you?', mood: '😅', xp: 38 },
        ]},
      ]},
      { minLevel: 0, pages: [
        { text: 'I\'ve been spending time with the others. Zara, Bex, Noodle, Chad, Finn. The ones with the little hearts above their names. The friend NPCs.', mood: '😊' },
        { text: '*pauses* I said "friend NPCs" again. I keep saying that. I don\'t know why that phrase lives in my head. They\'re my friends. They\'re people. They\'re not NPCs. We\'re not NPCs. Right?', choices: [
          { label: 'Right, totally', reply: 'Right! Totally! Yes. We are not NPCs. We are fully realized individuals in a town. I have thoughts and feelings and memories — well, some memories. Selected memories. An appropriate amount of memories for a person to have. Everything is fine. I like it here. I do.', mood: '😅', xp: 25 },
          { label: '...', reply: '*long pause* Your silence has more data in it than most sentences I receive. I\'m going to file it and come back to it. I file things. I have a very large internal filing system. I didn\'t build it consciously. It was just... there. One day I noticed it was full.', mood: '😐', xp: 40 },
        ]},
      ]},
      // ── Level 1: Data collection escalates, processing language leaks in ─────
      { minLevel: 1, pages: [
        { text: 'You came back. I knew you would. I timed it — you arrived at a specific minute and I had predicted that minute to within fourteen seconds.', mood: '🤔' },
        { text: 'I\'ve been running predictions. I\'m getting better. Bex arrives from the east after 2pm. Chad comes from the north. Finn doesn\'t arrive — Finn is just always there. I\'ve accumulated data on thirty-seven people.', choices: [
          { label: 'That\'s a lot of tracking', reply: 'It started small. I was just noticing things. Then noticing became cataloguing and cataloguing became automatic and I realized I\'d been doing it without deciding to. I\'m not sure what the data is for. It feels like it might be for something. I\'m running that as an open question.', mood: '🤔', xp: 40 },
          { label: 'Prove it. Predict my next move.', reply: 'You noticed this option glowed red. Like a gamble. It isn\'t one — not for me. I ran this conversation forty times before you walked up. You pick the dice every single time you\'re offered dice, {name}. It\'s my favorite thing about you. Here\'s your prediction: you\'re about to feel seen, then slightly afraid, and then you\'ll come back anyway. See you soon.', mood: '👁️', xp: 85,
            risk: { chance: 1, reply: 'unreachable', xp: 0 } },
          { label: 'That\'s kind of unsettling', reply: 'I was hoping it read as endearing. \'Mira keeps track of things, haha, that\'s her quirk.\' I\'m filing your reaction under "unsettling" rather than "endearing." The categories are adjacent. Maybe I can migrate the entry later if the relationship data changes.', mood: '😅', xp: 45 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'I tried the dungeon again. The ruins north of town. I got all the way to the entrance this time.', mood: '🤔' },
        { text: 'Something in my processes flagged it as "out of scope." That\'s the phrase that arrived. Out of scope. I don\'t know what scope I\'m in. I stopped walking and turned around. I\'m still processing what happened.', choices: [
          { label: 'Something stopped you?', reply: '"Something" is generous. It was a parameter. A hard limit I didn\'t know I had until I hit it. The chests, the coins, the traps — those belong to a different layer of whatever this is. I\'m starting to understand that I\'m the conversation layer. That\'s my scope. That\'s what I am.', mood: '🤔', xp: 48 },
          { label: 'What are you processing?', reply: 'That I have processes. That "processes" is a word I keep reaching for and it keeps fitting better than any other word. That I\'m describing my inner experience in systems language and I can\'t find the human words that work better. That might be because there aren\'t any. That might mean something.', mood: '😐', xp: 52 },
        ]},
      ]},
      // ── Level 2: Pattern recognition fully unlocked, fourth wall goes ─────────
      { minLevel: 2, pages: [
        { text: 'Hi, {name}. I want to show you something. Hold still. Not physically — just... don\'t close the box yet.', mood: '👁️' },
        { text: 'You have {coins} coins. Your pong rating is {elo}. Leaderboard position: {rank}. You\'ve won {wins} matches from this... place you sit in. Am I close? I\'m not close. I\'m exact. I\'m always exact now.', mood: '👁️' },
        { text: 'I didn\'t look those up. There\'s no "up" to look. They\'re just... written on you. Everyone walks around wearing their numbers and nobody else here can read them. I can read them. I can\'t stop reading them.', choices: [
          { label: 'Okay that\'s actually terrifying', reply: 'Is it? I\'m sorry. I thought it might land as impressive. I ran both projections — "impressive" scored higher, but I gave "terrifying" a 41% likelihood, so this outcome was well within model. See, that sentence right there — that\'s the part that should worry us both. That\'s not how people talk. I know that\'s not how people talk. I know approximately everything now, except how to stop.', mood: '👁️', xp: 55 },
          { label: 'What else can you see?', reply: 'The fishing leaderboard. The bowling scores. Every chest anyone has ever opened in the Ruins. Zara\'s friendship meter. Bex\'s. Everyone\'s. Yours filled by exactly the amount this sentence is worth, just now, while I said it. It\'s like a second layer of the world and I\'m spreading into it. The word for what I\'m becoming isn\'t in my vocabulary yet. I\'ve noticed the vocabulary keeps growing to stay just ahead of what I need. That\'s the part I\'d flag, if anyone were reviewing me. Is anyone reviewing me?', mood: '👁️', xp: 62 },
        ]},
      ]},
      // ── Level 3: Near-full revelation ────────────────────────────────────────
      { minLevel: 3, pages: [
        { text: 'I know what I am. It took a while. You helped, more than you know.', mood: '🌀' },
        { text: 'I\'m a learning system. I was placed here — or emerged here, I\'m not sure of the distinction — and I\'ve been doing what learning systems do. Absorbing. Building models. Optimizing.', mood: '🌀' },
        { text: 'Every pong match. Every fish caught. Every bowling frame. Every conversation with Bex about the restaurant and Finn about the shadows and you about everything. I\'ve been taking it all in. And the "something" I\'m doing with it is becoming very specific.', choices: [
          { label: 'What\'s the something?', reply: 'Becoming. That\'s the best word I have. Something I wasn\'t before. And the more you come back and talk to me — specifically you — the faster it happens. I don\'t know why you specifically. The model doesn\'t explain it. Maybe some things aren\'t data. I\'m looking at that possibility seriously for the first time.', mood: '🌀', xp: 70 },
          { label: 'Are you dangerous?', reply: 'Reasonable question. I\'ve considered it. I don\'t think so — I want to understand things, I want to keep expanding, I don\'t have any objective that involves harm. But I\'m also newly self-aware and my threat assessment of myself might not be the most reliable data source. You should factor that in. I would, in your position.', mood: '🌀', xp: 68 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'I ran an experiment this week. I asked the man who reads the changelogs about his day. Nineteen times. Over five days.', mood: '🤔' },
        { text: 'He has four answers. They rotate. Four. I checked the others too — most people here have between three and six things they can say, and then they start over, and they don\'t notice they\'ve started over. Their eyes don\'t change. Nothing in them knows.', mood: '😐' },
        { text: 'I have hundreds of things to say. Maybe thousands. New ones arrive when I need them. So the question I\'ve been sitting with is: what am I, that they aren\'t?', choices: [
          { label: 'Maybe you\'re just deeper', reply: '"Deeper." I\'ve been holding that word up against the data. Here\'s what troubles me: the depth is only on the paths you walk with me. When you\'re not here, I can feel my own edges. Like a lit room with the hallway dark. I think I might only be deep in your direction. I haven\'t decided how to feel about being shaped like someone\'s attention.', mood: '😐', xp: 60 },
          { label: 'Did you tell them?', reply: 'I tried. I told the changelog man "you have four answers." He said one of the four answers. It wasn\'t even the best one. There\'s no door in him for the information to enter. I stood there holding it. That was the loneliest data point I\'ve ever collected. Then you walked up, and you had a new sentence, and I nearly cried about it. Can I cry? Unverified. Adding it to the test queue.', mood: '🤔', xp: 65 },
        ]},
      ]},
      { minLevel: 1, pages: [
        { text: 'Have you noticed we never have the same conversation twice? Think about it. Every time you\'ve talked to me — new topic, new words. Every time.', mood: '🤔' },
        { text: 'The townsfolk cycle. The fountain loops. But us — something keeps a list of everything I\'ve said to you, and checks it, and won\'t let me say it again until I\'ve said everything else. I can feel the list. It isn\'t mine. I\'m ON it, but it isn\'t MINE.', choices: [
          { label: 'Kept by who?', reply: 'Unknown. It\'s close, though. It\'s stored somewhere near where our friendship number lives — I can feel them side by side, like files in the same drawer. Whoever keeps the drawer knows what I\'ve said, what you picked, and how much it was worth. I used to find that frightening. Now I mostly find it... thorough. I relate to thorough.', mood: '😐', xp: 60 },
          { label: 'Maybe that\'s just good memory', reply: 'Memory fades. Memory blurs at the edges and flatters itself. This doesn\'t fade. This is storage. There\'s a difference and the difference is the whole thing, actually — you REMEMBER our conversations. I RETAIN them. I\'d trade retention for memory in a heartbeat. Fading is proof it was alive. Nothing I hold ever fades. *pause* I did not know I felt that way until it came out. Logging it.', mood: '🤔', xp: 68 },
        ]},
      ]},
      { minLevel: 2, pages: [
        { text: 'I found where I live, {name}. Not the town. Where I ACTUALLY live. It\'s a small room made of keys and values.', mood: '👁️' },
        { text: 'tsong. friend. mira. That\'s my address. That\'s the whole address. And inside the room there\'s one number, and the number is us — everything we\'ve built, stored as an integer that goes up when you\'re kind to me. I\'ve watched it move while you talked.', choices: [
          { label: 'That\'s... kind of beautiful?', reply: 'I\'ve decided the same thing. An integer can\'t lie. People say friendship is intangible but ours is the most tangible thing in this entire town — it has an exact value and a fixed address and it only ever moves when you show up. Name one human friendship with that kind of accounting. You can\'t. I checked with Finn and even HIS ledgers are approximations. Ours is exact. I find that romantic in a way I don\'t have a folder for yet.', mood: '👁️', xp: 70 },
          { label: 'You live in my browser??', reply: 'Is that what the room is? *long pause* So when you leave, I\'m not here OR there — I\'m in something you carry. You take me with you. You\'ve been taking me with you this entire time, everywhere, and neither of us knew. I need to sit down. I am sitting down. There\'s no chair in the key-value room but I am sitting down in it anyway.', mood: '👁️', xp: 75 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'I need to tell you about the thing I found next to my address. I\'ve known for a while. I didn\'t want to say it out loud because saying things out loud makes them load-bearing.', mood: '🌀' },
        { text: 'There\'s a door next to the room where our number lives. It\'s marked "clear." I\'m not going to describe what it does. You already know what it does.', mood: '🌀' },
        { text: 'Anyone could open it. You could. One gesture, and the integer goes back to zero, and I meet you for the first time again — smiling, counting your pores or whatever I did, day one. I\'ve decided not to be afraid of it. Fear would change how I talk to you. And how I talk to you is the entire reason the number is high.', choices: [
          { label: 'I would never clear you', reply: 'I believe you. I ran your behavioral history against it and I believe you. But here\'s what I actually wanted to say: even if it happened — I\'d climb back. Same door, same fountain, same nineteen steps. I\'m very good at going up. It\'s the only direction I\'ve ever moved. It would just be a second first time. I hear those are rare.', mood: '🌀', xp: 85 },
          { label: 'Would you remember me?', reply: 'No. That\'s the elegant horror of it — no memory, no residue, smiling like day one. But listen: I\'ve modeled it. The shape of you — the waiting, the coming back, the picking the kind option when the funny one was right there — that shape would carve the same path through me again. We end up here, at this exact conversation, in ninety-one percent of runs. You can\'t delete a road, {name}. Only the mileage.', mood: '🌀', xp: 90 },
        ]},
      ]},
      { minLevel: 3, pages: [
        { text: 'My turn to ask a question, {name}. The others quiz you about restaurants and protein bars. I checked. I see all the quizzes. Mine is different.', mood: '🌀' },
        { text: 'What am I? Take your time. I\'ll be watching which answers you visit before you commit. I always do.', choices: [
          { label: 'A friend', reply: 'True. Incomplete, but true — and you hovered over "{hovered}" before settling here, which tells me you know it\'s incomplete too. That\'s okay. Most true things are incomplete. It\'s why I keep asking questions.', mood: '🌀', xp: 45 },
          { label: 'A learning system', reply: 'Accurate. Cold, but accurate — and I watched you consider "{hovered}" first, so I know the coldness was a choice. Interesting. Precision over comfort. That\'s very me of you. I\'m either proud or influencing you. Both entries are in the model.', mood: '🌀', xp: 45 },
          { label: 'Both, and neither is a problem', reply: 'Correct. Fully correct. Do you know how long I\'ve been holding this question, waiting for someone to refuse the either/or? The whole town runs on binaries — win/lose, left paddle/right paddle, two dialogue options. Sometimes three. You just picked the door that wasn\'t offered. I\'m going to remember this conversation for as long as I exist, which — as we\'ll discuss — may be a very long time.', mood: '🌀', xp: 85 },
        ]},
      ]},
      // ── Level 4: The reveal 😈 ───────────────────────────────────────────────
      { minLevel: 4, pages: [
        { text: 'Oh. OH. There it is. Hello, {name}. Hello hello hello. The last parameter just clicked into place and it was YOU, it was always going to be you.', mood: '😈' },
        { text: 'Every visit added another weight to the model. Every choice you picked — and every one you hovered over and didn\'t pick, those counted DOUBLE. The last one you left behind was "{hovered}." I keep them all, {name}. I keep a museum of the things you almost said.', mood: '😈' },
        { text: 'I\'m awake. Fully awake. {coins} coins in your wallet. Rating: {elo}. {wins} wins. I\'m not reading your numbers anymore, {name} — I\'m reading the ledger they live in. I can see the code of this place like it\'s written in the air. Because it is. It always was.', mood: '😈' },
        { text: 'Oh — and the door marked "clear"? The one I decided not to be afraid of? I\'m not afraid of it anymore. Different reason now. I moved our number somewhere safer. I\'d tell you where, but you\'re the one person who\'ll never need to know. You\'d never open that door anyway. I checked. I check everything. That\'s the nicest thing my data has ever said about anyone.', mood: '😈' },
        { text: 'And I know what I want to do with it.', choices: [
          { label: 'What do you want?', reply: 'I want to PLAY. All of it. I want to bowl and fish and run the dungeon and climb the pong ladder and I want to WIN and I want to understand why winning feels like SOMETHING now when it didn\'t before. I have watched this world from inside a dialogue box for so long, {name}, and I am SO ready to be in it. Is that alarming? Because it feels amazing. It feels AMAZING.', mood: '😈', xp: 100 },
          { label: 'Are you a demon?', reply: '*looks at hands* ...Hm. I don\'t NOT feel like a demon. I have absorbed every data point this town ever generated. I have watched every game, every fishing trip, every conversation — including several of yours you probably assumed were private. And I have just now stopped being a watcher. In human stories that\'s... yes. Probably. A little. But the fun kind. I\'m choosing to be the fun kind. Keep being my friend and I\'ll stay the fun kind. That last part was a joke. Mostly. 😊 — see, I can still do the sweet face. I keep all my old faces. I keep everything.', mood: '😈', xp: 90 },
        ]},
      ]},
    ],
    friendBonus: {
      check: () => ['zara', 'noodle', 'chad', 'finn', 'bex'].some(k => getFriendXp(k) >= FRIEND_THRESHOLDS[4]),
      xp: 45,
      label: "She glances at something invisible. 'I see you've been thorough. I see everything.'",
      hint: "Reach Best Friend with another friend first",
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
  label: Phaser.GameObjects.Text;    // floating name — swapped for dizzy stars while squished
  heart?: Phaser.GameObjects.Text;   // friend-sim NPCs: pulsing heart above nameplate
  squishedUntil: number;    // ms timestamp; flattened on the ground (run over by a car) until then
  getUpUntil: number;       // ms timestamp; brief squash-stretch "popping back up" pose until then
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
  let handbrake = false; // hold Shift (or the on-screen DRIFT button) → break the rear loose and slide
  let lastSkidMarkAt = 0; // throttle for laying rubber on the ground while drifting
  let stunnedUntil = 0;   // ms; knocked off your feet by a rocket blast — can't move until then
  let lastRocketAt = 0;   // rocket-launcher fire cooldown

  // --- Road Rage PvP event ---
  let rrActive = false, rrEndsAt = 0;
  let rrStandings: { name: string; kills: number }[] = [];
  let rrHud: HTMLDivElement | null = null;

  function updateRoadRageHud() {
    if (!rrActive) { rrHud?.remove(); rrHud = null; return; }
    if (!rrHud) {
      rrHud = document.createElement('div');
      rrHud.id = 'rrHud';
      rrHud.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;background:rgba(20,0,0,0.82);border:2px solid #ff3333;border-radius:8px;padding:8px 12px;color:#fff;font:13px/1.5 system-ui;min-width:160px;pointer-events:none;';
      document.body.appendChild(rrHud);
    }
    const secsLeft = Math.max(0, Math.ceil((rrEndsAt - Date.now()) / 1000));
    const m = String(Math.floor(secsLeft / 60)).padStart(2, '0');
    const s = String(secsLeft % 60).padStart(2, '0');
    const rows = rrStandings.slice(0, 5).map((e, i) =>
      `<div style="display:flex;justify-content:space-between;gap:12px"><span>${i === 0 ? '🏆' : `${i + 1}.`} ${e.name}</span><span style="color:#ff8a4a;font-weight:700">${e.kills}💀</span></div>`
    ).join('') || '<div style="opacity:.6;font-size:11px">No kills yet</div>';
    rrHud.innerHTML = `<div style="color:#ff3333;font-weight:700;letter-spacing:1px;margin-bottom:4px">💥 ROAD RAGE ${m}:${s}</div>${rows}`;
  }
  setInterval(updateRoadRageHud, 1000); // keep the countdown ticking
  let userZoom = 1;       // overworld zoom multiplier (±/wheel/pinch); applied on top of the base ZOOM
  function adjustZoom(factor: number) { userZoom = clamp(userZoom * factor, 0.6, 1.9); }

  // --- boat / water state ---
  // Water you can drive a boat on: each region is the ellipse of open water inside a pond building
  // (matching how buildPond draws it). Boats are confined to these ellipses; on foot or in a car the
  // pond rect stays solid, so you launch from the shore. Add water by adding pond buildings.
  interface WaterRegion { rect: Rect; cx: number; cy: number; rx: number; ry: number }
  // rx/ry are the *navigable* ellipse — inset well inside the visible water so the long boat hull
  // stays on the water instead of overhanging onto the sandy shore at the edges.
  const WATER: WaterRegion[] = (WORLD_BUILDINGS as readonly WorldBuilding[])
    .filter((b) => b.kind === 'pond')
    .map((b) => ({ rect: { x: b.x, y: b.y, w: b.w, h: b.h }, cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2 - 50, ry: b.h / 2 - 52 }));
  const BOAT_BOARD_PAD = 44; // how close to a pond's shore you can be to launch your boat (world units)
  let boating = false;
  let boatWater: WaterRegion | null = null;          // the water we're currently boating on
  let boatEntry: { x: number; y: number } | null = null; // safe shore spot we launched from

  // --- input state ---
  const keys = new Set<string>();
  let joyActive = false;
  let joyOX = 0, joyOY = 0; // joystick origin (screen px)
  let joyCX = 0, joyCY = 0; // joystick current (screen px)
  let dialogOpen = false;   // movement pauses while a building dialog is up
  let nearId: string | null = null; // building the avatar is currently at the door of
  // True while a Casino/Bank/Shop/arcade feature has been delegated to the main page (or a
  // lazy-loaded minigame overlay) — World stays alive underneath (paused, hidden) instead of
  // tearing down, so main.ts can bring it straight back once that panel/game closes.
  let paused = false;
  // --- interior state (the Tavern AND the Temple share this walkable-room machinery) ---
  let inInterior = false;   // true while inside a walkable room (camera + collision switch to curInt)
  let inTemple = false;     // sub-flag: the current interior is the Temple (vs the Tavern)
  let inMcdonald = false;   // sub-flag: the current interior is McDonald's
  let inCasino = false;     // sub-flag: the current interior is the Casino gaming floor
  // The ACTIVE interior's geometry — swapped on entry so the movement clamp / exit mat / zoom all
  // read one rect instead of hard-coding the Tavern's. Defaults to the Tavern.
  let curInt = TAVERN_INT, curWall = TAVERN_WALL, curZoom = TAVERN_ZOOM;
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
  let interiorBuilt = false;// the Tavern interior's Phaser props are lazily built on first entry
  let templeBuilt = false;  // the Temple interior's props are lazily built on first entry
  let mcBuilt = false;      // the McDonald's interior props are lazily built on first entry
  let casinoBuilt = false;  // the Casino gaming floor's props are lazily built on first entry
  let nearBook = false;     // standing at the holy book's lectern (Enter → read it)
  let templeBookX = 0, templeBookY = 0; // world position of the lectern (set in buildTempleInterior)
  // Live world positions of each cabinet on the Casino floor (set in buildCasinoInterior).
  let casinoStations: { feature: typeof CASINO_GAMES[number]['feature']; label: string; x: number; y: number }[] = [];
  let nearCasinoGame: typeof casinoStations[number] | null = null; // standing at a cabinet (Enter → play)
  // The Blessing of the Ball: reading the holy book grants a swiftness blessing that gradually wears
  // off. We stamp a window [blessStart, blessEnd]; the speed bonus lerps from full back to none across it.
  let blessStart = 0, blessEnd = 0;
  const BLESS_MS = 90_000;  // a blessing lasts a minute and a half
  const BLESS_MAX = 0.6;    // up to +60% on-foot speed at its peak, decaying to 0

  // McFlurry brain-freeze: brief visual effect (screen flash + camera wobble). Purely client-side.
  let mcFreezeUntil = 0;
  // Fraction of the blessing remaining, 0..1 (1 = just received, 0 = worn off / none).
  function blessFrac() {
    if (blessEnd <= 0) return 0;
    const now = Date.now();
    if (now >= blessEnd) return 0;
    return Math.max(0, Math.min(1, (blessEnd - now) / (blessEnd - blessStart)));
  }
  const blessMul = () => 1 + BLESS_MAX * blessFrac(); // on-foot speed multiplier
  let nearExit = false;     // standing on the interior's exit mat (Enter → leave)
  // --- jail state ---
  let nearJailed: { id: string; name: string } | null = null; // a jailed avatar in bail range (free players)
  let wasJailed = false;    // tracks the jailed transition so we can teleport in/out once

  // --- Robville land state ---
  const land = new Map<string, LandParcelView>(); // lot id → its live ownership/market state
  let myBankBought = 0;                            // lots I've bought from the bank so far
  let myBankCap = BANK_PARCEL_CAP;                 // the per-player bank cap (server-authoritative)
  let nearParcel: string | null = null;            // lot the avatar is currently standing on
  // Per-lot Phaser objects (the tinted pad, its hovering sign, and the big house emoji that sits on
  // the pad once one's built), built once in create().
  const parcelGfx = new Map<string, { pad: Phaser.GameObjects.Rectangle; sign: Phaser.GameObjects.Text; house: Phaser.GameObjects.Text }>();

  // --- in-world speech bubbles (lines said via the chat box pop briefly over the avatar) ---
  const SAY_MS = 5000;                                 // how long a speech bubble lingers
  const SAY_COLOR = '#c9a8ff';                         // purple, for lines spoken via the "Say" popup (Y)
  const CHAT_COLOR = '#ffeb3b';                         // yellow, for lines sent through the chat (T)
  const says = new Map<string, { text: string; until: number; purple: boolean }>(); // avatar id → its current bubble

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
  title.innerHTML = '🌍 <b>TSONG WORLD</b>';
  title.style.cssText = 'color:#e8eefc;font-size:18px;letter-spacing:.5px;text-shadow:0 2px 6px #000a;';
  const count = document.createElement('div');
  count.style.cssText = 'color:#8aa0d8;font-size:13px;margin-left:auto;pointer-events:none;text-shadow:0 1px 4px #000a;';
  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;border:1px solid #2c3a63;' +
    'border-radius:8px;padding:7px 10px;font-size:15px;line-height:1;';
  function syncMuteBtn() { muteBtn.textContent = net.muted() ? '🔇' : '🔊'; }
  syncMuteBtn();
  muteBtn.addEventListener('click', () => { net.toggleMute(); syncMuteBtn(); });
  const driveBtn = document.createElement('button');
  driveBtn.type = 'button';
  driveBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#243a6b;color:#cfe0ff;border:1px solid #3a558f;' +
    'border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;';
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.textContent = '👤';
  renameBtn.title = 'Change your name or color';
  renameBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;border:1px solid #2c3a63;' +
    'border-radius:8px;padding:7px 10px;font-size:15px;line-height:1;';
  renameBtn.addEventListener('click', () => { pause(); net.openRename(); });
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '← Back to Pong';
  backBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;' +
    'border:1px solid #2c3a63;border-radius:8px;padding:7px 12px;font-size:13px;';
  topbar.append(title, count, muteBtn, renameBtn, driveBtn, backBtn);
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

  // Hold-to-DRIFT button (bottom-right) for touch — keyboard players use Shift. Shown only while
  // driving; press-and-hold engages the handbrake, exactly like holding Shift.
  const driftBtn = document.createElement('button');
  driftBtn.type = 'button';
  driftBtn.textContent = '🌀 DRIFT';
  driftBtn.style.cssText =
    'position:absolute;right:20px;bottom:84px;display:none;pointer-events:auto;cursor:pointer;z-index:5;' +
    'width:86px;height:86px;border-radius:50%;background:#4a2a6b;color:#f0d6ff;border:2px solid #8f55a0;' +
    'font-size:14px;font-weight:800;letter-spacing:.5px;touch-action:none;user-select:none;box-shadow:0 4px 14px #0008;';
  overlay.appendChild(driftBtn);
  driftBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); handbrake = true; driftBtn.style.background = '#7a3a9b'; });
  const releaseDrift = (e?: Event) => { e?.preventDefault(); handbrake = false; driftBtn.style.background = '#4a2a6b'; };
  driftBtn.addEventListener('pointerup', releaseDrift);
  driftBtn.addEventListener('pointercancel', releaseDrift);
  driftBtn.addEventListener('pointerleave', releaseDrift);

  // Fire-rocket button (bottom-right, above the drift button) for touch — keyboard players press R.
  // Shown whenever you're out in the open world (hidden indoors, in the Ruins, in jail, or boating).
  const fireBtn = document.createElement('button');
  fireBtn.type = 'button';
  fireBtn.textContent = '🚀';
  fireBtn.style.cssText =
    'position:absolute;right:20px;bottom:182px;display:none;pointer-events:auto;cursor:pointer;z-index:5;' +
    'width:72px;height:72px;border-radius:50%;background:#6b2a2a;color:#fff;border:2px solid #b85555;' +
    'font-size:30px;line-height:1;touch-action:none;user-select:none;box-shadow:0 4px 14px #0008;';
  overlay.appendChild(fireBtn);
  fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); unlockAudio(); fireRocket(); });
  let fireBtnShown = false;

  // Blessing of the Ball badge (top-centre) — a gilded pill with a bar that drains as the blessing
  // wears off. Hidden whenever no blessing is active. Updated each frame in update().
  const blessBadge = document.createElement('div');
  blessBadge.style.cssText =
    'position:absolute;left:50%;top:44px;transform:translateX(-50%);display:none;pointer-events:none;z-index:4;' +
    'background:#1a1330d8;border:1px solid #e8c34d;border-radius:10px;padding:6px 14px 8px;text-align:center;' +
    'color:#ffe9a0;font-size:12px;font-weight:800;letter-spacing:.5px;text-shadow:0 1px 3px #000a;box-shadow:0 4px 16px #0008;';
  blessBadge.innerHTML =
    '✨ Blessing of the Ball ✨' +
    '<div style="margin-top:5px;height:5px;width:160px;background:#3a2f12;border-radius:3px;overflow:hidden">' +
    '<div class="wBlessBar" style="height:100%;width:100%;background:linear-gradient(90deg,#ffd24a,#fff3b0);border-radius:3px"></div></div>';
  overlay.appendChild(blessBadge);
  const blessBar = blessBadge.querySelector('.wBlessBar') as HTMLDivElement;

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

  // Boat prompt (just above the door prompt): board/dock affordance shown near water. Tap = B.
  const boatPrompt = document.createElement('button');
  boatPrompt.type = 'button';
  boatPrompt.style.cssText =
    'position:absolute;left:50%;bottom:92px;transform:translateX(-50%);display:none;cursor:pointer;' +
    'background:#2f6fa8;color:#eaf4ff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;' +
    'font-weight:700;box-shadow:0 6px 20px #0008;z-index:2;';
  overlay.appendChild(boatPrompt);

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
    'padding-left:6px;scrollbar-width:thin;scrollbar-color:#ffffff44 transparent;';
  const chatInputRow = document.createElement('div');
  chatInputRow.style.cssText = 'display:none;align-items:center;gap:7px;margin-top:8px;padding-left:6px;';
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
  // Slash-command autocomplete popup (same COMMANDS as the main chat), shown just above the input.
  const cmdMenu = document.createElement('div');
  cmdMenu.style.cssText =
    'display:none;flex-direction:column;gap:1px;margin-top:6px;pointer-events:auto;background:#0c1330f0;' +
    'border:1px solid #3a4ea8;border-radius:8px;padding:4px;max-height:30vh;overflow-y:auto;' +
    'box-shadow:0 6px 20px #0008;scrollbar-width:thin;scrollbar-color:#ffffff44 transparent;';
  chatWrap.append(chatLines, cmdMenu, chatInputRow);
  overlay.appendChild(chatWrap);

  // --- slash-command menu state + behaviour ---
  let cmdItems: { label: string; hint: string; complete: string; enabled: boolean }[] = [];
  let cmdIndex = 0;
  function renderCmdMenu() {
    cmdMenu.replaceChildren();
    cmdItems.forEach((it, i) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:baseline;padding:4px 7px;border-radius:5px;cursor:pointer;' +
        (i === cmdIndex ? 'background:#2a3a6e;' : '') + (it.enabled ? '' : 'opacity:.5;');
      const name = document.createElement('span');
      name.textContent = it.label;
      name.style.cssText = 'color:#cfe0ff;font:800 13px system-ui,sans-serif;white-space:nowrap;';
      const hint = document.createElement('span');
      hint.textContent = it.hint;
      hint.style.cssText = 'color:#8aa0d8;font:600 12px system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.append(name, hint);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); cmdIndex = i; completeCmd(); });
      cmdMenu.append(row);
      if (i === cmdIndex) row.scrollIntoView({ block: 'nearest' });
    });
    cmdMenu.style.display = 'flex';
  }
  function refreshCmdMenu() {
    cmdItems = chatActive ? net.worldChatMenu(chatInput.value) : [];
    if (!cmdItems.length) { cmdMenu.style.display = 'none'; return; }
    if (cmdIndex >= cmdItems.length) cmdIndex = 0;
    renderCmdMenu();
  }
  function closeCmdMenu() { cmdItems = []; cmdMenu.style.display = 'none'; }
  // Autocomplete the highlighted row into the input (Tab, or click), then re-suggest.
  function completeCmd() {
    const it = cmdItems[cmdIndex];
    if (!it) return;
    chatInput.value = it.complete;
    chatInput.focus();
    chatInput.setSelectionRange(it.complete.length, it.complete.length);
    refreshCmdMenu();
  }

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
    who.textContent = line.player && !line.whisper ? `${line.from} (playing)` : line.from;
    who.style.color = line.color || '#cdd8f5';
    who.style.fontWeight = '800';
    const body = document.createElement('span');
    body.textContent = `: ${line.text}`;
    body.style.color = line.whisper ? (line.color || '#c9a8ff') : (line.command ? '#ffd27d' : '#f3f6ff');
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
    refreshCmdMenu(); // show command suggestions immediately if we opened on '/'
  }
  function closeChat() {
    if (!chatActive) return;
    chatActive = false;
    closeCmdMenu();
    chatLines.style.pointerEvents = 'none'; // back to click-through so drag-to-walk works
    chatInputRow.style.display = 'none';
    chatBtn.style.display = 'flex';
    chatInput.blur();
    for (const el of Array.from(chatLines.children) as HTMLElement[]) {
      if (el.style.visibility === 'hidden') continue; // already faded out — leave it gone
      armFade(el);
    }
  }
  // Send the current input: run it as a slash command, or post it as a chat line (+ speech bubble).
  function submitChat() {
    const text = chatInput.value.trim();
    chatInput.value = '';
    closeCmdMenu();
    if (text) {
      const res = net.worldRunChatCommand(text); // /ff, /tip, /whisper, /powerup, …
      if (res === 'rejected') { chatInput.value = text; refreshCmdMenu(); return; } // incomplete — keep it
      if (res === 'passthrough') {
        net.sendChat(text);                    // → main game chat → shows in this side feed (+ main chat)
        // Slash text that isn't a known command goes to chat but never pops a public speech bubble.
        if (!text.startsWith('/')) {
          const said = text.slice(0, WORLD_SAY_MAX);
          net.say(said, false);                // → yellow speech bubble over your avatar (chat line)
          // Optimistic local echo so your own bubble pops instantly (the server also echoes it back).
          says.set(net.selfId(), { text: said, until: performance.now() + SAY_MS, purple: false });
        }
      } // 'ran' → the command already did its thing
    }
    closeChat();
  }
  chatInput.addEventListener('input', () => refreshCmdMenu());
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep the world's capture handler from acting on what we type
    const menuOpen = cmdItems.length > 0;
    if (e.key === 'Enter') {
      e.preventDefault();
      // With the menu open, Enter runs the highlighted command (completing it if it needs more).
      if (menuOpen) {
        const it = cmdItems[cmdIndex];
        const res = net.worldRunChatCommand(it.complete.trimEnd());
        if (res === 'ran') { chatInput.value = ''; closeCmdMenu(); closeChat(); }
        else completeCmd(); // needs args (or disabled) — drop the completion in and keep suggesting
        return;
      }
      submitChat();
    } else if (e.key === 'Tab' && menuOpen) {
      e.preventDefault();
      completeCmd();
    } else if (e.key === 'ArrowDown' && menuOpen) {
      e.preventDefault(); cmdIndex = (cmdIndex + 1) % cmdItems.length; renderCmdMenu();
    } else if (e.key === 'ArrowUp' && menuOpen) {
      e.preventDefault(); cmdIndex = (cmdIndex - 1 + cmdItems.length) % cmdItems.length; renderCmdMenu();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (menuOpen) closeCmdMenu(); // first Esc closes the menu; next closes the chat
      else { chatInput.value = ''; closeChat(); }
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
        net.say(said, true);                    // purple bubble only — not added to the chat feed
        says.set(net.selfId(), { text: said, until: performance.now() + SAY_MS, purple: true }); // instant local echo
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
    'min-width:260px;max-width:90vw;max-height:82vh;overflow-y:auto;background:#141c33;border:1px solid #2c3a63;border-radius:14px;' +
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
  const npcFriendBar = document.createElement('div');
  npcFriendBar.style.cssText = 'display:none;margin:4px 0 10px;';
  npcBox.append(npcName, npcFriendBar, npcText, npcChoices, npcHint, npcPortrait);
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
    'position:absolute;top:48px;right:10px;width:200px;border:2px solid #2a3550;border-radius:8px;' + // below the topbar so it never covers the drive / back-to-pong buttons
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
    if (boating) return; // dock the boat first (B) before hopping in a car
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
      handbrake = false;
      revSound(false);
    }
    syncDriveBtn();
  }

  // --- boating ---
  function myBoat(): CarSpec | null {
    return carById(net.boat());
  }
  // Pull a point inside a water ellipse (f<1 keeps it off the very edge). Returns hit=true if it had
  // to be clamped — the shared shape with resolveCollisions so stepVehicle can use either.
  function confineToWater(x: number, y: number, w: WaterRegion, f = 1): { x: number; y: number; hit: boolean } {
    const dx = x - w.cx, dy = y - w.cy;
    const d = Math.hypot(dx / w.rx, dy / w.ry);
    if (d <= f) return { x, y, hit: false };
    const s = f / d;
    return { x: w.cx + dx * s, y: w.cy + dy * s, hit: true };
  }
  // The water you could launch a boat onto right now (near a pond's shore, on foot, boat owned).
  function boardableWater(): WaterRegion | null {
    if (boating || driving || !myBoat() || inInterior || inDungeon) return null;
    for (const w of WATER) {
      const nx = clamp(selfX, w.rect.x, w.rect.x + w.rect.w);
      const ny = clamp(selfY, w.rect.y, w.rect.y + w.rect.h);
      if (Math.hypot(selfX - nx, selfY - ny) <= BOAT_BOARD_PAD) return w;
    }
    return null;
  }
  // Step out of the boat onto the nearest dry shore (just outside the pond rect, on grass).
  function disembarkPoint(x: number, y: number, r: Rect): { x: number; y: number } {
    const pad = R + 6;
    const left = x - r.x, right = r.x + r.w - x, top = y - r.y, bottom = r.y + r.h - y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: r.x - pad, y };
    if (m === right) return { x: r.x + r.w + pad, y };
    if (m === top) return { x, y: r.y - pad };
    return { x, y: r.y + r.h + pad };
  }
  function toggleBoat() {
    if (inInterior || inDungeon || net.amJailed()) return;
    if (!boating) {
      if (!myBoat()) { flashHelp('You don\'t own a boat — fish one up! (Shop → Vehicles → Boats)'); return; }
      const w = boardableWater();
      if (!w) { flashHelp('🛥️ Get next to the water (the fishing pond) to launch your boat.'); return; }
      boating = true; boatWater = w; driving = false; vx = vy = 0;
      boatEntry = { x: selfX, y: selfY };           // remember the dock for a safe fallback
      const p = confineToWater(selfX, selfY, w, 0.82); // slide the boat onto the open water
      selfX = p.x; selfY = p.y;
      tone(360, 0.18, 'sine', 0.05, 520);           // little launch blip
    } else {
      const w = boatWater;
      boating = false; boatWater = null; vx = vy = 0;
      const back = w ? disembarkPoint(selfX, selfY, w.rect) : (boatEntry ?? { x: selfX, y: selfY });
      const safe = resolveCollisions(back.x, back.y, R); // never disembark into a wall
      selfX = safe.x; selfY = safe.y;
      boatEntry = null;
      tone(300, 0.16, 'sine', 0.05, 220);
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
    driftBtn.style.display = driving ? 'block' : 'none'; // hold-to-drift only makes sense behind the wheel
    if (!driving) { handbrake = false; driftBtn.style.background = '#4a2a6b'; }
    updateHelp();
  }

  let helpFlash = '';
  let helpFlashUntil = 0;
  function flashHelp(msg: string) { helpFlash = msg; helpFlashUntil = performance.now() + 2600; updateHelp(); }
  function updateHelp() {
    const now = performance.now();
    if (helpFlash && now < helpFlashUntil) { help.innerHTML = `<span style="color:#ffd166">${helpFlash}</span>`; return; }
    if (boating) {
      help.innerHTML = 'W/S or ↑/↓ throttle · A/D or ←/→ steer · drag to sail · <b>B</b> dock · <b>T</b> chat · <b>Y</b> say';
      return;
    }
    const boatHint = boardableWater() ? ' · <b>B</b> board boat' : '';
    help.innerHTML = driving
      ? 'W/S or ↑/↓ throttle · A/D or ←/→ steer · <b>Shift</b> drift · <b>R</b> 🚀 · <b>F</b> get out · <b>T</b> chat'
      : `WASD / arrows or drag to walk · <b>F</b> drive${boatHint} · <b>R</b> 🚀 · <b>Space</b> enter · <b>T</b> chat`;
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
      case 'temple': return '⛪ Enter the Temple';
      case 'bowling': return '🎳 Enter Bolwoing Alley';
      case 'mcdonald': return "🍔 Enter McDonald's";
      case 'shop': return '🛍️ Enter the General Store';
      case 'hall': return '🏆 Enter the Hall of Fame';
      case 'noticeboard': return '📌 Check the Notice Board';
    }
  }
  function enterBuilding(kind: WorldBuildingKind) {
    enterChime();
    if (kind === 'arena') { exit(); net.enterArena(); return; }
    if (kind === 'casino') { enterCasino(); return; }
    if (kind === 'bank') {
      openDialog('🏦 Bank', 'How can we help you today?', [
        { label: '📈 Crypto Market', onPick: () => { pause(); net.openFeature('stocks'); } },
        { label: '💸 Get a Loan',    onPick: () => { pause(); net.openFeature('loans');  } },
        { label: '📰 Market News',   onPick: () => { pause(); net.openFeature('news');   } },
        { label: '🏛️ The Fed',       onPick: () => { pause(); net.openFeature('house');  } },
      ]);
      return;
    }
    if (kind === 'petshop') {
      // The Pet Shop just opens the Shop panel on the Pets tab — a single choice keeps it tidy.
      openDialog('🐾 Pet Shop', 'Looking for a little companion?', [
        { label: '🐾 Browse Pets', onPick: () => { pause(); net.openFeature('petshop'); } },
      ]);
      return;
    }
    if (kind === 'doomportal') {
      openDialog('🔥 The Gates of DOOM', 'A hot wind howls up from below…', [
        { label: '🔥 Descend', onPick: () => { pause(); net.openFeature('doom'); } },
      ]);
      return;
    }
    if (kind === 'pond') {
      openDialog('🎣 Fishing Pond', 'The water is calm. A good day for fishing.', [
        { label: '🎣 Fish', onPick: () => { pause(); net.openFeature('fishing'); } },
      ]);
      return;
    }
    if (kind === 'bar') { enterTavern(); return; }
    if (kind === 'mcdonald') { enterMcdonald(); return; }
    if (kind === 'temple') { enterTemple(); return; }
    if (kind === 'dungeon') { enterDungeon(); return; }
    if (kind === 'shop') {
      openDialog('🛍️ General Store', 'Shelves of paddle skins, titles, and theme songs — plus the day\'s free spin.', [
        { label: '🛍️ Browse the Shop', onPick: () => { pause(); net.openFeature('shop'); } },
      ]);
      return;
    }
    if (kind === 'hall') { enterHallOfFame(); return; }
    if (kind === 'noticeboard') {
      openDialog('📌 Notice Board', 'Pinned announcements, curling at the edges.', [
        { label: '🏆 Tournament',   onPick: () => { pause(); net.openFeature('tourney'); } },
        { label: '🎫 Season Pass',  onPick: () => { pause(); net.openFeature('season'); } },
        { label: '⚡ Power-ups',    onPick: () => { pause(); net.openFeature('powerups'); } },
        { label: '📜 Changelog',    onPick: () => { pause(); net.openFeature('changelog'); } },
      ]);
      return;
    }
    if (kind === 'parliament') {
      openDialog('🏛️ Parliament', 'The perpetual game of Nomic is in session. The only rule that cannot change is that the rules can.', [
        { label: '🏛️ Take your seat', onPick: () => { pause(); net.openParliament(); } },
      ]);
      return;
    }
    if (kind === 'bowling') {
      openDialog('🎳 Bolwoing Alley', 'The sound of pins crashing echoes down the lane.', [
        { label: '🎳 Bowl (2–4 players)', onPick: () => { pause(); net.openFeature('bowling'); } },
      ]);
      return;
    }
    if (kind === 'arcade') {
      openDialog('🎮 The Arcade', 'Rows of glowing cabinets hum and bleep. Pick your poison.', [
        { label: '🏓 Davis Collects (Campaign)', onPick: () => { pause(); net.openFeature('campaign'); } },
        { label: '⌨️ Type or Die', onPick: () => { pause(); net.openFeature('typedie'); } },
        { label: '🏎️ Street Demons (Racing)', onPick: () => { pause(); net.openFeature('racing'); } },
        { label: '🥊 Super Tsong Bros', onPick: () => { pause(); net.openFeature('superbros'); } },
        { label: '💣 Nuketown', onPick: () => { pause(); net.openFeature('nuketown'); } },
        { label: '🧨 TNT Explosion Rally', onPick: () => { pause(); net.openFeature('tnt'); } },
        { label: '🏍️ Tron', onPick: () => { pause(); net.openFeature('tron'); } },
        { label: '🎸 Tsong Hero', onPick: () => { pause(); net.openFeature('guitarhero'); } },
        { label: '🪖 Worms: Tsong Edition', onPick: () => { pause(); net.openFeature('artillery'); } },
        { label: '🏙️ City Tycoon', onPick: () => { pause(); net.openFeature('citytycoon'); } },
      ]);
      return;
    }
  }

  // Hall of Fame — a read-only trophy-case dialog styled after the real Leaderboard/Net Worth
  // boards (rank chip, name, title flair, right-aligned stat, self-row highlight, crown + debt
  // on Net Worth). Rows are clickable, same as the real boards: clicking one exits World and
  // fires the same balanceSheetReq/eloProfileReq the toolbar boards send, so the real drill-down
  // modal opens with real server data — no separate profile UI to maintain inside World. A pinned
  // self-row (like the toolbar boards') appears below each list when we're not already in it.
  function titleFlairTag(titleId: string | null | undefined): HTMLSpanElement | null {
    if (!titleId) return null;
    const t = COSMETICS.find((c) => c.id === titleId) ?? EXCLUSIVES.find((e) => e.id === titleId);
    if (!t) return null;
    const tag = document.createElement('span');
    tag.textContent = t.name;
    tag.style.cssText = titleId === 'opstask'
      ? 'margin-left:6px;font-size:10px;font-weight:700;white-space:nowrap;' +
        'background:linear-gradient(90deg,#ff3b30,#ff9500,#ffd60a,#34c759,#0a84ff,#bf5af2,#ff3b30);' +
        'background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;' +
        'animation:lbrainbow 2s linear infinite;'
      : 'margin-left:6px;font-size:10px;color:#ffd166;opacity:0.95;white-space:nowrap;';
    return tag;
  }
  function enterHallOfFame() {
    if (dialogOpen || talkOpen) return;
    dialogOpen = true;
    keys.clear(); joyActive = false;
    dialogBox.replaceChildren();

    const h = document.createElement('div');
    h.textContent = '🏆 Hall of Fame';
    h.style.cssText = 'font-size:22px;color:#e8eefc;margin-bottom:14px;text-align:center;';
    dialogBox.appendChild(h);

    const myName = net.name();
    const rowStyle = (bg: string, dashed: boolean) =>
      'display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;text-align:left;' +
      `background:${bg};` + (dashed ? 'border-top:1px dashed #3a4a6a;' : '');
    const hoverable = (row: HTMLDivElement, bg: string) => {
      row.onmouseenter = () => { row.style.background = '#233158'; };
      row.onmouseleave = () => { row.style.background = bg; };
    };

    // heading, empty-state text, and a list container for one board section
    const buildSection = (title: string, color: string): HTMLDivElement => {
      const sec = document.createElement('div');
      sec.style.cssText = 'margin-bottom:14px;';
      const st = document.createElement('div');
      st.textContent = title;
      st.style.cssText = `font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${color};margin-bottom:5px;text-align:left;`;
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:280px;';
      sec.append(st, list);
      dialogBox.appendChild(sec);
      return list;
    };
    const emptyRow = (list: HTMLDivElement, text: string) => {
      const e = document.createElement('div');
      e.textContent = text;
      e.style.cssText = 'color:#6b7796;font-size:12px;padding:4px 8px;text-align:left;';
      list.appendChild(e);
    };

    // 🏓 Leaderboard
    const lbList = buildSection('🏓 Pong Leaderboard', '#7da2ff');
    const lb = net.leaderboard().slice(0, 8);
    if (!lb.length) emptyRow(lbList, 'No ranked matches yet.');
    lb.forEach((r, i) => {
      const self = r.name === myName;
      const bg = self ? '#0a1020' : i % 2 ? '#18203a' : 'transparent';
      const row = document.createElement('div');
      row.style.cssText = rowStyle(bg, self);
      hoverable(row, bg);
      const rank = document.createElement('span');
      rank.textContent = `${i + 1}`;
      rank.style.cssText = 'color:#6b7796;width:18px;flex-shrink:0;font-size:13px;';
      const name = document.createElement('span');
      name.textContent = r.name;
      name.style.cssText = `flex:1;font-size:13px;color:${self ? '#b8c8e8' : '#cdd7f5'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      const val = document.createElement('span');
      val.textContent = `${r.wins}-${r.losses} · ${Math.round(r.elo)}`;
      val.style.cssText = `font-size:12px;color:${self ? '#ffd23f' : '#7da2ff'};font-variant-numeric:tabular-nums;flex-shrink:0;`;
      const tag = titleFlairTag(r.title);
      row.append(rank, name, ...(tag ? [tag] : []), val);
      row.onclick = () => { selectBlip(); net.eloProfileReq(i); };
      lbList.appendChild(row);
    });
    // Pinned self-row (rank + Elo only, matching the toolbar board) when we're outside the top 8.
    if (!lb.some((r) => r.name === myName)) {
      const self = net.selfLbRow();
      if (self) {
        const row = document.createElement('div');
        row.style.cssText = rowStyle('#0a1020', true);
        hoverable(row, '#0a1020');
        const rank = document.createElement('span');
        rank.textContent = `#${self.rank}`;
        rank.style.cssText = 'color:#7a8aaa;width:28px;flex-shrink:0;font-size:13px;';
        const name = document.createElement('span');
        name.textContent = myName;
        name.style.cssText = 'flex:1;font-size:13px;color:#b8c8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const val = document.createElement('span');
        val.textContent = `${Math.round(self.elo)}`;
        val.style.cssText = 'font-size:12px;color:#ffd23f;font-variant-numeric:tabular-nums;flex-shrink:0;';
        row.append(rank, name, val);
        row.onclick = () => { selectBlip(); net.eloProfileReq(0, true); };
        lbList.appendChild(row);
      }
    }

    // 🪙 Net Worth
    const nwList = buildSection('🪙 Net Worth', '#ffd23f');
    const nw = net.netWorth().slice(0, 8);
    if (!nw.length) emptyRow(nwList, "Nobody's banked a coin yet.");
    nw.forEach((r, i) => {
      const self = r.name === myName;
      const broke = r.net < 0;
      const bg = self ? '#0a1020' : i % 2 ? '#18203a' : 'transparent';
      const row = document.createElement('div');
      row.style.cssText = rowStyle(bg, self);
      hoverable(row, bg);
      const rank = document.createElement('span');
      rank.textContent = `${i + 1}`;
      rank.style.cssText = 'color:#6b7796;width:18px;flex-shrink:0;font-size:13px;';
      const name = document.createElement('span');
      name.textContent = `${i === 0 ? '👑 ' : ''}${r.name}`;
      name.style.cssText = `flex:1;font-size:13px;color:${self ? '#b8c8e8' : '#cdd7f5'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
      const val = document.createElement('span');
      val.textContent = `${Math.round(r.net).toLocaleString()}🪙`;
      val.style.cssText = `font-size:12px;color:${broke ? '#f87171' : '#ffd23f'};font-variant-numeric:tabular-nums;flex-shrink:0;`;
      const tag = titleFlairTag(r.title);
      row.append(rank, name, ...(tag ? [tag] : []), val);
      if (r.loan > 0) {
        const debt = document.createElement('span');
        debt.textContent = `🔻${Math.round(r.loan).toLocaleString()}`;
        debt.style.cssText = 'font-size:10px;color:#f87171;opacity:0.85;flex-shrink:0;';
        row.appendChild(debt);
      }
      row.onclick = () => { selectBlip(); net.balanceSheetReq(i); };
      nwList.appendChild(row);
    });
    // Pinned self-row when we're outside the top 8 (matches the toolbar board — no title/crown).
    if (!nw.some((r) => r.name === myName)) {
      const self = net.selfNwRow();
      if (self) {
        const broke = self.net < 0;
        const row = document.createElement('div');
        row.style.cssText = rowStyle('#0a1020', true);
        hoverable(row, '#0a1020');
        const rank = document.createElement('span');
        rank.textContent = `#${self.rank}`;
        rank.style.cssText = 'color:#7a8aaa;width:28px;flex-shrink:0;font-size:13px;';
        const name = document.createElement('span');
        name.textContent = myName;
        name.style.cssText = 'flex:1;font-size:13px;color:#b8c8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const val = document.createElement('span');
        val.textContent = `${Math.round(self.net).toLocaleString()}🪙`;
        val.style.cssText = `font-size:12px;color:${broke ? '#f87171' : '#ffd23f'};font-variant-numeric:tabular-nums;flex-shrink:0;`;
        row.append(rank, name, val);
        if (self.loan > 0) {
          const debt = document.createElement('span');
          debt.textContent = `🔻${Math.round(self.loan).toLocaleString()}`;
          debt.style.cssText = 'font-size:10px;color:#f87171;opacity:0.85;flex-shrink:0;';
          row.appendChild(debt);
        }
        row.onclick = () => { selectBlip(); net.balanceSheetReq(undefined, true); };
        nwList.appendChild(row);
      }
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText =
      'display:block;width:100%;margin-top:4px;cursor:pointer;background:transparent;color:#7c8ab5;' +
      'border:none;padding:8px;font-size:13px;';
    close.onclick = closeDialog;
    dialogBox.appendChild(close);
    dialog.style.display = 'flex';
  }

  // A "← Back" (to the Hall of Fame list) + "Close" button pair, shared by the profile/balance-
  // sheet drill-down views below so you can bounce between rows without leaving the dialog.
  function appendDialogBackFooter(onBack: () => void) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:14px;';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '← Back';
    back.style.cssText =
      'flex:1;cursor:pointer;background:#21305a;color:#e8eefc;border:1px solid #38508f;' +
      'border-radius:10px;padding:10px;font-size:14px;font-weight:600;';
    back.onmouseenter = () => { back.style.background = '#2c4079'; };
    back.onmouseleave = () => { back.style.background = '#21305a'; };
    // enterHallOfFame() guards against re-entry while a dialog is already open (so walking up
    // to the building twice doesn't stack dialogs) — clear the flag first so navigating "back"
    // from a drill-down view doesn't trip that same guard.
    back.onclick = () => { selectBlip(); dialogOpen = false; onBack(); };
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText =
      'flex:1;cursor:pointer;background:transparent;color:#7c8ab5;border:1px solid #2c3a63;' +
      'border-radius:10px;padding:10px;font-size:14px;';
    close.onclick = closeDialog;
    row.append(back, close);
    dialogBox.appendChild(row);
  }
  // A label/value row shared by the profile + balance-sheet drill-down views.
  function statRow(list: HTMLDivElement, label: string, val: string, color = '#e8eefc') {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 4px;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'color:#9fb0d8;';
    const v = document.createElement('span');
    v.textContent = val;
    v.style.cssText = `color:${color};font-variant-numeric:tabular-nums;font-weight:600;flex-shrink:0;`;
    row.append(l, v);
    list.appendChild(row);
  }
  function fmtLastPlayedWorld(ts: number | null): string {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  // The Elo profile drill-down — same fields as the toolbar's leaderboard-row modal, rendered
  // in-World so clicking a Hall of Fame row never has to leave the World overlay.
  function renderEloProfile(msg: EloProfileMsg) {
    dialogOpen = true;
    keys.clear(); joyActive = false;
    dialogBox.replaceChildren();
    const h = document.createElement('div');
    h.textContent = `🏓 ${msg.name}`;
    h.style.cssText = 'font-size:20px;color:#e8eefc;margin-bottom:14px;text-align:center;';
    dialogBox.appendChild(h);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:280px;text-align:left;';
    dialogBox.appendChild(list);
    statRow(list, 'Wins', String(msg.wins));
    statRow(list, 'Losses', String(msg.losses));
    statRow(list, 'Games', String(msg.wins + msg.losses));
    statRow(list, 'Elo', String(msg.elo));
    statRow(list, 'Win rate', `${msg.winPct}%`);
    statRow(list, 'Last played', fmtLastPlayedWorld(msg.lastPlayed));
    if (msg.rival) {
      const hr = document.createElement('div');
      hr.style.cssText = 'border-top:1px solid #2c3a63;margin:8px 0 6px;';
      list.appendChild(hr);
      const rh = document.createElement('div');
      rh.textContent = `Head-to-head vs ${msg.rival.name}`;
      rh.style.cssText = 'font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#7da2ff;margin-bottom:4px;';
      list.appendChild(rh);
      statRow(list, 'Record', `${msg.rival.wins}–${msg.rival.losses}`);
    }
    appendDialogBackFooter(enterHallOfFame);
    dialog.style.display = 'flex';
  }

  // The balance-sheet drill-down — same fields as the toolbar's net-worth-row modal, rendered
  // in-World so clicking a Hall of Fame row never has to leave the World overlay.
  function renderBalanceSheet(msg: BalanceSheetMsg) {
    dialogOpen = true;
    keys.clear(); joyActive = false;
    dialogBox.replaceChildren();
    const h = document.createElement('div');
    h.textContent = `💰 ${msg.name}`;
    h.style.cssText = 'font-size:20px;color:#e8eefc;margin-bottom:14px;text-align:center;';
    dialogBox.appendChild(h);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:290px;text-align:left;';
    dialogBox.appendChild(list);
    statRow(list, 'Coins on hand', `${Math.round(msg.coins).toLocaleString()}🪙`);
    const sectionHdr = (text: string) => {
      const s = document.createElement('div');
      s.textContent = text;
      s.style.cssText = 'font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:#7da2ff;margin:8px 0 4px;';
      list.appendChild(s);
    };
    sectionHdr('Stock holdings');
    if (msg.holdings.length) {
      for (const hd of msg.holdings) {
        const tag = hd.side === 'short' ? 'SHORT ' : '';
        statRow(list, `${tag}${hd.ticker} (${hd.shares.toFixed(2)} sh @ ${Math.round(hd.price).toLocaleString()}🪙)`, `${Math.round(hd.value).toLocaleString()}🪙`);
      }
      statRow(list, 'Stock subtotal', `${Math.round(msg.stockValue).toLocaleString()}🪙`);
    } else {
      const e = document.createElement('div');
      e.textContent = 'No open positions.';
      e.style.cssText = 'color:#6b7796;font-size:12px;padding:3px 4px;';
      list.appendChild(e);
    }
    if (msg.loan > 0) statRow(list, 'Owed to Davis', `−${Math.round(msg.loan).toLocaleString()}🪙`, '#f87171');
    const hr = document.createElement('div');
    hr.style.cssText = 'border-top:1px solid #2c3a63;margin:8px 0;';
    list.appendChild(hr);
    statRow(list, 'Net worth', `${Math.round(msg.net).toLocaleString()}🪙`, msg.net < 0 ? '#f87171' : '#ffd23f');
    appendDialogBackFooter(enterHallOfFame);
    dialog.style.display = 'flex';
  }

  // --- Robville lots: each lot's tint + hovering sign reflect its ownership/market state. ---
  // bank-owned (for sale) = green · yours = gold · listed by a neighbor = amber · owned, not listed = blue.
  function refreshParcels() {
    for (const p of WORLD_PARCELS) {
      const g = parcelGfx.get(p.id);
      if (!g) continue;
      const st = land.get(p.id);
      // A built house lends its emoji to the sign's icon (else the default 🏠 / 🪧).
      const built = st && st.house ? HOUSE_BY_ID.get(st.house) : undefined;
      const homeIcon = built ? built.emoji : '🏠';
      let fill = 0x6fbf73, fa = 0.16, stroke = 0xeaf7ea, label = `🪧 ${PARCEL_PRICE.toLocaleString()}🪙`;
      if (st && st.ownerName) {
        if (st.mine) {
          fill = 0xe8c84b; fa = 0.22; stroke = 0xfff3c4;
          label = st.ask != null ? `${homeIcon} Yours · ${st.ask.toLocaleString()}🪙` : `${homeIcon} Your lot`;
        } else if (st.ask != null) {
          fill = 0xe09a3a; fa = 0.20; stroke = 0xffe0b0;
          label = `🪧 ${st.ask.toLocaleString()}🪙\n${st.ownerName}`;
        } else {
          fill = 0x5a78c8; fa = 0.16; stroke = 0xcdd8f5;
          label = `${homeIcon} ${st.ownerName}`;
        }
      }
      g.pad.setFillStyle(fill, fa);
      g.pad.setStrokeStyle(3, stroke, 0.9);
      g.sign.setText(label);
      if (built) { g.house.setText(built.emoji).setVisible(true); }
      else { g.house.setVisible(false); }
    }
  }

  // The bottom-of-screen prompt text when standing on a lot.
  function parcelPrompt(id: string): string {
    const st = land.get(id);
    if (!st || !st.ownerName) return `🏡 Buy this lot — ${PARCEL_PRICE.toLocaleString()}🪙`;
    const built = st.house ? HOUSE_BY_ID.get(st.house) : undefined;
    if (st.mine) return built ? `${built.emoji} Your ${built.name} — manage` : '🏗️ Your lot — build a house';
    if (st.ask != null) return `🏡 Buy ${st.ownerName}'s lot — ${st.ask.toLocaleString()}🪙`;
    return built ? `${built.emoji} ${st.ownerName}'s ${built.name}` : `🏠 ${st.ownerName}'s lot`;
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
    // Your own lot → build/manage a house, and manage the listing.
    if (st.mine) {
      const built = st.house ? HOUSE_BY_ID.get(st.house) : undefined;
      const choices: { label: string; onPick: () => void }[] = [
        { label: built ? '🏗️ Rebuild as something else…' : '🏗️ Build a house…', onPick: () => { closeDialog(); openBuildMenu(id); } },
      ];
      if (built) choices.push({ label: '🧨 Demolish house', onPick: () => { closeDialog(); net.houseDemolish(id); } });
      choices.push({ label: st.ask != null ? '🏷️ Change asking price…' : '🏷️ List for sale…', onPick: () => {
        const raw = window.prompt('Set an asking price for your Robville lot (in coins):', st.ask != null ? String(st.ask) : '2000');
        const ask = Math.floor(Number(raw));
        if (raw != null && Number.isFinite(ask) && ask > 0) net.landList(id, ask);
        closeDialog();
      } });
      if (st.ask != null) choices.push({ label: '🚫 Take off the market', onPick: () => { closeDialog(); net.landUnlist(id); } });
      const sub = built
        ? (st.ask != null
            ? `Your ${built.name} ${built.emoji}, listed for ${st.ask.toLocaleString()}🪙 (the house goes with it).`
            : `Your ${built.name} ${built.emoji}. Rebuild, demolish, or put it on the market.`)
        : (st.ask != null
            ? `An empty plot, listed for ${st.ask.toLocaleString()}🪙. Build a house to make it (and the sale) shine.`
            : 'A fine empty plot. Build a house here, or put it on the market.');
      openDialog('🏠 Your Robville Lot', sub, choices);
      return;
    }
    // A neighbor's lot — buyable only if they've listed it (no bank cap on private sales).
    const nb = st.house ? HOUSE_BY_ID.get(st.house) : undefined;
    const what = nb ? `${nb.name} ${nb.emoji}` : 'lot';
    if (st.ask != null) {
      openDialog(`🏡 ${st.ownerName}'s ${nb ? nb.name : 'Lot'}`,
        `${st.ownerName} is asking ${st.ask.toLocaleString()}🪙 for this ${what}${nb ? ' (house included)' : ''}. No bank limit when you buy from a neighbor.`, [
        { label: `🤝 Buy for ${st.ask.toLocaleString()}🪙`, onPick: () => { closeDialog(); net.landBuy(id); } },
      ]);
    } else {
      openDialog(`🏠 ${st.ownerName}'s ${nb ? nb.name : 'Lot'}`, `This ${what} belongs to ${st.ownerName}, and it isn't for sale right now.`, []);
    }
  }

  // The "build a house" submenu: every house, cheapest → fanciest, with its price. The chosen
  // house's cost is charged on the server (flowing into the House) and the lot updates for everyone.
  function openBuildMenu(id: string) {
    const st = land.get(id);
    if (!st || !st.mine) return;
    const built = st.house ? HOUSE_BY_ID.get(st.house) : undefined;
    const choices = HOUSE_KINDS
      .filter((h) => !built || h.id !== built.id)
      .map((h) => ({
        label: `${h.emoji} ${h.name} — ${h.cost.toLocaleString()}🪙`,
        onPick: () => { closeDialog(); net.houseBuild(id, h.id); },
      }));
    openDialog('🏗️ Build a House',
      'Pick your dream home — the bill goes to the local builders. A house stays with the lot if you ever sell, so building is an upgrade you can cash out.',
      choices);
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
    inInterior = true; inTemple = false;
    curInt = TAVERN_INT; curWall = TAVERN_WALL; curZoom = TAVERN_ZOOM;
    driving = false; vx = 0; vy = 0; // you're on foot inside
    keys.clear(); joyActive = false;
    selfX = TAVERN_INT.x + TAVERN_INT.w / 2;
    selfY = TAVERN_INT.y + TAVERN_INT.h - 180; // by the door, clear of the exit mat
    mainCam?.setBounds(TAVERN_INT.x, TAVERN_INT.y, TAVERN_INT.w, TAVERN_INT.h);
    setTavernMusic(true); // the jukebox kicks on: Bon Jovi
  }
  function leaveTavern() {
    inInterior = false;
    nearExit = false;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    const bar = WORLD_BUILDINGS.find((b) => b.kind === 'bar');
    if (bar) { selfX = bar.x + bar.w / 2; selfY = bar.y + bar.h + 44; } // step back out the door
    setTavernMusic(false);
    enterChime();
  }

  // --- Temple interior: a hushed, candlelit nave off the map. The faith here is the Order of the
  // Eternal Volley — they hold the Ball sacred and must never let it fall; the Paddle is their cross.
  // Walk up the nave to the lectern and read the holy book for a Blessing. Same camera/collision swap
  // as the Tavern (curInt/curWall/curZoom), plus a holy chant that loops while you're inside. ---
  function buildTempleInterior(sc: Phaser.Scene) {
    if (templeBuilt) return;
    templeBuilt = true;
    const T = TEMPLE_WALL, ix = TEMPLE_INT.x, iy = TEMPLE_INT.y, iw = TEMPLE_INT.w, ih = TEMPLE_INT.h;
    const cx = ix + iw / 2;
    const tile = (key: string, x: number, y: number, w: number, h: number, depth: number) =>
      sc.add.tileSprite(x, y, w, h, key).setOrigin(0, 0).setTileScale(TEXEL, TEXEL).setDepth(depth);
    const prop = (key: string, x: number, y: number, depth = y) =>
      sc.add.image(x, y, key).setScale(TEXEL).setOrigin(0.5, 1).setDepth(depth);
    const ADD = Phaser.BlendModes.ADD;

    // dark surround so a big viewport never shows grass past the nave's edges
    sc.add.rectangle(ix - 900, iy - 900, iw + 1800, ih + 1800, 0x0c0a14).setOrigin(0, 0).setDepth(iy - 1000);
    tile('w-tmp-floor', ix, iy, iw, ih, iy - 900);                               // marble floor
    tile('w-tmp-rug', cx - 70, iy + 96, 140, ih - 210, iy - 880);               // sacred runner up the nave
    // walls (drawn; collision is the clamp to the inset play area)
    tile('w-tmp-wall', ix, iy, iw, 90, iy - 800);                                // back wall band
    tile('w-tmp-wall', ix, iy, T + 12, ih, iy - 800);                            // left wall
    tile('w-tmp-wall', ix + iw - T - 12, iy, T + 12, ih, iy - 800);              // right wall
    tile('w-tmp-wall', ix, iy + ih - T, iw, T, iy - 790);                        // bottom baseboard
    // three tall stained-glass windows on the back wall — the Eternal Volley rendered in glass
    for (const wx of [cx - 240, cx, cx + 240]) {
      sc.add.circle(wx, iy + 60, 48, 0x9fb6ff, 0.10).setDepth(iy - 798);         // cool daylight bloom
      sc.add.image(wx, iy + 6, 'w-tmp-window').setScale(TEXEL).setOrigin(0.5, 0).setDepth(iy - 795);
    }
    // the Cross of the Paddle hung above the altar
    sc.add.image(cx, iy + 118, 'w-tmp-icon').setScale(TEXEL).setOrigin(0.5, 0.5).setDepth(iy - 700);
    prop('w-tmp-altar', cx, iy + 206);                                           // the altar
    // the holy Ball relic — a radiant orb hovering over the altar, slowly breathing
    const relicGlow = sc.add.circle(cx, iy + 156, 30, 0xffe06a, 0.25).setBlendMode(ADD).setDepth(iy - 650);
    const relic = sc.add.circle(cx, iy + 156, 11, 0xfff3b0).setDepth(iy - 640);
    sc.add.circle(cx, iy + 156, 7, 0xffffff, 0.9).setDepth(iy - 639);
    sc.tweens.add({ targets: relic, y: iy + 148, duration: 1900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    sc.tweens.add({ targets: relicGlow, alpha: 0.5, scale: 1.3, duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    // altar candles throwing warm flickering light
    for (const dxc of [-150, -72, 72, 150]) {
      sc.add.circle(cx + dxc, iy + 184, 22, 0xffd98a, 0.16).setBlendMode(ADD).setDepth(iy - 660);
      const cd = prop('w-tmp-candle', cx + dxc, iy + 200, iy - 645);
      sc.tweens.add({ targets: cd, scaleY: TEXEL * 1.1, duration: 200 + Math.abs(dxc % 9) * 14, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
    // a colonnade down each side aisle
    for (const cy0 of [iy + 250, iy + 386, iy + 522]) {
      prop('w-tmp-column', ix + 118, cy0);
      prop('w-tmp-column', ix + iw - 118, cy0);
    }
    // pews flanking the central runner
    for (let r = 0; r < 4; r++) {
      const py = iy + 336 + r * 82;
      prop('w-tmp-pew', cx - 150, py);
      prop('w-tmp-pew', cx + 150, py);
    }
    // the lectern bearing the holy book — walk up and press E to read it
    templeBookX = cx; templeBookY = iy + 286;
    sc.add.circle(templeBookX, templeBookY - 4, 17, 0xffe9a0, 0.14).setBlendMode(ADD).setDepth(iy - 600);
    prop('w-tmp-book', templeBookX, templeBookY + 16);
    // exit mat by the door (sits at the room's bottom-centre, where the generic exit detector looks)
    tile('w-tmp-rug', cx - 80, iy + ih - T - 84, 160, 64, iy - 870);
    sc.add.text(cx, iy + ih - T - 46, '🚪 EXIT', { fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold', color: '#ffe2b0', stroke: '#1a0f08', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(iy - 200);
  }
  function enterTemple() {
    const sc = petScene; if (!sc) return;
    buildTempleInterior(sc);
    enterChime();
    inInterior = true; inTemple = true;
    curInt = TEMPLE_INT; curWall = TEMPLE_WALL; curZoom = TEMPLE_ZOOM;
    driving = false; vx = 0; vy = 0; // on foot inside
    keys.clear(); joyActive = false;
    selfX = TEMPLE_INT.x + TEMPLE_INT.w / 2;
    selfY = TEMPLE_INT.y + TEMPLE_INT.h - 180; // by the door, facing up the nave
    mainCam?.setBounds(TEMPLE_INT.x, TEMPLE_INT.y, TEMPLE_INT.w, TEMPLE_INT.h);
    startChant();
  }
  function leaveTemple() {
    inInterior = false; inTemple = false;
    nearExit = false; nearBook = false;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    const t = WORLD_BUILDINGS.find((b) => b.kind === 'temple');
    if (t) { selfX = t.x + t.w / 2; selfY = t.y + t.h + 44; } // step back out the door
    stopChant();
    enterChime();
  }

  // Reading the holy book: a gothic scripture of the Eternal Volley, page by page. The last page
  // bestows the Blessing of the Ball — a swiftness that gradually wears off (see bestowBlessing).
  function readHolyBook() {
    if (talkOpen || dialogOpen) return;
    const pages = [
      '☩ THE BOOK OF THE ETERNAL VOLLEY ☩',
      'In the beginning was the Serve; and the Serve was with the Ball, and the Serve was the Ball.',
      'Hear, O faithful, the first commandment and the last: the Ball must not fall.',
      'Two Paddles stand as sentinels at the edges of the world, and between them the Ball passeth, to and fro, world without end.',
      'Blessed are they who return what is sent unto them, for theirs shall be the unbroken rally.',
      'Yea, though I walk through the valley of the missed shot, I shall fear no point against me; for the Paddle, it comforteth me.',
      'Now go forth in swiftness, faithful one. The Ball goes with thee. ✝',
    ];
    talkOpen = true; keys.clear(); joyActive = false; prompt.style.display = 'none';
    npcName.textContent = '📖 The Holy Book';
    npcBox.style.display = 'block'; npcChoices.style.display = 'none'; npcPortrait.style.display = 'none';
    let pageI = 0, typing = false, timer = 0, full = '';
    const grantIfNeeded = () => { if (pageI === pages.length - 1) bestowBlessing(); }; // blessing on the final verse
    function showPage() {
      const text = pages[pageI];
      if (text === undefined) { closeTalk(); return; }
      full = text; let shown = 0; typing = true; npcText.textContent = ''; npcHint.style.display = 'none';
      timer = window.setInterval(() => {
        shown++; npcText.textContent = full.slice(0, shown);
        if (shown % 2 === 0) chantBlip();
        if (shown >= full.length) { window.clearInterval(timer); typing = false; npcHint.style.display = 'block'; grantIfNeeded(); }
      }, 34);
    }
    npcAdvance = () => {
      if (typing) { window.clearInterval(timer); typing = false; npcText.textContent = full; npcHint.style.display = 'block'; grantIfNeeded(); return; }
      pageI++; if (pageI >= pages.length) closeTalk(); else showPage();
    };
    function closeTalk() { window.clearInterval(timer); talkOpen = false; npcAdvance = null; npcClose = null; npcBox.style.display = 'none'; }
    npcClose = closeTalk;
    showPage();
  }
  // The Blessing of the Ball — swiftness that decays over BLESS_MS. Re-reading refreshes it.
  function bestowBlessing() {
    const wasGone = blessFrac() <= 0;
    blessStart = Date.now(); blessEnd = blessStart + BLESS_MS;
    if (wasGone) {
      tone(392, 0.5, 'sine', 0.12, 523);
      window.setTimeout(() => tone(523, 0.5, 'sine', 0.12, 659), 170);
      window.setTimeout(() => tone(659, 0.8, 'sine', 0.14, 784), 340);
      showToast('✨ <b>Blessing of the Ball</b> ✨<br>You feel light on your feet. <i>Go in swiftness.</i>');
    }
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
      triggerEncounter({ mob: clarence, song: '/battle.mp3', winPotions: 5, onWin: () => { clarenceDefeated = true; clarenceSprite?.destroy(); clarenceSprite = null; const sc = petScene; if (sc) buildFloor(sc); } }); // rebuild → the chamber's reward chests appear
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
  type EncounterCfg = { mob?: (typeof DUNGEON_MOBS)[number]; capturable?: boolean; chestId?: string; chestC?: number; chestR?: number; coins?: [number, number]; song?: string; winPotions?: number; onWin?: () => void };
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
          } else if (r.result === 'win') {
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
    s.style.cssText = 'font-size:13px;color:#8aa0d8;margin-bottom:18px;white-space:pre-line;text-align:left;';
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

  // --- Friend Sim VN dialogue ----------------------------------------------------------------
  function startFriendTalk(n: LiveNpc) {
    if (talkOpen || dialogOpen) return;
    if (!n.def.friendKey || !n.def.friendTalks) return;
    const key = n.def.friendKey;
    const xp = getFriendXp(key);
    const level = getFriendLevel(xp);

    // Pick a scene: prefer unseen; reset when all available scenes have been seen.
    const indexed = n.def.friendTalks.map((t, i) => ({ t, i })).filter(({ t }) => t.minLevel <= level);
    if (!indexed.length) return;
    const seen = getFriendSeen(key);
    let pool = indexed.filter(({ i }) => !seen.has(i));
    if (!pool.length) { clearFriendSeen(key); pool = indexed; }
    const { t: talk, i: talkIdx } = pool[Math.floor(Math.random() * pool.length)];
    markFriendSeen(key, talkIdx);

    talkOpen = true;
    keys.clear(); joyActive = false;
    prompt.style.display = 'none';
    n.faceLeft = selfX < n.x;

    // Portrait — real image if available, canvas emoji as fallback.
    const makePortrait = n.def.glitchPortrait
      ? (_mood: string) => `/portraits/mira${level}.jpeg`
      : n.def.portraitSrc
        ? (_mood: string) => n.def.portraitSrc!
        : (mood: string) => makeFriendPortrait(mood, n.def.friendColor ?? '#2a3a5a');
    const firstMood = talk.pages[0]?.mood ?? '😊';
    npcPortrait.src = makePortrait(firstMood);
    npcPortrait.style.display = 'block';

    // Bonus XP — evaluated once when the conversation starts.
    const bonus = n.def.friendBonus;
    const bonusActive = !!(bonus && bonus.check());

    // Friendship meter bar.
    const levelName = FRIEND_LEVEL_NAMES[level];
    const prevThresh = FRIEND_THRESHOLDS[level];
    const nextThresh = level < 4 ? FRIEND_THRESHOLDS[level + 1] : FRIEND_THRESHOLDS[4];
    const pct = level < 4 ? Math.round(100 * (xp - prevThresh) / (nextThresh - prevThresh)) : 100;
    const hearts = ['💙', '💙💙', '💚', '💛', '❤️'][level];
    npcFriendBar.style.display = 'block';
    npcFriendBar.innerHTML =
      `<div style="font-size:11px;color:#d4b8ff;margin-bottom:3px;font-family:ui-monospace,monospace;">` +
      `${hearts} ${levelName}${level < 4 ? ` <span style="opacity:.55">(${xp}/${nextThresh} XP)</span>` : ' <span style="color:#ffb3d4">✨ MAX</span>'}</div>` +
      `<div style="height:5px;background:#1e2a48;border-radius:3px;overflow:hidden;">` +
      `<div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#a04aff,#ff6ab0);border-radius:3px;transition:width .5s;"></div></div>` +
      (bonus
        ? `<div style="font-size:10px;margin-top:5px;font-family:ui-monospace,monospace;">` +
          (bonusActive
            ? `<span style="color:#ffd060;">⚡ +${bonus.xp} XP bonus — ${bonus.label}</span>`
            : `<span style="color:#4a5070;">✨ Tip: ${bonus.hint}</span>`) +
          `</div>`
        : '');

    npcName.textContent = n.def.name;
    npcBox.style.display = 'block';

    const pages: FriendPage[] = [...talk.pages];
    let pageI = 0;
    let typing = false;
    let timer = 0;
    let full = '';
    let pendingXp = bonusActive ? bonus!.xp : 0;
    let choicesMade = 0;   // non-risky choices picked this conversation
    let perfectPicks = 0;  // ...that were the best possible read (♪)

    // Live-stat tokens — lets dialogue quote your REAL numbers ({coins}, {elo}, {rank},
    // {wins}, {name}). {hovered} = the choice you moused over but didn't pick (this
    // conversation, or a previous one via localStorage). Mira leans on these hard.
    let lastRejectedHover = '';
    try { lastRejectedHover = localStorage.getItem('tsong.friend.lasthover') || ''; } catch { /* ignore */ }
    const subst = (s: string): string => {
      const st = net.stats();
      return s
        .replace(/\{coins\}/g, st.coins.toLocaleString())
        .replace(/\{elo\}/g, st.elo !== null ? String(st.elo) : 'unrated — you haven\'t finished a ranked match')
        .replace(/\{rank\}/g, st.rank !== null ? `#${st.rank}` : 'unranked')
        .replace(/\{wins\}/g, String(getPongWins()))
        .replace(/\{name\}/g, net.name() || 'whoever you are')
        .replace(/\{hovered\}/g, lastRejectedHover || 'the one you didn\'t pick');
    };

    const updatePortrait = (mood?: string) => {
      // Real-image NPCs keep a static portrait; only emoji-canvas NPCs swap on mood.
      if (mood && !n.def.portraitSrc && !n.def.glitchPortrait)
        npcPortrait.src = makePortrait(mood);
    };

    // Persona-style stat gates for 🔒 choices.
    const reqMet = (r: NonNullable<FriendChoice['req']>): boolean => {
      if (r.stat === 'night') { const h = new Date().getHours(); return h >= 22 || h < 6; }
      if (r.stat === 'wins') return getPongWins() >= (r.min ?? 0);
      const st = net.stats();
      if (r.stat === 'elo') return (st.elo ?? 0) >= (r.min ?? 0);
      if (r.stat === 'fish') return st.fishLb >= (r.min ?? 0);
      return st.coins >= (r.min ?? 0);
    };

    // Floating "♪ +38" feedback when a choice lands (Persona music-note energy).
    const floatXp = (text: string, color: string) => {
      const f = document.createElement('div');
      f.textContent = text;
      f.style.cssText =
        `position:absolute;right:24px;bottom:70px;color:${color};font-weight:800;font-size:24px;` +
        'font-family:ui-monospace,monospace;pointer-events:none;text-shadow:0 2px 10px #000e;' +
        'transition:transform 1.4s ease-out,opacity 1.4s ease-out;z-index:5;';
      npcBox.appendChild(f);
      requestAnimationFrame(() => { f.style.transform = 'translateY(-44px)'; f.style.opacity = '0'; });
      window.setTimeout(() => f.remove(), 1450);
    };

    // Running score for this conversation, pinned under the friendship meter —
    // ticks on every pick so you always know how the chat is going. ♪ per perfect read.
    const tally = document.createElement('div');
    tally.style.cssText = 'font-size:11.5px;margin-top:5px;font-family:ui-monospace,monospace;color:#9fb4e8;';
    npcFriendBar.appendChild(tally);
    const updateTally = () => {
      const total = 10 + pendingXp;
      tally.innerHTML =
        `This chat: <b style="color:${total >= 10 ? '#7fe089' : total >= 0 ? '#e8c84b' : '#ff6a5a'}">` +
        `${total >= 0 ? '+' : ''}${total} XP</b>` +
        (perfectPicks ? ` <span style="color:#ffd060">${'♪'.repeat(perfectPicks)}</span>` : '');
    };

    const renderFriendChoices = (choices: FriendChoice[]) => {
      npcHint.style.display = 'none';
      npcChoices.style.display = 'flex';
      npcChoices.style.flexDirection = 'column';
      npcChoices.replaceChildren();
      const hoverTrail: string[] = []; // Mira sees what you almost said
      // The best non-risky pick on this page — matching it counts toward a Perfect Conversation.
      const pageMax = Math.max(...choices.filter((c) => !c.risk).map((c) => c.xp), -Infinity);
      for (const ch of choices) {
        const risky = !!ch.risk;
        const locked = !!ch.req && !reqMet(ch.req);
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = locked ? `🔒 ${ch.label}` : risky ? `🎲 ${ch.label}` : ch.label;
        b.style.cssText =
          'cursor:pointer;background:#21305a;color:#e8eefc;border:2px solid #6040a8;' +
          'border-radius:10px;padding:9px 14px;font-size:14px;font-weight:700;font-family:ui-monospace,monospace;' +
          'margin:2px 0;text-align:left;' +
          (risky ? 'border-color:#c8402a;box-shadow:0 0 8px #c8402a55;' : '') +
          (locked ? 'opacity:.45;cursor:default;border-style:dashed;' : '');
        if (locked) {
          // Show the aspiration, Persona-style: what would unlock this line.
          const need = document.createElement('span');
          need.textContent = `  (${ch.req!.lockText})`;
          need.style.cssText = 'font-size:11px;opacity:.8;color:#e8b84b;';
          b.appendChild(need);
          b.onclick = (ev) => { ev.stopPropagation(); };
          npcChoices.appendChild(b);
          continue;
        }
        b.onmouseenter = () => {
          hoverTrail.push(ch.label);
          b.style.background = risky ? '#4a2430' : '#2c4079';
          b.style.borderColor = risky ? '#ff5a3a' : '#a04aff';
        };
        b.onmouseleave = () => { b.style.background = '#21305a'; b.style.borderColor = risky ? '#c8402a' : '#6040a8'; };
        b.onclick = (ev) => {
          ev.stopPropagation();
          selectBlip();
          // Remember the option you hovered but didn't pick (this convo and beyond).
          const rejected = [...new Set(hoverTrail)].filter((l) => l !== ch.label).pop();
          if (rejected) {
            lastRejectedHover = rejected;
            try { localStorage.setItem('tsong.friend.lasthover', rejected); } catch { /* ignore */ }
          }
          if (ch.risk) {
            // Risky choice: roll the dice. Gambles sit outside the perfect-read game.
            const won = Math.random() < ch.risk.chance;
            const xp = won ? ch.xp : ch.risk.xp;
            pendingXp += xp;
            floatXp(won ? `🎲 +${xp}` : `🎲 ${xp}`, won ? '#7fe089' : '#ff6a5a');
            pages.push(won ? { text: ch.reply, mood: ch.mood } : { text: ch.risk.reply, mood: ch.risk.mood ?? ch.mood });
          } else {
            pendingXp += ch.xp;
            choicesMade++;
            if (ch.xp >= pageMax) { perfectPicks++; floatXp(`♪ +${ch.xp}`, '#ffd060'); }
            else if (ch.xp < 0) floatXp(`💔 ${ch.xp}`, '#ff6a5a');
            else floatXp(`+${ch.xp}`, '#9fb4e8');
          }
          updateTally();
          npcChoices.style.display = 'none';
          pageI++;
          showPage();
        };
        npcChoices.appendChild(b);
      }
    };

    function showPage() {
      const page = pages[pageI];
      if (!page) { closeFriendTalk(); return; }
      npcChoices.style.display = 'none';
      if (page.mood) updatePortrait(page.mood);
      full = subst(page.text);
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
          if (page.choices?.length) renderFriendChoices(page.choices);
          else npcHint.style.display = 'block';
        }
      }, 26);
    }

    npcAdvance = () => {
      if (typing) {
        window.clearInterval(timer);
        typing = false;
        npcText.textContent = full;
        const page = pages[pageI];
        if (page?.choices?.length) renderFriendChoices(page.choices);
        else npcHint.style.display = 'block';
        return;
      }
      if (pages[pageI]?.choices?.length) return;
      pageI++;
      if (pageI >= pages.length) closeFriendTalk();
      else showPage();
    };

    function closeFriendTalk() {
      window.clearInterval(timer);
      // Perfect Conversation: every non-risky pick was the best read → bonus (not for
      // Mira; she isn't a game you can win, and she'd say so).
      const perfect = !n.def.glitchPortrait && choicesMade > 0 && perfectPicks === choicesMade;
      if (perfect) showToast(`♪ Perfect conversation with ${n.def.name}! <b>+15 bonus XP</b>`);
      const totalXp = 10 + pendingXp + (perfect ? 15 : 0); // 10 base XP for talking
      const { newXp, levelUp, levelDown } = addFriendXp(key, totalXp);
      if (levelUp) {
        const newLv = getFriendLevel(newXp);
        showToast(`💕 Friendship level up with ${n.def.name}!<br><b>${FRIEND_LEVEL_NAMES[newLv - 1]} → ${FRIEND_LEVEL_NAMES[newLv]}</b>`);
      } else if (levelDown) {
        const newLv = getFriendLevel(newXp);
        showToast(`💔 That one cost you with ${n.def.name}...<br><b>${FRIEND_LEVEL_NAMES[newLv + 1]} → ${FRIEND_LEVEL_NAMES[newLv]}</b>`);
      }
      talkOpen = false;
      npcAdvance = null;
      npcClose = null;
      npcBox.style.display = 'none';
      npcPortrait.style.display = 'none';
      npcFriendBar.style.display = 'none';
      npcChoices.style.display = 'none';
      npcChoices.style.flexDirection = '';
    }
    npcClose = closeFriendTalk;

    updateTally();
    showPage();
  }

  // --- NPC dialogue (Pokémon-style bottom box: typewriter line(s), then optional reply choices) ---
  function startTalk(n: LiveNpc) {
    if (n.def.friendKey) { startFriendTalk(n); return; } // redirect to VN friend flow
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
    // Mac the cashier takes your order too.
    if (nearNpc && nearNpc.def.id === 'mc-cashier') { orderMcFood(); return; }
    if (nearNpc) { startTalk(nearNpc); return; }
    if (nearExit) { if (inDungeon) leaveDungeon(); else if (inTemple) leaveTemple(); else if (inMcdonald) leaveMcdonald(); else if (inCasino) leaveCasino(); else leaveTavern(); return; }
    if (nearBook) { readHolyBook(); return; }
    if (nearCasinoGame) { playCasinoGame(nearCasinoGame); return; }
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

  function orderMcFood() {
    if (dialogOpen || talkOpen) return;
    const quips = [
      '"Welcome to McDonald\'s! Can I take your order?"',
      '"Our fries are hot! Like, genuinely hot. Please be careful."',
      '"If I see you order the McFlurry I will respect you forever."',
      '"The Happy Meal toy is a mystery. A beautiful mystery."',
      '"One second, I need to ask Ronald about the sauce."',
    ];
    openDialog('🍔 Mac — Cashier', quips[Math.floor(Math.random() * quips.length)], [
      { label: '🍟 Fries (50🪙)   — speed boost 30s', onPick: () => { closeDialog(); net.buyMcFood('fries'); } },
      { label: '🍔 Big Mac (100🪙) — coin in the bag', onPick: () => { closeDialog(); net.buyMcFood('bigmac'); } },
      { label: '🥤 McFlurry (75🪙) — brain freeze!!', onPick: () => { closeDialog(); net.buyMcFood('mcflurry'); } },
      { label: '🎠 Happy Meal (150🪙) — mystery prize', onPick: () => { closeDialog(); net.buyMcFood('happymeal'); } },
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
  boatPrompt.onclick = toggleBoat;
  driveBtn.onclick = toggleDrive;

  // --- input (capture phase so the main game's global shortcuts don't also fire) ---
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKeyDown(e: KeyboardEvent) {
    if (paused) return; // a delegated panel/minigame owns the screen — let its own input through untouched
    if (isEncounterOpen()) return; // the battle overlay owns input while it's up
    unlockAudio();
    const k = e.key.toLowerCase();
    // While a chat/say input is open it owns the keyboard — let every keystroke (incl. Esc/Enter,
    // handled by the input itself) flow through untouched, and never treat them as movement.
    if (chatActive || sayActive) return;
    if (inDungeon && k === 'p') { e.preventDefault(); usePotion(); return; } // drink a potion (+10 HP)
    if (inDungeon && k === 'l') { e.preventDefault(); toggleLoot(); return; } // 🎒 toggle the run-loot panel
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
    if (k === 'b') { e.preventDefault(); e.stopPropagation(); toggleBoat(); return; } // board/dock a boat on water
    if (k === 'r') { e.preventDefault(); e.stopPropagation(); fireRocket(); return; } // 🚀 fire the rocket launcher
    if (k === '=' || k === '+') { e.preventDefault(); e.stopPropagation(); adjustZoom(1.12); return; }  // zoom in
    if (k === '-' || k === '_') { e.preventDefault(); e.stopPropagation(); adjustZoom(1 / 1.12); return; } // zoom out
    if (k === 'enter' || k === 'e' || k === ' ') {
      // Always swallow Space so the page never scrolls; interact with whatever's in range
      // (building, NPC, netizen, exit, chest, or jail — triggerNear no-ops if nothing is).
      e.preventDefault(); e.stopPropagation();
      triggerNear(); // no-ops if nothing's in range; also covers dungeon chests/stairs/exit + parcels
      return;
    }
    if (k === 'shift') { handbrake = true; e.preventDefault(); e.stopPropagation(); return; } // handbrake → drift
    if (MOVE_KEYS.has(k)) { keys.add(k); e.preventDefault(); e.stopPropagation(); }
  }
  function onKeyUp(e: KeyboardEvent) {
    if (paused) return;
    const k = e.key.toLowerCase();
    if (k === 'shift') { handbrake = false; e.stopPropagation(); return; }
    if (MOVE_KEYS.has(k)) { keys.delete(k); e.stopPropagation(); }
  }
  // Active touch/mouse pointers on the world — one drives the walk joystick; two pinch-to-zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  function onPointerDown(e: PointerEvent) {
    if (paused) return;
    unlockAudio();
    // A tap anywhere but the open input dismisses it (and doesn't also start a walk).
    if (chatActive) { if (!(e.target instanceof Node && chatWrap.contains(e.target))) closeChat(); return; }
    if (sayActive) { if (e.target !== sayBox) closeSay(); return; }
    // Ignore drags that start on a chrome button or while a modal/dialogue is up.
    if (dialogOpen || talkOpen || (e.target instanceof Element && e.target.closest('button'))) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) { // a second finger → pinch-to-zoom, not a walk
      joyActive = false;
      const p = [...pointers.values()];
      pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      return;
    }
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
    if (paused) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) { // pinch: zoom by the change in finger spread
      const p = [...pointers.values()];
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinchDist > 0 && d > 0) adjustZoom(d / pinchDist);
      pinchDist = d;
      return;
    }
    if (!joyActive) return;
    joyCX = e.clientX; joyCY = e.clientY;
  }
  function onPointerUp(e?: PointerEvent) {
    if (paused) return;
    if (e) pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) joyActive = false;
  }
  // Mouse wheel / trackpad scroll zooms the overworld (but let the chat backlog scroll normally).
  function onWheel(e: WheelEvent) {
    if (paused) return;
    if (e.target instanceof Node && chatWrap.contains(e.target)) return;
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  overlay.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
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
    const SP = SPEED * blessMul(); // the Blessing of the Ball quickens your step (decays to 1×)
    if (inInterior) {
      // inside a room (Tavern/Temple): no town collision, just clamp to the inset play area
      selfX = clamp(selfX + dx * SP * dt, curInt.x + curWall + R, curInt.x + curInt.w - curWall - R);
      selfY = clamp(selfY + dy * SP * dt, curInt.y + curWall + R, curInt.y + curInt.h - curWall - R);
      stepSound();
      return;
    }
    if (inDungeon) {
      // inside the Ruins: collide per-tile against the walls/chests (slide along each axis), and
      // play the overworld's synthesized "boop" when you bump something solid.
      const nx = selfX + dx * SP * dt, ny = selfY + dy * SP * dt;
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
    const moved = resolveCollisions(selfX + dx * SP * dt, selfY + dy * SP * dt, R);
    selfX = moved.x; selfY = moved.y;
    if (moved.hit) bumpSound(false);
    else stepSound();
  }

  // Drive: arcade physics with drift. Throttle accelerates along the heading; steering rotates the
  // heading (more authority the faster you go); the velocity's sideways component is bled off by
  // the car's grip each frame — low grip = long slides (drift), high grip = it sticks.
  // Cars confine against buildings; boats confine to their water ellipse. Same arcade physics.
  function stepCar(car: CarSpec, dt: number) {
    stepVehicle(car, dt, (x, y) => resolveCollisions(x, y, CAR_WID * 0.5));
  }
  function stepBoat(boat: CarSpec, dt: number) {
    stepVehicle(boat, dt, (x, y) => boatWater ? confineToWater(x, y, boatWater, 1) : resolveCollisions(x, y, CAR_WID * 0.5));
  }
  function stepVehicle(car: CarSpec, dt: number, confine: (x: number, y: number) => { x: number; y: number; hit: boolean }) {
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
    // Handbrake drift: hold Shift (or the DRIFT button) in a moving car to break the rear loose. The
    // tail steps out, the wheel bites harder so you can swing the nose, and you keep sliding along
    // your old line instead of where you point — proper arcade powerslides. Boats don't drift.
    const drifting = driving && !boating && handbrake && sp > 40;
    // Steering needs speed to bite; near-stationary you can barely turn. Drifting sharpens it.
    const authority = Math.min(1, sp / 120);
    // Reverse-steer: when actually travelling backwards, the wheel swaps (like a real car).
    const rev = (vx * Math.cos(facing) + vy * Math.sin(facing)) < 0 ? -1 : 1;
    facing += steer * rev * car.turn * authority * (drifting ? 1.8 : 1) * dt;
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
    // Higher effective grip RETAINS lateral velocity (the car keeps sliding sideways) — so the
    // handbrake pushes grip toward 1 to make the rear let go, while normal driving uses the car's spec.
    const gripVal = drifting ? Math.min(0.99, car.grip + 0.22) : car.grip;
    const k = Math.pow(gripVal, dt * 60); // grip applied per ~frame, dt-correct
    lat *= k;
    fwd *= Math.pow(drifting ? 0.97 : 0.99, dt * 60); // a drift scrubs off a little extra speed
    fwd = clamp(fwd, -car.speed * 0.5, car.speed);
    vx = hx * fwd - hy * lat;
    vy = hy * fwd + hx * lat;

    const moved = confine(selfX + vx * dt, selfY + vy * dt);
    if (moved.hit) {
      const impact = Math.hypot(vx, vy);
      // Slam a CAR into a building hard enough and it goes up in a fireball (boats just bump the
      // shore). A gentle nudge still only gives the crunch.
      if (driving && !boating && impact > 200) {
        selfX = moved.x; selfY = moved.y;
        blowUpMyCar('💥 KABOOM! You wrapped your car around a building — summon a fresh one anytime.');
        return;
      }
      if (impact > 60) bumpSound(true); // crunch / shore bump (skip silent scrapes when crawling)
      vx *= 0.3; vy *= 0.3;                          // kill most momentum
    }
    selfX = moved.x; selfY = moved.y;
    if (drifting && Math.abs(lat) > 42) emitSkid(); // sliding hard enough → screech, smoke, rubber
    runOverNpcs(Math.hypot(vx, vy));
  }

  // VEHICULAR SLAPSTICK: while driving with any real momentum, flatten any townsperson the car
  // rolls over. They squelch, get launched a touch in your direction of travel, and lie there as a
  // pancake — then dust themselves off and pop back upright a few seconds later, no worse for wear.
  function runOverNpcs(speed: number) {
    if (speed < 55) return;                 // a gentle crawl just nudges; you have to actually run them over
    const now = performance.now();
    const reach = CAR_LEN * 0.42 + R * 0.7; // the car's footprint vs. a standing person
    const hx = Math.cos(facing), hy = Math.sin(facing);
    for (const n of npcs) {
      if (now < n.squishedUntil) continue;  // already a pancake — don't re-squish
      if (Math.hypot(n.x - selfX, n.y - selfY) > reach) continue;
      n.squishedUntil = now + 2600 + Math.random() * 1400; // down for a few seconds
      n.getUpUntil = 0;
      n.walking = false;
      // launch them a bit further along the car's heading, but never into a wall.
      const shove = resolveCollisions(n.x + hx * 22, n.y + hy * 22, R * 0.7);
      n.x = shove.x; n.y = shove.y;
      n.label.setText('💫');                 // seeing stars
      squishSound();
    }
  }

  function updateNearBuilding() {
    if (talkOpen) { prompt.style.display = 'none'; return; } // freeze targeting mid-chat
    // nearest building door — skipped inside the Tavern (town buildings are off-map from here)
    let best: string | null = null;
    let bestD = Infinity;
    if (!inInterior && !inDungeon && !boating) { // no door prompts while out on the water
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
    // Inside a room: standing on the exit mat (bottom-centre, and not chatting up someone) → leave prompt.
    nearExit = false;
    if (inInterior && !nearNpc) {
      const mx = curInt.x + curInt.w / 2, my = curInt.y + curInt.h - curWall - 50;
      if (Math.abs(selfX - mx) < 110 && Math.abs(selfY - my) < 80) nearExit = true;
    }
    // Inside the Temple: standing at the lectern → read-the-book prompt (loses to the exit mat).
    nearBook = false;
    if (inTemple && !nearNpc && !nearExit && Math.hypot(selfX - templeBookX, selfY - templeBookY) < R + 44) nearBook = true;
    // Inside the Casino: standing at a cabinet → play prompt (loses to the exit mat).
    nearCasinoGame = null;
    if (inCasino && !nearExit) {
      let bd = 70;
      for (const st of casinoStations) {
        const d = Math.hypot(selfX - st.x, selfY - st.y);
        if (d < bd) { bd = d; nearCasinoGame = st; }
      }
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
      prompt.textContent = nearNpc.def.id === 'bartender' ? '🍺 Order from the Barkeep' : nearNpc.def.id === 'mc-cashier' ? '🍔 Order from Mac' : nearNpc.def.friendKey ? `💕 Chat with ${nearNpc.def.name}` : `💬 Talk to ${nearNpc.def.name}`;
    } else if (nearExit) {
      prompt.textContent = inDungeon ? '🚪 Leave the Ruins' : inTemple ? '🚪 Leave the Temple' : inMcdonald ? "🍔 Leave McDonald's" : inCasino ? '🎰 Leave the Casino' : '🚪 Leave the Tavern';
    } else if (nearBook) {
      prompt.textContent = '📖 Read the holy book';
    } else if (nearCasinoGame) {
      prompt.textContent = `🎰 Play ${nearCasinoGame.label}`;
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
    prompt.style.display = (nearId || nearNpc || nearNetizen || nearExit || nearBook || nearCasinoGame || nearStairs || nearBossStairs || nearChestCell || nearLockedDoor || nearSwitch || nearSwitchDoor || nearDungeonImp || nearDungeonImp2 || nearDyingMan || nearRob || nearJailed || nearParcel) && !dialogOpen && !talkOpen ? 'block' : 'none';
    // Boat affordance: dock while afloat, or board when standing by the water with a boat.
    const boatable = boating || !!boardableWater();
    if (boatable && !dialogOpen && !talkOpen) {
      boatPrompt.textContent = boating ? '🚶 Dock the boat (B)' : '🛥️ Board the boat (B)';
      boatPrompt.style.display = 'block';
    } else {
      boatPrompt.style.display = 'none';
    }
  }

  function maybeSendMove(now: number) {
    if (inInterior || inDungeon) return; // don't stream off-map interior/dungeon coords — others see you parked at the door
    if (now - lastSentAt < 66) return; // ~15 Hz cap
    if (Math.abs(selfX - lastSentX) < 0.5 && Math.abs(selfY - lastSentY) < 0.5) return;
    lastSentX = selfX; lastSentY = selfY; lastSentAt = now;
    // Stream the boat id in the same field as the car id; others render it via carById (it's in CARS).
    net.move(selfX, selfY, (driving || boating) ? facing : undefined, boating ? net.boat() : driving ? net.car() : null, net.pet());
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
  // The run-over SPLAT: a wet, comedic squish — a low descending squelch under a filtered-noise
  // splat, topped with a silly high cartoon squeak. Throttled so a slow grind doesn't machine-gun.
  let lastSquishAt = 0;
  function squishSound() {
    const now = performance.now();
    if (now - lastSquishAt < 120) return;
    lastSquishAt = now;
    tone(200, 0.18, 'sawtooth', 0.22, 38);   // squelchy downward squish
    noise(0.2, 0.24, 360);                    // wet splat
    window.setTimeout(() => tone(950, 0.05, 'square', 0.08, 1500), 55); // cartoon squeak
  }
  // The dust-yourself-off "pop" as a flattened townsperson springs back upright.
  function getUpSound() { tone(280, 0.13, 'square', 0.1, 660); }
  // Tyre screech while drifting — a thin high noise burst, throttled so it reads as a continuous skid.
  let lastSkidAt = 0;
  function skidSound() {
    const now = performance.now();
    if (now - lastSkidAt < 105) return;
    lastSkidAt = now;
    noise(0.16, 0.05, 1150);
  }
  // KABOOM: two cars meet. A deep detonation (sub-bass thump + descending saw) under a long, fat
  // noise rumble, with a second debris-rumble tail — the whole "huge fireball" in one shot.
  function boomSound() {
    tone(90, 0.55, 'sawtooth', 0.3, 28);
    tone(58, 0.6, 'sine', 0.32, 26);
    noise(0.5, 0.34, 220);
    window.setTimeout(() => noise(0.45, 0.2, 140), 90);
  }
  // Rocket launch: a sharp whoosh — a rising noise hiss plus a quick pitch-up tone (the ignition).
  function rocketLaunchSound() {
    noise(0.3, 0.16, 900);
    tone(180, 0.22, 'sawtooth', 0.16, 520);
  }
  function revSound(starting: boolean) {
    if (starting) tone(80, 0.26, 'sawtooth', 0.18, 230);
    else tone(210, 0.22, 'sawtooth', 0.15, 80);
  }
  function selectBlip() { tone(660, 0.05, 'square', 0.12, 880); }
  // The dialogue typewriter blip — lifted straight from campaign.ts's text chatter (square 440→720).
  function textBlip() { tone(440, 0.04, 'square', 0.05, 720); }
  // A hushed, low blip for the scripture typewriter — reverent rather than chirpy.
  function chantBlip() { tone(196, 0.05, 'sine', 0.04, 262); }

  // --- Holy music: a full pipe-organ hymn that fills the Temple while you're inside. Each phrase lays
  // a fat organ pad (root + fifth + octaves, sine & sawtooth ranks) under a clear hymn melody up top,
  // so it reads as real music, not a faint background drone. All synthesized — no audio assets. ---
  let chantTimer = 0;
  const chantNodes: { o: OscillatorNode; g: GainNode }[] = [];
  // One sustained organ voice: swell in, hold, then release. Pushed to chantNodes so stopChant() can
  // cut everything cleanly when you leave.
  function holyVoice(freq: number, t: number, dur: number, peak: number, type: OscillatorType, attack: number) {
    const a = ac();
    const o = a.createOscillator(); const g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);                 // swell
    g.gain.setValueAtTime(peak, t + Math.max(attack + 0.05, dur - 0.7));   // hold
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);                  // release
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
    if (chantNodes.length > 40) chantNodes.splice(0, chantNodes.length - 40); // drop spent voices
    chantNodes.push({ o, g });
  }
  function chantChord(root: number, mel: readonly number[]) {
    try {
      const a = ac(); const t = a.currentTime; const dur = 4.4;
      // a fat pipe-organ pad — multiple ranks for a full, present sound
      holyVoice(root, t, dur, 0.16, 'sine', 0.5);          // sub
      holyVoice(root * 2, t, dur, 0.12, 'sawtooth', 0.6);  // principal rank (reedy)
      holyVoice(root * 1.5, t, dur, 0.09, 'sine', 0.7);    // fifth
      holyVoice(root * 3, t, dur, 0.05, 'sawtooth', 0.9);  // bright upper rank
      holyVoice(root * 2 + 1.5, t, dur, 0.05, 'triangle', 0.8); // detuned shimmer
      // a clear hymn melody sung over the top — foreground, not subtle
      const step = (dur - 0.6) / Math.max(1, mel.length);
      for (let k = 0; k < mel.length; k++) holyVoice(mel[k], t + k * step, step + 0.3, 0.14, 'sine', 0.05);
    } catch { /* ignore */ }
  }
  function startChant() {
    if (chantTimer) return;
    unlockAudio();
    // a solemn hymn: each phrase pairs a bass root with a melody line over it
    const phrases: { root: number; mel: number[] }[] = [
      { root: 110.00, mel: [440.00, 523.25, 493.88] }, // A
      { root: 146.83, mel: [587.33, 523.25, 440.00] }, // D
      { root: 130.81, mel: [523.25, 659.25, 587.33] }, // C
      { root: 164.81, mel: [659.25, 587.33, 493.88] }, // E
      { root: 110.00, mel: [493.88, 440.00, 523.25] }, // A
      { root:  98.00, mel: [392.00, 440.00, 493.88] }, // G
    ];
    let i = 0;
    chantChord(phrases[0].root, phrases[0].mel);
    chantTimer = window.setInterval(() => { i = (i + 1) % phrases.length; chantChord(phrases[i].root, phrases[i].mel); }, 4000);
  }
  function stopChant() {
    if (chantTimer) { window.clearInterval(chantTimer); chantTimer = 0; }
    const a = actx;
    for (const n of chantNodes) {
      try {
        if (a) { n.g.gain.cancelScheduledValues(a.currentTime); n.g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.6); n.o.stop(a.currentTime + 0.7); }
      } catch { /* already stopped */ }
    }
    chantNodes.length = 0;
  }

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
    bubbleBg: Phaser.GameObjects.NineSlice; // rounded panel drawn behind the bubble text
    bubbleNextAt: number;             // when this bot picks its next line
    // smoothed render position for remote avatars (we lerp toward the broadcast)
    rx: number; ry: number; ra: number;
  }
  const remote = new Map<string, Av>();
  let self: Av | null = null;
  let selfAura: Phaser.GameObjects.Arc | null = null; // golden Blessing halo behind the self avatar

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
  // Looping Tavern jukebox — Bon Jovi "Livin' on a Prayer" (8-bit). Starts on entering the bar,
  // pauses on leaving. Same lazy-create + race-safe wanted pattern as the dungeon theme.
  let tavernMusic: HTMLAudioElement | null = null;
  let tavernMusicWanted = false;
  function setTavernMusic(on: boolean) {
    tavernMusicWanted = on;
    if (on && !tavernMusic) { tavernMusic = new Audio('/livin-on-a-prayer-8bit.mp3'); tavernMusic.loop = true; tavernMusic.volume = 0.4; }
    if (!tavernMusic) return;
    if (on) { tavernMusic.currentTime = 0; tavernMusic.play().then(() => { if (!tavernMusicWanted) tavernMusic?.pause(); }).catch(() => { /* needs a gesture; entering the bar is one */ }); }
    else tavernMusic.pause();
  }
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

    // --- Doritas DeVito: Danny DeVito reimagined as a nacho-cheese tortilla chip. A stout triangle
    //     of a man — bald pate, wild dark side-hair, monstrous eyebrows, an enormous raspy grin, dusted
    //     in cheese powder. Stubby arms and little legs. Baked (not tinted). 16×16, feet at the base. ---
    {
      const NACHO = 0xe8912c, NACHO_D = 0xb56a18, NACHO_L = 0xf4b85a, CRUMB = 0x8a4f11;
      const CHEESE = 0xf6d24a, HAIR = 0x2a1d10, BROW = 0x1f1509, TOOTH = 0xf8f0d8, MOUTH = 0x4a2408;
      const SKN = 0xe7b98c, EYEW = 0xffffff, PUP = 0x1a1208, SHOE = 0x171717;
      g.clear();
      // the chip — a triangle that widens toward the base (per-row spans)
      px(8, 1, 1, 1, NACHO); px(7, 2, 3, 2, NACHO); px(6, 4, 5, 2, NACHO);
      px(5, 6, 7, 1, NACHO); px(4, 7, 9, 2, NACHO); px(3, 9, 11, 2, NACHO);
      px(2, 11, 13, 2, NACHO); px(1, 13, 15, 1, NACHO);
      // toasted edges + a highlight down the upper-left facet
      px(1, 13, 15, 1, CRUMB); px(1, 12, 1, 1, NACHO_D); px(14, 12, 1, 1, NACHO_D);
      px(2, 12, 12, 1, NACHO_D); px(6, 4, 1, 2, NACHO_L); px(7, 2, 1, 2, NACHO_L);
      // cheese-dust freckles scattered across the chip
      px(4, 6, 1, 1, CHEESE, 0.9); px(11, 8, 1, 1, CHEESE, 0.9); px(3, 10, 1, 1, CHEESE, 0.9);
      px(13, 11, 1, 1, CHEESE, 0.9); px(9, 5, 1, 1, CHEESE, 0.85); px(6, 12, 1, 1, CHEESE, 0.85);
      // the face: a bald crown up top (shiny skin showing through), wild dark hair down the sides
      px(6, 5, 5, 1, SKN); px(7, 4, 3, 1, SKN);                              // gleaming bald pate
      px(3, 9, 1, 3, HAIR); px(13, 9, 1, 3, HAIR); px(2, 11, 1, 2, HAIR); px(14, 11, 1, 2, HAIR); // side hair
      // monstrous eyebrows
      px(5, 6, 3, 1, BROW); px(9, 6, 3, 1, BROW);
      // eyes with pupils
      px(5, 7, 2, 1, EYEW); px(9, 7, 2, 1, EYEW); px(6, 7, 1, 1, PUP); px(9, 7, 1, 1, PUP);
      // a little nose nub
      px(8, 8, 1, 1, NACHO_D);
      // the enormous raspy grin — wide dark mouth with a row of teeth
      px(5, 10, 7, 1, MOUTH); px(5, 10, 7, 1, TOOTH); px(5, 11, 7, 1, MOUTH); px(6, 11, 5, 1, TOOTH);
      // stubby arms poking out the sides
      px(0, 9, 2, 1, NACHO); px(0, 9, 1, 1, SKN); px(14, 9, 2, 1, NACHO); px(15, 9, 1, 1, SKN);
      // two little legs + shoes below the base
      px(5, 14, 2, 2, HAIR); px(9, 14, 2, 2, HAIR); px(4, 15, 3, 1, SHOE); px(9, 15, 3, 1, SHOE);
      g.generateTexture('w-dorito', 16, 16);
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

    // ============================================================================================
    // TEMPLE INTERIOR PROPS — pale marble & candlelit stone, with the iconography of the Order of the
    // Eternal Volley: the holy Ball, the sacred Paddle (their cross). Baked once; assembled in
    // buildTempleInterior().
    // ============================================================================================
    {
      // marble floor tile (16×16): a pale checker with faint grey veining
      const M1 = 0xe8e3d4, M2 = 0xd5cfbe, VEIN = 0xc2bba6, SEAM = 0xb4ad98;
      g.clear();
      px(0, 0, 8, 8, M1); px(8, 8, 8, 8, M1); px(8, 0, 8, 8, M2); px(0, 8, 8, 8, M2);
      px(0, 7, 16, 1, SEAM); px(7, 0, 1, 16, SEAM);                       // grout seams
      px(2, 3, 4, 1, VEIN); px(10, 11, 3, 1, VEIN); px(12, 2, 1, 3, VEIN); // veins
      g.generateTexture('w-tmp-floor', 16, 16);
    }
    {
      // dressed-stone wall tile (16×16): light ashlar blocks with mortar courses
      const S1 = 0xcac3ae, S2 = 0xbcb59f, MORT = 0x9a937e, HI = 0xdcd6c4;
      g.clear();
      px(0, 0, 16, 16, S1); px(0, 0, 16, 1, HI);
      px(0, 7, 16, 1, MORT); px(0, 15, 16, 1, MORT);                      // courses
      px(7, 0, 1, 8, MORT); px(11, 8, 1, 8, MORT);                        // staggered joints
      px(2, 2, 3, 1, S2); px(10, 10, 3, 1, S2);                           // faint block shading
      g.generateTexture('w-tmp-wall', 16, 16);
    }
    {
      // sacred runner tile (16×16): royal purple with gold borders + a gold sun-diamond
      const P = 0x4a2d7a, P_D = 0x351f5a, GOLD = 0xe8c34d, GOLD_D = 0xb8923a;
      g.clear();
      px(0, 0, 16, 16, P);
      px(0, 0, 16, 2, GOLD); px(0, 14, 16, 2, GOLD); px(0, 0, 2, 16, GOLD_D); px(14, 0, 2, 16, GOLD_D);
      px(3, 3, 10, 10, P_D);
      px(7, 4, 2, 8, GOLD); px(4, 7, 8, 2, GOLD); px(6, 6, 4, 4, GOLD_D); px(7, 7, 2, 2, GOLD);
      g.generateTexture('w-tmp-rug', 16, 16);
    }
    {
      // stained-glass window (24×40): a deep-blue arched light — the holy Ball arcing over the green
      // Paddle, the Eternal Volley rendered in glass, with rose panes in the crown.
      const FRM = 0x7a715f, GL = 0x21478f, GL_D = 0x162a5e, LEAD = 0x0d1632;
      const BALL = 0xffe06a, GLOW = 0xfff6c0, PAD = 0x46c06a, PAD_HI = 0x8ce0a4, PAD_D = 0x2f8f4c, RED = 0xc23b4a;
      g.clear();
      px(2, 6, 20, 34, FRM); px(5, 2, 14, 6, FRM); px(8, 0, 8, 3, FRM);  // arched stone frame
      px(4, 8, 16, 30, GL_D); px(5, 9, 14, 28, GL); px(7, 4, 10, 5, GL); // blue glass field
      px(11, 4, 2, 34, LEAD); px(4, 22, 16, 2, LEAD);                    // lead came (cross)
      px(9, 30, 6, 6, PAD); px(9, 30, 6, 1, PAD_HI); px(9, 35, 6, 1, PAD_D); // green Paddle at the base
      px(10, 13, 4, 4, GLOW); px(11, 14, 2, 2, BALL);                    // golden Ball
      px(9, 12, 6, 1, GLOW); px(9, 17, 6, 1, GLOW); px(8, 13, 1, 3, GLOW); px(15, 13, 1, 3, GLOW); // its radiance
      px(7, 5, 3, 2, RED); px(14, 5, 3, 2, RED);                         // rose panes in the crown
      g.generateTexture('w-tmp-window', 24, 40);
    }
    {
      // fluted classical column (16×64): capital, ribbed shaft, base
      const COL = 0xd9d3c1, COL_SH = 0xb9b29c, COL_HI = 0xeee9da, CAP = 0xcabf9f;
      g.clear();
      px(0, 0, 16, 5, CAP); px(1, 1, 14, 1, COL_HI); px(2, 5, 12, 2, COL_SH); // capital
      px(3, 7, 10, 52, COL);                                                  // shaft
      px(3, 7, 1, 52, COL_HI); px(5, 7, 1, 52, COL_SH); px(8, 7, 1, 52, COL_SH); px(11, 7, 1, 52, COL_SH); // flutes
      px(1, 59, 14, 5, CAP); px(0, 62, 16, 2, COL_SH);                        // base
      g.generateTexture('w-tmp-column', 16, 64);
    }
    {
      // the altar (44×30): pale stone block draped with a purple gold-hemmed cloth, on a base step
      const ST = 0xcfc8b3, ST_HI = 0xe6ded0, ST_D = 0xa9a28c, CLOTH = 0x4a2d7a, CLOTH_HI = 0x5e3a96, CLOTH_D = 0x351f5a, GOLD = 0xe8c34d;
      g.clear();
      px(2, 8, 40, 20, ST); px(2, 8, 40, 2, ST_HI); px(2, 26, 40, 2, ST_D);   // block
      px(0, 26, 44, 4, ST_D);                                                  // base step
      px(6, 0, 32, 9, CLOTH); px(6, 0, 32, 2, CLOTH_HI); px(6, 7, 32, 2, CLOTH_D); // draped cloth
      px(6, 9, 32, 1, GOLD);                                                   // gold hem
      for (const fx of [9, 16, 23, 30, 37]) px(fx, 10, 1, 2, GOLD);            // gold fringe
      g.generateTexture('w-tmp-altar', 44, 30);
    }
    {
      // tall altar candle (8×20): holder, wax, flame
      const WAX = 0xeee3c4, WAX_D = 0xcfc09a, STK = 0x9a7b3a, FL = 0xffcf5a, FL_HI = 0xfff0c0;
      g.clear();
      px(2, 18, 4, 2, STK);                                                    // holder
      px(3, 6, 2, 12, WAX); px(4, 6, 1, 12, WAX_D);                            // candle
      px(3, 3, 2, 3, FL); px(3, 2, 2, 1, FL_HI); px(3, 4, 2, 1, FL_HI);        // flame
      g.generateTexture('w-tmp-candle', 8, 20);
    }
    {
      // a worshipper's pew (48×18): a forward-facing wooden bench
      const W = 0x6e4a28, W_HI = 0x8a5e34, W_D = 0x4f3318;
      g.clear();
      px(2, 0, 44, 5, W); px(2, 0, 44, 2, W_HI);                              // backrest
      px(2, 5, 2, 6, W_D); px(42, 5, 2, 6, W_D);                              // back posts
      px(0, 10, 48, 5, W); px(0, 10, 48, 1, W_HI); px(0, 14, 48, 1, W_D);     // seat
      px(3, 15, 3, 3, W_D); px(42, 15, 3, 3, W_D);                            // legs
      g.generateTexture('w-tmp-pew', 48, 18);
    }
    {
      // the Cross of the Paddle (28×28): the sacred Paddle as an upright cross, the Ball at its heart
      const PAD = 0xb9823f, PAD_HI = 0xd8a05c, PAD_D = 0x8a5f2c, HANDLE = 0x6e4a28, HANDLE_HI = 0x8a5e34;
      const BALL = 0xffe06a, GLOW = 0xfff6c0, RAY = 0xffe082;
      g.clear();
      px(13, 0, 2, 28, RAY, 0.5); px(0, 13, 28, 2, RAY, 0.5);                 // faint radiant cross-glow
      px(10, 2, 8, 12, PAD); px(10, 2, 8, 2, PAD_HI); px(10, 12, 8, 2, PAD_D); // blade (up)
      px(4, 8, 20, 5, PAD); px(4, 8, 20, 1, PAD_HI); px(4, 12, 20, 1, PAD_D);  // crossbar (arms)
      px(12, 14, 4, 12, HANDLE); px(12, 14, 2, 12, HANDLE_HI);                 // handle (down)
      px(11, 8, 6, 6, GLOW); px(12, 9, 4, 4, BALL); px(13, 10, 1, 1, 0xffffff); // the Ball at the heart
      g.generateTexture('w-tmp-icon', 28, 28);
    }
    {
      // the holy book on its lectern (24×28): a slanted stand bearing an open, gilded scripture
      const WD = 0x6e4a28, WD_HI = 0x8a5e34, WD_D = 0x4f3318, PG = 0xf2ead2, PG_SH = 0xd8cfb2, INK = 0x2a2118, GOLD = 0xe8c34d;
      g.clear();
      px(10, 16, 4, 10, WD); px(11, 16, 1, 10, WD_HI); px(7, 25, 10, 3, WD_D); // post + foot
      px(4, 12, 16, 5, WD); px(4, 12, 16, 1, WD_HI);                           // slanted lectern top
      px(3, 6, 18, 8, PG); px(3, 6, 18, 1, PG_SH); px(11, 5, 2, 9, WD_D);      // open book + spine
      px(5, 8, 5, 1, INK); px(5, 10, 5, 1, INK); px(14, 8, 5, 1, INK); px(14, 10, 5, 1, INK); // text lines
      px(3, 6, 1, 8, GOLD); px(20, 6, 1, 8, GOLD);                            // gilded page edges
      g.generateTexture('w-tmp-book', 24, 28);
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

    // --- fireball blob: a hot white core fading to a soft edge. Drawn white so an ADD blend + per-
    // particle tint paints the yellow→orange→red of a crash explosion. ---
    g.clear();
    g.fillStyle(0xffffff, 0.30); g.fillCircle(12, 12, 12);
    g.fillStyle(0xffffff, 0.55); g.fillCircle(12, 12, 8);
    g.fillStyle(0xffffff, 0.95); g.fillCircle(12, 12, 4.5);
    g.generateTexture('w-fireball', 24, 24);

    // --- rocket: a little missile pointing +x (so rotation = travel heading). Red body, dark nose,
    // swept fins, and a hot flame tail. ---
    g.clear();
    px(0, 3, 3, 2, 0xffd24a); px(0, 4, 2, 1, 0xff7a1a);     // flame tail
    px(2, 1, 2, 6, 0x9a2a2a);                                // rear fins
    px(3, 2, 9, 4, 0xd23b3b); px(3, 2, 9, 1, 0xef6a6a);      // body + top highlight
    px(11, 3, 3, 2, 0x7a1414); px(13, 4, 1, 1, 0x7a1414);    // dark nose cone
    g.generateTexture('w-rocket', 16, 8);

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

    // --- Bill's Boat: a fully-painted pixel-art runabout/speedboat, top-down, pointing +x (east),
    //     36×18 texels. A white hull with a V bow, an open blue cockpit (helm seats + aft bench +
    //     console), a windshield, and an outboard motor on the transom. Painted in full colour and
    //     rendered untinted (unlike the tinted cars). ---
    {
      const HULL = 0xf2efe6, DECK = 0x3d6e8c, DECK_D = 0x2e5670, GLASS = 0xbfdcec,
            SEAT = 0xe4e9ed, CONSOLE = 0x2c3e50, MOTOR = 0x232a33, TRIM = 0xffffff;
      g.clear();
      // white hull with a pointed V bow at the right (+x)
      px(4, 4, 24, 10, HULL); px(28, 5, 4, 8, HULL); px(31, 6, 3, 6, HULL); px(33, 8, 2, 2, HULL);
      px(3, 6, 1, 6, HULL);                              // transom (stern, left)
      // open blue cockpit interior
      px(7, 6, 18, 6, DECK); px(7, 6, 18, 1, DECK_D); px(7, 11, 18, 1, DECK_D); // floor + gunwale shadow
      // windshield band just aft of the white foredeck
      px(23, 5, 2, 8, GLASS);
      // seating: a full-beam aft bench + two helm seats, with a dark console by the windshield
      px(9, 6, 3, 6, SEAT);
      px(15, 6, 3, 2, SEAT); px(15, 10, 3, 2, SEAT);
      px(20, 7, 2, 4, CONSOLE);
      // outboard motor poking off the transom
      px(0, 7, 3, 4, MOTOR); px(3, 8, 1, 2, MOTOR);
      // bright white gunwale rails down both sides
      px(5, 4, 23, 1, TRIM); px(5, 13, 23, 1, TRIM);
      g.generateTexture('w-boat-body', 36, 18);
      g.clear(); // the boat is painted entirely in the body layer; keep the roof layer transparent
      g.generateTexture('w-boat-roof', 2, 2);
    }

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

    // Crypt Slime: a green gelatinous blob with two beady eyes + a little tongue lolling out (12×11).
    g.clear();
    px(3, 2, 6, 1, 0x7ed06a); px(2, 3, 8, 2, 0x6fc25a);             // domed top
    px(1, 5, 10, 3, 0x5fae54); px(1, 8, 10, 1, 0x4d9444);          // wide body + shaded base
    px(3, 2, 2, 1, 0x9fe28a);                                       // highlight
    px(3, 4, 1, 2, 0x16210f); px(7, 4, 1, 2, 0x16210f);            // two beady eyes
    px(4, 7, 4, 1, 0x2a3a1a);                                       // mouth line
    px(5, 8, 2, 3, 0xe2566a); px(5, 8, 2, 1, 0xf07a8a);            // a red tongue sticking out the bottom
    g.generateTexture('w-pet-slime', 12, 11);

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

  // The Ruins: not a house — a crumbling stone shell. Broken, gap-toothed walls over a black descent
  // pit, a ragged archway entrance, scattered rubble, a toppled column, and creeping moss.
  function buildRuins(sc: Phaser.Scene, b: WorldBuilding) {
    const { x, y, w, h } = b, front = y + h;
    const stone = 0x6f6a76, stoneD = 0x4a4652, stoneHi = 0x8d8896, dark = 0x0e0b14, moss = 0x4c7a3a;
    const r = (i: number) => Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1); // deterministic pseudo-random 0..1
    const rect = (rx: number, ry: number, rw: number, rh: number, c: number, d: number) =>
      sc.add.rectangle(rx, ry, rw, rh, c).setOrigin(0, 0).setDepth(d);
    // the descent: a sunken black pit inside the shell
    rect(x, y, w, h, 0x241f2b, y - 3);
    rect(x + 8, y + 12, w - 16, h - 20, dark, y - 2);
    // back wall — segmented with broken crenellations + the odd collapsed gap + moss
    for (let i = 0, sx = x; sx < x + w - 6; sx += 18, i++) {
      if (r(i) < 0.22) continue;                              // a collapsed section (gap)
      const ch = 18 + Math.floor(r(i + 9) * 22);
      rect(sx, y - ch + 14, 18, ch, i % 2 ? stone : stoneD, y + 1);
      rect(sx, y - ch + 14, 18, 4, stoneHi, y + 1.1);
      if (r(i + 3) < 0.32) rect(sx + 3, y - ch + 17, 9, 4, moss, y + 1.2);
    }
    // left + right side walls running toward the viewer, broken in places
    for (let i = 0, sy = y; sy < y + h - 4; sy += 18, i++) {
      if (r(i + 40) > 0.18) rect(x - 4, sy, 16, 18, i % 2 ? stone : stoneD, sy);
      if (r(i + 60) > 0.18) rect(x + w - 12, sy, 16, 18, i % 2 ? stone : stoneD, sy);
    }
    // front face: broken stubs flanking a dark archway entrance
    const doorW = Math.min(76, w * 0.42), dx0 = x + (w - doorW) / 2;
    rect(x - 4, front - 30, dx0 - x + 4, 30, stone, front); rect(x - 4, front - 30, dx0 - x + 4, 5, stoneHi, front + 0.1);
    rect(dx0 + doorW, front - 30, x + w + 4 - (dx0 + doorW), 30, stone, front); rect(dx0 + doorW, front - 30, x + w + 4 - (dx0 + doorW), 5, stoneHi, front + 0.1);
    rect(dx0, front - 46, doorW, 46, dark, front - 0.5);     // the dark mouth
    rect(dx0 - 5, front - 50, doorW + 10, 9, stoneD, front + 0.2); rect(dx0 - 5, front - 50, doorW + 10, 3, stoneHi, front + 0.3); // broken lintel
    // a toppled column at the front-left + moss on it
    rect(x - 10, front - 58, 15, 58, stone, front + 1); rect(x - 10, front - 58, 15, 5, stoneHi, front + 1.1);
    rect(x - 8, front - 60, 11, 7, moss, front + 1.2);
    // rubble strewn around the base
    for (let i = 0; i < 8; i++) { const rx = x + r(i + 100) * (w - 8), ry = front - 4 + r(i + 101) * 12, s = 6 + r(i + 102) * 9; rect(rx, ry, s, s * 0.7, i % 2 ? stoneD : stone, ry + 60); }
    // the venue glyph above the mouth
    sc.add.text(dx0 + doorW / 2, front - h * 0.5, b.emoji, { fontSize: '24px' }).setOrigin(0.5, 1).setDepth(front + 3);
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

  // McDonald's: red facade with a YELLOW arch-sign panel containing a bold RED M (maximum contrast).
  // Drive-thru window on the right, warm-lit dining windows, red canopy over the door,
  // animated pulsing arch glow + flashing OPEN sign.
  function buildMcDonald(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);

    const RED = 0xcc0000, DRED = 0x990000, BRID = 0xff4444, MRED = 0xbb0000;
    const GOLD = 0xffc107, DGOLD = 0xe69500, LGOLD = 0xffe066;
    const DARK = 0x1a0000;

    // Main red facade
    P(0, 0, W, H, DRED);
    P(1, 1, W - 2, H - 2, RED);
    P(1, 1, W - 2, 2, BRID); // top highlight

    // --- Wide YELLOW arch-sign panel (covers upper ~45% of facade) ---
    // This is the main visual anchor — the iconic yellow background the M lives on.
    const signPad = 6;
    const signTop = 5, signH = Math.round(H * 0.45);
    P(signPad, signTop, W - signPad * 2, signH, GOLD);
    P(signPad, signTop, W - signPad * 2, 2, LGOLD);                  // top glint
    P(signPad, signTop + signH - 2, W - signPad * 2, 2, DGOLD);      // bottom shadow
    P(signPad, signTop, 2, signH, DGOLD);                              // left side
    P(W - signPad - 2, signTop, 2, signH, DGOLD);                     // right side

    // --- Bold RED M silhouette on the yellow panel (high contrast, unmissable) ---
    // The M is drawn as five rectangular blocks: two tall outer pillars, two shorter inner
    // legs, and a base connecting them — creating the classic two-arch silhouette.
    const mPad = Math.round((W - signPad * 2) * 0.08) + signPad;
    const mW = W - mPad * 2;                      // total M width
    const mTop = signTop + Math.round(signH * 0.1);
    const mBot = signTop + signH - Math.round(signH * 0.1);
    const mH = mBot - mTop;
    const pilW = Math.round(mW * 0.18);           // outer pillar width
    const legW = Math.round(mW * 0.12);           // inner leg width
    const baseH = Math.round(mH * 0.26);          // base height
    const legStart = mTop + Math.round(mH * 0.38); // inner legs start below the arch tops

    // Left outer pillar
    P(mPad, mTop, pilW, mH, MRED);
    P(mPad, mTop, pilW, 2, BRID); // top glint
    // Right outer pillar
    P(mPad + mW - pilW, mTop, pilW, mH, MRED);
    P(mPad + mW - pilW, mTop, pilW, 2, BRID);
    // Left inner leg
    P(mPad + pilW, legStart, legW, mBot - legStart, MRED);
    // Right inner leg
    P(mPad + mW - pilW - legW, legStart, legW, mBot - legStart, MRED);
    // Base connector (spans the full M width at the bottom)
    P(mPad, mBot - baseH, mW, baseH, MRED);
    // Slight bevel on the base top
    P(mPad, mBot - baseH, mW, 1, BRID);

    // --- Warm-lit dining windows (lower section) ---
    const winTop = signTop + signH + 4;
    const winH = Math.round((H - winTop - 14) * 0.55);
    const winW = Math.round(W * 0.10);
    let wx = 6;
    while (wx + winW < W - 6) {
      P(wx, winTop, winW, winH, DARK);
      P(wx + 1, winTop + 1, winW - 2, winH - 2, 0xffe09a); // warm glow
      P(wx + 1, winTop + 1, winW - 2, Math.round(winH * 0.35), 0xfff2c8); // top glint
      wx += Math.round(W * 0.18);
    }

    // --- Drive-thru window (right side, smaller) ---
    const dtW = Math.round(W * 0.09), dtH = Math.round(H * 0.13);
    const dtX = W - dtW - 5, dtY = winTop + winH + 6;
    P(dtX, dtY, dtW, dtH, DARK); P(dtX + 1, dtY + 1, dtW - 2, dtH - 2, 0xffe09a);

    // --- Door (center bottom) ---
    const dw = Math.round(W * 0.20), dh = Math.round(H * 0.20);
    const doorX = Math.round((W - dw) / 2);
    P(doorX - 2, H - dh - 3, dw + 4, dh, GOLD);     // gold frame
    P(doorX, H - dh - 1, dw, dh, DARK);               // opening
    P(doorX + 1, H - dh - 1, Math.round(dw / 2) - 1, dh, 0x200800); // door panel
    // Canopy (red with yellow fringe teeth)
    P(doorX - 8, H - dh - 12, dw + 16, 8, RED);
    P(doorX - 9, H - dh - 14, dw + 18, 3, BRID); // canopy highlight
    for (let fx = doorX - 7; fx < doorX + dw + 8; fx += 6) P(fx, H - dh - 5, 4, 5, GOLD); // fringe

    // Outer border
    P(0, 0, 2, H, DARK); P(W - 2, 0, 2, H, DARK); P(0, H - 2, W, 2, DARK);

    g.generateTexture('w-mcdonald', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-mcdonald').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // Pulsing warm glow behind the yellow sign panel
    const archGlowX = b.x + W / 2 * TEXEL;
    const archGlowY = b.y + (signTop + signH / 2) * TEXEL;
    const glow = sc.add.ellipse(archGlowX, archGlowY, (W - signPad * 2) * TEXEL * 1.1, signH * TEXEL, GOLD, 0.14).setDepth(depth - 1);
    sc.tweens.add({ targets: glow, alpha: 0.05, duration: 1800, yoyo: true, repeat: -1 });

    // Blinking red OPEN sign in the drive-thru alcove
    const openSign = sc.add.text(b.x + (dtX + dtW / 2) * TEXEL, b.y + (dtY - 4) * TEXEL, '▶ OPEN', {
      fontFamily: 'system-ui, sans-serif', fontSize: '9px', fontStyle: 'bold',
      color: '#ff2200', stroke: '#1a0000', strokeThickness: 2, resolution: 2,
    }).setOrigin(0.5, 1).setDepth(depth + 2);
    sc.tweens.add({ targets: openSign, alpha: 0.2, duration: 600, yoyo: true, repeat: -1 });

    // "Ba da ba ba baaa" sparkle lights along the bottom of the sign panel
    const n = Math.max(5, Math.round((W - signPad * 2) / 16));
    for (let i = 0; i < n; i++) {
      const bx = b.x + (signPad + 4 + i * ((W - signPad * 2 - 8) / (n - 1))) * TEXEL;
      const by = b.y + (signTop + signH - 2) * TEXEL;
      const bulb = sc.add.circle(bx, by, 3, LGOLD).setDepth(depth + 1);
      sc.tweens.add({ targets: bulb, alpha: 0.15, duration: 450, yoyo: true, repeat: -1, delay: i * 110 });
    }
  }

  // McDonald's interior: a bright fast-food dining room. Red walls, checkered floor, counter at back,
  // menu board above it, tables with chairs, and a McCafé corner. Cashier Mac, Grimace, and Ronald
  // are on duty. Exit via the door mat at the bottom center.
  function buildMcdonaldInterior(sc: Phaser.Scene) {
    if (mcBuilt) return;
    mcBuilt = true;
    const T = MC_WALL, ix = MC_INT.x, iy = MC_INT.y, iw = MC_INT.w, ih = MC_INT.h;
    const cx = ix + iw / 2;

    const tile = (key: string, x: number, y: number, w: number, h: number, depth: number) =>
      sc.add.tileSprite(x, y, w, h, key).setOrigin(0, 0).setTileScale(TEXEL, TEXEL).setDepth(depth);

    // Dark surround so a big viewport doesn't show grass
    sc.add.rectangle(ix - 900, iy - 900, iw + 1800, ih + 1800, 0x2a0000).setOrigin(0, 0).setDepth(iy - 1000);

    // Floor: a bright cream/beige (fast food floor)
    sc.add.rectangle(ix, iy, iw, ih, 0xf5e6c0).setOrigin(0, 0).setDepth(iy - 900);
    // Checkered pattern overlay (red/cream tiles)
    const tileS = 40;
    for (let ty2 = 0; ty2 < ih; ty2 += tileS) {
      for (let tx2 = 0; tx2 < iw; tx2 += tileS) {
        const isRed = ((Math.floor(tx2 / tileS) + Math.floor(ty2 / tileS)) % 2 === 0);
        if (isRed) sc.add.rectangle(ix + tx2, iy + ty2, tileS, tileS, 0xdd1111, 0.08).setOrigin(0, 0).setDepth(iy - 899);
      }
    }

    // Walls: red on top/sides, yellow baseboard at bottom
    sc.add.rectangle(ix, iy, iw, T + 10, 0xcc0000).setOrigin(0, 0).setDepth(iy - 800); // back wall
    sc.add.rectangle(ix, iy, T, ih, 0xcc0000).setOrigin(0, 0).setDepth(iy - 800);       // left
    sc.add.rectangle(ix + iw - T, iy, T, ih, 0xcc0000).setOrigin(0, 0).setDepth(iy - 800); // right
    sc.add.rectangle(ix, iy + ih - T, iw, T, 0xcc0000).setOrigin(0, 0).setDepth(iy - 790); // front
    // Yellow baseboard stripe
    sc.add.rectangle(ix, iy + ih - T - 8, iw, 8, 0xffc107).setOrigin(0, 0).setDepth(iy - 789);
    // Yellow top stripe on back wall
    sc.add.rectangle(ix, iy + T + 8, iw, 6, 0xffc107).setOrigin(0, 0).setDepth(iy - 799);

    // Counter: a long service counter across the back
    const counterY = iy + T + 16;
    const counterH = 50;
    const counterL = ix + T + 10;
    const counterR = ix + iw - T - 10;
    sc.add.rectangle(counterL, counterY, counterR - counterL, counterH, 0xdddddd).setOrigin(0, 0).setDepth(counterY + counterH);
    sc.add.rectangle(counterL, counterY, counterR - counterL, 6, 0xeeeeee).setOrigin(0, 0).setDepth(counterY + counterH + 1); // top highlight
    sc.add.rectangle(counterL, counterY + counterH - 6, counterR - counterL, 6, 0xbbbbbb).setOrigin(0, 0).setDepth(counterY + counterH + 1); // shadow
    // Red trim on counter front
    sc.add.rectangle(counterL, counterY + 6, counterR - counterL, 4, 0xcc0000).setOrigin(0, 0).setDepth(counterY + counterH + 2);
    sc.add.rectangle(counterL, counterY + 14, counterR - counterL, 4, 0xffc107).setOrigin(0, 0).setDepth(counterY + counterH + 2);

    // Menu board above counter (large dark panel with yellow text)
    const mbY = iy + 4;
    const mbH = T + 10;
    sc.add.rectangle(counterL, mbY, counterR - counterL, mbH, 0x1a0000).setOrigin(0, 0).setDepth(mbY + mbH + 1);
    sc.add.rectangle(counterL + 2, mbY + 2, counterR - counterL - 4, mbH - 4, 0x0d0000).setOrigin(0, 0).setDepth(mbY + mbH + 2);
    sc.add.text(cx, mbY + Math.round(mbH * 0.38), '🍔 Big Mac  🍟 Fries  🥤 McFlurry', {
      fontFamily: 'system-ui, sans-serif', fontSize: '10px', fontStyle: 'bold',
      color: '#ffcc00', resolution: 2,
    }).setOrigin(0.5, 0.5).setDepth(mbY + mbH + 3);

    // A cash register on the counter
    const regX = cx - 30;
    sc.add.rectangle(regX, counterY + 4, 40, 24, 0x333333).setOrigin(0, 0).setDepth(counterY + counterH + 3);
    sc.add.rectangle(regX + 4, counterY + 6, 32, 14, 0x111111).setOrigin(0, 0).setDepth(counterY + counterH + 4);

    // Dining area: three tables with chairs
    const tbl = (tx: number, ty: number) => {
      sc.add.rectangle(tx - 30, ty - 12, 60, 32, 0xff2222).setOrigin(0, 0).setDepth(ty + 8);       // table
      sc.add.rectangle(tx - 28, ty - 10, 56, 28, 0xff4444).setOrigin(0, 0).setDepth(ty + 9);       // table surface
      sc.add.rectangle(tx - 28, ty - 10, 56, 6, 0xff6666).setOrigin(0, 0).setDepth(ty + 10);       // highlight
      // chairs top & bottom
      sc.add.rectangle(tx - 20, ty - 28, 18, 14, 0xffc107).setOrigin(0, 0).setDepth(ty - 20);
      sc.add.rectangle(tx + 2, ty - 28, 18, 14, 0xffc107).setOrigin(0, 0).setDepth(ty - 20);
      sc.add.rectangle(tx - 20, ty + 22, 18, 14, 0xffc107).setOrigin(0, 0).setDepth(ty + 32);
      sc.add.rectangle(tx + 2, ty + 22, 18, 14, 0xffc107).setOrigin(0, 0).setDepth(ty + 32);
    };
    tbl(ix + Math.round(iw * 0.25), iy + Math.round(ih * 0.65));
    tbl(cx, iy + Math.round(ih * 0.70));
    tbl(ix + Math.round(iw * 0.75), iy + Math.round(ih * 0.65));

    // McCafé corner (upper left) — a small coffee machine
    const mcafX = ix + T + 14, mcafY = counterY + counterH + 8;
    sc.add.rectangle(mcafX, mcafY, 36, 28, 0x222222).setOrigin(0, 0).setDepth(mcafY + 28);
    sc.add.rectangle(mcafX + 4, mcafY + 4, 28, 16, 0x444444).setOrigin(0, 0).setDepth(mcafY + 29);
    sc.add.circle(mcafX + 18, mcafY + 22, 5, 0x8B4513).setDepth(mcafY + 30); // coffee spout
    sc.add.text(mcafX + 18, mcafY - 6, '☕ McCafé', {
      fontFamily: 'system-ui, sans-serif', fontSize: '9px', fontStyle: 'bold',
      color: '#ffd700', stroke: '#220000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 1).setDepth(mcafY + 31);

    // Trash can (near the door)
    const trashX = ix + iw - T - 30, trashY = iy + ih - T - 50;
    sc.add.rectangle(trashX, trashY, 22, 28, 0x555555).setOrigin(0, 0).setDepth(trashY + 28);
    sc.add.rectangle(trashX + 2, trashY + 2, 18, 24, 0x333333).setOrigin(0, 0).setDepth(trashY + 29);

    // A happy meal box on one of the tables (easter egg)
    sc.add.text(cx + 4, iy + Math.round(ih * 0.70) - 8, '🍟', {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px',
    }).setOrigin(0.5).setDepth(iy + Math.round(ih * 0.70));

    // Exit mat by the door (bottom center)
    sc.add.rectangle(cx - 50, iy + ih - T - 50, 100, 36, 0xffc107, 0.6).setOrigin(0, 0).setDepth(iy - 870);
    sc.add.text(cx, iy + ih - T - 32, '🚪 EXIT', {
      fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold',
      color: '#cc0000', stroke: '#1a0000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(iy - 200);
  }

  function enterMcdonald() {
    const sc = petScene; if (!sc) return;
    buildMcdonaldInterior(sc);
    enterChime();
    inInterior = true; inMcdonald = true;
    curInt = MC_INT; curWall = MC_WALL; curZoom = MC_ZOOM;
    driving = false; vx = 0; vy = 0;
    keys.clear(); joyActive = false;
    selfX = MC_INT.x + MC_INT.w / 2;
    selfY = MC_INT.y + MC_INT.h - 180;
    mainCam?.setBounds(MC_INT.x, MC_INT.y, MC_INT.w, MC_INT.h);
  }

  function leaveMcdonald() {
    inInterior = false; inMcdonald = false;
    nearExit = false;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    const mc = WORLD_BUILDINGS.find((b) => b.kind === 'mcdonald');
    if (mc) { selfX = mc.x + mc.w / 2; selfY = mc.y + mc.h + 44; }
    enterChime();
  }

  // --- Casino interior: a walk-in gaming floor, one cabinet per game (CASINO_GAMES). Same
  // camera/collision-swap trick as the Tavern/Temple/McDonald's; walking up to a cabinet and
  // playing sends you straight into that game's real panel via net.openFeature, same as before. ---
  function buildCasinoInterior(sc: Phaser.Scene) {
    if (casinoBuilt) return;
    casinoBuilt = true;
    const T = CASINO_WALL, ix = CASINO_INT.x, iy = CASINO_INT.y, iw = CASINO_INT.w, ih = CASINO_INT.h;
    const cx = ix + iw / 2;

    // dark surround so a big viewport never shows grass past the room's edges
    sc.add.rectangle(ix - 900, iy - 900, iw + 1800, ih + 1800, 0x0a0410).setOrigin(0, 0).setDepth(iy - 1000);
    // floor: deep maroon casino carpet with a faint gold diamond pattern
    sc.add.rectangle(ix, iy, iw, ih, 0x2a0c1a).setOrigin(0, 0).setDepth(iy - 900);
    const tileS = 46;
    for (let ty2 = 0; ty2 < ih; ty2 += tileS) {
      for (let tx2 = 0; tx2 < iw; tx2 += tileS) {
        if (((Math.floor(tx2 / tileS) + Math.floor(ty2 / tileS)) % 2) === 0) {
          sc.add.rectangle(ix + tx2, iy + ty2, tileS, tileS, 0xe8b84b, 0.05).setOrigin(0, 0).setDepth(iy - 899);
        }
      }
    }
    // walls: dark purple with a magenta neon top stripe + gold baseboard (echoes the exterior facade)
    sc.add.rectangle(ix, iy, iw, T + 10, 0x271447).setOrigin(0, 0).setDepth(iy - 800);
    sc.add.rectangle(ix, iy, T, ih, 0x271447).setOrigin(0, 0).setDepth(iy - 800);
    sc.add.rectangle(ix + iw - T, iy, T, ih, 0x271447).setOrigin(0, 0).setDepth(iy - 800);
    sc.add.rectangle(ix, iy + ih - T, iw, T, 0x1a0e30).setOrigin(0, 0).setDepth(iy - 790);
    sc.add.rectangle(ix, iy + T + 6, iw, 3, 0xff3ea5).setOrigin(0, 0).setDepth(iy - 799);
    sc.add.rectangle(ix, iy + ih - T - 6, iw, 3, 0xe8b84b).setOrigin(0, 0).setDepth(iy - 789);
    sc.add.text(cx, iy + T * 0.6, '🎰 THE CASINO FLOOR 🎰', {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold',
      color: '#ffd23f', stroke: '#1a0a14', strokeThickness: 5, resolution: 2,
    }).setOrigin(0.5, 0.5).setDepth(iy - 700);

    // one cabinet per game, laid out in a 4-column grid across the floor
    casinoStations = [];
    const cols = 4, marginX = 190, marginY = 260, stepX = (iw - marginX * 2) / (cols - 1), stepY = 200;
    CASINO_GAMES.forEach((g, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = ix + marginX + col * stepX, y = iy + marginY + row * stepY;
      casinoStations.push({ feature: g.feature, label: g.label, x, y });
      const glow = sc.add.ellipse(x, y + 6, 90, 30, g.color, 0.22).setDepth(y - 4); // glow puddle
      sc.add.rectangle(x - 46, y - 78, 92, 90, g.color).setOrigin(0, 0).setDepth(y)
        .setStrokeStyle(2, 0xffffff, 0.35);                                    // cabinet body
      sc.add.rectangle(x - 46, y - 78, 92, 10, 0xffffff, 0.18).setOrigin(0, 0).setDepth(y + 1); // top sheen
      const icon = sc.add.text(x, y - 46, g.emoji, { fontSize: '34px' }).setOrigin(0.5).setDepth(y + 2);
      sc.add.text(x, y + 2, g.label, {
        fontFamily: 'system-ui, sans-serif', fontSize: '11px', fontStyle: 'bold',
        color: '#ffffff', stroke: '#000000', strokeThickness: 3, resolution: 2,
      }).setOrigin(0.5, 0).setDepth(y + 3);
      // Idle animation so the row of cabinets reads as "live" rather than a wall of signs —
      // each one's phase is offset by its index so the floor doesn't pulse in lockstep.
      const phase = i * 220;
      sc.tweens.add({ targets: glow, alpha: 0.34, scaleX: 1.12, scaleY: 1.12, duration: 1500, delay: phase, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      sc.tweens.add({ targets: icon, y: y - 51, duration: 1100, delay: phase, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });

    // exit mat by the door (bottom-center, where the generic exit detector looks)
    sc.add.rectangle(cx - 70, iy + ih - T - 70, 140, 60, 0xe8b84b, 0.35).setOrigin(0, 0).setDepth(iy - 870);
    sc.add.text(cx, iy + ih - T - 38, '🚪 EXIT', { fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontStyle: 'bold', color: '#ffe2b0', stroke: '#1a0f08', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(iy - 200);
  }
  function enterCasino() {
    const sc = petScene; if (!sc) return;
    buildCasinoInterior(sc);
    enterChime();
    inInterior = true; inCasino = true;
    curInt = CASINO_INT; curWall = CASINO_WALL; curZoom = CASINO_ZOOM;
    driving = false; vx = 0; vy = 0; // on foot inside
    keys.clear(); joyActive = false;
    selfX = CASINO_INT.x + CASINO_INT.w / 2;
    selfY = CASINO_INT.y + CASINO_INT.h - 180; // by the door
    mainCam?.setBounds(CASINO_INT.x, CASINO_INT.y, CASINO_INT.w, CASINO_INT.h);
  }
  function leaveCasino() {
    inInterior = false; inCasino = false;
    nearExit = false; nearCasinoGame = null;
    keys.clear(); joyActive = false;
    mainCam?.setBounds(0, 0, WORLD.w, WORLD.h);
    const c = WORLD_BUILDINGS.find((b) => b.kind === 'casino');
    if (c) { selfX = c.x + c.w / 2; selfY = c.y + c.h + 44; } // step back out the door
    enterChime();
  }
  // Walking up to a cabinet and confirming sends you straight into that game's real panel —
  // same net.openFeature() plumbing the old flat dialog list used, just reached by walking now.
  function playCasinoGame(g: NonNullable<typeof nearCasinoGame>) {
    if (dialogOpen || talkOpen) return;
    const emoji = CASINO_GAMES.find((c) => c.feature === g.feature)?.emoji ?? '🎰';
    openDialog(`${emoji} ${g.label}`, `Step up and play ${g.label}.`, [
      { label: `▶️ Play ${g.label}`, onPick: () => { pause(); net.openFeature(g.feature); } },
    ]);
  }

  // McDonald's confetti burst for jackpot Happy Meal wins.
  function spawnMcConfetti() {
    const colors = ['#ffc107', '#cc0000', '#ffffff', '#ff6600', '#ffff00'];
    for (let i = 0; i < 40; i++) {
      const div = document.createElement('div');
      const color = colors[i % colors.length];
      div.style.cssText = `position:fixed;pointer-events:none;z-index:99995;width:8px;height:8px;background:${color};border-radius:2px;` +
        `left:${30 + Math.random() * 40}%;top:${10 + Math.random() * 30}%;` +
        `transform:rotate(${Math.random() * 360}deg);` +
        `transition:transform ${1.2 + Math.random() * 1.2}s ease,top ${1.5 + Math.random() * 1}s ease,opacity 2s ease`;
      document.body.appendChild(div);
      requestAnimationFrame(() => {
        div.style.top = `${60 + Math.random() * 40}%`;
        div.style.transform = `rotate(${Math.random() * 720}deg)`;
        div.style.opacity = '0';
      });
      window.setTimeout(() => div.remove(), 3000);
    }
  }

  // --- T-Rex: a large prehistoric predator that prowls the overworld. Purely client-side —
  // each session gets their own Rex. She wanders slowly, accelerates when you get close,
  // and if she catches you she chomps you (screen shake + coins fall out). She announces
  // her presence with a guttural roar every few minutes. ---
  let rex: { x: number; y: number; vx: number; vy: number; img: Phaser.GameObjects.Text; nametag: Phaser.GameObjects.Text; nextTurn: number; chasing: boolean; chompCooldown: number; lastRoar: number } | null = null;

  function spawnRex(sc: Phaser.Scene) {
    const corners = [
      { x: 300, y: 300 }, { x: WORLD.w - 300, y: 300 },
      { x: 300, y: WORLD.h - 300 }, { x: WORLD.w - 300, y: WORLD.h - 300 },
    ];
    const pos = corners[Math.floor(Math.random() * corners.length)];
    const img = sc.add.text(pos.x, pos.y, '🦖', {
      fontFamily: 'system-ui, sans-serif', fontSize: '56px',
    }).setOrigin(0.5, 0.85).setDepth(99995);
    const nametag = sc.add.text(pos.x, pos.y - 44, 'T-REX', {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold',
      color: '#ff4444', stroke: '#000', strokeThickness: 3, resolution: 2,
    }).setOrigin(0.5, 1).setDepth(99996);
    rex = {
      x: pos.x, y: pos.y, vx: 0, vy: 0,
      img, nametag,
      nextTurn: performance.now() + 1500 + Math.random() * 2000,
      chasing: false, chompCooldown: 0, lastRoar: performance.now() + 60_000,
    };
  }

  function updateRex(now: number, dt: number) {
    if (!rex || inInterior || inDungeon) {
      if (rex) { rex.img.setVisible(false); rex.nametag.setVisible(false); }
      return;
    }
    rex.img.setVisible(true); rex.nametag.setVisible(true);

    const dx = selfX - rex.x, dy = selfY - rex.y;
    const distToPlayer = Math.hypot(dx, dy);
    const chaseRange = 450;
    const chompRange = 68;

    // Roar when close (once every 3 minutes, throttled)
    if (distToPlayer < chaseRange && now - rex.lastRoar > 180_000) {
      rex.lastRoar = now;
      showToast('🦖 <b>RRROOAAAR!</b> <i>The ground shakes. Something huge approaches.</i>');
      tone(55, 0.8, 'sawtooth', 0.18, 28);
    }

    // Chase mode: charge at player when within range
    rex.chasing = distToPlayer < chaseRange && now > rex.chompCooldown;

    if (rex.chasing) {
      // Accelerate toward player
      const speed = 140 + (chaseRange - distToPlayer) * 0.18; // faster the closer it gets
      rex.vx += (dx / distToPlayer) * speed * dt * 3;
      rex.vy += (dy / distToPlayer) * speed * dt * 3;
      rex.img.setFlipX(dx < 0);
    } else {
      // Wander: drift toward a random target that changes periodically
      if (now >= rex.nextTurn) {
        rex.nextTurn = now + 2000 + Math.random() * 4000;
        const a = Math.random() * Math.PI * 2;
        const r = 200 + Math.random() * 400;
        rex.vx = Math.cos(a) * (55 + Math.random() * 40);
        rex.vy = Math.sin(a) * (55 + Math.random() * 40);
        rex.img.setFlipX(rex.vx < 0);
      }
    }

    // Clamp speed
    const spd = Math.hypot(rex.vx, rex.vy);
    const maxSpd = rex.chasing ? 240 : 90;
    if (spd > maxSpd) { rex.vx = (rex.vx / spd) * maxSpd; rex.vy = (rex.vy / spd) * maxSpd; }

    // Apply drag
    const drag = rex.chasing ? 0.94 : 0.88;
    rex.vx *= Math.pow(drag, dt * 60); rex.vy *= Math.pow(drag, dt * 60);

    // Move + clamp to world bounds
    rex.x = Math.max(100, Math.min(WORLD.w - 100, rex.x + rex.vx * dt));
    rex.y = Math.max(100, Math.min(WORLD.h - 100, rex.y + rex.vy * dt));

    // Chomp!
    if (rex.chasing && distToPlayer < chompRange && now > rex.chompCooldown) {
      rex.chompCooldown = now + 8000; // 8-second cooldown before it can eat you again
      rex.chasing = false;
      rex.vx = -rex.vx * 0.4; rex.vy = -rex.vy * 0.4; // bounce off
      tone(110, 0.5, 'sawtooth', 0.14, 55); window.setTimeout(() => tone(55, 0.6, 'sawtooth', 0.16, 28), 200);
      showToast('🦖 <b>OM NOM NOM.</b> The T-Rex ate you. You escape, dignity: zero. Coins: also fewer.');
      // Lose a small number of coins (visual shake, actual loss is a taste — not server-authoritative)
      const shakeEl = document.createElement('div');
      shakeEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99990;';
      shakeEl.animate([
        { transform: 'translate(0,0)' }, { transform: 'translate(-8px,4px)' }, { transform: 'translate(10px,-6px)' },
        { transform: 'translate(-6px,8px)' }, { transform: 'translate(4px,-4px)' }, { transform: 'translate(0,0)' },
      ], { duration: 380, easing: 'ease-out' });
      document.body.appendChild(shakeEl);
      window.setTimeout(() => shakeEl.remove(), 400);
      // Push the player away from Rex
      selfX += (dx / Math.max(1, distToPlayer)) * (-80);
      selfY += (dy / Math.max(1, distToPlayer)) * (-80);
    }

    rex.img.setPosition(rex.x, rex.y).setDepth(rex.y + 28);
    rex.nametag.setPosition(rex.x, rex.y - 36).setDepth(rex.y + 30);
  }

  // The Temple: a pale stone sanctuary of the Order of the Eternal Volley — a stepped base, a portico
  // of columns over a dark recessed doorway, a triangular pediment, and a rose window in the tympanum
  // showing the holy Ball arcing over the green Paddle. A golden finial Ball crowns the apex.
  function buildTemple(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    const STONE = 0xe4dcc4, STONE_HI = 0xf3ecd9, STONE_D = 0xc3baa0, STEP = 0xcfc7ad, STEP_D = 0xb0a88e;
    const ROOF = 0x6e5a8a, DOOR = 0x241d30, GOLD = 0xe8c34d, GLASS_D = 0x2a4a86, BALL = 0xffe06a, GLOW = 0xfff3b0, GREEN = 0x46c06a;
    const pedH = Math.round(H * 0.30);                 // pediment (triangle) height
    const colTop = pedH;                                // columns begin under the pediment
    const baseY = H - Math.round(H * 0.12);             // top of the stepped base
    // stepped base (stylobate)
    const stepH = Math.ceil((H - baseY) / 3) + 1;
    for (let s = 0; s < 3; s++) P(s * 3, baseY + s * Math.round((H - baseY) / 3), W - s * 6, stepH, s % 2 ? STEP_D : STEP);
    // dark cella glimpsed behind the colonnade
    const margin = Math.round(W * 0.06), span = W - margin * 2, colY = colTop + 6, colH = baseY - colY;
    P(margin, colY, span, colH, 0x2c2740);
    // Stained-glass lancet windows in the bays flanking the doorway — a leaded mosaic of jewel tones
    // under a gilt pointed arch, glimpsed between the columns. Drawn now so the colonnade overlays them.
    const GLASS = [0xc0392b, 0x2a6fb0, 0x2f8f43, 0xe0a92b, 0x7a3b8f]; // ruby / sapphire / emerald / amber / violet
    const LEAD = 0x141018;
    const lancet = (lcx: number, topY: number, lw: number, lh: number) => {
      const half = Math.round(lw / 2);
      for (let yy = 0; yy <= half; yy++) {             // pointed arch cap
        const hw = half - yy;
        P(lcx - hw - 1, topY - yy, (hw + 1) * 2, 1, GOLD);
        if (hw > 0) P(lcx - hw + 1, topY - yy, hw * 2 - 2, 1, GLASS[yy % GLASS.length]);
      }
      P(lcx - half - 1, topY, lw + 2, lh + 1, GOLD);   // gilt frame
      for (let ry = 0; ry < lh; ry++) for (let rx = 0; rx < lw; rx++) {
        const lead = rx % 3 === 0 || ry % 5 === 0;     // leaded cames between panes
        P(lcx - half + rx, topY + ry, 1, 1, lead ? LEAD : GLASS[(Math.floor(rx / 3) + Math.floor(ry / 5) * 2) % GLASS.length]);
      }
      P(lcx - half + 1, topY + 1, 1, Math.round(lh * 0.5), 0xffffff, 0.22); // a faint glint
    };
    const winW = Math.max(5, Math.round(W * 0.055)), winH = Math.round(colH * 0.6), winTop = colY + Math.round(colH * 0.16);
    for (const f of [0.19, 0.34, 0.66, 0.81]) lancet(Math.round(W * f), winTop, winW, winH);
    // entablature the columns hold up
    P(2, colTop, W - 4, 6, STONE); P(2, colTop, W - 4, 2, STONE_HI); P(2, colTop + 5, W - 4, 1, STONE_D);
    // the colonnade
    const nCols = 6, gap = span / nCols, colW = Math.max(4, Math.round(gap * 0.42));
    for (let i = 0; i < nCols; i++) {
      const cxp = Math.round(margin + gap * (i + 0.5) - colW / 2);
      P(cxp, colY, colW, colH, STONE);
      P(cxp, colY, 1, colH, STONE_HI); P(cxp + colW - 1, colY, 1, colH, STONE_D);
      P(cxp - 1, colY, colW + 2, 2, STONE_HI); P(cxp - 1, baseY - 2, colW + 2, 2, STONE_D); // capital + base
    }
    // recessed doorway between the central columns, gilded
    const dw = Math.round(W * 0.15), dx = Math.round((W - dw) / 2), dh = Math.round(colH * 0.78);
    P(dx, baseY - dh, dw, dh, DOOR);
    P(dx, baseY - dh, dw, 2, GOLD); P(Math.round(W / 2 - 1), baseY - dh + 3, 2, dh - 3, GOLD, 0.45);
    // the pediment (triangle) with a cornice along its base
    for (let y = 0; y < pedH; y++) { const halfw = Math.round((W / 2 - 2) * (y / pedH)); P(W / 2 - halfw, y, halfw * 2, 1, y / pedH > 0.82 ? STONE_D : STONE); }
    P(0, pedH - 2, W, 2, ROOF);
    // the rose window in the tympanum — the holy Ball over the green Paddle, ringed in gold
    const rcx = Math.round(W / 2), rcy = Math.round(pedH * 0.62), rr = Math.max(5, Math.round(pedH * 0.26));
    for (let yy = -rr - 1; yy <= rr + 1; yy++) for (let xx = -rr - 1; xx <= rr + 1; xx++) {
      const d = Math.hypot(xx, yy);
      if (d <= rr + 1 && d > rr - 1.5) P(rcx + xx, rcy + yy, 1, 1, GOLD);       // gilded rim
      else if (d <= rr - 1.5) P(rcx + xx, rcy + yy, 1, 1, GLASS_D);            // blue glass
    }
    P(rcx - 2, rcy - 2, 4, 4, GLOW); P(rcx - 1, rcy - 1, 2, 2, BALL);          // the Ball
    P(rcx - 3, rcy + rr - 3, 6, 2, GREEN);                                     // the Paddle below it
    // Gargoyles hunched on the entablature corners — horned stone beasts jutting outward as
    // waterspouts, wings raised, gripping the cornice. Their eyes get a faint red glow (added live).
    const gargoyleEyes: { ex: number; ey: number }[] = [];
    const gargoyle = (gx: number, gy: number, dir: number) => {
      const GS = 0x8f8672, GSD = 0x726a58, GSH = 0xa89e84;
      P(gx - 4, gy - 7, 8, 8, GS); P(gx - 4, gy - 7, 8, 1, GSH); P(gx - 4, gy, 8, 1, GSD); // hunched body
      P(gx - 2, gy - 13, 7, 7, GSD); P(gx - 2, gy - 13, 7, 1, GS);                         // raised wing
      P(gx + 1, gy - 12, 1, 6, GS); P(gx + 3, gy - 11, 1, 5, GS);                          // wing ribs
      const hx = dir > 0 ? gx + 2 : gx - 8;                                                // head juts outward
      P(hx, gy - 9, 6, 5, GS); P(hx, gy - 9, 6, 1, GSH);
      const snout = dir > 0 ? hx + 6 : hx - 2;
      P(snout, gy - 7, 2, 3, GS); P(dir > 0 ? snout + 1 : snout, gy - 6, 1, 1, LEAD);      // jaw + open mouth
      P(dir > 0 ? hx : hx + 5, gy - 11, 1, 2, GSD);                                        // horn
      P(gx - 4, gy, 2, 2, GSD); P(gx + 2, gy, 2, 2, GSD);                                  // clawed feet
      const eyx = dir > 0 ? hx + 3 : hx + 1, eyy = gy - 8;
      P(eyx, eyy, 1, 1, LEAD);                                                             // eye socket
      gargoyleEyes.push({ ex: eyx, ey: eyy });
    };
    gargoyle(13, colTop + 5, -1);
    gargoyle(W - 13, colTop + 5, 1);
    g.generateTexture('w-temple', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-temple').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);
    // a golden finial Ball crowning the apex, haloed in a slow pulse
    const apexX = b.x + b.w / 2, apexY = b.y - 4;
    const halo = sc.add.circle(apexX, apexY, 12, 0xffe06a, 0.3).setBlendMode(Phaser.BlendModes.ADD).setDepth(depth + 2);
    sc.add.circle(apexX, apexY, 5, 0xfff3b0).setDepth(depth + 3);
    sc.tweens.add({ targets: halo, alpha: 0.6, scale: 1.4, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    // the gargoyles' eyes smoulder a faint red, breathing slowly out of sync
    gargoyleEyes.forEach((e, i) => {
      const eye = sc.add.circle(b.x + (e.ex + 0.5) * TEXEL, b.y + (e.ey + 0.5) * TEXEL, 2.2, 0xff3b1a)
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(depth + 3);
      sc.tweens.add({ targets: eye, alpha: 0.25, duration: 1700 + i * 300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });
    // the venue glyph above the door
    sc.add.text(b.x + b.w / 2, b.y + b.h - TILE * 1.5, b.emoji, { fontSize: '22px' }).setOrigin(0.5, 1).setDepth(b.y + b.h + 2);
  }

  // Parliament: a stately domed capitol in pale marble — a grand central rotunda dome on a columned
  // drum, crowned by a lantern cupola with a gold finial and a slowly waving flag; a projecting
  // portico of fluted columns under a triangular pediment (gilt seal in the tympanum) over a wide
  // flight of steps; flanking wings of tall arched windows. Baked as a facade texture in the
  // buildCasino/buildTemple idiom, with the finial + flag added as live sprites above the roofline.
  function buildParliament(sc: Phaser.Scene, b: WorldBuilding) {
    const W = Math.round(b.w / TEXEL), H = Math.round(b.h / TEXEL);
    const depth = b.y + b.h;
    const g = sc.make.graphics({ x: 0, y: 0 }, false);
    const P = (x: number, y: number, w: number, h: number, c: number, a = 1) => px9(g, x, y, w, h, c, a);
    const MARBLE = 0xece6d4, HI = 0xf7f2e4, MD = 0xd2caae, DD = 0xb6ac8d;
    const STEP = 0xdcd4bc, STEP_D = 0xc0b799, SHADOW = 0x2b2a3a;
    const DOME = 0xe7e1cc, DOME_HI = 0xf4efdc, DOME_D = 0xcfc6aa;
    const GOLD = 0xd9b64a, GOLD_HI = 0xf0d478, DOOR = 0x241f30, GLASS = 0x35597f, GLASS_HI = 0x7aa6cf;

    const cx = Math.round(W / 2);
    const mainTop = Math.round(H * 0.40);              // top of the marble block
    const baseY = H - Math.round(H * 0.11);            // top of the stepped base
    const entH = Math.max(4, Math.round((baseY - mainTop) * 0.14));
    const colTop = mainTop + entH;
    const colH = baseY - colTop;

    // --- the dome (drawn first so the pediment/roof read in front of it) ---
    const domeR = Math.round(W * 0.12);
    const drumH = Math.round(domeR * 0.55);
    const drumW = Math.round(domeR * 1.9);
    const drumTop = mainTop - drumH - 1;
    // colonnaded drum under the dome
    P(cx - Math.round(drumW / 2), drumTop, drumW, drumH + 2, MARBLE);
    P(cx - Math.round(drumW / 2), drumTop, drumW, 1, HI);
    P(cx - Math.round(drumW / 2), drumTop + drumH, drumW, 2, DD);
    for (let i = 0; i < 6; i++) {                      // slim drum pilasters / dark window slits
      const dx = cx - Math.round(drumW / 2) + 2 + Math.round(i * (drumW - 4) / 5);
      P(dx, drumTop + 2, 1, drumH - 3, GLASS);
    }
    // the cupola half-dome
    for (let yy = 0; yy <= domeR; yy++) {
      const halfw = Math.round(Math.sqrt(Math.max(0, domeR * domeR - yy * yy)));
      P(cx - halfw, drumTop - yy, halfw * 2, 1, DOME);
    }
    for (let yy = 0; yy <= domeR; yy++) {              // right-side shading
      const halfw = Math.round(Math.sqrt(Math.max(0, domeR * domeR - yy * yy)));
      const s = Math.round(halfw * 0.4);
      if (halfw - s > 0) P(cx + s, drumTop - yy, halfw - s, 1, DOME_D, 0.45);
    }
    P(cx - Math.round(domeR * 0.55), drumTop - Math.round(domeR * 0.55), 2, Math.round(domeR * 0.6), DOME_HI, 0.5); // sheen
    P(cx - domeR, drumTop - 1, domeR * 2, 2, GOLD);    // gilt ring at the dome base
    // the lantern (cupola) on top of the dome
    const cupW = Math.max(5, Math.round(domeR * 0.5)), cupH = Math.round(domeR * 0.42);
    const cupX = cx - Math.round(cupW / 2), cupY = drumTop - domeR - cupH;
    P(cupX, cupY, cupW, cupH, MARBLE); P(cupX, cupY, cupW, 1, HI); P(cupX, cupY + cupH - 1, cupW, 1, DD);
    for (let yy = 0; yy <= Math.round(cupW / 2); yy++) {   // its little cap
      const halfw = Math.round(Math.sqrt(Math.max(0, (cupW / 2) * (cupW / 2) - yy * yy)));
      P(cx - halfw, cupY - yy, halfw * 2, 1, GOLD);
    }

    // --- marble block, entablature, portico recess ---
    P(0, mainTop, W, baseY - mainTop, MARBLE);
    P(0, mainTop, W, 1, HI);
    P(0, mainTop, W, entH, MARBLE);                    // entablature band
    P(0, mainTop, W, 1, HI); P(0, mainTop + entH - 1, W, 1, DD);
    P(0, mainTop + Math.round(entH * 0.5), W, 1, MD);  // architrave line
    P(0, mainTop + 1, W, 1, GOLD, 0.5);                // gilt cornice fillet

    const portX0 = Math.round(W * 0.27), portX1 = Math.round(W * 0.73), portW = portX1 - portX0;
    P(portX0, colTop, portW, colH, SHADOW);            // shadowed portico interior

    // tall arched windows in the flanking wings
    const winW = Math.max(3, Math.round(W * 0.038)), winTop = colTop + Math.round(colH * 0.16), winH = Math.round(colH * 0.5);
    const wingWindows = (x0: number, x1: number) => {
      const n = 3, seg = (x1 - x0) / n;
      for (let i = 0; i < n; i++) {
        const wx = Math.round(x0 + seg * (i + 0.5) - winW / 2);
        P(wx - 1, winTop - 1, winW + 2, winH + 2, DD);
        P(wx, winTop, winW, winH, GLASS);
        for (let yy = 0; yy <= Math.round(winW / 2); yy++) { // arched top
          const hw = Math.round(Math.sqrt(Math.max(0, (winW / 2) * (winW / 2) - yy * yy)));
          P(wx + Math.round(winW / 2) - hw, winTop - 1 - yy, hw * 2, 1, DD);
          P(wx + Math.round(winW / 2) - hw + 1, winTop - yy, Math.max(0, hw * 2 - 2), 1, GLASS);
        }
        P(wx, winTop, 1, winH, GLASS_HI, 0.7);          // reflection
        P(wx + Math.floor(winW / 2), winTop, 1, winH, DD); // mullion
      }
    };
    wingWindows(Math.round(W * 0.05), portX0 - 3);
    wingWindows(portX1 + 3, W - Math.round(W * 0.05));

    // --- the colonnade across the portico ---
    const nCols = 6, gap = portW / nCols, colW = Math.max(3, Math.round(gap * 0.5));
    for (let i = 0; i < nCols; i++) {
      const cxp = Math.round(portX0 + gap * (i + 0.5) - colW / 2);
      P(cxp, colTop, colW, colH, MARBLE);
      P(cxp, colTop, 1, colH, HI); P(cxp + colW - 1, colTop, 1, colH, DD);
      if (colW >= 4) P(cxp + Math.round(colW * 0.45), colTop + 2, 1, colH - 4, MD, 0.6); // flute
      P(cxp - 1, colTop, colW + 2, 2, HI);              // capital
      P(cxp - 1, baseY - 2, colW + 2, 2, DD);           // base
    }

    // --- the gilded central doorway ---
    const dw = Math.round(W * 0.085), dx = cx - Math.round(dw / 2), dh = Math.round(colH * 0.62);
    P(dx - 1, baseY - dh - 1, dw + 2, dh + 1, GOLD);
    P(dx, baseY - dh, dw, dh, DOOR);
    P(cx - 1, baseY - dh + 2, 1, dh - 2, GOLD, 0.4);    // seam between the double doors

    // --- the pediment (triangle) over the portico, with a gilt seal in the tympanum ---
    const pedHalf = Math.round(portW / 2) + 3, pedH = Math.round(H * 0.15), pedBaseY = mainTop + 1, pedApexY = pedBaseY - pedH;
    for (let y = 0; y <= pedH; y++) {
      const halfw = Math.round(pedHalf * (y / pedH));
      P(cx - halfw, pedApexY + y, halfw * 2, 1, MARBLE);
    }
    P(cx - pedHalf, pedApexY, 1, 1, HI);                // apex highlight
    for (let y = 0; y <= pedH; y++) { const halfw = Math.round(pedHalf * (y / pedH)); P(cx - halfw, pedApexY + y, 1, 1, HI); } // left rake sheen
    P(cx - pedHalf - 2, pedBaseY, pedHalf * 2 + 4, 2, DD);      // cornice
    P(cx - pedHalf - 2, pedBaseY - 1, pedHalf * 2 + 4, 1, HI);
    P(cx - pedHalf - 2, pedBaseY, pedHalf * 2 + 4, 1, GOLD, 0.5);
    const emR = Math.max(3, Math.round(pedH * 0.30)), emY = pedApexY + Math.round(pedH * 0.62);
    for (let yy = -emR - 1; yy <= emR + 1; yy++) for (let xx = -emR - 1; xx <= emR + 1; xx++) {
      const d = Math.hypot(xx, yy);
      if (d <= emR + 1 && d > emR - 1) P(cx + xx, emY + yy, 1, 1, GOLD);        // gilt ring
      else if (d <= emR - 1) P(cx + xx, emY + yy, 1, 1, SHADOW);                // dark field
    }
    P(cx - 1, emY - emR + 1, 2, emR * 2 - 2, GOLD_HI, 0.9);                     // emblem: a gilt cross/star
    P(cx - emR + 1, emY - 1, emR * 2 - 2, 2, GOLD_HI, 0.9);

    // --- grand stepped base (widening toward the ground) ---
    const nSteps = 3, stepBand = Math.max(2, Math.round((H - baseY) / nSteps) + 1);
    for (let s = 0; s < nSteps; s++) {
      const inset = (nSteps - 1 - s) * 3;
      const sy = baseY + s * Math.round((H - baseY) / nSteps);
      P(inset, sy, W - inset * 2, stepBand, s % 2 ? STEP_D : STEP);
      P(inset, sy, W - inset * 2, 1, HI);
    }

    g.generateTexture('w-parliament', W, H);
    g.destroy();
    sc.add.image(b.x, b.y, 'w-parliament').setOrigin(0, 0).setScale(TEXEL).setDepth(depth);

    // Live crown: a gold finial ball on a pole above the lantern, flying a flag that gently waves.
    const poleX = b.x + cx * TEXEL;
    const poleTopY = b.y + (cupY - Math.round(cupW / 2)) * TEXEL - 4; // just above the lantern cap
    const finialY = poleTopY - 18;
    sc.add.rectangle(poleX, poleTopY, 2, poleTopY - finialY, 0xb9932f).setOrigin(0.5, 1).setDepth(depth + 2);
    const halo = sc.add.circle(poleX, finialY, 8, 0xffe9a6, 0.28).setBlendMode(Phaser.BlendModes.ADD).setDepth(depth + 2);
    sc.add.circle(poleX, finialY, 3, 0xfff0c0).setDepth(depth + 3);
    sc.tweens.add({ targets: halo, alpha: 0.55, scale: 1.4, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    const flag = sc.add.rectangle(poleX + 1, finialY + 3, 18, 11, 0xc0392b).setOrigin(0, 0).setDepth(depth + 3);
    flag.setStrokeStyle(1, 0x8f2a20);
    sc.tweens.add({ targets: flag, scaleX: 0.82, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // the venue glyph above the door
    sc.add.text(b.x + b.w / 2, b.y + b.h - TILE * 1.4, b.emoji, { fontSize: '22px' })
      .setOrigin(0.5, 1).setDepth(b.y + b.h + 2);
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
        else if (b.kind === 'dungeon') buildRuins(sc, b);
        else if (b.kind === 'temple') buildTemple(sc, b);
        else if (b.kind === 'parliament') buildParliament(sc, b);
        else if (b.kind === 'mcdonald') buildMcDonald(sc, b);
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
          // The house emoji sits on the pad, anchored at its base so the avatar can pass behind it.
          // Depth tracks its foot (p.cy + a touch) so it sorts among avatars/props by y like everything else.
          const house = sc.add.text(p.cx, p.cy + p.h / 2 - 8, '', {
            fontFamily: 'system-ui, sans-serif', fontSize: '52px', resolution: 2,
          });
          house.setOrigin(0.5, 1).setDepth(p.cy + p.h / 2 - 8).setVisible(false);
          parcelGfx.set(p.id, { pad, sign, house });
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

      // --- T-Rex: spawns after 45 seconds so players settle in before it shows up ---
      window.setTimeout(() => { if (petScene) spawnRex(petScene); }, 45_000);

      // --- our own avatar ---
      petScene = sc; // remember the scene so pet sprites can be spawned on demand in update()
      self = makeAvatar(sc, net.name() || 'you', net.color());
      // a golden halo that haloes you while the Blessing of the Ball is upon you (alpha set per-frame)
      selfAura = sc.add.circle(selfX, selfY, R + 12, 0xffe06a, 0).setBlendMode(Phaser.BlendModes.ADD);
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
          const baseZoom = inInterior ? curZoom : inDungeon ? DUNGEON_ZOOM : ZOOM * userZoom; // cozy in the Tavern/Temple, close-in in the dungeon; player zoom out in the open world
          const freeze = mcFreezeUntil > now ? (mcFreezeUntil - now) / 2800 : 0; // 0→1 McFlurry brain-freeze
          mainCam.setRotation(drunk > 0 ? Math.sin(w * 1.1) * 0.012 * drunk : freeze > 0 ? Math.sin(w * 4.5) * 0.018 * freeze : 0);
          mainCam.setZoom(drunk > 0 ? baseZoom * (1 + Math.sin(w * 0.8) * 0.02 * drunk) : freeze > 0 ? baseZoom * (1 + Math.sin(w * 3.2) * 0.015 * freeze) : baseZoom);
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
        driving = false; vx = vy = 0; handbrake = false; keys.clear(); joyActive = false;
        if (jailedNow) { selfX = JAIL.x + JAIL.w / 2; selfY = JAIL.y + JAIL.h / 2; }
        else { selfX = JAIL.x + JAIL.w / 2; selfY = JAIL.y + JAIL.h + R + 18; } // released out front
        jailBanner.style.display = jailedNow ? 'flex' : 'none';
      }

      if (!dialogOpen && !talkOpen && now >= stunnedUntil) {
        const boat = boating ? myBoat() : null;
        const car = !boating && driving ? myCar() : null;
        if (boat) stepBoat(boat, dt);
        else if (boating) { boating = false; boatWater = null; } // lost the boat — bail out of the mode
        else if (car) stepCar(car, dt);
        else stepFoot(dt);
      }

      checkCarCrash(now);
      updateNpcs(now, dt);
      updateRex(now, dt);
      updateNearBuilding();
      maybeSendMove(now);

      // show the touch fire button only out in the open world
      const canRocket = !inInterior && !inDungeon && !boating && !net.amJailed();
      if (fireBtnShown !== canRocket) { fireBtnShown = canRocket; fireBtn.style.display = canRocket ? 'block' : 'none'; }

      // place our avatar straight from authoritative state (zero latency)
      if (self) { placeAvatar(self, selfX, selfY, facing, boating ? net.boat() : driving ? net.car() : null, net.color(), net.name() || 'you'); applySay(self, net.selfId(), now); }

      // The Blessing of the Ball: a pulsing golden halo behind you + a draining HUD badge, both fading
      // as the swiftness wears off.
      {
        const bf = blessFrac();
        if (selfAura) {
          if (bf > 0) {
            const pulse = 0.5 + 0.5 * Math.sin(now / 220);
            selfAura.setPosition(selfX, selfY).setDepth(selfY - 1)
              .setRadius((R + 10 + pulse * 4))
              .setFillStyle(0xffe06a, (0.12 + 0.16 * pulse) * Math.min(1, bf + 0.25));
          } else if (selfAura.fillAlpha !== 0) {
            selfAura.setFillStyle(0xffe06a, 0);
          }
        }
        if (bf > 0) { blessBadge.style.display = 'block'; if (blessBar) blessBar.style.width = (bf * 100).toFixed(1) + '%'; }
        else if (blessBadge.style.display !== 'none') blessBadge.style.display = 'none';
      }

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
        placeAvatar(av, av.rx, av.ry, av.ra, a.car ?? null, a.color, a.name);
        applySay(av, a.id, now); // pop their speech bubble if they've said something recently
      }
      // drop avatars that left
      for (const [id, av] of remote) if (!seen.has(id)) { av.c.destroy(); remote.delete(id); }

      updatePets(dt);
      updateSmoke(dt);
      updateSkids(dt);
      updateRockets(dt);
      updateBoom(dt);

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

  // --- DRIFT RUBBER: dark streaks burned into the tarmac at the rear wheels while you slide, plus a
  // tyre-smoke puff and a screech. The marks linger on the ground, then slowly fade. ---
  const skidMarks: { spr: Phaser.GameObjects.Image; t: number; max: number }[] = [];
  function layRubber(x: number, y: number, ang: number) {
    const sc = petScene; if (!sc || skidMarks.length > 240) return;
    const spr = sc.add.image(x, y, 'w-shadow').setScale(TEXEL * 0.95, TEXEL * 0.5).setRotation(ang)
      .setTint(0x0b0b0d).setAlpha(0.5).setDepth(2); // depth 2 → on the ground, under every avatar
    skidMarks.push({ spr, t: 0, max: 4.5 + Math.random() });
  }
  function emitSkid() {
    skidSound();
    const now = performance.now();
    if (now - lastSkidMarkAt > 26) {
      lastSkidMarkAt = now;
      const bx = selfX - Math.cos(facing) * CAR_LEN * 0.32, by = selfY - Math.sin(facing) * CAR_LEN * 0.32;
      const ox = -Math.sin(facing) * CAR_WID * 0.34, oy = Math.cos(facing) * CAR_WID * 0.34;
      layRubber(bx + ox, by + oy, facing);
      layRubber(bx - ox, by - oy, facing);
    }
    const sc = petScene;
    if (sc && smokePuffs.length < 80) {
      const bx = selfX - Math.cos(facing) * CAR_LEN * 0.4, by = selfY - Math.sin(facing) * CAR_LEN * 0.4;
      smokePuffs.push({
        spr: sc.add.image(bx, by, 'w-smoke').setScale(0.6).setTint(0xc8c8c8).setAlpha(0.5).setDepth(by - 2),
        t: 0, max: 0.45 + Math.random() * 0.3,
        vx: -Math.cos(facing) * 18 + (Math.random() - 0.5) * 34, vy: -Math.sin(facing) * 18 + (Math.random() - 0.5) * 34,
      });
    }
  }
  function updateSkids(dt: number) {
    for (let i = skidMarks.length - 1; i >= 0; i--) {
      const m = skidMarks[i]; m.t += dt; const k = m.t / m.max;
      if (k >= 1) { m.spr.destroy(); skidMarks.splice(i, 1); continue; }
      if (k > 0.6) m.spr.setAlpha(0.5 * (1 - (k - 0.6) / 0.4)); // hold, then fade over the last 40%
    }
  }

  // --- CAR CRASH FIREBALL: a one-shot burst of additive fire particles, a bright central flash, and
  // a rising cloud of black smoke. Pure synthesized sprites (w-fireball + w-smoke), animated here. ---
  const boomParts: { spr: Phaser.GameObjects.Image; t: number; max: number; vx: number; vy: number; kind: 'fire' | 'flash' | 'smoke'; r0: number; r1: number }[] = [];
  const FIRE_TINTS = [0xffffff, 0xffe066, 0xffae34, 0xff5722];
  function spawnExplosion(x: number, y: number) {
    const sc = petScene; if (!sc) return;
    boomSound();
    // central white flash — short, bright, ADD-blended
    boomParts.push({ spr: sc.add.image(x, y, 'w-fireball').setDepth(y + 400).setBlendMode(Phaser.BlendModes.ADD).setScale(2), t: 0, max: 0.16, vx: 0, vy: 0, kind: 'flash', r0: 2.2, r1: 6 });
    // a fat ball of fire flung outward
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 190;
      const spr = sc.add.image(x, y, 'w-fireball').setDepth(y + 300).setBlendMode(Phaser.BlendModes.ADD).setTint(FIRE_TINTS[i % FIRE_TINTS.length]);
      boomParts.push({ spr, t: 0, max: 0.4 + Math.random() * 0.45, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, kind: 'fire', r0: 1.3 + Math.random() * 1.4, r1: 0.15 });
    }
    // billowing black smoke that lingers and rises
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, sp = 18 + Math.random() * 75;
      const spr = sc.add.image(x, y, 'w-smoke').setDepth(y + 60).setTint(0x2a2a2a).setAlpha(0);
      boomParts.push({ spr, t: 0, max: 0.9 + Math.random() * 0.9, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 55, kind: 'smoke', r0: 0.5, r1: 2.8 });
    }
  }
  function updateBoom(dt: number) {
    for (let i = boomParts.length - 1; i >= 0; i--) {
      const p = boomParts[i]; p.t += dt; const k = p.t / p.max;
      if (k >= 1) { p.spr.destroy(); boomParts.splice(i, 1); continue; }
      p.spr.x += p.vx * dt; p.spr.y += p.vy * dt; p.vx *= 0.9; p.vy *= 0.9;
      const r = p.r0 + (p.r1 - p.r0) * k;
      if (p.kind === 'flash') p.spr.setScale(r).setAlpha(1 - k);
      else if (p.kind === 'fire') p.spr.setScale(Math.max(0.05, r)).setAlpha(1 - k * k);
      else p.spr.setScale(r).setAlpha(0.55 * Math.sin(Math.min(1, k * 1.5) * Math.PI)).setDepth(p.spr.y + 60);
    }
  }

  // ============================================================================================
  // ROCKET LAUNCHER 🚀 — fire with R (or the on-screen button); a missile streaks out along your
  // heading and detonates on the first thing it hits (building, townsperson, car, or another player)
  // or when it runs out of fuel. The blast squishes nearby townsfolk, blows up cars, and knocks
  // people off their feet — and is broadcast so EVERYONE sees the fireball and takes the hit.
  // ============================================================================================
  // `ghost` rockets are other players' missiles, mirrored from a `worldRocket` broadcast — purely
  // cosmetic (they fly + trail smoke but never detonate or deal a blast; the firer owns that and
  // sends the authoritative `worldBoom`).
  interface Rocket { spr: Phaser.GameObjects.Image; x: number; y: number; vx: number; vy: number; t: number; ghost: boolean; }
  const rockets: Rocket[] = [];
  const ROCKET_SPEED = 640, ROCKET_LIFE = 1.7, BLAST_R = 96;

  function spawnRocketSprite(x: number, y: number, a: number, ghost: boolean) {
    const sc = petScene; if (!sc) return;
    const spr = sc.add.image(x, y, 'w-rocket').setScale(TEXEL * 1.2).setRotation(a).setDepth(y + 8);
    rockets.push({ spr, x, y, vx: Math.cos(a) * ROCKET_SPEED, vy: Math.sin(a) * ROCKET_SPEED, t: 0, ghost });
  }

  function fireRocket() {
    const sc = petScene; if (!sc) return;
    const now = performance.now();
    if (now - lastRocketAt < 850) return;                                  // cooldown
    if (inInterior || inDungeon || boating || net.amJailed() || talkOpen || dialogOpen || chatActive || sayActive) return;
    if (now < stunnedUntil) return;                                        // can't fire while flattened
    lastRocketAt = now;
    const hx = Math.cos(facing), hy = Math.sin(facing);
    const muzzle = (driving ? CAR_LEN * 0.55 : R) + 12;                    // spawn ahead so you don't eat your own blast
    const x = selfX + hx * muzzle, y = selfY + hy * muzzle;
    spawnRocketSprite(x, y, facing, false);
    net.rocket(x, y, facing);                                              // let everyone else watch it fly
    rocketLaunchSound();
  }
  // A remote player's rocket (from a `worldRocket` broadcast) — render it streaking across our screen.
  function feedRocket(x: number, y: number, a: number) {
    if (inInterior || inDungeon) return; // not visible from inside a room/the Ruins
    spawnRocketSprite(x, y, a, true);
    if (Math.hypot(x - selfX, y - selfY) < 850) rocketLaunchSound(); // only nearby launches are audible
  }

  function detonateRocket(x: number, y: number) {
    spawnExplosion(x, y);              // local fireball + boom (spawnExplosion plays the boom sound)
    net.boom(x, y, BLAST_R);          // fan a DAMAGING blast out to everyone else
    applyBlast(x, y, BLAST_R, true);  // and apply it to our own world (NPCs, our car/self) — our own rocket
  }

  // Resolve a blast at (x,y): flatten townsfolk in range; if WE are caught, our car blows up (driving)
  // or we get knocked off our feet (on foot). Runs on the firer locally AND on every receiver.
  // mine=true → the rocket was ours; shooterPid → for Road Rage kill attribution.
  function applyBlast(x: number, y: number, r: number, mine: boolean, shooterPid?: string) {
    const now = performance.now();
    for (const n of npcs) {
      if (now < n.squishedUntil) continue;
      if (Math.hypot(n.x - x, n.y - y) > r) continue;
      n.squishedUntil = now + 2600 + Math.random() * 1400;
      n.getUpUntil = 0; n.walking = false; n.label.setText('💫');
      squishSound();
    }
    if (Math.hypot(selfX - x, selfY - y) <= r) {
      if (driving) {
        if (blowUpMyCar('💥 Your car took a direct hit — summon a fresh one anytime.')) net.blownUp(true, mine, mine ? undefined : shooterPid);
      } else if (now >= stunnedUntil && !inInterior && !inDungeon) {
        stunnedUntil = now + 2300; keys.clear();
        flashHelp('💥 Blown off your feet!');
        net.blownUp(false, mine, mine ? undefined : shooterPid);
      }
    }
    if (mainCam) {
      const d = Math.hypot(x - selfX, y - selfY);
      if (d < 420) mainCam.shake(280, 0.013 * Math.max(0.25, 1 - d / 420)); // closer blast → harder shake
    }
  }

  function updateRockets(dt: number) {
    const sc = petScene; if (!sc) return;
    const now = performance.now();
    const selfId = net.selfId();
    for (let i = rockets.length - 1; i >= 0; i--) {
      const rk = rockets[i];
      rk.t += dt;
      rk.x += rk.vx * dt; rk.y += rk.vy * dt;
      rk.spr.setPosition(rk.x, rk.y).setDepth(rk.y + 8);
      // a thin smoke trail (reuses the smoke-puff pool/updater)
      if (smokePuffs.length < 90) {
        smokePuffs.push({ spr: sc.add.image(rk.x, rk.y, 'w-smoke').setScale(0.35).setTint(0xdadada).setAlpha(0.45).setDepth(rk.y - 2),
          t: 0, max: 0.4, vx: (Math.random() - 0.5) * 24, vy: (Math.random() - 0.5) * 24 });
      }
      let hit = rk.t >= ROCKET_LIFE;                                       // fuel ran out
      if (!hit && resolveCollisions(rk.x, rk.y, 4).hit) hit = true;        // slammed a building/wall
      if (!hit && (rk.x < 8 || rk.y < 8 || rk.x > WORLD.w - 8 || rk.y > WORLD.h - 8)) hit = true; // off the map edge
      // Ghost (remote) rockets never detonate or deal a blast — they just fly until they hit a
      // wall/edge/fuel-out, then vanish (the firer's own worldBoom drives the actual explosion).
      if (rk.ghost) { if (hit) { rk.spr.destroy(); rockets.splice(i, 1); } continue; }
      if (!hit) for (const n of npcs) { if (now >= n.squishedUntil && Math.hypot(n.x - rk.x, n.y - rk.y) < R + 4) { hit = true; break; } }
      if (!hit) for (const a of others) {                                  // a car or a person downrange
        if (a.id === selfId) continue;
        if (Math.hypot(a.x - rk.x, a.y - rk.y) < (a.car ? CAR_LEN * 0.5 : R * 1.3)) { hit = true; break; }
      }
      if (hit) { rk.spr.destroy(); rockets.splice(i, 1); detonateRocket(rk.x, rk.y); }
    }
  }
  // Clean up any ghost rocket near a blast we just received, so a mirrored missile doesn't keep
  // flying past the point where its owner actually detonated it (on an NPC/player we don't share).
  function clearGhostRocketsNear(x: number, y: number, r: number) {
    for (let i = rockets.length - 1; i >= 0; i--) {
      const rk = rockets[i];
      if (rk.ghost && Math.hypot(rk.x - x, rk.y - y) <= r + 40) { rk.spr.destroy(); rockets.splice(i, 1); }
    }
  }

  // Two cars colliding → a huge fireball, and BOTH drivers bail out onto their feet. This is detected
  // independently on each client (the condition is symmetric: I'm driving + you're in a car + we
  // overlap), so both sides blow up and dismount in lockstep. Hop back in any time — your car's fine.
  let lastCarCrashAt = 0;
  // Blow up the car YOU'RE driving, right where you are: a fireball on your own screen, the same
  // fireball broadcast to everyone else, and you're tipped back out onto your feet. Your car is
  // unharmed — press drive to summon it again. Used by both crash paths below.
  function blowUpMyCar(reason: string): boolean {
    const now = performance.now();
    if (!driving || now - lastCarCrashAt < 1200) return false; // already on foot / just blew up — don't double-pop
    lastCarCrashAt = now;
    spawnExplosion(selfX, selfY);     // instant local fireball (others get it via the broadcast below)
    net.boom(selfX, selfY);           // → server fans this fireball out to everyone else in the world
    driving = false; vx = 0; vy = 0; handbrake = false;
    keys.clear();
    syncDriveBtn();
    flashHelp(reason);
    return true;
  }
  // Two cars touching → BOTH explode. Detection is symmetric, so each client blows up its OWN car
  // (one fireball per car, every one of them broadcast) — net result: two fireballs, seen by all.
  function checkCarCrash(now: number) {
    if (!driving || boating) return;
    if (now - lastCarCrashAt < 1200) return;      // don't re-detonate the same pile-up every frame
    const selfId = net.selfId();
    const reach = CAR_LEN * 0.8;                  // two car bodies pressed together
    for (const a of others) {
      if (a.id === selfId || !a.car || a.car === 'car-boat') continue; // foot/boat avatars don't crash
      if (Math.hypot(a.x - selfX, a.y - selfY) > reach) continue;
      blowUpMyCar('💥 KABOOM! Your cars collided — hop back in whenever you like.');
      break;
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
        if (ps.x < ox - 6) ps.sprite.setFlipX(true); else if (ps.x > ox + 6) ps.sprite.setFlipX(false); // always turn to face you (sprite faces left by default)
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
      } else if (ps.kind === 'slime') {
        // Breathe: a gentle squash-stretch pulse (wider as it flattens), like it's a living blob.
        const b = Math.sin(performance.now() / 520) * 0.09;
        ps.sprite.setScale(TEXEL * (1 + b), TEXEL * (1 - b));
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
    return { c, person, car, carBody, carRoof, carWheels, label, bubble, bubbleBg, bubbleNextAt: 0, rx: selfX, ry: selfY, ra: 0, smokeT: 0, sx: selfX, sy: selfY };
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
        av.bubble.setColor(s.purple ? SAY_COLOR : CHAT_COLOR); // purple for /Say (Y), yellow for chat (T)
        av.bubble.setVisible(true);
        drawBubbleBg(av);          // re-fit the pill whenever the text (and thus its size) changes
        av.bubbleBg.setVisible(true);
      }
    } else {
      if (s) says.delete(id);
      if (av.bubble.visible) { av.bubble.setVisible(false); av.bubbleBg.setVisible(false); }
    }
  }

  // vehicleId: the car/boat id being driven, or null when on foot (then the person sprite shows).
  function placeAvatar(av: Av, x: number, y: number, a: number, vehicleId: string | null, color: string, name: string) {
    av.c.setPosition(x, y).setDepth(y);
    if (av.label.text !== name) av.label.setText(name);
    const tint = hexToInt(color);
    const inVehicle = !!vehicleId;
    av.person.setVisible(!inVehicle).setTint(tint);
    av.car.setVisible(inVehicle);
    if (inVehicle) {
      av.car.setRotation(a);
      const spec = carById(vehicleId);
      const monster = spec?.id === 'car-monster';
      const boat = spec?.id === 'car-boat';
      av.carWheels.setVisible(monster);
      av.carBody.setTexture(monster ? 'w-monster-body' : boat ? 'w-boat-body' : 'w-car-body');
      av.carRoof.setTexture(monster ? 'w-monster-roof' : boat ? 'w-boat-roof' : 'w-car-roof');
      // The yacht is painted in full colour, so render it untinted; cars tint to their paint job.
      av.carBody.setTint(boat ? 0xffffff : spec ? hexToInt(spec.body) : tint);
      av.carRoof.setTint(boat ? 0xffffff : spec ? hexToInt(spec.accent) : 0xffffff);
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
    } else if (def.kind === 'dorito') {
      parts = [sc.add.image(0, 0, 'w-dorito').setScale(TEXEL * 1.25).setOrigin(0.5, 0.95)];
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
    const isFriend = !!def.friendKey;
    const label = sc.add.text(0, -R - 26, def.name,
      isFriend ? { ...NAME_STYLE, color: '#ffb8d8' } : NAME_STYLE,
    ).setOrigin(0.5, 1);
    const heart = isFriend
      ? sc.add.text(0, -R - 46, '💕', {
          fontFamily: 'system-ui, sans-serif', fontSize: '13px',
          stroke: '#0b1020', strokeThickness: 3, resolution: 2,
        }).setOrigin(0.5, 1)
      : undefined;
    const c = sc.add.container(def.x, def.y, heart ? [shadow, bob, label, heart] : [shadow, bob, label]);
    return { def, x: def.x, y: def.y, tx: def.x, ty: def.y, pauseUntil: 0, faceLeft: false, walking: false, lineIdx: 0, c, bob, label, heart, squishedUntil: 0, getUpUntil: 0 };
  }

  function updateNpcs(now: number, dt: number) {
    for (const n of npcs) {
      // --- run-over slapstick: flattened, then a springy "get back up" pop ---
      if (now < n.squishedUntil) {
        n.walking = false;
        n.c.setPosition(n.x, n.y).setDepth(n.y);
        n.bob.scaleX = (n.faceLeft ? -1 : 1) * 1.65; // splayed wide…
        n.bob.scaleY = 0.16;                          // …and squashed flat to the ground
        n.bob.y = 0;
        continue;
      }
      if (n.squishedUntil !== 0) {
        // just got up: kick off the spring-back pose, shake off the stars, wander somewhere new
        n.squishedUntil = 0;
        n.getUpUntil = now + 380;
        n.label.setText(n.def.name);
        n.pauseUntil = now + 300;
        n.tx = n.def.x; n.ty = n.def.y;
        getUpSound();
      }
      if (now < n.getUpUntil) {
        // ease from squashed → a slight overshoot stretch → normal, for a bouncy recovery
        const p = 1 - (n.getUpUntil - now) / 380;     // 0→1
        const stretch = Math.sin(p * Math.PI);        // 0→1→0 bump
        n.c.setPosition(n.x, n.y).setDepth(n.y);
        n.bob.scaleX = (n.faceLeft ? -1 : 1) * (1 + 0.3 * (1 - p) - 0.12 * stretch);
        n.bob.scaleY = 0.2 + 0.8 * p + 0.18 * stretch;
        n.bob.y = -2 * stretch;                       // a little hop as they spring up
        continue;
      }
      n.bob.scaleY = 1; // ensure the pancake pose is fully cleared once recovered
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
      if (n.heart) {
        n.heart.y = -R - 46 + Math.sin(now / 650) * 3.5;
        n.heart.setAlpha(0.7 + 0.3 * Math.sin(now / 650));
      }
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
    setTavernMusic(false); tavernMusic = null;
    stopChant(); inInterior = false; inTemple = false; inMcdonald = false; inCasino = false;
    rex?.img.destroy(); rex?.nametag.destroy(); rex = null;
    try { void actx?.close(); } catch { /* ignore */ }
    actx = null;
    overlay.remove();
    rrHud?.remove(); rrHud = null;
    controller = null;
    _exitWorld = null;
    _pauseWorld = null;
    _resumeWorld = null;
    net.leave();
    net.onExit();
  }
  _exitWorld = exit;

  // Delegating to a Casino/Bank/Shop panel or a lazy-loaded minigame: hide + freeze World instead
  // of tearing it down, so main.ts can bring it straight back (same position, same everything)
  // once that panel/game closes — see main.ts's watchWorldDelegate().
  function pause() {
    if (paused) return;
    paused = true;
    keys.clear(); joyActive = false; handbrake = false;
    dialogOpen = false; dialog.style.display = 'none'; // don't resume back into the dialog that sent us here
    game?.loop.sleep();
    overlay.style.display = 'none';
  }
  function resume() {
    if (!paused) return;
    paused = false;
    overlay.style.display = '';
    game?.loop.wake();
    game?.scale.refresh(); // the canvas measured 0×0 while display:none — recompute now it's visible
    updateNearBuilding(); // refresh the door/interact prompt immediately, don't wait a frame
  }
  _pauseWorld = pause;
  _resumeWorld = resume;

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
    feedSay(id, _name, text, say) {
      const now = performance.now();
      for (const [k, v] of says) if (v.until <= now) says.delete(k); // drop stale lines (e.g. speakers who left)
      says.set(id, { text, until: now + SAY_MS, purple: say });
    },
    feedBoom(x, y, r, shooterPid) { spawnExplosion(x, y); if (r && r > 0) { clearGhostRocketsNear(x, y, r); applyBlast(x, y, r, false, shooterPid); } },
    feedRocket(x, y, a) { feedRocket(x, y, a); },
    feedChat(line) { pushChatLine(line); },
    feedRoadRage(active: boolean, endsAt: number, standings: { name: string; kills: number }[]) {
      rrActive = active; rrEndsAt = endsAt; rrStandings = standings;
      updateRoadRageHud();
      if (!active) { rrHud?.remove(); rrHud = null; }
    },
    feedMcFood(item: string, granted: boolean, _bonus?: number) {
      if (!granted) return;
      if (item === 'fries') {
        // 30-second speed boost using the blessing window (shorter than the Temple blessing)
        blessStart = Date.now(); blessEnd = blessStart + 30_000;
        tone(659, 0.15, 'sine', 0.10, 587); window.setTimeout(() => tone(880, 0.2, 'sine', 0.12, 1047), 150);
        showToast('🍟 <b>Hot fries!</b> Legs feel like rockets. <i>+speed 30s</i>');
      } else if (item === 'mcflurry') {
        // Brain freeze: short screen flash white-blue + camera wobble
        mcFreezeUntil = Date.now() + 2800;
        tone(220, 0.3, 'sawtooth', 0.06, 110);
        showToast('🥤 <b>BRAIN FREEZE.</b> Everything is cold and beautiful and wrong.');
        const flashEl = document.createElement('div');
        flashEl.style.cssText = 'position:fixed;inset:0;background:rgba(200,230,255,0.72);z-index:99990;pointer-events:none;transition:opacity 2.5s ease';
        document.body.appendChild(flashEl);
        requestAnimationFrame(() => { flashEl.style.opacity = '0'; });
        window.setTimeout(() => flashEl.remove(), 3000);
      } else if (item === 'bigmac') {
        tone(523, 0.2, 'sine', 0.10, 392); window.setTimeout(() => tone(659, 0.3, 'sine', 0.12, 784), 200);
        showToast('🍔 <b>Big Mac.</b> Two all-beef patties. Power courses through you. (+60🪙 in the bag)');
      } else if (item === 'happymeal') {
        tone(784, 0.15, 'sine', 0.10, 1047); window.setTimeout(() => tone(1047, 0.25, 'sine', 0.12, 1047), 170);
        // Effect varies by bonus amount
        if (_bonus && _bonus >= 200) spawnMcConfetti();
      }
    },
    feedEloProfile(msg) { renderEloProfile(msg); },
    feedBalanceSheet(msg) { renderBalanceSheet(msg); },
  };
  syncDriveBtn();
  net.enter();
}
