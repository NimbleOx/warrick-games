# Dice Dominion

A turn-based territory game like *Dice Wars* and *KDice*. The map is split into territories, each holding a stack of dice. On your turn you attack neighbouring territories by rolling your stack against theirs. When you end your turn you get new dice, one for each territory in your biggest connected group. Take the whole map to win.

## Rules for v1

- 2–8 players online, each on their own device. Click or tap one of your territories that has 2 or more dice, then an enemy territory next to it to attack. Click the selected territory again, or press Esc, to cancel. The **End turn** button or Enter ends your turn.
- A new random map every game, made of territories on a hex grid with some sea between them. The host picks the size: 4, 6 or 8 territories per player (default 6).
- Setup: territories are dealt out at random and as evenly as possible. Every territory starts with 1 die. Then each player gets the same number of extra dice, twice the territories-per-player setting, dropped one at a time on random territories of theirs, at most 8 per territory. Later seats get a few more on top, to make up for going later (see the design notes); the log says who got how many. Turn order is random and stays the same all game.
- Attacking: both sides roll all their dice. The attacker needs a strictly higher total; ties go to the defender. If the attacker wins, the territory changes hands, all but one of the attacking dice move into it, and one die stays behind. If the attacker loses, the attacking territory drops to 1 die and the defender loses nothing.
- You can attack as many times as you like in one turn, as long as you have a territory with 2 or more dice next to an enemy.
- End of turn: you get 1 die for each territory in your largest connected group (territories that share a border, not across sea). The dice drop one at a time on random territories of yours that have fewer than 8. Dice that don't fit go into your reserve (at most 64), which is placed first at the end of your next turns. The HUD shows every player's group size and reserve.
- Turn timer: the host picks off, 15, 30 or 60 seconds (default 30). The clock restarts after each attack, so it limits thinking time, not how many attacks you make. When it runs out, your turn ends as if you'd pressed End turn, and you still get your dice.
- A player with no territories left is out and watches. The last player holding territory wins, and the order players were knocked out in ranks the rest.
- If the player whose turn it is isn't connected, their turn ends after 5 seconds. Someone who drops and comes back mid-turn gets the clock they had, never more, so reloading can't buy time; if it had nearly run out, they get 5 seconds, once a turn. (The kit's turn clock, `@warrick/kit/worker/turns`, keeps these rules.) The host can hand a missing player's seat to a normal CPU; the player takes it back when they reconnect. Leaving mid-game leaves your territories on the map, like being away.
- CPU players (easy, normal, hard):
  - Easy attacks any neighbour it has more dice than, in random order, and sometimes stops early.
  - Normal attacks when it has more dice, or with 8 against 8 (an 8-stack can't grow). It prefers attacks that join two of its groups.
  - Hard takes the attacks normal would make and scores each by its chance of winning, the change to its largest group, and how exposed the captured territory and the 1 die left behind would be to its strongest neighbour. It keeps attacking while some attack scores above a threshold, plays harder against whoever leads, and is less cautious in a duel (waiting doesn't pay one-on-one).
  - Every level attacks with its best odds once all its territories hold 8 dice: waiting can't help it then, and two CPUs that both waited would stall the game forever.
  - CPU attacks are spaced about 0.7 seconds apart so everyone can follow. The host can turn on **Fast CPUs**, in the lobby or mid-game.
- Not in v1: teams and alliances, fog of war, hand-made maps, resigning, and a turn-limit or points mode. Design so they can be added.

## Design notes

- Map generation, in `src/shared/map.ts` and driven by a seeded RNG so tests can pin a map: size the hex grid to the territory count so territories average about 20–25 cells, with 40% of it sea. To get one connected landmass with a believable coast, it goes in two steps: grow one continent out from the middle (a flood fill steered by smoothed noise, so it gets bays, inlets and lakes; enclosed pockets under 5 cells become land), then plant one seed per territory spread across it (farthest-point sampling) and grow them over the land with a randomized flood fill, smallest territory first and preferring compact shapes. Throw the map away and try again if the territory graph isn't connected or any territory is under 10 cells. The map is a cell → territory array, each territory's neighbour list and the cell its dice stand on. The map never changes during a game, so it isn't in the state: it's the room's `live` state, and goes out on its own. The welcome carries it beside the state, and a game that starts sends it in a `map` message ahead of its first state. A client missing the current map (`mapId`) asks for it with `sync`, and gets a `map` message back.
- Rendering: fill each territory's cells with its owner's colour and draw a border wherever a cell's neighbour belongs to a different territory. Draw the dice stack on the cell farthest from the territory's edge, so stacks don't cover borders. Size the cells from the canvas so the whole map fits a phone in portrait. Highlight the territories the selected stack can attack.
- Odds: the attacker's chance of winning with a dice against b dice can be worked out exactly (convolve the d6 sums) into an 8 × 8 table. Ties favour the defender: 2 vs 2 wins 44% of the time, 8 vs 8 wins 47%, 3 vs 2 wins 78%. The CPUs use the table. The client can show the odds when you pick a target.
- Dice are rolled only on the server. Broadcast each attack as the two territories, both sets of rolls and the result. Clients play a short roll animation (under a second, skippable), then apply it. The end-of-turn broadcast lists where each new die landed, so clients can drop them in one by one.
- Largest group, legal attacks and win checks are graph functions over the territory neighbour lists. Keep them pure so Vitest can test them.
- First-move advantage: in simulated games between normal CPUs, the first of two players won about 80% of the time, and the first of four about 38%. Later seats now start with extra dice, rising to `round(1.2 × territories per player ÷ players)` for the last seat (`seatBonus` in `rules.ts`), which brought two players to about 50/50 and the first of four to about 29%. The README has the numbers. Keep watching it in playtests with people.

## How to build it

Copy the architecture of Crater Club, the turn-based artillery game in `../crater-club`. Read its README first. Crater Club is built on `@warrick/kit` (`../../packages/kit`), and so is this game: the room, lobby, router, socket and page shell come from the kit, and the game keeps its own rules, screen and look. It is turn-based like this game, so its turn timers, CPU pacing and alarm handling are the closest match. The other games in `../` are live; read them for ideas if useful, but don't modify them.

- Cloudflare Worker + Vite (`@cloudflare/vite-plugin`), TypeScript, no client framework, canvas rendering.
- One Durable Object per 5-character room code. `POST /api/games` creates a room, `/g/CODE` is the invite link, `/api/games/CODE/ws` is the WebSocket.
- No accounts: a random token in `localStorage` maps to a player slot, so a reload puts you back in your seat.
- Lobby: the host picks settings, can add CPU players, and starts the game. Up to 8 players.
- Build on the kit (see `../../packages/kit/README.md`), not on copies of Crater Club's files. `src/worker/game.ts` is a `Lobby` subclass with the game's rules; `src/worker/room.ts` extends the kit's `Room` (sockets, tokens, storage, the alarm via `timerAt`/`onTimer`, cleanup) and handles the game's own messages; `src/worker/index.ts` is `gameWorker("dice-dominion")`. On the client, `src/client/main.ts` creates the kit's `Shell` (home, create/join, invite links, lobby, chat, reconnecting socket, mute) and adds the game screen; `index.html` holds only that screen, and `src/client/style.css` starts with `@import "@warrick/kit/style.css"`. Copy Crater Club's tsconfig / Vitest / wrangler setup, which already points at the kit.
- Dev port 5181, already reserved in `../../.claude/launch.json`. Add a row for the game to the table in `../../README.md`.

### Turn-based, like Crater Club

- No tick loop. The Durable Object handles each action as it arrives and checks it: your turn, your territory, at least 2 dice, an enemy neighbour.
- One alarm drives every timer: the turn clock, CPU thinking time between attacks, the end-of-turn dice drop and the game-over banner. Timers pause when nobody is connected.
- Use hibernatable WebSockets so the object can sleep between actions. A game with no connections for 12 hours is deleted.
- The state is small, so persist it after every attack and every turn end. The map (about 8 KB) has its own storage key, written in the same save as the state when a game makes a new map (the room's `changedKeys`), and loaded in the room's constructor. A deploy mid-game should resume exactly where it was.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys. Blur buttons after clicks in the game screen, since Enter ends your turn.
- Make every limit visible. If something stops a player from acting, the UI must say why: not your turn, only 1 die, not a neighbour.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as Crater Club. The game is served at `https://warrick.games/dice-dominion/`: a path on one shared site, not a subdomain. The hub page at the root is its own Worker in `../../hub`, with `warrick.games` as a Custom Domain. This game gets its own Worker with a zone route on the same hostname, and routes take precedence over a Custom Domain. Each game is its own folder under `games/` in this repo and its own Worker, and deploys on its own. Crater Club already works this way, and the kit does most of the setup.

- `wrangler.jsonc`: `"routes": [{ "pattern": "warrick.games/dice-dominion*", "zone_name": "warrick.games" }]` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, and `run_worker_first: ["/dice-dominion/api/*"]`.
- `vite.config.ts` is the kit's `gameConfig("dice-dominion")`. It sets Vite's `base` to `/dice-dominion/`, and the kit's `Shell` and socket build every client URL from `import.meta.env.BASE_URL` (fetches, the WebSocket, invite links like `/dice-dominion/g/CODE`, `history` paths). The Worker's API lives under `/dice-dominion/api/...`. Locally the game is at `http://localhost:5181/dice-dominion/`.
- Static assets gotcha: Workers static assets are looked up by request path and ignore Vite's `base`. `gameConfig` handles it: it moves the client build into `dist/client/dice-dominion/` and leaves `index.html` at the root, because the single-page-application fallback always serves `/index.html`. Still check with `npm run build && npx vite preview` before deploying.
- All the games share one origin, so `localStorage` keys get the game's prefix: the `Shell` is created with `prefix: "dd"` (`dd.name`, `dd.token`, …). Crater Club uses `cc.`, Stack Attack `sa.`.
- A "Coming soon" card is already in `../../hub/public/index.html`. After the first deploy, turn it into a link (like Stack Attack's) and deploy the hub.

Ask before deploying, committing or pushing.
