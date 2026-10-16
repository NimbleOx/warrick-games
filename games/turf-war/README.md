# Turf War

A multiplayer, browser-based territory-capture game in the style of *Paper.io* and *Splix.io*, for up to 8 players. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object that runs the game in real time.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/turf-war/g/K7Q2M`. Send either one to your friends.
- The host picks the round length (1, 2, 3 or 5 minutes) and the board size (80 × 56, 100 × 70 or 130 × 90), and can add CPU players (easy, normal or hard).
- Everyone starts with a 3 × 3 patch of land. Steer with the arrow keys or WASD, or swipe on a touch screen. You move one cell every tick (10 a second) and can't turn straight back.
- Leave your land and you draw a trail. Get back onto your land and the trail, plus everything it encloses, becomes yours, including other players' land.
- If someone crosses your trail while you're out, you're gone, and they get your trail as land. You also go out if you cross your own trail, hit the edge of the board, meet someone head-on, or have all your land taken.
- You respawn 3 seconds later with a fresh home patch. Your old land is gone.
- The biggest share of the board when the clock runs out wins. The scoreboard shows everyone's share live.
- Reloading the page puts you back in your seat. Players who join mid-round drop straight in if there's a free seat, with no kills or deaths yet, even if someone else had that seat a moment ago. Otherwise they watch, and the screen says why. If you lose your connection, your head goes home and circles inside your land until you're back.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/turf-war -- --port 5178  # http://localhost:5178/turf-war/, with the Worker and Durable Object in workerd
npm test -w games/turf-war                    # board, claiming, tick rules, replay, CPU, game-flow and room tests (Node)
npm run typecheck -w games/turf-war
```

Editing worker code restarts the Durable Object, which also shows what a deploy does to a round in progress.

## Deploying

`npm run deploy -w games/turf-war` builds it and deploys it to **https://warrick.games/turf-war/**. The root README explains how the games share warrick.games. `localStorage` keys start with `tw.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /turf-war/api/games            → allocate a code, initialize that room
   │   GET  /turf-war/api/games/:code      → does the game exist?
   └─WS─ /turf-war/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the lobby and match state, each player's secret token, and the chat/event log in storage, and talks to browsers over hibernatable WebSockets.
- **No logins.** Each browser keeps a random token in `localStorage`. The room maps tokens to players, which is how a reload or reconnect gets you your seat back.
- **The server runs the game.** While a round is on and someone is connected, the room steps the simulation every 100 ms with a self-correcting `setTimeout` chain (scheduled from the loop's start, so it doesn't drift or bunch up). The loop stops when the round ends or everyone leaves, so idle games can hibernate. Round time is counted in ticks, so it pauses too.
- **Clients send only turns** (`{t: "dir", d}`), and only real changes: the client keeps a copy of the turns the server is still holding and drops repeats and reversals.
- **Every tick the server sends one frame of ops.** The server changes its board only through `Board.apply(op)` and records every op it applies. Clients run the same `apply` on their copy, so the boards can't drift apart. There are five ops: head moves, claims (as `[start, length]` runs of cells), deaths, spawns, and joins (a newcomer takes a slot, and its kills and deaths start again from zero). A typical frame is under 100 bytes. Every 50 ticks a frame carries a checksum of the board; a mismatch, or a gap in tick numbers, makes the client ask for a fresh snapshot. The server answers each connection's asks once a second at most (a snapshot is a few hundred times the size of the ask), so a client that hears nothing asks again after 1.5 s, on its next gap or bad checksum.
- **Snapshots** (the board run-length encoded, about 1–4 KB) go out at round start, in the welcome message when someone joins or reconnects, and on request (at most one a second per connection).
- **Persistence happens at round boundaries, not per tick.** The board lives only in memory. A deploy restarts every Durable Object; the first player to reconnect finds the round's board gone, and the round starts over. If that first hello is from someone new, they get a seat in the restarted round.
- **Claiming** is a flood fill. Within the player's bounding box (plus a one-cell margin), it fills from the edges in four directions without crossing the player's land or trail. Anything the fill can't reach is enclosed and becomes theirs.
- **CPU players** plan a short rectangular loop out of their land, take the shortest safe way home, and turn back early when an enemy head gets close to their trail. Normal and hard CPUs also go after trails they can reach before the owner gets home. Disconnected humans get the same code's autopilot.

### Layout

```
src/shared/    code used by both sides
  board.ts       the grid, ops and Board.apply (the only code that changes a board)
  claim.ts       the flood-fill claim
  sim.ts         Round: one tick of movement, collisions, kills, claims and respawns; client frame replay
  ai.ts          CPU players and the disconnected-player autopilot
  codec.ts       run-length encoding, cell runs, checksums
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: turns, resyncs, the tick loop), game.ts (match rules)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas), input.ts (keys + swipes),
               audio.ts (sounds), attract.ts (home-screen CPU demo)
test/          Vitest tests: claiming, tick rules, client replay, CPUs, game flow
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell, base styles and build config come from `@warrick/kit` (`../../packages/kit`).
