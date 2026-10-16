# Base Jump

A multiplayer, browser-based base-capture strategy game in the style of *Modern Conflict* (with a few ideas from *Galcon* and *Mushroom Wars*), for up to 8 players. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name.

Play it in **real time**, or in **turns**: everyone plans their orders at once, then watches the next five seconds of battle play out.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object that runs the battle.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/base-jump/g/K7Q2M`. Send either one to your friends.
- The host picks the mode, the map size (4, 6 or 8 bases a player) and the limits, and can add CPU players (easy, normal or hard). In real time the limit is the clock (5, 10 or 15 minutes, or none). In turns it's the number of turns (25, 40 or 60, or none) and the time to plan each one (15, 30 or 60 seconds, or no limit).
- Every map is new: bases joined by roads. **Depots** (round) build tanks; **airfields** (diamonds) build helicopters. Everyone starts with one depot and 15 tanks; the rest of the bases are neutral and guarded.
- Drag from one of your bases to any base to send units there. Sweep across more of your bases on the way to send from all of them. Or tap your base, then the target. **25% / 50% / All** (or keys 1, 2, 3) sets how much of each base goes.
- **Tanks drive along roads**, through any of your own bases on the way. **Helicopters fly straight** to anywhere, nearly twice as fast. While you aim, the map shows each route, how many units would go, and whether that's enough to take the base right now.
- Fights: like fights like first, and one tank is worth two helicopters. If any attackers are left, the base is theirs. Units on the move don't fight each other.
- Bases build up to a cap. Upgrade one (U, or the Upgrade button) by spending units in it: it builds faster and holds more. The dots above a base show its level, and the button shows how many units the next level needs. A base holding more than its cap slowly loses the excess, so don't hoard.
- **In turns**, nothing moves while everyone plans. Your orders show as arrows with when they'll land, and your bases show what's left after them. **Undo** (Backspace) takes back the last one. Press **Done** (Enter) when you're ready; the turn plays once everyone still in is done, or when time to plan runs out. A player who drops out gets 15 seconds to come back once everyone else is done; then the turn plays without them. Nobody sees anyone else's orders until the turn plays.
- Take every base to win, or hold the most when time (or the last turn) runs out. Reloading the page puts you back in your seat, plan and all; players who join mid-round watch until the next one. An update to the game restarts a real-time round on a new map. A round in turns carries on: plans and all while everyone plans, or replaying the turn that was playing out.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/base-jump -- --port 5187  # http://localhost:5187/base-jump/, with the Worker and Durable Object in workerd
npm test -w games/base-jump                    # map, battle, CPU, sync and game-flow tests (Node)
npm run typecheck -w games/base-jump
```

Editing worker code restarts the Durable Object, which also shows what a deploy does to a round in progress: in real time it starts over on a new map; in turns, planning carries on as it was, and a turn that was playing out plays again from its start.

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

- **The server runs the battle** 10 ticks a second while it's running and someone is connected (the kit's tick loop): all round long in real time, and for 50 ticks a turn in turns. The loop stops when the round ends, while everyone plans, or when everyone leaves, so idle games can hibernate. The battle lives in memory; a restart starts a real-time round over on a new map. In turns the object can also hibernate while everyone plans, so the room saves the battle as each turn's planning begins and the plans as they change, and brings the round back from them whenever an event finds it gone (`restore`): planning carries on, and a turn cut off mid-run plays again from its start with the same orders.
- **Clients send orders** (`send` from some bases to a base at a percentage, or `up` to upgrade one). The server checks each order as it arrives, so a mistake comes straight back as an error ("No road there through your bases…"). In real time it queues the order and applies it at the start of the next tick, and CPU orders go through the same path.
- **In turns**, an order goes into the player's plan instead, checked against the battle as the plan so far would leave it, and the server sends the plan back to that player alone (`plan`). `undo` takes the last one back, and `done` says the player is ready. The state carries the turn: its number, whether everyone is planning or it's running, the tick it's planned at, the deadline (the room's alarm) and who is done. Once everyone still in is done (players who have dropped out get `AWAY_MS` to come back, once they're all that's left), or at the deadline, every plan goes into the queue for the next tick (a different player's first each turn, since units reaching a base on the same tick fight in the order they left), and the battle runs `TURN_TICKS` ticks. CPUs make their plans the moment planning starts, on a copy of the battle.
- **Every tick the server broadcasts one frame**: the tick number and the orders applied that tick, usually under 30 bytes. The battle (`src/shared/battle.ts`) is deterministic and integer-only (production counts thousandths of a unit, travel times are whole ticks fixed when units leave), so every client runs the same frames on its own copy and stays in step. Units glide between bases on the client from their departure and arrival ticks. Every 50 ticks a frame carries a checksum; a mismatch or a gap makes the client ask for a snapshot.
- **Snapshots** (the map plus every base and unit group, a few KB) go out at round start, in the welcome message, and on request.
- **Maps** (`src/shared/map.ts`) are generated from a seed: bases scattered by best-candidate sampling, roads from the relative neighbourhood graph plus some extra Gabriel-graph edges (connected, never crossing), starting bases by farthest-point sampling over road distance, every start's nearest neighbour the same easy depot, and a guaranteed share of airfields. Each map is the fairest of 24 candidates, by how even the starts are.
- **CPU players** (`src/shared/ai.ts`) pick attacks by value against cost and travel time, sized for what holds the target. Normal and hard also send help to bases that would fall to what's coming, push units from behind the front, and upgrade safe bases. Hard thinks about twice as often, goes all in from front-line bases when that's what a capture takes, and gangs several bases up on one target. In turns, a CPU looks once a turn, makes more attacks in that look, and sizes them for what the target will hold when they arrive: what it builds on the way and help already heading there.

### CPU strength

Measured in CPU-against-CPU duels, seats swapped every other game, half on small maps and half on medium:

| Matchup | Real time: wins (stronger side) | Typical length | Turns: wins (stronger side) | Typical length |
| --- | --- | --- | --- | --- |
| Hard vs normal | 129 / 160 (81%) | ~95 s | 129 / 160 (81%) | ~31 turns |
| Normal vs easy | 160 / 160 | ~115 s | 160 / 160 | ~35 turns |
| Hard vs easy | 160 / 160 | ~85 s | 160 / 160 | ~27 turns |

While tuning hard in real time, caution never paid: bigger safety margins, keeping reserves against nearby enemies, and expecting the defender to reinforce all made a CPU weaker against normal. Thinking faster on its own didn't help either. What did help was being free to send everything from a front-line base, and doing it soon. Even sizing attacks for what the target builds before they arrive made real-time CPUs weaker (hard won 77% instead of 80% over 480 duels), so in real time they size them for what's there now.

Turns are different: an order can't be followed up until the next turn, so CPUs size attacks for what they'll find when they arrive. Without that, hard beat normal only 70% of the time.

Large free-for-alls between normal CPUs can grind on for a long time once two big empires face each other, which is why both modes have a limit by default. In turns, CPU free-for-alls take a median of about 80 turns with four players and often run past 200 with six or more, so the 40-turn default usually decides a bigger game by bases held.

### Layout

```
src/shared/    code used by both sides
  map.ts         map generation, distances and travel times
  battle.ts      Battle: orders, one tick (production, decay, arrivals, fights, knockouts), snapshots, checksums,
                 and a plan's preview
  ai.ts          CPU players, with each level's style in one table (and one for turns)
  constants.ts   speeds, build rates, caps, costs, the turn's length
  protocol.ts    settings, game state and message types
src/worker/    index.ts (routes), room.ts (Durable Object: orders, resyncs, the tick loop, the turn's alarm),
               game.ts (match rules, both modes)
src/client/    main.ts (the game screen and its hooks into the shell), render.ts (canvas), input.ts (drag and tap orders),
               audio.ts (sounds), attract.ts (home-screen CPU demo)
test/          Vitest tests: maps, fights and the battle, client sync, CPUs, game flow, turns
```

The room, lobby rules, router, socket, home/lobby/chat shell, base styles and build config come from `@warrick/kit` (`../../packages/kit`).
