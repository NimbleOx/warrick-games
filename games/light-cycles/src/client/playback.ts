import type { Frame } from "../shared/arena";
import type { TickClock } from "./predict";

/** Playback waits this much longer for each frame (in ms) than frames have come late lately. */
const MARGIN_MS = 12;
/** Behind where it should be, playback closes this share of the gap each tick: a tick behind, it runs half as fast again. */
const CATCH_UP = 0.5;
/** Ahead of where it should be, it slows down, but to no less than this speed. */
const MIN_SPEED = 0.8;
/** Further behind than this, in ticks (the tab was in the background, say), it skips ahead. */
const MAX_BEHIND_TICKS = 30;

/**
 * Plays everyone's frames back smoothly, as close behind the server as the network allows.
 *
 * It runs on the server's schedule as frames show it (the `TickClock`). Between ticks `n - 1`
 * and `n`, the heads move from their cells after tick `n - 1` into frame `n`'s, so frame `n` is
 * needed from tick `n - 1` on: playback runs a tick behind the clock. Frames come unevenly, so
 * it runs further behind by as long as frames have come late lately (`TickClock.late`), and the
 * frame it needs next is usually in by the time it's needed. Nothing is guessed: it never runs
 * past the newest frame, so when one is later than that, the heads wait for it, then catch up.
 */
export class Playback {
  /** Frames received but not shown yet, oldest first. */
  frames: Frame[] = [];
  /** Where playback is, in ticks with fractions. Between `n - 1` and `n`, the heads are on their way into frame `n`'s cells. */
  pos = 0;
  /** The newest frame handed out to be shown (or the tick playback started from). */
  tick = 0;
  private last: number | null = null;

  /** Start over from tick `tick` (a new round, or the one you've just joined). */
  reset(tick: number): void {
    this.frames = [];
    this.pos = tick;
    this.tick = tick;
  }

  push(f: Frame): void {
    this.frames.push(f);
  }

  /** The newest frame received. */
  get newest(): number {
    return this.frames.at(-1)?.n ?? this.tick;
  }

  /** How far the heads are into the cells of the newest frame shown: 0 just leaving the cells before it, 1 there. */
  get alpha(): number {
    return Math.min(1, Math.max(0, this.pos - (this.tick - 1)));
  }

  /** Where playback should be at `now`, or null before the clock has heard from the server. */
  target(clock: TickClock, now: number): number | null {
    const t = clock.tick(now);
    if (t === null) return null;
    return t - 1 - (clock.late(now) + MARGIN_MS) / clock.tickMs;
  }

  /** Moves playback on to `now`, and returns the frames it has reached, to show in order. */
  advance(now: number, clock: TickClock): Frame[] {
    const dt = this.last === null ? 0 : Math.max(0, now - this.last);
    this.last = now;
    const target = this.target(clock, now);
    if (target !== null) {
      const ticks = dt / clock.tickMs;
      const free = this.pos + ticks;
      const behind = target - free;
      let pos: number;
      if (behind > MAX_BEHIND_TICKS) pos = target;
      else if (behind > 0) pos = free + behind * Math.min(1, CATCH_UP * ticks);
      else pos = Math.max(target, free - (1 - MIN_SPEED) * ticks);
      this.pos = Math.max(this.pos, Math.min(this.newest, pos));
    }
    return this.take((f) => f.n - 1 < this.pos);
  }

  /** Every frame received, to show now. */
  drain(): Frame[] {
    const out = this.take(() => true);
    this.pos = this.tick;
    return out;
  }

  private take(due: (f: Frame) => boolean): Frame[] {
    let k = 0;
    while (k < this.frames.length && due(this.frames[k])) k++;
    const out = this.frames.splice(0, k);
    if (out.length) this.tick = out[out.length - 1].n;
    return out;
  }
}
