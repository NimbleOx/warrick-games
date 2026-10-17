import { reverse, type Board, type Dir } from "./board";
import { randInt, type Rng } from "./rng";
import type { Round } from "./sim";

export type CpuLevel = "easy" | "normal" | "hard";

interface Tuning {
  /** Cells to go straight out from home, then across, before heading back. */
  out: [number, number];
  across: [number, number];
  /** Head home once an enemy is within (my way home + margin) of my trail. */
  margin: number;
  /** Chance per tick of actually looking for danger. */
  watch: number;
  /** Chance per tick, while near home, of looking for a trail to cut. */
  hunt: number;
}

const TUNING: Record<CpuLevel, Tuning> = {
  easy: { out: [3, 6], across: [3, 6], margin: 1, watch: 0.5, hunt: 0 },
  normal: { out: [5, 10], across: [4, 9], margin: 3, watch: 0.9, hunt: 0.04 },
  hard: { out: [7, 14], across: [6, 12], margin: 4, watch: 1, hunt: 0.12 },
};

/** How far a CPU will go to cut someone's trail. */
const HUNT_RANGE = 14;

/** A CPU's memory between ticks. */
export interface Brain {
  level: CpuLevel;
  mode: "home" | "out" | "back" | "hunt";
  /** The rest of the planned loop, as [direction, cells] legs. */
  legs: [Dir, number][];
  /** Hunting: the slot whose trail we're after. */
  prey: number;
}

export function newBrain(level: CpuLevel): Brain {
  return { level, mode: "home", legs: [], prey: -1 };
}

/**
 * This tick's heading for a CPU. The plan: walk out of your land, go out a
 * few cells, across a few, then take the shortest way home, which closes a
 * loop. Turn for home early if an enemy gets close enough to cut the trail.
 */
export function think(round: Round, slot: number, brain: Brain, rng: Rng): Dir {
  const b = round.board;
  const h = b.heads[slot];
  const tune = TUNING[brain.level];
  const trail = b.trails[slot];

  if (h.fresh || (!trail.length && brain.mode !== "home" && brain.mode !== "hunt")) {
    brain.mode = "home";
    brain.legs = [];
  }

  if (trail.length && (brain.mode === "out" || brain.mode === "hunt") && rng() < tune.watch) {
    const home = wayHome(b, slot);
    if (!home || threat(b, slot) <= home.dist + tune.margin) brain.mode = "back";
  }

  if ((brain.mode === "home" || brain.mode === "out") && trail.length <= 4 && rng() < tune.hunt) {
    const prey = findPrey(b, slot);
    if (prey >= 0) {
      brain.mode = "hunt";
      brain.prey = prey;
    }
  }

  let want: Dir | null = null;
  if (brain.mode === "hunt") {
    const step = towardTrail(b, slot, brain.prey);
    if (step) want = step.dir;
    else brain.mode = trail.length ? "back" : "home";
  }
  if (brain.mode === "home") {
    if (trail.length) {
      brain.mode = "out"; // just stepped off our land
    } else {
      if (!brain.legs.length) planLoop(round, slot, brain, rng);
      want = brain.legs[0][0];
    }
  }
  if (brain.mode === "out") {
    const leg = brain.legs[0];
    if (leg) {
      want = leg[0];
      if (--leg[1] <= 0) brain.legs.shift();
    } else {
      brain.mode = "back";
    }
  }
  if (brain.mode === "back") want = wayHome(b, slot)?.dir ?? null;
  return safest(round, slot, want, rng);
}

/** A disconnected player's head: get home, then circle inside your own land. */
export function autopilot(round: Round, slot: number, rng: Rng): Dir {
  const b = round.board;
  const h = b.heads[slot];
  if (b.trails[slot].length) return safest(round, slot, wayHome(b, slot)?.dir ?? null, rng);
  const heading = round.heading[slot];
  const own = (d: Dir) => {
    const c = b.neighbor(h.cell, d);
    return c >= 0 && b.owner[c] === slot + 1;
  };
  if (own(heading)) return heading;
  for (const d of [((heading + 1) % 4) as Dir, ((heading + 3) % 4) as Dir]) if (own(d)) return d;
  return safest(round, slot, null, rng);
}

// ---------------------------------------------------------------- planning

function planLoop(round: Round, slot: number, brain: Brain, rng: Rng): void {
  const b = round.board;
  const h = b.heads[slot];
  const tune = TUNING[brain.level];
  const scale = Math.max(0.6, Math.min(1.4, b.w / 100));
  const out = Math.round(randInt(rng, ...tune.out) * scale);
  const across = Math.round(randInt(rng, ...tune.across) * scale);
  let best: Dir = round.heading[slot];
  let bestScore = -Infinity;
  for (const d of [0, 1, 2, 3] as Dir[]) {
    if (!h.fresh && d === reverse(h.dir)) continue;
    // Cells to walk before leaving our land, and room beyond for the loop.
    let c = h.cell;
    let inside = 0;
    while (c >= 0 && b.owner[c] === slot + 1) {
      c = b.neighbor(c, d);
      inside++;
    }
    if (c < 0) continue;
    const room = roomTo(b, c, d);
    if (room < out + 2) continue;
    const score = -inside + rng() * 8 + (d === round.heading[slot] ? 2 : 0) + Math.min(room, 20) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  // Turn across toward the side with more room, usually.
  const left = ((best + 3) % 4) as Dir;
  const right = ((best + 1) % 4) as Dir;
  const lean = roomTo(b, h.cell, right) - roomTo(b, h.cell, left) + (rng() - 0.5) * 20;
  const side = lean >= 0 ? right : left;
  brain.legs = [
    [best, out],
    [side, across],
  ];
}

/** Cells from c to the board edge going in direction d. */
function roomTo(b: Board, c: number, d: Dir): number {
  const x = c % b.w;
  const y = Math.floor(c / b.w);
  return d === 0 ? y : d === 1 ? b.w - 1 - x : d === 2 ? b.h - 1 - y : x;
}

// ---------------------------------------------------------------- danger and prey

/** How close the nearest enemy head is to our trail (or our head, which is on it). */
function threat(b: Board, slot: number): number {
  let best = Infinity;
  const cells = [...b.trails[slot], b.heads[slot].cell];
  for (let s = 0; s < b.heads.length; s++) {
    const e = b.heads[s];
    if (s === slot || !e.alive) continue;
    const ex = e.cell % b.w;
    const ey = Math.floor(e.cell / b.w);
    for (const c of cells) {
      const d = Math.abs((c % b.w) - ex) + Math.abs(Math.floor(c / b.w) - ey);
      if (d < best) best = d;
    }
  }
  return best;
}

/** An enemy whose trail we can reach before it can get home, or -1. */
function findPrey(b: Board, slot: number): number {
  const me = b.heads[slot].cell;
  let best = -1;
  let bestGap = 0;
  for (let s = 0; s < b.heads.length; s++) {
    const t = b.trails[s];
    if (s === slot || !t.length || !b.heads[s].alive) continue;
    const mine = nearest(b, me, t);
    if (mine > HUNT_RANGE) continue;
    // Their trail starts next to their land, so its first cell is a fair guess at their way home.
    const theirs = manhattan(b, b.heads[s].cell, t[0]);
    const gap = theirs - mine;
    if (gap > 1 && gap > bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return best;
}

function towardTrail(b: Board, slot: number, prey: number): { dir: Dir; dist: number } | null {
  if (!b.trails[prey].length || !b.heads[prey].alive) return null;
  return search(b, slot, (c) => b.trail[c] === prey + 1, HUNT_RANGE * 3);
}

function nearest(b: Board, from: number, cells: readonly number[]): number {
  let best = Infinity;
  for (const c of cells) best = Math.min(best, manhattan(b, from, c));
  return best;
}

function manhattan(b: Board, a: number, c: number): number {
  return Math.abs((a % b.w) - (c % b.w)) + Math.abs(Math.floor(a / b.w) - Math.floor(c / b.w));
}

// ---------------------------------------------------------------- pathfinding

let seen = new Uint32Array(0);
let first = new Int8Array(0);
let dist = new Int32Array(0);
let queue = new Int32Array(0);
let epoch = 0;

function nextEpoch(size: number): number {
  if (seen.length < size) {
    seen = new Uint32Array(size);
    first = new Int8Array(size);
    dist = new Int32Array(size);
    queue = new Int32Array(size);
    epoch = 0;
  }
  return ++epoch;
}

function wayHome(b: Board, slot: number): { dir: Dir; dist: number } | null {
  return search(b, slot, (c) => b.owner[c] === slot + 1);
}

/**
 * Breadth-first search from a slot's head to the nearest cell where `goal`
 * holds, never crossing its own trail or turning straight back.
 */
function search(b: Board, slot: number, goal: (c: number) => boolean, limit = Infinity): { dir: Dir; dist: number } | null {
  const mark = nextEpoch(b.size);
  const h = b.heads[slot];
  const own = slot + 1;
  let head = 0;
  let tail = 0;
  seen[h.cell] = mark;
  for (const d of [0, 1, 2, 3] as Dir[]) {
    if (!h.fresh && d === reverse(h.dir)) continue;
    const c = b.neighbor(h.cell, d);
    if (c < 0 || b.trail[c] === own) continue;
    if (goal(c)) return { dir: d, dist: 1 };
    seen[c] = mark;
    first[c] = d;
    dist[c] = 1;
    queue[tail++] = c;
  }
  while (head < tail) {
    const c = queue[head++];
    if (dist[c] >= limit) continue;
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const n = b.neighbor(c, d);
      if (n < 0 || seen[n] === mark || b.trail[n] === own) continue;
      if (goal(n)) return { dir: first[c] as Dir, dist: dist[c] + 1 };
      seen[n] = mark;
      first[n] = first[c];
      dist[n] = dist[c] + 1;
      queue[tail++] = n;
    }
  }
  return null;
}

/**
 * The wanted direction if it's safe (on the board, not into our own trail, not
 * straight back); otherwise the safe direction with the most open space.
 */
function safest(round: Round, slot: number, want: Dir | null, rng: Rng): Dir {
  const b = round.board;
  const h = b.heads[slot];
  const ok = (d: Dir) => {
    if (!h.fresh && d === reverse(h.dir)) return false;
    const c = b.neighbor(h.cell, d);
    return c >= 0 && b.trail[c] !== slot + 1;
  };
  if (want !== null && ok(want)) return want;
  const heading = round.heading[slot];
  let best: Dir = ok(heading) ? heading : h.dir;
  let bestScore = -Infinity;
  for (const d of [0, 1, 2, 3] as Dir[]) {
    if (!ok(d)) continue;
    const score = openSpace(b, slot, b.neighbor(h.cell, d)) + (d === heading ? 0.5 : 0) + rng() * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Free cells reachable from c within a few steps: a cheap "is this a dead end?" check. */
function openSpace(b: Board, slot: number, c: number): number {
  const own = slot + 1;
  const mark = nextEpoch(b.size);
  let head = 0;
  let tail = 0;
  seen[c] = mark;
  queue[tail++] = c;
  while (head < tail && tail < 40) {
    const x = queue[head++];
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const n = b.neighbor(x, d);
      if (n < 0 || seen[n] === mark || b.trail[n] === own) continue;
      seen[n] = mark;
      queue[tail++] = n;
    }
  }
  return tail;
}
