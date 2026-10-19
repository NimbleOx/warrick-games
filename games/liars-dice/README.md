# Liar's Dice

A multiplayer, browser-based bluffing dice game like *Perudo*. Everyone rolls five dice under a cup and looks only at their own. Players take turns bidding on how many dice of one face are on the whole table, each bid higher than the last, until someone calls "Liar!". The cups come up, the dice are counted, and whoever was wrong loses a die. Lose them all and you're out. The last player with dice wins. Up to 8 players, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/liars-dice/g/K7Q2M`. Send either one to your friends.
- The host picks whether ones are wild (on by default), whether Spot on is allowed (off by default) and the turn timer (off, 15, 30 or 45 seconds), and can add CPU players (easy, normal or hard).
- Everyone starts with 5 dice. You see your own dice and how many dice everyone else has, never their faces.
- On your turn, bid on how many dice of one face are on the whole table, yours included: "at least seven 4s". Each bid must raise the last one: more dice of any face, or the same number of a higher face. Pick a face (or press 1–6), set the number with − and + (or the arrow keys), and press **Bid** (or Enter). Only legal bids can be made, and each face shows the smallest number you could bid on it.
- Don't believe the last bid? Call **Liar!** (or L). Every cup comes up and the dice are counted. If there are at least that many, the caller loses a die; if not, the bidder does. Whoever lost starts the next round.
- **Wild ones** count as every face, so "seven 4s" counts the 4s and the 1s. Bids on ones have their own track: you can't open a round on them, switching to ones can halve the number, rounded up (after seven 4s, four 1s is enough), and switching back needs double plus one (after four 1s, nine of a face). With wilds off, ones are just the lowest face.
- **Spot on** (or S), when the host allows it: instead of raising or calling Liar!, say the last bid is exactly right. If it is, you get a die back (5 at most); if not, you lose one. Either way, you start the next round.
- Lose your last die and you're out. The last player with dice wins, and everyone else is ranked by when they went out.
- When your clock runs out, the game makes the move a normal CPU would make with your dice. Reloading the page puts you back in your seat with your dice, and with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, the game moves for them after 5 seconds. **Leave** mid-game and you're out, though your dice still count this round. Anyone who joins mid-game watches until the next game.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/liars-dice -- --port 5185  # http://localhost:5185/liars-dice/, with the Worker and Durable Object in workerd
npm test -w games/liars-dice                    # rules, CPU, privacy, game-flow and room tests (Node)
npm run typecheck -w games/liars-dice
```

## Deploying

`npm run deploy -w games/liars-dice` builds it and deploys it to **https://warrick.games/liars-dice/**. The root README explains how the games share warrick.games. `localStorage` keys start with `ld.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /liars-dice/api/games            → allocate a code, initialize that room
   │   GET  /liars-dice/api/games/:code      → does the game exist?
   └─WS─ /liars-dice/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between moves. The game is saved after every move, so a deploy mid-round picks up where it was, with the same dice.
- **Nobody's dice are in the game state.** Every socket gets the state, so it holds only public facts: dice counts, this round's bids and the last call's reveal. The round's dice are the room's `live` state, which the kit doesn't save, so `GameRoom` saves them under a key of their own, in the same write as the state. Each player gets their own dice in a `hand` message after every roll and every hello. A call puts that round's dice into the state, public from then on. `test/privacy.test.ts` runs whole games and checks that no seat ever hears another's dice before a call.
- **Dice are rolled only on the server**, with `crypto.getRandomValues` and rejection sampling, so every face is equally likely.
- **Bid order is one number.** `bidRank` maps a bid to an integer, so a raise is just a bigger rank, the halving and doubling of wild ones included.
- **The rules are pure functions** in `src/shared/`: bids, counting and resolving a call (`rules.ts`), the odds (`odds.ts`) and the CPUs (`ai.ts`). The `Game` class in `src/worker/game.ts` is turns, timers, the log and who sees what.
- **A call** plays out from the server's time of the call: the cups lift, the dice that count light up one at a time, then the table sees who loses a die. The reveal lasts 4.5 seconds plus 0.16 seconds a counted die, at most 10 seconds, and someone who reconnects mid-reveal sees it from where it is.
- **One alarm drives every timer:** the turn clock, the 5-second wait for a missing player, CPU thinking time (1–2 seconds a move) and the reveal. The turn clock is the kit's (`@warrick/kit/worker/turns`). Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **The table is DOM, not canvas**: cards, buttons and text, sized to fit a phone.

### CPUs

- Every level judges a bid from its own dice plus the binomial odds for the dice it can't see, and the CPU is given only what its seat may know: its own dice, everyone's dice counts and this round's bids. Easy calls Liar! only on far-fetched bids. Normal calls it when a bid is less than 30% likely (15% with wilds off). Hard reads the other players' bids as hints about their dice, bluffs now and then, and draws its thresholds fresh each turn.
- The levels were tuned with CPU-only games (`test/sim.ts` plays them with the pure rules). A normal CPU that called Liar! below 35% lost to easy, because people and CPUs bid on faces they hold, so plain odds undersell a bid. `test/ai.test.ts` plays a few hundred games to check that easy < normal < hard with every combination of the two options.

### Layout

```
src/shared/    code used by both sides
  rules.ts       bid order and checks, counting, resolving a call, the next seat
  odds.ts        how likely a bid is from one seat's point of view
  ai.ts          CPU players
  constants.ts   dice counts and timings: CPU thinking, the wait for a missing player, the reveal
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: messages, the alarm, saving the hands),
               game.ts (rounds, turns, calls, timers, who sees what), dice.ts (rolling)
src/client/    main.ts (the table, the bid picker and its hooks into the shell), dice.ts (dice as SVG),
               pending.ts (a move waiting for the server), audio.ts (sounds), attract.ts (the home screen's tumbling dice)
test/          Vitest tests for the rules, odds and CPUs, the game flow and the hidden dice, and room.test.ts, which runs
               the real room (reloads, restarts, the hands' storage) through the kit's test harness; sim.ts plays CPU-only games
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
