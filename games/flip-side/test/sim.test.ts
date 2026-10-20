import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { describe, expect, test } from "vitest";
import { TICK_HZ } from "../src/shared/constants";
import { dcos, dsin } from "../src/shared/dmath";
import {
  AUTO_TICKS,
  B_FREE,
  B_OFF,
  B_PLUNGER,
  B_SCOOP,
  EV_BANK,
  EV_DRAIN,
  EV_LANES,
  EV_MULTIBALL,
  EV_SAVED,
  EV_SEND,
  EV_TILT,
  IN_LEFT,
  IN_NUDGE,
  IN_PLUNGE,
  IN_RIGHT,
  Play,
  POWER_MAX,
  T_BRICK,
  T_SHRINK,
  T_SWAP,
  TUNE,
  applyTrouble,
  playFromNumbers,
  playHash,
  playNumbers,
  startPlay,
  stepPlay,
  type Rules,
} from "../src/shared/sim";
import { FLIP_REST, FLIP_UP, TABLE } from "../src/shared/table";
import dmathSource from "../src/shared/dmath.ts?raw";
import localSource from "../src/shared/local.ts?raw";
import simSource from "../src/shared/sim.ts?raw";
import tableSource from "../src/shared/table.ts?raw";

const TIMED: Rules = { mode: "timed", endTick: 3 * 60 * TICK_HZ, balls: 3, seed: 1234 };
const BALLS: Rules = { mode: "balls", endTick: 10 * 60 * TICK_HZ, balls: 3, seed: 1234 };

/** A player mashing buttons: flips now and then, plunges, sometimes nudges. */
function randomInputs(seed: number, ticks: number): [number, number][] {
  const rng = mulberry32(seed);
  const log: [number, number][] = [];
  for (let tick = 0; tick < ticks; tick += randInt(rng, 3, 40)) {
    const bits =
      (rng() < 0.35 ? IN_LEFT : 0) |
      (rng() < 0.35 ? IN_RIGHT : 0) |
      (rng() < 0.3 ? IN_PLUNGE : 0) |
      (rng() < 0.03 ? IN_NUDGE : 0);
    log.push([tick, bits]);
  }
  return log;
}

function replay(rules: Rules, log: [number, number][], ticks: number, troubles: [number, number, number][] = []): Play {
  const p = startPlay(rules);
  let bits = 0;
  let next = 0;
  while (p.tick < ticks) {
    while (next < log.length && log[next][0] <= p.tick) bits = log[next++][1];
    for (const [at, kind, param] of troubles) if (at === p.tick) applyTrouble(p, kind, param, TABLE);
    stepPlay(p, bits, TABLE, rules);
  }
  return p;
}

/** A game with one ball free at (x, y), moving at (vx, vy), and nothing else going on. */
function ballAt(x: number, y: number, vx = 0, vy = 0, rules = TIMED): Play {
  const p = startPlay(rules);
  const b = p.balls[0];
  b.st = B_FREE;
  b.x = x;
  b.y = y;
  b.vx = vx;
  b.vy = vy;
  return p;
}

function run(p: Play, ticks: number, bits = 0, rules = TIMED): number[] {
  const kinds: number[] = [];
  for (let i = 0; i < ticks; i++) {
    stepPlay(p, typeof bits === "number" ? bits : 0, TABLE, rules);
    for (const e of p.events) kinds.push(e.k);
  }
  return kinds;
}

describe("determinism", () => {
  // Two minutes of a random player on the table, with trouble landing. If the physics or the
  // rules change on purpose, put the new hash here; otherwise this failing means the sim
  // stopped being deterministic.
  test("a recorded game hashes the same", () => {
    const ticks = 2 * 60 * TICK_HZ;
    const troubles: [number, number, number][] = [
      [1500, T_BRICK, 2],
      [4000, T_SHRINK, 0],
      [7000, T_SWAP, 0],
    ];
    const p = replay(TIMED, randomInputs(99, ticks), ticks, troubles);
    expect(p.score).toBeGreaterThan(0);
    expect(playHash(p)).toBe(GOLDEN);
  });

  test("a game restored from a snapshot carries on exactly the same", () => {
    const log = randomInputs(7, 6000);
    const half = replay(TIMED, log, 3000);
    const copy = playFromNumbers(playNumbers(half));
    for (const p of [half, copy]) {
      let bits = log.filter((e) => e[0] < 3000).at(-1)![1];
      let next = log.findIndex((e) => e[0] >= 3000);
      while (p.tick < 6000) {
        while (next < log.length && log[next][0] <= p.tick) bits = log[next++][1];
        stepPlay(p, bits, TABLE, TIMED);
      }
    }
    expect(playHash(copy)).toBe(playHash(half));
    expect(playHash(half)).toBe(playHash(replay(TIMED, log, 6000)));
  });

  test("the sim uses only arithmetic that every browser rounds the same", () => {
    for (const src of [simSource, tableSource, dmathSource, localSource]) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code).not.toMatch(/Math\.(?!sqrt|abs|min|max|floor|round|imul)\w+/);
      expect(code).not.toMatch(/\*\*/);
    }
  });

  test("dsin and dcos match Math.sin and Math.cos closely", () => {
    for (let a = -10; a <= 10; a += 0.0137) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-14);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-14);
    }
  });
});

describe("the ball and the table", () => {
  test("every wall has a length and a direction", () => {
    for (const s of TABLE.segs) {
      expect(s.len).toBeGreaterThan(1e-3);
      expect(Number.isFinite(s.dx) && Number.isFinite(s.dy) && Number.isFinite(s.nx) && Number.isFinite(s.ny)).toBe(true);
    }
  });

  test("a new game has a ball waiting on the plunger, and it launches when the plunger is let go", () => {
    const p = startPlay(TIMED);
    expect(p.balls[0].st).toBe(B_PLUNGER);
    run(p, 60, IN_PLUNGE);
    expect(p.pull).toBe(60);
    run(p, 1);
    expect(p.balls[0].st).toBe(B_FREE);
    expect(p.balls[0].vy).toBeLessThan(-TUNE.plungeMin);
  });

  test("a ball left on the plunger launches itself", () => {
    const p = startPlay(TIMED);
    run(p, AUTO_TICKS + 1);
    expect(p.balls[0].st).toBe(B_FREE);
  });

  test("a ball dropped on the table falls, and never leaves the cabinet", () => {
    const p = ballAt(253, 300, 900, -400);
    for (let i = 0; i < 600 && p.balls[0].st === B_FREE; i++) {
      stepPlay(p, 0, TABLE, TIMED);
      const b = p.balls[0];
      if (b.st === B_FREE) {
        expect(b.x).toBeGreaterThan(20);
        expect(b.x).toBeLessThan(520);
        expect(b.y).toBeGreaterThan(20);
      }
    }
  });

  test("a held flipper catches a ball rolling down the inlane", () => {
    const p = ballAt(76, 800);
    run(p, 240, IN_LEFT);
    const b = p.balls[0];
    expect(b.st).toBe(B_FREE);
    expect(Math.hypot(b.vx, b.vy)).toBeLessThan(40);
    expect(b.y).toBeLessThan(900);
  });

  test("a flip sends a ball on the flipper up the table", () => {
    const p = ballAt(76, 800);
    run(p, 80);
    let top = Infinity;
    for (let i = 0; i < 90; i++) {
      stepPlay(p, i < 25 ? IN_LEFT : 0, TABLE, TIMED);
      top = Math.min(top, p.balls[0].y);
    }
    expect(top).toBeLessThan(600);
  });

  test("the flippers swing all the way up and back", () => {
    const p = startPlay(TIMED);
    run(p, 10, IN_LEFT | IN_RIGHT);
    expect(p.flip).toEqual([FLIP_UP, FLIP_UP]);
    run(p, 20);
    expect(p.flip).toEqual([FLIP_REST, FLIP_REST]);
  });

  test("the drop targets fall, light the lock, and come back up", () => {
    const p = startPlay(TIMED);
    for (const s of TABLE.segs.filter((x) => x.kind === 4)) {
      const b = p.balls[0];
      b.st = B_FREE;
      // Straight at the middle of the target, from in front of it.
      const mx = (s.ax + s.bx) / 2;
      const my = (s.ay + s.by) / 2;
      const nx = s.ny > 0 ? s.nx : -s.nx;
      const ny = s.ny > 0 ? s.ny : -s.ny;
      b.x = mx + nx * 40;
      b.y = my + ny * 40;
      b.vx = -nx * 900;
      b.vy = -ny * 900;
      const kinds = run(p, 12);
      if (s.id === 2) expect(kinds).toContain(EV_BANK);
    }
    expect(p.drops).toBe(7);
    expect(p.lockLit).toBe(1);
    p.balls[0].st = B_OFF;
    p.balls[0].x = 0;
    run(p, 2 * TICK_HZ);
    expect(p.drops).toBe(0);
  });

  test("all three top lanes raise the bonus multiplier", () => {
    const p = startPlay(TIMED);
    for (let lane = 0; lane < 3; lane++) {
      const b = p.balls[0];
      b.st = B_FREE;
      b.x = 313 + lane * 46;
      b.y = 145;
      b.vx = 0;
      b.vy = 200;
      const kinds = run(p, 10);
      if (lane === 2) expect(kinds).toContain(EV_LANES);
    }
    expect(p.mult).toBe(2);
    expect(p.lanes).toBe(0);
  });

  test("the scoop holds the ball, then kicks it out", () => {
    const sc = TABLE.scoop;
    // Coming up the scoop's lane, the way it kicks balls out but backwards.
    const p = ballAt(sc.x + sc.vx * 0.06, sc.y + sc.vy * 0.06, -sc.vx, -sc.vy);
    run(p, 20);
    expect(p.balls[0].st).toBe(B_SCOOP);
    run(p, TICK_HZ);
    expect(p.balls[0].st).toBe(B_FREE);
    expect(p.balls[0].vy).toBeGreaterThan(0);
  });

  test("two locks start multiball, with balls launched from the plunger", () => {
    const sc = TABLE.scoop;
    const p = startPlay(TIMED);
    p.balls[0].st = B_OFF;
    p.lockLit = 1;
    p.locks = 1;
    const b = p.balls[1];
    b.st = B_FREE;
    b.x = sc.x + sc.vx * 0.06;
    b.y = sc.y + sc.vy * 0.06;
    b.vx = -sc.vx;
    b.vy = -sc.vy;
    const kinds = run(p, 2 * TICK_HZ);
    expect(kinds).toContain(EV_MULTIBALL);
    expect(p.multi).toBe(1);
    // Three balls: on the table, on the plunger, or waiting for the shooter lane to clear.
    expect(p.balls.filter((x) => x.st !== B_OFF).length + p.mbQueue).toBe(3);
  });
});

describe("draining, bonus and the end", () => {
  test("ball save puts a drained ball back on the plunger", () => {
    const p = ballAt(253, 1000, 0, 400);
    p.save = 100;
    const kinds = run(p, 12);
    expect(kinds).toContain(EV_SAVED);
    expect(p.balls.some((b) => b.st === B_PLUNGER)).toBe(true);
    expect(p.ball).toBe(1);
  });

  test("a drain pays the bonus times the multiplier and serves the next ball", () => {
    const p = ballAt(253, 1000, 0, 400);
    p.bonus = 1000;
    p.mult = 3;
    const score = p.score;
    const kinds = run(p, 12);
    expect(kinds).toContain(EV_DRAIN);
    expect(p.score).toBe(score + 3000);
    expect(p.mult).toBe(1);
    run(p, 2 * TICK_HZ);
    expect(p.ball).toBe(2);
    expect(p.balls.some((b) => b.st === B_PLUNGER)).toBe(true);
  });

  test("in balls mode, the last ball draining ends the game", () => {
    const p = ballAt(253, 1000, 0, 400, BALLS);
    p.left = 0;
    p.ball = 3;
    run(p, 12, 0, BALLS);
    expect(p.over).toBe(1);
  });

  test("a timed game ends at its time, paying the bonus of the ball in play", () => {
    const rules: Rules = { ...TIMED, endTick: 200 };
    const p = ballAt(253, 300, 0, 0, rules);
    p.bonus = 500;
    run(p, 200, 0, rules);
    expect(p.over).toBe(1);
    expect(p.score).toBeGreaterThanOrEqual(500);
    const tick = p.tick;
    run(p, 10, 0, rules);
    expect(p.tick).toBe(tick + 10);
  });

  test("three quick nudges tilt the ball: dead flippers and no bonus", () => {
    const p = ballAt(253, 400);
    p.bonus = 5000;
    const kinds: number[] = [];
    for (let i = 0; i < 3; i++) {
      kinds.push(...run(p, 1, IN_NUDGE));
      kinds.push(...run(p, 1));
    }
    expect(kinds).toContain(EV_TILT);
    expect(p.tilted).toBe(1);
    run(p, 10, IN_LEFT);
    expect(p.flip[0]).toBe(FLIP_REST);
  });

  test("full power sends trouble", () => {
    const p = startPlay(TIMED);
    p.power = POWER_MAX - 1;
    p.lanes = 3;
    const b = p.balls[0];
    b.st = B_FREE;
    b.x = 405;
    b.y = 145;
    b.vy = 200;
    const kinds = run(p, 10);
    expect(kinds).toContain(EV_SEND);
    expect(p.sent).toBe(1);
  });
});

describe("trouble", () => {
  test("swap: the left button works the right flipper", () => {
    const p = startPlay(TIMED);
    applyTrouble(p, T_SWAP, 0, TABLE);
    run(p, 10, IN_LEFT);
    expect(p.flip[0]).toBe(FLIP_REST);
    expect(p.flip[1]).toBe(FLIP_UP);
  });

  test("a brick is in the way, and goes when its time is up", () => {
    const spot = TABLE.brickSpots[0];
    const p = ballAt(spot.x, spot.y - 60, 0, 0);
    applyTrouble(p, T_BRICK, 0, TABLE);
    run(p, 30);
    expect(p.balls[0].y).toBeLessThan(spot.y);
    run(p, 12 * TICK_HZ);
    expect(p.trouble[T_BRICK]).toBe(0);
  });

  test("shrink makes a flip weaker at the tip: the ball rolls past where a full flipper is", () => {
    const p = ballAt(220, 880);
    applyTrouble(p, T_SHRINK, 0, TABLE);
    expect(p.trouble[T_SHRINK]).toBeGreaterThan(0);
    run(p, 60);
    expect(p.balls[0].y).toBeGreaterThan(900);
  });
});

/** The hash of the recorded game (see "a recorded game hashes the same"). */
const GOLDEN = "349c0a76";
