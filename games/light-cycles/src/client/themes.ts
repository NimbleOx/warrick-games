import { hexToRgb, mix } from "@warrick/kit/client/color";

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

/** Blend toward white: the hot core of a light wall. */
export function lighten(hex: string, amt: number): string {
  const m = mix(hexToRgb(hex), [255, 255, 255], amt);
  return `rgb(${m[0] | 0}, ${m[1] | 0}, ${m[2] | 0})`;
}
