/**
 * The clock for whoever's turn it is, in a turn-based game: how long they have, and what happens
 * to it when they drop out and come back. Pure functions over three fields that a game keeps in
 * its state. They can sit at the top of the state, so the game passes the state itself (or keep
 * them in an object of their own, if the names are taken).
 *
 * The rules:
 * - A turn starts with the whole clock, or with no limit.
 * - While the player whose turn it is is away, their turn ends `awayMs` after they went (or when
 *   the clock runs out, if that's sooner).
 * - When they come back they get the clock they had, never more, so reloading can't buy time.
 *   One exception per turn: back with less than `backMinMs` left, they get `backMinMs`.
 * - A deadline the room only noticed long after it passed (everyone was gone, or the room was
 *   restarting) starts over at `awayMs`, instead of ending the turn the moment someone is back.
 *
 * Arm the game's timer for `turnDeadline` after each call (every one returns it), and call
 * `turnTimeUp` when it fires. Tell the clock about a connection only when it changes: a second
 * tab, or a hello from someone already connected, should leave it alone. (It can't buy time
 * anyway, but it could spend the top-up.)
 */

/** The fields a turn clock keeps in a game's state. */
export interface TurnClock {
  /**
   * When the turn's clock runs out (null: no limit). Missing, as in a game saved before it used
   * these, it's taken from `turnDeadline` the first time it's needed.
   */
  clockEnd?: number | null;
  /** When the turn ends by itself: the clock, or sooner while the player is away (null: it doesn't). */
  turnDeadline: number | null;
  /** This turn's top-up has been used. Missing counts as unused. */
  clockTopUp?: boolean;
}

/** A game's timings. Make it a constant. */
export interface ClockRules {
  /** How long the player whose turn it is can be away before their turn ends. */
  awayMs: number;
  /** The least time someone coming back on their turn gets, once a turn. Default 5 seconds. */
  backMinMs?: number;
  /** A deadline noticed this long after it passed was missed while the room wasn't running. Default 5 seconds. */
  lateMs?: number;
}

const BACK_MIN_MS = 5000;
const LATE_MS = 5000;
/** An alarm can fire a moment early. A deadline this close counts as reached. */
const EARLY_MS = 25;

/**
 * Start the clock: for a new turn, or afresh within one (after a move that restarts it, say).
 * `turnMs` is the time limit (0 or null: none), and `here` whether the player is connected.
 */
export function startTurnClock(c: TurnClock, rules: ClockRules, now: number, turnMs: number | null, here: boolean): number | null {
  c.clockEnd = turnMs ? now + turnMs : null;
  c.clockTopUp = false;
  c.turnDeadline = here ? c.clockEnd : awayDeadline(c, rules, now);
  return c.turnDeadline;
}

/** The player whose turn it is has gone. */
export function turnHolderLeft(c: TurnClock, rules: ClockRules, now: number): number | null {
  c.turnDeadline = awayDeadline(c, rules, now);
  return c.turnDeadline;
}

/** The player whose turn it is is back. */
export function turnHolderBack(c: TurnClock, rules: ClockRules, now: number): number | null {
  const end = clockEnd(c);
  const min = rules.backMinMs ?? BACK_MIN_MS;
  if (end === null) {
    c.turnDeadline = null;
  } else if (end - now < min && !c.clockTopUp) {
    c.turnDeadline = now + min;
    c.clockTopUp = true;
  } else {
    c.turnDeadline = end;
  }
  return c.turnDeadline;
}

/**
 * The game's timer for the turn fired. True: the turn is over. False: it isn't, either because
 * the deadline is still to come or because it passed long ago, unnoticed, and has just been
 * moved to `awayMs` from now (re-arm the timer for `turnDeadline`).
 */
export function turnTimeUp(c: TurnClock, rules: ClockRules, now: number): boolean {
  const at = c.turnDeadline;
  if (at === null || now < at - EARLY_MS) return false;
  if (now - at > (rules.lateMs ?? LATE_MS)) {
    c.turnDeadline = now + rules.awayMs;
    return false;
  }
  return true;
}

function clockEnd(c: TurnClock): number | null {
  if (c.clockEnd === undefined) c.clockEnd = c.turnDeadline;
  return c.clockEnd;
}

function awayDeadline(c: TurnClock, rules: ClockRules, now: number): number {
  return Math.min(clockEnd(c) ?? Infinity, now + rules.awayMs);
}
