/**
 * The ground: a polyline from left to right with the solid side below it, which wheels and the
 * rider collide with. Segments are bucketed into columns along x, so a query looks at only the
 * few segments near it. Vertical segments (step-ups, drops, walls) are fine; overhangs aren't in
 * v1, but nothing here depends on that except `heightAt`.
 *
 * Everything here is shared by the sim, so it keeps to the deterministic arithmetic in PLAN.md.
 */

/** The largest radius a contact query may ask about: columns are padded by this much. */
export const MAX_QUERY_R = 0.6;

const COLUMN_W = 2;

/**
 * How many numbers each contact takes in a query's output: normal x, normal y, distance, and
 * which feature of the ground it is (segment i is i + 1, the corner at vertex i is -(i + 1)), so
 * the sim can tell the same contact from one step to the next.
 */
export const CONTACT_STRIDE = 4;

export class Ground {
  readonly n: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Per segment i (vertex i to i+1): unit direction, length, and left normal (up for flat ground). */
  private readonly ex: Float64Array;
  private readonly ey: Float64Array;
  private readonly len: Float64Array;
  private readonly nx: Float64Array;
  private readonly ny: Float64Array;
  /** Per vertex: 1 if it's a peak, where a circle can touch the corner itself. */
  private readonly convex: Uint8Array;
  /** The ends of the ground along x. */
  readonly minX: number;
  readonly maxX: number;
  private readonly x0: number;
  private readonly columns: number;
  /** Segments in column c are segs[colStart[c]] .. segs[colStart[c + 1] - 1]. */
  private readonly colStart: Int32Array;
  private readonly segs: Int32Array;

  /** `points` is flat: x0, y0, x1, y1, ... from left to right. */
  constructor(points: readonly number[]) {
    const n = points.length >> 1;
    this.n = n;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = points[2 * i];
      this.ys[i] = points[2 * i + 1];
    }
    const m = n - 1;
    this.ex = new Float64Array(m);
    this.ey = new Float64Array(m);
    this.len = new Float64Array(m);
    this.nx = new Float64Array(m);
    this.ny = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const dx = this.xs[i + 1] - this.xs[i];
      const dy = this.ys[i + 1] - this.ys[i];
      const l = Math.sqrt(dx * dx + dy * dy);
      this.len[i] = l;
      this.ex[i] = dx / l;
      this.ey[i] = dy / l;
      this.nx[i] = -dy / l;
      this.ny[i] = dx / l;
    }
    this.convex = new Uint8Array(n);
    for (let i = 1; i < m; i++) {
      // A right turn going left to right is a peak.
      this.convex[i] = this.ex[i - 1] * this.ey[i] - this.ey[i - 1] * this.ex[i] < 0 ? 1 : 0;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.xs[i]);
      maxX = Math.max(maxX, this.xs[i]);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.x0 = minX;
    this.columns = Math.floor((maxX - minX) / COLUMN_W) + 1;
    const lists: number[][] = [];
    for (let c = 0; c < this.columns; c++) lists.push([]);
    for (let i = 0; i < m; i++) {
      const lo = Math.min(this.xs[i], this.xs[i + 1]) - MAX_QUERY_R;
      const hi = Math.max(this.xs[i], this.xs[i + 1]) + MAX_QUERY_R;
      const c0 = Math.max(0, Math.floor((lo - minX) / COLUMN_W));
      const c1 = Math.min(this.columns - 1, Math.floor((hi - minX) / COLUMN_W));
      for (let c = c0; c <= c1; c++) lists[c].push(i);
    }
    this.colStart = new Int32Array(this.columns + 1);
    let total = 0;
    for (let c = 0; c < this.columns; c++) {
      this.colStart[c] = total;
      total += lists[c].length;
    }
    this.colStart[this.columns] = total;
    this.segs = new Int32Array(total);
    for (let c = 0, k = 0; c < this.columns; c++) for (const i of lists[c]) this.segs[k++] = i;
  }

  private column(x: number): number {
    const c = Math.floor((x - this.x0) / COLUMN_W);
    return c < 0 ? 0 : c >= this.columns ? this.columns - 1 : c;
  }

  /**
   * The ground within `r` of the point (cx, cy), at most `max` contacts, written to `out` as
   * normal x, normal y, signed distance from the point to the surface along the normal, and the
   * feature (see CONTACT_STRIDE). A
   * point a little below a segment still touches it (down to -r), so a fast wheel that sinks in
   * is pushed back out the right way. Returns the number of contacts.
   */
  contacts(cx: number, cy: number, r: number, out: Float64Array, max: number): number {
    const col = this.column(cx);
    let k = 0;
    for (let p = this.colStart[col], end = this.colStart[col + 1]; p < end && k < max; p++) {
      const i = this.segs[p];
      const dx = cx - this.xs[i];
      const dy = cy - this.ys[i];
      const t = dx * this.ex[i] + dy * this.ey[i];
      if (t >= 0 && t <= this.len[i]) {
        const d = dx * this.nx[i] + dy * this.ny[i];
        if (d < r && d > -r) {
          out[k * CONTACT_STRIDE] = this.nx[i];
          out[k * CONTACT_STRIDE + 1] = this.ny[i];
          out[k * CONTACT_STRIDE + 2] = d;
          out[k * CONTACT_STRIDE + 3] = i + 1;
          k++;
        }
      } else if (t < 0 && this.convex[i]) {
        // The wedge outside a peak, past the end of the segment before and before this one.
        const j = i - 1;
        const tp = (cx - this.xs[j]) * this.ex[j] + (cy - this.ys[j]) * this.ey[j];
        if (tp > this.len[j]) {
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r && d2 > 1e-12) {
            const d = Math.sqrt(d2);
            out[k * CONTACT_STRIDE] = dx / d;
            out[k * CONTACT_STRIDE + 1] = dy / d;
            out[k * CONTACT_STRIDE + 2] = d;
            out[k * CONTACT_STRIDE + 3] = -(i + 1);
            k++;
          }
        }
      }
    }
    return k;
  }

  /** The height of the top surface at x (the highest, at a vertical face). */
  heightAt(x: number): number {
    const col = this.column(x);
    let best = -Infinity;
    for (let p = this.colStart[col], end = this.colStart[col + 1]; p < end; p++) {
      const i = this.segs[p];
      const x0 = this.xs[i];
      const x1 = this.xs[i + 1];
      if (x1 <= x0 || x < x0 || x > x1) continue;
      const y = this.ys[i] + ((x - x0) * (this.ys[i + 1] - this.ys[i])) / (x1 - x0);
      if (y > best) best = y;
    }
    return best;
  }
}

/** Builds a ground polyline piece by piece, left to right. Shapes are polynomials, not trig. */
export class PathBuilder {
  readonly points: number[] = [];
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.points.push(x, y);
  }

  to(x: number, y: number): this {
    this.points.push(x, y);
    this.x = x;
    this.y = y;
    return this;
  }

  flat(dx: number): this {
    return this.to(this.x + dx, this.y);
  }

  /** Straight up or down to height y (a step face, a drop or a wall). */
  face(y: number): this {
    return this.to(this.x, y);
  }

  /** Over dx, rise by dy * shape(u) for u from 0 to 1, in `steps` straight pieces. */
  curve(dx: number, dy: number, shape: (u: number) => number, steps: number): this {
    const x0 = this.x;
    const y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      this.to(x0 + dx * u, y0 + dy * shape(u));
    }
    return this;
  }

  /** `count` round bumps (whoops), each `width` long and `height` tall. */
  bumps(count: number, width: number, height: number, steps = 10): this {
    for (let b = 0; b < count; b++) this.curve(width, height, bump, steps);
    return this;
  }
}

/** Shapes for `curve`: each goes from 0 at u = 0 to 1 at u = 1 (`bump` comes back to 0). */
export const smooth = (u: number) => u * u * (3 - 2 * u);
export const kick = (u: number) => u * u;
export const easeOut = (u: number) => u * (2 - u);
export const bump = (u: number) => 16 * u * u * (1 - u) * (1 - u);
