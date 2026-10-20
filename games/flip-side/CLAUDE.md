# Flip Side

A pinball battle: everyone plays the same table at once, each on their own screen, and big shots send trouble to rivals. It's built the way Dust Up is (each player's game runs on their own screen first and the room re-runs it from their inputs), with trouble routed between tables the way Stack Attack routes garbage.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 1–8 players online, each on their own device, plus CPU players (easy, normal, hard). On your own, the start button reads "Play solo": no trouble, and your best score for each mode is kept in your browser.
- **One table** (`src/shared/table.ts`), the same for everyone, with the same luck: the match's seed lights the same skill-shot lanes in the same order on every table.
- **Match modes** (host): timed, 2, 3 or 5 minutes (default 3): unlimited balls, top score at the end wins; a drain costs the ball's multiplier and the time to serve and launch the next. Balls, 3 or 5 each: top score once everyone has drained wins, with a 10-minute cap so a match can't go on for ever.
- **Controls:** left flipper, right flipper, plunger (hold to pull, let go to launch), nudge. Keyboard: ←/Z/left Shift/A, →//(slash)/right Shift/D/M, ↓/Space/Enter/S, ↑/W. Touch: the table's halves are the flippers; buttons under it for launch and nudge.
- **Scoring:** slingshots 10, bumpers 100, inlanes 100, standups 250 (all three 3,000), top lanes 500 (100 once lit; all three 2,000 and the multiplier up one, to 5×), drop targets 500 (the bank 5,000), orbit 1,000 × the combo, scoop 1,500, outlanes 1,000, lock 5,000, multiball 10,000, jackpot 25,000, skill shot 10,000. Most also add to the ball's bonus, paid times the multiplier when it drains (or when time's up), except after a tilt.
- **Trouble:** power comes from the drop target bank (3), the standups (3), the skill shot (3), all three lanes (2), orbits (1, 2 in a combo), multiball (2) and jackpots (5). At 6, trouble goes to a rival still playing (the host picks a random one or the leader; "nobody" turns trouble off) and lands one second after the room hears of it: brick 12 s, shrink 10 s, fog 8 s, swap 6 s, picked at random. More of the same kind restarts its clock.
- **Ball save** 6 s from the ball leaving the shooter lane, 10 s from multiball starting. A ball left on the plunger launches itself after 10 s. A ball barely moving for 3 s away from the flippers gets a kick.
- **Tilt:** each nudge adds one danger; one comes off every 2 s. Three and the ball is tilted: flippers and kickers dead, bonus lost, until it drains.
- **Every limit shows:** the countdown, time left (or the cap's last minute), ball save, the auto-launch countdown, tilt danger, trouble on its way (with who sent it and when it lands), trouble on you (what it does and how long is left), what's lit, and that you'll play from the next match.
- **Joining mid-match:** you get a seat and watch until the next match. **Leaving** takes your table out. **Dropping out:** the room plays on for you with a normal-level autopilot, and when you're back you pick up where it is. If everyone goes, the match waits, and goes on after a countdown when someone is back.
- **Not in v1:** other tables, ramps and anything on a second level, spinners, kickbacks, extra balls, a match point system across several matches, choosing your trouble or blocking it, nudging in a direction. Design so they can be added.

## Design notes

### The game (`src/shared/sim.ts`)

- One ball is a circle with no spin, sliding without friction; up to three at once. A fixed 120 Hz tick of 8 substeps (960 Hz), so a ball at the 4,200 units/s cap moves under 5 units a substep and never skips a wall (the ball's radius is 13). Gravity 1,500 units/s² down the table.
- Collisions push the ball out along the contact normal and reflect the speed into it times (1 + bounciness); slower than 40 units/s in and it doesn't bounce, so it settles. Walls are segments (capsules), posts and bumpers circles, both looked up in a 40-unit grid. Flippers are tapered capsules swung at a fixed speed, and the ball bounces off the surface's own speed at the contact point, which is what launches it. Pop bumpers and slingshots add speed straight out; gates only stop a ball on one side.
- **It's deterministic across browsers**, bit for bit: the client and the worker step the same game from the same inputs. Only + − × ÷, `Math.sqrt`, `abs`, `min`, `max`, `floor`, `round` and `imul` in the sim, the table and the screen's own table; sin and cos come from `dmath.ts` (polynomials). A test reads the source and checks; the golden game (`test/sim.test.ts`) checks the results.
- Inputs are four bits (left, right, plunger, nudge). Presses (bits that weren't held last tick) move the lit lanes and nudge; trouble's swap swaps the flipper bits before anything reads them.
- Everything in `Play` is state, saved in `playNumbers` and hashed, except `events` (what happened on the last tick, for sounds and the room).
- Tuning is in `TUNE`. What the table needed: the plunger launches the ball up a curve that leaves it flying over the top lanes, so how long it's pulled decides the lane (a ball that rode the arch all the way round didn't drop into any); the inlane guides run in line with the flippers' tops, or the ball parked on the pivot; the scoop only catches a ball moving into it, or it caught the ball it had just kicked out; and the plain scoop gives no power, or the hard CPU looped it for ever.

### The match over the network

Each player's table is stepped first on their own screen (`src/shared/local.ts`), so the flippers answer at once; the room steps the same game from the same inputs and keeps the score. Tables don't touch, except through trouble.

- **Client to room:** `play` every 100 ms: the input in effect at the tick the last one left off, every change since, and how far the screen has played (`upTo`). The room replaces whatever it had queued from that tick on.
- **The room's tick loop** runs at 20 Hz while a match is played: each human's table as far as their inputs reach (never more than 0.25 s past the clock), each CPU's to the clock, then one frame with every table (balls in whole units, flippers in milliradians, lights, score, flags) and the latest hash of each human's table, every 60 ticks.
- **Trouble** is routed when a table's power fills on the room's copy of it: the room picks the rival and the kind, and the tick it lands, one second (`TROUBLE_LEAD`) past the clock or the rival's table, whichever is later, so it's always in the room's future for that table. Every screen hears of it at once; the rival's screen lands it at that tick. One that comes late (a slow connection) takes the screen back to a snapshot from before the tick (it keeps one every 30 ticks for 4 s) and plays forwards again; later than that, it asks for the room's game.
- **Hashes:** if the screen's hash at a tick differs from the room's, it asks for the room's game (`resync`, at most once a second) and gets a `sync`: it takes that game and plays it on to where it was with its own inputs, which is what the room will do with the inputs it has.
- A human whose inputs fall more than 1 s behind the clock is played by an autopilot (normal CPU), marked away, and sent their table as soon as they're heard from again.
- **The match lives in memory only** (the kit's `live`). The state keeps the run, when the clock started, who's playing and the results. A restart (a deploy) starts the match again. If the loop stopped because everyone went, the first one back gets a countdown and the clock goes on from where it stopped.

### CPU players (`src/shared/ai.ts`)

- The sim is exact, so they plan by trying: a CPU looks a half second ahead for a ball reaching a flipper with nobody flipping, then plays copies of its game with the flip at a handful of moments around then, and plays the one that scored best (points, plus a worth for what it set up: a bank, a lock, multiball, a jackpot) without losing the ball and with the ball left high and safe. A hard CPU also tries catching the ball on a raised flipper, and from there tries letting it roll for different times before flipping: that's how it aims at the scoop.
- Easy and normal react later, try fewer moments, flip a tick or few off what they planned, and now and then don't flip at all. Only hard plunges for the skill shot (`SKILL_PULLS`, checked by a test) and nudges a ball out of an outlane.
- Only the worker runs them (and the home screen's demo), so they may use `Math.atan2`. Measured costs and strengths are in the README.

### Screen (`src/client/`)

- Canvas (`render.ts`): the playfield is drawn once into its own layer for each size (walls with a glow, blocks, slingshots, unlit inserts), then each frame the lights, drop targets and standups, bumpers, the brick, the plunger, flippers in the player's colour, balls, popups, and trouble over the top (fog, a swap, a tilt). Rivals' tables use the same renderer, small, without the glow and the words.
- Your own table is drawn a tick behind the clock, between its last two ticks; rivals 36 ticks (0.3 s) behind, between their frames. When you're not playing (watching, or out in a balls match), the big view shows the leader or the rival you click.
- The HUD: the score display (score, ball, time, multiplier, ball save), the trouble meter, what's lit and what's coming (a list beside the table, over it on a phone), a feed of trouble sent, and banners for the countdown and the big moments. The results blur the screen, so the tables stop drawing beneath them once they're up.
