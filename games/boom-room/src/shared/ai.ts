import type { Arena, ArenaPlayer, ItemKind, SimInput } from "./arena";
import { FLAME_MS } from "./constants";
import { DX, DY, type Dir } from "./movement";
import type { CpuLevel } from "./protocol";
import { shuffle, type Rng } from "@warrick/kit/shared/rng";

interface Profile {
  /** How often to re-plan, in ms. */
  thinkMs: number;
  /** Safety margin around blast timings, in ms. */
  margin: number;
  /** How much it likes hunting other bombers. */
  aggro: number;
  /** Sees chain reactions coming. */
  chains: boolean;
  /** Chance per plan of just wandering about. */
  wander: number;
  /** Chance of taking a good bombing spot when it finds one. */
  bombChance: number;
  avoidSkulls: boolean;
}

const PROFILES: Record<CpuLevel, Profile> = {
  easy: { thinkMs: 340, margin: 40, aggro: 0.25, chains: false, wander: 0.3, bombChance: 0.5, avoidSkulls: false },
  normal: { thinkMs: 170, margin: 120, aggro: 0.7, chains: true, wander: 0.08, bombChance: 0.85, avoidSkulls: true },
  hard: { thinkMs: 60, margin: 170, aggro: 1.3, chains: true, wander: 0, bombChance: 1, avoidSkulls: true },
};

/** Bonus for a bomb that leaves someone nowhere to run. */
const TRAP_VALUE = 40;

const ITEM_VALUE: Record<ItemKind, number> = { bomb: 9, fire: 9, speed: 7, kick: 4, maxfire: 12, skull: 1 };

interface Danger {
  /** Earliest arena time each tile will be on fire (Infinity if never). */
  start: Float64Array;
  /** When the last fire on each tile goes out. */
  end: Float64Array;
}

interface Hypothetical {
  c: number;
  at: number;
  range: number;
}

/** Where the fire is going to be, given the bombs on the board. */
function dangerMap(a: Arena, prof: Profile, extra?: Hypothetical): Danger {
  const n = a.cols * a.rows;
  const start = new Float64Array(n).fill(Infinity);
  const end = new Float64Array(n).fill(-Infinity);
  const bombs: Hypothetical[] = a.bombs.map((b) => ({ c: a.cellAt(b.x, b.y), at: b.at, range: b.range }));
  if (extra) bombs.push(extra);
  const blasts = bombs.map((b) => a.blastCells(b.c, b.range).cells);
  if (prof.chains) {
    const byCell = new Map(bombs.map((b, i) => [b.c, i]));
    let changed = true;
    for (let guard = 0; changed && guard < 16; guard++) {
      changed = false;
      bombs.forEach((b, i) => {
        for (const c of blasts[i]) {
          const j = byCell.get(c);
          if (j !== undefined && j !== i && bombs[j].at > b.at) {
            bombs[j].at = b.at;
            changed = true;
          }
        }
      });
    }
  }
  bombs.forEach((b, i) => {
    for (const c of blasts[i]) {
      start[c] = Math.min(start[c], b.at);
      end[c] = Math.max(end[c], b.at + FLAME_MS);
    }
  });
  for (const [c, f] of a.flames) {
    start[c] = Math.min(start[c], a.time);
    end[c] = Math.max(end[c], f.until);
  }
  for (const [c, at] of a.upcomingDrops(3000)) {
    start[c] = Math.min(start[c], at - 300);
    end[c] = Infinity;
  }
  return { start, end };
}

function centered(p: ArenaPlayer): boolean {
  return Math.abs(p.x - Math.round(p.x)) < 0.02 && Math.abs(p.y - Math.round(p.y)) < 0.02;
}

/** A CPU bomber: plans a path every so often and follows it a tick at a time. */
export class Brain {
  private prof: Profile;
  private path: number[] = [];
  private bombNow = false;
  /** Tiles where a bomb turned out not to be safe, until when. */
  private badSpots = new Map<number, number>();
  private nextThink = 0;
  private sig = "";
  private lastX = NaN;
  private lastY = NaN;
  private stuckFor = 0;
  private lastTime = 0;

  constructor(
    readonly id: string,
    readonly level: CpuLevel,
    private rng: Rng,
  ) {
    this.prof = PROFILES[level] ?? PROFILES.normal;
  }

  input(a: Arena): SimInput {
    const p = a.player(this.id);
    if (!p?.alive || a.time < a.goAt || a.result) return { dir: 0 };
    const dt = a.time - this.lastTime;
    this.lastTime = a.time;

    // React straight away when bombs appear or go off (easy CPUs wait for their next think).
    const sig = a.bombs.map((b) => b.id).join(",");
    const changed = sig !== this.sig;
    this.sig = sig;

    if (p.x === this.lastX && p.y === this.lastY && this.path.length) this.stuckFor += dt;
    else this.stuckFor = 0;
    this.lastX = p.x;
    this.lastY = p.y;

    if (a.time >= this.nextThink || (changed && this.level !== "easy") || this.stuckFor > 400) {
      this.think(a, p, this.stuckFor > 400);
      this.stuckFor = 0;
      this.nextThink = a.time + this.prof.thinkMs * (0.75 + this.rng() * 0.5);
    }
    return this.follow(a, p);
  }

  // ---------------------------------------------------------------- planning

  private think(a: Arena, p: ArenaPlayer, stuck: boolean): void {
    const prof = this.prof;
    const me = a.cellAt(p.x, p.y);
    const danger = dangerMap(a, prof);
    this.bombNow = false;
    // Stick with a plan while it still works; re-rolling every think makes them dither.
    const keep = !stuck && this.path.length > 0 && this.pathOk(a, p, danger, this.path);

    if (danger.start[me] !== Infinity) {
      if (!keep) this.path = this.escape(a, p, danger) ?? [];
      return;
    }

    const value = this.canBomb(a, p) && this.rng() < prof.bombChance ? this.bombValue(a, p, me) : 0;
    if (value > 0) {
      const withBomb = dangerMap(a, prof, { c: me, at: a.time + a.fuseOf(p), range: a.rangeOf(p) });
      // Normally they want a choice of hiding places, so one bomb can't box them in;
      // for a sure kill they'll settle for one.
      const crowded = a.players.some((o) => o.alive && o !== p && Math.abs(o.x - p.x) + Math.abs(o.y - p.y) < 6);
      const need = this.level === "easy" || value >= TRAP_VALUE || !crowded ? 1 : 2;
      const out = this.escape(a, p, withBomb, true, need);
      if (out?.length) {
        this.bombNow = true;
        this.path = out;
        return;
      }
      // Don't keep coming back to a spot where bombing isn't safe.
      this.badSpots.set(me, a.time + 2500);
    }

    if (keep) return;
    if (stuck || this.rng() < prof.wander) {
      this.path = this.wander(a, p, danger);
      return;
    }
    this.path = this.seek(a, p, danger);
  }

  /** Is this route still walkable, out of the fire on the way, and ending somewhere safe? */
  private pathOk(a: Arena, p: ArenaPlayer, danger: Danger, path: number[]): boolean {
    const msPerTile = 1000 / a.speedOf(p);
    const start = a.cellAt(p.x, p.y);
    const offset = (Math.abs(p.x - Math.round(p.x)) + Math.abs(p.y - Math.round(p.y))) * msPerTile;
    let prev = start;
    let steps = 0;
    for (const c of path) {
      if (c === start && steps === 0) continue;
      steps++;
      const dx = Math.abs((c % a.cols) - (prev % a.cols));
      const dy = Math.abs(Math.floor(c / a.cols) - Math.floor(prev / a.cols));
      if (dx + dy !== 1 || !this.walkable(a, c, start)) return false;
      const enter = a.time + offset + (steps - 0.5) * msPerTile;
      if (danger.start[c] - this.prof.margin < enter + msPerTile && enter < danger.end[c] + this.prof.margin) return false;
      prev = c;
    }
    return danger.start[path[path.length - 1]] === Infinity;
  }

  private canBomb(a: Arena, p: ArenaPlayer): boolean {
    if (p.curse === "nobomb") return false;
    const c = a.cellAt(p.x, p.y);
    if (a.bombAt(c)) return false;
    return a.bombs.filter((b) => b.owner === p.id).length < p.bombs;
  }

  /** How good a bomb at tile `c` would be: crates it opens and bombers it catches. */
  private bombValue(a: Arena, p: ArenaPlayer, c: number): number {
    const cells = a.blastCells(c, a.rangeOf(p)).cells;
    let value = 0;
    for (const n of cells) if (a.isCrate(n)) value += 3;
    let withBomb: Danger | null = null;
    for (const o of a.players) {
      if (!o.alive || o.id === p.id || !cells.includes(a.cellAt(o.x, o.y))) continue;
      value += 8 * this.prof.aggro;
      if (this.level === "easy") continue;
      // Would they have anywhere to run? If not, that's a kill.
      withBomb ??= dangerMap(a, this.prof, { c, at: a.time + a.fuseOf(p), range: a.rangeOf(p) });
      if (!this.escapeWith(a, o, withBomb, 0, true, 1, c)) value += TRAP_VALUE;
    }
    return value;
  }

  private walkable(a: Arena, c: number, from: number): boolean {
    if (c === from) return true;
    if (a.isWall(c) || a.isCrate(c) || a.bombAt(c)) return false;
    if (this.prof.avoidSkulls && a.items.get(c) === "skull") return false;
    return true;
  }

  private neighbors(a: Arena, c: number): number[] {
    const x = c % a.cols;
    const y = (c - x) / a.cols;
    const out: number[] = [];
    for (let d = 1; d <= 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (a.inside(nx, ny)) out.push(a.idx(nx, ny));
    }
    // Shuffle so equal choices don't always break the same way.
    return shuffle(this.rng, out);
  }

  /**
   * Shortest route to a tile that won't burn, never standing in fire on the way.
   * Without a clean route, the one that buys the most time.
   */
  private escape(a: Arena, p: ArenaPlayer, danger: Danger, strict = false, need = 1): number[] | null {
    const found = this.escapeWith(a, p, danger, this.prof.margin, true, need);
    if (found || strict) return found;
    // Nothing comfortable: cut it fine, and failing that, buy as much time as possible.
    return this.escapeWith(a, p, danger, 0, false);
  }

  /** `need` is how many separate safe tiles must be reachable, so one blocked corridor isn't fatal. */
  private escapeWith(
    a: Arena,
    p: ArenaPlayer,
    danger: Danger,
    margin: number,
    strict: boolean,
    need = 1,
    /** A tile to treat as blocked, e.g. where a bomb is about to go. */
    wall = -1,
  ): number[] | null {
    const msPerTile = 1000 / a.speedOf(p);
    const start = a.cellAt(p.x, p.y);
    const offset = (Math.abs(p.x - Math.round(p.x)) + Math.abs(p.y - Math.round(p.y))) * msPerTile;
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    let latest = { c: start, at: danger.start[start] };
    let first = -1;
    let safe = 0;
    for (let steps = 1; frontier.length && steps < 40; steps++) {
      const next: number[] = [];
      for (const c of frontier) {
        for (const n of this.neighbors(a, c)) {
          if (prev.has(n) || n === wall || !this.walkable(a, n, start)) continue;
          const enter = a.time + offset + (steps - 0.5) * msPerTile;
          const leave = enter + msPerTile;
          if (danger.start[n] - margin < leave && enter < danger.end[n] + margin) continue;
          prev.set(n, c);
          if (danger.start[n] === Infinity) {
            if (first < 0) first = n;
            if (++safe >= need) return this.trace(prev, first);
          } else if (danger.start[n] > latest.at) {
            latest = { c: n, at: danger.start[n] };
          }
          next.push(n);
        }
      }
      frontier = next;
    }
    if (strict) return null;
    if (first >= 0) return this.trace(prev, first);
    return latest.c === start ? null : this.trace(prev, latest.c);
  }

  /** Head for the most attractive safe tile: power-ups, crates to blow, bombers to catch. */
  private seek(a: Arena, p: ArenaPlayer, danger: Danger): number[] {
    const start = a.cellAt(p.x, p.y);
    const canBomb = this.canBomb(a, p);
    const enemies = a.players.filter((o) => o.alive && o.id !== p.id).map((o) => [Math.round(o.x), Math.round(o.y)]);
    const prev = new Map<number, number>([[start, -1]]);
    let frontier = [start];
    let best = { c: start, score: -Infinity };
    for (let d = 0; frontier.length && d < 24; d++) {
      const next: number[] = [];
      for (const c of frontier) {
        if (d > 0) {
          let score = 0;
          const item = a.items.get(c);
          if (item) score += item === "skull" ? (this.prof.avoidSkulls ? -50 : ITEM_VALUE.skull) : ITEM_VALUE[item];
          if (canBomb && !((this.badSpots.get(c) ?? 0) > a.time)) score += this.bombValue(a, p, c);
          const x = c % a.cols;
          const y = (c - x) / a.cols;
          let near = Infinity;
          for (const [ex, ey] of enemies) near = Math.min(near, Math.abs(ex - x) + Math.abs(ey - y));
          if (near < Infinity) score += (this.prof.aggro * 3) / (1 + near);
          score = score / (1 + d * 0.35) + this.rng() * 0.05;
          if (score > best.score) best = { c, score };
        }
        for (const n of this.neighbors(a, c)) {
          if (prev.has(n) || !this.walkable(a, n, start) || danger.start[n] !== Infinity) continue;
          prev.set(n, c);
          next.push(n);
        }
      }
      frontier = next;
    }
    return best.c === start ? [] : this.trace(prev, best.c);
  }

  private wander(a: Arena, p: ArenaPlayer, danger: Danger): number[] {
    const start = a.cellAt(p.x, p.y);
    let c = start;
    const path: number[] = [];
    for (let i = 0; i < 4; i++) {
      const options = this.neighbors(a, c).filter(
        (n) => this.walkable(a, n, start) && danger.start[n] === Infinity && !path.includes(n) && n !== start,
      );
      if (!options.length) break;
      c = options[0];
      path.push(c);
    }
    return path;
  }

  private trace(prev: Map<number, number>, end: number): number[] {
    const path: number[] = [];
    for (let c = end; prev.get(c) !== -1 && prev.has(c); c = prev.get(c)!) path.push(c);
    return path.reverse();
  }

  // ---------------------------------------------------------------- moving

  private follow(a: Arena, p: ArenaPlayer): SimInput {
    const bomb = this.bombNow;
    this.bombNow = false;
    const here = a.cellAt(p.x, p.y);
    while (this.path.length && this.path[0] === here && centered(p)) this.path.shift();
    const target = this.path[0] ?? here;
    // Never step into live fire, whatever the plan says.
    if (target !== here && a.flames.has(target)) return { dir: 0, bomb };
    const tx = target % a.cols;
    const ty = (target - tx) / a.cols;
    const dx = tx - p.x;
    const dy = ty - p.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return { dir: 0, bomb };
    let dir: Dir;
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 2 : 4;
    else dir = dy > 0 ? 3 : 1;
    return { dir, bomb, to: { x: tx, y: ty } };
  }
}

/** One round's arena plus the brains steering its CPU bombers. */
export class Match {
  readonly brains = new Map<string, Brain>();

  constructor(
    readonly arena: Arena,
    cpus: { id: string; level: CpuLevel }[],
    rng: Rng,
  ) {
    for (const c of cpus) this.brains.set(c.id, new Brain(c.id, c.level, rng));
  }

  step(dt: number): void {
    const inputs: Record<string, SimInput> = {};
    for (const [id, brain] of this.brains) inputs[id] = brain.input(this.arena);
    this.arena.step(dt, inputs);
  }
}
