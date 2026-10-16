import { describe, expect, it } from "vitest";
import { choose, landings } from "../src/shared/ai";
import { COLS, SPAWN_X, SPAWN_Y } from "../src/shared/constants";
import { Board, Lane, SPIN_FULL, SPIN_MINI, explore, reachable, spinKind, spotKey, turn, type Placement } from "../src/shared/engine";
import { Bag, GARBAGE, I, O, SHAPES, T, type Piece } from "../src/shared/pieces";
import { mulberry32 } from "../src/shared/rng";

/** Build a board from rows drawn top-down: "#" solid, "." empty. The last row is the floor. */
function board(...rows: string[]): Board {
  const b = new Board();
  rows.forEach((row, i) => {
    const y = rows.length - 1 - i;
    [...row].forEach((ch, x) => {
      if (ch !== ".") b.cells[y * COLS + x] = GARBAGE;
    });
  });
  return b;
}

function draw(b: Board, rows = 6): string[] {
  const out: string[] = [];
  for (let y = rows - 1; y >= 0; y--) {
    let s = "";
    for (let x = 0; x < COLS; x++) s += b.get(x, y) ? "#" : ".";
    out.push(s);
  }
  return out;
}

/** A lane that only ever deals `p`. */
function only(p: Piece): Lane {
  const lane = new Lane(1);
  lane.bag = { seed: 1, at: () => p } as unknown as Bag;
  return lane;
}

/** The first resting place for the piece in play. */
function anywhere(lane: Lane): Placement {
  return { ...landings(lane.board, lane.current)[0], hold: false, spin: 0 };
}

const drop = (b: Board, piece: Piece, r: number, x: number): Placement => ({
  piece,
  r,
  x,
  y: b.drop(piece, r, x, SPAWN_Y),
  hold: false,
  spin: 0,
});

describe("pieces", () => {
  it("every piece has four blocks in every rotation", () => {
    for (let p = 1; p <= 7; p++) for (const cells of SHAPES[p]) expect(cells).toHaveLength(4);
  });

  it("bags hold each piece once", () => {
    const bag = new Bag(42);
    for (let k = 0; k < 5; k++) {
      const seven = Array.from({ length: 7 }, (_, i) => bag.at(k * 7 + i)).sort();
      expect(seven).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it("the same seed gives the same pieces", () => {
    const a = new Bag(7);
    const b = new Bag(7);
    for (let i = 0; i < 50; i++) expect(a.at(i)).toBe(b.at(i));
  });

  it("an I turns in place in open space and kicks off the wall", () => {
    const b = new Board();
    // Flat I against the left wall, turned clockwise from upright at column 0.
    const t = turn(b, I, 3, -1, 5, 1);
    expect(t).toEqual({ r: 0, x: 0, y: 5, kick: 1 });
    expect(turn(b, T, 0, 4, 5, 1)).toEqual({ r: 1, x: 4, y: 5, kick: 0 });
  });
});

describe("board", () => {
  it("clears full rows and drops the rest", () => {
    const b = board("#.........", "##########", ".#########", "##########");
    expect(b.clearLines()).toEqual([0, 2]);
    expect(draw(b, 3)).toEqual(["..........", "#.........", ".#########"]);
  });

  it("pushes garbage in from the floor with one hole", () => {
    const b = board("#.........");
    expect(b.addGarbage(2, 3)).toBe(true);
    expect(draw(b, 3)).toEqual(["#.........", "###.######", "###.######"]);
  });

  it("round-trips through encode", () => {
    const b = board("..##......", "#########.");
    expect(Board.decode(b.encode())!.cells).toEqual(b.cells);
    expect(new Board().encode()).toBe("");
    expect(Board.decode("12x")).toBeNull();
  });
});

describe("reachability", () => {
  it("finds a tuck under an overhang but not a sealed cavity", () => {
    const b = board("......####", "..........", "#.........");
    // An O slid right under the overhang: rows 0–1, columns 6–7. Dropping straight there is blocked.
    expect(reachable(b, O, { piece: O, r: 0, x: 5, y: 1, hold: false, spin: 0 })).toBe(true);
    const sealed = board("##########", "#.........", "#.........");
    // Space below a full row can't be reached.
    expect(reachable(sealed, O, { piece: O, r: 0, x: 3, y: 1, hold: false, spin: 0 })).toBe(false);
  });

  it("rejects a placement that isn't resting", () => {
    const b = new Board();
    expect(reachable(b, T, { piece: T, r: 0, x: 3, y: 5, hold: false, spin: 0 })).toBe(false);
    expect(reachable(b, T, { piece: T, r: 0, x: 3, y: 1, hold: false, spin: 0 })).toBe(true);
  });

  it("only allows the spin it can actually reach", () => {
    const b = new Board();
    // Flat on the floor in open space: a turn with no kick can land there, the last kick can't.
    expect(reachable(b, T, { piece: T, r: 2, x: 3, y: 2, hold: false, spin: 1 })).toBe(true);
    expect(reachable(b, T, { piece: T, r: 2, x: 3, y: 2, hold: false, spin: 5 })).toBe(false);
  });

  it("explores from the spawn", () => {
    const spots = explore(new Board(), T);
    expect(spots.has(spotKey(0, SPAWN_X, SPAWN_Y))).toBe(true);
    expect(spots.has(spotKey(0, 0, 1))).toBe(true);
    expect(spots.has(spotKey(0, 8, 1))).toBe(false); // off the right edge
  });
});

describe("T-spins", () => {
  // The classic T-spin double slot: the overhang at (2, 2) means only a turn gets the T in.
  const slot = () =>
    board(
      "..#.......", //
      "##...#####",
      "###.######",
    );

  it("spots a T-spin double and pays 4", () => {
    const b = slot();
    // Pointing down, centre at (3, 1).
    const p: Placement = { piece: T, r: 2, x: 2, y: 2, hold: false, spin: 1 };
    expect(spinKind(b, T, 2, 2, 2, 1)).toBe(SPIN_FULL);
    expect(b.fits(T, 2, 2, 3)).toBe(false); // can't drop straight in
    const lane = only(T);
    lane.board = b;
    const res = lane.lock(p, 0)!;
    expect(res.cleared).toHaveLength(2);
    expect(res.spin).toBe(SPIN_FULL);
    expect(res.attack).toBe(4);
  });

  it("is no spin if the last move wasn't a turn", () => {
    expect(spinKind(slot(), T, 2, 2, 2, 0)).toBe(0);
  });

  it("calls it a mini when the corners it points at aren't both solid", () => {
    // Pointing up on the floor, centre (1, 0): both floor corners and the top-left are solid.
    expect(spinKind(board("#.........", ".........."), T, 0, 0, 1, 1)).toBe(SPIN_MINI);
    expect(spinKind(board("..........", ".........."), T, 0, 0, 1, 1)).toBe(0);
    // Pointing down, centre (1, 1): both bottom corners and the top-left are solid.
    expect(spinKind(board("#.........", "..........", "#.#......."), T, 2, 0, 2, 1)).toBe(SPIN_FULL);
  });
});

describe("lane", () => {
  it("plays pieces from the bag in order and through hold", () => {
    const lane = new Lane(5);
    const bag = new Bag(5);
    const first = lane.current;
    expect(first).toBe(bag.at(0));
    // Hold with an empty slot: the second piece locks and the first is held.
    const res = lane.lock({ ...drop(lane.board, bag.at(1), 0, 3), hold: true }, 0)!;
    expect(res.piece).toBe(bag.at(1));
    expect(lane.hold).toBe(first);
    expect(lane.current).toBe(bag.at(2));
    // Hold again: the held first piece comes back and the third goes in the slot.
    lane.lock({ ...drop(lane.board, first, 0, 0), hold: true }, 0);
    expect(lane.hold).toBe(bag.at(2));
    expect(lane.current).toBe(bag.at(3));
  });

  it("rejects the wrong piece, floating pieces and overlaps", () => {
    const lane = only(T);
    expect(lane.lock({ piece: I, r: 0, x: 3, y: 1, hold: false, spin: 0 }, 0)).toBeNull();
    expect(lane.lock({ piece: T, r: 0, x: 3, y: 4, hold: false, spin: 0 }, 0)).toBeNull();
    expect(lane.lock({ piece: T, r: 0, x: 3, y: 0, hold: false, spin: 0 }, 0)).toBeNull();
    expect(lane.lock({ piece: T, r: 0, x: 3, y: 1, hold: false, spin: 0 }, 0)).not.toBeNull();
  });

  it("scores quads, back-to-backs and combos", () => {
    const lane = only(I);
    lane.board = board(...Array<string>(12).fill("#########."));
    const quad = (): Placement => ({ piece: I, r: 1, x: 7, y: lane.board.drop(I, 1, 7, SPAWN_Y), hold: false, spin: 0 });
    expect(lane.lock(quad(), 0)!.attack).toBe(4);
    // A second quad straight after: back-to-back +1, combo 1 (no bonus yet).
    let res = lane.lock(quad(), 0)!;
    expect(res.b2b).toBe(true);
    expect(res.combo).toBe(1);
    expect(res.attack).toBe(5);
    // The third empties the board: 4 + 1 back-to-back + 1 combo + 10 perfect clear.
    res = lane.lock(quad(), 0)!;
    expect(res.pc).toBe(true);
    expect(res.attack).toBe(16);
    // A lock that clears nothing ends the combo; a single after it breaks back-to-back.
    lane.lock({ piece: I, r: 0, x: 0, y: 1, hold: false, spin: 0 }, 0);
    expect(lane.combo).toBe(-1);
    expect(lane.b2b).toBe(true);
  });

  it("gives a perfect clear 10 extra", () => {
    const lane = only(I);
    lane.board = board("######....");
    const res = lane.lock({ piece: I, r: 0, x: 6, y: 1, hold: false, spin: 0 }, 0)!;
    expect(res.pc).toBe(true);
    expect(res.attack).toBe(10);
  });

  it("lets garbage in one lock after it's known, and clears cancel it", () => {
    const lane = new Lane(3);
    lane.queue.push({ id: 1, lines: 3, hole: 0, from: 2 });
    // The browser had seen garbage 1 by this lock, but it wasn't known at the last one: no rise yet.
    let res = lane.lock(anywhere(lane), 1)!;
    expect(res.inserted).toBe(0);
    expect(lane.ack).toBe(1);
    expect(lane.armed()).toBe(3);
    // Now it rises.
    res = lane.lock(anywhere(lane), 1)!;
    expect(res.inserted).toBe(3);
    expect(lane.lastHitBy).toBe(2);
    expect(lane.pending()).toBe(0);
    expect(lane.board.get(0, 0)).toBe(0);
    expect(lane.board.get(1, 0)).toBe(GARBAGE);
  });

  it("cancels only garbage the player knew about", () => {
    const lane = only(I);
    lane.board = board("######....");
    lane.queue.push({ id: 4, lines: 3, hole: 0, from: 1 }, { id: 9, lines: 5, hole: 2, from: 1 });
    // Perfect clear: 10 attack. Knows only id 4: cancels its 3, sends 7, leaves id 9 alone.
    const res = lane.lock({ piece: I, r: 0, x: 6, y: 1, hold: false, spin: 0 }, 4)!;
    expect(res.cancelled).toBe(3);
    expect(res.sent).toBe(7);
    expect(lane.queue).toEqual([{ id: 9, lines: 5, hole: 2, from: 1 }]);
  });

  it("tops out when the next piece can't appear", () => {
    const lane = only(O);
    for (let y = 0; y <= 20; y++) for (let x = 3; x <= 6; x++) lane.board.cells[y * COLS + x] = GARBAGE;
    const res = lane.lock({ piece: O, r: 0, x: -1, y: 1, hold: false, spin: 0 }, 0)!;
    expect(res.out).toBe(true);
    expect(lane.out).toBe(true);
    expect(lane.lock({ piece: O, r: 0, x: 7, y: 1, hold: false, spin: 0 }, 0)).toBeNull();
  });

  it("two lanes fed the same placements stay identical", () => {
    const a = new Lane(99);
    const b = new Lane(99);
    const rng = mulberry32(3);
    for (let i = 0; i < 60 && !a.out; i++) {
      if (i === 10) {
        a.queue.push({ id: 1, lines: 2, hole: 4, from: 1 });
        b.queue.push({ id: 1, lines: 2, hole: 4, from: 1 });
      }
      const pl = choose(a, "normal", rng, a.queue.at(-1)?.id ?? 0)!;
      a.lock(pl, a.queue.at(-1)?.id ?? 0);
      b.lock(pl, b.queue.at(-1)?.id ?? 0);
      expect(b.checksum()).toBe(a.checksum());
    }
    expect(Lane.fromSnap(JSON.parse(JSON.stringify(a.snap()))).checksum()).toBe(a.checksum());
  });
});

describe("CPU", () => {
  it.each(["easy", "normal", "hard"] as const)("%s survives 300 pieces on a clean board", (level) => {
    const lane = new Lane(1234);
    const rng = mulberry32(8);
    let attack = 0;
    for (let i = 0; i < 300; i++) {
      const pl = choose(lane, level, rng, 0);
      expect(pl).not.toBeNull();
      const res = lane.lock(pl!, 0)!;
      expect(res).not.toBeNull();
      attack += res.attack;
      if (lane.out) break;
    }
    expect(lane.out).toBe(false);
    console.log(`${level}: ${lane.lines} lines, ${attack} attack in 300 pieces`);
  });

  it("hard sends more than easy", () => {
    const run = (level: "easy" | "hard") => {
      const lane = new Lane(77);
      const rng = mulberry32(1);
      for (let i = 0; i < 200 && !lane.out; i++) lane.lock(choose(lane, level, rng, 0)!, 0);
      return lane.sent;
    };
    expect(run("hard")).toBeGreaterThan(run("easy"));
  });

  it("finds the T-spin double", () => {
    const lane = only(T);
    lane.board = board("..#.......", "##...#####", "###.######");
    const pl = choose(lane, "hard", mulberry32(1), 0)!;
    const res = lane.clone().lock(pl, 0)!;
    expect(res.spin).toBe(SPIN_FULL);
    expect(res.cleared).toHaveLength(2);
  });
});
