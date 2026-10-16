# Curve Ball

A browser multiplayer take on *Achtung, die Kurve* (also known as *Curve Fever*). Every player steers a line that is always moving forward; you can only turn left or right. Lines leave a permanent trail with short random gaps you can slip through. Touch any trail or the edge of the arena and you're out.

## Rules for v1

- 2–8 players online, each on their own device. Steer with ←/→ or A/D; on touch screens, hold the left or right half of the screen.
- A round: everyone spawns at a random spot and heading, a 3-second countdown, then go. Constant speed and turn rate.
- Trails have a gap every 1.5–3 seconds (random), a few pixels long. Gaps can be driven through.
- Scoring follows the original: whenever someone dies, every player still alive gets 1 point. The match ends when someone reaches the target (host picks it; default 10 × (players − 1)) with a 2-point lead.
- CPU players: cast a few rays ahead (left / straight / right) and steer toward the most open direction.
- Not in v1: power-ups (speed up, slow others, fat/thin lines, wrap-around walls, clear the board). Design so they can be added.

## Design notes

- Collision: keep trails in an occupancy bitmap of the arena. Each tick, test the pixels just ahead of each head, ignoring the player's own most recent pixels.
- Trails are a pure function of inputs and tick numbers, so the network traffic can stay tiny: clients send steering changes, the server broadcasts head positions (or input changes) per tick, plus a full snapshot on join or reconnect.

## How it's built

Built on `@warrick/kit` (`../../packages/kit`), like every game here; its README lists what each import gives you. Reach for the kit before copying code from another game, and don't edit the kit or other games from a Curve Ball session. Turf War (`../turf-war`) is the nearest real-time sibling.

- Cloudflare Worker + Vite, TypeScript, no client framework, canvas rendering. `vite.config.ts` is the kit's `gameConfig("curve-ball")`, and `src/worker/index.ts` is `gameWorker("curve-ball")` (routes and room codes).
- `src/worker/room.ts`: `GameRoom` extends the kit's `Room`, which owns the sockets, tokens, storage, alarm, cleanup and tick loop. It adds the tick (`tickMs`, `wantsLoop`), the round timers (`timerAt`), the round snapshot in the welcome, and the `steer` and `resync` messages.
- `src/worker/game.ts`: `Game` extends the kit's `Lobby` (joining, host, CPUs, colours, settings, kick, chat) with the rounds, steering, scoring and timers.
- `src/client/main.ts` creates the kit's `Shell` (home, lobby, chat and the reconnecting socket) and adds the game screen. `localStorage` keys use the prefix `cb`. Dev port 5175 (`../../.claude/launch.json`); `?lag=150` adds latency and `?predict=0` turns off prediction.

### Real-time

- During a round the kit's tick loop steps the simulation every `TICK_MS` (30 Hz), with `setTimeout`s scheduled from the loop's start so it doesn't drift. It runs only while `wantsLoop` says "playing" and someone is connected, so idle games hibernate. The countdown and the pause between rounds run off the alarm (`timerAt` / `onTimer`).
- Clients send only steering changes. The server broadcasts one small frame per tick; clients play them back slightly behind and predict their own head.
- The simulation in `src/shared/sim.ts` is pure and deterministic, so Vitest can test it and clients can run it. A round is its seed plus its steering log; `Round.replay` rebuilds it (the client passes `onStep` to draw trails as it goes). Keep it free of `Math.sin` and other engine-dependent maths.
- A client that misses a frame or fails a checksum asks for a `resync`. The room answers each socket at most once per `RESYNC_EVERY_MS`, since a snapshot carries the whole input log; the client asks again while it's still waiting.
- Room state is saved at round boundaries, not every tick. The live round is memory only.

## Lessons from Crater Club

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys.
- Make every limit visible. If something stops a player from acting, the UI must say why.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Live at `https://warrick.games/curve-ball/`, with a card on the hub (`../../hub/public/`). Like the other games: a zone route `warrick.games/curve-ball*` in `wrangler.jsonc`, `workers_dev: false`, `preview_urls: false`, `run_worker_first: ["/curve-ball/api/*"]`. The kit's `gameConfig` sets Vite's base path and nests the client build under `dist/client/curve-ball/`. Build every client URL from `import.meta.env.BASE_URL`. Check a build with `npm run build && npx vite preview` before deploying.

Ask before deploying, committing or pushing.
