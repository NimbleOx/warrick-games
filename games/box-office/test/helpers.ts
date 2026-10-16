import { NONE, geometry, newBoard, type Board } from "../src/shared/board";

/**
 * A board from a picture. Dots are `+`, drawn lines `-` and `|`, and a digit inside a box
 * claims it for that seat (its sides are drawn whatever the picture says). Lines are drawn
 * by seat 0. Leading indentation is ignored.
 *
 *   +-+-+
 *   |0|
 *   +-+ +
 */
export function board(picture: string): Board {
  const rows = picture
    .replace(/^\n/, "")
    .replace(/\n\s*$/, "")
    .split("\n");
  const indent = Math.min(...rows.filter((r) => r.trim()).map((r) => r.match(/^ */)![0].length));
  const text = rows.map((r) => r.slice(indent));
  const h = (text.length - 1) / 2;
  const w = (Math.max(...text.map((r) => r.length)) - 1) / 2;
  if (!Number.isInteger(h) || !Number.isInteger(w)) throw new Error("Bad board picture");
  const b = newBoard(w, h);
  const g = geometry(w, h);
  const at = (r: number, c: number) => text[r]?.[c] ?? " ";
  for (let r = 0; r <= h; r++) for (let c = 0; c < w; c++) if (at(2 * r, 2 * c + 1) === "-") b.lines[hEdge(b, r, c)] = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c <= w; c++) if (at(2 * r + 1, 2 * c) === "|") b.lines[vEdge(b, r, c)] = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = at(2 * r + 1, 2 * c + 1);
      if (!/\d/.test(ch)) continue;
      const box = r * w + c;
      b.boxes[box] = Number(ch);
      for (const e of g.boxEdges[box]) if (b.lines[e] === NONE) b.lines[e] = 0;
    }
  }
  return b;
}

/** The horizontal edge above box row r (r = h is the bottom border), column c. */
export function hEdge(b: Board, r: number, c: number): number {
  return r * b.w + c;
}

/** The vertical edge left of box column c (c = w is the right border), row r. */
export function vEdge(b: Board, r: number, c: number): number {
  return (b.h + 1) * b.w + r * (b.w + 1) + c;
}

export function box(b: Board, r: number, c: number): number {
  return r * b.w + c;
}
