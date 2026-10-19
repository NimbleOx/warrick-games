# Ricochet Alley

A multiplayer, browser-based tank battle in a maze, in the spirit of Atari *Combat* and *Tank Trouble*. Up to 8 tanks drive around a new random maze each round. Bullets bounce off the walls for about 6 seconds, and one hit kills, including your own bullet coming back round. Last tank standing scores a point. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/ricochet-alley/g/K7Q2M`. Send either one to your friends.
- The host picks the target score (first to 3, 5, 10, 15 or 20) and the maze size, and can add CPU opponents (easy, normal or hard).
- **↑/↓** drive, **←/→** turn, **Space** fires. Tapping a turn key turns just 2°, so you can line up bank shots; holding it spins up to full speed. WASD works too.
- On a touch screen there's a stick and a Fire button. Push the stick the way you want to go: the tank turns to face that way and drives once it's roughly lined up. Pull it straight back to reverse.
- You have 5 bullets. A bullet comes back to you when it hits something or runs out after 6 seconds. The HUD shows how many you have ready.
- Fire point-blank into a wall and the shot bounces straight back at you.
- When one tank is left, the round runs 2 more seconds, so a bullet still in flight can turn the win into a draw.
- Reloading the page puts you back in your seat. Anyone who joins mid-match watches the current round and plays from the next one.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/ricochet-alley -- --port 5176  # http://localhost:5176/ricochet-alley/, with the Worker and Durable Object in workerd
npm test -w games/ricochet-alley                    # simulation, AI, prediction, game-rule and room tests (Node)
npm run typecheck -w games/ricochet-alley
```

Dev-only URL options (ignored in production builds):

- `/?sandbox` plays offline against CPUs, with no server. `&cpus=hard,normal,easy` sets the opponents, `&size=small|medium|large` the maze, and **R** makes a new maze. Use it for tuning how the game feels.
- `?lag=150` adds 150 ms of round-trip delay to the socket, to try prediction locally.
- `?as=bob` makes this tab a separate player (its own token and name), so one browser can be several players.

## Deploying

`npm run deploy -w games/ricochet-alley` builds it and deploys it to **https://warrick.games/ricochet-alley/**. The root README explains how the games share warrick.games. `localStorage` keys start with `ra.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /ricochet-alley/api/games            → allocate a code, initialize that room
   │   GET  /ricochet-alley/api/games/:code      → does the game exist?
   └─WS─ /ricochet-alley/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your tank back. Other players never see tokens.
- **A 30 Hz loop, only during a round.** While a round is live and someone is connected, the room steps the shared simulation on the kit's tick loop and broadcasts a small frame every tick. If it falls behind, it catches up a few ticks at most, then skips ahead. Between rounds the loop stops. The countdown, the round-over pause and cleanup run off the Durable Object alarm, so an idle game can hibernate. A game with no connections for 12 hours is deleted.
- **State is saved at round boundaries, not every tick.** The round itself (tank positions, bullets) lives only in memory. Deploying restarts every Durable Object and drops every socket. Clients reconnect on their own, and the interrupted round starts again from its saved starting positions with a fresh countdown.
- **Clients send only input changes:** the four held keys as a bitmask, with a sequence number, plus fire presses.
- **Frames are compact.** Each frame carries every tank's position and heading. For human players it also carries the last input change the server applied, and for how many ticks. Bullets aren't in frames. The server announces each new bullet once, with its exact position and velocity, and says when one hits a tank. Every client flies bullets itself with the same code. A bullet's flight uses only `+ − × ÷` (and tank headings come from a table built the same way), so the result is bit-identical on the server and in every browser.
- **Your own tank is predicted.** Every input change is applied locally right away, along with the local tick it started on. When a frame says "input #n, applied for k ticks", the client starts from the server's position and replays its inputs since then. Small corrections are blended out over about 100 ms. Other tanks are drawn about 100 ms in the past, between two frames. Bullets are drawn at the client's best guess of the server's current tick, so you dodge where they really are. The server decides every hit.
- **CPU players** produce the same input bits a human does. They route toward the nearest enemy over the maze grid (BFS). They fire when a ray with up to 2 bounces (by difficulty) would hit someone before it hits them, and harder ones scan nearby headings for bank shots and back away from incoming bullets.
- **The canvas draws only what shows.** The floor, walls and scorch marks are painted once per maze onto a layer of their own. Under the game over, the maze keeps its last frame once the explosions have settled. The home screen's demo draws on a canvas the size of the window, with the maze scaled to fill it and centred, so a phone held upright doesn't draw the parts it would crop.

### Layout

```
src/shared/    code used by both sides: constants, heading table, maze, geometry, the simulation, CPU AI, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: input messages, the tick loop, picking a stalled round
               back up), game.ts (match rules)
src/client/    main.ts (the game screen and its hooks into the shell), round.ts (one networked round), predict.ts
               (prediction, interpolation, client-side bullets), input.ts (keyboard + touch), render.ts (canvas),
               local.ts (offline matches: home-screen demo and sandbox), audio.ts (sounds), themes.ts
test/          Vitest tests for the maze, the simulation, the AI, prediction and the game flow
```

The room, lobby rules, router, socket (with the `?lag=` dev aid, and the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).

### Adding power-ups or teams later

- **Power-ups:** weapons would be new kinds of shot in `World.step()` (`sim.ts`), each with its own frame event. The bullet code already handles any number of bounces per tick, and the client flies anything it's told about exactly.
- **Teams:** add a team field to players and a "last team standing" check where `Game.tick()` decides the round.
