// The rules as pure functions: board layouts, legal placements, move generation and scoring.
// The server checks moves and runs the CPUs with these; the client draws the ghost, the open
// corners and the home-screen demo with them.
import {
  MONOMINO,
  PIECE_COUNT,
  PIECE_IDS,
  TOTAL_SQUARES,
  orientations,
  pieceIndex,
  pieceSize,
  type PieceId,
} from "./pieces";

export const EMPTY = -1;

/** A placement: a piece, one of its orientations, and the top-left of that orientation's box. */
export interface Move {
  piece: PieceId;
  orient: number;
  x: number;
  y: number;
}

/** Everything the rules need to know about a game in progress. Seats are 0–3. */
export interface Position {
  size: number;
  /** size × size, row by row: the seat that covers each square, or EMPTY. */
  cells: Int8Array;
  /** Each seat's starting square. */
  starts: readonly number[];
  /** Each seat's pieces left. A full tray means that seat hasn't placed yet. */
  trays: readonly (readonly PieceId[])[];
}

export interface Layout {
  size: number;
  starts: number[];
}

/**
 * 3–4 players: 20×20 with a start in each corner, clockwise from the top left (with 3, the
 * bottom-left corner stays empty). 2 players: 14×14 with the starts near the middle, as in Duo.
 */
export function layoutFor(players: number): Layout {
  if (players <= 2) {
    const size = 14;
    return { size, starts: [4 * size + 4, 9 * size + 9] };
  }
  const size = 20;
  const m = size - 1;
  return { size, starts: [0, m, m * size + m, m * size].slice(0, players) };
}

export function newPosition(layout: Layout): Position {
  return {
    size: layout.size,
    cells: new Int8Array(layout.size * layout.size).fill(EMPTY),
    starts: layout.starts,
    trays: layout.starts.map(() => [...PIECE_IDS]),
  };
}

export function isFirstMove(pos: Position, seat: number): boolean {
  return pos.trays[seat].length === PIECE_COUNT;
}

/** The squares a move covers, or null if any of them is off the board. */
export function moveCells(size: number, m: Move): number[] | null {
  const o = orientations(m.piece)[m.orient];
  if (!o || !Number.isInteger(m.x) || !Number.isInteger(m.y)) return null;
  if (m.x < 0 || m.y < 0 || m.x + o.w > size || m.y + o.h > size) return null;
  return o.cells.map(([dx, dy]) => (m.y + dy) * size + m.x + dx);
}

/** Why a move isn't allowed, or null if it is. */
export function placementError(pos: Position, seat: number, m: Move): string | null {
  const tray = pos.trays[seat];
  if (!tray?.includes(m.piece)) return "You've already placed that piece";
  if (!orientations(m.piece)[m.orient]) return "That isn't a way that piece can turn";
  const cells = moveCells(pos.size, m);
  if (!cells) return "That doesn't fit on the board";
  const { size } = pos;
  const first = isFirstMove(pos, seat);
  const reserved = reservedStarts(pos, seat);
  for (const i of cells) {
    if (pos.cells[i] !== EMPTY) return "That space is taken";
    if (reserved.includes(i)) return "That's another player's starting square";
  }
  if (first) {
    return cells.includes(pos.starts[seat]) ? null : "Your first piece must cover your starting square";
  }
  let corner = false;
  for (const i of cells) {
    const x = i % size;
    const y = (i - x) / size;
    if (touchesEdge(pos, seat, x, y)) return "Your pieces can't touch along an edge";
    if (!corner && touchesCorner(pos, seat, x, y)) corner = true;
  }
  return corner ? null : "It must touch one of your pieces at a corner";
}

/** Put a move on the board. Returns a new position; the move must be legal. */
export function play(pos: Position, seat: number, m: Move): Position {
  const cells = pos.cells.slice();
  for (const i of moveCells(pos.size, m)!) cells[i] = seat;
  const trays = pos.trays.slice();
  trays[seat] = trays[seat].filter((p) => p !== m.piece);
  return { ...pos, cells, trays };
}

/**
 * A seat's open corners: empty squares diagonal to one of its pieces and not edge to edge with
 * any. Before its first piece, its starting square (if it's still free).
 */
export function anchors(pos: Position, seat: number): number[] {
  const { size, cells } = pos;
  if (isFirstMove(pos, seat)) {
    const start = pos.starts[seat];
    return cells[start] === EMPTY ? [start] : [];
  }
  const out: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (cells[i] !== EMPTY) continue;
      if (touchesCorner(pos, seat, x, y) && !touchesEdge(pos, seat, x, y)) out.push(i);
    }
  }
  return out;
}

/**
 * Calls `found` once for every legal placement of the given pieces (default: the whole tray),
 * with the open corner it was found from. Stop early by returning true.
 */
export function eachMove(
  pos: Position,
  seat: number,
  found: (m: Move, anchor: number) => boolean | void,
  pieces: readonly PieceId[] = pos.trays[seat],
): void {
  const { size, cells } = pos;
  const first = isFirstMove(pos, seat);
  const reserved = reservedStarts(pos, seat);
  const seen = new Set<number>();
  for (const a of anchors(pos, seat)) {
    const ax = a % size;
    const ay = (a - ax) / size;
    for (const piece of pieces) {
      const pi = pieceIndex(piece);
      const orients = orientations(piece);
      for (let oi = 0; oi < orients.length; oi++) {
        const o = orients[oi];
        for (const [cx, cy] of o.cells) {
          const x = ax - cx;
          const y = ay - cy;
          if (x < 0 || y < 0 || x + o.w > size || y + o.h > size) continue;
          const key = ((pi * 8 + oi) * size + y) * size + x;
          if (seen.has(key)) continue;
          let ok = true;
          for (const [dx, dy] of o.cells) {
            const px = x + dx;
            const py = y + dy;
            const i = py * size + px;
            if (cells[i] !== EMPTY || (reserved.length && reserved.includes(i)) || (!first && touchesEdge(pos, seat, px, py))) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          // Found from another corner too: still one move.
          seen.add(key);
          if (found({ piece, orient: oi, x, y }, a)) return;
        }
      }
    }
  }
}

export function legalMoves(pos: Position, seat: number, pieces?: readonly PieceId[]): Move[] {
  const out: Move[] = [];
  eachMove(pos, seat, (m) => void out.push(m), pieces);
  return out;
}

export function hasLegalMove(pos: Position, seat: number): boolean {
  let any = false;
  eachMove(pos, seat, () => (any = true));
  return any;
}

/** The pieces in a seat's tray that fit somewhere right now. */
export function fittingPieces(pos: Position, seat: number): Set<PieceId> {
  const fits = new Set<PieceId>();
  for (const piece of pos.trays[seat]) {
    eachMove(pos, seat, () => (fits.add(piece), true), [piece]);
  }
  return fits;
}

// ------------------------------------------------------------------ scoring

export function squaresLeft(tray: readonly PieceId[]): number {
  return tray.reduce((n, p) => n + pieceSize(p), 0);
}

export function squaresPlaced(tray: readonly PieceId[]): number {
  return TOTAL_SQUARES - squaresLeft(tray);
}

/** −1 per square left; +15 for placing everything, +20 if the monomino went last. */
export function scoreFor(tray: readonly PieceId[], lastPiece: PieceId | null): number {
  if (tray.length === 0) return lastPiece === MONOMINO ? 20 : 15;
  return -squaresLeft(tray);
}

// ------------------------------------------------------------------ helpers

function reservedStarts(pos: Position, seat: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < pos.starts.length; s++) {
    if (s !== seat && isFirstMove(pos, s)) out.push(pos.starts[s]);
  }
  return out;
}

export function touchesEdge(pos: Position, seat: number, x: number, y: number): boolean {
  const { size, cells } = pos;
  return (
    (x > 0 && cells[y * size + x - 1] === seat) ||
    (x < size - 1 && cells[y * size + x + 1] === seat) ||
    (y > 0 && cells[(y - 1) * size + x] === seat) ||
    (y < size - 1 && cells[(y + 1) * size + x] === seat)
  );
}

export function touchesCorner(pos: Position, seat: number, x: number, y: number): boolean {
  const { size, cells } = pos;
  const up = y > 0;
  const down = y < size - 1;
  return (
    (x > 0 && ((up && cells[(y - 1) * size + x - 1] === seat) || (down && cells[(y + 1) * size + x - 1] === seat))) ||
    (x < size - 1 && ((up && cells[(y - 1) * size + x + 1] === seat) || (down && cells[(y + 1) * size + x + 1] === seat)))
  );
}
