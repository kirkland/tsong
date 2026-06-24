# Plan 08 — Mobile Core Fixes

## Context

The mobile layout (≤768px) is cramped and partly broken. Scope is **core fixes** (not a full responsive rebuild): (1) fix the **empty Leaderboard tab**, (2) stop the **sponsored ad from covering content**, (3) un-cram the **top nav**, (4) make the **most-used panels (Market, Shop, Casino) usable** on phones. Defer deep reflows of rarely-used panels.

## Anchors

- Mobile breakpoint `@media (max-width: 768px)` (`index.html:2685`). Mobile shows a sticky tab bar `#mobileTabs` (`index.html:3501-3505`) with Play/Chat/Leaderboard; switch logic `main.ts:3488-3528`.
- Boards markup: `#boards` (containing `#leaderboard` + `#netWorth`) lives **inside** `#stage` (`index.html:3507-3561`).
- Ad: injected by `client/ads.ts`, `#fakeAd` `position:fixed; bottom:0; z-index:55; height:76px` (`ads.ts:78-79`); `document.body.style.paddingBottom='76px'` (`ads.ts:150`); revealed on join (`main.ts:749`).
- Nav: `#topLeft` `display:flex; gap` no wrap (`index.html:777-785`); mobile shrinks fonts (`index.html:2742-2758`); dropdown `.nav-menu min-width:170px` (`index.html:812-821`).

## Fix 1 — Empty Leaderboard tab (root cause confirmed)

The Leaderboard tab sets `#stage` to `display:none` (`main.ts:3509`) then sets `#leaderboard`/`#netWorth` to `display:''` (`main.ts:3511-3512`) — **but those boards are children of `#stage`, so the hidden parent wins** and they stay invisible.

**Fix (pick one, recommend A):**
- **A — Move `#boards` out of `#stage`.** In `index.html`, relocate the `#boards` div to be a sibling of `#stage` inside `.arena` (after `#stage`, alongside `#chat`). Update the tab logic so Play shows `#stage` + `#boards`, Chat shows `#chat`, Leaderboard shows `#boards` only. Verify desktop still positions the boards correctly (they currently render under chat on desktop — ensure the move doesn't disturb the 3-column desktop CSS; adjust the desktop rule to place `#boards` where it was).
- **B — Don't hide `#stage`.** For the Leaderboard tab, instead of `stage.display='none'`, hide only the in-stage game elements (canvas + HUD + join controls) and keep `#boards` visible. More surgical but more element-by-element.

Recommend **A** (clean separation), with a careful check of the desktop layout after moving.

## Fix 2 — Ad covering content

The ad is `position:fixed` bottom with `height:76px`; `paddingBottom:76px` on `body` doesn't help because the mobile boards/tab content can sit in a fixed/full-height area that the body padding doesn't push.
- Ensure the scrollable mobile content container reserves space: add `padding-bottom: 76px` (or `env(safe-area-inset-bottom)+76px`) to the **mobile content wrapper** (the `.arena`/tab panes), not just `body`.
- Lower the ad's intrusion on mobile: make it dismissible (the screenshots show an `×`) and ensure dismiss persists for the session. Confirm `z-index:55` sits below the `#mobileTabs` (z 90) so tabs stay tappable, and above the boards so it doesn't get hidden — but with the reserved padding it won't overlap.
- On the Leaderboard tab specifically, verify the last board row isn't hidden behind the ad after the padding fix.

## Fix 3 — Nav cramping

`#topLeft` is a single non-wrapping flex row; on narrow screens buttons overflow.
- Add `flex-wrap: wrap` to `#topLeft` at the mobile breakpoint so buttons flow to a second row instead of overflowing, OR make `#topLeft` horizontally scrollable (`overflow-x:auto; flex-wrap:nowrap`) — recommend **wrap** so everything's reachable without horizontal scrolling.
- Keep the reduced font/padding already at `index.html:2742-2758`. Ensure the wrapped nav doesn't cover the `T S O N G` title / score (give the board top padding equal to the nav height, or pin the nav and offset content).

## Fix 4 — Panel usability (Market, Shop, Casino)

Dropdowns are `position:absolute; min-width:170px` anchored to fixed nav buttons → they overflow the right edge / get cut off on phones.
- At the mobile breakpoint, restyle the **most-used** panels (`#marketPanel`, `#shopPanel`, `#casinoPanel` and its children `#market`/`#loot`/`#marketplace`/`#loan`/`#roulette`/blackjack/news) as **full-width bottom sheets or centered modals**: `position:fixed; left:0; right:0; max-width:100vw; max-height:80vh; overflow:auto` with a close affordance. A shared `.mobile-sheet` class applied under the media query is cleanest.
- Ensure the market panel's coin rows/graphs and the shop's item grid reflow to the narrow width (no fixed pixel widths wider than the viewport). The roulette/blackjack canvases should scale down (`max-width:100%`).
- Defer Loan/World/Tourney/Power-ups deep reflow (out of core scope) but make sure they at least don't break the page (constrain to viewport, `overflow:auto`).

## Verification

- Use device emulation (Chrome DevTools, ~390px). Confirm: Leaderboard tab shows both boards fully; the ad never covers the last row and is dismissible; nav buttons wrap to reachable rows; Market/Shop/Casino open as full-width sheets and are fully scrollable/usable; desktop layout (≥769px) is unchanged.
- Regression: desktop 3-column layout, tab switching, and board rendering all still correct after moving `#boards`.

## Files to touch

- `client/index.html` — move `#boards` out of `#stage` (`3507-3561`); mobile `@media` (`2685`, `2742-2758`): `flex-wrap` on `#topLeft`, `.mobile-sheet` panel styles, content `padding-bottom`.
- `client/main.ts` — tab switch logic (`3488-3528`) to show/hide the relocated `#boards`.
- `client/ads.ts` — mobile padding/dismiss behavior (`78-79`, `150`).
