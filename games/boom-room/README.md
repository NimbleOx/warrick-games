# Boom Room

A multiplayer, browser-based take on *Bomberman*'s battle mode. Real-time bombing in a walled arena, for up to 8 bombers. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It's a sibling of [Crater Club](../crater-club) and is built the same way: a Cloudflare Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/boom-room/g/K7Q2M`. Send either one to your friends.
- The host picks how many round wins take the game, when the walls start closing in, how many crates and power-ups there are, and whether skulls are in play. The host can also add CPU bombers (easy, normal or hard).
- Move with the arrow keys or WASD; drop a bomb with Space or X. Gamepads work too, and phones get an on-screen D-pad and bomb button.
- Blow up crates to find power-ups: **+1 Bomb**, **+1 Fire**, **Speed**, **Kick** (walk into a bomb to send it sliding) and the rare **Max Fire**. **Skulls** curse you for a while (slow, zoomies, backwards controls, no bombs, leaky bombs, short fuses, weak fire), and the curse jumps to whoever you bump into.
- Bombs set each other off. You can walk off a bomb you're standing on, but not back onto one.
- Last bomber standing wins the round. When the timer runs out it's **Hurry up!**: blocks drop in a spiral from the edges inward and squash anyone underneath.
- Reloading the page puts you back in your seat. Anyone who joins mid-game watches until the next game, and players who've left sit out later rounds.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/boom-room -- --port 5177  # http://localhost:5177/boom-room/, with the Worker and Durable Object in workerd
npm test -w games/boom-room                    # arena, CPU and game-rule tests (Node)
npm run typecheck -w games/boom-room
```

To try two players on one machine, open the second at `http://p2.localhost:5177/boom-room/`: it's a different origin, so it gets its own player.

## Deploying

`npm run deploy -w games/boom-room` builds it and deploys it to **https://warrick.games/boom-room/**. The root README explains how the games share warrick.games. `localStorage` keys start with `br.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /boom-room/api/games            → allocate a code, initialize that room
   │   GET  /boom-room/api/games/:code      → does the game exist?
   └─WS─ /boom-room/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat/event log in storage. It talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **No logins.** Each browser generates a random token and keeps it in `localStorage`. The room maps tokens to player slots, which is how a reload or reconnect gets you your bomber back. Other players never see tokens.
- **A round runs on a fixed 30 Hz tick.** While a round is on, the room steps the arena (`src/shared/arena.ts`) on an interval and sends everyone a frame every tick. A frame is a delta (`ArenaDelta`): only what changed since the last one, usually who moved, about 100–150 bytes. The grid and the round's fixed fields come only when they change, and whole snapshots go out at the start of a round. Someone who joins, or a page that asks after losing track (once a second at most), gets the frame everyone else was last sent, so the next delta fits theirs too and everyone else's frames stay deltas. A page says it takes deltas (`{ t: "deltas" }`) with each new arena. While any open socket hasn't said so (a tab still running the JS from before deltas), every tick goes out whole instead, so old tabs keep working. Between rounds the interval stops, the object can hibernate, and the alarm brings on the next round. The live arena is kept only in memory; if the object restarts mid-round, the round is dealt again.
- **Your own bomber moves instantly.** The browser runs the same grid movement as the server (`src/shared/movement.ts`, including the corner nudging that makes turning forgiving) and reports where it went. The server accepts a position only if you could have walked there since your last report (walls, crates, bombs, and a movement budget that refills at your speed and banks under half a second of walking, enough for reports the network bunched up). Otherwise it keeps you where you were and bumps a counter that tells your browser to snap back. A report that could only have got there through fire puts you in the fire, as it would have if every step had been seen. Everything else (bombs, blasts, power-ups, deaths) is decided by the server.
- **Everyone else is drawn about 90 ms in the past**, blended between the two frames on either side, so they glide rather than jump.
- **CPU bombers** (`src/shared/ai.ts`) map where fire is going to be (chain reactions included), escape along routes that stay out of it, and only drop a bomb when they can see a way out. They score spots by crates, power-ups and how badly they'd trap someone. The same code runs the demo battle on the home screen.
- **The home screen's demo draws on a canvas the size of the window**, with the arena scaled to fill it and centred, so a phone held upright doesn't draw the parts it would crop.

### Layout

```
src/shared/    code used by both sides: constants, movement, the arena simulation, CPU brains, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: moves, the tick loop, the between-round timer),
               game.ts (round rules)
src/client/    main.ts (the game screen, prediction, and its hooks into the shell), render.ts (canvas), input.ts,
               audio.ts (sounds), attract.ts (home-screen demo)
test/          Vitest tests for movement, the arena, CPU matches and the game flow
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
