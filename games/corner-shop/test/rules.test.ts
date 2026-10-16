import { describe, expect, it } from "vitest";
import {
  MONOMINO,
  ORIENTATION_COUNT,
  PIECES,
  PIECE_IDS,
  TOTAL_SQUARES,
  flipT,
  orientFor,
  orientations,
  rotateT,
  transformCells,
  type PieceId,
} from "../src/shared/pieces";
import {
  EMPTY,
  anchors,
  hasLegalMove,
  layoutFor,
  legalMoves,
  moveCells,
  newPosition,
  placementError,
  play,
  scoreFor,
  type Move,
  type Position,
} from "../src/shared/rules";

/** Find the orientation of `piece` whose cells are exactly `cells`. */
function orientOf(piece: PieceId, cells: [number, number][]): number {
  const key = JSON.stringify([...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]));
  const i = orientations(piece).findIndex((o) => JSON.stringify(o.cells) === key);
  if (i < 0) throw new Error(`no orientation of ${piece} like ${key}`);
  return i;
}

/** Fill squares by hand: "x,y" list for a seat. */
function paint(pos: Position, seat: number, cells: [number, number][]): Position {
  const out = { ...pos, cells: pos.cells.slice() };
  for (const [x, y] of cells) out.cells[y * pos.size + x] = seat;
  return out;
}

describe("the pieces", () => {
  it("are the 21 polyominoes of 1 to 5 squares", () => {
    expect(PIECES).toHaveLength(21);
    const bySize = [1, 2, 3, 4, 5].map((n) => PIECES.filter((p) => p.cells.length === n).length);
    expect(bySize).toEqual([1, 1, 2, 5, 12]);
    expect(TOTAL_SQUARES).toBe(89);
  });

  it("are all different shapes, even turned over", () => {
    const canon = (cells: readonly (readonly [number, number])[]) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((t) => JSON.stringify(transformCells(cells, t))).sort()[0];
    expect(new Set(PIECES.map((p) => canon(p.cells))).size).toBe(21);
  });

  it("are each one connected piece", () => {
    for (const p of PIECES) {
      const key = (x: number, y: number) => `${x},${y}`;
      const cells = new Set(p.cells.map(([x, y]) => key(x, y)));
      const seen = new Set([key(...p.cells[0])]);
      const stack = [p.cells[0]];
      while (stack.length) {
        const [x, y] = stack.pop()!;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const k = key(x + dx, y + dy);
          if (cells.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push([x + dx, y + dy]);
          }
        }
      }
      expect(seen.size, p.id).toBe(p.cells.length);
    }
  });

  it("have 91 distinct orientations", () => {
    expect(ORIENTATION_COUNT).toBe(91);
    const counts = Object.fromEntries(PIECE_IDS.map((id) => [id, orientations(id).length]));
    expect(counts).toMatchObject({
      "1": 1,
      "2": 2,
      I3: 2,
      V3: 4,
      O4: 1,
      I4: 2,
      T4: 4,
      S4: 4,
      L4: 8,
      X: 1,
      I5: 2,
      F: 8,
      W: 4,
      Z5: 4,
      T5: 4,
      U: 4,
      V5: 4,
    });
  });

  it("rotate and flip like the screen does", () => {
    // The L-tetromino turned a quarter clockwise lies flat with its foot pointing down-left.
    const t = rotateT(0);
    expect(orientations("L4")[orientFor("L4", t)].cells).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ]);
    // Four quarter turns and two flips come back to the start.
    expect(rotateT(rotateT(rotateT(rotateT(5))))).toBe(5);
    expect(flipT(flipT(3))).toBe(3);
    // Flipping mirrors what's on screen, whatever the rotation.
    for (let t = 0; t < 8; t++) {
      const shown = orientations("F")[orientFor("F", t)].cells;
      const w = Math.max(...shown.map((c) => c[0]));
      const mirrored = shown.map(([x, y]) => [w - x, y]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      expect(orientations("F")[orientFor("F", flipT(t))].cells).toEqual(mirrored);
    }
  });
});

describe("placing pieces", () => {
  const four = () => newPosition(layoutFor(4));
  const two = () => newPosition(layoutFor(2));

  it("lays out the boards", () => {
    expect(layoutFor(4)).toEqual({ size: 20, starts: [0, 19, 399, 380] });
    expect(layoutFor(3)).toEqual({ size: 20, starts: [0, 19, 399] });
    expect(layoutFor(2)).toEqual({ size: 14, starts: [4 * 14 + 4, 9 * 14 + 9] });
  });

  it("makes the first piece cover the starting square", () => {
    const pos = four();
    const domino = (x: number, y: number): Move => ({
      piece: "2",
      orient: orientOf("2", [
        [0, 0],
        [1, 0],
      ]),
      x,
      y,
    });
    expect(placementError(pos, 0, domino(0, 0))).toBeNull();
    expect(placementError(pos, 0, domino(1, 0))).toBe("Your first piece must cover your starting square");
    expect(placementError(pos, 1, domino(18, 0))).toBeNull();
    expect(placementError(pos, 1, domino(19, 0))).toBe("That doesn't fit on the board");
    // Duo: the starts are near the middle.
    expect(placementError(two(), 1, domino(8, 9))).toBeNull();
    expect(anchors(two(), 0)).toEqual([4 * 14 + 4]);
  });

  it("only lets your pieces meet at corners", () => {
    let pos = play(four(), 0, { piece: "O4", orient: 0, x: 0, y: 0 }); // (0,0)–(1,1)
    const mono = (x: number, y: number): Move => ({ piece: MONOMINO, orient: 0, x, y });
    expect(placementError(pos, 0, mono(2, 2))).toBeNull();
    expect(placementError(pos, 0, mono(2, 1))).toBe("Your pieces can't touch along an edge");
    expect(placementError(pos, 0, mono(3, 3))).toBe("It must touch one of your pieces at a corner");
    expect(placementError(pos, 0, mono(1, 1))).toBe("That space is taken");
    expect(anchors(pos, 0)).toEqual([2 * 20 + 2]);
    // Other colours can touch yours along an edge.
    pos = paint(pos, 1, [[19, 0]]);
    pos = { ...pos, trays: pos.trays.map((t, s) => (s === 1 ? t.filter((p) => p !== "1") : t)) };
    expect(placementError(pos, 1, { piece: "I4", orient: 0, x: 15, y: 1 })).toBeNull();
    expect(
      placementError(pos, 1, {
        piece: "2",
        orient: orientOf("2", [
          [0, 0],
          [1, 0],
        ]),
        x: 2,
        y: 0,
      }),
    ).toBe("It must touch one of your pieces at a corner");
    pos = paint(pos, 1, [[4, 1]]);
    expect(
      placementError(pos, 1, {
        piece: "2",
        orient: orientOf("2", [
          [0, 0],
          [1, 0],
        ]),
        x: 2,
        y: 0,
      }),
    ).toBeNull();
  });

  it("keeps a player's starting square free until they've started", () => {
    const pos = play(two(), 0, {
      piece: "I5",
      orient: orientOf("I5", [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
      x: 4,
      y: 4,
    });
    // A board where seat 0 could reach seat 1's start: still not allowed.
    const near = paint(pos, 0, [[8, 8]]);
    expect(placementError(near, 0, { piece: MONOMINO, orient: 0, x: 9, y: 9 })).toBe("That's another player's starting square");
    expect(legalMoves(near, 0).some((m) => moveCells(14, m)!.includes(9 * 14 + 9))).toBe(false);
    // Once seat 1 is out (it left before its first piece, say), its start is free for anyone.
    const gone = { ...near, out: [false, true] };
    expect(placementError(gone, 0, { piece: MONOMINO, orient: 0, x: 9, y: 9 })).toBeNull();
    expect(legalMoves(gone, 0).some((m) => moveCells(14, m)!.includes(9 * 14 + 9))).toBe(true);
  });

  it("checks the tray and the orientation", () => {
    const pos = play(four(), 0, { piece: MONOMINO, orient: 0, x: 0, y: 0 });
    expect(placementError(pos, 0, { piece: MONOMINO, orient: 0, x: 1, y: 1 })).toBe("You've already placed that piece");
    expect(placementError(pos, 0, { piece: "X", orient: 1, x: 1, y: 1 })).toBe("That isn't a way that piece can turn");
    expect(moveCells(20, { piece: "X", orient: 0, x: 18, y: 0 })).toBeNull();
  });

  it("generates exactly the legal moves", () => {
    let pos = four();
    // Every first move covers the start: in the corner, one per orientation and cell that fits.
    const first = legalMoves(pos, 0);
    expect(first.every((m) => placementError(pos, 0, m) === null)).toBe(true);
    expect(first.every((m) => moveCells(20, m)!.includes(0))).toBe(true);
    expect(new Set(first.map((m) => JSON.stringify(m))).size).toBe(first.length);

    // After a few pieces: compare against brute force over every spot on the board.
    pos = play(pos, 0, {
      piece: "V5",
      orient: orientOf("V5", [
        [0, 0],
        [0, 1],
        [0, 2],
        [1, 2],
        [2, 2],
      ]),
      x: 0,
      y: 0,
    });
    pos = play(pos, 1, {
      piece: "I5",
      orient: orientOf("I5", [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
      ]),
      x: 19,
      y: 0,
    });
    pos = play(pos, 0, { piece: "X", orient: 0, x: 3, y: 2 });
    expect(pos.cells[2 * 20 + 4]).toBe(0);
    const fast = legalMoves(pos, 0)
      .map((m) => JSON.stringify(m))
      .sort();
    const slow: string[] = [];
    for (const piece of pos.trays[0]) {
      orientations(piece).forEach((_, orient) => {
        for (let y = 0; y < 20; y++)
          for (let x = 0; x < 20; x++) {
            const m = { piece, orient, x, y };
            if (placementError(pos, 0, m) === null) slow.push(JSON.stringify(m));
          }
      });
    }
    expect(fast).toEqual(slow.sort());
    expect(fast.length).toBeGreaterThan(100);
  });

  it("knows when a player is stuck", () => {
    let pos = two();
    expect(hasLegalMove(pos, 0)).toBe(true);
    // Fill every square but seat 0's start: it can't place its first piece anywhere but there,
    // and nothing it has fits.
    pos = { ...pos, cells: pos.cells.map((_, i) => (i === pos.starts[0] ? EMPTY : 1)) as Int8Array };
    expect(hasLegalMove(pos, 0)).toBe(true); // the monomino fits on its start
    pos = { ...pos, trays: [pos.trays[0].filter((p) => p !== MONOMINO), pos.trays[1]] };
    expect(hasLegalMove(pos, 0)).toBe(false);
  });

  it("scores the tray", () => {
    expect(scoreFor([...PIECE_IDS], null)).toBe(-89);
    expect(scoreFor(["X", "1"], "W")).toBe(-6);
    expect(scoreFor([], "W")).toBe(15);
    expect(scoreFor([], MONOMINO)).toBe(20);
  });
});
