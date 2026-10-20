// The CPU players. They search with a fast copy of the rules of their own: a move is one integer
// and the board an Int8Array, so a search can look at tens of thousands of positions in a few
// milliseconds. The tests check that it finds exactly the moves `legalShoves` does.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { CELLS, NB, RING } from "./hex";
import { EMPTY, MARBLES, TO_WIN, type Move } from "./rules";

// ------------------------------------------------------------------ moves as integers

// tail (6 bits) | axis (2) | marbles − 1 (2) | direction (3) | kind (2): the line's marbles run
// from `tail` along `axis` (east, north-east or north-west), and kind says whether the move pushes.
const PLAIN = 0;
const PUSH = 1;
const OFF = 2;

const enc = (tail: number, axis: number, n: number, dir: number, kind: number) =>
  tail | (axis << 6) | ((n - 1) << 8) | (dir << 10) | (kind << 13);
const kindOf = (code: number) => code >> 13;

/** The move an integer stands for, as the rules (and the wire) take it. */
export function decode(code: number): Move {
  const tail = code & 63;
  const axis = (code >> 6) & 3;
  const n = ((code >> 8) & 3) + 1;
  const marbles = [tail];
  for (let i = 1; i < n; i++) marbles.push(NB[marbles[i - 1] * 6 + axis]);
  return { marbles, dir: (code >> 10) & 7 };
}

/** Pushes along the line from `front`: OFF or PUSH or PLAIN, or −1 if it can't go. */
function inline(b: Int8Array, seat: number, front: number, dir: number, n: number): number {
  let at = NB[front * 6 + dir];
  if (at < 0 || b[at] === seat) return -1;
  if (b[at] === EMPTY) return PLAIN;
  let k = 0;
  while (at >= 0 && b[at] !== EMPTY && b[at] !== seat) {
    k++;
    at = NB[at * 6 + dir];
  }
  if (k >= n || (at >= 0 && b[at] === seat)) return -1;
  return at < 0 ? OFF : PUSH;
}

/** Every legal move for `seat`, into `out`. Returns how many. */
export function generate(b: Int8Array, seat: number, out: Int32Array): number {
  let k = 0;
  for (let c = 0; c < CELLS; c++) {
    if (b[c] !== seat) continue;
    for (let d = 0; d < 6; d++) {
      const to = NB[c * 6 + d];
      if (to >= 0 && b[to] === EMPTY) out[k++] = enc(c, 0, 1, d, PLAIN);
    }
    for (let a = 0; a < 3; a++) {
      const m1 = NB[c * 6 + a];
      if (m1 < 0 || b[m1] !== seat) continue;
      const m2 = NB[m1 * 6 + a];
      const three = m2 >= 0 && b[m2] === seat;
      for (let n = 2; n <= (three ? 3 : 2); n++) {
        const head = n === 2 ? m1 : m2;
        for (let d = 0; d < 6; d++) {
          if (d === a || d === a + 3) {
            const kind = inline(b, seat, d === a ? head : c, d, n);
            if (kind >= 0) out[k++] = enc(c, a, n, d, kind);
            continue;
          }
          const t0 = NB[c * 6 + d];
          const t1 = NB[m1 * 6 + d];
          if (t0 < 0 || t1 < 0 || b[t0] !== EMPTY || b[t1] !== EMPTY) continue;
          if (n === 3) {
            const t2 = NB[m2 * 6 + d];
            if (t2 < 0 || b[t2] !== EMPTY) continue;
          }
          out[k++] = enc(c, a, n, d, PLAIN);
        }
      }
    }
  }
  return k;
}

/** Make a legal move on the board. */
export function apply(b: Int8Array, seat: number, code: number): void {
  const tail = code & 63;
  const axis = (code >> 6) & 3;
  const n = ((code >> 8) & 3) + 1;
  const dir = (code >> 10) & 7;
  let head = tail;
  for (let i = 1; i < n; i++) head = NB[head * 6 + axis];
  if (n === 1 || dir === axis || dir === axis + 3) {
    // Along the line, the back marble jumps to the front; a pushed run of theirs does the same.
    const front = dir === axis ? head : tail;
    const back = dir === axis ? tail : head;
    const to = NB[front * 6 + dir];
    if (b[to] !== EMPTY) {
      const theirs = b[to];
      let end = to;
      while (end >= 0 && b[end] === theirs) end = NB[end * 6 + dir];
      if (end >= 0) b[end] = theirs;
    }
    b[to] = seat;
    b[back] = EMPTY;
    return;
  }
  let m = tail;
  for (let i = 0; i < n; i++) {
    b[NB[m * 6 + dir]] = seat;
    b[m] = EMPTY;
    m = NB[m * 6 + axis];
  }
}

// ------------------------------------------------------------------ judging a position

const WIN = 1_000_000;
/** A marble on the board. */
const W_MARBLE = 500;
/** Each step in from the rim: the middle is safe, and marbles there push outwards. */
const W_CENTRE = 6;
/** Each pair of touching marbles: groups push and hold; lone marbles get pushed around. */
const W_TOUCH = 3;
const CENTRE = RING.map((r) => (4 - r) * (4 - r + 2));

/** How good the board is for `seat`, from its side: positive is good. */
export function evaluate(b: Int8Array, seat: number): number {
  let mine = 0;
  let theirs = 0;
  let pos = 0;
  for (let c = 0; c < CELLS; c++) {
    const v = b[c];
    if (v === EMPTY) continue;
    const sign = v === seat ? 1 : -1;
    if (sign > 0) mine++;
    else theirs++;
    let touch = 0;
    for (let d = 0; d < 3; d++) {
      const nb = NB[c * 6 + d];
      if (nb >= 0 && b[nb] === v) touch++;
    }
    pos += sign * (W_CENTRE * CENTRE[c] + W_TOUCH * touch);
  }
  if (theirs <= MARBLES - TO_WIN) return WIN;
  if (mine <= MARBLES - TO_WIN) return -WIN;
  return W_MARBLE * (mine - theirs) + pos;
}

/** The game is won or lost on this board. */
function decided(b: Int8Array): boolean {
  let a = 0;
  let z = 0;
  for (let c = 0; c < CELLS; c++) {
    if (b[c] === 0) a++;
    else if (b[c] === 1) z++;
  }
  return a <= MARBLES - TO_WIN || z <= MARBLES - TO_WIN;
}

// ------------------------------------------------------------------ searching

/** Moves found at each depth of a search: room for the most a position can have (well under 1024). */
const MOVES = Array.from({ length: 8 }, () => new Int32Array(1024));

class Search {
  nodes = 0;
  aborted = false;
  constructor(readonly budget: number) {}

  /** Negamax with alpha-beta: the best `seat` can do from here, `depth` moves deep. */
  value(b: Int8Array, seat: number, depth: number, alpha: number, beta: number, ply: number): number {
    if (++this.nodes > this.budget) {
      this.aborted = true;
      return 0;
    }
    if (depth === 0 || decided(b)) {
      const v = evaluate(b, seat);
      // A win sooner (and a loss later) is better.
      return v === WIN ? WIN - ply : v === -WIN ? -WIN + ply : v;
    }
    const moves = MOVES[ply];
    const n = order(moves, generate(b, seat, moves));
    if (!n) return evaluate(b, seat);
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      const child = b.slice();
      apply(child, seat, moves[i]);
      const v = -this.value(child, 1 - seat, depth - 1, -beta, -alpha, ply + 1);
      if (this.aborted) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }
}

/** Pushes off first, then pushes, then the rest: alpha-beta prunes more when good moves come first. */
function order(moves: Int32Array, n: number): number {
  let w = 0;
  for (const kind of [OFF, PUSH]) {
    for (let i = w; i < n; i++) {
      if (kindOf(moves[i]) !== kind) continue;
      const t = moves[w];
      moves[w++] = moves[i];
      moves[i] = t;
    }
  }
  return n;
}

interface Level {
  /** Moves to look ahead, counting this one. */
  depth: number;
  /** Positions it may look at; past this it plays its best move from the last full depth. */
  budget: number;
  /** Random points added to each move, so it doesn't play the same game every time. */
  noise: number;
  /** How often it plays any legal move at all. */
  wild: number;
}

const LEVELS: Record<CpuLevel, Level> = {
  easy: { depth: 1, budget: 1e9, noise: 90, wild: 0.12 },
  normal: { depth: 2, budget: 1e9, noise: 10, wild: 0 },
  hard: { depth: 4, budget: 60_000, noise: 2, wild: 0 },
};

/**
 * The CPU's move for `seat`, or null if it has none. Searches deeper and deeper up to its level's
 * depth, keeping the best move of the deepest search that finished inside its budget.
 */
export function chooseMove(board: ArrayLike<number>, seat: number, level: CpuLevel, rng: Rng): Move | null {
  const b = Int8Array.from(board);
  const root = new Int32Array(1024);
  const n = generate(b, seat, root);
  if (!n) return null;
  const L = LEVELS[level];
  if (L.wild && rng() < L.wild) return decode(root[Math.floor(rng() * n)]);
  // The same noise for a move at every depth, so a deeper search doesn't reshuffle it.
  const noise = Array.from({ length: n }, () => rng() * L.noise);
  let best = root[0];
  const search = new Search(L.budget);
  for (let depth = 1; depth <= L.depth; depth++) {
    let alpha = -Infinity;
    let pick = -1;
    // The previous depth's best goes first, which makes the cut-offs much better.
    const idx = Array.from({ length: n }, (_, i) => i).sort(
      (i, j) => Number(root[j] === best) - Number(root[i] === best) || kindOf(root[j]) - kindOf(root[i]),
    );
    for (const i of idx) {
      const child = b.slice();
      apply(child, seat, root[i]);
      const v = -search.value(child, 1 - seat, depth - 1, -Infinity, noise[i] - alpha, 1) + noise[i];
      if (search.aborted) break;
      if (v > alpha) {
        alpha = v;
        pick = root[i];
      }
    }
    if (search.aborted) break;
    best = pick;
  }
  return decode(best);
}
