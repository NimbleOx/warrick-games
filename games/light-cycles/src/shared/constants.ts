// The arena is a grid of cells with y pointing DOWN (0 = top row).

export const ARENA_SIZES = {
  small: { w: 80, h: 45 },
  medium: { w: 112, h: 63 },
  large: { w: 144, h: 81 },
} as const;

/** Cells per second for each speed setting. One tick moves a cycle one cell. */
export const SPEEDS = {
  chill: 10,
  classic: 14,
  hyper: 20,
} as const;

export type ArenaSize = keyof typeof ARENA_SIZES;
export type Speed = keyof typeof SPEEDS;

export function tickMsFor(speed: Speed): number {
  return 1000 / SPEEDS[speed];
}

/** A boost moves you two cells per tick for this long. */
export const BOOST_SECONDS = 1.2;
/** Once sudden death starts, the arena wall closes in one cell every this many seconds. */
export const SHRINK_SECONDS = 0.8;
/** Sudden death stops shrinking when the open floor is this small. */
export const MIN_OPEN = 12;

// Scoring.
export const SCORE_PER_OUTLAST = 1;
export const SCORE_PER_KILL = 2;
export const SCORE_PER_WIN = 3;

/** Light Cycles' neon player colours, in place of the kit's usual ones. */
export const PLAYER_COLORS = [
  "#2be4ff", // cyan
  "#ff9f1c", // orange
  "#ff3df2", // magenta
  "#9dff3a", // lime
  "#ffe23f", // yellow
  "#ff4060", // red
  "#5c7cff", // blue
  "#f2f6ff", // white
] as const;

/** Number of grid palettes the client knows how to draw. */
export const THEME_COUNT = 5;
