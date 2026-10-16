/** A territory holds at most this many dice. */
export const MAX_DICE = 8;
/** Dice that don't fit at the end of a turn wait in a reserve, up to this many. */
export const RESERVE_MAX = 64;

/** The map aims for territories of about this many hex cells... */
export const TARGET_CELLS = 22;
/** ...throws away any map with a territory smaller than this... */
export const MIN_CELLS = 10;
/** ...and makes the grid this much bigger than the land, so there's sea around and between. */
export const LAND_SHARE = 0.6;

/** Gap between a CPU's attacks, and before its first one, so everyone can follow (ms). */
export const CPU_GAP_MS = 700;
export const CPU_GAP_FAST_MS = 160;

/**
 * How long the end-of-turn dice take to land, one at a time, before the next turn starts.
 * The server waits this long and the client animates in the same time.
 */
export function dropMs(dice: number, fast: boolean): number {
  const each = fast ? 30 : 70;
  const cap = fast ? 700 : 1800;
  return Math.min(cap, dice * each) + (fast ? 150 : 400);
}
