import { describe, expect, it } from "vitest";
import { ODDS, winChance } from "../src/shared/odds";

/** Brute force: every roll of a dice against b dice. */
function bruteForce(a: number, b: number): number {
  const totals = (n: number): number[] => {
    let sums = [0];
    for (let i = 0; i < n; i++) sums = sums.flatMap((s) => [1, 2, 3, 4, 5, 6].map((f) => s + f));
    return sums;
  };
  const att = totals(a);
  const def = totals(b);
  let wins = 0;
  for (const x of att) for (const y of def) if (x > y) wins++;
  return wins / (att.length * def.length);
}

describe("odds table", () => {
  it("matches the design doc", () => {
    expect(winChance(2, 2)).toBeCloseTo(0.4437, 4); // 575/1296: ties go to the defender
    expect(winChance(3, 2)).toBeCloseTo(0.7785, 4);
    expect(winChance(8, 8)).toBeCloseTo(0.4708, 3);
  });

  it("is exact for small stacks", () => {
    for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) expect(ODDS[a][b]).toBeCloseTo(bruteForce(a, b), 12);
    expect(ODDS[2][2]).toBeCloseTo(575 / 1296, 12);
  });

  it("is 8 × 8 and favours the defender when even", () => {
    for (let a = 1; a <= 8; a++) {
      expect(ODDS[a]).toHaveLength(9);
      expect(ODDS[a][a]).toBeLessThan(0.5);
      for (let b = 1; b <= 8; b++) {
        expect(ODDS[a][b]).toBeGreaterThanOrEqual(0);
        expect(ODDS[a][b]).toBeLessThan(1);
        // More attackers always help, more defenders always hurt (once a win is possible at all).
        if (a < 8) expect(ODDS[a + 1][b]).toBeGreaterThan(ODDS[a][b]);
        if (b < 8 && ODDS[a][b] > 0) expect(ODDS[a][b + 1]).toBeLessThan(ODDS[a][b]);
      }
    }
    expect(winChance(1, 8)).toBe(0); // 1 die can never beat 8
  });
});
