# Pocket Wars

A small turn-based tactics game like *Advance Wars*, for 2–4 players. Each player starts with an HQ and a factory on a hand-made grid map. On your turn you collect funds from your buildings, build units at your factories, then move each unit once and attack, capture or wait. Capture an enemy HQ, or wipe out an army, to knock that player out. The last player standing wins.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

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
- **Your turn.** First you collect funds from every building you own, and each of your units standing on one of your buildings is repaired by up to 2 HP, never past full, oldest unit first. A repair costs 10% of the unit's price per HP, and a unit gets only the HP the funds left can pay for, so it may get 1 or none. Then you build, and move each unit once in any order. Pick a unit and a destination within its movement range, then give it one action: **Attack**, **Capture** or **Wait**. Until you choose the action you can cancel the move and the unit goes back. Press **End turn** when you're done. Units you didn't move just stay where they are.
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
- **Turn timer.** The host picks off, 60, 120 or 180 seconds (default 120). When it runs out, your turn ends and the units that haven't acted just wait. If the player whose turn it is isn't connected, their turn ends after 60 seconds (sooner if their clock runs out first). Someone who comes back mid-turn gets the clock they had, never more, so reloading can't buy time; if it had nearly run out, they get 5 seconds, once a turn. (The kit's turn clock, `@warrick/kit/worker/turns`, keeps these rules.) The host can hand any missing player's seat to a normal CPU. The player takes it back when they return.
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
- **Broadcast each action, then animate.** Each action goes out as an event (the path, the damage both ways, what was destroyed, capture progress), together with the state after it: a copy made when the event is queued, since the room sends the outbox only once the whole action is done (ending your turn when the next player has nothing left sends their turn, which knocks them out, and the one after it, each with its own state). The last event of an action carries the state at the end of it, because the room sends no state message of its own after an event that carries one. Turn starts go out the same way (income, repairs). Clients queue these and play them in order: the unit slides along its path, then the attack and the numbers, then they snap to the state that came with the event. Timers drive the queue (`src/client/queue.ts`), not animation frames. It has to keep up, because your turn clock starts when the server starts your turn: an event plays faster with others waiting behind it (0.6× with one, 0.3× with two), and a Fast CPU's step plays within `CPU_FAST_MS`, the gap before the next one. While three or more events are waiting (`SNAP_BACKLOG`), or your own turn is waiting behind them, the event playing finishes and the next ones are applied at once, showing their effects without sounds, so at most two wait and your turn waits for nothing. `test/queue.test.ts` plays the queue against the real room: with Fast CPUs your turn waits for nothing, and at normal speed every event plays at full length. The game is saved after every action and turn end, so a deploy mid-game resumes exactly where it was.
- **Drawing.** The canvas is drawn when what it shows changes (the state, the selection, the mouse, the camera, a resize) and while something on it moves (an animation, effects, the pulsing selection), not on every frame. Work a selection needs, like the tiles its unit could attack, is done once when it's picked.
- **The UI.** Tap one of your ready units to see where it can move, with the tiles it could then attack outlined. Tap a destination and the unit moves there, and a small menu offers Attack, Capture, Wait and Cancel. For Attack, the targets are highlighted. Tap one to see the forecast (damage both ways), and tap it again or press Attack to fire. Tap a free factory of yours to open its build menu. Tap an enemy to see how far it can move and attack. The HUD shows the day, whose turn it is, the clock, your funds and income, and an End turn button that asks again if units are still ready. Units show their HP when it's under 10, and done units are greyed out. On phones the map pans with a drag and zooms with a pinch, and a mouse wheel zooms on desktop.
- **CPU turns are a sequence of steps.** Each one picks the best-scoring action for one unit given the board as it is now (or a build, once the units are done, or End turn). Scores are in funds, so attacks, captures and moves compare. A unit whose best option is to stay put is skipped. Every step goes through the same check a human action does. A test plays whole CPU games on every map at every level and checks that every step is legal.
- **Balance checks.** `test/sim.ts` plays CPU-only games with the pure rules. `BALANCE=1 npx vitest run test/balance.test.ts` prints how often each seat wins on every map, for tuning `SEAT_FUNDS` and the maps.
- **Fair maps.** Symmetric isn't fair if both sides race for the same objective: seat 1 wins the ties. Twin Rivers first had each side's spare factory in the middle, 9 and 10 tiles from the two HQs, and seat 1 won almost every CPU game even with 10,000 extra for seat 2. With each spare factory behind its own side's river, it's even. Give each seat its own expansion and keep the contested buildings few.
- **Dev aid.** In `npm run dev`, the console can play your seat with a CPU: `__pw.autoplay("hard")` (and `null` to stop). That's how full games against every level were played in the preview.
