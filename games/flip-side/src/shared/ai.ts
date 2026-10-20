/**
 * CPU players, and the autopilot that keeps a dropped player's table going. The sim is exact, so
 * they plan by trying: when a ball is about to reach a flipper, a CPU plays copies of its game a
 * second ahead with the flip at different moments, and flips the way that scored best without
 * losing the ball. A hard CPU also catches the ball on a raised flipper and aims from there,
 * plunges for the skill shot, and nudges a ball out of an outlane.
 *
 * Only the room (and the home screen's demo) runs them, so they may use `Math.atan2`.
 */

import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, type Rng } from "@warrick/kit/shared/rng";
import {
  AUTO_TICKS,
  B_FREE,
  B_PLUNGER,
  EV_BANK,
  EV_DRAIN,
  EV_DROP,
  EV_JACKPOT,
  EV_LANES,
  EV_LOCK,
  EV_LOST,
  EV_MULTIBALL,
  EV_ORBIT,
  EV_SAVED,
  EV_SEND,
  EV_SKILL,
  EV_TARGETS,
  IN_NUDGE,
  IN_PLUNGE,
  Play,
  stepPlay,
  type Rules,
} from "./sim";
import { BALL_R, FLIP_REST, FLIP_UP, MID_X, type Table } from "./table";

interface Level {
  /** Ticks it takes to react: it can't flip sooner than this after it sees a ball coming. */
  react: number;
  /** When it flips, around the moment the ball reaches the flipper. */
  offsets: number[];
  /** Ticks either way a flip lands off what it planned. */
  jitter: number;
  /** Share of balls it doesn't flip at all. */
  miss: number;
  /** Catches the ball on a raised flipper and aims from there, trying these waits before the flip. */
  aim: number[];
  nudge: boolean;
  /** Plunges for the skill shot. */
  skill: boolean;
}

const LEVELS: Record<CpuLevel, Level> = {
  easy: { react: 9, offsets: [-8, 0], jitter: 4, miss: 0.1, aim: [], nudge: false, skill: false },
  normal: { react: 2, offsets: [-8, -5, -2, 0, 3], jitter: 1, miss: 0.02, aim: [6, 14, 24], nudge: false, skill: false },
  hard: { react: 0, offsets: [-9, -6, -4, -2, 0, 2], jitter: 0, miss: 0, aim: [4, 9, 14, 20, 27], nudge: true, skill: true },
};

/** How long the plunger is held to drop the ball into each top lane (test/ai.test.ts checks them). */
export const SKILL_PULLS = [61, 50, 41];

/** What a plan is worth, beyond its points, for what it makes happen. */
const WORTH: Record<number, number> = {
  [EV_JACKPOT]: 40000,
  [EV_MULTIBALL]: 30000,
  [EV_LOCK]: 15000,
  [EV_BANK]: 8000,
  [EV_DROP]: 1500,
  [EV_ORBIT]: 2500,
  [EV_LANES]: 4000,
  [EV_SEND]: 6000,
  [EV_TARGETS]: 3000,
  [EV_SKILL]: 3000,
  [EV_SAVED]: -15000,
  [EV_LOST]: -60000,
  [EV_DRAIN]: -100000,
};

/** How far ahead it plays each plan, after the ball reaches the flipper. */
const AFTER = 90;
/** How far ahead it looks for a ball reaching a flipper. */
const LOOK = 60;
/** A flip holds the flipper up this long. */
const HOLD = 22;

export class Pilot {
  private readonly rng: Rng;
  private readonly lv: Level;
  /** The input bits for the flippers, tick by tick, from now. */
  private plan: number[] = [];
  private at = 0;
  /** Ticks before it looks again. */
  private wait = 0;
  /** The plunger: ticks to wait, then ticks to hold. */
  private plunge: { wait: number; hold: number } | null = null;
  private nudged = -1e9;
  /** How long it's held a ball on a raised flipper. */
  private held = 0;
  private readonly sim = new Play();

  constructor(
    readonly level: CpuLevel,
    seed: number,
  ) {
    this.rng = mulberry32(seed);
    this.lv = LEVELS[level];
  }

  /** The input bits for this tick. */
  decide(p: Play, table: Table, rules: Rules): number {
    if (p.over) return 0;
    let bits: number;
    if (this.at < this.plan.length) bits = this.plan[this.at++];
    else {
      this.plan = [];
      this.at = 0;
      if (--this.wait <= 0) this.think(p, table, rules);
      bits = this.at < this.plan.length ? this.plan[this.at++] : 0;
    }
    return bits | this.plunger(p) | this.nudge(p);
  }

  private think(p: Play, table: Table, rules: Rules): void {
    this.wait = 4;
    if (!p.balls.some((b) => b.st === B_FREE)) {
      this.wait = 8;
      return;
    }
    const lv = this.lv;
    // A ball sitting on a raised flipper: aim from there.
    const cradled = this.cradled(p, table);
    if (cradled >= 0 && lv.aim.length && this.held < 3 * 120) {
      const f = cradled;
      const plans: number[][] = [repeat(1 << f, 30)];
      for (const r of lv.aim) plans.push([...repeat(0, r), ...repeat(1 << f, HOLD)]);
      const best = this.best(p, table, rules, plans, 140);
      this.plan = best;
      this.held = best === plans[0] ? this.held + 30 : 0;
      return;
    }
    this.held = 0;
    const hit = this.arrival(p, table, rules);
    if (!hit) {
      this.wait = 6;
      return;
    }
    const { tick, f } = hit;
    const bit = 1 << f;
    if (this.rng() < lv.miss) {
      this.wait = tick + 20;
      return;
    }
    const plans: number[][] = [[]];
    for (const o of lv.offsets) {
      const at = Math.max(lv.react, tick + o);
      plans.push([...repeat(0, at), ...repeat(bit, HOLD)]);
    }
    // Catch it: hold the flipper up as it comes, to aim once it's still.
    if (lv.aim.length) plans.push([...repeat(0, Math.max(lv.react, tick - 8)), ...repeat(bit, 50)]);
    let plan = this.best(p, table, rules, plans, tick + AFTER);
    if (lv.jitter && plan.length) {
      const shift = randInt(this.rng, -lv.jitter, lv.jitter);
      const start = plan.indexOf(bit);
      if (start >= 0) plan = [...repeat(0, Math.max(lv.react, start + shift)), ...plan.slice(start)];
    }
    this.plan = plan;
    if (!plan.length) this.wait = Math.min(tick, 12);
  }

  /** The plan that plays out best, of these, over `ticks`. */
  private best(p: Play, table: Table, rules: Rules, plans: number[][], ticks: number): number[] {
    let best = plans[0];
    let bestValue = -Infinity;
    for (const plan of plans) {
      const v = this.value(p, table, rules, plan, ticks);
      if (v > bestValue) {
        bestValue = v;
        best = plan;
      }
    }
    return best;
  }

  private value(p: Play, table: Table, rules: Rules, plan: number[], ticks: number): number {
    const sim = this.sim.copyFrom(p);
    const start = sim.score;
    let v = 0;
    for (let k = 0; k < ticks && !sim.over; k++) {
      stepPlay(sim, plan[k] ?? 0, table, rules);
      for (const e of sim.events) v += WORTH[e.k] ?? 0;
    }
    v += sim.score - start;
    // Where it leaves the balls: high up is good, low and falling is trouble.
    for (const b of sim.balls) {
      if (b.st !== B_FREE) continue;
      v += (900 - b.y) * 3;
      if (b.y > 700 && b.vy > 0) v -= 3000;
    }
    return v;
  }

  /** When a ball first comes within a flipper's reach if nobody flips, and which flipper. */
  private arrival(p: Play, table: Table, rules: Rules): { tick: number; f: number } | null {
    const sim = this.sim.copyFrom(p);
    for (let k = 0; k < LOOK; k++) {
      for (const b of sim.balls) {
        if (b.st !== B_FREE || b.y < 760) continue;
        for (let f = 0; f < 2; f++) if (inReach(b.x, b.y, table, f)) return { tick: k, f };
      }
      stepPlay(sim, 0, table, rules);
      if (sim.over) return null;
    }
    return null;
  }

  /** The flipper a ball is sitting still on, raised, or -1. */
  private cradled(p: Play, table: Table): number {
    for (let f = 0; f < 2; f++) {
      if (p.flip[f] > FLIP_UP + 0.02) continue;
      for (const b of p.balls) {
        if (b.st !== B_FREE || b.vx * b.vx + b.vy * b.vy > 80 * 80) continue;
        if (inReach(b.x, b.y, table, f)) return f;
      }
    }
    return -1;
  }

  private plunger(p: Play): number {
    const ball = p.balls.find((b) => b.st === B_PLUNGER);
    // No ball waiting, or one that's about to go by itself (saved, or multiball).
    if (!ball || ball.t > AUTO_TICKS / 2) {
      this.plunge = null;
      return 0;
    }
    if (!this.plunge) {
      const lv = this.lv;
      const hold =
        lv.skill && p.skill >= 0
          ? SKILL_PULLS[p.skill]
          : this.level === "normal"
            ? randInt(this.rng, 35, 75)
            : randInt(this.rng, 15, 110);
      this.plunge = { wait: randInt(this.rng, 25, 70), hold };
    }
    if (this.plunge.wait > 0) {
      this.plunge.wait--;
      return 0;
    }
    if (this.plunge.hold > 0) {
      this.plunge.hold--;
      return IN_PLUNGE;
    }
    return 0;
  }

  private nudge(p: Play): number {
    if (!this.lv.nudge || p.danger > 0 || p.tick - this.nudged < 120) return 0;
    for (const b of p.balls) {
      if (b.st !== B_FREE || b.vy <= 0 || b.y < 680 || b.y > 770) continue;
      if (b.x < 58 || b.x > MID_X * 2 - 58) {
        this.nudged = p.tick;
        return IN_NUDGE;
      }
    }
    return 0;
  }
}

function repeat(bits: number, n: number): number[] {
  return new Array<number>(Math.max(0, n)).fill(bits);
}

/** Whether a ball at (x, y) is where flipper `f` swings through. */
function inReach(x: number, y: number, table: Table, f: number): boolean {
  const spec = table.flippers[f];
  const dx = (x - spec.px) * spec.side;
  const dy = y - spec.py;
  const d2 = dx * dx + dy * dy;
  const reach = spec.len + BALL_R + 8;
  if (d2 > reach * reach || d2 < 12 * 12) return false;
  const a = Math.atan2(dy, dx);
  return a > FLIP_UP - 0.5 && a < FLIP_REST + 0.25;
}
