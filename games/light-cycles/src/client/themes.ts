export interface Theme {
  name: string;
  /** Grid line color. */
  grid: string;
  /** Floor color in the middle of the arena, fading to `edge` at the walls. */
  floor: string;
  edge: string;
}

// Must have THEME_COUNT entries.
export const THEMES: Theme[] = [
  { name: "Grid", grid: "#1e8fff", floor: "#06101f", edge: "#02050b" },
  { name: "Ultraviolet", grid: "#a64dff", floor: "#0f0820", edge: "#04020a" },
  { name: "Reef", grid: "#19d3a2", floor: "#04140f", edge: "#010605" },
  { name: "Ember", grid: "#ff6a3d", floor: "#170905", edge: "#060201" },
  { name: "Neon", grid: "#ff3d9a", floor: "#16061a", edge: "#050108" },
];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgba(hex: string, a: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

/** Blend toward white: the hot core of a light wall. */
export function lighten(hex: string, amt: number): string {
  const m = mix(hexToRgb(hex), [255, 255, 255], amt);
  return `rgb(${m[0] | 0}, ${m[1] | 0}, ${m[2] | 0})`;
}
