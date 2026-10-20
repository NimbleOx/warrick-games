import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { apply, decode, generate } from "../src/shared/ai";
import { CELLS, RING, cellAt, cellName, cellNamed, cellNear, centre, mirror, step } from "../src/shared/hex";
import {
  EMPTY,
  LAYOUT_IDS,
  MARBLES,
  count,
  legalShoves,
  lineOf,
  newBoard,
  play,
  shove,
  type Move,
  type Shove,
} from "../src/shared/rules";

const E = 0;
const NE = 1;
const NW = 2;
const W = 3;
const SW = 4;
const SE = 5;

/** A board with the named holes filled: `x` for seat 0, `o` for seat 1. */
function board(x: string, o = ""): number[] {
  const b = new Array<number>(CELLS).fill(EMPTY);
  for (const n of x.split(" ").filter(Boolean)) b[cellNamed(n)] = 0;
  for (const n of o.split(" ").filter(Boolean)) b[cellNamed(n)] = 1;
  return b;
}

const cells = (names: string) => names.split(" ").map(cellNamed);
const move = (names: string, dir: number): Move => ({ marbles: cells(names), dir });
const names = (cs: number[]) => cs.map(cellName).join(" ");

function ok(b: number[], seat: number, m: Move): Shove {
  const sh = shove(b, seat, m);
  if (typeof sh === "string") throw new Error(sh);
  return sh;
}

describe("the board", () => {
  it("has 61 holes, 5 to a side, named A1 to I9", () => {
    expect(CELLS).toBe(61);
    expect(RING.filter((r) => r === 4)).toHaveLength(24);
    expect(cellName(0)).toBe("I5");
    expect(cellName(60)).toBe("A5");
    expect(cellName(cellAt(0, 0))).toBe("E5");
    for (let c = 0; c < CELLS; c++) expect(cellNamed(cellName(c))).toBe(c);
    expect(cellNamed("A6")).toBe(-1);
    expect(cellNamed("J1")).toBe(-1);
  });

  it("knows its neighbours, its mirror and where each hole is", () => {
    const e5 = cellNamed("E5");
    expect(names([0, 1, 2, 3, 4, 5].map((d) => step(e5, d)))).toBe("E6 F6 F5 E4 D4 D5");
    expect(step(cellNamed("A1"), SW)).toBe(-1);
    expect(cellName(mirror(cellNamed("A1")))).toBe("I9");
    for (let c = 0; c < CELLS; c++) {
      const { x, y } = centre(c);
      expect(cellNear(x + 0.2, y - 0.2)).toBe(c);
    }
    expect(cellNear(10, 0)).toBe(-1);
  });

  it("starts each layout with 14 marbles each, the second player's mirroring the first's", () => {
    for (const layout of LAYOUT_IDS) {
      const b = newBoard(layout);
      expect(count(b, 0)).toBe(MARBLES);
      expect(count(b, 1)).toBe(MARBLES);
      // The classic layout mirrors through the middle; the daisies mirror left to right.
      const flip = (c: number) => (layout === "standard" ? mirror(c) : cellAt(-centreQ(c) - centreR(c), centreR(c)));
      for (let c = 0; c < CELLS; c++) if (b[c] === 0) expect(b[flip(c)]).toBe(1);
    }
    expect(
      names(cells("C3 C4 C5"))
        .split(" ")
        .every((n) => newBoard("standard")[cellNamed(n)] === 0),
    ).toBe(true);
  });
});

function centreQ(c: number) {
  const { x, y } = centre(c);
  return Math.round(x - y / Math.sqrt(3));
}
function centreR(c: number) {
  return Math.round((centre(c).y * 2) / Math.sqrt(3));
}

describe("lines", () => {
  it("takes 1 to 3 marbles side by side in a straight line, in any order", () => {
    expect(lineOf(cells("E5"))).toEqual({ ordered: cells("E5"), axis: -1 });
    expect(lineOf(cells("E7 E5 E6"))).toMatchObject({ ordered: cells("E5 E6 E7") });
    expect(lineOf(cells("C3 E5 D4"))).toMatchObject({ ordered: cells("C3 D4 E5") });
    expect(lineOf(cells("E5 E7"))).toBeNull();
    expect(lineOf(cells("E5 E6 F6"))).toBeNull();
  });
});

describe("moves", () => {
  it("moves one marble to any empty neighbour", () => {
    const b = board("E5");
    for (let d = 0; d < 6; d++) expect(ok(b, 0, move("E5", d))).toMatchObject({ inline: true, pushed: [], off: -1 });
    expect(shove(b, 1, move("E5", E))).toBe("Those aren't all your marbles");
    expect(shove(board("A1"), 0, move("A1", SW))).toBe("You can't push your own marbles off the board");
  });

  it("slides a line along itself, front marble first", () => {
    const b = board("E4 E5 E6");
    expect(ok(b, 0, move("E5 E4 E6", E)).marbles).toEqual(cells("E6 E5 E4"));
    expect(ok(b, 0, move("E5 E4 E6", W)).marbles).toEqual(cells("E4 E5 E6"));
    const after = [...b];
    play(after, 0, ok(b, 0, move("E4 E5 E6", E)));
    expect(after).toEqual(board("E5 E6 E7"));
  });

  it("side-steps a line only into empty holes", () => {
    const b = board("E4 E5 E6", "F6");
    expect(ok(b, 0, move("E4 E5 E6", SE))).toMatchObject({ inline: false, pushed: [] });
    expect(shove(b, 0, move("E4 E5 E6", NE))).toBe("A side step needs an empty hole in front of every marble");
    expect(shove(board("A1 A2"), 0, move("A1 A2", SE))).toBe("You can't move off the board");
    const after = [...b];
    play(after, 0, ok(b, 0, move("E4 E5 E6", SW)));
    expect(after).toEqual(board("D3 D4 D5", "F6"));
  });

  it("won't move more than three, or a line that isn't one", () => {
    expect(shove(board("E2 E3 E4 E5"), 0, move("E2 E3 E4", E))).toBe("You can move at most 3 marbles at once");
    expect(shove(board("E3 E4 E5"), 0, move("E3 E4", E))).toBe("One of your own marbles is in the way");
    expect(shove(board("E3 E4 E5 E6"), 0, move("E3 E4 E5 E6", E))).toBe("Pick 1 to 3 of your marbles");
    expect(shove(board("E3 E5"), 0, move("E3 E5", E))).toBe("Pick marbles in a straight line, side by side");
    expect(shove(board("E3"), 0, move("E3 E3", E))).toBe("Pick 1 to 3 of your marbles");
    expect(shove(board("E3"), 0, { marbles: cells("E3"), dir: 6 })).toBe("That's not a direction");
  });

  it("pushes with more marbles than the other side: 2 push 1, 3 push 1 or 2", () => {
    expect(ok(board("E3 E4", "E5"), 0, move("E3 E4", E))).toMatchObject({ pushed: cells("E5"), off: -1 });
    expect(ok(board("E2 E3 E4", "E5 E6"), 0, move("E2 E3 E4", E))).toMatchObject({ pushed: cells("E5 E6"), off: -1 });
    expect(shove(board("E4", "E5"), 0, move("E4", E))).toBe(
      "One marble can't push: you need more marbles in the line than they have",
    );
    expect(shove(board("E3 E4", "E5 E6"), 0, move("E3 E4", E))).toBe(
      "Two can't push two: you need more marbles in the line than they have",
    );
    expect(shove(board("E2 E3 E4", "E5 E6 E7"), 0, move("E2 E3 E4", E))).toBe(
      "Three can't push three: you need more marbles in the line than they have",
    );
    // Sideways never pushes.
    expect(shove(board("E3 E4", "F5"), 0, move("E3 E4", NE))).toBe("A side step needs an empty hole in front of every marble");
  });

  it("can't push into one of your own", () => {
    expect(shove(board("E2 E3 E4 E6", "E5"), 0, move("E2 E3 E4", E))).toBe("Blocked: one of your marbles is behind theirs");
  });

  it("pushes a marble off the edge", () => {
    const b = board("E6 E7 E8", "E9");
    const sh = ok(b, 0, move("E6 E7 E8", E));
    expect(sh).toMatchObject({ pushed: cells("E9"), off: cellNamed("E9") });
    play(b, 0, sh);
    expect(b).toEqual(board("E7 E8 E9"));
    const two = board("A1 B2 C3", "D4 E5");
    expect(ok(two, 0, move("A1 B2 C3", NE)).off).toBe(-1);
    const edge = board("E5 F6 G7", "H8 I9");
    const off = ok(edge, 0, move("E5 F6 G7", NE));
    expect(off.off).toBe(cellNamed("I9"));
    play(edge, 0, off);
    expect(edge).toEqual(board("F6 G7 H8", "I9"));
  });

  it("lists every legal move of the opening", () => {
    const b = newBoard("standard");
    const all = legalShoves(b, 0);
    expect(all.length).toBe(44);
    expect(all.every((sh) => sh.pushed.length === 0)).toBe(true);
  });
});

describe("the CPU's own move generator", () => {
  const key = (m: Move, seat: number, b: number[]) => {
    const sh = shove(b, seat, m);
    if (typeof sh === "string") throw new Error(`${names(m.marbles)} ${m.dir}: ${sh}`);
    return `${[...sh.marbles].sort((x, y) => x - y).join(",")}>${sh.dir}`;
  };

  it("finds exactly the rules' legal moves, and makes them the same way, all through random games", () => {
    const rng = mulberry32(7);
    const buf = new Int32Array(1024);
    let positions = 0;
    let pushes = 0;
    let offs = 0;
    for (let g = 0; g < 30; g++) {
      const b = newBoard(LAYOUT_IDS[g % 3]);
      for (let ply = 0; ply < 160 && count(b, 0) > 8 && count(b, 1) > 8; ply++) {
        const seat = ply % 2;
        const rules = legalShoves(b, seat);
        const n = generate(Int8Array.from(b), seat, buf);
        const fast = Array.from(buf.subarray(0, n));
        expect(new Set(fast.map((c) => key(decode(c), seat, b)))).toEqual(
          new Set(rules.map((sh) => `${[...sh.marbles].sort((x, y) => x - y).join(",")}>${sh.dir}`)),
        );
        expect(fast.length).toBe(rules.length);
        positions++;
        // Prefer pushes, so the test sees plenty of them.
        const pushing = fast.filter((c) => c >> 13);
        const code = pushing.length && rng() < 0.7 ? pushing[Math.floor(rng() * pushing.length)] : fast[Math.floor(rng() * n)];
        const sh = shove(b, seat, decode(code)) as Shove;
        pushes += sh.pushed.length ? 1 : 0;
        offs += sh.off >= 0 ? 1 : 0;
        const fastBoard = Int8Array.from(b);
        apply(fastBoard, seat, code);
        play(b, seat, sh);
        expect(Array.from(fastBoard)).toEqual(b);
      }
    }
    expect(positions).toBeGreaterThan(1000);
    expect(pushes).toBeGreaterThan(100);
    expect(offs).toBeGreaterThan(20);
  });
});

// Directions used above by name.
void [NE, NW, W, SW, SE];
