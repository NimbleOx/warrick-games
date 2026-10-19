# Corner Shop

A multiplayer, browser-based take on *Blokus*. Everyone has the same 21 pieces: every shape you can make from 1 to 5 squares. Take turns placing them on a shared board. Your own pieces may only touch each other at the corners, never along an edge; other colours can touch yours however they like. Fit in as many squares as you can before the board closes up on you. Up to 4 players, or solitaire on your own, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/corner-shop/g/K7Q2M`. Send either one to your friends.
- The host picks the turn timer (off, 30, 60 or 90 seconds) and can add CPU players (easy, normal or hard). Three or four players get a 20×20 board with a corner each. Two get a 14×14 board, starting near the middle.
- Pick a piece from your tray. R, right-click or the mouse wheel rotates it (Shift+R the other way), F flips it, and Esc puts it back. A ghost shows where it would land: green where it's legal, red where it isn't, with the reason under the board. Click to place it, or move the ghost with the arrow keys and press Enter or Space. You can pick a piece up and try it while you wait for your turn.
- On a touch screen, tap a piece (the ghost jumps to the nearest spot where it fits) or drag it onto the board, drag on the board to move it, and use the Rotate, Flip and Place buttons.
- Your first piece covers your starting square. After that, every piece must touch one of yours at a corner and none of yours along an edge. The board marks your open corners, and pieces that don't fit anywhere are greyed out.
- No move left? You're passed for the rest of the game. When nobody can move, you score −1 for each square left in your tray, or +15 for placing all 21 pieces (+20 if the monomino went last). Highest score wins.
- **Solitaire.** On your own in the lobby, the start button says **Play solitaire**: just you on the 14×14 board, from its top-left corner, with no turn timer. Fit in as many pieces as you can. The end screen shows your score and your best (kept in this browser). Add a CPU or invite a friend for a game instead.
- Running out of time passes that one turn. Reloading the page puts you back in your seat, with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, their turn passes after 10 seconds, and a player who misses 3 turns in a row while away is out. **Leave** puts you out, but your pieces stay and your score counts. Anyone who joins mid-game watches until the next game.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/corner-shop -- --port 5183  # http://localhost:5183/corner-shop/, with the Worker and Durable Object in workerd
npm test -w games/corner-shop                    # rules, CPU, game-flow and room tests (Node)
npm run typecheck -w games/corner-shop
```

## Deploying

`npm run deploy -w games/corner-shop` builds it and deploys it to **https://warrick.games/corner-shop/**. The root README explains how the games share warrick.games. `localStorage` keys start with `cs.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /corner-shop/api/games            → allocate a code, initialize that room
   │   GET  /corner-shop/api/games/:code      → does the game exist?
   └─WS─ /corner-shop/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between moves. The board, every tray and the list of moves are in the state, saved after every move, so a deploy mid-game picks up where it was.
- **The rules are pure functions** in `src/shared/`: the pieces and their orientations (`pieces.ts`), placement, move generation and scoring (`rules.ts`), and the CPUs (`ai.ts`). The server checks every move with the same function the client uses for the ghost, and the client runs the move generator for the greyed-out pieces, the open corners and the home screen's demo.
- **A move is the piece, its orientation and where it goes** (`{ piece, orient, x, y }`). The 21 pieces have 91 distinct orientations, and a table from rotation and flip to orientation lets the client turn pieces without any geometry of its own.
- **Moves are found from open corners**: the empty squares diagonal to one of a player's pieces and not next to any. Whether a player is out of moves is checked when their turn comes round, and the game is over when everyone is out.
- **One alarm drives every timer:** the turn clock, the 10-second wait for a missing player and a CPU's thinking time (0.8 seconds a move). The turn clock is the kit's (`@warrick/kit/worker/turns`). Solitaire has no clock and never passes, so its alarm is only the clean-up. Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **The client redraws only what a move changed.** The player list has one row per seat for the whole game, and a move rebuilds just the mover's pieces, score and count. The home screen's demo draws its board off screen once a move; between moves it copies that in and lightens the new piece's squares while they flash, then draws nothing until the next move.
- **CPU players** run on the server. Easy plays a random legal move, favouring big pieces. Normal scores every move by the squares it places and the open corners it gains and takes away. Hard looks one move ahead from Normal's best 8, which stays well under 100 ms on a mid-game 20×20 board.

### Layout

```
src/shared/    code used by both sides
  pieces.ts      the 21 pieces, their orientations, and the rotate and flip table
  rules.ts       board layouts, placement checks, open corners, move generation, scoring
  ai.ts          CPU players
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the alarm), game.ts (seats, turns, passing, scores)
src/client/    main.ts (the game screen, the tray, the player list and the controls, and its hooks into the shell), board.ts (the board on a canvas),
               shapes.ts (pieces as SVG for the tray and the player list), audio.ts (sounds), attract.ts (the home screen's demo)
test/          Vitest tests for the pieces and rules, the CPUs and the game flow, and room.test.ts, which runs the real room
               (reloads, second tabs, deploys, solitaire) through the kit's test harness
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
