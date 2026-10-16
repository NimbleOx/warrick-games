import { describe, expect, it } from "vitest";
import type { Bid } from "../src/shared/protocol";
import { bidError, bidRank, bidText, canOpenOn, countFace, legalBids, minQty, nextSeat, resolveCall } from "../src/shared/rules";

const WILD = { wild: true };
const PLAIN = { wild: false };
const b = (qty: number, face: number): Bid => ({ qty, face });
const ok = (last: Bid | null, next: Bid, rules = WILD, total = 30) => bidError(last, next, rules, total) === null;

/** Perudo's raise rule written out case by case, to check the rank trick against. */
function perudoRaise(last: Bid, next: Bid, wild: boolean): boolean {
  if (!wild || (last.face !== 1 && next.face !== 1))
    return next.qty > last.qty || (next.qty === last.qty && next.face > last.face);
  if (last.face !== 1 && next.face === 1) return next.qty >= Math.ceil(last.qty / 2);
  if (last.face === 1 && next.face === 1) return next.qty > last.qty;
  return next.qty >= last.qty * 2 + 1;
}

describe("bid order without wilds", () => {
  it("raises by quantity on any face, or the same quantity on a higher face", () => {
    expect(ok(b(3, 4), b(3, 5), PLAIN)).toBe(true);
    expect(ok(b(3, 4), b(4, 2), PLAIN)).toBe(true);
    expect(ok(b(3, 4), b(4, 1), PLAIN)).toBe(true);
    expect(ok(b(3, 4), b(3, 4), PLAIN)).toBe(false);
    expect(ok(b(3, 4), b(3, 3), PLAIN)).toBe(false);
    expect(ok(b(3, 4), b(2, 6), PLAIN)).toBe(false);
  });

  it("treats ones as the lowest ordinary face, and lets a round open on them", () => {
    expect(canOpenOn(1, PLAIN)).toBe(true);
    expect(ok(null, b(2, 1), PLAIN)).toBe(true);
    expect(ok(b(3, 1), b(3, 2), PLAIN)).toBe(true);
    expect(ok(b(3, 2), b(3, 1), PLAIN)).toBe(false);
    expect(ok(b(3, 6), b(4, 1), PLAIN)).toBe(true);
  });
});

describe("bid order with wild ones", () => {
  it("can't open on ones", () => {
    expect(canOpenOn(1, WILD)).toBe(false);
    expect(bidError(null, b(2, 1), WILD, 20)).toMatch(/can't open on ones/);
    expect(ok(null, b(1, 2))).toBe(true);
    expect(minQty(null, 1, WILD, 20)).toBeNull();
    expect(minQty(null, 4, WILD, 20)).toBe(1);
  });

  it("switching to ones may halve the quantity, rounded up", () => {
    expect(ok(b(7, 4), b(4, 1))).toBe(true);
    expect(ok(b(7, 4), b(3, 1))).toBe(false);
    expect(ok(b(8, 6), b(4, 1))).toBe(true);
    expect(ok(b(8, 6), b(3, 1))).toBe(false);
    expect(ok(b(1, 3), b(1, 1))).toBe(true);
    expect(bidError(b(7, 4), b(3, 1), WILD, 30)).toBe("Switching to ones needs at least 4");
    expect(minQty(b(7, 4), 1, WILD, 30)).toBe(4);
    expect(minQty(b(8, 2), 1, WILD, 30)).toBe(4);
    expect(minQty(b(9, 2), 1, WILD, 30)).toBe(5);
  });

  it("raising ones needs more ones", () => {
    expect(ok(b(4, 1), b(5, 1))).toBe(true);
    expect(ok(b(4, 1), b(4, 1))).toBe(false);
    expect(minQty(b(4, 1), 1, WILD, 30)).toBe(5);
  });

  it("switching back from ones needs double plus one", () => {
    expect(ok(b(4, 1), b(9, 2))).toBe(true);
    expect(ok(b(4, 1), b(8, 6))).toBe(false);
    expect(bidError(b(4, 1), b(8, 6), WILD, 30)).toBe("Switching from ones needs at least 9");
    for (const face of [2, 3, 4, 5, 6]) expect(minQty(b(4, 1), face, WILD, 30)).toBe(9);
    expect(minQty(b(1, 1), 5, WILD, 30)).toBe(3);
  });

  it("other faces raise as usual", () => {
    expect(ok(b(7, 4), b(7, 5))).toBe(true);
    expect(ok(b(7, 4), b(8, 2))).toBe(true);
    expect(ok(b(7, 4), b(7, 3))).toBe(false);
    expect(minQty(b(7, 4), 5, WILD, 30)).toBe(7);
    expect(minQty(b(7, 4), 3, WILD, 30)).toBe(8);
    expect(minQty(b(7, 4), 4, WILD, 30)).toBe(8);
  });

  it("matches the written-out rule for every pair of bids", () => {
    for (const wild of [true, false]) {
      const rules = { wild };
      const all: Bid[] = [];
      for (let q = 1; q <= 20; q++) for (let f = 1; f <= 6; f++) all.push(b(q, f));
      const ranks = new Set(all.map((x) => bidRank(x, rules)));
      expect(ranks.size).toBe(all.length); // a strict order: no two bids tie
      for (const last of all) {
        for (const next of all) expect(bidRank(next, rules) > bidRank(last, rules)).toBe(perudoRaise(last, next, wild));
        for (let f = 1; f <= 6; f++) {
          const q = minQty(last, f, rules, 50);
          // minQty is the smallest quantity that raises.
          expect(perudoRaise(last, b(q!, f), wild)).toBe(true);
          if (q! > 1) expect(perudoRaise(last, b(q! - 1, f), wild)).toBe(false);
        }
      }
    }
  });
});

describe("bid limits", () => {
  it("can't bid more dice than are on the table, or a bad face", () => {
    expect(bidError(b(9, 4), b(11, 4), WILD, 10)).toBe("There are only 10 dice on the table");
    expect(bidError(null, b(2, 7), WILD, 10)).toMatch(/face/);
    expect(bidError(null, b(0, 3), WILD, 10)).toMatch(/at least one/);
    expect(bidError(null, b(1.5, 3), WILD, 10)).not.toBeNull();
    expect(minQty(b(10, 6), 6, WILD, 10)).toBeNull();
    expect(minQty(b(10, 6), 1, WILD, 10)).toBe(5);
  });

  it("lists the smallest legal bid on each face, and none past the top", () => {
    expect(legalBids(b(7, 4), WILD, 30)).toEqual([b(4, 1), b(8, 2), b(8, 3), b(8, 4), b(7, 5), b(7, 6)]);
    expect(legalBids(null, WILD, 30).map((x) => x.face)).toEqual([2, 3, 4, 5, 6]);
    // Ten ones is the top bid with ten dice and wilds on; ten 6s without.
    expect(legalBids(b(10, 1), WILD, 10)).toEqual([]);
    expect(legalBids(b(10, 6), PLAIN, 10)).toEqual([]);
  });
});

describe("counting and calls", () => {
  const hands = [
    [1, 4, 4, 6, 2],
    [1, 1, 3],
    [4, 5],
  ];

  it("counts ones toward other faces when they're wild", () => {
    expect(countFace(hands, 4, WILD)).toBe(6);
    expect(countFace(hands, 4, PLAIN)).toBe(3);
    expect(countFace(hands, 1, WILD)).toBe(3);
    expect(countFace(hands, 6, WILD)).toBe(4);
  });

  it("Liar!: a bid that's met costs the caller, a short one costs the bidder", () => {
    expect(resolveCall("liar", b(6, 4), hands, WILD)).toEqual({ count: 6, loser: "caller", callerGains: false });
    expect(resolveCall("liar", b(5, 4), hands, WILD).loser).toBe("caller");
    expect(resolveCall("liar", b(7, 4), hands, WILD)).toEqual({ count: 6, loser: "bidder", callerGains: false });
    expect(resolveCall("liar", b(4, 4), hands, PLAIN).loser).toBe("bidder");
  });

  it("Spot on: exactly right gains a die, anything else costs the caller", () => {
    expect(resolveCall("spot", b(6, 4), hands, WILD)).toEqual({ count: 6, loser: null, callerGains: true });
    expect(resolveCall("spot", b(5, 4), hands, WILD)).toEqual({ count: 6, loser: "caller", callerGains: false });
    expect(resolveCall("spot", b(7, 4), hands, WILD).loser).toBe("caller");
    expect(resolveCall("spot", b(3, 4), hands, PLAIN).callerGains).toBe(true);
  });
});

describe("seats and words", () => {
  it("finds the next seat clockwise, skipping anyone who can't play", () => {
    const order = ["a", "b", "c", "d"];
    const out = new Set(["b"]);
    expect(nextSeat(order, "a", (id) => !out.has(id))).toBe("c");
    expect(nextSeat(order, "d", (id) => !out.has(id))).toBe("a");
    expect(nextSeat(order, "b", (id) => !out.has(id))).toBe("c");
    expect(nextSeat(order, "a", (id) => id === "a")).toBe("a");
    expect(nextSeat(order, "a", () => false)).toBeNull();
  });

  it("reads bids out", () => {
    expect(bidText(b(7, 4))).toBe("seven 4s");
    expect(bidText(b(1, 6))).toBe("one 6");
    expect(bidText(b(23, 2))).toBe("23 2s");
  });
});
