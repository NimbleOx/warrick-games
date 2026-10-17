export interface Theme {
  name: string;
  floor: string;
  /** Alternate floor tile, for a faint checkerboard. */
  floor2: string;
  wall: string;
  /** Highlight along the top/left of each wall. */
  wallEdge: string;
  bullet: string;
  bulletEdge: string;
  /** Outline around tanks, so light tanks show on light floors and vice versa. */
  outline: string;
  scorch: string;
  label: string;
}

// THEME_COUNT in shared/constants.ts must match the length of this list.
export const THEMES: Theme[] = [
  {
    name: "bunker",
    floor: "#1b2030",
    floor2: "#1e2436",
    wall: "#7d87a3",
    wallEdge: "#b9c1da",
    bullet: "#f6f6f6",
    bulletEdge: "#11131c",
    outline: "#0b0d14",
    scorch: "rgb(0 0 0 / 0.45)",
    label: "#e9ecf8",
  },
  {
    name: "paper",
    floor: "#ece8dd",
    floor2: "#e5e0d3",
    wall: "#3b3a38",
    wallEdge: "#5b5a56",
    bullet: "#151515",
    bulletEdge: "#ece8dd",
    outline: "#262522",
    scorch: "rgb(60 40 20 / 0.28)",
    label: "#262522",
  },
  {
    name: "neon",
    floor: "#0c0e19",
    floor2: "#0f1220",
    wall: "#1fa89c",
    wallEdge: "#6ff7ea",
    bullet: "#ffffff",
    bulletEdge: "#0c0e19",
    outline: "#05060c",
    scorch: "rgb(0 0 0 / 0.6)",
    label: "#d8fffb",
  },
  {
    name: "forest",
    floor: "#233021",
    floor2: "#263424",
    wall: "#9b8a5e",
    wallEdge: "#cbb98a",
    bullet: "#f4f1e6",
    bulletEdge: "#141a12",
    outline: "#10150e",
    scorch: "rgb(0 0 0 / 0.4)",
    label: "#eef3e6",
  },
  {
    name: "sand",
    floor: "#d9c49a",
    floor2: "#d3bd92",
    wall: "#6e4f2e",
    wallEdge: "#8d6a43",
    bullet: "#1d140b",
    bulletEdge: "#d9c49a",
    outline: "#3a2a17",
    scorch: "rgb(60 30 0 / 0.3)",
    label: "#2b1e10",
  },
];
