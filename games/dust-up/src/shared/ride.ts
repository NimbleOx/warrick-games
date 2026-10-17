/**
 * A ride: one bike on one course, counted in ticks, with checkpoints, crashes and respawns.
 * Deterministic like the bike: the same course and the same input log give the same ride, bit
 * for bit, on every device.
 */

import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { Bike, bikeNumbers, placeBike, stepBike, type Input } from "./bike";
import { RESPAWN_TICKS } from "./constants";
import type { Ground } from "./ground";

export interface Course {
  ground: Ground;
  /** Checkpoint x positions in order; the first is the start gate. Each is on flat ground. */
  checkpoints: number[];
  finishX: number;
  /** The pits under gaps: a bike whose centre drops below y between x0 and x1 has crashed. */
  pits?: readonly Pit[];
}

export interface Pit {
  x0: number;
  x1: number;
  y: number;
}

/** Input for a ride: the bike's, plus respawn (0 or 1; held, it holds you at the checkpoint). */
export interface RideInput extends Input {
  respawn: number;
}

/** An input change in a log: the tick it starts at, bits (1 throttle, 2 brake, 4 respawn), lean. */
export type InputEvent = [tick: number, bits: number, lean: number];

export function encodeInput(i: RideInput): number {
  return i.throttle | (i.brake << 1) | (i.respawn << 2);
}

export function decodeInput(bits: number, lean: number, into: RideInput): RideInput {
  into.throttle = bits & 1;
  into.brake = (bits >> 1) & 1;
  into.respawn = (bits >> 2) & 1;
  into.lean = lean;
  return into;
}

export class Ride {
  readonly bike = new Bike();
  tick = 0;
  /** The last checkpoint passed (its index in course.checkpoints). */
  checkpoint = 0;
  /** Ticks since the crash (0 on the tick it happened, and while riding). */
  crashTicks = 0;
  /** The tick the finish line was crossed, or -1. */
  finishTick = -1;

  copyFrom(o: Ride): this {
    this.bike.copyFrom(o.bike);
    this.tick = o.tick;
    this.checkpoint = o.checkpoint;
    this.crashTicks = o.crashTicks;
    this.finishTick = o.finishTick;
    return this;
  }
}

export function startRide(course: Course): Ride {
  const ride = new Ride();
  placeBike(ride.bike, course.checkpoints[0], course.ground);
  return ride;
}

export function respawn(ride: Ride, course: Course): void {
  placeBike(ride.bike, course.checkpoints[ride.checkpoint], course.ground);
  ride.crashTicks = 0;
}

/** One tick. A crashed bike tumbles on, and is back at the checkpoint RESPAWN_TICKS after the crash. */
export function stepRide(ride: Ride, input: Readonly<RideInput>, course: Course): void {
  if (input.respawn) respawn(ride, course);
  else if (ride.bike.crashed && ++ride.crashTicks >= RESPAWN_TICKS) respawn(ride, course);
  else {
    stepBike(ride.bike, input, course.ground);
    if (!ride.bike.crashed && course.pits && inPit(ride.bike, course.pits)) ride.bike.crashed = 1;
    if (!ride.bike.crashed) {
      const cps = course.checkpoints;
      while (ride.checkpoint + 1 < cps.length && ride.bike.x >= cps[ride.checkpoint + 1]) ride.checkpoint++;
      if (ride.finishTick < 0 && ride.bike.x >= course.finishX) ride.finishTick = ride.tick + 1;
    }
  }
  ride.tick++;
}

function inPit(b: Bike, pits: readonly Pit[]): boolean {
  for (const pit of pits) if (b.x > pit.x0 && b.x < pit.x1 && b.y < pit.y) return true;
  return false;
}

/** Every number in a ride's state, in a fixed order: for snapshots sent over the wire. */
export function rideNumbers(ride: Ride): number[] {
  return bikeNumbers(ride.bike, [ride.tick, ride.checkpoint, ride.crashTicks, ride.finishTick]);
}

/** The ride a snapshot from `rideNumbers` describes, bit for bit (JSON keeps every double exactly). */
export function rideFromNumbers(nums: readonly number[], into = new Ride()): Ride {
  let i = 0;
  const next = () => nums[i++];
  into.tick = next();
  into.checkpoint = next();
  into.crashTicks = next();
  into.finishTick = next();
  const b = into.bike;
  b.x = next();
  b.y = next();
  b.vx = next();
  b.vy = next();
  b.c = next();
  b.s = next();
  b.w = next();
  b.lean = next();
  b.crashed = next();
  for (const wh of [b.rear, b.front]) {
    wh.x = next();
    wh.y = next();
    wh.vx = next();
    wh.vy = next();
    wh.a = next();
    wh.w = next();
  }
  for (let k = 0; k < b.warm.length; k++) b.warm[k] = next();
  return into;
}

/** Rides `ticks` ticks from the start gate with the inputs in `log` (sorted by tick). */
export function replay(course: Course, log: readonly InputEvent[], ticks: number): Ride {
  const ride = startRide(course);
  const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
  let next = 0;
  while (ride.tick < ticks) {
    while (next < log.length && log[next][0] <= ride.tick) {
      decodeInput(log[next][1], log[next][2], input);
      next++;
    }
    stepRide(ride, input, course);
  }
  return ride;
}

/**
 * A rider mashing keys: every 0.05 to 0.6 s new inputs, mostly gas, any lean (as a mouse gives),
 * now and then the brake or R. It crashes a lot, so it tests the tumbling as well as the riding.
 */
export function randomInputs(seed: number, ticks: number): InputEvent[] {
  const rng = mulberry32(seed);
  const log: InputEvent[] = [];
  for (let tick = 0; tick < ticks; tick += randInt(rng, 6, 72)) {
    const bits = (rng() < 0.8 ? 1 : 0) | (rng() < 0.12 ? 2 : 0) | (rng() < 0.01 ? 4 : 0);
    log.push([tick, bits, randInt(rng, -8, 8)]);
  }
  return log;
}

/** FNV-1a over the bits of every number in the ride, as 8 hex digits. */
export function rideHash(ride: Ride): string {
  return rideHash32(ride).toString(16).padStart(8, "0");
}

/** The same hash as a number, to send in frames. */
export function rideHash32(ride: Ride): number {
  const bytes = new Uint8Array(new Float64Array(rideNumbers(ride)).buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
