// CPU players. `MEASURE=1 npx vitest run test/ai.test.ts --silent=false` (in this folder) plays
// 200 two-minute games per level (`MEASURE=500` for more) and prints a table: see the README.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { describe, expect, test } from "vitest";
import { SKILL_PULLS, Pilot } from "../src/shared/ai";
import { TICK_HZ } from "../src/shared/constants";
import {
  EV_DRAIN,
  EV_JACKPOT,
  EV_LANE,
  EV_MULTIBALL,
  EV_SEND,
  IN_PLUNGE,
  startPlay,
  stepPlay,
  type Rules,
} from "../src/shared/sim";
import { TABLE } from "../src/shared/table";

const LEVELS: CpuLevel[] = ["easy", "normal", "hard"];

interface Tally {
  score: number;
  drains: number;
  sends: number;
  jackpots: number;
  multiballs: number;
  ms: number;
}

function play(level: CpuLevel, seed: number, seconds: number): Tally {
  const rules: Rules = { mode: "timed", endTick: seconds * TICK_HZ, balls: 3, seed };
  const p = startPlay(rules);
  const pilot = new Pilot(level, seed * 31 + 7);
  const t: Tally = { score: 0, drains: 0, sends: 0, jackpots: 0, multiballs: 0, ms: 0 };
  const start = performance.now();
  while (!p.over) {
    stepPlay(p, pilot.decide(p, TABLE, rules), TABLE, rules);
    for (const e of p.events) {
      if (e.k === EV_DRAIN) t.drains++;
      else if (e.k === EV_SEND) t.sends++;
      else if (e.k === EV_JACKPOT) t.jackpots++;
      else if (e.k === EV_MULTIBALL) t.multiballs++;
    }
  }
  t.ms = performance.now() - start;
  t.score = p.score;
  return t;
}

describe("CPU players", () => {
  test("the skill shot pulls drop the ball into each lane", () => {
    SKILL_PULLS.forEach((pull, lane) => {
      const rules: Rules = { mode: "timed", endTick: 60 * TICK_HZ, balls: 3, seed: 1 };
      const p = startPlay(rules);
      let first = -1;
      for (let k = 0; k < 4 * TICK_HZ && first < 0; k++) {
        stepPlay(p, k < pull ? IN_PLUNGE : 0, TABLE, rules);
        for (const e of p.events) if (e.k === EV_LANE && first < 0) first = e.i;
      }
      expect(first).toBe(lane);
    });
  });

  test("hard outscores normal, which outscores easy", () => {
    const mean = (level: CpuLevel) => {
      let total = 0;
      for (let seed = 1; seed <= 8; seed++) total += play(level, seed, 60).score;
      return total / 8;
    };
    const [easy, normal, hard] = LEVELS.map(mean);
    expect(normal).toBeGreaterThan(easy);
    expect(hard).toBeGreaterThan(normal);
  });

  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const measure = Number(env.MEASURE ?? 0);
  test.skipIf(!measure)(
    "measure: two-minute games per level",
    () => {
      const games = measure > 1 ? measure : 200;
      const rows: string[] = [
        "| CPU | Mean score | Drains / min | Trouble sent / min | Multiballs / min | Jackpots / min | ms per game-second |",
        "| --- | --- | --- | --- | --- | --- | --- |",
      ];
      for (const level of LEVELS) {
        const sum: Tally = { score: 0, drains: 0, sends: 0, jackpots: 0, multiballs: 0, ms: 0 };
        for (let seed = 1; seed <= games; seed++) {
          const t = play(level, seed, 120);
          for (const k of Object.keys(sum) as (keyof Tally)[]) sum[k] += t[k];
        }
        const per = (v: number) => (v / games / 2).toFixed(2);
        rows.push(
          `| ${level} | ${Math.round(sum.score / games).toLocaleString("en-US")} | ${per(sum.drains)} | ${per(sum.sends)} | ${per(sum.multiballs)} | ${per(sum.jackpots)} | ${(sum.ms / games / 120).toFixed(2)} |`,
        );
      }
      console.log(`\n${games} two-minute games per level:\n${rows.join("\n")}\n`);
    },
    3_600_000,
  );
});
