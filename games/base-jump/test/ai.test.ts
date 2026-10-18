import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { newBrain, think, type CpuLevel } from "../src/shared/ai";
import { Battle } from "../src/shared/battle";
import { TICKS_PER_SEC } from "../src/shared/constants";
import { generateMap, type MapSize } from "../src/shared/map";

/** CPUs play a whole round. Returns the ranking and how long it took. */
function play(seed: number, levels: CpuLevel[], size: MapSize = "medium", minutes = 15) {
  const map = generateMap(seed, levels.length, size);
  const slots = levels.map((_, i) => i);
  const b = new Battle(map, { slots, countdown: 0, limit: minutes * 60 * TICKS_PER_SEC });
  const rng = mulberry32(seed);
  const brains = levels.map((l) => newBrain(l));
  let thinking = 0;
  while (!b.over) {
    const t0 = performance.now();
    slots.forEach((s) => think(b, s, brains[s], rng, (cmd) => b.apply(cmd)));
    thinking = Math.max(thinking, performance.now() - t0);
    b.step();
  }
  return { ranking: b.ranking(), ticks: b.n, battle: b, thinking };
}

describe("CPU players", () => {
  it("finish a duel by conquest well inside the clock", () => {
    for (const seed of [1, 2, 3]) {
      const { battle, ticks } = play(seed, ["normal", "normal"]);
      expect(battle.aliveSlots().length).toBe(1);
      expect(ticks).toBeLessThan(10 * 60 * TICKS_PER_SEC);
    }
  });

  it("let hard beat normal and normal beat easy, most of the time", () => {
    // Seats swap every other game, so the map's quirks even out. Over 160 games (see the
    // README) hard beats normal about 80% of the time and normal beats easy every time.
    const duels = (strong: CpuLevel, weak: CpuLevel) => {
      let wins = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const swap = seed % 2 === 0;
        const r = play(seed * 7919, swap ? [weak, strong] : [strong, weak], seed % 4 < 2 ? "small" : "medium", 12);
        if (r.ranking[0] === (swap ? 1 : 0)) wins++;
      }
      return wins;
    };
    expect(duels("hard", "normal")).toBeGreaterThanOrEqual(13);
    expect(duels("normal", "easy")).toBeGreaterThanOrEqual(18);
  });

  it("can run a full eight-player game, thinking quickly", () => {
    const { battle, thinking } = play(4, ["hard", "normal", "easy", "hard", "normal", "easy", "hard", "normal"], "large", 6);
    expect(battle.over).toBe(true);
    // Every CPU's look at the map in one tick, together.
    expect(thinking).toBeLessThan(40);
  });

  it("does nothing during the countdown", () => {
    const map = generateMap(3, 2, "small");
    const b = new Battle(map, { slots: [0, 1], countdown: 30, limit: 0 });
    const acts: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      think(b, 0, newBrain("hard"), mulberry32(1), (cmd) => acts.push(cmd) > 0);
      b.step();
    }
    expect(acts).toEqual([]);
  });
});
