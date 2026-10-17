import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { Pilot } from "../shared/ai";
import type { GeneratedCourse } from "../shared/course";
import { encodeInput, rideNumbers, startRide, type InputEvent, type Ride, type RideInput } from "../shared/ride";
import type { RaceSnapshot } from "../shared/protocol";

/** One rider's bike in the room: the ride, and the inputs that steer it. */
export class RaceRider {
  readonly ride: Ride;
  /** The input in effect. */
  readonly input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
  /** A human's inputs that haven't been reached yet, by tick. */
  pending: InputEvent[] = [];
  /** How far the rider's own screen has ridden (humans). */
  upTo = 0;
  /** The tick they reached their last checkpoint. */
  cpAt = 0;
  /** The latest hash of the bike, and its tick (humans: they check it against their own). */
  hashTick = -1;
  hash = 0;
  /** The room is stepping the bike without them. */
  away = false;
  /** When the room last sent them their bike, so it doesn't every tick. */
  syncedAt = -Infinity;

  constructor(
    readonly id: string,
    readonly pilot: Pilot | null,
    course: GeneratedCourse,
  ) {
    this.ride = startRide(course);
  }
}

/**
 * The course being ridden: the kit's `live`, in memory only (it changes 120 times a second, far
 * too often to save). A restart loses it, and the course starts again from the gate.
 */
export class Race {
  readonly riders: RaceRider[];
  /** The course clock's tick when the room last stepped the race. */
  clock = 0;

  constructor(
    readonly course: GeneratedCourse,
    readonly run: number,
    riders: { id: string; cpu: CpuLevel | null }[],
  ) {
    this.riders = riders.map(
      (p, i) => new RaceRider(p.id, p.cpu ? new Pilot(p.cpu, (course.spec.seed ^ (i * 7919)) >>> 0) : null, course),
    );
  }

  rider(id: string): RaceRider | undefined {
    return this.riders.find((r) => r.id === id);
  }

  remove(id: string): void {
    const i = this.riders.findIndex((r) => r.id === id);
    if (i >= 0) this.riders.splice(i, 1);
  }

  snapshot(): RaceSnapshot {
    return {
      run: this.run,
      spec: this.course.spec,
      riders: this.riders.map((r) => r.id),
      rides: this.riders.map((r) => rideNumbers(r.ride)),
      inputs: this.riders.map((r) => [encodeInput(r.input), r.input.lean]),
    };
  }
}
