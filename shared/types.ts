// Shared contracts and constants used by both the server and the browser client.
// Court coordinates are in abstract "court units" (not pixels); the client scales
// its canvas to this logical size, so both ends agree on geometry.

export const COURT = { w: 800, h: 500 } as const;

export const PADDLE = {
  w: 14, // paddle thickness
  h: 90, // paddle length
  margin: 24, // distance of paddle center from its wall
  speed: 900, // max paddle travel, court units / second
} as const;

export const BALL = {
  r: 9,
  speed: 480, // serve speed, court units / second
  speedup: 1.05, // multiplier applied on each paddle hit (no upper cap)
} as const;

// "Closing walls" mode: each paddle hit drags both paddles a step toward center.
export const CLOSING = {
  step: 12, // court units each paddle slides inward per paddle hit
  minGap: 200, // closest the two paddle faces may get (court units between faces)
} as const;

export const WIN_SCORE = 3;
export const TEAM_MAX = 4; // max players (paddles) per side

// "Arena" mode: a free-for-all on a regular polygon. Each player owns one edge; the
// court grows a side per player (2 = the classic box, 3 = triangle, 4 = square, …,
// 8 = octagon / stop sign). Last player standing wins (ball past your edge = out).
export const MAX_PLAYERS = 8; // arena seat cap
export const ARENA = {
  cx: COURT.w / 2,
  cy: COURT.h / 2,
  radius: 260, // circumradius of the polygon, court units (near-fills the 500-tall court)
} as const;
export const POLY_PADDLE_LEN = 64; // arena paddle length along its edge, court units
// Power-ups that make sense in a free-for-all (per-player or global only — nothing that
// targets a single "opponent", which is ambiguous with more than two players).
export const POLY_POWERUPS = [
  'grow', 'smash', 'slow', 'multi', 'curve', 'shield', 'ghost', 'tiny', 'warp', 'bigball',
] as const;

// "Layered teams" mode: teammates don't share a plane — each later joiner plays a
// step further forward (toward mid-court) than the one before, by join order.
export const LAYERED = {
  step: 70, // court units each teammate sits forward of the previous one
  cap: 60, // closest a forward paddle face may get to mid-court
} as const;
export const PADDLE_BOOST = 1.5; // paddle height multiplier while "grow" is active
export const PADDLE_SHRINK = 0.6; // opponent paddle height multiplier while "shrink" is active
export const SMASH_BONUS = 1.35; // extra ball-speed multiplier applied on each "smash" hit
export const SLOW_SCALE = 0.6; // ball-speed multiplier during "slow" motion
export const SLOW_TIME = 4; // seconds a "slow" power-up lasts
export const MULTI_MAX = 2; // max simultaneous extra balls from "multi"
export const POWERUP_HITS = 3; // hits a per-hit power-up (grow/shrink/smash) lasts
export const FREEZE_TIME = 2; // seconds the opponent paddle is locked
export const BLIND_TIME = 3; // seconds the opponent's view is obscured
export const MIRROR_TIME = 3; // seconds the opponent's controls are inverted
export const GHOST_TIME = 3; // seconds the ball is invisible
export const TINY_TIME = 5; // seconds the ball is rendered tiny
export const BIG_BALL_TIME = 6; // seconds the ball is enlarged
export const BIG_BALL_R = 36; // enlarged ball radius (4× normal)
// "Blaster" power-up: collect it for a few shots, then click to fire an aimable projectile.
// A hit temporarily disables (locks) the opponent's paddle. 2D-only (mouse-aimed).
export const BLASTER = {
  ammo: 2, // shots granted per pickup
  speed: 720, // projectile speed, court units / second
  r: 7, // projectile radius
  life: 2.2, // seconds a projectile lives before fizzling
  disable: 2.5, // seconds the hit paddle is locked
  maxAngle: Math.PI / 3, // ± aim cone off straight-across
} as const;
export const CURVE_SPIN = 1.4; // spin (rad/s) applied to the ball on a curve hit
// "Roam" power-up: the paddle can push inward off its wall for a limited number of hits.
// `maxInset` is how far toward center it can travel; `hits` is how many paddle contacts it lasts.
export const ROAM = {
  maxInset: 180, // court units the paddle can push inward from its default wall position
  hits: 5,       // paddle contacts the roam power-up lasts
} as const;
// Spectator-dropped obstacle blocks: solid axis-aligned boxes that deflect the ball.
// Blocks accumulate during a match (up to `maxCount`) and clear at the next match start.
export const BLOCK = {
  maxCount: 4, // most blocks allowed on the court at once
  min: 40,     // minimum block side length, court units
  max: 80,     // maximum block side length, court units
} as const;
// "Breakout" mode: a single column of bricks runs down the centre of the court.
// 1 column × 22 rows of 18×18 bricks with 4-unit gaps.
// Total 22 bricks. Wall is centred at x=400 in the 800×500 court.
// Ball phases through the wall until the first paddle hit (lastHit !== null).
export const BREAKOUT = {
  cols: 1,
  rows: 22,
  w: 18,   // brick width, court units
  h: 18,   // brick height, court units
  gap: 4,  // gap between bricks
  left: 391,   // (800 - 18) / 2
  top:  10,    // (500 - (22*22 - 4)) / 2  →  (500-480)/2
} as const;

export const GRAVITY_ACCEL = 220; // court units/sec² downward pull in gravity mode
export const TURBO_SPEED_MULT = 1.5; // serve speed multiplier in turbo mode
export const TURBO_SPEEDUP = 1.1; // per-hit speedup in turbo mode (vs BALL.speedup = 1.05)
// "Diamond hands" mode: a blue-and-white diamond drifts around the court (bouncing off
// the walls) and the ball caroms off its 45° faces.
export const DIAMOND = {
  r: 42, // half-diagonal, court units (vertices sit this far from center along each axis)
  speed: 150, // drift speed, court units / second
} as const;

// "Piñata" mode: a beach-ball collector drifts around the court. A ball that touches it
// sticks to its surface and a fresh ball spawns into play; the moment a 5th ball would
// stick, the piñata bursts and flings every stuck ball outward at once.
export const PINATA = {
  r: 40, // beach-ball radius, court units
  speed: 130, // drift speed, court units / second
  spin: 0.9, // visual rotation, rad / second
  stickMax: 4, // balls held before the next contact (the 5th) bursts it
  maxBalls: 10, // safety cap on live balls — don't spawn replacements beyond this
} as const;
export const TARGET = {
  r: 24, // target radius, court units
  minDelay: 6, // min seconds before a target (re)appears
  maxDelay: 14, // max seconds before a target (re)appears
  life: 7, // seconds an unclaimed target lingers before vanishing
} as const;

// The power-up a target grants when the ball is bounced across it:
//   grow   — your paddle grows for your next 3 hits
//   shrink — the opponent's paddle shrinks for their next 3 hits
//   smash  — your next 3 hits launch the ball faster
//   slow   — the ball slows down for a few seconds
//   multi  — two extra balls join the rally until the next point
//   freeze — opponent's paddle locks in place for 2 s
//   curve  — your next hit puts spin on the ball, making it arc
//   blind  — opponent's view of their side goes dark for 3 s
//   mirror — opponent's up/down controls are inverted for 3 s
//   shield — absorbs the next goal scored against you
//   ghost  — ball turns invisible for 3 s
//   tiny   — ball shrinks to near-invisible size for 5 s
//   warp   — ball teleports to a random mid-court position
//   rotate — the entire court rotates 90° for the rest of the match
export const POWERUPS = [
  'grow', 'shrink', 'smash', 'slow', 'multi',
  'freeze', 'curve', 'blind', 'mirror', 'shield', 'ghost', 'tiny', 'warp', 'bigball', 'rotate', 'fritz', 'disco', 'blaster', 'minion', 'earthquake', 'coins', 'blackout', 'bullettime', 'vortex', 'glitch', 'smoke', 'tilt', 'roam',
] as const;
export type PowerupKind = (typeof POWERUPS)[number];
export const LEADERBOARD_MIN_GAMES = 3; // games needed before win% is ranked
export const LEADERBOARD_SIZE = 10;

// Money is whole coins, scaled ×100 so the stock market has integer room for percentage moves
// (a 1% move on a 100-coin stock = 1 coin) instead of needing fractional cents. Every coin
// amount in the game — rewards, store prices, stock base prices, spin payouts — lives in these
// units. (Bumping this does NOT retro-scale existing data; that's a one-time DB migration.)
export const COIN_SCALE = 100;

// Cosmetic shop. Purely visual — equipped items are drawn on the paddle but never affect
// the ball's collision (the hitbox is always the plain paddle rectangle). You earn 1 coin
// per match win and can spend coins here. `slot` is mutually exclusive per player.
export interface CosmeticItem {
  id: string;
  name: string;
  slot: 'hat' | 'skin' | 'trail' | 'title' | 'song' | 'car';
  price: number;
  locked?: 'campaign'; // not buyable — unlocked by an in-game achievement (e.g. clearing the campaign)
  audio?: string; // for 'song' items: path to the mp3 that plays during your matches
}
// Static cosmetics cost 1000 coins; animated ones cost 2000 (10×/20× the COIN_SCALE base).
export const COSMETICS: readonly CosmeticItem[] = [
  // Hats
  { id: 'tophat', name: 'Top Hat', slot: 'hat', price: 1000 },
  { id: 'crown', name: 'Crown', slot: 'hat', price: 1000 },
  { id: 'party', name: 'Party Hat', slot: 'hat', price: 1000 },
  { id: 'halo', name: 'Halo', slot: 'hat', price: 2000 }, // animated
  { id: 'cowboy', name: 'Cowboy Hat', slot: 'hat', price: 1000 },
  { id: 'wizard', name: 'Wizard Hat', slot: 'hat', price: 1000 },
  { id: 'horns', name: 'Devil Horns', slot: 'hat', price: 1000 },
  { id: 'gradcap', name: 'Grad Cap', slot: 'hat', price: 1000 },
  { id: 'flame', name: 'Flame', slot: 'hat', price: 2000 }, // animated
  { id: 'helmet', name: 'Helmet', slot: 'hat', price: 1000 },
  { id: 'antennae', name: 'Bug Antennae', slot: 'hat', price: 2000 }, // animated
  { id: 'mohawk', name: 'Mohawk', slot: 'hat', price: 1000 },
  { id: 'bow', name: 'Bow', slot: 'hat', price: 1000 },
  { id: 'pirate', name: 'Pirate Hat', slot: 'hat', price: 1000 },
  { id: 'santa', name: 'Santa Hat', slot: 'hat', price: 1000 },
  { id: 'headphones', name: 'Headphones', slot: 'hat', price: 2000 }, // animated
  // Skins
  { id: 'rainbow', name: 'Rainbow', slot: 'skin', price: 1000 },
  { id: 'gold', name: 'Gold', slot: 'skin', price: 2000 }, // animated
  { id: 'chrome', name: 'Chrome', slot: 'skin', price: 2000 }, // animated
  { id: 'galaxy', name: 'Galaxy', slot: 'skin', price: 2000 }, // animated
  { id: 'lava', name: 'Lava', slot: 'skin', price: 2000 }, // animated
  { id: 'ice', name: 'Ice', slot: 'skin', price: 1000 },
  { id: 'camo', name: 'Camo', slot: 'skin', price: 1000 },
  { id: 'neon', name: 'Neon', slot: 'skin', price: 2000 }, // animated
  { id: 'stripes', name: 'Stripes', slot: 'skin', price: 1000 },
  { id: 'glitch', name: 'Glitch', slot: 'skin', price: 2000 }, // animated
  { id: 'toxic', name: 'Toxic', slot: 'skin', price: 2000 }, // animated
  { id: 'plasma', name: 'Plasma', slot: 'skin', price: 2000 }, // animated
  { id: 'wood', name: 'Wood', slot: 'skin', price: 1000 },
  { id: 'hologram', name: 'Hologram', slot: 'skin', price: 2000 }, // animated
  { id: 'venom', name: 'Venom', slot: 'skin', price: 2000 }, // animated
  // Paddle trails — a fading streak behind the paddle as it moves. Animated ones cost 2000.
  { id: 'comet', name: 'Comet', slot: 'trail', price: 1000 },
  { id: 'frostwake', name: 'Frost Wake', slot: 'trail', price: 1000 },
  { id: 'shadow', name: 'Shadow', slot: 'trail', price: 1000 },
  { id: 'ember', name: 'Ember', slot: 'trail', price: 1000 },
  { id: 'neonstreak', name: 'Neon Streak', slot: 'trail', price: 2000 }, // animated
  { id: 'rainbowtrail', name: 'Rainbow Trail', slot: 'trail', price: 2000 }, // animated
  // Titles — flair shown next to your name on the leaderboard. Mostly buyable; "Davis Slayer"
  // is NOT buyable — it's unlocked only by clearing the campaign.
  { id: 'davisslayer', name: '🏆 Davis Slayer', slot: 'title', price: 0, locked: 'campaign' },
  { id: 'flawless', name: '💯 Flawless', slot: 'title', price: 0, locked: 'campaign' }, // perfect campaign run only
  { id: 'clown', name: '🤡 Clown', slot: 'title', price: 1000 },
  { id: 'sharpshooter', name: '🎯 Sharpshooter', slot: 'title', price: 3000 },
  { id: 'champion', name: '🏅 Champion', slot: 'title', price: 3000 },
  { id: 'highroller', name: '💸 High Roller', slot: 'title', price: 5000 },
  { id: 'legend', name: '⭐ Legend', slot: 'title', price: 8000 },
  { id: 'goat', name: '🐐 GOAT', slot: 'title', price: 10000 },
  // --- Premium tier (high-end coin sinks) ---
  // Hats (animated, bespoke 2D + 3D models)
  { id: 'saturn', name: 'Ringed Planet', slot: 'hat', price: 8000 },
  { id: 'propeller', name: 'Propeller Cap', slot: 'hat', price: 10000 },
  { id: 'flamingcrown', name: 'Flaming Crown', slot: 'hat', price: 12000 },
  { id: 'diamondtiara', name: 'Diamond Tiara', slot: 'hat', price: 20000 },
  // Skins (animated)
  { id: 'obsidian', name: 'Obsidian', slot: 'skin', price: 6000 },
  { id: 'aurora', name: 'Aurora', slot: 'skin', price: 10000 },
  // Trails
  { id: 'stardust', name: 'Stardust', slot: 'trail', price: 5000 },
  { id: 'inferno', name: 'Inferno', slot: 'trail', price: 8000 },
  { id: 'lightning', name: 'Lightning', slot: 'trail', price: 10000 },
  { id: 'phoenix', name: 'Phoenix', slot: 'trail', price: 15000 }, // animated
  // Titles (flex tier)
  { id: 'whale', name: '💎 Whale', slot: 'title', price: 25000 },
  { id: 'marketmaker', name: '📈 Market Maker', slot: 'title', price: 40000 },
  { id: 'untouchable', name: '👑 Untouchable', slot: 'title', price: 50000 },
  { id: 'opstask', name: '🛠️ Ops Task Duty', slot: 'title', price: 100000 }, // animated rainbow
  // Theme songs — one plays (looped) during your matches. If more than one player in a match
  // owns+equips a song, the server picks one at random for that match.
  { id: 'song-battle', name: 'regular battle theme', slot: 'song', price: 15000, audio: '/battle.mp3' },
  { id: 'song-disco', name: 'disco', slot: 'song', price: 20000, audio: '/disco.mp3' },
  { id: 'song-davis', name: 'davis boss theme', slot: 'song', price: 30000, audio: '/davis-battle.mp3' },
  // Cars — drive them around the World map (slot 'car'; physics/look live in CARS above).
  { id: 'car-coupe', name: '🚗 Coupe', slot: 'car', price: 8000 },
  { id: 'car-drifter', name: '🏎️ Drift King', slot: 'car', price: 20000 },
  { id: 'car-muscle', name: '🚙 Muscle', slot: 'car', price: 35000 },
] as const;
// --- Economy Overhaul: scarce "exclusive" cosmetics ---
// Loot-box-only cosmetics with a HARD global mint cap (see exclusive_supply in the DB). They are
// NOT in COSMETICS and are NOT buyable in the shop — the only way to get one is to roll it from a
// loot box (a mint, gated by the cap) or buy a used one off the player marketplace (a transfer).
// They reuse the same equip columns (hat/skin/trail/title) as regular cosmetics, so a slot is
// mutually exclusive between a regular cosmetic and an exclusive. `cap` is the lifetime mint cap;
// a couple are cap:1 one-of-a-kind grails. Rarity is purely a display/weight hint.
export interface ExclusiveItem {
  id: string;
  name: string;
  slot: 'hat' | 'skin' | 'trail' | 'title';
  cap: number;     // lifetime global mint cap (authoritative count lives in exclusive_supply)
  rarity: 'rare' | 'epic' | 'legendary' | 'mythic';
}
export const EXCLUSIVES: readonly ExclusiveItem[] = [
  { id: 'x-voidcrown',   name: '🕳️ Void Crown',      slot: 'hat',   cap: 1, rarity: 'mythic' },     // one-of-one grail
  { id: 'x-genesis',     name: '🌌 Genesis Skin',     slot: 'skin',  cap: 1, rarity: 'mythic' },     // one-of-one grail
  { id: 'x-eclipse',     name: '🌑 Eclipse Trail',    slot: 'trail', cap: 3, rarity: 'legendary' },
  { id: 'x-prismhalo',   name: '💠 Prism Halo',       slot: 'hat',   cap: 3, rarity: 'legendary' },
  { id: 'x-founder',     name: '🪙 Founder',          slot: 'title', cap: 3, rarity: 'epic' },
  { id: 'x-quantum',     name: '⚛️ Quantum Skin',     slot: 'skin',  cap: 3, rarity: 'epic' },
] as const;
export function isExclusive(id: string): boolean {
  return EXCLUSIVES.some((x) => x.id === id);
}

export const CHAT_MAX_LEN = 200; // max characters per chat message
export const CHAT_HISTORY = 50; // recent messages kept/sent to new joiners
export const TICK_MS = 1000 / 60;
export const MAX_BOUNCE = Math.PI / 3; // steepest deflection off a paddle edge
export const SERVE_DELAY = 0.7; // seconds the ball pauses at center before launching
export const READY_TIMEOUT = 15; // seconds to wait for both players to ready up before clearing spots
export const CAPTURE_TIMEOUT = 10; // seconds a laggard has to capture their mouse once an opponent is ready, before being benched

export type Side = 'left' | 'right';
// 'player' is the arena (polygon) seat role — the client finds its own paddle by id.
export type Role = Side | 'player' | 'observer';
export type Status = 'waiting' | 'playing' | 'over';

// Finishing moves the winner can perform during the 'over' window (opt-in, see the
// "Fatalities" toggle on the client). The name is the wire value.
// SCREEN_MELT: the ball flares into a fireball and the losing paddle melts down the
// court like liquid wax.
// PADDLE_SPLIT: the losing paddle is dragged to center, split in half, and explodes.
// FROST_SHATTER: the losing paddle freezes, cracks, and shatters into ice shards.
// NOT_FOUND: the losing paddle glitches into a magenta/black missing-texture
// checkerboard, flickers under a "404 PADDLE NOT FOUND" tag, and blinks out.
// SINGULARITY: a black hole tears open at court center, the losing paddle is
// spaghettified into a glowing accretion disk, then it implodes and detonates.
// PAC_CHOMP: the winner becomes a yellow Pac-Man and chomps a trail of ping-pong
// pellets across the court to the frozen loser, eats it, then balloons and bursts.
// JSAV: the losing paddle becomes Jsav's face, which stretches vertically and
// inflates ever bigger and wider until it swallows the whole court.
// MONITOR_BREAK: the ball rockets into the screen, the whole court erupts in smoke, and
// a cracked-glass overlay drops over everything as if the physical monitor just shattered.
// AVERY: the screen snaps to black and Avery's face slams in full-frame, jittering, as a
// jumpscare sting blares — a sudden in-your-face scare rather than a slow build.
export const FATALITY_MOVES = ['SCREEN_MELT', 'PADDLE_SPLIT', 'FROST_SHATTER', 'NOT_FOUND', 'SINGULARITY', 'PAC_CHOMP', 'JSAV', 'MONITOR_BREAK', 'AVERY'] as const;
export type FatalityMove = (typeof FATALITY_MOVES)[number];

// AI opponent difficulty. A bot fills one duel side; a match it plays never touches the
// leaderboard, and the bot always leaves once the match ends (win or lose).
export const BOT_LEVELS = ['easy', 'medium', 'hard'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

// --- Beta "World" (free-roam 2D overworld) ---------------------------------------------
// A shared top-down town the players walk around as little avatars, each with their name
// floating above. Walk up to a building to enter it: the Arena (the classic tsong game),
// the Casino (roulette), or the Bank (stocks / loans). Movement is client-authoritative —
// there are no competitive stakes in walking around, so each client owns its avatar's
// position and streams it; the server only clamps it to the map and fans everyone's
// positions out to whoever is currently in the world.
//
// Built to grow: to put a new venue on the map (a car dealership, a house you can buy, …),
// add a WORLD_BUILDINGS entry and a handler for its `kind` on the client. Nothing else in
// the protocol needs to change.
export const WORLD = {
  w: 3200,      // map width, world units
  h: 2200,      // map height, world units
  spawnX: 1600, // where a fresh avatar appears (the central plaza)
  spawnY: 1240,
} as const;
export const WORLD_AVATAR = {
  r: 16,        // avatar body radius, world units
  speed: 280,   // on-foot walk speed, world units / second
} as const;

// --- Cars -------------------------------------------------------------------------------
// You buy a car in the shop (it lives in the `car` cosmetic slot, like a hat) and drive it
// around the world — roughly twice walking speed, with arcade drift (low grip = more slide).
// A car id matches a COSMETICS entry with slot 'car'; CARS holds the look + physics for it.
export interface CarSpec {
  id: string;
  name: string;
  body: string;   // main paint color
  accent: string; // roof / stripe color
  speed: number;  // top speed, world units / second
  accel: number;  // how fast it reaches top speed, units / s²
  turn: number;   // steering rate, radians / second at speed
  grip: number;   // 0..1 lateral grip per tick — lower = driftier (slides more)
}
export const CARS: readonly CarSpec[] = [
  // The starter: balanced, grippy, forgiving.
  { id: 'car-coupe',   name: 'Coupe',     body: '#e23b3b', accent: '#fff1f1', speed: 560, accel: 700, turn: 2.6, grip: 0.86 },
  // The drifter: a touch faster and much looser — built to slide.
  { id: 'car-drifter', name: 'Drift King', body: '#2bd4c4', accent: '#10302d', speed: 600, accel: 760, turn: 3.0, grip: 0.70 },
  // The muscle: fastest and heaviest, wide drifts once it breaks loose.
  { id: 'car-muscle',  name: 'Muscle',    body: '#8a5cf6', accent: '#1c1430', speed: 660, accel: 620, turn: 2.2, grip: 0.78 },
] as const;
export function carById(id: string | null | undefined): CarSpec | null {
  if (!id) return null;
  return CARS.find((c) => c.id === id) ?? null;
}

// What entering a building does (the client maps each `kind` to an action). Add a kind here
// and a handler on the client to introduce a new venue.
export type WorldBuildingKind = 'arena' | 'casino' | 'bank';
// A venue's footprint on the map. The rectangle (top-left origin, world units) is solid —
// avatars collide with it — and an apron just outside the door is the entry trigger zone.
export interface WorldBuilding {
  id: string;
  kind: WorldBuildingKind;
  name: string;  // sign over the door
  emoji: string; // glyph drawn on the building face
  x: number;
  y: number;
  w: number;
  h: number;
  color: string; // wall color
}
export const WORLD_BUILDINGS: readonly WorldBuilding[] = [
  { id: 'arena',  kind: 'arena',  name: 'TSONG ARENA', emoji: '🏓', x: 1360, y: 300,  w: 480, h: 340, color: '#3a4ea8' },
  { id: 'casino', kind: 'casino', name: 'CASINO',      emoji: '🎰', x: 440,  y: 1480, w: 440, h: 320, color: '#a8323a' },
  { id: 'bank',   kind: 'bank',   name: 'BANK',        emoji: '🏦', x: 2320, y: 1480, w: 440, h: 320, color: '#2f7d4f' },
] as const;

// One avatar as broadcast to everyone in the world. `id` matches YouMsg.id, so a client can
// skip drawing its own avatar from this list — it renders that one straight from its own
// input for zero-latency movement, and draws everyone else from here.
export interface WorldAvatar {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  a?: number;          // heading in radians (only meaningful while driving)
  car?: string | null; // car id being driven, or null/undefined when on foot
}
export interface WorldMsg {
  type: 'world';
  avatars: WorldAvatar[];
}

// --- Client -> Server ---
export type ClientMsg =
  // pid = stable per-browser identity; color = chosen paddle color
  | { type: 'join'; nickname: string; pid: string; color?: string }
  | { type: 'claim'; side?: Side } // preferred side; omitted = auto-assign to the smaller team
  | { type: 'paddle'; y: number; x?: number } // desired paddle center Y (and optional roam inset X), in court units
  | { type: 'chat'; text: string }
  | { type: 'reaction'; emoji: string } // a floating emoji reaction, shown to everyone
  | { type: 'mode'; closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean; arena?: boolean; viewMode?: string; breakout?: boolean; fog?: boolean; portal?: boolean } // toggle game modes
  | { type: 'fatality'; move: string } // winner-only, validated server-side
  | { type: 'setFatalities'; enabled: boolean } // flips the shared fatalities setting
  | { type: 'forfeit' } // "/ff": leave your paddle spot mid-game (and get shamed)
  | { type: 'spawnPowerup'; kind?: string } // "/powerup [name]": spectators only — drop a power-up target (random when unnamed)
  | { type: 'addBlock' } // spectators only — drop a solid obstacle block at a random central position
  | { type: 'tip'; to: string; amount: number } // send coins directly to another player by nickname
  | { type: 'placeBounty'; to: string; amount: number } // put coins on a player's head; the next to beat them claims it
  | { type: 'capture'; on: boolean } // whether this player's mouse is captured to the board
  | { type: 'kingExit' } // winner declines to stay as king of the court
  | { type: 'queueJoin' } // join the spectator queue
  | { type: 'queueLeave' } // leave the spectator queue
  | { type: 'ready' } // ready up for the next match
  | { type: 'addBot'; level: BotLevel } // drop an AI opponent into the open duel side
  | { type: 'removeBot' }
  | { type: 'ping' } // kick the AI opponent
  | { type: 'rtt'; t: number } // latency probe: the server echoes `t` back untouched so the client can measure round-trip time
  | { type: 'setWinScore'; score: number } // change the first-to-N win score (room-wide)
  | { type: 'tournamentCreate'; size: number } // set up a bracket of the given size (4 or 8)
  | { type: 'tournamentJoin' } // take the next open signup slot
  | { type: 'tournamentLeave' } // give up your signup slot
  | { type: 'tournamentCancel' } // tear down the current tournament
  | { type: 'fire'; angle: number } // blaster power-up: fire a projectile at this vertical aim angle
  | { type: 'doomJoin' } // take a slot in the 2-player co-op DOOM lobby
  | { type: 'doomLeave' } // leave the co-op DOOM lobby / game
  | { type: 'doomRelay'; data: unknown } // forward an opaque DOOM payload to the co-op partner
  | { type: 'doomScore'; round: number; coop: boolean; name?: string } // record a DOOM run's reached round (name = combined team label for co-op)
  | { type: 'doomReward' } // grant the player 1 coin (killed the DOOM minion boss)
  | { type: 'ntJoin' } // take a slot in the Nuketown team-deathmatch lobby (up to 6)
  | { type: 'ntLeave' } // leave the Nuketown lobby / match
  | { type: 'ntStart' } // (host only) start the Nuketown match from the waiting room
  | { type: 'ntEnd'; team: number } // (host only) report the winning team so the server pays the winners
  | { type: 'ntRelay'; data: unknown } // forward an opaque Nuketown payload to all other participants
  | { type: 'srJoin' } // take a grid slot in the "Street Demons: Grand Prix" race lobby (up to 4)
  | { type: 'srLeave' } // leave the Street Demons lobby / race
  | { type: 'srStart' } // (host only) start the race (bots fill the grid up to 4)
  | { type: 'srEnd'; winner: number } // (host only) report the winning slot so the server pays the racer (-1 = a bot won)
  | { type: 'srRelay'; data: unknown } // forward an opaque Street Demons payload to all other racers
  | { type: 'tdJoin' } // join the shared co-op "Type or Die" arena
  | { type: 'tdLeave' } // leave the Type or Die arena
  | { type: 'tdStart' } // (any participant) start the next Type or Die run from the waiting room
  | { type: 'tdTarget'; id: number | null } // soft-lock the monster you're currently typing (null = release)
  | { type: 'tdKill'; id: number } // claim a kill: you finished typing this monster's word
  | { type: 'campaignScore'; score: number; stage: number; won: boolean } // record a campaign run (arcade score, furthest stage, whether Davis fell)
  | { type: 'shopBuy'; item: string } // buy a cosmetic from the shop
  | { type: 'shopEquip'; slot: 'hat' | 'skin' | 'trail' | 'title' | 'song' | 'car'; item: string | null } // equip (item) or unequip (null) a cosmetic
  | { type: 'bet'; side: Side; amount: number } // spectator wagers coins on a side of the live duel
  | { type: 'dailySpin' } // claim the once-per-24h reward spin
  | { type: 'stockInvest'; coin: string; amount: number; side?: StockSide } // open a long or short position
  | { type: 'stockCashOut'; coin: string; side?: StockSide } // close a long or short position
  | { type: 'getLoan'; amount: number } // borrow `amount` coins from Davis (owe 1.5× back by the daily 5pm collection)
  | { type: 'repayLoan' } // pay Davis the full 1.5× owed and clear the loan
  | { type: 'roulette'; bets: RouletteBet[] } // stake coins on a single spin of the casino wheel
  | { type: 'balanceSheetReq'; rank: number } // peek at a net-worth board player's balance sheet (by current rank)
  | { type: 'lootBoxOpen' } // open a loot box: spend coins, roll a weighted prize (common cosmetic / House coins / capped-rare exclusive)
  | { type: 'marketList'; instanceId: number; ask: number } // list an owned exclusive instance on the marketplace for `ask` coins
  | { type: 'marketCancel'; listingId: number } // cancel one of your own listings
  | { type: 'marketBuy'; item: string } // buy the lowest-ask listed instance of an exclusive item
  | { type: 'marketReq' } // request the current marketplace book (listings + floors + supply)
  | { type: 'loanBookReq' } // request the public open-loan book (for the clickable stability-bar modal)
  | { type: 'worldEnter' } // step into the free-roam world map (start sending/receiving avatar positions)
  | { type: 'worldLeave' } // leave the world map
  | { type: 'worldMove'; x: number; y: number; a?: number; car?: string | null } // client-authoritative avatar position (world units), heading + car when driving
  | { type: 'migrate'; oldPid: string }; // one-time: merge a UUID guest account into the signed-in Google account

// --- Server -> Client ---

// One seated player's own paddle within a side's team. Several players may share a
// side (team mode); they share the side's height and power-up state, but each
// drives their own paddle Y — and in layered mode, sits on their own X plane.
export interface TeamPlayer {
  id: string; // per-connection id (matches YouMsg.id, so a client can find its own paddle)
  x: number; // this player's paddle center X (staggered toward center in layered mode)
  y: number; // this player's paddle center Y in court units
  name: string;
  color: string;
  hat?: string | null; // equipped cosmetic hat (purely visual — no collision)
  skin?: string | null; // equipped cosmetic skin (purely visual — no collision)
  trail?: string | null; // equipped paddle trail (purely visual — no collision)
  title?: string | null; // equipped name title (flair shown by the name)
}

export interface PaddleState {
  x: number; // paddle center X in court units (moves inward in "closing walls" mode)
  y: number; // representative paddle Y (first player's, or court center when open) — kept for fatality animations
  name: string | null; // joined nicknames of the players on this side, or null if open
  color: string; // representative hex color (first player's)
  h: number; // current paddle height in court units (taller while powered up)
  frozen: boolean; // paddles are temporarily immobile (freeze power-up)
  mirrored: boolean; // up/down controls are inverted (mirror power-up)
  shielded: boolean; // next goal against this side is absorbed (shield power-up)
  blinded: boolean; // opponent's half of the court is obscured (blind power-up)
  curveReady: boolean; // next hit will put spin on the ball (curve power-up)
  disabled: boolean; // paddle is locked by a blaster hit (can't move)
  ammo: number; // blaster shots this side currently holds (0 = none)
  players: TeamPlayer[]; // every paddle on this side, one per seated player
  // Active power-up countdown values (0 when inactive). Drives the HUD timer display.
  freezeTimer: number;
  blindTimer: number;
  mirrorTimer: number;
  growHits: number;
  shrinkHits: number;
  smashHits: number;
  roamHits: number; // paddle-contacts left on the "roam" power-up (paddle roams into the court)
}

// One player's paddle in Arena (polygon) mode. The paddle rides along its edge of the
// regular N-gon; `cx,cy` is its current center, `angle` the edge direction (for drawing
// it rotated), `len` its current length (grows with the grow power-up).
export interface PolyPlayer {
  id: string;
  name: string;
  color: string;
  cx: number;
  cy: number;
  angle: number; // edge direction, radians
  len: number; // paddle length along the edge, court units
  alive: boolean; // false once knocked out — its edge is now a solid wall
  shielded: boolean; // next goal against this player is absorbed (shield power-up)
  curveReady: boolean; // next hit puts spin on the ball (curve power-up)
}

// The live Arena (free-for-all polygon) view. Present on StateMsg only while arena mode
// is driving a 3+ player match; null otherwise (the classic rectangular court renders).
export interface PolyState {
  n: number; // number of sides / seated players
  cx: number; // polygon center
  cy: number;
  verts: { x: number; y: number }[]; // the n polygon vertices, in edge order
  players: PolyPlayer[]; // one per edge, in vertex order (edge i spans vert i → i+1)
  aliveCount: number;
  winner: string | null; // last player standing, when the round is over
  stopSign: boolean; // true at 8 players — render the court as a stop sign
}

export interface StateMsg {
  type: 'state';
  ball: { x: number; y: number; color: string }; // color = paddle that last hit it (neutral until first hit)
  hitSeq: number; // increments on every paddle contact (both sides); client plays sound on change
  // Extra balls in play during a "multi" power-up; empty the rest of the time.
  extraBalls: { x: number; y: number; color: string }[];
  ballSpeed: number; // current ball speed, court units / second
  paddles: { left: PaddleState; right: PaddleState };
  // Active power-up target, or null when none is on the board. `kind` picks its icon/effect.
  target: { x: number; y: number; kind: PowerupKind } | null;
  score: { left: number; right: number };
  status: Status;
  // True while an in-progress match is frozen waiting for both players to capture
  // their mouse (pointer lock). The client overlays a "capture to play" prompt.
  paused: boolean;
  // Seconds left for an un-captured player to grab their mouse before being benched,
  // counting down only once another seated player is ready and waiting. null when no
  // such countdown is running. The client surfaces it in the capture prompt.
  captureCountdown: number | null;
  closing: boolean; // whether "closing walls" mode is armed
  gravity: boolean; // whether gravity mode is active
  turbo: boolean; // whether turbo mode is active
  layered: boolean; // whether "layered teams" mode is active (teammates stagger forward)
  arena: boolean; // whether "arena" (free-for-all polygon) mode is armed
  // Live arena view when a 3+ player free-for-all is running; null for the classic court.
  poly: PolyState | null;
  diamond: boolean; // whether "diamond hands" mode is armed
  // Live position of the diamond obstacle (diamond-hands mode), or null when none is on
  // the board. Center in court units; its size is the shared DIAMOND.r constant.
  diamondPos: { x: number; y: number } | null;
  // Number of "rotate" power-ups collected this point (0–3). Each adds 90° CW.
  // Resets to 0 on each new serve; 4 wraps back to 0 (full circle = no rotation).
  rotated: number;
  fritz: boolean; // "fritz" power-up: replaces the court background with fritz's photo for the point
  disco: boolean; // "disco" power-up: 3D disco ball drops, dance floor, colored lights (3D/FP only)
  minion: boolean; // "minion" power-up: both paddles are drawn as a minion for the point
  earthquake: boolean; // "earthquake" power-up: court shakes and the ball jitters for the point
  blackout: boolean; // "blackout": heavy dark vignette obscures the court
  bullettime: boolean; // "bullet time": ball slows + blue tint
  vortex: boolean; // "vortex": swirling overlay + ball pulled toward center
  glitch: boolean; // "glitch": TV-static / RGB-split overlay
  smoke: boolean; // "smoke bomb": drifting smoke clouds obscure the court
  tilt: boolean; // "tilt": court tilts in perspective + ball rolls downward
  viewMode: 'normal' | '3d' | 'firstperson'; // shared view mode — changes for every client at once
  pinata: boolean; // whether "piñata" mode is armed
  // Live piñata (beach-ball collector): center, current rotation, the balls stuck to its
  // surface (absolute court positions), and a one-frame `burst` pulse the moment it pops.
  // null when the mode is off or no match is running.
  pinataPos: { x: number; y: number; spin: number; stuck: { x: number; y: number }[]; burst: boolean } | null;
  breakout: boolean; // whether "breakout" mode is armed
  // Which bricks are still alive (true = alive). Length = BREAKOUT.cols × BREAKOUT.rows.
  // null when breakout mode is off.
  bricks: boolean[] | null;
  // Spectator-dropped obstacle blocks currently on the court. Cleared at each match start.
  blocks: { x: number; y: number; w: number; h: number }[];
  fog: boolean;    // "fog of war": ball invisible except close to either paddle
  portal: boolean; // "portal walls": top/bottom walls teleport the ball to a random Y
  winner: string | null; // nickname of the winner when status === 'over'
  // Shared, room-wide toggle: when true, the match winner can perform a finishing move.
  // It's one setting for everyone (not per-user), so it rides along in the state.
  fatalitiesEnabled: boolean;
  // Set once the winner lands a finishing move; drives the on-court animation for
  // every client. `side` is the winning side; null until/unless a fatality happens.
  fatality: { side: Side; move: string } | null;
  watchers: string[]; // nicknames of joined observers
  king: string | null; // nickname of the king (winner who stayed), null if none
  kingWins: number; // the king's current win streak (consecutive match wins)
  queue: string[]; // ordered nicknames of spectators waiting to play
  ready: { left: boolean; right: boolean }; // ready-up status when match is over
  ghostBall: boolean; // ball is currently invisible (ghost power-up)
  tinyBall: boolean; // ball is currently rendered tiny (tiny power-up)
  bigBall: boolean; // ball is currently enlarged (bigball power-up)
  streamerMode: boolean; // fake chat bots are spamming the chat
  bot: BotLevel | null; // difficulty of the AI opponent currently in the duel, or null
  // Active ball-effect countdown values (seconds remaining; 0 when inactive).
  slowTimer: number;
  ghostTimer: number;
  tinyTimer: number;
  bigBallTimer: number;
  winScore: number; // current first-to-N win score (room-wide setting)
  tournament: TournamentView | null; // live single-elimination bracket, or null when none
  // Public wagers on the current duel, grouped by side (name + stake), so everyone can see
  // who bet on whom. Empty arrays when there are no bets.
  bets: { left: Array<{ name: string; amount: number }>; right: Array<{ name: string; amount: number }> };
  // Live fair decimal odds for each side (Elo + current score), or null when betting isn't
  // open. A spectator's payout on a winning call is stake × the odds shown when they bet.
  odds: { left: number; right: number } | null;
  // Blaster projectiles in flight. vx/vy give the travel direction so the client can draw
  // an oriented laser bolt + trail. color is the laser color (bright green).
  projectiles: { x: number; y: number; vx: number; vy: number; color: string }[];
}

// One match node in the bracket, as sent to clients for rendering.
export interface TournamentMatchView {
  id: number;
  round: number; // 0 = first round played; higher = later rounds (final is the max)
  p1: string | null; // participant nickname, or null if not yet determined
  p2: string | null;
  winner: string | null; // nickname of the winner, or null if not played yet
  live: boolean; // true for the match currently being played on the court
}

// The whole tournament as broadcast to every client.
export interface TournamentView {
  status: 'signup' | 'active' | 'done';
  size: number; // 4 or 8
  creator: string; // nickname of whoever set it up (only they may cancel it)
  slots: (string | null)[]; // signup slots in seed order; null = open (signup phase)
  matches: TournamentMatchView[];
  rounds: number; // total number of rounds (so the client can label/lay them out)
  champion: string | null; // nickname of the winner once status === 'done'
  // World Cup Edition: each participant is randomly assigned a nation from the 2026 field.
  // Maps player nickname → assigned country. Populated once a player joins during signup.
  countries: Record<string, { name: string; flag: string }>;
}

// The 48 nations in the 2026 FIFA World Cup field, with their emoji flags.
export const WC_COUNTRIES: ReadonlyArray<{ name: string; flag: string }> = [
  { name: 'Algeria', flag: '🇩🇿' },
  { name: 'Argentina', flag: '🇦🇷' },
  { name: 'Australia', flag: '🇦🇺' },
  { name: 'Austria', flag: '🇦🇹' },
  { name: 'Belgium', flag: '🇧🇪' },
  { name: 'Bosnia and Herzegovina', flag: '🇧🇦' },
  { name: 'Brazil', flag: '🇧🇷' },
  { name: 'Cabo Verde', flag: '🇨🇻' },
  { name: 'Canada', flag: '🇨🇦' },
  { name: 'Colombia', flag: '🇨🇴' },
  { name: 'Congo DR', flag: '🇨🇩' },
  { name: "Côte d'Ivoire", flag: '🇨🇮' },
  { name: 'Croatia', flag: '🇭🇷' },
  { name: 'Curaçao', flag: '🇨🇼' },
  { name: 'Czechia', flag: '🇨🇿' },
  { name: 'Ecuador', flag: '🇪🇨' },
  { name: 'Egypt', flag: '🇪🇬' },
  { name: 'England', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { name: 'France', flag: '🇫🇷' },
  { name: 'Germany', flag: '🇩🇪' },
  { name: 'Ghana', flag: '🇬🇭' },
  { name: 'Haiti', flag: '🇭🇹' },
  { name: 'IR Iran', flag: '🇮🇷' },
  { name: 'Iraq', flag: '🇮🇶' },
  { name: 'Japan', flag: '🇯🇵' },
  { name: 'Jordan', flag: '🇯🇴' },
  { name: 'Korea Republic', flag: '🇰🇷' },
  { name: 'Mexico', flag: '🇲🇽' },
  { name: 'Morocco', flag: '🇲🇦' },
  { name: 'Netherlands', flag: '🇳🇱' },
  { name: 'New Zealand', flag: '🇳🇿' },
  { name: 'Norway', flag: '🇳🇴' },
  { name: 'Panama', flag: '🇵🇦' },
  { name: 'Paraguay', flag: '🇵🇾' },
  { name: 'Portugal', flag: '🇵🇹' },
  { name: 'Qatar', flag: '🇶🇦' },
  { name: 'Saudi Arabia', flag: '🇸🇦' },
  { name: 'Scotland', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  { name: 'Senegal', flag: '🇸🇳' },
  { name: 'South Africa', flag: '🇿🇦' },
  { name: 'Spain', flag: '🇪🇸' },
  { name: 'Sweden', flag: '🇸🇪' },
  { name: 'Switzerland', flag: '🇨🇭' },
  { name: 'Tunisia', flag: '🇹🇳' },
  { name: 'Türkiye', flag: '🇹🇷' },
  { name: 'United States', flag: '🇺🇸' },
  { name: 'Uruguay', flag: '🇺🇾' },
  { name: 'Uzbekistan', flag: '🇺🇿' },
] as const;

// Sent to a single connection whenever its own role changes (connect / claim / release).
export interface YouMsg {
  type: 'you';
  id: string;
  role: Role;
}

export interface LeaderboardRow {
  name: string;
  wins: number;
  losses: number;
  elo: number;
  title?: string | null; // equipped title id (flair shown by the name)
}

// Broadcast on connect and whenever the standings change (after a match).
export interface LeaderboardMsg {
  type: 'leaderboard';
  rows: LeaderboardRow[];
}

// One row of the Net Worth board: total liquid + invested coins, net of any
// debt owed to Davis. `net` = coins + (stock holdings at live price) − loan owed,
// and can go negative when a loan outweighs the assets behind it.
export interface NetWorthRow {
  name: string;
  net: number;   // coins + holdings value − loan owed
  coins: number; // liquid coins (wallet)
  loan: number;  // outstanding debt owed to Davis (0 if none)
  title?: string | null; // equipped title id (flair shown by the name)
}

// Broadcast alongside the leaderboard and whenever the economy shifts (matches,
// stock re-rolls, loans, the daily collection).
export interface NetWorthMsg {
  type: 'netWorth';
  rows: NetWorthRow[];
}

// One line item on a player's balance sheet: an open stock position valued live.
export interface BalanceSheetHolding {
  coin: string;       // display name (e.g. "Davis Clarke Coin")
  ticker: string;     // short ticker (e.g. "DAVIS")
  side: StockSide;    // 'long' or 'short'
  shares: number;     // fractional shares held
  price: number;      // current price per share
  value: number;      // positionWorth at current price, rounded to whole coins
}

// Server → client: a public balance sheet for the player at `rank` on the net-worth
// board — coins on hand, every stock position valued live, and any debt to Davis.
// Sent in response to a balanceSheetReq (clicking a net-worth row).
export interface BalanceSheetMsg {
  type: 'balanceSheet';
  rank: number;
  name: string;
  coins: number;                    // liquid coins
  holdings: BalanceSheetHolding[];  // stock positions (empty if none)
  stockValue: number;               // total live value of all holdings
  loan: number;                     // outstanding debt owed to Davis (0 if none)
  net: number;                      // coins + stockValue − loan
}

export interface ChatLine {
  from: string;
  text: string;
  player: boolean; // true if the sender held a paddle when they sent it
  color: string; // hex color of the sender's name
  command?: boolean; // true if this line is a slash command someone ran (styled apart)
  time: number; // epoch ms, set by the server
}

// One line for a live message; the full recent history on connect. Client appends.
export interface ChatMsg {
  type: 'chat';
  lines: ChatLine[];
}

// A one-off emoji reaction, fanned out live to every client (not replayed on join).
export interface ReactionMsg {
  type: 'reaction';
  emoji: string;
}

// A one-off transient notice. By default a big center-screen banner (e.g. a forfeit);
// `toast: true` renders a small unobtrusive corner toast instead (e.g. betting activity).
export interface AnnounceMsg {
  type: 'announce';
  text: string;
  toast?: boolean;
}

// A ping notification requesting attention: someone wants others to join the game.
export interface PingMsg {
  type: 'ping';
  from: string;
}

// A snapshot of the authoritative loop's health, sampled over a rolling window. The
// loop must hold 60 Hz; if a tick's work overruns its budget the whole room lags at
// once, so these numbers are the server-side smoking gun. Ride along on the rtt echo.
export interface TickHealth {
  tps: number; // achieved ticks/second (target ~60)
  busyAvg: number; // average ms of work per tick
  busyMax: number; // worst single tick's work time in the window, ms
  slowPct: number; // % of ticks whose work overran the TICK_MS budget
}

// Echo of a client's latency probe: `t` is the client's own timestamp, returned
// unchanged so the client can compute (now - t) = round-trip time. Carries no server
// state — purely a client-side network-health readout. `tick` piggybacks the server's
// current tick-loop health so the client can show it without any per-frame overhead.
export interface RttMsg {
  type: 'rtt';
  t: number;
  tick?: TickHealth;
}

// The default quick-reaction row, in display order.
export const REACTIONS = ['🔥', '🎉', '🫵', '👍', '😂', '😮', '👏', '😡', '🖕'] as const;

// Special non-emoji reaction: a pong ball rendered in the live ball color. The
// color isn't sent — each client paints it with whatever its own ball shows.
export const BALL_REACTION = 'ball';

export type ServerMsg =
  | YouMsg
  | StateMsg
  | LeaderboardMsg
  | NetWorthMsg
  | BalanceSheetMsg
  | ChatMsg
  | ReactionMsg
  | AnnounceMsg
  | PingMsg
  | RttMsg
  | DoomLobbyMsg
  | DoomRelayMsg
  | DoomEndMsg
  | NtLobbyMsg
  | NtRelayMsg
  | SrLobbyMsg
  | SrRelayMsg
  | DoomLeaderboardMsg
  | TypeDieStateMsg
  | TypeDieLeaderboardMsg
  | CampaignLeaderboardMsg
  | WalletMsg
  | StockMsg
  | LoanMsg
  | SpinResultMsg
  | RouletteResultMsg
  | TipMsg
  | BountyBoardMsg
  | BountyHitMsg
  | ThemeSongMsg
  | LootResultMsg
  | MarketMsg
  | LoanBookMsg
  | WorldMsg
  | HouseMsg;

// --- Economy Overhaul server → client messages ---

// Result of opening a loot box, sent only to the opener so it can run the reveal animation.
// `kind` picks the celebration: a common cosmetic grant, a House-funded coin payout, or a
// freshly-minted scarce exclusive (with its serial). A capped-out exclusive roll degrades to a
// coin payout server-side, so the client only ever sees a real, paid result.
export interface LootResultMsg {
  type: 'lootResult';
  kind: 'coins' | 'cosmetic' | 'exclusive';
  coins?: number;             // coins paid (kind === 'coins')
  item?: string;              // item id (cosmetic or exclusive)
  name?: string;              // display name of the item
  serial?: number;            // mint serial (exclusive only): "#serial of cap"
  cap?: number;               // the item's global cap (exclusive only)
  rarity?: string;            // rarity tag (exclusive only)
}

// The public marketplace book for scarce exclusives: per-item floor + listings, last-sale prices,
// and how many of each item have been minted (vs the cap). Sent in response to marketReq and
// re-pushed to interested clients after any listing change.
export interface MarketListingView {
  id: number;          // listing id (for cancel)
  instanceId: number;  // the instance being sold
  item: string;        // exclusive item id
  sellerName: string;  // seller display name
  ask: number;         // ask price in coins
  mine: boolean;       // true if this listing belongs to the requesting player
}
export interface MarketItemView {
  item: string;        // exclusive item id
  floor: number | null; // lowest ask across all listings of this item (null = none listed)
  minted: number;      // how many have been minted globally
  cap: number;         // the item's lifetime mint cap
  lastSale: number | null; // last sale price (null = never sold)
  listings: MarketListingView[]; // every open listing for this item, ascending ask
}
export interface MarketMsg {
  type: 'market';
  items: MarketItemView[];
}

// The public open-loan book (clicking the market-stability bar): who owes Davis what, due when.
export interface LoanBookRow { name: string; amount: number; owed: number; dueAt: number; }
export interface LoanBookMsg {
  type: 'loanBook';
  loans: LoanBookRow[];
}

// The House treasury balance, broadcast on join and whenever it changes. When it runs low,
// House-funded payouts are throttled (see housePay) — the client surfaces a "payouts reduced" note.
export interface HouseMsg {
  type: 'house';
  balance: number;
}

// Broadcast when a match kicks off and a seated player has a theme song equipped — every client
// loops `audio` for the duration of the match (until status leaves 'playing'). `owner` is the
// nickname whose song was picked (random among the match's players who have one equipped).
export interface ThemeSongMsg {
  type: 'themeSong';
  audio: string;
  owner: string;
}

// Broadcast when one player tips another — drives the room-wide coin shower.
export interface TipMsg {
  type: 'tip';
  from: string;
  to: string;
  amount: number;
}

// The active-bounties board: a pot of coins riding on each named player's head. Whoever beats
// that player in a duel next claims the whole pot, and it clears. Sent on join and on change.
export interface BountyBoardMsg {
  type: 'bounties';
  list: { name: string; pot: number }[];
}

// Broadcast when a bounty is collected — the winner beat the bountied player. Drives a coin shower.
export interface BountyHitMsg {
  type: 'bountyHit';
  winner: string;
  target: string;
  amount: number;
}

// A player's private wallet + cosmetics + active bet, sent only to that client.
export interface WalletMsg {
  type: 'wallet';
  coins: number;
  owned: string[]; // item ids owned
  hat: string | null; // equipped hat
  skin: string | null; // equipped skin
  trail: string | null; // equipped paddle trail
  title: string | null; // equipped name title (flair shown by your name)
  song: string | null; // equipped theme song (plays during your matches)
  car: string | null; // equipped car (driven in the World map)
  // Owned scarce exclusives (loot-box mints / marketplace buys): item id + mint serial +
  // instance id (the marketplace lists a specific instance). Kept OUT of the `owned` CSV —
  // exclusives are tracked per-instance in their own table.
  exclusives: { id: string; serial: number; instanceId: number }[];
  // Your open wagers on the live duel (multiple allowed in live betting); each locks the odds
  // it was placed at. Empty when you have none.
  bets: Array<{ side: Side; amount: number; odds: number }>;
  nextSpinAt: number; // epoch ms when the daily spin is next available (0 = available now)
  bonusSpins: number; // banked free spins (e.g. from winning a tournament); bypass the cooldown
}

// A player's private loan status, sent only to that client (on join and after any loan
// change). `loan` is null when they owe Davis nothing. Borrow N coins now; owe `owed`
// (= ceil(1.5 × N), Davis rounds up) back by `dueAt` (the next daily 5pm collection). Miss the
// deadline and Davis zeroes your wallet AND wipes every stock position — and your unpaid debt is
// added to the market-instability pool (see MARKET_INSTABILITY_THRESHOLD).
export interface LoanMsg {
  type: 'loan';
  loan: { amount: number; owed: number; dueAt: number } | null;
}

// The daily-spin wheel segments, in display order. Shared so the client wheel and the
// server roll agree on the layout. Higher-value segments have lower odds (weights live
// server-side). hat/skin award a random unowned cosmetic of that slot.
export const SPIN_SEGMENTS = [
  { label: '100 🪙', kind: 'coins', value: 100 },
  { label: '200 🪙', kind: 'coins', value: 200 },
  { label: '300 🪙', kind: 'coins', value: 300 },
  { label: '500 🪙', kind: 'coins', value: 500 },
  { label: '1000 🪙', kind: 'coins', value: 1000 },
  { label: '2000 🪙', kind: 'coins', value: 2000 },
  { label: '🎩 Hat', kind: 'hat', value: 0 },
  { label: '🎨 Skin', kind: 'skin', value: 0 },
] as const;

// --- Stock market (joke crypto exchange) ---
// Five fictional "cryptocurrencies" you can sink coins into. Each has a global price that
// random-walks every STOCK_UPDATE_MS (shared by everyone — it's one market). Investing N
// coins at price P buys N/P "shares"; cashing out pays round(shares × currentPrice) coins
// and closes the whole position. `base` is the starting price — 100 (= COIN_SCALE), so 1%
// price moves are whole coins — and the market drifts up from there; `img` is the logo.
export const STOCKS = [
  { id: 'kenny', name: 'Kenny Kawaguchi', ticker: 'KENNY', img: '/kennykawaguchi.png', base: 100, supply: 10000 },
  { id: 'chugs', name: 'BadlandsChugs',   ticker: 'CHUG',  img: '/badlandschugs.jpg',  base: 100, supply: 5000  },
  { id: 'davis', name: 'Davis Clarke Coin', ticker: 'DAVIS', img: '/davisclarke.jpg',  base: 100, supply: 3000  },
  { id: 'otto',  name: 'OTTO',             ticker: 'OTTO',  img: '/otto.webp',          base: 100, supply: 1500  },
  { id: 'bacon', name: 'Bacon Roll',       ticker: 'BACON', img: '/baconroll.png',      base: 100, supply: 1000  },
  { id: 'fritz', name: 'Fritz Coin',       ticker: 'FRITZ', img: '/fritz.jpg',          base: 100, supply: 500   },
  { id: 'omega', name: 'Omega Davis',      ticker: 'OMEGA', img: '/davis-cosmic.jpg',   base: 100, supply: 10000 },
] as const;
export type StockId = (typeof STOCKS)[number]['id'];
export const STOCK_UPDATE_MS = 30 * 1000; // prices re-roll every 30 seconds
// Market stability: the market no longer resets on a daily timer. Instead, each day's loan
// collection adds every defaulter's unpaid debt (the 1.5× `owed`) to a global instability
// pool. When that pool reaches MARKET_INSTABILITY_THRESHOLD coins a CRASH fires for EVERYONE —
// a random subset of coins each drop by a random degree while one random coin spikes up (so it
// can't be exploited by shorting the whole board) — and the pool resets to 0. The "Market
// Stability" bar shows pool / threshold.
export const MARKET_INSTABILITY_THRESHOLD = 10000;
// Per-coin price-history buffers for the little graphs — one independent series per
// timeframe so each view has its own resolution and span (no overlap/aliasing). `everyTicks`
// is how many re-rolls (30s each) between samples; `cap` is how many points to keep:
//   5m → sample every re-roll (30s), 10 points  = 5 minutes
//   1h → sample every 4 re-rolls (2 min), 30 points = 1 hour
//   6h → sample every 24 re-rolls (12 min), 30 points = 6 hours
//   1d → sample every 60 re-rolls (30 min), 48 points = 1 day
// History lives in server memory only (not persisted), so it refills after a restart.
export const STOCK_HISTORY = {
  '5m': { everyTicks: 1, cap: 10 },
  '1h': { everyTicks: 4, cap: 30 },
  '6h': { everyTicks: 24, cap: 30 },
  '1d': { everyTicks: 60, cap: 48 },
} as const;
export type StockTf = keyof typeof STOCK_HISTORY; // '5m' | '1h' | '6h' | '1d'

// Direction of a stock position. A player can hold long and short of the same coin at once.
export type StockSide = 'long' | 'short';
// Current value of a position: long pays shares×price; short pays 2×cost − shares×price
// (goes negative if price climbs past entry — covering then costs the holder extra coins).
export function positionWorth(side: StockSide, shares: number, cost: number, price: number): number {
  return side === 'long' ? shares * price : 2 * cost - shares * price;
}

// A player's private market view: the global price board plus that player's own positions.
// Sent on join, after every trade, and to everyone when prices re-roll.
export interface StockMsg {
  type: 'stocks';
  // Global price board, in STOCKS order. `prev` is the price at the previous re-roll (for the
  // %-change readout); `price` is the live one. `flow` is the current net order-flow pressure
  // sign for that coin (+1 buy-heavy, −1 sell-heavy, 0 balanced) — drives a small ▲/▼ tint.
  prices: { id: string; price: number; prev: number; flow?: number }[];
  // This player's open positions (only coins they actually hold). `shares` is fractional;
  // `cost` is the total coins poured in (cost basis); `worth` is floor(shares × price) — the
  // coins they'd get if they cashed out right now.
  holdings: { id: string; side: StockSide; shares: number; cost: number; worth: number }[];
  // Price history for the per-coin graphs, in STOCKS order — one array per timeframe (oldest
  // first). See STOCK_HISTORY for the cadence/length of each series.
  history: { id: string; series: Record<StockTf, number[]> }[];
  nextUpdateAt: number; // epoch ms when prices next re-roll
  // Global market-stability pool: `unpaid` is the running total of defaulted loan debt, `threshold`
  // is where it triggers a market-wide crash (MARKET_INSTABILITY_THRESHOLD). Drives the bar.
  stability: { unpaid: number; threshold: number };
}

// Result of a daily spin, sent to the spinning client so it can land the wheel on `segment`
// (an index into SPIN_SEGMENTS) and celebrate the prize.
export interface SpinResultMsg {
  type: 'spinResult';
  segment: number;
  reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string };
}

// --- Roulette (single-zero European wheel) ---
// A casino roulette table: stake coins on where the ball lands on a 0–36 wheel. The wheel
// is the European single-zero layout, so the lone green 0 gives the house its edge. The
// server is authoritative — it rolls the number, settles every bet, and adjusts the wallet.

// The 18 red pockets (the other 18 of 1–36 are black; 0 is green). Standard layout.
export const ROULETTE_RED: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
// Pocket order around the physical European wheel, clockwise from 0 (for the visual spin).
export const ROULETTE_WHEEL: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
export const ROULETTE_MAX_TOTAL = 10000; // most coins that may be staked across all bets on one spin

// The bet kinds offered. `straight` needs a target `number` (0–36); the rest are the
// classic "outside" bets. The value is the profit-to-stake ratio — a winning bet returns
// the stake plus stake × ratio (so straight pays 35:1, dozens 2:1, even-money 1:1).
export type RouletteBetKind =
  | 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen1' | 'dozen2' | 'dozen3';
export const ROULETTE_PAYOUTS: Record<RouletteBetKind, number> = {
  straight: 35, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1, dozen1: 2, dozen2: 2, dozen3: 2,
};
export interface RouletteBet {
  kind: RouletteBetKind;
  amount: number; // coins staked on this bet (positive whole number)
  number?: number; // target pocket 0–36, only for a `straight` bet
}

// Does `bet` win when the ball lands on `win` (0–36)? Shared so the server settles and the
// client previews/highlights with identical rules.
export function rouletteWins(bet: RouletteBet, win: number): boolean {
  switch (bet.kind) {
    case 'straight': return bet.number === win;
    case 'red': return ROULETTE_RED.has(win);
    case 'black': return win !== 0 && !ROULETTE_RED.has(win);
    case 'odd': return win !== 0 && win % 2 === 1;
    case 'even': return win !== 0 && win % 2 === 0;
    case 'low': return win >= 1 && win <= 18;
    case 'high': return win >= 19 && win <= 36;
    case 'dozen1': return win >= 1 && win <= 12;
    case 'dozen2': return win >= 13 && win <= 24;
    case 'dozen3': return win >= 25 && win <= 36;
  }
}

// Result of one spin, sent to the spinning client so it can land the wheel on `number` and
// settle up. `payout` is the total coins returned (stake + winnings on every winning bet;
// 0 when everything lost); `staked` is what was put down.
export interface RouletteResultMsg {
  type: 'rouletteResult';
  number: number; // winning pocket, 0–36
  staked: number; // total coins wagered this spin
  payout: number; // total coins paid back (0 if all bets lost)
}

// Co-op DOOM lobby status (2 slots). `slot` is which slot this client holds (0 = host,
// 1 = guest, null = not in it). When status flips to 'playing', slot 0 is the authority.
export interface DoomLobbyMsg {
  type: 'doomLobby';
  status: 'signup' | 'playing';
  filled: number; // slots taken (0–2)
  slot: number | null; // this client's slot, or null if not joined
}
// An opaque payload relayed from the co-op partner (host state snapshot / guest input).
export interface DoomRelayMsg {
  type: 'doomRelay';
  data: unknown;
}
// The co-op session ended (partner left/disconnected).
export interface DoomEndMsg {
  type: 'doomEnd';
  reason: string;
}
// Nuketown lobby (up to 6 slots, two teams). `slot` is which slot this client holds (0 = host).
// `hostSlot` is always 0 unless the host leaves (then the match ends). When status flips to
// 'playing', the host (slot 0) is the authority; on 'ended' everyone bails to the menu.
export interface NtLobbyMsg {
  type: 'ntLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; team: number; slot: number }[]; // everyone in the lobby
}
// An opaque payload broadcast from one Nuketown participant to all others (host state
// snapshot / guest input). Clients pick out the messages they care about.
export interface NtRelayMsg {
  type: 'ntRelay';
  data: unknown;
}
// --- "Street Demons: Grand Prix" (4-player pseudo-3D racer) ---
// Up to 4 human racers; the host (slot 0) is the authority and fills any empty grid slots with
// bots, so a lone player still races a full field. Mirrors Nuketown's host-authoritative relay:
// the server only runs the lobby + opaque fan-out and pays the winning racer. `slot` is which
// grid slot this client holds (0 = host). 'playing' kicks off the race; 'ended' bails everyone
// back to the menu (the host left).
export interface SrLobbyMsg {
  type: 'srLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's grid slot (0 = host / authority)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; slot: number }[]; // every human in the lobby
}
// An opaque payload broadcast from one Street Demons racer to all others (host world snapshot /
// guest input). Clients pick out the messages they care about.
export interface SrRelayMsg {
  type: 'srRelay';
  data: unknown;
}
// High-round leaderboards for the DOOM minigame (separate solo / co-op tables).
export interface DoomLeaderboardMsg {
  type: 'doomLeaderboard';
  solo: Array<{ name: string; round: number }>;
  coop: Array<{ name: string; round: number }>;
}

// --- "Type or Die" (co-op typing horde-defense) ---
// One shared global arena. Monsters bearing words march down toward a shared base; type a
// monster's word to destroy it. Base HP / wave / score are shared, so more typists = deeper
// waves. Server-authoritative: it owns spawns, positions, HP and scoring; clients render this
// state and send soft target-locks + kill claims (validated server-side).
export type TdPhase = 'lobby' | 'countdown' | 'playing' | 'gameover';
export type TdKind = 'normal' | 'fast' | 'boss' | 'coin';

// One monster on the field. y runs 0 (spawn, top) → 1 (the base, bottom); x is 0..1 across.
// `lockedBy` is the participant id currently typing it (so clients don't fight over a word).
export interface TdEnemy {
  id: number;
  x: number;
  y: number;
  word: string;
  kind: TdKind;
  lockedBy: string | null;
}
// One participant in the arena, with their live kill tally (drives the MVP flourish).
export interface TdPlayer {
  id: string; // matches a connection id, so a client can find itself
  name: string;
  color: string;
  kills: number;
}
export interface TypeDieStateMsg {
  type: 'tdState';
  phase: TdPhase;
  you: string;            // this client's participant id
  players: TdPlayer[];
  enemies: TdEnemy[];
  baseHp: number;
  baseMax: number;
  wave: number;
  score: number;
  countdown: number;      // seconds left in the pre-run countdown (0 unless phase === 'countdown')
  overIn: number;         // seconds the gameover screen lingers before returning to the lobby
  mvp: string | null;     // top killer's name (set on gameover)
}
export interface TypeDieScoreRow { name: string; wave: number; }
export interface TypeDieLeaderboardMsg {
  type: 'tdLeaderboard';
  rows: TypeDieScoreRow[]; // best wave reached per player
}

// Campaign ("Davis Collects") high scores. One row per player (best arcade score kept).
// `stage` is the furthest stage reached (1–5); `won` marks a full clear of Davis.
export interface CampaignScoreRow { name: string; score: number; stage: number; won: boolean; }
export interface CampaignLeaderboardMsg {
  type: 'campaignLeaderboard';
  rows: CampaignScoreRow[];
}
export const CAMPAIGN_STAGE_COUNT = 5;
