import { DX, DY, type Arena, type Dir } from "./arena";
import type { CpuLevel } from "./protocol";
import type { Rng } from "./rng";

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
let owner = new Uint8Array(0);
let dist = new Uint16Array(0);
let queue = new Int32Array(0);
let stamp = 0;

function fresh(n: number): void {
  if (seen.length < n) {
    seen = new Uint32Array(n);
    owner = new Uint8Array(n);
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

const MINE = 1;
const THEIRS = 2;
const TIED = 3;

/** Cells rider i would reach (from x, y) strictly before any other rider. */
function territory(arena: Arena, i: number, x: number, y: number): number {
  const { w, h } = arena.cfg;
  fresh(w * h);
  let head = 0;
  let tail = 0;
  const seed = (cell: number, who: number) => {
    seen[cell] = stamp;
    owner[cell] = who;
    dist[cell] = 0;
    queue[tail++] = cell;
  };
  seed(y * w + x, MINE);
  arena.cycles.forEach((o, j) => {
    if (j !== i && o.alive) seed(o.y * w + o.x, THEIRS);
  });
  let mine = 0;
  while (head < tail) {
    const p = queue[head++];
    const who = owner[p];
    if (who === MINE) mine++;
    if (who === TIED) continue;
    const px = p % w;
    const py = (p - px) / w;
    for (let d = 0; d < 4; d++) {
      const q = step(arena, px, py, d as Dir);
      if (q < 0) continue;
      if (seen[q] !== stamp) {
        seen[q] = stamp;
        owner[q] = who;
        dist[q] = dist[p] + 1;
        queue[tail++] = q;
      } else if (dist[q] === dist[p] + 1 && owner[q] !== who && owner[q] !== TIED) {
        owner[q] = TIED;
      }
    }
  }
  return mine;
}
