// The 21 pieces: every polyomino of 1 to 5 squares, and their 91 distinct orientations.

export type Cell = readonly [x: number, y: number];

export interface PieceDef {
  id: string;
  name: string;
  cells: readonly Cell[];
  /** How hard it is to fit late in the game; the hard CPU plays these while there's room. */
  awkward: number;
}

/** One rotation/flip of a piece, moved to the top-left: every x and y starts at 0. */
export interface Orientation {
  cells: readonly Cell[];
  w: number;
  h: number;
}

// Drawn with x to the right and y down. Order is the tray's order: small to big.
const DEFS = [
  { id: "1", name: "Monomino", awkward: -4, cells: [[0, 0]] },
  { id: "2", name: "Domino", awkward: 0, cells: [[0, 0], [1, 0]] },
  { id: "I3", name: "I-tromino", awkward: 0.5, cells: [[0, 0], [1, 0], [2, 0]] },
  { id: "V3", name: "V-tromino", awkward: 0.3, cells: [[0, 0], [0, 1], [1, 1]] },
  { id: "I4", name: "I-tetromino", awkward: 1.5, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: "O4", name: "O-tetromino", awkward: 1.2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  { id: "T4", name: "T-tetromino", awkward: 1.3, cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
  { id: "L4", name: "L-tetromino", awkward: 1, cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
  { id: "S4", name: "S-tetromino", awkward: 1.3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { id: "F", name: "F-pentomino", awkward: 3.5, cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]] },
  { id: "I5", name: "I-pentomino", awkward: 3, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },
  { id: "L5", name: "L-pentomino", awkward: 2, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]] },
  { id: "N", name: "N-pentomino", awkward: 2.5, cells: [[1, 0], [1, 1], [0, 2], [1, 2], [0, 3]] },
  { id: "P", name: "P-pentomino", awkward: 1.5, cells: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]] },
  { id: "T5", name: "T-pentomino", awkward: 3, cells: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]] },
  { id: "U", name: "U-pentomino", awkward: 2.5, cells: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
  { id: "V5", name: "V-pentomino", awkward: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },
  { id: "W", name: "W-pentomino", awkward: 4, cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]] },
  { id: "X", name: "X-pentomino", awkward: 5, cells: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
  { id: "Y", name: "Y-pentomino", awkward: 2.5, cells: [[1, 0], [0, 1], [1, 1], [1, 2], [1, 3]] },
  { id: "Z5", name: "Z-pentomino", awkward: 3.5, cells: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]] },
] as const satisfies readonly PieceDef[];

export type PieceId = (typeof DEFS)[number]["id"];

export const PIECES: readonly PieceDef[] = DEFS;
export const PIECE_IDS: readonly PieceId[] = DEFS.map((d) => d.id);
export const PIECE_COUNT = PIECE_IDS.length;
export const MONOMINO: PieceId = "1";

const INDEX = new Map<string, number>(PIECE_IDS.map((id, i) => [id, i]));

export function isPieceId(v: unknown): v is PieceId {
  return typeof v === "string" && INDEX.has(v);
}

export function pieceIndex(id: PieceId): number {
  return INDEX.get(id)!;
}

export function pieceDef(id: PieceId): PieceDef {
  return PIECES[pieceIndex(id)];
}

export function pieceSize(id: PieceId): number {
  return pieceDef(id).cells.length;
}

/** Squares in a full tray: 89. */
export const TOTAL_SQUARES = PIECE_IDS.reduce((n, id) => n + pieceSize(id), 0);

// ------------------------------------------------------------------ orientations

/**
 * A transform is a rotation (0–3 quarter turns clockwise) after an optional mirror:
 * t = rot + (flipped ? 4 : 0).
 */
export function transformCells(cells: readonly Cell[], t: number): Cell[] {
  const rot = t & 3;
  const out = cells.map(([x0, y0]): Cell => {
    let x = t >= 4 ? -x0 : x0;
    let y = y0;
    // A quarter turn clockwise on screen (y down): (x, y) → (−y, x).
    for (let r = 0; r < rot; r++) [x, y] = [-y, x];
    return [x, y];
  });
  return normalize(out);
}

function normalize(cells: Cell[]): Cell[] {
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]): Cell => [x - minX, y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function keyOf(cells: readonly Cell[]): string {
  return cells.map(([x, y]) => `${x},${y}`).join(" ");
}

interface PieceOrients {
  orients: Orientation[];
  /** Transform (0–7) → index into `orients`. */
  byTransform: number[];
}

const ORIENTS: PieceOrients[] = PIECES.map((p) => {
  const orients: Orientation[] = [];
  const seen = new Map<string, number>();
  const byTransform: number[] = [];
  for (let t = 0; t < 8; t++) {
    const cells = transformCells(p.cells, t);
    const key = keyOf(cells);
    let i = seen.get(key);
    if (i === undefined) {
      i = orients.length;
      seen.set(key, i);
      orients.push({
        cells,
        w: Math.max(...cells.map((c) => c[0])) + 1,
        h: Math.max(...cells.map((c) => c[1])) + 1,
      });
    }
    byTransform.push(i);
  }
  return { orients, byTransform };
});

/** The distinct orientations of a piece (1 for the X, 8 for the F). */
export function orientations(id: PieceId): readonly Orientation[] {
  return ORIENTS[pieceIndex(id)].orients;
}

/** The orientation a transform (0–7) gives. */
export function orientFor(id: PieceId, t: number): number {
  return ORIENTS[pieceIndex(id)].byTransform[t & 7];
}

/** All the orientations of all the pieces: 91. */
export const ORIENTATION_COUNT = ORIENTS.reduce((n, o) => n + o.orients.length, 0);

/** The transform after a quarter turn clockwise (dir 1) or anticlockwise (dir −1) on screen. */
export function rotateT(t: number, dir: 1 | -1 = 1): number {
  return ((t + dir + 4) & 3) | (t & 4);
}

/** The transform after mirroring left to right on screen. */
export function flipT(t: number): number {
  // Mirroring a shape turned r times is the mirror image turned −r times.
  return ((4 - (t & 3)) & 3) | ((t & 4) ^ 4);
}
