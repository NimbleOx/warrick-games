/**
 * Tank headings are whole steps of 0.5°, and their cos/sin come from this table rather than Math.cos and
 * Math.sin, which can differ in the last bit between JS engines. The table is built with + − × ÷ only, so
 * the server and every browser get identical numbers and tank movement replays exactly on both sides.
 * Step 0 points right (+x); steps increase clockwise on screen, since y points down.
 */
export const HEADINGS = 720;

export const COS = new Float64Array(HEADINGS);
export const SIN = new Float64Array(HEADINGS);

/** Taylor series, good to well under 1e-16 for |x| ≤ π/4. */
function taylorSin(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 9; n++) {
    term = (-term * x2) / (2 * n * (2 * n + 1));
    sum += term;
  }
  return sum;
}

function taylorCos(x: number): number {
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 9; n++) {
    term = (-term * x2) / ((2 * n - 1) * (2 * n));
    sum += term;
  }
  return sum;
}

{
  const quarter = HEADINGS / 4;
  const eighth = HEADINGS / 8;
  // First quadrant from the first octant and its mirror image.
  for (let k = 0; k <= quarter; k++) {
    if (k <= eighth) {
      const x = (k * Math.PI) / (HEADINGS / 2);
      COS[k] = taylorCos(x);
      SIN[k] = taylorSin(x);
    } else {
      const x = ((quarter - k) * Math.PI) / (HEADINGS / 2);
      COS[k] = taylorSin(x);
      SIN[k] = taylorCos(x);
    }
  }
  for (let k = quarter + 1; k <= HEADINGS / 2; k++) {
    COS[k] = -COS[HEADINGS / 2 - k];
    SIN[k] = SIN[HEADINGS / 2 - k];
  }
  for (let k = HEADINGS / 2 + 1; k < HEADINGS; k++) {
    COS[k] = COS[HEADINGS - k];
    SIN[k] = -SIN[HEADINGS - k];
  }
}

export function wrapHeading(h: number): number {
  return ((h % HEADINGS) + HEADINGS) % HEADINGS;
}

/** Heading step nearest to the direction (dx, dy). Uses Math.atan2, so only for decisions, never physics. */
export function headingTo(dx: number, dy: number): number {
  return wrapHeading(Math.round((Math.atan2(dy, dx) / (2 * Math.PI)) * HEADINGS));
}

/** Signed shortest turn from heading a to heading b, in steps (−359 … 360). */
export function headingDiff(a: number, b: number): number {
  let d = wrapHeading(b - a);
  if (d > HEADINGS / 2) d -= HEADINGS;
  return d;
}

/** Heading in radians, for drawing. */
export function headingRad(h: number): number {
  return (h / HEADINGS) * 2 * Math.PI;
}
