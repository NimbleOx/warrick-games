# Corner Shop

A turn-based territory game like *Blokus*. Everyone has the same 21 pieces: every shape you can make from 1 to 5 squares. Take turns placing them on a shared board. Your own pieces may only touch each other at the corners, never along an edge; other colours can touch yours however they like. Fit in as many squares as you can before the board closes up on you.

## Rules for v1

- 2–4 players online, each on their own device, plus CPU players. The lobby holds at most 4. Anyone who arrives mid-game watches until the next one.
- The board depends on how many play:
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
- "Out of moves" is checked when a player's turn comes round, with an early-exit search. The game is over when every seat is out.
- The CPU runs on the server. A mid-game 20×20 position has a few thousand legal moves; Hard's lookahead looks at its best 8 and stays well under 100 ms.
- Watch the first-move advantage in playtests, especially in 2-player games. If going first wins too often, Duo's usual fix is to let the second player pick their colour first; here we could rotate who starts between games.

## How to build it

Build it on `@warrick/kit` (`../../packages/kit`, see its README), starting from Crater Club in `../crater-club`, the turn-based game already on the kit. Read its README first: its turn timers, CPU pacing and alarm handling are the closest match. Read the other games for ideas, but don't modify them.

- Cloudflare Worker + Vite, TypeScript, no client framework, canvas rendering. `vite.config.ts` is `gameConfig("corner-shop")`; `tsconfig.client.json` and `tsconfig.worker.json` extend `@warrick/kit/tsconfig.base.json`.
- One Durable Object per 5-character room code. `src/worker/index.ts` exports the `GameRoom` and `gameWorker("corner-shop")`, which serves `POST /corner-shop/api/games`, `GET /corner-shop/api/games/CODE` and the WebSocket at `/corner-shop/api/games/CODE/ws`. `/corner-shop/g/CODE` is the invite link.
- `GameRoom` extends the kit's `Room` with `newState`, `makeGame`, `timerAt` and `handle` (the `place` message). `Game` extends the kit's `Lobby` with the rules: `maxPlayers = 4`, its own colours, `finishedPhase = "gameover"`, and overrides for `leave` and `setConnected` (a player who leaves mid-game is out; one who drops is skipped).
- No accounts: the kit's random token in `localStorage` maps to a seat, so a reload puts you back in your seat. The `localStorage` prefix is `cs`.
- The client's `main.ts` creates the kit's `Shell` (home card, lobby, chat, connection, leave, mute) and adds the game screen: the board canvas, the tray, the HUD and the touch controls. `index.html` holds only the game screen.
- Dev port 5183, reserved as `corner-shop` in `../../.claude/launch.json`. Locally the game is at `http://localhost:5183/corner-shop/`.

### Turn-based, like Crater Club

- No tick loop. The Durable Object checks each `place` as it arrives: your turn, your piece, a legal spot.
- One alarm drives every timer: the turn clock, CPU thinking time and the away skip. The kit pauses timers when nobody is connected.
- Hibernatable WebSockets, so the object sleeps between moves. A game with no connections for 12 hours is deleted.
- The state is small (a 400-cell board and at most 84 moves), so it's saved and broadcast whole after every move. A deploy mid-game resumes exactly where it was.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys. Blur buttons after clicks in the game screen, since Enter places a piece.
- Make every limit visible. If something stops a player from acting, the UI must say why: not your turn, that touches your own piece along an edge, that piece doesn't fit anywhere.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as the other games. The game is served at `https://warrick.games/corner-shop/`: a path on the shared site, not a subdomain. The hub at the root is its own Worker in `../../hub`, with `warrick.games` as a Custom Domain; this game's Worker has a zone route on the same hostname, and routes take precedence over a Custom Domain.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/corner-shop*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, `not_found_handling: "single-page-application"` and `run_worker_first: ["/corner-shop/api/*"]`.
- The kit's `gameConfig` sets Vite's `base` to `/corner-shop/` and moves the client build into `dist/client/corner-shop/` (Workers static assets are looked up by request path and ignore `base`), leaving `index.html` at the root for the single-page-application fallback. The `Shell` builds every URL from `import.meta.env.BASE_URL`. Check with `npm run build && npx vite preview` before the first deploy.
- `npm run deploy -w games/corner-shop` builds and deploys. Then turn the game's card in `../../hub/public/index.html` from "Coming soon" into a link, deploy the hub (`npm run deploy -w hub`), and mark it live in the root README.

Ask before deploying, committing or pushing.
