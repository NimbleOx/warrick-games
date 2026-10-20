// Abalone's rules as pure functions over a board: which moves are legal (and why not), what a
// move does, and the starting positions. The server checks every move with `shove`, and the
// client uses the same function for its previews and the reason under the board.
import { CELLS, cellNamed, opposite, step } from "./hex";

/** An empty hole. Otherwise a hole holds the seat (0 or 1) whose marble is in it. */
export const EMPTY = -1;
/** Marbles each player starts with. */
export const MARBLES = 14;
/** Push this many of the other player's marbles off the board to win. */
export const TO_WIN = 6;
/** The most marbles you can move at once. */
export const MAX_LINE = 3;

export type Layout = "standard" | "belgian" | "german";
export const LAYOUT_IDS: readonly Layout[] = ["standard", "belgian", "german"];
export const LAYOUT_NAMES: Record<Layout, string> = {
  standard: "Classic",
  belgian: "Belgian daisy",
  german: "German daisy",
};

/** The starting holes, in Abalone's notation: seat 0 (who moves first) and seat 1. */
const STARTS: Record<Layout, [string, string]> = {
  // Three rows each, from the bottom and the top edges: the box's layout.
  standard: ["A1 A2 A3 A4 A5 B1 B2 B3 B4 B5 B6 C3 C4 C5", "I5 I6 I7 I8 I9 H4 H5 H6 H7 H8 H9 G5 G6 G7"],
  // Two "daisies" of seven each, in opposite corners, beside two of the other player's.
  belgian: ["A1 A2 B1 B2 B3 C2 C3 G7 G8 H7 H8 H9 I8 I9", "A4 A5 B4 B5 B6 C5 C6 G4 G5 H4 H5 H6 I5 I6"],
  // The same daisies, one row further in.
  german: ["B1 B2 C1 C2 C3 D2 D3 F7 F8 G7 G8 G9 H8 H9", "B5 B6 C5 C6 C7 D6 D7 F3 F4 G3 G4 G5 H4 H5"],
};

export function newBoard(layout: Layout): number[] {
  const board = new Array<number>(CELLS).fill(EMPTY);
  STARTS[layout].forEach((names, seat) => {
    for (const name of names.split(" ")) board[cellNamed(name)] = seat;
  });
  return board;
}

/** Your marbles (1 to 3 in a line) and which way they go (0–5, see `DIRS`). */
export interface Move {
  marbles: number[];
  dir: number;
}

/** What a legal move does. */
export interface Shove {
  dir: number;
  /** Your marbles, front first: for a move along the line, the one at the front. */
  marbles: number[];
  /** Along the line (which can push) or a side step (which can't). */
  inline: boolean;
  /** The other player's marbles it pushes, nearest first. */
  pushed: number[];
  /** The hole of the marble it pushes off the board, or −1. */
  off: number;
}

/**
 * Marbles in a straight line, side by side: in order along `axis` (east, north-east or
 * north-west), or null.
 */
export function lineOf(cells: readonly number[]): { ordered: number[]; axis: number } | null {
  if (cells.length === 1) return { ordered: [cells[0]], axis: -1 };
  for (const start of cells) {
    for (let d = 0; d < 3; d++) {
      const ordered = [start];
      for (let i = 1; i < cells.length; i++) ordered.push(step(ordered[i - 1], d));
      if (ordered.every((c) => c >= 0 && cells.includes(c))) return { ordered, axis: d };
    }
  }
  return null;
}

const WORDS = ["none", "one", "two", "three", "four", "five", "six"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * What `move` does for `seat`, or why it isn't allowed (a sentence for the player).
 * Abalone's rules:
 * - Move 1, 2 or 3 of your marbles in a straight line, side by side, one hole in any direction.
 * - Along the line, the front marble can push the other player's marbles in front of it, if
 *   you have more marbles in the line than they do (2 push 1, 3 push 1 or 2), and there's an
 *   empty hole or the edge of the board behind them. A marble pushed past the edge is off.
 * - A side step (across the line) needs an empty hole for every marble, and pushes nothing.
 * - You can never push your own marbles off.
 */
export function shove(board: ArrayLike<number>, seat: number, move: Move): Shove | string {
  const cells = move.marbles;
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_LINE) return `Pick 1 to ${MAX_LINE} of your marbles`;
  if (new Set(cells).size !== cells.length || !cells.every((c) => Number.isInteger(c) && c >= 0 && c < CELLS))
    return `Pick 1 to ${MAX_LINE} of your marbles`;
  if (!cells.every((c) => board[c] === seat)) return "Those aren't all your marbles";
  const dir = move.dir;
  if (!Number.isInteger(dir) || dir < 0 || dir > 5) return "That's not a direction";
  const line = lineOf(cells);
  if (!line) return "Pick marbles in a straight line, side by side";
  const n = cells.length;

  if (n > 1 && dir !== line.axis && dir !== opposite(line.axis)) {
    // A side step.
    for (const c of line.ordered) {
      const to = step(c, dir);
      if (to < 0) return "You can't move off the board";
      if (board[to] !== EMPTY) return "A side step needs an empty hole in front of every marble";
    }
    return { dir, marbles: line.ordered, inline: false, pushed: [], off: -1 };
  }

  // Along the line: front marble first.
  const marbles = dir === line.axis ? [...line.ordered].reverse() : line.ordered;
  let at = step(marbles[0], dir);
  if (at < 0) return "You can't push your own marbles off the board";
  if (board[at] === seat)
    return n === MAX_LINE ? `You can move at most ${MAX_LINE} marbles at once` : "One of your own marbles is in the way";
  const pushed: number[] = [];
  while (at >= 0 && board[at] !== EMPTY && board[at] !== seat) {
    pushed.push(at);
    at = step(at, dir);
  }
  if (pushed.length) {
    if (at >= 0 && board[at] === seat) return "Blocked: one of your marbles is behind theirs";
    if (n === 1) return "One marble can't push: you need more marbles in the line than they have";
    if (pushed.length >= n)
      return `${cap(WORDS[n])} can't push ${WORDS[Math.min(pushed.length, 6)]}: you need more marbles in the line than they have`;
  }
  return { dir, marbles, inline: true, pushed, off: pushed.length && at < 0 ? pushed[pushed.length - 1] : -1 };
}

/** Make a legal move's changes to the board. */
export function play(board: number[] | Int8Array, seat: number, sh: Shove): void {
  const theirs = sh.pushed.length ? board[sh.pushed[0]] : EMPTY;
  for (const c of sh.pushed) board[c] = EMPTY;
  for (const c of sh.marbles) board[c] = EMPTY;
  for (const c of sh.pushed) {
    const to = step(c, sh.dir);
    if (to >= 0) board[to] = theirs;
  }
  for (const c of sh.marbles) board[step(c, sh.dir)] = seat;
}

/**
 * Every group of 1 to 3 of `seat`'s marbles in a line: each line once, as its marbles in order
 * along one of the directions east, north-east or north-west.
 */
export function groups(board: ArrayLike<number>, seat: number): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < CELLS; c++) {
    if (board[c] !== seat) continue;
    out.push([c]);
    for (let d = 0; d < 3; d++) {
      const b = step(c, d);
      if (b < 0 || board[b] !== seat) continue;
      out.push([c, b]);
      const e = step(b, d);
      if (e >= 0 && board[e] === seat) out.push([c, b, e]);
    }
  }
  return out;
}

/** Every legal move for `seat`, with what it does. */
export function legalShoves(board: ArrayLike<number>, seat: number): Shove[] {
  const out: Shove[] = [];
  for (const marbles of groups(board, seat)) {
    for (let dir = 0; dir < 6; dir++) {
      const sh = shove(board, seat, { marbles, dir });
      if (typeof sh !== "string") out.push(sh);
    }
  }
  return out;
}

export function hasLegalMove(board: ArrayLike<number>, seat: number): boolean {
  for (const marbles of groups(board, seat)) {
    for (let dir = 0; dir < 6; dir++) if (typeof shove(board, seat, { marbles, dir }) !== "string") return true;
  }
  return false;
}

/** How many of `seat`'s marbles are on the board. */
export function count(board: ArrayLike<number>, seat: number): number {
  let n = 0;
  for (let c = 0; c < CELLS; c++) if (board[c] === seat) n++;
  return n;
}
