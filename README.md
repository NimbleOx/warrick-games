# Crater Club

A multiplayer, browser-based take on *Scorched Earth*. Turn-based artillery on destructible terrain, for up to 8 tanks. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://…/g/K7Q2M`. Send either one to your friends.
- The host picks the rounds, starting cash, wind, wall behavior and turn timer, and can add CPU opponents (easy, normal or hard).
- On your turn, aim with the sliders, the arrow keys (hold Shift for bigger steps), or by dragging on the map. Press **Fire** or Space.
- Damaged tanks can't fire at full power. Tanks take damage when the ground under them is blown away.
- Between rounds there's a shop with Missiles, Nukes, MIRVs, Death's Heads, Funky Bombs, Leapfrogs, Rollers, Dirt Clods, Tracers, Shields and Parachutes. You earn cash for damage, kills, surviving and winning rounds.
- Reloading the page puts you back in your seat. Anyone who joins mid-game watches until the next game.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 — Vite + the Worker and Durable Object running in workerd
npm test           # simulation and game-rule tests (Node)
npm run typecheck
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime.

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `crater-club` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets. It will be served at `crater-club.<your-subdomain>.workers.dev`. To use your own domain, add a custom domain to the Worker in the dashboard or add a `routes` entry to `wrangler.jsonc`.

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
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your tank back. Other players never see tokens.
- **The server is authoritative, but clients animate.** When someone fires, the room runs the whole shot to completion with the shared simulation (`src/shared/sim.ts`). It then broadcasts the shot's inputs and the resulting state. Each client replays the same deterministic simulation frame by frame for the animation, then snaps to the server's result. The server works out the launch velocity with trig once; the per-tick physics uses only `+ − × ÷ √` and a seeded integer PRNG, which give identical results in every JS engine.
- **One alarm drives all the timers.** Turn timeouts, CPU "thinking" time, the pause after each shot, the round-over banner and the shop countdown all run off the Durable Object alarm. Timers pause when nobody is connected. A game with no connections for 12 hours is deleted.
- **CPU players** search angle/power space with the same simulation, then add error that depends on their difficulty.

### Layout

```
src/shared/    code used by both sides: constants, weapons, terrain, the shot simulation, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object), game.ts (rules), ai.ts (CPU players)
src/client/    main.ts (UI + networking glue), render.ts (canvas), net.ts, audio.ts, attract.ts (home-screen demo)
test/          Vitest tests for the simulation and the game flow
```
