// The CPU riders. The quick tests check what holds on any course: the hard CPU gets round, a
// CPU that's stuck goes back to its checkpoint, and a finished CPU stops. The measurements
// (MEASURE=1 npx vitest run test/ai.test.ts --silent=false) ride a few hundred courses per level,
// for the numbers in the README: one course says little about a CPU's strength.
import { describe, expect, it } from "vitest";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { Pilot } from "../src/shared/ai";
import { TICK_HZ } from "../src/shared/constants";
import { DIFFICULTIES, generateCourse, type CourseLength, type Difficulty } from "../src/shared/course";
import { Ground, PathBuilder } from "../src/shared/ground";
import { startRide, stepRide, type Course, type RideInput } from "../src/shared/ride";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

function rideCourse(level: CpuLevel, course: Course & { capTicks: number }, seed: number) {
  const pilot = new Pilot(level, seed);
  const ride = startRide(course);
  const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
  let crashes = 0;
  let wasCrashed = false;
  while (ride.finishTick < 0 && ride.tick < course.capTicks) {
    pilot.decide(ride, course, input);
    stepRide(ride, input, course);
    if (ride.bike.crashed && !wasCrashed) crashes++;
    wasCrashed = !!ride.bike.crashed;
  }
  return { ride, crashes };
}

describe("CPU riders", () => {
  it.each(DIFFICULTIES)("the hard CPU gets round %s courses well inside the cap", (difficulty) => {
    for (const seed of [3, 4]) {
      const course = generateCourse({ seed, length: "short", difficulty });
      const { ride } = rideCourse("hard", course, seed);
      expect(ride.finishTick).toBeGreaterThan(0);
      expect(ride.finishTick).toBeLessThan(course.parTicks * 1.5);
    }
  });

  it("goes back to its checkpoint when it's stuck", () => {
    const p = new PathBuilder(-14, 8).face(0).flat(60).face(10);
    const course = { ground: new Ground(p.points), checkpoints: [0], finishX: 50 };
    const pilot = new Pilot("hard", 1);
    const ride = startRide(course);
    const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
    // The bike doesn't move (the clock does): after 3 s it holds R.
    const ticks: number[] = [];
    for (; ride.tick < 4 * TICK_HZ; ride.tick++) {
      pilot.decide(ride, course, input);
      if (input.respawn) ticks.push(ride.tick);
    }
    expect(ticks[0]).toBeGreaterThan(3 * TICK_HZ);
    expect(ticks[0]).toBeLessThan(3.2 * TICK_HZ);
  });

  it("rolls to a stop after the finish", () => {
    const course = generateCourse({ seed: 5, length: "short", difficulty: "easy" });
    const pilot = new Pilot("hard", 5);
    const { ride } = rideCourse("hard", course, 5);
    const input: RideInput = { throttle: 0, brake: 0, lean: 0, respawn: 0 };
    for (let i = 0; i < 8 * TICK_HZ; i++) {
      pilot.decide(ride, course, input);
      stepRide(ride, input, course);
    }
    expect(Math.abs(ride.bike.vx)).toBeLessThan(0.5);
    expect(ride.bike.x).toBeLessThan(course.ground.maxX);
  });
});

// ---------------------------------------------------------------------------------------------

function measure(level: CpuLevel, difficulty: Difficulty, length: CourseLength, n: number) {
  let finished = 0;
  let seconds = 0;
  let crashes = 0;
  let cpu = 0;
  let ticks = 0;
  for (let seed = 1000; seed < 1000 + n; seed++) {
    const course = generateCourse({ seed, length, difficulty });
    const t0 = performance.now();
    const r = rideCourse(level, course, seed);
    cpu += performance.now() - t0;
    ticks += r.ride.tick;
    crashes += r.crashes;
    if (r.ride.finishTick >= 0) {
      finished++;
      seconds += r.ride.finishTick / TICK_HZ;
    }
  }
  return {
    level,
    difficulty,
    finished: `${finished}/${n}`,
    "mean time (s)": +(seconds / Math.max(1, finished)).toFixed(1),
    "crashes per course": +(crashes / n).toFixed(2),
    "µs per tick": +((cpu * 1000) / ticks).toFixed(1),
  };
}

describe.skipIf(!env.MEASURE)("CPU strength (MEASURE=1)", () => {
  it("rides a few hundred short courses per level and difficulty", { timeout: 3_600_000 }, () => {
    const n = Number(env.MEASURE) > 1 ? Number(env.MEASURE) : 200;
    const rows = [];
    for (const difficulty of DIFFICULTIES) {
      for (const level of ["easy", "normal", "hard"] as CpuLevel[]) rows.push(measure(level, difficulty, "short", n));
    }
    console.table(rows);
    for (const r of rows) if (r.level === "hard") expect(r.finished).toBe(`${n}/${n}`);
  });
});
