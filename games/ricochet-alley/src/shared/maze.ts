import { CELL, WALL_T } from "./constants";
import { randInt, shuffle, type Rng } from "@warrick/kit/shared/rng";

/**
 * A grid maze. 1 = wall, 0 = open.
 *
 * `h` holds the horizontal walls: h[r * cols + c] is the top edge of cell (c, r), for r in 0..rows (row `rows`
 * is the bottom border). `v` holds the vertical walls: v[r * (cols + 1) + c] is the left edge of cell (c, r),
 * for c in 0..cols (column `cols` is the right border).
 */
export interface Maze {
  cols: number;
  rows: number;
  h: number[];
  v: number[];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 0 right, 1 down, 2 left, 3 up. */
export type Dir = 0 | 1 | 2 | 3;
export const DC = [1, 0, -1, 0] as const;
export const DR = [0, 1, 0, -1] as const;

export const mazeWidth = (m: Maze) => m.cols * CELL;
export const mazeHeight = (m: Maze) => m.rows * CELL;

/** Where the wall on side `d` of cell (c, r) lives: which array, and the index in it. */
function wallAt(m: Maze, c: number, r: number, d: Dir): [number[], number] {
  switch (d) {
    case 0:
      return [m.v, r * (m.cols + 1) + c + 1];
    case 1:
      return [m.h, (r + 1) * m.cols + c];
    case 2:
      return [m.v, r * (m.cols + 1) + c];
    case 3:
      return [m.h, r * m.cols + c];
  }
}

/** Can you go from cell (c, r) to its neighbor on side `d`? */
export function isOpen(m: Maze, c: number, r: number, d: Dir): boolean {
  const nc = c + DC[d];
  const nr = r + DR[d];
  if (nc < 0 || nr < 0 || nc >= m.cols || nr >= m.rows) return false;
  const [arr, i] = wallAt(m, c, r, d);
  return arr[i] === 0;
}

/**
 * Carve a perfect maze with a randomized depth-first search, then knock out a share of the walls that are
 * left so there are loops to circle round. The outer border always stays.
 */
export function generateMaze(rng: Rng, cols: number, rows: number, loopiness: number): Maze {
  const m: Maze = {
    cols,
    rows,
    h: new Array<number>((rows + 1) * cols).fill(1),
    v: new Array<number>(rows * (cols + 1)).fill(1),
  };
  const seen = new Uint8Array(cols * rows);
  const start = randInt(rng, 0, cols * rows - 1);
  const stack = [start];
  seen[start] = 1;
  const options: Dir[] = [];
  while (stack.length) {
    const cell = stack[stack.length - 1];
    const c = cell % cols;
    const r = (cell - c) / cols;
    options.length = 0;
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nc = c + DC[d];
      const nr = r + DR[d];
      if (nc >= 0 && nr >= 0 && nc < cols && nr < rows && !seen[nr * cols + nc]) options.push(d);
    }
    if (!options.length) {
      stack.pop();
      continue;
    }
    const d = options[Math.floor(rng() * options.length)];
    const [arr, i] = wallAt(m, c, r, d);
    arr[i] = 0;
    const next = (r + DR[d]) * cols + c + DC[d];
    seen[next] = 1;
    stack.push(next);
  }

  // Interior walls still standing: the right and bottom side of each cell, where there's a neighbor.
  const standing: [number[], number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !isOpen(m, c, r, 0)) standing.push(wallAt(m, c, r, 0));
      if (r + 1 < rows && !isOpen(m, c, r, 1)) standing.push(wallAt(m, c, r, 1));
    }
  }
  shuffle(rng, standing);
  const knock = Math.round(standing.length * loopiness);
  for (let k = 0; k < knock; k++) {
    const [arr, i] = standing[k];
    arr[i] = 0;
  }
  return m;
}

/**
 * The walls as rectangles, with collinear neighbors merged into one. Each is WALL_T thick and runs half a
 * thickness past its end points, so corners and T-junctions close up.
 */
export function wallRects(m: Maze): Rect[] {
  const half = WALL_T / 2;
  const rects: Rect[] = [];
  for (let r = 0; r <= m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      if (!m.h[r * m.cols + c]) continue;
      const c0 = c;
      while (c + 1 < m.cols && m.h[r * m.cols + c + 1]) c++;
      rects.push({ x0: c0 * CELL - half, y0: r * CELL - half, x1: (c + 1) * CELL + half, y1: r * CELL + half });
    }
  }
  for (let c = 0; c <= m.cols; c++) {
    for (let r = 0; r < m.rows; r++) {
      if (!m.v[r * (m.cols + 1) + c]) continue;
      const r0 = r;
      while (r + 1 < m.rows && m.v[(r + 1) * (m.cols + 1) + c]) r++;
      rects.push({ x0: c * CELL - half, y0: r0 * CELL - half, x1: c * CELL + half, y1: (r + 1) * CELL + half });
    }
  }
  return rects;
}

// ------------------------------------------------------------------ grid helpers

export function cellAt(m: Maze, x: number, y: number): number {
  const c = Math.min(m.cols - 1, Math.max(0, Math.floor(x / CELL)));
  const r = Math.min(m.rows - 1, Math.max(0, Math.floor(y / CELL)));
  return r * m.cols + c;
}

export function cellCenter(m: Maze, cell: number): { x: number; y: number } {
  const c = cell % m.cols;
  const r = (cell - c) / m.cols;
  return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL };
}

/**
 * Breadth-first search over open cell sides from `from`. `dist` is −1 for cells you can't reach; `prev` is
 * the cell each one was reached from (−1 for the start).
 */
export function bfs(m: Maze, from: number): { dist: Int16Array; prev: Int16Array } {
  const n = m.cols * m.rows;
  const dist = new Int16Array(n).fill(-1);
  const prev = new Int16Array(n).fill(-1);
  const queue = new Int16Array(n);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  dist[from] = 0;
  while (head < tail) {
    const cell = queue[head++];
    const c = cell % m.cols;
    const r = (cell - c) / m.cols;
    for (let d = 0; d < 4; d++) {
      if (!isOpen(m, c, r, d as Dir)) continue;
      const next = (r + DR[d]) * m.cols + c + DC[d];
      if (dist[next] !== -1) continue;
      dist[next] = dist[cell] + 1;
      prev[next] = cell;
      queue[tail++] = next;
    }
  }
  return { dist, prev };
}

/** Cells from `from` to `to` inclusive, or [] if unreachable. */
export function pathBetween(m: Maze, from: number, to: number): number[] {
  const { prev, dist } = bfs(m, from);
  if (dist[to] < 0) return [];
  const path = [to];
  for (let c = to; c !== from; ) {
    c = prev[c];
    path.push(c);
  }
  return path.reverse();
}

export interface Spawn {
  x: number;
  y: number;
  /** An open side of the cell to face, so nobody starts staring at a wall. */
  dir: Dir;
}

/**
 * Spread `n` tanks out: each new tank goes in one of the cells furthest (by path) from the tanks already
 * placed, picked at random among the near-best so the layout isn't predictable.
 */
export function pickSpawns(m: Maze, n: number, rng: Rng): Spawn[] {
  const cells = m.cols * m.rows;
  const nearest = new Int16Array(cells).fill(0x7fff);
  const chosen: number[] = [];
  for (let k = 0; k < n; k++) {
    let cell: number;
    if (k === 0) {
      cell = randInt(rng, 0, cells - 1);
    } else {
      let best = -1;
      for (let i = 0; i < cells; i++) if (!chosen.includes(i)) best = Math.max(best, nearest[i]);
      const pool: number[] = [];
      for (let i = 0; i < cells; i++) {
        if (!chosen.includes(i) && nearest[i] >= Math.max(1, Math.floor(best * 0.75))) pool.push(i);
      }
      if (!pool.length) for (let i = 0; i < cells; i++) if (!chosen.includes(i)) pool.push(i);
      cell = pool[randInt(rng, 0, pool.length - 1)];
    }
    chosen.push(cell);
    const { dist } = bfs(m, cell);
    for (let i = 0; i < cells; i++) if (dist[i] >= 0) nearest[i] = Math.min(nearest[i], dist[i]);
  }
  return chosen.map((cell) => {
    const c = cell % m.cols;
    const r = (cell - c) / m.cols;
    const open = ([0, 1, 2, 3] as Dir[]).filter((d) => isOpen(m, c, r, d));
    const dir = open.length ? open[randInt(rng, 0, open.length - 1)] : 0;
    return { ...cellCenter(m, cell), dir };
  });
}
