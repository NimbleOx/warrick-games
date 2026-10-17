/** The sim steps at a fixed rate, and time is counted in whole ticks. */
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;

/** After a crash, the rider respawns at the last checkpoint this many ticks later (1.5 s). */
export const RESPAWN_TICKS = 180;

/** Lean input is a whole number from -LEAN_MAX (back) to LEAN_MAX (forward). Keys give the ends. */
export const LEAN_MAX = 8;

// ---------------------------------------------------------------------------------------------
// The race over the network.

/** The room's tick loop: it steps every bike and sends a frame this often. */
export const FRAME_MS = 100;
/** How often a client sends its inputs. */
export const SEND_MS = 100;
/** The countdown before the gate drops (and before a paused course goes on). */
export const COUNTDOWN_MS = 3000;
/** The results after each course, before the next one. */
export const RESULTS_MS = 9000;
/**
 * The room steps a rider's bike only as far as their inputs reach, but never lets it fall more
 * than this far behind the course clock: past that (they've gone, or their page stalled) it steps
 * it on with nothing pressed, and sends them where it is.
 */
export const MAX_BEHIND = TICK_HZ;
/** Nor more than this far ahead of the course clock (a fast clock, or a cheat). */
export const AHEAD_SLACK = TICK_HZ / 4;
/** The room hashes each rider's bike at every multiple of this tick, for the rider to check. */
export const HASH_EVERY = 60;

/** Points for each place on a course; a DNF gets none. */
export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

/** Dirt bike plastics, one per rider. */
export const PLAYER_COLORS = [
  "#ff7a1a", // orange
  "#2f7dff", // blue
  "#3fc34a", // green
  "#ffd21f", // yellow
  "#e8344a", // red
  "#a45cff", // purple
  "#1fd1c8", // teal
  "#f4f1e8", // white
] as const;
