import { describe, expect, it } from "vitest";
import { TANK_HALF_W, WORLD_W } from "../src/shared/constants";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { World, launchFor, maxPowerFor } from "../src/shared/sim";
import {
  carveCrater,
  generateTerrain,
  ROUGHNESS,
  TERRAIN_STYLES,
  type Roughness,
  type TerrainStyle,
} from "../src/shared/terrain";
import { WEAPON_ORDER, type WeaponId } from "../src/shared/weapons";

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

/** A world on the given ground, with tanks sitting on it at the given xs ("a", "b", ...). */
function worldOn(heights: number[], xs: number[], wind = 0) {
  return new World({
    heights,
    tanks: xs.map((x, i) => ({ id: "abcd"[i], x, y: heights[x], health: 100, alive: true, shield: 0, parachutes: 0 })),
    wind,
    walls: "open",
  });
}

/** Drop a shot straight down onto x from just above the ground there. */
function drop(w: World, weapon: WeaponId, x: number, vx = 0) {
  w.fire({ shooterId: "a", weapon, seed: 7, x, y: w.heights[x] + 60, vx, vy: 0 });
  w.runToEnd();
  return w;
}

function damageTo(w: World, id: string): number {
  return w.events.reduce((sum, e) => sum + (e.type === "damage" && e.id === id ? e.amount : 0), 0);
}

/** Ground shaped like a V, lowest at x = 600, rising half a pixel a column. */
const valley = () => Array.from({ length: WORLD_W }, (_, x) => 100 + Math.floor(Math.abs(x - 600) / 2));

function shoot(w: World, weapon: WeaponId, angle: number, power: number, seed = 42) {
  const t = w.tanks[0];
  w.fire({ shooterId: t.id, weapon, seed, ...launchFor(t, angle, power) });
  w.runToEnd();
  return w;
}

describe("terrain", () => {
  it("generates every style at every roughness within the map", () => {
    for (const style of TERRAIN_STYLES) {
      for (const roughness of ROUGHNESS) {
        const h = generateTerrain(mulberry32(7), style, roughness);
        expect(h).toHaveLength(WORLD_W);
        expect(Math.min(...h)).toBeGreaterThan(0);
        expect(h.every(Number.isInteger)).toBe(true);
      }
    }
  });

  it("makes each roughness bumpier than the one before, in every style", () => {
    // How far the ground climbs and falls from one side to the other, over 20 maps.
    const climb = (style: TerrainStyle, roughness: Roughness) => {
      let total = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const h = generateTerrain(mulberry32(seed), style, roughness);
        for (let x = 1; x < h.length; x++) total += Math.abs(h[x] - h[x - 1]);
      }
      return total;
    };
    for (const style of TERRAIN_STYLES) {
      const [smooth, rough, jagged] = ROUGHNESS.map((r) => climb(style, r));
      expect(rough, style).toBeGreaterThan(smooth * 1.15);
      expect(jagged, style).toBeGreaterThan(rough * 1.15);
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
    for (const weapon of WEAPON_ORDER) {
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

describe("the laser", () => {
  it("goes dead straight, whatever the wind, and burns every tank in its way once", () => {
    const w = flatWorld();
    w.wind = 20;
    w.tanks.splice(1, 1, ...[500, 800].map((x, i) => ({ ...w.tanks[0], id: "bc"[i], x })));
    const t = w.tanks[0];
    w.fire({ shooterId: "a", weapon: "laser", seed: 1, ...launchFor(t, 0, 1000) });
    let maxY = 0;
    let minY = Infinity;
    while (!w.done) {
      w.step();
      for (const p of w.projectiles) {
        maxY = Math.max(maxY, p.y);
        minY = Math.min(minY, p.y);
      }
    }
    expect(maxY - minY).toBeLessThan(1e-9);
    expect(damageTo(w, "b")).toBe(50);
    expect(damageTo(w, "c")).toBe(50);
    expect(damageTo(w, "a")).toBe(0);
    // It is quick: across the map in about a second.
    expect(w.tick).toBeLessThan(70);
  });

  it("cuts through a hill, and power sets how far it reaches", () => {
    const hill = Array.from({ length: WORLD_W }, (_, x) => 200 + Math.max(0, 60 - Math.abs(x - 500)));
    const far = worldOn(hill, [200, 800]);
    far.fire({ shooterId: "a", weapon: "laser", seed: 1, ...launchFor(far.tanks[0], 0, 1000) });
    far.runToEnd();
    expect(damageTo(far, "b")).toBe(50);
    // A groove where the beam went through the hill.
    expect(far.heights[500]).toBeLessThan(hill[500]);
    expect(far.terrainVersion).toBeGreaterThan(0);

    // At 300 power it reaches 360 px: through the hill, but not to the tank 600 px away.
    const short = worldOn(hill, [200, 800]);
    short.fire({ shooterId: "a", weapon: "laser", seed: 1, ...launchFor(short.tanks[0], 0, 300) });
    short.runToEnd();
    expect(damageTo(short, "b")).toBe(0);
    expect(short.heights[500]).toBeLessThan(hill[500]);
  });
});

describe("napalm", () => {
  it("runs down into a valley and burns the tank at the bottom", () => {
    const w = drop(worldOn(valley(), [200, 600]), "napalm", 680);
    expect(damageTo(w, "b")).toBeGreaterThan(10);
    expect(w.done).toBe(true);
    expect(w.flames).toHaveLength(0);
  });

  it("runs off a hilltop, so a tank up there gets off lightly", () => {
    const peak = valley().map((h) => 500 - h);
    const top = drop(worldOn(peak, [100, 600]), "napalm", 600);
    const flat = drop(worldOn(new Array(WORLD_W).fill(200), [100, 600]), "napalm", 600);
    expect(damageTo(top, "b")).toBeLessThan(damageTo(flat, "b") / 3);
    expect(damageTo(flat, "b")).toBeGreaterThan(30);
  });

  it("doesn't dig, and hot napalm burns harder", () => {
    const flat = new Array(WORLD_W).fill(200);
    const napalm = drop(worldOn(flat, [100, 600]), "napalm", 600);
    const hot = drop(worldOn(flat, [100, 600]), "hot_napalm", 600);
    expect(napalm.heights).toEqual(flat);
    expect(damageTo(hot, "b")).toBeGreaterThan(damageTo(napalm, "b"));
  });

  it("is soaked up by a shield like anything else", () => {
    const flat = new Array(WORLD_W).fill(200);
    const bare = damageTo(drop(worldOn(flat, [100, 600]), "napalm", 600), "b");
    const w = worldOn(flat, [100, 600]);
    w.tanks[1].shield = 60;
    drop(w, "napalm", 600);
    expect(w.events.some((e) => e.type === "shield" && e.id === "b")).toBe(true);
    expect(damageTo(w, "b") + 60 - w.tanks[1].shield).toBe(bare);
  });

  it("burns the same way on every replay", () => {
    const a = drop(worldOn(valley(), [200, 600]), "hot_napalm", 700);
    const b = drop(worldOn(valley(), [200, 600]), "hot_napalm", 700);
    expect(a.events).toEqual(b.events);
    expect(a.tick).toBe(b.tick);
  });
});

describe("the sandhog", () => {
  it("burrows through a hill and blows up under the tank behind it", () => {
    const hill = Array.from({ length: WORLD_W }, (_, x) => 200 + Math.max(0, 80 - Math.abs(x - 450)));
    const w = drop(worldOn(hill, [200, 560]), "sandhog", 400, 0.5);
    const blast = w.events.find((e) => e.type === "explode")!;
    expect(Math.abs(blast.x - 560)).toBeLessThan(TANK_HALF_W);
    expect(blast.y).toBeLessThan(200);
    expect(damageTo(w, "b")).toBeGreaterThan(30);
    // It dug a tunnel through the hill on the way.
    expect(w.heights[450]).toBeLessThan(hill[450]);
  });

  it("goes the way it was flying, and gives up after its reach", () => {
    const flat = new Array(WORLD_W).fill(200);
    const w = drop(worldOn(flat, [100, 1000]), "sandhog", 500, -0.5);
    const dug = w.events.find((e) => e.type === "burrow")!;
    const blast = w.events.find((e) => e.type === "explode")!;
    expect(blast.x).toBeLessThan(dug.x);
    expect(Math.abs(dug.x - blast.x - 180)).toBeLessThan(2);
    expect(damageTo(w, "b")).toBe(0);
  });

  it("goes off at once on a direct hit", () => {
    const w = flatWorld();
    w.fire({ shooterId: "a", weapon: "sandhog", seed: 1, x: 900, y: 260, vx: 0, vy: 0 });
    w.runToEnd();
    expect(w.events.some((e) => e.type === "burrow")).toBe(false);
    expect(damageTo(w, "b")).toBeGreaterThan(50);
  });
});
