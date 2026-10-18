import { describe, expect, it } from "vitest";
import { MIN_CELLS } from "../src/shared/constants";
import { neighbours } from "../src/shared/hex";
import { adjacency, generateMap, isConnected, territorySizes } from "../src/shared/map";

describe("hex grid", () => {
  it("neighbours are mutual", () => {
    const w = 7;
    const h = 6;
    for (let c = 0; c < w * h; c++) {
      for (const nb of neighbours(w, h, c)) if (nb >= 0) expect(neighbours(w, h, nb)).toContain(c);
    }
  });

  it("edge k faces the neighbour across it", () => {
    // Edge order is E, SE, SW, W, NW, NE, so neighbour k and neighbour k+3 face each other.
    const w = 6;
    const h = 6;
    for (const c of [14, 15, 20, 21]) {
      const nb = neighbours(w, h, c);
      nb.forEach((n, k) => expect(neighbours(w, h, n)[(k + 3) % 6]).toBe(c));
    }
  });
});

describe("map generation", () => {
  const cases: [number, number][] = [];
  for (const territories of [8, 12, 18, 24, 36, 48, 64]) for (let seed = 1; seed <= 12; seed++) cases.push([seed * 7919, territories]);

  it.each(cases)("seed %i with %i territories: connected, no tiny territories", (seed, territories) => {
    const map = generateMap(seed, territories);
    expect(map.adj).toHaveLength(territories);
    expect(map.cells).toHaveLength(map.w * map.h);
    expect(isConnected(map.adj)).toBe(true);
    const sizes = territorySizes(map);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MIN_CELLS);
    // Every territory borders another, and the stored neighbour lists match the cells.
    expect(map.adj.every((a) => a.length > 0)).toBe(true);
    expect(adjacency(map.w, map.h, map.cells, territories)).toEqual(map.adj);
    // Each territory's dice stand inside it.
    map.anchor.forEach((cell, t) => expect(map.cells[cell]).toBe(t));
  });

  it("averages 20–25 cells a territory, with some sea", () => {
    for (const territories of [12, 36, 64]) {
      const map = generateMap(42, territories);
      const sizes = territorySizes(map);
      const avg = sizes.reduce((a, b) => a + b, 0) / territories;
      expect(avg).toBeGreaterThanOrEqual(20);
      expect(avg).toBeLessThanOrEqual(25);
      expect(map.cells.filter((c) => c < 0).length).toBeGreaterThan(map.cells.length * 0.25);
    }
  });

  it("is the same map for the same seed", () => {
    expect(generateMap(1234, 24)).toEqual(generateMap(1234, 24));
    expect(generateMap(1234, 24).cells).not.toEqual(generateMap(1235, 24).cells);
  });

  it("neighbour lists are symmetric", () => {
    const map = generateMap(99, 30);
    map.adj.forEach((list, t) => list.forEach((u) => expect(map.adj[u]).toContain(t)));
  });
});
