# Box Office

A multiplayer, browser-based take on *Dots and Boxes*. The board is a grid of dots. On your turn you draw one line between two neighbouring dots, and if that line closes a box, the box is yours and you go again. When every box is claimed, whoever holds the most wins. Up to 8 players, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/box-office/g/K7Q2M`. Send either one to your friends.
- The host picks the board (small, medium or large), the turn timer (off, 10, 20 or 30 seconds) and whether hints are on, and can add CPU players (easy, normal or hard). The board grows with the number of players, CPUs included, and the lobby shows the size you'll get: from 4 × 4 boxes for two players on small to 11 × 8 for eight on large.
- On your turn, hover over or touch a line between two dots to highlight it, and click or tap to draw it. When the boxes are small on a touch screen, the first tap shows the line and a second tap on it draws it; tapping elsewhere moves or clears it.
- Draw the fourth side of a box and it's yours, and you go again. A line between two boxes can close both. Most boxes when the board is full wins; ties share the win.
- With more than two players, the chain you open goes to whoever sits after you, so it matters who that is.
- With hints on, the boxes you can close pulse on your turn, and **Take all** (or T) takes every one of them at once. To decline the last boxes of a chain (a double-cross), take them one at a time. With hints off you spot them yourself. The HUD shows which it is all game.
- The clock restarts after every line. When it runs out, the game finishes your turn for you: it takes every box you can close, then draws a line that gives nobody a box, or the one that gives away the fewest.
- Reloading the page puts you back in your seat, with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, the game plays their turn after 5 seconds. Leaving mid-game keeps your seat and your boxes, and the game plays your turns. Anyone who joins mid-game watches until the next game.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/box-office -- --port 5184  # http://localhost:5184/box-office/, with the Worker and Durable Object in workerd
npm test -w games/box-office                    # board, chain, endgame, CPU, game-flow and room tests (Node)
npm run typecheck -w games/box-office
```

## Deploying

`npm run deploy -w games/box-office` builds it and deploys it to **https://warrick.games/box-office/**. The root README explains how the games share warrick.games. `localStorage` keys start with `bo.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /box-office/api/games            → allocate a code, initialize that room
   │   GET  /box-office/api/games/:code      → does the game exist?
   └─WS─ /box-office/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between moves. The board is part of the state, saved after every line, so a deploy mid-game picks up where it was.
- **The whole board goes out in every state**: who drew each line, who claimed each box, and `order`, every line in the order it was drawn. The biggest board, 11 × 8, is a few hundred bytes. The client draws the lines it hasn't seen yet one at a time, faster the longer the run, and snaps straight to the board after a reconnect or in a background tab.
- **One alarm drives every timer:** the turn clock, the 5-second wait for a missing player, and a CPU's thinking time (0.8 seconds before its first line, 0.25 seconds a line through a capture run). The turn clock is the kit's (`@warrick/kit/worker/turns`). Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **The rules are pure functions** in `src/shared/`: the board's geometry and drawing a line (`board.ts`), the chain analysis (`chains.ts`: safe lines, chains and loops, what a line gives away) and the endgame model (`endgame.ts`). The server, the CPUs, the move made for a player out of time and the client's hints all use them.
- **CPU players** (`src/shared/ai.ts`): easy takes boxes and otherwise draws at random, and normal never gives a box away while a safe line is left. Hard plays the chain endgame: in the last 10 safe lines it searches every order they can be drawn in, and it solves the endgame (every player taking the most boxes for themselves) to decide when to decline a chain. Its slowest decision, 8 players on the large board, takes about 120 ms.
- **Hints are a game setting**, the same for everyone in the game. Every cue that a box can be closed goes through one check in the client, and the server refuses Take all when hints are off.
- **The board is one canvas.** On a phone in portrait, a board wider than tall is drawn on its side, so its long side runs down the screen.

### Layout

```
src/shared/    code used by both sides
  board.ts       board sizes, edge and box geometry, drawing a line, box counts
  chains.ts      safe lines, capturable boxes, chains and loops, giveaways
  endgame.ts     the endgame model over chains and loops, for the hard CPU
  ai.ts          CPU players and the move made for a player who ran out of time
  protocol.ts    settings, game state and message types, standings
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the alarm), game.ts (seats, lines, turns, timers)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (the board on a canvas),
               audio.ts (sounds), attract.ts (the home screen's self-playing demo)
test/          Vitest tests for the board, the chain analysis and endgame, the CPUs and the game flow, and room.test.ts,
               which runs the real room (reloads, second tabs, deploys) through the kit's test harness
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
