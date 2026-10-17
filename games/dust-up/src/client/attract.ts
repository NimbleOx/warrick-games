import { mulberry32, randInt, randomSeed, shuffle, type Rng } from "@warrick/kit/shared/rng";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { Pilot } from "../shared/ai";
import { Bike } from "../shared/bike";
import { PLAYER_COLORS, TICK_HZ } from "../shared/constants";
import { generateCourse, type GeneratedCourse } from "../shared/course";
import { Ride, startRide, stepRide, type RideInput } from "../shared/ride";
import { Renderer, lerpBike, lookFor, type BikeLook } from "./render";

const LEVELS: CpuLevel[] = ["hard", "hard", "normal", "normal", "easy"];

interface Demo {
  pilot: Pilot;
  ride: Ride;
  prev: Ride;
  input: RideInput;
  look: BikeLook;
  pose: Bike;
}

/** A race of CPUs behind the home screen, the camera on the leader. */
export class Attract {
  private readonly renderer: Renderer;
  private readonly rng: Rng = mulberry32(randomSeed());
  private course!: GeneratedCourse;
  private riders: Demo[] = [];
  private start = 0;
  private lastNow = 0;
  private resetAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.renderer.zoom = 0.8;
    this.reset(performance.now());
  }

  resize(): void {
    this.renderer.resize();
  }

  frame(now: number): void {
    // The tab was hidden: don't fast-forward the race.
    if (now - this.lastNow > 500) this.start += now - this.lastNow;
    this.lastNow = now;
    if (this.resetAt && now > this.resetAt) this.reset(now);
    const target = Math.floor(((now - this.start) * TICK_HZ) / 1000);
    for (const d of this.riders) {
      let steps = 0;
      while (d.ride.tick < target && steps++ < 30) {
        d.prev.copyFrom(d.ride);
        d.pilot.decide(d.ride, this.course, d.input);
        stepRide(d.ride, d.input, this.course);
      }
    }
    const ft = ((now - this.start) * TICK_HZ) / 1000;
    for (const d of this.riders) lerpBike(d.pose, d.prev.bike, d.ride.bike, Math.max(0, Math.min(1, ft - d.ride.tick)));
    const leader = this.riders.reduce((a, b) => (b.pose.x > a.pose.x ? b : a));
    this.renderer.follow(leader.pose, 1 / 60);
    this.renderer.draw(
      this.course,
      this.riders.map((d) => ({ bike: d.pose, look: d.look })),
      leader.ride.checkpoint,
    );
    if (!this.resetAt && (leader.ride.finishTick >= 0 || target > 75 * TICK_HZ)) this.resetAt = now + 4000;
  }

  private reset(now: number): void {
    const rng = this.rng;
    this.course = generateCourse({ seed: randomSeed(), length: "short", difficulty: rng() < 0.5 ? "normal" : "hard" });
    const n = randInt(rng, 3, 5);
    const colors = shuffle(rng, [...PLAYER_COLORS]);
    const levels = shuffle(rng, [...LEVELS]);
    this.riders = [];
    for (let i = 0; i < n; i++) {
      const ride = startRide(this.course);
      this.riders.push({
        pilot: new Pilot(levels[i], randomSeed()),
        ride,
        prev: new Ride().copyFrom(ride),
        input: { throttle: 0, brake: 0, lean: 0, respawn: 0 },
        look: lookFor(colors[i]),
        pose: new Bike(),
      });
    }
    this.renderer.cam.ready = false;
    this.start = now + 800;
    this.lastNow = now;
    this.resetAt = 0;
  }
}
