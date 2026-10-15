// The arena is a grid of square tiles. Positions are in tile units, and an
// integer coordinate is the center of a tile, so (3, 5) is the middle of the
// tile in column 3, row 5. Rows count down from the top.

/** Server simulation and broadcast rate. */
export const TICKS_PER_SEC = 30;
export const TICK_MS = 1000 / TICKS_PER_SEC;

/** Milliseconds of "3, 2, 1" before anyone can move. */
export const COUNTDOWN_MS = 3000;
export const FUSE_MS = 2400;
export const SHORT_FUSE_MS = 1100;
export const FLAME_MS = 520;
/** After the last-but-one bomber goes down, wait this long before calling it (so near-simultaneous deaths draw). */
export const END_GRACE_MS = 1300;

// Speeds in tiles per second.
export const BASE_SPEED = 3.7;
export const SPEED_STEP = 0.55;
export const MAX_SPEED_LEVEL = 6;
export const SLOW_SPEED = 2.2;
export const FAST_SPEED = 9;
export const BOMB_SLIDE_SPEED = 9;

export const START_BOMBS = 1;
export const START_FIRE = 2;
export const MAX_BOMBS = 8;
export const MAX_FIRE = 8;

export const CURSE_MS = 12000;
/** After passing a curse on, you can't catch it straight back. */
export const CURSE_IMMUNE_MS = 1500;

/** "Hurry up!" warning before the walls start closing in, then one block per interval. */
export const HURRY_WARN_MS = 2500;
export const HURRY_DROP_MS = 150;
/** How long a falling block is visible before it lands. */
export const FALL_SHOW_MS = 450;

export const MAX_PLAYERS = 8;

export const PLAYER_COLORS = [
  "#ff4d4d", // red
  "#4da6ff", // blue
  "#5ce65c", // green
  "#ffd23f", // yellow
  "#ff6bd6", // pink
  "#3ff0e0", // cyan
  "#ff9a3c", // orange
  "#e8e8e8", // white
] as const;

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

/** Number of tile palettes the client knows how to draw. */
export const THEME_COUNT = 6;
