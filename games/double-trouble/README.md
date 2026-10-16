# Double Trouble

A multiplayer, browser-based 2048 battle for up to 8 players. Everyone plays their own board at the same time, and every merge charges up rocks to drop on someone else. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object that checks every move and routes the rocks.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/double-trouble/g/K7Q2M`. Send either one to your friends.
- The host picks how to win (last one standing, or first to make a 256, 512 or 1024 tile, default 512), the board (4 × 4 like the original, or 5 × 5), and who rocks go to (a random opponent, whoever's in the lead, or whoever's closest to full). The host can also add CPU players (easy, normal or hard).
- Slide with the arrow keys or WASD, or swipe (or drag) on your board. Tiles merge as in 2048. Everyone gets the same 2s and 4s in the same order; where they appear depends on your board.
- **Power.** Each merge charges the meter right of your board: a merge into 2^k is worth k − 1 (a 4 is worth 1, a 512 is worth 8). A move with several merges is worth (merges + 1) / 2 times as much. Every 8 power sends one rock to an opponent.
- **Rocks.** A rock slides like a tile but never merges. A merge right next to it smashes it. Rocks coming at you show on the left of your board: orange while they're on their way, red when they'll land on your next move. They land on your third move after they show up, at most 3 per move, in random empty cells. Power you make in the meantime smashes them before they land.
- Sitting still doesn't help: if rocks are waiting and you haven't moved for 4 seconds, they drop in anyway. If there's no room for them, you're buried and out.
- After two minutes, rocks sent are multiplied (×1.5, then up by half every 30 seconds, up to ×4) so rounds come to an end. The HUD shows the multiplier.
- Run out of moves and you're out. Whoever makes the goal tile first wins; otherwise the last one standing does. Knocking someone out (your rocks were the last to land on them) counts as a KO.
- **Solo.** On your own in the lobby, the start button says **Play solo**: plain 2048, with no rocks either way (nobody to send them to). Making a 2048 tile wins, and you keep going until you run out of moves. The HUD shows the goal, your best tile, your score and your moves; the end screen shows your best tile, score, moves and time, with your best score on that board size (kept in this browser). The "win by" and "rocks go to" settings don't apply. Add a CPU or invite a friend and it's a match again.
- Reloading the page puts you back in your seat. Players who arrive mid-round watch until the next one.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/double-trouble -- --port 5182  # http://localhost:5182/double-trouble/, with the Worker and Durable Object in workerd
npm test -w games/double-trouble                    # engine, rocks, replay, CPU and game-flow tests (Node)
npm run typecheck -w games/double-trouble
```

## Deploying

`npm run deploy -w games/double-trouble` builds it and deploys it to **https://warrick.games/double-trouble/**. The root README explains how the games share warrick.games. `localStorage` keys start with `dt.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /double-trouble/api/games            → allocate a code, initialize that room
   │   GET  /double-trouble/api/games/:code      → does the game exist?
   └─WS─ /double-trouble/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **Your board runs in your browser.** A key or swipe moves the tiles at once. The browser then sends the move, `{k, d, g, ck}`: how many moves came before it, the direction, the newest rock id it has seen, and a checksum of its board afterwards.
- **The server replays every move.** `Lane` in `src/shared/engine.ts` is the one model of a player's game (board, random streams, power, incoming rocks), and both sides run it. The server replays each move into its copy and compares checksums.
- **Rock timing is deterministic.** A move marks rocks up to its `g` as seen, and they land on the third move after that. Only seen rocks can be smashed by a move's power. So the browser and server always agree on what landed, whatever the latency. The checksum covers only rocks the browser had seen. The browser's word only goes so far, though: rocks sent more than 1.5 seconds before a move arrives count as seen anyway (and the server overrules that move), so a modified client can't keep rocks off its board by never reporting them.
- **The multiplier and idle drops are the server's alone.** Smashing incoming rocks uses the plain power inside `Lane`, and the server scales up only the rocks that go out. Rocks dropped on a player who's sat still are a server action (`Lane.drop()`) followed by a correction.
- **The server can overrule.** If a move doesn't check out, moves come faster than anyone could make them (more than 20 at once, or 15 a second for long), or rocks were dropped on an idle player, the server bumps that board's epoch and sends the player their real board. Moves from an older epoch are ignored.
- **Everyone else's boards** arrive as one op per move: the board as one character per cell, plus score, power and rocks waiting.
- **The Durable Object** holds the lobby, tokens and chat in storage and the round in memory. While a round is on and someone is connected, a 50 ms loop moves the CPUs and drops rocks on idle players. It stops between rounds so the object can hibernate. A deploy restarts every Durable Object: the first player to reconnect finds the round gone, and it starts over.
- **CPU players** score boards the usual 2048 way (empty cells, pairs ready to merge, big tiles in order along an edge), with rocks counted as filled cells that break up pairs. Easy looks one move ahead and often slips. Normal looks one move ahead. Hard also averages over where the next tile might land. They move about 1, 2 and 3 times a second.

### Layout

```
src/shared/    code used by both sides
  engine.ts      Board (slide, merge, encode), Lane (one player's game: moves, power, rocks, spawns)
  ai.ts          CPU players
  constants.ts   rock cost and timing, tick rate, countdown
  protocol.ts    settings, the rock multiplier, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: move messages, the tick loop), game.ts (match rules),
               round.ts (one round: checking moves, routing rocks, KOs, the goal, CPUs, idle players)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas: boards, tiles,
               rocks, meters, animations), input.ts (keys and swipes), audio.ts (sounds), attract.ts (home-screen demo)
test/          Vitest tests: sliding, rocks, power, rock timing, replay, CPUs, game flow
```

The room, lobby rules, router, socket (with the heartbeat that keeps a round's room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).

## Tuning

The numbers in `src/shared/constants.ts` (rock cost 8, rocks land on the third move, at most 3 per move, 4-second idle drop) and the two-minute margin in `protocol.ts` came from simulated CPU rounds:

- Rounds between two normal CPUs on 4 × 4, last one standing, last about 2 minutes (most end between 1:30 and 2:30), and the winner's biggest tile is usually a 256.
- Two hard CPUs make a 512 about half the time before someone is knocked out.
- A 1024 almost never gets made under fire, so "First to 1024" plays like last one standing for most groups.
- Rounds on 5 × 5 run about 40 seconds longer.

How fast you move matters as much as how well: power comes from merges, and merges come from moves.
