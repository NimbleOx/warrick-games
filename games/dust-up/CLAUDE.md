# Dust Up

A side-on dirt bike race after _Dirt Bike_ (Brad Quick and Michel de Messieres, 1995), the classic Mac shareware game, where you rode bumpy courses against the clock and raced your own best runs as ghosts. Here the ghosts are your friends: everyone rides the same course at once, sees the others as see-through bikes, and rides right through them. The fastest time wins the course, and a game is a short series of courses.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 1–8 riders online, each on their own device, plus CPU riders (easy, normal, hard). On your own, the start button reads "Ride solo": a time trial against your own best run on each course.
- Everyone starts at the gate together after a 3-second countdown. Bikes are held at the gate until it drops; holding the gas revs the engine.
- **Controls:** gas, brake, lean back, lean forward, and back to the last checkpoint.
  - **Keyboard:** Up, W or Space for gas, Down or S to brake, Left/A and Right/D to lean, R back to the checkpoint (held, it holds you there), G to show or hide your best run.
  - **Mouse**, like the original: click the course to take the pointer, then hold the button for gas, move left and right to lean (by any amount), and the right button brakes. Esc lets go.
  - **Touch:** lean back and forward on the left, back-to-checkpoint, brake and a big gas button on the right: under the course on a phone held upright, over its corners on its side.
- **Leaning** shifts the rider's weight. On the ground, leaning back lifts the front (a wheelie) and leaning forward presses it down. In the air it turns the bike, so you can land on both wheels.
- **Courses** run left to right from the gate to the finish flag, with a checkpoint every so often. Obstacles are the shape of the ground: whoops, kickers, tabletops, gaps over a pit, doubles, step-ups onto a shelf, drops, hills, climbs, descents, logs and rocks.
- **Crashing:** the rider's head or body touching the ground, landing upside down, or falling into a pit. After 1.5 s you're back at the last checkpoint, upright and still. The clock keeps running: a crash costs time, never the race.
- **A course ends** when everyone has finished, or when the window after the first finish closes (the host picks 15, 30 or 60 s; default 30), or at the hard cap of three times the course's par. Riders who haven't finished are DNF, ranked by how far they got.
- **Points per course** by place: 10, 8, 6, 5, 4, 3, 2, 1, and none for a DNF. Riders with the same time share the place and its points. The most points after the last course wins the series, then the most course wins.
- **Host settings:** courses (1, 3, 5 or 7; default 5), length (short, medium or long: about 30, 60 or 90 s for the hard CPU; default short), difficulty (easy, normal or hard: the size of the obstacles; default normal), and the window after the winner.
- **Ghosts:** other riders are see-through bikes in their colour, with their name over them. Your best run on the course rides beside you too (on by default; G or the Ghost button). A strip along the top shows everyone between the gate and the flag.
- **Solo:** after each course you choose: ride it again, or go on. Your best time on each course and the run behind it are kept in your browser.
- **Joining mid-series:** you get a seat and watch until the next course, which you ride with 0 points.
- **Leaving** mid-series takes your bike off the course and you out of the standings. **Dropping out** (a closed lid, a lost connection): the room rides your bike on with nothing pressed, and when you're back you pick up where it is. If everyone goes, the course waits, and goes on after a countdown when someone is back.
- **Every limit shows:** the countdown, why you're held, the respawn countdown, "stuck? press R" (on the gas and getting nowhere), when the course ends after the winner, and that you'll ride from the next course.
- **Not in v1:** a course editor or hand-made courses, surfaces (mud, ice, water), choosing or tuning bikes, riders colliding, tricks and flip scoring, loops and ceilings (Elasto Mania's closed shapes), sharing course codes. Design so they can be added.

## Design notes

### The bike (`src/shared/bike.ts`)

- Two wheels (circles with mass and spin) and a chassis (the bike and rider as one body), each wheel held to the chassis on its suspension axis by a damped spring: the model Elasto Mania, X-Moto and Gravity Defied use. Gas drives the rear wheel against the chassis (so gas lifts the front), brakes hold each wheel's spin to the chassis's, lean shifts the rider's weight and turns the chassis, and traction is friction at each tyre's contact.
- A fixed 120 Hz step: forces, then sequential impulses over the joints and contacts (soft constraints), then positions. The solver starts from the last step's impulses (warm starting), which are part of the bike's state: without them a bike at rest crept backwards. Contacts are matched step to step by ground feature.
- Inputs are small whole numbers: gas 0/1, brake 0/1, lean −8 to 8, and respawn 0/1.
- **It's deterministic across browsers**, bit for bit: the client and the worker step the same bike from the same inputs. Only + − × ÷, `Math.sqrt` (correctly rounded by IEEE), `abs`, `min`, `max`, `floor`, `round` and `imul` in the sim and the course generator; never `sin`, `cos`, `atan2`, `hypot`, `pow`, `exp` or `**`. The chassis angle is a unit vector turned by a polynomial and renormalised with `sqrt`. A test reads the source and checks; golden rides (test/fixtures) check the results, and check.html replays them in a browser.
- Tuning lives in `TUNE`. What the sandbox found: the rear wheel can't spin more than 4 m/s faster than the bike moves (gas in the air used to loop the bike on landing), and engine braking and bearing drag act on the wheels alone (their reaction through the tilted suspension made a bike at rest creep). Feel: 0 to 50 km/h in 2 s, 72 km/h flat out, a wheelie in half a second with gas and lean back, a full flip in the air in about 1.1 s, landings survive from −50° to +40° off the slope.

### Courses (`src/shared/course.ts`, `ground.ts`)

- Generated from a spec (seed, length, difficulty): pieces left to right, each after a flat run-up, until the course is long enough. Each piece scales with a difficulty value from its difficulty's band, so an easy course has small bumps and short gaps and a hard one has big air. Pieces lean up or down to keep the course in a band of heights, and hills and climbs are no steeper than about 35°.
- The ground is a polyline with no overhangs, bucketed into 2 m columns so a wheel checks only the segments near it. Collision is against segments and peak corners, so overhangs can come later.
- A checkpoint goes on a run-up, 15 m before its piece, at least 75 m after the last one, so a respawn has room to get up to speed. Gaps have a pit: a bike whose centre drops below the lip there has crashed.
- The generator doesn't try courses out. The tests do, across every piece's range: the hard CPU finishes every course (`test/ai.test.ts`, and `MEASURE=1` for hundreds), and courses are checked for their shape (`test/course.test.ts`). Par is the course's length over the hard CPU's measured speed on that difficulty; the hard cap is three times par.
- A course's id is its seed, length and difficulty. Personal bests and best runs are kept by it.

### The race over the network

Each rider's bike is stepped first on their own screen (`src/shared/local.ts`), so the controls answer at once; the room steps the same bike from the same inputs and decides checkpoints, crashes and finish times. Nobody touches anybody, so nothing else needs predicting.

- **Client to room:** `ride` every 100 ms: the input in effect at the tick the last one left off, then every change since, each with its tick, and how far the screen has ridden (`upTo`). The room replaces whatever it had queued from that tick on, so a message that never arrived is covered by the next.
- **The room's tick loop** runs at 10 Hz while a course is being ridden: it steps each human's bike as far as their inputs reach (never more than 0.25 s past the course clock), each CPU's to the clock, and sends one frame: every bike's pose (positions in cm, angles in milliradians), flags (crashed, finished, held, away), its checkpoint and when it got there, and the latest hash of each human's bike.
- **Hashes:** every 60 ticks the room hashes each human's bike. The screen checks it against its own hash for that tick; if they differ (they shouldn't), it asks for the room's bike (`resync`, at most once a second) and gets a `sync`: it takes that bike and rides it on to where it was with its own inputs. That's what the room will do with the inputs it has.
- **A run's time is its tick count**, so lag costs nothing. The course clock (from `startAt`, on the server's clock) bounds every bike: a human whose inputs fall more than 1 s behind it is ridden on by the room with nothing pressed, marked away, and sent their bike as soon as they're heard from again.
- **The screen steps its bike from the clock, not from animation frames**: on each frame, and from a timer when frames stop (a hidden tab), it steps until its tick catches up. Inputs are let go when the page is hidden or loses focus.
- **Other riders are drawn 30 ticks (250 ms) behind the clock**, all at the same moment of the course, between the frames either side of it (`Ghost`); one whose frames are late runs on in a straight line for a moment. Your own bike is at the clock.
- **The race lives in memory only** (the kit's `live`). The state keeps the series' seed, the course number, the run (counting every start of a course, so stale inputs can be told apart), when the gate dropped, the finishes, results and points. A restart (a deploy) starts the course again from the gate. If the loop stopped because everyone went, the first one back gets a countdown and the course clock goes on from where it stopped, every bike where it was. A race snapshot (in the welcome, and in `race` at every countdown) carries its own course spec and riders, since it can arrive just before the state that goes with it.

### CPU riders (`src/shared/ai.ts`)

- The sim is exact for them (nothing touches them), so they plan by trying: every 0.25 s a CPU rides a handful of plans ahead on a copy of its bike (one input held for a moment, then a steadying policy at a target speed), and rides the one that gets furthest without crashing, quick and in line with the ground. A plan that ends in the air rides on until it lands, so it's judged on its landing. The steadying policy, in the air, leans the bike to land parallel to the ground where a ballistic guess says it'll come down.
- Easy and normal plan less far ahead and try fewer things, and now and then hesitate: they ride at a crawl until the next plan. That costs time, and sometimes a crash (coming up short on a gap), which is what makes them easier. A comfort speed that capped how far a plan was worth going made easy too timid to clear gaps: it stopped before them.
- After a crash, until it's past that spot, a CPU rides a little faster or slower than before (more so each time it crashes there), and doesn't hesitate. The sim is exact, so without that a CPU would ride from the checkpoint the same way and crash in the same place for ever (the hard CPU did, on 2 courses in 600). Just slowing down made it worse: an easy CPU that came up short on a gap only came up shorter. After two crashes in one spot it plans like a hard CPU until it's past: varying the speed alone didn't get a normal CPU over a hill it kept looping on.
- A CPU on the gas that gets nowhere for 3 s holds R. After the finish it rolls to a stop.
- Only the worker runs them (and the home screen's demo), so they may use `Math.atan2` freely. Cost: about 75 µs per tick for hard, 35 for normal, 12 for easy (README).

### Screen (`src/client/`)

- Canvas, side-on (`render.ts`): sky and parallax hills, the ground with a dirt edge, checkpoint flags, the finish, and each bike drawn from its physics bodies (spoked wheels that spin, the frame, a rider posed by lean). The camera looks ahead, pulls back at speed, and drops towards the ground on big jumps.
- The HUD over the course: your time, the course number, your place, speed, the strip, your split at each checkpoint against your best run and the leader, and when the course ends. Banners for the countdown, crashes, being held, stuck, finished and watching. After each course a results table, after the series the standings.
- The engine (`audio.ts`) is a voice that keeps running, pitched by the rear wheel's spin, louder and brighter on the gas; it uses the kit's `audioOut`. Short sounds for the countdown, checkpoints, landings, crashes and the finish.
- Your best run on a course (`ghosts.ts`) is its input log, kept only once it replays from the gate to the same time; the newest 40 courses' runs are kept.
