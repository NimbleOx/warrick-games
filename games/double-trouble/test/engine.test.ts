import { describe, expect, it } from "vitest";
import { ARM_MOVES, MAX_LAND, ROCK_COST } from "../src/shared/constants";
import { Board, DOWN, LEFT, Lane, RIGHT, UP, movePower, type Dir } from "../src/shared/engine";

/** A 4 × 4 board from rows written top to bottom: numbers are tile values (0 empty), "R" a rock. */
function board(rows: (number | "R")[][]): Board {
  const size = rows.length;
  return new Board(
    size,
    rows.flat().map((v) => (v === "R" ? -1 : v ? Math.log2(v) : 0)),
  );
}

function rows(b: Board): (number | "R")[][] {
  const out: (number | "R")[][] = [];
  for (let y = 0; y < b.size; y++) out.push(b.cells.slice(y * b.size, (y + 1) * b.size).map((v) => (v < 0 ? "R" : v ? 2 ** v : 0)));
  return out;
}

/** A lane with a set board (and no tile spawned yet). */
function laneWith(rowsIn: (number | "R")[][], seed = 1): Lane {
  const lane = new Lane(seed, rowsIn.length);
  lane.board = board(rowsIn);
  return lane;
}

describe("sliding", () => {
  it("merges each tile once, toward the edge", () => {
    const b = board([
      [2, 2, 2, 2],
      [2, 2, 2, 0],
      [4, 0, 4, 8],
      [2, 4, 8, 16],
    ]);
    const s = b.slide(LEFT)!;
    expect(rows(new Board(4, s.cells))).toEqual([
      [4, 4, 0, 0],
      [4, 2, 0, 0],
      [8, 8, 0, 0],
      [2, 4, 8, 16],
    ]);
    expect(s.merged).toEqual([0, 1, 4, 8]);
    const r = b.slide(RIGHT)!;
    expect(rows(new Board(4, r.cells))[1]).toEqual([0, 0, 2, 4]);
  });

  it("slides up and down along columns", () => {
    const b = board([
      [2, 0, 0, 0],
      [2, 0, 4, 0],
      [0, 0, 4, 0],
      [4, 0, 0, 2],
    ]);
    expect(rows(new Board(4, b.slide(UP)!.cells))).toEqual([
      [4, 0, 8, 2],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(rows(new Board(4, b.slide(DOWN)!.cells))).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [4, 0, 0, 0],
      [4, 0, 8, 2],
    ]);
  });

  it("slides rocks but never merges them or across them", () => {
    const b = board([
      [0, 2, "R", 2],
      ["R", "R", 0, 0],
      [2, "R", 2, 0],
      [0, 0, 0, 0],
    ]);
    expect(rows(new Board(4, b.slide(LEFT)!.cells))).toEqual([
      [2, "R", 2, 0],
      ["R", "R", 0, 0],
      [2, "R", 2, 0],
      [0, 0, 0, 0],
    ]);
  });

  it("says when a move changes nothing", () => {
    const b = board([
      [2, 4, 0, 0],
      ["R", 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(b.slide(LEFT)).toBeNull();
    expect(b.slide(UP)).toBeNull();
    expect(b.slide(RIGHT)).not.toBeNull();
  });

  it("knows when a board is stuck", () => {
    expect(
      board([
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, "R"],
      ]).canMove(),
    ).toBe(false);
    expect(
      board([
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, 4],
      ]).canMove(),
    ).toBe(true);
    // Rocks next to each other don't merge.
    expect(
      board([
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, "R", "R"],
      ]).canMove(),
    ).toBe(false);
  });

  it("round-trips the board encoding", () => {
    const b = board([
      [2, 4, 2048, 0],
      ["R", 0, 0, 65536],
      [0, 0, 0, 0],
      [0, 0, 8, 0],
    ]);
    b.cells[5] = -2;
    const again = Board.decode(b.encode(), 4)!;
    expect(again.cells).toEqual(b.cells);
    expect(Board.decode("12", 4)).toBeNull();
    expect(Board.decode("000000000000000!", 4)).toBeNull();
  });
});

describe("lanes", () => {
  it("starts with two tiles and spawns one after every move", () => {
    const lane = new Lane(42, 4);
    expect(lane.board.filled()).toBe(2);
    const dir = ([UP, RIGHT, DOWN, LEFT] as Dir[]).find((d) => lane.canSlide(d))!;
    const res = lane.move(dir, 0)!;
    expect(res.spawn).toBeGreaterThanOrEqual(0);
    expect(lane.n).toBe(1);
  });

  it("gives everyone the same tiles in the same order", () => {
    const a = new Lane(7, 4);
    const b = new Lane(7, 4);
    const spawned = (lane: Lane, dirs: Dir[]) =>
      dirs.flatMap((d) => {
        const res = lane.move(d, 0);
        return res && res.spawn >= 0 ? [lane.board.cells[res.spawn]] : [];
      });
    // Different moves, so different boards, but the same 2s and 4s.
    const va = spawned(a, [LEFT, UP, LEFT, UP, RIGHT, DOWN, LEFT, UP, RIGHT, UP, LEFT, DOWN]);
    const vb = spawned(b, [RIGHT, DOWN, RIGHT, DOWN, LEFT, UP, RIGHT, DOWN, LEFT, DOWN, RIGHT, UP]);
    const n = Math.min(va.length, vb.length);
    expect(n).toBeGreaterThan(5);
    expect(va.slice(0, n)).toEqual(vb.slice(0, n));
  });

  it("is deterministic, and survives a snapshot", () => {
    const a = new Lane(99, 4);
    const b = new Lane(99, 4);
    const dirs: Dir[] = [LEFT, UP, RIGHT, DOWN, LEFT, LEFT, UP, UP, RIGHT, DOWN];
    for (const d of dirs) {
      a.move(d, 0);
      b.move(d, 0);
    }
    expect(a.checksum()).toBe(b.checksum());
    const c = Lane.fromSnap(JSON.parse(JSON.stringify(a.snap())));
    for (const d of dirs) {
      a.move(d, 0);
      c.move(d, 0);
    }
    expect(c.checksum()).toBe(a.checksum());
    expect(c.board.encode()).toBe(a.board.encode());
  });

  it("scores merges like the original", () => {
    const lane = laneWith([
      [2, 2, 4, 4],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const res = lane.move(LEFT, 0)!;
    expect(res.points).toBe(4 + 8);
    expect(res.combo).toBe(2);
    expect(lane.score).toBe(12);
  });
});

describe("power and rocks", () => {
  it("charges more for bigger merges and for several at once", () => {
    expect(movePower([2])).toBe(1); // a 4
    expect(movePower([9])).toBe(8); // a 512
    expect(movePower([3, 3])).toBe(Math.floor(((2 + 2) * 3) / 2));
    expect(movePower([2, 2, 2])).toBe(6);
  });

  it("sends a rock each time the meter fills", () => {
    const lane = laneWith([
      [256, 256, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    lane.charge = ROCK_COST - 1;
    const res = lane.move(LEFT, 0)!;
    // A 512 is worth 8: with 7 already charged that's 15, so one rock and 7 left over.
    expect(res.attack).toBe(1);
    expect(res.sent).toBe(1);
    expect(lane.charge).toBe(15 - ROCK_COST);
  });

  it("smashes a rock with a merge right next to it", () => {
    const lane = laneWith([
      [2, 2, 0, 0],
      ["R", 0, 0, 0],
      [0, "R", 0, 0],
      [0, 0, 0, "R"],
    ]);
    const res = lane.move(LEFT, 0)!;
    // The merge lands at the top left: the rock below it is hit, the others aren't next to it.
    expect(res.hits).toEqual([{ cell: 4, hp: 0 }]);
    expect(lane.board.cells[4]).toBeGreaterThanOrEqual(0);
    expect(lane.board.rocks()).toBe(2);
    expect(lane.smashed).toBe(1);
  });

  it("lands seen rocks on the third move, a few at a time", () => {
    const lane = new Lane(5, 5);
    lane.queue.push({ id: 1, rocks: MAX_LAND + 2, from: 3, at: -1 });
    const moves = () => ([UP, LEFT, DOWN, RIGHT] as Dir[]).find((d) => lane.canSlide(d))!;
    // Not seen yet: nothing happens to it.
    lane.move(moves(), 0);
    expect(lane.pending()).toBe(MAX_LAND + 2);
    // Seen on this move.
    let landed = 0;
    for (let i = 0; i < ARM_MOVES - 1; i++) {
      const res = lane.move(moves(), 1)!;
      landed += res.landed.length;
      if (i === 0) expect(lane.queue[0].at).toBe(1);
    }
    expect(landed).toBe(0);
    expect(lane.armed()).toBe(MAX_LAND);
    const res = lane.move(moves(), 1)!;
    expect(res.landed.length).toBe(MAX_LAND);
    expect(lane.lastHitBy).toBe(3);
    expect(lane.pending()).toBe(2);
    expect(lane.move(moves(), 1)!.landed.length).toBe(2);
    expect(lane.pending()).toBe(0);
  });

  it("smashes seen rocks with its own attack first", () => {
    const lane = laneWith([
      [256, 256, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    lane.charge = ROCK_COST - 1;
    lane.queue.push({ id: 1, rocks: 1, from: 2, at: -1 }, { id: 2, rocks: 3, from: 2, at: -1 });
    // Only id 1 has been seen: the attack cancels it, and id 2 is untouched.
    const res = lane.move(LEFT, 1)!;
    expect(res.cancelled).toBe(1);
    expect(res.sent).toBe(0);
    expect(lane.queue).toEqual([{ id: 2, rocks: 3, from: 2, at: -1 }]);
  });

  it("won't take a move whose garbage id goes backwards", () => {
    const lane = new Lane(3, 4);
    lane.queue.push({ id: 4, rocks: 1, from: 1, at: -1 });
    const d = ([UP, LEFT, DOWN, RIGHT] as Dir[]).find((x) => lane.canSlide(x))!;
    expect(lane.move(d, 4)).not.toBeNull();
    const d2 = ([UP, LEFT, DOWN, RIGHT] as Dir[]).find((x) => lane.canSlide(x))!;
    expect(lane.move(d2, 3)).toBeNull();
  });

  it("leaves garbage the player hasn't seen out of the checksum", () => {
    const a = new Lane(11, 4);
    const b = new Lane(11, 4);
    b.queue.push({ id: 1, rocks: 2, from: 0, at: -1 });
    expect(a.checksum()).toBe(b.checksum());
    b.ack = 1;
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it("drops waiting rocks on an idle board, and knows when that fills it", () => {
    const lane = laneWith([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 0],
    ]);
    lane.queue.push({ id: 1, rocks: 2, from: 1, at: -1 });
    expect(lane.drop()).toEqual([15]);
    expect(lane.out).toBe(true);
    expect(lane.pending()).toBe(1);
  });

  it("buries an idle board that has no room for the rocks waiting, even with a merge left", () => {
    const lane = laneWith([
      [2, 2, "R", "R"],
      ["R", "R", "R", "R"],
      ["R", "R", "R", "R"],
      ["R", "R", "R", "R"],
    ]);
    expect(lane.board.canMove()).toBe(true);
    lane.queue.push({ id: 1, rocks: 1, from: 1, at: -1 });
    expect(lane.drop()).toEqual([]);
    expect(lane.out).toBe(true);
  });

  it("is out when a move leaves no moves", () => {
    const lane = laneWith([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [8, 4, 2, 2],
    ]);
    // Merging the 2s leaves one gap; the new tile fills it. Whatever it is, the board may or may not be stuck.
    const res = lane.move(RIGHT, 0)!;
    expect(res.out).toBe(!lane.board.canMove());
  });
});
