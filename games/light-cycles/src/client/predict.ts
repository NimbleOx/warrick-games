import {
  Arena,
  MAX_QUEUED_TURNS,
  enterCell,
  opposite,
  shrinksOn,
  type ArenaSnapshot,
  type Cycle,
  type Dir,
  type Frame,
} from "../shared/arena";

/** How many of the newest frames `TickClock` reads the server's schedule from. */
const CLOCK_FRAMES = 30;
/** How fast `TickClock` eases onto a new reading of the schedule: 5% faster or slower than real time. */
const CLOCK_EASE = 0.05;
/** Off by more than this (in ms), and it jumps straight there. */
const CLOCK_JUMP_MS = 250;
/** Your cycle runs at most this many ticks past the newest frame. */
const MAX_LEAD_TICKS = 10;
/** How many ticks after it was due a turn can still show up before it counts as turned down. */
const GRACE_TICKS = 10;
/** Extra lead, in ms, so a turn reaches the server before its tick even when the network is a little slow. */
const MIN_SLACK_MS = 20;
const MAX_SLACK_MS = 120;
/** Each turn that shows up late adds this much slack; each one on time takes 1 ms back. */
const SLACK_STEP_MS = 15;

/**
 * Where the server is in the round, from when its frames arrive. The server ticks on a fixed
 * schedule, so the frame that came quickest for its tick shows that schedule (as seen down the
 * network's quickest path); the others only waited longer on the way. When a quicker frame
 * comes, or the quickest grows old, the clock eases onto the new reading rather than jump, so
 * your cycle doesn't either.
 */
export class TickClock {
  tickMs = 1000;
  /** For each recent frame: when it arrived, less when its tick was due on the schedule. */
  private gaps: number[] = [];
  /** The gap the clock goes by, easing towards the smallest of `gaps`. */
  private gap: number | null = null;
  private eased = 0;

  reset(tickMs: number): void {
    this.tickMs = tickMs;
    this.gaps = [];
    this.gap = null;
  }

  /** Frame `n` arrived at `now`. */
  heard(n: number, now: number): void {
    this.gaps.push(now - n * this.tickMs);
    if (this.gaps.length > CLOCK_FRAMES) this.gaps.shift();
  }

  /** The server's tick at `now`, as it looks from here (with fractions), or null before the first frame. */
  tick(now: number): number | null {
    if (!this.gaps.length) return null;
    const target = Math.min(...this.gaps);
    if (this.gap === null || Math.abs(target - this.gap) > CLOCK_JUMP_MS) {
      this.gap = target;
    } else if (now > this.eased) {
      const most = (now - this.eased) * CLOCK_EASE;
      this.gap += Math.max(-most, Math.min(most, target - this.gap));
    }
    this.eased = Math.max(this.eased, now);
    return (now - this.gap) / this.tickMs;
  }
}

interface Sent {
  dir: Dir;
  /** The tick it was sent for. */
  at: number;
}

/** Your cycle as the server will have it when a turn you make now gets there. */
export interface Predicted {
  /** Its index in the arena. */
  i: number;
  /** Your cycle, ridden on from the newest frame with the turns and boost on their way. */
  cycle: Cycle;
  /** Where to draw its head, in cell-center coordinates. */
  head: [number, number];
}

/**
 * Steers your cycle on your screen as soon as you press, without waiting for the server.
 *
 * Everyone else is drawn from frames, which show the past. Your cycle is drawn where the server
 * will have it when a turn you make now arrives: the newest frame, ridden on by the time since
 * it, the round trip and a little slack. So a turn you press is sent for the tick your screen
 * shows it on (the cell your head is heading into), and the server holds it until then
 * (`Arena.queueTurn`): it lands on the cell you saw. The frames still decide: each one restarts
 * the prediction from the server's word, so a turn that got there late, or a crash, corrects it.
 */
export class Predictor {
  /** The round as of the newest frame. Playback shows it a little later; your cycle runs on from it. */
  arena: Arena | null = null;
  readonly clock = new TickClock();
  /** Turns you've sent that the newest frame doesn't show yet, in order. */
  private sent: Sent[] = [];
  /** The tick a boost you've sent is for, until a frame shows it. */
  private boostAt: number | null = null;
  private slack = MIN_SLACK_MS;
  /** The tick your last turn was made on. */
  private made = 0;
  /** Your cell before the newest frame, to glide from. */
  private from: [number, number] | null = null;

  /** A new round, or the one you've just joined. */
  reset(snap: ArenaSnapshot | null, tickMs: number): void {
    this.arena = snap ? new Arena(snap) : null;
    this.clock.reset(tickMs);
    this.sent = [];
    this.boostAt = null;
    this.made = 0;
    this.from = null;
  }

  /**
   * The round has just started ticking. The server sends that as it starts its tick loop, so it
   * sets the clock going before the first frame comes.
   */
  started(now: number): void {
    if (this.arena) this.clock.heard(this.arena.tick, now);
  }

  /** The turn on its way that you'll make next, if any (the countdown shows it on your heading). */
  get next(): Dir | null {
    return this.sent[0]?.dir ?? null;
  }

  /** A frame has arrived from the server. Returns false for one this round has already had. */
  frame(f: Frame, me: string, now: number): boolean {
    const a = this.arena;
    if (!a || f.n <= a.tick) return false;
    this.clock.heard(f.n, now);
    const i = a.index(me);
    const c = a.cycles[i];
    if (!c?.alive) {
      a.apply(f);
      return true;
    }
    const before = c.dir;
    this.from = [c.x, c.y];
    a.apply(f);
    if (!c.alive) {
      this.sent = [];
      this.boostAt = null;
      return true;
    }
    if (c.dir !== before) {
      // The server only turns you when you ask, in the order you asked. A turn we weren't
      // expecting means we've lost track, so start over.
      const k = this.sent.findIndex((t) => t.dir === c.dir);
      if (k >= 0) this.timed(f.n > Math.max(this.sent[k].at, this.made + 1));
      this.sent.splice(0, k < 0 ? this.sent.length : k + 1);
      this.made = f.n;
    }
    // Long overdue: the server turned it down, so the ones after it won't line up either.
    if (this.sent.length && f.n > this.sent[0].at + GRACE_TICKS) this.sent = [];
    if (this.boostAt !== null && (f.e.some((e) => e.k === "boost" && e.i === i) || f.n > this.boostAt + GRACE_TICKS)) {
      this.boostAt = null;
    }
    return true;
  }

  /**
   * The tick your cycle is drawn at, with fractions: between `n` and `n + 1` it's heading from the
   * cell it had after tick `n` into the next one. A turn you press now is made on the way out of
   * that next cell.
   */
  shownTick(now: number, rtt: number | null): number {
    const a = this.arena!;
    const t = this.clock.tick(now);
    if (t === null) return a.tick;
    const lead = ((rtt ?? 0) + this.slack) / this.clock.tickMs;
    return Math.min(a.tick + MAX_LEAD_TICKS - 1, Math.max(a.tick - 1, t + lead - 1));
  }

  /**
   * The tick to send a turn (or boost) for if you press it now: the one that leaves the cell your
   * head is heading into. Before the first frame (in the countdown), the round's first tick.
   */
  private aim(now: number, rtt: number | null): number {
    const a = this.arena!;
    if (this.clock.tick(now) === null) return a.tick + 1;
    return Math.max(a.tick + 1, Math.floor(this.shownTick(now, rtt)) + 2);
  }

  /** The tick to send turn `dir` for, or null for a turn the server would ignore (straight on, a U-turn, too many). */
  aimTurn(me: string, dir: Dir, now: number, rtt: number | null): number | null {
    const c = this.arena?.cycles[this.arena.index(me)];
    if (!c?.alive) return null;
    const last = this.sent.at(-1);
    const planned = last?.dir ?? c.dir;
    if (dir === planned || dir === opposite(planned) || this.sent.length >= MAX_QUEUED_TURNS) return null;
    return Math.max(this.aim(now, rtt), (last?.at ?? 0) + 1);
  }

  /** You've sent turn `dir` for tick `at`. */
  sentTurn(dir: Dir, at: number): void {
    this.sent.push({ dir, at });
  }

  /** The tick to send a boost for, or null when one is already on its way or you've none left. */
  aimBoost(me: string, now: number, rtt: number | null): number | null {
    const c = this.arena?.cycles[this.arena.index(me)];
    if (!c?.alive || c.boosts <= 0 || this.boostAt !== null) return null;
    return this.aim(now, rtt);
  }

  sentBoost(at: number): void {
    this.boostAt = at;
  }

  /**
   * Your cycle as of `shownTick`: the newest frame's, ridden on with the same rules as
   * `Arena.step`. It stops at a wall rather than crash (only a frame can say you crashed), and it
   * doesn't know where the others have gone since the newest frame.
   */
  predict(me: string, now: number, rtt: number | null): Predicted | null {
    const a = this.arena;
    const i = a?.index(me) ?? -1;
    if (!a || i < 0) return null;
    const c0 = a.cycles[i];
    const last = c0.trail[c0.trail.length - 1];
    // Only the last line of the wall grows, so the rest can be shared.
    const c: Cycle = { ...c0, alive: true, trail: [...c0.trail.slice(0, -1), [...last]] };
    let cur: [number, number] = [c.x, c.y];
    // It sits still before the first frame (in the countdown). A crashed one waits where it hit
    // until playback reaches the crash.
    if (!c0.alive || this.clock.tick(now) === null) return { i, cycle: c, head: [cur[0] + 0.5, cur[1] + 0.5] };

    const shown = this.shownTick(now, rtt);
    const until = Math.floor(shown) + 1;
    let prev: [number, number] = this.from ?? cur;
    const { cfg, grid } = a;
    let shrink = a.shrink;
    let turn = 0;
    let boostAt = this.boostAt;
    const entered = new Set<number>();
    for (let n = a.tick + 1; n <= until; n++) {
      prev = cur;
      if (shrinksOn(cfg, n, shrink)) shrink++;
      if (!a.inside(c.x, c.y, shrink)) break; // caught by the closing wall
      const t = this.sent[turn];
      if (t && t.at <= n) {
        turn++;
        if (t.dir !== opposite(c.dir)) c.dir = t.dir;
      }
      if (boostAt !== null && boostAt <= n) {
        if (c.boosts > 0 && c.boost === 0) {
          c.boost = cfg.boostTicks;
          c.boosts--;
        }
        boostAt = null;
      }
      let blocked = false;
      for (let sub = c.boost > 0 ? 2 : 1; sub > 0; sub--) {
        const [x, y] = a.next(c.x, c.y, c.dir);
        const k = y * cfg.w + x;
        if (!a.inside(x, y, shrink) || grid[k] || entered.has(k)) {
          blocked = true;
          break;
        }
        enterCell(c, x, y);
        entered.add(k);
      }
      if (c.boost > 0) c.boost--;
      cur = [c.x, c.y];
      if (blocked && n < until) prev = cur; // stopped at the wall before the tick it's drawn at
      if (blocked) break;
    }
    const f = Math.min(1, Math.max(0, shown - (until - 1)));
    const wrapped = Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) > 2;
    const head: [number, number] = wrapped
      ? [cur[0] + 0.5, cur[1] + 0.5]
      : [prev[0] + (cur[0] - prev[0]) * f + 0.5, prev[1] + (cur[1] - prev[1]) * f + 0.5];
    return { i, cycle: c, head };
  }

  /** A turn of yours has shown up: on its tick, or late (it reached the server after its tick). */
  private timed(late: boolean): void {
    this.slack = late ? Math.min(MAX_SLACK_MS, this.slack + SLACK_STEP_MS) : Math.max(MIN_SLACK_MS, this.slack - 1);
  }
}
