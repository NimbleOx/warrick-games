import { describe, expect, it } from "vitest";
import { WORLD_W } from "../src/shared/constants";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { World, launchFor, maxPowerFor } from "../src/shared/sim";
import { carveCrater, generateTerrain, TERRAIN_STYLES } from "../src/shared/terrain";
import type { WeaponId } from "../src/shared/weapons";

function flatWorld(walls: "open" | "bounce" | "wrap" = "open") {
  return new World({
    heights: new Array(WORLD_W).fill(200),
    tanks: [
      { id: "a", x: 200, y: 200, health: 100, alive: true, shield: 0, parachutes: 0 },
      { id: "b", x: 900, y: 200, health: 100, alive: true, shield: 0, parachutes: 0 },
    ],
    wind: 0,
    walls,
  });
}

function shoot(w: World, weapon: WeaponId, angle: number, power: number, seed = 42) {
  const t = w.tanks[0];
  w.fire({ shooterId: t.id, weapon, seed, ...launchFor(t, angle, power) });
  w.runToEnd();
  return w;
}

describe("terrain", () => {
  it("generates every style within the map", () => {
    for (const style of TERRAIN_STYLES) {
      const h = generateTerrain(mulberry32(7), style);
      expect(h).toHaveLength(WORLD_W);
      expect(Math.min(...h)).toBeGreaterThan(0);
      expect(h.every(Number.isInteger)).toBe(true);
    }
  });

  it("carves a crater and lets dirt above fall", () => {
    const h = new Array(WORLD_W).fill(200);
    carveCrater(h, 600, 200, 30);
    expect(h[600]).toBe(170);
    expect(h[500]).toBe(200);
  });
});

describe("shots", () => {
  it("is deterministic for the same input", () => {
    const a = shoot(flatWorld(), "funky_bomb", 50, 700);
    const b = shoot(flatWorld(), "funky_bomb", 50, 700);
    expect(a.heights).toEqual(b.heights);
    expect(a.tick).toBe(b.tick);
    expect(a.events).toEqual(b.events);
  });

  it("can hit the other tank and the shot ends", () => {
    const w = flatWorld();
    // Search for a power that lands on tank b.
    let hit = false;
    for (let power = 300; power <= 1000 && !hit; power += 5) {
      const probe = flatWorld();
      const t = probe.tanks[0];
      const impact = probe.traceImpact(launchFor(t, 45, power));
      if (impact.tankId === "b") {
        shoot(w, "missile", 45, power);
        hit = true;
      }
    }
    expect(hit).toBe(true);
    expect(w.done).toBe(true);
    expect(w.tanks[1].health).toBeLessThan(100);
  });

  it("runs every weapon to completion", () => {
    const weapons: WeaponId[] = ["baby_missile", "missile", "baby_nuke", "nuke", "mirv", "deaths_head",
      "funky_bomb", "leapfrog", "roller", "dirt_clod", "dirt_ball", "tracer"];
    for (const weapon of weapons) {
      for (const walls of ["open", "bounce", "wrap"] as const) {
        const w = shoot(flatWorld(walls), weapon, 60, 650);
        expect(w.done, `${weapon}/${walls}`).toBe(true);
        expect(w.timedOut, `${weapon}/${walls}`).toBe(false);
      }
    }
  });

  it("caps power for damaged tanks without making them useless", () => {
    expect(maxPowerFor(100)).toBe(1000);
    expect(maxPowerFor(50)).toBe(700);
    expect(maxPowerFor(0)).toBe(400);
    // At 1 HP a 45° shot on flat ground still lands well away from the shooter.
    const w = flatWorld();
    w.tanks.splice(1, 1);
    const impact = w.traceImpact(launchFor(w.tanks[0], 45, maxPowerFor(1)));
    expect(impact.x - w.tanks[0].x).toBeGreaterThan(250);
  });

  it("drops a tank whose ground is blown away, with fall damage", () => {
    const w = flatWorld();
    w.tanks[1].y = 200;
    // Nuke straight under tank b by shooting from b's position downward-ish: carve manually.
    carveCrater(w.heights, 900, 120, 80);
    w.step(); // falling starts on the next tick after the ground changes
    w.runToEnd();
    expect(w.tanks[1].y).toBeLessThan(200);
    expect(w.tanks[1].health).toBeLessThan(100);
  });
});
