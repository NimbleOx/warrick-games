import { DX, DY, type Arena, type Dir } from "./arena";
import type { CpuLevel } from "./protocol";
import type { Rng } from "@warrick/kit/shared/rng";

// Lives in shared/ so the home-screen demo can race the same bots the server uses.

interface Brain {
  /** How many cells of open floor it looks for before it's satisfied. */
  space: number;
  /** Also count the floor it can reach before anyone else (Voronoi territory). */
  territory: boolean;
  /** Chance per tick of an idle turn into roughly-as-good space. */
  wobble: number;
  /** Chance per tick of not paying attention at all. */
  blunder: number;
  /** Chance per tick of boosting down a long clear straight. */
  boost: number;
}

const BRAINS: Record<CpuLevel, Brain> = {
  easy: { space: 20, territory: false, wobble: 0.05, blunder: 0.04, boost: 0.004 },
  normal: { space: 240, territory: false, wobble: 0.02, blunder: 0, boost: 0.008 },
  hard: { space: 900, territory: true, wobble: 0.006, blunder: 0, boost: 0.015 },
};

export interface CpuMove {
  dir: Dir | null;
  boost: boolean;
}

/** Pick a heading for a CPU rider: the one with the most room, avoiding likely head-ons. */
export function steer(arena: Arena, i: number, level: CpuLevel, rng: Rng): CpuMove {
  const brain = BRAINS[level];
  const me = arena.cycles[i];
  if (!me?.alive || rng() < brain.blunder) return { dir: null, boost: false };
  const { w } = arena.cfg;

  // Cells another rider could drive into next tick.
  const danger = new Set<number>();
  if (level !== "easy") {
    arena.cycles.forEach((o, j) => {
      if (j === i || !o.alive) return;
      for (let d = 0; d < 4; d++) {
        const cell = step(arena, o.x, o.y, d as Dir);
        if (cell >= 0) danger.add(cell);
      }
    });
  }

  const options: Dir[] = [me.dir, ((me.dir + 3) % 4) as Dir, ((me.dir + 1) % 4) as Dir];
  const scores = options.map((d, k) => {
    const cell = step(arena, me.x, me.y, d);
    if (cell < 0) return -Infinity;
    const x = cell % w;
    const y = (cell - x) / w;
    let s = flood(arena, x, y, brain.space);
    // Boxed-in options already lose on space; territory only breaks ties between open ones.
    if (brain.territory && s >= brain.space) s += territory(arena, i, x, y);
    if (danger.has(cell)) s = s * 0.2 - 5;
    if (k === 0) s += 1.5; // don't zig-zag for nothing
    return s;
  });

  let best = 0;
  for (let k = 1; k < 3; k++) if (scores[k] > scores[best]) best = k;
  if (scores[best] === -Infinity) return { dir: null, boost: false };
  if (rng() < brain.wobble) {
    const ok = [0, 1, 2].filter((k) => scores[k] > 0 && scores[k] >= scores[best] * 0.75);
    best = ok[Math.floor(rng() * ok.length)] ?? best;
  }

  const dir = options[best];
  let boost = false;
  if (me.boosts > 0 && me.boost === 0 && rng() < brain.boost) boost = clearRun(arena, me.x, me.y, dir, 14) >= 14;
  return { dir: dir === me.dir ? null : dir, boost };
}

/** Index of the open cell one step away, or -1. */
function step(arena: Arena, x: number, y: number, d: Dir): number {
  const { w, h } = arena.cfg;
  let nx = x + DX[d];
  let ny = y + DY[d];
  if (arena.cfg.walls === "wrap") {
    if (nx < 0) nx += w;
    else if (nx >= w) nx -= w;
    if (ny < 0) ny += h;
    else if (ny >= h) ny -= h;
  }
  return arena.open(nx, ny) ? ny * w + nx : -1;
}

function clearRun(arena: Arena, x: number, y: number, d: Dir, max: number): number {
  const { w } = arena.cfg;
  let n = 0;
  while (n < max) {
    const cell = step(arena, x, y, d);
    if (cell < 0) break;
    x = cell % w;
    y = (cell - x) / w;
    n++;
  }
  return n;
}

// Scratch buffers shared by every search, so a tick doesn't allocate.
let seen = new Uint32Array(0);
let dist = new Uint16Array(0);
let queue = new Int32Array(0);
let stamp = 0;

function fresh(n: number): void {
  if (seen.length < n) {
    seen = new Uint32Array(n);
    dist = new Uint16Array(n);
    queue = new Int32Array(n);
    stamp = 0;
  }
  if (++stamp === 0xffffffff) {
    seen.fill(0);
    stamp = 1;
  }
}

/** Open cells reachable from (x, y), counting up to `cap`. */
function flood(arena: Arena, x: number, y: number, cap: number): number {
  const { w, h } = arena.cfg;
  fresh(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = y * w + x;
  seen[y * w + x] = stamp;
  while (head < tail && head < cap) {
    const p = queue[head++];
    const px = p % w;
    const py = (p - px) / w;
    for (let d = 0; d < 4; d++) {
      const q = step(arena, px, py, d as Dir);
      if (q < 0 || seen[q] === stamp) continue;
      seen[q] = stamp;
      queue[tail++] = q;
    }
  }
  return Math.min(head, cap);
}

// For every cell: how far the nearest rider's head is (and whose it is), and how far the nearest
// other rider's is. Worked out once per tick and shared by every CPU's territory count.
const FAR = 0xffff;
let near1 = new Uint16Array(0);
let who1 = new Uint8Array(0);
let near2 = new Uint16Array(0);
let rq = new Int32Array(0);
let rqWho = new Uint8Array(0);
let rivalsArena: Arena | null = null;
let rivalsTick = -1;

/** A breadth-first search from every head at once, where each cell takes the first two riders to reach it. */
function rivals(arena: Arena): void {
  if (rivalsArena === arena && rivalsTick === arena.tick) return;
  rivalsArena = arena;
  rivalsTick = arena.tick;
  const { w, h } = arena.cfg;
  const n = w * h;
  if (near1.length < n) {
    near1 = new Uint16Array(n);
    who1 = new Uint8Array(n);
    near2 = new Uint16Array(n);
    // Each cell is queued at most twice, plus the heads.
    rq = new Int32Array(2 * n + arena.cycles.length);
    rqWho = new Uint8Array(2 * n + arena.cycles.length);
  }
  near1.fill(FAR, 0, n);
  near2.fill(FAR, 0, n);
  who1.fill(0, 0, n);
  let head = 0;
  let tail = 0;
  arena.cycles.forEach((c, j) => {
    if (!c.alive) return;
    const cell = c.y * w + c.x;
    near1[cell] = 0;
    who1[cell] = j + 1;
    rq[tail] = cell;
    rqWho[tail++] = j + 1;
  });
  while (head < tail) {
    const p = rq[head];
    const who = rqWho[head++];
    const d = (who1[p] === who ? near1[p] : near2[p]) + 1;
    const px = p % w;
    const py = (p - px) / w;
    for (let k = 0; k < 4; k++) {
      const q = step(arena, px, py, k as Dir);
      if (q < 0) continue;
      if (who1[q] === 0) {
        who1[q] = who;
        near1[q] = d;
      } else if (who1[q] !== who && near2[q] === FAR) {
        near2[q] = d;
      } else {
        continue;
      }
      rq[tail] = q;
      rqWho[tail++] = who;
    }
  }
}

/**
 * Cells rider i would reach (from x, y) strictly before any other rider. Only those cells are
 * searched: a cell someone else reaches first (or as soon) can't be on rider i's way to one of its own.
 */
export function territory(arena: Arena, i: number, x: number, y: number): number {
  rivals(arena);
  const { w, h } = arena.cfg;
  fresh(w * h);
  const me = i + 1;
  let head = 0;
  let tail = 0;
  const start = y * w + x;
  seen[start] = stamp;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const p = queue[head++];
    const d = dist[p] + 1;
    const px = p % w;
    const py = (p - px) / w;
    for (let k = 0; k < 4; k++) {
      const q = step(arena, px, py, k as Dir);
      if (q < 0 || seen[q] === stamp) continue;
      seen[q] = stamp;
      if (d >= (who1[q] === me ? near2[q] : near1[q])) continue;
      dist[q] = d;
      queue[tail++] = q;
    }
  }
  return tail;
}
