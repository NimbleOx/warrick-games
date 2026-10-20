// The board: a hexagon of 61 holes, five to a side, in axial coordinates (q, r). Rows run
// across the screen, r from −4 at the top to 4 at the bottom; q runs along each row, and the
// third axis (s = −q − r) runs down the other diagonal. A hole's centre is at
// x = q + r / 2, y = r × √3 / 2, in units of the gap between two holes.

/** Holes along each edge. */
export const SIDE = 5;
const MAX = SIDE - 1;

/** The six directions, anticlockwise from east as seen on screen (y grows downwards). */
export const DIRS = [
  [1, 0], // E
  [1, -1], // NE
  [0, -1], // NW
  [-1, 0], // W
  [-1, 1], // SW
  [0, 1], // SE
] as const;
export const DIR_NAMES = ["east", "north-east", "north-west", "west", "south-west", "south-east"] as const;
export const opposite = (d: number): number => (d + 3) % 6;

/** Each hole's q and r, in reading order (top row first, left to right). */
export const Q: number[] = [];
export const R: number[] = [];
const index = new Map<string, number>();
for (let r = -MAX; r <= MAX; r++) {
  for (let q = Math.max(-MAX, -MAX - r); q <= Math.min(MAX, MAX - r); q++) {
    index.set(`${q},${r}`, Q.length);
    Q.push(q);
    R.push(r);
  }
}
/** 61 holes. */
export const CELLS = Q.length;

/** The hole at (q, r), or −1 off the board. */
export function cellAt(q: number, r: number): number {
  return index.get(`${q},${r}`) ?? -1;
}

/** `NB[c * 6 + d]`: the hole next to `c` in direction `d`, or −1 off the board. */
export const NB = new Int8Array(CELLS * 6);
for (let c = 0; c < CELLS; c++) {
  for (let d = 0; d < 6; d++) NB[c * 6 + d] = cellAt(Q[c] + DIRS[d][0], R[c] + DIRS[d][1]);
}

export function step(c: number, d: number): number {
  return NB[c * 6 + d];
}

/** Steps from the middle hole: 0 in the middle, 4 round the rim. */
export const RING: number[] = Q.map((q, i) => Math.max(Math.abs(q), Math.abs(R[i]), Math.abs(q + R[i])));

/** The hole opposite through the middle: the other player's view of the board. */
export function mirror(c: number): number {
  return cellAt(-Q[c], -R[c]);
}

/** Where a hole's centre is, in units of the gap between holes, with the middle hole at 0, 0. */
export function centre(c: number): { x: number; y: number } {
  return { x: Q[c] + R[c] / 2, y: (R[c] * Math.sqrt(3)) / 2 };
}

/** The hole nearest a point (in the units of `centre`), or −1 if that's off the board. */
export function cellNear(x: number, y: number): number {
  const r = (y * 2) / Math.sqrt(3);
  const q = x - r / 2;
  // Round in cube coordinates, fixing whichever axis rounded furthest.
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return cellAt(rq, rr);
}

/**
 * A hole's name in Abalone's notation: rows A (bottom) to I (top), and numbers along the
 * diagonals from 1 on the left, so the bottom row is A1–A5 and the middle row E1–E9.
 */
export function cellName(c: number): string {
  return `${"ABCDEFGHI"[MAX - R[c]]}${Q[c] + SIDE}`;
}

/** The hole with that name, or −1. */
export function cellNamed(name: string): number {
  const row = "ABCDEFGHI".indexOf(name[0]?.toUpperCase() ?? "");
  const n = Number(name.slice(1));
  if (row < 0 || !Number.isInteger(n)) return -1;
  return cellAt(n - SIDE, MAX - row);
}
