// The arena is measured in logical pixels with y pointing DOWN (0 = top edge).
export const ARENA_W = 960;
export const ARENA_H = 600;

/** The server steps every round at this rate, whatever the speed setting. */
export const TICKS_PER_SEC = 30;
export const TICK_MS = 1000 / TICKS_PER_SEC;

/** Each tick moves every head in this many equal sub-steps, so fast heads can't skip over thin trails. */
export const SUBSTEPS = 4;

/** Headings are integers: this many units make a full turn (quarter degrees). */
export const HEADINGS = 1440;

/** Half the trail's width, in px. */
export const LINE_RADIUS = 2;

/**
 * Per speed setting: px moved per tick, and heading units turned per sub-step.
 * Turn radius = speed / (turn × SUBSTEPS × 2π / HEADINGS); about 28 px for all three.
 */
export const SPEEDS = {
  chill: { speed: 2.4, turn: 5 },
  classic: { speed: 3, turn: 6 },
  fast: { speed: 3.8, turn: 8 },
} as const;
export type Speed = keyof typeof SPEEDS;

/** Each head's next gap starts this many seconds after the last one. */
export const GAP_EVERY_SECONDS = [1.5, 3] as const;
/** Gap length in px; converted to whole ticks for each speed. */
export const GAP_PX = 18;

export const COUNTDOWN_MS = 3000;
export const ROUNDOVER_MS = 3000;

export const MAX_PLAYERS = 8;
/** The match ends once the leader has the target and is this far ahead. */
export const WIN_LEAD = 2;

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
