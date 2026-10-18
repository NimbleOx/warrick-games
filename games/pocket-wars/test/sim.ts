// Plays CPU-only games with the pure rules, checking every CPU step against the server's checks.
import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { cpuNext } from "../src/shared/ai";
import { seatFunds } from "../src/shared/constants";
import type { MapDef } from "../src/shared/maps";
import {
  actProblem,
  applyAct,
  applyBuild,
  buildProblem,
  endTurn,
  newBoard,
  startTurn,
  winnerSeat,
  type Board,
} from "../src/shared/rules";

export interface SimResult {
  winner: number | null;
  days: number;
  steps: number;
  problems: string[];
  board: Board;
}

export function simulate(
  m: MapDef,
  levels: CpuLevel[],
  seed: number,
  maxDays = 60,
  funds: readonly number[] = seatFunds(m.players),
): SimResult {
  const rng: Rng = mulberry32(seed);
  const b = newBoard(m, funds);
  const problems: string[] = [];
  let steps = 0;
  let day = 1;
  for (; day <= maxDays; day++) {
    for (let seat = 0; seat < m.players; seat++) {
      if (b.out[seat]) continue;
      startTurn(m, b, seat);
      if (b.out[seat]) {
        if (winnerSeat(b) !== null) return { winner: winnerSeat(b), days: day, steps, problems, board: b };
        continue;
      }
      for (let i = 0; i < 400; i++) {
        const mv = cpuNext(levels[seat], m, b, seat, rng, day);
        steps++;
        if (mv.kind === "end") break;
        if (mv.kind === "act") {
          const p = actProblem(m, b, seat, mv.act);
          if (p) {
            problems.push(`${levels[seat]} day ${day}: ${p} ${JSON.stringify(mv.act)}`);
            break;
          }
          applyAct(m, b, seat, mv.act);
        } else {
          const p = buildProblem(m, b, seat, mv.at, mv.unit);
          if (p) {
            problems.push(`${levels[seat]} day ${day}: ${p} build ${mv.unit}`);
            break;
          }
          applyBuild(m, b, seat, mv.at, mv.unit);
        }
        if (winnerSeat(b) !== null) return { winner: winnerSeat(b), days: day, steps, problems, board: b };
      }
      endTurn(b, seat);
    }
  }
  return { winner: winnerSeat(b), days: day - 1, steps, problems, board: b };
}
