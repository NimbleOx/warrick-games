// The board is a grid of square cells. A cell is addressed by its row-major
// index, y * w + x, with y counting down from the top.

/** Server simulation rate. Every live head moves one cell per tick. */
export const TICKS_PER_SEC = 10;
export const TICK_MS = 1000 / TICKS_PER_SEC;

/** Frozen "3, 2, 1" at the start of a round, in ticks. */
export const COUNTDOWN_TICKS = 3 * TICKS_PER_SEC;
/** How long a dead player waits for a fresh home patch, in ticks. */
export const RESPAWN_TICKS = 3 * TICKS_PER_SEC;
/** Every this many ticks a frame carries a board checksum, so clients can spot drift. */
export const CHECKSUM_EVERY = 50;
/** The server answers each socket's requests for a fresh snapshot at most this often, in ms. */
export const RESYNC_MS = 1000;

/** Turf War's player colours: the usual ones, with violet in place of white. */
export const PLAYER_COLORS = [
  "#ff4d4d", // red
  "#4da6ff", // blue
  "#5ce65c", // green
  "#ffd23f", // yellow
  "#ff6bd6", // pink
  "#3ff0e0", // cyan
  "#ff9a3c", // orange
  "#b48cff", // violet
] as const;
