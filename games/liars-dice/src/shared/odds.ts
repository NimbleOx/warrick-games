// How likely a bid is, from one seat's point of view: its own dice are known, the rest follow
// the binomial odds (or, for a hard CPU reading the other bids, a die-by-die estimate).
import type { Bid } from "./protocol";
import { counts, type RoundRules } from "./rules";

/** The chance that one unseen die counts toward a bid on `face`: the face itself, or a wild one. */
export function matchChance(face: number, rules: RoundRules): number {
  return rules.wild && face !== 1 ? 1 / 3 : 1 / 6;
}

/** The distribution of how many of `n` dice match, each with chance `p`: index k is P(exactly k). */
export function binomial(n: number, p: number): number[] {
  return poissonBinomial(new Array<number>(Math.max(0, n)).fill(p));
}

/** Like `binomial`, but each die has its own chance. */
export function poissonBinomial(ps: readonly number[]): number[] {
  let dist = [1];
  for (const p of ps) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

/** P(X ≥ k) for a distribution from `binomial`. */
export function atLeast(dist: readonly number[], k: number): number {
  if (k <= 0) return 1;
  let sum = 0;
  for (let i = k; i < dist.length; i++) sum += dist[i];
  return Math.min(1, sum);
}

/** P(X = k). */
export function exactly(dist: readonly number[], k: number): number {
  return dist[k] ?? 0;
}

export interface Odds {
  /** Dice in my own cup that count. */
  mine: number;
  /** My count plus the expected matches among the dice I can't see. */
  expected: number;
  /** The bid is true: at least that many. */
  atLeast: number;
  /** Exactly that many (what Spot on needs). */
  exactly: number;
}

/** A bid's odds from one seat: its own `hand` plus `unseen` dice it can't see. */
export function bidOdds(hand: readonly number[], unseen: number, bid: Bid, rules: RoundRules): Odds {
  const p = matchChance(bid.face, rules);
  return oddsFrom(hand, binomial(unseen, p), unseen * p, bid, rules);
}

/** A bid's odds when each unseen die has its own chance of matching (see `poissonBinomial`). */
export function bidOddsWeighted(hand: readonly number[], unseen: readonly number[], bid: Bid, rules: RoundRules): Odds {
  const expected = unseen.reduce((a, p) => a + p, 0);
  return oddsFrom(hand, poissonBinomial(unseen), expected, bid, rules);
}

function oddsFrom(hand: readonly number[], dist: readonly number[], expectedUnseen: number, bid: Bid, rules: RoundRules): Odds {
  const mine = hand.filter((d) => counts(d, bid.face, rules)).length;
  const need = bid.qty - mine;
  return {
    mine,
    expected: mine + expectedUnseen,
    atLeast: atLeast(dist, need),
    exactly: need < 0 ? 0 : exactly(dist, need),
  };
}
