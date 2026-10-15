import { describe, expect, it } from "vitest";
import { autopilot, newBrain, think, type Brain, type CpuLevel } from "../src/shared/ai";
import type { DeathCause, Dir } from "../src/shared/board";
import { TICKS_PER_SEC } from "../src/shared/constants";
import { mulberry32 } from "../src/shared/rng";
import { Round } from "../src/shared/sim";
import { checkInvariants, parseBoard } from "./ascii";

describe("CPU players", () => {
  it("heads home early when an enemy gets near its trail", () => {
    // A is out on a loop, two cells from home. B is three cells from A's trail.
    const b = parseBoard(`
      ..............
      .AAA..........
      .AAAaaaaaaa...
      .AAA......a...
      ..........a...
      ..............
      ..............
      ..........BBB.
      ..........BBB.
    `);
    Object.assign(b.heads[0], { cell: b.idx(10, 4), dir: 2, alive: true, fresh: false, respawnAt: -1 });
    Object.assign(b.heads[1], { cell: b.idx(11, 7), dir: 0, alive: true, fresh: false, respawnAt: -1 });
    const round = new Round(mulberry32(1), { w: b.w, h: b.h, slots: [0, 1], ticks: 100, countdown: 0, board: b });
    const brain: Brain = { level: "hard", mode: "out", legs: [[2, 6]], prey: -1 };
    const dir = think(round, 0, brain, mulberry32(2));
    expect(brain.mode).toBe("back");
    // Home is up and to the left; going on down would be the planned leg.
    expect([3 as Dir]).toContain(dir);
  });

  it("an easy CPU with no one around keeps going with its plan", () => {
    const b = parseBoard(`
      ..............
      .AAA..........
      .AAAaa........
      .AAA..........
      ..............
      ..............
    `);
    Object.assign(b.heads[0], { cell: b.idx(5, 2), dir: 1, alive: true, fresh: false, respawnAt: -1 });
    const round = new Round(mulberry32(1), { w: b.w, h: b.h, slots: [0], ticks: 100, countdown: 0, board: b });
    const brain: Brain = { level: "easy", mode: "out", legs: [[1, 3]], prey: -1 };
    expect(think(round, 0, brain, mulberry32(2))).toBe(1);
    expect(brain.mode).toBe("out");
  });

  it("autopilot brings a stranded head home and then circles inside its land", () => {
    const b = parseBoard(`
      ..........
      .AAA......
      .AAAaaa...
      .AAA......
      ..........
    `);
    Object.assign(b.heads[0], { cell: b.idx(6, 2), dir: 1, alive: true, fresh: false, respawnAt: -1 });
    const round = new Round(mulberry32(1), { w: b.w, h: b.h, slots: [0], ticks: 200, countdown: 0, board: b });
    const rng = mulberry32(3);
    let claimed = false;
    for (let i = 0; i < 60; i++) {
      round.steer(0, autopilot(round, 0, rng));
      const f = round.step();
      if (f.o.some((o) => o[0] === "c")) claimed = true;
      expect(round.board.heads[0].alive).toBe(true);
    }
    expect(claimed).toBe(true);
    expect(round.board.trails[0].length).toBe(0);
  });

  it("eight CPUs play a full three-minute round cleanly and quickly", () => {
    const rng = mulberry32(2026);
    const levels: CpuLevel[] = ["easy", "normal", "hard", "hard", "normal", "easy", "hard", "normal"];
    const round = new Round(rng, { w: 100, h: 70, slots: [0, 1, 2, 3, 4, 5, 6, 7], ticks: 180 * TICKS_PER_SEC });
    const brains = levels.map((l) => newBrain(l));
    const causes: Record<DeathCause, number> = { wall: 0, trail: 0, self: 0, headon: 0, squeeze: 0, left: 0 };
    let claims = 0;

    const started = performance.now();
    while (!round.over) {
      if (round.playing) {
        for (let s = 0; s < 8; s++) {
          if (round.board.heads[s].alive) round.steer(s, think(round, s, brains[s], rng));
        }
      }
      const f = round.step();
      for (const op of f.o) {
        if (op[0] === "d") causes[op[4]]++;
        if (op[0] === "c") claims++;
      }
      if (round.n % 100 === 0) checkInvariants(round.board);
    }
    const msPerTick = (performance.now() - started) / round.n;

    const best = round.best;
    console.log(
      `soak: ${msPerTick.toFixed(3)} ms/tick, ${claims} claims, deaths ${JSON.stringify(causes)}, ` +
        `best land ${best.join(" ")}, kills ${round.kills.join(" ")}`,
    );
    // Everyone got out and claimed something worthwhile.
    expect(best.every((n) => n > 40)).toBe(true);
    expect(claims).toBeGreaterThan(100);
    // CPUs shouldn't be wrecking themselves.
    expect(causes.wall + causes.self).toBeLessThan(8);
    // Somebody cut somebody's trail.
    expect(causes.trail).toBeGreaterThan(0);
    // Well within a Durable Object's budget at 10 ticks a second.
    expect(msPerTick).toBeLessThan(2);
  });
});
