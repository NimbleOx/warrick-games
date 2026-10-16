import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { MAX_DICE, RESERVE_MAX } from "../src/shared/constants";
import {
  applyAttack,
  attackProblem,
  groupsOf,
  largestGroup,
  legalAttacks,
  reinforce,
  seatBonus,
  setupBoard,
  sum,
  targetsOf,
  winnerSeat,
} from "../src/shared/rules";

// A chain of six territories, 0 – 1 – 2 – 3 – 4 – 5, plus 6 off to the side touching 1 and 3.
const adj = [[1], [0, 2, 6], [1, 3], [2, 4, 6], [3, 5], [4], [1, 3]];

describe("groups", () => {
  it("finds connected groups and the largest", () => {
    const owner = [0, 0, 1, 0, 0, 0, 1];
    expect(groupsOf(adj, owner, 0).map((g) => g.sort())).toEqual([[0, 1], [3, 4, 5]]);
    expect(largestGroup(adj, owner, 0)).toBe(3);
    expect(largestGroup(adj, owner, 1)).toBe(1); // 2 and 6 don't touch
    expect(largestGroup(adj, owner, 2)).toBe(0);
  });

  it("a capture can join two groups", () => {
    const owner = [0, 0, 1, 0, 0, 0, 1];
    owner[2] = 0;
    expect(largestGroup(adj, owner, 0)).toBe(6);
  });
});

describe("attacking", () => {
  const owner = [0, 0, 1, 0, 0, 0, 1];
  const dice = [1, 4, 3, 2, 1, 8, 2];

  it("says why an attack isn't allowed", () => {
    expect(attackProblem(adj, owner, dice, 0, 1, 2)).toBeNull();
    expect(attackProblem(adj, owner, dice, 0, 2, 1)).toBe("That's not your territory");
    expect(attackProblem(adj, owner, dice, 0, 0, 1)).toBe("A territory needs 2 or more dice to attack");
    expect(attackProblem(adj, owner, dice, 0, 1, 0)).toBe("You can't attack your own territory");
    expect(attackProblem(adj, owner, dice, 0, 5, 2)).toBe("You can only attack a neighbouring territory");
    expect(attackProblem(adj, owner, dice, 0, 1, 99)).toBe("No such territory");
    expect(attackProblem(adj, owner, dice, 0, 1.5, 2)).toBe("No such territory");
  });

  it("lists the legal attacks", () => {
    expect(targetsOf(adj, owner, dice, 1)).toEqual([2, 6]);
    expect(targetsOf(adj, owner, dice, 0)).toEqual([]);
    expect(legalAttacks(adj, owner, dice, 0)).toEqual([[1, 2], [1, 6], [3, 2], [3, 6]]);
    expect(legalAttacks(adj, owner, dice, 1)).toEqual([[2, 1], [2, 3], [6, 1], [6, 3]]);
  });

  it("a win moves all but one die into the captured territory", () => {
    const o = owner.slice();
    const d = dice.slice();
    expect(applyAttack(o, d, 1, 2, [6, 5, 1, 1], [2, 2, 2])).toBe(true);
    expect(o[2]).toBe(0);
    expect(d[2]).toBe(3);
    expect(d[1]).toBe(1);
  });

  it("a loss drops the attacker to 1 die and costs the defender nothing", () => {
    const o = owner.slice();
    const d = dice.slice();
    expect(applyAttack(o, d, 1, 2, [1, 1, 1, 1], [6, 6, 6])).toBe(false);
    expect(o[2]).toBe(1);
    expect(d[2]).toBe(3);
    expect(d[1]).toBe(1);
  });

  it("ties go to the defender", () => {
    const o = owner.slice();
    const d = dice.slice();
    expect(applyAttack(o, d, 3, 2, [4, 5], [3, 3, 3])).toBe(false);
    expect(o[2]).toBe(1);
    expect(d[3]).toBe(1);
  });
});

describe("end-of-turn dice", () => {
  const rng = mulberry32(7);

  it("drops one die per group territory on random territories with room", () => {
    const owner = [0, 0, 1, 0, 0, 0, 1];
    const dice = [1, 1, 1, 1, 1, 1, 1];
    const r = reinforce(rng, owner, dice, 0, 3, 0);
    expect(r.placed).toHaveLength(3);
    expect(r.reserve).toBe(0);
    expect(r.placed.every((t) => owner[t] === 0)).toBe(true);
    expect(sum(dice)).toBe(10);
    expect(dice[2]).toBe(1); // nobody else's
  });

  it("places the reserve first, and never more than 8 on a territory", () => {
    const owner = [0, 0, 1, 0, 0, 0, 1];
    const dice = [7, 7, 1, 8, 8, 8, 1];
    const r = reinforce(rng, owner, dice, 0, 3, 2);
    // Room for 2 more dice (one each on 0 and 1): the other 3 go back into the reserve.
    expect(r.placed.sort()).toEqual([0, 1]);
    expect(r.reserve).toBe(3);
    expect(Math.max(...dice)).toBe(MAX_DICE);
  });

  it("caps the reserve", () => {
    const owner = [0, 0];
    const dice = [8, 8];
    expect(reinforce(rng, owner, dice, 0, 5, 62)).toEqual({ placed: [], reserve: RESERVE_MAX });
  });

  it("uses the reserve when there's room again", () => {
    const owner = [0, 0, 0];
    const dice = [1, 1, 1];
    const r = reinforce(rng, owner, dice, 0, 3, 10);
    // 10 in reserve + 3 new = 13 dice, and the three territories have room for 21.
    expect(r.placed).toHaveLength(13);
    expect(sum(dice)).toBe(16);
    expect(r.reserve).toBe(0);
  });
});

describe("setup and winning", () => {
  it("deals territories evenly and gives every seat the same dice", () => {
    const { owner, dice } = setupBoard(mulberry32(3), 24, 4, 12);
    for (let seat = 0; seat < 4; seat++) {
      const mine = owner.map((o, t) => (o === seat ? t : -1)).filter((t) => t >= 0);
      expect(mine).toHaveLength(6);
      expect(sum(mine.map((t) => dice[t]))).toBe(6 + 12);
    }
    expect(Math.min(...dice)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...dice)).toBeLessThanOrEqual(MAX_DICE);
  });

  it("adds a seat's bonus dice", () => {
    const { owner, dice } = setupBoard(mulberry32(3), 12, 3, 8, [0, 1, 2]);
    const total = (seat: number) => sum(dice.filter((_, t) => owner[t] === seat));
    expect([total(0), total(1), total(2)]).toEqual([12, 13, 14]);
  });

  it("later seats get a few extra dice, fewer the more players there are", () => {
    expect(seatBonus(2, 6)).toEqual([0, 4]);
    expect(seatBonus(2, 4)).toEqual([0, 2]);
    expect(seatBonus(4, 6)).toEqual([0, 1, 1, 2]);
    expect(seatBonus(8, 6)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    for (const n of [2, 3, 4, 5, 6, 7, 8]) for (const size of [4, 6, 8]) {
      const b = seatBonus(n, size);
      expect(b[0]).toBe(0);
      expect(b.every((x, i) => i === 0 || x >= b[i - 1])).toBe(true);
    }
  });

  it("someone wins when they hold every territory", () => {
    expect(winnerSeat([2, 2, 2])).toBe(2);
    expect(winnerSeat([2, 2, 1])).toBeNull();
    expect(winnerSeat([])).toBeNull();
  });
});
