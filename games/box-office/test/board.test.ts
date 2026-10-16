import { describe, expect, it } from "vitest";
import { boardSize, boxCounts, boxesLeft, geometry, isOver, newBoard, playLine } from "../src/shared/board";
import { board, box, hEdge, vEdge } from "./helpers";

describe("geometry", () => {
  it("numbers every edge once and links edges and boxes", () => {
    const g = geometry(5, 4);
    expect(g.hCount).toBe(5 * 5);
    expect(g.edgeCount).toBe(5 * 5 + 4 * 6);
    expect(g.boxEdges).toHaveLength(20);
    for (const edges of g.boxEdges) expect(new Set(edges).size).toBe(4);
    // Border edges have one box, inside edges two.
    const counts = g.edgeBoxes.map((b) => b.length);
    expect(counts.filter((n) => n === 1)).toHaveLength(2 * 5 + 2 * 4);
    expect(counts.filter((n) => n === 2)).toHaveLength(g.edgeCount - 18);
    // Edge ends are neighbouring dots.
    for (const [x0, y0, x1, y1] of g.ends) expect(Math.abs(x1 - x0) + Math.abs(y1 - y0)).toBe(1);
  });

  it("sizes the board by the setting and the player count", () => {
    expect(boardSize("medium", 2)).toEqual({ w: 5, h: 5 });
    expect(boardSize("small", 2)).toEqual({ w: 4, h: 4 });
    expect(boardSize("large", 8)).toEqual({ w: 11, h: 8 });
    expect(boardSize("medium", 5)).toEqual({ w: 7, h: 6 });
    // Every size gives each player at least six boxes and grows with the player count.
    for (const size of ["small", "medium", "large"] as const) {
      let prev = 0;
      for (let n = 2; n <= 8; n++) {
        const { w, h } = boardSize(size, n);
        expect(w).toBeGreaterThanOrEqual(h);
        expect(w * h).toBeGreaterThanOrEqual(6 * n);
        expect(w * h).toBeGreaterThanOrEqual(prev);
        prev = w * h;
      }
    }
  });
});

describe("drawing lines", () => {
  it("claims a box with its fourth side", () => {
    const b = newBoard(2, 2);
    expect(playLine(b, hEdge(b, 0, 0), 0)).toEqual([]);
    expect(playLine(b, vEdge(b, 0, 0), 1)).toEqual([]);
    expect(playLine(b, hEdge(b, 1, 0), 0)).toEqual([]);
    expect(b.boxes[box(b, 0, 0)]).toBe(-1);
    // The fourth side, drawn by seat 1: the box is theirs, whoever drew the other three.
    expect(playLine(b, vEdge(b, 0, 1), 1)).toEqual([box(b, 0, 0)]);
    expect(b.boxes[box(b, 0, 0)]).toBe(1);
    expect(boxCounts(b, 2)).toEqual([0, 1]);
    expect(boxesLeft(b)).toBe(3);
  });

  it("completes two boxes with one line", () => {
    const b = board(`
      +-+-+
      |   |
      +-+-+
    `);
    const middle = vEdge(b, 0, 1);
    expect(playLine(b, middle, 1).sort()).toEqual([0, 1]);
    expect(b.boxes).toEqual([1, 1]);
    expect(isOver(b)).toBe(true);
  });

  it("isn't over until every box is claimed", () => {
    const b = board(`
      +-+-+
      |0|
      +-+-+
    `);
    expect(b.boxes).toEqual([0, -1]);
    expect(isOver(b)).toBe(false);
    playLine(b, vEdge(b, 0, 2), 1);
    expect(isOver(b)).toBe(true);
    expect(boxCounts(b, 2)).toEqual([1, 1]);
  });
});
