// A board is size × size cells, stored row by row from the top left: cell i is (i % size, i / size).

/** Board sizes the host can pick: 4 × 4 like the original, or a roomier 5 × 5. */
export const SIZES = [4, 5] as const;

/** Merges charge a player's power meter; each time it reaches this, one rock goes out. */
export const ROCK_COST = 8;

/** Incoming rocks land on the third move after your board shows them. Merges on those moves smash them first. */
export const ARM_MOVES = 3;
/** At most this many rocks land on one move. The rest wait for the next. */
export const MAX_LAND = 3;
/** A rock takes this many hits (merges right next to it) to smash. */
export const ROCK_HP = 1;

/** Someone who stops moving with rocks waiting gets them dropped in anyway after this long. */
export const IDLE_DROP_MS = 4000;

/** Server loop rate while a round is on: CPU moves and idle players. */
export const TICK_MS = 50;
/** "3, 2, 1" before the round starts. */
export const COUNTDOWN_MS = 3000;
