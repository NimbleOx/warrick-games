# Shove Off

A multiplayer, browser-based take on *Abalone*. Two players face off with 14 marbles each on a hexagonal board of 61 holes. On your turn you move 1, 2 or 3 of your marbles in a line, one hole in any direction, and push the other player's marbles when you outnumber them in the line. Push six of theirs off the edge to win. Two players, or you against a CPU, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/shove-off/g/K7Q2M`. Send either one to a friend. On your own, **Play the CPU** (or the hub's Solo button) starts a game against a normal CPU straight away; add an easy or a hard CPU in the lobby instead for a different one.
- The host picks the start (the box's classic rows, or the Belgian or German daisy), the turn timer (off, 30 or 60 seconds, or 2 minutes) and the move limit (50, 100 or 150 moves each, or none). Anyone past the two seats watches.
- Who moves first goes to a coin toss, then swaps game by game. Your own marbles are always at the bottom of the board: the second player sees it turned round.
- Click (or tap) your marbles to pick 1 to 3 in a straight line; click one two along from a picked marble to take the one between too. Arrows show where they can go. Click an arrow to move, drag the marbles that way, or press <kbd>W</kbd> <kbd>E</kbd> <kbd>A</kbd> <kbd>D</kbd> <kbd>Z</kbd> <kbd>X</kbd> (the six directions around <kbd>S</kbd>). Hovering an arrow shows the move: where the marbles land, and any marble it would push off, crossed out. Esc (or Clear) drops your pick. You can pick and look while you wait for your turn.
- Along the line, your front marble pushes theirs when you have more in the line: 2 push 1, and 3 push 1 or 2. There must be an empty hole or the edge behind them. A side step (across the line) needs an empty hole for every marble and pushes nothing. You can't push your own marbles off. When a move isn't allowed, the arrow under the pointer turns red and the reason shows under the board.
- Push six of theirs off to win. At the move limit, whoever has pushed more off wins; equal is a draw.
- Running out of time passes that one turn. Reloading the page puts you back in your seat, with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, their turn passes after 10 seconds, and a player who misses 3 turns in a row while away loses. Against a CPU there's no clock, and the game waits for you however long you're gone. **Resign** or **Leave** gives the game to the other player.
- After a game, the host's **Play again** starts the next one straight away, with the other player moving first.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/shove-off -- --port 5189  # http://localhost:5189/shove-off/, with the Worker and Durable Object in workerd
npm test -w games/shove-off                    # rules, CPU, game-flow and room tests (Node)
npm run typecheck -w games/shove-off
npm run sim -w games/shove-off                 # CPU against CPU, to measure the levels (SIM_GAMES=200 for more games)
```

## Deploying

`npm run deploy -w games/shove-off` builds it and deploys it to **https://warrick.games/shove-off/**. The root README explains how the games share warrick.games. `localStorage` keys start with `so.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /shove-off/api/games            → allocate a code, initialize that room
   │   GET  /shove-off/api/games/:code      → does the game exist?
   └─WS─ /shove-off/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between moves. The board is in the state, saved after every move, so a deploy mid-game picks up where it was.
- **The rules are pure functions** in `src/shared/`: the board's geometry (`hex.ts`), moves, pushes and the starting layouts (`rules.ts`), and the CPUs (`ai.ts`). The server checks every move with the same function (`shove`) the client uses for its arrows, its previews and the reason a move isn't allowed.
- **The board is 61 holes in axial coordinates**, numbered in reading order, with a table of each hole's six neighbours. A move is the marbles and a direction (`{ marbles, dir }`); the state keeps the last move (the marbles, what it pushed, and what went off) so the client can slide it in and mark it.
- **One alarm drives every timer:** the turn clock, the 10-second wait for a missing player and a CPU's thinking time (0.9 seconds a move). The turn clock is the kit's (`@warrick/kit/worker/turns`). Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **CPU players** run on the server, with their own fast copy of the move generator (a move is one integer, the board an `Int8Array`), which the tests check against the rules move for move. They judge a board by marbles left, how near the middle their marbles are, and how many touch each other. Easy looks one move ahead with a lot of noise, and now and then plays any move at all. Normal looks two moves ahead (its move and the reply). Hard searches four moves ahead with alpha-beta, within a budget of positions, and falls back on its deepest finished search; a move usually takes it well under 200 ms, and at most about half a second. Over 100 games a pairing, Normal beat Easy every time and Hard beat Normal 91 times, with 8 draws (`npm run sim`).
- **The client draws only when something changes**: a move sliding in, the pointer over a new arrow, a new pick. Marbles are drawn once per colour and size and copied in. The home screen's demo is two CPUs playing on a board behind the card, drawn only while a move slides in.

### Layout

```
src/shared/    code used by both sides
  hex.ts         the 61 holes, their neighbours, names (A1–I9) and where each is drawn
  rules.ts       starting layouts, moves and pushes (and why a move isn't allowed), move lists
  ai.ts          CPU players
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the alarm), game.ts (seats, turns, pushes off, endings)
src/client/    main.ts (the game screen, picking and moving, the scoreboard, results, and its hooks into the shell), view.ts (the board on a canvas),
               audio.ts (sounds), attract.ts (the home screen's demo)
test/          Vitest tests for the rules, the CPUs and the game flow, and room.test.ts, which runs the real room
               (reloads, deploys, the CPU) through the kit's test harness; sim.ts and strength.sim.ts play CPU-only games
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
