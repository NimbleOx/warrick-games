// How the CPU levels do against each other, each seat taking turns to move first:
// `npm run sim -w games/shove-off` (SIM_GAMES=200 for more games a pairing).
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { it } from "vitest";
import { LAYOUT_IDS } from "../src/shared/rules";
import { playGame } from "./sim";

// Node's, which the worker's types leave out.
declare const process: { env: Record<string, string | undefined>; stdout: { write(text: string): void } };

const GAMES = Number(process.env.SIM_GAMES ?? 40);
const PAIRS: [CpuLevel, CpuLevel][] = [
  ["easy", "normal"],
  ["normal", "hard"],
  ["easy", "hard"],
];

for (const [a, b] of PAIRS) {
  it(`${a} against ${b}`, () => {
    const rng = mulberry32(GAMES * 7919 + a.length * 31 + b.length);
    const score = { [a]: 0, [b]: 0, draw: 0 } as Record<string, number>;
    let turns = 0;
    let firstWins = 0;
    let slowest = 0;
    let decided = 0;
    for (let g = 0; g < GAMES; g++) {
      const levels: [CpuLevel, CpuLevel] = g % 2 ? [b, a] : [a, b];
      const r = playGame(levels, LAYOUT_IDS[g % LAYOUT_IDS.length], rng);
      turns += r.turns;
      slowest = Math.max(slowest, ...r.slowest);
      if (r.winner === null) score.draw++;
      else {
        score[levels[r.winner]]++;
        if (r.winner === 0) firstWins++;
        decided++;
      }
    }
    process.stdout.write(
      `${a} v ${b}: ${a} ${score[a]}, ${b} ${score[b]}, drawn ${score.draw} of ${GAMES}; ` +
        `${(turns / GAMES).toFixed(0)} turns a game; first player won ${firstWins} of ${decided}; slowest move ${slowest.toFixed(0)} ms\n`,
    );
  });
}
