import { describe, expect, it } from "vitest";
import { MAP_LIST, mapsFor, type MapDef } from "../src/shared/maps";
import { distanceField, tileOf } from "../src/shared/rules";
import { MAX_SEATS } from "../src/shared/constants";

/** The terrain and the building (kind and owner) on a tile, with seats renamed by `seats`. */
function cell(m: MapDef, x: number, y: number, seats: number[] = []): string {
  const t = tileOf(m, x, y);
  const bi = m.buildingAt[t];
  if (bi < 0) return m.tiles[t];
  const o = m.buildings[bi].owner;
  return `${m.tiles[t]}:${o < 0 ? -1 : (seats[o] ?? o)}`;
}

function eachTile(m: MapDef, f: (x: number, y: number) => void): void {
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) f(x, y);
}

describe("maps", () => {
  it("has maps for every player count, small enough for a phone", () => {
    for (let p = 2; p <= MAX_SEATS; p++) expect(mapsFor(p).length).toBeGreaterThan(0);
    expect(mapsFor(2).length).toBeGreaterThanOrEqual(2);
    for (const m of MAP_LIST) {
      expect(m.w).toBeLessThanOrEqual(20);
      expect(m.h).toBeLessThanOrEqual(15);
      expect(m.tiles).toHaveLength(m.w * m.h);
    }
  });

  it("gives every seat one HQ and a factory", () => {
    for (const m of MAP_LIST) {
      for (let seat = 0; seat < m.players; seat++) {
        const owned = m.buildings.filter((b) => b.owner === seat);
        expect(owned.filter((b) => b.kind === "hq"), `${m.id} seat ${seat + 1}`).toHaveLength(1);
        expect(owned.some((b) => b.kind === "factory"), `${m.id} seat ${seat + 1}`).toBe(true);
        expect(m.buildings[m.hq[seat]].kind).toBe("hq");
      }
    }
  });

  it("is symmetric, so every seat starts the same", () => {
    for (const m of MAP_LIST) {
      eachTile(m, (x, y) => {
        if (m.players === 2) {
          // A half turn swaps the two seats.
          expect(cell(m, m.w - 1 - x, m.h - 1 - y, [1, 0]), `${m.id} ${x},${y}`).toBe(cell(m, x, y));
        } else if (m.players === 4) {
          // Seats 1 2 / 4 3: left-right swaps 1↔2 and 3↔4, top-bottom swaps 1↔4 and 2↔3.
          expect(cell(m, m.w - 1 - x, y, [1, 0, 3, 2]), `${m.id} ${x},${y}`).toBe(cell(m, x, y));
          expect(cell(m, x, m.h - 1 - y, [3, 2, 1, 0]), `${m.id} ${x},${y}`).toBe(cell(m, x, y));
        } else {
          // Left-right swaps seats 1 and 2; seat 3 sits on the axis.
          expect(cell(m, m.w - 1 - x, y, [1, 0, 2]), `${m.id} ${x},${y}`).toBe(cell(m, x, y));
        }
      });
      if (m.players === 3) {
        const hq3 = m.buildings[m.hq[2]];
        expect(hq3.x).toBe((m.w - 1) / 2);
        const counts = [0, 1, 2].map((s) => m.buildings.filter((b) => b.owner === s).length);
        expect(new Set(counts).size).toBe(1);
      }
    }
  });

  it("lets infantry walk from every HQ to every building", () => {
    for (const m of MAP_LIST) {
      for (let seat = 0; seat < m.players; seat++) {
        const hq = m.buildings[m.hq[seat]];
        const d = distanceField(m, "foot", [tileOf(m, hq.x, hq.y)]);
        for (const b of m.buildings) expect(Number.isFinite(d[tileOf(m, b.x, b.y)]), `${m.id} ${b.x},${b.y}`).toBe(true);
      }
    }
  });
});
