import { rngStep } from "@warrick/kit/shared/rng";
import { ARM_MOVES, MAX_LAND, ROCK_COST, ROCK_HP } from "./constants";

/** Which way a move slides the tiles. */
export type Dir = 0 | 1 | 2 | 3;
export const UP: Dir = 0;
export const RIGHT: Dir = 1;
export const DOWN: Dir = 2;
export const LEFT: Dir = 3;
export const DIRS: readonly Dir[] = [UP, RIGHT, DOWN, LEFT];

export function isDir(d: unknown): d is Dir {
  return d === 0 || d === 1 || d === 2 || d === 3;
}

// A cell is 0 when empty, n > 0 for the tile 2^n, and -h for a rock that takes h more hits to smash.

/** The lines of cells a move slides along, each listed from the edge the tiles slide toward. */
const LINES = new Map<string, number[][]>();

function linesFor(size: number, dir: Dir): number[][] {
  const key = `${size}:${dir}`;
  let out = LINES.get(key);
  if (out) return out;
  out = [];
  for (let a = 0; a < size; a++) {
    const line: number[] = [];
    for (let b = 0; b < size; b++) {
      if (dir === UP) line.push(b * size + a);
      else if (dir === DOWN) line.push((size - 1 - b) * size + a);
      else if (dir === LEFT) line.push(a * size + b);
      else line.push(a * size + size - 1 - b);
    }
    out.push(line);
  }
  LINES.set(key, out);
  return out;
}

export function neighbours(size: number, cell: number): number[] {
  const x = cell % size;
  const y = Math.floor(cell / size);
  const out: number[] = [];
  if (y > 0) out.push(cell - size);
  if (x < size - 1) out.push(cell + 1);
  if (y < size - 1) out.push(cell + size);
  if (x > 0) out.push(cell - 1);
  return out;
}

/** One tile (or rock) sliding during a move: where it was, where it went, and what it was. */
export interface Tween {
  from: number;
  to: number;
  v: number;
}

export interface Slide {
  cells: number[];
  tweens: Tween[];
  /** Cells where two tiles merged into one. */
  merged: number[];
}

export class Board {
  readonly cells: number[];

  constructor(
    readonly size: number,
    cells?: number[],
  ) {
    this.cells = cells ?? Array<number>(size * size).fill(0);
  }

  clone(): Board {
    return new Board(this.size, this.cells.slice());
  }

  empties(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === 0) out.push(i);
    return out;
  }

  /** The biggest tile's exponent (11 for 2048), or 0. */
  best(): number {
    let best = 0;
    for (const v of this.cells) if (v > best) best = v;
    return best;
  }

  rocks(): number {
    return this.cells.filter((v) => v < 0).length;
  }

  filled(): number {
    return this.cells.filter((v) => v !== 0).length;
  }

  /**
   * Slide everything toward one edge without changing this board. Rocks slide too but never
   * merge; each tile merges at most once per move. Null if nothing would move.
   */
  slide(dir: Dir): Slide | null {
    const src = this.cells;
    const cells = Array<number>(src.length).fill(0);
    const tweens: Tween[] = [];
    const merged: number[] = [];
    let moved = false;
    for (const line of linesFor(this.size, dir)) {
      const items = line.filter((c) => src[c] !== 0);
      let slot = 0;
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        const v = src[a];
        const to = line[slot++];
        const b = items[i + 1];
        if (v > 0 && b !== undefined && src[b] === v) {
          cells[to] = v + 1;
          merged.push(to);
          tweens.push({ from: a, to, v }, { from: b, to, v });
          moved = true;
          i++;
        } else {
          cells[to] = v;
          tweens.push({ from: a, to, v });
          if (a !== to) moved = true;
        }
      }
    }
    return moved ? { cells, tweens, merged } : null;
  }

  /** Whether any move would change the board. */
  canMove(): boolean {
    const { size, cells } = this;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (v === 0) return true;
      if (v < 0) continue;
      const x = i % size;
      if (x < size - 1 && cells[i + 1] === v) return true;
      if (i + size < cells.length && cells[i + size] === v) return true;
    }
    return false;
  }

  /** One character per cell: "0" empty, base-36 exponents for tiles, "A", "B"… for rocks with 1, 2… hits left. */
  encode(): string {
    return this.cells.map((v) => (v > 0 ? v.toString(36) : v < 0 ? String.fromCharCode(64 - v) : "0")).join("");
  }

  static decode(s: string, size: number): Board | null {
    if (typeof s !== "string" || s.length !== size * size) return null;
    const cells: number[] = [];
    for (const ch of s) {
      const v = ch >= "A" && ch <= "Z" ? -(ch.charCodeAt(0) - 64) : parseInt(ch, 36);
      if (!Number.isFinite(v)) return null;
      cells.push(v);
    }
    return new Board(size, cells);
  }
}

/** Rocks on their way to a board. */
export interface Garbage {
  id: number;
  /** Rocks still to land. */
  rocks: number;
  /** The board they came from. */
  from: number;
  /** The move during which this board first knew about them, or -1 before that. They land ARM_MOVES moves later. */
  at: number;
}

/** Everything about a lane that later play depends on. */
export interface LaneSnap {
  size: number;
  b: string;
  n: number;
  score: number;
  charge: number;
  rv: number;
  rp: number;
  q: Garbage[];
  ack: number;
  out: boolean;
  hit: number;
  merges: number;
  smashed: number;
}

export interface MoveResult {
  dir: Dir;
  tweens: Tween[];
  merged: number[];
  /** Rocks a merge hit, with the hits each has left (0: smashed). */
  hits: { cell: number; hp: number }[];
  /** Cells rocks landed in. */
  landed: number[];
  /** Where the new tile appeared, or -1. */
  spawn: number;
  /** Score from this move (the merged tiles' values, as in the original). */
  points: number;
  /** Merges this move. Two or more multiply its power. */
  combo: number;
  /** Rocks this move's power made, before cancelling. */
  attack: number;
  /** Rocks on their way here that this move's attack smashed instead. */
  cancelled: number;
  /** Rocks left over to send. */
  sent: number;
  out: boolean;
}

/** A move's power: each merge into 2^k is worth k - 1, and a move with m ≥ 2 merges is worth (m + 1) / 2 times as much. */
export function movePower(newTiles: number[]): number {
  let power = 0;
  for (const v of newTiles) power += v - 1;
  const m = newTiles.length;
  return m >= 2 ? Math.floor((power * (m + 1)) / 2) : power;
}

/**
 * One player's game, the only model of it: the browser plays it and the server replays every
 * move into its own copy, so both must stay deterministic. Time never enters it.
 *
 * Everyone in a round shares a seed. Tile values come from their own stream, so everyone gets
 * the same 2s and 4s in the same order; where they appear (and where rocks land) comes from
 * another, since that depends on the board.
 */
export class Lane {
  board: Board;
  /** Moves made. */
  n = 0;
  score = 0;
  /** Power carried toward the next rock. */
  charge = 0;
  /** Random streams: tile values, and positions. */
  rv: number;
  rp: number;
  queue: Garbage[] = [];
  /** The newest garbage id this board had seen at its last move. */
  ack = 0;
  out = false;
  /** The board whose rocks landed here last, for KO credit. */
  lastHitBy = -1;
  merges = 0;
  smashed = 0;

  constructor(seed: number, size: number) {
    this.board = new Board(size);
    this.rv = seed >>> 0;
    this.rp = (seed ^ 0x9e3779b9) >>> 0;
    this.spawn(this.board.cells);
    this.spawn(this.board.cells);
  }

  get size(): number {
    return this.board.size;
  }

  get best(): number {
    return this.board.best();
  }

  /** Rocks on their way. */
  pending(): number {
    let n = 0;
    for (const q of this.queue) n += q.rocks;
    return n;
  }

  /** Rocks that land on the next move unless it smashes them first. */
  armed(): number {
    let n = 0;
    for (const q of this.queue) if (q.at >= 0 && this.n - q.at >= ARM_MOVES - 1) n += q.rocks;
    return Math.min(n, MAX_LAND);
  }

  /** Whether a move that way would change anything. */
  canSlide(dir: Dir): boolean {
    return !this.out && !!this.board.slide(dir);
  }

  /**
   * Make a move. `g` is the newest garbage id the player had seen when they made it: only
   * garbage up to there counts as seen, can be smashed, and starts its countdown to land.
   * Null if the move changes nothing (or the lane is out, or `g` went backwards).
   */
  move(dir: Dir, g: number): MoveResult | null {
    if (this.out || !isDir(dir) || !Number.isInteger(g) || g < this.ack) return null;
    const slide = this.board.slide(dir);
    if (!slide) return null;
    const { size } = this.board;
    const cells = slide.cells;
    const k = this.n;

    // A merge hits every rock right next to it, each rock at most once a move.
    const hit = new Set<number>();
    for (const c of slide.merged) for (const nb of neighbours(size, c)) if (cells[nb] < 0) hit.add(nb);
    const hits = [...hit]
      .sort((a, b) => a - b)
      .map((cell) => {
        cells[cell]++;
        return { cell, hp: cells[cell] < 0 ? -cells[cell] : 0 };
      });

    let points = 0;
    for (const c of slide.merged) points += 2 ** cells[c];
    this.charge += movePower(slide.merged.map((c) => cells[c]));
    const attack = Math.floor(this.charge / ROCK_COST);
    this.charge -= attack * ROCK_COST;

    // Garbage: this move sees what the player had seen, smashes what it can, and the rest may land.
    this.ack = g;
    for (const q of this.queue) if (q.id <= g && q.at < 0) q.at = k;
    let left = attack;
    let cancelled = 0;
    for (const q of this.queue) {
      if (!left) break;
      if (q.at < 0) continue;
      const c = Math.min(left, q.rocks);
      q.rocks -= c;
      left -= c;
      cancelled += c;
    }
    const landed: number[] = [];
    for (const q of this.queue) {
      if (q.at < 0 || k - q.at < ARM_MOVES - 1) continue;
      landed.push(...this.land(cells, q, MAX_LAND - landed.length));
    }
    this.queue = this.queue.filter((q) => q.rocks > 0);

    const spawn = this.spawn(cells);
    this.board = new Board(size, cells);
    this.n++;
    this.score += points;
    this.merges += slide.merged.length;
    this.smashed += hits.filter((h) => h.hp === 0).length;
    this.out = !this.board.canMove();
    return {
      dir,
      tweens: slide.tweens,
      merged: slide.merged,
      hits,
      landed,
      spawn,
      points,
      combo: slide.merged.length,
      attack,
      cancelled,
      sent: left,
      out: this.out,
    };
  }

  /**
   * The server drops waiting rocks on a player who's stopped moving, armed or not. Not a move.
   * Rocks with nowhere to land bury a player who won't move: they're out even if a merge is left.
   */
  drop(): number[] {
    if (this.out) return [];
    const cells = this.board.cells.slice();
    const landed: number[] = [];
    for (const q of this.queue) landed.push(...this.land(cells, q, MAX_LAND - landed.length));
    this.queue = this.queue.filter((q) => q.rocks > 0);
    this.board = new Board(this.size, cells);
    this.out = !this.board.canMove() || (this.queue.length > 0 && !this.board.empties().length);
    return landed;
  }

  /**
   * A hash of everything later play depends on. Only garbage the player had seen counts: the
   * server may have queued more that the browser hasn't heard about yet, and no move touches it.
   */
  checksum(): number {
    const q = this.queue
      .filter((g) => g.id <= this.ack)
      .map((g) => `${g.id}.${g.rocks}.${g.at}`)
      .join(",");
    const s = `${this.board.encode()}|${this.n}|${this.score}|${this.charge}|${this.rv}|${this.rp}|${this.ack}|${this.out ? 1 : 0}|${q}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  snap(): LaneSnap {
    return {
      size: this.size,
      b: this.board.encode(),
      n: this.n,
      score: this.score,
      charge: this.charge,
      rv: this.rv,
      rp: this.rp,
      q: this.queue.map((g) => ({ ...g })),
      ack: this.ack,
      out: this.out,
      hit: this.lastHitBy,
      merges: this.merges,
      smashed: this.smashed,
    };
  }

  static fromSnap(s: LaneSnap): Lane {
    const lane = new Lane(0, s.size);
    lane.board = Board.decode(s.b, s.size) ?? new Board(s.size);
    lane.n = s.n;
    lane.score = s.score;
    lane.charge = s.charge;
    lane.rv = s.rv;
    lane.rp = s.rp;
    lane.queue = s.q.map((g) => ({ ...g }));
    lane.ack = s.ack;
    lane.out = s.out;
    lane.lastHitBy = s.hit;
    lane.merges = s.merges;
    lane.smashed = s.smashed;
    return lane;
  }

  // ---------------------------------------------------------------- internals

  private roll(stream: "rv" | "rp"): number {
    const r = rngStep(this[stream]);
    this[stream] = r.state;
    return r.value;
  }

  /** A new tile in a random empty cell: a 2, or one time in ten a 4. */
  private spawn(cells: number[]): number {
    const empty = emptyCells(cells);
    if (!empty.length) return -1;
    const cell = empty[Math.floor(this.roll("rp") * empty.length)];
    cells[cell] = this.roll("rv") < 0.9 ? 1 : 2;
    return cell;
  }

  /** Land up to `room` of a garbage's rocks in random empty cells. */
  private land(cells: number[], q: Garbage, room: number): number[] {
    const landed: number[] = [];
    while (q.rocks > 0 && landed.length < room) {
      const empty = emptyCells(cells);
      if (!empty.length) break;
      const cell = empty[Math.floor(this.roll("rp") * empty.length)];
      cells[cell] = -ROCK_HP;
      landed.push(cell);
      q.rocks--;
      this.lastHitBy = q.from;
    }
    return landed;
  }
}

function emptyCells(cells: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] === 0) out.push(i);
  return out;
}

/** The value of a tile exponent, for showing: 11 → 2048. */
export function tileValue(v: number): number {
  return 2 ** v;
}
