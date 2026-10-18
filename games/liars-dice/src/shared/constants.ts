export const START_DICE = 5;
/** Nobody holds more than this, even after a good Spot on. */
export const MAX_DICE = 5;

/** CPU thinking time, so everyone can follow. */
export const CPU_THINK_MIN_MS = 1000;
export const CPU_THINK_MAX_MS = 2000;
/** How long the game waits for a player who isn't connected before it moves for them. */
export const AWAY_MS = 5000;

// The reveal after a call. The client's animation runs on the same clock: the cups lift, the
// dice that count light up one at a time, then the result shows until the next round.
export const REVEAL_LIFT_MS = 700;
export const REVEAL_COUNT_START_MS = 1100;
export const REVEAL_PER_DIE_MS = 160;
const REVEAL_BASE_MS = 4500;
const REVEAL_MAX_MS = 10000;

/** How long the reveal phase lasts when `count` dice count toward the bid. */
export function revealMs(count: number): number {
  return Math.min(REVEAL_MAX_MS, REVEAL_BASE_MS + REVEAL_PER_DIE_MS * count);
}
