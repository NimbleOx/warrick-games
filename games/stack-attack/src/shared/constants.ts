// The board is 10 columns by 40 rows. x counts from the left, y from the bottom: row 0 is the
// floor, rows 0–19 are the visible field and rows 20–39 are the buffer pieces spawn into.

export const COLS = 10;
export const ROWS = 40;
export const VISIBLE = 20;

/** Where a new piece's 4 × 4 (or 3 × 3) box goes: its left column, and its top row. */
export const SPAWN_X = 3;
export const SPAWN_Y = 21;

/** How many upcoming pieces the preview shows. */
export const NEXT_COUNT = 5;

/** A grounded piece locks after this long without moving. */
export const LOCK_DELAY_MS = 500;
/** Moving or turning a grounded piece restarts its lock delay, up to this many times per row. */
export const MAX_LOCK_RESETS = 15;

/** The most garbage rows that can rise into a board on one lock. The rest waits for the next. */
export const GARBAGE_CAP = 10;

/** Server loop rate while a round is on: CPU moves, autopilot and deadlines. */
export const TICK_MS = 50;
/** "3, 2, 1" before the first piece drops. */
export const COUNTDOWN_MS = 3000;

/** Stack Attack's player colours: the usual ones, with violet in place of white. */
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
