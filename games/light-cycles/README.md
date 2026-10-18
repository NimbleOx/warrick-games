# Light Cycles

A multiplayer, browser-based light cycle game, a sibling to [Crater Club](../crater-club). Up to 8 riders race around a grid, each leaving a solid wall of light behind them. Hit a wall and you derez. The last rider standing wins the round. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/light-cycles/g/K7Q2M`. Send either one to your friends.
- The host picks the rounds, arena size, speed, boosts, walls (solid or wrap-around) and sudden death, and can add CPU riders (easy, normal or hard).
- Steer with the arrow keys or WASD. On a phone, swipe on the grid or use the on-screen pad. You can steer during the countdown to pick your opening line.
- **Space** (or the Boost button) doubles your speed for a moment. You get a few boosts per round.
- When you crash, your wall derezzes with you, which opens up the grid for everyone else.
- With sudden death on, the arena walls start closing in after the set time, so every round ends.
- Scoring: +1 for every rider you outlast, +2 when someone crashes into your wall, +3 for winning the round.
- Reloading the page puts you back on your cycle. Anyone who joins mid-game watches until the next game. If everyone leaves mid-round, the round pauses and resumes with a countdown when someone comes back.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/light-cycles -- --port 5174  # http://localhost:5174/light-cycles/, with the Worker and Durable Object in workerd
npm test -w games/light-cycles                    # arena, CPU, game-rule and room tests (Node)
npm run typecheck -w games/light-cycles
```

## Deploying

`npm run deploy -w games/light-cycles` builds it and deploys it to **https://warrick.games/light-cycles/**. The root README explains how the games share warrick.games. `localStorage` keys start with `lc.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /light-cycles/api/games            → allocate a code, initialize that room
   │   GET  /light-cycles/api/games/:code      → does the game exist?
   └─WS─ /light-cycles/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your cycle back. Other players never see tokens.
- **The server runs the race.** Unlike Crater Club's turn-based shots, this is real time. While a round is live, the room runs a drift-corrected `setTimeout` loop at 10, 14 or 20 ticks a second, depending on the speed setting. Each tick it steers the CPUs, steps the arena (`src/shared/arena.ts`) and broadcasts a small `Frame`: the cells each cycle entered, their headings, and any crashes, boosts or wall shrinks. Clients feed frames to the same `Arena` class with `apply()`, so walls are laid by identical code on every screen.
- **Input is just turns.** Clients send `turn` and `boost` messages, each with the tick it's for (`at`). The server queues up to three turns per rider, makes one a tick (so a quick up-then-left hairpin works), holds each until its tick, and ignores U-turns. A turn that arrives after its tick is made on the next one.
- **Your cycle steers the moment you press.** Frames show the past: they take a round trip and a tick of playback to come back. So your own cycle isn't drawn from them, but from where the server will have it when a turn you press now gets there: the newest frame, ridden on by the time since it, the round trip and a little slack (`src/client/predict.ts`). A turn is sent for the tick that leaves the cell your head is heading into, and the server holds it until then, so it lands on the cell you saw. Everyone else is drawn from frames (see the next point), so they're about a round trip behind you. The frames still decide: each one restarts the prediction, so a turn that got there late, or a crash, puts it right. A late turn also adds to the slack, and the predicted head stops at a wall until the crash comes in. The crash shows as soon as it does: your cycle derezzes there and then (`Arena.crashAs`), and everyone else plays on at their own pace, so another rider's wall you hit can appear a tick after you derez.
- **Everyone else is played back from frames, as close behind the server as the network allows** (`src/client/playback.ts`). Playback runs on the server's schedule as its frames show it (the clock your cycle is timed by too), and between ticks it moves each head from its cell in one frame into its cell in the next. A frame's cells are only known once it's in, so playback runs a tick behind the clock, plus as long as frames have come late lately (one late frame counts for at most 150 ms, and it fades by half every 2 seconds). The next frame is then usually in before it's needed. When one isn't, the heads wait for it and then catch up a little faster; when frames start coming later, playback slows down, to no less than 0.8× speed, rather than stop. Nothing is guessed: the others never run past the newest frame, so they don't overshoot a corner and snap back. With steady frames they're drawn about 1.2 ticks behind the clock (it was 2.2 when each frame was shown a tick after it came, then animated towards). A page that isn't animating (a background tab, or no animation frame for 250 ms, as in a hidden pane) shows each frame as it comes.
- **The tick loop only runs when it has to.** It stops when the round ends or nobody is connected, so the object can hibernate between rounds. A pending timer keeps a Durable Object in memory, and each incoming WebSocket message resets its 30-second CPU budget. During a round the client sends a JSON heartbeat every 5 seconds (the kit's socket does this while the shell's `isLive` says a round is on); the plain `ping`/`pong` keepalive doesn't count, because the auto-response answers it without waking the room.
- **The arena lives in memory only**, since it changes every tick. If the room restarts mid-round, the round is replayed from a fresh grid. Everything else (scores, settings, phase) is in storage.
- **One alarm drives the phase timers**: the 3-second countdown, the round-over pause and cleanup. A game with no connections for 12 hours is deleted.
- **CPU riders** (`src/shared/ai.ts`) look at going straight, left or right. Each option is scored by the open floor it can reach (flood fill). Hard riders also count the floor they'd reach before anyone else (Voronoi territory), which makes them cut you off. Normal and hard riders avoid cells another head could enter next tick. With 8 hard CPUs on the large arena, that costs about 6 ms per tick. The home screen's demo race uses the same bots.

### Layout

```
src/shared/    code used by both sides: constants, the arena simulation, CPU steering, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: steering messages, the tick loop, the phase timers),
               game.ts (rounds, riding and scoring)
src/client/    main.ts (the game screen and its hooks into the shell), predict.ts (your cycle, ahead of the frames),
               playback.ts (everyone else, from the frames), render.ts (canvas), audio.ts (sounds),
               attract.ts (home-screen demo)
test/          Vitest tests for the arena, the CPUs, the game flow, prediction and playback
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`). `localStorage` keys start with `lc.`.
