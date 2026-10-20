// Plays CPU-only games with the pure rules, for the CPU tests and `npm run sim`.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { chooseMove } from "../src/shared/ai";
import { MARBLES, TO_WIN, count, newBoard, play, shove, type Layout } from "../src/shared/rules";

export interface SimResult {
  /** The winning seat, or null for a draw on the move limit. */
  winner: number | null;
  turns: number;
  /** Marbles each seat pushed off. */
  pushed: [number, number];
  /** The slowest move each seat took, in ms. */
  slowest: [number, number];
}

/** One game, `levels[0]` moving first, ending on six pushed off or after `limit` turns in all. */
export function playGame(levels: [CpuLevel, CpuLevel], layout: Layout, rng: Rng, limit = 200): SimResult {
  const b = newBoard(layout);
  const slowest: [number, number] = [0, 0];
  let turns = 0;
  const pushed = (): [number, number] => [MARBLES - count(b, 1), MARBLES - count(b, 0)];
  for (; turns < limit; turns++) {
    const seat = turns % 2;
    const t0 = performance.now();
    const move = chooseMove(b, seat, levels[seat], rng);
    slowest[seat] = Math.max(slowest[seat], performance.now() - t0);
    if (!move) continue;
    const sh = shove(b, seat, move);
    if (typeof sh === "string") throw new Error(`illegal CPU move: ${sh}`);
    play(b, seat, sh);
    const p = pushed();
    if (p[seat] >= TO_WIN) return { winner: seat, turns: turns + 1, pushed: p, slowest };
  }
  const p = pushed();
  return { winner: p[0] === p[1] ? null : p[0] > p[1] ? 0 : 1, turns, pushed: p, slowest };
}
