import { describe, expect, it } from "vitest";
import type { Dir, Frame, Op } from "../src/shared/board";
import { RESPAWN_TICKS } from "../src/shared/constants";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { Round } from "../src/shared/sim";
import { board, parseBoard, printBoard } from "./ascii";

type HeadSpec = [x: number, y: number, dir: Dir];

/** A round on a drawn board, with heads placed by hand and no countdown. */
function scenario(text: string, heads: Record<number, HeadSpec>) {
  const b = parseBoard(text);
  for (const [slot, [x, y, dir]] of Object.entries(heads)) {
    Object.assign(b.heads[Number(slot)], { cell: b.idx(x, y), dir, alive: true, fresh: false, respawnAt: -1 });
  }
  const slots = Object.keys(heads).map(Number);
  const round = new Round(mulberry32(1), { w: b.w, h: b.h, slots, ticks: 1000, countdown: 0, board: b });
  const step = (turns: Record<number, Dir> = {}): Frame => {
    for (const [s, d] of Object.entries(turns)) round.turn(Number(s), d);
    return round.step();
  };
  return { round, b, step, at: (x: number, y: number) => b.idx(x, y) };
}

const opsOf = (f: Frame, kind: Op[0]) => f.o.filter((o) => o[0] === kind);

describe("movement and claiming", () => {
  it("lays trail off its land and claims the loop on the way back in", () => {
    const t = scenario(
      `
      ..........
      .AAA......
      .AAA......
      .AAA......
      ..........
      ..........
    `,
      { 0: [2, 2, 1] },
    );
    t.step(); // (3,2), still home
    t.step(); // (4,2)
    t.step(); // (5,2)
    expect(t.b.trails[0]).toEqual([t.at(4, 2), t.at(5, 2)]);
    t.step({ 0: 2 }); // (5,3)
    t.step(); // (5,4)
    t.step({ 0: 3 }); // (4,4)
    t.step(); // (3,4)
    const f = t.step({ 0: 0 }); // (3,3), home again
    expect(opsOf(f, "c")).toHaveLength(1);
    expect(printBoard(t.b)).toBe(
      board(`
      ..........
      .AAA......
      .AAAAA....
      .AAAAA....
      ...AAA....
      ..........
    `),
    );
    expect(t.b.land[0]).toBe(16);
    expect(t.b.trails[0]).toEqual([]);
  });

  it("ignores a turn straight back, except right after spawning", () => {
    const t = scenario(
      `
      .......
      .AAA...
      .AAA...
      .AAA...
    `,
      { 0: [2, 2, 1] },
    );
    t.step({ 0: 3 });
    expect(t.b.heads[0].cell).toBe(t.at(3, 2));

    const u = scenario(
      `
      .......
      .AAA...
      .AAA...
      .AAA...
    `,
      { 0: [2, 2, 1] },
    );
    u.b.heads[0].fresh = true;
    u.step({ 0: 3 });
    expect(u.b.heads[0].cell).toBe(u.at(1, 2));
  });

  it("keeps a second quick turn for the next tick", () => {
    const t = scenario(
      `
      .......
      .AAA...
      .AAA...
      .AAA...
      .......
      .......
    `,
      { 0: [2, 2, 1] },
    );
    t.round.turn(0, 2);
    t.round.turn(0, 3);
    t.step();
    expect(t.b.heads[0].cell).toBe(t.at(2, 3));
    t.step();
    expect(t.b.heads[0].cell).toBe(t.at(1, 3));
  });
});

describe("deaths", () => {
  it("kills a head that leaves the board, then respawns it with a fresh home", () => {
    const t = scenario(
      `
      ............
      .........AAA
      .........AAA
      .........AAA
      ............
      ............
      ............
      ............
    `,
      { 0: [11, 2, 1] },
    );
    const f = t.step();
    expect(opsOf(f, "d")).toEqual([["d", 0, -1, -1, "wall", 1 + RESPAWN_TICKS]]);
    expect(t.b.land[0]).toBe(0);
    expect(t.round.deaths[0]).toBe(1);
    while (t.round.n < RESPAWN_TICKS) expect(opsOf(t.step(), "s")).toEqual([]);
    expect(opsOf(t.step(), "s")).toHaveLength(1);
    expect(t.b.heads[0]).toMatchObject({ alive: true, fresh: true });
    expect(t.b.land[0]).toBe(9);
  });

  it("cutting a trail kills its owner and hands the killer that trail as land", () => {
    const t = scenario(
      `
      ............
      .AAA........
      .AAAaaaa....
      .AAA........
      ............
      .....BBB....
      .....BBB....
      .....BBB....
    `,
      { 0: [7, 2, 1], 1: [6, 6, 0] },
    );
    t.step();
    t.step();
    t.step();
    const f = t.step();
    expect(opsOf(f, "d")).toEqual([["d", 0, 1, 1, "trail", 4 + RESPAWN_TICKS]]);
    // B's head landed on A's old trail, which is now B's land, so B's own trail closes too.
    expect(opsOf(f, "c")).toHaveLength(1);
    expect(printBoard(t.b)).toBe(
      board(`
      ............
      ............
      ....BBBBBBB.
      ......B.....
      ......B.....
      .....BBB....
      .....BBB....
      .....BBB....
    `),
    );
    expect(t.round.kills).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    expect(t.round.deaths[0]).toBe(1);
  });

  it("crossing your own trail is fatal", () => {
    const t = scenario(
      `
      ........
      .AAA....
      .AAAaaa.
      .AAA.aa.
      .....aa.
    `,
      { 0: [5, 3, 0] },
    );
    const f = t.step();
    expect(opsOf(f, "d")).toEqual([["d", 0, -1, -1, "self", 1 + RESPAWN_TICKS]]);
    expect(t.b.owner.every((o) => o === 0)).toBe(true);
    expect(t.b.trail.every((o) => o === 0)).toBe(true);
  });

  it("two heads entering the same cell both die", () => {
    const t = scenario(
      `
      .........
      .AAA.BBB.
      .AAA.BBB.
      .AAA.BBB.
    `,
      { 0: [3, 2, 1], 1: [5, 2, 3] },
    );
    const f = t.step();
    expect(opsOf(f, "d").map((d) => [d[1], d[4]])).toEqual([
      [0, "headon"],
      [1, "headon"],
    ]);
    expect(t.round.kills).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("two heads swapping cells both die", () => {
    const t = scenario(
      `
      .........
      .AAA.BBB.
      .AAAaBBB.
      .AAA.BBB.
    `,
      { 0: [4, 2, 1], 1: [5, 2, 3] },
    );
    const f = t.step();
    expect(opsOf(f, "d").map((d) => [d[1], d[4]])).toEqual([
      [0, "headon"],
      [1, "headon"],
    ]);
  });

  it("two players cutting each other's trails on the same tick both die, and nobody takes a trail", () => {
    const t = scenario(
      `
      ..........
      ..........
      AA........
      AAaaaaa...
      ..bbbbbBB.
      .......BB.
      ..........
    `,
      { 0: [6, 3, 1], 1: [2, 4, 3] },
    );
    const f = t.step({ 0: 2, 1: 0 });
    expect(opsOf(f, "d")).toEqual([
      ["d", 0, 1, -1, "trail", 1 + RESPAWN_TICKS],
      ["d", 1, 0, -1, "trail", 1 + RESPAWN_TICKS],
    ]);
    expect(t.b.owner.every((o) => o === 0)).toBe(true);
    expect(t.b.trail.every((o) => o === 0)).toBe(true);
  });

  it("enclosing all of someone's land squeezes them out", () => {
    const t = scenario(
      `
      .........
      .aaaaaa..
      .a.BB.a..
      .a.BB.a..
      .AAAAAa..
      .AAAAA...
    `,
      { 0: [6, 4, 2], 1: [3, 2, 1] },
    );
    const f = t.step({ 0: 3 });
    expect(opsOf(f, "d")).toEqual([["d", 1, 0, -1, "squeeze", 1 + RESPAWN_TICKS]]);
    expect(t.b.land[1]).toBe(0);
    expect(t.b.land[0]).toBe(29);
    expect(t.round.kills[0]).toBe(1);
  });
});

describe("round flow", () => {
  it("holds everyone still through the countdown", () => {
    const round = new Round(mulberry32(3), { w: 60, h: 40, slots: [0, 1, 2], ticks: 100, countdown: 30 });
    const start = round.board.heads.map((h) => h.cell);
    for (let i = 0; i < 30; i++) expect(round.step().o).toEqual([]);
    expect(round.board.heads.map((h) => h.cell)).toEqual(start);
    expect(opsOf(round.step(), "m")).toHaveLength(1);
  });

  it("gives every starter a separate 3 × 3 home facing the middle", () => {
    const round = new Round(mulberry32(4), { w: 80, h: 56, slots: [0, 1, 2, 3, 4, 5, 6, 7], ticks: 100 });
    for (let s = 0; s < 8; s++) {
      expect(round.board.land[s]).toBe(9);
      expect(round.board.heads[s]).toMatchObject({ alive: true, fresh: true });
    }
  });

  it("ends after the set number of ticks", () => {
    const round = new Round(mulberry32(5), { w: 40, h: 30, slots: [0, 1], ticks: 20, countdown: 5 });
    let n = 0;
    while (!round.over) {
      round.step();
      n++;
    }
    expect(n).toBe(25);
  });

  it("a player who leaves loses everything and doesn't come back", () => {
    const round = new Round(mulberry32(6), { w: 40, h: 30, slots: [0, 1], ticks: 200, countdown: 0 });
    round.leave(1);
    const f = round.step();
    expect(opsOf(f, "d")).toEqual([["d", 1, -1, -1, "left", -1]]);
    expect(round.board.land[1]).toBe(0);
    for (let i = 0; i < RESPAWN_TICKS + 5; i++) round.step();
    expect(round.board.heads[1].alive).toBe(false);
    expect(round.deaths[1]).toBe(0);
  });

  it("a late joiner spawns on clear ground on the next tick", () => {
    const round = new Round(mulberry32(7), { w: 60, h: 40, slots: [0, 1], ticks: 200, countdown: 0 });
    for (let i = 0; i < 10; i++) round.step();
    const before = Uint8Array.from(round.board.owner);
    round.join(5);
    const spawns = opsOf(round.step(), "s");
    expect(spawns).toHaveLength(1);
    const [, slot, cell] = spawns[0] as ["s", number, number, Dir];
    expect(slot).toBe(5);
    expect(before[cell]).toBe(0);
    expect(round.board.land[5]).toBe(9);
  });
});
