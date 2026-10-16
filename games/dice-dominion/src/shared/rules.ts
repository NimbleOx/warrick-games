import { shuffle, type Rng } from "@warrick/kit/shared/rng";
import { MAX_DICE, RESERVE_MAX } from "./constants";

/**
 * The rules as pure functions over the board: each territory's owner (a seat number, the
 * player's place in the turn order) and dice, plus the map's neighbour lists. The server runs
 * them, the CPUs plan with them, and the client uses them to explain what you can do.
 */

/** Each connected group of a seat's territories (sharing a border, not across sea). */
export function groupsOf(adj: number[][], owner: number[], seat: number): number[][] {
  const seen = new Array<boolean>(owner.length).fill(false);
  const groups: number[][] = [];
  for (let t = 0; t < owner.length; t++) {
    if (owner[t] !== seat || seen[t]) continue;
    const group = [t];
    seen[t] = true;
    for (let k = 0; k < group.length; k++) {
      for (const u of adj[group[k]]) {
        if (owner[u] === seat && !seen[u]) {
          seen[u] = true;
          group.push(u);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** The size of a seat's largest connected group: the dice it gets at the end of its turn. */
export function largestGroup(adj: number[][], owner: number[], seat: number): number {
  let best = 0;
  for (const g of groupsOf(adj, owner, seat)) best = Math.max(best, g.length);
  return best;
}

export function territoryCount(owner: number[], seat: number): number {
  let n = 0;
  for (const o of owner) if (o === seat) n++;
  return n;
}

/** Why `seat` can't attack `to` from `from`, or null if it can. */
export function attackProblem(
  adj: number[][],
  owner: number[],
  dice: number[],
  seat: number,
  from: number,
  to: number,
): string | null {
  const exists = (t: number) => Number.isInteger(t) && t >= 0 && t < owner.length;
  if (!exists(from) || !exists(to)) return "No such territory";
  if (owner[from] !== seat) return "That's not your territory";
  if (dice[from] < 2) return "A territory needs 2 or more dice to attack";
  if (owner[to] === seat) return "You can't attack your own territory";
  if (!adj[from].includes(to)) return "You can only attack a neighbouring territory";
  return null;
}

/** The enemy neighbours a territory can attack right now (none if it has fewer than 2 dice). */
export function targetsOf(adj: number[][], owner: number[], dice: number[], from: number): number[] {
  if (dice[from] < 2) return [];
  return adj[from].filter((u) => owner[u] !== owner[from]);
}

/** Every attack a seat can make, as [from, to] pairs. */
export function legalAttacks(adj: number[][], owner: number[], dice: number[], seat: number): [number, number][] {
  const out: [number, number][] = [];
  for (let t = 0; t < owner.length; t++) {
    if (owner[t] !== seat) continue;
    for (const u of targetsOf(adj, owner, dice, t)) out.push([t, u]);
  }
  return out;
}

export function rollDice(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
}

/**
 * Settle an attack with the dice already rolled, changing `owner` and `dice` in place. Returns
 * whether the attacker won (a strictly higher total; ties go to the defender). Either way the
 * attacking territory keeps 1 die; on a win the rest move into the captured territory.
 */
export function applyAttack(owner: number[], dice: number[], from: number, to: number, att: number[], def: number[]): boolean {
  const won = sum(att) > sum(def);
  if (won) {
    owner[to] = owner[from];
    dice[to] = dice[from] - 1;
  }
  dice[from] = 1;
  return won;
}

export function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/**
 * End-of-turn dice: the reserve plus `gain` new dice, dropped one at a time on random
 * territories of the seat's with fewer than MAX_DICE. Changes `dice` in place. Returns where
 * each die landed, in order, and the new reserve: what didn't fit, up to RESERVE_MAX.
 */
export function reinforce(
  rng: Rng,
  owner: number[],
  dice: number[],
  seat: number,
  gain: number,
  reserve: number,
): { placed: number[]; reserve: number } {
  const open: number[] = [];
  for (let t = 0; t < owner.length; t++) if (owner[t] === seat && dice[t] < MAX_DICE) open.push(t);
  let left = reserve + gain;
  const placed: number[] = [];
  while (left > 0 && open.length) {
    const i = Math.floor(rng() * open.length);
    const t = open[i];
    dice[t]++;
    placed.push(t);
    left--;
    if (dice[t] >= MAX_DICE) {
      open[i] = open[open.length - 1];
      open.pop();
    }
  }
  return { placed, reserve: Math.min(RESERVE_MAX, left) };
}

/** The seat holding every territory, or null while two or more are left. */
export function winnerSeat(owner: number[]): number | null {
  if (!owner.length) return null;
  return owner.every((o) => o === owner[0]) ? owner[0] : null;
}

/**
 * Deal the territories out at random, as evenly as possible, with 1 die each. Then each seat
 * gets `extra` more dice, dropped one at a time on random territories of its own (at most
 * MAX_DICE each). `bonus[seat]` adds dice for that seat on top (later seats, say).
 */
export function setupBoard(
  rng: Rng,
  territories: number,
  seats: number,
  extra: number,
  bonus: readonly number[] = [],
): { owner: number[]; dice: number[] } {
  const order = shuffle(
    rng,
    Array.from({ length: territories }, (_, i) => i),
  );
  const owner = new Array<number>(territories).fill(-1);
  order.forEach((t, i) => (owner[t] = i % seats));
  const dice = new Array<number>(territories).fill(1);
  for (let seat = 0; seat < seats; seat++) reinforce(rng, owner, dice, seat, extra + (bonus[seat] ?? 0), 0);
  return { owner, dice };
}

/**
 * Extra starting dice by seat, to make up for going later: none for the first seat, rising
 * to round(1.2 × territories per player ÷ players) for the last. Simulated games between
 * normal CPUs (see the README) had the first of two players winning 80% of the time without it.
 */
export function seatBonus(seats: number, perPlayer: number): number[] {
  const last = Math.round((1.2 * perPlayer) / seats);
  return Array.from({ length: seats }, (_, k) => (seats > 1 ? Math.round((last * k) / (seats - 1)) : 0));
}
