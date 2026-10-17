import { expect } from "vitest";
import { Board } from "../src/shared/board";

// Boards drawn as text, one character per cell:
//   .      neutral
//   A–H    land of slot 0–7
//   a–h    trail of slot 0–7 (on neutral ground)

const LAND = "ABCDEFGH";
const TRAIL = "abcdefgh";

export function parseBoard(text: string): Board {
  const rows = text
    .trim()
    .split("\n")
    .map((r) => r.trim());
  const b = new Board(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    if (row.length !== b.w) throw new Error(`row ${y} has ${row.length} cells, expected ${b.w}`);
    [...row].forEach((ch, x) => {
      const c = b.idx(x, y);
      if (LAND.includes(ch)) b.setOwner(c, LAND.indexOf(ch) + 1);
      else if (TRAIL.includes(ch)) {
        const slot = TRAIL.indexOf(ch);
        b.trail[c] = slot + 1;
        b.trails[slot].push(c);
      } else if (ch !== ".") throw new Error(`unknown cell ${ch}`);
    });
  });
  return b;
}

/** Trail wins over land, so a trail lying on someone's land shows as lowercase. */
export function printBoard(b: Board): string {
  const rows: string[] = [];
  for (let y = 0; y < b.h; y++) {
    let row = "";
    for (let x = 0; x < b.w; x++) {
      const c = b.idx(x, y);
      row += b.trail[c] ? TRAIL[b.trail[c] - 1] : b.owner[c] ? LAND[b.owner[c] - 1] : ".";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export function board(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((r) => r.trim())
    .join("\n");
}

/** The board's counts and lists agree with its grids. */
export function checkInvariants(b: Board): void {
  const land = new Array(8).fill(0);
  const trails: number[][] = Array.from({ length: 8 }, () => []);
  for (let c = 0; c < b.size; c++) {
    if (b.owner[c]) land[b.owner[c] - 1]++;
    if (b.trail[c]) {
      trails[b.trail[c] - 1].push(c);
      expect(b.owner[c], `trail on its owner's land at ${c}`).not.toBe(b.trail[c]);
    }
  }
  expect(Array.from(b.land)).toEqual(land);
  expect(b.trails.map((t) => [...t].sort((x, y) => x - y))).toEqual(trails);
  // A live head is on the board. (It can stand on someone else's land with no
  // trail under it: that happens when a claim takes the ground it was resting on.)
  b.heads.forEach((h) => {
    if (h.alive) expect(h.cell).toBeGreaterThanOrEqual(0);
  });
}
