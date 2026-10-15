# Boom Room

A multiplayer, browser-based take on *Bomberman*'s battle mode. Real-time bombing in a walled arena, for up to 8 bombers. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It's a sibling of [Crater Club](../crater-club) and is built the same way: a Cloudflare Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://…/g/K7Q2M`. Send either one to your friends.
- The host picks how many round wins take the game, when the walls start closing in, how many crates and power-ups there are, and whether skulls are in play. The host can also add CPU bombers (easy, normal or hard).
- Move with the arrow keys or WASD; drop a bomb with Space or X. Gamepads work too, and phones get an on-screen D-pad and bomb button.
- Blow up crates to find power-ups: **+1 Bomb**, **+1 Fire**, **Speed**, **Kick** (walk into a bomb to send it sliding) and the rare **Max Fire**. **Skulls** curse you for a while (slow, zoomies, backwards controls, no bombs, leaky bombs, short fuses, weak fire), and the curse jumps to whoever you bump into.
- Bombs set each other off. You can walk off a bomb you're standing on, but not back onto one.
- Last bomber standing wins the round. When the timer runs out it's **Hurry up!**: blocks drop in a spiral from the edges inward and squash anyone underneath.
- Reloading the page puts you back in your seat. Anyone who joins mid-game watches until the next game, and players who've left sit out later rounds.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 — Vite + the Worker and Durable Object running in workerd
npm test           # arena, CPU and game-rule tests (Node)
npm run typecheck
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime. To try two players on one machine, open the second one at `http://p2.localhost:5173`; it's a different origin, so it gets its own player identity.

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `boom-room` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets.

It's set up to be served at **https://boom-room.warrick.games**, a Worker Custom Domain in `wrangler.jsonc` (`routes` with `custom_domain: true`). Cloudflare creates the DNS record and certificate on deploy, provided the zone is in the same account. The `workers.dev` address is turned off (`workers_dev: false`), so invite links always point at the custom domain. To host it somewhere else, change the `pattern`. To get the `workers.dev` URL back, set `workers_dev` to `true`.

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
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your bomber back. Other players never see tokens.
- **A round runs on a fixed 30 Hz tick.** While a round is on, the room steps the arena (`src/shared/arena.ts`) on an interval and broadcasts the whole arena to everyone every tick (about 1 KB). Between rounds the interval stops, the object can hibernate, and the alarm brings on the next round. The live arena is kept only in memory; if the object restarts mid-round, the round is dealt again.
- **Your own bomber moves instantly.** The browser runs the same grid movement as the server (`src/shared/movement.ts`, including the corner nudging that makes turning forgiving) and reports where it went. The server accepts a position only if you could have walked there since your last report (movement budget, walls, crates, bombs). Otherwise it keeps you where you were and bumps a counter that tells your browser to snap back. Everything else (bombs, blasts, power-ups, deaths) is decided by the server.
- **Everyone else is drawn about 90 ms in the past**, blended between the two frames on either side, so they glide rather than jump.
- **CPU bombers** (`src/shared/ai.ts`) map where fire is going to be (chain reactions included), escape along routes that stay out of it, and only drop a bomb when they can see a way out. They score spots by crates, power-ups and how badly they'd trap someone. The same code runs the demo battle on the home screen.

### Layout

```
src/shared/    code used by both sides: constants, movement, the arena simulation, CPU brains, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object + tick loop), game.ts (lobby and round rules)
src/client/    main.ts (UI, networking, prediction), render.ts (canvas), input.ts, net.ts, audio.ts, attract.ts (home-screen demo)
test/          Vitest tests for movement, the arena, CPU matches and the game flow
```
