// Plays CPU-only games with the pure rules, for the CPU tests.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32, randInt, type Rng } from "@warrick/kit/shared/rng";
import { cpuMove } from "../src/shared/ai";
import type { BidEntry } from "../src/shared/protocol";
import { bidError, nextSeat, resolveCall } from "../src/shared/rules";

export interface SimOptions {
  wild: boolean;
  spotOn: boolean;
}

/** One game between these levels, seated in this order. Returns the winner's seat. */
export function playGame(levels: CpuLevel[], opts: SimOptions, rng: Rng): number {
  const ids = levels.map((_, i) => `s${i}`);
  const dice = levels.map(() => 5);
  const rules = { wild: opts.wild };
  let starter = randInt(rng, 0, levels.length - 1);
  for (let round = 0; round < 500; round++) {
    const alive = dice.filter((d) => d > 0).length;
    if (alive <= 1) return dice.findIndex((d) => d > 0);
    const hands = dice.map((n) => Array.from({ length: n }, () => randInt(rng, 1, 6)));
    const bids: BidEntry[] = [];
    let turn = starter;
    for (let step = 0; step < 400; step++) {
      const seats = ids.map((id, i) => ({ id, dice: dice[i] })).filter((s) => s.dice > 0);
      const move = cpuMove(
        { me: ids[turn], hand: hands[turn], seats, bids, rules, spotOn: opts.spotOn, maxDice: 5 },
        levels[turn],
        rng,
      );
      const total = dice.reduce((a, b) => a + b, 0);
      if (move.t === "bid") {
        const err = bidError(bids.at(-1) ?? null, move, rules, total);
        if (err) throw new Error(`illegal CPU bid: ${err}`);
        bids.push({ by: ids[turn], qty: move.qty, face: move.face });
        turn = Number(nextSeat(ids, ids[turn], (id) => dice[Number(id.slice(1))] > 0)!.slice(1));
        continue;
      }
      const last = bids.at(-1)!;
      const bidder = Number(last.by.slice(1));
      const r = resolveCall(move.t, last, hands, rules);
      const loser = r.loser === "caller" ? turn : r.loser === "bidder" ? bidder : -1;
      if (loser >= 0) dice[loser]--;
      if (r.callerGains && dice[turn] < 5) dice[turn]++;
      const want = move.t === "liar" ? loser : turn;
      starter = dice[want] > 0 ? want : Number(nextSeat(ids, ids[want], (id) => dice[Number(id.slice(1))] > 0)!.slice(1));
      break;
    }
  }
  throw new Error("game didn't end");
}

/** How often `a` beats `b` heads-up over `games` games, alternating seats. */
export function winRate(a: CpuLevel, b: CpuLevel, games: number, opts: SimOptions, seed = 1): number {
  const rng = mulberry32(seed);
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const flip = g % 2 === 1;
    const w = playGame(flip ? [b, a] : [a, b], opts, rng);
    if ((w === 0) !== flip) wins++;
  }
  return wins / games;
}

/** Wins per level over `games` games at a table seated like `levels` (rotated each game). */
export function tableWins(levels: CpuLevel[], games: number, opts: SimOptions, seed = 1): Record<string, number> {
  const rng = mulberry32(seed);
  const wins: Record<string, number> = {};
  for (let g = 0; g < games; g++) {
    const seats = levels.map((_, i) => levels[(i + g) % levels.length]);
    const w = seats[playGame(seats, opts, rng)];
    wins[w] = (wins[w] ?? 0) + 1;
  }
  return wins;
}
