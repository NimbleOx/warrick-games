import { describe, expect, it } from "vitest";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { Arena, type ArenaConfig, type Dir, type Frame } from "../src/shared/arena";
import { Predictor, TickClock } from "../src/client/predict";

/** ms per tick. */
const T = 100;
const CFG: ArenaConfig = { w: 40, h: 40, walls: "solid", boosts: 2, boostTicks: 3, suddenDeathAt: 0, shrinkEvery: 1 };

interface NetOpts {
  /** ms for a message to reach the server, and for a frame to come back. */
  up?: number;
  down?: number;
  /** The round trip the client has timed (by default, the real one). */
  rtt?: number;
  /** Up to this many ms more for each frame (they still arrive in order). */
  jitter?: number;
  start?: { x: number; y: number; dir: Dir };
}

/**
 * A server arena that ticks every T ms from time 0, and a client predicting its own cycle from
 * the frames, which take `down` ms to arrive, as does the news the round has started. The
 * client's turns take `up` ms to reach the server. Time moves a millisecond at a time, and the
 * client draws every millisecond.
 */
function net({ up = 30, down = 30, rtt = up + down, jitter = 0, start = { x: 5, y: 20, dir: 1 } }: NetOpts = {}) {
  const server = Arena.create(CFG, [{ id: "me", ...start }]);
  const p = new Predictor();
  p.reset(server.snapshot(), T);
  const rng = mulberry32(11);
  const toClient: { at: number; f: Frame }[] = [];
  const toServer: { at: number; send: () => void }[] = [];
  /** The ticks the server turned and boosted you on. */
  const turned: number[] = [];
  const boosted: number[] = [];
  /** Where the client drew your head, every ms from the first frame on. */
  const heads: [number, number][] = [];
  let now = 0;

  const t = {
    server,
    p,
    turned,
    boosted,
    heads,
    get now() {
      return now;
    },
    run(ms: number) {
      for (const end = now + ms; now < end;) {
        now++;
        while (toServer.length && toServer[0].at <= now) toServer.shift()!.send();
        if (now === down) p.started(now);
        if (now % T === 0 && server.cycles[0].alive) {
          const before = server.cycles[0].dir;
          const f = server.step();
          if (server.cycles[0].dir !== before) turned.push(f.n);
          if (f.e.some((e) => e.k === "boost")) boosted.push(f.n);
          const at = Math.max(toClient.at(-1)?.at ?? 0, now + down + Math.floor(rng() * jitter));
          toClient.push({ at, f });
        }
        while (toClient.length && toClient[0].at <= now) p.frame(toClient.shift()!.f, "me", now);
        if (p.clock.tick(now) !== null) heads.push(t.drawn().head);
      }
    },
    drawn() {
      return p.predict("me", now, rtt)!;
    },
    turn(dir: Dir): number | null {
      const at = p.aimTurn("me", dir, now, rtt);
      if (at === null) return null;
      p.sentTurn(dir, at);
      toServer.push({ at: now + up, send: () => server.queueTurn(0, dir, at) });
      return at;
    },
    boost(): number | null {
      const at = p.aimBoost("me", now, rtt);
      if (at === null) return null;
      p.sentBoost(at);
      toServer.push({ at: now + up, send: () => server.requestBoost(0, at) });
      return at;
    },
  };
  return t;
}

/** The furthest the head moved between two draws a millisecond apart, in cells. */
function maxJump(heads: [number, number][]): number {
  let max = 0;
  for (let k = 1; k < heads.length; k++) {
    max = Math.max(max, Math.abs(heads[k][0] - heads[k - 1][0]) + Math.abs(heads[k][1] - heads[k - 1][1]));
  }
  return max;
}

describe("tick clock", () => {
  it("reads the server's schedule from the frame that came quickest", () => {
    const c = new TickClock();
    expect(c.tick(0)).toBe(null);
    c.reset(100);
    c.heard(1, 180); // 80 ms on the way
    c.heard(2, 230); // 30 ms
    c.heard(3, 370); // 70 ms
    expect(c.tick(380)).toBeCloseTo(3.5);
  });
});

describe("prediction", () => {
  for (const [up, down] of [
    [5, 5],
    [40, 60],
    [120, 80],
  ]) {
    it(`turns on the cell your head is heading into (${up} ms up, ${down} ms down)`, () => {
      const t = net({ up, down, jitter: 30 });
      t.run(1037);
      const before = t.drawn();
      const into = [before.cycle.x, before.cycle.y];
      expect(before.head[0]).toBeLessThan(into[0] + 0.5);
      expect(before.head[0]).toBeGreaterThan(into[0] - 0.5);
      const at = t.turn(0);
      const pressed = t.heads.length;
      t.run(1000);
      // The server made the turn on the tick it was sent for, leaving that very cell.
      expect(t.turned).toEqual([at]);
      expect(t.server.cycles[0].trail).toEqual([[5, 20, into[0], 20, into[0], t.server.cycles[0].y]]);
      // Your head was already heading up a tick after you pressed, and it never jumped.
      expect(t.heads[pressed + T][1]).toBeLessThan(20.5);
      expect(maxJump(t.heads.slice(1))).toBeLessThan(0.05);
    });
  }

  it("makes a hairpin one turn per tick", () => {
    const t = net();
    t.run(1050);
    const a = t.turn(0)!;
    const b = t.turn(3)!;
    expect(b).toBe(a + 1);
    t.run(1000);
    expect(t.turned).toEqual([a, b]);
    expect(maxJump(t.heads.slice(1))).toBeLessThan(0.05);
  });

  it("puts right a turn that got there late, and aims further ahead after it", () => {
    // The client thinks the round trip is quicker than it is. Pressed halfway through a tick,
    // a turn gets to the server too late for the tick it was sent for.
    const t = net({ up: 80, down: 20, rtt: 20 });
    const sent: number[] = [];
    const dirs: Dir[] = [0, 1, 2, 1];
    t.run(455);
    for (const dir of dirs) {
      sent.push(t.turn(dir)!);
      t.run(500);
    }
    t.run(500);
    expect(t.turned).toHaveLength(dirs.length);
    expect(t.turned[0]).toBeGreaterThan(sent[0]);
    expect(t.turned.slice(-2)).toEqual(sent.slice(-2));
    // Once each late turn's frame is in, the prediction has the server's corners.
    const corners = (trail: number[][]) => trail.map((line) => line.slice(0, -2));
    expect(corners(t.drawn().cycle.trail)).toEqual(corners(t.server.cycles[0].trail));
  });

  it("stops your head at a wall, where it waits for the crash", () => {
    const t = net({ start: { x: 30, y: 20, dir: 1 } });
    t.run(2000);
    expect(t.server.cycles[0].alive).toBe(false);
    expect(Math.max(...t.heads.map((h) => h[0]))).toBe(39.5);
    expect(t.drawn().head).toEqual([39.5, 20.5]);
    expect(maxJump(t.heads.slice(1))).toBeLessThan(0.05);
  });

  it("boosts on the tick it was sent for", () => {
    const t = net({ up: 40, down: 60 });
    t.run(1020);
    const at = t.boost();
    expect(t.boost()).toBe(null); // one on its way already
    t.run(1000);
    expect(t.boosted).toEqual([at]);
    expect(t.drawn().cycle.x).toBe(t.server.cycles[0].x);
    expect(maxJump(t.heads.slice(1))).toBeLessThan(0.05);
  });

  it("sets off from its spot with the round, before the first frame", () => {
    const t = net({ up: 20, down: 20 });
    t.run(1000);
    expect(t.heads[0]).toEqual([5.5, 20.5]);
    expect(maxJump(t.heads)).toBeLessThan(0.05);
  });

  it("sends a turn in the countdown for the first tick", () => {
    const t = net();
    expect(t.turn(2)).toBe(1);
    expect(t.drawn().head).toEqual([5.5, 20.5]); // still on the grid
    expect(t.p.next).toBe(2);
    t.run(500);
    expect(t.turned).toEqual([1]);
    expect(t.p.next).toBe(null);
  });

  it("won't send the turns the server would ignore", () => {
    const t = net();
    t.run(250);
    expect(t.turn(1)).toBe(null); // straight on
    expect(t.turn(3)).toBe(null); // U-turn
    expect(t.turn(0)).not.toBe(null);
    expect(t.turn(2)).toBe(null); // U-turn from the turn on its way
    expect(t.turn(3)).not.toBe(null); // a hairpin is fine
    expect(t.turn(2)).not.toBe(null);
    expect(t.turn(1)).toBe(null); // three on their way already
  });

  it("starts over after a turn it wasn't expecting", () => {
    const t = net();
    t.run(250);
    t.p.sentTurn(0, t.p.aimTurn("me", 0, t.now, 60)!); // never reaches the server
    t.server.queueTurn(0, 2);
    t.run(500);
    expect(t.p.next).toBe(null);
    expect(t.drawn().cycle.dir).toBe(2);
  });

  it("drops a turn the server turned down once it's long overdue", () => {
    const t = net();
    t.run(250);
    t.p.sentTurn(0, t.p.aimTurn("me", 0, t.now, 60)!); // never reaches the server
    t.run(500);
    expect(t.p.next).toBe(0);
    t.run(1000);
    expect(t.p.next).toBe(null);
    expect(t.drawn().cycle.dir).toBe(1);
  });
});
