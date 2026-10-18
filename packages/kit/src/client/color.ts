// Colour arithmetic for drawing on a canvas, on "#rrggbb" strings and [r, g, b] channels
// (0–255, not rounded, so blends can be chained). Each game turns them into CSS its own way.

export type RGB = [number, number, number];

/** A "#rrggbb" colour's channels. */
export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Part way from `a` to `b`: 0 is `a`, 1 is `b`. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** A "#rrggbb" colour at opacity `a`, as CSS. */
export function rgba(hex: string, a: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
