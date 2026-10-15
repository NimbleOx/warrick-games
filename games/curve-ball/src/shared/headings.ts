import { HEADINGS } from "./constants";

// Unit vectors for every heading. Heading 0 points right (+x); since y points
// down, increasing headings turn clockwise on screen.
//
// Clients replay rounds from the input log, so every engine must compute
// exactly the same positions. Math.sin and Math.cos may differ in the last
// bit between JS engines, but + − × ÷ are exactly rounded everywhere, so the
// table is built from a fixed Taylor series and symmetry, with no Math calls.

const QUARTER = HEADINGS / 4;

export const COS = new Float64Array(HEADINGS);
export const SIN = new Float64Array(HEADINGS);

function taylorSin(x: number): number {
  // x − x³/3! + x⁵/5! − …, evaluated in a fixed order. 12 terms is far below
  // double precision for |x| ≤ π/2.
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 12; n++) {
    term = (-term * x2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

{
  const quarterSin = new Float64Array(QUARTER + 1);
  for (let k = 0; k <= QUARTER; k++) quarterSin[k] = taylorSin((k * Math.PI) / (HEADINGS / 2));
  // Pin the exact values the series only gets close to.
  quarterSin[0] = 0;
  quarterSin[QUARTER] = 1;
  for (let k = 0; k < HEADINGS; k++) {
    const q = Math.floor(k / QUARTER);
    const r = k % QUARTER;
    const s = quarterSin[r];
    const c = quarterSin[QUARTER - r];
    // Rotating by a quarter turn maps (c, s) to (−s, c).
    COS[k] = q === 0 ? c : q === 1 ? -s : q === 2 ? -c : s;
    SIN[k] = q === 0 ? s : q === 1 ? c : q === 2 ? -s : -c;
  }
}

/** Wrap any integer heading into 0 … HEADINGS − 1. */
export function wrapHeading(h: number): number {
  return ((h % HEADINGS) + HEADINGS) % HEADINGS;
}
