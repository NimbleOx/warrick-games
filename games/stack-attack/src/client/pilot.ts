import { LOCK_DELAY_MS, MAX_LOCK_RESETS, SPAWN_X, SPAWN_Y } from "../shared/constants";
import { turn, type Lane, type LockResult, type Placement } from "../shared/engine";
import type { Piece } from "../shared/pieces";
import { gravityMs } from "../shared/protocol";

export type Action = "left" | "right" | "soft" | "hard" | "cw" | "ccw" | "hold";

/** How the keys feel, in milliseconds: auto-shift delay and repeat rate, and soft drop as a multiple of gravity. */
export interface Handling {
  das: number;
  arr: number;
  /** 0 means soft drop goes straight to the floor. */
  sdf: number;
}

export interface Active {
  p: Piece;
  r: number;
  x: number;
  y: number;
}

export interface PilotHooks {
  /** A piece locked. `k` is how many pieces came before it. */
  locked(pl: Placement, res: LockResult, k: number): void;
  /** For sounds: something moved. */
  moved(kind: "shift" | "turn" | "hold" | "land" | "fail"): void;
}

/**
 * The player's own piece, run in the browser with no waiting for the server: shifting with
 * auto-repeat, turning with wall kicks, gravity, soft and hard drop, hold, and lock delay.
 * Pieces lock into `lane`, the same model the server replays them into.
 */
export class Pilot {
  active: Active | null = null;
  /** Hold was used on this piece. */
  held = false;
  /** 0 if the last move wasn't a turn; otherwise 1 + the wall kick it used. */
  spin = 0;
  /** The newest garbage id this browser has seen for us. */
  known = 0;
  /** Gravity and input are on (the round is running and we're in it). */
  running = false;

  private grounded = false;
  private lockAt = 0;
  private resets = 0;
  private lowest = Infinity;
  private fall = 0;
  private dir: -1 | 0 | 1 = 0;
  private dirSince = 0;
  private repeats = 0;
  private down = { left: false, right: false, soft: false };

  constructor(
    public lane: Lane,
    private handling: () => Handling,
    private hooks: PilotHooks,
  ) {}

  /** The piece that will sit in the hold box once this one locks. */
  get holdShown(): number {
    return this.held ? this.lane.current : this.lane.hold;
  }

  /** The upcoming pieces, after the one in play. */
  preview(count: number): Piece[] {
    // Holding with an empty slot brought the next piece forward.
    const from = this.lane.n + (this.held && !this.lane.hold ? 2 : 1);
    return Array.from({ length: count }, (_, i) => this.lane.bag.at(from + i));
  }

  /** Where the piece in play would land. */
  ghostY(): number {
    const a = this.active;
    return a ? this.lane.board.drop(a.p, a.r, a.x, a.y) : 0;
  }

  /** Start over from the server's copy of the board. */
  reset(lane: Lane, now: number): void {
    this.lane = lane;
    this.active = null;
    if (this.running && !lane.out) this.spawn(now);
  }

  start(now: number): void {
    this.running = true;
    if (!this.active && !this.lane.out) this.spawn(now);
  }

  stop(): void {
    this.running = false;
    this.releaseAll();
  }

  releaseAll(): void {
    this.down = { left: false, right: false, soft: false };
    this.dir = 0;
  }

  press(a: Action, now: number): void {
    if (a === "left" || a === "right") {
      this.down[a] = true;
      this.dir = a === "left" ? -1 : 1;
      this.dirSince = now;
      this.repeats = 0;
      if (this.active) this.shift(this.dir, now);
      return;
    }
    if (a === "soft") {
      this.down.soft = true;
      return;
    }
    const piece = this.active;
    if (!piece || !this.running) return;
    if (a === "hard") {
      const y = this.ghostY();
      if (y < piece.y) this.spin = 0;
      piece.y = y;
      this.lock(now);
    } else if (a === "cw" || a === "ccw") {
      const t = turn(this.lane.board, piece.p, piece.r, piece.x, piece.y, a === "cw" ? 1 : 3);
      if (!t) return this.hooks.moved("fail");
      piece.r = t.r;
      piece.x = t.x;
      piece.y = t.y;
      this.spin = t.kick + 1;
      this.afterMove(now);
      this.hooks.moved("turn");
    } else if (a === "hold") {
      if (this.held) return this.hooks.moved("fail");
      const p = this.lane.swapped;
      if (!this.lane.board.fits(p, 0, SPAWN_X, SPAWN_Y)) return this.hooks.moved("fail");
      this.held = true;
      this.place(p, now);
      this.hooks.moved("hold");
    }
  }

  release(a: Action, now: number): void {
    if (a === "left" || a === "right") {
      this.down[a] = false;
      const other = a === "left" ? "right" : "left";
      if (this.dir === (a === "left" ? -1 : 1)) {
        // Still holding the other way: it takes over and charges its own auto-shift.
        this.dir = this.down[other] ? (other === "left" ? -1 : 1) : 0;
        this.dirSince = now;
        this.repeats = 0;
      }
    } else if (a === "soft") {
      this.down.soft = false;
    }
  }

  /** Run gravity, auto-shift and lock delay up to `now`. */
  update(now: number, dt: number, level: number): void {
    const piece = this.active;
    if (!this.running || !piece) return;
    const h = this.handling();

    if (this.dir) {
      const t = now - this.dirSince - h.das;
      if (t >= 0) {
        if (h.arr <= 0) {
          while (this.shift(this.dir, now));
        } else {
          const due = Math.floor(t / h.arr) + 1;
          while (this.repeats < due) {
            this.repeats++;
            if (!this.shift(this.dir, now)) {
              this.repeats = due;
              break;
            }
          }
        }
      }
    }
    if (this.active !== piece) return;

    let rate = gravityMs(level);
    if (this.down.soft) rate = h.sdf > 0 ? Math.min(rate, Math.max(rate / h.sdf, 1)) : 0;
    if (rate === 0) {
      while (this.stepDown());
    } else {
      this.fall += dt;
      while (this.fall >= rate) {
        if (!this.stepDown()) {
          this.fall = 0;
          break;
        }
        this.fall -= rate;
      }
    }

    const grounded = !this.lane.board.fits(piece.p, piece.r, piece.x, piece.y - 1);
    if (grounded && !this.grounded) {
      this.lockAt = now + (this.resets >= MAX_LOCK_RESETS ? 0 : LOCK_DELAY_MS);
      this.hooks.moved("land");
    }
    this.grounded = grounded;
    if (grounded && now >= this.lockAt) this.lock(now);
  }

  // ---------------------------------------------------------------- internals

  private spawn(now: number): void {
    this.held = false;
    this.place(this.lane.current, now);
  }

  private place(p: Piece, now: number): void {
    this.active = { p, r: 0, x: SPAWN_X, y: SPAWN_Y };
    // Pieces appear above the field and drop one row straight away, if they can.
    if (this.lane.board.fits(p, 0, SPAWN_X, SPAWN_Y - 1)) this.active.y--;
    this.spin = 0;
    this.grounded = false;
    this.resets = 0;
    this.lowest = this.active.y;
    this.fall = 0;
    // A charged auto-shift carries over to the new piece.
    if (this.dir && now - this.dirSince >= this.handling().das) this.repeats = 0;
  }

  private shift(dir: -1 | 1, now: number): boolean {
    const a = this.active;
    if (!a || !this.running || !this.lane.board.fits(a.p, a.r, a.x + dir, a.y)) return false;
    a.x += dir;
    this.spin = 0;
    this.afterMove(now);
    this.hooks.moved("shift");
    return true;
  }

  private stepDown(): boolean {
    const a = this.active!;
    if (!this.lane.board.fits(a.p, a.r, a.x, a.y - 1)) return false;
    a.y--;
    this.spin = 0;
    if (a.y < this.lowest) {
      this.lowest = a.y;
      this.resets = 0;
    }
    this.grounded = false;
    return true;
  }

  /** A shift or turn while grounded restarts the lock delay, a limited number of times. */
  private afterMove(now: number): void {
    const a = this.active!;
    if (a.y < this.lowest) {
      this.lowest = a.y;
      this.resets = 0;
    }
    if (this.grounded) {
      if (this.resets < MAX_LOCK_RESETS) {
        this.resets++;
        this.lockAt = now + LOCK_DELAY_MS;
      }
      this.grounded = !this.lane.board.fits(a.p, a.r, a.x, a.y - 1);
      if (!this.grounded) this.fall = 0;
    }
  }

  private lock(now: number): void {
    const a = this.active!;
    const pl: Placement = { piece: a.p, r: a.r, x: a.x, y: a.y, hold: this.held, spin: this.spin };
    const k = this.lane.pc;
    const res = this.lane.lock(pl, this.known);
    this.active = null;
    if (!res) return; // can't happen with a legal piece; the server will set us straight
    this.hooks.locked(pl, res, k);
    if (!this.lane.out && this.running) this.spawn(now);
  }
}
