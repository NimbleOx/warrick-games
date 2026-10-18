// A bottle is a grid of COLS × ROWS cells. A cell is addressed by its row-major
// index, y * COLS + x, with y counting down from the top.

export const COLS = 8;
export const ROWS = 16;
/** New capsules appear lying in the top row, in columns SPAWN_X and SPAWN_X + 1. */
export const SPAWN_X = 3;

/** Every bottle steps at this rate, on the server and in every browser. */
export const TICKS_PER_SEC = 60;
export const TICK_MS = 1000 / TICKS_PER_SEC;

// Bottle timings, in ticks.
/** Hold left or right this long before the capsule starts sliding on its own... */
export const DAS_DELAY = 10;
/** ...then it moves one column every this many ticks. */
export const DAS_RATE = 4;
/** Ticks per row while soft-dropping. */
export const SOFT_DROP = 2;
/** How long cleared cells flash before they vanish. */
export const POP_TICKS = 20;
/** Ticks per row for loose halves falling after a clear. */
export const SETTLE_TICKS = 5;
/** Pause between one capsule landing and the next one appearing. */
export const SPAWN_TICKS = 10;
/** Gravity speeds up one notch every this many capsules. */
export const SPEED_UP_EVERY = 10;
/** Attacks waiting for a bottle; up to this many drop between two capsules. */
export const GARBAGE_BATCHES = 2;
/** Attacks waiting beyond this many are dropped, so a swamped bottle can't grow without bound. */
export const MAX_PENDING = 8;

/** Ticks per row by speed notch, after NES Dr. Mario's table. */
export const GRAVITY = [
  69, 67, 65, 63, 61, 59, 57, 55, 53, 51, 49, 47, 45, 43, 41, 39, 37, 35, 33, 31, 29, 27, 25, 23, 21, 19, 18, 17, 16,
  15, 14, 13, 12, 11, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 3, 3, 3, 3,
  3, 2, 2, 2, 2, 2, 1,
];
/** Starting notch for each speed setting: 39, 19 and 13 ticks per row. */
export const START_SPEED = { low: 15, med: 25, hi: 31 } as const;

export const MAX_LEVEL = 20;
export const virusCount = (level: number) => Math.min(84, (level + 1) * 4);
/** The highest row (from the top) viruses may sit in: higher levels fill more of the bottle. */
export const virusTop = (level: number) => (level >= 19 ? 3 : level >= 17 ? 4 : level >= 15 ? 5 : 6);

// Networking.
/** "3, 2, 1" before tick 0 of a round. */
export const COUNTDOWN_MS = 3000;
/** The room's loop: step CPU bottles and broadcast what changed. */
export const LOOP_MS = 50;
/** A player's bottle may trail the clock by this much before the server moves it on without them. */
export const MAX_LAG_TICKS = 2 * TICKS_PER_SEC;
/** Same, once the player has disconnected. */
export const MAX_LAG_OFFLINE = 6;
/** Inputs this far ahead of the server's clock aren't replayed yet. */
export const MAX_LEAD_TICKS = TICKS_PER_SEC;
/** A browser must take delivery of an attack within this long, or the server drops it in for them. */
export const GARBAGE_GRACE_TICKS = 2 * TICKS_PER_SEC;
/** Pause between rounds of a match. */
export const INTERMISSION_MS = 4500;

/** Pill Panic's player colours: pink and violet where the kit's usual palette has red and pink. */
export const PLAYER_COLORS = [
  "#ff6b8b", // pink
  "#4da6ff", // blue
  "#5ce65c", // green
  "#ffd23f", // yellow
  "#c58cff", // violet
  "#3ff0e0", // cyan
  "#ff9a3c", // orange
  "#e9ecf8", // white
] as const;
