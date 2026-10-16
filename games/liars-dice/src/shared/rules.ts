// The rules of a round, as pure functions: bid order, legal bids, counting and resolving a call.
// The worker and the CPUs use them, and so does the client's bid picker.
import type { Bid } from "./protocol";

/** The options a round is played with. A palifico round would add its own here. */
export interface RoundRules {
  /** Ones count as every face (and bids on ones have their own track). */
  wild: boolean;
}

export const FACES = [1, 2, 3, 4, 5, 6] as const;

/**
 * Where a bid sits in the bidding order: a raise is a bid with a higher rank.
 *
 * Without wilds it's quantity, then face: 6q + f. With wilds, other faces keep 6q + f (f is 2–6,
 * so a rank is never 1 mod 6) and q ones are 12q + 7, which falls between (2q, 6) and (2q + 1, 2).
 * That gives Perudo's rule exactly: switching to ones may halve the quantity (rounded up), and
 * switching back from q ones needs 2q + 1.
 */
export function bidRank(bid: Bid, rules: RoundRules): number {
  return rules.wild && bid.face === 1 ? 12 * bid.qty + 7 : 6 * bid.qty + bid.face;
}

/** Whether a round can open on this face. With wilds on, it can't open on ones. */
export function canOpenOn(face: number, rules: RoundRules): boolean {
  return !(rules.wild && face === 1);
}

/** Why `next` isn't a legal bid after `last` with `total` dice on the table, or null if it is. */
export function bidError(last: Bid | null, next: Bid, rules: RoundRules, total: number): string | null {
  const { qty, face } = next;
  if (!Number.isInteger(face) || face < 1 || face > 6) return "Pick a face from 1 to 6";
  if (!Number.isInteger(qty) || qty < 1) return "Bid at least one die";
  if (qty > total) return `There are only ${total} dice on the table`;
  if (!last) return canOpenOn(face, rules) ? null : "Ones are wild: you can't open on ones";
  if (bidRank(next, rules) > bidRank(last, rules)) return null;
  if (rules.wild && face === 1 && last.face !== 1) return `Switching to ones needs at least ${Math.ceil(last.qty / 2)}`;
  if (rules.wild && face !== 1 && last.face === 1) return `Switching from ones needs at least ${last.qty * 2 + 1}`;
  return `That doesn't raise ${bidText(last)}`;
}

/** The smallest legal quantity on `face` after `last`, or null if there's none (it would top the table). */
export function minQty(last: Bid | null, face: number, rules: RoundRules, total: number): number | null {
  let q: number;
  if (!last) {
    if (!canOpenOn(face, rules)) return null;
    q = 1;
  } else {
    const r = bidRank(last, rules);
    // The smallest q with a rank above r.
    q = rules.wild && face === 1 ? Math.floor((r - 7) / 12) + 1 : Math.floor((r - face) / 6) + 1;
    q = Math.max(1, q);
  }
  return q <= total ? q : null;
}

/** The smallest legal next bid on each face that has one. */
export function legalBids(last: Bid | null, rules: RoundRules, total: number): Bid[] {
  const out: Bid[] = [];
  for (const face of FACES) {
    const q = minQty(last, face, rules, total);
    if (q !== null) out.push({ qty: q, face });
  }
  return out;
}

/** Whether a die counts toward a bid on `face`. */
export function counts(die: number, face: number, rules: RoundRules): boolean {
  return die === face || (rules.wild && face !== 1 && die === 1);
}

/** How many dice in these cups count toward a bid on `face`. */
export function countFace(hands: readonly (readonly number[])[], face: number, rules: RoundRules): number {
  let n = 0;
  for (const hand of hands) for (const d of hand) if (counts(d, face, rules)) n++;
  return n;
}

export interface CallResult {
  count: number;
  /** Whose die goes: the caller, the bidder, or nobody (a right Spot on). */
  loser: "caller" | "bidder" | null;
  /** A right Spot on: the caller gets a die back (if they have room for it). */
  callerGains: boolean;
}

/**
 * Liar!: if the bid is met (at least that many), the caller loses a die, otherwise the bidder.
 * Spot on: if the count is exactly the bid, the caller gains a die, otherwise the caller loses one.
 */
export function resolveCall(
  kind: "liar" | "spot",
  bid: Bid,
  hands: readonly (readonly number[])[],
  rules: RoundRules,
): CallResult {
  const count = countFace(hands, bid.face, rules);
  if (kind === "liar") return { count, loser: count >= bid.qty ? "caller" : "bidder", callerGains: false };
  return count === bid.qty ? { count, loser: null, callerGains: true } : { count, loser: "caller", callerGains: false };
}

/** The first seat after `from`, going clockwise, that `ok` accepts. `from` itself comes last. */
export function nextSeat(order: readonly string[], from: string, ok: (id: string) => boolean): string | null {
  const i = order.indexOf(from);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(i + k + order.length) % order.length];
    if (ok(id)) return id;
  }
  return null;
}

const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

export function qtyWord(qty: number): string {
  return WORDS[qty] ?? String(qty);
}

/** "seven 4s", "one 6". */
export function bidText(bid: Bid): string {
  return `${qtyWord(bid.qty)} ${bid.face}${bid.qty === 1 ? "" : "s"}`;
}
