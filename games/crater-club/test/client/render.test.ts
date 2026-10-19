// The map is drawn only while something on it moves or changes. This runs the real Renderer over
// a canvas that only counts what's drawn on it.
import { mulberry32 } from "@warrick/kit/shared/rng";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Renderer, type DrawOpts, type TankInfo } from "../../src/client/render";
import { WindStreaks } from "../../src/client/wind";
import { WORLD_H, WORLD_W } from "../../src/shared/constants";
import { World, launchFor } from "../../src/shared/sim";
import { flattenPad, generateTerrain } from "../../src/shared/terrain";

const FRAME_MS = 1000 / 60;

/** Every call drawn on every fake canvas: its name and arguments. */
let drawn: [string, unknown[]][] = [];

/** A canvas whose 2D context does nothing but count (and note) the calls that draw. */
function fakeCanvas() {
  let calls = 0;
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createImageData") return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => ({ addColorStop() {} });
      return (...args: unknown[]) => {
        calls++;
        drawn.push([String(key), args]);
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { width: 300, height: 150, getContext: () => ctx, calls: () => calls };
}

function world(wind = 0): World {
  const heights = generateTerrain(mulberry32(1), "hills", "smooth");
  const tanks = [300, 900].map((x, i) => ({
    id: `p${i + 1}`,
    x,
    y: flattenPad(heights, x),
    health: 100,
    alive: true,
    shield: 0,
    parachutes: 0,
  }));
  return new World({ heights, tanks, wind, walls: "open" });
}

function opts(over: { active?: string; angle?: number } = {}): DrawOpts {
  const tanks = new Map<string, TankInfo>();
  for (const id of ["p1", "p2"]) {
    tanks.set(id, {
      name: id,
      color: "#ff4d5e",
      angle: id === "p1" ? (over.angle ?? 60) : 120,
      active: over.active === id,
      you: id === "p1",
    });
  }
  return { theme: 0, tanks, labels: true, aimGuide: null };
}

/** Draw a frame at each of `frames` 60 Hz frames from `start`, and count the ones drawn. */
function run(r: Renderer, w: World, o: DrawOpts, start: number, frames: number): number {
  let drawn = 0;
  for (let i = 0; i < frames; i++) if (r.draw(w, o, start + i * FRAME_MS)) drawn++;
  return drawn;
}

let canvas: ReturnType<typeof fakeCanvas>;
let r: Renderer;

beforeEach(() => {
  drawn = [];
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      constructor(w: number, h: number) {
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    },
  );
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  canvas = fakeCanvas();
  r = new Renderer(canvas as unknown as HTMLCanvasElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the renderer", () => {
  it("doesn't draw a frame that would look like the last one", () => {
    const w = world();
    expect(r.draw(w, opts(), 0)).toBe(true);
    const calls = canvas.calls();
    expect(run(r, w, opts(), FRAME_MS, 120)).toBe(0);
    expect(canvas.calls()).toBe(calls);

    // Something on it changes: a barrel turns, the canvas is resized, a new world arrives.
    expect(r.draw(w, opts({ angle: 61 }), 3000)).toBe(true);
    expect(r.draw(w, opts({ angle: 61 }), 3016)).toBe(false);
    r.resize(600);
    expect(r.draw(w, opts({ angle: 61 }), 3032)).toBe(true);
    expect(r.draw(world(), opts({ angle: 61 }), 3048)).toBe(true);
    r.invalidate();
    expect(r.draw(w, opts({ angle: 61 }), 3064)).toBe(true);
  });

  it("repaints only the ground that changed", () => {
    // The ground's own canvas is repainted with a dirty rect: (image, 0, 0, x, y, width, height).
    const painted = () => drawn.filter(([k, a]) => k === "putImageData" && a.length === 7).map(([, a]) => a.slice(3));
    const w = world();
    r.draw(w, opts(), 0);
    expect(painted()).toEqual([[0, 0, WORLD_W, WORLD_H]]);
    // The same ground in a new state (every state between shots brings one): nothing to paint.
    expect(r.draw(world(), opts(), 100)).toBe(true);
    expect(painted()).toHaveLength(1);
    // A crater: just its columns.
    for (let x = 590; x <= 610; x++) w.heights[x] -= 20;
    w.terrainVersion++;
    r.draw(w, opts(), 200);
    expect(painted().at(-1)).toEqual([590, 0, 21, WORLD_H]);
    // A new theme: all of it, in its colours.
    r.draw(w, { ...opts(), theme: 1 }, 300);
    expect(painted().at(-1)).toEqual([0, 0, WORLD_W, WORLD_H]);
  });

  it("fills a box with the world, centred and cropped, drawing only what shows", () => {
    // A phone held upright: the world is scaled to its height, and its middle shows.
    r.resizeCover(390, 844);
    expect([canvas.width, canvas.height]).toEqual([390, 844]);
    expect(r.blank).toBe(true);
    expect(r.draw(world(), opts(), 0)).toBe(true);
    expect(r.blank).toBe(false);
    const k = 844 / WORLD_H;
    const scaled = drawn.find(([key, a]) => key === "setTransform" && a[0] === k);
    expect(scaled?.[1]).toEqual([k, 0, 0, k, (390 - WORLD_W * k) / 2, 0]);
  });

  it("redraws a few times a second while the arrow over the player whose turn it is bobs", () => {
    const w = world();
    const drawn = run(r, w, opts({ active: "p1" }), 0, 60);
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(15);
  });

  it("draws every frame while an explosion shakes the map and a hit floats up, then stops", () => {
    const w = world();
    r.draw(w, opts(), 0);
    r.onEvent({ type: "explode", x: 300, y: 200, r: 60, dirt: false } as never, w, 0, () => "#ffffff");
    r.onEvent({ type: "damage", id: "p1", by: "p2", amount: 30 } as never, w, 0, () => "#ffffff");
    // The hit floats up for 1.4 seconds.
    expect(run(r, w, opts(), FRAME_MS, 80)).toBe(80);
    expect(run(r, w, opts(), 1500, 60)).toBeLessThanOrEqual(1);
    expect(r.draw(w, opts(), 2600)).toBe(false);
  });

  it("draws the shot as it flies, and its trail as it fades", () => {
    const w = world();
    const tank = w.tanks[0];
    w.fire({ shooterId: "p1", weapon: "baby_missile", seed: 1, ...launchFor(tank, 60, 500) });
    r.newShot();
    let now = 0;
    for (; w.projectiles.length > 0; now += FRAME_MS) {
      w.step();
      expect(r.draw(w, opts(), now)).toBe(true);
    }
    // It has landed. Hold the world still: the trail alone fades out over 0.7 seconds, then nothing moves.
    const fading = run(r, w, opts(), now, 60);
    expect(fading).toBeGreaterThan(30);
    expect(fading).toBeLessThan(50);
    expect(r.draw(w, opts(), now + 3000)).toBe(false);
  });

  it("redraws about 30 times a second while the wind blows streaks across the sky", () => {
    const drawn = run(r, world(-10), opts(), 0, 60);
    expect(drawn).toBeGreaterThan(25);
    expect(drawn).toBeLessThan(35);
  });

  it("holds the wind streaks still for players who'd rather not see motion", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1, matchMedia: () => ({ matches: true }) });
    r = new Renderer(canvas as unknown as HTMLCanvasElement);
    const w = world(-10);
    expect(r.draw(w, opts(), 0)).toBe(true);
    expect(run(r, w, opts(), FRAME_MS, 60)).toBe(0);
  });
});

describe("the wind streaks", () => {
  /** Where a streak's head is after each frame. Math.random is pinned, so every streak is alike. */
  function headAt(wind: number, times: number[]): number[] {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let x = NaN;
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      beginPath() {},
      moveTo() {},
      lineTo(lx: number) {
        x = lx;
      },
      stroke() {},
    } as unknown as CanvasRenderingContext2D;
    const streaks = new WindStreaks();
    return times.map((t) => {
      streaks.draw(ctx, wind, t, 1);
      return x;
    });
  }

  it("blow the way the wind does, faster the harder it blows", () => {
    const [a, b, c] = headAt(-10, [1000, 1100, 1200]);
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);

    const drift = (wind: number) => {
      const [x0, x1] = headAt(wind, [1000, 1100]);
      return x1 - x0;
    };
    expect(drift(5)).toBeGreaterThan(0);
    expect(drift(20)).toBeGreaterThan(drift(5));
  });

  it("aren't there in calm air", () => {
    expect(headAt(0, [1000, 1100])).toEqual([NaN, NaN]);
  });
});
