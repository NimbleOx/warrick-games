import { describe, expect, it } from "vitest";
import { cpuSteer } from "../src/shared/ai";
import { TICKS_PER_SEC } from "../src/shared/constants";
import type { CpuLevel } from "../src/shared/protocol";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { Round, configFor } from "../src/shared/sim";

/** Run a round where head i is driven by levels[i] (null = never steers). */
function play(seed: number, levels: (CpuLevel | null)[], maxTicks: number) {
  const r = new Round({ cfg: configFor("classic"), seed, ids: levels.map((_, i) => `p${i}`) });
  const rng = mulberry32(seed);
  while (!r.over && r.tick < maxTicks) {
    levels.forEach((level, i) => {
      if (!level) return;
      const s = cpuSteer(r, i, level, rng);
      if (s !== null) r.setSteer(i, s);
    });
    r.step();
  }
  return r;
}

describe("CPU players", () => {
  it("don't crash early when alone in an empty arena", () => {
    for (const level of ["easy", "normal", "hard"] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const r = play(seed, [level], 12 * TICKS_PER_SEC);
        expect(r.heads[0].alive, `${level} seed ${seed} died at tick ${r.heads[0].diedAt}`).toBe(true);
      }
    }
  });

  it("outlast a player who never steers", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = play(seed, ["normal", null], 60 * TICKS_PER_SEC);
      expect(r.over).toBe(true);
      expect(r.heads[0].alive).toBe(true);
    }
  });

  it("always finish a round between themselves", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = play(seed, ["hard", "hard", "normal", "easy"], 20 * 60 * TICKS_PER_SEC);
      expect(r.over, `seed ${seed} still going at tick ${r.tick}`).toBe(true);
    }
  });

  it("hard CPUs beat easy ones most of the time", () => {
    let hardWins = 0;
    const games = 40;
    for (let seed = 1; seed <= games; seed++) {
      const r = play(seed, ["hard", "easy"], 20 * 60 * TICKS_PER_SEC);
      if (r.heads[0].points > r.heads[1].points) hardWins++;
    }
    expect(hardWins).toBeGreaterThanOrEqual(games * 0.6);
  });
});
