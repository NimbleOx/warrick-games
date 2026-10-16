// The endgame as a model: once no safe lines are left, every move opens a chain or a loop.
// The opener picks which; the next player in turn order receives it and either takes it all
// (and opens the next one), or declines the last 2 boxes of a long chain or the last 4 of a
// loop, which hands those to the player after them, who then has to open the next one.
//
// Every player maximizes their own boxes (max-n). The answer depends only on the components
// left and the number of players, so it's memoized on those.
import type { Component } from "./chains";

/** A component as a number: a chain of n is n, a loop of n is -n. */
type Code = number;

const memo = new Map<string, number[]>();
const MEMO_MAX = 200_000;
/** Above this many reachable positions, the opener only considers the smallest of each kind. */
const FULL_SEARCH_MAX = 40_000;

/**
 * What each player gains from here on, relative to the opener: `out[0]` is the opener's,
 * `out[1]` the next player's, and so on. Don't change the array: it's shared.
 */
export function endgame(comps: Component[], players: number): number[] {
  const codes = comps.map((c) => (c.kind === "loop" ? -c.size : c.size)).sort((a, b) => a - b);
  if (memo.size > MEMO_MAX) memo.clear();
  return solve(codes, players, reachable(codes) > FULL_SEARCH_MAX);
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

function solve(codes: Code[], n: number, restricted: boolean): number[] {
  if (codes.length === 0) return new Array(n).fill(0);
  const key = `${n}${restricted ? "r" : ""}|${codes.join(",")}`;
  const hit = memo.get(key);
  if (hit) return hit;

  let best: number[] | null = null;
  for (const i of choices(codes, restricted)) {
    const code = codes[i];
    const size = Math.abs(code);
    const rest = codes.slice(0, i).concat(codes.slice(i + 1));
    const next = solve(rest, n, restricted);
    // The receiver (offset 1) takes everything and opens the next one...
    let res = rotate(next, 1, n);
    res[1 % n] += size;
    // ...or declines the last 2 (chain) or 4 (loop), and the player after them opens next.
    const keep = code < 0 ? 4 : code >= 3 ? 2 : 0;
    if (keep) {
      const dec = rotate(next, 2, n);
      dec[1 % n] += size - keep;
      dec[2 % n] += keep;
      if (dec[1 % n] > res[1 % n]) res = dec;
    }
    if (!best || better(res, best, 0)) best = res;
  }
  memo.set(key, best!);
  return best!;
}

/** Which components the opener considers: every distinct one, or the smallest of each kind. */
function choices(codes: Code[], restricted: boolean): number[] {
  const out: number[] = [];
  if (!restricted) {
    for (let i = 0; i < codes.length; i++) if (i === 0 || codes[i] !== codes[i - 1]) out.push(i);
    return out;
  }
  const pick = (test: (c: Code) => boolean, smallest: (a: Code, b: Code) => boolean) => {
    let at = -1;
    codes.forEach((c, i) => {
      if (test(c) && (at < 0 || smallest(c, codes[at]))) at = i;
    });
    if (at >= 0) out.push(at);
  };
  pick((c) => c < 0, (a, b) => a > b);
  pick((c) => c === 1, () => false);
  pick((c) => c === 2, () => false);
  pick((c) => c >= 3, (a, b) => a < b);
  return out;
}

/** How many sub-multisets the search could visit. */
function reachable(codes: Code[]): number {
  const counts = new Map<Code, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  let total = 1;
  for (const k of counts.values()) total *= k + 1;
  return total;
}
