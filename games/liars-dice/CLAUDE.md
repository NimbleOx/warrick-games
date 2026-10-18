# Liar's Dice

A multiplayer bluffing dice game like *Perudo*. Everyone rolls five dice under a cup and looks only at their own. Players take turns bidding on how many dice of one face are on the whole table, each bid higher than the last, until someone calls "Liar!". The cups come up, the dice are counted, and whoever was wrong loses a die. Lose them all and you're out. The last player with dice wins.

## Rules for v1

- 2–8 players online, each on their own device, plus CPUs. Everyone starts with 5 dice, and nobody can have more than 5.
- Seats go in a random order that stays the same all game. Play moves clockwise, skipping anyone who is out.
- Each round everyone rolls in secret. You see your own dice and how many dice everyone else has, never their faces.
- A bid is a quantity and a face, like "at least seven 4s", counting every die on the table, yours included. A bid can't be for more dice than are on the table.
- Each bid must raise the last one: a higher quantity of any face, or the same quantity of a higher face.
- **Ones are wild** (host option, on by default). Ones count as every face, so "seven 4s" counts the 4s and the 1s. Bids on ones have their own track:
  - You can't open a round on ones.
  - Switching to ones, the quantity can drop to half the last bid, rounded up: after seven 4s, four 1s is enough.
  - Raising ones needs a higher quantity of ones.
  - Switching back from ones needs double the quantity plus one: after four 1s, at least nine of a face.
  - With wilds off, ones are an ordinary face, the lowest, and you can open on them.
- On your turn you either raise or call **Liar!** on the last bid (not on the first turn of a round, when there's nothing to call). Every cup comes up and the dice are counted. If the bid is met (at least that many), the caller loses a die. If not, the bidder does. The loser starts the next round.
- **Spot on** (host option, off by default). On your turn, instead of raising or calling Liar!, you can claim the last bid is exactly right. If it is, you get a die back (if you have fewer than 5). If not, you lose one. Either way, you start the next round.
- A player with no dice is out and watches. If the player who should start the next round is out, the next player clockwise starts. The last player with dice wins. Everyone else is ranked by when they went out.
- Turn timer: the host picks off, 15, 30 or 45 seconds (default 30). When it runs out, the game makes the move a normal CPU would make with your dice.
- If the player whose turn it is isn't connected, the game makes that move for them after 5 seconds, so a dropped phone doesn't stall the table. When they come back, they're in their seat with their dice.
- Leaving mid-game (the Leave button) counts as going out. Your dice stay in this round's count, and your turns are skipped. From the next round you're gone.
- Anyone who joins mid-game watches until the next game.
- CPU players (easy, normal, hard). All of them judge a bid from their own dice plus the binomial odds for the dice they can't see: each unseen die matches with chance 1/3 for a non-one face with wilds on (the face or a one), otherwise 1/6.
  - **Easy** bids its most common face (counting its ones when they're wild), with the smallest legal quantity. It calls Liar! when a bid is at least 2 more than its average count (its own matches plus the expected matches among the unseen dice). It never calls Spot on.
  - **Normal** calls Liar! when the bid is less than 30% likely to be true (15% with wilds off). Otherwise it makes the smallest raise on its best face, the one whose smallest raise is most likely to be true. With Spot on enabled, it calls it when the bid is at least 50% likely to be exactly right. (The brief said about 35%; see Lessons for why it's lower.)
  - **Hard** treats other players' bids this round as hints: a player who bid on a face is taken to hold more of it than chance (and more ones, with wilds on). It weighs Liar!, Spot on and its best raises by how likely each is to cost it a die. It bluffs now and then (it bids a face it holds few of, as long as the bid is still plausible), sometimes raises by more than the minimum, and draws its thresholds fresh each turn so it's harder to read.
  - Opening bids: each level bids its best face, at the largest quantity it thinks is likely enough (easy 50%, normal 60%, hard 50–75%).
  - CPUs think for 1–2 seconds a move, so everyone can follow.
- Not in v1: Perudo's palifico round, teams, more house rules (calling out of turn, losing dice to the difference, a different starting count). The rules functions take the round's options as an argument, so a palifico round (no wilds, face fixed by the opener) can be added as another option on the round.

## Design notes

- **Hidden information is the core of this game.** Nobody's dice are in the game state. `s` is broadcast to every socket (and sent whole in the welcome), so it holds only public facts: dice counts, the bids, and the last call's reveal. The current round's dice live in the room's `live` slot, which `GameRoom` also saves under its own storage key, so a deploy mid-round doesn't re-roll anyone. Each player gets their own dice in a direct `hand` message after every roll, and again after every hello, so a reload puts you back in your seat with your dice.
- Snapshots, logs, spectators' and eliminated players' views never include anyone's dice until a call reveals them. A call puts that round's dice into `s.reveal`, which is public from then on. A Vitest test runs a whole room with fake sockets (humans, CPUs, a spectator, reconnects and eliminations) and checks every message each seat receives.
- **Dice are rolled only on the server**, with `crypto.getRandomValues` (unbiased by rejection). Tests set hands directly.
- **Bid order is one number.** `bidRank` maps a bid to an integer so a raise is just a bigger rank. Without wilds it's `6q + f`. With wilds a non-one bid is `6q + f` and q ones are `12q + 7`, which sits between (2q, 6) and (2q + 1, 2): exactly the halve-going-in, double-plus-one-coming-out rule. `minQty(prev, face)` finds the smallest legal quantity for each face, which is what the bid picker and the CPUs use.
- Rules, bid validation, counting, resolving a call and the CPUs are pure functions in `src/shared/` (`rules.ts`, `odds.ts`, `ai.ts`). The CPU takes only what that seat may know: its own hand, everyone's dice counts and this round's bids. The `Game` class in `src/worker/game.ts` is glue: turns, timers, the log and who sees what.
- **The UI** is DOM, not canvas: it's cards, buttons and text, and it has to fit a phone. It shows your own dice big, every player's seat with their dice count and last bid, the current bid, a bid picker (quantity stepper and face buttons, with only legal bids enabled and each face's smallest legal quantity under it), the Liar! and Spot on buttons, and this round's bid history. The picker starts each turn at the smallest raise on the current face.
- **A call** lifts the cups (each seat's dice appear), highlights the dice that count (wild ones marked differently), counts them up one at a time, then shows who loses a die. The reveal stays in `s` with its server time, so someone who reconnects mid-reveal sees it from where it is. The reveal phase lasts long enough for the count (4.5 s plus 0.16 s per counted die, at most 10 s). Then the next round starts and everyone's new hand arrives.
- One alarm drives every timer: the turn clock, the 5-second grace for a missing player, CPU thinking time and the reveal pause. Timers pause when nobody is connected.

## How to build it

Built on `@warrick/kit` (see `../../packages/kit/README.md`), starting from Crater Club (`../crater-club`), which is turn-based and already on the kit. Read the root `README.md` first.

- `vite.config.ts` is `gameConfig("liars-dice")`. It sets Vite's `base` to `/liars-dice/` and nests the built client under `dist/client/liars-dice/`.
- `src/worker/index.ts` exports `GameRoom` and `gameWorker("liars-dice")`, with the API under `/liars-dice/api/...`.
- `src/worker/game.ts`: `Game extends Lobby<GameState, ServerMsg, Hands>`. It overrides `createPlayer`, `betweenRounds` (the lobby is open only in the "lobby" phase), `leave` (mid-game it counts as going out), `setConnected` (queues your hand, and starts the 5-second grace), `resetForLobby`, and adds `start`, `bid`, `liar`, `spot` and `onTimer`.
- `src/worker/room.ts`: `GameRoom extends Room` with `newState`, `makeGame`, `handle` (bid, liar, spot) and `timerAt`. It loads the hands in its constructor and saves them after each message and alarm if they changed. If they're lost anyway (a restart between the two saves), the game rolls that round again, clears its bids and sends everyone their new cup.
- `src/client/main.ts` creates a `Shell` with prefix `ld`, the settings' labels, and hooks for the `hand` message and the game screen. `index.html` holds only the game screen. The stylesheet imports `@warrick/kit/style.css` and sets an amber accent.
- `tsconfig.client.json` and `tsconfig.worker.json` extend `@warrick/kit/tsconfig.base.json`. `vitest.config.ts` aliases `cloudflare:workers` to a stub in `test/stubs/`, so the privacy test can run the real room in Node.
- Dev port 5185, reserved as "liars-dice" in `../../.claude/launch.json`: `http://localhost:5185/liars-dice/`.

## Lessons from this game

- Plain binomial odds undersell a bidder's own dice: people (and CPUs) bid on faces they hold. In simulated games, a Normal CPU that called Liar! below 35% lost to Easy, which only calls far-fetched bids, and without wilds (1 die in 6 matches, not 1 in 3) it lost badly. Calling below 30% with wilds and 15% without puts the levels in order (easy < normal < hard) for every combination of the two options. `test/sim.ts` plays CPU-only games with the pure rules; `test/ai.test.ts` keeps the order from slipping.
- The kit broadcasts the whole state and sends it whole in the welcome, and doesn't persist `live`. So the hidden dice live in `live` and `GameRoom` saves them itself, and each player's cup goes out as a direct message queued from `setConnected` (every hello passes through it). A future kit hook for a per-seat view would make this simpler.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients reconnect and resync from the welcome. Here that means the hidden hands must be persisted too, not just the state.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys. Blur buttons after clicks in the game screen.
- Make every limit visible. If something stops a player from acting, the UI says why: not your turn, that bid doesn't raise the last one, nothing to call yet.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, same account as the other games. The game is served at `https://warrick.games/liars-dice/`, a path on the shared site. The hub at the root is its own Worker in `../../hub` with `warrick.games` as a Custom Domain. This game is its own Worker with a zone route on the same hostname, and routes take precedence over a Custom Domain.

- `wrangler.jsonc`: the route `{ "pattern": "warrick.games/liars-dice*", "zone_name": "warrick.games" }`, `workers_dev: false`, `preview_urls: false`, and `run_worker_first: ["/liars-dice/api/*"]`.
- The client's `Shell` builds every URL from `import.meta.env.BASE_URL`, and the kit's `gameConfig` handles the static-assets base path. Check with `npm run build && npx vite preview` before the first deploy.
- `localStorage` keys are prefixed `ld.` (every game shares the warrick.games origin).
- `npm run deploy -w games/liars-dice`. Then turn the game's card in `../../hub/public/index.html` from "Coming soon" into a link, mark it live in the root README's table, and deploy the hub (`npm run deploy -w hub`).

Ask before deploying, committing or pushing.
