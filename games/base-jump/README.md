# Base Jump

A multiplayer, browser-based base-capture strategy game in the style of *Modern Conflict* (with a few ideas from *Galcon* and *Mushroom Wars*), for up to 8 players. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object that runs the battle in real time.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/base-jump/g/K7Q2M`. Send either one to your friends.
- The host picks the time limit (5, 10 or 15 minutes, or none) and the map size (4, 6 or 8 bases a player), and can add CPU players (easy, normal or hard).
- Every map is new: bases joined by roads. **Depots** (round) build tanks; **airfields** (diamonds) build helicopters. Everyone starts with one depot and 15 tanks; the rest of the bases are neutral and guarded.
- Drag from one of your bases to any base to send units there. Sweep across more of your bases on the way to send from all of them. Or tap your base, then the target. **25% / 50% / All** (or keys 1, 2, 3) sets how much of each base goes.
- **Tanks drive along roads**, through any of your own bases on the way. **Helicopters fly straight** to anywhere, nearly twice as fast. While you aim, the map shows each route, how many units would go, and whether that's enough to take the base right now.
- Fights: like fights like first, and one tank is worth two helicopters. If any attackers are left, the base is theirs. Units on the move don't fight each other.
- Bases build up to a cap. Upgrade one (U, or the Upgrade button) by spending units in it: it builds faster and holds more. A base holding more than its cap slowly loses the excess, so don't hoard.
- Take every base to win, or hold the most when time runs out. Reloading the page puts you back in your seat; players who join mid-round watch until the next one.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/base-jump -- --port 5187  # http://localhost:5187/base-jump/, with the Worker and Durable Object in workerd
npm test -w games/base-jump                    # map, battle, CPU, sync and game-flow tests (Node)
npm run typecheck -w games/base-jump
```

Editing worker code restarts the Durable Object, which also shows what a deploy does to a round in progress: it starts over on a new map.

## Deploying

`npm run deploy -w games/base-jump` builds it and deploys it to **https://warrick.games/base-jump/**. The root README explains how the games share warrick.games. `localStorage` keys start with `bj.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /base-jump/api/games            → allocate a code, initialize that room
   │   GET  /base-jump/api/games/:code      → does the game exist?
   └─WS─ /base-jump/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **The server runs the battle** 10 ticks a second while a round is on and someone is connected (the kit's tick loop). The loop stops when the round ends or everyone leaves, so idle games can hibernate. The battle lives in memory only; a restart starts the round over on a new map.
- **Clients send orders** (`send` from some bases to a base at a percentage, or `up` to upgrade one). The server checks each order as it arrives, so a mistake comes straight back as an error ("No road there through your bases…"), queues it, and applies it at the start of the next tick. CPU orders go through the same path.
- **Every tick the server broadcasts one frame**: the tick number and the orders applied that tick, usually under 30 bytes. The battle (`src/shared/battle.ts`) is deterministic and integer-only (production counts thousandths of a unit, travel times are whole ticks fixed when units leave), so every client runs the same frames on its own copy and stays in step. Units glide between bases on the client from their departure and arrival ticks. Every 50 ticks a frame carries a checksum; a mismatch or a gap makes the client ask for a snapshot.
- **Snapshots** (the map plus every base and unit group, a few KB) go out at round start, in the welcome message, and on request.
- **Maps** (`src/shared/map.ts`) are generated from a seed: bases scattered by best-candidate sampling, roads from the relative neighbourhood graph plus some extra Gabriel-graph edges (connected, never crossing), starting bases by farthest-point sampling over road distance, every start's nearest neighbour the same easy depot, and a guaranteed share of airfields. Each map is the fairest of 24 candidates, by how even the starts are.
- **CPU players** (`src/shared/ai.ts`) estimate what will be holding a target when their units get there (garrison, production on the way, units already heading there), then pick attacks by value against cost and travel time. Normal and hard also send help to bases that would fall to what's coming, push units from behind the front, and upgrade safe bases. Hard thinks about twice as often, goes all in from front-line bases when that's what a capture takes, and gangs several bases up on one target.

### CPU strength

Measured in CPU-against-CPU duels, seats swapped every other game, half on small maps and half on medium:

| Matchup | Wins (stronger side) | Typical length |
| --- | --- | --- |
| Hard vs normal | 129 / 160 (81%) | ~95 s |
| Normal vs easy | 160 / 160 | ~115 s |
| Hard vs easy | 80 / 80 | ~80 s |

While tuning hard, caution never paid: bigger safety margins, keeping reserves against nearby enemies, and expecting the defender to reinforce all made a CPU weaker against normal. Thinking faster on its own didn't help either. What did help was being free to send everything from a front-line base, and doing it soon. Large free-for-alls between normal CPUs can grind on for a long time once two big empires face each other, which is why the default has a 10-minute limit.

### Layout

```
src/shared/    code used by both sides
  map.ts         map generation, distances and travel times
  battle.ts      Battle: orders, one tick (production, decay, arrivals, fights, knockouts), snapshots, checksums
  ai.ts          CPU players, with each level's style in one table
  constants.ts   speeds, build rates, caps, costs
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: orders, resyncs, the tick loop), game.ts (match rules)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas), input.ts (drag and tap orders),
               audio.ts (sounds), attract.ts (home-screen CPU demo)
test/          Vitest tests: maps, fights and the battle, client sync, CPUs, game flow
```

The room, lobby rules, router, socket, home/lobby/chat shell, base styles and build config come from `@warrick/kit` (`../../packages/kit`).
