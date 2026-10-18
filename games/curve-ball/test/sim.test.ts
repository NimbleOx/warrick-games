import { describe, expect, it } from "vitest";
import { HEADINGS, SUBSTEPS } from "../src/shared/constants";
import { COS, SIN } from "../src/shared/headings";
import { Round, coast, configFor, graceSubsteps, type Input, type RoundConfig, type RoundSetup } from "../src/shared/sim";

const CFG: RoundConfig = { ...configFor("classic"), w: 200, h: 120 };

/** A round with heads placed by hand instead of at random. */
function round(starts: { x: number; y: number; heading: number }[], cfg: Partial<RoundConfig> = {}) {
  const r = new Round({ cfg: { ...CFG, ...cfg }, seed: 1, ids: starts.map((_, i) => `p${i}`) });
  starts.forEach((s, i) => Object.assign(r.heads[i], s, { nextGap: 1e9 }));
  return r;
}

function run(r: Round, ticks: number) {
  const deaths = [];
  for (let i = 0; i < ticks && !r.over; i++) deaths.push(...r.step());
  return deaths;
}

function hash(a: Uint8Array): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) x = Math.imul(x ^ a[i], 0x01000193);
  return x >>> 0;
}

const EAST = 0;
const SOUTH = HEADINGS / 4;
const WEST = HEADINGS / 2;
const NORTH = (HEADINGS * 3) / 4;

describe("heading table", () => {
  it("matches Math.sin and Math.cos and hits the axes exactly", () => {
    for (let k = 0; k < HEADINGS; k++) {
      const a = (k * 2 * Math.PI) / HEADINGS;
      expect(Math.abs(COS[k] - Math.cos(a))).toBeLessThan(1e-14);
      expect(Math.abs(SIN[k] - Math.sin(a))).toBeLessThan(1e-14);
    }
    expect([COS[EAST], SIN[EAST]]).toEqual([1, 0]);
    expect([COS[SOUTH], SIN[SOUTH]]).toEqual([-0, 1]);
    expect([COS[WEST], SIN[WEST]]).toEqual([-1, -0]);
    expect([COS[NORTH], SIN[NORTH]]).toEqual([0, -1]);
  });

  it("is pinned, so a change that would break old replays shows up here", () => {
    expect(COS[1]).toBe(0.9999904807207345);
    expect(SIN[1]).toBe(0.00436330928474657);
    expect(SIN[240]).toBe(0.8660254037844385);
    expect(COS[1000]).toBe(-0.34202014332566877);
  });
});

describe("movement", () => {
  it("goes straight at the configured speed", () => {
    const r = round([{ x: 20, y: 60, heading: EAST }]);
    run(r, 10);
    expect(r.heads[0].x).toBeCloseTo(20 + 10 * CFG.speed, 9);
    expect(r.heads[0].y).toBe(60);
    expect(r.heads[0].alive).toBe(true);
  });

  it("turns left (counter-clockwise on screen) and right at the configured rate", () => {
    const r = round([
      { x: 60, y: 60, heading: EAST },
      { x: 140, y: 60, heading: EAST },
    ]);
    r.setSteer(0, -1);
    r.setSteer(1, 1);
    r.step();
    expect(r.heads[0].heading).toBe(HEADINGS - CFG.turn * SUBSTEPS);
    expect(r.heads[0].y).toBeLessThan(60);
    expect(r.heads[1].heading).toBe(CFG.turn * SUBSTEPS);
    expect(r.heads[1].y).toBeGreaterThan(60);
  });

  it("drives a circle of the expected radius without hitting its own trail", () => {
    const perTurn = HEADINGS / (CFG.turn * SUBSTEPS); // ticks for a full circle
    const radius = CFG.speed / ((CFG.turn * SUBSTEPS * 2 * Math.PI) / HEADINGS);
    const r = round([{ x: 100, y: 60 - radius, heading: EAST }], { h: 200, w: 200 });
    r.setSteer(0, 1);
    let maxY = 0;
    for (let i = 0; i < perTurn - 3; i++) {
      r.step();
      maxY = Math.max(maxY, r.heads[0].y);
    }
    expect(r.heads[0].alive).toBe(true);
    expect(maxY - (60 - radius)).toBeCloseTo(2 * radius, 0);
    // Keep going and it runs into the start of its own circle.
    run(r, 10);
    expect(r.heads[0].alive).toBe(false);
    expect(r.deaths[0]).toMatchObject({ slot: 0, by: 0, headOn: false });
  });
});

describe("collisions", () => {
  it("dies at the wall and stops just short of it", () => {
    const r = round([{ x: 150, y: 60, heading: EAST }]);
    const deaths = run(r, 40);
    expect(deaths).toEqual([{ slot: 0, by: -1, headOn: false, tick: expect.any(Number) }]);
    expect(r.heads[0].x + r.heads[0].radius).toBeLessThanOrEqual(CFG.w);
    expect(r.heads[0].x + r.heads[0].radius).toBeGreaterThan(CFG.w - CFG.speed);
  });

  it("dies on another player's trail, and the survivor scores", () => {
    const r = round([
      { x: 100, y: 10, heading: SOUTH },
      { x: 20, y: 60, heading: EAST },
    ]);
    // Head 0 lays a vertical wall first; head 1 crosses it later.
    run(r, 30);
    expect(r.heads[0].alive).toBe(true);
    expect(r.heads[1].alive).toBe(false);
    expect(r.deaths).toMatchObject([{ slot: 1, by: 0, headOn: false }]);
    expect(r.heads[1].x).toBeLessThan(100);
    expect(r.heads[0].points).toBe(1);
    expect(r.over).toBe(true);
  });

  it("kills both heads in a head-on collision, whatever their slot order", () => {
    const r = round([
      { x: 60, y: 60, heading: EAST },
      { x: 140, y: 60, heading: WEST },
      { x: 100, y: 100, heading: EAST },
    ]);
    const deaths = run(r, 20);
    expect(deaths.map((d) => d.slot).sort()).toEqual([0, 1]);
    expect(deaths.every((d) => d.headOn)).toBe(true);
    expect(deaths[0].tick).toBe(deaths[1].tick);
    expect(r.heads[2].points).toBe(2);
  });

  it("gives survivors a point for each death in the same tick", () => {
    const r = round([
      { x: 190, y: 20, heading: EAST },
      { x: 190, y: 60, heading: EAST },
      { x: 20, y: 100, heading: EAST },
    ]);
    const deaths = run(r, 5);
    expect(deaths).toHaveLength(2);
    expect(r.heads.map((h) => h.points)).toEqual([0, 0, 2]);
  });

  it("ignores only its own most recent paint", () => {
    const r = round([{ x: 20, y: 60, heading: EAST }]);
    run(r, 5);
    const h = r.heads[0];
    // Right behind the head is its own fresh paint: clear.
    expect(r.blockedAt(0, h.x - 2, h.y, h.radius, r.now)).toBeNull();
    // The same spot much later is old paint: blocked.
    expect(r.blockedAt(0, h.x - 2, h.y, h.radius, r.now + graceSubsteps(h) + 1)).toBe(0);
  });
});

describe("gaps", () => {
  it("leaves a gap every 1.5–3 s that other heads can drive through", () => {
    const r = round([{ x: 100, y: 5, heading: SOUTH }], { h: 300 });
    r.heads[0].nextGap = 20;
    run(r, 20);
    expect(r.heads[0].gap).toBe(CFG.gapTicks);
    const gapStartY = r.heads[0].y;
    run(r, CFG.gapTicks);
    expect(r.heads[0].gap).toBe(0);
    expect(r.heads[0].nextGap).toBeGreaterThanOrEqual(CFG.gapMin);
    expect(r.heads[0].nextGap).toBeLessThanOrEqual(CFG.gapMax);
    const gapEndY = r.heads[0].y;
    run(r, 5);
    const mid = Math.floor((gapStartY + gapEndY) / 2);
    expect(r.grid[mid * CFG.w + 100]).toBe(0);
    expect(r.grid[Math.floor(gapStartY - 6) * CFG.w + 100]).toBe(1);
    expect(r.grid[Math.floor(gapEndY + 4) * CFG.w + 100]).toBe(1);

    // A second head crossing exactly through the middle of the gap survives.
    // A second head crossing through the middle of the gap survives; one crossing the trail doesn't.
    const cross = (y: number) => {
      const c = round(
        [
          { x: 100, y: 5, heading: SOUTH },
          // Far enough left that it reaches x = 100 after head 0 has gone past.
          { x: 10, y, heading: EAST },
        ],
        { h: 300, w: 300 },
      );
      c.heads[0].nextGap = 20;
      for (let i = 0; i < 70; i++) {
        c.step();
        if (i === 40) c.heads[0].nextGap = 1e9;
      }
      return c.heads[1];
    };
    const through = cross((gapStartY + gapEndY) / 2);
    expect(through.alive).toBe(true);
    expect(through.x).toBeGreaterThan(120);
    const blocked = cross(gapStartY - 10);
    expect(blocked.alive).toBe(false);
    expect(blocked.x).toBeLessThan(100);
  });

  it("starts every head's first gap 1.5–3 s in", () => {
    const r = new Round({ cfg: configFor("classic"), seed: 99, ids: ["a", "b", "c", "d"] });
    for (const h of r.heads) {
      expect(h.nextGap).toBeGreaterThanOrEqual(45);
      expect(h.nextGap).toBeLessThanOrEqual(90);
    }
    expect(new Set(r.heads.map((h) => h.nextGap)).size).toBeGreaterThan(1);
  });
});

describe("spawning", () => {
  it("spreads heads out, away from the walls", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = new Round({ cfg: configFor("classic"), seed, ids: ["a", "b", "c", "d", "e", "f", "g", "h"] });
      for (const h of r.heads) {
        expect(h.x).toBeGreaterThanOrEqual(80);
        expect(h.x).toBeLessThanOrEqual(r.cfg.w - 80);
        expect(h.y).toBeGreaterThanOrEqual(80);
        expect(h.y).toBeLessThanOrEqual(r.cfg.h - 80);
      }
      expect(r.over).toBe(false);
    }
  });
});

describe("determinism", () => {
  /** A busy 8-player round with steering changes every few ticks. */
  function scripted(seed: number) {
    const setup: RoundSetup = { cfg: configFor("classic"), seed, ids: ["a", "b", "c", "d", "e", "f", "g", "h"] };
    const inputs: Input[] = [];
    let x = seed;
    for (let t = 0; t < 600; t += 3) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      inputs.push([t, x % 8, (((x >>> 8) % 3) - 1) as -1 | 0 | 1]);
    }
    return { setup, inputs };
  }

  function live(setup: RoundSetup, inputs: Input[], ticks: number) {
    const r = new Round(setup);
    let k = 0;
    while (r.tick < ticks && !r.over) {
      while (k < inputs.length && inputs[k][0] === r.tick) {
        r.setSteer(inputs[k][1], inputs[k][2]);
        k++;
      }
      r.step();
    }
    return r;
  }

  it("produces the same round from the same seed and inputs", () => {
    const { setup, inputs } = scripted(7);
    const a = live(setup, inputs, 600);
    const b = live(setup, inputs, 600);
    expect(hash(a.grid)).toBe(hash(b.grid));
    expect(a.checksum()).toBe(b.checksum());
    expect(a.deaths).toEqual(b.deaths);
    expect(a.deaths.length).toBeGreaterThan(0);
  });

  it("replays a snapshot taken mid-round to the same state", () => {
    const { setup, inputs } = scripted(11);
    const a = live(setup, inputs, 200);
    const b = Round.replay(
      setup,
      inputs.filter((i) => i[0] < 200),
      200,
    );
    expect(b.tick).toBe(a.tick);
    expect(b.checksum()).toBe(a.checksum());
    expect(hash(b.grid)).toBe(hash(a.grid));
    // And they stay together afterwards.
    for (let t = 200; t < 400 && !a.over; t++) {
      for (const [, slot, s] of inputs.filter((i) => i[0] === t)) {
        a.setSteer(slot, s);
        b.setSteer(slot, s);
      }
      a.step();
      b.step();
    }
    expect(b.checksum()).toBe(a.checksum());
  });

  it("calls onStep after every step of a replay, with the round as it was live", () => {
    const { setup, inputs } = scripted(11);
    const before = inputs.filter((i) => i[0] < 200);
    // The live round, stepped alongside.
    const a = new Round(setup);
    let k = 0;
    const ticks: number[] = [];
    const b = Round.replay(setup, before, 200, (r) => {
      while (k < inputs.length && inputs[k][0] === a.tick) {
        a.setSteer(inputs[k][1], inputs[k][2]);
        k++;
      }
      a.step();
      ticks.push(r.tick);
      // What a client draws from after each step.
      expect(r.checksum()).toBe(a.checksum());
      expect([...r.prevX, ...r.prevY]).toEqual([...a.prevX, ...a.prevY]);
      expect(r.painted).toEqual(a.painted);
      expect(r.deaths).toEqual(a.deaths);
    });
    expect(b.tick).toBe(200);
    expect(ticks).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    // Watching doesn't change the outcome.
    const plain = Round.replay(setup, before, 200);
    expect(b.checksum()).toBe(plain.checksum());
    expect(hash(b.grid)).toBe(hash(plain.grid));
  });

  it("is a different round with a different seed", () => {
    const a = new Round({ cfg: configFor("classic"), seed: 1, ids: ["a", "b"] });
    const b = new Round({ cfg: configFor("classic"), seed: 2, ids: ["a", "b"] });
    expect(a.checksum()).not.toBe(b.checksum());
  });
});

describe("prediction", () => {
  it("coasting a copy of a head matches stepping the round, gaps included", () => {
    const r = new Round({ cfg: configFor("classic"), seed: 5, ids: ["me"] });
    const copy = { ...r.heads[0] };
    const steers = [1, 1, 1, 0, 0, -1, -1, 0, 1, 0] as const;
    for (let t = 0; t < 120; t++) {
      const s = steers[t % steers.length];
      r.setSteer(0, s);
      copy.steer = s;
      r.step();
      const painted = coast(copy, r.cfg);
      expect(painted).toBe(r.painted[0]);
      expect([copy.x, copy.y, copy.heading, copy.gap, copy.nextGap]).toEqual([
        r.heads[0].x,
        r.heads[0].y,
        r.heads[0].heading,
        r.heads[0].gap,
        r.heads[0].nextGap,
      ]);
    }
  });
});
