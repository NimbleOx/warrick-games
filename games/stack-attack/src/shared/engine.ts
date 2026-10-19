import { COLS, GARBAGE_CAP, ROWS, SPAWN_X, SPAWN_Y, VISIBLE } from "./constants";
import { Bag, GARBAGE, SHAPES, T, isPiece, kicks, type Piece } from "./pieces";

// ------------------------------------------------------------------ board

/** The grid of settled blocks. Cell (x, y) is cells[y * COLS + x]; y = 0 is the floor. */
export class Board {
  readonly cells: Uint8Array;

  constructor(cells?: Uint8Array) {
    this.cells = cells ?? new Uint8Array(COLS * ROWS);
  }

  clone(): Board {
    return new Board(this.cells.slice());
  }

  /** The cell's value, with everything outside the board counting as solid. */
  get(x: number, y: number): number {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return GARBAGE;
    return this.cells[y * COLS + x];
  }

  fits(p: Piece, r: number, x: number, y: number): boolean {
    for (const [dx, dy] of SHAPES[p][r]) {
      const cx = x + dx;
      const cy = y - dy;
      if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS || this.cells[cy * COLS + cx]) return false;
    }
    return true;
  }

  /** The lowest y the piece can fall to from (x, y). */
  drop(p: Piece, r: number, x: number, y: number): number {
    while (this.fits(p, r, x, y - 1)) y--;
    return y;
  }

  place(p: Piece, r: number, x: number, y: number): void {
    for (const [dx, dy] of SHAPES[p][r]) this.cells[(y - dy) * COLS + x + dx] = p;
  }

  /** Remove full rows and drop the rest. Returns the rows' y as they were, bottom first. */
  clearLines(): number[] {
    const full: number[] = [];
    const c = this.cells;
    let write = 0;
    for (let y = 0; y < ROWS; y++) {
      let n = 0;
      for (let x = 0; x < COLS; x++) if (c[y * COLS + x]) n++;
      if (n === COLS) {
        full.push(y);
        continue;
      }
      if (write !== y) c.copyWithin(write * COLS, y * COLS, (y + 1) * COLS);
      write++;
    }
    if (full.length) c.fill(0, write * COLS);
    return full;
  }

  /** Push `lines` rows of garbage in from the floor. Returns false if blocks were pushed off the top. */
  addGarbage(lines: number, hole: number): boolean {
    const c = this.cells;
    lines = Math.min(lines, ROWS);
    let ok = true;
    for (let i = (ROWS - lines) * COLS; i < ROWS * COLS; i++) if (c[i]) ok = false;
    c.copyWithin(lines * COLS, 0, (ROWS - lines) * COLS);
    for (let y = 0; y < lines; y++) {
      for (let x = 0; x < COLS; x++) c[y * COLS + x] = x === hole ? 0 : GARBAGE;
    }
    return ok;
  }

  /** One more than the highest occupied row; 0 for an empty board. */
  height(): number {
    for (let y = ROWS - 1; y >= 0; y--) {
      for (let x = 0; x < COLS; x++) if (this.cells[y * COLS + x]) return y + 1;
    }
    return 0;
  }

  isEmpty(): boolean {
    return this.cells.every((v) => v === 0);
  }

  /** Rows from the floor up to the highest block, one digit per cell. */
  encode(): string {
    const h = this.height();
    let s = "";
    for (let i = 0; i < h * COLS; i++) s += String.fromCharCode(48 + this.cells[i]);
    return s;
  }

  static decode(s: string): Board | null {
    if (typeof s !== "string" || s.length % COLS || s.length > COLS * ROWS) return null;
    const b = new Board();
    for (let i = 0; i < s.length; i++) {
      const v = s.charCodeAt(i) - 48;
      if (v < 0 || v > GARBAGE) return null;
      b.cells[i] = v;
    }
    return b;
  }
}

// ------------------------------------------------------------------ lane: one player's game

/** Garbage on its way into a board. Every row of one attack has its hole in the same column. */
export interface Garbage {
  id: number;
  lines: number;
  hole: number;
  /** The attacker's slot. */
  from: number;
}

/** Where a piece locked, as the player's browser reports it. */
export interface Placement {
  piece: Piece;
  r: number;
  x: number;
  y: number;
  /** The player swapped with the hold slot before locking this piece. */
  hold: boolean;
  /** 0 if the last move wasn't a turn; otherwise 1 + the index of the wall kick that turn used. */
  spin: number;
}

export const SPIN_NONE = 0;
export const SPIN_MINI = 1;
export const SPIN_FULL = 2;

export interface LockResult {
  piece: Piece;
  /** Rows cleared, as y before clearing. */
  cleared: number[];
  spin: number;
  /** Consecutive clears so far, counting from 0; -1 after a lock that cleared nothing. */
  combo: number;
  /** This clear earned the back-to-back bonus. */
  b2b: boolean;
  /** Perfect clear: the board is empty. */
  pc: boolean;
  /** Garbage this clear is worth, before cancelling. */
  attack: number;
  cancelled: number;
  /** What's left to send to an opponent. */
  sent: number;
  /** Garbage rows that rose into the board. */
  inserted: number;
  /** The player topped out. */
  out: boolean;
}

export interface LaneSnap {
  b: string;
  seed: number;
  n: number;
  hold: number;
  pc: number;
  combo: number;
  b2b: boolean;
  q: Garbage[];
  ack: number;
  out: boolean;
  lines: number;
  sent: number;
}

const CLEAR_ATTACK = [0, 0, 1, 2, 4];
const TSPIN_ATTACK = [0, 2, 4, 6];
const MINI_ATTACK = [0, 0, 1, 2];
const COMBO_ATTACK = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
const PERFECT_CLEAR_ATTACK = 10;

const CLEAR_POINTS = [0, 100, 300, 500, 800];
const TSPIN_POINTS = [400, 800, 1200, 1600];
const MINI_POINTS = [100, 200, 400];
const PERFECT_CLEAR_POINTS = [0, 800, 1200, 1800, 2000];

/**
 * Points for a lock, the usual guideline way: the clear (T-spins worth more), half as much
 * again for a back-to-back, 50 per combo step and a perfect-clear bonus, all times the level.
 * The level goes up with time, so only the server scores, like the garbage multiplier: keep it
 * out of `Lane`.
 */
export function lockPoints(res: LockResult, level: number): number {
  const lines = res.cleared.length;
  let pts = (res.spin === SPIN_FULL ? TSPIN_POINTS : res.spin === SPIN_MINI ? MINI_POINTS : CLEAR_POINTS)[lines] ?? 0;
  if (res.b2b) pts *= 1.5;
  if (lines && res.combo > 0) pts += 50 * res.combo;
  if (res.pc) pts += PERFECT_CLEAR_POINTS[lines] ?? 0;
  return Math.round(pts * level);
}

/**
 * One player's board, piece queue, hold, combo and incoming garbage. Both sides run the same
 * code: the player's browser locks pieces into its copy as they land, and the server replays
 * each reported placement into its own, so the two stay identical.
 *
 * Incoming garbage is the only thing that arrives from outside, and its timing is the same on
 * both sides by construction: each lock reports the newest garbage id the browser had seen
 * (`known`). A clear cancels only garbage up to `known`, and a lock without a clear lets in
 * only garbage up to the previous lock's `known`, so every attack gives at least one piece of
 * warning.
 */
export class Lane {
  board = new Board();
  bag: Bag;
  /** Index in the bag of the piece in play. */
  n = 0;
  hold = 0;
  /** Pieces placed. */
  pc = 0;
  combo = -1;
  b2b = false;
  queue: Garbage[] = [];
  /** Garbage up to this id was known at the last lock, so it can rise in on this one. */
  ack = 0;
  out = false;
  lines = 0;
  sent = 0;
  /** The slot whose garbage last rose into this board, for KO credit. */
  lastHitBy = -1;

  constructor(seed: number) {
    this.bag = new Bag(seed);
  }

  get current(): Piece {
    return this.bag.at(this.n);
  }

  /** What swapping with hold brings into play: the held piece, or else the next one. */
  get swapped(): Piece {
    return isPiece(this.hold) ? this.hold : this.bag.at(this.n + 1);
  }

  pending(): number {
    let n = 0;
    for (const g of this.queue) n += g.lines;
    return n;
  }

  /** Garbage that will rise in if the next lock clears nothing. */
  armed(): number {
    let n = 0;
    for (const g of this.queue) if (g.id <= this.ack) n += g.lines;
    return n;
  }

  spawnFits(): boolean {
    return this.board.fits(this.current, 0, SPAWN_X, SPAWN_Y);
  }

  clone(): Lane {
    const l = new Lane(this.bag.seed);
    l.bag = this.bag;
    l.board = this.board.clone();
    l.n = this.n;
    l.hold = this.hold;
    l.pc = this.pc;
    l.combo = this.combo;
    l.b2b = this.b2b;
    l.queue = this.queue.map((g) => ({ ...g }));
    l.ack = this.ack;
    l.out = this.out;
    l.lines = this.lines;
    l.sent = this.sent;
    l.lastHitBy = this.lastHitBy;
    return l;
  }

  /** Lock a piece. Returns null if the placement doesn't fit, isn't resting, or isn't the right piece. */
  lock(p: Placement, known: number): LockResult | null {
    if (this.out) return null;
    const piece = p.hold ? this.swapped : this.current;
    const b = this.board;
    if (p.piece !== piece || !(p.r >= 0 && p.r < 4)) return null;
    if (!Number.isInteger(p.r) || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return null;
    if (!b.fits(piece, p.r, p.x, p.y) || b.fits(piece, p.r, p.x, p.y - 1)) return null;

    const spin = spinKind(b, piece, p.r, p.x, p.y, p.spin);
    b.place(piece, p.r, p.x, p.y);
    const above = SHAPES[piece][p.r].every(([, dy]) => p.y - dy >= VISIBLE);
    const cleared = b.clearLines();
    const lines = cleared.length;

    if (p.hold) {
      const cur = this.current;
      this.n += this.hold ? 1 : 2;
      this.hold = cur;
    } else {
      this.n++;
    }
    this.pc++;

    let attack = 0;
    let b2b = false;
    let pc = false;
    if (lines) {
      this.combo++;
      const hard = lines === 4 || spin !== SPIN_NONE;
      attack = (spin === SPIN_FULL ? TSPIN_ATTACK : spin === SPIN_MINI ? MINI_ATTACK : CLEAR_ATTACK)[lines] ?? 0;
      if (hard && this.b2b) {
        attack++;
        b2b = true;
      }
      this.b2b = hard;
      attack += COMBO_ATTACK[Math.min(this.combo, COMBO_ATTACK.length - 1)];
      if (b.isEmpty()) {
        attack += PERFECT_CLEAR_ATTACK;
        pc = true;
      }
      this.lines += lines;
    } else {
      this.combo = -1;
    }

    // Queue entries arrive in id order, so the known ones are always at the front.
    let cancelled = 0;
    let inserted = 0;
    let overflow = false;
    if (lines) {
      let left = attack;
      for (const g of this.queue) {
        if (!left || g.id > known) break;
        const take = Math.min(g.lines, left);
        g.lines -= take;
        left -= take;
        cancelled += take;
      }
    } else {
      let room = GARBAGE_CAP;
      for (const g of this.queue) {
        if (!room || g.id > this.ack) break;
        const take = Math.min(g.lines, room);
        if (!b.addGarbage(take, g.hole)) overflow = true;
        g.lines -= take;
        room -= take;
        inserted += take;
        this.lastHitBy = g.from;
      }
    }
    this.queue = this.queue.filter((g) => g.lines > 0);
    this.ack = Math.max(this.ack, known);

    const sent = attack - cancelled;
    this.sent += sent;
    // Lock out (the piece landed wholly above the field), garbage pushed blocks off the top,
    // or block out (the next piece has nowhere to appear).
    const out = (above && !lines) || overflow || !this.spawnFits();
    if (out) this.out = true;
    return { piece, cleared, spin, combo: this.combo, b2b, pc, attack, cancelled, sent, inserted, out };
  }

  /**
   * Everything that decides how this lane plays from here, hashed. Garbage newer than `ack` is
   * left out: the server can queue it while a lock is on its way in, before the browser has
   * seen it, and no lock touches it until a later one reports it known.
   */
  checksum(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v | 0), 0x01000193);
    };
    const top = this.board.height() * COLS;
    for (let i = 0; i < top; i++) mix(this.board.cells[i]);
    mix(top);
    mix(this.n);
    mix(this.hold);
    mix(this.pc);
    mix(this.combo);
    mix(this.b2b ? 1 : 0);
    mix(this.ack);
    for (const g of this.queue) {
      if (g.id > this.ack) break;
      mix(g.id);
      mix(g.lines);
      mix(g.hole);
    }
    return h >>> 0;
  }

  snap(): LaneSnap {
    return {
      b: this.board.encode(),
      seed: this.bag.seed,
      n: this.n,
      hold: this.hold,
      pc: this.pc,
      combo: this.combo,
      b2b: this.b2b,
      q: this.queue.map((g) => ({ ...g })),
      ack: this.ack,
      out: this.out,
      lines: this.lines,
      sent: this.sent,
    };
  }

  static fromSnap(s: LaneSnap): Lane {
    const lane = new Lane(s.seed);
    lane.board = Board.decode(s.b) ?? new Board();
    lane.n = s.n;
    lane.hold = s.hold;
    lane.pc = s.pc;
    lane.combo = s.combo;
    lane.b2b = s.b2b;
    lane.queue = s.q.map((g) => ({ ...g }));
    lane.ack = s.ack;
    lane.out = s.out;
    lane.lines = s.lines;
    lane.sent = s.sent;
    return lane;
  }
}

/**
 * T-spins: the T's last move was a turn and three of the four corners around its centre are
 * solid. It's a full T-spin if both corners it points at are solid, or the turn needed the
 * last wall kick; otherwise a mini.
 */
export function spinKind(b: Board, p: Piece, r: number, x: number, y: number, spin: number): number {
  if (p !== T || !(spin > 0)) return SPIN_NONE;
  const cx = x + 1;
  const cy = y - 1;
  // Top-left, top-right, bottom-right, bottom-left.
  const solid = [
    b.get(cx - 1, cy + 1) !== 0,
    b.get(cx + 1, cy + 1) !== 0,
    b.get(cx + 1, cy - 1) !== 0,
    b.get(cx - 1, cy - 1) !== 0,
  ];
  if (solid.filter(Boolean).length < 3) return SPIN_NONE;
  const [a, c] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ][r];
  return (solid[a] && solid[c]) || spin - 1 === 4 ? SPIN_FULL : SPIN_MINI;
}

export function spinName(spin: number, lines: number): string {
  const n = ["", " SINGLE", " DOUBLE", " TRIPLE"][lines] ?? "";
  if (spin === SPIN_FULL) return `T-SPIN${n}`;
  if (spin === SPIN_MINI) return `T-SPIN MINI${n}`;
  return ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"][lines] ?? "";
}

// ------------------------------------------------------------------ reachability

/** A place a piece can get to from where it spawns, and how. */
export interface Spot {
  r: number;
  x: number;
  y: number;
  /** Bitmask of the wall-kick indexes turns reached it with. */
  kicks: number;
}

export const spotKey = (r: number, x: number, y: number) => (r * 32 + x + 8) * 64 + y;

/**
 * Every position the piece can reach from its spawn by shifting, soft dropping and turning
 * (gravity aside). The server checks reported placements against this, and the CPUs pick from it.
 */
export function explore(b: Board, p: Piece): Map<number, Spot> {
  const spots = new Map<number, Spot>();
  if (!b.fits(p, 0, SPAWN_X, SPAWN_Y)) return spots;
  const todo: Spot[] = [];
  const visit = (r: number, x: number, y: number, kick: number) => {
    const k = spotKey(r, x, y);
    let s = spots.get(k);
    if (!s) {
      s = { r, x, y, kicks: 0 };
      spots.set(k, s);
      todo.push(s);
    }
    if (kick >= 0) s.kicks |= 1 << kick;
  };
  visit(0, SPAWN_X, SPAWN_Y, -1);
  while (todo.length) {
    const { r, x, y } = todo.pop()!;
    if (b.fits(p, r, x - 1, y)) visit(r, x - 1, y, -1);
    if (b.fits(p, r, x + 1, y)) visit(r, x + 1, y, -1);
    if (b.fits(p, r, x, y - 1)) visit(r, x, y - 1, -1);
    for (const dir of [1, 3] as const) {
      const t = turn(b, p, r, x, y, dir);
      if (t) visit(t.r, t.x, t.y, t.kick);
    }
  }
  return spots;
}

/** Try to turn a piece, wall kicks included. Returns where it ends up and which kick did it. */
export function turn(
  b: Board,
  p: Piece,
  r: number,
  x: number,
  y: number,
  dir: 1 | 3,
): { r: number; x: number; y: number; kick: number } | null {
  const to = (r + dir) % 4;
  const ks = kicks(p, r, to);
  for (let i = 0; i < ks.length; i++) {
    const [kx, ky] = ks[i];
    if (b.fits(p, to, x + kx, y + ky)) return { r: to, x: x + kx, y: y + ky, kick: i };
  }
  return null;
}

/** Whether a reported placement is somewhere the piece could really have got to, the way it says. */
export function reachable(b: Board, piece: Piece, p: Placement): boolean {
  const s = explore(b, piece).get(spotKey(p.r, p.x, p.y));
  if (!s || b.fits(piece, p.r, p.x, p.y - 1)) return false;
  if (p.spin > 0) return (s.kicks & (1 << (p.spin - 1))) !== 0;
  return true;
}
