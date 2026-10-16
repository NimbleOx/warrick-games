import { COLS } from "./constants";
import { explore, type Board, type Lane, type Placement } from "./engine";
import { SHAPES, type Piece } from "./pieces";
import type { Rng } from "@warrick/kit/shared/rng";

export type CpuLevel = "easy" | "normal" | "hard";

interface Style {
  /** Milliseconds per piece, give or take a fifth. */
  pace: number;
  hold: boolean;
  /** Random spread added to every score, so weaker CPUs make worse choices. */
  noise: number;
  holes: number;
  /** Builds a well for quads: one column may stay low without counting as bumpy. */
  well: boolean;
  /** How much a clear's garbage counts for, beyond surviving. */
  greed: number;
  /**
   * 0–1: how far the CPU ignores the height a clear removes, so it holds out for clears that
   * send garbage instead of taking every single. High stacks drop it to 0.
   */
  patience: number;
}

const STYLES: Record<CpuLevel, Style> = {
  easy: { pace: 1500, hold: false, noise: 1.2, holes: -2.2, well: false, greed: 0.4, patience: 0 },
  normal: { pace: 850, hold: true, noise: 0.4, holes: -3.2, well: true, greed: 1.2, patience: 0.8 },
  hard: { pace: 470, hold: true, noise: 0, holes: -4, well: true, greed: 1.6, patience: 0.9 },
};

/** How long a CPU takes over a piece, in milliseconds. */
export function cpuPace(level: CpuLevel, rng: Rng): number {
  return STYLES[level].pace * (0.8 + rng() * 0.4);
}

/** The resting places a piece can reach, one per distinct set of cells, turns preferred (for T-spins). */
export function landings(b: Board, p: Piece): Placement[] {
  const best = new Map<string, Placement>();
  for (const s of explore(b, p).values()) {
    if (b.fits(p, s.r, s.x, s.y - 1)) continue;
    const key = SHAPES[p][s.r]
      .map(([dx, dy]) => (s.y - dy) * COLS + s.x + dx)
      .sort((a, c) => a - c)
      .join();
    // Claim the strongest turn that got there: the last kick makes a full T-spin.
    const spin = s.kicks ? (s.kicks & 16 ? 5 : 1 + Math.log2(s.kicks & -s.kicks)) : 0;
    const prev = best.get(key);
    if (!prev || spin > prev.spin) best.set(key, { piece: p, r: s.r, x: s.x, y: s.y, hold: false, spin });
  }
  return [...best.values()];
}

/** Pick where a CPU (or a disconnected player's autopilot) puts the piece in play. */
export function choose(lane: Lane, level: CpuLevel, rng: Rng, known: number): Placement | null {
  const style = STYLES[level];
  let best: Placement | null = null;
  let bestScore = -Infinity;
  // Low stacks hold out for clears that send something; high ones take any clear going.
  const patience = lane.board.height() > 9 ? 0 : style.patience;
  for (const hold of style.hold ? [false, true] : [false]) {
    const piece = hold ? lane.swapped : lane.current;
    if (hold && piece === lane.current) continue;
    for (const spot of landings(lane.board, piece)) {
      const pl = { ...spot, hold };
      const sim = lane.clone();
      const res = sim.lock(pl, known);
      if (!res) continue;
      let score: number;
      if (res.out) {
        score = -1e6;
      } else {
        score = judge(sim.board, style) * (1 - patience);
        if (patience) {
          const placed = lane.board.clone();
          placed.place(pl.piece, pl.r, pl.x, pl.y);
          score += judge(placed, style) * patience;
        }
        score += res.attack * style.greed + Math.min(res.attack, lane.pending()) * 0.8;
        // Rows spent on a clear that sends less than it uses could have gone towards a quad.
        score -= Math.max(0, res.cleared.length - res.attack) * style.greed * patience * 1.5;
      }
      if (style.noise) score += (rng() - 0.5) * style.noise * 2;
      if (score > bestScore) {
        bestScore = score;
        best = pl;
      }
    }
  }
  return best;
}

function judge(b: Board, style: Style): number {
  const h: number[] = [];
  let holes = 0;
  let covered = 0;
  const top = b.height();
  for (let x = 0; x < COLS; x++) {
    let y = top - 1;
    while (y >= 0 && !b.get(x, y)) y--;
    h.push(y + 1);
    let above = 0;
    for (; y >= 0; y--) {
      if (b.get(x, y)) above++;
      else {
        holes++;
        covered += above;
      }
    }
  }
  let agg = 0;
  let max = 0;
  let low = 0;
  for (let x = 0; x < COLS; x++) {
    agg += h[x];
    max = Math.max(max, h[x]);
    if (h[x] < h[low]) low = x;
  }
  let bump = 0;
  for (let x = 0; x + 1 < COLS; x++) {
    if (style.well && (x === low || x + 1 === low)) continue;
    bump += Math.abs(h[x] - h[x + 1]);
  }
  let score = -0.51 * agg + style.holes * holes - 0.18 * covered - 0.36 * bump;
  if (style.well) {
    // A well deeper than a quad needs is just a hole waiting to happen.
    const sides = Math.min(low > 0 ? h[low - 1] : 99, low < COLS - 1 ? h[low + 1] : 99);
    score -= Math.max(0, sides - h[low] - 4) * 1.5;
  }
  if (max > 14) score -= (max - 14) * 6;
  return score;
}
