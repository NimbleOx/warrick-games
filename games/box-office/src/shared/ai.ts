// CPU players, and the move the game makes for a player who runs out of time. Each call
// returns one line; the room calls again while the same seat is still to move.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { NONE, boxCounts, cloneBoard, isOver, playLine, undrawnLines, type Board } from "./board";
import {
  canDecline,
  capturable,
  captureOrder,
  components,
  declinePoint,
  giveaway,
  isSafe,
  lastSide,
  playOut,
  safeLines,
  takeAll,
} from "./chains";
import { EndgameMemo, better, endgame, margin, rotate } from "./endgame";

/** Hard looks ahead through every order of the safe lines once this few are left. */
export const SEARCH_SAFE = 10;

/**
 * One line for the seat `me` to draw, with `players` seats taking turns in seat order.
 * The board must have an undrawn line.
 */
export function cpuMove(b: Board, players: number, me: number, level: CpuLevel, rng: Rng): number {
  if (level === "easy") return easyMove(b, rng);
  if (level === "normal") return normalMove(b, rng);
  return hardMove(b, players, me, rng);
}

/**
 * The line the game draws for a player who ran out of time (or isn't here): take a box if
 * there is one, else a random safe line, else the line that gives away the fewest boxes.
 */
export function timeoutMove(b: Board, rng: Rng): number {
  return normalMove(b, rng);
}

function pick<T>(rng: Rng, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function easyMove(b: Board, rng: Rng): number {
  const caps = capturable(b);
  if (caps.length) return lastSide(b, pick(rng, caps));
  return pick(rng, undrawnLines(b));
}

function normalMove(b: Board, rng: Rng): number {
  const caps = capturable(b);
  if (caps.length) return lastSide(b, pick(rng, caps));
  const safe = safeLines(b);
  if (safe.length) return pick(rng, safe);
  return cheapestLine(b, rng);
}

/** The line that gives the next player the fewest boxes (random among equals). */
export function cheapestLine(b: Board, rng: Rng): number {
  let best: number[] = [];
  let fewest = Infinity;
  for (const e of undrawnLines(b)) {
    const n = giveaway(b, e);
    if (n < fewest) {
      fewest = n;
      best = [e];
    } else if (n === fewest) {
      best.push(e);
    }
  }
  return pick(rng, best);
}

// ------------------------------------------------------------------ hard

function hardMove(b: Board, players: number, me: number, rng: Rng): number {
  // One memo for the decision: its endgames overlap, and it goes when the decision's made.
  const memo = new EndgameMemo();
  if (capturable(b).length) return hardCapture(b, players, me, memo);
  const safe = safeLines(b);
  if (safe.length > SEARCH_SAFE) return pick(rng, safe);
  if (safe.length) return safeSearch(b, players, me, safe, rng, memo);
  return hardOpen(b, players, me, rng, memo);
}

/** Final box counts if the endgame model plays out from `after`, with `opener` to move. */
function project(base: number[], after: Board, opener: number, players: number, memo: EndgameMemo): number[] {
  const rel = endgame(components(after), players, memo);
  const abs = rotate(rel, opener, players);
  return base.map((v, i) => v + abs[i]);
}

/**
 * Captures. While safe lines will be left afterwards, take everything. In the endgame, take
 * the smallest runs first, and at the last 2 boxes of a chain (4 of a loop) decide whether
 * to take them or decline them, whichever leaves Hard better off against the best of the rest.
 */
function hardCapture(b: Board, players: number, me: number, memo: EndgameMemo): number {
  const after = cloneBoard(b);
  takeAll(after, me);
  const order = captureOrder(b);
  const take = lastSide(b, order[0]);
  if (isOver(after) || safeLines(after).length) return take;

  const offer = declinePoint(b);
  if (!offer) return take;
  const base = boxCounts(b, players);
  const next = (me + 1) % players;
  const kept = base.slice();
  kept[me] += offer.keep;
  const given = base.slice();
  given[next] += offer.keep;
  const ifTake = project(kept, after, me, players, memo);
  const ifDecline = project(given, after, next, players, memo);
  return margin(ifDecline, me) > margin(ifTake, me) ? offer.line : take;
}

/**
 * No captures, no safe lines: something has to be opened. Try every line, group them by the
 * boxes they give away (and whether the receiver could decline), and play out each group:
 * the receiver takes or declines, whichever is better for them, then the model runs the rest.
 */
function hardOpen(b: Board, players: number, me: number, rng: Rng, memo: EndgameMemo): number {
  const base = boxCounts(b, players);
  const receiver = (me + 1) % players;
  const after2 = (me + 2) % players;
  const groups = new Map<string, { lines: number[]; score: number; given: number }>();
  for (const e of undrawnLines(b)) {
    const opened = cloneBoard(b);
    playLine(opened, e, me);
    const keep = canDecline(opened);
    const { taken, after } = playOut(b, e);
    const key = `${keep}|${taken.sort((x, y) => x - y).join(",")}`;
    const group = groups.get(key);
    if (group) {
      group.lines.push(e);
      continue;
    }
    const took = base.slice();
    took[receiver] += taken.length;
    let result = project(took, after, receiver, players, memo);
    if (keep) {
      const split = base.slice();
      split[receiver] += taken.length - keep;
      split[after2] += keep;
      const declined = project(split, after, after2, players, memo);
      if (better(declined, result, receiver)) result = declined;
    }
    groups.set(key, { lines: [e], score: margin(result, me), given: taken.length });
  }
  let best: { lines: number[]; score: number; given: number } | null = null;
  for (const g of groups.values()) {
    if (!best || g.score > best.score || (g.score === best.score && g.given < best.given)) best = g;
  }
  return pick(rng, best!.lines);
}

/**
 * The last few safe lines: whoever draws the last one makes the next player open the first
 * chain. Search every order they can be drawn in (safe lines never capture, so the turn just
 * passes) and score the positions where none are left with the endgame model.
 */
function safeSearch(b: Board, players: number, me: number, safe: number[], rng: Rng, memo: EndgameMemo): number {
  const work = cloneBoard(b);
  const byMask = new Map<number, number[]>();
  const rec = (mask: number, depth: number): number[] => {
    const hit = byMask.get(mask);
    if (hit) return hit;
    const mover = (me + depth) % players;
    let best: number[] | null = null;
    for (let i = 0; i < safe.length; i++) {
      if (mask & (1 << i) || !isSafe(work, safe[i])) continue;
      work.lines[safe[i]] = mover;
      const v = rec(mask | (1 << i), depth + 1);
      work.lines[safe[i]] = NONE;
      if (!best || better(v, best, mover)) best = v;
    }
    best ??= rotate(endgame(components(work), players, memo), mover, players);
    byMask.set(mask, best);
    return best;
  };

  const base = boxCounts(b, players);
  let bestScore = -Infinity;
  let bestLines: number[] = [];
  for (let i = 0; i < safe.length; i++) {
    work.lines[safe[i]] = me;
    const gains = rec(1 << i, 1);
    work.lines[safe[i]] = NONE;
    const score = margin(
      base.map((v, j) => v + gains[j]),
      me,
    );
    if (score > bestScore) {
      bestScore = score;
      bestLines = [safe[i]];
    } else if (score === bestScore) {
      bestLines.push(safe[i]);
    }
  }
  return pick(rng, bestLines);
}
