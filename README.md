# Light Cycles

A multiplayer, browser-based light cycle game, a sibling to [Crater Club](../crater-club). Up to 8 riders race around a grid, each leaving a solid wall of light behind them. Hit a wall and you derez. The last rider standing wins the round. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://…/g/K7Q2M`. Send either one to your friends.
- The host picks the rounds, arena size, speed, boosts, walls (solid or wrap-around) and sudden death, and can add CPU riders (easy, normal or hard).
- Steer with the arrow keys or WASD. On a phone, swipe on the grid or use the on-screen pad. You can steer during the countdown to pick your opening line.
- **Space** (or the Boost button) doubles your speed for a moment. You get a few boosts per round.
- When you crash, your wall derezzes with you, which opens up the grid for everyone else.
- With sudden death on, the arena walls start closing in after the set time, so every round ends.
- Scoring: +1 for every rider you outlast, +2 when someone crashes into your wall, +3 for winning the round.
- Reloading the page puts you back on your cycle. Anyone who joins mid-game watches until the next game. If everyone leaves mid-round, the round pauses and resumes with a countdown when someone comes back.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 — Vite + the Worker and Durable Object running in workerd
npm test           # arena, CPU and game-rule tests (Node)
npm run typecheck
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime. (`.claude/launch.json` runs it on port 5174 so it can sit next to Crater Club.)

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `light-cycles` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets.

`wrangler.jsonc` serves it at **https://light-cycles.warrick.games** as a Worker Custom Domain (`routes` with `custom_domain: true`), the same way Crater Club is set up. Cloudflare creates the DNS record and certificate on deploy, provided the zone is in the same account. The `workers.dev` address is turned off (`workers_dev: false`), so invite links always point at the custom domain. To host it somewhere else, change the `pattern`. To get the `workers.dev` URL back, set `workers_dev` to `true`.

If you change bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /api/games            → allocate a code, initialize that room
   │   GET  /api/games/:code      → does the game exist?
   └─WS─ /api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your cycle back. Other players never see tokens.
- **The server runs the race.** Unlike Crater Club's turn-based shots, this is real time. While a round is live, the room runs a drift-corrected `setTimeout` loop at 10, 14 or 20 ticks a second, depending on the speed setting. Each tick it steers the CPUs, steps the arena (`src/shared/arena.ts`) and broadcasts a small `Frame`: the cells each cycle entered, their headings, and any crashes, boosts or wall shrinks. Clients feed frames to the same `Arena` class with `apply()`, so walls are laid by identical code on every screen. Heads are drawn interpolated between ticks so movement looks smooth.
- **Input is just turns.** Clients send `turn` and `boost` messages. The server queues up to three turns per rider (so a quick up-then-left hairpin works) and ignores U-turns.
- **The tick loop only runs when it has to.** It stops when the round ends or nobody is connected, so the object can hibernate between rounds. A pending timer keeps a Durable Object in memory, and each incoming WebSocket message resets its 30-second CPU budget. During a round the client sends a JSON heartbeat every 5 seconds; the plain `ping`/`pong` keepalive doesn't count, because the auto-response answers it without waking the room.
- **The arena lives in memory only**, since it changes every tick. If the room restarts mid-round, the round is replayed from a fresh grid. Everything else (scores, settings, phase) is in storage.
- **One alarm drives the phase timers**: the 3-second countdown, the round-over pause and cleanup. A game with no connections for 12 hours is deleted.
- **CPU riders** (`src/shared/ai.ts`) look at going straight, left or right. Each option is scored by the open floor it can reach (flood fill). Hard riders also count the floor they'd reach before anyone else (Voronoi territory), which makes them cut you off. Normal and hard riders avoid cells another head could enter next tick. With 8 hard CPUs on the large arena, that costs about 6 ms per tick. The home screen's demo race uses the same bots.

### Layout

```
src/shared/    code used by both sides: constants, the arena simulation, CPU steering, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object + tick loop), game.ts (rules and scoring)
src/client/    main.ts (UI + networking glue), render.ts (canvas), net.ts, audio.ts, attract.ts (home-screen demo)
test/          Vitest tests for the arena, the CPUs and the game flow
```
