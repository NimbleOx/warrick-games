import { CPU_LEVELS } from "@warrick/kit/shared/constants";
import type { Rng } from "@warrick/kit/shared/rng";
import { Board, DIRS, type Dir, type Lane } from "./engine";

export type CpuLevel = (typeof CPU_LEVELS)[number];

/**
 * How a board looks for the future, the usual 2048 way: line by line, reward empty cells and
 * pairs ready to merge, and penalize lines that aren't monotonic (big tiles should sit along an
 * edge, in order) and big tiles in general. Rocks count as filled and break up pairs.
 */
export function evaluate(cells: number[], size: number): number {
  let total = 0;
  const line: number[] = Array(size);
  for (let a = 0; a < size; a++) {
    for (const rows of [true, false]) {
      for (let b = 0; b < size; b++) line[b] = cells[rows ? a * size + b : b * size + a];
      total += lineScore(line);
    }
  }
  return total;
}

function lineScore(line: number[]): number {
  let empty = 0;
  let merges = 0;
  let sum = 0;
  let prev = -1;
  let run = 0;
  let monoL = 0;
  let monoR = 0;
  for (let i = 0; i < line.length; i++) {
    const v = line[i];
    if (v === 0) {
      empty++;
    } else if (v < 0) {
      // A rock: filled, and no pair across it.
      if (run) merges += 1 + run;
      run = 0;
      prev = -1;
    } else {
      sum += v ** 3.5;
      if (v === prev) {
        run++;
      } else {
        if (run) merges += 1 + run;
        run = 0;
        prev = v;
      }
    }
    if (i) {
      const a = Math.max(0, line[i - 1]) ** 4;
      const b = Math.max(0, v) ** 4;
      if (a > b) monoL += a - b;
      else monoR += b - a;
    }
  }
  if (run) merges += 1 + run;
  return 270 * empty + 700 * merges - 47 * Math.min(monoL, monoR) - 11 * sum;
}

/** The best a move can do, looking `depth` of our moves ahead, averaging over where the next tile might land. */
function search(board: Board, depth: number, rng: Rng): number {
  let best = -Infinity;
  for (const d of DIRS) {
    const slide = board.slide(d);
    if (!slide) continue;
    const next = new Board(board.size, slide.cells);
    best = Math.max(best, depth <= 1 ? evaluate(next.cells, next.size) : chance(next, depth - 1, rng));
  }
  return best === -Infinity ? -1e9 : best;
}

function chance(board: Board, depth: number, rng: Rng): number {
  const empty = board.empties();
  if (!empty.length) return search(board, depth, rng);
  // A sample of the empty cells is plenty, and keeps the cost flat as the board opens up.
  const cells = empty.length <= 6 ? empty : pickSome(empty, 6, rng);
  let total = 0;
  for (const c of cells) {
    for (const [v, p] of [
      [1, 0.9],
      [2, 0.1],
    ] as const) {
      board.cells[c] = v;
      total += p * search(board, depth, rng);
      board.cells[c] = 0;
    }
  }
  return total / cells.length;
}

function pickSome(arr: number[], n: number, rng: Rng): number[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * A CPU's next move, or null if it has none. Easy looks one move ahead and often slips;
 * normal looks one move ahead; hard looks two, weighing where the next tile might land.
 */
export function choose(lane: Lane, level: CpuLevel, rng: Rng): Dir | null {
  const board = lane.board;
  const legal = DIRS.filter((d) => board.slide(d));
  if (!legal.length) return null;
  if (level === "easy" && rng() < 0.3) return legal[Math.floor(rng() * legal.length)];
  let best: Dir = legal[0];
  let bestScore = -Infinity;
  for (const d of legal) {
    const slide = board.slide(d)!;
    const next = new Board(board.size, slide.cells);
    let score = level === "hard" ? chance(next, 1, rng) : evaluate(next.cells, next.size);
    if (level === "easy") score += (rng() - 0.5) * 4000;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** How long a CPU takes over each move, in ms. */
export function cpuPace(level: CpuLevel, rng: Rng): number {
  const [lo, hi] = level === "easy" ? [750, 1250] : level === "normal" ? [420, 700] : [260, 420];
  return lo + rng() * (hi - lo);
}
