# Corner Shop

A turn-based territory game like *Blokus*. Everyone has the same 21 pieces: every shape you can make from 1 to 5 squares. Take turns placing them on a shared board. Your own pieces may only touch each other at the corners, never along an edge; other colours can touch yours however they like. Fit in as many squares as you can before the board closes up on you.

## Rules for v1

- 2–4 players online, each on their own device, plus CPU players. The lobby holds at most 4. Anyone who arrives mid-game watches until the next one.
- **Solitaire.** On your own in the lobby, the start button says **Play solitaire**: just you on the 14×14 board, starting from its top-left corner, and every turn is yours. Fit in as many of your 21 pieces as you can; the game ends when none of the rest fit, and the usual scoring applies. There's no turn timer and nothing passes while you're away: nobody is waiting. The end screen shows your score, pieces and squares left, and your best score (kept in this browser). Add a CPU or invite a friend and it's a game again. (On 20×20 every CPU places all 21 pieces every time; on 14×14 the normal CPU manages it about a third of the time.)
- The board depends on how many play (solitaire is above):
  - 3–4 players: a 20×20 board, and everyone starts in their own corner, clockwise from the top left. With 3 players the bottom-left corner stays empty.
  - 2 players: a 14×14 board with the starting squares near the middle, on the diagonal at (5, 5) and (10, 10) counting from 1, like *Blokus Duo*.
- Turn order is random and stays the same all game; seats go round the corners clockwise in that order.
- The pieces: 1 monomino, 1 domino, 2 trominoes, 5 tetrominoes and 12 pentominoes, 89 squares in all. Every player has the full set.
- On your turn you place one piece. It can be rotated and flipped. It must fit on the board and cover only empty squares.
  - Your first piece must cover your starting square.
  - Every later piece must touch at least one of your own pieces corner to corner, and none of them along an edge.
  - Other colours can touch your pieces anywhere.
  - Nobody can cover another player's starting square before that player has placed their first piece, unless that player is out. (This only matters if someone misses their first turn; without it, a neighbour could shut them out of the game.)
- If you have no legal move when your turn comes, you're out of moves: you're passed automatically for the rest of the game, the log says so, and your row in the player list says "out of moves". (Pieces are never removed, so once you're stuck you stay stuck.) Placing your last piece also puts you out.
- The game ends when nobody can move.
- Scoring: −1 for each square left in your tray. Place all 21 pieces and you score +15 instead, or +20 if the monomino was your last piece. Highest score wins, and ties share the win.
- Turn timer: the host picks off, 30, 60 or 90 seconds (default 60). Running out passes that one turn; you're still in the game and play again next time round.
- If the player whose turn it is isn't connected, their turn passes after 10 seconds. Back in time, they get the clock they had, not a new one (the kit's turn clock). A player who misses 3 turns in a row while away is out, so a game can't stall on someone who has gone for good. Leaving the game with the Leave button puts you out straight away; your pieces stay on the board and your score counts.
- Controls:
  - Pick a piece from your tray. Pieces that don't fit anywhere right now are greyed out and say so.
  - Rotate with R, right-click or the mouse wheel. Flip with F. Esc puts the piece back.
  - A ghost shows where the piece would land: green where it's legal, red where it isn't, with the reason under the board ("Your first piece must cover your starting square", "Your pieces can't touch along an edge", and so on). Click to place. Arrow keys move the ghost and Enter places it.
  - On touch screens: tap a piece (the ghost jumps to the nearest spot where it fits) or drag it from the tray onto the board, drag on the board to move it, use the Rotate and Flip buttons, then Place.
  - The board marks your open corners: the squares where one of your remaining pieces could still go. While you hold a piece, the corners it fits are brighter.
- CPU players (easy, normal, hard), each about 0.8 seconds per move so everyone can follow:
  - Easy plays a random legal move, favouring big pieces.
  - Normal is greedy: it scores every legal move by the squares placed, plus the new open corners it makes for itself, minus the open corners it takes from the others. It saves the monomino for last.
  - Hard takes Normal's best few moves and looks one move ahead: for each, it plays the next player's likely reply and counts how many squares it could still place afterwards. It pushes toward the centre early, plays awkward pentominoes (X, W, F, Z…) while there's room, takes more corners from whoever leads, and saves the monomino for last.
- Not in v1: 5–8 players on a bigger board, teams (the 2-colours-each variant), a blitz mode, undo, handing a missing player's seat to a CPU, and a resign button. Design so they can be added.

## Design notes

- The pieces, in `src/shared/pieces.ts`: each piece is a list of cells. All 8 rotations and flips of each, normalised (moved to the top-left and sorted) and deduplicated, give the 91 distinct orientations. Each piece also has a table from (rotation, flip) to its orientation index, so the client can rotate and flip without any geometry of its own.
- The board is a flat array, `size × size`, of seat numbers (−1 for empty). The state also keeps the list of moves (seat, piece, cells) so the client can outline each piece and highlight the last move.
- A move is `{ piece, orient, x, y }`: the orientation's index and the top-left of its bounding box. The server checks the piece is in your tray, the orientation index is real, and the placement is legal, using the same pure function the client uses for the ghost.
- Move generation works from each player's open corners (anchors): empty squares diagonal to one of their pieces and not edge-adjacent to any. On the first move the only anchor is the starting square. For each anchor, each piece left in the tray, each orientation and each of its cells, put that cell on the anchor and check the rest. A placement found from two anchors counts once.
- Rules, move generation, scoring and the CPU are pure functions in `src/shared/`, with no state beyond their arguments and a seeded RNG, so Vitest can test them and the client can run them for the ghost, the open corners and the home-screen demo.
- Solitaire is a game with one seat (`layoutFor(1)`): the turn always comes back to the same player, nobody wins (`winners` stays empty), and its turns have no deadline, so the room's alarm is only its clean-up.
- "Out of moves" is checked when a player's turn comes round, with an early-exit search. The game is over when every seat is out.
- The CPU runs on the server. A mid-game 20×20 position has a few thousand legal moves; Hard's lookahead looks at its best 8 and stays well under 100 ms.
- Watch the first-move advantage in playtests, especially in 2-player games. If going first wins too often, Duo's usual fix is to let the second player pick their colour first; here we could rotate who starts between games.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/corner-shop -- --port 5183  # http://localhost:5183/corner-shop/, with the Worker and Durable Object in workerd
npm test -w games/corner-shop                    # rules, CPU, game-flow and room tests (Node)
npm run typecheck -w games/corner-shop
```

## Deploying

`npm run deploy -w games/corner-shop` builds it and deploys it to **https://warrick.games/corner-shop/**. The root README explains how the games share warrick.games. `localStorage` keys start with `cs.`.
