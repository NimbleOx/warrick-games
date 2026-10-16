# Stack Attack

A multiplayer, browser-based falling-block battle game in the style of *Tetris 99* and *Puyo Puyo Tetris*'s versus mode, for up to 8 players. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object that checks every piece and routes the garbage.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/stack-attack/g/K7Q2M`. Send either one to your friends.
- The host picks the speed (relaxed, normal or frantic: how fast pieces fall at the start and how quickly that picks up) and who garbage goes to (a random opponent, whoever's doing best, or whoever's closest to topping out), and can add CPU players (easy, normal or hard).
- Everyone gets the same pieces in the same order, from shuffled bags of all seven.
- Clear lines to send garbage: doubles send 1, triples 2, quads 4, T-spin singles, doubles and triples 2, 4 and 6. Back-to-back quads and T-spins add 1, combos add up to 5 more, and a perfect clear adds 10.
- Garbage coming at you shows as a bar beside your board: orange while it's arriving, red once it's armed. Clear lines and you cancel it first; lock a piece without clearing and the red part rises in from the bottom, each attack with one gap to dig through. Every attack gives you at least one piece's warning.
- Pieces fall faster as the round goes on, and after a while (90 seconds at normal speed) garbage gets multiplied: ×1.5, then up by half every 30 seconds, so rounds don't drag on. The HUD shows the multiplier. Top out and you're out. Last one standing wins the round.
- Keys: `←` `→` move, `↓` soft drop, `Space` hard drop, `↑`/`X` turn right, `Z`/`Ctrl` turn left, `C`/`Shift` hold. Touch screens get on-screen buttons. **Controls** sets the auto-shift delay and speed and the soft drop speed.
- Reloading the page puts you back in your seat. If you lose your connection, an autopilot keeps your board going until you're back. Players who arrive mid-round watch until the next one.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/stack-attack -- --port 5180  # http://localhost:5180/stack-attack/, with the Worker and Durable Object in workerd
npm test -w games/stack-attack                    # engine, T-spin, garbage, CPU and game-flow tests (Node)
npm run typecheck -w games/stack-attack
```

## Deploying

`npm run deploy -w games/stack-attack` builds it and deploys it to **https://warrick.games/stack-attack/**. The root README explains how the games share warrick.games. `localStorage` keys start with `sa.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /stack-attack/api/games            → allocate a code, initialize that room
   │   GET  /stack-attack/api/games/:code      → does the game exist?
   └─WS─ /stack-attack/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **Your board runs in your browser.** Moving, turning, gravity, lock delay and hold all happen locally, so the controls never wait on the network. When a piece locks, the browser sends where it went: `{piece, rotation, x, y, held?, spin}`, plus the newest garbage it has seen and a checksum of its board afterwards.
- **The server replays every lock.** `Lane` in `src/shared/engine.ts` is the one model of a player's game (board, bag, hold, combo, back-to-back, incoming garbage), and both sides run it. The server checks the piece is the right one, that it could really get there from its spawn (a search over every shift, drop and wall-kicked turn, which also confirms T-spins), replays it, and compares checksums.
- **Garbage timing is deterministic.** Each lock says the newest garbage id the browser had seen. A clear cancels only garbage up to that id; a lock that clears nothing lets in only garbage up to the *previous* lock's id. So the browser and server always agree on what rose in, whatever the latency. The browser's word only goes so far, though: garbage sent more than 2 seconds before a lock arrives counts as seen anyway (and the server overrules that lock), so a modified client can't keep garbage out by never reporting it.
- **The garbage multiplier is the server's alone.** Cancelling uses the plain attack inside `Lane`; the server scales up only what goes out, so time never enters the shared model.
- **The server can overrule.** If a lock doesn't check out, pieces lock faster than anyone could (more than 20 at once, or 10 a second for long), a tab stops (a piece hangs far too long), or the autopilot moves for someone who's dropped, the server bumps that board's epoch and sends the player their real board. Locks from an older epoch are ignored.
- **Everyone else's boards** arrive as one op per lock: the board run as one digit per cell, from the floor up to the highest block. Opponents don't see your falling piece, only where it lands.
- **The Durable Object** holds the lobby, tokens and chat in storage and the round in memory. While a round is on and someone is connected, a 50 ms loop moves the CPUs and the autopilot and checks for hanging pieces; it stops between rounds so the object can hibernate. A deploy restarts every Durable Object; the first player to reconnect finds the round gone, and it starts over.
- **CPU players** search every reachable resting spot for the piece in play (and the held one), so they can tuck and T-spin. They score the board for height, holes and bumpiness, and stronger ones hold out for clears that send garbage, keeping a well for quads.

### Layout

```
src/shared/    code used by both sides
  pieces.ts      the seven pieces, rotation states, wall kicks, the 7-bag
  engine.ts      Board, Lane (one player's game: lock, clear, attack, garbage), T-spins, the reachability search
  ai.ts          CPU players and the disconnected-player autopilot
  protocol.ts    settings, gravity curve, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: lock messages, the tick loop), game.ts (match rules),
               round.ts (one round: checking locks, routing garbage, KOs, CPUs)
src/client/    main.ts (the game screen and its hooks into the shell), pilot.ts (your piece: auto-shift,
               gravity, lock delay), render.ts (canvas), input.ts (keys + touch buttons), audio.ts (sounds),
               attract.ts (home-screen demo)
test/          Vitest tests: pieces, clears, T-spins, garbage timing, replay, CPUs, game flow
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
