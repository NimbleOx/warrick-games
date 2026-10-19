import { BULLET_R, TANK_R, TICK_MS } from "../shared/constants";
import type { Vec } from "../shared/geom";
import { headingRad } from "../shared/headings";
import { EV_FIRE, EV_HIT, type Frame, type RoundSetup } from "../shared/protocol";
import { POS_SCALE, wallsFor, type Bullet, type Walls, type WorldSnapshot } from "../shared/sim";
import { BulletField, Predictor, ServerClock, Timeline, type Poses, type TankPose } from "./predict";
import type { DrawBullet, DrawTank } from "./render";

export interface RoundHooks {
  tankInfo(i: number): { name: string; color: string };
  fired(b: Bullet, mine: boolean): void;
  hit(owner: number, victim: number, x: number, y: number): void;
  bounced(x: number, y: number): void;
}

/** How far past the newest frame bullets may be flown on their own (the server may have paused). */
const MAX_AHEAD = 3;

/**
 * One round as this client sees it, built from the server's round snapshot and then its frames:
 * other tanks drawn a little in the past between frames, bullets flown locally from their fire events,
 * and your own tank predicted ahead and reconciled with each frame.
 */
export class NetRound {
  readonly walls: Walls;
  readonly field: BulletField;
  readonly timeline = new Timeline();
  readonly clock = new ServerClock();
  readonly predictor = new Predictor();
  /** Your tank's index, or −1 if you're watching. */
  readonly me: number;
  readonly alive: boolean[];
  private stepAt = -1;
  private lastNow = 0;
  private others: Vec[] = [];
  private startTick: number;

  constructor(
    readonly setup: RoundSetup,
    world: WorldSnapshot,
    myId: string,
    seq: number,
    bits: number,
    private hooks: RoundHooks,
  ) {
    this.walls = wallsFor(setup.maze);
    this.field = new BulletField(this.walls.bullet);
    this.field.reset(this.walls.bullet, world.bullets, world.tick);
    this.me = setup.tanks.indexOf(myId);
    const poses: Poses = world.tanks.map((t) => (t.alive ? { x: t.x, y: t.y, h: t.h, tt: t.tt } : null));
    this.timeline.reset(world.tick, poses);
    this.alive = world.tanks.map((t) => t.alive);
    this.startTick = world.tick;
    this.predictor.reset(this.me >= 0 ? poses[this.me] : null, seq, bits);
  }

  get myAlive(): boolean {
    return this.me >= 0 && this.alive[this.me];
  }

  get aliveCount(): number {
    return this.alive.filter(Boolean).length;
  }

  input(seq: number, bits: number): void {
    this.predictor.input(seq, bits);
  }

  frame(f: Frame, now: number): void {
    this.clock.observe(f.n, now);
    const poses: Poses = f.k.map((k) => (k === 0 ? null : { x: k[0] / POS_SCALE, y: k[1] / POS_SCALE, h: k[2], tt: k[3] }));
    this.timeline.push(f.n, poses);
    for (const e of f.e ?? []) {
      if (e[0] === EV_FIRE) {
        const b: Bullet = { id: e[1], o: e[2], x: e[3], y: e[4], vx: e[5], vy: e[6], age: 0 };
        this.field.add(b, f.n);
        this.hooks.fired(b, b.o === this.me);
      } else if (e[0] === EV_HIT) {
        this.field.remove(e[1]);
        this.hooks.hit(e[2], e[3], e[4], e[5]);
      }
    }
    poses.forEach((p, i) => {
      if (!p) this.alive[i] = false;
    });
    if (this.me >= 0) {
      const k = f.k[this.me];
      if (k === 0) {
        this.predictor.pose = null;
      } else if (k.length >= 6) {
        this.predictor.reconcile(poses[this.me] as TankPose, k[4], k[5], this.walls.tank, this.others);
      }
    }
  }

  /**
   * Run your tank's prediction up to `now`. Only while the round is live (frozen in countdown/round over).
   * `beforeStep` runs before each tick, so input that depends on the tank's heading (the touch stick) is
   * decided tick by tick, as the server will apply it.
   */
  update(now: number, live: boolean, beforeStep?: () => void): void {
    const dt = this.lastNow ? now - this.lastNow : 0;
    this.lastNow = now;
    this.predictor.settle(dt);
    if (!live) {
      this.stepAt = -1;
      return;
    }
    // Just went live, or the tab was asleep: start the local clock afresh (the next frame catches us up).
    if (this.stepAt < 0 || now - this.stepAt > TICK_MS * 8) this.stepAt = now - TICK_MS;
    let steps = 0;
    while (now - this.stepAt >= TICK_MS && steps++ < 8) {
      this.stepAt += TICK_MS;
      beforeStep?.();
      this.predictor.step(this.walls.tank, this.others);
    }
  }

  /** The newest frame's tick, or the snapshot's before any arrive. */
  get latestTick(): number {
    return this.timeline.latest?.n ?? this.startTick;
  }

  /** Server tick to draw bullets at: the present as best we know it, not too far past the last frame. */
  presentTick(now: number): number {
    const latest = this.latestTick;
    if (!this.clock.ready) return latest;
    return Math.min(latest + MAX_AHEAD, Math.max(this.startTick, this.clock.tick(now)));
  }

  draw(now: number): { tanks: DrawTank[]; bullets: DrawBullet[] } {
    const t = this.presentTick(now);
    const tOthers = Math.min(this.latestTick, t - this.clock.delay);
    const tanks: DrawTank[] = [];
    const others: Vec[] = [];
    for (let i = 0; i < this.setup.tanks.length; i++) {
      let pose: (Vec & { h: number }) | null;
      if (i === this.me) {
        const f = this.stepAt < 0 ? 1 : Math.min(1, (now - this.stepAt) / TICK_MS);
        pose = this.alive[i] ? this.predictor.draw(f) : null;
      } else {
        pose = this.alive[i] ? this.timeline.sample(i, tOthers) : null;
        if (pose) others.push({ x: pose.x, y: pose.y });
      }
      if (!pose) continue;
      const info = this.hooks.tankInfo(i);
      tanks.push({ id: this.setup.tanks[i], x: pose.x, y: pose.y, a: headingRad(pose.h), ...info, me: i === this.me });
    }
    this.others = others;

    this.field.advance(Math.ceil(t), this.hooks.bounced);
    // A bullet on top of a tank is a hit the server hasn't told us about yet: don't draw it sailing through.
    const reach = TANK_R + BULLET_R;
    const bullets = this.field
      .positions(t)
      .filter(
        (b) =>
          !tanks.some(
            (k) => Math.abs(k.x - b.x) < reach && Math.abs(k.y - b.y) < reach && Math.hypot(k.x - b.x, k.y - b.y) < reach,
          ),
      );
    return { tanks, bullets };
  }

  /** Bullets of yours in flight. */
  myBullets(): number {
    return this.me >= 0 ? this.field.countOf(this.me) : 0;
  }
}
