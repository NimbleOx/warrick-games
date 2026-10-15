export interface Theme {
  name: string;
  /** Sky colors from the top of the screen down to the horizon. */
  sky: string[];
  /** Ground colors from the bottom of the map up to the peaks. */
  ground: [string, string];
  crust: string;
  stars: boolean;
  moon?: string;
}

// Must have THEME_COUNT entries.
export const THEMES: Theme[] = [
  {
    name: "Dusk",
    sky: ["#120926", "#3d1856", "#a63d68", "#f29a5c"],
    ground: ["#2a170d", "#7d4a26"],
    crust: "#d18f4c",
    stars: true,
  },
  {
    name: "Desert",
    sky: ["#1f4c99", "#5b8fd4", "#b8d3ee", "#f6dca6"],
    ground: ["#6b4220", "#d6a256"],
    crust: "#f3d590",
    stars: false,
  },
  {
    name: "Mars",
    sky: ["#140404", "#43120b", "#8f3018", "#d06a32"],
    ground: ["#3a120a", "#a8452a"],
    crust: "#e0814f",
    stars: true,
  },
  {
    name: "Arctic",
    sky: ["#081530", "#1f4b7e", "#5e98c9", "#c7e6f7"],
    ground: ["#4d6a91", "#e6f0fc"],
    crust: "#ffffff",
    stars: false,
  },
  {
    name: "Night",
    sky: ["#000005", "#050a26", "#121c52", "#26357a"],
    ground: ["#0b2311", "#2d7a3a"],
    crust: "#7ee07f",
    stars: true,
    moon: "#f4f1d8",
  },
  {
    name: "Toxic",
    sky: ["#040b06", "#0f2913", "#2c5419", "#7e9e2c"],
    ground: ["#16220a", "#6b8f2b"],
    crust: "#d3ff5c",
    stars: true,
  },
];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Sample a multi-stop gradient at t in [0, 1]. */
export function gradientAt(stops: string[], t: number): [number, number, number] {
  const rgb = stops.map(hexToRgb);
  const f = Math.min(0.9999, Math.max(0, t)) * (rgb.length - 1);
  const i = Math.floor(f);
  return mix(rgb[i], rgb[i + 1], f - i);
}
