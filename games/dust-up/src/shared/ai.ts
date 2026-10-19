/**
 * CPU riders. The sim is cheap and deterministic, and riders don't touch each other, so a CPU
 * knows exactly what each choice of inputs will do: it plans by trying them. Every so often it
 * tries a handful of plans (one input held for a moment, then a steadying policy for the rest),
 * rides each one ahead on a copy of its bike, and rides the one that gets furthest without
 * crashing and leaves the bike in good shape.
 *
 * Only the worker runs CPUs (and the home screen's demo, which nobody checks), so this needn't
 * keep to the sim's deterministic arithmetic: it uses Math.atan2 freely.
 */

import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { TUNE } from "./bike";
import { LEAN_MAX, TICK_HZ } from "./constants";
import { Ride, stepRide, type Course, type RideInput } from "./ride";

interface Level {
  /** Ticks between plans. */
  replan: number;
  /** How far ahead each plan is ridden, in ticks. */
  horizon: number;
  /** How long a plan's first input is held before the policy takes over. */
  hold: number;
  /** The first inputs it tries: [throttle, brake, lean]. */
  firsts: [number, number, number][];
  /** The speeds (m/s) the policy aims for after that. */
  speeds: number[];
  /**
   * How often, at a plan, it eases off instead: it rides steadily at a crawl until the next plan.
   * It costs time, and now and then a crash (coming up short on a jump), which is what makes the
   * easier CPUs easier.
   */
  hesitate: number;
}

const GAS: [number, number, number] = [1, 0, 0];
const GAS_BACK: [number, number, number] = [1, 0, -LEAN_MAX];
const GAS_FORWARD: [number, number, number] = [1, 0, LEAN_MAX];
const COAST: [number, number, number] = [0, 0, 0];
const COAST_FORWARD: [number, number, number] = [0, 0, LEAN_MAX];

export const LEVELS: Record<CpuLevel, Level> = {
  easy: { replan: 48, horizon: 72, hold: 24, firsts: [GAS, COAST, GAS_BACK], speeds: [8, 11], hesitate: 0.45 },
  normal: { replan: 30, horizon: 96, hold: 18, firsts: [GAS, COAST, GAS_BACK], speeds: [11, 16], hesitate: 0.12 },
  hard: {
    replan: 30,
    horizon: 120,
    hold: 15,
    firsts: [GAS, GAS_BACK, GAS_FORWARD, COAST, COAST_FORWARD],
    speeds: [11, 17],
    hesitate: 0,
  },
};

/** The speed a CPU eases off to when it hesitates. */
const CRAWL = 5;

/** A plan that ends in the air rides on until it lands, for at most this long, so it's judged on its landing. */
const SETTLE_TICKS = 150;

/** A CPU holds R to go back to its checkpoint after this long without getting anywhere. */
const STUCK_TICKS = 3 * TICK_HZ;

export class Pilot {
  private readonly level: Level;
  private readonly rng: Rng;
  private readonly scratch = new Ride();
  private readonly memo = new Memo();
  /** The plan being ridden: its first input until `holdUntil`, then the policy at `speed`. */
  private first: [number, number, number] = [1, 0, 0];
  private speed = 12;
  private holdUntil = 0;
  private nextPlan = 0;
  /** For noticing it's stuck: the furthest it has been, and when. */
  private bestX = -Infinity;
  private bestAt = 0;
  /**
   * Where it last crashed, and how many times in a row there. Until it's past that spot it rides
   * a little differently each time: the sim is exact, so otherwise a CPU would ride the same way
   * from the checkpoint and crash in the same place for ever.
   */
  private crashX = -Infinity;
  private crashes = 0;
  private wasCrashed = false;

  /**
   * `firstPlan` is the tick it first plans at. Pilots stepped on one thread can start at
   * different ticks, so they don't all plan on the same frame; the room's start at 0, as they
   * were when the CPU levels were measured.
   */
  constructor(
    readonly cpu: CpuLevel,
    seed: number,
    firstPlan = 0,
  ) {
    this.level = LEVELS[cpu];
    this.rng = mulberry32(seed);
    this.nextPlan = firstPlan;
  }

  /** Another crash at `x`: the count goes on while they're all in one place. */
  private noteCrash(x: number): void {
    this.crashes = Math.abs(x - this.crashX) < 15 ? this.crashes + 1 : 1;
    this.crashX = x;
  }

  /** The input for the ride's next tick. */
  decide(ride: Ride, course: Course, out: RideInput): RideInput {
    const b = ride.bike;
    out.respawn = 0;
    if (b.crashed) {
      if (!this.wasCrashed) this.noteCrash(b.x);
      this.wasCrashed = true;
      this.bestX = -Infinity;
      this.nextPlan = ride.tick;
      return policy(ride, course, this.speed, out, this.memo);
    }
    this.wasCrashed = false;
    // Past the finish: ease off and roll to a stop.
    if (ride.finishTick >= 0) return policy(ride, course, 0, out, this.memo);
    if (b.x > this.bestX + 1) {
      this.bestX = b.x;
      this.bestAt = ride.tick;
    } else if (ride.tick - this.bestAt > STUCK_TICKS) {
      // Stuck counts as a crash here: it'll ride this bit differently next time.
      this.noteCrash(b.x);
      this.bestX = -Infinity;
      out.throttle = out.brake = out.lean = 0;
      out.respawn = 1;
      return out;
    }
    if (ride.tick >= this.nextPlan) this.plan(ride, course);
    if (ride.tick < this.holdUntil) {
      [out.throttle, out.brake, out.lean] = this.first;
      return out;
    }
    return policy(ride, course, this.speed, out, this.memo);
  }

  private plan(ride: Ride, course: Course): void {
    // Coming up to where it crashed, it doesn't hesitate, and rides a little faster or slower
    // than it did: never quite the same way twice. After two crashes there, it concentrates:
    // it plans like a hard CPU until it's past.
    const again = ride.bike.x < this.crashX + 10;
    const L = again && this.crashes >= 2 ? LEVELS.hard : this.level;
    this.nextPlan = ride.tick + L.replan;
    if (!again && L.hesitate && this.rng() < L.hesitate && !airborne(ride, course)) {
      this.speed = CRAWL;
      this.holdUntil = ride.tick;
      return;
    }
    const vary = again ? 1 + (this.rng() * 2 - 1) * Math.min(0.3, 0.1 * this.crashes) : 1;
    let best = -Infinity;
    for (const first of L.firsts) {
      for (const level of L.speeds) {
        const speed = level * vary;
        const score = this.tryPlan(ride, course, L, first, speed);
        if (score > best) {
          best = score;
          this.first = first;
          this.speed = speed;
        }
      }
    }
    this.holdUntil = ride.tick + L.hold;
  }

  /** Rides a plan ahead on a copy of the bike and scores where it ends up. */
  private tryPlan(ride: Ride, course: Course, L: Level, first: [number, number, number], speed: number): number {
    const r = this.scratch.copyFrom(ride);
    const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
    const x0 = r.bike.x;
    const memo = new Memo();
    for (let i = 0; i < L.horizon + SETTLE_TICKS; i++) {
      if (i >= L.horizon && !airborne(r, course)) break;
      if (i < L.hold) [input.throttle, input.brake, input.lean] = first;
      else policy(r, course, speed, input, memo);
      stepRide(r, input, course);
      if (r.bike.crashed) return -10000 + i * 10 + (r.bike.x - x0);
      if (r.finishTick >= 0) return 10000 - i;
    }
    return score(r, course, x0);
  }
}

/** Where a plan leaves the bike: further is better, and so is quick, and in line with the ground. */
function score(r: Ride, course: Course, x0: number): number {
  const b = r.bike;
  const off = Math.abs(Math.atan2(b.s, b.c) - groundSlope(course.ground, b.x));
  return b.x - x0 + 0.5 * b.vx - 6 * Math.max(0, off - 0.3) - 0.5 * Math.max(0, Math.abs(b.w) - 1);
}

/** What the policy keeps between ticks of one ride: its guess at where a jump lands. */
class Memo {
  landSlope = 0;
  landAt = -1;
}

/**
 * A steadying policy: on the ground, gas up to `speed` and keep the bike in line with the
 * slope; in the air, lean so it lands parallel to the ground where it'll come down.
 */
export function policy(ride: Ride, course: Course, speed: number, out: RideInput, memo = new Memo()): RideInput {
  const b = ride.bike;
  out.respawn = 0;
  out.brake = 0;
  const pitch = Math.atan2(b.s, b.c);
  if (airborne(ride, course)) {
    // Land a touch rear-first. Where it lands changes slowly, so it's worked out now and then.
    if (memo.landAt < 0 || ride.tick - memo.landAt >= 6 || ride.tick < memo.landAt) {
      memo.landSlope = landingSlope(ride, course);
      memo.landAt = ride.tick;
    }
    const target = memo.landSlope + 0.08;
    const err = pitch - target;
    out.lean = clampLean(LEAN_MAX * (2.2 * err + 0.35 * b.w));
    // Gas lifts the nose in the air; braking drops it.
    out.throttle = err < -0.35 ? 1 : 0;
    out.brake = err > 0.5 ? 1 : 0;
    return out;
  }
  const slope = groundSlope(course.ground, b.x);
  const err = pitch - slope;
  const v = b.vx * b.c + b.vy * b.s;
  out.throttle = v < speed && err < 0.35 ? 1 : 0;
  // Well over the speed it wants, on a steady bike: brake.
  out.brake = v > speed + 4 && Math.abs(err) < 0.15 ? 1 : 0;
  out.lean = Math.abs(err) < 0.06 && Math.abs(b.w) < 0.5 ? 0 : clampLean(LEAN_MAX * (2.5 * err + 0.4 * b.w));
  return out;
}

function clampLean(v: number): number {
  return Math.max(-LEAN_MAX, Math.min(LEAN_MAX, Math.round(v)));
}

/** Neither wheel is touching the ground. */
export function airborne(ride: Ride, course: Course): boolean {
  const g = course.ground;
  const R = TUNE.wheelRadius;
  const b = ride.bike;
  return b.rear.y - R - g.heightAt(b.rear.x) > 0.12 && b.front.y - R - g.heightAt(b.front.x) > 0.12;
}

/** The angle of the ground around x, across a wheelbase. */
export function groundSlope(g: Course["ground"], x: number): number {
  const a = Math.atan2(g.heightAt(x + 0.7) - g.heightAt(x - 0.7), 1.4);
  return Number.isFinite(a) ? a : 0;
}

/** The slope of the ground where a bike in the air will come down, by a ballistic guess. */
function landingSlope(ride: Ride, course: Course): number {
  const b = ride.bike;
  const g = course.ground;
  const grav = TUNE.gravity;
  // Step the arc in 50 ms steps until it's below the ground (at most 3 s).
  let x = b.x;
  let y = b.y - 0.75;
  let vy = b.vy;
  for (let t = 0; t < 3; t += 0.05) {
    x += b.vx * 0.05;
    vy -= grav * 0.05;
    y += vy * 0.05;
    if (y <= g.heightAt(x)) break;
  }
  return groundSlope(g, x);
}
