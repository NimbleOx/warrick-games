# Dust Up: dev plan

A side-on motorbike race game based on _Dirt Bike_ (Brad Quick and Michel de Messieres, 1995), a classic Mac shareware game. In the original you rode bumpy courses against the clock using only the mouse: left and right tilted the bike (fall over and you crash), and up and down set your speed. It saved your best runs as ghosts you could race against.

Dust Up turns those ghosts into a party game. Everyone rides the same course at the same time, and you see each other's bikes as ghosts. You ride through them, so racing comes down to riding well, not barging. The fastest time wins the course, and a game is a short series of courses.

This file is the brief to build from. Once the game is built, its rules and design notes move into the game's `README.md` and `CLAUDE.md`, like the other games', and this file is deleted.

## Rules for v1

- 1–8 riders online, each on their own device, plus CPU riders. With one player the start button reads "Play solo": a time trial against your own best ghost.
- Everyone starts at the gate together after a 3-second countdown. Bikes are held at the gate until it drops, but you can rev.
- **Controls:** throttle, brake, lean back and lean forward.
  - **Keyboard:** Up or W throttles, Down or S brakes, Left or A leans back, Right or D leans forward. R respawns at the last checkpoint if you're stuck.
  - **Mouse**, like the original: hold the button to throttle, move left and right to lean (pointer lock, so leaning is analog), and use the right button to brake.
  - **Touch:** hold the right half of the screen to throttle, use two lean buttons on the left, and a brake button.
- **Leaning** shifts the rider's weight. On the ground, leaning back lifts the front wheel (a wheelie) and leaning forward presses it down. In the air, it rotates the bike, so you land on both wheels.
- **The course** runs left to right, from the start gate to the finish flag, with checkpoints along the way. Obstacles are made from the shape of the ground: whoops (rows of bumps), kickers, tabletops, gaps, step-ups, drops, steep hills, logs and rocks.
- **Crashing:** if the rider's head or body touches the ground, or the bike lands upside down, you crash. After 1.5 seconds you respawn at the last checkpoint, upright and at a standstill. The clock keeps running, so a crash costs time but never ends your race.
- **A course ends** when everyone has finished, or when the finish window closes (the host picks 15, 30 or 60 seconds after the first finisher; default 30). There is also a hard cap: three times the course's par time. Riders who don't finish are ranked by distance as DNF.
- **Points per course** by place: 10, 8, 6, 5, 4, 3, 2, 1, and 0 for a DNF. The most points after the last course wins the series, and tied riders share a place.
- **Host settings:** number of courses (3, 5 or 7; default 5), length (short ~30 s, medium ~60 s or long ~90 s of riding at par), difficulty (easy, normal or hard, which sets the obstacle mix and size), finish window, and CPU riders (easy, normal or hard).
- **Ghosts:** other riders are drawn as see-through bikes in their colour, with their name. In solo, and optionally in races, your own best run on this course rides along as a ghost too.
- **Joining mid-series:** you watch the current course and ride from the next one, with 0 points.
- **Leaving** mid-course makes your run a DNF. If you disconnect, your bike's inputs are released and it coasts. When you reconnect, you pick up where your bike is.
- **Not in v1:** a course editor or hand-made courses, surfaces (mud, ice, water), choosing or tuning bikes (the original had several), riders colliding with each other, tricks and flip scoring, loops and ceilings (Elasto Mania-style closed shapes), and sharing course codes. Design so these can be added.

## Design notes

### The bike (`src/shared/bike.ts`)

- The bike follows the well-known model from Elasto Mania, X-Moto and Gravity Defied. There are two wheels (circles with mass and spin) and a chassis (position and angle), with each wheel joined to the chassis by a damped spring along its suspension axis. The rider's head and body are collision points on the chassis.
  - Throttle applies torque to the rear wheel, up to a top speed.
  - Brake slows both wheels' spin.
  - Lean moves the rider's weight forward or back and adds torque to the chassis.
  - Traction comes from the difference between a wheel's spin and its speed over the ground, and that is what drives the bike.
- The sim uses a fixed step of 120 Hz (semi-implicit Euler with a few constraint passes). Time is counted in whole ticks.
- Inputs are small integers: throttle 0/1, brake 0/1, and lean −8…8. The keyboard gives ±8; the mouse gives anything in between.
- **The sim must be deterministic across browsers.** The client and the worker step the same bike from the same inputs and must get the same result bit for bit.
  - Allowed in the sim: + − × ÷, `Math.sqrt` (IEEE requires it to be correctly rounded), `abs`, `min`, `max`, `floor` and `round`.
  - Not allowed: `Math.sin`, `cos`, `atan2`, `hypot`, `pow` and `exp`, because engines differ in the last bit.
  - The chassis angle is kept as a unit vector, rotated by small-angle updates and renormalised with `sqrt`. Any trig the course generator needs is a polynomial in shared code.
- A golden test steps a recorded run and checks a hash of the final state. A dev page runs the same check in Safari, Firefox and Chrome. Do this before building anything on the sim.
- A bike's state is 41 numbers: 21 for the bodies, and 20 for the solver's impulses from the last step, which it starts from (warm starting). Snapshots are still cheap, and a client can rewind and replay.

What milestone 1 found (the numbers are in `TUNE` in `bike.ts`):

- **Warm starting is needed.** Without it, ten solver passes couldn't carry the bike's weight through the tilted suspension, and a bike at rest crept backwards at 2 mm/s, even with the brakes on. The kept impulses are part of the state, and so they're in the hash and in snapshots. Contacts are matched from step to step by ground feature (segment or corner).
- **Rev limit.** The rear wheel can't spin more than 4 m/s faster than the bike moves. Holding the gas in the air used to spin it up to top speed, which tipped the nose up and then looped the bike on landing. Players hold Up all the time, so that was too harsh.
- **Drag doesn't turn the chassis.** Engine braking and bearing drag act on the wheel alone. Their reaction through the tilted suspension also made a bike at rest creep. The engine and brakes still react on the chassis, so gas lifts the front and braking dives it.
- **Feel targets met:** 0 to 50 km/h in 2 s, 72 km/h top speed. Gas alone doesn't lift the front on the flat. Gas with lean back wheelies in about 0.5 s and loops by about 1.2 s if held. Wheelies can be held low by working the gas and lean. A full flip in the air takes about 1.1 s at full lean. Landings survive from −50° to +40° off the slope. Neutral riding takes the sandbox whoops up to about 12 m/s; faster needs lean.
- **Step cost:** 1.4–1.6 µs on an M-series Mac (Node and Chrome on V8, and JavaScriptCore). The CPU budget above (46,000 steps a second) is about 7% of a core there, or maybe 15–20% on a Worker's slower CPU.

### Courses (`src/shared/course.ts`)

- Courses are generated from a seed. Each is a strip of pieces laid left to right (flat, whoops, kicker, tabletop, gap, step-up, drop, hill, log, rock pile), picked by difficulty until the course reaches its target length. The ground is a polyline, start and finish are flat, and v1 has no overhangs. Collision only works against segments, though, so overhangs can come later.
- Segments are bucketed into columns along x, so a wheel only checks the few near it.
- There are checkpoints about every 8 seconds of riding, plus the start gate and the finish flag.
- Every course must be rideable. After generating a course, the hard CPU rides it. If it can't clear a piece, that piece is replaced. The CPU's time becomes the course's par, which sets the length and the hard cap.
- A course's id is its seed, length and difficulty. Personal bests and ghosts are kept by that id.

### Real time

Unlike Light Cycles, where the server steps the whole world, each rider's bike is stepped first on their own device, so the controls respond at once. The server steps the same bike from the same inputs and decides crashes, checkpoints and finish times.

- **Client to server:** `{ t: "ride", upTo, events }` every 100 ms. `events` holds the input changes since the last message, each with its tick, and `upTo` is the tick the client has ridden up to. Inputs change only a few times a second, so these messages are tiny. Set the room's `rateLimits` for them.
- **The room's tick loop** runs at 10 Hz while a course is on. Each tick it:
  - steps each human's bike up to its `upTo`;
  - steps the CPUs up to the course clock;
  - broadcasts one frame: each rider's pose (x, y, angle, wheel spin, lean, quantised), plus checkpoint, crash, respawn and finish events.
- **Clients draw the other riders** 150 ms behind the newest frame, interpolated. The kit's `ClockSync` gives the course clock.
- **A run's time is its tick count**, so lag doesn't cost anything. The course clock bounds every bike:
  - no inputs are accepted for ticks ahead of the clock (plus a little slack);
  - a bike that falls more than 1 s behind is stepped on by the server with its inputs released. That covers a dropped connection, a stalled page or a hidden tab. The server then sends the client the bike's state, and the client takes it.
  - inputs for ticks the server has already stepped are dropped.
- **Checks:** every 50 ticks a frame carries a hash of each human's bike. The owner compares it with its own history. A mismatch shouldn't happen, but if it does, the client takes the server's state at that tick and replays its inputs since then.
- **The client steps its bike from the course clock, not from animation frames.** On each animation frame or timer tick, it steps until its tick catches up with the clock. Background tabs don't run `requestAnimationFrame`, so this keeps a hidden tab's bike in step. When the page is hidden or loses focus, its inputs are released.
- **The bikes live in memory only.** The state in storage keeps each course's seed, the series and the points. If the room restarts mid-course (a deploy), the course starts again from the gate with a countdown. Clients resync from a snapshot (the course seed plus every bike's state) sent in the welcome.

### CPU riders (`src/shared/ai.ts`)

- The sim is cheap and deterministic, so CPUs plan by trying things. Every 0.25 s a CPU tries a handful of input plans (throttle, brake and lean held for the next 0.5–1.5 s) and simulates each one. It scores each plan by the distance covered without crashing and by how upright the bike is at the end, then rides the best one.
  - Easy CPUs look less far ahead, try fewer plans and react late.
  - Hard CPUs try more plans and look further ahead.
- Budget: 8 CPUs × ~12 plans × ~120-step horizon × 4 plans a second is about 46,000 steps a second in one Durable Object. Measure step cost in milestone 1. If it's too slow, shorten the horizon before touching the physics.
- Measure CPU strength over a few hundred generated courses, never one. Check that hard finishes every course, and record times per level. The results go in the README.
- The home screen's demo (`attract.ts`) is a CPU riding a course.

### Screen (`src/client/render.ts`)

- Canvas, side-on. The camera follows your bike, looks ahead in the direction of travel and pulls back a little at speed. There's a sky with parallax hills behind, and the ground is a filled shape with a dirt edge.
- The bike is drawn from the physics bodies: wheels with spokes (so you can see them spin), the frame, and the rider posed by lean.
- Spectators follow the leader, or pick a rider.
- **HUD:**
  - the course clock;
  - your split at each checkpoint against your best and against the leader;
  - your place;
  - which course of the series this is;
  - a strip along the top with every rider's position on the course, since ghosts are often off screen.
- After each course, a results table shows times, gaps, DNF distances and points, followed by the series standings.
- **Sound** (`audio.ts`):
  - an engine: one sawtooth voice through a lowpass, pitched by the rear wheel's speed and the throttle;
  - a thump on landing, a crash, a checkpoint chime and countdown beeps.

  The engine needs a voice that keeps playing, which the kit's `tone` and `noiseBurst` don't give. Build it on the kit's audio context. If the kit doesn't expose that context, the change is a small, backwards-compatible kit change: say so when making it.

- **Make every limit visible:**
  - "held at the gate" during the countdown;
  - the respawn countdown after a crash;
  - "finish window closes in 12 s";
  - "you'll ride from the next course" for mid-series joiners.

## Layout

```
src/shared/    constants.ts, bike.ts (physics), course.ts (generator), ai.ts (CPU riders), protocol.ts
src/worker/    index.ts (gameWorker("dust-up")), room.ts (tick loop, ride messages, frames),
               game.ts (series, courses, finish window, points)
src/client/    main.ts (Shell and game screen), input.ts (keys, mouse, touch), render.ts, audio.ts,
               attract.ts (home-screen demo), ghosts.ts (best runs in localStorage), style.css
test/          bike (determinism, golden hash), course (valid and rideable), ai, game, room tests
```

Built on `@warrick/kit` like every game here; see the root README's "Adding a game" for the build config, the Worker, the route and the sharing card. Its closest siblings:

- **Light Cycles** (`../light-cycles`): rounds with a countdown and a pause between them, a 10 Hz tick loop that stops between rounds, CPU riders and a home-screen demo.
- **Base Jump** (`../base-jump`) and **Turf War** (`../turf-war`): a deterministic shared sim, frames with checksums, and snapshots on resync.

Read them for ideas; don't change them. The dev port is 5188 (in `.claude/launch.json`), the `localStorage` prefix is `du`, and the game is served at `/dust-up/`.

## Milestones

Each milestone ends with something you can play and with tests passing. Ask before committing.

1. **Bike sandbox.** Client only: `bike.ts`, one hand-made bumpy course, keyboard controls and a canvas. Tune the feel here (wheelies, landings, crashes, how it takes a bump), because this is the game. Add the golden determinism test, check it in Safari, Firefox and Chrome, and measure the cost of a step.
2. **Courses.** The generator, its pieces and difficulty levels, checkpoints, finish and respawn, and a local time trial. Tests: courses are valid (no overhangs, flat start and finish, checkpoints in order) for many seeds.
3. **CPU riders.** The planner. The generator rejects pieces the hard CPU can't clear. Measure the levels over a few hundred courses, and add the home-screen demo.
4. **On the kit.** Package, wrangler and Vite config, and the `Shell` with its settings and solo mode. Then the room: countdown, tick loop, ride messages, server stepping, frames, ghosts, finish window, results and series points. Room tests on the kit's harness: a restart mid-course, a reconnect, early and late inputs, a rider who stalls, and a rider who leaves mid-course.
5. **Ghosts and solo.** Personal bests and your best ghost for each course id, and replaying a course in solo.
6. **Polish.** Sound, mouse (pointer lock) and touch controls, the phone layout, results screens, the sharing card and the hub card. Turn this plan into the game's `README.md` and `CLAUDE.md`, then delete it. Deploy after asking.
