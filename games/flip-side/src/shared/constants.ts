/** The sim steps at a fixed rate, and time is counted in whole ticks. */
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;
/** Each tick moves the ball in this many small steps, so it never skips through a wall. */
export const SUBSTEPS = 8;

// ---------------------------------------------------------------------------------------------
// The match over the network.

/** The room's tick loop: it steps every table and sends a frame this often. */
export const FRAME_MS = 50;
/** How often a client sends its inputs. */
export const SEND_MS = 100;
/** The countdown before the balls go in (and before a paused match goes on). */
export const COUNTDOWN_MS = 3000;
/**
 * The room steps a player's table only as far as their inputs reach, but never lets it fall more
 * than this far behind the match clock: past that (they've gone, or their page stalled) it plays
 * on for them, and sends them where it is.
 */
export const MAX_BEHIND = TICK_HZ;
/** Nor more than this far ahead of the match clock (a fast clock, or a cheat). */
export const AHEAD_SLACK = TICK_HZ / 4;
/** The room hashes each player's table at every multiple of this tick, for the player to check. */
export const HASH_EVERY = 60;
/** Trouble lands this many ticks after the room hears it was sent: a second's warning. */
export const TROUBLE_LEAD = TICK_HZ;
/** A balls match ends after this long whatever happens, in minutes. */
export const BALLS_CAP_MIN = 10;

/** Neon, one per player. */
export const PLAYER_COLORS = [
  "#ff3fa4", // pink
  "#2fd6ff", // cyan
  "#ffd23f", // yellow
  "#7dff5c", // green
  "#a77bff", // violet
  "#ff8a2f", // orange
  "#4d7cff", // blue
  "#f2f2ff", // white
] as const;
