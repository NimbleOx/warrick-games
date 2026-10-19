import {
  BASE_SPEED,
  BOMB_SLIDE_SPEED,
  BUDGET_BANK_SECS,
  BUDGET_BANK_TILES,
  COUNTDOWN_MS,
  CURSE_IMMUNE_MS,
  CURSE_MS,
  END_GRACE_MS,
  FALL_SHOW_MS,
  FAST_SPEED,
  FLAME_MS,
  FUSE_MS,
  HURRY_DROP_MS,
  HURRY_WARN_MS,
  MAX_BOMBS,
  MAX_FIRE,
  MAX_SPEED_LEVEL,
  SHORT_FUSE_MS,
  SLOW_SPEED,
  SPEED_STEP,
  START_BOMBS,
  START_FIRE,
} from "./constants";
import { DX, DY, OPPOSITE, SIDE_BIT, isDir, moveActor, overlaps, snapCoord, type BlockedFn, type Dir } from "./movement";
import { shuffle, type Rng } from "@warrick/kit/shared/rng";

export type ItemKind = "bomb" | "fire" | "speed" | "kick" | "maxfire" | "skull";
export type CurseKind = "slow" | "fast" | "reverse" | "nobomb" | "autobomb" | "shortfuse" | "weak";

export const CURSES: CurseKind[] = ["slow", "fast", "reverse", "nobomb", "autobomb", "shortfuse", "weak"];

const TILE_FLOOR = 0;
const TILE_WALL = 1;
const TILE_CRATE = 2;

export const ITEM_CHAR: Record<ItemKind, string> = {
  bomb: "b",
  fire: "f",
  speed: "s",
  kick: "k",
  maxfire: "m",
  skull: "x",
};
export const CHAR_ITEM: Record<string, ItemKind> = Object.fromEntries(
  Object.entries(ITEM_CHAR).map(([k, v]) => [v, k as ItemKind]),
);

const ITEM_WEIGHTS: [ItemKind, number][] = [
  ["bomb", 30],
  ["fire", 28],
  ["speed", 16],
  ["kick", 10],
  ["maxfire", 4],
  ["skull", 12],
];

export interface ArenaOpts {
  cols: number;
  rows: number;
  /** Chance that each free tile starts with a crate. */
  crates: number;
  /** Share of crates hiding a power-up. */
  items: number;
  skulls: boolean;
  /** Round time before the walls close in; null for never. */
  hurryMs: number | null;
  theme: number;
}

export interface ArenaPlayer {
  id: string;
  x: number;
  y: number;
  /** Last direction faced, for drawing. */
  face: Dir;
  /** Direction currently held, for kicking. */
  press: Dir;
  alive: boolean;
  bombs: number;
  fire: number;
  speedLvl: number;
  kick: boolean;
  curse: CurseKind | null;
  curseUntil: number;
  immuneUntil: number;
  /** Bumped whenever the server overrides this bomber's position, so its client snaps to it. */
  fix: number;
  /** Movement allowance for checking positions reported by clients. */
  budget: number;
  killedBy: string | null;
  kills: number;
  items: number;
}

export interface Bomb {
  id: number;
  owner: string;
  x: number;
  y: number;
  /** Arena time it goes off. */
  at: number;
  range: number;
  slide: Dir;
}

export interface Flame {
  /** Which sides connect to neighboring flame (SIDE_BIT). */
  mask: number;
  born: number;
  until: number;
  owner: string;
}

/** Input for a bomber the simulation moves itself (CPUs, the home-screen demo). */
export interface SimInput {
  dir: Dir;
  bomb?: boolean;
  /** Stop at this tile center instead of overshooting it. */
  to?: { x: number; y: number };
}

export type ArenaEvent =
  | { e: "go" }
  | { e: "bomb"; c: number; o: string }
  | { e: "boom"; c: number; o: string; n: number }
  | { e: "crate"; c: number }
  | { e: "burn"; c: number; k: ItemKind }
  | { e: "pick"; id: string; k: ItemKind; c: number }
  | { e: "curse"; id: string; k: CurseKind }
  | { e: "pass"; from: string; id: string; k: CurseKind }
  | { e: "cure"; id: string }
  | { e: "kick"; id: string; c: number }
  | { e: "die"; id: string; by: string | null; c: number }
  | { e: "hurry" }
  | { e: "drop"; c: number }
  | { e: "end"; winner: string | null };

export interface SnapPlayer {
  id: string;
  x: number;
  y: number;
  f: Dir;
  alive: boolean;
  /** Bomb capacity, fire range, effective speed (tiles/s), speed-ups collected, kick. */
  b: number;
  r: number;
  s: number;
  sl: number;
  k: boolean;
  c: CurseKind | null;
  /** Curse milliseconds left. */
  cl: number;
  fix: number;
}

export interface SnapBomb {
  id: number;
  o: string;
  x: number;
  y: number;
  at: number;
  r: number;
  s: Dir;
}

export interface SnapFlame {
  c: number;
  m: number;
  b: number;
  u: number;
}

/** Everything a client needs to draw the arena. */
export interface ArenaSnap {
  time: number;
  cols: number;
  rows: number;
  theme: number;
  /** One char per tile: # wall, + crate, . floor, or an item letter. */
  grid: string;
  goAt: number;
  hurryAt: number | null;
  players: SnapPlayer[];
  bombs: SnapBomb[];
  flames: SnapFlame[];
  /** Blocks about to land in sudden death: [cell, landsAt]. */
  falls: [number, number][];
  ev: ArenaEvent[];
}

/**
 * A tick's frame as a change to the one before, for a client that kept it: `applyDelta` lays it
 * over that one. Only `time` is always here. The grid and the round's fixed fields, the bombs,
 * flames and falling blocks come when they change, and each bomber with only the fields of theirs
 * that changed, so most ticks carry little more than who moved.
 */
export interface ArenaDelta extends Partial<Omit<ArenaSnap, "players">> {
  time: number;
  players?: (Partial<SnapPlayer> & { id: string })[];
}

const DELTA_FIELDS = ["cols", "rows", "theme", "grid", "goAt", "hurryAt"] as const;
const DELTA_LISTS = ["bombs", "flames", "falls"] as const;

/** Do two lists of flat records (or tuples) hold the same values? */
function sameRows(a: readonly object[], b: readonly object[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    for (const k in x) if (x[k] !== y[k]) return false;
  }
  return true;
}

/** `snap` as a change to `prev` (see ArenaDelta). With nothing to go on, that's all of it. */
export function diffSnaps(prev: ArenaSnap | null, snap: ArenaSnap): ArenaDelta {
  if (!prev) return snap;
  const d: Record<string, unknown> = { time: snap.time };
  for (const k of DELTA_FIELDS) if (snap[k] !== prev[k]) d[k] = snap[k];
  for (const k of DELTA_LISTS) if (!sameRows(snap[k], prev[k])) d[k] = snap[k];
  const players: Record<string, unknown>[] = [];
  for (const p of snap.players) {
    const was = prev.players.find((q) => q.id === p.id);
    if (!was) {
      players.push({ ...p });
      continue;
    }
    const changed: Record<string, unknown> = { id: p.id };
    let any = false;
    for (const k of Object.keys(p) as (keyof SnapPlayer)[]) {
      if (p[k] !== was[k]) {
        changed[k] = p[k];
        any = true;
      }
    }
    if (any) players.push(changed);
  }
  if (players.length) d.players = players;
  if (snap.ev.length) d.ev = snap.ev;
  return d as unknown as ArenaDelta;
}

/** The snapshot a delta makes of the one before it. */
export function applyDelta(prev: ArenaSnap, d: ArenaDelta): ArenaSnap {
  const players = d.players
    ? prev.players.map((p) => {
        const q = d.players!.find((u) => u.id === p.id);
        return q ? { ...p, ...q } : p;
      })
    : prev.players;
  return { ...prev, ...d, players, ev: d.ev ?? [] };
}

export interface ArenaResult {
  winner: string | null;
}

/** Arena size for a number of bombers: both odd, so pillars sit on even tiles. */
export function arenaSize(players: number): { cols: number; rows: number } {
  if (players <= 4) return { cols: 15, rows: 13 };
  if (players <= 6) return { cols: 17, rows: 13 };
  return { cols: 19, rows: 13 };
}

/** Start positions, filled in this order: opposite corners first, then edge midpoints. */
export function spawnPoints(cols: number, rows: number): [number, number][] {
  const l = 1;
  const r = cols - 2;
  const t = 1;
  const b = rows - 2;
  const mx = (cols - 1) / 2;
  const my = (rows - 1) / 2;
  return [
    [l, t],
    [r, b],
    [r, t],
    [l, b],
    [mx, t],
    [mx, b],
    [l, my],
    [r, my],
  ];
}

/**
 * One round of bombing: the grid, bombers, bombs and flames, stepped in fixed
 * increments. The server runs it for real; the home screen runs one for its demo.
 * Times are arena milliseconds, counted from the start of the round.
 */
export class Arena {
  time = 0;
  readonly cols: number;
  readonly rows: number;
  readonly theme: number;
  readonly goAt = COUNTDOWN_MS;
  readonly hurryAt: number | null;
  grid: Uint8Array;
  /** Power-ups lying on the floor. */
  items = new Map<number, ItemKind>();
  /** Power-ups still inside crates. */
  hidden = new Map<number, ItemKind>();
  players: ArenaPlayer[] = [];
  bombs: Bomb[] = [];
  flames = new Map<number, Flame>();
  events: ArenaEvent[] = [];
  result: ArenaResult | null = null;

  private rng: Rng;
  private nextBombId = 1;
  private reveals: { c: number; k: ItemKind; at: number }[] = [];
  private spiral: number[] = [];
  private dropIdx = 0;
  private nextDropAt = Infinity;
  private hurried = false;
  private wentGo = false;
  private endAt = 0;
  /** The frame everyone was last sent, which the next delta is a change to. */
  private sent: ArenaSnap | null = null;

  constructor(rng: Rng, ids: string[], opts: ArenaOpts) {
    this.rng = rng;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.theme = opts.theme;
    this.hurryAt = opts.hurryMs === null ? null : COUNTDOWN_MS + opts.hurryMs;
    this.grid = new Uint8Array(this.cols * this.rows);
    this.generate(ids, opts);
  }

  // ---------------------------------------------------------------- setup

  private generate(ids: string[], opts: ArenaOpts): void {
    const { cols, rows, grid } = this;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const edge = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
        grid[this.idx(x, y)] = edge || (x % 2 === 0 && y % 2 === 0) ? TILE_WALL : TILE_FLOOR;
      }
    }

    // Keep a little room around each start so everyone can place a first bomb and hide.
    const spawns = spawnPoints(cols, rows).slice(0, ids.length);
    const safe = new Set<number>();
    for (const [sx, sy] of spawns) {
      safe.add(this.idx(sx, sy));
      const open = (x: number, y: number) => grid[this.idx(x, y)] !== TILE_WALL;
      const horiz = open(sx - 1, sy) || open(sx + 1, sy);
      const vert = open(sx, sy - 1) || open(sx, sy + 1);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const diagonal = dx !== 0 && dy !== 0;
          // Corners get the classic L; a start with only a straight corridor gets the 3x3 box.
          if (diagonal && horiz && vert) continue;
          if (open(sx + dx, sy + dy)) safe.add(this.idx(sx + dx, sy + dy));
        }
      }
    }

    const crates: number[] = [];
    for (let c = 0; c < grid.length; c++) {
      if (grid[c] === TILE_FLOOR && !safe.has(c) && this.rng() < opts.crates) {
        grid[c] = TILE_CRATE;
        crates.push(c);
      }
    }
    const weights = ITEM_WEIGHTS.filter(([k]) => opts.skulls || k !== "skull");
    const total = weights.reduce((n, [, w]) => n + w, 0);
    const count = Math.round(crates.length * opts.items);
    for (const c of shuffle(this.rng, crates).slice(0, count)) {
      let roll = this.rng() * total;
      for (const [k, w] of weights) {
        roll -= w;
        if (roll < 0) {
          this.hidden.set(c, k);
          break;
        }
      }
    }

    const order = shuffle(this.rng, [...ids]);
    order.forEach((id, i) => {
      const [x, y] = spawns[i];
      this.players.push({
        id,
        x,
        y,
        face: 3,
        press: 0,
        alive: true,
        bombs: START_BOMBS,
        fire: START_FIRE,
        speedLvl: 0,
        kick: false,
        curse: null,
        curseUntil: 0,
        immuneUntil: 0,
        fix: 0,
        budget: 1,
        killedBy: null,
        kills: 0,
        items: 0,
      });
    });

    // Sudden death fills the interior in a spiral, from the outside in.
    let l = 1;
    let t = 1;
    let r = cols - 2;
    let b = rows - 2;
    const push = (x: number, y: number) => {
      const c = this.idx(x, y);
      if (grid[c] !== TILE_WALL) this.spiral.push(c);
    };
    while (l <= r && t <= b) {
      for (let x = l; x <= r; x++) push(x, t);
      for (let y = t + 1; y <= b; y++) push(r, y);
      if (t < b) for (let x = r - 1; x >= l; x--) push(x, b);
      if (l < r) for (let y = b - 1; y > t; y--) push(l, y);
      l++;
      t++;
      r--;
      b--;
    }
  }

  // ---------------------------------------------------------------- lookups

  idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  cellAt(x: number, y: number): number {
    return this.idx(Math.round(x), Math.round(y));
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  isWall(c: number): boolean {
    return this.grid[c] === TILE_WALL;
  }

  isCrate(c: number): boolean {
    return this.grid[c] === TILE_CRATE;
  }

  player(id: string): ArenaPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  bombAt(c: number): Bomb | undefined {
    return this.bombs.find((b) => this.cellAt(b.x, b.y) === c);
  }

  speedOf(p: ArenaPlayer): number {
    if (p.curse === "slow") return SLOW_SPEED;
    if (p.curse === "fast") return FAST_SPEED;
    return BASE_SPEED + p.speedLvl * SPEED_STEP;
  }

  fuseOf(p: ArenaPlayer): number {
    return p.curse === "shortfuse" ? SHORT_FUSE_MS : FUSE_MS;
  }

  rangeOf(p: ArenaPlayer): number {
    return p.curse === "weak" ? 1 : p.fire;
  }

  /** Tiles this bomber can't walk into: walls, crates, and bombs it isn't already standing on. */
  blockedFor(p: { x: number; y: number }): BlockedFn {
    const { x, y } = p;
    return (cx, cy) => {
      if (!this.inside(cx, cy)) return true;
      const c = this.idx(cx, cy);
      if (this.grid[c] !== TILE_FLOOR) return true;
      return !!this.bombAt(c) && !overlaps(x, y, cx, cy);
    };
  }

  /** The tiles a blast from `c` reaches. A crate, bomb or power-up stops it (and is hit). */
  blastCells(c: number, range: number): { cells: number[]; masks: number[] } {
    const cx = c % this.cols;
    const cy = (c - cx) / this.cols;
    const cells = [c];
    const masks = [0];
    for (let d = 1 as Dir; d <= 4; d++) {
      let prev = 0;
      for (let i = 1; i <= range; i++) {
        const x = cx + DX[d] * i;
        const y = cy + DY[d] * i;
        if (!this.inside(x, y)) break;
        const n = this.idx(x, y);
        if (this.grid[n] === TILE_WALL) break;
        masks[prev] |= SIDE_BIT[d];
        cells.push(n);
        masks.push(SIDE_BIT[OPPOSITE[d]]);
        prev = cells.length - 1;
        if (this.grid[n] === TILE_CRATE || this.items.has(n) || this.bombAt(n)) break;
      }
    }
    return { cells, masks };
  }

  // ---------------------------------------------------------------- actions

  placeBomb(id: string): boolean {
    const p = this.player(id);
    if (!p?.alive || this.time < this.goAt || this.result || p.curse === "nobomb") return false;
    if (this.bombs.filter((b) => b.owner === id).length >= p.bombs) return false;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const c = this.idx(x, y);
    if (this.grid[c] !== TILE_FLOOR || this.bombAt(c)) return false;
    this.bombs.push({ id: this.nextBombId++, owner: id, x, y, at: this.time + this.fuseOf(p), range: this.rangeOf(p), slide: 0 });
    this.events.push({ e: "bomb", c, o: id });
    return true;
  }

  /**
   * A browser reports where its bomber is. Accept it if it's a place you could
   * have walked to since the last report; otherwise keep the old position and
   * bump `fix` so the client snaps back. A walk that could only have gone
   * through fire ends there, the way it would have if each step had been seen.
   */
  clientMove(id: string, rawX: unknown, rawY: unknown, rawDir: unknown): boolean {
    const p = this.player(id);
    if (!p?.alive) return false;
    if (isDir(rawDir)) {
      p.press = rawDir;
      if (rawDir) p.face = rawDir;
    }
    const x = snapCoord(Math.round(Number(rawX) * 1000) / 1000);
    const y = snapCoord(Math.round(Number(rawY) * 1000) / 1000);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x === p.x && y === p.y) return true;
    const reject = () => {
      p.fix++;
      return false;
    };
    if (this.time < this.goAt || this.result) return reject();
    if (x !== Math.round(x) && y !== Math.round(y)) return reject(); // off both lanes
    const need = Math.abs(x - p.x) + Math.abs(y - p.y);
    // Overspending is carried as debt, so the slack for rounding can't be spent again on every report.
    if (need > p.budget + 0.08) return reject();
    if (!this.legalSpot(p, x, y)) return reject();
    const from = this.cellAt(p.x, p.y);
    const to = this.cellAt(x, y);
    const steps = Math.ceil(need) + 1;
    const path = this.route(p, from, to, steps);
    if (!path) return reject();
    const burning = (c: number) => this.flames.has(c);
    const fire = path.find(burning);
    if (fire !== undefined && !this.route(p, from, to, steps, burning)) {
      p.x = fire % this.cols;
      p.y = (fire - p.x) / this.cols;
      p.fix++;
      this.kill(p, this.flames.get(fire)!.owner);
      return false;
    }
    p.budget -= need;
    p.x = x;
    p.y = y;
    return true;
  }

  private legalSpot(p: ArenaPlayer, x: number, y: number): boolean {
    for (const cx of new Set([Math.floor(x), Math.ceil(x)])) {
      for (const cy of new Set([Math.floor(y), Math.ceil(y)])) {
        if (!overlaps(x, y, cx, cy)) continue;
        if (!this.inside(cx, cy)) return false;
        const c = this.idx(cx, cy);
        if (this.grid[c] !== TILE_FLOOR) return false;
        if (this.bombAt(c) && !overlaps(p.x, p.y, cx, cy)) return false;
      }
    }
    return true;
  }

  /**
   * The tiles of a shortest walk from `from` to `to` of at most `maxSteps` steps, both ends
   * included, keeping out of tiles `avoid` says no to; null if there's none.
   */
  private route(p: ArenaPlayer, from: number, to: number, maxSteps: number, avoid?: (c: number) => boolean): number[] | null {
    if (from === to) return [from];
    const blocked = this.blockedFor(p);
    const cameFrom = new Map([[from, -1]]);
    let frontier = [from];
    for (let step = 0; step < maxSteps && frontier.length; step++) {
      const next: number[] = [];
      for (const c of frontier) {
        const cx = c % this.cols;
        const cy = (c - cx) / this.cols;
        for (let d = 1; d <= 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          const n = this.idx(nx, ny);
          if (cameFrom.has(n) || blocked(nx, ny) || avoid?.(n)) continue;
          cameFrom.set(n, c);
          if (n === to) {
            const path = [n];
            for (let back = c; back !== -1; back = cameFrom.get(back)!) path.unshift(back);
            return path;
          }
          next.push(n);
        }
      }
      frontier = next;
    }
    return null;
  }

  // ---------------------------------------------------------------- simulation

  step(dt: number, inputs: Record<string, SimInput> = {}): void {
    if (this.result) return;
    this.time += dt;
    const t = this.time;
    const live = t >= this.goAt;
    if (live && !this.wentGo) {
      this.wentGo = true;
      this.events.push({ e: "go" });
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      const speed = this.speedOf(p);
      p.budget = Math.min(speed * BUDGET_BANK_SECS + BUDGET_BANK_TILES, p.budget + (speed * dt) / 1000);
    }

    if (live) {
      for (const [id, input] of Object.entries(inputs)) this.applyInput(id, input, dt);
      for (const p of this.players) {
        if (p.alive && p.curse === "autobomb") this.placeBomb(p.id);
      }
    }

    this.slideBombs(dt);
    if (live) this.kicks();

    // Anything sitting in fire goes off now; then everything that's due, chains included.
    for (const b of this.bombs) {
      if (this.flames.has(this.cellAt(b.x, b.y))) b.at = Math.min(b.at, t);
    }
    this.explodeDue();

    for (const [c, f] of this.flames) if (t >= f.until) this.flames.delete(c);
    this.reveals = this.reveals.filter((r) => {
      if (t < r.at) return true;
      if (this.grid[r.c] === TILE_FLOOR) this.items.set(r.c, r.k);
      return false;
    });

    this.burnPlayers();
    this.pickups();
    this.curses();
    this.suddenDeath();
    this.checkEnd();
  }

  private applyInput(id: string, input: SimInput, dt: number): void {
    const p = this.player(id);
    if (!p?.alive) return;
    // Drop first, so the bomb lands on the tile the bomber was standing on when it decided.
    if (input.bomb) this.placeBomb(id);
    let dir = isDir(input.dir) ? input.dir : 0;
    const reversed = p.curse === "reverse";
    if (reversed) dir = OPPOSITE[dir];
    let dist = (this.speedOf(p) * dt) / 1000;
    if (input.to && !reversed) dist = Math.min(dist, Math.abs(input.to.x - p.x) + Math.abs(input.to.y - p.y));
    moveActor(p, dir, dist, this.blockedFor(p));
    p.press = dir;
    if (dir) p.face = dir;
  }

  private bombBlocked(cx: number, cy: number, self: Bomb): boolean {
    if (!this.inside(cx, cy)) return true;
    const c = this.idx(cx, cy);
    if (this.grid[c] !== TILE_FLOOR) return true;
    if (this.bombs.some((b) => b !== self && this.cellAt(b.x, b.y) === c)) return true;
    return this.players.some((p) => p.alive && overlaps(p.x, p.y, cx, cy));
  }

  private slideBombs(dt: number): void {
    for (const b of this.bombs) {
      if (!b.slide) continue;
      const d = b.slide;
      const before = { x: b.x, y: b.y };
      moveActor(b, d, (BOMB_SLIDE_SPEED * dt) / 1000, (cx, cy) => this.bombBlocked(cx, cy, b));
      if (b.x === before.x && b.y === before.y) {
        b.slide = 0;
        b.x = Math.round(b.x);
        b.y = Math.round(b.y);
      }
    }
  }

  private kicks(): void {
    for (const p of this.players) {
      if (!p.alive || !p.kick || !p.press) continue;
      const cx = Math.round(p.x);
      const cy = Math.round(p.y);
      if (Math.abs(p.x - cx) > 0.2 || Math.abs(p.y - cy) > 0.2) continue;
      const d = p.press;
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (!this.inside(nx, ny)) continue;
      const b = this.bombAt(this.idx(nx, ny));
      if (!b || b.slide || overlaps(p.x, p.y, nx, ny)) continue;
      if (this.bombBlocked(nx + DX[d], ny + DY[d], b)) continue;
      b.slide = d;
      this.events.push({ e: "kick", id: p.id, c: this.idx(nx, ny) });
    }
  }

  private explodeDue(): void {
    const t = this.time;
    // Crates destroyed this tick still stop later blasts in the same chain.
    const smashed = new Set<number>();
    for (;;) {
      const due = this.bombs.filter((b) => b.at <= t).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.detonate(due, smashed);
    }
  }

  private detonate(b: Bomb, smashed: Set<number>): void {
    const t = this.time;
    this.bombs.splice(this.bombs.indexOf(b), 1);
    b.slide = 0;
    const c0 = this.cellAt(b.x, b.y);
    const cx = c0 % this.cols;
    const cy = (c0 - cx) / this.cols;
    const cells = [c0];
    const masks = [0];
    for (let d = 1 as Dir; d <= 4; d++) {
      let prev = 0;
      for (let i = 1; i <= b.range; i++) {
        const x = cx + DX[d] * i;
        const y = cy + DY[d] * i;
        if (!this.inside(x, y)) break;
        const n = this.idx(x, y);
        if (this.grid[n] === TILE_WALL) break;
        masks[prev] |= SIDE_BIT[d];
        cells.push(n);
        masks.push(SIDE_BIT[OPPOSITE[d]]);
        prev = cells.length - 1;
        if (this.grid[n] === TILE_CRATE) {
          this.grid[n] = TILE_FLOOR;
          smashed.add(n);
          this.events.push({ e: "crate", c: n });
          const k = this.hidden.get(n);
          if (k) {
            this.hidden.delete(n);
            this.reveals.push({ c: n, k, at: t + FLAME_MS });
          }
          break;
        }
        if (smashed.has(n)) break;
        const item = this.items.get(n);
        if (item) {
          this.items.delete(n);
          this.events.push({ e: "burn", c: n, k: item });
          break;
        }
        const other = this.bombAt(n);
        if (other) {
          other.at = Math.min(other.at, t);
          break;
        }
      }
    }
    cells.forEach((c, i) => {
      const f = this.flames.get(c);
      if (f) {
        f.mask |= masks[i];
        f.until = Math.max(f.until, t + FLAME_MS);
        f.owner = b.owner;
      } else {
        this.flames.set(c, { mask: masks[i], born: t, until: t + FLAME_MS, owner: b.owner });
      }
    });
    this.events.push({ e: "boom", c: c0, o: b.owner, n: cells.length });
  }

  private kill(p: ArenaPlayer, by: string | null): void {
    p.alive = false;
    p.killedBy = by;
    p.press = 0;
    if (by && by !== p.id) {
      const killer = this.player(by);
      if (killer) killer.kills++;
    }
    this.events.push({ e: "die", id: p.id, by, c: this.cellAt(p.x, p.y) });
  }

  private burnPlayers(): void {
    for (const p of this.players) {
      if (!p.alive) continue;
      const f = this.flames.get(this.cellAt(p.x, p.y));
      if (f) this.kill(p, f.owner);
    }
  }

  private pickups(): void {
    for (const p of this.players) {
      if (!p.alive) continue;
      const c = this.cellAt(p.x, p.y);
      const k = this.items.get(c);
      if (!k) continue;
      this.items.delete(c);
      p.items++;
      switch (k) {
        case "bomb":
          p.bombs = Math.min(MAX_BOMBS, p.bombs + 1);
          break;
        case "fire":
          p.fire = Math.min(MAX_FIRE, p.fire + 1);
          break;
        case "maxfire":
          p.fire = MAX_FIRE;
          break;
        case "speed":
          p.speedLvl = Math.min(MAX_SPEED_LEVEL, p.speedLvl + 1);
          break;
        case "kick":
          p.kick = true;
          break;
        case "skull": {
          const options = CURSES.filter((cu) => cu !== p.curse);
          p.curse = options[Math.floor(this.rng() * options.length)];
          p.curseUntil = this.time + CURSE_MS;
          this.events.push({ e: "curse", id: p.id, k: p.curse });
          break;
        }
      }
      this.events.push({ e: "pick", id: p.id, k, c });
    }
  }

  private curses(): void {
    const t = this.time;
    for (const p of this.players) {
      if (p.curse && (t >= p.curseUntil || !p.alive)) {
        p.curse = null;
        if (p.alive) this.events.push({ e: "cure", id: p.id });
      }
    }
    // A curse jumps to whoever you bump into, and leaves you.
    for (const a of this.players) {
      if (!a.alive || !a.curse) continue;
      for (const b of this.players) {
        if (b === a || !b.alive || b.curse || t < b.immuneUntil) continue;
        if (Math.abs(a.x - b.x) < 0.8 && Math.abs(a.y - b.y) < 0.8) {
          b.curse = a.curse;
          b.curseUntil = t + CURSE_MS;
          this.events.push({ e: "pass", from: a.id, id: b.id, k: a.curse });
          a.curse = null;
          a.immuneUntil = t + CURSE_IMMUNE_MS;
          break;
        }
      }
    }
  }

  private suddenDeath(): void {
    const t = this.time;
    if (this.hurryAt === null || t < this.hurryAt) return;
    if (!this.hurried) {
      this.hurried = true;
      this.nextDropAt = this.hurryAt + HURRY_WARN_MS;
      this.events.push({ e: "hurry" });
    }
    while (this.dropIdx < this.spiral.length && t >= this.nextDropAt) {
      const c = this.spiral[this.dropIdx++];
      this.nextDropAt += HURRY_DROP_MS;
      this.grid[c] = TILE_WALL;
      this.items.delete(c);
      this.hidden.delete(c);
      this.flames.delete(c);
      this.reveals = this.reveals.filter((r) => r.c !== c);
      this.bombs = this.bombs.filter((b) => this.cellAt(b.x, b.y) !== c);
      const cx = c % this.cols;
      const cy = (c - cx) / this.cols;
      for (const p of this.players) {
        if (!p.alive) continue;
        if (this.cellAt(p.x, p.y) === c) this.kill(p, null);
        else if (overlaps(p.x, p.y, cx, cy)) {
          // Grazed: nudge back to the middle of your own tile.
          p.x = Math.round(p.x);
          p.y = Math.round(p.y);
          p.fix++;
        }
      }
      this.events.push({ e: "drop", c });
    }
  }

  /** Upcoming sudden-death blocks within `within` ms: [cell, landsAt]. */
  upcomingDrops(within: number): [number, number][] {
    const out: [number, number][] = [];
    if (!this.hurried) return out;
    let at = this.nextDropAt;
    for (let i = this.dropIdx; i < this.spiral.length && at <= this.time + within; i++) {
      out.push([this.spiral[i], at]);
      at += HURRY_DROP_MS;
    }
    return out;
  }

  private checkEnd(): void {
    if (this.players.length < 2) return;
    const alive = this.players.filter((p) => p.alive);
    if (!this.endAt && alive.length <= 1) this.endAt = this.time + END_GRACE_MS;
    if (this.endAt && this.time >= this.endAt) {
      const winner = alive.length === 1 ? alive[0].id : null;
      this.result = { winner };
      this.events.push({ e: "end", winner });
    }
  }

  // ---------------------------------------------------------------- output

  gridString(): string {
    let s = "";
    for (let c = 0; c < this.grid.length; c++) {
      const g = this.grid[c];
      const item = this.items.get(c);
      s += g === TILE_WALL ? "#" : g === TILE_CRATE ? "+" : item ? ITEM_CHAR[item] : ".";
    }
    return s;
  }

  /** The state to send to clients. With `drain`, the events since the last drain go along and are cleared. */
  snapshot(drain: boolean): ArenaSnap {
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const ev = drain ? this.events : [];
    if (drain) this.events = [];
    return {
      time: Math.round(this.time),
      cols: this.cols,
      rows: this.rows,
      theme: this.theme,
      grid: this.gridString(),
      goAt: this.goAt,
      hurryAt: this.hurryAt,
      players: this.players.map((p) => ({
        id: p.id,
        x: r3(p.x),
        y: r3(p.y),
        f: p.face,
        alive: p.alive,
        b: p.bombs,
        r: p.fire,
        s: r3(this.speedOf(p)),
        sl: p.speedLvl,
        k: p.kick,
        c: p.curse,
        cl: p.curse ? Math.max(0, Math.round(p.curseUntil - this.time)) : 0,
        fix: p.fix,
      })),
      bombs: this.bombs.map((b) => ({
        id: b.id,
        o: b.owner,
        x: r3(b.x),
        y: r3(b.y),
        at: Math.round(b.at),
        r: b.range,
        s: b.slide,
      })),
      flames: [...this.flames].map(([c, f]) => ({ c, m: f.mask, b: Math.round(f.born), u: Math.round(f.until) })),
      falls: this.upcomingDrops(FALL_SHOW_MS),
      ev,
    };
  }

  /**
   * The next frame for everyone, whole and as a delta from the last one this returned. Call it
   * for every frame that goes to everyone, whichever of the two is sent.
   */
  frame(drain: boolean): { full: ArenaSnap; delta: ArenaDelta } {
    const full = this.snapshot(drain);
    const delta = diffSnaps(this.sent, full);
    this.sent = full;
    return { full, delta };
  }

  /**
   * A whole snapshot for one client (joining, or lost track). Things can change between ticks,
   * so it may differ from what everyone else has: the next delta carries everything, which fits
   * both.
   */
  catchUp(): ArenaSnap {
    this.sent = null;
    return this.snapshot(false);
  }
}

/** Is a tile in a snapshot grid closed to walking? */
export function snapTileSolid(ch: string | undefined): boolean {
  return ch === undefined || ch === "#" || ch === "+";
}
