import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { cpuMove, timeoutMove } from "../src/shared/ai";
import { NONE, cloneBoard, isOver, newBoard, playLine, undrawnLines, type Board } from "../src/shared/board";
import { capturable, giveaway, isSafe, lastSide, safeLines } from "../src/shared/chains";
import { board, box, hEdge, vEdge } from "./helpers";

const rng = () => mulberry32(42);
const LEVELS = ["easy", "normal", "hard"] as const;

/**
 * A 7 × 4 endgame: a chain of 6 across the top, 20 claimed boxes, and two boxes at the
 * bottom left. `tail` is either the last two boxes of an opened chain (the left one ready to
 * take) or an unopened 2-chain. `ones` and `twos` say who holds the claimed boxes.
 */
function endgameBoard(tail: "opened" | "closed", owners = "0000000000" + "1111111111"): Board {
  const d = owners.split("");
  const row = (from: number) => d.slice(from, from + 7).join("|");
  return board(`
    +-+-+-+-+-+ +-+
                |${d[0]}|
    +-+-+-+-+-+-+-+
    |${row(1)}|
    +-+-+-+-+-+-+-+
    |${row(8)}|
    +-+-+-+-+-+-+-+
    ${tail === "opened" ? "|" : " "}   |${d.slice(15, 20).join("|")}|
    +-+ +-+-+-+-+-+
  `);
}

describe("every level", () => {
  it("completes a box when it can", () => {
    const b = board(`
      +-+-+ + +
      |
      +-+ + + +
    `);
    for (const level of LEVELS) expect(cpuMove(b, 2, 0, level, rng())).toBe(vEdge(b, 0, 1));
  });

  it("plays a whole game to the end", () => {
    for (const level of LEVELS) {
      const b = newBoard(6, 5);
      const r = rng();
      let seat = 0;
      for (let moves = 0; !isOver(b); moves++) {
        expect(moves).toBeLessThan(b.lines.length);
        const e = cpuMove(b, 3, seat, level, r);
        expect(b.lines[e]).toBe(NONE);
        if (!playLine(b, e, seat).length) seat = (seat + 1) % 3;
      }
    }
  });
});

describe("normal", () => {
  it("never draws a box's third side while a safe line exists", () => {
    const r = mulberry32(7);
    for (let game = 0; game < 20; game++) {
      const b = newBoard(5, 4);
      let seat = 0;
      while (!isOver(b)) {
        const safe = safeLines(b).length > 0 && capturable(b).length === 0;
        const e = cpuMove(b, 2, seat, "normal", r);
        if (safe) expect(isSafe(b, e)).toBe(true);
        if (!playLine(b, e, seat).length) seat = 1 - seat;
      }
    }
  });

  it("opens the shortest chain when it has to", () => {
    const b = endgameBoard("closed");
    expect(safeLines(b)).toEqual([]);
    for (let i = 0; i < 10; i++) expect(giveaway(b, cpuMove(b, 2, 0, "normal", mulberry32(i)))).toBe(2);
  });

  it("takes every box, never declining", () => {
    const b = endgameBoard("opened");
    expect(cpuMove(b, 2, 0, "normal", rng())).toBe(vEdge(b, 3, 1));
  });
});

describe("hard", () => {
  it("declines the last two boxes of a chain to keep control", () => {
    // Taking both would mean opening the 6-chain for the opponent. Declining gives them 2,
    // and they have to open it instead.
    const b = endgameBoard("opened");
    expect(cpuMove(b, 2, 0, "hard", rng())).toBe(hEdge(b, 4, 1));
  });

  it("takes the last two boxes when nothing is left to control", () => {
    const b = board(`
      +-+-+-+
      |   |1|
      +-+ +-+
    `);
    expect(cpuMove(b, 2, 0, "hard", rng())).toBe(vEdge(b, 0, 1));
  });

  it("opens a 2-chain in the middle so it can't be declined", () => {
    const b = endgameBoard("closed");
    expect(cpuMove(b, 2, 0, "hard", rng())).toBe(vEdge(b, 3, 1));
  });

  it("with three players, weighs who gets the next chain", () => {
    // Seat 0 (hard) can take the 2 and open the 6-chain, which goes to seat 1, or decline, so
    // seat 1 gets the 2 and opens the 6-chain for seat 2. It hands the big chain to whoever
    // isn't its main rival.
    const leaderNext = endgameBoard("opened", "0000000000" + "1111111111");
    expect(cpuMove(leaderNext, 3, 0, "hard", rng())).toBe(hEdge(leaderNext, 4, 1));
    const leaderAfter = endgameBoard("opened", "0000000000" + "2222222222");
    expect(cpuMove(leaderAfter, 3, 0, "hard", rng())).toBe(vEdge(leaderAfter, 3, 1));
  });

  it("plays for the long-chain rule in the last safe lines", () => {
    // The two boxes on the right can take two or three more safe lines, depending on whether
    // the line between them is drawn. Hard has to leave an odd number so its opponent opens.
    const b = board(`
      +-+ + +
      |0|
      +-+ + +
    `);
    expect(safeLines(b)).toHaveLength(6);
    const best = Math.max(...undrawnLines(b).map((e) => valueOf(b, e)));
    for (let i = 0; i < 10; i++) expect(valueOf(b, cpuMove(b, 2, 0, "hard", mulberry32(i)))).toBe(best);
    expect(best).toBe(2);
  });

  it("matches perfect play in small endgames", () => {
    // A loop and a chain: open the loop, so keeping control costs the receiver too much.
    const loopAndChain = board(`
      +-+-+ +-+-+
      |   |
      + + +-+-+-+
      |   |0|0|0|
      +-+-+-+-+-+
    `);
    // Two 3-chains and a single box: give away the single box first and keep control.
    const tempo = board(`
      +-+-+ + + +-+-+
            | |
      +-+-+-+ +-+-+-+
    `);
    for (const b of [loopAndChain, tempo]) {
      expect(safeLines(b)).toEqual([]);
      const best = Math.max(...undrawnLines(b).map((e) => valueOf(b, e)));
      for (let i = 0; i < 5; i++) expect(valueOf(b, cpuMove(b, 2, 0, "hard", mulberry32(i)))).toBe(best);
    }
    expect(Math.max(...undrawnLines(tempo).map((e) => valueOf(tempo, e)))).toBe(1);
  });
});

// The slowest moment of a run is a noisy measure, and shared CI machines are slower than a laptop:
// give CI headroom (it's still well under what the old code took). No Node types here, hence the cast.
const ci = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI;
const slack = ci ? 2.5 : 1;

describe("thinking time", () => {
  it("stays quick for hard with 8 players on the largest board", () => {
    // Whole games between hard CPUs on 11 × 8. These seeds reach the slowest decisions found,
    // where the endgame model has the most to look at.
    let slowest = 0;
    for (const seed of [23, 15]) {
      const r = mulberry32(seed);
      const b = newBoard(11, 8);
      let seat = 0;
      while (!isOver(b)) {
        const t0 = performance.now();
        const e = cpuMove(b, 8, seat, "hard", r);
        slowest = Math.max(slowest, performance.now() - t0);
        if (!playLine(b, e, seat).length) seat = (seat + 1) % 8;
      }
    }
    expect(slowest).toBeLessThan(200 * slack);
  });
});

describe("running out of time", () => {
  it("takes the boxes it can first", () => {
    const b = endgameBoard("opened");
    expect(timeoutMove(b, rng())).toBe(lastSide(b, box(b, 3, 0)));
  });

  it("draws a safe line when there is one", () => {
    for (let i = 0; i < 20; i++) {
      const b = newBoard(4, 4);
      const r = mulberry32(i);
      // Some random safe lines first.
      for (let k = 0; k < 8; k++) {
        const safe = safeLines(b);
        if (safe.length) playLine(b, safe[Math.floor(r() * safe.length)], 0);
      }
      if (!safeLines(b).length) continue;
      expect(isSafe(b, timeoutMove(b, r))).toBe(true);
    }
  });

  it("otherwise gives away as little as it can", () => {
    const b = endgameBoard("closed");
    expect(giveaway(b, timeoutMove(b, rng()))).toBe(2);
  });
});

// ------------------------------------------------------------------ perfect play, by brute force

/** For two players: how many more boxes than the opponent the mover ends with, after drawing `e`. */
function valueOf(b: Board, e: number): number {
  const after = cloneBoard(b);
  const n = playLine(after, e, 0).length;
  const rest = solve(after, new Map());
  return n ? n + rest : -rest;
}

function solve(b: Board, memo: Map<string, number>): number {
  if (isOver(b)) return 0;
  const key = b.lines.map((l) => (l === NONE ? "0" : "1")).join("");
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let best = -Infinity;
  for (const e of undrawnLines(b)) {
    const after = cloneBoard(b);
    const n = playLine(after, e, 0).length;
    const v = n ? n + solve(after, memo) : -solve(after, memo);
    if (v > best) best = v;
  }
  memo.set(key, best);
  return best;
}
