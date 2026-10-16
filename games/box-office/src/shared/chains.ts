// Reading a position: which lines are safe, what a line gives away, and the chains and loops
// the endgame is played over. Pure functions; the ones that play lines out work on a copy.
import { NONE, cloneBoard, geometry, isOpen, playLine, undrawnSides, type Board } from "./board";

/** Boxes with three sides drawn: whoever moves can complete them. */
export function capturable(b: Board): number[] {
  const out: number[] = [];
  for (let box = 0; box < b.boxes.length; box++) {
    if (isOpen(b, box) && undrawnSides(b, box) === 1) out.push(box);
  }
  return out;
}

/** The one undrawn side of a box with three sides drawn (or -1). */
export function lastSide(b: Board, box: number): number {
  for (const e of geometry(b.w, b.h).boxEdges[box]) if (b.lines[e] === NONE) return e;
  return -1;
}

/** The box on the other side of an edge from `box`, if there is one in play. */
export function across(b: Board, e: number, box: number): number {
  for (const o of geometry(b.w, b.h).edgeBoxes[e]) if (o !== box && isOpen(b, o)) return o;
  return -1;
}

/**
 * A line that doesn't give anyone a box: it doesn't make any box's third side. (A line that
 * completes a box isn't "safe" either; that's a capture.)
 */
export function isSafe(b: Board, e: number): boolean {
  if (b.lines[e] !== NONE) return false;
  for (const box of geometry(b.w, b.h).edgeBoxes[e]) {
    if (isOpen(b, box) && undrawnSides(b, box) <= 2) return false;
  }
  return true;
}

export function safeLines(b: Board): number[] {
  const out: number[] = [];
  for (let e = 0; e < b.lines.length; e++) if (isSafe(b, e)) out.push(e);
  return out;
}

/**
 * Complete boxes for a seat until none can be completed, drawing each one's last side.
 * With `from`, only follow the captures that start at those boxes. Changes the board;
 * returns the lines drawn and the boxes taken.
 */
export function takeAll(b: Board, seat: number, from?: number[]): { lines: number[]; taken: number[] } {
  const lines: number[] = [];
  const taken: number[] = [];
  const todo = from ? from.slice() : capturable(b);
  while (todo.length) {
    const box = todo.pop()!;
    if (!isOpen(b, box) || undrawnSides(b, box) !== 1) continue;
    const e = lastSide(b, box);
    const next = across(b, e, box);
    lines.push(e);
    taken.push(...playLine(b, e, seat));
    if (next >= 0 && isOpen(b, next) && undrawnSides(b, next) === 1) todo.push(next);
  }
  return { lines, taken };
}

/**
 * Play a line out on a copy: draw it, then the next player takes everything they can.
 * Assumes no box can be completed before the line is drawn.
 */
export function playOut(b: Board, e: number): { taken: number[]; after: Board } {
  const after = cloneBoard(b);
  playLine(after, e, 0);
  const { taken } = takeAll(after, 1);
  return { taken, after };
}

/** How many boxes a line hands the next player. */
export function giveaway(b: Board, e: number): number {
  return playOut(b, e).taken.length;
}

/** How many boxes a capture run starting at this box takes. */
export function runSize(b: Board, box: number): number {
  return takeAll(cloneBoard(b), 0, [box]).taken.length;
}

// ------------------------------------------------------------------ declining

export interface Decline {
  /** The double-dealing line: it completes nothing and leaves the boxes for the next player. */
  line: number;
  /** How many boxes it hands over: 2 at the end of a chain, 4 at the end of a loop. */
  keep: 2 | 4;
}

/**
 * Whether the player to move can decline the boxes on offer right now: everything left to
 * take is the last two boxes of a chain or the last four of a loop.
 */
export function declinePoint(b: Board): Decline | null {
  const caps = capturable(b);
  if (caps.length === 0 || caps.length > 2) return null;
  const total = takeAll(cloneBoard(b), 0).taken.length;
  if (caps.length === 1 && total === 2) {
    // x is ready to take; y behind it has two sides left. Drawing y's far side leaves a
    // domino: two boxes the next player takes with one line.
    const x = caps[0];
    const e1 = lastSide(b, x);
    const y = across(b, e1, x);
    if (y < 0 || undrawnSides(b, y) !== 2) return null;
    const far = geometry(b.w, b.h).boxEdges[y].find((e) => e !== e1 && b.lines[e] === NONE);
    return far === undefined ? null : { line: far, keep: 2 };
  }
  if (caps.length === 2 && total === 4) {
    // a - p - q - d with both ends ready: drawing p|q leaves two dominoes.
    const [a, d] = caps;
    const ea = lastSide(b, a);
    const ed = lastSide(b, d);
    if (ea === ed) return null;
    const p = across(b, ea, a);
    const q = across(b, ed, d);
    if (p < 0 || q < 0 || p === q || undrawnSides(b, p) !== 2 || undrawnSides(b, q) !== 2) return null;
    const g = geometry(b.w, b.h);
    const mid = g.boxEdges[p].find((e) => b.lines[e] === NONE && g.edgeBoxes[e].includes(q));
    return mid === undefined ? null : { line: mid, keep: 4 };
  }
  return null;
}

/**
 * The capture to make first when you might decline at the end: finish the smallest run first,
 * so the one you might decline comes last.
 */
export function captureOrder(b: Board): number[] {
  return capturable(b)
    .map((box) => ({ box, run: runSize(b, box) }))
    .sort((x, y) => x.run - y.run)
    .map((x) => x.box);
}

/**
 * Whether the player who receives this position can decline at the end of their captures,
 * taking the runs in `captureOrder`. Returns what they'd hand over (2 or 4), or 0.
 */
export function canDecline(b: Board): 0 | 2 | 4 {
  const work = cloneBoard(b);
  for (let guard = 0; guard < work.boxes.length + 1; guard++) {
    const d = declinePoint(work);
    if (d) return d.keep;
    const first = captureOrder(work)[0];
    if (first === undefined) return 0;
    playLine(work, lastSide(work, first), 0);
  }
  return 0;
}

// ------------------------------------------------------------------ chains and loops

export interface Component {
  kind: "chain" | "loop";
  size: number;
}

/**
 * The chains and loops in a position with no safe lines (the endgame). Boxes with two sides
 * left are chain boxes, linked through their undrawn sides into paths (chains) and cycles
 * (loops). A box with three or four sides left is a junction: the short arms get used up
 * first, so the junction ends up joining its two longest arms into one chain. With safe lines
 * still on the board this is only an estimate.
 */
export function components(b: Board): Component[] {
  const g = geometry(b.w, b.h);
  const n = b.boxes.length;
  const left = new Array<number>(n).fill(0);
  for (let box = 0; box < n; box++) if (isOpen(b, box)) left[box] = undrawnSides(b, box);
  const isChainBox = (box: number) => isOpen(b, box) && left[box] >= 1 && left[box] <= 2;

  const pathOf = new Array<number>(n).fill(-1);
  const paths: { size: number; junctions: number[] }[] = [];
  const out: Component[] = [];

  for (let start = 0; start < n; start++) {
    if (!isChainBox(start) || pathOf[start] >= 0) continue;
    const id = paths.length;
    const stack = [start];
    pathOf[start] = id;
    let size = 0;
    let links = 0;
    const junctions: number[] = [];
    while (stack.length) {
      const box = stack.pop()!;
      size++;
      for (const e of g.boxEdges[box]) {
        if (b.lines[e] !== NONE) continue;
        const o = across(b, e, box);
        if (o < 0) continue;
        if (isChainBox(o)) {
          links++;
          if (pathOf[o] < 0) {
            pathOf[o] = id;
            stack.push(o);
          }
        } else {
          junctions.push(o);
        }
      }
    }
    // Every link inside the component was seen from both ends.
    if (links / 2 >= size && size >= 4) out.push({ kind: "loop", size });
    else paths.push({ size, junctions });
  }

  const used = new Array<boolean>(paths.length).fill(false);
  for (let j = 0; j < n; j++) {
    if (!isOpen(b, j) || left[j] < 3) continue;
    const arms: number[] = [];
    paths.forEach((p, id) => {
      for (const x of p.junctions) if (x === j) arms.push(id);
    });
    arms.sort((x, y) => paths[y].size - paths[x].size);
    const free = arms.filter((id) => !used[id]);
    const first = free[0];
    if (first === undefined) {
      out.push({ kind: "chain", size: 1 });
      continue;
    }
    used[first] = true;
    if (free[1] === first) {
      // Both ends of one path come back to this junction: in the end it closes into a loop.
      out.push({ kind: "loop", size: paths[first].size + 1 });
      continue;
    }
    const second = free.find((id) => id !== first);
    if (second !== undefined) used[second] = true;
    out.push({ kind: "chain", size: 1 + paths[first].size + (second !== undefined ? paths[second].size : 0) });
  }
  paths.forEach((p, id) => {
    if (!used[id]) out.push({ kind: "chain", size: p.size });
  });
  return out;
}
