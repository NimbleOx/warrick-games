import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { chooseMove } from "../src/shared/ai";
import { CELLS, cellNamed } from "../src/shared/hex";
import { EMPTY, legalShoves, newBoard, play, shove, type Shove } from "../src/shared/rules";
import { playGame } from "./sim";

function board(x: string, o: string): number[] {
  const b = new Array<number>(CELLS).fill(EMPTY);
  for (const n of x.split(" ").filter(Boolean)) b[cellNamed(n)] = 0;
  for (const n of o.split(" ").filter(Boolean)) b[cellNamed(n)] = 1;
  return b;
}

describe("CPU players", () => {
  it("push a marble off when they can", () => {
    // Real games never have fewer than 9 marbles a side: back rows fill them up.
    const b = board("E6 E7 E8 A1 A2 A3 A4 A5 B1 B2 B3 B4", "E9 I5 I6 I7 I8 I9 H4 H5 H6 H7 H8");
    for (const level of ["normal", "hard"] as const) {
      for (let seed = 0; seed < 5; seed++) {
        const m = chooseMove(b, 0, level, mulberry32(seed))!;
        expect((shove(b, 0, m) as Shove).off).toBe(cellNamed("E9"));
      }
    }
  });

  it("move a marble out of a push off the edge", () => {
    // Three of theirs line up behind one of yours on the edge.
    const b = board("E9 A1 A2 A3 A4 A5 B1 B2 B3 B4 B5 B6", "E6 E7 E8 I5 I6 I7 I8 I9 H4 H5 H6 H7");
    for (const level of ["normal", "hard"] as const) {
      for (let seed = 0; seed < 5; seed++) {
        const after = [...b];
        play(after, 0, shove(b, 0, chooseMove(b, 0, level, mulberry32(seed))!) as Shove);
        expect(legalShoves(after, 1).filter((sh) => sh.off >= 0)).toEqual([]);
      }
    }
  });

  it("always have a move from the start, and play legal ones through a game", () => {
    for (const level of ["easy", "normal", "hard"] as const) {
      expect(chooseMove(newBoard("standard"), 0, level, mulberry32(1))).not.toBeNull();
    }
    // playGame throws on an illegal move.
    const r = playGame(["easy", "normal"], "belgian", mulberry32(11), 120);
    expect(r.turns).toBeGreaterThan(0);
  });
});
