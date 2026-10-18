// The endgame as a model: once no safe lines are left, every move opens a chain or a loop.
// The opener picks which; the next player in turn order receives it and either takes it all
// (and opens the next one), or declines the last 2 boxes of a long chain or the last 4 of a
// loop, which hands those to the player after them, who then has to open the next one.
//
// Every player maximizes their own boxes (max-n). The answer depends only on the components
// left and the number of players, so it's memoized on those, for one decision at a time.
import { mulberry32 } from "@warrick/kit/shared/rng";
import type { Component } from "./chains";

/** A component as a number: a chain of n is n, a loop of n is -n. */
type Code = number;

/** Most positions a memo keeps. Past this it starts again, so a decision's memory stays bounded (about 10 MB). */
const MEMO_MAX = 100_000;
/** Above this many reachable positions, the opener only considers the smallest of each kind. */
const FULL_SEARCH_MAX = 40_000;

/**
 * Endgame answers, shared by the calls one decision makes (they look at overlapping sets of
 * components). Make one per decision: it's thrown away with it, so rooms never share one.
 *
 * Positions are keyed by adding up a random number for each component they hold (Zobrist
 * hashing), so a smaller position's key is one subtraction away. Two positions sharing a key
 * is vanishingly unlikely (around 2^-53 for each pair), and would only cost a CPU some
 * judgement.
 */
export class EndgameMemo {
  private readonly answers = new Map<number, number[]>();
  constructor(private readonly max = MEMO_MAX) {}

  get size(): number {
    return this.answers.size;
  }

  get(key: number): number[] | undefined {
    return this.answers.get(key);
  }

  set(key: number, answer: number[]): void {
    if (this.answers.size >= this.max) this.answers.clear();
    this.answers.set(key, answer);
  }
}

/**
 * What each player gains from here on, relative to the opener: `out[0]` is the opener's,
 * `out[1]` the next player's, and so on. Don't change the array: it's shared.
 */
export function endgame(comps: Component[], players: number, memo = new EndgameMemo()): number[] {
  const codes = comps.map((c) => (c.kind === "loop" ? -c.size : c.size)).sort((a, b) => a - b);
  return solve(codes, players, reachable(codes) > FULL_SEARCH_MAX, memo);
}

/** Whether `a` is better than `b` for the player at `who`: more boxes, then a bigger lead. */
export function better(a: number[], b: number[], who: number): boolean {
  if (a[who] !== b[who]) return a[who] > b[who];
  return margin(a, who) > margin(b, who);
}

/** A player's lead over the best of the others (negative when behind). */
export function margin(v: number[], who: number): number {
  let best = -Infinity;
  for (let i = 0; i < v.length; i++) if (i !== who && v[i] > best) best = v[i];
  return v[who] - (best === -Infinity ? 0 : best);
}

/**
 * Turn gains relative to the player at `offset` into gains relative to the current opener,
 * with `players` seats in all.
 */
export function rotate(rel: number[], offset: number, players: number): number[] {
  const out = new Array<number>(players);
  for (let i = 0; i < players; i++) out[i] = rel[(((i - offset) % players) + players) % players];
  return out;
}

// ------------------------------------------------------------------ the search

/** Each component's share of a position's key, below 2^46 so a sum of 88 stays exact. */
const zobrist = new Map<number, number>();
const keyRng = mulberry32(0x5eed);

function keyOf(code: number): number {
  let k = zobrist.get(code);
  if (k === undefined) {
    k = Math.floor(keyRng() * 2 ** 23) * 2 ** 23 + Math.floor(keyRng() * 2 ** 23);
    zobrist.set(code, k);
  }
  return k;
}

/** The search over the components left, as counts of each distinct one. */
function solve(codes: Code[], n: number, restricted: boolean, memo: EndgameMemo): number[] {
  const kinds: Code[] = [];
  const counts: number[] = [];
  for (const c of codes) {
    if (kinds.length && kinds[kinds.length - 1] === c) counts[counts.length - 1]++;
    else {
      kinds.push(c);
      counts.push(1);
    }
  }
  const keys = kinds.map(keyOf);
  const none = new Array<number>(n).fill(0);
  // Scratch rows for the two answers to an opening; each is used up before the next search.
  const take = new Array<number>(n);
  const dec = new Array<number>(n);
  const choice: number[] = [];
  let left = codes.length;

  const rec = (key: number): number[] => {
    if (left === 0) return none;
    const hit = memo.get(key);
    if (hit) return hit;
    const best = new Array<number>(n);
    let found = false;
    const from = choice.length;
    choose(kinds, counts, restricted, choice);
    const to = choice.length;
    for (let c = from; c < to; c++) {
      const i = choice[c];
      counts[i]--;
      left--;
      const next = rec(key - keys[i]);
      counts[i]++;
      left++;
      const code = kinds[i];
      const size = Math.abs(code);
      // The receiver (offset 1) takes everything and opens the next one...
      for (let j = 0; j < n; j++) take[j] = next[j >= 1 ? j - 1 : j - 1 + n];
      take[1 % n] += size;
      let res = take;
      // ...or declines the last 2 (chain) or 4 (loop), and the player after them opens next.
      const keep = code < 0 ? 4 : code >= 3 ? 2 : 0;
      if (keep) {
        for (let j = 0; j < n; j++) dec[j] = next[j >= 2 ? j - 2 : j - 2 + n];
        dec[1 % n] += size - keep;
        dec[2 % n] += keep;
        if (dec[1 % n] > take[1 % n]) res = dec;
      }
      if (!found || better(res, best, 0)) {
        for (let j = 0; j < n; j++) best[j] = res[j];
        found = true;
      }
    }
    choice.length = from;
    memo.set(key, best);
    return best;
  };

  // The players and the kind of search are in the key too, as one more made-up component.
  let key = keyOf(1000 + 2 * n + (restricted ? 1 : 0));
  for (const c of codes) key += keyOf(c);
  return rec(key);
}

/**
 * Push the kinds the opener considers onto `out`: every one left, or the smallest of each sort
 * (loop, single box, pair, long chain). `kinds` is in ascending order: loops first, biggest
 * first, then chains, smallest first.
 */
function choose(kinds: Code[], counts: number[], restricted: boolean, out: number[]): void {
  if (!restricted) {
    for (let i = 0; i < kinds.length; i++) if (counts[i]) out.push(i);
    return;
  }
  let loop = -1;
  let one = -1;
  let two = -1;
  let long = -1;
  for (let i = 0; i < kinds.length; i++) {
    if (!counts[i]) continue;
    const c = kinds[i];
    if (c < 0) loop = i;
    else if (c === 1) one = i;
    else if (c === 2) two = i;
    else if (long < 0) long = i;
  }
  if (loop >= 0) out.push(loop);
  if (one >= 0) out.push(one);
  if (two >= 0) out.push(two);
  if (long >= 0) out.push(long);
}

/** How many sub-multisets the search could visit. */
function reachable(codes: Code[]): number {
  const counts = new Map<Code, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let total = 1;
  for (const k of counts.values()) total *= k + 1;
  return total;
}
