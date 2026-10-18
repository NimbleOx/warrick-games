import {
  B_CCW,
  B_CW,
  B_DOWN,
  B_DROP,
  B_LEFT,
  B_RIGHT,
  COLOR,
  KIND,
  VIRUS,
  fallStep,
  fitsIn,
  markMatches,
  pieceCells,
  removePopped,
  rotated,
  type Bottle,
  type Piece,
} from "./bottle";
import { COLS, ROWS, SPAWN_X } from "./constants";
import { mulberry32, type Rng } from "@warrick/kit/shared/rng";

export type CpuLevel = "easy" | "normal" | "hard";

interface Style {
  /** Ticks before reacting to a new capsule. */
  react: number;
  /** Ticks between button presses. */
  gap: number;
  /** Random slop added to each placement's score. */
  noise: number;
  /** Also think about the next capsule. */
  lookahead: boolean;
  drop: "hard" | "soft" | "lazy";
}

const STYLES: Record<CpuLevel, Style> = {
  easy: { react: 36, gap: 8, noise: 6, lookahead: true, drop: "lazy" },
  normal: { react: 20, gap: 4, noise: 2, lookahead: true, drop: "soft" },
  hard: { react: 10, gap: 2, noise: 0, lookahead: true, drop: "hard" },
};

/** A CPU player's memory. Lives on the server only (and in the home screen's demo). */
export interface Brain {
  level: CpuLevel;
  rng: Rng;
  /** The capsule count the current plan is for. */
  planned: number;
  target: { x: number; rot: number } | null;
  cool: number;
  /** Where the capsule was when we last pressed something, to notice when it isn't moving. */
  last: string;
  stuck: number;
  replans: number;
}

export function newBrain(level: CpuLevel, seed: number): Brain {
  return { level, rng: mulberry32(seed), planned: -1, target: null, cool: 0, last: "", stuck: 0, replans: 0 };
}

/** The buttons a CPU holds this tick. */
export function think(b: Bottle, brain: Brain): number {
  const style = STYLES[brain.level];
  const p = b.piece;
  if (b.phase !== "fall" || !p) return 0;
  if (brain.planned !== b.count) {
    brain.planned = b.count;
    brain.target = plan(b, brain);
    brain.cool = style.react + Math.floor(brain.rng() * style.react * 0.5);
    brain.last = "";
    brain.stuck = 0;
    brain.replans = 0;
  }
  if (brain.cool > 0) {
    brain.cool--;
    return 0;
  }
  const t = brain.target;
  if (t && (p.rot !== t.rot || p.x !== t.x)) {
    const where = `${p.x},${p.rot}`;
    brain.stuck = where === brain.last ? brain.stuck + 1 : 0;
    brain.last = where;
    // Blocked (something in the way, or it fell past the gap): think again from here, then give up.
    if (brain.stuck >= 2) {
      brain.replans++;
      brain.stuck = 0;
      brain.target = brain.replans <= 2 ? plan(b, brain) : null;
    }
    if (brain.target && (p.rot !== brain.target.rot || p.x !== brain.target.x)) {
      const t = brain.target;
      brain.cool = style.gap;
      if (p.rot !== t.rot) return ((t.rot - p.rot + 4) & 3) === 3 ? B_CCW : B_CW;
      return t.x < p.x ? B_LEFT : B_RIGHT;
    }
  }
  switch (style.drop) {
    case "hard":
      return B_DROP;
    case "soft":
      return B_DOWN;
    default:
      return brain.rng() < 0.35 ? B_DOWN : 0;
  }
}

interface Option {
  piece: Piece;
  score: number;
  grid: Uint8Array;
}

function plan(b: Bottle, brain: Brain): { x: number; rot: number } | null {
  const style = STYLES[brain.level];
  const options = placements(b.cells, b.piece!).map((piece) => ({ piece, ...evaluate(b.cells, piece) }));
  if (!options.length) return null;
  let pool = options;
  if (style.lookahead) {
    // Of the best few, which leaves the best spot for the next capsule?
    pool = [...options].sort((x, y) => y.score - x.score).slice(0, 6);
    const [a, c] = b.next;
    for (const o of pool) {
      const spawn: Piece = { x: SPAWN_X, y: 0, rot: 0, a, b: c };
      let best = -1e6;
      if (fitsIn(o.grid, spawn.x, 0, 0)) {
        for (const q of placements(o.grid, spawn)) best = Math.max(best, evaluate(o.grid, q).score);
      }
      o.score += best * 0.6;
    }
  }
  let pick: Option = pool[0];
  let top = -Infinity;
  for (const o of pool) {
    const s = o.score + brain.rng() * style.noise;
    if (s > top) {
      top = s;
      pick = o;
    }
  }
  return { x: pick.piece.x, rot: pick.piece.rot };
}

/**
 * Where a capsule can land: turned in place first, then slid along its row, then dropped.
 * That skips tucks under overhangs, which keeps the plan easy to carry out under gravity.
 */
export function placements(cells: Uint8Array, start: Piece): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const turns of [[], [1], [1, 1], [-1]] as (1 | -1)[][]) {
    let q: Piece | null = { ...start };
    for (const t of turns) q = q && rotated(cells, q, t);
    if (!q) continue;
    const xs = [q.x];
    for (let x = q.x - 1; fitsIn(cells, x, q.y, q.rot); x--) xs.push(x);
    for (let x = q.x + 1; fitsIn(cells, x, q.y, q.rot); x++) xs.push(x);
    for (const x of xs) {
      let y = q.y;
      while (fitsIn(cells, x, y + 1, q.rot)) y++;
      const piece = { ...q, x, y };
      const key = pieceCells(piece)
        .map(([cx, cy, c]) => `${cx},${cy},${c}`)
        .join(";");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(piece);
    }
  }
  return out;
}

/** Scoring weights, tuned by playing simulated bottles. */
const W = { virusNeed: 7, junkNeed: 3.4, blocker: 4.2, height: 0.076, virus: 62, group: 10, chain: 24, hole: 3.4, middle: 31 };

/** Score a landing spot: what it clears, how much work it leaves, and how much danger. */
export function evaluate(cells: Uint8Array, piece: Piece): { score: number; grid: Uint8Array } {
  const grid = cells.slice();
  const parts = pieceCells(piece);
  if (parts.some(([, y]) => y < 0)) return { score: -1e6, grid };
  for (const [x, y, c, kind] of parts) grid[y * COLS + x] = kind | c;

  let score = 0;
  // A lying capsule over a gap leaves a hole that's hard to fill.
  for (const [x, y] of parts) {
    if (y + 1 < ROWS && !parts.some(([px, py]) => px === x && py === y + 1) && !grid[(y + 1) * COLS + x]) score -= W.hole;
  }

  let viruses = 0;
  let groups = 0;
  let chains = 0;
  for (let guard = 0; guard < 24; guard++) {
    const m = markMatches(grid);
    if (!m.groups) break;
    chains++;
    groups += m.groups;
    viruses += m.viruses;
    removePopped(grid);
    while (fallStep(grid));
  }
  score += viruses * W.virus + groups * W.group + Math.max(0, chains - 1) * W.chain;
  return { score: score - work(grid), grid };
}

/**
 * Roughly how many more halves the bottle needs, as a cost. Every vertical line of one color
 * needs filling up to four: lines through viruses count most, and every other color piled on a
 * virus line costs extra. Tall columns cost too, the middle two most: that's where capsules appear.
 */
function work(grid: Uint8Array): number {
  let cost = 0;
  for (let x = 0; x < COLS; x++) {
    let topY = ROWS;
    let blockers = 0;
    let y = 0;
    while (y < ROWS) {
      const c = grid[y * COLS + x];
      if (!c) {
        y++;
        continue;
      }
      if (topY === ROWS) topY = y;
      const color = c & COLOR;
      let n = 0;
      let hasVirus = false;
      while (y + n < ROWS && (grid[(y + n) * COLS + x] & COLOR) === color) {
        if ((grid[(y + n) * COLS + x] & KIND) === VIRUS) hasVirus = true;
        n++;
      }
      const need = 4 - Math.min(3, n);
      cost += hasVirus ? need * W.virusNeed + blockers * W.blocker : need * W.junkNeed;
      blockers += n;
      y += n;
    }
    const height = ROWS - topY;
    cost += height * height * W.height;
    if ((x === SPAWN_X || x === SPAWN_X + 1) && topY <= 4) cost += (5 - topY) * W.middle;
  }
  return cost;
}
