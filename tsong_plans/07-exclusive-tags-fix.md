# Plan 07 — Exclusive Tags/Items Render Fix

## Context

Exclusive cosmetics pulled from loot boxes (Void Crown, Genesis Skin, Prism Halo, Quantum Skin, Founder title, etc.) can be owned and equipped but **render as nothing** — the same class of bug the `x-eclipse` trail had before commit `92558af` fixed it. Root cause: the client render layer looks each cosmetic up in a renderer registry keyed by id, and the `x-*` exclusive ids were never added, so the lookup returns `undefined` and the draw silently no-ops.

This is a pure bug fix. Do it first — Plans 06 and any future cosmetic depend on the same registration pattern.

## The template (the trail fix, `92558af`)

The trail bug: `x-eclipse` was missing from `TRAIL_TINTS`, so `drawTrail()` hit `if (!tint) return;` (`client/render.ts:710`) and drew nothing. The fix added an `x-eclipse` entry to `TRAIL_TINTS` (`render.ts:696-703`) and to the `TRAIL_GLOW` set (`render.ts:705`). Every exclusive needs the analogous registration in its slot's registry.

## The bugs to fix (confirmed missing entries)

1. **Hats** — `HAT_RENDERERS` (`client/render.ts:799-820`), applied at `render.ts:112` (`HAT_RENDERERS[pl.hat]`). Missing: **`x-voidcrown`**, **`x-prismhalo`** (plus any new hat exclusives from Plan 06). Add a renderer fn for each that draws the hat (follow the existing entries' signature/style; make Void Crown a mythic-looking crown, Prism Halo a glowing ring, etc.).
2. **Skins** — `SKIN_RENDERERS` (`client/render.ts:659-677`), applied at `render.ts:105` (`SKIN_RENDERERS[pl.skin]`). Missing: **`x-genesis`**, **`x-quantum`** (+ new skin exclusives). Add a renderer fn each (animated tints like the other skins).
3. **Trails** — `TRAIL_TINTS` already has `x-eclipse` ✓. Add any **new** trail exclusives (Plan 06's `x-singularity`, etc.) to `TRAIL_TINTS` (+ `TRAIL_GLOW`).
4. **Titles** — `x-founder` is a **title**. Titles render as a text tag next to the player name (like "GOAT", "Clown"), resolved by looking the title id up for a display label. The exclusive title id is **not** in `COSMETICS`, so the label lookup likely fails or shows blank. **Action**: grep for how a title tag renders (search `title` usage in `client/render.ts`/`client/main.ts` and where the leaderboard draws the title chip; look for a `COSMETICS.find(c => c.id === title)` or a name map). Ensure the lookup also searches `EXCLUSIVES` (merge both lists, or add a combined `ALL_COSMETICS = [...COSMETICS, ...EXCLUSIVES]` helper in `shared/types.ts` and use it for label resolution). Confirm the exclusive title chip shows its name (e.g. "🪙 Founder") wherever regular titles show.

## Equip path (verify, likely already correct)

`equipItem()` (`db.ts:729-746`) already validates exclusive ownership against the per-instance list (`cur.exclusives.some(e => e.id === item)`) vs CSV `owned` for regulars (`db.ts:735-737`). So equipping is fine; the bug is purely **rendering**. Confirm the equipped exclusive id actually reaches the renderer: trace that `WalletMsg.exclusives` (`types.ts:971`) and the equipped slot column flow into the same `pl.hat/skin/trail/title` fields the renderers read. If the client only renders ids it finds in `COSMETICS` anywhere upstream (e.g. a guard that filters unknown ids before equipping in the UI), fix that to include exclusives too.

## Make it future-proof

Add a dev-time guard so this can't silently regress: a small startup assertion (or a comment + test) that every `EXCLUSIVES` (and `COSMETICS` animated) id has a corresponding renderer entry for its slot. E.g. iterate `EXCLUSIVES`, and for each, assert the matching registry has the key; `console.warn` any missing id. This turns "renders as nothing" into a visible warning.

## Verification

- `npm run dev`; grant/equip each exclusive (Void Crown, Genesis, Prism Halo, Quantum, Eclipse, Founder + new ones). Confirm each **visibly renders** on your paddle/avatar and the Founder **title chip shows its name** on the leaderboard.
- Pull a new Plan-06 exclusive and confirm it renders (joint test).
- The startup guard logs no missing-renderer warnings.
- `npm run typecheck`.

## Files to touch

- `client/render.ts` — add renderer fns: `HAT_RENDERERS` (`799`) `x-voidcrown`,`x-prismhalo`; `SKIN_RENDERERS` (`659`) `x-genesis`,`x-quantum`; `TRAIL_TINTS`/`TRAIL_GLOW` (`684-705`) any new trails; the missing-renderer startup guard.
- `client/main.ts` / `client/render.ts` — title-label resolution to include `EXCLUSIVES` (the title chip lookup).
- `shared/types.ts` — optional `ALL_COSMETICS` helper for unified label lookup.
