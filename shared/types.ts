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
// Arena paddle length is a fraction of the *current* edge length rather than a flat
// number: a triangle's edges are far longer than an octagon's, so a fixed-length paddle
// covered way less of a triangle edge and made 3–4 player games end in seconds. Scaling
// with the edge (clamped so it can't get silly-long or disappear) keeps coverage — and
// game length — comparable across every player count, while leaving the 8-player octagon
// (whose edges are shortest) at essentially the old 64.
export const POLY_PADDLE_FRACTION = 0.32; // share of the edge a paddle covers at rest
export const POLY_PADDLE_MIN = 56; // court units
export const POLY_PADDLE_MAX = 130; // court units
// Arena's free-for-all rallies bounce between many paddles before anyone misses, so the
// per-hit speedup compounds far more times per point than in a 1v1 duel. A slower serve,
// gentler speedup, and hard cap keep long rallies from spiraling into an unreturnable
// blur — the "ball's too quick" complaint.
export const ARENA_BALL = {
  speed: 340, // serve speed, court units/second (vs. BALL.speed = 480 for the duel)
  speedup: 1.025, // multiplier applied on each paddle hit
  maxSpeed: 760, // hard cap regardless of how long the rally runs
} as const;
export const ARENA_SERVE_DELAY = 1.1; // seconds the arena ball pauses at center before launching (vs. SERVE_DELAY = 0.7)
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

// "Bumpers" mode: five static circular pegs in a pinball formation across the center.
// Ball caroms off them with a small speed boost; each hit flashes the bumper.
export const BUMPER = {
  r: 22,         // radius, court units
  speedBoost: 1.04, // ball speed multiplier on each hit (capped at 1.5× base)
} as const;
export const BUMPER_POSITIONS: readonly { x: number; y: number }[] = [
  { x: 280, y: 130 },
  { x: 520, y: 130 },
  { x: 400, y: 250 },
  { x: 280, y: 370 },
  { x: 520, y: 370 },
] as const;

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
  'freeze', 'curve', 'blind', 'mirror', 'shield', 'ghost', 'tiny', 'warp', 'bigball', 'rotate', 'fritz', 'disco', 'blaster', 'minion', 'earthquake', 'coins', 'blackout', 'vortex', 'glitch', 'smoke', 'tilt', 'roam',
] as const;
export type PowerupKind = (typeof POWERUPS)[number];
export const LEADERBOARD_MIN_GAMES = 3; // games needed before win% is ranked
export const LEADERBOARD_SIZE = 10;

// Cortisol: a per-player stress/tension gauge (0 = zen … 100 = maxed out). It rises on stressful
// events (bad friend-sim interactions, long rallies, near-elimination in Arena) and decays back
// toward calm over time. The "Calmest" leaderboard ranks it low→high (most zen on top).
export const CORTISOL_MAX = 100;
// Everyone starts here — right in the middle. Stress pushes it up; calm bleeds it back down.
export const CORTISOL_START = 50;

// Money is whole coins, scaled ×100 so the stock market has integer room for percentage moves
// (a 1% move on a 100-coin stock = 1 coin) instead of needing fractional cents. Every coin
// amount in the game — rewards, store prices, stock base prices, spin payouts — lives in these
// units. (Bumping this does NOT retro-scale existing data; that's a one-time DB migration.)
export const COIN_SCALE = 100;

// --- Account level, derived purely from lifetime XP (see server db.grantXp) -------------------
// Each level costs a bit more than the last (linear increments → a gentle quadratic total): the
// first level-up is quick and satisfying, and the curve stretches out so high levels are earned.
export function xpForLevelUp(level: number): number {
  return 100 + Math.max(0, level - 1) * 60; // XP needed to go from `level` → `level+1`
}
/** Break a lifetime XP total into { level, into (xp into the current level), need (xp for the
 *  next level) } — everything the HUD needs to draw a level badge + progress bar. Level 1 = 0 XP. */
export function levelForXp(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let rem = Math.max(0, Math.floor(xp || 0));
  for (let guard = 0; guard < 100000; guard++) {
    const need = xpForLevelUp(level);
    if (rem < need) return { level, into: rem, need };
    rem -= need;
    level++;
  }
  return { level, into: 0, need: xpForLevelUp(level) };
}

// Cosmetic shop. Purely visual — equipped items are drawn on the paddle but never affect
// the ball's collision (the hitbox is always the plain paddle rectangle). You earn 1 coin
// per match win and can spend coins here. `slot` is mutually exclusive per player.
export interface CosmeticItem {
  id: string;
  name: string;
  slot: 'hat' | 'skin' | 'trail' | 'balltrail' | 'goalcelebr' | 'title' | 'song' | 'car' | 'boat' | 'pet' | 'carcolor';
  price: number;
  locked?: 'campaign' | 'fishing' | 'fishing_rare' | 'fishing_junk' | 'dungeon' | 'fountain' | 'desert' | 'club' | 'golf'; // not buyable — unlocked by in-game achievements
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
  { id: 'mushroom', name: '🍄 Mushroom Cap', slot: 'hat', price: 0, locked: 'dungeon' }, // a Ruins chest prize (B1)
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
  { id: 'pickle', name: 'Pickle Rick', slot: 'skin', price: 2000 }, // animated — I turned myself into a paddle, Morty!
  // Paddle trails — a fading streak behind the paddle as it moves. Animated ones cost 2000.
  { id: 'comet', name: 'Comet', slot: 'trail', price: 1000 },
  { id: 'frostwake', name: 'Frost Wake', slot: 'trail', price: 1000 },
  { id: 'shadow', name: 'Shadow', slot: 'trail', price: 1000 },
  { id: 'ember', name: 'Ember', slot: 'trail', price: 1000 },
  { id: 'neonstreak', name: 'Neon Streak', slot: 'trail', price: 2000 }, // animated
  { id: 'rainbowtrail', name: 'Rainbow Trail', slot: 'trail', price: 2000 }, // animated
  { id: 'auroratrail', name: 'Aurora Trail', slot: 'trail', price: 2000 }, // animated
  // Titles — flair shown next to your name on the leaderboard. Mostly buyable; "Davis Slayer"
  // is NOT buyable — it's unlocked only by clearing the campaign.
  { id: 'davisslayer', name: '🏆 Davis Slayer', slot: 'title', price: 0, locked: 'campaign' },
  { id: 'flawless', name: '💯 Flawless', slot: 'title', price: 0, locked: 'campaign' }, // perfect campaign run only
  { id: 'title-pindropper', name: '📍 Pin Dropper', slot: 'title', price: 0, locked: 'dungeon' }, // beat Rob, the final boss
  { id: 'bigcatch', name: '🐟 Big Catch', slot: 'title', price: 0, locked: 'fishing_rare' }, // land a rare-or-better fish
  { id: 'angler', name: '🎣 Angler', slot: 'title', price: 0, locked: 'fishing' }, // land a legendary fish
  { id: 'wisher', name: '⛲ Wisher', slot: 'title', price: 0, locked: 'fountain' }, // the fountain grants ~1 wish in 77
  { id: 'club-member', name: '⛳ Old Money', slot: 'title', price: 0, locked: 'club' }, // the Country Club initiation fee is not discussed in public
  { id: 'club-champ', name: '🏌️ Club Champion', slot: 'title', price: 0, locked: 'club' }, // earned, not bought (unlike everything else up there)
  { id: 'golf-champ', name: '⛳ Golf Champion', slot: 'title', price: 0, locked: 'golf' }, // shot all 18. the course does not care that it hurt.
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
  { id: 'skin-hotdog', name: '🌭 Hot Dog', slot: 'skin', price: 0, locked: 'dungeon' }, // a Ruins chest prize
  { id: 'skin-prism', name: '💠 Prism', slot: 'skin', price: 0, locked: 'dungeon' }, // a Ruins chest prize (B5, post-Clarence)
  { id: 'skin-globe', name: '🌍 Globe', slot: 'skin', price: 0, locked: 'dungeon' }, // the Rob boss prize
  // Trails
  { id: 'stardust', name: 'Stardust', slot: 'trail', price: 5000 },
  { id: 'inferno', name: 'Inferno', slot: 'trail', price: 8000 },
  { id: 'lightning', name: 'Lightning', slot: 'trail', price: 10000 },
  { id: 'phoenix', name: 'Phoenix', slot: 'trail', price: 15000 }, // animated
  { id: 'trail-fart', name: '💨 Fart Cloud', slot: 'trail', price: 0, locked: 'dungeon' }, // a Ruins chest prize (B4 switch room)
  { id: 'trail-blood', name: '🩸 Blood Trail', slot: 'trail', price: 0, locked: 'dungeon' }, // a Ruins chest prize (B3 gore floor)
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
  { id: 'song-everlong', name: '🎸 Everlong (8-bit)', slot: 'song', price: 0, locked: 'dungeon', audio: '/everlong.mp3' }, // a Ruins chest prize (B4)
  { id: 'song-encounter', name: '⚔️ Encounter Theme', slot: 'song', price: 0, locked: 'dungeon', audio: '/encounter.mp3' }, // a Ruins chest prize (B5)
  { id: 'song-inthend', name: '🎧 In The End (8-bit)', slot: 'song', price: 0, locked: 'dungeon', audio: '/inthend.mp3' }, // Rob's anthem — a boss prize
  // 8-bit cover tsongs — all purchasable. Livin' on a Prayer also loops in the Tavern (enterTavern).
  { id: 'song-prayer', name: "🎸 Livin' on a Prayer (8-bit)", slot: 'song', price: 25000, audio: '/livin-on-a-prayer-8bit.mp3' },
  { id: 'song-gangsta', name: "🎤 Gangsta's Paradise (8-bit)", slot: 'song', price: 18000, audio: '/gangstas-paradise-8bit.mp3' },
  { id: 'song-heart', name: '🖤 Heart-Shaped Box (8-bit)', slot: 'song', price: 20000, audio: '/heart-shaped-box-8bit.mp3' },
  { id: 'song-android', name: '🤖 Paranoid Android (8-bit)', slot: 'song', price: 22000, audio: '/paranoid-android-8bit.mp3' },
  // Cars — drive them around the World map (slot 'car'; physics/look live in CARS above).
  { id: 'car-coupe', name: '🚗 Coupe', slot: 'car', price: 8000 },
  { id: 'car-drifter', name: '🏎️ Drift King', slot: 'car', price: 20000 },
  { id: 'car-muscle', name: '🚙 Muscle', slot: 'car', price: 35000 },
  { id: 'car-monster', name: '🛻 Monster Truck', slot: 'car', price: 0, locked: 'dungeon' }, // the Ruins locked-room prize
  // Boats (slot 'boat') — equipped alongside a car; usable on water. Look/physics live in CARS.
  { id: 'car-boat', name: "🛥️ Bill's Boat", slot: 'boat', price: 0, locked: 'fishing_junk' }, // fish up boat keys from junk to unlock (it's a yacht)
  { id: 'car-golfcart', name: '🛺 Golf Cart', slot: 'car', price: 0, locked: 'golf' }, // shoot 18 holes to unlock — drive it anywhere, not just the fairway
  // Car paint jobs (slot 'carcolor') — an optional repaint layered over whichever car you've
  // equipped (never a boat — the yacht always keeps its own colours); look lives in CAR_COLORS
  // below. Equip none to keep the car's stock paint.
  { id: 'carcolor-white', name: '⚪ Pearl White', slot: 'carcolor', price: 0 },
  { id: 'carcolor-black', name: '⚫ Matte Black', slot: 'carcolor', price: 0 },
  { id: 'carcolor-neon', name: '🟢 Neon Green', slot: 'carcolor', price: 2500 },
  { id: 'carcolor-gold', name: '🟡 Gold Rush', slot: 'carcolor', price: 3000 },
  { id: 'carcolor-flame', name: '🔥 Flame Job', slot: 'carcolor', price: 3500 },
  { id: 'carcolor-rainbow', name: '🌈 Rainbow', slot: 'carcolor', price: 6000 }, // animated — cycles hue in-world
  { id: 'carcolor-chrome', name: '⚙️ Liquid Chrome', slot: 'carcolor', price: 4500 }, // animated — pulses a moving specular shimmer in-world
  { id: 'carcolor-holo', name: '🌟 Holo Shift', slot: 'carcolor', price: 5500 }, // animated — cycles a narrow pastel hue band in-world
  { id: 'carcolor-police', name: '🚨 Police Flash', slot: 'carcolor', price: 5000 }, // animated — strobes red/blue in-world
  // Pets (slot 'pet') — follow you around the World map; look/animation keyed by PETS below.
  { id: 'pet-rock', name: '🪨 Pet Rock', slot: 'pet', price: 50000 },
  { id: 'pet-pikachu', name: '⚡ Pikachu', slot: 'pet', price: 100000 },
  { id: 'pet-pacman', name: '🟡 Pac-Man', slot: 'pet', price: 150000 },
  { id: 'pet-slime', name: '🟢 Crypt Slime', slot: 'pet', price: 0, locked: 'dungeon' }, // caught in the Ruins (B4 monster box)
  { id: 'pet-dragon', name: '🐉 Dragon', slot: 'pet', price: 0, locked: 'dungeon' }, // the Rob boss prize — flies around you
  { id: 'pet-tumbleweed', name: '🌵 Rusty (Tumbleweed)', slot: 'pet', price: 0, locked: 'desert' }, // Pete's road trip fund. It's a friend.
  { id: 'pet-swan', name: '🦢 Bartholomew (Swan)', slot: 'pet', price: 0, locked: 'club' }, // he chose you. the club pretends not to notice he's gone.
  // New common loot-box refresh items
  { id: 'beret', name: 'Beret', slot: 'hat', price: 1000 },
  { id: 'catears', name: 'Cat Ears', slot: 'hat', price: 2000 }, // animated
  { id: 'disco', name: '🪩 Disco Ball', slot: 'hat', price: 2000 }, // animated
  { id: 'ufo', name: '🛸 UFO', slot: 'hat', price: 2000 }, // animated
  { id: 'carbon', name: 'Carbon Fiber', slot: 'skin', price: 2000 }, // animated
  { id: 'mermaid', name: 'Mermaid', slot: 'skin', price: 2000 }, // animated
  { id: 'circuit', name: 'Circuit Board', slot: 'skin', price: 2000 }, // animated
  { id: 'kaleidoscope', name: 'Kaleidoscope', slot: 'skin', price: 2000 }, // animated
  // Ball trails — a fading comet tail behind the ball as it zips across the court
  { id: 'balltrail-comet',     name: 'Ball Comet',      slot: 'balltrail', price: 2000 },
  { id: 'balltrail-rainbow',   name: 'Rainbow Streak',  slot: 'balltrail', price: 3000 },
  { id: 'balltrail-fire',      name: 'Ball Inferno',    slot: 'balltrail', price: 5000 },
  { id: 'balltrail-ghost',     name: 'Ghost Trail',     slot: 'balltrail', price: 3500 },
  { id: 'balltrail-lightning', name: '⚡ Lightning',    slot: 'balltrail', price: 7000 },
  { id: 'balltrail-plasma',    name: '🔵 Plasma',       slot: 'balltrail', price: 8000 },
  { id: 'balltrail-galaxy',    name: '🌌 Galaxy',       slot: 'balltrail', price: 9000 },
  { id: 'balltrail-void',      name: '🕳️ Void',         slot: 'balltrail', price: 12000 },
  { id: 'balltrail-prism',     name: '🔺 Prism Split',   slot: 'balltrail', price: 13000 },
  // Goal celebrations — Rocket League-style screen explosion when you score
  { id: 'goalcelebr-confetti',    name: '🎊 Confetti',      slot: 'goalcelebr', price: 2000 },
  { id: 'goalcelebr-explosion',   name: '💥 Rocket Blast',  slot: 'goalcelebr', price: 5000 },
  { id: 'goalcelebr-fireworks',   name: '🎆 Fireworks',     slot: 'goalcelebr', price: 3500 },
  { id: 'goalcelebr-glitter',     name: '✨ Glitter Storm', slot: 'goalcelebr', price: 2500 },
  { id: 'goalcelebr-matrix',      name: '👾 Matrix',        slot: 'goalcelebr', price: 7500 },
  { id: 'goalcelebr-hyperspace',  name: '🚀 Hyperspace',    slot: 'goalcelebr', price: 10000 },
  { id: 'goalcelebr-supernova',   name: '💫 Supernova',     slot: 'goalcelebr', price: 15000 },
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
  { id: 'x-singularity', name: '🌀 Singularity',      slot: 'trail', cap: 1, rarity: 'mythic' },     // one-of-one grail
  { id: 'x-eclipse',     name: '🌑 Eclipse Trail',    slot: 'trail', cap: 3, rarity: 'legendary' },
  { id: 'x-prismhalo',   name: '💠 Prism Halo',       slot: 'hat',   cap: 3, rarity: 'legendary' },
  { id: 'x-jackpot',     name: '🎰 Jackpot Crown',    slot: 'hat',   cap: 3, rarity: 'legendary' },
  { id: 'x-founder',     name: '🪙 Founder',          slot: 'title', cap: 3, rarity: 'epic' },
  { id: 'x-quantum',     name: '⚛️ Quantum Skin',     slot: 'skin',  cap: 3, rarity: 'epic' },
  { id: 'x-midas',       name: '👑 Midas Touch',      slot: 'skin',  cap: 3, rarity: 'epic' },
] as const;
export function isExclusive(id: string): boolean {
  return EXCLUSIVES.some((x) => x.id === id);
}

export const CHAT_MAX_LEN = 200; // max characters per chat message
export const CHAT_HISTORY = 50; // recent messages kept/sent to new joiners
export const WORLD_SAY_MAX = 120; // max characters in a World speech bubble (press '/' to talk)
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
export const WORLD: { w: number; h: number; spawnX: number; spawnY: number } = {
  w: 4800, // widened east to make room for Robville, the suburban neighborhood (see WORLD_PARCELS)
  // Grown from 2200 — Robville's bulbs shifted 400 south to clear The Lake (see ROBVILLE_BULBS),
  // and the lower bulbs' own lot ring reaches close enough to the old bottom edge that it needed
  // the extra room too.
  h: 2600,
  // Just in front of the Arena (x1295–1775, y255–595), framing the Ruins (x1850+) to the right.
  // Offset a bit from Coach Vito's home spot (1710, 720) — dead center on top of him meant a
  // fresh player's own name tag landed stacked directly on top of his.
  spawnX: 1660,
  spawnY: 640,
};
export const WORLD_AVATAR = {
  r: 16,        // avatar body radius, world units
  speed: 280,   // on-foot walk speed, world units / second
} as const;

// The FULL traversable extent of the overworld: the town rect (WORLD) plus its frontiers —
// the desert west of x0, the country club north of y0, and the bog south of the town's bottom
// edge. Shared so the server relays positions anywhere a client can legitimately stand (it used
// to clamp to the town rect, which pinned frontier explorers to the map edge on everyone else's
// screen), and so client geometry derives from one source of truth.
export const WORLD_BOUNDS = {
  minX: -24000,           // ← the Great Western Nothing
  minY: -2600,            // ↑ the Tsong Country Club (grown to fit the real 18-hole course — keep in sync with CLUB.h in client/world.ts)
  maxX: 4800 + 9600,      // → the Frostreach (= WORLD.w + its width)
  maxY: 2200 + 4200,      // ↓ the Great Southern Damp (= WORLD.h + its depth)
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
  // The Monster Truck: the Ruins' locked-room prize. Heavy, planted, monstrous low-end grunt.
  { id: 'car-monster', name: 'Monster Truck', body: '#cc2222', accent: '#1a1a1a', speed: 600, accel: 820, turn: 2.0, grip: 0.92 },
  // Bill's Boat: a little white-and-navy yacht fished up from junk. Glides on water — low grip.
  { id: 'car-boat',    name: "Bill's Boat",  body: '#eef3f8', accent: '#2f6fa8', speed: 560, accel: 600, turn: 2.5, grip: 0.55 },
  // The Golf Cart: the 18-hole course's own prize. Slow and stately, but turns on a dime.
  { id: 'car-golfcart', name: 'Golf Cart', body: '#f4f0e0', accent: '#2f6b3f', speed: 420, accel: 520, turn: 3.4, grip: 0.9 },
] as const;
export function carById(id: string | null | undefined): CarSpec | null {
  if (!id) return null;
  return CARS.find((c) => c.id === id) ?? null;
}

// --- Car colors ---------------------------------------------------------------------------
// An optional repaint layered over whichever car you've equipped (slot 'carcolor', separate
// from the 'car' slot itself) — body/accent here override the CarSpec's defaults when equipped.
// Never applies to the boat, which always renders in its own colours.
export interface CarColorSpec {
  id: string;
  name: string;
  body: string;
  accent: string;
}
export const CAR_COLORS: readonly CarColorSpec[] = [
  { id: 'carcolor-white', name: 'Pearl White', body: '#f4f4f4', accent: '#c9c9c9' },
  { id: 'carcolor-black', name: 'Matte Black', body: '#1a1a1a', accent: '#0a0a0a' },
  { id: 'carcolor-neon', name: 'Neon Green', body: '#39ff14', accent: '#0a3d0a' },
  { id: 'carcolor-gold', name: 'Gold Rush', body: '#ffd23f', accent: '#8a6d1a' },
  { id: 'carcolor-flame', name: 'Flame Job', body: '#ff5e1a', accent: '#ffcf33' },
  { id: 'carcolor-rainbow', name: 'Rainbow', body: '#ff3df0', accent: '#3df0ff' }, // world.ts animates this one live; these are just the shop-swatch preview colours
  { id: 'carcolor-chrome', name: 'Liquid Chrome', body: '#c8c8c8', accent: '#f6f6f6' }, // world.ts animates a shimmer live; fallback swatch colours
  { id: 'carcolor-holo', name: 'Holo Shift', body: '#c48bff', accent: '#7ad8ff' }, // world.ts animates a hue-shift live; fallback swatch colours
  { id: 'carcolor-police', name: 'Police Flash', body: '#e21b1b', accent: '#1b3ee2' }, // world.ts animates a strobe live; fallback swatch colours
] as const;
export function carColorById(id: string | null | undefined): CarColorSpec | null {
  if (!id) return null;
  return CAR_COLORS.find((c) => c.id === id) ?? null;
}

// --- Pets -------------------------------------------------------------------------------
// A pet is a cosmetic that TRAILS BEHIND your avatar in the World — a little sprite that
// follows you around (unlike a car, which replaces/IS the avatar while driving). A pet id
// matches a COSMETICS entry with slot 'pet'. `kind` selects the custom drawn sprite in the
// World renderer; `emoji` is just the small shop-tile preview glyph.
export type PetKind = 'rock' | 'pikachu' | 'pacman' | 'slime' | 'dragon' | 'tumbleweed' | 'swan';
export const PETS: readonly { id: string; emoji: string; kind: PetKind }[] = [
  { id: 'pet-rock', emoji: '🪨', kind: 'rock' },       // a googly-eyed rock
  { id: 'pet-pikachu', emoji: '⚡', kind: 'pikachu' },  // Pikachu
  { id: 'pet-pacman', emoji: '🟡', kind: 'pacman' },    // Pac-Man, chomping as it follows
  { id: 'pet-slime', emoji: '🟢', kind: 'slime' },     // a Crypt Slime caught in the Ruins
  { id: 'pet-dragon', emoji: '🐉', kind: 'dragon' },   // a dragon that flies around you (Rob boss prize),
  { id: 'pet-tumbleweed', emoji: '🌵', kind: 'tumbleweed' },
  { id: 'pet-swan', emoji: '🦢', kind: 'swan' },
];
export function petById(id: string | null | undefined) {
  if (!id) return null;
  return PETS.find((p) => p.id === id) ?? null;
}

// What entering a building does (the client maps each `kind` to an action). Add a kind here
// and a handler on the client to introduce a new venue.
export type WorldBuildingKind = 'arena' | 'casino' | 'bank' | 'petshop' | 'doomportal' | 'pond' | 'bar' | 'parliament' | 'arcade' | 'dungeon' | 'temple' | 'bowling' | 'mcdonald' | 'shop' | 'hall' | 'noticeboard' | 'observatory';
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
  // Shrunk to ~0.72× their old footprints and re-centred near their old spots (so the auto-tuned
  // roads still meet their doors). Old: arena 480×340, casino/bank 440×320, petshop 420×300.
  // The Arena was grown back to its original 480×340 footprint (the maintainer wants it to read as
  // the town's main attraction) — right/bottom edges held fixed so the road spur and the Ruins'
  // 75-unit clearance to the east are untouched; it only grows north and west.
  { id: 'arena',  kind: 'arena',  name: 'TSONG ARENA', emoji: '🏓', x: 1295, y: 255,  w: 480, h: 340, color: '#3a4ea8' },
  { id: 'casino', kind: 'casino', name: 'CASINO',      emoji: '🎰', x: 500,  y: 1525, w: 320, h: 230, color: '#a8323a' },
  { id: 'bank',   kind: 'bank',   name: 'BANK',        emoji: '🏦', x: 2380, y: 1525, w: 320, h: 230, color: '#2f7d4f' },
  // A tiny dingy shack (not a real store) with a 'PETS' sign — strays mill around outside.
  { id: 'petshop', kind: 'petshop', name: 'PETS',  emoji: '🐾', x: 2455, y: 470,  w: 150, h: 130, color: '#7a4fa8' },
  // Hellfire portal to DOOM — small footprint just south of the central fountain, on the path.
  { id: 'doomportal', kind: 'doomportal', name: 'DOOM', emoji: '🔥', x: 1520, y: 1380, w: 160, h: 190, color: '#3a0000' },
  // Fishing pond — a body of water east of the plaza with a wooden pier on its west (plaza) side.
  // Footprint clears the plaza (x ends 1840), the petshop (x starts 2370) and the bank (y 1525+).
  { id: 'pond', kind: 'pond', name: 'FISHING POND', emoji: '🎣', x: 2020, y: 860, w: 300, h: 260, color: '#2a6f97' },
  // The Lake — a much bigger second body of water (kind 'pond' is genuinely generic: "add water
  // by adding pond buildings" per WATER's own comment in world.ts, so this gets fishing, a pier,
  // ripples and a boardable ellipse for free). North of the Notice Board/Hall of Fame (clear on x)
  // and of Robville's upper cul-de-sacs — moved up near the top of the map, with Robville's bulbs
  // shifted 400 south (see ROBVILLE_BULBS) to give ~300 units of real clearance from the actual lot
  // ring, not just the bulb circles, which is what the lake used to (barely) overlap.
  { id: 'lake', kind: 'pond', name: 'THE LAKE', emoji: '⛵', x: 3050, y: 100, w: 900, h: 450, color: '#2a6f97' },
  // The Tavern — south-of-centre off a path spur. Buy a beer, get progressively drunker.
  { id: 'bar', kind: 'bar', name: 'THE TAVERN', emoji: '🍺', x: 1020, y: 1600, w: 230, h: 180, color: '#5a3d2a' },
  // Parliament — a stately marble hall in the upper-left, home of the Nomic rules game. Walk in to
  // join the perpetual game where the players legislate their own rulebook.
  { id: 'parliament', kind: 'parliament', name: 'PARLIAMENT', emoji: '🏛️', x: 470, y: 420, w: 340, h: 240, color: '#7c8aa3' },
  // The Arcade — a neon-lit hall between Parliament and the Arena, home to the solo/co-op minigames
  // (Campaign, Type or Die, Street Demons racing, Super Tsong Bros).
  { id: 'arcade', kind: 'arcade', name: 'ARCADE', emoji: '🎮', x: 900, y: 430, w: 280, h: 200, color: '#3a2a5a' },
  // The Ruins — a crumbling overgrown stone doorway east of the Arena. Step in to descend into the
  // dungeon: torch-lit floors, random Pong encounters, loot, and a boss at the bottom.
  { id: 'dungeon', kind: 'dungeon', name: 'THE RUINS', emoji: '🏚️', x: 1850, y: 380, w: 200, h: 170, color: '#5d6a4c' },
  // The Temple — a pale stone sanctuary south of the plaza, devoted to the Order of the Eternal Volley.
  // Step inside to a hushed, candlelit nave; read the holy book at the lectern to receive a Blessing.
  { id: 'temple', kind: 'temple', name: 'THE TEMPLE', emoji: '⛪', x: 1560, y: 1730, w: 340, h: 270, color: '#d8cda0' },
  // Bolwoing Alley — east of the Robville connector, accessible via a short spur road.
  // Hosts 2–4 player turn-based bowling with server-side pin physics and strike celebrations.
  { id: 'bowling', kind: 'bowling', name: 'BOLWOING ALLEY', emoji: '🎳', x: 2890, y: 1390, w: 310, h: 220, color: '#1a1050' },
  // McDonald's — south of the pond, east of the Temple. Red facade, golden arches, enterable interior.
  // Cashier Mac, Grimace, and Ronald hold court inside. The fries are hot and fresh.
  { id: 'mcdonald', kind: 'mcdonald', name: "McDONALD'S", emoji: '🍔', x: 2050, y: 1870, w: 260, h: 200, color: '#cc0000' },
  // The General Store — south of the Casino, on its own short spur. Sells the same cosmetics/
  // vehicles/Daily Spin as the toolbar Shop; this is just a walk-in door into that same panel.
  { id: 'shop', kind: 'shop', name: 'GENERAL STORE', emoji: '🛍️', x: 480, y: 1820, w: 280, h: 200, color: '#c98a2e' },
  // Hall of Fame — a trophy hall NE of the plaza, between the pond and Bolwoing Alley. Displays
  // the live pong leaderboard and net-worth standings without needing to leave the World.
  { id: 'hall', kind: 'hall', name: 'HALL OF FAME', emoji: '🏆', x: 2700, y: 850, w: 280, h: 210, color: '#c9a227' },
  // Notice Board — a little kiosk NE of the plaza, north of the Hall of Fame. Posts the
  // Tournament bracket, the Season Pass, the Power-ups reference, and the Changelog — informational
  // panels that otherwise have no walk-up home once the toolbar is hidden behind World.
  { id: 'noticeboard', kind: 'noticeboard', name: 'NOTICE BOARD', emoji: '📌', x: 2700, y: 420, w: 260, h: 180, color: '#5a6a8a' },
  // The Observatory — a domed institute east of the Hall of Fame, on the grassy rise between
  // The Lake (ends y550) and Maple Court's lot ring (nearest lot starts y993 / x3192; the
  // footprint below clears it on y by ~50). The astronomers long ago swiveled the telescope
  // down at the town itself: walk in to browse live usage charts — who's on, what's being
  // played, where people go.
  { id: 'observatory', kind: 'observatory', name: 'THE OBSERVATORY', emoji: '🔭', x: 3120, y: 720, w: 280, h: 220, color: '#2e3d5c' },
] as const;

// --- Usage analytics ---------------------------------------------------------------------
// The payload of GET /api/usage, rendered by the Observatory's charts. Assembled in
// server/analytics.ts from the events table (or, without a DATABASE_URL, from the in-memory
// ring — 'memory' source, stats since boot only). Times are epoch ms; series are pre-bucketed
// server-side so the client just draws.
export interface UsageStats {
  generatedAt: number;
  source: 'db' | 'memory';
  onlineNow: number;                 // sockets currently connected
  players24h: number;                // distinct identities seen in the last 24h
  events24h: number;                 // tracked actions in the last 24h
  games24h: number;                  // game.* events in the last 24h
  hourly: { t: number; events: number; players: number }[];       // last 48 h, one point per hour
  daily: { day: string; players: number; events: number }[];      // last 14 days ('YYYY-MM-DD')
  games7d: { game: string; plays: number }[];                     // top games, last 7 days
  visits7d: { building: string; visits: number }[];               // top buildings walked into, last 7 days
  actions7d: { name: string; count: number }[];                   // top raw event names, last 7 days
  feed: { t: number; who: string; name: string }[];               // most recent events, newest first
  starOfWeek: { who: string; events: number } | null;             // busiest player of the last 7 days
}

// --- The Ruins dungeon economy: SERVER-AUTHORITATIVE so a tampered client can't mint coins. ---
// Chests keyed by 'floor:col,row'. The server pays a chest's coins (from the House) the first time
// a given player opens it, and tracks opened chests per account.
export const DUNGEON_CHEST_CONTENTS: Record<string, { coins?: number; potions?: number; spin?: boolean; cosmetic?: string; needsKey?: boolean; monster?: string; pet?: string; items?: string[] }> = {
  'B1:18,2': { cosmetic: 'mushroom' }, // 🍄 Mushroom Cap hat — the first-floor cosmetic
  'B1:9,9': { potions: 1 },
  // B2 — a free wheel-spin chest, a potion, a coin chest, plus the SEALED locked-room prize (34,24).
  'B2:26,3': { spin: true },   // spins the wheel in-dungeon; reward → run loot, granted on escape
  'B2:4,13': { potions: 1 },
  'B2:15,21': { coins: 2500 },
  'B2:34,24': { cosmetic: 'car-monster', needsKey: true }, // the sealed vault: a MONSTER TRUCK (needs the B3 key)
  // B3 — bigger, darker, tier-3 mobs; meatier loot for the longer floor.
  'B3:28,3': { cosmetic: 'trail-blood' }, // 🩸 Blood Trail — the gore-floor cosmetic
  'B3:4,13': { potions: 4 },               // generous: 4 potions on a long floor
  'B3:29,23': { cosmetic: 'skin-hotdog' }, // 🌭 Hot Dog paddle skin
  'B3:38,24': { potions: 2 },
  // B4 — the deep floor: a 5-potion chest right at the entrance, richest coins, another wheel spin, and
  // the switch-locked room's prize: a 💨 Fart Cloud trail.
  'B4:6,3': { potions: 5 },
  'B4:29,3': { cosmetic: 'song-everlong' }, // 🎸 Everlong battle theme
  'B4:12,4': { cosmetic: 'trail-fart' }, // behind the switch-sealed 'X' door
  'B4:4,14': { potions: 2 },
  'B4:28,14': { spin: true },
  'B4:4,27': { monster: 'slime', coins: 450, pet: 'pet-slime' }, // a MONSTER BOX: fight the slime — kill it for 450🪙, or capture it as a pet
  // B5 — the boss sanctum. These three only become lootable AFTER you beat Clarence the Gatekeeper.
  'B5:32,5': { cosmetic: 'song-encounter' }, // ⚔️ the Encounter battle theme (Clarence already drops potions)
  'B5:37,5': { coins: 5000 },                // the deepest coin haul in the Ruins
  'B5:42,5': { cosmetic: 'skin-prism' },     // 💠 Prism paddle skin
  // B6 — the final boss reward (granted on beating Rob; once per account). Not a findable tile chest.
  'B6:boss': { coins: 50000, items: ['song-inthend', 'title-pindropper', 'skin-globe', 'pet-dragon'] },
};
// Encounter-win payout keyed by the MOB'S TIER [min, max], not the floor. The server picks the amount
// from the tier's range (it never trusts a client-sent number) after checking the tier is legal here.
export const DUNGEON_TIER_COINS: Record<number, readonly [number, number]> = {
  1: [35, 75],    // Cave Bat, Crypt Slime
  2: [70, 140],   // Cursed Jsav (4 lives), The Warden (big paddle)
  3: [140, 260],  // Demon Fritz (roam), + B3's second mob
  4: [260, 460],  // Bone Rattler, Grave Wisp
  5: [460, 760],  // Stone Gargoyle, Cursed Wraith
};
// Which mob tiers may legitimately appear on each floor = the floor's own NEW tier + the one above it
// (carried down). The server uses this to reject a tampered win that claims a tier you couldn't fight.
export const DUNGEON_FLOOR_TIERS: Record<string, readonly number[]> = {
  B1: [1],
  B2: [1, 2],
  B3: [2, 3], // tier-3 new mobs + tier-2 carried down
  B4: [3, 4], // tier-4 new mobs + tier-3 carried down
};

// The town JAIL — a tiny barred cell just east of the Tavern. Try to drive after 2+ beers and the
// drunk-tank claims you: your avatar is locked behind these bars (server-persisted, so you can't
// log out to escape) until someone posts your 500🪙 bail. Walls are solid; the front is bars you can
// see (and be bailed) through. `cell` is the walkable interior the jailed avatar is clamped to.
export const JAIL = { x: 1330, y: 1610, w: 170, h: 150 } as const;
export const JAIL_WALL = 16;        // wall/bar thickness (world units)
export const BAIL_COST = 500;       // coins to post bail (→ the House)
export const JAIL_CELL = {
  x: JAIL.x + JAIL_WALL, y: JAIL.y + JAIL_WALL,
  w: JAIL.w - JAIL_WALL * 2, h: JAIL.h - JAIL_WALL * 2,
} as const;

// --- Robville: the suburban neighborhood -----------------------------------------------
// A charming subdivision on the east side of the map, reached by an avenue off the town's main
// street. A residential spine threads four cul-de-sac bulbs, each ringed by buyable lots. Buy an
// empty lot from the BANK for PARCEL_PRICE (coins → the House). Anti-monopoly rule: nobody may
// buy more than BANK_PARCEL_CAP lots (1/10 of all lots) FROM THE BANK — but you can buy any number
// from other players on the open market, where owners set their own asking price. Once you own a
// lot you can build a house on it (see HOUSE_KINDS) — and a built house travels with the lot when
// you sell it, so a furnished plot is worth more on the open market.
export const PARCEL_PRICE = 1000; // coins to buy an empty lot from the bank

// A cul-de-sac bulb: a paved circle at the dead end of a residential stem road. `stem` is the
// compass direction (radians, +x = east) from the bulb back toward the spine — the side of the
// ring kept clear of lots so the street can enter.
export interface RobBulb { cx: number; cy: number; r: number; stem: number; }
// cy shifted +400 south of the original 760/1640 — the lot RING around each bulb reaches roughly
// 310 units past the bulb's own radius (lot centers sit at r+140, and each lot is 120 wide), which
// is a lot further than it looks from the bulb circle alone. At the old cy:760 that put the
// northernmost lot's edge at y≈446, well inside The Lake's footprint (y100-550) — this shift (plus
// WORLD.h growing to match) gives it real clearance instead of just clearing the bulb itself.
export const ROBVILLE_BULBS: readonly RobBulb[] = [
  { cx: 3500, cy: 1160, r: 130, stem: 0 },        // Maple Court (west, upper)
  { cx: 4300, cy: 1160, r: 130, stem: Math.PI },  // Birch Circle (east, upper)
  { cx: 3500, cy: 2040, r: 130, stem: 0 },        // Willow Court (west, lower)
  { cx: 4300, cy: 2040, r: 130, stem: Math.PI },  // Cedar Circle (east, lower)
];

// One buyable lot. `x,y,w,h` is the lot footprint (top-left origin, world units — the future
// house pad); `cx,cy` is its center (where you stand to buy/sell, and where a house will sit).
export interface LandParcel { id: string; x: number; y: number; w: number; h: number; cx: number; cy: number; }
// The fixed set of lots, generated deterministically from the bulbs so the client (rendering +
// proximity) and the server (validation) agree exactly. Six lots ring each bulb, spread over the
// ~280° arc that faces away from the stem mouth.
export const WORLD_PARCELS: readonly LandParcel[] = (() => {
  const LOT = 120;                      // lot footprint side, world units
  const PER_BULB = 6;                   // lots ringing each cul-de-sac
  const ARC = (280 * Math.PI) / 180;    // arc the lots span (the rest is the stem mouth)
  const out: LandParcel[] = [];
  ROBVILLE_BULBS.forEach((b, bi) => {
    const dist = b.r + 140;             // lot-center distance from the bulb center (clears neighbors)
    for (let i = 0; i < PER_BULB; i++) {
      // Center the lot arc opposite the stem (b.stem + π), then step across it.
      const ang = b.stem + Math.PI - ARC / 2 + ((i + 0.5) / PER_BULB) * ARC;
      const cx = b.cx + dist * Math.cos(ang);
      const cy = b.cy + dist * Math.sin(ang);
      out.push({ id: `rv-${bi}-${i}`, x: cx - LOT / 2, y: cy - LOT / 2, w: LOT, h: LOT, cx, cy });
    }
  });
  return out;
})();
// Anti-monopoly cap: the most lots one player may EVER buy from the bank (1/10 of all lots, ≥1).
// Player-to-player purchases don't count toward it and are unlimited.
export const BANK_PARCEL_CAP = Math.max(1, Math.floor(WORLD_PARCELS.length / 10));

// The houses you can build on a lot you own. Cost (coins → the House, i.e. the local construction
// industry) scales with fanciness, from a humble straw hut to a full castle. Building one replaces
// whatever stood there before; demolishing is free. The house is part of the lot — it stays put
// when the lot changes hands. `emoji` is how it's drawn on the pad. Ordered cheapest → fanciest.
export interface HouseKind { id: string; name: string; emoji: string; cost: number; blurb: string; }
export const HOUSE_KINDS: readonly HouseKind[] = [
  { id: 'hut',      name: 'Straw Hut',      emoji: '🛖', cost: 500,    blurb: 'Four walls and a dream. Mostly walls.' },
  { id: 'cape',     name: 'Modest Cape',    emoji: '🏠', cost: 2_500,  blurb: 'A respectable little starter home.' },
  { id: 'cottage',  name: 'Cozy Cottage',   emoji: '🏡', cost: 6_000,  blurb: 'White picket fence, garden out back.' },
  { id: 'mushroom', name: 'Mushroom House', emoji: '🍄', cost: 12_000, blurb: 'Whimsical, fungal, surprisingly roomy.' },
  { id: 'bigtop',   name: 'The Big Top',    emoji: '🎪', cost: 16_000, blurb: 'Why live in a house when you can live in a circus?' },
  { id: 'pagoda',   name: 'Jade Pagoda',    emoji: '🏯', cost: 24_000, blurb: 'Tiered, serene, and very fancy.' },
  { id: 'mansion',  name: 'Marble Mansion', emoji: '🏛️', cost: 32_000, blurb: 'Columns. So many columns.' },
  { id: 'wizard',   name: 'Wizard Tower',   emoji: '🧙', cost: 45_000, blurb: 'Comes with a hat. Probably haunted.' },
  { id: 'castle',   name: 'Castle',         emoji: '🏰', cost: 75_000, blurb: 'A moat is extra. The flex is included.' },
  { id: 'ufo',      name: 'UFO Landing Pad', emoji: '🛸', cost: 120_000, blurb: 'Out of this world. The neighbors have questions.' },
];
export const HOUSE_BY_ID: ReadonlyMap<string, HouseKind> = new Map(HOUSE_KINDS.map((h) => [h.id, h]));

// --- Nomic (the Parliament sub-game) ---------------------------------------------------
// A standalone, self-amending RULES game in its own World building (🏛️ PARLIAMENT). NOT connected
// to the Pong game. The server enforces the *procedure* (turns, voting, scoring, rule numbering,
// mutability, win); humans write + interpret the free-text rule *bodies*. A proposal carries an
// English `text` PLUS an optional structured `effect` that moves exactly one enforced parameter —
// that's what makes self-amendment real and not just a comment box with vote buttons.
// One perpetual communal game for the whole server; winning a season seals the rulebook into the
// Hall and reseeds (rules carry forward, scores reset). See docs/nomic.md.

export type NomThreshold = 'majority' | 'twothirds' | 'unanimous';
export type NomProposalKind = 'enact' | 'amend' | 'repeal' | 'transmute';
export type NomVote = 'for' | 'against' | 'abstain';

// The enforced, self-amendable parameters — the procedural skeleton. Each is backed by a seed rule;
// a proposal `effect` mutates exactly one of them. Stored authoritatively in nomic_state.
export interface NomParams {
  threshold: NomThreshold;   // votes needed to pass a normal proposal (transmutes always need unanimity)
  pointsPerAdoption: number; // points the proposer scores when their change is adopted
  votesPerPlayer: number;    // votes each legislator may cast (currently a display/flavor cap; 1 = classic)
  winScore: number;          // points to win the season
  turnDir: 1 | -1;           // rotation direction through the seating order
  allowAbstain: boolean;     // whether Abstain is offered (abstentions never count toward the threshold)
}
export const NOM_DEFAULT_PARAMS: NomParams = {
  threshold: 'majority',
  pointsPerAdoption: 5,
  votesPerPlayer: 1,
  winScore: 100,
  turnDir: 1,
  allowAbstain: true,
};
// Bounds the server clamps proposal effects to, so nobody can legislate a stuck/unplayable game.
export const NOM_LIMITS = {
  minPoints: 1, maxPoints: 50,
  minVotes: 1, maxVotes: 5,
  minWin: 10, maxWin: 1000,
} as const;

// A structured mutation a proposal carries alongside its English body. Each variant names one knob
// and its new value. A proposal with no effect (null) is a pure-text rule — flavor / honor-system.
export type NomEffect =
  | { param: 'threshold'; value: NomThreshold }
  | { param: 'pointsPerAdoption'; value: number }
  | { param: 'votesPerPlayer'; value: number }
  | { param: 'winScore'; value: number }
  | { param: 'turnDir'; value: 1 | -1 }
  | { param: 'allowAbstain'; value: boolean };

// One rule in the live rulebook. num < 200 = immutable Constitution; >= 200 = mutable Body.
export interface NomRule {
  num: number;
  text: string;              // the free-text body humans read + interpret
  mutable: boolean;
  effect?: NomEffect | null; // the enforced knob this rule backs, if any
}

// The TSONG-flavored starting rulebook a fresh game (the very first season) seeds from.
export const NOM_SEED_RULES: readonly NomRule[] = [
  // Immutable Constitution (100s) — a transmute-to-mutable (unanimous) must come first to touch these.
  { num: 101, mutable: false, text: 'All players must obey the rules in force.' },
  { num: 102, mutable: false, text: 'Immutable rules (the 100s) outrank mutable rules (the 200s); where a mutable rule conflicts with an immutable one, the immutable rule wins.' },
  { num: 103, mutable: false, text: 'A “rule change” means enacting a new rule, amending or repealing a rule, or transmuting a rule between immutable and mutable.' },
  { num: 104, mutable: false, text: 'Players take turns in the rotation shown on the floor. On your turn you put exactly one rule change to the floor.' },
  { num: 105, mutable: false, text: 'A rule change passes by the threshold then in force and is adopted. Transmutations always require unanimity.' },
  { num: 106, mutable: false, text: 'An adopted new rule takes the lowest unused number in its class (immutable 100s, mutable 200s+).' },
  { num: 107, mutable: false, text: 'Adopting your proposed rule change scores you the points then in force.' },
  { num: 108, mutable: false, text: 'The first player to reach the winning score wins the season; the rulebook is sealed into the Hall of Rulebooks and a new season begins from where it left off.' },
  { num: 109, mutable: false, text: 'Whatever is not prohibited by a rule is permitted. 🏓' },
  { num: 110, mutable: false, text: 'If the rules contradict or fall silent on a question, the Speaker (the current turn-holder) — or a Judge they appoint — rules on it; the ruling stands until a rule change overturns it.' },
  // Mutable Body (200s) — each backs an enforced knob, so turn one teaches that the numbers are yours.
  { num: 201, mutable: true, text: 'A proposal passes by a simple majority of the votes cast.', effect: { param: 'threshold', value: 'majority' } },
  { num: 202, mutable: true, text: 'Adopting a rule change scores its proposer 5 points.', effect: { param: 'pointsPerAdoption', value: 5 } },
  { num: 203, mutable: true, text: 'Players vote For, Against, or Abstain; abstentions do not count toward the threshold.', effect: { param: 'allowAbstain', value: true } },
  { num: 204, mutable: true, text: 'Each player has one vote.', effect: { param: 'votesPerPlayer', value: 1 } },
  { num: 205, mutable: true, text: 'The winning score is 100 points.', effect: { param: 'winScore', value: 100 } },
  { num: 206, mutable: true, text: 'Turn order runs in seating order and wraps around.', effect: { param: 'turnDir', value: 1 } },
  { num: 207, mutable: true, text: 'Every rule body shall be written in good cheer.' },
] as const;

// A seated legislator (persisted by stable player id so scores survive sessions/reconnects).
export interface NomScore { id: string; name: string; color: string; points: number; }

// One vote on the floor.
export interface NomVoteRecord { id: string; name: string; vote: NomVote; }

// The proposal currently on the floor (or a resolved one kept for the log).
export interface NomProposal {
  id: number;
  kind: NomProposalKind;
  proposer: string;            // member id
  proposerName: string;
  text: string;                // English body (enact/amend) or rationale (repeal/transmute)
  target?: number | null;      // rule number for amend / repeal / transmute
  effect?: NomEffect | null;   // structured knob change, if any
  ruleClass?: 'immutable' | 'mutable'; // for enact: which class to number the new rule into
  votes: NomVoteRecord[];
  status: 'open' | 'passed' | 'failed';
}

// One line of parliamentary history.
export interface NomLogEntry { id: number; text: string; time: number; }

// The full parliament snapshot broadcast to everyone in the building.
export interface NomStateMsg {
  type: 'nomState';
  you: string;                  // this client's member id ('' if not seated)
  yourTurn: boolean;            // convenience: is it this client's turn to propose?
  season: number;
  params: NomParams;
  rules: NomRule[];             // the live rulebook, ascending by number
  scores: NomScore[];           // every legislator who has ever played this season, by points desc
  members: string[];            // all legislators in turn order (includes offline)
  online: string[];             // subset of members currently connected to the Parliament
  turn: string | null;          // member id whose turn it is (the Speaker), null if nobody seated
  proposal: NomProposal | null; // what's on the floor, or null between turns
  log: NomLogEntry[];           // recent history, oldest → newest
  winner: string | null;        // winner's name, set briefly when a season is won before the reseed
}

// --- Fishing minigame ---
// The solo fishing overlay (client/fishing.ts) rolls a tier, then a species within that tier,
// then a size between minLb/maxLb. Rarer tiers fight harder in the reel mini-game and pay more
// (House-funded, server-picked — see lobby.fishCatch). The client only sends tier + sizeLb back;
// it never names a coin amount, so a tampered client can't mint money.
export type FishTier = 'junk' | 'common' | 'uncommon' | 'rare' | 'legendary';
export interface FishSpecies { id: string; name: string; tier: FishTier; minLb: number; maxLb: number; }
export const FISH: readonly FishSpecies[] = [
  // junk — barely worth reeling in
  { id: 'boot',      name: '🥾 Old Boot',       tier: 'junk',      minLb: 0.5, maxLb: 3 },
  { id: 'can',       name: '🥫 Soda Can',       tier: 'junk',      minLb: 0.1, maxLb: 1 },
  { id: 'seaweed',   name: '🌿 Seaweed',        tier: 'junk',      minLb: 0.2, maxLb: 2 },
  // common
  { id: 'minnow',    name: '🐟 Minnow',         tier: 'common',    minLb: 0.1, maxLb: 0.8 },
  { id: 'perch',     name: '🐟 Perch',          tier: 'common',    minLb: 0.5, maxLb: 3 },
  { id: 'sunfish',   name: '🐠 Sunfish',        tier: 'common',    minLb: 0.4, maxLb: 2.5 },
  // uncommon
  { id: 'bass',      name: '🐟 Largemouth Bass', tier: 'uncommon', minLb: 2, maxLb: 12 },
  { id: 'trout',     name: '🐟 Rainbow Trout',   tier: 'uncommon', minLb: 1.5, maxLb: 9 },
  { id: 'bluegill',  name: '🐠 Bluegill',        tier: 'uncommon', minLb: 0.3, maxLb: 3 },
  // rare
  { id: 'catfish',   name: '🐱 Giant Catfish',  tier: 'rare',      minLb: 10, maxLb: 60 },
  { id: 'koi',       name: '✨ Golden Koi',      tier: 'rare',      minLb: 5, maxLb: 30 },
  { id: 'salmon',    name: '🐟 King Salmon',     tier: 'rare',      minLb: 15, maxLb: 80 },
  { id: 'sturgeon',  name: '🦈 Sturgeon',        tier: 'rare',      minLb: 20, maxLb: 150 },
  // legendary — tsong-themed monsters of the deep
  { id: 'daviswhale', name: '🐋 Davis Whale',   tier: 'legendary', minLb: 200, maxLb: 1500 },
  { id: 'kraken',     name: '🦑 Ancient Kraken', tier: 'legendary', minLb: 500, maxLb: 5000 },
] as const;
// Tier roll weights (sum 100): junk 10 / common 46 / uncommon 27 / rare 13 / legendary 4.
export const FISH_TIER_WEIGHTS: Readonly<Record<FishTier, number>> = {
  junk: 10, common: 46, uncommon: 27, rare: 13, legendary: 4,
};
export const FISH_TIERS: readonly FishTier[] = ['junk', 'common', 'uncommon', 'rare', 'legendary'];

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
  carColor?: string | null; // equipped paint job overriding the car's stock colours, or null/undefined
  pet?: string | null; // pet id trailing behind this avatar, or null/undefined when none
  bot?: boolean;       // true for netizen avatars
  jailed?: boolean;    // true while locked in the jail cell (others can pay to bail them out)
}
export interface WorldMsg {
  type: 'world';
  avatars: WorldAvatar[];
}

// One Robville lot's ownership/market state. `mine` and the wallet-ish counters are
// recipient-specific, so LandMsg is built per-player (like the marketplace book).
export interface LandParcelView {
  id: string;
  ownerName: string | null; // null = bank-owned (buyable for PARCEL_PRICE); else the owner's nickname
  mine: boolean;            // true if YOU own this lot
  ask: number | null;       // asking price if the owner has it listed for sale, else null
  house: string | null;     // a HOUSE_KINDS id if a house is built here, else null (empty lot)
}
export interface LandMsg {
  type: 'land';
  parcels: LandParcelView[];
  bankBought: number; // how many lots YOU'VE bought from the bank so far (lifetime)
  bankCap: number;    // BANK_PARCEL_CAP — so the client can show "2 of 2 used"
}

// A live in-world chat line, fanned out to everyone in the World (not replayed on join). The
// client pops `text` as a speech bubble over the avatar with id `id` for a few seconds.
export interface WorldSayMsg {
  type: 'worldSay';
  id: string;   // speaker's avatar/connection id (matches WorldAvatar.id / YouMsg.id)
  name: string; // speaker's nickname (for an optional log/fallback)
  text: string;
  say?: boolean; // true → spoken via the "Say" popup (Y); renders the bubble in purple
}

// The overworld arsenal. Every weapon draws from its own ammo pool, refilled by crates that
// respawn around the map. `rocket` is the original launcher; the rest were added alongside it.
export type WorldWeapon =
  | 'rocket'  // 🚀 slow missile, big blast radius
  | 'mg'      // 🔫 rapid-fire bullets, pinpoint hits
  | 'laser'   // ⚡ instant piercing beam
  | 'void'    // 🕳️ singularity — collapses everything inward, then detonates
  | 'snow';   // ❄️ a lobbed snowball — harmless, humiliating (packed in the Frostreach)

// How a receiver should draw an incoming WorldBoomMsg. Omitted = 'blast' (the classic fireball),
// so old clients and car crashes keep their current look.
export type WorldFx =
  | 'blast'   // full fireball (car crash, rocket)
  | 'hit'     // small spark — a machine-gun round landing
  | 'zap'     // laser scorch
  | 'void'    // a black hole opens, drags everything in, then blows
  | 'snow';   // a snowball splat — knocks nobody's car out, ruins everybody's dignity

// Runtime lists of the above, for validating what arrives off the wire.
export const WORLD_WEAPONS: readonly WorldWeapon[] = ['rocket', 'mg', 'laser', 'void', 'snow'];
export const WORLD_FX: readonly WorldFx[] = ['blast', 'hit', 'zap', 'void', 'snow'];

// A car blew up (car-vs-car collision or a high-speed building crash) at this world point. Fanned
// out to everyone else in the world so the fireball is visible to all, not just the crasher.
export interface WorldBoomMsg {
  type: 'worldBoom';
  x: number;
  y: number;
  r?: number;      // blast radius (weapon strikes); when >0 receivers also take blast effects, not just the visual
  fx?: WorldFx;    // which effect to draw; omitted = 'blast'
  pid?: string;    // shooter's pid — set by server for kill attribution during Road Rage
}

// Road Rage event — broadcast when the mode starts, ends, or standings change.
export interface WorldRoadRageMsg {
  type: 'worldRoadRage';
  active: boolean;
  endsAt: number;  // ms epoch timestamp; 0 when active=false
  standings: { name: string; kills: number }[];
}

// A player fired a weapon from (x,y) heading at angle a — fanned out so everyone watches the shot.
// Damage is authoritative on the firer and arrives separately as a WorldBoomMsg; what receivers
// draw from this message is purely cosmetic.
export interface WorldRocketMsg {
  type: 'worldRocket';
  x: number;
  y: number;
  a: number;
  w?: WorldWeapon; // which weapon; omitted = 'rocket' (what old clients send)
  len?: number;    // laser only: how far the beam reached before it hit something
}

// City Tycoon trade terms: properties + cash + jail-free cards offered in either direction.
export interface CrTradeOffer {
  offerProps: number[]; offerCash: number; offerJailFree: number;
  wantProps: number[]; wantCash: number; wantJailFree: number;
}

// --- Client -> Server ---
export type ClientMsg =
  // pid = stable per-browser identity; color = chosen paddle color
  | { type: 'join'; nickname: string; pid: string; color?: string }
  // User settings (mute, chat toggles, boss-key target…) to persist on the account. Partial:
  // only the changed keys are sent; the server merges them into the stored set.
  | { type: 'prefs'; prefs: Record<string, string> }
  // Usage analytics breadcrumb for a client-side-only action (walking into a building, an
  // interior room…). The server namespaces it under 'visit.' — a client can't spoof the
  // server-authoritative event names — rate-limits it, and drops anything malformed.
  | { type: 'track'; name: string }
  | { type: 'claim'; side?: Side } // preferred side; omitted = auto-assign to the smaller team
  | { type: 'paddle'; y: number; x?: number } // desired paddle center Y (and optional roam inset X), in court units
  | { type: 'chat'; text: string }
  | { type: 'reaction'; emoji: string } // a floating emoji reaction, shown to everyone
  | { type: 'summonPlane' } // secret: summon the banner-plane for the whole room to see
  | { type: 'stress'; amount: number } // a bad friend-sim interaction — bump this player's cortisol
  // Type Racer: a correct keystroke typed while the ball is heading AWAY — relayed to the
  // other side, whose paddles get knocked a quarter-step off course (see TypeShoveMsg).
  | { type: 'typeShove' }
  | { type: 'mode'; closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean; arena?: boolean; viewMode?: string; breakout?: boolean; fog?: boolean; portal?: boolean; bumpers?: boolean; typeRacer?: boolean } // toggle game modes
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
  | { type: 'questClaim'; quest: string } // claim a World objective reward (server grants once per player)
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
  | { type: 'sbJoin' } // take a slot in the Super Tsong Bros lobby (2–4 players)
  | { type: 'sbLeave' } // leave the Super Tsong Bros lobby / match
  | { type: 'sbPick'; fighter: string } // lock in a fighter for the character-select gate
  | { type: 'sbStart' } // (host only) start the Super Tsong Bros match (needs ≥2 players, all locked)
  | { type: 'sbEnd'; winner: number } // (host only) report the winning slot so the server pays the winner
  | { type: 'sbRelay'; data: unknown } // forward an opaque Super Tsong Bros payload to all other participants
  | { type: 'trnJoin' } // take a slot in the Tron light-cycle lobby (1–4 players; bots fill empty seats)
  | { type: 'trnLeave' } // leave the Tron lobby / match
  | { type: 'trnStart' } // (host only) start the match (solo start = you vs bots, no payout)
  | { type: 'trnEnd'; winner: number } // (host only) report winning slot (-1 = a bot won); server pays only multi-human matches
  | { type: 'trnRelay'; data: unknown } // forward an opaque Tron payload to all other riders
  | { type: 'ghScore'; song: string; diff: string; score: number } // Tsong Hero run finished — record the best
  | { type: 'waJoin' } // take a slot in the Tsong Artillery lobby (1–4 players; bots fill empty seats)
  | { type: 'waLeave' } // leave the Artillery lobby / match
  | { type: 'waStart' } // (host only) start the match (solo start = you vs bots, no payout)
  | { type: 'waEnd'; winner: number; winner2?: number } // (host only) winning slot(s) — two for 2v2 team wins (-1 = nobody paid)
  | { type: 'waRelay'; data: unknown } // forward an opaque Artillery payload to all other players
  | { type: 'fountainWish' } // toss 10 coins in the plaza fountain (tiny chance of the Wisher title)
  | { type: 'mobKill'; kind: string } // downed a biome critter → coins + XP by species (server owns the reward table), rate-limited
  | { type: 'worldBank' } // reached town alive → bank the at-risk mob-loot purse into the wallet
  | { type: 'worldDied' } // died out in the wild → forfeit the unbanked purse
  | { type: 'clubJoin' } // apply to the Country Club (server validates the 1,000,000🪙 initiation fee)
  | { type: 'clubDrink'; tier: number } // order off the 19th Hole's menu (1=House Pour, 2='52 Reserve, 3=Founder's Vintage; server charges, effects mirror buyBeer)
  | { type: 'bgJoin'; game: string } // take a seat at a board-game table (chess/morris/billiards; 2 seats, PvP only)
  | { type: 'bgLeave'; game: string } // leave the board-game lobby / match
  | { type: 'bgStake'; game: string; stake: number } // (host only, pre-start) set the winner-takes-all stake
  | { type: 'bgStart'; game: string } // (host only) start — requires all seats consented; server escrows the stake
  | { type: 'bgRelay'; game: string; data: unknown } // forward an opaque board-game payload to the other seat
  | { type: 'bgResult'; game: string; winner: number } // report the finish (winner slot, -1 = draw) — first report settles the pot
  | { type: 'tntJoin' } // take a slot in the TNT Explosion Rally lobby (1v1 bomb-parry maze duel)
  | { type: 'tntLeave' } // leave the TNT Explosion Rally lobby / match
  | { type: 'tntStart' } // (host only) start the match (solo start = practice vs the TNT Bot, no payout)
  | { type: 'tntEnd'; winner: number } // (host only) report the winning slot so the server pays the winner (-1 = the bot won)
  | { type: 'tntRelay'; data: unknown } // forward an opaque TNT Explosion Rally payload to the other player
  | { type: 'mjJoin' } // take a slot in the Monster Jam lobby (1v1 monster-truck stunt showdown)
  | { type: 'mjLeave' } // leave the Monster Jam lobby / show
  | { type: 'mjStart' } // (host only) start the show (solo start = you vs Crushbot 9000, no payout)
  | { type: 'mjEnd'; winner: number } // (host only) report the winning slot so the server pays the winner (-1 = bot/draw)
  | { type: 'mjRelay'; data: unknown } // forward an opaque Monster Jam payload to the other player
  | { type: 'tdJoin' } // join the shared co-op "Type or Die" arena
  | { type: 'tdLeave' } // leave the Type or Die arena
  | { type: 'tdStart' } // (any participant) start the next Type or Die run from the waiting room
  | { type: 'tdTarget'; id: number | null } // soft-lock the monster you're currently typing (null = release)
  | { type: 'tdKill'; id: number } // claim a kill: you finished typing this monster's word
  | { type: 'campaignScore'; score: number; stage: number; won: boolean } // record a campaign run (arcade score, furthest stage, whether Davis fell)
  | { type: 'fishCatch'; tier: string; sizeLb: number } // landed a fish — server picks the House-funded coin reward by tier (client never sends coins)
  | { type: 'golfScore'; strokes: number } // finished all 18 holes (solo or PvP) — server keeps each player's best total for the course leaderboard
  | { type: 'shopBuy'; item: string } // buy a cosmetic from the shop
  | { type: 'shopEquip'; slot: 'hat' | 'skin' | 'trail' | 'balltrail' | 'goalcelebr' | 'title' | 'song' | 'car' | 'boat' | 'pet' | 'carcolor'; item: string | null } // equip (item) or unequip (null) a cosmetic
  | { type: 'bet'; side: Side; amount: number } // spectator wagers coins on a side of the live duel
  | { type: 'dailySpin' } // claim the once-per-24h reward spin
  | { type: 'stockInvest'; coin: string; amount: number; side?: StockSide } // open a long or short position
  | { type: 'stockCashOut'; coin: string; side?: StockSide; fraction?: number } // close a long/short position — all of it, or a 0–1 fraction (partial cash-out)
  | { type: 'getLoan'; amount: number } // borrow `amount` coins from Davis (owe 1.5× back by the daily 5pm collection)
  | { type: 'repayLoan' } // pay Davis the full 1.5× owed and clear the loan
  | { type: 'roulette'; bets: RouletteBet[] } // stake coins on a single spin of the casino wheel
  | { type: 'bjBet'; amount: number } // start a blackjack hand with this wager
  | { type: 'bjAction'; action: BjAction } // hit, stand, or double down
  | { type: 'crapsRoll'; pass: number; dontPass: number } // roll the dice with pass/don't-pass bets
  | { type: 'crashBet'; amount: number; autoCashout?: number } // bet on the next crash round (optional auto-cashout multiplier)
  | { type: 'crashCancelBet' } // cancel a placed bet while the betting window is still open
  | { type: 'crashCashout' } // cash out of the current live crash round
  | { type: 'slotsSpin'; amount: number } // spin the 3-reel slot machine with this wager
  | { type: 'plinko'; amount: number } // drop a ball down the 8-row pegboard
  | { type: 'horseReq' } // request a fresh race card (5 horses with shuffled odds)
  | { type: 'horseBet'; horse: number; amount: number } // 0-indexed horse choice + wager
  | { type: 'hiloBet'; amount: number } // start a Hi-Lo hand with this wager
  | { type: 'hiloGuess'; guess: 'hi' | 'lo' } // guess Higher or Lower than the current card
  | { type: 'hiloCashout' } // cash out the current Hi-Lo streak
  | { type: 'minesBet'; amount: number; mines: number } // start a Mines hand (1–24 mines on a 5×5 grid)
  | { type: 'minesReveal'; cell: number } // flip tile at index 0–24
  | { type: 'minesCashout' } // collect winnings on the current Mines hand
  | { type: 'balanceSheetReq'; rank?: number; self?: boolean } // peek at a net-worth board player's balance sheet (by rank, or self for the requesting player)
  | { type: 'lootBoxOpen' } // open a loot box: spend coins, roll a weighted prize (common cosmetic / House coins / capped-rare exclusive)
  | { type: 'marketList'; instanceId: number; ask: number } // list an owned exclusive instance on the marketplace for `ask` coins
  | { type: 'marketCancel'; listingId: number } // cancel one of your own listings
  | { type: 'marketBuy'; item: string } // buy the lowest-ask listed instance of an exclusive item
  | { type: 'marketReq' } // request the current marketplace book (listings + floors + supply)
  | { type: 'loanBookReq' } // request the public open-loan book (for the clickable stability-bar modal)
  | { type: 'worldEnter' } // step into the free-roam world map (start sending/receiving avatar positions)
  | { type: 'worldLeave' } // leave the world map
  | { type: 'worldMove'; x: number; y: number; a?: number; car?: string | null; pet?: string | null; carColor?: string | null } // client-authoritative avatar position (world units), heading + car when driving, pet trailing, car paint job
  | { type: 'worldChat'; text: string; say?: boolean } // say a line in the World — pops as a speech bubble over your avatar; say=true (the Y popup) renders it purple
  | { type: 'worldBoom'; x: number; y: number; r?: number; fx?: WorldFx } // an explosion here (car crash or weapon strike) — broadcast the effect; r>0 = a damaging blast
  | { type: 'worldRocket'; x: number; y: number; a: number; w?: WorldWeapon; len?: number } // we fired here, heading a → broadcast so others see the shot
  | { type: 'worldBlownUp'; car: boolean; self: boolean; killedBy?: string } // a blast got us; killedBy = shooter pid for Road Rage kill attribution
  | { type: 'worldRoadRage' } // start a Road Rage PvP event (any player can trigger; server enforces cooldown)
  // --- Robville land (the suburban neighborhood) ---
  | { type: 'landReq' } // request the current Robville parcel ownership/market book
  | { type: 'landBuyBank'; id: string } // buy an empty lot from the bank for PARCEL_PRICE (subject to BANK_PARCEL_CAP)
  | { type: 'landList'; id: string; ask: number } // list your lot for sale at `ask` coins
  | { type: 'landUnlist'; id: string } // take your lot back off the market
  | { type: 'landBuy'; id: string } // buy a listed lot from its owner at the asking price (no cap)
  | { type: 'houseBuild'; id: string; house: string } // build a HOUSE_KINDS house on a lot you own (coins → House)
  | { type: 'houseDemolish'; id: string } // tear the house down on a lot you own (free; back to empty lot)
  | { type: 'migrate'; oldPid: string } // one-time: merge a UUID guest account into the signed-in Google account
  | { type: 'netizenInfoReq'; netizenId: string }
  | { type: 'netizenChallenge'; netizenId: string; wager: number }
  | { type: 'newsReq' }
  | { type: 'houseReq' } // request the House/Fed dashboard snapshot
  | { type: 'bondBuy'; amount: number; termDays: number } // buy a Treasury bond (locks coins for a term)
  | { type: 'bondWithdraw'; id: string } // redeem a bond early (forfeit interest + 5% penalty)
  | { type: 'auctionBid'; amount: number } // bid on the current Fed exclusive auction
  | { type: 'buyBeer' } // buy a beer at the Tavern (20🪙 → House); ups your drunk level (cut off at 6)
  | { type: 'buyMcFood'; item: 'fries' | 'bigmac' | 'mcflurry' | 'happymeal' } // buy food at McDonald's; server charges coins + sends mcFoodResult
  | { type: 'jail' } // self-report: tried to drunk-drive (server verifies drunkLevel ≥ 2 and jails you)
  | { type: 'bail'; targetId: string } // pay 500🪙 to bail a jailed player out (targetId = their avatar id; may be your own)
  // --- The Ruins dungeon (server owns the coin awards + which chests you've opened) ---
  | { type: 'dungeonSync' } // entering the Ruins: ask which chests this player has already opened
  | { type: 'dungeonChest'; chest: string; captured?: boolean } // open a chest (server pays once). captured=true → a "monster box" mob was caught → grant its pet instead of coins
  | { type: 'dungeonWin'; floor: string; tier: number } // won an encounter (adds a TIER-ranged amount to the run purse)
  | { type: 'dungeonTakeKey' } // took the key from the dying B3 adventurer → server marks the run-key
  | { type: 'dungeonExit'; escaped: boolean } // left the Ruins: escaped=true pays the purse (from House); false forfeits
  // --- Nomic (the Parliament sub-game) ---
  | { type: 'nomEnter' } // enter the Parliament: seat as a legislator + subscribe to its state
  | { type: 'nomLeave' } // leave the Parliament (unseat + unsubscribe)
  | { type: 'nomPropose'; kind: NomProposalKind; text: string; target?: number; effect?: NomEffect | null; ruleClass?: 'immutable' | 'mutable' } // (your turn) put a rule change on the floor
  | { type: 'nomVote'; vote: NomVote } // cast your vote on the proposal currently on the floor
  | { type: 'nomResolve' } // (the Speaker / proposer) call the vote and resolve the floor early
  | { type: 'eloProfileReq'; rank: number; self?: true }
  | { type: 'seasonPassReq' }                // request a fresh season pass state
  | { type: 'seasonClaim'; id: string }      // claim a completed weekly challenge reward
  | { type: 'replayWatching'; watching: boolean } // hold/release serve countdown during goal replay
  // --- Bolwoing Alley ---
  | { type: 'bowlJoin' }                          // enter/create a bowling room
  | { type: 'bowlReady' }                         // mark self as ready to start
  | { type: 'bowlThrow'; offset: number; power: number } // make a throw (offset −1..1, power 0..1)
  | { type: 'bowlLeave' }                         // leave the bowling room
  // --- City Tycoon (Monopoly-style board game) ---
  | { type: 'crJoin' }                            // enter/create a City Tycoon room
  | { type: 'crLeave' }                           // leave the room
  | { type: 'crReady' }                           // mark self ready to start
  | { type: 'crRoll' }                            // roll the dice on your turn
  | { type: 'crBuy' }                             // buy the property you landed on
  | { type: 'crPass' }                            // decline → send it to auction
  | { type: 'crAuctionBid'; amount: number }      // bid in the current auction
  | { type: 'crBuild'; position: number }         // build a house/hotel on a lot you own
  | { type: 'crUnmortgage'; position: number }    // pay off a mortgage (+10% interest) on a lot you own
  | { type: 'crEndTurn' }                         // end your turn
  | { type: 'crAddBot' }                          // drop an AI tycoon into an open seat (waiting room only)
  | { type: 'crRemoveBot'; pid: string }          // kick a bot from the room
  | { type: 'crPayBail' }                         // pay $50 to leave the drunk tank on demand
  | { type: 'crUseJailFree' }                     // spend a held jail-free card to leave the drunk tank
  | { type: 'crProposeTrade'; toPid: string; offer: CrTradeOffer } // propose a property/cash/jail-free trade to another player
  | { type: 'crRespondTrade'; tradeId: number; accept: boolean } // accept/reject a trade offered to you
  | { type: 'crCancelTrade'; tradeId: number }    // withdraw a trade you proposed
  | { type: 'crCounterTrade'; tradeId: number; offer: CrTradeOffer } // reply to a trade with different terms
  | { type: 'crChat'; text: string };             // send a chat line to your City Tycoon room

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
  balltrail?: string | null; // equipped ball trail cosmetic
  goalcelebr?: string | null; // equipped goal celebration cosmetic
  title?: string | null; // equipped name title (flair shown by the name)
  cortisol?: number; // 0..100 live stress level — drives this player's HUD meter + low-cortisol jitter
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
  cortisol?: number; // 0..100 live stress level
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
  ballTrail: string | null; // active ball trail cosmetic id (from the player who last hit)
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
  // `angle` (radians) is 0 for axis-aligned; non-zero for diamond/rotated variants.
  blocks: { x: number; y: number; w: number; h: number; angle?: number }[];
  fog: boolean;    // "fog of war": ball invisible except close to either paddle
  portal: boolean; // "portal walls": top/bottom walls teleport the ball to a random Y
  bumpers: boolean; // "bumpers" mode: five static pinball pegs in the center
  // One-frame flash per bumper (index matches BUMPER_POSITIONS). True the tick the ball hit it.
  bumperFlash: boolean[];
  // "Type racer" mode: mouse/arrow paddle control is off — players type sentences and each
  // correct character steps their paddle toward where the ball will land. Movement itself
  // stays client-driven (the usual 'paddle' message); the server only carries the toggle.
  typeRacer: boolean;
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
  tOff?: number; // day/night clock offset (ms), randomized per server boot — only on the first 'you'
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
  selfElo?: number;
  selfRank?: number;
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
  // The recipient's own row + global rank, sent when they fall below the visible top-N so the
  // client can pin them to the bottom of the board. Omitted when they're already shown.
  selfRow?: NetWorthRow;
  selfRank?: number;
}

// One row of the Cortisol ("Calmest") board: the player's current stress level, ranked low→high
// (calmest on top). Rises with bad friend-sim interactions, long rallies, and near-elimination;
// decays back toward calm over time.
export interface CortisolRow {
  name: string;
  cortisol: number; // 0..100 current stress level
  title?: string | null; // equipped title id (flair shown by the name)
}

// Broadcast alongside the other standings — periodically (cortisol drifts as it decays) and on
// connect. `selfCortisol` / `selfRank` pin the recipient's own row when they're below the top-N.
export interface CortisolMsg {
  type: 'cortisol';
  rows: CortisolRow[];
  selfCortisol?: number;
  selfRank?: number;
}

// The Levels board (Hall of Fame): top players by lifetime XP. The client derives the level +
// progress from `xp` via levelForXp. `selfXp`/`selfRank` pin the recipient when below the top-N.
export interface LevelRow {
  name: string;
  xp: number;
  title?: string | null;
}
export interface LevelBoardMsg {
  type: 'levelBoard';
  rows: LevelRow[];
  selfXp?: number;
  selfRank?: number;
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

// Server → client: an Elo leaderboard drill-down card (mirrors the net-worth balance sheet).
export interface EloProfileMsg {
  type: 'eloProfile';
  rank: number;
  name: string;
  wins: number;
  losses: number;
  elo: number;
  winPct: number;
  lastPlayed: number | null;
  rival: { name: string; wins: number; losses: number } | null;
}

export interface ChatLine {
  from: string;
  text: string;
  player: boolean; // true if the sender held a paddle when they sent it
  netizen?: boolean; // true only for the 10 trading netizens (market chatter)
  color: string; // hex color of the sender's name
  command?: boolean; // true if this line is a slash command someone ran (styled apart)
  whisper?: boolean; // true if this is a private /whisper line (rendered all-purple)
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

// Type Racer sabotage: the opponent typed a correct character while the ball is heading
// toward YOU. Your client nudges its own paddle target a quarter-step off course (away
// from the predicted intercept) — so at equal typing speed the defender still wins.
export interface TypeShoveMsg {
  type: 'typeShove';
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

// Someone summoned the banner-plane via the secret word; the whole room flies it. `idx`
// selects which "your airplane has arrived" banner so everyone sees the same one.
export interface FlyoverMsg {
  type: 'flyover';
  idx: number;
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
  | { type: 'prefs'; prefs: Record<string, string> } // the account's stored user settings, on join
  | StateMsg
  | LeaderboardMsg
  | NetWorthMsg
  | BalanceSheetMsg
  | ChatMsg
  | ReactionMsg
  | TypeShoveMsg
  | AnnounceMsg
  | PingMsg
  | FlyoverMsg
  | RttMsg
  | DoomLobbyMsg
  | DoomRelayMsg
  | DoomEndMsg
  | NtLobbyMsg
  | NtRelayMsg
  | SrLobbyMsg
  | SrRelayMsg
  | SbLobbyMsg
  | SbRelayMsg
  | TrnLobbyMsg
  | TrnRelayMsg
  | WaLobbyMsg
  | WaRelayMsg
  | BgLobbyMsg
  | BgRelayMsg
  | WishResultMsg
  | GhLeaderboardMsg
  | TntLobbyMsg
  | TntRelayMsg
  | MjLobbyMsg
  | MjRelayMsg
  | DoomLeaderboardMsg
  | TypeDieStateMsg
  | TypeDieLeaderboardMsg
  | CampaignLeaderboardMsg
  | FishRewardMsg
  | FishLeaderboardMsg
  | GolfLeaderboardMsg
  | WalletMsg
  | LevelUpMsg
  | MobLootMsg
  | StockMsg
  | LoanMsg
  | SpinResultMsg
  | RouletteResultMsg
  | BjStateMsg
  | BjResultMsg
  | CrapsResultMsg
  | SlotsResultMsg
  | PlinkoResultMsg
  | HorseCardMsg
  | HorseResultMsg
  | HiLoStateMsg
  | HiLoResultMsg
  | MinesStateMsg
  | MinesResultMsg
  | CrashStateMsg
  | TipMsg
  | BountyBoardMsg
  | BountyHitMsg
  | ThemeSongMsg
  | LootResultMsg
  | MarketMsg
  | LoanBookMsg
  | WorldMsg
  | { type: 'dungeonChests'; opened: string[] } // chests this player has opened (reply to dungeonSync)
  | { type: 'dungeonChestOpened'; chest: string; coins: number; potions: number; spin?: boolean; prize?: string; prizes?: string[] } // a chest open was accepted (prize/prizes = display names of cosmetic rewards)
  | { type: 'dungeonSpin'; chest: string; segment: number; reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string } } // a spin chest: play the wheel, reward goes to run loot
  | { type: 'dungeonPurse'; coins: number } // current run-purse total (paid out only on a clean escape)
  | LandMsg
  | WorldSayMsg
  | WorldBoomMsg
  | WorldRocketMsg
  | WorldRoadRageMsg
  | HouseMsg
  | HouseStateMsg
  | NetizenInfoMsg
  | NetizenChallengeResultMsg
  | NewsMsg
  | DrunkMsg
  | JailMsg
  | NomStateMsg
  | EloProfileMsg
  | CortisolMsg
  | LevelBoardMsg
  | SeasonPassMsg
  | MatchStatsMsg
  // --- Bolwoing Alley server→client messages ---
  | { type: 'bowlState'; roomId: string; phase: string; players: any[]; currentPlayerId: string | null; pinState: boolean[]; scores: any; frames: any }
  | { type: 'bowlStart'; roomId: string; phase: string; players: any[]; currentPlayerId: string | null; pinState: boolean[]; scores: any; frames: any }
  | { type: 'bowlThrowResult'; roomId: string; playerId: string; pinState: boolean[]; pinsDown: number[]; scores: any; frames: any }
  | { type: 'bowlNextBall'; roomId: string; playerId: string; ball: number; pinState: boolean[]; scores: any; frames: any }
  | { type: 'bowlNextTurn'; roomId: string; playerId: string; frameIdx: number; pinState: boolean[]; scores: any; frames: any }
  | { type: 'bowlGameOver'; roomId: string; ranked: any[]; scores: any; frames: any }
  | { type: 'mcFoodResult'; item: string; granted: boolean; bonus?: number }
  // --- City Tycoon ---
  | { type: 'crState'; game: any }                                        // full authoritative game snapshot
  | { type: 'crEvent'; text: string; kind: 'info' | 'warn' | 'success' | 'error' }; // toast/log line

// Your current drunkenness level (0 = sober … 6 = cut off). Sent only to the affected client.
// The client applies escalating visual + control-wobble effects; the server owns the 3-min-per-level
// countdown and sobers you down one level at a time.
export interface DrunkMsg {
  type: 'drunk';
  level: number;
}

// Whether YOU are currently locked in the jail. Sent only to the affected client when it changes
// (jailed on a drunk-drive attempt, freed once bailed). Drives the movement lock + the bail banner.
export interface JailMsg {
  type: 'jailed';
  jailed: boolean;
}

// --- Economy Overhaul server → client messages ---

// Result of opening a loot box, sent only to the opener so it can run the reveal animation.
// `kind` picks the celebration: a common cosmetic grant, a House-funded coin payout, or a
// freshly-minted scarce exclusive (with its serial). A capped-out exclusive roll degrades to a
// coin payout server-side, so the client only ever sees a real, paid result.
export interface LootResultMsg {
  type: 'lootResult';
  kind: 'coins' | 'cosmetic' | 'exclusive' | 'nothing';
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

// Full House/Fed dashboard snapshot (sent in reply to houseReq). Drives the 🏦 House panel.
export interface HouseStateMsg {
  type: 'houseState';
  balance: number;
  trickleFund: number;
  totalCoins: number;
  top5Pct: number;            // top-5 net-worth concentration among players only, %
  top5ShareOfTotal: number;   // top-5 net-worth / (House + all player net worth), %
  playerNetWorthTotal: number; // sum of all positive player net worth
  economyTotal: number;        // House balance + all player net worth
  brokerFeePct: number;       // current broker fee, % (0.5 in-hours / 1.0 after-hours)
  concentrationCap: number;   // max % of a stock one player may hold
  loanCapWaived: boolean;
  tightening: boolean;
  wealthBrackets: { upTo: number; rate: number }[]; // current (top reflects the Fed cap)
  capGainBrackets: { upTo: number; rate: number }[];
  fastSell: { underMin: number; rate: number }[];   // minutes held → rate
  idleTiers: { days: number; rate: number }[];       // days idle → rate
  fedNews: { ts: number; headline: string }[];       // recent 🪙 FED statements
  bondRates: { termDays: number; rate: number }[];   // available Treasury bond terms
  myBonds: { id: string; amount: number; termDays: number; rate: number; maturesAt: number }[]; // this player's bonds
  auction: { item: string; name: string; startBid: number; highBid: number; highName: string | null; endsAt: number } | null;
}

// A market news headline — published hourly during market hours with a hidden price move.
export interface NewsItem {
  id: string;
  ts: number;         // publish epoch ms
  coin: string;       // affected coin id
  headline: string;   // allusive flavor text (no numbers, no explicit direction)
}
export interface NewsMsg {
  type: 'news';
  items: NewsItem[];  // newest-first, up to ~30
}
// Headline templates — allude without stating direction or timing.
export const NEWS_TEMPLATES_BULLISH = [
  'Whispers in the Casino district: someone\'s been quietly loading up on {name} — and they might not be the only one circling the {sector} sector.',
  '{ticker} chatter is heating up across the trading floor — the smart money looks interested, and a few shell companies just lit up on the order book.',
  'A well-known whale was seen eyeing {name} early this morning, and word is they\'re shopping the whole {sector} basket.',
  'Insiders are unusually optimistic about {ticker} lately — chatter among the floor traders suggests the quiet accumulation has already begun.',
  'Rumors are swirling that {name} is about to catch a bid, and a handful of algo funds have started positioning across the {sector} board.',
  'Something is brewing with {ticker} — the order book is thickening at the ask, and the options flow is starting to look interesting.',
  'A prominent trader just moved a sizable position into {name}, and their recent track record has the rest of the floor paying attention.',
  'The vibe around {ticker} is shifting — the murmurs are getting louder, and the consolidated tape shows unusual activity rippling through {sector}.',
  'Deep pockets are circling {name}: a series of dark-pool prints just crossed the tape, and the street is starting to take notice of the broader {sector} bid.',
  'Calls are stacking up on {ticker} — someone with a big book is betting this {sector} name has room to run, and the gamma flow is starting to accelerate.',
  'Whisper number on {name} is creeping higher — three independent analysts just revised their outlook, and the algo flow is turning increasingly constructive across the sector.',
  'Accumulation alert: {ticker} just saw its heaviest volume in weeks, and the tape reads like a coordinated bid across multiple {sector} names.',
  'A large institutional flip into {name} just registered on the consolidated tape — the kind of print that usually precedes a broader rotation into {sector}.',
  'Sources close to the exchange report that a major {sector} player has been steadily adding {ticker} through dark pools for the past three sessions.',
  'The put/call ratio on {name} just hit a multi-week low — the options market is screaming that the bears have thrown in the towel on this one.',
];
export const NEWS_TEMPLATES_BEARISH = [
  'Analysts are growing wary of {name}\'s recent run — the momentum looks tired, and a few second-tier holders have started trimming their {sector} exposure.',
  'Something feels off about {ticker} — insiders are getting quiet, and the bid depth has been thinning out across the {sector} board.',
  'Rumblings that {name} holders are heading for the exits — a cluster of large sell orders just hit the tape, and the algo flow is turning defensive across {sector}.',
  'A cold wind is blowing through {ticker} — the consolidated tape shows distribution, not accumulation, and the whole {sector} sector is starting to feel the chill.',
  'The smart money appears to be rotating out of {name} — a couple of known funds have marked down their {sector} exposure in recent filings.',
  '{ticker} is looking wobbly — profit-takers are circling and the volume profile suggests the easy money has already been made in this {sector} name.',
  'Volume on {name} is drying up — the silence is telling, and the lack of bids below the market has the floor worried about a broader {sector} shakeout.',
  'A shadow has fallen over {ticker} — traders are hedging, the options skew is flipping bearish, and the entire {sector} sector is starting to trade heavy.',
  'Distribution day for {name}: the tape shows large blocks printing on the ask, and the market-makers are leaning short across the {sector} complex.',
  'The high-frequency flow just flipped negative on {ticker} — the algo community smells weakness, and the short interest in {sector} names is ticking up.',
  'A well-known bear just published a note on {name}, and the initial reaction in the {sector} pit has been noticeably defensive — bids are pulling fast.',
  'Open interest is collapsing on {ticker} — the longs are throwing in the towel, and the options market is pricing in a rough stretch for the {sector} group.',
  'Dark-pool activity on {name} just spiked — but the prints are all on the sell side, and the whisper on the street is that a big holder is quietly exiting {sector}.',
  'The macro headwinds are starting to hit {ticker}: a broader risk-off move is taking shape, and the {sector} names are bearing the brunt of the selling.',
  'Liquidity is drying up on {name} — the bid-ask spread just widened to its highest in weeks, and the order book looks thin across the entire {sector} board.',
];

// The Fed's public statements. Keyed by event so the actor can pick the right line. `{n}` is filled
// with the relevant number (concentration %, stimulus amount, bond rate…). Shown in the news feed
// under a 🪙 prefix alongside market headlines.
export const FED_TEMPLATES: Record<string, string[]> = {
  tighten: [
    '🪙 FED: Wealth concentration triggered automatic tightening. The top bracket is now {n}%.',
    '🪙 FED: The committee notes excessive accumulation at the top. Tightening measures are in effect.',
    '🪙 FED: Reserve ratios skewed — we are raising the upper wealth bracket to {n}% to restore balance.',
  ],
  ease: [
    '🪙 FED: Market stability improved — concentration eased to {n}%. Returning rates to baseline.',
    '🪙 FED: Conditions warrant accommodation. Easing measures are now in effect.',
    '🪙 FED: The distribution has normalized. We are standing down from tightening.',
  ],
  stimulus: [
    '🪙 FED: Trickle Fund distributed {n}🪙 in stimulus to active players. Keep the economy moving.',
    '🪙 FED: A {n}🪙 stimulus has been wired to recently-active accounts. Spend it wisely.',
    '🪙 FED: Stimulus disbursed — {n}🪙 returned to the players keeping velocity up.',
  ],
  liquidity: [
    '🪙 FED: Emergency liquidity injection — the loan cap is temporarily waived.',
    '🪙 FED: The lending pool ran dry. We have opened the credit window and waived the cap.',
  ],
  drain: [
    '🪙 FED: Treasury surplus detected — excess reserves swept into the Trickle Fund.',
    '🪙 FED: The House is flush; we are reallocating the overflow toward stimulus.',
  ],
  hold: [
    '🪙 FED: The committee has decided to hold rates steady. Reserve ratio stable.',
    '🪙 FED: No action taken this cycle. We continue to monitor conditions.',
  ],
};

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
// Sent when a coin/activity reward pushes you past one or more level boundaries — the client
// throws a little celebration. `level` is your new level, `reward` any coins the House chipped in.
export interface LevelUpMsg {
  type: 'levelUp';
  level: number;
  reward: number;
}
// The at-risk mob-loot purse total after a kill/bank/forfeit. Coins from biome mobs accumulate
// here (server-held) and only reach the wallet once you bank them safely in town; dying forfeits them.
export interface MobLootMsg {
  type: 'mobLoot';
  purse: number;   // current unbanked coins
  gained?: number; // coins just added by a kill (for the floating "+N" on the client)
  banked?: number; // coins just moved into the wallet (for a "banked N" toast)
}
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
  boat: string | null; // equipped boat (used on water; equipped alongside a car)
  pet: string | null; // equipped pet (trails behind you in the World map)
  carcolor: string | null; // equipped car paint job (overrides the car's stock colours)
  balltrail: string | null; // equipped ball trail cosmetic
  goalcelebr: string | null; // equipped goal celebration cosmetic
  // Owned scarce exclusives (loot-box mints / marketplace buys): item id + mint serial +
  // instance id (the marketplace lists a specific instance). Kept OUT of the `owned` CSV —
  // exclusives are tracked per-instance in their own table.
  exclusives: { id: string; serial: number; instanceId: number }[];
  // Your open wagers on the live duel (multiple allowed in live betting); each locks the odds
  // it was placed at. Empty when you have none.
  bets: Array<{ side: Side; amount: number; odds: number }>;
  nextSpinAt: number; // epoch ms when the daily spin is next available (0 = available now)
  bonusSpins: number; // banked free spins (e.g. from winning a tournament); bypass the cooldown
  xp: number; // lifetime XP; the client derives the account level + progress bar via levelForXp
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

// Market sectors — a news headline about one coin can pressure the whole sector.
export const SECTORS: { name: string; ids: StockId[] }[] = [
  { name: 'Creators', ids: ['kenny', 'chugs', 'davis'] },
  { name: 'Meme',     ids: ['otto', 'bacon', 'fritz'] },
  { name: 'Derivatives', ids: ['omega'] },
];

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
// Fast-sell tax: closing a position within this window of opening — or topping it up, which
// restamps the clock — taxes a fraction of the payout to the House. Tiered brackets step down
// from 25% to 0% over 3 hours. Single source of truth so server charges and client countdowns
// can never drift apart.
export const FAST_SELL_BRACKETS: { underMs: number; rate: number }[] = [
  { underMs:   5 * 60_000, rate: 0.20 },
  { underMs:  15 * 60_000, rate: 0.15 },
  { underMs:  30 * 60_000, rate: 0.10 },
  { underMs:  60 * 60_000, rate: 0.05 },
];
// Legacy single-constant shims kept for any import sites not yet updated.
export const FAST_SELL_TAX_MS   = FAST_SELL_BRACKETS[FAST_SELL_BRACKETS.length - 1].underMs; // 60 min (last bracket)
export const FAST_SELL_TAX_RATE = FAST_SELL_BRACKETS[0].rate;                                 // 20% (first bracket)
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
  // coins they'd get if they cashed out right now. `openedAt` is the server-time stamp of the
  // last open/top-up, used to count down the 60s fast-sell-tax window.
  holdings: { id: string; side: StockSide; shares: number; cost: number; worth: number; openedAt: number }[];
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

// --- Loot box rebalance ---
// Whale-gamble box: ~3% cosmetic, ~2% exclusive, ~65% partial coin-back, ~30% nothing.
export const LOOT_TABLE = {
  cosmeticWeight: 3.0,
  exclusiveWeight: 2.0,
  coinBackWeight: 65.0,
  nothingWeight: 30.0,
  coinBackMin: 500,
  coinBackMax: 2000,
};

// --- Wealth-scaled minimum bets ---
// Anti-hoarding lever: the wealthier a player is, the higher their minimum bet floor.
// The bottom tier is 1 so low-wealth players are unaffected — the floor only rises for
// those sitting on large coin piles. Used across roulette, blackjack, PvP bets, and netizen challenges.
export const MIN_BET_TIERS: readonly [number, number][] = [
  [1_000_000, 10_000], [500_000, 5_000], [100_000, 1_000],
  [10_000, 100], [1_000, 10], [0, 1],
]; // [thresholdCoins, minBet], checked high→low
export function minBet(wealth: number): number {
  for (const [t, m] of MIN_BET_TIERS) if (wealth >= t) return m;
  return 1;
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
export const ROULETTE_MAX_TOTAL = 50000; // most coins that may be staked across all bets on one spin

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

// --- Blackjack ---
// Six-deck shoe. Cards as rank+suit strings: A2–9TJQK + SHDC (e.g. 'AS', 'TD', 'KH').
// Server is authoritative: it holds the shoe, deals, resolves, and settles the wallet.
export const BJ_MAX_BET = 50_000;
export type BjAction = 'hit' | 'stand' | 'double';
export type BjOutcome = 'blackjack' | 'win' | 'push' | 'lose';
export interface BjStateMsg {
  type: 'bjState';
  playerCards: string[]; // e.g. ['AS', 'TD']
  dealerCard: string;    // face-up card (hidden one not revealed until stand / double)
  playerTotal: number;   // best soft/hard total ≤ 21 (busted = bust total)
  canDouble: boolean;    // true only before the first hit
  status: 'playing';
}
export interface BjResultMsg {
  type: 'bjResult';
  playerCards: string[];
  dealerCards: string[]; // both dealer cards revealed
  playerTotal: number;
  dealerTotal: number;
  outcome: BjOutcome;   // 'blackjack'=3:2, 'win'=1:1, 'push'=even, 'lose'=0
  bet: number;
  payout: number;        // coins returned (0=lose, bet=push, bet×2=win, floor(bet×2.5)=BJ)
}

// --- Street Craps ---
// Pass Line / Don't Pass bets with a come-out → point-phase state machine.
export const CRAPS_MAX_BET = 50_000;
export interface CrapsResultMsg {
  type: 'crapsResult';
  dice: [number, number]; // individual die values, 1–6
  total: number;
  prevPoint: number | null; // craps point before this roll (null = was on come-out)
  newPoint: number | null;  // point after this roll (null = come-out phase; number = point active)
  outcome: 'win' | 'lose' | 'point'; // 'point' = no resolution, keep rolling
  push12: boolean;          // come-out 12: pass loses, don't-pass pushes (not loses)
  passPayout: number;       // coins returned for the Pass Line bet (0 = lost)
  dontPassPayout: number;   // coins returned for the Don't Pass bet
}

// --- Crash ---
// Lobby-wide multiplayer crash: multiplier rises from 1.00× and crashes at a server-chosen
// point. Players bet during the 8s window and cash out before the crash. House edge ≈ 3%.
export const CRASH_BETTING_MS = 12_000;
export const CRASH_TICK_MS = 100;        // live-phase tick interval (ms)
export const CRASH_ENDED_MS = 4_000;     // how long the crash result lingers before next round
export const CRASH_MAX_BET = 50_000;
export const CRASH_GROWTH = 1.02;        // multiplier per 100ms tick (~7× per minute at the start)
// --- Slots ---
// Classic 3-reel slot machine. Each reel shows 3 symbols; the center row is the pay line.
// Symbol weights skew rare symbols low. Server rolls, evaluates, settles the wallet.
export const SLOTS_MAX_BET = 50_000;
// Symbol pool (index 0–6), listed rarest→most-common for human readability.
// Weights are sampled on each reel independently. The '7' jackpot is weighted 1/64.
export const SLOTS_SYMBOLS = ['7️⃣', '💎', '🍀', '⭐', '🍊', '🍋', '🍒'] as const;
export type SlotsSymbol = typeof SLOTS_SYMBOLS[number];
// Payout multipliers for a 3-of-a-kind center-row match (applied to the bet).
export const SLOTS_PAYOUTS: Record<SlotsSymbol, number> = {
  '7️⃣': 100, '💎': 40, '🍀': 20, '⭐': 10, '🍊': 5, '🍋': 3, '🍒': 2,
};
// Per-reel symbol weights (index matches SLOTS_SYMBOLS). Total = 64.
export const SLOTS_WEIGHTS = [1, 2, 3, 6, 10, 14, 28] as const;
export interface SlotsResultMsg {
  type: 'slotsResult';
  // reels[reel][row]: 3 reels × 3 rows (row 1 is the pay line)
  reels: [SlotsSymbol[], SlotsSymbol[], SlotsSymbol[]];
  win: SlotsSymbol | null; // the matching symbol on the pay line, or null (no win)
  bet: number;
  payout: number;          // coins returned (0 on loss)
}

// --- Plinko ---
// 8-row pegboard. Ball drops from center, bounces left/right at each peg. Lands in 1 of 9 slots.
export const PLINKO_ROWS = 8;
export const PLINKO_PAYOUTS = [26, 3, 1.4, 0.4, 0.2, 0.4, 1.4, 3, 26] as const;
export const PLINKO_MAX_BET = 50_000;
export interface PlinkoResultMsg {
  type: 'plinkoResult';
  path: boolean[];   // 8 booleans: false=left, true=right at each peg row
  slot: number;      // sum of 'true' values (0–8)
  multiplier: number;
  bet: number;
  payout: number;
}

// --- Horse Racing ---
// 5 horses with shuffled odds. Player picks one, bets, then the server runs the race.
export const HORSE_NAMES = [
  'Davis Destroyer', 'Kirkland King', 'Bacon Roll',
  'Minion Madness', 'Avery Express', 'The Pong Ball', 'Jsav Jr.', 'Ping Ponger',
] as const;
export const HORSE_ODDS = [1.8, 2.5, 4.0, 7.0, 14.0] as const;
export const HORSE_MAX_BET = 50_000;
export interface HorseCardMsg {
  type: 'horseCard';
  horses: { name: string; odds: number }[]; // 5 entries
}
export interface HorseResultMsg {
  type: 'horseResult';
  horses: { name: string; odds: number }[];
  winner: number;  // 0-indexed winning horse
  horse: number;   // which horse the player bet on
  bet: number;
  payout: number;
}

// --- Mines ---
// Bet coins, choose 1–24 mines hidden in a 5×5 grid, then flip tiles. Each safe reveal grows the
// multiplier; hit a mine and lose everything. Cash out any time after at least one safe reveal.
export const MINES_COLS = 5;
export const MINES_ROWS_COUNT = 5;
export const MINES_GRID = MINES_COLS * MINES_ROWS_COUNT; // 25 tiles
export const MINES_MAX_BET = 50_000;
export const MINES_HOUSE_EDGE = 0.01; // 1%
export interface MinesStateMsg {
  type: 'minesState';
  revealed: boolean[];      // length 25: true = this tile was flipped and was safe
  safeCount: number;        // how many safe tiles revealed so far
  multiplier: number;       // current cashout multiplier (1× before first reveal)
  bet: number;
  mines: number;
  pendingPayout: number;    // floor(bet × multiplier); 0 before first safe reveal
}
export interface MinesResultMsg {
  type: 'minesResult';
  won: boolean;             // true = cashed out, false = hit a mine
  hitCell: number;          // tile index that ended the game (-1 on cashout)
  minePositions: number[];  // all mine indices (revealed at end)
  payout: number;
  net: number;
}

// --- Hi-Lo ---
// Bet coins → get a card (1–13) → guess Higher or Lower → correct = multiplier grows, cashout any time → wrong = lose bet.
export const HILO_MAX_BET = 50_000;
export const HILO_HOUSE_EDGE = 0.05;
export interface HiLoStateMsg {
  type: 'hiloState';
  card: number;          // current card 1-13
  multiplier: number;    // accumulated return multiplier (1.0 at start)
  bet: number;
  pendingPayout: number; // floor(bet × multiplier); 0 before first correct guess
}
export interface HiLoResultMsg {
  type: 'hiloResult';
  won: boolean;    // true = cashed out; false = wrong guess
  newCard: number; // card that was revealed
  payout: number;  // coins received (0 on loss)
  net: number;     // payout - bet (negative = lost)
}

export interface CrashStateMsg {
  type: 'crashState';
  phase: 'betting' | 'live' | 'ended';
  multiplier: number;          // 1.00 during betting; rising during live; crash value when ended
  timeLeft: number;            // ms remaining in the betting window (0 during live/ended)
  bets: { name: string; amount: number; cashedAt: number | null }[];
  yourBet: number | null;      // null = not in this round
  yourCashedAt: number | null; // multiplier at which you cashed out (null = still live or lost)
  crashedAt: number | null;    // the final crash multiplier (non-null only when ended)
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
// Super Tsong Bros lobby (2–4 slots, free-for-all platform fighter). `slot` is which slot this
// client holds (0 = host/authority). Each player carries their chosen `fighter` id (null until
// they lock in). The match can only start once every player has a non-null fighter AND ≥2 are
// present (the all-locked gate). On 'playing', slot 0 simulates the whole match; on 'ended'
// everyone bails to the menu (the host left).
export interface SbLobbyMsg {
  type: 'sbLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; slot: number; fighter: string | null }[]; // everyone in the lobby + their pick
}
// An opaque payload broadcast from one Super Tsong Bros participant to all others (host state
// snapshot / guest input). Clients pick out the messages they care about.
export interface SbRelayMsg {
  type: 'sbRelay';
  data: unknown;
}
// Tron light-cycle lobby (1–4 players; the host fills empty seats with bots at start). `slot`
// is which slot this client holds (0 = host/authority). On 'playing', slot 0 simulates the
// whole match client-side (bots included) and streams snapshots over the trn relay; guests
// send direction inputs. On 'ended' everyone bails to the menu (the host left).
export interface TrnLobbyMsg {
  type: 'trnLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; slot: number }[]; // humans in the lobby (bots are host-side only)
}
// An opaque payload broadcast from one Tron participant to all others (host state snapshot /
// guest direction input). Clients pick out the messages they care about.
export interface TrnRelayMsg {
  type: 'trnRelay';
  data: unknown;
}
// Board-game (chess / Nine Men's Morris) lobby — the smallest relay shape yet: exactly two seats,
// PvP only (the club does not stock bots), no payouts (members do not discuss money). Slot 0 is
// the host and plays white/first; moves ride the bg relay and both clients run the same rules.
export interface BgLobbyMsg {
  type: 'bgLobby';
  game: string; // 'chess' | 'morris'
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's seat (0 = host)
  players: { name: string; slot: number }[];
  stake: number; // winner-takes-all stake per player (0 = friendly game); escrowed by the server at start
}
export interface BgRelayMsg {
  type: 'bgRelay';
  game: string;
  data: unknown;
}
// Tsong Artillery lobby (1–4 players; the host fills empty seats with bots at start). Same
// host-authoritative relay shape as Tron: the server only runs the lobby + fan-out. Turn-based,
// so the shot messages replay deterministically on every client.
export interface WaLobbyMsg {
  type: 'waLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host)
  hostSlot: number;
  players: { name: string; slot: number }[];
}
export interface WaRelayMsg {
  type: 'waRelay';
  data: unknown;
}
// A fountain wish landed: the town's all-time wish count (and whether the fountain granted a title).
export interface WishResultMsg {
  type: 'wishResult';
  total: number;
  title?: boolean;
}
// Tsong Hero public leaderboard: the top 5 scores for every song × difficulty.
export interface GhLeaderboardMsg {
  type: 'ghLeaderboard';
  rows: { song: string; diff: string; name: string; score: number }[];
}
// TNT Explosion Rally lobby (exactly 2 slots, 1v1 bomb-parry maze duel — concept by a
// six-year-old game director). `slot` is which slot this client holds (0 = host/authority).
// On 'playing', slot 0 simulates the whole match client-side and streams snapshots over the
// relay; the guest sends inputs. A solo host may start a practice match vs a bot (no payout).
// 'ended' bails everyone back to the menu (the host left).
export interface TntLobbyMsg {
  type: 'tntLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host / authority)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; slot: number }[]; // everyone in the lobby
}
// An opaque payload forwarded from one TNT Explosion Rally player to the other (host world
// snapshot / guest input). Clients pick out the messages they care about.
export interface TntRelayMsg {
  type: 'tntRelay';
  data: unknown;
}
// Monster Jam: Stunt Showdown lobby (1v1 monster-truck stunt competition, designed by a
// six-year-old). Same shape as TNT: on 'playing', slot 0 simulates the whole show client-side
// (truck picks, the practice yard, and the main event) and streams snapshots over the relay;
// the guest sends inputs. A solo host puts on a show vs Crushbot 9000 (no payout).
// 'ended' bails everyone back to the menu (the host left).
export interface MjLobbyMsg {
  type: 'mjLobby';
  status: 'waiting' | 'playing' | 'ended';
  slot: number; // this client's slot (0 = host / authority)
  hostSlot: number; // which slot is the authority (0)
  players: { name: string; slot: number }[]; // everyone in the lobby
}
// An opaque payload forwarded from one Monster Jam player to the other (host snapshot / guest input).
export interface MjRelayMsg {
  type: 'mjRelay';
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

// --- Fishing minigame messages ---
// Sent back to the angler after a validated catch: the House-funded coin reward, plus the
// (one-time) Angler title item if a legendary was landed.
export interface FishRewardMsg {
  type: 'fishReward';
  coins: number;
  item?: { id: string; name: string };
}
// Biggest-catch leaderboard (top N by best landed weight), pushed on each catch.
export interface FishLeaderboardRow { name: string; lb: number; }
export interface FishLeaderboardMsg {
  type: 'fishLeaderboard';
  rows: FishLeaderboardRow[];
}

// The Course's leaderboard — lowest total strokes across all 18 holes, best round kept per
// player (solo or PvP both count), pushed whenever anyone finishes a round.
export interface GolfScoreRow { name: string; strokes: number; }
export interface GolfLeaderboardMsg {
  type: 'golfLeaderboard';
  rows: GolfScoreRow[];
}

// --- Netizen Challenge (Plan 10) ---
export const NETIZEN_CHALLENGE_MAX_FRAC = 0.20;
export const NETIZEN_CHALLENGE_HARDEST_REACT = 0.09;
export const NETIZEN_CHALLENGE_HARDEST_ERROR = 22;
export const NETIZEN_CHALLENGE_EASIEST_REACT = 0.30;
export const NETIZEN_CHALLENGE_EASIEST_ERROR = 95;

export interface NetizenInfoMsg {
  type: 'netizenInfo';
  netizenId: string;
  netizenName: string;
  netWorth: number;
  maxWin: number;
  challengedToday: boolean;
}
export interface NetizenChallengeResultMsg {
  type: 'netizenChallengeResult';
  won: boolean;
  delta: number;
  netizenName: string;
}

// --- Market news (Plan 01) ---
export interface NewsItem { id: string; ts: number; coin: string; headline: string; }
export interface NewsMsg { type: 'news'; items: NewsItem[]; }

// --- Netizen dialogue corpus (Plan 02 + Plan 03) ---
export const NETIZEN_DIALOGUE = {
  buyLong: [
    'aped into {ticker} 🚀', 'loading {ticker} here', '{ticker} looking juicy ngl',
    'all in {ticker} lfg', 'yolo {ticker} 🚀', 'adding {ticker} to the bag', '{ticker} dip is tasty',
    'hearing good things about {ticker} rn', 'just doubled my {ticker} position', 'stacking {ticker} while its cheap',
    'whale alert — someone just bought a wall of {ticker}', 'chart says {ticker} going higher 📈',
    'filling my bags with {ticker} before the next leg up',
  ],
  sellProfit: [
    'took profit on {ticker} 💰', 'out of {ticker}, ty market', '{ticker} paid the bills today',
    'locked in gains on {ticker} ✅', 'trimmed {ticker} for some profit',
    'scalp successful — out of {ticker} with a bag 💼', 'that {ticker} pump was generous, i took half off',
    'profit is profit, even on {ticker}', 'called that {ticker} rip perfectly ngl',
  ],
  sellLoss: [
    'got rekt on {ticker} 💀', 'paperhanded {ticker} again', '{ticker} bagholder no more',
    'sold {ticker} at a loss rip 💸', 'dyor they said {ticker} they said',
    '{ticker} just dumped on me hard', 'why do i always buy the top on {ticker}',
    'giving up on {ticker}, too much pain', 'that {ticker} trade went exactly as expected — badly',
    'my {ticker} position just got liquidated oof',
  ],
  newsBullish: [
    'something brewing with {ticker}? 👀', "i'm not not buying {ticker} rn",
    'feels like {ticker} szn', '{ticker} definitely up to something', 'heard a rumor about {ticker} 😏',
    'just read the news — {ticker} about to moon 🌙', 'the signs are all pointing to {ticker}',
    'if you are not buying {ticker} right now what are you doing', 'momentum is building for {ticker}',
    'algo flow just turned positive on {ticker}', '{ticker} looking primed for a breakout',
    'the tape on {ticker} is screaming accumulation',
  ],
  newsBearish: [
    'staying away from {ticker} today', '{ticker} giving me bad vibes',
    'might short {ticker} ngl', 'something off with {ticker} energy', 'not touching {ticker} with a pole',
    '{ticker} looking like a falling knife rn', 'the news on {ticker} is not good at all',
    'everyone piling into {ticker} is a sign to get out', 'shorting {ticker} feels like free money',
    'that {ticker} chart is a disaster', 'smart money is leaving {ticker} fast',
  ],
  idleBanter: [
    "who's this lasso guy with 1M net worth", 'new exclusive dropped in the black market 👀',
    'anyone else watching the leaderboard?', 'market looking spicy today 🌶️',
    'feels like a dead cat bounce', 'chart says up but my gut says down 🤷',
    'has anyone actually beaten the top elo player', 'heard the casino has a new game dropping soon',
    'these loan interest rates are criminal smh', 'the house always wins eventually',
    'anyone know what time the lootbox resets', 'the economy in this game is wild',
    'i swear the market moves when i look away', 'net worth go brr 📈 or should i say brr 📉',
  ],
};

// =====================================================================================
// Super Tsong Bros — a 2–4 player PvP platform fighter (Smash-like). Wire contract + the
// fighter roster and the stage list shared by client (sim + render) and server (lobby gate).
// The sim itself lives in client/superbros.ts; these are the tunable data tables.
// =====================================================================================

// Per-fighter melee attack: an instant arc/hitbox in front of the fighter.
export interface FighterMelee {
  name: string;     // move name, shown in HUD / select
  range: number;    // 1–10 reach in front of the fighter
  dmg: number;      // 1–10 damage dealt (→ damage-% added)
  startup: number;  // 1–10 wind-up frames (lower = snappier; high = slow but strong)
}
// Per-fighter projectile (K). Fired forward; despawns off-screen or after a lifetime.
export interface FighterProjectile {
  name: string;                          // projectile name
  speed: number;                         // 1–10 launch speed
  dmg: number;                           // 1–10 damage on hit
  cooldown: number;                      // 1–10 reuse delay (lower = more rapid fire)
  arc: 'straight' | 'lob' | 'bounce';    // trajectory: flat, gravity-lobbed, or floor-bouncing
}
// A playable fighter. All stats are on a 1–10 "feel" scale; the engine (client/superbros.ts)
// converts them to physics units. `color` is the flat select-screen / fallback tint; `useImage`
// (jsav only) means the sprite is the /jsav.jpg asset rather than pixel-baked art.
export interface Fighter {
  id: string;
  name: string;
  blurb: string;       // one-line archetype shown on the select screen
  color: string;       // portrait / fallback body tint
  speed: number;       // ground run speed
  strength: number;    // knockback dealt (attacker strength)
  weight: number;      // knockback resistance (heavier = launched less)
  jump: number;        // jump + recovery (up-burst) height
  fallSpeed: number;   // gravity / fast-fall feel
  size: number;        // hurtbox size (also visual scale)
  melee: FighterMelee;
  projectile: FighterProjectile;
  useImage?: boolean;  // jsav: draw the /jsav.jpg image instead of pixel art
}

// The roster. Six fighters, tuned for clear variety across the feel scale.
// TO ADD MORE FIGHTERS: append an entry here (and a matching draw routine + portrait swatch in
// client/superbros.ts's FIGHTER_ART / drawFighter). Nothing else needs to change — the lobby,
// select gate and sim all read this table.
export const FIGHTERS: Fighter[] = [
  {
    id: 'minion', name: 'Minion', blurb: 'Rushdown lightweight — fast, frail, annoying.',
    color: '#ffd836', speed: 8, strength: 4, weight: 3, jump: 7, fallSpeed: 5, size: 4,
    melee: { name: 'Slap', range: 3, dmg: 3, startup: 2 },
    projectile: { name: 'Banana', speed: 4, dmg: 3, cooldown: 4, arc: 'lob' },
  },
  {
    id: 'pikachu', name: 'Pikachu', blurb: 'Fast floaty zoner — shock from range.',
    color: '#f6d02f', speed: 9, strength: 4, weight: 3, jump: 8, fallSpeed: 4, size: 4,
    melee: { name: 'Tail Whip', range: 3, dmg: 4, startup: 2 },
    projectile: { name: 'Lightning Bolt', speed: 10, dmg: 5, cooldown: 5, arc: 'straight' },
  },
  {
    id: 'rob', name: 'Rob', blurb: 'Balanced all-rounder — no glaring weakness.',
    color: '#e8862e', speed: 6, strength: 6, weight: 5, jump: 6, fallSpeed: 5, size: 5,
    melee: { name: 'Jab', range: 4, dmg: 5, startup: 3 },
    projectile: { name: 'Knife', speed: 8, dmg: 5, cooldown: 5, arc: 'straight' },
  },
  {
    id: 'lebron', name: 'LeBron James', blurb: 'Athletic heavyweight — huge hops, huge hits.',
    color: '#552583', speed: 6, strength: 8, weight: 7, jump: 8, fallSpeed: 6, size: 7,
    melee: { name: 'Dunk Slam', range: 5, dmg: 8, startup: 6 },
    projectile: { name: 'Basketball', speed: 6, dmg: 7, cooldown: 6, arc: 'bounce' },
  },
  {
    id: 'jsav', name: 'jsav', blurb: 'Machine-gun zoner — bury them in bullets.',
    color: '#7a6a55', speed: 5, strength: 5, weight: 5, jump: 5, fallSpeed: 6, size: 5,
    melee: { name: 'Pistol-Whip', range: 4, dmg: 5, startup: 3 },
    projectile: { name: 'Bullet', speed: 10, dmg: 2, cooldown: 1, arc: 'straight' },
    useImage: true,
  },
  {
    id: 'kenny', name: 'Kenny', blurb: 'Wheelchair bat-swinger — heavy, rolls fast, no recovery.',
    color: '#2bbfae', speed: 7, strength: 7, weight: 8, jump: 3, fallSpeed: 7, size: 6,
    melee: { name: 'Bat Swing', range: 6, dmg: 7, startup: 4 },
    projectile: { name: 'Baseball', speed: 7, dmg: 5, cooldown: 5, arc: 'lob' },
  },
  // ↑ add more fighters here.
];

// A solid or pass-through platform rect, in stage-space (origin top-left, y down).
export interface StagePlatform {
  x: number; y: number; w: number; h: number;
  passThrough: boolean; // true = jump up through it / hold ↓ to drop down
  // optional oscillation: dx = horizontal amplitude (px), dy = vertical amplitude (px),
  // period = seconds per full cycle, phase = 0..1 offset so platforms desync.
  moves?: { dx: number; period: number; dy?: number; phase?: number };
}
// A damaging hazard region (e.g. lava). Touching it deals damage + a strong upward launch.
export interface StageHazard {
  x: number; y: number; w: number; h: number;
  kind: 'lava';
  dmg: number;     // damage-% added per touch tick
  launch: number;  // upward launch impulse strength
}
// A stage. Coordinates are in a fixed 1280×720 stage-space; the renderer scales to the canvas.
// Blast zones: a fighter launched past these bounds loses a stock. `spawns` are respawn points.
export interface Stage {
  id: string;
  name: string;
  blurb: string;
  backdrop: string;          // base sky/background tint
  platforms: StagePlatform[];
  hazards: StageHazard[];
  spawns: { x: number; y: number }[]; // up to 4 spawn points
  blast: { left: number; right: number; top: number; bottom: number }; // ring-out bounds
}

// Stage-space is 1280 wide × 720 tall. Blast zones sit OUTSIDE that so there's margin off-screen.
export const SB_STAGE_W = 1280;
export const SB_STAGE_H = 720;

// The three stages. TO ADD MORE STAGES: append here (and the renderer in client/superbros.ts
// already draws platforms/hazards generically; add a backdrop case for extra flavor).
export const STAGES: Stage[] = [
  {
    id: 'plaza', name: 'Plaza Showdown',
    blurb: 'Open & beginner-friendly. A long floor + two small floats.',
    backdrop: '#7fb2e8',
    platforms: [
      { x: 240, y: 560, w: 800, h: 40, passThrough: false }, // long solid main floor
      { x: 360, y: 400, w: 200, h: 20, passThrough: true },  // left float
      { x: 720, y: 400, w: 200, h: 20, passThrough: true },  // right float
    ],
    hazards: [],
    spawns: [
      { x: 420, y: 480 }, { x: 860, y: 480 }, { x: 560, y: 340 }, { x: 720, y: 340 },
    ],
    blast: { left: -160, right: 1440, top: -260, bottom: 880 },
  },
  {
    id: 'paddlepark', name: 'Paddle Park',
    blurb: 'Aerial & vertical. NO floor — staggered pong-paddle platforms with gaps.',
    backdrop: '#10202b',
    platforms: [
      { x: 200, y: 560, w: 220, h: 22, passThrough: true },  // low-left paddle
      { x: 860, y: 560, w: 220, h: 22, passThrough: true },  // low-right paddle
      { x: 520, y: 420, w: 240, h: 22, passThrough: true, moves: { dx: 180, period: 7 } }, // moving mid paddle
      { x: 340, y: 280, w: 200, h: 22, passThrough: true },  // high-left paddle
      { x: 740, y: 280, w: 200, h: 22, passThrough: true },  // high-right paddle
    ],
    hazards: [],
    spawns: [
      { x: 300, y: 500 }, { x: 960, y: 500 }, { x: 440, y: 220 }, { x: 820, y: 220 },
    ],
    blast: { left: -160, right: 1440, top: -260, bottom: 860 },
  },
  {
    id: 'hellpit', name: 'Hell Pit',
    blurb: 'DOOM hazard stage. A central lava pit between two ledges — touch it and fly.',
    backdrop: '#1a0808',
    platforms: [
      { x: 160, y: 560, w: 360, h: 60, passThrough: false }, // left ground
      { x: 760, y: 560, w: 360, h: 60, passThrough: false }, // right ground
      { x: 540, y: 360, w: 200, h: 20, passThrough: true },  // center float over the pit
    ],
    hazards: [
      { x: 520, y: 600, w: 240, h: 120, kind: 'lava', dmg: 12, launch: 9 }, // central lava pit
    ],
    spawns: [
      { x: 300, y: 480 }, { x: 980, y: 480 }, { x: 240, y: 480 }, { x: 1040, y: 480 },
    ],
    blast: { left: -160, right: 1440, top: -260, bottom: 880 },
  },
  {
    id: 'gauntlet', name: 'The Gauntlet',
    blurb: 'Everything moves. Sliding platforms + two out-of-phase risers — time your landings.',
    backdrop: '#141a2e',
    platforms: [
      { x: 100, y: 590, w: 240, h: 30, passThrough: false }, // left anchor ground
      { x: 940, y: 590, w: 240, h: 30, passThrough: false }, // right anchor ground
      { x: 540, y: 500, w: 220, h: 20, passThrough: true, moves: { dx: 280, period: 5 } },                 // wide low slider
      { x: 330, y: 380, w: 180, h: 20, passThrough: true, moves: { dx: 0, period: 4, dy: 140 } },           // left riser
      { x: 770, y: 380, w: 180, h: 20, passThrough: true, moves: { dx: 0, period: 4, dy: 140, phase: 0.5 } }, // right riser (opposite)
      { x: 560, y: 250, w: 160, h: 20, passThrough: true, moves: { dx: 220, period: 6.5, phase: 0.25 } },   // high slider
    ],
    hazards: [],
    spawns: [
      { x: 200, y: 510 }, { x: 1040, y: 510 }, { x: 540, y: 420 }, { x: 700, y: 420 },
    ],
    blast: { left: -160, right: 1440, top: -260, bottom: 900 },
  },
];

// Super Tsong Bros match rules (shared so client sim + any future server checks agree).
export const SB_STOCKS = 3;          // lives per fighter
export const SB_MAX_PLAYERS = 4;     // lobby cap
export const SB_MIN_PLAYERS = 2;     // min to start

// --- Tron (light cycles) ---
export const TRN_COLS = 320;         // arena grid width in cells
export const TRN_ROWS = 180;         // arena grid height in cells
export const TRN_MAX_PLAYERS = 4;    // lobby cap (humans; bots fill the rest)
export const TRN_MIN_PLAYERS = 1;    // solo start allowed (vs bots, no payout)
export const TRN_ROUNDS_TO_WIN = 3;  // first to this many round wins takes the match

// --- Tsong Artillery (Worms-like) ---
export const WA_W = 1920;            // battlefield width (px, also the terrain bitmap width)
export const WA_H = 1080;            // battlefield height
export const WA_MAX_PLAYERS = 4;
export const WA_TURN_MS = 30_000;    // shot clock per turn
export const WA_HP = 150;            // hit points per fighter

// --- Tsong Hero (rhythm game) — server-side validation whitelists ---
export const GH_SONG_FILES = [
  'everlong.mp3', 'inthend.mp3', 'paranoid-android-8bit.mp3',
  'gangstas-paradise-8bit.mp3', 'heart-shaped-box-8bit.mp3', 'livin-on-a-prayer-8bit.mp3',
] as const;
export const GH_DIFFS = ['easy', 'normal', 'hard'] as const;
export const GH_MAX_SCORE = 1_000_000; // sanity ceiling (a full-combo hard chart tops out ~700k)


// Season Pass: weekly challenges with coin rewards.
export interface SeasonChallenge {
  id: string;
  label: string;
  emoji: string;
  goal: number;
  progress: number;
  reward: number;
  claimed: boolean;
}

export interface SeasonPassMsg {
  type: 'seasonPass';
  weekId: string;  // e.g. '2026-W26'
  challenges: SeasonChallenge[];
}

export interface MatchStatsMsg {
  type: 'matchStats';
  longestRally: number;    // peak paddle-hit count in a single rally
  maxBallSpeed: number;    // peak ball speed this match, court units / second (rounded)
  powerupsLeft: number;    // total power-ups collected by the left side
  powerupsRight: number;   // total power-ups collected by the right side
  leftName: string | null;
  rightName: string | null;
  winnerSide: Side | null;
}
