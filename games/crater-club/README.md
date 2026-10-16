# Crater Club

A multiplayer, browser-based take on *Scorched Earth*. Turn-based artillery on destructible terrain, for up to 8 tanks. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/crater-club/g/K7Q2M`. Send either one to your friends.
- The host picks the rounds, starting cash, wind, wall behavior and turn timer, and can add CPU opponents (easy, normal or hard).
- On your turn, aim with the sliders, the arrow keys (hold Shift for bigger steps), or by dragging on the map. Press **Fire** or Space.
- Wind bends every shot. The HUD gives its strength, and wisps of air blowing across the sky show which way it blows and how hard.
- Damaged tanks can't fire at full power (the HUD shows your current max). Switch weapons with the Weapon menu or Tab. Tanks take damage when the ground under them is blown away.
- Before the first round and between rounds there's a shop with Missiles, Nukes, MIRVs, Death's Heads, Funky Bombs, Leapfrogs, Rollers, Dirt Clods, Tracers, Shields and Parachutes. You earn cash for damage, kills, surviving and winning rounds.
- Reloading the page puts you back in your seat. Anyone who joins mid-game watches until the next game.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/crater-club -- --port 5173  # http://localhost:5173/crater-club/, with the Worker and Durable Object in workerd
npm test -w games/crater-club                    # simulation, game-rule, room and renderer tests (Node)
npm run typecheck -w games/crater-club
```

## Deploying

`npm run deploy -w games/crater-club` builds it and deploys it to **https://warrick.games/crater-club/**. The root README explains how the games share warrick.games. `localStorage` keys start with `cc.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /crater-club/api/games            → allocate a code, initialize that room
   │   GET  /crater-club/api/games/:code      → does the game exist?
   └─WS─ /crater-club/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your tank back. Other players never see tokens.
- **The server is authoritative, but clients animate.** When someone fires, the room runs the whole shot to completion with the shared simulation (`src/shared/sim.ts`). It then broadcasts the shot's inputs and the resulting state. Each client replays the same deterministic simulation frame by frame for the animation, then snaps to the server's result. The server works out the launch velocity with trig once; the per-tick physics uses only `+ − × ÷ √` and a seeded integer PRNG, which give identical results in every JS engine.
- **One alarm drives all the timers.** Turn timeouts, CPU "thinking" time, the pause after each shot, the round-over banner and the shop countdown all run off the Durable Object alarm. Timers pause when nobody is connected. A game with no connections for 12 hours is deleted.
- **The turn clock is the kit's** (`@warrick/kit/worker/turns`). Reloading on your turn gives you back the clock you had, never more; with under 5 seconds left, you get 5, once a turn. Drop on your turn and it ends 8 seconds later unless you're back; a turn that comes round to someone already gone is skipped after 4. Dropping out of the shop never closes it at once, since it may only be a reload.
- **CPU players** search angle/power space with the same simulation, then add error that depends on their difficulty.

### Layout

```
src/shared/    code used by both sides: constants, weapons, terrain, the shot simulation, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the turn timer), game.ts (rules), ai.ts (CPU players)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas), wind.ts (the wisps of
               air in the sky), audio.ts (sounds), attract.ts (home-screen demo)
test/          Vitest tests: the simulation, the game flow, the real room (with the kit's test harness)
               and, in test/client, when the map gets redrawn
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
