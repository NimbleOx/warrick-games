/** The sim steps at a fixed rate, and time is counted in whole ticks. */
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;

/** After a crash, the rider respawns at the last checkpoint this many ticks later (1.5 s). */
export const RESPAWN_TICKS = 180;

/** Lean input is a whole number from -LEAN_MAX (back) to LEAN_MAX (forward). Keys give the ends. */
export const LEAN_MAX = 8;
