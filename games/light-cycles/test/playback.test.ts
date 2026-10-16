import { describe, expect, it } from "vitest";
import { mulberry32 } from "@warrick/kit/shared/rng";
import type { Frame } from "../src/shared/arena";
import { Playback } from "../src/client/playback";
import { TickClock } from "../src/client/predict";

/** ms per tick (the classic speed). */
const T = 1000 / 14;
/** ms between animation frames. */
const DRAW = 1000 / 60;

interface RaceOpts {
  /** ms for a frame to arrive, and up to this many ms more (frames still arrive in order). */
  down?: number;
  jitter?: number;
  seed?: number;
  ms?: number;
  /** Frames from this tick on wait for `hiccup.ms` more, and come together. */
  hiccup?: { at: number; ms: number };
  /** No animation frames between these times (a hidden pane). */
  still?: [number, number];
}

interface Draw {
  now: number;
  /** Where playback is, and where the clock has the server (by the frames' quickest path). */
  pos: number;
  clock: number;
  /** The newest frame received. */
  newest: number;
}

/**
 * A server that ticks every T ms from time 0, and a client that hears the round start and
 * each frame `down` ms (plus jitter) later, and draws every DRAW ms.
 */
function race({ down = 75, jitter = 0, seed = 1, ms = 10000, hiccup, still }: RaceOpts = {}) {
  const clock = new TickClock();
  clock.reset(T);
  const pb = new Playback();
  pb.reset(0);
  const rng = mulberry32(seed);
  const arrivals: number[] = [down]; // tick 0: the round starting
  for (let n = 1; n * T < ms; n++) {
    let at = n * T + down + rng() * jitter;
    if (hiccup && n >= hiccup.at) at = Math.max(at, hiccup.at * T + down + hiccup.ms);
    arrivals.push(Math.max(arrivals[n - 1], at));
  }
  const draws: Draw[] = [];
  const shown: number[] = [];
  let heard = 0;
  for (let now = 0; now < ms; now += DRAW) {
    while (heard < arrivals.length && arrivals[heard] <= now) {
      clock.heard(heard, arrivals[heard]);
      if (heard > 0) pb.push(frame(heard));
      heard++;
    }
    if (still && now >= still[0] && now < still[1]) continue;
    for (const f of pb.advance(now, clock)) shown.push(f.n);
    const t = clock.tick(now);
    if (t !== null) draws.push({ now, pos: pb.pos, clock: t, newest: pb.newest });
  }
  return { pb, draws, shown };
}

function frame(n: number): Frame {
  return { n, m: [], d: [], e: [] };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** How fast playback ran between each pair of draws, next to real time. */
function speeds(draws: Draw[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < draws.length; k++) {
    out.push((draws[k].pos - draws[k - 1].pos) / ((draws[k].now - draws[k - 1].now) / T));
  }
  return out;
}

/** The draws from `ms` on, once the clock has settled. */
const after = (draws: Draw[], ms: number) => draws.filter((d) => d.now >= ms);

describe("playback", () => {
  it("runs a little over a tick behind the clock with steady frames", () => {
    const { draws } = race();
    const lag = after(draws, 1000).map((d) => d.clock - d.pos);
    // A frame's cells are known once it's in, so a tick behind the clock is as close as it gets.
    expect(Math.min(...lag)).toBeGreaterThan(1);
    expect(mean(lag)).toBeLessThan(1.25);
    expect(Math.max(...lag)).toBeLessThan(1.3);
    for (const s of speeds(after(draws, 1000))) expect(s).toBeCloseTo(1, 1);
  });

  for (const seed of [1, 2, 3]) {
    it(`moves smoothly with jittery frames, and only as far behind as they need (seed ${seed})`, () => {
      const { draws } = race({ jitter: 40, seed });
      const settled = after(draws, 2000);
      for (const s of speeds(settled)) {
        expect(s).toBeGreaterThan(0.75); // never stops for a frame
        expect(s).toBeLessThan(1.25);
      }
      const lag = settled.map((d) => d.clock - d.pos);
      expect(mean(lag)).toBeLessThan(1 + (40 + 15) / T);
    });
  }

  it("shows every frame once, in order, and never runs past the newest", () => {
    const { draws, shown } = race({ jitter: 60, seed: 4 });
    expect(shown).toEqual(shown.map((_, k) => k + 1));
    for (const d of draws) expect(d.pos).toBeLessThanOrEqual(d.newest);
    for (const s of speeds(draws)) expect(s).toBeGreaterThanOrEqual(0);
  });

  it("waits for late frames, then catches up without jumping", () => {
    const { draws } = race({ hiccup: { at: 50, ms: 300 } });
    const sp = speeds(draws);
    // The heads stood still at the newest frame while the late ones were on their way…
    expect(sp.some((s) => s === 0)).toBe(true);
    // …then ran on a little faster, never more than a cell a draw.
    expect(Math.max(...sp)).toBeLessThan(3.5);
    for (let k = 1; k < draws.length; k++) expect(draws[k].pos - draws[k - 1].pos).toBeLessThan(1);
    // It allows for frames that late a while, then closes in again.
    const end = draws.at(-1)!;
    expect(end.clock - end.pos).toBeLessThan(1.5);
  });

  it("skips ahead after a long time without drawing", () => {
    const { draws } = race({ still: [3000, 6000] });
    const back = draws.find((d) => d.now >= 6000)!;
    expect(back.clock - back.pos).toBeLessThan(1.3);
  });

  it("drains every frame received", () => {
    const pb = new Playback();
    pb.reset(10);
    pb.push(frame(11));
    pb.push(frame(12));
    expect(pb.drain().map((f) => f.n)).toEqual([11, 12]);
    expect([pb.tick, pb.pos, pb.alpha]).toEqual([12, 12, 1]);
  });
});

describe("tick clock lateness", () => {
  it("is the latest a frame has come, fading by half every few seconds", () => {
    const c = new TickClock();
    c.reset(100);
    c.heard(1, 150);
    c.tick(150);
    c.heard(2, 290); // 40 ms late
    expect(c.late(290)).toBe(40);
    c.heard(3, 360); // a frame less late doesn't lower it
    expect(c.late(2290)).toBeCloseTo(20, 0);
    c.heard(4, 2900); // a hiccup counts for only so much
    expect(c.late(2900)).toBe(150);
  });
});
