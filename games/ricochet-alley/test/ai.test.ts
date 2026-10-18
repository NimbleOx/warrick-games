import { describe, expect, it } from "vitest";
import { CpuBrain, traceShot, turnKey, type CpuLevel } from "../src/shared/ai";
import { MAZE_LOOPINESS, MAZE_SIZES } from "../src/shared/constants";
import { HEADINGS, headingDiff, wrapHeading } from "../src/shared/headings";
import { generateMaze, pickSpawns, type Maze } from "../src/shared/maze";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { IN_LEFT, IN_RIGHT, World, moveTank, startingTanks, type Tank } from "../src/shared/sim";

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

/** One hard CPU (tank 0) against a tank that never moves or fires: the tick the round ended on (or −1), and the world. */
function huntIdle(maze: Maze, tanks: Tank[], maxTicks: number): { end: number; w: World } {
  const w = new World(maze, { tick: 0, nextId: 1, tanks, bullets: [] });
  const brain = new CpuBrain("hard", mulberry32(1));
  const bits = [0, 0];
  for (let t = 0; t < maxTicks; t++) {
    const move = brain.think(w, 0);
    bits[0] = move.bits;
    if (move.fire) w.requestFire(0);
    w.step(bits);
    if (w.aliveCount <= 1) return { end: w.tick, w };
  }
  return { end: -1, w };
}

/**
 * Rounds the game dealt with Math.random seeded by mulberry32(seed), in which a hard CPU used to freeze for good
 * against an idle human: it swung between two shots it couldn't turn onto exactly, or a shot and its route.
 * Walls as 0/1 strings (Maze.h, Maze.v); the CPU's tank comes first.
 */
const FROZE: { seed: number; h: string; v: string; tanks: [number, number, number][] }[] = [
  {
    seed: 75,
    h: "111111100001000101010100000010000101111111",
    v: "1001000111000111100111011011000110010001",
    tanks: [[350, 150, 360], [50, 350, 0]],
  },
  {
    seed: 25,
    h: "111111101100100001000001110101010101111111",
    v: "1000100110000101110001111100000110000001",
    tanks: [[450, 50, 180], [250, 350, 180]],
  },
  {
    seed: 77,
    h: "111111101001010011000011000000000111111111",
    v: "1000000111000011101010011101010110100001",
    tanks: [[450, 50, 0], [350, 350, 180]],
  },
];

describe("turnKey", () => {
  it("turns onto any heading exactly, whatever turn key is already held", () => {
    for (let tt = -8; tt <= 8; tt++) {
      for (let diff = 0; diff < HEADINGS; diff++) {
        const t = { x: 0, y: 0, h: 100, tt };
        const goal = wrapHeading(t.h + diff);
        for (let n = 0; n < 32 && t.h !== goal; n++) {
          const key = turnKey(headingDiff(t.h, goal), t.tt);
          moveTank(t, key > 0 ? IN_RIGHT : key < 0 ? IN_LEFT : 0, [], []);
        }
        expect(t.h, `diff ${diff}, tt ${tt}`).toBe(goal);
        expect(turnKey(0, t.tt)).toBe(0);
      }
    }
  });
});

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

  for (const f of FROZE) {
    it(`a hard CPU gets an idle tank in the round seed ${f.seed} froze in`, () => {
      const maze = { cols: 7, rows: 5, h: [...f.h].map(Number), v: [...f.v].map(Number) };
      const tanks = f.tanks.map(([x, y, h], i) => tank(`t${i}`, x, y, h));
      const { end, w } = huntIdle(maze, tanks, 30 * 10);
      expect(end).toBeGreaterThan(0);
      expect(w.tanks[0].alive).toBe(true);
    });
  }

  it("a hard CPU always ends a round against an idle tank", () => {
    for (const size of ["small", "medium"] as const) {
      const { cols, rows } = MAZE_SIZES[size];
      for (let seed = 1; seed <= 30; seed++) {
        const maze = generateMaze(mulberry32(seed), cols, rows, MAZE_LOOPINESS);
        const tanks = startingTanks(["cpu", "idle"], pickSpawns(maze, 2, mulberry32(seed)));
        expect(huntIdle(maze, tanks, 30 * 60).end, `${size} seed ${seed}`).toBeGreaterThan(0);
      }
    }
  });

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
