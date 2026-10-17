/**
 * The course on this screen: your own bike (stepped here, see `LocalRider`), everyone else's
 * ghosts from the room's frames, and your best run on the course riding beside you.
 */

import { Bike } from "../shared/bike";
import { courseId, generateCourse, type GeneratedCourse } from "../shared/course";
import { LocalRider } from "../shared/local";
import { encodeRider, type RaceSnapshot, type RiderFrame } from "../shared/protocol";
import { Ride, rideFromNumbers, type RideInput } from "../shared/ride";
import { BestGhost, Ghost, bestRun } from "./ghosts";

/** What happened to your bike on a tick, for sounds and banners. */
export type MyEvent =
  | { k: "crash" }
  | { k: "checkpoint"; cp: number; tick: number }
  | { k: "finish"; tick: number }
  | { k: "land"; hard: number }
  | { k: "respawn" };

export class ClientRace {
  readonly course: GeneratedCourse;
  readonly run: number;
  readonly riders: string[];
  /** Your bike, if you're riding this course. */
  readonly mine: LocalRider | null;
  readonly ghosts = new Map<string, Ghost>();
  /** Your best run on this course, if this browser has one. */
  readonly best: BestGhost | null;
  /** Each rider's tick at each checkpoint, as frames show it (for splits against the leader). */
  readonly cpTicks = new Map<string, number[]>();
  /** The newest frame's course tick. */
  frameTick = 0;

  constructor(snap: RaceSnapshot, me: string, previous: ClientRace | null) {
    const same = previous?.run === snap.run;
    this.course = previous && previous.course.id === courseId(snap.spec) ? previous.course : generateCourse(snap.spec);
    this.run = snap.run;
    this.riders = snap.riders;
    const i = snap.riders.indexOf(me);
    if (i < 0) this.mine = null;
    else if (same && previous.mine) {
      // The same run going on (after a pause or a reconnect): take the room's bike, keep our log.
      this.mine = previous.mine;
      this.mine.adopt(snap.rides[i], snap.inputs[i]);
    } else {
      this.mine = new LocalRider(this.course, snap.run, { ride: snap.rides[i], input: snap.inputs[i] });
    }
    snap.riders.forEach((id, k) => {
      if (id === me) return;
      const ghost = (same && previous.ghosts.get(id)) || new Ghost(id);
      // Where the room has them now, until frames come.
      if (!same) ghost.push(encodeRider(id, rideFromNumbers(snap.rides[k]), 0, 0, -1, 0));
      this.ghosts.set(id, ghost);
      this.cpTicks.set(id, (same && previous.cpTicks.get(id)) || [0]);
    });
    const run = bestRun(this.course.id);
    this.best = same && previous.best ? previous.best : run ? new BestGhost(this.course, run) : null;
  }

  /** A frame from the room: other riders' ghosts, and a check on our own bike (false: it's off). */
  frame(k: number, rows: RiderFrame[], me: string): boolean {
    this.frameTick = k;
    let ok = true;
    for (const r of rows) {
      const id = r[0];
      if (id === me) {
        if (this.mine && r[15] >= 0 && !this.mine.check(r[15], r[16])) ok = false;
        continue;
      }
      const ghost = this.ghosts.get(id);
      if (!ghost) continue;
      ghost.push(r);
      const cps = this.cpTicks.get(id)!;
      if (cps[r[13]] === undefined && r[13] > 0) cps[r[13]] = r[14];
    }
    return ok;
  }

  /**
   * Steps your bike to `target`, reading `controls` for each tick, and says what happened
   * (crashes, checkpoints, the finish, hard landings).
   */
  advance(target: number, read: (into: RideInput) => void, on: (e: MyEvent) => void): void {
    const mine = this.mine;
    if (!mine) return;
    mine.advance(target, read, (ride) => {
      const prev = mine.prev;
      if (ride.bike.crashed && !prev.bike.crashed) on({ k: "crash" });
      if (!ride.bike.crashed && prev.bike.crashed) on({ k: "respawn" });
      if (ride.checkpoint > prev.checkpoint) on({ k: "checkpoint", cp: ride.checkpoint, tick: ride.tick });
      if (ride.finishTick >= 0 && prev.finishTick < 0) on({ k: "finish", tick: ride.finishTick });
      // A wheel stopped falling all at once: a landing.
      if (!ride.bike.crashed) {
        const dv = Math.max(ride.bike.rear.vy - prev.bike.rear.vy, ride.bike.front.vy - prev.bike.front.vy);
        if (dv > 2.5) on({ k: "land", hard: Math.min(1, (dv - 2.5) / 6) });
      }
    });
  }

  /** The tick the first rider (you included) reached checkpoint `cp`, and who. */
  leaderAt(cp: number, me: string, mine: number | null): { id: string; tick: number } | null {
    let best: { id: string; tick: number } | null = mine === null ? null : { id: me, tick: mine };
    for (const [id, cps] of this.cpTicks) {
      const t = cps[cp];
      if (t !== undefined && (!best || t < best.tick)) best = { id, tick: t };
    }
    return best;
  }
}

/**
 * A ride's pose a tick behind clock time `ft` (in ticks), between its last two ticks, so it moves
 * smoothly whatever the screen's frame rate.
 */
export function poseBetween(out: Bike, prev: Ride, ride: Ride, ft: number): Bike {
  const a = Math.max(0, Math.min(1, ft - ride.tick));
  const p = prev.bike;
  const b = ride.bike;
  out.copyFrom(b);
  if (prev.tick !== ride.tick - 1 || a >= 1) return out;
  const l = (x: number, y: number) => x + (y - x) * a;
  out.x = l(p.x, b.x);
  out.y = l(p.y, b.y);
  const c = l(p.c, b.c);
  const s = l(p.s, b.s);
  const n = Math.hypot(c, s) || 1;
  out.c = c / n;
  out.s = s / n;
  out.lean = l(p.lean, b.lean);
  for (const [o, q, r] of [
    [out.rear, p.rear, b.rear],
    [out.front, p.front, b.front],
  ] as const) {
    o.x = l(q.x, r.x);
    o.y = l(q.y, r.y);
    let da = r.a - q.a;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    o.a = q.a + da * a;
  }
  return out;
}
