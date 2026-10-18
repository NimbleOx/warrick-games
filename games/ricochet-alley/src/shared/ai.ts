import { BULLET_LIFE, BULLET_SPEED, CELL, MAX_BULLETS, MUZZLE, TANK_R, TURN_RAMP } from "./constants";
import { castPath, segmentHitsCircle } from "./geom";
import { COS, HEADINGS, SIN, headingDiff, headingTo, wrapHeading } from "./headings";
import { bfs, cellAt, cellCenter } from "./maze";
import type { Rng } from "@warrick/kit/shared/rng";
import { IN_DOWN, IN_LEFT, IN_RIGHT, IN_UP, type World } from "./sim";

export type CpuLevel = "easy" | "normal" | "hard";

interface Level {
  /** Wall bounces it will plan a shot around. */
  bounces: number;
  /** Chance per tick of pulling the trigger once a shot lines up (reaction time). */
  trigger: number;
  /** How far off (in heading steps) its sense of its own aim can be, so it sometimes fires and misses. */
  jitter: number;
  /** Heading steps either side of its own it searches for a bank shot; 0 = only shoots where it's facing. */
  scan: number;
  /** Ticks between route decisions. */
  thinkEvery: number;
  /** Whether it backs away from bullets about to hit it. */
  dodge: boolean;
}

const LEVELS: Record<CpuLevel, Level> = {
  easy: { bounces: 0, trigger: 0.08, jitter: 14, scan: 0, thinkEvery: 10, dodge: false },
  normal: { bounces: 1, trigger: 0.3, jitter: 6, scan: 24, thinkEvery: 4, dodge: false },
  hard: { bounces: 2, trigger: 0.9, jitter: 0, scan: 70, thinkEvery: 2, dodge: true },
};

export interface CpuMove {
  bits: number;
  fire: boolean;
}

/**
 * The tank that a shot fired now along heading `h` would hit first, if every tank stood still: an index into
 * world.tanks (possibly the shooter's own), or −1 if it hits nobody within `bounces` bounces.
 */
export function traceShot(w: World, i: number, h: number, bounces: number): number {
  const me = w.tanks[i];
  const vx = BULLET_SPEED * COS[h];
  const vy = BULLET_SPEED * SIN[h];
  const walls = w.walls.bullet;
  const muzzle = castPath(walls, me.x, me.y, vx, vy, MUZZLE / BULLET_SPEED);
  const path = castPath(walls, muzzle.x, muzzle.y, muzzle.vx, muzzle.vy, BULLET_LIFE, bounces);
  return w.firstTankOnPath(path.pts)?.t ?? -1;
}

/** Held-turn counts the turn planner tells apart: −RAMP … RAMP, since the ramp tops out after RAMP ticks. */
const RAMP = TURN_RAMP.length;
const HELD = 2 * RAMP + 1;
let turnKeys: Int8Array | null = null;

/**
 * The turn key to press this tick (−1 left, 0 neither, +1 right) to face exactly `diff` heading steps clockwise
 * of where a tank faces now, in the fewest ticks, given its held-turn count `tt`. Holding a key speeds up
 * (TURN_RAMP) and even a tap turns 4 steps, so "turn until within a step or two" can't settle on a heading: it
 * overshoots a narrow bank shot, re-aims from where it ended up, and can swing back and forth forever.
 */
export function turnKey(diff: number, tt: number): number {
  turnKeys ??= planTurns();
  return turnKeys[wrapHeading(diff) * HELD + Math.max(-RAMP, Math.min(RAMP, tt)) + RAMP];
}

/**
 * The best key for every (steps still to turn, ticks held) pair. Starts from "facing it" and relaxes
 * "1 + ticks from where this key leads" until nothing improves. Turns the way moveTank does.
 */
function planTurns(): Int8Array {
  const n = HEADINGS * HELD;
  const after = (s: number, key: number): number => {
    const left = Math.floor(s / HELD);
    if (key === 0) return left * HELD + RAMP;
    const tt = (s % HELD) - RAMP;
    const held = Math.sign(tt) === key ? Math.max(-RAMP, Math.min(RAMP, tt + key)) : key;
    return wrapHeading(left - key * TURN_RAMP[Math.abs(held) - 1]) * HELD + held + RAMP;
  };
  const ticks = new Uint16Array(n).fill(0xffff);
  ticks.fill(0, 0, HELD);
  const keys = new Int8Array(n);
  for (let changed = true; changed; ) {
    changed = false;
    for (let s = HELD; s < n; s++) {
      for (let key = -1; key <= 1; key++) {
        const t = ticks[after(s, key)] + 1;
        if (t < ticks[s]) {
          ticks[s] = t;
          keys[s] = key;
          changed = true;
        }
      }
    }
  }
  return keys;
}

/**
 * A CPU player. It produces the same input bits a human does: route toward the nearest enemy over the maze
 * grid (BFS), turn to face any shot that lines up, and fire when a ray with a few bounces would hit someone.
 */
export class CpuBrain {
  private wait = 0;
  private goal: { x: number; y: number } | null = null;
  /** Heading of a shot it's lining up, if any; it stands still while turning to it. */
  private aim: number | null = null;
  private stuckTicks = 0;
  private backing = 0;
  private backTurn = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly spec: Level;

  constructor(
    readonly level: CpuLevel,
    private rng: Rng,
  ) {
    this.spec = LEVELS[level];
  }

  think(w: World, i: number): CpuMove {
    const me = w.tanks[i];
    if (!me?.alive) return { bits: 0, fire: false };
    const spec = this.spec;
    const canFire = me.cd === 0 && w.bulletsOf(i) < MAX_BULLETS;

    let fire = false;
    if (canFire) {
      const off = spec.jitter ? Math.round((this.rng() * 2 - 1) * spec.jitter) : 0;
      const target = traceShot(w, i, wrapHeading(me.h + off), spec.bounces);
      if (target >= 0 && target !== i && this.rng() < spec.trigger) fire = true;
    }

    if (spec.dodge) {
      const threat = this.incoming(w, i);
      if (threat) return { bits: threat, fire };
    }

    if (this.backing > 0) {
      this.backing--;
      return { bits: IN_DOWN | this.backTurn, fire };
    }

    if (--this.wait <= 0) {
      this.wait = spec.thinkEvery;
      this.plan(w, i, canFire);
    }

    // Stuck on a wall end? Back off for a moment with a random twist.
    const moved = Math.abs(me.x - this.lastX) + Math.abs(me.y - this.lastY);
    this.lastX = me.x;
    this.lastY = me.y;

    if (this.aim !== null) {
      // Lining up a shot: stand still and turn onto it exactly.
      this.stuckTicks = 0;
      const key = turnKey(headingDiff(me.h, this.aim), me.tt);
      return { bits: key > 0 ? IN_RIGHT : key < 0 ? IN_LEFT : 0, fire };
    }
    if (!this.goal) return { bits: 0, fire };

    const diff = headingDiff(me.h, headingTo(this.goal.x - me.x, this.goal.y - me.y));
    let bits = 0;
    if (diff > 2) bits |= IN_RIGHT;
    else if (diff < -2) bits |= IN_LEFT;
    if (Math.abs(diff) < 80) bits |= IN_UP;

    if (bits & IN_UP && moved < 0.5) {
      if (++this.stuckTicks > 12) {
        this.stuckTicks = 0;
        this.backing = 8 + Math.floor(this.rng() * 8);
        this.backTurn = this.rng() < 0.5 ? IN_LEFT : IN_RIGHT;
      }
    } else {
      this.stuckTicks = 0;
    }
    return { bits, fire };
  }

  /** Pick where to go and whether there's a shot worth turning for. */
  private plan(w: World, i: number, canFire: boolean): void {
    const me = w.tanks[i];
    const m = w.maze;

    // Stay with the shot it's turning onto while that still hits someone. Picking afresh each time from
    // wherever the turn has got to can flip between two shots, or a shot and the route, for good.
    if (canFire && this.aim !== null) {
      const t = traceShot(w, i, this.aim, this.spec.bounces);
      if (t >= 0 && t !== i) return;
    }
    this.aim = null;

    // A shot worth lining up: scan headings near the current one, closest first.
    if (canFire) {
      const { scan, bounces } = this.spec;
      for (let d = 0; d <= scan; d += 4) {
        for (const h of d ? [me.h + d, me.h - d] : [me.h]) {
          const hh = wrapHeading(h);
          const t = traceShot(w, i, hh, bounces);
          if (t >= 0 && t !== i) {
            this.aim = hh;
            return;
          }
        }
      }
    }

    // Otherwise head for the nearest enemy by path length.
    const from = cellAt(m, me.x, me.y);
    const { dist, prev } = bfs(m, from);
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < w.tanks.length; j++) {
      const o = w.tanks[j];
      if (j === i || !o.alive) continue;
      const d = dist[cellAt(m, o.x, o.y)];
      const score = d < 0 ? Infinity : d * CELL + Math.hypot(o.x - me.x, o.y - me.y) * 0.01;
      if (score < bestD) {
        bestD = score;
        best = j;
      }
    }
    if (best < 0) {
      this.goal = null;
      return;
    }
    const enemy = w.tanks[best];
    const to = cellAt(m, enemy.x, enemy.y);

    if (to === from) {
      // Same cell: face them directly (a straight shot will line up as we turn).
      this.aim = headingTo(enemy.x - me.x, enemy.y - me.y);
      this.goal = null;
      return;
    }
    // Walk the BFS tree back from the enemy to find the first step.
    let next = to;
    while (prev[next] !== from && prev[next] >= 0) next = prev[next];
    const here = cellCenter(m, from);
    const there = cellCenter(m, next);
    // Line up with the doorway before going through it, so we don't snag the wall ends.
    const offAxis = there.x !== here.x ? Math.abs(me.y - here.y) : Math.abs(me.x - here.x);
    this.goal = offAxis > 14 ? here : there;
  }

  /** Bits that step out of the way of a bullet about to hit us, or 0 if none is. */
  private incoming(w: World, i: number): number {
    const me = w.tanks[i];
    for (const b of w.bullets) {
      if (Math.abs(b.x - me.x) > 160 || Math.abs(b.y - me.y) > 160) continue;
      const p = castPath(w.walls.bullet, b.x, b.y, b.vx, b.vy, 10);
      for (let k = 0; k + 3 < p.pts.length; k += 2) {
        const [ax, ay, bx, by] = [p.pts[k], p.pts[k + 1], p.pts[k + 2], p.pts[k + 3]];
        if (segmentHitsCircle(ax, ay, bx, by, me.x, me.y, TANK_R + 8) < 0) continue;
        // Move along our own axis, away from where the bullet will cross it.
        const ahead = (ax - me.x) * COS[me.h] + (ay - me.y) * SIN[me.h];
        return ahead > 0 ? IN_DOWN : IN_UP;
      }
    }
    return 0;
  }
}
