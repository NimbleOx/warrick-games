import type { Rect } from "./maze";

export interface Vec {
  x: number;
  y: number;
}

export function inflate(rects: Rect[], r: number): Rect[] {
  return rects.map((w) => ({ x0: w.x0 - r, y0: w.y0 - r, x1: w.x1 + r, y1: w.y1 + r }));
}

// Which faces the last rayEnter() call crossed. Module scratch, so the hot loop doesn't allocate.
let crossX = false;
let crossY = false;

/**
 * Parameter t ≥ 0 at which the ray (ox, oy) + t·(vx, vy) enters `r`, or −1 if it doesn't (including when it
 * starts inside or on the boundary heading out). Sets crossX/crossY to the face(s) it enters through.
 */
function rayEnter(r: Rect, ox: number, oy: number, vx: number, vy: number): number {
  let enterX = -Infinity;
  let exitX = Infinity;
  if (vx !== 0) {
    const a = (r.x0 - ox) / vx;
    const b = (r.x1 - ox) / vx;
    enterX = a < b ? a : b;
    exitX = a < b ? b : a;
  } else if (ox < r.x0 || ox > r.x1) {
    return -1;
  }
  let enterY = -Infinity;
  let exitY = Infinity;
  if (vy !== 0) {
    const a = (r.y0 - oy) / vy;
    const b = (r.y1 - oy) / vy;
    enterY = a < b ? a : b;
    exitY = a < b ? b : a;
  } else if (oy < r.y0 || oy > r.y1) {
    return -1;
  }
  const enter = enterX > enterY ? enterX : enterY;
  const exit = exitX < exitY ? exitX : exitY;
  if (enter < 0 || enter > exit || exit <= 0) return -1;
  crossX = enterX >= enterY;
  crossY = enterY >= enterX;
  return enter;
}

/** Hits closer together than this (in t) count as one, so a shot into a corner reflects off both walls. */
const TIE = 1e-9;

export interface Path {
  /** Points along the way, flat [x0, y0, x1, y1, …]: the start, each bounce, and the end. */
  pts: number[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  /** True if it ended on a wall because it ran out of bounces. */
  stopped: boolean;
}

/**
 * Move a point from (x, y) along t·(vx, vy) for t in [0, len], reflecting off the rectangles' faces. Can bounce
 * any number of times along the way, up to `maxBounces`; the next wall after that ends the path. Only + − × ÷,
 * so a path replays identically on every JS engine.
 */
export function castPath(
  rects: Rect[],
  x: number,
  y: number,
  vx: number,
  vy: number,
  len = 1,
  maxBounces = 16,
): Path {
  const pts = [x, y];
  let left = len;
  let bounces = 0;
  for (;;) {
    let best = Infinity;
    let fx = false;
    let fy = false;
    for (let i = 0; i < rects.length; i++) {
      const t = rayEnter(rects[i], x, y, vx, vy);
      if (t < 0 || t > left || t > best + TIE) continue;
      if (t < best - TIE) {
        best = t;
        fx = crossX;
        fy = crossY;
      } else {
        fx ||= crossX;
        fy ||= crossY;
      }
    }
    if (best === Infinity) {
      x += vx * left;
      y += vy * left;
      pts.push(x, y);
      return { pts, x, y, vx, vy, bounces, stopped: false };
    }
    x += vx * best;
    y += vy * best;
    pts.push(x, y);
    if (bounces >= maxBounces) return { pts, x, y, vx, vy, bounces, stopped: true };
    if (fx) vx = -vx;
    if (fy) vy = -vy;
    bounces++;
    left -= best;
    if (left <= 0) return { pts, x, y, vx, vy, bounces, stopped: false };
  }
}

/**
 * Smallest t in [0, 1] at which the segment (ax, ay) → (bx, by) comes within r of (cx, cy), or −1. A segment
 * that starts inside the circle hits at 0.
 */
export function segmentHitsCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const mx = ax - cx;
  const my = ay - cy;
  const c = mx * mx + my * my - r * r;
  if (c <= 0) return 0;
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = mx * dx + my * dy;
  if (b >= 0) return -1; // heading away
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/** Push a circle of radius r out of a rectangle. Returns true if it overlapped. */
export function pushOutOfRect(p: Vec, r: number, w: Rect): boolean {
  const cx = p.x < w.x0 ? w.x0 : p.x > w.x1 ? w.x1 : p.x;
  const cy = p.y < w.y0 ? w.y0 : p.y > w.y1 ? w.y1 : p.y;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    p.x = cx + (dx / d) * r;
    p.y = cy + (dy / d) * r;
  } else {
    // Center inside the wall (shouldn't happen at tank speeds): leave by the nearest face.
    const left = p.x - w.x0;
    const right = w.x1 - p.x;
    const top = p.y - w.y0;
    const bottom = w.y1 - p.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) p.x = w.x0 - r;
    else if (m === right) p.x = w.x1 + r;
    else if (m === top) p.y = w.y0 - r;
    else p.y = w.y1 + r;
  }
  return true;
}

/** Push p so it's at least `dist` from q (q stays put). Returns true if they were closer. */
export function pushApart(p: Vec, q: Vec, dist: number): boolean {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= dist * dist) return false;
  if (d2 === 0) {
    p.x += dist;
    return true;
  }
  const d = Math.sqrt(d2);
  p.x = q.x + (dx / d) * dist;
  p.y = q.y + (dy / d) * dist;
  return true;
}

export function rectsOverlapCircle(rects: Rect[], x: number, y: number, r: number): boolean {
  for (const w of rects) {
    const cx = x < w.x0 ? w.x0 : x > w.x1 ? w.x1 : x;
    const cy = y < w.y0 ? w.y0 : y > w.y1 ? w.y1 : y;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

export function pointInRects(rects: Rect[], x: number, y: number): boolean {
  for (const w of rects) if (x > w.x0 && x < w.x1 && y > w.y0 && y < w.y1) return true;
  return false;
}
