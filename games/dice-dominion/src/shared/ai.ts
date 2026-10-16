import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { MAX_DICE } from "./constants";
import { winChance } from "./odds";
import { groupsOf, largestGroup, legalAttacks, territoryCount } from "./rules";

export interface BoardView {
  adj: number[][];
  owner: number[];
  dice: number[];
}

/**
 * A CPU's next attack, or null to end its turn. It's asked again after every attack, so it
 * plays one attack at a time against the board as it now stands.
 */
export function cpuAttack(level: CpuLevel, b: BoardView, seat: number, rng: Rng): [number, number] | null {
  const move = level === "easy" ? easyAttack(b, seat, rng) : level === "normal" ? normalAttack(b, seat, rng) : hardAttack(b, seat, rng);
  if (move) return move;
  // Waiting only pays while new dice can land. Once all its territories are full, a CPU that
  // passes would pass forever (two of them would stall the game), so it takes its best shot.
  if (b.owner.every((o, t) => o !== seat || b.dice[t] === MAX_DICE)) return bestOdds(b, seat);
  return null;
}

function bestOdds({ adj, owner, dice }: BoardView, seat: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestP = 0;
  for (const [f, t] of legalAttacks(adj, owner, dice, seat)) {
    const p = winChance(dice[f], dice[t]);
    if (p > bestP) {
      bestP = p;
      best = [f, t];
    }
  }
  return best;
}

/** Any neighbour with fewer dice, in random order; sometimes it just stops. */
function easyAttack({ adj, owner, dice }: BoardView, seat: number, rng: Rng): [number, number] | null {
  const moves = legalAttacks(adj, owner, dice, seat).filter(([f, t]) => dice[f] > dice[t]);
  if (!moves.length || rng() < 0.15) return null;
  return moves[Math.floor(rng() * moves.length)];
}

/** More dice, or 8 against 8 (an 8-stack can't grow); best of all, an attack that joins two groups. */
function normalAttack({ adj, owner, dice }: BoardView, seat: number, rng: Rng): [number, number] | null {
  const moves = legalAttacks(adj, owner, dice, seat).filter(
    ([f, t]) => dice[f] > dice[t] || (dice[f] === MAX_DICE && dice[t] === MAX_DICE),
  );
  if (!moves.length) return null;
  const groupOf = groupIndex(adj, owner, seat);
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (const [f, t] of moves) {
    const joins = new Set(adj[t].filter((u) => owner[u] === seat).map((u) => groupOf[u])).size;
    const score = (joins >= 2 ? 2 : 0) + winChance(dice[f], dice[t]) + rng() * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = [f, t];
    }
  }
  return best;
}

/**
 * Of the attacks normal would make, scores each by its chance of winning, what it does to the
 * largest group, and how exposed the captured territory and the 1 die left behind would be to
 * their strongest enemy neighbour. Attacks while the best score clears a threshold, which is
 * lower against the leader, and lower still in a duel, where waiting doesn't help. The weights
 * were tuned in simulated games against normal CPUs (see the README).
 */
function hardAttack({ adj, owner, dice }: BoardView, seat: number, rng: Rng): [number, number] | null {
  const moves = legalAttacks(adj, owner, dice, seat).filter(
    ([f, t]) => dice[f] > dice[t] || (dice[f] === MAX_DICE && dice[t] === MAX_DICE),
  );
  if (!moves.length) return null;

  // The leader: whoever else holds the most territory, if they're ahead of us.
  const counts = new Map<number, number>();
  for (const o of owner) counts.set(o, (counts.get(o) ?? 0) + 1);
  let leader = -1;
  for (const [s, n] of counts) if (s !== seat && (leader < 0 || n > counts.get(leader)!)) leader = s;
  const leaderAhead = leader >= 0 && counts.get(leader)! > (counts.get(seat) ?? 0);
  const duel = counts.size === 2;

  const baseGroup = largestGroup(adj, owner, seat);
  const after = owner.slice();
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (const [f, t] of moves) {
    const a = dice[f];
    const p = winChance(a, dice[t]);
    const defender = owner[t];
    after[t] = seat;
    const gain = largestGroup(adj, after, seat) - baseGroup;
    const threat = (cell: number, stack: number) => {
      let worst = 0;
      for (const u of adj[cell]) if (after[u] !== seat && dice[u] >= 2) worst = Math.max(worst, winChance(dice[u], stack));
      return worst;
    };
    const exposedTo = threat(t, a - 1);
    const exposedFrom = threat(f, 1);
    after[t] = defender;

    const vsLeader = defender === leader && leaderAhead;
    const knockout = territoryCount(owner, defender) === 1;
    const winValue = 1 + gain * 0.7 + (vsLeader ? 0.6 : 0) + (knockout ? 1 : 0) - exposedTo * (a - 1) * 0.5 - exposedFrom * 0.6;
    const loseValue = -(a - 1) * 0.3 - exposedFrom * 0.6;
    // An 8-stack can't grow, so its dice are worth less sitting still.
    const idle = a === MAX_DICE ? 0.4 : 0;
    const score = p * winValue + (1 - p) * loseValue + idle + rng() * 0.05;
    const threshold = duel ? -0.2 : vsLeader ? 0.3 : 0.5;
    if (score >= threshold && score > bestScore) {
      bestScore = score;
      best = [f, t];
    }
  }
  return best;
}

/** Which of the seat's groups each of its territories is in. */
function groupIndex(adj: number[][], owner: number[], seat: number): number[] {
  const index = new Array<number>(owner.length).fill(-1);
  groupsOf(adj, owner, seat).forEach((g, i) => {
    for (const t of g) index[t] = i;
  });
  return index;
}
