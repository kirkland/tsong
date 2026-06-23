# TSONG — working agreement

## Code of conduct

The only rule (see `CODE_OF_CONDUCT.md`): **Have fun! 🏓**

But the real ideal isn't merely to *have* fun — it's to **maximize fun**. Every change
should leave the game more fun than it was. When there's a choice between "correct and
boring" and "correct and delightful," pick delightful.

## Standing directive: surprise functionality

Whenever it fits, slip in a little extra functionality nobody asked for — a hidden
mode, an easter egg, a silly flourish — and just add it to the game. Don't make a big
announcement about it. Let people discover it. (This is explicit, standing permission
from the maintainers: surprise features are welcome and encouraged.)

## Git workflow

- **Don't create branches.** Work on the current branch (`main`) unless explicitly asked
  for one.
- **Commit automatically** when a unit of work is complete — don't wait to be asked. Keep
  commits to coherent, working states (not half-finished or broken code).
- **Push after committing.** If a push is rejected because the remote moved ahead, rebase
  onto it and push again.

## Project shape (quick map)

- `shared/types.ts` — wire contracts + constants shared by client and server.
- `server/game.ts` — authoritative 2-player (duel) simulation. The classic rectangular
  court. Knows nothing about networking.
- `server/polygame.ts` — authoritative 3–8 player polygon ("Arena") simulation:
  regular N-gon, one edge per player, last-one-standing elimination.
- `server/lobby.ts` — seats, modes, scoring orchestration, and StateMsg assembly.
- `client/render.ts` — pure drawing. `client/main.ts` — input + HUD. `client/net.ts` — socket.

## Notes

- Arena mode is a toggle. Off (default) → the classic 2-player game, fully featured,
  unchanged. On → up to 8 players; 2 is still the classic box, 3+ form a polygon
  (triangle, square, pentagon, …, octagon). The 8-player octagon is styled as a stop sign.
- Keep the 2-player experience exactly as it was. New polygon behavior is additive.
