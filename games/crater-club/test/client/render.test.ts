// The map is drawn only while something on it moves or changes. This runs the real Renderer over
// a canvas that only counts what's drawn on it.
import { mulberry32 } from "@warrick/kit/shared/rng";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Renderer, type DrawOpts, type TankInfo } from "../../src/client/render";
import { World, launchFor } from "../../src/shared/sim";
import { flattenPad, generateTerrain } from "../../src/shared/terrain";

const FRAME_MS = 1000 / 60;

/** A canvas whose 2D context does nothing but count the calls that draw. */
function fakeCanvas() {
  let calls = 0;
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createImageData") return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (key === "createRadialGradient") return () => ({ addColorStop() {} });
      return () => {
        calls++;
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { width: 300, height: 150, getContext: () => ctx, calls: () => calls };
}

function world(): World {
  const heights = generateTerrain(mulberry32(1), "hills");
  const tanks = [300, 900].map((x, i) => ({
    id: `p${i + 1}`,
    x,
    y: flattenPad(heights, x),
    health: 100,
    alive: true,
    shield: 0,
    parachutes: 0,
  }));
  return new World({ heights, tanks, wind: 0, walls: "open" });
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
});
