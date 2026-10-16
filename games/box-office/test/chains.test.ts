import { describe, expect, it } from "vitest";
import { playLine } from "../src/shared/board";
import {
  canDecline,
  capturable,
  components,
  declinePoint,
  giveaway,
  isSafe,
  lastSide,
  safeLines,
  takeAll,
} from "../src/shared/chains";
import { endgame } from "../src/shared/endgame";
import { board, box, hEdge, vEdge } from "./helpers";

const sorted = (cs: { kind: string; size: number }[]) =>
  cs.map((c) => `${c.kind}${c.size}`).sort();

describe("safe lines and captures", () => {
  it("a line that makes a box's third side isn't safe", () => {
    const b = board(`
      +-+ +
      |
      + + +
    `);
    // The left box has two sides drawn, so both its undrawn sides give it away.
    expect(isSafe(b, vEdge(b, 0, 1))).toBe(false);
    expect(isSafe(b, hEdge(b, 1, 0))).toBe(false);
    expect(safeLines(b).sort((x, y) => x - y)).toEqual([hEdge(b, 0, 1), hEdge(b, 1, 1), vEdge(b, 0, 2)].sort((x, y) => x - y));
    expect(capturable(b)).toEqual([]);
  });

  it("finds boxes with three sides drawn and their last side", () => {
    const b = board(`
      +-+-+
      |
      +-+ +
    `);
    expect(capturable(b)).toEqual([box(b, 0, 0)]);
    expect(lastSide(b, box(b, 0, 0))).toBe(vEdge(b, 0, 1));
  });

  it("takes a whole chain, and counts what a line gives away", () => {
    const b = board(`
      +-+-+-+

      +-+-+-+
    `);
    // A chain of 3, open at both ends: any line hands over all three.
    for (const e of [vEdge(b, 0, 0), vEdge(b, 0, 1), vEdge(b, 0, 3)]) expect(giveaway(b, e)).toBe(3);
    playLine(b, vEdge(b, 0, 0), 0);
    const { lines, taken } = takeAll(b, 1);
    expect(lines).toEqual([vEdge(b, 0, 1), vEdge(b, 0, 2), vEdge(b, 0, 3)]);
    expect(taken.sort()).toEqual([0, 1, 2]);
    expect(b.boxes).toEqual([1, 1, 1]);
  });
});

describe("chains and loops", () => {
  it("finds a chain", () => {
    const b = board(`
      +-+-+-+

      +-+-+-+
    `);
    expect(sorted(components(b))).toEqual(["chain3"]);
  });

  it("finds a loop", () => {
    const b = board(`
      +-+-+
      |   |
      + + +
      |   |
      +-+-+
    `);
    expect(sorted(components(b))).toEqual(["loop4"]);
  });

  it("joins a junction's two longest arms", () => {
    // The top middle box has three sides left, each leading to a one-box arm. The first arm
    // taken uses one of its sides up, and the other two arms become a chain of three with it.
    const b = board(`
      +-+-+-+

      +-+ +-+
      |0| |1|
      +-+ +-+
    `);
    expect(sorted(components(b))).toEqual(["chain1", "chain3"]);
    expect(giveaway(b, hEdge(b, 2, 1))).toBe(1);
    const after = board(`
      +-+-+-+

      +-+-+-+
      |0|1|1|
      +-+-+-+
    `);
    expect(sorted(components(after))).toEqual(["chain3"]);
  });

  it("separates several chains and loops", () => {
    const b = board(`
      +-+-+ +-+-+
      |   |
      + + +-+-+-+
      |   |0|0|0|
      +-+-+-+-+-+
    `);
    expect(sorted(components(b))).toEqual(["chain3", "loop4"]);
  });
});

describe("declining", () => {
  it("can decline only at the last two boxes of a chain", () => {
    const b = board(`
      +-+-+-+
      |
      +-+-+-+
    `);
    // Three boxes to take: not yet.
    expect(declinePoint(b)).toBeNull();
    playLine(b, vEdge(b, 0, 1), 0);
    // Two left: drawing the far end leaves both for the next player.
    expect(declinePoint(b)).toEqual({ line: vEdge(b, 0, 3), keep: 2 });
  });

  it("declines the last four boxes of a loop", () => {
    const b = board(`
      +-+-+
      |   |
      + + +
      |   |
      +-+-+
    `);
    playLine(b, vEdge(b, 0, 1), 0);
    expect(capturable(b)).toHaveLength(2);
    expect(declinePoint(b)).toEqual({ line: vEdge(b, 1, 1), keep: 4 });
  });

  it("a 2-chain opened in the middle can't be declined", () => {
    const pic = `
      +-+-+

      +-+-+
    `;
    const middle = board(pic);
    playLine(middle, vEdge(middle, 0, 1), 0);
    expect(canDecline(middle)).toBe(0);
    const end = board(pic);
    playLine(end, vEdge(end, 0, 0), 0);
    expect(canDecline(end)).toBe(2);
  });
});

describe("the endgame model", () => {
  const chain = (size: number) => ({ kind: "chain" as const, size });
  const loop = (size: number) => ({ kind: "loop" as const, size });

  it("two players: the controller declines every chain but the last", () => {
    // Relative to the opener: [opener, receiver].
    expect(endgame([chain(3)], 2)).toEqual([0, 3]);
    expect(endgame([chain(3), chain(3)], 2)).toEqual([2, 4]);
    expect(endgame([chain(5), chain(5), chain(5)], 2)).toEqual([4, 11]);
    // A short chain is a free move: the opener sacrifices it and the receiver opens the long one.
    expect(endgame([chain(1), chain(5)], 2)).toEqual([5, 1]);
    expect(endgame([chain(2), chain(5)], 2)).toEqual([5, 2]);
    // Keeping control through a loop costs four boxes.
    expect(endgame([loop(4), chain(6)], 2)).toEqual([4, 6]);
  });

  it("more players: declining hands the next chain to the player after the receiver", () => {
    expect(endgame([chain(3), chain(3)], 3)).toEqual([0, 3, 3]);
    expect(endgame([chain(3), chain(8)], 3)).toEqual([0, 3, 8]);
  });
});
