// ── TSONG Dungeon — floor layouts (canonical, planning-phase) ───────────────────
//
// This is the single source of truth for the dungeon's level design while we plan.
// Each floor is an array of equal-width rows (the previewer pads ragged rows and
// warns, so don't sweat exact counts while sketching). When the design settles,
// this whole structure drops into shared/types.ts as DUNGEON_FLOORS and the client
// renders it with the existing Kenney tileset — planning artifact == implementation seed.
//
// LEGEND (keep in sync with tools/dungeon/preview.html + docs/dungeon.md):
//   #  wall (solid)            .  floor (walkable)        (space) bedrock / outside
//   @  arrival point           <  stairs up               >  stairs down
//   D  door                    +  locked door (eats a K)  K  key pickup
//   ~  encounter tile (step → chance of a Pong battle)
//   c  chest (coins / minor loot)     $  exclusive collectible (one-time)
//   o  pillar (solid decor)    T  torch (light fixture)   ^  spike trap (damage)
//   B  boss
//
// Descent: B1 → B2 → B3 → B4 → B5 → Throne (the boss arena).

window.DUNGEON_FLOORS = [
  {
    id: 'B1',
    name: 'The Threshold',
    blurb: 'Tutorial floor. One torch-lit encounter room, one chest. Teaches the loop: step on ~ → Pong battle → reward → press on.',
    rows: [
      '#######################',
      '#T....#.......#.....T.#',
      '#.@...D..~~~..D...c...#',
      '#.....#..~~~..#.......#',
      '#.....#..~~~..#.......#',
      '#..####..#D#..####....#',
      '#..#...........#...#..#',
      '#..#..######...#.#.#..#',
      '#..#..#....#...#.#.#..#',
      '#..#..#..c.#...#...#..#',
      '#..#..#....#...#####..#',
      '#..#..##D###.........>#',
      '#..#............#....##',
      '#T.###############..T.#',
      '#######################',
    ],
  },
  {
    id: 'B2',
    name: 'Cistern Galleries',
    blurb: 'Branches for the first time. A flooded room full of encounter tiles guards a key (K); the key opens a locked vault (+) holding the floor’s chest.',
    rows: [
      '#######################',
      '#<....#.~~~~~~~#......#',
      '#.....D.~~~~~~~D..K...#',
      '#..@..#.~~~~~~~#......#',
      '#.....#..#####.#..###.#',
      '#..##.#..#...#.#..#.#.#',
      '#..#..D..#.c.+....#.#.#',
      '#..#..#..#...#.#..#.#.#',
      '#..#..#..#####.#..#...#',
      '#..#..#.......#..##.#.#',
      '#..#..#######.D.....#.#',
      '#..#.........#..###.#.#',
      '#..#########.~~~.#...>#',
      '#T..........~~~..#..T.#',
      '#######################',
    ],
  },
  {
    id: 'B3',
    name: 'The Gauntlet',
    blurb: 'A pressure floor. Long corridors lined with encounter tiles and spike traps (^). First exclusive collectible ($) tucked behind the danger.',
    rows: [
      '#######################',
      '#<...T#~^~^~^~#T......#',
      '#.@...D~~~~~~~D....$..#',
      '#.....#~^~^~^~#.......#',
      '#..##.#~~~~~~~#.####..#',
      '#..#..#.......#.#..#..#',
      '#..#..####D####.#..#..#',
      '#..#...........#.D.#..#',
      '#..####.#####..#.#.#..#',
      '#.....#.#~~~#..^..#.#.#',
      '#.###.#.#~~~#..####.#.#',
      '#.#...#.#~~~D.......#.#',
      '#.#.T.#.#####.####.#.>#',
      '#.#...#.........#....##',
      '#######################',
    ],
  },
  {
    id: 'B4',
    name: 'Pillared Hall',
    blurb: 'A grand chamber broken by stone pillars (o). Wide-open encounter floor — harder, faster monster paddles — and a second collectible ($) plus a coin chest.',
    rows: [
      '#######################',
      '#<......o.....o......T#',
      '#.@...................#',
      '#....o..~~~~~~~..o....#',
      '#.......~~~~~~~.......#',
      '#..o....~~~~~~~....o..#',
      '#.......~~~~~~~.......#',
      '#....o..~~~~~~~..o....#',
      '#.....................#',
      '#..c..o.......o....$..#',
      '#.....................#',
      '#..####.#######.####..#',
      '#T....D.........D....T#',
      '#.........>...........#',
      '#######################',
    ],
  },
  {
    id: 'B5',
    name: 'The Antechamber',
    blurb: 'Calm before the storm. A quiet shrine room (heal / save-point feel), the last chest, and the great door down to the throne. No encounters — deliberate breather.',
    rows: [
      '#####################',
      '#########<###########',
      '######.........######',
      '#####...........#####',
      '#####....T.T....#####',
      '#####...........#####',
      '#####.....@.....#####',
      '#####...........#####',
      '######...c...########',
      '#######.....#########',
      '########.D.##########',
      '#######.....#########',
      '########.>.##########',
    ],
  },
  {
    id: 'BOSS',
    name: 'Throne of the Pong Lord',
    blurb: 'No encounters here. You arrive at the foot of a long, torch-lined hall and walk the whole length toward the throne, where the Pong Lord (B) just sits, waiting. Step up and talk to him → dialogue → the duel begins. Win → the throne yields the exclusive trophy ($).',
    rows: [
      '#####################',
      '#####...........#####',
      '#####.....$.....#####',
      '#####.....B.....#####',
      '#####...........#####',
      '#####...........#####',
      '#########.D.#########',
      '#######T.....T#######',
      '########.....########',
      '#######T.....T#######',
      '########.....########',
      '#######T.....T#######',
      '########.....########',
      '#######T.....T#######',
      '########.....########',
      '#######T.....T#######',
      '########..@..########',
      '#####################',
    ],
  },
];
