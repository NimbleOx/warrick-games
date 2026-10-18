# Curve Ball

A multiplayer, browser-based take on *Achtung, die Kurve!* (also known as *Curve Fever*). Everyone steers a line that never stops moving; you can only turn left or right. Lines leave a permanent trail with short gaps you can slip through. Touch any trail or the wall and you're out. Up to 8 players, each on their own device. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/curve-ball/g/K7Q2M`. Send either one to your friends.
- The host picks the target score (default 10 × (players − 1)) and the speed, and can add CPU players (easy, normal or hard).
- Steer with <kbd>←</kbd> <kbd>→</kbd> or <kbd>A</kbd> <kbd>D</kbd>. On a touch screen, hold the left or right half of the screen.
- Each round starts with a 3-second countdown showing where everyone is and which way they're heading.
- Every 1.5–3 seconds your trail leaves a short gap. Anyone can drive through it.
- Whenever someone crashes, everyone still alive gets a point. The match ends when someone has reached the target score and leads by at least 2.
- Reloading the page puts you back in your seat. Anyone who joins mid-match watches until the next one.

## Development

```bash
npm install
npm run dev        # http://localhost:5175/curve-ball/ — Vite + the Worker and Durable Object running in workerd
npm test           # simulation, CPU and game-rule tests (Node)
npm run typecheck
npm run test:live  # end-to-end protocol check against the running dev server
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime. `npm run test:live` expects the game at `http://localhost:5175/curve-ball`; set `CURVE_BALL_URL` if it's elsewhere.

Add `?predict=0` to a game URL to turn off client-side prediction of your own line, to compare.

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `curve-ball` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets.

It's served at **https://warrick.games/curve-ball/**, one path on a site shared with the other games. The hub page at the root is a separate Worker in `../../hub`, with `warrick.games` as a Custom Domain. This Worker has the zone route `warrick.games/curve-ball*` in `wrangler.jsonc`, and routes take precedence over a Custom Domain. The `workers.dev` address is turned off (`workers_dev: false`), so invite links always point at warrick.games.

Everything lives under the base path `/curve-ball/`. `vite.config.ts` is the kit's `gameConfig("curve-ball")`: it sets Vite's `base`, and the client builds its URLs from `import.meta.env.BASE_URL`. The Worker's API is at `/curve-ball/api/...`, and `run_worker_first` matches that. Workers static assets are looked up by request path and ignore Vite's `base`, so `gameConfig` also moves the client build into `dist/client/curve-ball/`. `index.html` stays at the root of `dist/client`, because the single-page-application fallback always serves `/index.html`.

If you change bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /curve-ball/api/games            → allocate a code, initialize that room
   │   GET  /curve-ball/api/games/:code      → does the game exist?
   └─WS─ /curve-ball/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage, and talks to browsers over hibernatable WebSockets.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your seat back.
- **The server runs the round.** During a round the room steps the shared simulation (`src/shared/sim.ts`) 30 times a second with a self-correcting `setTimeout` loop, and broadcasts one small frame per tick. Between rounds the loop stops and the countdown and round-over pause run off the Durable Object alarm, so idle games can hibernate. A round with nobody connected pauses, and resumes with a countdown when someone comes back. Once only CPUs are left in a round, it plays at double speed.
- **Clients send only steering changes** (`{t: "steer", s: -1 | 0 | 1}`). Each frame carries the tick number, the steering changes applied on that tick, any crashes, and every 30 ticks a checksum of all heads; a quiet frame is about 20 bytes.
- **Rounds are deterministic.** Headings come from a table built with only `+ − × ÷` (no `Math.sin`, which can differ in the last bit between JS engines), and gaps come from a seeded integer PRNG. So a round is a pure function of its seed and its steering log. Joining, reconnecting or resyncing sends that seed and log, and the client replays the round in a few milliseconds. A client that misses a frame or fails a checksum asks for a fresh snapshot. The room sends each socket at most one a second, and the client asks again while it waits.
- **Collisions** use an occupancy bitmap with one cell per pixel. Heads move in four sub-steps per tick; all heads are tested before any paint, so player order never decides who dies, and two heads that touch both die. A head ignores only the cells it painted in the last few sub-steps.
- **Smooth playback and prediction.** Clients play frames back about 1.5 ticks behind the newest one, interpolating heads between ticks, and speed up when they fall behind. Your own line is drawn ahead of the server by your measured input lag, so it responds the moment you press a key.
- **Scores are saved between rounds.** The live round (bitmap, steering log, this round's points) only lives in memory. Deploying restarts every Durable Object, so a round in progress restarts from its countdown and nobody gains or loses points.
- **CPU players** cast a few paths ahead (straight, and turning left or right by different amounts), head for whichever runs longest, and avoid pockets too tight to turn around in. Harder CPUs look further ahead and react faster. The home screen's backdrop is a few of them playing a round of their own.

### Layout

```
src/shared/    code used by both sides: constants, heading table, the round simulation, CPU steering, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: steering, resyncs, the tick loop and the timers), game.ts (rules)
src/client/    main.ts (the game screen, playback and its hooks into the shell), render.ts (canvas), input.ts,
               audio.ts (sounds), attract.ts (home-screen demo)
test/          Vitest tests for the simulation, the CPUs and the game flow; test/live checks a running server
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).

### Adding power-ups later

Each head already carries its own `speed`, `turn` and `radius` (copied from the round config at spawn), and the collision grace window is computed from them, so speed-ups, slow-downs and fat or thin lines only need to change those fields from within `Round.step`. Spawning power-ups should use the round's seeded generator so clients' replays stay in step.
