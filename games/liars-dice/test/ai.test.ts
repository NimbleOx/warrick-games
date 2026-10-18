import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { cpuMove, hintedChances, type CpuView } from "../src/shared/ai";
import { atLeast, bidOdds, binomial, exactly, matchChance, poissonBinomial } from "../src/shared/odds";
import type { BidEntry } from "../src/shared/protocol";
import { bidError } from "../src/shared/rules";
import { playGame, tableWins, winRate } from "./sim";

const WILD = { wild: true };
const PLAIN = { wild: false };

function view(hand: number[], others: number[], bids: BidEntry[], opts: Partial<CpuView> = {}): CpuView {
  return {
    me: "me",
    hand,
    seats: [{ id: "me", dice: hand.length }, ...others.map((dice, i) => ({ id: `o${i}`, dice }))],
    bids,
    rules: WILD,
    spotOn: false,
    maxDice: 5,
    ...opts,
  };
}

const bid = (by: string, qty: number, face: number): BidEntry => ({ by, qty, face });

describe("odds", () => {
  it("an unseen die matches 1 in 3 for a non-one face with wilds on, otherwise 1 in 6", () => {
    expect(matchChance(4, WILD)).toBeCloseTo(1 / 3);
    expect(matchChance(1, WILD)).toBeCloseTo(1 / 6);
    expect(matchChance(4, PLAIN)).toBeCloseTo(1 / 6);
    expect(matchChance(1, PLAIN)).toBeCloseTo(1 / 6);
  });

  it("works out the binomial odds", () => {
    const d = binomial(5, 1 / 6);
    expect(d.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(atLeast(d, 1)).toBeCloseTo(1 - (5 / 6) ** 5, 12);
    expect(exactly(d, 2)).toBeCloseTo(10 * (1 / 6) ** 2 * (5 / 6) ** 3, 12);
    expect(atLeast(d, 0)).toBe(1);
    expect(atLeast(d, 6)).toBe(0);
    expect(binomial(0, 0.5)).toEqual([1]);
    // Different chances per die.
    const pb = poissonBinomial([0.5, 0.25]);
    expect(pb[0]).toBeCloseTo(0.375);
    expect(pb[1]).toBeCloseTo(0.5);
    expect(pb[2]).toBeCloseTo(0.125);
  });

  it("judges a bid from its own dice plus the dice it can't see", () => {
    // Two 4s and a wild one in hand: need 2 more of the 10 unseen dice, each 1 in 3.
    const o = bidOdds([1, 4, 4, 2, 6], 10, { qty: 5, face: 4 }, WILD);
    expect(o.mine).toBe(3);
    expect(o.expected).toBeCloseTo(3 + 10 / 3);
    expect(o.atLeast).toBeCloseTo(1 - (2 / 3) ** 10 - 10 * (1 / 3) * (2 / 3) ** 9, 12);
    expect(o.exactly).toBeCloseTo(45 * (1 / 3) ** 2 * (2 / 3) ** 8, 12);
    // Without wilds the one doesn't count.
    expect(bidOdds([1, 4, 4, 2, 6], 10, { qty: 5, face: 4 }, PLAIN).mine).toBe(2);
    // A bid my own cup already covers is certain, and can't be exactly right if I hold more.
    const sure = bidOdds([4, 4, 4], 6, { qty: 2, face: 4 }, PLAIN);
    expect(sure.atLeast).toBe(1);
    expect(sure.exactly).toBe(0);
  });
});

describe("CPU moves", () => {
  it("are always legal, at every level and with every option", () => {
    const rng = mulberry32(42);
    const levels: CpuLevel[] = ["easy", "normal", "hard"];
    for (const wild of [true, false]) {
      for (const spotOn of [true, false]) {
        for (let g = 0; g < 40; g++) {
          const n = 2 + (g % 7);
          const seats = Array.from({ length: n }, (_, i) => levels[(i + g) % 3]);
          // playGame throws on an illegal bid, a call with nothing to call, or a game that never ends.
          const w = playGame(seats, { wild, spotOn }, rng);
          expect(w).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("never call Spot on when it's off, and always bid to open", () => {
    const rng = mulberry32(3);
    for (const level of ["easy", "normal", "hard"] as CpuLevel[]) {
      for (let i = 0; i < 200; i++) {
        const hand = Array.from({ length: 1 + (i % 5) }, () => 1 + Math.floor(rng() * 6));
        const open = cpuMove(view(hand, [5, 3], []), level, rng);
        expect(open.t).toBe("bid");
        if (open.t === "bid") expect(bidError(null, open, WILD, hand.length + 8)).toBeNull();
        const m = cpuMove(view(hand, [5, 3], [bid("o0", 4, 3)]), level, rng);
        expect(m.t).not.toBe("spot");
      }
    }
  });

  it("easy calls Liar! when a bid is 2 or more above its average, and otherwise bids its most common face", () => {
    const rng = mulberry32(1);
    // Holding two 5s and a one, with 6 unseen dice: the average for 5s is 3 + 2 = 5.
    const hand = [1, 5, 5, 2, 3];
    expect(cpuMove(view(hand, [6], [bid("o0", 7, 5)]), "easy", rng)).toEqual({ t: "liar" });
    expect(cpuMove(view(hand, [6], [bid("o0", 6, 5)]), "easy", rng)).toEqual({ t: "bid", qty: 7, face: 5 });
  });

  it("normal calls Liar! under 30% (15% without wilds), and otherwise makes the smallest raise on its best face", () => {
    const rng = mulberry32(1);
    const hand = [2, 3, 3, 6, 6];
    // Eight 4s with no 4s or ones in hand and 10 dice unseen: about 0.03 likely.
    expect(cpuMove(view(hand, [5, 5], [bid("o0", 8, 4)]), "normal", rng)).toEqual({ t: "liar" });
    // Two 4s is very likely; the best raise is on its 6s (or 3s): two 6s raises two 4s.
    expect(cpuMove(view(hand, [5, 5], [bid("o0", 2, 4)]), "normal", rng)).toEqual({ t: "bid", qty: 2, face: 6 });
    // Without wilds: two 4s from 10 unseen dice, holding none, is about 0.52 likely; four 4s about 0.07.
    expect(cpuMove(view(hand, [5, 5], [bid("o0", 2, 4)], { rules: PLAIN }), "normal", rng).t).toBe("bid");
    expect(cpuMove(view(hand, [5, 5], [bid("o0", 4, 4)], { rules: PLAIN }), "normal", rng)).toEqual({ t: "liar" });
  });

  it("normal calls Spot on when it's at least even money to be exactly right", () => {
    const rng = mulberry32(1);
    // Heads-up, one unseen die. Three 6s, holding three: exactly right unless the other die is a 6 or a one.
    const hand = [6, 6, 6, 2];
    expect(cpuMove(view(hand, [1], [bid("o0", 3, 6)], { spotOn: true }), "normal", rng)).toEqual({ t: "spot" });
    expect(cpuMove(view(hand, [1], [bid("o0", 3, 6)], { spotOn: false }), "normal", rng).t).toBe("bid");
  });

  it("hard reads other players' bids as hints about their dice", () => {
    const v = view([2, 3], [5, 5], [bid("o0", 3, 4), bid("o1", 4, 4)]);
    const fours = hintedChances(v, 4, 0.3);
    const fives = hintedChances(v, 5, 0.3);
    // o0 switched to 4s (a strong hint); o1 only raised the 4s (a weaker one). Nobody claimed 5s.
    expect(fours.slice(0, 5).every((p) => p > 1 / 3)).toBe(true);
    expect(fours[0]).toBeGreaterThan(fours[5]);
    expect(fours[5]).toBeGreaterThan(1 / 3);
    expect(fives.every((p) => Math.abs(p - 1 / 3) < 1e-12)).toBe(true);
    // A claim on wild ones says a little about every other face.
    const ones = hintedChances(view([2], [5], [bid("o0", 2, 1)]), 5, 0.3);
    expect(ones[0]).toBeGreaterThan(1 / 3);
  });

  it("hard calls an impossible bid and takes a certain Spot on", () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 50; i++) {
      // Two dice unseen, and the bid needs four more 4s.
      expect(cpuMove(view([2, 3, 4], [2], [bid("o0", 5, 4)]), "hard", rng)).toEqual({ t: "liar" });
      // With no dice it can't see, it knows the count.
      expect(cpuMove(view([4, 4, 1], [], [bid("o0", 3, 4)], { spotOn: true }), "hard", rng)).toEqual({ t: "spot" });
    }
  });

  it("get stronger by level: easy < normal < hard", () => {
    const opts = { wild: true, spotOn: false };
    expect(winRate("normal", "easy", 300, opts, 11)).toBeGreaterThan(0.6);
    expect(winRate("hard", "easy", 300, opts, 13)).toBeGreaterThan(0.65);
    expect(winRate("hard", "normal", 300, opts, 12)).toBeGreaterThan(0.5);
    for (const o of [
      { wild: true, spotOn: true },
      { wild: false, spotOn: false },
      { wild: false, spotOn: true },
    ]) {
      const t = tableWins(["easy", "normal", "hard", "easy", "normal", "hard"], 150, o, 5);
      expect(t.normal ?? 0).toBeGreaterThan(t.easy ?? 0);
      expect(t.hard ?? 0).toBeGreaterThan(t.normal ?? 0);
    }
  });
});
