import { describe, expect, it } from "vitest";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { choose, type CpuLevel } from "../src/shared/ai";
import { Board, Lane } from "../src/shared/engine";

/** Play a lane alone until it's stuck (or for a while) and return its biggest tile's exponent. */
function solo(level: CpuLevel, seed: number, moves = 600): number {
  const lane = new Lane(seed, 4);
  const rng = mulberry32(seed);
  for (let i = 0; i < moves && !lane.out; i++) {
    const d = choose(lane, level, rng);
    if (d === null || !lane.move(d, 0)) break;
  }
  return lane.best;
}

describe("CPU players", () => {
  it("only picks moves that do something, and none when stuck", () => {
    const rng = mulberry32(1);
    const lane = new Lane(1, 4);
    for (let i = 0; i < 50; i++) {
      const d = choose(lane, "normal", rng)!;
      expect(lane.canSlide(d)).toBe(true);
      lane.move(d, 0);
    }
    const stuck = new Lane(1, 4);
    stuck.board = new Board(4, [1, 2, 1, 2, 2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, -1]);
    expect(choose(stuck, "hard", rng)).toBeNull();
  });

  it("gets better with the level", () => {
    const avg = (level: CpuLevel) => {
      let total = 0;
      for (let s = 1; s <= 6; s++) total += solo(level, s * 101);
      return total / 6;
    };
    const easy = avg("easy");
    const normal = avg("normal");
    const hard = avg("hard");
    expect(normal).toBeGreaterThan(easy);
    expect(hard).toBeGreaterThanOrEqual(normal);
    // Normal and up make at least a 256 on their own within 600 moves.
    expect(normal).toBeGreaterThanOrEqual(8);
  });
});
