# The Dungeon — design doc (planning)

A JRPG/Pokémon-style **dungeon crawl** reachable from the World. You enter a building
in town, descend through tile-grid floors, trigger **random encounters** that resolve as
short **Pong duels**, loot chests, hunt floor-exclusive collectibles, and fight a **boss**
at the bottom.

> **Preview the layouts:** open `tools/dungeon/preview.html` in a browser (no build step).
> Floors come from `tools/dungeon/floors.js` — the canonical level data while we plan, and
> the seed for `DUNGEON_FLOORS` in `shared/types.ts` once it's settled.

## Decisions locked

- **It lives *inside* the World — not a separate overlay.** The dungeon is a continuation of the
  World, built on the **same Phaser scene, the same pixel graphics, the same synthesized sound
  engine, and the same dialogue box**. It is NOT an isolated module like `campaign.ts` / `doom.ts`.
- **Implementation model = the Tavern.** The Tavern interior (`TAVERN_INT` in `world.ts`) already
  proves the pattern: an off-map rect you "enter," at which point the camera bounds switch to that
  rect and movement is clamped to it — same scene, same avatar, same everything. Each dungeon
  **floor is another off-map room** like this. Taking the stairs (`>`/`<`) switches the camera
  bounds to the next floor's room. Entry from town is a `WORLD_BUILDINGS` entry (a stone
  **crypt / catacomb** doorway) whose `enterBuilding()` branch drops you into the B1 room.
- **Battles run the real Pong engine.** Encounters use the actual `server/game.ts` simulation we
  already built — not a reimplementation. The encounter just spins up a game vs. an AI paddle
  (mob), restyled per floor. Battle HUD (enemy box, your HP, banner) sits in **reserved top/bottom
  bands so it never covers the court** — the playfield is always clean.
- **Reuse, don't rebuild:** the World's `tone()` / `noise()` synth and its named one-shots
  (`textBlip` square 440→720, `selectBlip` 660→880, `enterChime`), and its Pokémon-style `npcBox`
  dialogue (name tag, 30ms typewriter blipping every 2 chars, blinking ▼, click/Enter/Space to
  advance). Everything dungeon-facing speaks through these so it feels seamless.
- **Theme: overgrown ruins** — old stone reclaimed by nature: moss, dirt, plant tufts, hanging
  vines, tall-grass encounter patches, torch-lit but *not* pitch black (lighter, green-tinted
  ambient). Pokémon-route-meets-FF6-ruins. (Evolved from "classic stone dungeon.") Mockup uses
  real 0x72 CC0 stone tiles + a procedural overgrowth pass; may swap in a dedicated ruins tileset.
- **Movement = the World engine.** Smooth analog glide with **WASD / arrows / touch joystick** —
  *not* grid-step. Walking the dungeon feels exactly like walking the overworld (same code).
- **Camera = the World camera: zoomed in, following the player.** You only ever see the area
  around you — never the whole floor at once. Combined with torch-limited visibility, exploration
  is real discovery. (The mockup zooms out to show the full map *only* for design review.)
- **Scope (first pass):** **4 explorable floors (B1–B4) + a boss hall** (Throne). Descent is
  linear via stairs; floors branch internally. *(Was 5 — trimmed to 4.)*
- **Difficulty curve:** each floor is **trickier to navigate** than the last (denser maze, more
  traps/hazards) **and adds new mobs** to the encounter pool — the roster is **cumulative**, so
  deeper floors mix earlier mobs with new, slightly tougher ones. `floors.js` still has a B5 block
  to fold into B4 / drop when we restructure.
- **Floors grow as you descend:** B1 is the smallest; each floor is meaningfully bigger than the
  last, with **B4 ≈ 4× the size of B1** (sprawling, easy to get lost — the deep dungeon). Scale the
  tilemap dimensions up per floor accordingly. (Current in-engine B1 is 23×15 tiles.)

## The core loop

1. **Explore** a floor on a tile grid (Pokémon-route movement: discrete-feeling, grid-aligned).
2. Step onto an **encounter tile** (`~`) → per-step roll (~12% early, scaling deeper) fires a
   **random battle**.
3. Battle = a **short Pong duel** vs a themed dungeon monster (an AI paddle with a gimmick).
   First to N points, or a timer. Win → continue + chance of loot. Lose → bumped back to the
   floor's arrival point and lose some HP (run ends at 0 HP → climb out / lose unbanked loot).
4. **Loot** chests (`c`) for coins (ties into the existing economy) and hunt **exclusive
   collectibles** (`$`) — cosmetics you can *only* get here.
5. Take the stairs down (`>`). Repeat, harder, until the **Throne** → boss duel → trophy.

## Floors at a glance

| Floor | Name | Role |
|------|------|------|
| **B1** | The Threshold | Tutorial — one encounter room, one chest. Teaches the loop. |
| **B2** | Cistern Galleries | First branch. Key (`K`) → locked vault (`+`) → chest. |
| **B3** | The Gauntlet | Pressure floor: encounter corridors + spike traps (`^`). Collectible #1. |
| **B4** | Pillared Hall | Wide open, faster monsters. Collectible #2 + chest. |
| **B5** | The Antechamber | Breather — shrine/heal, last chest, no encounters. Door to the boss. |
| **Throne** | Throne of the Pong Lord | Boss duel (gimmick paddle). Win → exclusive trophy. |

## Health & combat (proposed)

Every random encounter is a **Pong duel to 3**. Health is **one persistent HP bar** for the
whole run (default 100) — no separate lives. The model collapses "does conceding a point vs
losing a match cost health" into a single rule:

- **A point the mob scores on you costs `power` HP. That is the only source of damage.**
- **Losing a match is not a separate penalty** — it just means the mob scored 3, so you took
  `3 × power`. A loss also bumps you back to the floor's arrival tile (faint-flavor); you're
  not dead, you can push forward again.
- **A flawless 3–0 win costs nothing.** Skill = HP preservation. Tougher mobs have higher
  `power`, so they cost more even when you beat them — difficulty auto-scales.
- **HP hits 0 → black out, expelled from the dungeon.** Secured collectibles are kept;
  unbanked floor coins are lost (the risk/reward, ties into the banking question below).
- **Flee** is allowed per encounter (they're random, not gates): a small HP nick + a free
  serve for the mob, so you can bail on a bad matchup.

The corner profile (Campaign-style) reads as **two health bars**:

- **Mob health = the 3 points you must score** → 3 pips by its portrait, draining as you score.
- **Your health = the HP bar** → chipped `power` per conceded point, persists across the run.

Heal at chests (potions), on clearing a floor (small heal), and fully at the **B5 shrine**.

## Encounter intro — music + transition

When a step rolls a random encounter, it should *feel* like a Pokémon wild battle:

### Music state machine

Three staged tracks (personal project — copyright is a non-issue):

| Track | File | When |
|-------|------|------|
| Dungeon theme — *FFVI "The Mines of Narshe"* | `/dungeon.mp3` | loops while exploring a floor |
| Wild battle — *RSE Wild Pokémon Battle* | `/encounter.mp3` | during an encounter duel |
| Victory — *FFVI Victory Fanfare* | `/victory.mp3` | the win/payout screen |

Transitions:
- Encounter triggers → **pause the dungeon theme in place** (keep `currentTime`) and start the
  battle track from 0.
- Battle won → victory fanfare on the payout screen.
- Back to the floor → **resume the dungeon theme from exactly where it paused**, and loop it when
  it ends. (Don't restart it — that's the whole point of the request.)

### The wild-battle feel
- **Transition (~2s):** a Gen-3-style flash → wipe, kicked off the moment the song starts:
  1. **Flash** — a few rapid full-screen strobes (~0.65s).
  2. **Wipe in** — black bars slam shut from alternating sides to cover the screen.
  3. **Swap + reveal** — under cover, the dungeon view is replaced by the Pong court; the bars
     slide away, the mob's corner profile + "A wild *X* appeared!" banner animate in.

**Preview it now:** open `tools/dungeon/encounter.html` (loads `mobs.js` for a random mob and
plays `/encounter.mp3`). Press Space / click to trigger an encounter. This is the feel spec for
when the encounter flow is actually wired into the dungeon overlay.

## Flavor props (back pocket — add per floor as we build B2+)

Keep B1 clean. Layer atmosphere in as you descend (leafy ruins → crypt). Most can be generated
pixel textures (like the chest) or pulled from the 0x72 atlas (pillars, columns, skeletons, banners).

- **B2 (overgrown):** mossy/broken **pillars** (solid → double as cover), **glowing mushrooms**
  (bioluminescent + a tiny light source), **puddles + drips** (animated plink), **tattered banners**.
- **B3 (things died here):** **bone/skull piles**, **cobwebs** in corners (ported from the mockup),
  a **scurrying rat/spider** (reuse the World critter system), a **cracked statue** landmark.
- **B4 / Throne (crypt):** **sarcophagi / coffins**, **gravestones**, a **dead adventurer** with an
  item glint, and **blue braziers** near the boss (just retint the torch light → instant dread).
- Dual-purpose wins: mushrooms/braziers = extra **light sources**; pillars/statues = **solid props**;
  blue-flame = **zero new art**, just a tint.

## Mob roster

Canonical data: `tools/dungeon/mobs.js`. Each gimmick is a **real engine effect** (a member of
`POWERUPS`) — nothing invented. Bot difficulty reuses Campaign's `react/error/predict/idleCenter`.

| Mob | Floors | `power` | Gimmick (real effect) | Profile flavor |
|-----|--------|:------:|-----------------------|----------------|
| 🦇 Cave Bat | B1 | 4 | **Flit** — `ghost` (ball blinks dark) | "Screeeee!" |
| 🟢 Crypt Slime | B1–B2 | 5 | **Engorge** — `bigball` + slow | "...bloop." |
| 💀 Bone Rattler | B2–B3 | 6 | **Rib Toss** — `multi` (extra ball) | "rattle… rattle…" |
| 🔵 Grave Wisp | B3–B4 | 7 | **Gloom** — `blind` / smoke fx | "…" |
| 🗿 Stone Gargoyle | B4 | 9 | **Petrify** — `shield` + `grow` | "*grinds awake*" |
| 👻 Cursed Wraith | B4–B5 | 10 | **Hex** — `mirror` (inverts YOUR controls) | "your fate is sealed." |
| 👑 The Pong Lord | Throne | 12 | 3 phases: `rotate` → `multi`+`warp` → `freeze`+turbo | boss |

**Boss** is multi-phase like Campaign's Davis — each phase layers on a nastier gimmick.

*(Open question: solo vs the AI only, or can encounters pull in another World player for a live
duel? Default = solo vs AI; live-player encounters are a stretch goal.)*

## Rewards & exclusives

Coins use the existing world currency. Everything you earn in a run goes into a **run purse**
you only keep if you make it out (or bank it at the B5 shrine) — black out at 0 HP and the
unbanked purse is lost (collectibles you secured are always kept). That tension is the engine:
*push deeper for more, or cash out what you've got.*

### Combat rewards — **every** encounter win pays

- **150–300 coins on every win**, trending toward the high end on deeper floors. (Note: this is a
  big injection vs. the World's baseline of ~1 coin per Arena win — intentional, dungeon coins are
  the draw; chest sizes / shop prices may want to scale to match.)
- **A chance at an item** on top of the coins (item table TBD — see consumables/collectibles).
- **Flawless bonus** for a 3–0 — pairs with the HP model (clean play = free HP *and* more coins).
- **Boss**: a much larger purse **+** the exclusive trophy.

### Victory screen — the payoff beat

When you win an encounter, before returning to the floor:

- 🎺 The **FFVI Victory Fanfare** plays — staged at `client/public/victory.mp3` (`/victory.mp3`).
- The reward is shown **through the World's `npcBox` dialogue box** (same graphics + `textBlip`
  typewriter sound), Pokémon-style: e.g. *"You won! · Earned 240🪙!"* — and an item line if one
  dropped.
- **Click (or Enter/Space) to continue** — exactly like dismissing a Pokémon battle result. Then
  the box closes and you're back in the floor room where you were standing.

### Exploration rewards — payoff for leaving the critical path

The fastest line is stairs-to-stairs; the loot is off to the sides, behind encounter rooms and
locked doors. Reasons to wander:

- **Chests (`c`)** — a coin cache bigger than a single fight (≈ a floor's worth of wins) plus a
  good shot at a **consumable**. Placed in dead-ends and guarded rooms.
- **Locked vaults (`+`)** — need a **key (`K`)** found elsewhere on the floor; pay out ≈2–3×
  a normal chest. One real detour per floor that has them (B2).
- **Consumables** (from chests/drops):
  - 🧪 **Potion** — restore HP.
  - 🚫 **Repel** — suppress encounters for N steps (skip grinding, reach a chest clean).
  - 🍀 **Lucky Charm** — boosts coin/consumable drop rates for a while.
  - 💨 **Smoke Bomb** — guaranteed flee from one encounter (vs. the risky default flee).
- **Exclusive collectibles (`$`)** — the headline pull: cosmetics obtainable *only* in the
  dungeon, so they read as status — paddle skins, ball trails, an avatar title/badge shown in
  the World, maybe a pet. Candidates: a **Bone paddle** (B3), a **Cistern Pearl** ball-trail
  (B4), and the boss **Pong Crown** trophy (Throne), wearable in town. These never enter the
  purse — securing one means you keep it even if you later black out.

*(Tuning — base coin values, chest sizes, drop rates — is placeholder; balance once the loop
is playable.)*

## Tile legend (canonical)

| Glyph | Meaning | | Glyph | Meaning |
|---|---|---|---|---|
| `#` | wall | | `~` | encounter tile |
| `.` | floor | | `c` | chest (loot) |
| (space) | bedrock / outside | | `$` | exclusive collectible |
| `@` | arrival point | | `o` | pillar (solid decor) |
| `<` | stairs up | | `T` | torch |
| `>` | stairs down | | `^` | spike trap |
| `D` | door | | `B` | boss |
| `+` | locked door (eats a `K`) | | `K` | key |

Keep this legend in sync across `floors.js`, `preview.html`, and this doc.

## Backlog / TODO (parking lot)

- **Click to capture mouse** — pointer-lock on click (battle and/or dungeon) so mouse control is
  smooth and doesn't drift out of the window.
- **Locked room + key system** — the `+` locked doors / `K` keys: a key gates a room (Matt has the
  specific design in mind).

## Open questions (to settle before building)

1. **Movement feel** — *resolved:* free analog on the World engine (WASD/arrows/joystick), not
   grid-step. Encounter rolls therefore key off distance walked / time on a `~` patch, not steps.
2. **HP / run economy** — *proposed above* (single HP bar, conceded-point damage). Still to
   settle: starting HP value, `power` tuning, and whether loot banks per-floor or only on exit.
3. **Encounter rate curve** — flat per floor, or rising with steps-since-last-battle?
4. **Live-player encounters** — solo-only v1, or wire in another World avatar for a real duel?
5. **Persistence** — are collectibles per-account (server-tracked, like cars/pets) — yes, almost
   certainly, so they show off in town.
