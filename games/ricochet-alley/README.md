# Ricochet Alley

A multiplayer, browser-based tank battle in a maze, in the spirit of Atari *Combat* and *Tank Trouble*. Up to 8 tanks drive around a new random maze each round. Bullets bounce off the walls for about 6 seconds, and one hit kills, including your own bullet coming back round. Last tank standing scores a point. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://…/g/K7Q2M`. Send either one to your friends.
- The host picks the target score (first to 3, 5, 10, 15 or 20) and the maze size, and can add CPU opponents (easy, normal or hard).
- **↑/↓** drive, **←/→** turn, **Space** fires. Tapping a turn key turns just 2°, so you can line up bank shots; holding it spins up to full speed. WASD works too.
- On a touch screen there's a stick and a Fire button. Push the stick the way you want to go: the tank turns to face that way and drives once it's roughly lined up. Pull it straight back to reverse.
- You have 5 bullets. A bullet comes back to you when it hits something or runs out after 6 seconds. The HUD shows how many you have ready.
- Fire point-blank into a wall and the shot bounces straight back at you.
- When one tank is left, the round runs 2 more seconds, so a bullet still in flight can turn the win into a draw.
- Reloading the page puts you back in your seat. Anyone who joins mid-match watches the current round and plays from the next one.

## Development

```bash
npm install
npm run dev        # http://localhost:5176 — Vite + the Worker and Durable Object running in workerd
npm test           # simulation, AI, prediction and game-rule tests (Node)
npm run typecheck
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime.

Dev-only URL options (ignored in production builds):

- `/?sandbox` plays offline against CPUs, with no server. `&cpus=hard,normal,easy` sets the opponents, `&size=small|medium|large` the maze, and **R** makes a new maze. Use it for tuning how the game feels.
- `?lag=150` adds 150 ms of round-trip delay to the socket, to try prediction locally.
- `?as=bob` makes this tab a separate player (its own token and name), so one browser can be several players.

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `ricochet-alley` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets.

It's set up to serve at **https://ricochet-alley.warrick.games**, as a Worker Custom Domain in `wrangler.jsonc` (`routes` with `custom_domain: true`). Cloudflare creates the DNS record and certificate on deploy, provided the zone is in the same account. The `workers.dev` address is turned off (`workers_dev: false`), so invite links always point at the custom domain. To host it somewhere else, change the `pattern`. To get the `workers.dev` URL back, set `workers_dev` to `true`. Before attaching a domain, check DNS against the zone's authoritative nameservers (`dig @<zone nameserver> ricochet-alley.warrick.games`) rather than the local resolver, which caches "doesn't exist" for a while.

If you change bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /api/games            → allocate a code, initialize that room
   │   GET  /api/games/:code      → does the game exist?
   └─WS─ /api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your tank back. Other players never see tokens.
- **A 30 Hz loop, only during a round.** While a round is live and someone is connected, the room steps the shared simulation on a `setInterval` and broadcasts a small frame every tick. If it falls behind, it catches up a few ticks at most, then skips ahead. Between rounds the loop stops. The countdown, the round-over pause and cleanup run off the Durable Object alarm, so an idle game can hibernate. A game with no connections for 12 hours is deleted.
- **State is saved at round boundaries, not every tick.** The round itself (tank positions, bullets) lives only in memory. Deploying restarts every Durable Object and drops every socket. Clients reconnect on their own, and the interrupted round starts again from its saved starting positions with a fresh countdown.
- **Clients send only input changes:** the four held keys as a bitmask, with a sequence number, plus fire presses.
- **Frames are compact.** Each frame carries every tank's position and heading. For human players it also carries the last input change the server applied, and for how many ticks. Bullets aren't in frames. The server announces each new bullet once, with its exact position and velocity, and says when one hits a tank. Every client flies bullets itself with the same code. A bullet's flight uses only `+ − × ÷` (and tank headings come from a table built the same way), so the result is bit-identical on the server and in every browser.
- **Your own tank is predicted.** Every input change is applied locally right away, along with the local tick it started on. When a frame says "input #n, applied for k ticks", the client starts from the server's position and replays its inputs since then. Small corrections are blended out over about 100 ms. Other tanks are drawn about 100 ms in the past, between two frames. Bullets are drawn at the client's best guess of the server's current tick, so you dodge where they really are. The server decides every hit.
- **CPU players** produce the same input bits a human does. They route toward the nearest enemy over the maze grid (BFS). They fire when a ray with up to 2 bounces (by difficulty) would hit someone before it hits them, and harder ones scan nearby headings for bank shots and back away from incoming bullets.

### Layout

```
src/shared/    code used by both sides: constants, heading table, maze, geometry, the simulation, CPU AI, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object + tick loop), game.ts (rules)
src/client/    main.ts (UI + networking glue), round.ts (one networked round), predict.ts (prediction, interpolation,
               client-side bullets), input.ts (keyboard + touch), render.ts (canvas), local.ts (offline matches:
               home-screen demo and sandbox), net.ts, audio.ts, themes.ts
test/          Vitest tests for the maze, the simulation, the AI, prediction and the game flow
```

### Adding power-ups or teams later

- **Power-ups:** weapons would be new kinds of shot in `World.step()` (`sim.ts`), each with its own frame event. The bullet code already handles any number of bounces per tick, and the client flies anything it's told about exactly.
- **Teams:** add a team field to players and a "last team standing" check where `Game.tick()` decides the round.
