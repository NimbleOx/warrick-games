import { describe, expect, it } from "vitest";
import { CELL, MAZE_LOOPINESS, MAZE_SIZES, WALL_T } from "../src/shared/constants";
import { COS, HEADINGS, SIN, headingDiff, headingTo } from "../src/shared/headings";
import { bfs, cellAt, generateMaze, isOpen, pathBetween, pickSpawns, wallRects, type Maze } from "../src/shared/maze";
import { mulberry32 } from "@warrick/kit/shared/rng";

function countInterior(m: Maze): number {
  let n = 0;
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      if (c + 1 < m.cols && !isOpen(m, c, r, 0)) n++;
      if (r + 1 < m.rows && !isOpen(m, c, r, 1)) n++;
    }
  }
  return n;
}

describe("headings", () => {
  it("has exact axes and agrees with Math.cos/sin", () => {
    expect(COS[0]).toBe(1);
    expect(SIN[0]).toBe(0);
    expect(COS[HEADINGS / 4]).toBe(0);
    expect(SIN[HEADINGS / 4]).toBe(1);
    expect(COS[HEADINGS / 2]).toBe(-1);
    expect(SIN[(HEADINGS * 3) / 4]).toBe(-1);
    for (let k = 0; k < HEADINGS; k++) {
      const a = (k / HEADINGS) * 2 * Math.PI;
      expect(Math.abs(COS[k] - Math.cos(a))).toBeLessThan(1e-15);
      expect(Math.abs(SIN[k] - Math.sin(a))).toBeLessThan(1e-15);
    }
  });

  it("finds headings and the short way round", () => {
    expect(headingTo(1, 0)).toBe(0);
    expect(headingTo(0, 1)).toBe(HEADINGS / 4); // y down: +y is clockwise from +x
    expect(headingTo(-1, 0)).toBe(HEADINGS / 2);
    expect(headingDiff(10, 700)).toBe(-30);
    expect(headingDiff(700, 10)).toBe(30);
  });
});

describe("maze", () => {
  for (const [name, { cols, rows }] of Object.entries(MAZE_SIZES)) {
    it(`generates a connected ${name} maze with loops and an intact border`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const m = generateMaze(mulberry32(seed), cols, rows, MAZE_LOOPINESS);
        for (let c = 0; c < cols; c++) {
          expect(m.h[c]).toBe(1);
          expect(m.h[rows * cols + c]).toBe(1);
        }
        for (let r = 0; r < rows; r++) {
          expect(m.v[r * (cols + 1)]).toBe(1);
          expect(m.v[r * (cols + 1) + cols]).toBe(1);
        }
        const { dist } = bfs(m, 0);
        expect(Array.from(dist).every((d) => d >= 0)).toBe(true);

        // A perfect maze keeps (all interior walls − (cells − 1)); loopiness removes a share of those.
        const allInterior = (rows - 1) * cols + rows * (cols - 1);
        const perfect = allInterior - (cols * rows - 1);
        expect(countInterior(m)).toBe(perfect - Math.round(perfect * MAZE_LOOPINESS));
      }
    });
  }

  it("is the same maze for the same seed", () => {
    const a = generateMaze(mulberry32(42), 9, 6, MAZE_LOOPINESS);
    const b = generateMaze(mulberry32(42), 9, 6, MAZE_LOOPINESS);
    const c = generateMaze(mulberry32(43), 9, 6, MAZE_LOOPINESS);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("merges walls into rectangles that cover every wall and no opening", () => {
    const m = generateMaze(mulberry32(7), 9, 6, MAZE_LOOPINESS);
    const rects = wallRects(m);
    const covered = (x: number, y: number) => rects.some((w) => x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1);
    let walls = 0;
    for (let r = 0; r <= m.rows; r++) {
      for (let c = 0; c < m.cols; c++) {
        const mid = { x: (c + 0.5) * CELL, y: r * CELL };
        walls += m.h[r * m.cols + c];
        expect(covered(mid.x, mid.y)).toBe(m.h[r * m.cols + c] === 1);
      }
    }
    for (let c = 0; c <= m.cols; c++) {
      for (let r = 0; r < m.rows; r++) {
        const mid = { x: c * CELL, y: (r + 0.5) * CELL };
        walls += m.v[r * (m.cols + 1) + c];
        expect(covered(mid.x, mid.y)).toBe(m.v[r * (m.cols + 1) + c] === 1);
      }
    }
    expect(rects.length).toBeLessThan(walls);
    for (const w of rects) expect(Math.min(w.x1 - w.x0, w.y1 - w.y0)).toBe(WALL_T);
  });

  it("finds paths and spreads spawns out", () => {
    const m = generateMaze(mulberry32(3), 12, 8, MAZE_LOOPINESS);
    const path = pathBetween(m, 0, 12 * 8 - 1);
    expect(path[0]).toBe(0);
    expect(path[path.length - 1]).toBe(12 * 8 - 1);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const ac = a % 12;
      const ar = (a - ac) / 12;
      const d = b === a + 1 ? 0 : b === a + 12 ? 1 : b === a - 1 ? 2 : 3;
      expect(isOpen(m, ac, ar, d)).toBe(true);
    }

    const spawns = pickSpawns(m, 8, mulberry32(5));
    const cells = spawns.map((s) => cellAt(m, s.x, s.y));
    expect(new Set(cells).size).toBe(8);
    for (const s of spawns) {
      const cell = cellAt(m, s.x, s.y);
      const c = cell % 12;
      expect(isOpen(m, c, (cell - c) / 12, s.dir)).toBe(true);
    }
  });
});
