// CPU players. Pure functions of the position, so the server, the tests and the home-screen
// demo all run the same ones.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { MONOMINO, pieceDef, pieceSize } from "./pieces";
import { EMPTY, anchors, eachMove, legalMoves, moveCells, play, squaresPlaced, type Move, type Position } from "./rules";

/** How many of its best moves the hard CPU looks ahead from. */
const HARD_CANDIDATES = 8;

/**
 * Pick a move for `seat`, or null if it has none. `order` is the seats still playing, in turn
 * order; the hard CPU uses it to guess the next player's reply and to find the leader.
 */
export function chooseMove(pos: Position, seat: number, level: CpuLevel, rng: Rng, order: readonly number[] = [seat]): Move | null {
  const moves = legalMoves(pos, seat);
  if (!moves.length) return null;
  if (level === "easy") return easyMove(moves, rng);
  if (level === "normal") return greedyMove(pos, seat, moves, order, rng);
  return hardMove(pos, seat, moves, order, rng);
}

/** Any legal move, but bigger pieces are likelier. */
function easyMove(moves: Move[], rng: Rng): Move {
  const weights = moves.map((m) => pieceSize(m.piece) ** 2);
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < moves.length; i++) {
    r -= weights[i];
    if (r < 0) return moves[i];
  }
  return moves[moves.length - 1];
}

/** Squares placed, plus open corners gained, minus the others' open corners taken. */
function greedyMove(pos: Position, seat: number, moves: Move[], order: readonly number[], rng: Rng | null): Move {
  const ev = evaluator(pos, seat, order, false);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const f = ev(m);
    let score = 3 * f.size + f.corners + 1.5 * f.blocked;
    if (m.piece === MONOMINO && pos.trays[seat].length > 1) score -= 6;
    if (rng) score += rng() * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/**
 * Greedy with more in it (centre early, awkward pieces first, block the leader), then a short
 * lookahead from the best few: play the next player's greedy reply, and count how many squares
 * of the tray could still go down, and from how many corners.
 */
function hardMove(pos: Position, seat: number, moves: Move[], order: readonly number[], rng: Rng): Move {
  const ev = evaluator(pos, seat, order, true);
  const early = Math.max(0, 1 - squaresPlaced(pos.trays[seat]) / 30);
  const scored = moves.map((m) => {
    const f = ev(m);
    let score = 3 * f.size + pieceDef(m.piece).awkward * (0.6 + 0.6 * early) + 1.2 * f.corners + 1.5 * f.blocked + 2 * early * f.centre;
    if (m.piece === MONOMINO && pos.trays[seat].length > 1) score -= 10;
    return { m, score: score + rng() * 0.2 };
  });
  scored.sort((a, b) => b.score - a.score);

  const at = order.indexOf(seat);
  const next = order.length > 1 && at >= 0 ? order[(at + 1) % order.length] : -1;
  let best = scored[0];
  let bestTotal = -Infinity;
  for (const c of scored.slice(0, HARD_CANDIDATES)) {
    let after = play(pos, seat, c.m);
    if (next >= 0 && next !== seat) {
      const replies = legalMoves(after, next);
      if (replies.length) after = play(after, next, greedyMove(after, next, replies, order, null));
    }
    const fits = new Set<Move["piece"]>();
    const corners = new Set<number>();
    let count = 0;
    eachMove(after, seat, (m, anchor) => {
      fits.add(m.piece);
      corners.add(anchor);
      count++;
    });
    let reach = 0;
    for (const p of fits) reach += pieceSize(p);
    const total = c.score + 0.5 * reach + 0.6 * corners.size + 0.01 * Math.min(count, 1500);
    if (total > bestTotal) {
      bestTotal = total;
      best = c;
    }
  }
  return best.m;
}

interface Features {
  size: number;
  /** Open corners this move makes for us, minus the ones it uses up or walls off. */
  corners: number;
  /** The others' open corners it covers, weighted (the leader's count more when `hard`). */
  blocked: number;
  /** How much closer to the centre it gets us than we've been. */
  centre: number;
}

/** Scores the features of a move from `pos` for `seat`, with what can be worked out once. */
function evaluator(pos: Position, seat: number, order: readonly number[], hard: boolean): (m: Move) => Features {
  const { size, cells } = pos;
  const mine = new Uint8Array(size * size);
  for (const a of anchors(pos, seat)) mine[a] = 1;

  const theirs = new Float32Array(size * size);
  const others = order.filter((s) => s !== seat);
  const lead = Math.max(-1, ...others.map((s) => squaresPlaced(pos.trays[s])));
  for (const s of others) {
    const w = hard && squaresPlaced(pos.trays[s]) === lead ? 1.8 : 1;
    for (const a of anchors(pos, s)) theirs[a] += w;
  }

  const mid = (size - 1) / 2;
  const dist = (i: number) => Math.hypot((i % size) - mid, Math.floor(i / size) - mid);
  let reach = dist(pos.starts[seat]);
  if (hard) for (let i = 0; i < cells.length; i++) if (cells[i] === seat) reach = Math.min(reach, dist(i));

  const own = (i: number, placed: number[]) => cells[i] === seat || placed.includes(i);

  return (m) => {
    const placed = moveCells(size, m)!;
    let gained = 0;
    let lost = 0;
    let blocked = 0;
    let closest = reach;
    const seen: number[] = [];
    for (const c of placed) {
      blocked += theirs[c];
      if (hard) closest = Math.min(closest, dist(c));
      const x = c % size;
      const y = (c - x) / size;
      if (mine[c]) lost++;
      for (const [dx, dy] of EDGES) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const n = ny * size + nx;
        if (mine[n] && !placed.includes(n) && !seen.includes(n)) {
          seen.push(n);
          lost++;
        }
      }
      for (const [dx, dy] of DIAGONALS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const n = ny * size + nx;
        if (cells[n] !== EMPTY || mine[n] || placed.includes(n) || seen.includes(n)) continue;
        seen.push(n);
        let walled = false;
        for (const [ex, ey] of EDGES) {
          const qx = nx + ex;
          const qy = ny + ey;
          if (qx >= 0 && qy >= 0 && qx < size && qy < size && own(qy * size + qx, placed)) {
            walled = true;
            break;
          }
        }
        if (!walled) gained++;
      }
    }
    return { size: placed.length, corners: gained - lost, blocked, centre: Math.max(0, reach - closest) };
  };
}

const EDGES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const DIAGONALS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

