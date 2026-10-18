/**
 * Your own bike, on your own screen: it's stepped here first, so the controls answer at once,
 * and the room steps the same bike from the inputs this sends (see `RideMsg`). Both get the same
 * ride bit for bit; the room's hashes in its frames check that, and if they ever differ this
 * takes the room's bike and rides on from there with its own inputs (`adopt`).
 *
 * No DOM here, so the tests can ride it against the real room.
 */

import { HASH_EVERY } from "./constants";
import type { RideMsg } from "./protocol";
import {
  Ride,
  decodeInput,
  encodeInput,
  rideFromNumbers,
  rideHash32,
  startRide,
  stepRide,
  type Course,
  type InputEvent,
  type RideInput,
} from "./ride";

/** How long hashes are kept for checking, in ticks. */
const KEEP_HASHES = 20 * HASH_EVERY;

export class LocalRider {
  readonly ride: Ride;
  /** The ride a tick ago, for drawing between ticks. */
  readonly prev = new Ride();
  /** Every input change this run, by tick, from the gate (or from where a snapshot took over). */
  log: InputEvent[] = [];
  private readonly input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
  /** The first tick the next message covers. */
  private sendFrom: number;
  private readonly hashes = new Map<number, number>();

  constructor(
    readonly course: Course,
    readonly run: number,
    snapshot?: { ride: readonly number[]; input: readonly [number, number] },
  ) {
    this.ride = snapshot ? rideFromNumbers(snapshot.ride) : startRide(course);
    const [bits, lean] = snapshot?.input ?? [0, 0];
    this.log.push([this.ride.tick, bits, lean]);
    decodeInput(bits, lean, this.input);
    this.prev.copyFrom(this.ride);
    this.sendFrom = this.ride.tick;
  }

  /** Steps the bike up to `target`. `read` sets the input for each tick (it's logged when it changes). */
  advance(target: number, read: (into: RideInput) => void, onStep?: (ride: Ride) => void): void {
    while (this.ride.tick < target) {
      read(this.input);
      const last = this.log[this.log.length - 1];
      const bits = encodeInput(this.input);
      if (last[1] !== bits || last[2] !== this.input.lean) {
        if (last[0] === this.ride.tick) this.log[this.log.length - 1] = [this.ride.tick, bits, this.input.lean];
        else this.log.push([this.ride.tick, bits, this.input.lean]);
      }
      this.step(this.input);
      onStep?.(this.ride);
    }
  }

  private step(input: RideInput): void {
    this.prev.copyFrom(this.ride);
    stepRide(this.ride, input, this.course);
    const t = this.ride.tick;
    if (t % HASH_EVERY === 0) {
      this.hashes.set(t, rideHash32(this.ride));
      this.hashes.delete(t - KEEP_HASHES);
    }
  }

  /** The input in effect at a tick. */
  inputAt(tick: number): InputEvent {
    let e = this.log[0];
    for (const x of this.log) {
      if (x[0] > tick) break;
      e = x;
    }
    return [tick, e[1], e[2]];
  }

  /**
   * The message to send now: the input in effect where the last one sent left off, every change
   * since, and how far we are. Call `sent` once it's gone (a message that couldn't go is covered
   * by the next one).
   */
  message(): RideMsg {
    const from = this.sendFrom;
    const ev: InputEvent[] = [this.inputAt(from), ...this.log.filter((e) => e[0] > from)];
    return { t: "ride", run: this.run, ev, upTo: this.ride.tick };
  }

  sent(msg: RideMsg): void {
    this.sendFrom = Math.max(this.sendFrom, msg.upTo);
  }

  /** Whether the room's hash of our bike at `tick` matches ours (true if we can't tell). */
  check(tick: number, hash: number): boolean {
    const ours = this.hashes.get(tick);
    return ours === undefined || ours === hash;
  }

  /**
   * Take the room's bike (from a sync or a welcome) and ride it on to where we were, with our
   * own inputs from its tick: what the room will do with the inputs we've sent. The next message
   * restates everything from its tick, in case some of ours never arrived.
   */
  adopt(nums: readonly number[], input: readonly [number, number]): void {
    const was = this.ride.tick;
    rideFromNumbers(nums, this.ride);
    const t = this.ride.tick;
    // The whole log stays, so the run can be replayed from the gate (a ghost of it, say).
    this.log = [...this.log.filter((e) => e[0] < t), [t, input[0], input[1]], ...this.log.filter((e) => e[0] >= t)];
    // Hashes from before are of the bike we just dropped: nothing to check them against now.
    this.hashes.clear();
    if (t % HASH_EVERY === 0) this.hashes.set(t, rideHash32(this.ride));
    this.sendFrom = t;
    const replay: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
    let next = this.log.findIndex((e) => e[0] >= t);
    while (this.ride.tick < was) {
      while (next < this.log.length && this.log[next][0] <= this.ride.tick) {
        decodeInput(this.log[next][1], this.log[next][2], replay);
        next++;
      }
      this.step(replay);
    }
    this.prev.copyFrom(this.ride);
  }
}
