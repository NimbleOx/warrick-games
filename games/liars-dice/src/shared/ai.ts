// CPU players. A CPU sees only what its seat may know: its own cup, how many dice everyone
// holds, and this round's bids. The worker calls this for CPUs, and with "normal" for a player
// whose turn timer runs out.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { bidOdds, bidOddsWeighted, matchChance, type Odds } from "./odds";
import type { Bid, BidEntry } from "./protocol";
import { FACES, bidError, canOpenOn, counts, minQty, type RoundRules } from "./rules";

export interface CpuView {
  me: string;
  hand: readonly number[];
  /** Every cup in this round, in seat order, and how many dice it holds (mine included). */
  seats: readonly { id: string; dice: number }[];
  bids: readonly BidEntry[];
  rules: RoundRules;
  spotOn: boolean;
  maxDice: number;
}

export type Move = { t: "bid"; qty: number; face: number } | { t: "liar" } | { t: "spot" };

type OddsFn = (bid: Bid) => Odds;

const LIAR: Move = { t: "liar" };
const SPOT: Move = { t: "spot" };

/** Easy calls Liar! when a bid is this far above its average count. */
export const EASY = { callMargin: 2 };
/**
 * Normal calls Liar! when a bid is less likely than this, and Spot on when it's at least
 * `spotFrom` likely to be exactly right. Without wilds the plain odds undersell the bidder's own
 * dice more (a die matches 1 in 6, not 1 in 3), so it calls at a lower chance.
 */
export const NORMAL = { callBelowWild: 0.3, callBelowPlain: 0.15, spotFrom: 0.5 };

export function cpuMove(view: CpuView, level: CpuLevel, rng: Rng): Move {
  const move = level === "easy" ? easy(view, rng) : level === "hard" ? hard(view, rng) : normal(view);
  return legalOr(view, move);
}

function table(view: CpuView) {
  const total = view.seats.reduce((n, s) => n + s.dice, 0);
  return { total, unseen: total - view.hand.length, last: view.bids.at(-1) ?? null };
}

/** The faces a CPU thinks of as "its" faces: with wilds on, ones already count toward every other face. */
function ownFaces(view: CpuView): number[] {
  return FACES.filter((f) => !(view.rules.wild && f === 1));
}

function matches(view: CpuView, face: number): number {
  return view.hand.filter((d) => counts(d, face, view.rules)).length;
}

/** The largest quantity on `face` that's at least `target` likely, but never less than 1. */
function likelyQty(odds: OddsFn, face: number, total: number, target: number): number {
  let q = 1;
  while (q < total && odds({ qty: q + 1, face }).atLeast >= target) q++;
  return q;
}

/** An opening bid on the face that supports the biggest likely quantity. */
function opening(view: CpuView, odds: OddsFn, total: number, target: number): Move {
  let best: { qty: number; face: number; p: number } | null = null;
  for (const face of FACES) {
    if (!canOpenOn(face, view.rules)) continue;
    const qty = likelyQty(odds, face, total, target);
    const p = odds({ qty, face }).atLeast;
    if (!best || qty > best.qty || (qty === best.qty && p > best.p + 1e-9)) best = { qty, face, p };
  }
  return { t: "bid", qty: best!.qty, face: best!.face };
}

/** The smallest raise on every face that has one, with its chance of being true. */
function raises(view: CpuView, last: Bid, odds: OddsFn, total: number, jump = 0): { bid: Bid; p: number }[] {
  const out: { bid: Bid; p: number }[] = [];
  for (const face of FACES) {
    const q = minQty(last, face, view.rules, total);
    if (q === null || q + jump > total) continue;
    const bid = { qty: q + jump, face };
    out.push({ bid, p: odds(bid).atLeast });
  }
  return out;
}

// ------------------------------------------------------------------ easy

/** Bids its most common face; calls Liar! when the bid is well above its average. */
function easy(view: CpuView, rng: Rng): Move {
  const { total, unseen, last } = table(view);
  const odds: OddsFn = (b) => bidOdds(view.hand, unseen, b, view.rules);
  if (last && last.qty >= odds(last).expected + EASY.callMargin) return LIAR;
  // Most common first; ties in random order.
  const faces = ownFaces(view)
    .map((face) => ({ face, n: matches(view, face), r: rng() }))
    .sort((a, b) => b.n - a.n || a.r - b.r)
    .map((f) => f.face);
  if (!last) return { t: "bid", qty: likelyQty(odds, faces[0], total, 0.5), face: faces[0] };
  for (const face of faces) {
    const qty = minQty(last, face, view.rules, total);
    if (qty !== null) return { t: "bid", qty, face };
  }
  return LIAR;
}

// ------------------------------------------------------------------ normal

/** Calls Liar! below 30% (15% without wilds); otherwise the smallest raise on its best face. */
function normal(view: CpuView): Move {
  const { total, unseen, last } = table(view);
  const odds: OddsFn = (b) => bidOdds(view.hand, unseen, b, view.rules);
  if (!last) return opening(view, odds, total, 0.6);
  const o = odds(last);
  if (view.spotOn && o.exactly >= NORMAL.spotFrom) return SPOT;
  if (o.atLeast < (view.rules.wild ? NORMAL.callBelowWild : NORMAL.callBelowPlain)) return LIAR;
  let best: { bid: Bid; p: number } | null = null;
  for (const r of raises(view, last, odds, total)) {
    if (!best || r.p > best.p + 1e-9 || (Math.abs(r.p - best.p) <= 1e-9 && r.bid.face > best.bid.face)) best = r;
  }
  return best ? { t: "bid", ...best.bid } : LIAR;
}

// ------------------------------------------------------------------ hard

/**
 * Each unseen die's chance of counting toward `face`, reading the other players' bids as hints:
 * whoever last bid on a face is taken to hold more of it than chance. A bid that only raised the
 * quantity of the face already on the table says less than one that switched to it.
 */
export function hintedChances(view: CpuView, face: number, trust: number): number[] {
  const base = matchChance(face, view.rules);
  const claims = new Map<string, { face: number; weight: number }>();
  view.bids.forEach((b, i) => {
    if (b.by === view.me) return;
    const switched = i === 0 || view.bids[i - 1].face !== b.face;
    claims.set(b.by, { face: b.face, weight: switched ? 1 : 0.5 });
  });
  const ps: number[] = [];
  for (const seat of view.seats) {
    if (seat.id === view.me) continue;
    const claim = claims.get(seat.id);
    let p = base;
    if (claim?.face === face) p = base + (1 - base) * trust * claim.weight;
    // A claim on ones, with wilds on, also says something about every other face.
    else if (claim?.face === 1 && view.rules.wild && face !== 1) p = base + (1 - base) * trust * claim.weight * 0.5;
    for (let i = 0; i < seat.dice; i++) ps.push(p);
  }
  return ps;
}

/**
 * Weighs Liar!, Spot on and its best raises by how likely each is to cost it a die, reading
 * the other bids as hints. Bluffs now and then, sometimes jumps the bid, and redraws its
 * thresholds every turn.
 */
function hard(view: CpuView, rng: Rng): Move {
  const { total, last } = table(view);
  const trust = 0.12 + rng() * 0.16;
  const cache = new Map<number, number[]>();
  const chances = (face: number) => {
    let ps = cache.get(face);
    if (!ps) cache.set(face, (ps = hintedChances(view, face, trust)));
    return ps;
  };
  const odds: OddsFn = (b) => bidOddsWeighted(view.hand, chances(b.face), b, view.rules);
  const bluff = rng() < 0.14;

  if (!last) {
    if (bluff) {
      // Open on a face it holds few of, at a quantity that still looks fine.
      const face = ownFaces(view)
        .map((f) => ({ f, n: matches(view, f), r: rng() }))
        .sort((a, b) => a.n - b.n || a.r - b.r)[0].f;
      return { t: "bid", qty: likelyQty(odds, face, total, 0.4), face };
    }
    return opening(view, odds, total, 0.5 + rng() * 0.25);
  }

  if (bluff) {
    // The smallest raise on a face it holds few of, as long as it isn't a likely loser.
    const options = raises(view, last, odds, total)
      .filter((r) => r.p >= 0.3 && r.bid.face !== last.face)
      .sort((a, b) => matches(view, a.bid.face) - matches(view, b.bid.face) || b.p - a.p);
    if (options.length && matches(view, options[0].bid.face) <= 1) return { t: "bid", ...options[0].bid };
  }

  // Expected dice lost by each choice, with a little noise so it's harder to read.
  const noise = () => (rng() - 0.5) * 0.08;
  /** How often a raise gets called: the cost of a raise is its chance of being false, times this. */
  const press = 0.6 + rng() * 0.25;
  const o = odds(last);
  const options: { move: Move; loss: number }[] = [{ move: LIAR, loss: o.atLeast + noise() }];
  if (view.spotOn) {
    const gain = view.hand.length < view.maxDice ? o.exactly : 0;
    options.push({ move: SPOT, loss: 1 - o.exactly - gain + noise() });
  }
  for (const r of raises(view, last, odds, total)) options.push({ move: { t: "bid", ...r.bid }, loss: (1 - r.p) * press + noise() });
  // Sometimes push the bid up by one more than it has to, if that's still likely.
  if (rng() < 0.2) {
    for (const r of raises(view, last, odds, total, 1)) {
      if (r.p >= 0.55) options.push({ move: { t: "bid", ...r.bid }, loss: (1 - r.p) * press - 0.03 + noise() });
    }
  }
  options.sort((a, b) => a.loss - b.loss);
  return options[0].move;
}

// ------------------------------------------------------------------ safety

/** Whatever a CPU picked, make it a legal move. */
function legalOr(view: CpuView, move: Move): Move {
  const { total, last } = table(view);
  if (move.t === "liar" && last) return move;
  if (move.t === "spot" && last && view.spotOn) return move;
  if (move.t === "bid" && !bidError(last, move, view.rules, total)) return move;
  if (last) return LIAR;
  const face = ownFaces(view).sort((a, b) => matches(view, b) - matches(view, a))[0];
  return { t: "bid", qty: 1, face };
}
