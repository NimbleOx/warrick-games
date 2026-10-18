/**
 * The hex grid: pointy-top hexes in rows, with odd rows shifted half a cell right ("odd-r").
 * Cells are numbered row by row, cell = row * w + col.
 */

export const SQRT3 = Math.sqrt(3);

/** The six neighbours of a cell, in edge order E, SE, SW, W, NW, NE; -1 off the grid. */
export function neighbours(w: number, h: number, cell: number): number[] {
  const c = cell % w;
  const r = (cell - c) / w;
  const odd = r & 1;
  const at = (cc: number, rr: number) => (cc >= 0 && cc < w && rr >= 0 && rr < h ? rr * w + cc : -1);
  return [at(c + 1, r), at(c + odd, r + 1), at(c - 1 + odd, r + 1), at(c - 1, r), at(c - 1 + odd, r - 1), at(c + odd, r - 1)];
}

/** A cell's centre for hexes of radius 1, with the grid's top-left corner at (0, 0). */
export function cellCenter(w: number, cell: number): { x: number; y: number } {
  const c = cell % w;
  const r = (cell - c) / w;
  return { x: SQRT3 * (c + 0.5 * (r & 1)) + SQRT3 / 2, y: 1.5 * r + 1 };
}

/** The grid's size for hexes of radius 1. */
export function gridExtent(w: number, h: number): { width: number; height: number } {
  return { width: SQRT3 * (w + 0.5), height: 1.5 * (h - 1) + 2 };
}

/**
 * Corner k of a hex of radius 1 around (0, 0). Edge k runs from corner k to corner k + 1 and
 * faces neighbour k of `neighbours`.
 */
export const CORNERS: readonly { x: number; y: number }[] = Array.from({ length: 6 }, (_, k) => {
  const a = ((60 * k - 30) * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
});
