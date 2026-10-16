export const MAX_SEATS = 4;

/**
 * Starting funds by seat, to offset moving first, by player count. Seat 1 builds and moves
 * first; the others start with more. In simulated games between two hard CPUs, seat 1 won
 * 90–95% of games on every 2-player map with no bonus, and 35–45% with 4,000 for seat 2
 * (normal CPUs: 45–60%). With 3 and 4 players the results were noisy and bonuses didn't
 * clearly help later seats, so they get a smaller nudge. test/balance.test.ts reruns this;
 * check it in playtests too.
 */
export const SEAT_FUNDS: Readonly<Record<number, readonly number[]>> = {
  2: [0, 4000],
  3: [0, 2000, 2000],
  4: [0, 2000, 2000, 2000],
};

export function seatFunds(players: number): readonly number[] {
  return SEAT_FUNDS[players] ?? [];
}

/** CPU pacing: the pause before a CPU's first move, and after each move (plus its animation). */
export const CPU_FIRST_MS = 1200;
export const CPU_GAP_MS = 450;
export const CPU_FAST_MS = 120;

/** Client animation timings, which the CPU pacing waits for. */
export const MOVE_MS_PER_TILE = 90;
export const ATTACK_MS = 900;
export const CAPTURE_MS = 600;
export const BUILD_MS = 450;

/** A player who isn't connected loses their turn after this long. */
export const AWAY_MS = 60_000;
/** The winner's banner, before the standings. */
export const FINISH_MS = 4000;
