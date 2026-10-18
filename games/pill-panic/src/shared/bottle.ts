import {
  COLS,
  DAS_DELAY,
  DAS_RATE,
  GARBAGE_BATCHES,
  GRAVITY,
  MAX_PENDING,
  POP_TICKS,
  ROWS,
  SETTLE_TICKS,
  SOFT_DROP,
  SPAWN_TICKS,
  SPAWN_X,
  SPEED_UP_EVERY,
  virusCount,
  virusTop,
} from "./constants";
import { mulberry32 } from "@warrick/kit/shared/rng";

// Colors. A cell's low two bits; 0 is empty.
export const RED = 1;
export const YELLOW = 2;
export const BLUE = 3;

// Buttons, as bits of an input mask. A bottle steps once per tick with the buttons held during it.
export const B_LEFT = 1;
export const B_RIGHT = 2;
export const B_DOWN = 4;
export const B_CW = 8;
export const B_CCW = 16;
export const B_DROP = 32;
export const PLAYER_BUTTONS = 63;
/** Not a button: the server sets it when a player leaves mid-round, and the bottle tops out. */
export const B_QUIT = 64;

// Cells: color in bits 0-1, kind in bits 2-4, popping in bit 5.
export const COLOR = 3;
export const KIND = 7 << 2;
export const VIRUS = 1 << 2;
/** Half a capsule whose other half is gone. */
export const LONE = 2 << 2;
/** Left half of a lying capsule: its partner is to the right. */
export const LINK_R = 3 << 2;
export const LINK_L = 4 << 2;
/** Top half of a standing capsule: its partner is below. */
export const LINK_D = 5 << 2;
export const LINK_U = 6 << 2;
export const POP = 1 << 5;

export type Phase = "spawn" | "fall" | "pop" | "settle" | "won" | "dead";
const PHASES: Phase[] = ["spawn", "fall", "pop", "settle", "won", "dead"];

/**
 * The falling capsule. (x, y) is its bottom-left cell. Rotation 0 lies flat with `a` on the
 * left; each clockwise turn stands it up or lays it down around that cell.
 */
export interface Piece {
  x: number;
  y: number;
  rot: number;
  a: number;
  b: number;
}

/** An attack: loose halves, as [column, color], that drop into a bottle before its next capsule. */
export interface Garbage {
  id: number;
  p: [number, number][];
}

export type BottleEvent =
  | { k: "spawn" }
  | { k: "move" }
  | { k: "rotate" }
  | { k: "land" }
  | { k: "pop"; chain: number; groups: number; viruses: number }
  | { k: "attack"; colors: number[] }
  | { k: "garbage"; n: number }
  | { k: "won" }
  | { k: "dead" };

export interface BottleSnap {
  seed: number;
  start: number;
  cells: string;
  tick: number;
  phase: Phase;
  timer: number;
  piece: [number, number, number, number, number] | null;
  count: number;
  gravity: number;
  das: number;
  dir: number;
  prev: number;
  downLock: boolean;
  viruses: number;
  chain: number;
  groups: number;
  colors: number[];
  garbageFall: boolean;
  pending: Garbage[];
  cleared: number;
  bestChain: number;
}

/**
 * One player's bottle: a deterministic simulation stepped once per tick with the buttons held.
 * The same seed, level and inputs give the same bottle on the server and in every browser,
 * which is what lets a player's own browser run it without lag while the server replays it.
 */
export class Bottle {
  cells: Uint8Array;
  tick = 0;
  phase: Phase = "spawn";
  timer = 1;
  piece: Piece | null = null;
  /** Capsules handed out so far. */
  count = 0;
  gravity = 0;
  das = 0;
  /** The last horizontal direction pressed, for when both are held. */
  dir = 0;
  /** Buttons held last tick, to spot presses. */
  prevMask = 0;
  /** Down was already held when this capsule appeared: don't soft-drop it until it's let go. */
  downLock = false;
  viruses = 0;
  /** The combo in progress: clears so far, lines cleared, and their colors. */
  chain = 0;
  groups = 0;
  colors: number[] = [];
  /** The settling in progress was started by garbage, so its clears don't attack anyone. */
  garbageFall = false;
  pending: Garbage[] = [];
  cleared = 0;
  bestChain = 0;
  /** What happened since the owner last looked. Not part of the state. */
  events: BottleEvent[] = [];

  constructor(
    readonly seed: number,
    /** Gravity notch for the first capsules. */
    readonly start: number,
    cells: Uint8Array,
  ) {
    this.cells = cells;
    for (const c of cells) if ((c & KIND) === VIRUS) this.viruses++;
  }

  static create(seed: number, level: number, start: number): Bottle {
    return new Bottle(seed, start, virusLayout(seed, level));
  }

  // ---------------------------------------------------------------- reading

  at(x: number, y: number): number {
    return this.cells[y * COLS + x];
  }

  get speed(): number {
    return Math.min(GRAVITY.length - 1, this.start + Math.floor(Math.max(0, this.count - 1) / SPEED_UP_EVERY));
  }

  get done(): boolean {
    return this.phase === "won" || this.phase === "dead";
  }

  /** The capsule after the current one. */
  get next(): [number, number] {
    return capsuleAt(this.seed, this.count);
  }

  /** Where the falling capsule would land. */
  ghostY(): number {
    const p = this.piece;
    if (!p) return 0;
    let y = p.y;
    while (this.fits(p.x, y + 1, p.rot)) y++;
    return y;
  }

  pendingPieces(): number {
    let n = 0;
    for (const g of this.pending) n += g.p.length;
    return n;
  }

  // ---------------------------------------------------------------- stepping

  /** Queue an attack. It drops in once the current capsule has landed and settled. */
  addGarbage(g: Garbage): void {
    if (this.pending.length < MAX_PENDING) this.pending.push({ id: g.id, p: g.p.map(([x, c]) => [x, c]) });
  }

  step(mask: number): void {
    const pressed = mask & ~this.prevMask;
    this.prevMask = mask;
    if (mask & B_QUIT && !this.done) {
      this.die();
    } else {
      switch (this.phase) {
        case "spawn":
          if (--this.timer <= 0) this.spawn(mask);
          break;
        case "fall":
          this.control(mask, pressed);
          break;
        case "pop":
          if (--this.timer <= 0) {
            removePopped(this.cells);
            this.phase = "settle";
            this.timer = SETTLE_TICKS;
          }
          break;
        case "settle":
          if (--this.timer <= 0) {
            if (fallStep(this.cells)) this.timer = SETTLE_TICKS;
            else this.resolve();
          }
          break;
      }
    }
    this.tick++;
  }

  private spawn(mask: number): void {
    const [a, b] = capsuleAt(this.seed, this.count);
    this.count++;
    this.piece = { x: SPAWN_X, y: 0, rot: 0, a, b };
    if (this.at(SPAWN_X, 0) || this.at(SPAWN_X + 1, 0)) return this.die();
    this.phase = "fall";
    this.gravity = 0;
    this.downLock = (mask & B_DOWN) !== 0;
    this.events.push({ k: "spawn" });
  }

  private control(mask: number, pressed: number): void {
    const p = this.piece!;
    if (pressed & B_CW) this.rotate(1);
    else if (pressed & B_CCW) this.rotate(-1);

    if (pressed & B_LEFT) this.dir = -1;
    if (pressed & B_RIGHT) this.dir = 1;
    const left = (mask & B_LEFT) !== 0;
    const right = (mask & B_RIGHT) !== 0;
    const dir = left && right ? this.dir : left ? -1 : right ? 1 : 0;
    if (dir) {
      if (pressed & (dir < 0 ? B_LEFT : B_RIGHT)) {
        this.das = 0;
        this.shift(dir);
      } else if (++this.das >= DAS_DELAY) {
        this.das = DAS_DELAY - DAS_RATE;
        this.shift(dir);
      }
    } else {
      this.das = 0;
    }

    if (pressed & B_DROP) {
      while (this.fits(p.x, p.y + 1, p.rot)) p.y++;
      return this.lock();
    }

    if (!(mask & B_DOWN)) this.downLock = false;
    const fall = GRAVITY[this.speed];
    const limit = mask & B_DOWN && !this.downLock ? Math.min(SOFT_DROP, fall) : fall;
    if (++this.gravity >= limit) {
      this.gravity = 0;
      if (this.fits(p.x, p.y + 1, p.rot)) p.y++;
      else this.lock();
    }
  }

  private rotate(turn: 1 | -1): void {
    const q = rotated(this.cells, this.piece!, turn);
    if (!q) return;
    Object.assign(this.piece!, q);
    this.events.push({ k: "rotate" });
  }

  private shift(dir: number): void {
    const p = this.piece!;
    if (!this.fits(p.x + dir, p.y, p.rot)) return;
    p.x += dir;
    this.events.push({ k: "move" });
  }

  fits(x: number, y: number, rot: number): boolean {
    return fitsIn(this.cells, x, y, rot);
  }

  private lock(): void {
    const p = this.piece!;
    const parts = pieceCells(p);
    // Landing with half the capsule still above the bottle tops you out.
    if (parts.some(([, y]) => y < 0)) return this.die();
    this.piece = null;
    for (const [x, y, c, kind] of parts) this.cells[y * COLS + x] = kind | c;
    this.events.push({ k: "land" });
    this.chain = 0;
    this.groups = 0;
    this.colors = [];
    this.garbageFall = false;
    this.resolve();
  }

  /** Clear any lines of four, or end the combo if there are none. */
  private resolve(): void {
    const m = markMatches(this.cells);
    if (m.groups) {
      this.chain++;
      this.groups += m.groups;
      this.colors.push(...m.colors);
      this.viruses -= m.viruses;
      this.cleared += m.viruses;
      if (!this.garbageFall) this.bestChain = Math.max(this.bestChain, this.chain);
      this.events.push({ k: "pop", chain: this.chain, groups: m.groups, viruses: m.viruses });
      this.phase = "pop";
      this.timer = POP_TICKS;
      return;
    }
    // Two or more lines from one capsule, at once or in a chain, attack: one half per line, up to four.
    if (!this.garbageFall && this.groups >= 2) this.events.push({ k: "attack", colors: this.colors.slice(0, 4) });
    this.chain = 0;
    this.groups = 0;
    this.colors = [];
    if (this.viruses <= 0) {
      this.phase = "won";
      this.events.push({ k: "won" });
      return;
    }
    if (!this.garbageFall && this.pending.length) return this.dropGarbage();
    this.garbageFall = false;
    this.phase = "spawn";
    this.timer = SPAWN_TICKS;
  }

  private dropGarbage(): void {
    let n = 0;
    this.pending.splice(0, GARBAGE_BATCHES).forEach((g, row) => {
      for (const [x, c] of g.p) {
        if (this.cells[row * COLS + x]) continue;
        this.cells[row * COLS + x] = LONE | c;
        n++;
      }
    });
    this.garbageFall = true;
    this.events.push({ k: "garbage", n });
    this.phase = "settle";
    this.timer = SETTLE_TICKS;
  }

  private die(): void {
    this.phase = "dead";
    this.events.push({ k: "dead" });
  }

  // ---------------------------------------------------------------- snapshots

  snapshot(): BottleSnap {
    const p = this.piece;
    return {
      seed: this.seed,
      start: this.start,
      cells: encodeCells(this.cells),
      tick: this.tick,
      phase: this.phase,
      timer: this.timer,
      piece: p ? [p.x, p.y, p.rot, p.a, p.b] : null,
      count: this.count,
      gravity: this.gravity,
      das: this.das,
      dir: this.dir,
      prev: this.prevMask,
      downLock: this.downLock,
      viruses: this.viruses,
      chain: this.chain,
      groups: this.groups,
      colors: [...this.colors],
      garbageFall: this.garbageFall,
      pending: this.pending.map((g) => ({ id: g.id, p: g.p.map(([x, c]) => [x, c]) })),
      cleared: this.cleared,
      bestChain: this.bestChain,
    };
  }

  static restore(s: BottleSnap): Bottle {
    const b = new Bottle(s.seed, s.start, decodeCells(s.cells));
    b.tick = s.tick;
    b.phase = s.phase;
    b.timer = s.timer;
    b.piece = s.piece ? { x: s.piece[0], y: s.piece[1], rot: s.piece[2], a: s.piece[3], b: s.piece[4] } : null;
    b.count = s.count;
    b.gravity = s.gravity;
    b.das = s.das;
    b.dir = s.dir;
    b.prevMask = s.prev;
    b.downLock = s.downLock;
    b.viruses = s.viruses;
    b.chain = s.chain;
    b.groups = s.groups;
    b.colors = [...s.colors];
    b.garbageFall = s.garbageFall;
    b.pending = s.pending.map((g) => ({ id: g.id, p: g.p.map(([x, c]) => [x, c]) }));
    b.cleared = s.cleared;
    b.bestChain = s.bestChain;
    return b;
  }

  /**
   * A hash of everything that decides what the bottle does next, except attacks waiting to drop:
   * those can arrive between two ticks, and any difference shows up as soon as they land.
   */
  checksum(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v & 0xff), 0x01000193);
      h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    };
    for (const c of this.cells) mix(c);
    const p = this.piece;
    mix(this.tick);
    mix(this.tick >>> 16);
    mix(PHASES.indexOf(this.phase));
    mix(this.timer);
    if (p) [p.x + 1, p.y + 2, p.rot, p.a, p.b].forEach(mix);
    else mix(0xffff);
    [this.count, this.gravity, this.das, this.dir + 1, this.prevMask, +this.downLock, this.viruses].forEach(mix);
    [this.chain, this.groups, +this.garbageFall].forEach(mix);
    return h >>> 0;
  }
}

// ------------------------------------------------------------------ capsules and viruses

/** Capsule number `i` of a round. Everyone in a round gets the same sequence. */
export function capsuleAt(seed: number, i: number): [number, number] {
  let h = Math.imul(seed ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const k = (h >>> 0) % 9;
  return [(k % 3) + 1, Math.floor(k / 3) + 1];
}

/**
 * The starting viruses for a level. Colors take turns, and no virus has one of its own color two
 * cells away in a straight line, which also rules out three in a row (after NES Dr. Mario).
 */
export function virusLayout(seed: number, level: number): Uint8Array {
  const cells = new Uint8Array(COLS * ROWS);
  const rng = mulberry32(seed ^ 0x5eed1e55);
  const total = virusCount(level);
  const top = virusTop(level);
  const same = (x: number, y: number, c: number) =>
    x >= 0 && x < COLS && y >= 0 && y < ROWS && (cells[y * COLS + x] & COLOR) === c;
  let placed = 0;
  for (let tries = 0; placed < total && tries < 20000; tries++) {
    const x = Math.floor(rng() * COLS);
    const y = top + Math.floor(rng() * (ROWS - top));
    if (cells[y * COLS + x]) continue;
    // After many misses, allow anything that doesn't line up three.
    const strict = tries < 12000;
    for (let k = 0; k < 3; k++) {
      const c = ((placed + k) % 3) + 1;
      const spaced = !same(x - 2, y, c) && !same(x + 2, y, c) && !same(x, y - 2, c) && !same(x, y + 2, c);
      const noThree =
        !(same(x - 1, y, c) && (same(x - 2, y, c) || same(x + 1, y, c))) &&
        !(same(x + 1, y, c) && same(x + 2, y, c)) &&
        !(same(x, y - 1, c) && (same(x, y - 2, c) || same(x, y + 1, c))) &&
        !(same(x, y + 1, c) && same(x, y + 2, c));
      if (strict ? spaced : noThree) {
        cells[y * COLS + x] = VIRUS | c;
        placed++;
        break;
      }
    }
  }
  return cells;
}

/** Whether a capsule fits at (x, y). Its top half may stick out above the bottle. */
export function fitsIn(cells: Uint8Array, x: number, y: number, rot: number): boolean {
  const free = (x: number, y: number) => x >= 0 && x < COLS && y < ROWS && (y < 0 || cells[y * COLS + x] === 0);
  return rot & 1 ? free(x, y) && free(x, y - 1) : free(x, y) && free(x + 1, y);
}

/** The capsule after one turn, or null if it can't turn there. */
export function rotated(cells: Uint8Array, p: Piece, turn: 1 | -1): Piece | null {
  const rot = (p.rot + turn + 4) & 3;
  if (fitsIn(cells, p.x, p.y, rot)) return { ...p, rot };
  // Laying a capsule down against the right wall or a block: it shifts left to make room.
  if ((rot & 1) === 0 && fitsIn(cells, p.x - 1, p.y, rot)) return { ...p, x: p.x - 1, rot };
  return null;
}

/** The two cells of a capsule, as [x, y, color, kind]. */
export function pieceCells(p: Piece): [number, number, number, number][] {
  switch (p.rot & 3) {
    case 0:
      return [
        [p.x, p.y, p.a, LINK_R],
        [p.x + 1, p.y, p.b, LINK_L],
      ];
    case 1:
      return [
        [p.x, p.y - 1, p.a, LINK_D],
        [p.x, p.y, p.b, LINK_U],
      ];
    case 2:
      return [
        [p.x, p.y, p.b, LINK_R],
        [p.x + 1, p.y, p.a, LINK_L],
      ];
    default:
      return [
        [p.x, p.y - 1, p.b, LINK_D],
        [p.x, p.y, p.a, LINK_U],
      ];
  }
}

// ------------------------------------------------------------------ grid rules (shared with the CPU)

/** Mark every line of four or more of one color as popping. */
export function markMatches(cells: Uint8Array): { groups: number; colors: number[]; viruses: number } {
  const hit = new Uint8Array(cells.length);
  const colors: number[] = [];
  const scan = (len: number, lines: number, at: (line: number, i: number) => number) => {
    for (let line = 0; line < lines; line++) {
      let i = 0;
      while (i < len) {
        const c = cells[at(line, i)] & COLOR;
        let e = i + 1;
        if (c) while (e < len && (cells[at(line, e)] & COLOR) === c) e++;
        if (c && e - i >= 4) {
          colors.push(c);
          for (let k = i; k < e; k++) hit[at(line, k)] = 1;
        }
        i = e;
      }
    }
  };
  scan(COLS, ROWS, (y, x) => y * COLS + x);
  scan(ROWS, COLS, (x, y) => y * COLS + x);
  let viruses = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!hit[i]) continue;
    if ((cells[i] & KIND) === VIRUS) viruses++;
    cells[i] |= POP;
  }
  return { groups: colors.length, colors, viruses };
}

/** Remove popping cells. A capsule half that loses its partner becomes a loose half. */
export function removePopped(cells: Uint8Array): void {
  for (let i = 0; i < cells.length; i++) {
    if (!(cells[i] & POP)) continue;
    const j = partner(i, cells[i]);
    if (j >= 0 && !(cells[j] & POP)) cells[j] = LONE | (cells[j] & COLOR);
  }
  for (let i = 0; i < cells.length; i++) if (cells[i] & POP) cells[i] = 0;
}

function partner(i: number, cell: number): number {
  switch (cell & KIND) {
    case LINK_R:
      return i + 1;
    case LINK_L:
      return i - 1;
    case LINK_D:
      return i + COLS;
    case LINK_U:
      return i - COLS;
    default:
      return -1;
  }
}

/**
 * Drop everything unsupported by one row. Works from the bottom up, so a stack falls together.
 * A lying capsule falls only if both halves are unsupported; viruses never fall.
 */
export function fallStep(cells: Uint8Array): boolean {
  let moved = false;
  const empty = (i: number) => cells[i] === 0;
  const move = (from: number, to: number) => {
    cells[to] = cells[from];
    cells[from] = 0;
  };
  for (let y = ROWS - 2; y >= 0; y--) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const kind = cells[i] & KIND;
      const below = i + COLS;
      if (kind === LONE) {
        if (empty(below)) {
          move(i, below);
          moved = true;
        }
      } else if (kind === LINK_R) {
        if (empty(below) && empty(below + 1)) {
          move(i, below);
          move(i + 1, below + 1);
          moved = true;
        }
      } else if (kind === LINK_U) {
        if (empty(below)) {
          move(i, below);
          move(i - COLS, i);
          moved = true;
        }
      }
    }
  }
  return moved;
}

// ------------------------------------------------------------------ encoding

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeCells(cells: Uint8Array): string {
  let s = "";
  for (const c of cells) s += ALPHABET[c & 63];
  return s;
}

export function decodeCells(s: string): Uint8Array {
  const cells = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < cells.length; i++) cells[i] = Math.max(0, ALPHABET.indexOf(s[i] ?? "A"));
  return cells;
}
