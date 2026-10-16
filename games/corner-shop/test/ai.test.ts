import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { chooseMove } from "../src/shared/ai";
import { TOTAL_SQUARES } from "../src/shared/pieces";
import { hasLegalMove, layoutFor, newPosition, placementError, play, squaresPlaced, type Position } from "../src/shared/rules";
import type { CpuLevel } from "../src/shared/protocol";

/** Play a whole game between CPUs, checking every move they pick. Returns squares placed per seat. */
function playOut(levels: CpuLevel[], seed: number): { placed: number[]; moves: number; pos: Position } {
  const rng = mulberry32(seed);
  let pos = newPosition(layoutFor(levels.length));
  const out = levels.map(() => false);
  let moves = 0;
  for (let turn = 0; out.some((o) => !o); turn = (turn + 1) % levels.length) {
    if (out[turn]) continue;
    const order = levels.map((_, s) => s).filter((s) => !out[s]);
    const move = chooseMove(pos, turn, levels[turn], rng, order);
    if (!move) {
      expect(hasLegalMove(pos, turn)).toBe(false);
      out[turn] = true;
      continue;
    }
    expect(placementError(pos, turn, move)).toBeNull();
    pos = play(pos, turn, move);
    moves++;
    if (!pos.trays[turn].length) out[turn] = true;
  }
  return { placed: levels.map((_, s) => squaresPlaced(pos.trays[s])), moves, pos };
}

describe("CPU players", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    it(`${level} only ever plays legal moves`, () => {
      for (const [n, seed] of [
        [2, 1],
        [3, 2],
        [4, 3],
      ] as const) {
        const { moves, placed } = playOut(Array(n).fill(level), seed);
        expect(moves).toBeGreaterThan(n * 8);
        expect(placed.every((p) => p > 0 && p <= TOTAL_SQUARES)).toBe(true);
      }
    });
  }

  it("get stronger with each level", () => {
    let normalBeatsEasy = 0;
    let hardBeatsNormal = 0;
    const games = 6;
    for (let g = 0; g < games; g++) {
      // Swap seats every other game so going first doesn't decide it.
      const a = playOut(g % 2 ? ["easy", "normal"] : ["normal", "easy"], 100 + g).placed;
      if ((g % 2 ? a[1] - a[0] : a[0] - a[1]) > 0) normalBeatsEasy++;
      const b = playOut(g % 2 ? ["normal", "hard"] : ["hard", "normal"], 200 + g).placed;
      if ((g % 2 ? b[1] - b[0] : b[0] - b[1]) > 0) hardBeatsNormal++;
    }
    expect(normalBeatsEasy).toBeGreaterThanOrEqual(5);
    expect(hardBeatsNormal).toBeGreaterThanOrEqual(4);
  });

  it("save the monomino for last when they can", () => {
    // Normal and hard never play the monomino while other pieces fit... unless it's all that fits.
    const rng = mulberry32(9);
    let pos = newPosition(layoutFor(4));
    for (let turn = 0; turn < 12; turn++) {
      const seat = turn % 4;
      const move = chooseMove(pos, seat, "normal", rng, [0, 1, 2, 3])!;
      expect(move.piece).not.toBe("1");
      pos = play(pos, seat, move);
    }
  });

  it("think fast enough", () => {
    const rng = mulberry32(5);
    let pos = newPosition(layoutFor(4));
    // Get to a busy middle game, then time the hard CPU.
    for (let turn = 0; turn < 32; turn++) {
      const move = chooseMove(pos, turn % 4, "normal", rng, [0, 1, 2, 3]);
      if (move) pos = play(pos, turn % 4, move);
    }
    const t0 = performance.now();
    for (let seat = 0; seat < 4; seat++) chooseMove(pos, seat, "hard", rng, [0, 1, 2, 3]);
    expect((performance.now() - t0) / 4).toBeLessThan(400);
  });
});
