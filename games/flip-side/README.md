# Flip Side

A multiplayer, browser-based pinball battle for up to 8 players. Everyone plays the same table at the same time, each on their own screen, and big shots send trouble to your rivals: a brick on their playfield, fog over the top of their table, shrunk flippers or swapped flipper buttons. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name. On your own, it's you against your best score.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/flip-side/g/K7Q2M`. Send either one to your friends. **Play solo** (or the hub's Solo button) starts a game on your own straight away.
- The host picks the match: **timed** (2, 3 or 5 minutes; the top score when time's up wins, and a drained ball comes straight back) or **balls** (3 or 5 each; the top score once everyone has drained wins, with a 10-minute cap). The host also picks who trouble goes to (a random rival, whoever's winning, or nobody) and can add CPU players (easy, normal or hard).
- **Keyboard:** ← , Z or left Shift for the left flipper; → , / or right Shift for the right one. Hold ↓ or Space to pull the plunger back and let go to launch. ↑ nudges the table: a shove towards the middle that can save a ball from an outlane, but three nudges close together tilt it.
- **Touch:** the left and right halves of the table are the flippers; **Hold to launch** is the plunger, and **Nudge** nudges.
- **The table.** Three pop bumpers, slingshots, three top lanes (roll through all three to raise the bonus multiplier, up to 5×; the flippers move the lit lanes along), a bank of three drop targets, three standups, a left orbit (combos within 4 seconds score more each time), and a scoop up the right.
- **Skill shot.** Each new ball lights one of the top lanes. How long you pull the plunger decides which lane the ball drops into: get the flashing one for 10,000.
- **Multiball.** Knocking down all the drop targets lights the lock at the scoop. Lock two balls for 3-ball multiball; then the scoop is a 25,000 jackpot, relit by the orbit.
- **Ball save** gives a drained ball back for 6 seconds after it leaves the shooter lane (10 seconds once multiball starts). A drain pays the ball's bonus times the multiplier, and the multiplier goes back to 1×.
- **Trouble.** Drop targets, lanes, standups, the orbit, the skill shot, multiball and jackpots charge your trouble meter. When it's full, trouble goes to a rival and lands a second later: you get a warning, then a **brick** in the way for 12 s, **fog** over the top of the table for 8 s, **shrunk flippers** for 10 s, or **swapped flipper buttons** for 6 s.
- Reloading the page puts you back at your table. If you drop out mid-match, an autopilot keeps your table going until you're back. Anyone who joins mid-match watches (click a rival's table to watch it) and plays from the next match.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/flip-side -- --port 5190  # http://localhost:5190/flip-side/, with the Worker and Durable Object in workerd
npm test -w games/flip-side                    # physics, rules, your own table, CPU, game and room tests (Node)
npm run typecheck -w games/flip-side
```

In development, `__fs.autopilot("hard")` in the console plays your table with a CPU (`null` gives it back), and `?lag=150` on the URL adds round-trip delay.

**Determinism.** The client and the worker must step every table the same, bit for bit (see `CLAUDE.md`). `test/sim.test.ts` replays a recorded two-minute game, with trouble landing, and checks its hash. If you change the physics or the rules on purpose, the golden hash there changes too.

**CPU strength.** `MEASURE=1 npx vitest run test/ai.test.ts --silent=false` (in this folder) plays 200 two-minute games per CPU level (`MEASURE=500` for more) and prints a table. On an Apple M4 Max, 200 games each:

| CPU | Mean score | Drains / min | Trouble sent / min | Multiballs / min | Jackpots / min | ms per game-second |
| --- | --- | --- | --- | --- | --- | --- |
| easy | 55,601 | 2.83 | 0.46 | 0.04 | 0.01 | 1.14 |
| normal | 99,773 | 2.70 | 1.10 | 0.13 | 0.07 | 1.68 |
| hard | 256,735 | 1.68 | 2.53 | 0.43 | 0.61 | 2.09 |

So normal scores nearly twice what easy does, and hard two and a half times normal: it aims, catches the ball to aim again, and gets to multiball. A CPU costs about 2 ms of thinking and playing per second of play for hard (about 1 for easy), nearly all of it planning flips: seven hard CPUs in one room are under 2% of a core.

## Deploying

`npm run deploy -w games/flip-side` builds it and deploys it to **https://warrick.games/flip-side/**. The root README explains how the games share warrick.games. `localStorage` keys start with `fs.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /flip-side/api/games            → allocate a code, initialize that room
   │   GET  /flip-side/api/games/:code      → does the game exist?
   └─WS─ /flip-side/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat and event log in storage, and talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **Your table runs on your screen first.** The physics and the rules (`src/shared/sim.ts`) are deterministic, so your screen steps your game as you play and sends your inputs ten times a second; the room steps the same game from them and is the judge of the score. Hashes in the room's frames check the two agree, and if they don't, your screen takes the room's game.
- **The room runs the match.** While a match is played, the room's tick loop runs twenty times a second: it steps every table (humans from their inputs, CPUs from their pilots), routes trouble, and sends a frame with every table's balls, flippers, lights and score. Rivals' tables are drawn small beside yours, a moment behind the clock, smoothly between frames.
- **Trouble lands at a tick the room picks**, a second after the sender's power fills, on the rival's table and on their screen alike. If it reaches their screen late, the screen goes back to a snapshot from before that tick and plays forwards again with it in.
- **CPU players** (`src/shared/ai.ts`) plan by trying: when a ball is about to reach a flipper, they play copies of their game a second ahead with the flip at different moments, and flip the way that did best. The home screen's demo is a hard CPU.
- **The match lives in memory only**; scores, settings and wins are in storage. A deploy restarts the match. **One alarm drives the countdown.** A game with no connections for 12 hours is deleted.

### Layout

```
src/shared/    constants, deterministic sin and cos (dmath.ts), the table (table.ts), one player's game
               (sim.ts), your own table on your screen (local.ts), CPU players (ai.ts), protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: play messages, the tick loop, the countdown),
               game.ts (the match, trouble, results), match.ts (every table in the match)
src/client/    main.ts (the shell, the loop, HUD, rivals and results), match.ts (the match on screen),
               render.ts (canvas), input.ts (keys and touch), audio.ts (sounds), attract.ts (home-screen demo)
test/          physics and rules, your own table, CPU, game-rule and room tests
```

The room, lobby rules, router, socket (with the heartbeat that keeps a playing room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
