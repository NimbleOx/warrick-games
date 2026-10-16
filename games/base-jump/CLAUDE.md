# Base Jump

A real-time base-capture game like *Modern Conflict* (iPad), with ideas from *Galcon* and *Mushroom Wars*. The map is a set of bases joined by roads. Every base you hold builds units. Send them out to take more bases: tanks have to drive along the roads, helicopters fly straight to any base. Take every base, or hold the most when time runs out.

## Rules for v1

- 2–8 players online, each on their own device. Drag from one of your bases to any other base to send units there; drag across several of your bases first to send from all of them. Or tap a base of yours, then tap the target. Tap empty ground or press Esc to clear the selection.
- Send size: 25%, 50% (default) or all of each selected base's units, picked in the HUD or with 1, 2, 3. A key or button for "select all my bases" (A).
- Two kinds of base, shown by their icon: **depots** build tanks, **airfields** build helicopters. A base holds both kinds if they arrive there.
- **Tanks** drive along roads only. A convoy can pass through any number of your own bases on the way, by the quickest road route. If a base on its route has changed hands by the time it gets there, the convoy stops and attacks it. If there's no road route through your bases, tanks can't go.
- **Helicopters** fly straight to any base, nearly twice as fast as tanks.
- When you send to a base, each selected base sends its tanks by road (if it can) and its helicopters by air. If it can do neither, the game says why. While aiming, the map shows each route, how many units would go, and whether that's enough against what's there now.
- Combat when units reach a base that isn't yours: like fights like first (tanks against tanks, helicopters against helicopters), then the rest. **One tank is worth two helicopters** in a fight, attacking or defending. The attackers take the base if any survive the garrison; a tie leaves the defender holding an empty base. Units arriving at your own base join its garrison. Units on the move don't fight each other.
- Production: each player's base builds one unit of its kind every so often, faster at higher levels, until it holds its cap (more units can still arrive). Neutral bases build nothing.
- Decay, from Mushroom Wars: a base holding more than its cap loses a twentieth of the excess (at least one unit) every second. Without it, CPU free-for-alls ended with two empires stacking thousands of units on their fronts and trading bases forever.
- Levels 1–3, shown by the base's size. Upgrading spends units in that base (15 for level 2, 30 for level 3) and raises its build rate and cap. Select one base and press Upgrade, or U.
- Start: everyone gets one level-2 depot with 15 tanks. Every other base is neutral with a garrison of tanks (bigger at higher levels). Every map has at least one airfield per player.
- A player with no bases and nothing on the move is out. The last one left wins. With a time limit (host picks 5, 10 or 15 minutes, or none; default 10), the most bases when time runs out wins, then the most units.
- Leaving mid-game makes your bases neutral and recalls your units. Disconnected players keep their bases; they keep building.
- CPU players (easy, normal, hard). Easy attacks the odd neighbour it can beat and doesn't defend. Normal picks targets by value against cost and travel time (by road or by air), reinforces bases under attack, moves units up from behind the front, and upgrades safe bases. Hard thinks about twice as often, goes all in from front-line bases when a capture needs it, gangs bases up on one target, and leans on the leader. Hard beats normal about 4 duels in 5; normal beats easy every time (README). Caution made CPUs weaker in every test, so keep that in mind when tuning.
- Not in v1: special powers (Modern Conflict's air strike), more unit types (artillery, missiles), fog of war, hand-made maps, teams. Design so they can be added.

## Design notes

- Map generation (`src/shared/map.ts`), seeded: scatter bases with best-candidate sampling, so they're spread out but not on a grid. Roads are the relative neighbourhood graph (connected, and it never crosses itself) plus a share of the extra Gabriel-graph edges, so there are loops and choices. Drop any road that passes too close to another base. Then pick the starting bases with farthest-point sampling over road distance, set the neutrals' kinds, levels and garrisons, and score the map for fairness (how many and how valuable the bases closest to each start are). Make several candidates and keep the fairest.
- The simulation (`src/shared/battle.ts`) is deterministic and integer-only: production counts in thousandths of a unit per tick, travel times are whole ticks fixed when units leave. Convoy and helicopter positions between bases are worked out from the departure and arrival ticks, so nothing moves in the state except at waypoints.
- Real-time like Turf War: the Durable Object steps the battle 10 times a second while a round is on and someone is connected. Players' commands (send, upgrade) are checked when they arrive (so mistakes come back as an error at once), queued, and applied at the start of the next tick. CPU commands go through the same path.
- Every tick the server broadcasts one frame: the tick number and the commands applied that tick. Clients run the same code on their copy of the battle, so the frame stays tiny. Every 50 ticks a frame carries a checksum; a mismatch or a gap makes the client ask for a snapshot. Snapshots (the map plus every base and group) go out at round start, in the welcome, and on request.
- The round lives in memory only. A deploy restarts the Durable Object; the first player back finds the round gone and it starts over on a new map.
- Rendering: canvas, roads first, then units in transit, then bases. The map is laid out landscape; on a portrait screen the client swaps x and y, so it fills a phone held upright. Hit-testing uses the same transform.

## How to build it

Built on `@warrick/kit` (`../../packages/kit`), like every game here. Turf War (`../turf-war`) is the closest real-time sibling: its tick loop, frames, checksums and resyncs are the model. Dice Dominion (`../dice-dominion`) has the nearest map generator. Read them for ideas; don't modify them.

- `src/worker/game.ts` is a `Lobby` subclass with the rules; `src/worker/room.ts` extends the kit's `Room` with the tick loop and the game's messages; `src/worker/index.ts` is `gameWorker("base-jump")`. On the client, `src/client/main.ts` creates the kit's `Shell` and adds the game screen.
- Dev port 5187 in `../../.claude/launch.json`. `localStorage` prefix `bj`.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- When a button has keyboard focus, let it own Space/Enter; don't also fire game hotkeys.
- Make every limit visible. If something stops a player from acting, the UI must say why: no road there, not enough units to upgrade, already level 3.

## Deploying

Served at `https://warrick.games/base-jump/` like the other games: a zone route `warrick.games/base-jump*`, `workers_dev: false`, `run_worker_first: ["/base-jump/api/*"]`, and `vite.config.ts` is `gameConfig("base-jump")`. Check a build with `npm run build && npx vite preview` before deploying. After the first deploy, add a card for it to `../../hub/public/index.html` (and an icon in `../../hub/public/icons/`) and deploy the hub.

Ask before deploying, committing or pushing.
