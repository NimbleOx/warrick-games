import type { Board } from "./board";

// Scratch space reused by every fill. `stamp[c] === epoch` means "the fill
// reached c this time", so nothing needs clearing between fills.
let stamp = new Uint32Array(0);
let queue = new Int32Array(0);
let epoch = 0;

function nextEpoch(size: number): number {
  if (stamp.length < size) {
    stamp = new Uint32Array(size);
    queue = new Int32Array(size);
    epoch = 0;
  }
  if (++epoch === 0xffffffff) {
    stamp.fill(0);
    epoch = 1;
  }
  return epoch;
}

/**
 * The cells `slot` gains by closing its trail right now: the trail itself and
 * everything it encloses with the slot's land, as [start, length, …] runs.
 *
 * A cell is enclosed if a flood fill from the board edges can't reach it
 * without crossing the slot's land or trail. Only the slot's bounding box
 * (plus a one-cell margin) is filled: nothing outside it can be enclosed.
 * The fill moves in four directions, so land that touches only diagonally
 * still seals a gap.
 */
export function claimRuns(board: Board, slot: number): number[] {
  const { w, h, owner, trail } = board;
  const v = slot + 1;

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0, c = 0; y < h; y++) {
    for (let x = 0; x < w; x++, c++) {
      if (owner[c] !== v && trail[c] !== v) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return [];
  const x0 = Math.max(0, minX - 1);
  const x1 = Math.min(w - 1, maxX + 1);
  const y0 = Math.max(0, minY - 1);
  const y1 = Math.min(h - 1, maxY + 1);

  const mark = nextEpoch(w * h);
  let head = 0;
  let tail = 0;
  const visit = (c: number) => {
    if (stamp[c] === mark || owner[c] === v || trail[c] === v) return;
    stamp[c] = mark;
    queue[tail++] = c;
  };

  for (let x = x0; x <= x1; x++) {
    visit(y0 * w + x);
    visit(y1 * w + x);
  }
  for (let y = y0 + 1; y < y1; y++) {
    visit(y * w + x0);
    visit(y * w + x1);
  }
  while (head < tail) {
    const c = queue[head++];
    const x = c % w;
    const y = (c - x) / w;
    if (x > x0) visit(c - 1);
    if (x < x1) visit(c + 1);
    if (y > y0) visit(c - w);
    if (y < y1) visit(c + w);
  }

  const runs: number[] = [];
  let start = -1;
  let len = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0, c = y * w + x0; x <= x1; x++, c++) {
      if (owner[c] === v || stamp[c] === mark) continue;
      if (start >= 0 && start + len === c) {
        len++;
      } else {
        if (start >= 0) runs.push(start, len);
        start = c;
        len = 1;
      }
    }
  }
  if (start >= 0) runs.push(start, len);
  return runs;
}
