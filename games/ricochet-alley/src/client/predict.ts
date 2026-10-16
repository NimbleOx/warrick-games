import { TICK_MS } from "../shared/constants";
import type { Vec } from "../shared/geom";
import { HEADINGS } from "../shared/headings";
import type { Rect } from "../shared/maze";
import { moveBullet, moveTank, type Bullet } from "../shared/sim";

export interface TankPose {
  x: number;
  y: number;
  h: number;
  tt: number;
}

/** The point a fraction `f` of the way along a polyline [x0, y0, x1, y1, …]. */
export function pointAlong(pts: number[], f: number): Vec {
  if (pts.length <= 2 || f <= 0) return { x: pts[0], y: pts[1] };
  let total = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  let want = Math.min(1, f) * total;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const seg = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    if (want <= seg || i + 4 >= pts.length) {
      const k = seg ? Math.min(1, want / seg) : 0;
      return { x: pts[i] + (pts[i + 2] - pts[i]) * k, y: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * k };
    }
    want -= seg;
  }
  return { x: pts[pts.length - 2], y: pts[pts.length - 1] };
}

/** Heading steps interpolated the short way round, as a fractional step. */
export function lerpHeading(a: number, b: number, f: number): number {
  let d = b - a;
  if (d > HEADINGS / 2) d -= HEADINGS;
  if (d < -HEADINGS / 2) d += HEADINGS;
  return a + d * f;
}

interface FieldBullet {
  b: Bullet;
  /** The tick b's state is for. */
  tick: number;
  /** Path of its last move, for drawing it between ticks. */
  last: number[] | null;
}

/**
 * Bullets as the client sees them. The server only says when one is fired and when one hits a tank; between
 * those, every client flies them with the same shared code, which comes out bit-identical to the server's.
 */
export class BulletField {
  private list: FieldBullet[] = [];

  constructor(private walls: Rect[]) {}

  reset(walls: Rect[], bullets: Bullet[], tick: number): void {
    this.walls = walls;
    this.list = bullets.map((b) => ({ b: { ...b }, tick, last: null }));
  }

  /** A bullet whose state `b` is as of server tick `tick`. */
  add(b: Bullet, tick: number): void {
    if (this.list.some((f) => f.b.id === b.id)) return;
    this.list.push({ b: { ...b }, tick, last: null });
  }

  /** Take a bullet out (it hit a tank). Returns where it was. */
  remove(id: number): Vec | null {
    const i = this.list.findIndex((f) => f.b.id === id);
    if (i < 0) return null;
    const [f] = this.list.splice(i, 1);
    return { x: f.b.x, y: f.b.y };
  }

  /** Fly every bullet forward to `tick`. Reports bounce points (for sparks and sounds) as it goes. */
  advance(tick: number, onBounce?: (x: number, y: number) => void): void {
    for (let i = 0; i < this.list.length;) {
      const f = this.list[i];
      let gone = false;
      // Don't replay more than a few seconds (a tab that was asleep): a bullet that old is gone anyway.
      while (f.tick < tick) {
        const path = moveBullet(f.b, this.walls);
        f.tick++;
        if (!path) {
          gone = true;
          break;
        }
        f.last = path.pts;
        if (onBounce && f.tick >= tick - 1) {
          for (let p = 2; p + 2 < path.pts.length; p += 2) onBounce(path.pts[p], path.pts[p + 1]);
        }
      }
      if (gone) this.list.splice(i, 1);
      else i++;
    }
  }

  /** Where each bullet is at fractional tick `t` (call advance(Math.ceil(t)) first). */
  positions(t: number): (Vec & { o: number })[] {
    return this.list.map((f) => {
      if (!f.last || f.tick <= t) return { x: f.b.x, y: f.b.y, o: f.b.o };
      const p = pointAlong(f.last, 1 - (f.tick - t));
      return { x: p.x, y: p.y, o: f.b.o };
    });
  }

  countOf(o: number): number {
    let n = 0;
    for (const f of this.list) if (f.b.o === o) n++;
    return n;
  }

  get size(): number {
    return this.list.length;
  }

  ids(): number[] {
    return this.list.map((f) => f.b.id);
  }

  get(id: number): Bullet | undefined {
    return this.list.find((f) => f.b.id === id)?.b;
  }
}

/**
 * Works out which server tick it is now, from when frames arrive. It trusts the earliest arrivals (the least
 * delayed) and drifts slowly if the delay grows. Also tracks how late frames run, for the interpolation delay.
 */
export class ServerClock {
  private base = NaN;
  private jitter = 0;

  reset(): void {
    this.base = NaN;
    this.jitter = 0;
  }

  observe(n: number, now: number): void {
    const cand = now - n * TICK_MS;
    if (Number.isNaN(this.base) || cand < this.base) {
      this.base = cand;
    } else {
      const late = (cand - this.base) / TICK_MS;
      this.jitter = Math.max(this.jitter * 0.995, late);
      this.base += (cand - this.base) * 0.02;
    }
  }

  get ready(): boolean {
    return !Number.isNaN(this.base);
  }

  /** Fractional server tick at local time `now`. */
  tick(now: number): number {
    return (now - this.base) / TICK_MS;
  }

  /** How far behind "now" to draw other tanks, in ticks, so there are usually frames on both sides. */
  get delay(): number {
    return Math.min(8, 2 + this.jitter);
  }
}

/** One frame's tank poses: index → [x, y, h] (or null if dead). */
export type Poses = (TankPose | null)[];

/** Recent frames, for drawing other tanks smoothly between server updates. */
export class Timeline {
  private frames: { n: number; poses: Poses }[] = [];

  reset(n: number, poses: Poses): void {
    this.frames = [{ n, poses }];
  }

  push(n: number, poses: Poses): void {
    const last = this.frames[this.frames.length - 1];
    if (last && n <= last.n) return;
    this.frames.push({ n, poses });
    if (this.frames.length > 60) this.frames.shift();
  }

  get latest(): { n: number; poses: Poses } | undefined {
    return this.frames[this.frames.length - 1];
  }

  /** Tank i at fractional tick t. Holds the newest pose rather than guessing past it. */
  sample(i: number, t: number): (Vec & { h: number }) | null {
    const fr = this.frames;
    if (!fr.length) return null;
    let b = fr.length - 1;
    while (b > 0 && fr[b - 1].n >= t) b--;
    const B = fr[b];
    const A = b > 0 ? fr[b - 1] : B;
    const pa = A.poses[i];
    const pb = B.poses[i];
    if (!pb) return null;
    if (!pa || A === B || t >= B.n) return { x: pb.x, y: pb.y, h: pb.h };
    const f = Math.max(0, Math.min(1, (t - A.n) / (B.n - A.n)));
    return { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f, h: lerpHeading(pa.h, pb.h, f) };
  }
}

/**
 * Your own tank, run ahead of the server. Each input change gets a sequence number and the local tick it
 * started on. When the server says "your tank is at S, having applied input `seq` for `age` ticks", that S
 * belongs to local tick first(seq) + age − 1: start from S and replay the inputs used since. If the server
 * has held `seq` longer than we did (the next change is still on its way), S comes just before our next
 * change, and everything from that change on is replayed. Small corrections are blended out over a few
 * frames rather than snapped.
 */
export class Predictor {
  pose: TankPose | null = null;
  /** Pose one local tick earlier, for drawing between ticks. */
  prev: TankPose | null = null;
  /** Local tick that `pose` is for. */
  tick = 0;
  /** Drawn offset from the true predicted position, decaying to zero after a correction. */
  ox = 0;
  oy = 0;
  private bits = 0;
  private firsts = new Map<number, number>();
  private history = new Map<number, number>();

  /** Start predicting from `pose`, with the given latest input already in force. */
  reset(pose: TankPose | null, seq: number, bits: number): void {
    this.pose = pose ? { ...pose } : null;
    this.prev = this.pose ? { ...this.pose } : null;
    this.tick = 0;
    this.bits = bits;
    this.firsts.clear();
    this.history.clear();
    this.firsts.set(seq, 1);
    this.ox = this.oy = 0;
  }

  /** Record input change number `seq`: it takes effect from the next local tick. */
  input(seq: number, bits: number): void {
    this.bits = bits;
    this.firsts.set(seq, this.tick + 1);
  }

  step(walls: Rect[], others: readonly Vec[]): void {
    if (!this.pose) return;
    this.prev = { ...this.pose };
    moveTank(this.pose, this.bits, walls, others);
    this.tick++;
    this.history.set(this.tick, this.bits);
  }

  /** Line up with the server. Returns how far the prediction was off. */
  reconcile(server: TankPose, seq: number, age: number, walls: Rect[], others: readonly Vec[]): number {
    const first = this.firsts.get(seq);
    if (!this.pose || first === undefined) {
      // An input we have no record of (we just reset): take the server's word for where we are now.
      this.snap(server);
      this.firsts.set(seq, this.tick - age + 1);
      return Infinity;
    }
    const nextFirst = this.firsts.get(seq + 1);
    let at = first + age - 1;
    if (nextFirst !== undefined && at >= nextFirst) at = nextFirst - 1;
    let next: TankPose;
    if (at >= this.tick) {
      // The server is level with us or a tick ahead (very low latency, or this tab was asleep): catch up.
      next = { ...server };
      this.tick = at;
      this.history.clear();
    } else {
      next = { ...server };
      for (let k = at + 1; k <= this.tick; k++) moveTank(next, this.history.get(k) ?? this.bits, walls, others);
    }
    const ex = this.pose.x - next.x;
    const ey = this.pose.y - next.y;
    const err = Math.hypot(ex, ey);
    if (err > 40) {
      // Too far off to blend: jump.
      this.ox = this.oy = 0;
      this.prev = { ...next };
    } else {
      // Keep the drawn tank where it was and let the offset decay.
      this.ox += ex;
      this.oy += ey;
      if (this.prev) {
        this.prev.x -= ex;
        this.prev.y -= ey;
      }
    }
    this.pose = next;
    // Forget what can't matter any more.
    for (const k of this.history.keys()) if (k <= at) this.history.delete(k);
    for (const [s, t] of this.firsts) if (s < seq && t < at) this.firsts.delete(s);
    return err;
  }

  /** Decay the visual correction; call once per animation frame. */
  settle(dtMs: number): void {
    const k = Math.exp(-dtMs / 90);
    this.ox *= k;
    this.oy *= k;
    if (Math.abs(this.ox) < 0.01) this.ox = 0;
    if (Math.abs(this.oy) < 0.01) this.oy = 0;
  }

  /** Drawn pose, a fraction `f` of the way from the previous local tick to the current one. */
  draw(f: number): (Vec & { h: number }) | null {
    const p = this.pose;
    if (!p) return null;
    const a = this.prev ?? p;
    return {
      x: a.x + (p.x - a.x) * f + this.ox,
      y: a.y + (p.y - a.y) * f + this.oy,
      h: lerpHeading(a.h, p.h, f),
    };
  }

  private snap(server: TankPose): void {
    this.pose = { ...server };
    this.prev = { ...server };
    this.ox = this.oy = 0;
    this.history.clear();
  }
}
