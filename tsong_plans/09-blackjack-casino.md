# Plan 09 — Blackjack in the Casino

## Context

Add **Blackjack** as a new single-player-vs-dealer casino game, modeled on the existing Roulette. Player bets coins (escrow → House), plays a hand against the dealer, and wins/loses against the House. Unlike Roulette (a one-shot spin), blackjack is **stateful** (deal → hit/stand/double → dealer plays → settle), so the server holds per-player hand state between messages.

v1 scope: hit, stand, double-down. **No** split/insurance (can be a later addition). Standard rules: dealer stands on 17, blackjack (natural 21) pays **3:2**, regular win **1:1**, push returns the stake, bust loses.

## Roulette template (anchors to mirror)

- Server handler `roulette()` `lobby.ts:1533-1567`: validate → `spendCoins(total)` escrow → `houseCredit(total)` → roll → `housePay(winnings)` → `tell(ws, result)`. **Same escrow/House/payout discipline applies.**
- Messages: `ClientMsg {type:'roulette', bets}` (`types.ts:459`); `RouletteResultMsg` (`types.ts:1130`). Dispatch: server `index.ts`, client `main.ts:651`.
- Casino nav: `#casinoPanel` (`index.html:2952-2960`) lists Market/Loot/Black Market/Loan/Roulette buttons. Add `#blackjackBtn 🃏 Blackjack` sibling and a `#blackjackPanel` after `#roulettePanel` (`index.html:3005`).
- Client roulette module `client/roulette.ts` (canvas + bet handling) is the structural template for a new `client/blackjack.ts`.

## Server state machine (`lobby.ts`)

Hold one active hand per player connection:
```ts
private blackjack = new Map<string /*pid*/, {
  deck: number[];        // shuffled card values to draw from (or draw randomly)
  player: number[];      // card ranks
  dealer: number[];
  bet: number;           // escrowed coins
  doubled: boolean;
  status: 'playing' | 'done';
}>();
```
Cards: represent ranks 1–13 (or a 52-card deck array); Ace = 1 or 11 (best). Use a helper `handValue(cards): { total:number; soft:boolean }`. Either shuffle a real 52-deck per hand (better feel, enables counting flavor) or draw uniform ranks (simpler). Recommend a real shuffled shoe per hand.

Handlers:
- **`blackjackDeal(ws, bet)`**: validate bet (positive int; **respect the wealth-scaled min bet — see Plan 11**; cap like roulette's max stake). `spendCoins(pid, bet)`; if null → reject. `houseCredit(bet)`. Create deck, deal 2 to player, 2 to dealer (one hole card hidden in the message). If player has natural 21 → resolve immediately (3:2). Set status. Send `blackjackState`.
- **`blackjackAction(ws, action)`**: requires an active `playing` hand.
  - `hit`: draw a card to player; if bust (>21) → settle loss, status done.
  - `stand`: dealer reveals hole, draws to ≥17 (dealer stands on soft 17 — pick a rule and document; standard: stand on all 17), then settle.
  - `double`: only on first action; escrow another `bet` (`spendCoins`+`houseCredit`), `doubled=true`, draw exactly one card, then auto-stand (dealer plays), settle. (If player can't afford double, reject.)
- **Settle**: compare totals; compute payout from the House:
  - player blackjack (natural, 2 cards = 21) and dealer not blackjack → `payout = bet + floor(bet*1.5)` (3:2).
  - player wins (no bust, > dealer or dealer bust) → `payout = bet*2` (stake back + 1:1). If doubled, bet is the doubled total.
  - push (equal) → `payout = bet` (stake back).
  - loss/bust → `payout = 0`.
  - Pay via `housePay(pid, name, payout)` (respects House scaling — show the **actual** credited amount). Clear the hand (`status='done'`, delete from map after sending final state).
- On disconnect mid-hand: forfeit (House keeps escrow) or auto-stand — recommend forfeit-loss to avoid abuse; clear state on `worldLeave`/socket close.

## Protocol (`shared/types.ts`)

- **ClientMsg**: `{ type:'blackjackDeal'; bet:number }`, `{ type:'blackjackAction'; action:'hit'|'stand'|'double' }`.
- **ServerMsg**: `BlackjackStateMsg { type:'blackjackState'; player:number[]; dealer:number[]; dealerHidden:boolean; playerTotal:number; dealerTotal:number; status:'playing'|'won'|'lost'|'push'|'blackjack'; bet:number; payout:number; canDouble:boolean }`. (While playing, send `dealer` with the hole card masked and `dealerHidden:true`; on settle, reveal full dealer hand + outcome + payout.)
- Dispatch: add cases in `server/index.ts` (~130-345) with type guards; add client branch in `main.ts` (~651) → `blackjackHandle.onState(msg)`.

## Client (`client/blackjack.ts` + panel)

- Panel `#blackjackPanel`: a felt table area, dealer row (top) + player row (bottom) rendered as cards (canvas or styled divs), a bet input + chip selector (reuse roulette's chip picker pattern `roulette.ts:342`), and **Deal / Hit / Stand / Double** buttons enabled per state.
- `onState(msg)`: render hands (mask the dealer hole while `dealerHidden`), show totals, enable/disable action buttons (`canDouble` only on first decision), and on terminal status show the outcome + payout with a flourish (reuse a celebration like the spin/loot reveal). Update the coin balance from the wallet refresh the server sends.
- Min-bet display: show the current wealth-scaled minimum (Plan 11) so the player knows the floor.

## Conservation

Escrow → House (`houseCredit`), payout ← House (`housePay`). Net House edge comes from the rules (dealer advantage + 3:2 caps). Sums to zero per hand. `npm run conservation` — add a blackjack round-trip case if practical.

## Verification

- `npm run dev`; open Blackjack, deal, exercise hit/stand/double, and a natural blackjack. Confirm payouts: 3:2 on natural, 1:1 on win, stake back on push, House balance moves correctly, and a near-empty House throttles the payout to the actually-credited amount.
- Confirm min-bet enforcement (Plan 11) and disconnect-mid-hand forfeits cleanly.
- `npm run typecheck`.

## Files to touch

- `shared/types.ts` — blackjack message types + a `BLACKJACK_MAX_BET` (and use Plan 11 min-bet).
- `server/lobby.ts` — `blackjack` state map, `blackjackDeal`/`blackjackAction`, `handValue`, settle; cleanup on disconnect.
- `server/index.ts` — dispatch the two client messages.
- `client/blackjack.ts` (new) + `client/index.html` (`#blackjackBtn`, `#blackjackPanel` in `#casinoPanel`) + `client/main.ts` (dispatch `blackjackState`, init module).
