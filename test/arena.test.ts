import { describe, expect, it } from "vitest";
import { steer } from "../src/shared/ai";
import { Arena, spawnPoints, type ArenaConfig, type Dir } from "../src/shared/arena";
import { ARENA_SIZES } from "../src/shared/constants";
import { DEFAULT_SETTINGS, arenaConfig } from "../src/shared/protocol";
import { mulberry32 } from "../src/shared/rng";

const CFG: ArenaConfig = { w: 20, h: 12, walls: "solid", boosts: 2, boostTicks: 3, suddenDeathAt: 0, shrinkEvery: 1 };

function arena(starts: { x: number; y: number; dir: Dir }[], cfg: Partial<ArenaConfig> = {}) {
  return Arena.create({ ...CFG, ...cfg }, starts.map((s, i) => ({ id: `c${i}`, ...s })));
}

function crashes(a: Arena, ticks: number) {
  const out = [];
  for (let i = 0; i < ticks; i++) out.push(...a.step().e.filter((e) => e.k === "crash"));
  return out;
}

describe("arena", () => {
  it("lays a wall behind each cycle, with a corner at every turn", () => {
    const a = arena([{ x: 2, y: 2, dir: 1 }]);
    a.step();
    a.step();
    a.queueTurn(0, 2);
    a.step();
    a.step();
    expect(a.cycles[0].trail).toEqual([[2, 2, 4, 2, 4, 4]]);
    for (const [x, y] of [[2, 2], [3, 2], [4, 2], [4, 3], [4, 4]]) expect(a.grid[y * CFG.w + x]).toBe(1);
  });

  it("ignores U-turns and repeated turns", () => {
    const a = arena([{ x: 5, y: 5, dir: 1 }]);
    expect(a.queueTurn(0, 3)).toBe(false);
    expect(a.queueTurn(0, 1)).toBe(false);
    expect(a.queueTurn(0, 0)).toBe(true);
    expect(a.queueTurn(0, 0)).toBe(false);
    expect(a.queueTurn(0, 3)).toBe(true); // left after up is fine: a tight hairpin
    a.step();
    a.step();
    expect([a.cycles[0].x, a.cycles[0].y]).toEqual([4, 4]);
  });

  it("crashes into the arena wall", () => {
    const a = arena([{ x: 18, y: 5, dir: 1 }, { x: 1, y: 5, dir: 3 }]);
    a.step(); // both reach the edge
    const [c0, c1] = crashes(a, 1);
    expect(c0).toMatchObject({ i: 0, by: -1 });
    expect(c1).toMatchObject({ i: 1, by: -1 });
  });

  it("credits the cycle whose wall you hit, and its wall derezzes when it crashes", () => {
    // c1 drives up into the row c0 has already filled.
    const a = arena([{ x: 2, y: 5, dir: 1 }, { x: 4, y: 11, dir: 0 }]);
    const [hit] = crashes(a, 10);
    expect(hit).toMatchObject({ i: 1, by: 0 });
    expect(a.cycles[1].alive).toBe(false);
    expect(Array.from(a.grid).filter((v) => v === 2)).toHaveLength(0);
    expect(a.cycles[1].trail[0].length).toBeGreaterThan(2); // kept for the animation
  });

  it("kills both cycles in a head-on", () => {
    const a = arena([{ x: 4, y: 5, dir: 1 }, { x: 8, y: 5, dir: 3 }]);
    a.step();
    const hits = crashes(a, 1);
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.k === "crash" && h.headOn)).toBe(true);
  });

  it("boosts two cells per tick for a limited time", () => {
    const a = arena([{ x: 1, y: 5, dir: 1 }]);
    expect(a.requestBoost(0)).toBe(true);
    const f = a.step();
    expect(f.m[0]).toEqual([2, 5, 3, 5]);
    expect(f.e).toContainEqual({ k: "boost", i: 0 });
    a.step();
    a.step();
    expect(a.cycles[0].x).toBe(7);
    a.step();
    expect(a.cycles[0].x).toBe(8);
    expect(a.cycles[0].boosts).toBe(1);
  });

  it("wraps around the edges when the walls wrap", () => {
    const a = arena([{ x: 18, y: 5, dir: 1 }], { walls: "wrap" });
    a.step();
    a.step();
    a.step();
    expect(a.cycles[0].alive).toBe(true);
    expect(a.cycles[0].trail).toEqual([[18, 5, 19, 5], [0, 5, 1, 5]]);
  });

  it("closes the walls in during sudden death", () => {
    const a = arena([{ x: 0, y: 5, dir: 0 }, { x: 10, y: 6, dir: 0 }], { w: 40, h: 30, suddenDeathAt: 2, shrinkEvery: 2 });
    a.step();
    const f = a.step();
    expect(f.e).toContainEqual({ k: "shrink", s: 1 });
    expect(f.e).toContainEqual(expect.objectContaining({ k: "crash", i: 0, by: -1 }));
    expect(a.inside(0, 5)).toBe(false);
    expect(a.cycles[1].alive).toBe(true);
  });

  it("replays frames into an identical arena", () => {
    const rng = mulberry32(99);
    const cfg = { ...arenaConfig({ ...DEFAULT_SETTINGS, arena: "small", walls: "wrap" }), suddenDeathAt: 150 };
    const spots = spawnPoints(4, cfg.w, cfg.h, rng);
    const server = Arena.create(cfg, spots.map((s, i) => ({ id: `c${i}`, ...s })));
    const client = new Arena(server.snapshot());
    let guard = 0;
    while (server.aliveCount > 1 && guard++ < 5000) {
      server.cycles.forEach((c, i) => {
        const move = steer(server, i, "normal", rng);
        if (move.dir !== null) server.queueTurn(i, move.dir);
        if (move.boost) server.requestBoost(i);
      });
      client.apply(JSON.parse(JSON.stringify(server.step())));
    }
    expect(server.aliveCount).toBeLessThanOrEqual(1);
    expect(client.snapshot()).toEqual(server.snapshot());
    expect(Array.from(client.grid)).toEqual(Array.from(server.grid));
  });

  it("rebuilds the grid from a snapshot", () => {
    const a = arena([{ x: 2, y: 2, dir: 1 }]);
    a.step();
    a.queueTurn(0, 2);
    a.step();
    a.step();
    expect(Array.from(new Arena(a.snapshot()).grid)).toEqual(Array.from(a.grid));
  });
});

describe("cpu riders", () => {
  it("don't drive into a wall they can see", () => {
    const rng = mulberry32(5);
    const a = arena([{ x: 19, y: 5, dir: 1 }]);
    for (const level of ["easy", "normal", "hard"] as const) {
      const move = steer(a, 0, level, () => 0.5 + rng() * 0.4); // no blunders
      expect(move.dir === 0 || move.dir === 2).toBe(true);
    }
  });

  it("finish rounds on every arena size within the sudden-death limit", () => {
    for (const size of Object.keys(ARENA_SIZES) as (keyof typeof ARENA_SIZES)[]) {
      const rng = mulberry32(size.length);
      const cfg = arenaConfig({ ...DEFAULT_SETTINGS, arena: size });
      const spots = spawnPoints(6, cfg.w, cfg.h, rng);
      const a = Arena.create(cfg, spots.map((s, i) => ({ id: `c${i}`, ...s })));
      const levels = ["hard", "hard", "normal", "normal", "easy", "easy"] as const;
      let ticks = 0;
      while (a.aliveCount > 1 && ticks++ < 10000) {
        a.cycles.forEach((c, i) => {
          if (!c.alive) return;
          const move = steer(a, i, levels[i], rng);
          if (move.dir !== null) a.queueTurn(i, move.dir);
          if (move.boost) a.requestBoost(i);
        });
        a.step();
      }
      expect(a.aliveCount).toBeLessThanOrEqual(1);
      // Sudden death starts after 60s and closes the floor in a few dozen rings.
      expect(ticks).toBeLessThan(cfg.suddenDeathAt + 2000);
    }
  });
});
