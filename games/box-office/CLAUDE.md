# Box Office

Dots and Boxes for up to 8 players. The board is a grid of dots. On your turn you draw one line between two neighbouring dots, and if that line closes a box, the box is yours and you go again. When every box is claimed, whoever holds the most wins. With more than two players, every chain you open goes to the next player in turn order, so it matters who sits after you.

## Rules for v1

- 2–8 players online, each on their own device, plus CPUs. Turn order is random and stays the same all game.
- The host picks the board: small, medium or large (default medium). The size grows with the number of players at the start, CPUs included, so everyone has boxes to fight over. Sizes are in boxes, columns × rows:

  | Players | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | Small | 4×4 | 5×4 | 5×5 | 6×5 | 6×6 | 7×6 | 8×6 |
  | Medium | 5×5 | 6×5 | 6×6 | 7×6 | 8×6 | 8×7 | 9×7 |
  | Large | 7×6 | 8×6 | 8×7 | 9×7 | 9×8 | 10×8 | 11×8 |

  The lobby shows the size the current player count will get.
- On your turn you draw one undrawn line between two neighbouring dots. If it completes a box (its fourth side), the box is yours. A line between two boxes can complete both at once. If your line completed at least one box you must move again; otherwise the turn passes to the next player.
- The game ends when every box is claimed. Most boxes wins, and ties share the win. The results rank everyone by boxes, with tied players sharing a place.
- Turn timer: the host picks off, 10, 20 or 30 seconds (default 20). The clock restarts after every line, so a long chain of captures gets the full time for each line. When it runs out, the game finishes your turn for you: it takes every box you can complete, then draws a random line that doesn't give anyone a box. If every line gives boxes away, it draws the one that gives away the fewest.
- If the player whose turn it is isn't connected, the game plays their turn the same way after 5 seconds, whatever the timer setting. A player who leaves mid-game keeps their seat and their boxes, and their turns are played for them.
- **Take all** (or T): when you can complete boxes, a button takes every one you can in one go. It never declines boxes; to double-cross, take them one at a time.
- Anyone who joins mid-game watches until the next game.
- CPU players (easy, normal, hard):
  - Easy completes a box when it can and otherwise draws a random line.
  - Normal takes every box it can. Then it draws a random safe line, one that doesn't give anyone a box. When no safe line is left, it opens whatever gives away the fewest boxes.
  - Hard counts the chains and loops and plays the endgame properly. When there are no safe lines left after its captures, it decides at the last two boxes of a chain (the last four of a loop) whether to take them or decline them with a double-dealing move, which hands those boxes to the next player and makes that player open the next chain. In the last stretch of safe lines it plays for the long-chain rule: it looks ahead to see who will be forced to open the first long chain and steers that onto someone else, using short chains as tempo moves. It opens 2-chains in the middle so they can't be declined. With more than two players it weighs who receives each chain: it chooses by its margin over the best other player, not just its own box count.
  - A CPU thinks for about 0.8 seconds before the first line of its turn, and plays the rest of a capture run at 0.25 seconds a line.
- Controls: hovering or touching highlights the nearest undrawn line, with a generous hit area (anywhere within about half a box of it). Click or tap to draw it. When the boxes are smaller than a fingertip (under 48 CSS pixels) on a touch screen, the first tap previews the line and a second tap on it draws it; tapping elsewhere moves or clears the preview. On your turn, boxes you can complete pulse.
- Lines are drawn in their drawer's colour. Claimed boxes are filled with the owner's colour and initial (two letters when two players share an initial). The last move is highlighted. New lines animate in quickly, and a run of captures plays faster the longer it is, so long chains don't drag.
- Not in v1: odd board shapes with holes, bonus boxes worth more, teams, boards with the outer edge already drawn, handing a missing player's seat to a CPU, and keyboard play. Design so they can be added.

## Design notes

- The rules, the chain analysis and the CPU are pure functions in `src/shared/`, with no I/O and no clock, so Vitest can drive them directly.
  - `board.ts`: geometry and rules. A board is `{ w, h, lines, boxes }`: `lines[e]` is the seat that drew edge `e` (or -1), `boxes[b]` the seat that claimed box `b` (or -1). Horizontal edges come first, `r * w + c` for `r` in `0..h`, then vertical edges, `H + r * (w + 1) + c`. Geometry (each box's four edges, each edge's one or two boxes, edge endpoints for drawing) is computed once per size and cached. `playLine(board, edge, seat)` draws a line and returns the boxes it completed; the caller decides whose turn is next.
  - `chains.ts`: the analysis. A line is *safe* if it doesn't make any box's third side. A box with exactly two undrawn sides is a chain box. Chain boxes that share an undrawn side link up into chains (paths) and loops (cycles). Boxes with three or four undrawn sides are junctions: when the endgame starts, each junction joins its two longest arms into one chain (the opener uses up the short arms first), and its other arms count as chains of their own. `giveaway(board, edge)` plays a line out with greedy captures and counts what the next player gets, which is how Normal and the timeout pick the cheapest line.
  - `endgame.ts`: the endgame model over a list of components. The opener picks a component; the next player in turn order receives it. Short chains (1–2 boxes) are taken whole. For a long chain (3+) the receiver can take it all and open the next component, or take all but 2, give the 2 to the player after them, and that player opens next. For a loop it's all but 4. Every player maximizes their own boxes (max-n). The answer is relative to the opener, so it's memoized on just the remaining components and the number of players, and a decision costs milliseconds.
  - `ai.ts`: `cpuMove(board, seats, me, level, rng)` returns one edge. The room calls it once per line.
- Hard's safe-phase search: with 10 or fewer safe lines left, it searches the orders the safe lines can be drawn in (memoized on which of them are drawn; whose move it is follows from the count, since safe lines never capture) and scores each position with no safe lines left by the endgame model. With more than 10, it draws a random safe line.
- Room for the v1 exclusions: a hole is a box that starts as -2 with the edges that touch no playable box pre-drawn (-2 in `lines`, "nobody's"). The analysis already treats any non-negative or -2 line as drawn and skips boxes that aren't -1. Bonus boxes become a `values` array that scoring and component sizes add up instead of counting. Teams become a seat → team map; the turn order stays per seat, scoring and the CPU's objective sum by team. A pre-drawn outer edge is the same -2 lines.
- The server sends the whole board in every state. The biggest board is 195 edges and 88 boxes, a few hundred bytes. `order` lists the edges in the order they were drawn, so a client can animate every line it hasn't seen yet, in order, and highlight the last move.
- Rendering: one canvas. Dots, faint undrawn lines, drawn lines in the drawer's colour, translucent box fills with initials. On a portrait screen a board that's wider than tall is drawn transposed, so its long side runs down the phone; input maps back through the same transform.

## How to build it

Box Office is built on `@warrick/kit` (`../../packages/kit`; read its README). Start from Crater Club in `../crater-club`, which is turn-based and on the kit: its alarm timers, CPU pacing and game-over flow are the closest match. Read the other games for ideas but don't edit them.

- Cloudflare Worker + Vite (`@cloudflare/vite-plugin`), TypeScript, no client framework, canvas rendering. One Durable Object per 5-character room code; no accounts, a random token in `localStorage` maps to a seat, so a reload puts you back in it. All of that comes from the kit.
- `vite.config.ts` is `gameConfig("box-office")`, which sets Vite's `base` to `/box-office/` and nests the built client under `dist/client/box-office/`. `tsconfig.client.json` and `tsconfig.worker.json` extend `@warrick/kit/tsconfig.base.json`.
- `src/worker/index.ts` exports the room and `gameWorker("box-office")`, with the API under `/box-office/api/...`.
- `src/worker/game.ts`: `Game extends Lobby` with `start`, `line`, `takeAll`, the turn flow and `onTimer`. It overrides `leave` and `setConnected` like Crater Club (a leaver keeps their seat; a disconnect shortens the turn clock). `finishedPhase` is the kit's default, `"results"`.
- `src/worker/room.ts`: `GameRoom extends Room` with `newState`, `makeGame`, `timerAt` (the state's `timer.at`) and `handle` for `line` and `takeAll`. No tick loop.
- One alarm drives every timer: the turn clock, the away player's 5 seconds, and CPU thinking time. Timers pause when nobody is connected. The state is small, so it's saved after every line, and a deploy mid-game resumes where it was.
- `src/client/main.ts` creates the kit's `Shell` with the prefix `bo`, the size and timer settings, and hooks for the game screen. `index.html` holds only the game screen. The stylesheet starts with `@import "@warrick/kit/style.css";` and sets the cinema colours: ticket red buttons, a gold logo.
- Dev port 5184, already reserved as `box-office` in `../../.claude/launch.json`. Run `npm run dev -w games/box-office`, or `preview_start` with the name `box-office`; the game is at `http://localhost:5184/box-office/`.
- Add the game's row to the table in `../../README.md` and its card ("Coming soon" until deployed) to `../../hub/public/index.html`.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys. Blur buttons after clicks in the game screen.
- Make every limit visible. If something stops a player from acting, the UI must say why: not your turn, that line's taken, tap again to draw.
- A tab in the background doesn't run `requestAnimationFrame`, so nothing the game needs may wait on an animation. The client snaps the board to the latest state instead of queueing animations while the tab is hidden.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as the other games. The game is served at `https://warrick.games/box-office/`, a path on the shared site. The hub at the root is its own Worker in `../../hub` with `warrick.games` as a Custom Domain; this game gets its own Worker with a zone route on the same hostname, and routes take precedence over a Custom Domain.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/box-office*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, `not_found_handling: "single-page-application"` and `run_worker_first: ["/box-office/api/*"]`. One Durable Object binding, `GAME_ROOM` → `GameRoom`, with a `new_sqlite_classes` migration. Run `npm run cf-typegen` after changing bindings.
- Build every client URL from `import.meta.env.BASE_URL` (the kit's `Shell` does). Workers static assets ignore Vite's `base`, which is why `gameConfig` nests the build; check with `npm run build && npx vite preview` before the first deploy.
- `localStorage` keys are prefixed `bo.`, because every game shares the warrick.games origin.
- `npm run deploy -w games/box-office`, then turn the hub card from "Coming soon" into a link, mark the README row live, and `npm run deploy -w hub`.

Ask before deploying, committing or pushing.
