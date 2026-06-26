// ── TSONG Dungeon — mob roster (canonical, planning-phase) ──────────────────────
//
// The monsters you run into on encounter tiles (~). Each resolves as a Pong duel to 3,
// with a corner profile (portrait + name + 3 health pips) like Campaign's opponents.
//
// Every `gimmick.powerup` below is a REAL effect already in the engine
// (shared/types.ts POWERUPS) — grow/shrink/smash/slow/multi/freeze/curve/blind/mirror/
// shield/ghost/tiny/warp/bigball/rotate — plus the turbo/gravity/fog mods and the
// glitch/smoke/blackout/vortex screen FX. Bot difficulty reuses Campaign's four knobs.
//
//   power   = HP you lose per point the mob scores on you (the ONLY damage source).
//   bot     = { react (s between re-aims), error (± aim units), predict, idleCenter }.
//             higher react/error = easier; predict = anticipates the wall bounce.
//   gimmick = its signature move: a real powerup/fx it periodically triggers.
//   floors  = where it spawns.

window.DUNGEON_MOBS = [
  {
    id: 'bat', name: 'Cave Bat', portrait: '🦇', floors: ['B1'],
    power: 4,
    bot: { react: 0.34, error: 110, predict: false, idleCenter: false },
    gimmick: { name: 'Flit', powerup: 'ghost', desc: 'The ball blinks dark for ~1s as it darts — track it blind.' },
    flavor: 'Screeeee!',
  },
  {
    id: 'slime', name: 'Crypt Slime', portrait: '🟢', floors: ['B1', 'B2'],
    power: 5,
    bot: { react: 0.30, error: 90, predict: false, idleCenter: true },
    gimmick: { name: 'Engorge', powerup: 'bigball', mods: { slow: true }, desc: 'A fat, lazy ball — easy to hit, but it lulls you to sleep.' },
    flavor: '...bloop.',
  },
  {
    id: 'rattler', name: 'Bone Rattler', portrait: '💀', floors: ['B2', 'B3'],
    power: 6,
    bot: { react: 0.24, error: 70, predict: false, idleCenter: true },
    gimmick: { name: 'Rib Toss', powerup: 'multi', desc: 'Flings a second "rib" ball — two to watch at once.' },
    flavor: 'rattle… rattle…',
  },
  {
    id: 'wisp', name: 'Grave Wisp', portrait: '🔵', floors: ['B3', 'B4'],
    power: 7,
    bot: { react: 0.20, error: 55, predict: true, idleCenter: true }, fx: 'smoke',
    gimmick: { name: 'Gloom', powerup: 'blind', desc: 'Smothers your side of the court in fog — read the ball late.' },
    flavor: '…',
  },
  {
    id: 'gargoyle', name: 'Stone Gargoyle', portrait: '🗿', floors: ['B4'],
    power: 9,
    bot: { react: 0.16, error: 40, predict: true, idleCenter: false },
    gimmick: { name: 'Petrify', powerup: 'shield', mods: { grow: true }, desc: 'A stone wall springs up + its paddle grows — hard to get one past.' },
    flavor: '*grinds awake*',
  },
  {
    id: 'wraith', name: 'Cursed Wraith', portrait: '👻', floors: ['B4', 'B5'],
    power: 10,
    bot: { react: 0.14, error: 30, predict: true, idleCenter: true }, fx: 'glitch',
    gimmick: { name: 'Hex', powerup: 'mirror', desc: 'Inverts YOUR controls for ~3s — up is down.' },
    flavor: 'your fate is sealed.',
  },
  {
    id: 'pong_lord', name: 'The Pong Lord', portrait: '👑', floors: ['BOSS'], boss: true,
    power: 12,
    bot: { react: 0.12, error: 22, predict: true, idleCenter: true },
    // Multi-phase like Campaign's Davis: each phase adds a nastier gimmick.
    phases: [
      { name: 'Phase I — The Tilt',  powerup: 'rotate', desc: 'Rotates the whole court 90°.' },
      { name: 'Phase II — The Swarm', powerup: 'multi', mods: { warp: true }, desc: 'Two balls, and they teleport mid-court.' },
      { name: 'Phase III — Sudden Death', powerup: 'freeze', mods: { turbo: true }, desc: 'Turbo serves + it freezes your paddle on a whim.' },
    ],
    flavor: 'You came all this way… to lose at MY table.',
  },
];
