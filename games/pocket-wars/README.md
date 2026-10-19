# Pocket Wars

A multiplayer, browser-based tactics game like *Advance Wars*. Each player starts with an HQ and a factory on a hand-made grid map. On your turn you collect funds from your buildings, build units at your factories, then move each unit once and attack, capture or wait. Capture an enemy HQ, or wipe out an army, to knock that player out. The last player standing wins. 2–4 players, no accounts: one person creates a game and shares the 5-character code or the link.

It runs on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/pocket-wars/g/K7Q2M`. Send either one to your friends.
- The host picks the map, the turn timer (off, 60, 120 or 180 seconds) and whether CPUs move one unit at a time or fast (the host can switch that mid-game too), and can add CPU players (easy, normal or hard). There are three maps for two players (Pocket Duel, Twin Rivers and Mirror Lake), Three Crowns for three and Four Corners for four; *Auto* picks one for however many are playing.
- At the start of your turn every building you own pays 1,000 funds, and your units standing on your buildings are repaired by up to 2 HP, at 10% of the unit's price per HP, oldest unit first while the funds last.
- Tap a free factory of yours to build: Infantry 1,000, Bazooka 3,000, Recon 4,000, Artillery 6,000, Tank 7,000 or Heavy Tank 16,000. A new unit can act from your next turn.
- Tap one of your ready units to see where it can move, with the tiles it could then attack outlined. Tap a destination, then pick **Attack**, **Capture**, **Wait** or **Cancel**; until you pick, the unit can go back (Esc steps back too). To attack, tap a target to see the damage both ways, then tap it again or press **Attack**. Tap an enemy to see how far it can move and attack. **End turn** asks again if units are still ready.
- There's no luck in a fight: the damage depends on the two units, their HP and the cover the defender's tile gives (forests, cities and mountains help). A defender that survives hits back if it's next to the attacker. Artillery fires 2 or 3 tiles away, only if it hasn't moved, and nothing can hit back.
- Infantry and Bazookas capture buildings. Every building has 20 points, and each **Capture** takes off the unit's HP. If it moves off or is destroyed, the points go back to 20.
- You're out when your HQ is captured, when you have no units and can't build any, or when you resign, which you can do at any time, since games run long. The last army standing wins.
- Moving first is a big edge, so later seats start with extra funds: 4,000 for the second of two, 2,000 for the others in a game of three or four.
- On a phone, drag to pan the map and pinch to zoom. On a desktop, the mouse wheel zooms.
- When your clock runs out, your turn ends and your other units wait. Reloading the page puts you back in your seat, with the clock you had (reloading can't buy time). If the player whose turn it is isn't connected, their turn ends after 60 seconds, and the host can hand their seat to a normal CPU until they come back. Leaving mid-game leaves your army on the map. Anyone who joins mid-game watches until the next game.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/pocket-wars -- --port 5186  # http://localhost:5186/pocket-wars/, with the Worker and Durable Object in workerd
npm test -w games/pocket-wars                    # rules, movement, maps, balance, CPU, game-flow, room and event-queue tests (Node)
npm run typecheck -w games/pocket-wars
```

## Deploying

`npm run deploy -w games/pocket-wars` builds it and deploys it to **https://warrick.games/pocket-wars/**. The root README explains how the games share warrick.games. `localStorage` keys start with `pw.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /pocket-wars/api/games            → allocate a code, initialize that room
   │   GET  /pocket-wars/api/games/:code      → does the game exist?
   └─WS─ /pocket-wars/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code**, built on the kit's `Room`: the game state, each player's secret token and the chat/event log live in its storage, and it talks to browsers over hibernatable WebSockets, so a game costs nothing between actions. The board is in the state, saved after every action and every turn's end, so a deploy mid-game resumes exactly where it was.
- **The rules are pure functions** over a `Board` (units, building owners, capture points, funds and who's out) in `src/shared/`: the terrain and unit tables, pathfinding, damage, the action checks and their effects, the start of a turn, knockouts and the CPUs. The server, the CPUs and the home screen's demo, where CPUs play each other, all use them.
- **The maps are static data** (`src/shared/maps.ts`, drawn in ASCII), and the clients have them too, so the state carries only the map id, the building owners and capture points, and the units.
- **One message per unit action.** The client keeps a move to itself until you pick the action, which is how Cancel works, then sends the unit, its destination, the action and the target. The server checks all of it the same way for people and CPUs, and anything wrong comes back as an error you can read.
- **Each action is broadcast as an event** (the path, the damage both ways, what was destroyed, capture progress) carrying the state right after it. Clients queue the events and play them in order, the unit sliding along its path and then the attack, before they snap to the state that came with each. The queue keeps up with the server: an event plays faster when others are waiting, and a Fast CPU's step plays within the 120 ms before the next one. Events it skips to catch up show their damage numbers but make no sound. It skips events while three or more are waiting, and when your own turn arrives it skips everything still ahead of it. So your turn is yours as soon as it arrives, since its clock is already running.
- **One alarm drives every timer:** the turn clock, the minute an absent player has, each CPU step and the winner's banner. The turn clock is the kit's (`@warrick/kit/worker/turns`). Timers pause when nobody is connected, and a game with no connections for 12 hours is deleted.
- **CPU turns are a sequence of steps**, about a second apart unless the host turns on Fast CPUs. Each step picks the best-scoring action for one unit (or a build, or End turn), with every score in funds, and goes through the same checks as a person's action. Easy goes for the best target in reach and captures what it lands on. Normal only makes trades that come out ahead, keeps artillery out of reach and pulls hurt units back to repair. Hard also steers clear of tiles enemies can hit hard, focuses fire, guards its HQ and plans captures several turns ahead. From day 25 they grow bolder, so long games don't stall.
- **The canvas is drawn only when something on it changes or moves**, not on every frame.

### Balance

Seat 1 builds and moves first, and with no luck in a fight, whoever strikes first wins the exchange. In simulated games between two hard CPUs, seat 1 won 90–95% of 2-player games with no bonus and 35–45% with seat 2's 4,000 (`SEAT_FUNDS` in `src/shared/constants.ts`). `BALANCE=1 npx vitest run test/balance.test.ts` prints how often each seat wins on every map. Maps matter too: Twin Rivers first had each side's spare factory in the middle, and seat 1 won almost every CPU game even with 10,000 extra for seat 2; with each spare factory behind its own side's river, it's even. Playtests with people should check all of this.

### Layout

```
src/shared/    code used by both sides
  terrain.ts     terrain types, movement costs, defence, income and capture points
  units.ts       the unit table and the damage table
  maps.ts        the hand-made maps
  rules.ts       the Board, movement, damage, action checks and effects, turn start, knockouts
  ai.ts          CPU players
  constants.ts   seat funds, CPU pacing, animation timings, the away minute
  protocol.ts    settings, game state, events and message types
src/worker/    index.ts (routes), room.ts (Durable Object: messages and the alarm), game.ts (seats, turns, actions, timers)
src/client/    main.ts (the game screen, selection and menus, and its hooks into the shell),
               queue.ts (the queue of server events, and how it keeps up),
               render.ts (the map and units on a canvas, panning and zooming), audio.ts (sounds),
               attract.ts (the home screen's CPU demo)
test/          Vitest tests for the rules, movement, maps and their symmetry, the CPUs and the game flow, and room.test.ts,
               which runs the real room (reloads, restarts, stand-ins, events) through the kit's test harness;
               sim.ts plays CPU-only games, and balance.test.ts uses it; queue.test.ts plays the client's
               event queue against the real room and a Fast CPU
```

The room, lobby rules, router, socket, home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
