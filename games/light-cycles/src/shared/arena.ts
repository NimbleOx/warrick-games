import { MIN_OPEN } from "./constants";
import type { Rng } from "@warrick/kit/shared/rng";

/** 0 up, 1 right, 2 down, 3 left (y points down). */
export type Dir = 0 | 1 | 2 | 3;
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export type WallMode = "solid" | "wrap";

export function isDir(v: unknown): v is Dir {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

export function opposite(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

export interface ArenaConfig {
  w: number;
  h: number;
  walls: WallMode;
  /** Boosts each cycle gets per round. */
  boosts: number;
  boostTicks: number;
  /** Tick at which the walls start closing in; 0 = never. */
  suddenDeathAt: number;
  shrinkEvery: number;
}

export interface Cycle {
  id: string;
  x: number;
  y: number;
  dir: Dir;
  alive: boolean;
  /** Ticks of boost left; a boosting cycle moves two cells per tick. */
  boost: number;
  /** Boosts left this round. */
  boosts: number;
  /**
   * The wall this cycle has laid, as polylines of cell coordinates ([x0, y0, x1, y1, …]).
   * Wrapping around an edge starts a new polyline. The last point is the head.
   * Kept after a crash for the derez animation, but no longer solid.
   */
  trail: number[][];
  /** Tick it crashed on, or -1. */
  diedAt: number;
}

export interface ArenaSnapshot extends ArenaConfig {
  tick: number;
  shrink: number;
  cycles: Cycle[];
}

export type ArenaEvent =
  /** `by` is the cycle whose wall was hit (or the other cycle in a head-on); -1 for the arena wall. */
  | { k: "crash"; i: number; by: number; x: number; y: number; headOn?: boolean }
  | { k: "boost"; i: number }
  | { k: "shrink"; s: number };

/** Everything that happened in one tick, small enough to send every tick. */
export interface Frame {
  n: number;
  /** Per cycle: the cells it entered this tick, flat [x, y, …]. */
  m: number[][];
  /** Per cycle: its heading after this tick. */
  d: Dir[];
  e: ArenaEvent[];
}

export const MAX_QUEUED_TURNS = 3;
/** A turn or boost can be asked for at most this many ticks ahead. */
export const MAX_AHEAD_TICKS = 20;

/** A turn waiting for its tick. */
interface Queued {
  dir: Dir;
  /** The first tick it can be made on. */
  at: number;
}

/**
 * The light cycle grid. The server calls `step()` once per tick and sends the
 * resulting Frame; clients feed it to `apply()`. Both paths lay walls with the
 * same `enter()`, so trails come out identical on every screen.
 */
export class Arena {
  readonly cfg: ArenaConfig;
  tick: number;
  shrink: number;
  cycles: Cycle[];
  /** 0 = empty, otherwise 1 + the index of the cycle whose wall fills the cell. */
  readonly grid: Uint8Array;
  private queues: Queued[][];
  /** The tick each cycle has asked to boost on, or -1. */
  private wantBoost: number[];

  constructor(snap: ArenaSnapshot) {
    const { tick, shrink, cycles, ...cfg } = snap;
    this.cfg = cfg;
    this.tick = tick;
    this.shrink = shrink;
    this.cycles = cycles.map(copyCycle);
    this.grid = new Uint8Array(cfg.w * cfg.h);
    this.cycles.forEach((c, i) => {
      if (!c.alive) return;
      for (const line of c.trail) {
        for (let k = 0; k + 2 < line.length; k += 2) this.fillSegment(i, line[k], line[k + 1], line[k + 2], line[k + 3]);
        this.grid[line[line.length - 1] * cfg.w + line[line.length - 2]] = i + 1;
      }
    });
    this.queues = this.cycles.map(() => []);
    this.wantBoost = this.cycles.map(() => -1);
  }

  static create(cfg: ArenaConfig, starts: { id: string; x: number; y: number; dir: Dir }[]): Arena {
    const cycles: Cycle[] = starts.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      dir: s.dir,
      alive: true,
      boost: 0,
      boosts: cfg.boosts,
      trail: [[s.x, s.y]],
      diedAt: -1,
    }));
    return new Arena({ ...cfg, tick: 0, shrink: 0, cycles });
  }

  snapshot(): ArenaSnapshot {
    return { ...this.cfg, tick: this.tick, shrink: this.shrink, cycles: this.cycles.map(copyCycle) };
  }

  index(id: string): number {
    return this.cycles.findIndex((c) => c.id === id);
  }

  get aliveCount(): number {
    let n = 0;
    for (const c of this.cycles) if (c.alive) n++;
    return n;
  }

  /** Inside the walls (which close in during sudden death)? `s` is how far they've closed. */
  inside(x: number, y: number, s = this.shrink): boolean {
    return x >= s && y >= s && x < this.cfg.w - s && y < this.cfg.h - s;
  }

  /** Can a cycle drive into this cell? */
  open(x: number, y: number): boolean {
    return this.inside(x, y) && this.grid[y * this.cfg.w + x] === 0;
  }

  /** The cell one step from (x, y), wrapping if the walls wrap. It may be outside the arena. */
  next(x: number, y: number, dir: Dir): [number, number] {
    let nx = x + DX[dir];
    let ny = y + DY[dir];
    if (this.cfg.walls === "wrap") {
      nx = (nx + this.cfg.w) % this.cfg.w;
      ny = (ny + this.cfg.h) % this.cfg.h;
    }
    return [nx, ny];
  }

  /** The heading a cycle will have once its queued turns are used up. */
  plannedDir(i: number): Dir {
    const q = this.queues[i];
    return q?.length ? q[q.length - 1].dir : this.cycles[i].dir;
  }

  /**
   * Queue a turn for an upcoming tick: the next one, or tick `at` if that's later (a player's
   * turn waits for the tick their screen showed it on). One turn is made per tick, in order.
   * U-turns (straight into your own wall) are ignored.
   */
  queueTurn(i: number, dir: Dir, at?: number): boolean {
    const c = this.cycles[i];
    if (!c?.alive || !isDir(dir)) return false;
    const last = this.plannedDir(i);
    const q = this.queues[i];
    if (dir === last || dir === opposite(last) || q.length >= MAX_QUEUED_TURNS) return false;
    q.push({ dir, at: this.aheadTick(at) });
    return true;
  }

  /** Boost on the next tick, or on tick `at` if that's later, if the last boost has burnt out by then. */
  requestBoost(i: number, at?: number): boolean {
    const c = this.cycles[i];
    if (!c?.alive || c.boosts <= 0) return false;
    this.wantBoost[i] = this.aheadTick(at);
    return true;
  }

  /** Advance one tick (server and offline demo only). */
  step(): Frame {
    const n = ++this.tick;
    const cfg = this.cfg;
    const e: ArenaEvent[] = [];
    const m: number[][] = this.cycles.map(() => []);

    // Sudden death: the walls close in one ring at a time.
    if (shrinksOn(cfg, n, this.shrink)) {
      this.shrink++;
      e.push({ k: "shrink", s: this.shrink });
      this.cycles.forEach((c, i) => {
        if (c.alive && !this.inside(c.x, c.y)) this.crash(i, -1, e);
      });
    }

    this.cycles.forEach((c, i) => {
      if (!c.alive) return;
      const q = this.queues[i];
      if (q.length && q[0].at <= n) {
        const turn = q.shift()!.dir;
        if (turn !== opposite(c.dir)) c.dir = turn;
      }
      const want = this.wantBoost[i];
      if (want >= 0 && want <= n) {
        if (c.boosts > 0 && c.boost === 0) {
          c.boost = cfg.boostTicks;
          c.boosts--;
          e.push({ k: "boost", i });
        }
        this.wantBoost[i] = -1;
      }
    });

    // Everyone advances one cell at the same time; boosting cycles then advance once more.
    for (let sub = 0; sub < 2; sub++) {
      const movers: number[] = [];
      this.cycles.forEach((c, i) => {
        if (c.alive && (sub === 0 || c.boost > 0)) movers.push(i);
      });
      if (!movers.length) break;
      const targets = movers.map((i) => this.next(this.cycles[i].x, this.cycles[i].y, this.cycles[i].dir));
      const crashes: { i: number; by: number; headOn?: boolean }[] = [];
      movers.forEach((i, k) => {
        const [x, y] = targets[k];
        if (!this.inside(x, y)) {
          crashes.push({ i, by: -1 });
          return;
        }
        // Side by side and facing: each drives into the other's head. That's a head-on, not a wall.
        const c = this.cycles[i];
        const swap = movers.findIndex((j, k2) => {
          const o = this.cycles[j];
          return k2 !== k && o.x === x && o.y === y && targets[k2][0] === c.x && targets[k2][1] === c.y;
        });
        if (swap >= 0) {
          crashes.push({ i, by: movers[swap], headOn: true });
          return;
        }
        const owner = this.grid[y * cfg.w + x];
        if (owner) {
          crashes.push({ i, by: owner - 1 });
          return;
        }
        const other = targets.findIndex((t, k2) => k2 !== k && t[0] === x && t[1] === y);
        if (other >= 0) crashes.push({ i, by: movers[other], headOn: true });
      });
      movers.forEach((i, k) => {
        if (crashes.some((c) => c.i === i)) return;
        const [x, y] = targets[k];
        this.enter(i, x, y);
        m[i].push(x, y);
      });
      for (const c of crashes) this.crash(c.i, c.by, e, c.headOn);
    }

    for (const c of this.cycles) if (c.alive && c.boost > 0) c.boost--;
    return { n, m, d: this.cycles.map((c) => c.dir), e };
  }

  /** Replay a tick computed by the server. */
  apply(f: Frame): void {
    this.tick = f.n;
    for (const ev of f.e) if (ev.k === "shrink") this.shrink = ev.s;
    f.m.forEach((cells, i) => {
      // One that has crashed already (shown ahead of the frames: see `crashAs`) is left as it ended.
      if (!this.cycles[i]?.alive) return;
      for (let k = 0; k + 1 < cells.length; k += 2) this.enter(i, cells[k], cells[k + 1]);
    });
    f.d.forEach((d, i) => {
      if (this.cycles[i]?.alive) this.cycles[i].dir = d;
    });
    for (const ev of f.e) {
      if (ev.k === "shrink" || !this.cycles[ev.i]?.alive) continue;
      if (ev.k === "crash") {
        this.kill(ev.i);
      } else {
        this.cycles[ev.i].boost = this.cfg.boostTicks;
        this.cycles[ev.i].boosts = Math.max(0, this.cycles[ev.i].boosts - 1);
      }
    }
    for (const c of this.cycles) if (c.alive && c.boost > 0) c.boost--;
  }

  /**
   * Cycle `i` has crashed, as `c` (the same cycle in an arena further on) ended up. The client
   * shows your own crash this way as soon as it's heard, ahead of playback. The frames before
   * the crash are still applied after it, but leave this cycle where it ended.
   */
  crashAs(i: number, c: Cycle): void {
    this.kill(i);
    this.cycles[i] = copyCycle(c);
  }

  // ---------------------------------------------------------------- internals

  /** The tick a turn or boost asked for at `at` is due: no sooner than the next one, and not too far off. */
  private aheadTick(at: number | undefined): number {
    const next = this.tick + 1;
    if (typeof at !== "number" || !Number.isFinite(at)) return next;
    return Math.min(this.tick + MAX_AHEAD_TICKS, Math.max(next, Math.floor(at)));
  }

  private enter(i: number, x: number, y: number): void {
    enterCell(this.cycles[i], x, y);
    this.grid[y * this.cfg.w + x] = i + 1;
  }

  private crash(i: number, by: number, e: ArenaEvent[], headOn?: boolean): void {
    const c = this.cycles[i];
    this.kill(i);
    e.push(headOn ? { k: "crash", i, by, x: c.x, y: c.y, headOn } : { k: "crash", i, by, x: c.x, y: c.y });
  }

  /** A crashed cycle derezzes, and its wall goes with it. */
  private kill(i: number): void {
    const c = this.cycles[i];
    if (!c.alive) return;
    c.alive = false;
    c.boost = 0;
    c.diedAt = this.tick;
    this.queues[i] = [];
    this.wantBoost[i] = -1;
    const g = this.grid;
    for (let k = 0; k < g.length; k++) if (g[k] === i + 1) g[k] = 0;
  }

  private fillSegment(i: number, x0: number, y0: number, x1: number, y1: number): void {
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    for (let x = x0, y = y0; x !== x1 || y !== y1; x += dx, y += dy) this.grid[y * this.cfg.w + x] = i + 1;
  }
}

function copyCycle(c: Cycle): Cycle {
  return { ...c, trail: c.trail.map((line) => [...line]) };
}

/** Move a cycle's head into the cell (x, y), one step from where it is (or across a wrapped edge), extending its wall. */
export function enterCell(c: Cycle, x: number, y: number): void {
  const line = c.trail[c.trail.length - 1];
  const n = line.length;
  const px = line[n - 2];
  const py = line[n - 1];
  if (Math.abs(x - px) + Math.abs(y - py) !== 1) {
    c.trail.push([x, y]); // wrapped around an edge
  } else if (n >= 4 && Math.sign(px - line[n - 4]) === x - px && Math.sign(py - line[n - 3]) === y - py) {
    line[n - 2] = x; // still going straight: stretch the last segment
    line[n - 1] = y;
  } else {
    line.push(x, y);
  }
  c.x = x;
  c.y = y;
}

/** Do the walls close in another ring on tick `n`, having closed `shrink` so far? */
export function shrinksOn(cfg: ArenaConfig, n: number, shrink: number): boolean {
  return (
    !!cfg.suddenDeathAt &&
    n >= cfg.suddenDeathAt &&
    (n - cfg.suddenDeathAt) % cfg.shrinkEvery === 0 &&
    Math.min(cfg.w, cfg.h) - 2 * (shrink + 1) >= MIN_OPEN
  );
}

/** Starting spots on a ring around the middle, each cycle facing inward. */
export function spawnPoints(n: number, w: number, h: number, rng: Rng): { x: number; y: number; dir: Dir }[] {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const offset = rng() * Math.PI * 2;
  const out: { x: number; y: number; dir: Dir }[] = [];
  for (let i = 0; i < n; i++) {
    const a = offset + (i * Math.PI * 2) / n;
    const x = Math.round(cx + Math.cos(a) * w * 0.36);
    const y = Math.round(cy + Math.sin(a) * h * 0.36);
    const dx = cx - x;
    const dy = cy - y;
    const dir: Dir = Math.abs(dx) / w >= Math.abs(dy) / h ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
    out.push({ x, y, dir });
  }
  return out;
}
