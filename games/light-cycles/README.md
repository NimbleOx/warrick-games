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
- **The server runs the race.** Unlike Crater Club's turn-based shots, this is real time. While a round is live, the room runs a drift-corrected `setTimeout` loop at 10, 14 or 20 ticks a second, depending on the speed setting. Each tick it steers the CPUs, steps the arena (`src/shared/arena.ts`) and broadcasts a small `Frame`: the cells each cycle entered, their headings, and any crashes, boosts or wall shrinks. Clients feed frames to the same `Arena` class with `apply()`, so walls are laid by identical code on every screen. Heads are drawn interpolated between ticks so movement looks smooth.
- **Input is just turns.** Clients send `turn` and `boost` messages. The server queues up to three turns per rider (so a quick up-then-left hairpin works) and ignores U-turns.
- **Your head shows your turn right away.** A turn shows up in a frame only after a round trip, the wait for the next tick and the playback buffer (one tick behind the newest frame, to ride out jitter). Until then a chevron beside your head points the new way (`src/client/turns.ts` keeps the server's queueing rules to know which turns count). It's only a cue: the frames still steer.
- **The tick loop only runs when it has to.** It stops when the round ends or nobody is connected, so the object can hibernate between rounds. A pending timer keeps a Durable Object in memory, and each incoming WebSocket message resets its 30-second CPU budget. During a round the client sends a JSON heartbeat every 5 seconds (the kit's socket does this while the shell's `isLive` says a round is on); the plain `ping`/`pong` keepalive doesn't count, because the auto-response answers it without waking the room.
- **The arena lives in memory only**, since it changes every tick. If the room restarts mid-round, the round is replayed from a fresh grid. Everything else (scores, settings, phase) is in storage.
- **One alarm drives the phase timers**: the 3-second countdown, the round-over pause and cleanup. A game with no connections for 12 hours is deleted.
- **CPU riders** (`src/shared/ai.ts`) look at going straight, left or right. Each option is scored by the open floor it can reach (flood fill). Hard riders also count the floor they'd reach before anyone else (Voronoi territory), which makes them cut you off. Normal and hard riders avoid cells another head could enter next tick. With 8 hard CPUs on the large arena, that costs about 6 ms per tick. The home screen's demo race uses the same bots.

### Layout

```
src/shared/    code used by both sides: constants, the arena simulation, CPU steering, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: steering messages, the tick loop, the phase timers),
               game.ts (rounds, riding and scoring)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas), audio.ts (sounds),
               attract.ts (home-screen demo)
test/          Vitest tests for the arena, the CPUs and the game flow
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`). `localStorage` keys start with `lc.`.
