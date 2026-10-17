export type RGB = [number, number, number];

export interface Theme {
  name: string;
  /** Checkerboard floor colors. */
  floor: [string, string];
  /** Specks of grass, sand, frost… */
  speck: string;
  /** Seams between floor tiles. */
  seam: string;
  wall: { top: string; face: string; light: string; dark: string };
  crate: { base: string; light: string; dark: string; mortar: string };
}

// Must have THEME_COUNT entries. Named after Crater Club's skies.
export const THEMES: Theme[] = [
  {
    name: "Meadow",
    floor: ["#3f8c3b", "#469642"],
    speck: "#5fb355",
    seam: "#33752f",
    wall: { top: "#b4bbcb", face: "#767e94", light: "#e4e8f2", dark: "#454b5d" },
    crate: { base: "#c4622d", light: "#ee9252", dark: "#87391a", mortar: "#5a250c" },
  },
  {
    name: "Desert",
    floor: ["#e2bb76", "#d9b06a"],
    speck: "#c99b55",
    seam: "#c49a58",
    wall: { top: "#b97c47", face: "#8a5430", light: "#e6ad72", dark: "#5a3218" },
    crate: { base: "#a86c35", light: "#d6984f", dark: "#6c3f19", mortar: "#45260c" },
  },
  {
    name: "Mars",
    floor: ["#9a4a2f", "#a35335"],
    speck: "#b8623f",
    seam: "#7c3822",
    wall: { top: "#6a585e", face: "#43363b", light: "#9c8990", dark: "#261d21" },
    crate: { base: "#d47b3c", light: "#f5a463", dark: "#91481f", mortar: "#5a2a10" },
  },
  {
    name: "Arctic",
    floor: ["#cfe5f4", "#c2ddf0"],
    speck: "#ffffff",
    seam: "#a7c7de",
    wall: { top: "#6aa3d8", face: "#3c73b0", light: "#bfe0fa", dark: "#214a82" },
    crate: { base: "#eef6ff", light: "#ffffff", dark: "#aecbe4", mortar: "#86a9c8" },
  },
  {
    name: "Night",
    floor: ["#151b3c", "#192046"],
    speck: "#2b3876",
    seam: "#0d1229",
    wall: { top: "#4f5db8", face: "#2f3b88", light: "#8e9cf5", dark: "#19215a" },
    crate: { base: "#7044bd", light: "#a274f0", dark: "#462685", mortar: "#26134d" },
  },
  {
    name: "Toxic",
    floor: ["#2b3819", "#31401c"],
    speck: "#4d6a26",
    seam: "#1e2811",
    wall: { top: "#6e7d5c", face: "#4b5741", light: "#a1b388", dark: "#2c3426" },
    crate: { base: "#8bab2a", light: "#c6ec4c", dark: "#576d17", mortar: "#34420c" },
  },
];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgb(c: RGB): string {
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

export function shade(hex: string, amt: number): string {
  return rgb(mix(hexToRgb(hex), amt < 0 ? [0, 0, 0] : [255, 255, 255], Math.abs(amt)));
}

export function hexA(hex: string, a: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
