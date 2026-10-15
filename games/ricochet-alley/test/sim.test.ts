import { describe, expect, it } from "vitest";
import {
  BULLET_LIFE,
  CELL,
  MAX_BULLETS,
  MAZE_LOOPINESS,
  REFIRE_TICKS,
  TANK_R,
} from "../src/shared/constants";
import { castPath, pointInRects, rectsOverlapCircle, segmentHitsCircle } from "../src/shared/geom";
import { HEADINGS } from "../src/shared/headings";
import { generateMaze, mazeHeight, mazeWidth, pickSpawns, type Maze, type Rect } from "../src/shared/maze";
import { mulberry32 } from "../src/shared/rng";
import {
  IN_LEFT,
  IN_RIGHT,
  IN_UP,
  World,
  moveBullet,
  startingTanks,
  wallsFor,
  type Bullet,
  type SimEvent,
  type Tank,
} from "../src/shared/sim";

/** A maze with only the outer border. */
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

function world(maze: Maze, tanks: Tank[]): World {
  return new World(maze, { tick: 0, nextId: 1, tanks, bullets: [] });
}

function runUntil(w: World, inputs: number[], pred: (e: SimEvent) => boolean, max = 1000): SimEvent | null {
  for (let i = 0; i < max; i++) {
    const hit = w.step(inputs).find(pred);
    if (hit) return hit;
  }
  return null;
}

describe("castPath", () => {
  const wall: Rect = { x0: 100, y0: -1000, x1: 106, y1: 1000 };

  it("reflects off a face and carries on with the distance left", () => {
    const p = castPath([wall], 50, 50, 20, 0, 4);
    expect(p.pts).toEqual([50, 50, 100, 50, 70, 50]);
    expect(p.vx).toBe(-20);
    expect(p.bounces).toBe(1);
  });

  it("reflects off both walls in a corner", () => {
    const v: Rect = { x0: 100, y0: 0, x1: 110, y1: 200 };
    const h: Rect = { x0: 0, y0: 100, x1: 200, y1: 110 };
    const p = castPath([v, h], 50, 50, 10, 10, 8);
    expect(p.pts.slice(2, 4)).toEqual([100, 100]);
    expect([p.vx, p.vy]).toEqual([-10, -10]);
    expect([p.x, p.y]).toEqual([70, 70]);
  });

  it("bounces many times in one step in a tight gap", () => {
    const a: Rect = { x0: -10, y0: -1000, x1: 0, y1: 1000 };
    const b: Rect = { x0: 10, y0: -1000, x1: 20, y1: 1000 };
    const p = castPath([a, b], 5, 0, 100, 1, 1);
    expect(p.bounces).toBe(10);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(10);
  });

  it("stops at the wall after the last allowed bounce", () => {
    const p = castPath([wall], 50, 50, 20, 0, 100, 0);
    expect(p.stopped).toBe(true);
    expect([p.x, p.y]).toEqual([100, 50]);
  });
});

describe("segmentHitsCircle", () => {
  it("finds the first touch, starts inside, and misses", () => {
    expect(segmentHitsCircle(0, 0, 100, 0, 50, 0, 10)).toBeCloseTo(0.4);
    expect(segmentHitsCircle(45, 0, 100, 0, 50, 0, 10)).toBe(0);
    expect(segmentHitsCircle(0, 20, 100, 20, 50, 0, 10)).toBe(-1);
    expect(segmentHitsCircle(70, 0, 100, 0, 50, 0, 10)).toBe(-1);
  });
});

describe("bullets", () => {
  it("never pass through a wall or leave the maze", () => {
    const rng = mulberry32(99);
    for (let seed = 1; seed <= 6; seed++) {
      const maze = generateMaze(mulberry32(seed), 12, 8, MAZE_LOOPINESS);
      const walls = wallsFor(maze).bullet;
      // Shrink a hair so a point resting exactly on a face doesn't count as inside.
      const solid = walls.map((w) => ({ x0: w.x0 + 1e-6, y0: w.y0 + 1e-6, x1: w.x1 - 1e-6, y1: w.y1 - 1e-6 }));
      for (let n = 0; n < 40; n++) {
        let x: number;
        let y: number;
        do {
          x = rng() * mazeWidth(maze);
          y = rng() * mazeHeight(maze);
        } while (pointInRects(walls, x, y));
        const a = rng() * Math.PI * 2;
        const b: Bullet = { id: n, o: 0, x, y, vx: Math.cos(a) * 10, vy: Math.sin(a) * 10, age: 0 };
        for (let path = moveBullet(b, walls); path; path = moveBullet(b, walls)) {
          for (let p = 0; p + 3 < path.pts.length; p += 2) {
            const [ax, ay, bx, by] = path.pts.slice(p, p + 4);
            const len = Math.hypot(bx - ax, by - ay);
            for (let s = 0; s <= len; s += 0.5) {
              const f = len ? s / len : 0;
              expect(pointInRects(solid, ax + (bx - ax) * f, ay + (by - ay) * f)).toBe(false);
            }
          }
          expect(b.x).toBeGreaterThan(0);
          expect(b.y).toBeGreaterThan(0);
          expect(b.x).toBeLessThan(mazeWidth(maze));
          expect(b.y).toBeLessThan(mazeHeight(maze));
        }
        expect(b.age).toBe(BULLET_LIFE);
      }
    }
  });

  it("allows five in flight and says so when you're out", () => {
    const w = world(openMaze(12, 8), [tank("a", 50, 50, 0)]);
    const fired: SimEvent[] = [];
    for (let i = 0; i < 6 * REFIRE_TICKS + 2; i++) {
      w.requestFire(0);
      fired.push(...w.step([0]));
    }
    expect(fired.filter((e) => e.k === "fire")).toHaveLength(MAX_BULLETS);
    expect(fired.some((e) => e.k === "empty")).toBe(true);
    expect(w.bulletsOf(0)).toBe(MAX_BULLETS);
  });

  it("holds a fire press through the cooldown", () => {
    const w = world(openMaze(12, 8), [tank("a", 50, 50, 0)]);
    w.requestFire(0);
    w.step([0]);
    w.requestFire(0); // pressed again during the cooldown
    const ev = runUntil(w, [0], (e) => e.k === "fire", REFIRE_TICKS + 1);
    expect(ev).not.toBeNull();
  });

  it("kills the tank in front", () => {
    const w = world(openMaze(6, 1), [tank("a", 50, 50, 0), tank("b", 450, 50, HEADINGS / 2)]);
    w.requestFire(0);
    const hit = runUntil(w, [0, 0], (e) => e.k === "hit");
    expect(hit).toMatchObject({ k: "hit", o: 0, t: 1 });
    expect(w.tanks[1].alive).toBe(false);
    expect(w.tanks[0].alive).toBe(true);
  });

  it("kills its own tank when it comes back", () => {
    const w = world(openMaze(3, 1), [tank("a", 50, 50, 0)]);
    w.requestFire(0);
    const hit = runUntil(w, [0], (e) => e.k === "hit");
    expect(hit).toMatchObject({ k: "hit", o: 0, t: 0 });
  });

  it("bounces straight back when fired point-blank into a wall", () => {
    // Nose almost on the right-hand border wall.
    const w = world(openMaze(1, 1), [tank("a", 100 - 3 - TANK_R - 2, 50, 0)]);
    w.requestFire(0);
    const fire = w.step([0]).find((e) => e.k === "fire");
    expect(fire?.k === "fire" && fire.b.vx).toBeLessThan(0);
    expect(w.step([0]).some((e) => e.k === "hit")).toBe(true);
  });

  it("expire after their lifetime", () => {
    const walls = wallsFor(openMaze(12, 8)).bullet;
    const b: Bullet = { id: 1, o: 0, x: 600, y: 400, vx: 7, vy: 3, age: 0 };
    let moves = 0;
    while (moveBullet(b, walls)) moves++;
    expect(moves).toBe(BULLET_LIFE);
  });
});

describe("tanks", () => {
  it("never overlap walls or each other under random driving", () => {
    const rng = mulberry32(1234);
    for (let seed = 1; seed <= 4; seed++) {
      const maze = generateMaze(mulberry32(seed), 9, 6, MAZE_LOOPINESS);
      const spawns = pickSpawns(maze, 6, mulberry32(seed));
      const w = world(maze, startingTanks(["a", "b", "c", "d", "e", "f"], spawns));
      const inputs = [0, 0, 0, 0, 0, 0];
      for (let tick = 0; tick < 1500; tick++) {
        for (let i = 0; i < inputs.length; i++) if (rng() < 0.08) inputs[i] = Math.floor(rng() * 16);
        w.step(inputs);
        for (const t of w.tanks) {
          expect(rectsOverlapCircle(w.walls.tank, t.x, t.y, TANK_R - 0.05)).toBe(false);
          for (const o of w.tanks) {
            if (o !== t) expect(Math.hypot(o.x - t.x, o.y - t.y)).toBeGreaterThan(TANK_R * 2 - 0.5);
          }
        }
      }
    }
  });

  it("drive along their heading and turn slowly at first, then faster", () => {
    const w = world(openMaze(6, 6), [tank("a", 300, 300, 0)]);
    w.step([IN_UP]);
    expect([w.tanks[0].x, w.tanks[0].y]).toEqual([305, 300]);
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      w.step([IN_RIGHT]);
      seen.push(w.tanks[0].h);
    }
    expect(seen).toEqual([4, 10, 19, 31, 45, 59, 73]);
    // Switching direction starts the ramp again.
    w.step([IN_LEFT]);
    expect(w.tanks[0].h).toBe(69);
    w.step([0]);
    w.step([IN_LEFT]);
    expect(w.tanks[0].h).toBe(65);
    expect(HEADINGS).toBe(720);
  });

  it("stop at a wall instead of going through", () => {
    const w = world(openMaze(2, 1), [tank("a", 50, 50, 0)]);
    for (let i = 0; i < 100; i++) w.step([IN_UP]);
    expect(w.tanks[0].x).toBeCloseTo(2 * CELL - 3 - TANK_R, 1);
  });
});

describe("world", () => {
  it("replays identically from the same snapshot and inputs", () => {
    const maze = generateMaze(mulberry32(8), 9, 6, MAZE_LOOPINESS);
    const tanks = startingTanks(["a", "b", "c"], pickSpawns(maze, 3, mulberry32(8)));
    const a = world(maze, tanks);
    const b = world(maze, tanks);
    const rng = mulberry32(77);
    const inputs = [0, 0, 0];
    for (let tick = 0; tick < 900; tick++) {
      for (let i = 0; i < 3; i++) if (rng() < 0.1) inputs[i] = Math.floor(rng() * 16);
      if (rng() < 0.05) {
        const i = Math.floor(rng() * 3);
        a.requestFire(i);
        b.requestFire(i);
      }
      expect(a.step(inputs)).toEqual(b.step(inputs));
    }
    expect(a.snapshot()).toEqual(b.snapshot());
    // And a world rebuilt from a snapshot mid-round carries on the same.
    const c = new World(maze, JSON.parse(JSON.stringify(a.snapshot())));
    for (let tick = 0; tick < 300; tick++) expect(c.step(inputs)).toEqual(a.step(inputs));
  });

  it("lets a tank shoot one it's touching", () => {
    // Touching tanks: a shot from one lands on the other next tick.
    const w = world(openMaze(4, 1), [tank("a", 100, 50, 0), tank("b", 100 + TANK_R * 2, 50, 0)]);
    w.requestFire(0);
    w.step([0, 0]);
    const hit = w.step([0, 0]).find((e) => e.k === "hit");
    expect(hit).toMatchObject({ o: 0, t: 1 });
  });
});
