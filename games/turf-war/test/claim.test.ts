import { describe, expect, it } from "vitest";
import { Board } from "../src/shared/board";
import { claimRuns } from "../src/shared/claim";
import { forEachRunCell, rleDecode, rleEncode } from "../src/shared/codec";
import { mulberry32, randInt } from "../src/shared/rng";
import { board, parseBoard, printBoard } from "./ascii";

function claim(text: string, slot = 0): Board {
  const b = parseBoard(text);
  b.apply(["c", slot, ...claimRuns(b, slot)]);
  return b;
}

describe("claiming", () => {
  it("fills a rectangle loop", () => {
    const b = claim(`
      .......
      .aaaa..
      .a..a..
      .AAAa..
      .......
    `);
    expect(printBoard(b)).toBe(
      board(`
      .......
      .AAAA..
      .AAAA..
      .AAAA..
      .......
    `),
    );
    expect(b.land[0]).toBe(12);
    expect(b.trails[0]).toEqual([]);
  });

  it("converts only the trail when it encloses nothing", () => {
    const b = claim(`
      .....
      .aa..
      .AA..
    `);
    expect(printBoard(b)).toBe(
      board(`
      .....
      .AA..
      .AA..
    `),
    );
  });

  it("uses trail along the board edge as a wall", () => {
    const b = claim(`
      .......
      aaaaaaa
      a.....a
      a.....a
      AAAAAAA
    `);
    expect(printBoard(b)).toBe(
      board(`
      .......
      AAAAAAA
      AAAAAAA
      AAAAAAA
      AAAAAAA
    `),
    );
  });

  it("doesn't claim a pocket that is open to the board edge", () => {
    const b = claim(`
      .aaaa.
      .a..a.
      .A..A.
      .A..A.
    `);
    expect(printBoard(b)).toBe(
      board(`
      .AAAA.
      .A..A.
      .A..A.
      .A..A.
    `),
    );
  });

  it("leaves a channel to the edge unclaimed in a concave shape", () => {
    const b = claim(`
      aaaaaaa
      a.....a
      a.AAA.a
      a.A.A.a
      AAA.AAA
    `);
    expect(printBoard(b)).toBe(
      board(`
      AAAAAAA
      AAAAAAA
      AAAAAAA
      AAA.AAA
      AAA.AAA
    `),
    );
  });

  it("steals enclosed enemy land but leaves the enemy's trail on top", () => {
    const b = claim(`
      .aaaaaa.
      .a.BB.a.
      .a.Bb.a.
      .AAAAAAA
    `);
    expect(printBoard(b)).toBe(
      board(`
      .AAAAAA.
      .AAAAAA.
      .AAAbAA.
      .AAAAAAA
    `),
    );
    expect(b.land[1]).toBe(0);
    expect(b.owner[b.idx(4, 2)]).toBe(1);
    expect(b.trails[1]).toEqual([b.idx(4, 2)]);
  });

  it("treats land that touches only diagonally as a wall", () => {
    const b = claim(`
      aaaa.
      a..A.
      a.A..
      aA...
      A....
    `);
    expect(printBoard(b)).toBe(
      board(`
      AAAA.
      AAAA.
      AAA..
      AA...
      A....
    `),
    );
  });

  it("fills holes in its own land", () => {
    const b = claim(`
      AAA..
      A.A..
      AAAa.
      ..Aa.
    `);
    expect(printBoard(b)).toBe(
      board(`
      AAA..
      AAA..
      AAAA.
      ..AA.
    `),
    );
  });

  it("claims the pockets a winding trail closes, not one open to the edge", () => {
    const b = claim(`
      aaa.aaa.
      a.a.a.a.
      a.a.a.a.
      a.a.a.a.
      a.a.a.a.
      a.aaa.a.
      a.....a.
      AAAAAAAA
    `);
    expect(printBoard(b)).toBe(
      board(`
      AAA.AAA.
      AAA.AAA.
      AAA.AAA.
      AAA.AAA.
      AAA.AAA.
      AAAAAAA.
      AAAAAAA.
      AAAAAAAA
    `),
    );
  });

  it("returns nothing for a slot with no land or trail", () => {
    const b = parseBoard(`
      BBB
      B.B
      BBB
    `);
    expect(claimRuns(b, 0)).toEqual([]);
  });

  it("matches a whole-board flood fill on random boards", () => {
    const rng = mulberry32(1234);
    for (let round = 0; round < 1000; round++) {
      const w = randInt(rng, 3, 40);
      const h = randInt(rng, 3, 30);
      const b = new Board(w, h);
      const density = rng() * 0.6;
      // Blobs of land for slots 0–2, and a scattering of trail for slot 0.
      for (let c = 0; c < b.size; c++) {
        const r = rng();
        if (r < density) b.setOwner(c, randInt(rng, 1, 3));
        else if (r < density + 0.1) {
          b.trail[c] = 1;
          b.trails[0].push(c);
        }
      }
      const fast: number[] = [];
      forEachRunCell(claimRuns(b, 0), 0, (c) => fast.push(c));
      expect(fast, `board ${round}`).toEqual(naiveClaim(b, 0));
    }
  });
});

describe("codec", () => {
  it("round-trips a grid through RLE", () => {
    const rng = mulberry32(7);
    const grid = Uint8Array.from({ length: 500 }, () => (rng() < 0.8 ? 0 : randInt(rng, 1, 8)));
    const out = new Uint8Array(500);
    expect(rleDecode(rleEncode(grid), out)).toBe(true);
    expect(out).toEqual(grid);
    expect(rleDecode([0, 499], out)).toBe(false);
    expect(rleDecode([0, 501], out)).toBe(false);
  });

  it("round-trips a board through a snapshot", () => {
    const b = parseBoard(`
      .aaaa..
      .a..aB.
      .AAAaBB
      ..cCC..
    `);
    b.apply(["s", 3, b.idx(5, 3), 0]);
    const copy = Board.fromSnapshot(JSON.parse(JSON.stringify(b.snapshot())))!;
    expect(printBoard(copy)).toBe(printBoard(b));
    expect(Array.from(copy.land)).toEqual(Array.from(b.land));
    expect(copy.heads).toEqual(b.heads);
    expect(copy.checksum()).toBe(b.checksum());
  });
});

/** Reference implementation: fill the whole board from its edges. */
function naiveClaim(b: Board, slot: number): number[] {
  const v = slot + 1;
  const wall = (c: number) => b.owner[c] === v || b.trail[c] === v;
  if (!b.owner.some((o) => o === v) && !b.trail.some((t) => t === v)) return [];
  const seen = new Uint8Array(b.size);
  const queue: number[] = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (x > 0 && y > 0 && x < b.w - 1 && y < b.h - 1) continue;
      const c = b.idx(x, y);
      if (!wall(c) && !seen[c]) {
        seen[c] = 1;
        queue.push(c);
      }
    }
  }
  while (queue.length) {
    const c = queue.pop()!;
    const x = c % b.w;
    const y = Math.floor(c / b.w);
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h) continue;
      const n = b.idx(nx, ny);
      if (!seen[n] && !wall(n)) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  const out: number[] = [];
  for (let c = 0; c < b.size; c++) if (!seen[c] && b.owner[c] !== v) out.push(c);
  return out;
}
