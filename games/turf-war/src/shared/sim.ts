import { Board, reverse, type BoardSnap, type DeathCause, type Dir, type Frame, type Op } from "./board";
import { claimRuns } from "./claim";
import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { randInt, shuffle, type Rng } from "@warrick/kit/shared/rng";
import { CHECKSUM_EVERY, COUNTDOWN_TICKS, RESPAWN_TICKS } from "./constants";

export interface RoundOpts {
  w: number;
  h: number;
  /** Board slots taking part from the start. */
  slots: number[];
  /** Ticks of play after the countdown. */
  ticks: number;
  countdown?: number;
  /** Start from this board (with `slots`' heads already on it) instead of fresh homes. For tests. */
  board?: Board;
}

/** Everything a client needs to pick up a round in the middle. */
export interface Snapshot extends BoardSnap {
  n: number;
  /** Heads start moving on the tick after this one. */
  go: number;
  /** The round is over once tick `end` has run. */
  end: number;
  kills: number[];
  deaths: number[];
}

/** At most this many turns wait for a head, so a quick double tap can U-turn. */
const MAX_QUEUE = 2;

/**
 * One round of Turf War, stepped one tick at a time. The server runs it and
 * sends each tick's Frame; clients apply the frames' ops to their own Board.
 * Ticks 1…go are the frozen countdown, ticks go+1…end are play.
 */
export class Round {
  readonly board: Board;
  /** Ticks run so far. */
  n = 0;
  readonly go: number;
  readonly end: number;
  /** Slots that are in this round (alive, dead or waiting to spawn). */
  readonly inRound: boolean[] = Array(MAX_PLAYERS).fill(false);
  /** Where each live head will go next, after queued turns. */
  readonly heading: Dir[] = Array(MAX_PLAYERS).fill(1);
  readonly kills: number[] = Array(MAX_PLAYERS).fill(0);
  readonly deaths: number[] = Array(MAX_PLAYERS).fill(0);
  /** Most land each slot held at any point in the round. */
  readonly best: number[] = Array(MAX_PLAYERS).fill(0);

  private queues: Dir[][] = Array.from({ length: MAX_PLAYERS }, () => []);
  private leaving: number[] = [];
  private ops: Op[] = [];

  constructor(
    private rng: Rng,
    opts: RoundOpts,
  ) {
    this.go = opts.countdown ?? COUNTDOWN_TICKS;
    this.end = this.go + opts.ticks;
    if (opts.board) {
      this.board = opts.board;
      for (const s of opts.slots) {
        this.inRound[s] = true;
        this.heading[s] = this.board.heads[s].dir;
      }
    } else {
      this.board = new Board(opts.w, opts.h);
      this.placeStarts(opts.slots);
    }
  }

  get over(): boolean {
    return this.n >= this.end;
  }

  get playing(): boolean {
    return this.n >= this.go && !this.over;
  }

  /** Queue a turn for a slot's head. */
  turn(slot: number, d: Dir): void {
    const q = this.queues[slot];
    if (!q) return;
    if (q.length >= MAX_QUEUE) q[q.length - 1] = d;
    else q.push(d);
  }

  /** Replace whatever a slot had queued (CPUs decide afresh every tick). */
  steer(slot: number, d: Dir): void {
    this.queues[slot] = [d];
  }

  /** Bring a slot into the round; it spawns on the next tick. */
  join(slot: number): void {
    if (this.inRound[slot]) return;
    this.inRound[slot] = true;
    this.board.heads[slot].respawnAt = this.n + 1;
  }

  /** Nobody is using this slot and nothing of its last owner is left on the board. */
  slotFree(slot: number): boolean {
    const b = this.board;
    return (
      !this.inRound[slot] &&
      !this.leaving.includes(slot) &&
      !b.heads[slot].alive &&
      b.land[slot] === 0 &&
      b.trails[slot].length === 0
    );
  }

  /** Take a slot out of the round. Its head dies and its land clears on the next tick. */
  leave(slot: number): void {
    if (!this.inRound[slot]) return;
    this.inRound[slot] = false;
    this.leaving.push(slot);
  }

  step(): Frame {
    this.n++;
    this.ops = [];
    const b = this.board;

    for (const slot of this.leaving) {
      const h = b.heads[slot];
      if (h.alive || h.respawnAt >= 0 || b.land[slot] || b.trails[slot].length) this.die(slot, -1, "left", -1);
    }
    this.leaving = [];

    if (this.n > this.go && this.n <= this.end) this.moveAll();

    for (let s = 0; s < MAX_PLAYERS; s++) {
      const h = b.heads[s];
      if (this.inRound[s] && !h.alive && h.respawnAt >= 0 && this.n >= h.respawnAt) this.spawn(s);
    }
    for (let s = 0; s < MAX_PLAYERS; s++) this.best[s] = Math.max(this.best[s], b.land[s]);

    const frame: Frame = { t: "f", n: this.n, o: this.ops };
    if (this.n % CHECKSUM_EVERY === 0) frame.ck = b.checksum();
    return frame;
  }

  snapshot(): Snapshot {
    return {
      ...this.board.snapshot(),
      n: this.n,
      go: this.go,
      end: this.end,
      kills: [...this.kills],
      deaths: [...this.deaths],
    };
  }

  // ---------------------------------------------------------------- one tick of movement

  private moveAll(): void {
    const b = this.board;
    const live: number[] = [];
    for (let s = 0; s < MAX_PLAYERS; s++) if (b.heads[s].alive) live.push(s);

    // 1. Turns.
    for (const s of live) {
      const h = b.heads[s];
      const q = this.queues[s];
      while (q.length) {
        const d = q.shift()!;
        if (d === this.heading[s] || (!h.fresh && d === reverse(h.dir))) continue;
        this.heading[s] = d;
        break;
      }
    }

    // 2. Where each head is going. Everything below is judged against the
    // board as it stood at the start of the tick, so slot order doesn't matter.
    const next = new Map<number, number>();
    const dead = new Map<number, { by: number; why: DeathCause }>();
    for (const s of live) {
      const c = b.neighbor(b.heads[s].cell, this.heading[s]);
      if (c < 0) dead.set(s, { by: -1, why: "wall" });
      else next.set(s, c);
    }

    // 3a. Head-on: two heads into one cell, or swapping cells.
    for (const [s, cs] of next) {
      for (const [t, ct] of next) {
        if (t <= s) continue;
        if (cs === ct || (cs === b.heads[t].cell && ct === b.heads[s].cell)) {
          if (!dead.has(s)) dead.set(s, { by: t, why: "headon" });
          if (!dead.has(t)) dead.set(t, { by: s, why: "headon" });
        }
      }
    }

    // 3b. Trails. All the crossings are found first, so two players who cross
    // each other's trails on the same tick both go.
    const hits: [number, number][] = [];
    for (const [s, c] of next) {
      if (dead.has(s) || !b.trail[c]) continue;
      hits.push([s, b.trail[c] - 1]);
    }
    for (const [s, victim] of hits) {
      if (victim === s) {
        if (!dead.has(s)) dead.set(s, { by: -1, why: "self" });
      } else if (!dead.has(victim)) {
        dead.set(victim, { by: s, why: "trail" });
      }
    }

    // 4. Deaths. A killer who survives takes the victim's trail as land.
    for (const s of [...dead.keys()].sort((x, y) => x - y)) {
      const { by, why } = dead.get(s)!;
      const takes = why === "trail" && !dead.has(by);
      this.die(s, by, why, takes ? by : -1);
    }
    this.squeeze(-1);

    // 5. Survivors move, laying trail off their own land.
    const move: Op = ["m"];
    let moved = false;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const c = b.heads[s].alive ? (next.get(s) ?? -1) : -1;
      move.push(c);
      if (c >= 0) moved = true;
    }
    while (move.length > 1 && move[move.length - 1] === -1) move.pop();
    if (moved) this.emit(move);

    // 6. Claims: a head back on its own land with trail out takes what it closed.
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const h = b.heads[s];
      if (!h.alive || b.owner[h.cell] !== s + 1 || !b.trails[s].length) continue;
      this.emit(["c", s, ...claimRuns(b, s)]);
      this.squeeze(s);
    }
  }

  /** Anyone left with no land at all is out. */
  private squeeze(by: number): void {
    const b = this.board;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (b.heads[s].alive && b.land[s] === 0) this.die(s, by, "squeeze", -1);
    }
  }

  private die(slot: number, by: number, why: DeathCause, to: number): void {
    const respawnAt = this.inRound[slot] ? this.n + RESPAWN_TICKS : -1;
    this.emit(["d", slot, by, to, why, respawnAt]);
    this.queues[slot] = [];
  }

  private emit(op: Op): void {
    this.board.apply(op);
    tally(op, this.kills, this.deaths);
    this.ops.push(op);
  }

  // ---------------------------------------------------------------- spawning

  private spawn(slot: number): void {
    const cell = this.spawnSpot(slot);
    const dir = this.facingCenter(cell);
    this.heading[slot] = dir;
    this.queues[slot] = [];
    this.emit(["s", slot, cell, dir]);
  }

  /** Starting homes on a ring around the middle of the board, in random order. */
  private placeStarts(slots: number[]): void {
    const { w, h } = this.board;
    const order = shuffle(this.rng, [...slots]);
    const turn = this.rng() * Math.PI * 2;
    order.forEach((slot, i) => {
      this.inRound[slot] = true;
      const a = turn + (i / order.length) * Math.PI * 2;
      const x = Math.round(w / 2 + Math.cos(a) * w * 0.32 + randInt(this.rng, -2, 2));
      const y = Math.round(h / 2 + Math.sin(a) * h * 0.32 + randInt(this.rng, -2, 2));
      const cell = this.board.idx(Math.min(w - 4, Math.max(3, x)), Math.min(h - 4, Math.max(3, y)));
      const dir = this.facingCenter(cell);
      this.heading[slot] = dir;
      this.board.apply(["s", slot, cell, dir]);
    });
  }

  /**
   * A home spot for a respawn or a late joiner: somewhere with clear ground
   * around it, as far from other heads as can be found.
   */
  private spawnSpot(slot: number): number {
    const b = this.board;
    const others = b.heads.filter((h, s) => s !== slot && h.alive).map((h) => h.cell);
    const distance = (c: number) => {
      let d = Infinity;
      for (const o of others) {
        d = Math.min(d, Math.abs((o % b.w) - (c % b.w)) + Math.abs(Math.floor(o / b.w) - Math.floor(c / b.w)));
      }
      return d;
    };
    // Strictest first: a clear 5 × 5, then a clear 3 × 3, then no trail under a 3 × 3.
    const tests: [number, (c: number) => boolean][] = [
      [2, (c) => b.owner[c] === 0 && b.trail[c] === 0],
      [1, (c) => b.owner[c] === 0 && b.trail[c] === 0],
      [1, (c) => b.trail[c] === 0],
    ];
    for (const [r, ok] of tests) {
      let best = -1;
      let bestScore = -1;
      for (let tries = 0, found = 0; tries < 400 && found < 40; tries++) {
        const x = randInt(this.rng, 2, b.w - 3);
        const y = randInt(this.rng, 2, b.h - 3);
        if (!this.areaOk(x, y, r, ok)) continue;
        found++;
        const score = distance(b.idx(x, y));
        if (score > bestScore) {
          bestScore = score;
          best = b.idx(x, y);
        }
      }
      if (best >= 0) return best;
    }
    return b.idx(randInt(this.rng, 2, b.w - 3), randInt(this.rng, 2, b.h - 3));
  }

  private areaOk(cx: number, cy: number, r: number, ok: (c: number) => boolean): boolean {
    const b = this.board;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= b.w || y >= b.h || !ok(b.idx(x, y))) return false;
      }
    }
    return true;
  }

  private facingCenter(cell: number): Dir {
    const { w, h } = this.board;
    const dx = w / 2 - (cell % w);
    const dy = h / 2 - Math.floor(cell / w);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3;
    return dy >= 0 ? 2 : 0;
  }
}

/** Count kills and deaths from a death op. Cutting a trail or squeezing someone out is a kill. */
export function tally(op: Op, kills: number[], deaths: number[]): void {
  if (op[0] !== "d") return;
  const [, slot, by, , why] = op;
  if (why !== "left") deaths[slot]++;
  if ((why === "trail" || why === "squeeze") && by >= 0 && by !== slot) kills[by]++;
}

/** A client's copy of the round, kept up to date from the server's frames. */
export interface RoundView {
  board: Board;
  n: number;
  go: number;
  end: number;
  kills: number[];
  deaths: number[];
}

export function viewFromSnapshot(s: Snapshot): RoundView | null {
  const board = Board.fromSnapshot(s);
  if (!board) return null;
  return { board, n: s.n, go: s.go, end: s.end, kills: [...s.kills], deaths: [...s.deaths] };
}

/**
 * Apply one frame. Returns false, leaving the view alone, if the frame isn't
 * the next tick; the client should then ask for a fresh snapshot.
 */
export function applyFrame(v: RoundView, f: Frame): boolean {
  if (f.n !== v.n + 1) return false;
  for (const op of f.o) {
    v.board.apply(op);
    tally(op, v.kills, v.deaths);
  }
  v.n = f.n;
  return true;
}
