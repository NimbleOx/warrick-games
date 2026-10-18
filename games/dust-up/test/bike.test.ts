import { describe, expect, test } from "vitest";
import { Bike, NO_INPUT, TUNE, placeBike, stepBike, type Input } from "../src/shared/bike";
import { DT, RESPAWN_TICKS } from "../src/shared/constants";
import { Ground, PathBuilder } from "../src/shared/ground";
import { Ride, randomInputs, replay, rideHash, startRide, stepRide, type InputEvent } from "../src/shared/ride";
import { sandboxCourse } from "../src/shared/sandbox";
import bikeSource from "../src/shared/bike.ts?raw";
import groundSource from "../src/shared/ground.ts?raw";
import rideSource from "../src/shared/ride.ts?raw";
import sandboxSource from "../src/shared/sandbox.ts?raw";
import golden from "./fixtures/ride.json";
import random from "./fixtures/random.json";

const flat = new Ground(new PathBuilder(-50, 10).face(0).flat(500).face(10).points);
const pitch = (b: Bike) => (Math.atan2(b.s, b.c) * 180) / Math.PI;

function ride(b: Bike, input: Input, seconds: number, g = flat): void {
  for (let i = 0; i < seconds / DT; i++) stepBike(b, input, g);
}

function onFlat(): Bike {
  const b = new Bike();
  placeBike(b, 0, flat);
  return b;
}

describe("determinism", () => {
  // The recorded ride (test/fixtures/ride.json): 40 s on the sandbox course with a wheelie that
  // loops out, a crash and respawn, a held R, braking, analog lean and the finish. If the physics
  // changes on purpose, put the new hash (and finishTick) in the fixture; otherwise this failing
  // means the sim stopped being deterministic.
  test("the golden ride hashes the same", () => {
    const r = replay(sandboxCourse(), golden.events as InputEvent[], golden.ticks);
    expect(r.finishTick).toBe(golden.finishTick);
    expect(rideHash(r)).toBe(golden.hash);
  });

  // Inputs from a seeded random rider, who crashes a lot: covers the tumbling and respawns too.
  // check.html replays both rides in a browser and compares the same hashes.
  test("the random ride hashes the same", () => {
    const r = replay(sandboxCourse(), randomInputs(random.seed, random.ticks), random.ticks);
    expect(rideHash(r)).toBe(random.hash);
  });

  test("a ride restored from a snapshot carries on exactly the same", () => {
    const course = sandboxCourse();
    const events = golden.events as InputEvent[];
    const half = Math.floor(golden.ticks / 2);
    const first = replay(course, events, half);
    const copy = new Ride().copyFrom(first);
    // Carry on both from the same tick with the inputs from the log.
    const rest = events.filter((e) => e[0] >= half);
    const last = events.filter((e) => e[0] < half).at(-1)!;
    for (const r of [first, copy]) {
      const input = { throttle: last[1] & 1, brake: (last[1] >> 1) & 1, respawn: (last[1] >> 2) & 1, lean: last[2] };
      let next = 0;
      while (r.tick < golden.ticks) {
        while (next < rest.length && rest[next][0] <= r.tick) {
          const [, bits, lean] = rest[next++];
          Object.assign(input, { throttle: bits & 1, brake: (bits >> 1) & 1, respawn: (bits >> 2) & 1, lean });
        }
        stepRide(r, input, course);
      }
    }
    expect(rideHash(copy)).toBe(rideHash(first));
    expect(rideHash(first)).toBe(golden.hash);
  });

  test("the sim uses only arithmetic that every browser rounds the same", () => {
    for (const src of [bikeSource, groundSource, rideSource, sandboxSource]) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/Math\.(?!sqrt|abs|min|max|floor|round|imul)\w+/);
      expect(code).not.toMatch(/\*\*/);
    }
  });
});

describe("physics", () => {
  test("the bike rests on flat ground", () => {
    const b = onFlat();
    ride(b, NO_INPUT, 3);
    expect(b.crashed).toBe(0);
    expect(Math.abs(b.vx)).toBeLessThan(1e-3);
    expect(Math.abs(b.vy)).toBeLessThan(1e-3);
    expect(Math.abs(b.x)).toBeLessThan(0.05);
    expect(Math.abs(pitch(b))).toBeLessThan(1);
    // Both wheels on the ground.
    for (const wh of [b.rear, b.front]) expect(wh.y).toBeCloseTo(TUNE.wheelRadius, 2);
  });

  test("throttle drives it forward, up to its top speed", () => {
    const b = onFlat();
    const gas = { throttle: 1, brake: 0, lean: 0 };
    ride(b, gas, 2);
    expect(b.vx).toBeGreaterThan(10);
    expect(b.x).toBeGreaterThan(8);
    ride(b, gas, 6);
    expect(b.vx).toBeGreaterThan(TUNE.topSpeed - 1);
    expect(b.vx).toBeLessThan(TUNE.topSpeed + 0.5);
    expect(b.crashed).toBe(0);
    // Gas alone doesn't lift the front on the flat.
    expect(Math.abs(pitch(b))).toBeLessThan(6);
  });

  test("leaning back with the gas on lifts the front, then flips it over and crashes", () => {
    const b = onFlat();
    const input = { throttle: 1, brake: 0, lean: -8 };
    ride(b, input, 0.6);
    expect(pitch(b)).toBeGreaterThan(15);
    expect(b.crashed).toBe(0);
    let maxPitch = 0;
    for (let i = 0; i < 2 / DT && !b.crashed; i++) {
      stepBike(b, input, flat);
      maxPitch = Math.max(maxPitch, pitch(b));
    }
    expect(b.crashed).toBe(1);
    expect(maxPitch).toBeGreaterThan(90);
  });

  test("leaning back at a standstill doesn't flip it", () => {
    const b = onFlat();
    ride(b, { throttle: 0, brake: 0, lean: -8 }, 2);
    expect(b.crashed).toBe(0);
    expect(pitch(b)).toBeLessThan(10);
  });

  test("the brakes stop it", () => {
    const b = onFlat();
    ride(b, { throttle: 1, brake: 0, lean: 0 }, 2);
    ride(b, { throttle: 0, brake: 1, lean: 0 }, 3);
    expect(Math.abs(b.vx)).toBeLessThan(0.1);
    expect(b.crashed).toBe(0);
  });

  test("in the air, lean turns the bike", () => {
    const sky = new Ground(new PathBuilder(-50, 10).face(-100).flat(500).face(10).points);
    const back = new Bike();
    placeBike(back, 0, flat);
    const forward = back.clone();
    ride(back, { throttle: 0, brake: 0, lean: -8 }, 0.5, sky);
    ride(forward, { throttle: 0, brake: 0, lean: 8 }, 0.5, sky);
    expect(pitch(back)).toBeGreaterThan(20);
    expect(pitch(forward)).toBeLessThan(-20);
  });

  test("a level landing from a 3 m drop is fine", () => {
    const b = onFlat();
    for (const body of [b, b.rear, b.front]) {
      body.y += 3;
      body.vx = 8;
    }
    ride(b, NO_INPUT, 2);
    expect(b.crashed).toBe(0);
    expect(b.y).toBeLessThan(1);
  });
});

describe("the ride", () => {
  test("a crash respawns at the last checkpoint after 1.5 s, upright and still", () => {
    const course = sandboxCourse();
    const r = startRide(course);
    const loop = { throttle: 1, brake: 0, lean: -8, respawn: 0 };
    while (!r.bike.crashed && r.tick < 600) stepRide(r, loop, course);
    expect(r.bike.crashed).toBe(1);
    const idle = { ...loop, throttle: 0, lean: 0 };
    for (let i = 0; i < RESPAWN_TICKS - 1; i++) stepRide(r, idle, course);
    expect(r.bike.crashed).toBe(1);
    stepRide(r, idle, course);
    expect(r.bike.crashed).toBe(0);
    expect(r.bike.x).toBe(course.checkpoints[r.checkpoint]);
    expect(r.bike.vx).toBe(0);
    expect(pitch(r.bike)).toBe(0);
  });

  test("holding R holds the bike at the checkpoint", () => {
    const course = sandboxCourse();
    const r = startRide(course);
    for (let i = 0; i < 240; i++) stepRide(r, { throttle: 1, brake: 0, lean: 0, respawn: 0 }, course);
    expect(r.bike.x).toBeGreaterThan(10);
    for (let i = 0; i < 60; i++) stepRide(r, { throttle: 1, brake: 0, lean: 0, respawn: 1 }, course);
    expect(r.bike.x).toBe(course.checkpoints[r.checkpoint]);
    expect(r.tick).toBe(300);
  });

  test("checkpoints count once passed, in order", () => {
    const r = replay(sandboxCourse(), golden.events as InputEvent[], golden.ticks);
    expect(r.checkpoint).toBe(sandboxCourse().checkpoints.length - 1);
  });
});
