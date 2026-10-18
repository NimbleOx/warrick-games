import { MAX_DICE } from "./constants";

/** dist[n][t]: the chance that n six-sided dice add up to t. */
function sumDistributions(max: number): number[][] {
  const dist: number[][] = [[1]];
  for (let n = 1; n <= max; n++) {
    const prev = dist[n - 1];
    const next = new Array<number>(6 * n + 1).fill(0);
    for (let t = 0; t < prev.length; t++) {
      if (!prev[t]) continue;
      for (let face = 1; face <= 6; face++) next[t + face] += prev[t] / 6;
    }
    dist.push(next);
  }
  return dist;
}

/**
 * ODDS[a][b]: the chance that a attacking dice beat b defending dice. The attacker needs a
 * strictly higher total, so ties go to the defender. Worked out exactly by convolving the
 * d6 sums; row and column 0 are unused.
 */
export const ODDS: readonly (readonly number[])[] = (() => {
  const dist = sumDistributions(MAX_DICE);
  const table: number[][] = [];
  for (let a = 0; a <= MAX_DICE; a++) {
    const row: number[] = [];
    for (let b = 0; b <= MAX_DICE; b++) {
      if (!a || !b) {
        row.push(0);
        continue;
      }
      // P(attack > defence) = Σ_t P(attack = t) · P(defence < t)
      let below = 0;
      let win = 0;
      const att = dist[a];
      const def = dist[b];
      for (let t = 0; t < att.length; t++) {
        win += att[t] * below;
        below += def[t] ?? 0;
      }
      row.push(win);
    }
    table.push(row);
  }
  return table;
})();

export function winChance(attack: number, defence: number): number {
  return ODDS[Math.min(MAX_DICE, attack)]?.[Math.min(MAX_DICE, defence)] ?? 0;
}
