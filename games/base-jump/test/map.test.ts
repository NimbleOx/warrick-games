import { describe, expect, it } from "vitest";
import { HELI, NEUTRAL_GARRISON, START_LEVEL, START_TANKS, TANK } from "../src/shared/constants";
import { baseCount, generateMap, type GameMap, type MapSize } from "../src/shared/map";

function crosses(m: GameMap, [a, b]: [number, number], [c, d]: [number, number]): boolean {
  if (a === c || a === d || b === c || b === d) return false;
  const orient = (p: number, q: number, r: number) =>
    Math.sign((m.x[q] - m.x[p]) * (m.y[r] - m.y[p]) - (m.y[q] - m.y[p]) * (m.x[r] - m.x[p]));
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b);
}

function connected(m: GameMap): boolean {
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) for (const nb of m.adj[stack.pop()!]) if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
  return seen.size === m.x.length;
}

describe("map generation", () => {
  const cases: [number, MapSize][] = [
    [2, "small"],
    [2, "medium"],
    [3, "large"],
    [4, "medium"],
    [6, "medium"],
    [8, "large"],
  ];

  it.each(cases)("makes a sound map for %i players (%s)", (players, size) => {
    for (const seed of [1, 2, 3]) {
      const m = generateMap(seed, players, size);
      expect(m.x.length).toBe(baseCount(players, size));
      expect(connected(m)).toBe(true);
      expect(new Set(m.starts).size).toBe(players);
      for (let i = 0; i < m.x.length; i++) {
        expect(m.x[i]).toBeGreaterThanOrEqual(0);
        expect(m.x[i]).toBeLessThanOrEqual(m.w);
        expect(m.y[i]).toBeGreaterThanOrEqual(0);
        expect(m.y[i]).toBeLessThanOrEqual(m.h);
      }
      for (let i = 0; i < m.roads.length; i++) {
        for (let j = i + 1; j < m.roads.length; j++) expect(crosses(m, m.roads[i], m.roads[j])).toBe(false);
      }
    }
  });

  it("is the same for the same seed", () => {
    expect(generateMap(42, 4, "medium")).toEqual(generateMap(42, 4, "medium"));
    expect(generateMap(42, 4, "medium")).not.toEqual(generateMap(43, 4, "medium"));
  });

  it("starts everyone on the same depot, next to the same easy first target", () => {
    const m = generateMap(7, 4, "medium");
    for (const s of m.starts) {
      expect([m.kind[s], m.level[s], m.garrison[s]]).toEqual([TANK, START_LEVEL, START_TANKS]);
    }
    for (let b = 0; b < m.x.length; b++) {
      if (m.starts.includes(b)) continue;
      const [lo, hi] = NEUTRAL_GARRISON[m.level[b]];
      expect(m.garrison[b]).toBeGreaterThanOrEqual(Math.min(lo, 5));
      expect(m.garrison[b]).toBeLessThanOrEqual(hi);
    }
    const near = m.starts.map((s) => {
      const nb = [...m.adj[s]].sort(
        (a, b) => Math.hypot(m.x[a] - m.x[s], m.y[a] - m.y[s]) - Math.hypot(m.x[b] - m.x[s], m.y[b] - m.y[s]),
      );
      return nb.some((b) => m.level[b] === 1 && m.garrison[b] === 5 && m.kind[b] === TANK);
    });
    expect(near.filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  it("always has airfields (at least one per player) and some bigger bases", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const m = generateMap(seed, 2, "small");
      expect(m.kind.filter((k) => k === HELI).length).toBeGreaterThanOrEqual(2);
    }
    const m = generateMap(11, 6, "large");
    expect(m.kind.filter((k) => k === HELI).length).toBeGreaterThanOrEqual(9);
    expect(m.level.filter((l) => l >= 2).length).toBeGreaterThan(6);
  });

  it("is quick enough to make on every round start", () => {
    const t0 = performance.now();
    generateMap(5, 8, "large");
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
