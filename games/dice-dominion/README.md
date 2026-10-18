# Dice Dominion

A multiplayer, browser-based take on *Dice Wars* and *KDice*. The map is split into territories, each holding a stack of dice. On your turn you attack neighbours by rolling your stack against theirs, and when you end it you get a die for every territory in your largest connected group. Take the whole map to win. Up to 8 players, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/dice-dominion/g/K7Q2M`. Send either one to your friends.
- The host picks the map size (4, 6 or 8 territories per player), the turn timer (off, 15, 30 or 60 seconds) and the CPU speed, and can add CPU players (easy, normal or hard).
- On your turn, click or tap one of your territories with 2 or more dice, then a highlighted neighbour; the label on each shows your chance of winning. Click the selected territory again, or press Esc, to cancel. **End turn** (or Enter) collects your dice.
- Both sides roll all their dice and the higher total wins; ties go to the defender. Win and all but one of your dice move in. Lose and your territory drops to 1 die.
- New dice land on random territories of yours. Those that don't fit (8 is the most a territory holds) are saved, up to 64, and placed first next time.
- The turn clock restarts after every attack. When it runs out, your turn ends and you still get your dice.
- Later seats start with a few extra dice, since going first is a big advantage (see below). The log says who got how many.
- Reloading the page puts you back in your seat, with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, their turn ends after 5 seconds, and the host can hand their seat to a normal CPU (the **CPU** button by their name) until they come back. Anyone who joins mid-game watches until the next game.

## Development

```bash
npm install        # once, at the repo root
npm run dev        # http://localhost:5181/dice-dominion/ — Vite + the Worker and Durable Object running in workerd
npm test           # map, odds, rules and game-flow tests (Node)
npm run typecheck
```

`npm run dev` uses the Cloudflare Vite plugin, so the Worker, the Durable Object and the WebSockets run locally in the real Workers runtime. In dev builds `window.__dd` holds the client's state, the map view and the shell.

## Deploying to Cloudflare

```bash
npx wrangler login
npm run deploy     # vite build && wrangler deploy
```

That creates a Worker called `dice-dominion` with the `GameRoom` Durable Object (SQLite-backed) and uploads the client as static assets. It's served at **https://warrick.games/dice-dominion/** through the zone route `warrick.games/dice-dominion*` in `wrangler.jsonc`; the `workers.dev` address is off, so invite links always point at warrick.games. Everything lives under the base path `/dice-dominion/`, set by the kit's `gameConfig("dice-dominion")` in `vite.config.ts` and `gameWorker("dice-dominion")` in `src/worker/index.ts` (see Crater Club's README for how the base path and the static assets fit together). Check with `npm run build && npx vite preview` before deploying.

If you change bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /dice-dominion/api/games            → allocate a code, initialize that room
   │   GET  /dice-dominion/api/games/:code      → does the game exist?
   └─WS─ /dice-dominion/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between actions. The state is saved after every attack and every turn, so a deploy mid-game picks up where it was. The map has a storage key of its own, written only when a game makes a new one.
- **The map** is made on the server from a seed (`src/shared/map.ts`): a continent grown out from the middle of a hex grid with a flood fill steered by smoothed noise (so it gets bays, inlets and lakes), one seed per territory spread across it, and the seeds grown over the land, smallest territory first. Maps with a tiny territory or a territory graph that isn't connected are thrown away. The map never changes during a game, so it isn't in the state: it goes out on its own, in the welcome and in a `map` message when a game starts, and a client that somehow lacks it asks with `sync`.
- **Dice are rolled only on the server.** Each attack is broadcast as the two territories, both rolls and the result, and each turn's end as the list of territories the new dice landed on. Clients queue these and animate them (a short roll, the dice dropping in one by one) before applying the state that follows. Tapping skips the animation.
- **One alarm drives every timer:** the turn clock, the gap between a CPU's attacks, the end-of-turn dice drop and the winner's banner. Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **The rules are pure functions** over each territory's owner and dice plus the map's neighbour lists (`src/shared/rules.ts`): largest group, legal attacks and why an attack isn't allowed, attack resolution, end-of-turn dice with the reserve, the win check. The server, the CPUs and the client's hints all use them.
- **The odds** (`src/shared/odds.ts`) are worked out exactly by convolving the d6 sums into an 8 × 8 table. The CPUs plan with it and the client labels targets with it.

### CPUs and balance

The CPU levels and the starting-dice bonus were tuned with simulated games between CPUs (pure rule functions, no server), a few hundred to a thousand games per setting:

- **First-seat advantage** is big: with two normal CPUs the first player won about 80% of games, and with four the first seat won about 38%. Later seats now start with extra dice, rising to `round(1.2 × territories per player ÷ players)` for the last seat (`seatBonus` in `rules.ts`). That brought two players to about 50/50 and the first of four down to about 29%.
- **Normal** beat three easy CPUs about 46% of the time (a fair share is 25%). **Hard** beat three normal CPUs about 51% of the time, two normals about 51% (fair: 33%), and plays even with normal one-on-one, where luck and the first move dominate. Hard only considers attacks with more dice (or 8 against 8), weighs each by its odds, the growth of its largest group and how exposed the captured territory and the die left behind would be, is pickier when several opponents are left, and goes after the leader.
- Every level attacks with its best odds once all its territories are full: waiting can't help it then, and two CPUs that both waited would stall the game forever.

Watch these in playtests with people; humans play differently from the CPUs the numbers come from.

### Layout

```
src/shared/    code used by both sides: hex grid, map generation, odds, rules, CPU players, protocol types
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the alarm), game.ts (turns, attacks, timers)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (the map on a canvas),
               audio.ts (sounds), attract.ts (the home screen's self-playing demo)
test/          Vitest tests for the map, the odds, the rules and the game flow, and room.test.ts, which runs
               the real room (reloads, restarts, the map's storage) through the kit's test harness
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
