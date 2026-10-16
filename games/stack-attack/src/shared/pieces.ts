import { mulberry32, shuffle, type Rng } from "@warrick/kit/shared/rng";

// Cell values on a board: 0 is empty, 1–7 are the pieces, 8 is garbage.
export const I = 1;
export const O = 2;
export const T = 3;
export const S = 4;
export const Z = 5;
export const J = 6;
export const L = 7;
export const GARBAGE = 8;

export type Piece = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const PIECE_LETTERS = ".IOTSZJL#";

export function isPiece(v: unknown): v is Piece {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 7;
}

/** [dx, dy] of each block, with dy counting down from the top of the piece's box. */
export type Cells = readonly (readonly [number, number])[];

// Spawn orientations, in the boxes the Super Rotation System turns them in.
const SPAWN: Record<Piece, { n: number; cells: [number, number][] }> = {
  [I]: {
    n: 4,
    cells: [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
  },
  [O]: {
    n: 4,
    cells: [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
  },
  [T]: {
    n: 3,
    cells: [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  },
  [S]: {
    n: 3,
    cells: [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
    ],
  },
  [Z]: {
    n: 3,
    cells: [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
  },
  [J]: {
    n: 3,
    cells: [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  },
  [L]: {
    n: 3,
    cells: [
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  },
};

/** SHAPES[piece][rotation]: rotation 0 is the spawn orientation, then clockwise. */
export const SHAPES: Cells[][] = [[]];
for (let p = 1 as Piece; p <= 7; p++) {
  const { n, cells } = SPAWN[p];
  const rots: Cells[] = [cells];
  for (let r = 1; r < 4; r++) {
    // The O piece doesn't turn; turning its box would shift it.
    rots.push(p === O ? cells : rots[r - 1].map(([x, y]) => [n - 1 - y, x] as const));
  }
  SHAPES[p] = rots;
}

/** Wall kicks, [dx, dy] with dy up, tried in order. Keyed by "from>to" rotation. */
type Kicks = Record<string, readonly (readonly [number, number])[]>;

const JLSTZ_KICKS: Kicks = {
  "0>1": [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ],
  "1>0": [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ],
  "1>2": [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ],
  "2>1": [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ],
  "2>3": [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ],
  "3>2": [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ],
  "3>0": [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ],
  "0>3": [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ],
};

const I_KICKS: Kicks = {
  "0>1": [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, -1],
    [1, 2],
  ],
  "1>0": [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, 1],
    [-1, -2],
  ],
  "1>2": [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, 2],
    [2, -1],
  ],
  "2>1": [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, -2],
    [-2, 1],
  ],
  "2>3": [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, 1],
    [-1, -2],
  ],
  "3>2": [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, -1],
    [1, 2],
  ],
  "3>0": [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, -2],
    [-2, 1],
  ],
  "0>3": [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, 2],
    [2, -1],
  ],
};

const NO_KICKS = [[0, 0]] as const;

export function kicks(p: Piece, from: number, to: number): readonly (readonly [number, number])[] {
  if (p === O) return NO_KICKS;
  return (p === I ? I_KICKS : JLSTZ_KICKS)[`${from}>${to}`];
}

/**
 * The piece sequence: shuffled bags of all seven. Everyone in a round shares a seed, so
 * everyone gets the same pieces in the same order.
 */
export class Bag {
  private seq: Piece[] = [];
  private rng: Rng;

  constructor(readonly seed: number) {
    this.rng = mulberry32(seed);
  }

  at(i: number): Piece {
    while (this.seq.length <= i) this.seq.push(...shuffle(this.rng, [I, O, T, S, Z, J, L] as Piece[]));
    return this.seq[i];
  }
}
