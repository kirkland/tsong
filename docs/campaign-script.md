# DAVIS COLLECTS — Campaign Script

The visual-novel script for tsong's campaign mode. Silent protagonist (the player
never speaks; rivals talk *at* you). Recurring motif: **"the debt always comes back."**
Cosmic-debt currency: **time/existence** (Davis lends time, not coins).
Ending tone: bittersweet — *"We're square — for now."*

Conventions:
- **SPEAKER** — portrait shown in the VN box.
- *(italics)* — stage direction / delivery note.
- `[cue]` — music/sfx to fire.
- Lines are kept short — one VN text box each (advance on click/space, text-blip per char).

---

## COLD OPEN — before Stage 1
*Portrait: `davisclarke.jpg`. `[start-music.mp3] fades under`*

**DAVIS:** Rough year, huh? The coins, the loans, the bad bets. I've seen your books.

**DAVIS:** Relax. I'm a reasonable man. Here's the deal, one time only.

**DAVIS:** Win my little tournament — five of my associates — and your debt's gone. Wiped clean.

**DAVIS:** Lose?

*(he smiles, doesn't finish)*

**DAVIS:** ...Let's not lose. First table's waiting.

---

## STAGE 1 — FRITZ ("Easy Money")
*Portrait: `fritz.jpg`. `[battle.mp3]` on fight start. Clean court, no modifiers. First to 3.*

### Intro
**FRITZ:** Oh, you're the new mark? Hah. Davis sent me. No offense, friend.

**FRITZ:** I'll be home before this ball cools off. Easy money.

### Defeat
**FRITZ:** Okay— okay. Huh. That actually... huh.

**FRITZ:** Y'know what? Keep the win. Davis can deal with you himself.

**FRITZ:** *(under his breath)* Heard it doesn't matter anyway. The debt always comes back.

---

## STAGE 2 — OTTO (the minion)
*Portrait: `minion.png` + minion paddle skin. `[battle.mp3]`. Turbo on. `[minion-laugh.mp3]` on his intro and each time he scores. First to 3.*

### Intro
**OTTO:** *(cackling)* BELLO! Davis say... pong-pong! Hee hee! `[minion-laugh.mp3]`

**OTTO:** Me play! Me WIN! Banana for winner!

### Defeat
**OTTO:** *(sad little noise)* ...aww.

**OTTO:** ...banana.

*(he toddles off)*

---

## STAGE 3 — JSAV (the true believer)
*Portrait: `jsav.jpg`. `[battle.mp3]`. Gravity on + `.fx-glitch` flickering. `[jumpscare.mp3]` sting on the "larger than you think" line. First to 3.*

### Intro
**JSAV:** *(calm, unsettling)* You think you're winning matches. You're settling accounts.

**JSAV:** Davis sees every rally. Every debt. He's seen yours. `[jumpscare.mp3]`

**JSAV:** It's... larger than you think.

### Defeat
**JSAV:** *(serene, smiling)* Good. Now I'm balanced.

**JSAV:** He'll see you soon. He always does.

**JSAV:** The debt always comes back. You'll understand.

---

## STAGE 4 — AVERY (the terrified lieutenant)
*Portrait: `avery.webp`. `[battle.mp3]` (tenser). `.fx-smoke` / fog of war on. First to 3.*

### Intro
**AVERY:** You shouldn't have made it this far. Listen— listen to me.

**AVERY:** Nobody pays Davis off. You win, you lose, doesn't matter— the debt always—

*(he stops, glances over his shoulder)*

**AVERY:** ...he's listening. He's always listening. Just play. Please just play.

### Defeat
**AVERY:** *(shaking)* You're really going to face him. God.

**AVERY:** Okay. Whatever you owe him — don't let him tell you the number.

**AVERY:** Once you hear it... it's real.

---

## STAGE 5 — DAVIS, THE ACCOUNTANT OF REALITY
*`[davis-battle.mp3]` starts at the Phase 1 pre-fight box and loops through all phases.*

### PHASE 1 — "The Businessman" · first to 3
*Portrait: `davisclarke.jpg`. Turbo on.*

**DAVIS:** There he is. The one who climbed my whole ladder just to avoid a conversation.

**DAVIS:** Sit. Let's settle up. You want to know your balance with me?

**DAVIS:** It's everything. It always was. Every coin. Every game. Every breath, on credit.

**DAVIS:** Shall we?

### PHASE 1 → PHASE 2 transition
*`[finish-him.mp3]` sting. Portrait shifts `davisclarke.jpg` → `davis_glasses.jpg`. `.fx-blackout` + `.fx-glitch` begin. Court half-dissolves into ledger lines.*

**DAVIS:** *(voice doubling)* Money? That's cute. Money's a tally I invented to keep you playing.

**DAVIS:** I don't lend coins, friend. I lend *time*.

**DAVIS:** Existence runs on my ledger. And yours... is overdue.

### PHASE 2 — "The Mask Slips" · first to 3
*Portrait: `davis_glasses.jpg` → `davis_marathon.png`. `.fx-blackout` + `.fx-glitch`. Bot predicts bounces (sharper).*

*(no extra box — fight resumes immediately)*

### PHASE 2 → PHASE 3 transition
*`[finish-him.mp3]`/`[jumpscare.mp3]` sting. Portrait → `davis-cosmic.jpg` (true form). `.fx-vortex` + `.fx-blackout`, gravity pulls toward him. The court hangs in the void.*

**DAVIS:** No more forms. No more names.

**DAVIS:** I am the line every debt resolves to.

**DAVIS:** Balance me — if the universe lets you.

### PHASE 3 — "The Accountant" (TRUE FORM) · first to 7
*Portrait: `davis-cosmic.jpg`. `.fx-vortex` + `.fx-blackout` + gravity. Hardest bot.*

Mid-phase taunts (fire as one-shot VN-style toast overlays at score milestones; do NOT pause the match):
- *(you reach 3)* **DAVIS:** Stubborn. Most accounts close quietly.
- *(you reach 5)* **DAVIS:** Interesting. You're not paying the debt. You're *disputing* it.
- *(Davis reaches 5)* **DAVIS:** Don't worry. I round up.

---

## ENDING — VICTORY
*The void cracks; the cosmic form reassembles into plain `davisclarke.jpg`. `[yay.mp3]` then `[chaching.mp3]`. Effects clear.*

**DAVIS:** *(straightening his tie, almost amused)* Well. Books are balanced. We're square.

**DAVIS:** ...For now.

**DAVIS:** Debts have a way of accruing. Come see me again.

*(cut to score screen: arcade-score breakdown, final total, leaderboard rank)*

---

## ENDING — DEFEAT (any stage)
*`[you-lose.mp3]`. Screen goes to Davis's ledger.*

**DAVIS:** *(unseen, calm)* Account closed.

*(cut to score screen: partial score banked, leaderboard rank)*

---

## SCORE SCREEN (post-run, win or lose)
Not dialogue — UI. Shows:
- Per-stage: base (scales with stage) + win-margin bonus + speed bonus
- Running total → **FINAL SCORE**
- Your rank on the campaign leaderboard
- Buttons: **Retry** / **Quit**
- `[start-music.mp3]` loop returns
