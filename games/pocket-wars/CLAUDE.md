# Pocket Wars

A small turn-based tactics game like *Advance Wars*, for 2–4 players. Each player starts with an HQ and a factory on a hand-made grid map. On your turn you collect funds from your buildings, build units at your factories, then move each unit once and attack, capture or wait. Capture an enemy HQ, or wipe out an army, to knock that player out. The last player standing wins.

## Rules for v1

- 2–4 players online, each on their own device, plus CPUs (easy, normal, hard). The lobby holds 4. Seats are dealt out at random when the game starts. Seat 1 moves first, and the order stays the same all game. A *day* is one turn for every player.
- **Maps.** Hand-made maps, shipped as ASCII data in `src/shared/maps.ts`, at most 20 × 15 so they fit a phone. Each map is for an exact number of players. The host picks one in the lobby, or *Auto* picks one at random for however many players there are. v1 ships three 2-player maps (Pocket Duel, a quick 11 × 8; Twin Rivers; Mirror Lake), one 3-player map (Three Crowns) and one 4-player map (Four Corners). The 2-player maps have 180° rotational symmetry, the 4-player map is mirrored on both axes, and the 3-player map is mirrored left to right with the third seat on the axis. A test checks the symmetry.
- **Terrain.** Plains, road, bridge (a road over a river), forest, mountain, river and sea, plus three kinds of building: HQ, city and factory. Each terrain has a movement cost for each movement type and gives a unit standing on it 0–4 defence stars:

  | Terrain | Foot | Boots | Wheels | Treads | Defence |
  | --- | --- | --- | --- | --- | --- |
  | Plains | 1 | 1 | 2 | 1 | 1 |
  | Road, bridge | 1 | 1 | 1 | 1 | 0 |
  | Forest | 1 | 1 | 3 | 2 | 2 |
  | Mountain | 2 | 1 | – | – | 4 |
  | River | 2 | 1 | – | – | 0 |
  | Sea | – | – | – | – | 0 |
  | City, factory | 1 | 1 | 1 | 1 | 3 |
  | HQ | 1 | 1 | 1 | 1 | 4 |

- **Buildings.** Each player starts with an HQ and a factory, and some maps give them a city too. The other cities and factories start neutral. Every building you own pays 1,000 funds at the start of your turn. A factory you own builds one unit per turn if nothing is standing on it. The new unit can't act until your next turn.
- **Units.** All the stats live in one table in `src/shared/units.ts`:

  | Unit | Cost | Move | Movement | Range | Captures |
  | --- | --- | --- | --- | --- | --- |
  | Infantry | 1,000 | 3 | foot | 1 | yes |
  | Bazooka | 3,000 | 2 | boots | 1 | yes |
  | Recon | 4,000 | 8 | wheels | 1 | |
  | Tank | 7,000 | 6 | treads | 1 | |
  | Heavy Tank | 16,000 | 5 | treads | 1 | |
  | Artillery | 6,000 | 5 | treads | 2–3 | |

  No air or naval units, ammo or fuel in v1.
- **Your turn.** First you collect funds from every building you own, and each of your units standing on one of your buildings is repaired by 2 HP. A repair costs 10% of the unit's price per HP, and it's skipped if you can't pay. Then you build, and move each unit once in any order. Pick a unit and a destination within its movement range, then give it one action: **Attack**, **Capture** or **Wait**. Until you choose the action you can cancel the move and the unit goes back. Press **End turn** when you're done. Units you didn't move just stay where they are.
- **Moving.** A unit can move through your own units but not through enemies, and can't stop on a tile that's taken. Staying put counts as a move.
- **Combat.** Units have 10 HP. Damage is deterministic, with no luck: `round(base × attackerHP/10 × (100 − stars × defenderHP)/100)` in HP, where `base` comes from the damage table below (the percentage a 10-HP attacker does to a defender on a 0-star tile). A defender that survives hits back at once with its new HP, if it's direct-fire and next to the attacker. Before you confirm an attack, the game shows the damage both ways.

  | Attacker ↓ / Defender → | Inf | Baz | Recon | Tank | Heavy | Art |
  | --- | --- | --- | --- | --- | --- | --- |
  | Infantry | 55 | 45 | 12 | 5 | 1 | 15 |
  | Bazooka | 65 | 55 | 85 | 55 | 15 | 70 |
  | Recon | 70 | 65 | 35 | 6 | 1 | 45 |
  | Tank | 75 | 70 | 85 | 55 | 15 | 70 |
  | Heavy Tank | 105 | 95 | 105 | 85 | 55 | 105 |
  | Artillery | 90 | 85 | 80 | 70 | 45 | 75 |

- **Artillery** fires at range 2–3 (Manhattan distance), only if it hasn't moved this turn, and never hits back. Units it hits never hit back either, because it's out of their reach.
- **Capturing.** Every building has 20 capture points. Infantry or a Bazooka standing on a building you don't own can **Capture**: the points drop by its current HP. At 0 the building is yours and the points go back to 20. If the capturing unit moves off or is destroyed, the points reset to 20.
- **Knocked out.** You're out when your HQ is captured, when you resign, or when you have no units and can't build any: no factory of yours is free, or you can't afford Infantry after collecting funds. That's checked at the start of your turn, and at once if you have no units and no factories. Your units are removed and your buildings turn neutral, except a captured HQ, which the captor keeps and which pays them like a city. You can resign from the game screen at any time, since games run long. The last player standing wins. Then come the standings: the winner, then everyone else by how long they lasted.
- **Turn timer.** The host picks off, 60, 120 or 180 seconds (default 120). When it runs out, your turn ends and the units that haven't acted just wait. If the player whose turn it is isn't connected, their turn ends after 60 seconds (sooner if their clock runs out first). The host can hand any missing player's seat to a normal CPU. The player takes it back when they return.
- **CPU players**:
  - *Easy* attacks the best target it can reach (the most damage by value). Otherwise it moves toward the nearest enemy, or the nearest city it doesn't own, and captures what it lands on. It builds random units it can afford.
  - *Normal* scores attacks by the value of the damage it deals minus the value of the counter-damage it takes (HP × unit cost), and only makes attacks that come out ahead. It sends infantry to capture, a different building for each one. It keeps artillery out of reach of enemy direct-fire units, prefers good defensive terrain and pulls badly damaged units back to its cities to repair. It builds infantry for the first three days, then counters to what the enemy fields (the most value won per factory slot), plus enough infantry to keep capturing.
  - *Hard* adds a threat map, so it avoids ending a move where enemies can hit it hard (the strongest attacker counts in full, each extra one less). It adds a bonus for kills, so it focuses fire to finish units. It guards its HQ (enemy capturers near it come first, and it blocks the HQ tile when they're close), and it plans captures several turns ahead by matching capturers to buildings by travel time.
  - From day 25 the CPUs grow bolder, reaching full boldness by day 50: they push harder, mind threats less and accept slightly losing trades, so long games between careful armies don't stall.
  - CPU moves play out one unit at a time, about a second apart, so people can follow. The host can turn on **Fast CPUs** in the lobby or during the game.
- **Not in v1:** fog of war, air and naval units, ammo and fuel, transports, joining damaged units, commanders and their powers, weather, random maps, a map editor, teams, and spectator chat. Design so they can be added: movement types, terrain and units are data tables, and the rules look up range, captures and counterattacks from the unit table, not by unit name.
- **First-move advantage.** Seat 1 builds and moves first, which is a big edge here: damage is deterministic, so whoever strikes first wins the exchange. Later seats get extra starting funds (`SEAT_FUNDS` in `src/shared/constants.ts`): seat 2 of 2 starts with 4,000, and seats 2–4 of 3 or 4 start with 2,000. In simulated games between two hard CPUs, seat 1 won 90–95% of 2-player games with no bonus and 35–45% with it. Playtests with people should check this.

## Design notes

- **Pure rules in `src/shared/`.** The terrain and unit tables, the maps, pathfinding, damage, the action checks and their effects, turn start (income, repairs), elimination and the CPU are all pure functions over a `Board`: units, building owners, capture points, funds and who's out. The server and the CPU use the same functions, and so does the home screen's demo, where CPUs play each other. Vitest tests them directly.
- **The map is static data.** `MAPS[id]` has the size, terrain per tile and the building list (position, kind, starting owner). The state carries only the map id, the building owners and capture points (indexed like the map's building list) and the units. Clients have the maps too, so they never come over the wire.
- **Movement** is Dijkstra over the terrain cost for the unit's movement type, with the move points as budget. Enemy units block, your own units can be passed through, and a unit can stop only on an empty tile or where it started. The result has the cost and previous tile of each reachable tile, so the path can be drawn and animated.
- **One message per unit action.** The client keeps the move to itself until you choose the action, which is how cancelling works. Then it sends `{ t: "act", unit, to, action, target? }`. The server checks everything: that it's your turn, the unit is yours and hasn't acted, the destination is reachable and free, the attack is in range (artillery hasn't moved), the capture is allowed. Builds are `{ t: "build", at, unit }` (your factory, free, enough funds). Anything wrong comes back as an error the player can read.
- **Broadcast each action, then animate.** Each action goes out as an event (the path, the damage both ways, what was destroyed, capture progress), together with the state after it. Turn starts go out the same way (income, repairs). Clients queue these and play them in order: the unit slides along its path, then the attack and the numbers, then they snap to the state that came with the event. A burst of queued events plays faster, so Fast CPUs and reconnects don't fall behind. The game is saved after every action and turn end, so a deploy mid-game resumes exactly where it was.
- **The UI.** Tap one of your ready units to see where it can move, with the tiles it could then attack outlined. Tap a destination and the unit moves there, and a small menu offers Attack, Capture, Wait and Cancel. For Attack, the targets are highlighted. Tap one to see the forecast (damage both ways), and tap it again or press Attack to fire. Tap a free factory of yours to open its build menu. Tap an enemy to see how far it can move and attack. The HUD shows the day, whose turn it is, the clock, your funds and income, and an End turn button that asks again if units are still ready. Units show their HP when it's under 10, and done units are greyed out. On phones the map pans with a drag and zooms with a pinch, and a mouse wheel zooms on desktop.
- **CPU turns are a sequence of steps.** Each one picks the best-scoring action for one unit given the board as it is now (or a build, once the units are done, or End turn). Scores are in funds, so attacks, captures and moves compare. A unit whose best option is to stay put is skipped. Every step goes through the same check a human action does. A test plays whole CPU games on every map at every level and checks that every step is legal.
- **Balance checks.** `test/sim.ts` plays CPU-only games with the pure rules. `BALANCE=1 npx vitest run test/balance.test.ts` prints how often each seat wins on every map, for tuning `SEAT_FUNDS` and the maps.
- **Dev aid.** In `npm run dev`, the console can play your seat with a CPU: `__pw.autoplay("hard")` (and `null` to stop). That's how full games against every level were played in the preview.

## How to build it

Built on `@warrick/kit` (see `../../packages/kit/README.md`), starting from Crater Club in `../crater-club`, which is turn-based and on the kit. Read its README first. Dice Dominion in `../dice-dominion` is another turn-based kit game with a seat takeover, Fast CPUs and stand-ins, so it's worth reading too. Read the other games for ideas, but don't modify them.

- Cloudflare Worker + Vite, TypeScript, no client framework, canvas rendering. One Durable Object per 5-character room code, with the kit's `Room` doing sockets, tokens, storage, cleanup and the alarm.
- `vite.config.ts` is `gameConfig("pocket-wars")`, and `src/worker/index.ts` exports `GameRoom` and `gameWorker("pocket-wars")`. The tsconfigs extend `@warrick/kit/tsconfig.base.json`.
- `src/worker/game.ts` is the `Game` class: it extends the kit's `Lobby` and turns the pure rules into turns, timers, CPU steps, takeovers and messages. `src/worker/room.ts` extends `Room` with `timerAt` and `handle` for the game's own messages.
- `src/client/main.ts` makes a kit `Shell` with prefix `pw` and `maxPlayers: 4`. The shell does the home card, the lobby and chat, so `index.html` holds only the game screen. `render.ts` draws the map, units, overlays and animations on a canvas with a pan-and-zoom camera. `attract.ts` is the home-screen demo, and `audio.ts` builds the sounds from the kit's tones.
- Dev port 5186, reserved in `../../.claude/launch.json`: run `preview_start {name: "pocket-wars"}` or `npm run dev -w games/pocket-wars`, and the game is at `http://localhost:5186/pocket-wars/`. The game's row is in the table in `../../README.md`.

### Turn-based, like Crater Club

- No tick loop. The Durable Object handles each action as it arrives and checks it.
- One alarm drives every timer: the turn clock, an away player's 60 seconds, the CPU's next step and the winner's banner. Timers pause when nobody is connected. A game with no connections for 12 hours is deleted.
- Hibernatable WebSockets let the object sleep between actions.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot, and drop whatever animation queue they had.
- When a button has keyboard focus, let it own Space/Enter, and don't also fire game hotkeys. Blur buttons after clicks in the game screen.
- Make every limit visible. If something stops a player from acting, the UI must say why: not your turn, already moved, artillery can't move and fire, not enough funds, the factory is blocked.
- A message that carries `state` stands in for the room's own state message (see the kit's `Room.flush`). Events carry the state after them, so clients can animate and then snap to it.
- Drive the animation queue with timers, not `requestAnimationFrame`. Frames stop in background tabs (and in a hidden preview pane), and a queue that waits on them never applies the next state. Prune canvas effects when they're added, too, not only when a frame draws them.
- Symmetric isn't fair if both sides race for the same objective: seat 1 wins the ties. Twin Rivers first had each side's spare factory in the middle, 9 and 10 tiles from the two HQs, and seat 1 won almost every CPU game even with 10,000 extra for seat 2. With each spare factory behind its own side's river, it's even. Give each seat its own expansion and keep the contested buildings few.
- CPU-only simulations are cheap (a 2-player game takes about 0.1 seconds), so measure CPU strength and seat balance with a few hundred games, never one. Seat order swamps level differences on small maps, so compare levels from both seats.
- Before attaching a custom domain, check DNS against the zone's authoritative nameservers (`dig @mina.ns.cloudflare.com <name>`), not the local resolver, which caches the "doesn't exist" answer for 30 minutes.

## Deploying

Cloudflare, the same account as the other games. The game is served at `https://warrick.games/pocket-wars/`: a path on the shared site, not a subdomain. The hub at the root is its own Worker in `../../hub`, with `warrick.games` as a Custom Domain. This game gets its own Worker with a zone route on the same hostname, and routes take precedence over a Custom Domain.

- `wrangler.jsonc`: the route `{ "pattern": "warrick.games/pocket-wars*", "zone_name": "warrick.games" }` (a zone route, not a custom domain), `workers_dev: false`, `preview_urls: false`, `not_found_handling: "single-page-application"` and `run_worker_first: ["/pocket-wars/api/*"]`. One Durable Object binding, `GAME_ROOM` → `GameRoom`, with a `new_sqlite_classes` migration.
- The kit's `gameConfig` sets Vite's `base` to `/pocket-wars/` and moves the client build into `dist/client/pocket-wars/`, because Workers static assets are looked up by request path and ignore Vite's `base`. The shell builds every URL from `import.meta.env.BASE_URL`. Check with `npm run build && npx vite preview` before deploying.
- `localStorage` keys are prefixed `pw.`, since every game shares the warrick.games origin.
- Deploy with `npm run deploy -w games/pocket-wars`. Then turn the game's card in `../../hub/public/index.html` from "Coming soon" into a link, and deploy the hub with `npm run deploy -w hub`.

Ask before deploying, committing or pushing.
