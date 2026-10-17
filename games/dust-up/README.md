# Dust Up

A multiplayer side-on dirt bike race, after _Dirt Bike_ (1995), the classic Mac shareware game. Everyone rides the same course at the same time and sees the other riders as ghosts: ride right through them. Wheelie, land your jumps, keep your head off the dirt. The fastest time wins the course, and the most points wins the series. There are no accounts: one person creates a game, shares the 5-character code (or the link), and everyone else joins with just a name. On your own, it's a time trial against your best run.

It runs entirely on Cloudflare: a Worker serves the client and the API, and each game is one Durable Object.

## Playing

- **Create game** gives you a code like `K7Q2M` and a link like `https://warrick.games/dust-up/g/K7Q2M`. Send either one to your friends. **Ride solo** (or the hub's Solo button) starts a time trial straight away.
- The host picks how many courses, how long and how hard they are, how long everyone has to finish after the winner, and can add CPU riders (easy, normal or hard).
- **Keyboard:** ↑, W or Space for gas, ↓ or S to brake, ← → or A D to lean back and forward, R to go back to the last checkpoint, G to show or hide your best run.
- **Mouse**, like the original: click the course, then hold the button for gas and move the mouse left and right to lean. The right button brakes; Esc lets go of the mouse.
- **Touch:** lean buttons on the left; back-to-checkpoint, brake and gas on the right.
- Lean back with the gas on to lift the front wheel; lean in the air to land on both wheels. Your head or body touching the ground, landing upside down or falling into a pit is a crash: 1.5 s later you're back at the last checkpoint, and the clock keeps running.
- A course ends when everyone has finished, or a set time after the first rider does. Points: 10, 8, 6, 5, 4, 3, 2, 1 by place, none for a DNF.
- Your best run on each course rides beside you as a ghost, and your split at each checkpoint shows how you're doing against it and against the leader.
- Reloading the page puts you back on your bike. Anyone who joins mid-series watches until the next course. If everyone leaves mid-course, the course waits and goes on with a countdown when someone comes back.

## Development

From the repo root, after `npm install` there:

```bash
npm run dev -w games/dust-up -- --port 5188  # http://localhost:5188/dust-up/, with the Worker and Durable Object in workerd
npm test -w games/dust-up                    # bike, course, CPU, game-rule and room tests (Node)
npm run typecheck -w games/dust-up
```

In development, `__du.autopilot("hard")` in the console rides your bike with a CPU pilot (`null` gives it back), and `?lag=150` on the URL adds round-trip delay.

**Determinism.** The client and the worker must step every bike the same, bit for bit (see `CLAUDE.md`). `test/bike.test.ts` replays two recorded rides on the sandbox course (`src/shared/sandbox.ts`) and checks their hashes. `check.html` replays the same rides in a browser and times a step; open `/dust-up/check.html` on a build or the live site in each browser. It passes in Node, Chrome and Safari's JavaScriptCore; Firefox hasn't been checked yet. If you change the physics on purpose, the golden hashes in `test/fixtures` change too.

**CPU strength.** `MEASURE=1 npx vitest run test/ai.test.ts --silent=false` (in this folder) rides 200 short courses per CPU level and difficulty (`MEASURE=500` for more) and prints a table. On an Apple M4 Max, 200 short courses each:

| Courses | CPU | Finished | Mean time | Crashes per course |
| --- | --- | --- | --- | --- |
| easy | easy | 200/200 | 38.5 s | 0.07 |
| easy | normal | 200/200 | 28.9 s | 0.33 |
| easy | hard | 200/200 | 24.6 s | 0.01 |
| normal | easy | 200/200 | 42.2 s | 0.30 |
| normal | normal | 200/200 | 31.7 s | 0.43 |
| normal | hard | 200/200 | 26.6 s | 0.01 |
| hard | easy | 200/200 | 48.5 s | 0.93 |
| hard | normal | 200/200 | 34.6 s | 0.64 |
| hard | hard | 200/200 | 28.1 s | 0.03 |

So normal takes about a fifth longer than hard, and easy over half as long again. A CPU costs about 75 µs of planning and riding per tick for hard, 35 for normal and 12 for easy: seven hard CPUs in one room are about 6% of a core.

## Deploying

`npm run deploy -w games/dust-up` builds it and deploys it to **https://warrick.games/dust-up/**. The root README explains how the games share warrick.games. `localStorage` keys start with `du.`.

## How it works

```
browser ──HTTP──▶ Worker ──▶ static assets (client)
   │                │
   │   POST /dust-up/api/games            → allocate a code, initialize that room
   │   GET  /dust-up/api/games/:code      → does the game exist?
   └─WS─ /dust-up/api/games/:code/ws ──▶ GameRoom Durable Object (one per code)
```

- **One Durable Object per game code.** It holds the game state, each player's secret token, and the chat and event log in storage, and talks to browsers over hibernatable WebSockets, so idle games cost nothing.
- **Your bike runs on your screen first.** The physics (`src/shared/bike.ts`) is deterministic, so your screen steps your bike as you ride, and sends your inputs ten times a second; the room steps the same bike from them and is the judge of checkpoints, crashes and times. Hashes in the room's frames check the two agree, and if they don't, your screen takes the room's bike.
- **The room runs the race.** While a course is ridden, the room's tick loop runs ten times a second: it steps every bike (humans from their inputs, CPUs from their pilots) and sends a frame with everyone's pose. Other riders are drawn a quarter of a second behind the clock, smoothly between frames.
- **Courses are generated from a seed** (`src/shared/course.ts`), the same on every screen and in the room: only the seed, length and difficulty go over the wire.
- **CPU riders** (`src/shared/ai.ts`) plan by trying a handful of input plans ahead on a copy of their bike and riding the best. The home screen's demo race uses the same pilots.
- **The race lives in memory only**; scores, settings and the series are in storage. A deploy restarts the course from the gate. **One alarm drives the countdown and the pause after each course.** A game with no connections for 12 hours is deleted.

### Layout

```
src/shared/    constants, the bike, the ground and courses, a ride (checkpoints, crashes, respawns),
               your own bike on your screen (local.ts), CPU pilots, protocol types, and the sandbox
               course the determinism fixtures ride
src/worker/    index.ts (routes), room.ts (Durable Object: ride messages, the tick loop, the timers),
               game.ts (the series, courses, finishes and points), race.ts (every bike on the course)
src/client/    main.ts (the shell, the loop, HUD and results), race.ts (the course on screen),
               ghosts.ts (other riders, your best runs), input.ts (keys, mouse, touch), render.ts
               (canvas), audio.ts (sounds and the engine), attract.ts (home-screen demo),
               check.ts (the determinism check page)
test/          bike, course, CPU, game-rule and room tests, and the golden rides
```

The room, lobby rules, router, socket (with the heartbeat that keeps a riding room within its CPU budget), home/lobby/chat shell and base styles come from `@warrick/kit` (`../../packages/kit`).
