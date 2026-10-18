import { TANK_HALF_W, WORLD_H, WORLD_W } from "./constants";
import type { Rng } from "@warrick/kit/shared/rng";

export type TerrainStyle = "hills" | "mountains" | "plains" | "valley";
export const TERRAIN_STYLES: TerrainStyle[] = ["hills", "mountains", "plains", "valley"];

interface StyleParams {
  roughness: number;
  lo: number;
  hi: number;
  blur: number;
}

const STYLE: Record<TerrainStyle, StyleParams> = {
  hills: { roughness: 0.52, lo: 0.12, hi: 0.55, blur: 6 },
  mountains: { roughness: 0.6, lo: 0.08, hi: 0.78, blur: 2 },
  plains: { roughness: 0.45, lo: 0.15, hi: 0.36, blur: 8 },
  valley: { roughness: 0.5, lo: 0.08, hi: 0.68, blur: 5 },
};

/** How rough the ground is, the host's choice. The style still sets its overall shape. */
export type Roughness = "smooth" | "rough" | "jagged";
export const ROUGHNESS: Roughness[] = ["smooth", "rough", "jagged"];

/**
 * What each roughness does to a style: `detail` adds to how much of each scale's bumps the next
 * smaller scale keeps (more hills on the hills, and sharper edges), and the blur is scaled by `blur`.
 * Smooth is the ground as it was before roughness was a setting.
 */
const ROUGH: Record<Roughness, { detail: number; blur: number }> = {
  smooth: { detail: 0, blur: 1 },
  rough: { detail: 0.08, blur: 0.4 },
  jagged: { detail: 0.15, blur: 0.15 },
};

/**
 * Midpoint-displacement heightmap, stretched to fill the style's vertical band.
 * Generated on the server only and sent to clients, so it may use any math.
 */
export function generateTerrain(rng: Rng, style: TerrainStyle, roughness: Roughness): number[] {
  const p = STYLE[style];
  const r = ROUGH[roughness];
  const N = 2048;
  const pts = new Float64Array(N + 1);
  pts[0] = rng();
  pts[N] = rng();
  let step = N;
  let scale = 1;
  while (step > 1) {
    const half = step / 2;
    for (let i = half; i < N; i += step) {
      pts[i] = (pts[i - half] + pts[i + half]) / 2 + (rng() - 0.5) * scale;
    }
    scale *= p.roughness + r.detail;
    step = half;
  }

  let heights: number[] = [];
  for (let x = 0; x < WORLD_W; x++) {
    const f = (x / (WORLD_W - 1)) * N;
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    let v = pts[i] * (1 - t) + pts[i + 1] * t;
    if (style === "valley") {
      // Push the edges up and the middle down.
      const d = Math.abs(x / WORLD_W - 0.5) * 2;
      v += d * d * 1.2;
    }
    heights.push(v);
  }
  heights = boxBlur(heights, Math.round(p.blur * r.blur));

  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const lo = p.lo * WORLD_H;
  const hi = p.hi * WORLD_H;
  const range = max - min || 1;
  return heights.map((h) => Math.round(lo + ((h - min) / range) * (hi - lo)));
}

function boxBlur(src: number[], r: number): number[] {
  if (r <= 0) return src;
  const out: number[] = [];
  for (let x = 0; x < src.length; x++) {
    let sum = 0;
    let n = 0;
    for (let k = x - r; k <= x + r; k++) {
      if (k >= 0 && k < src.length) {
        sum += src[k];
        n++;
      }
    }
    out.push(sum / n);
  }
  return out;
}

/** Level a pad for a tank to sit on; returns the pad height. */
export function flattenPad(heights: number[], cx: number): number {
  const from = Math.max(0, cx - TANK_HALF_W - 3);
  const to = Math.min(WORLD_W - 1, cx + TANK_HALF_W + 3);
  let sum = 0;
  for (let x = from; x <= to; x++) sum += heights[x];
  const h = Math.round(sum / (to - from + 1));
  for (let x = from; x <= to; x++) heights[x] = h;
  return h;
}

/** Remove a disc of dirt. Anything above the hole falls straight down. Returns whether any dirt went. */
export function carveCrater(heights: number[], cx: number, cy: number, r: number): boolean {
  const from = Math.max(0, Math.ceil(cx - r));
  const to = Math.min(WORLD_W - 1, Math.floor(cx + r));
  let changed = false;
  for (let x = from; x <= to; x++) {
    const dx = x - cx;
    const dy = Math.sqrt(r * r - dx * dx);
    const lo = cy - dy;
    const hi = cy + dy;
    const h = heights[x];
    const overlap = Math.min(h, hi) - Math.max(0, lo);
    if (overlap > 0) {
      const next = Math.max(0, Math.round(h - overlap));
      if (next !== h) changed = true;
      heights[x] = next;
    }
  }
  return changed;
}

/** Remove the dirt between lo and hi from one column; anything above falls. Returns whether any dirt went. */
export function cutColumn(heights: number[], x: number, lo: number, hi: number): boolean {
  const h = heights[x];
  const overlap = Math.min(h, hi) - Math.max(0, lo);
  if (overlap <= 0) return false;
  const next = Math.max(0, Math.round(h - overlap));
  heights[x] = next;
  return next !== h;
}

/** Drop a disc of dirt. Parts of the disc that are in mid-air settle onto the column. */
export function addDirt(heights: number[], cx: number, cy: number, r: number): void {
  const from = Math.max(0, Math.ceil(cx - r));
  const to = Math.min(WORLD_W - 1, Math.floor(cx + r));
  for (let x = from; x <= to; x++) {
    const dx = x - cx;
    const dy = Math.sqrt(r * r - dx * dx);
    const lo = cy - dy;
    const hi = cy + dy;
    const h = heights[x];
    const add = hi - Math.max(lo, h);
    if (add > 0) heights[x] = Math.min(WORLD_H - 4, Math.round(h + add));
  }
}

/** Highest ground under a tank's footprint. */
export function supportHeight(heights: number[], x: number): number {
  let m = 0;
  const from = Math.max(0, x - TANK_HALF_W + 1);
  const to = Math.min(WORLD_W - 1, x + TANK_HALF_W - 1);
  for (let i = from; i <= to; i++) if (heights[i] > m) m = heights[i];
  return m;
}
