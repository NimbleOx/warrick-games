/**
 * Other riders, and your own best run.
 *
 * Other riders come in frames, ten a second, each at the tick the room has their bike at. They're
 * all drawn at the same moment of the course, a little behind the clock (`DELAY`), between the
 * frames either side of it, so they keep their places relative to each other. A rider whose
 * frames are late runs on in a straight line for a moment.
 *
 * Your best run on a course is its inputs, kept in this browser (`store`), and replayed beside
 * you, tick for tick, on the same clock: the sim is deterministic, so it rides exactly as you did.
 */

import { personalBest, store } from "@warrick/kit/client/dom";
import { Bike } from "../shared/bike";
import { TICK_HZ } from "../shared/constants";
import { decodePose, F_CRASHED, F_FINISHED, F_HELD, type RiderFrame } from "../shared/protocol";
import { Ride, decodeInput, replay, startRide, stepRide, type Course, type InputEvent, type RideInput } from "../shared/ride";

/** How far behind the course clock other riders are drawn, in ticks (a frame and a bit). */
export const DELAY = 30;
/** How long a rider runs on past their newest frame before stopping to wait. */
const EXTRAPOLATE = 24;
/** Frames kept per rider. */
const KEEP = 24;

interface Sample {
  tick: number;
  pose: Bike;
  flags: number;
  cp: number;
  cpAt: number;
}

export class Ghost {
  private samples: Sample[] = [];
  /** The newest frame's facts, for the HUD and the riders list. */
  flags = 0;
  cp = 0;
  cpAt = 0;
  tick = 0;
  /** The pose to draw this animation frame. */
  readonly pose = new Bike();

  constructor(readonly id: string) {}

  push(f: RiderFrame): void {
    const tick = f[1];
    const last = this.samples[this.samples.length - 1];
    if (last && tick <= last.tick) {
      // The same tick again (they've stalled), or older: just keep the facts.
      if (tick === last.tick) last.flags = f[12];
    } else {
      this.samples.push({ tick, pose: decodePose(f), flags: f[12], cp: f[13], cpAt: f[14] });
      if (this.samples.length > KEEP) this.samples.shift();
    }
    this.flags = f[12];
    this.cp = f[13];
    this.cpAt = f[14];
    this.tick = tick;
  }

  /** Puts the pose at course tick `t` into `pose` (false before the first frame). */
  at(t: number): boolean {
    const s = this.samples;
    if (!s.length) return false;
    if (t <= s[0].tick) {
      this.pose.copyFrom(s[0].pose);
      return true;
    }
    for (let i = 1; i < s.length; i++) {
      if (s[i].tick >= t) {
        const a = s[i - 1];
        const b = s[i];
        lerpPose(this.pose, a.pose, b.pose, (t - a.tick) / (b.tick - a.tick));
        this.pose.crashed = b.flags & F_CRASHED ? 1 : 0;
        return true;
      }
    }
    // Past the newest frame: run on in a straight line for a moment, unless they're held still.
    const b = s[s.length - 1];
    const a = s.length > 1 ? s[s.length - 2] : b;
    const still = b.flags & (F_CRASHED | F_HELD | F_FINISHED) || a === b;
    const over = still ? 0 : Math.min(t - b.tick, EXTRAPOLATE) / (b.tick - a.tick);
    lerpPose(this.pose, a.pose, b.pose, 1 + over);
    this.pose.crashed = b.flags & F_CRASHED ? 1 : 0;
    return true;
  }

  /** How far along they are, by their newest frame. */
  get x(): number {
    const s = this.samples[this.samples.length - 1];
    return s ? s.pose.x : 0;
  }
}

/** Between two poses (t from 0 to 1, or a little past 1 to run on). */
export function lerpPose(out: Bike, a: Bike, b: Bike, t: number): Bike {
  const l = (p: number, q: number) => p + (q - p) * t;
  out.x = l(a.x, b.x);
  out.y = l(a.y, b.y);
  const c = l(a.c, b.c);
  const s = l(a.s, b.s);
  const n = Math.hypot(c, s) || 1;
  out.c = c / n;
  out.s = s / n;
  out.lean = l(a.lean, b.lean);
  for (const [o, p, q] of [
    [out.rear, a.rear, b.rear],
    [out.front, a.front, b.front],
  ] as const) {
    o.x = l(p.x, q.x);
    o.y = l(p.y, q.y);
    let da = q.a - p.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    o.a = p.a + da * t;
  }
  out.crashed = b.crashed;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Your best runs.

interface SavedRun {
  ticks: number;
  log: InputEvent[];
}

/** How many courses' best runs this browser keeps. */
const KEEP_RUNS = 40;

/** Your best run on a course, if this browser has one. */
export function bestRun(courseId: string): SavedRun | null {
  try {
    const run = JSON.parse(store(`run.${courseId}`) ?? "null") as SavedRun | null;
    return run && typeof run.ticks === "number" && Array.isArray(run.log) ? run : null;
  } catch {
    return null;
  }
}

/**
 * Offer a finished run (its inputs from the gate, and the run's id so showing the results again
 * doesn't count it twice). It's kept if it's your best on the course, and only once it replays
 * to the same time, so the ghost rides exactly as you did. Returns your best before it and now.
 */
export function offerRun(
  course: Course & { id: string },
  runId: string,
  ticks: number,
  log: InputEvent[],
): { best: number; prev: number | null; fresh: boolean } {
  // Lower is better, so the kit's personal best (higher is better) keeps minus the time.
  const pb = personalBest(`best.${course.id}`, runId, -ticks);
  const result = { best: -pb.best, prev: pb.prev === null ? null : -pb.prev, fresh: pb.fresh };
  if (!pb.fresh || pb.best !== -ticks) return result;
  if (replay(course, log, ticks + 1).finishTick !== ticks) return result;
  store(`run.${course.id}`, JSON.stringify({ ticks, log }));
  // Forget the oldest courses' runs.
  let ids: string[] = [];
  try {
    ids = JSON.parse(store("runs") ?? "[]") as string[];
  } catch {
    // Start again.
  }
  ids = [course.id, ...ids.filter((id) => id !== course.id)];
  for (const old of ids.slice(KEEP_RUNS)) {
    store(`run.${old}`, null);
    store(`best.${old}`, null);
  }
  store("runs", JSON.stringify(ids.slice(0, KEEP_RUNS)));
  return result;
}

/** Your best run, ridden again beside you on the course clock. */
export class BestGhost {
  readonly ride: Ride;
  /** The ride a tick ago, for drawing between ticks. */
  readonly prev = new Ride();
  private readonly input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
  private next = 0;
  /** The tick it reached each checkpoint, for your splits. */
  readonly cpTicks: number[] = [0];

  constructor(
    private readonly course: Course,
    readonly run: SavedRun,
  ) {
    this.ride = startRide(course);
    this.prev.copyFrom(this.ride);
  }

  /** Ride on to `tick` (it stops a little past its finish). */
  advance(tick: number): void {
    const end = this.run.ticks + 2 * TICK_HZ;
    const log = this.run.log;
    while (this.ride.tick < Math.min(tick, end)) {
      while (this.next < log.length && log[this.next][0] <= this.ride.tick) {
        decodeInput(log[this.next][1], log[this.next][2], this.input);
        this.next++;
      }
      const cp = this.ride.checkpoint;
      this.prev.copyFrom(this.ride);
      stepRide(this.ride, this.input, this.course);
      if (this.ride.checkpoint !== cp) this.cpTicks[this.ride.checkpoint] = this.ride.tick;
    }
  }
}
