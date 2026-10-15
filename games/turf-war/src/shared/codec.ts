// Compact encodings for grids and cell sets, shared by the server and clients.

/** Run-length encode a grid as [value, count, value, count, …]. */
export function rleEncode(cells: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const v = cells[i];
    let j = i + 1;
    while (j < cells.length && cells[j] === v) j++;
    out.push(v, j - i);
    i = j;
  }
  return out;
}

/** Decode `rleEncode` output into `out`. Returns false if the data doesn't fit exactly. */
export function rleDecode(rle: readonly number[], out: Uint8Array): boolean {
  let at = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const v = rle[i];
    const n = rle[i + 1];
    if (!Number.isInteger(n) || n < 1 || at + n > out.length) return false;
    out.fill(v, at, at + n);
    at += n;
  }
  return at === out.length && rle.length % 2 === 0;
}

/** Visit every cell in a [start, length, start, length, …] run list. */
export function forEachRunCell(runs: readonly number[], from: number, fn: (cell: number) => void): void {
  for (let i = from; i + 1 < runs.length; i += 2) {
    const end = runs[i] + runs[i + 1];
    for (let c = runs[i]; c < end; c++) fn(c);
  }
}

/** Number of cells in a run list. */
export function runCellCount(runs: readonly number[], from = 0): number {
  let n = 0;
  for (let i = from + 1; i < runs.length; i += 2) n += runs[i];
  return n;
}

/** 32-bit FNV-1a over one or more byte arrays. */
export function fnv1a(...arrays: Uint8Array[]): number {
  let h = 0x811c9dc5;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}
