// The board and its rules, as pure functions over plain data.
//
// A board of w × h boxes has (w + 1) × (h + 1) dots. Edges are numbered horizontal first,
// row by row (r * w + c for r in 0..h), then vertical (H + r * (w + 1) + c for r in 0..h-1),
// where H = (h + 1) * w. Box (r, c) is r * w + c.

/** An undrawn line or an unclaimed box. */
export const NONE = -1;
/**
 * A line drawn by nobody, or a box that isn't part of the board. Not used in v1; it's how
 * holes and a pre-drawn outer edge would be set up, and everything here already treats such a
 * line as drawn and such a box as out of play.
 */
export const NOBODY = -2;

export interface Board {
  /** Boxes across and down. */
  w: number;
  h: number;
  /** Per edge: the seat that drew it, or NONE. */
  lines: number[];
  /** Per box: the seat that claimed it, or NONE. */
  boxes: number[];
}

export interface Geometry {
  w: number;
  h: number;
  /** The number of horizontal edges; vertical ones come after them. */
  hCount: number;
  edgeCount: number;
  boxCount: number;
  /** Each box's edges: top, bottom, left, right. */
  boxEdges: number[][];
  /** Each edge's one or two boxes. */
  edgeBoxes: number[][];
  /** Each edge's end dots, as [x0, y0, x1, y1] in box units (x across, y down). */
  ends: [number, number, number, number][];
}

const cache = new Map<string, Geometry>();

export function geometry(w: number, h: number): Geometry {
  const key = `${w}x${h}`;
  let g = cache.get(key);
  if (g) return g;
  const hCount = (h + 1) * w;
  const edgeCount = hCount + h * (w + 1);
  const boxCount = w * h;
  const boxEdges: number[][] = [];
  const edgeBoxes: number[][] = Array.from({ length: edgeCount }, () => []);
  const ends: [number, number, number, number][] = [];
  for (let r = 0; r <= h; r++) for (let c = 0; c < w; c++) ends.push([c, r, c + 1, r]);
  for (let r = 0; r < h; r++) for (let c = 0; c <= w; c++) ends.push([c, r, c, r + 1]);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const b = r * w + c;
      const edges = [r * w + c, (r + 1) * w + c, hCount + r * (w + 1) + c, hCount + r * (w + 1) + c + 1];
      boxEdges.push(edges);
      for (const e of edges) edgeBoxes[e].push(b);
    }
  }
  g = { w, h, hCount, edgeCount, boxCount, boxEdges, edgeBoxes, ends };
  cache.set(key, g);
  return g;
}

export function newBoard(w: number, h: number): Board {
  const g = geometry(w, h);
  return { w, h, lines: new Array(g.edgeCount).fill(NONE), boxes: new Array(g.boxCount).fill(NONE) };
}

export function cloneBoard(b: Board): Board {
  return { w: b.w, h: b.h, lines: b.lines.slice(), boxes: b.boxes.slice() };
}

export function isDrawn(b: Board, e: number): boolean {
  return b.lines[e] !== NONE;
}

/** How many of a box's sides are still undrawn. */
export function undrawnSides(b: Board, box: number): number {
  let n = 0;
  for (const e of geometry(b.w, b.h).boxEdges[box]) if (b.lines[e] === NONE) n++;
  return n;
}

/** A box still in play: not claimed, not a hole. */
export function isOpen(b: Board, box: number): boolean {
  return b.boxes[box] === NONE;
}

export function isLine(b: Board, e: unknown): e is number {
  return Number.isInteger(e) && (e as number) >= 0 && (e as number) < b.lines.length;
}

/**
 * Draw a line for a seat and claim every box it completes. Returns the boxes it completed:
 * if there are any, the same seat moves again. The caller checks the line is undrawn.
 */
export function playLine(b: Board, e: number, seat: number): number[] {
  b.lines[e] = seat;
  const done: number[] = [];
  for (const box of geometry(b.w, b.h).edgeBoxes[e]) {
    if (isOpen(b, box) && undrawnSides(b, box) === 0) {
      b.boxes[box] = seat;
      done.push(box);
    }
  }
  return done;
}

export function undrawnLines(b: Board): number[] {
  const out: number[] = [];
  for (let e = 0; e < b.lines.length; e++) if (b.lines[e] === NONE) out.push(e);
  return out;
}

export function isOver(b: Board): boolean {
  return b.boxes.every((o) => o !== NONE);
}

export function boxesLeft(b: Board): number {
  return b.boxes.filter((o) => o === NONE).length;
}

/** Boxes held by each seat. */
export function boxCounts(b: Board, seats: number): number[] {
  const out = new Array(seats).fill(0);
  for (const o of b.boxes) if (o >= 0 && o < seats) out[o]++;
  return out;
}

// ------------------------------------------------------------------ board sizes

export type BoardSize = "small" | "medium" | "large";

/** Columns × rows of boxes for 2..8 players. */
const SIZES: Record<BoardSize, [number, number][]> = {
  small: [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [7, 6], [8, 6]],
  medium: [[5, 5], [6, 5], [6, 6], [7, 6], [8, 6], [8, 7], [9, 7]],
  large: [[7, 6], [8, 6], [8, 7], [9, 7], [9, 8], [10, 8], [11, 8]],
};

export function boardSize(size: BoardSize, players: number): { w: number; h: number } {
  const row = SIZES[size] ?? SIZES.medium;
  const [w, h] = row[Math.min(row.length - 1, Math.max(0, players - 2))];
  return { w, h };
}
