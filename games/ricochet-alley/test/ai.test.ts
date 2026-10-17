import { describe, expect, it } from "vitest";
import { CpuBrain, traceShot, type CpuLevel } from "../src/shared/ai";
import { MAZE_LOOPINESS, MAZE_SIZES } from "../src/shared/constants";
import { HEADINGS } from "../src/shared/headings";
import { generateMaze, pickSpawns, type Maze } from "../src/shared/maze";
import { mulberry32 } from "../src/shared/rng";
import { World, startingTanks, type Tank } from "../src/shared/sim";

function openMaze(cols: number, rows: number): Maze {
  const h = new Array((rows + 1) * cols).fill(0);
  const v = new Array(rows * (cols + 1)).fill(0);
  for (let c = 0; c < cols; c++) h[c] = h[rows * cols + c] = 1;
  for (let r = 0; r < rows; r++) v[r * (cols + 1)] = v[r * (cols + 1) + cols] = 1;
  return { cols, rows, h, v };
}

function tank(id: string, x: number, y: number, h: number): Tank {
  return { id, x, y, h, tt: 0, alive: true, cd: 0, fire: false };
}

/** Play one CPU-only round; returns the tick it ended on (≤1 tank left), or −1. */
function cpuRound(seed: number, levels: CpuLevel[], maxTicks: number): number {
  const { cols, rows } = MAZE_SIZES.medium;
  const maze = generateMaze(mulberry32(seed), cols, rows, MAZE_LOOPINESS);
  const ids = levels.map((_, i) => `c${i}`);
  const w = new World(maze, { tick: 0, nextId: 1, tanks: startingTanks(ids, pickSpawns(maze, ids.length, mulberry32(seed))), bullets: [] });
  const brains = levels.map((l, i) => new CpuBrain(l, mulberry32(seed * 100 + i)));
  const bits = levels.map(() => 0);
  for (let t = 0; t < maxTicks; t++) {
    brains.forEach((b, i) => {
      const move = b.think(w, i);
      bits[i] = move.bits;
      if (move.fire) w.requestFire(i);
    });
    w.step(bits);
    if (w.aliveCount <= 1) return w.tick;
  }
  return -1;
}

describe("traceShot", () => {
  it("sees a straight shot and nothing when facing away", () => {
    const w = new World(openMaze(6, 1), { tick: 0, nextId: 1, tanks: [tank("a", 50, 50, 0), tank("b", 450, 50, 0)], bullets: [] });
    expect(traceShot(w, 0, 0, 0)).toBe(1);
    // Facing the near wall with no bounces allowed: hits nobody.
    expect(traceShot(w, 0, HEADINGS / 2, 0)).toBe(-1);
    // With one bounce off the left wall it comes back through the shooter first.
    expect(traceShot(w, 0, HEADINGS / 2, 1)).toBe(0);
  });

  it("finds a bank shot round a wall", () => {
    // Two cells side by side with a wall between; the only way is off the top or bottom border.
    const m = openMaze(2, 2);
    m.v[1] = 1; // wall between (0,0) and (1,0)
    const w = new World(m, { tick: 0, nextId: 1, tanks: [tank("a", 50, 50, 0), tank("b", 150, 50, 0)], bullets: [] });
    expect(traceShot(w, 0, 0, 2)).toBe(0); // straight into the wall and back
    let found = -1;
    for (let h = 0; h < HEADINGS; h += 2) if (traceShot(w, 0, h, 1) === 1) found = h;
    expect(found).toBeGreaterThanOrEqual(0);
  });
});

describe("CPU players", () => {
  for (const level of ["easy", "normal", "hard"] as CpuLevel[]) {
    it(`finish a ${level} round`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const end = cpuRound(seed, [level, level, level, level], 30 * 180);
        expect(end, `seed ${seed}`).toBeGreaterThan(0);
      }
    });
  }

  it("hard beats easy more often than not", () => {
    let hardWins = 0;
    let decided = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const { cols, rows } = MAZE_SIZES.small;
      const maze = generateMaze(mulberry32(seed), cols, rows, MAZE_LOOPINESS);
      const w = new World(maze, { tick: 0, nextId: 1, tanks: startingTanks(["h", "e"], pickSpawns(maze, 2, mulberry32(seed))), bullets: [] });
      const brains = [new CpuBrain("hard", mulberry32(seed)), new CpuBrain("easy", mulberry32(seed + 1000))];
      const bits = [0, 0];
      for (let t = 0; t < 30 * 120 && w.aliveCount > 1; t++) {
        brains.forEach((b, i) => {
          const m = b.think(w, i);
          bits[i] = m.bits;
          if (m.fire) w.requestFire(i);
        });
        w.step(bits);
      }
      if (w.aliveCount === 1) {
        decided++;
        if (w.tanks[0].alive) hardWins++;
      }
    }
    expect(decided).toBeGreaterThan(8);
    expect(hardWins / decided).toBeGreaterThan(0.6);
  });
});
