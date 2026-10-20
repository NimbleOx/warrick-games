import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { describe, expect, test } from "vitest";
import { TICK_HZ } from "../src/shared/constants";
import { LocalTable } from "../src/shared/local";
import type { Trouble } from "../src/shared/protocol";
import { IN_LEFT, IN_PLUNGE, IN_RIGHT, T_BRICK, T_SWAP, playHash, playNumbers, type Rules } from "../src/shared/sim";
import { TABLE } from "../src/shared/table";

const RULES: Rules = { mode: "timed", endTick: 3 * 60 * TICK_HZ, balls: 3, seed: 77 };

/** Input bits for each tick, from a seeded player. */
function player(seed: number): (tick: number) => number {
  const rng = mulberry32(seed);
  const plan: number[] = [];
  let bits = 0;
  for (let t = 0; t < 20000; t++) {
    if (t % randInt(rng, 5, 30) === 0)
      bits = (rng() < 0.4 ? IN_LEFT : 0) | (rng() < 0.4 ? IN_RIGHT : 0) | (rng() < 0.3 ? IN_PLUNGE : 0);
    plan.push(bits);
  }
  return (tick) => plan[tick];
}

const trouble = (id: number, kind: number, at: number): Trouble => ({ id, from: "p2", to: "p1", kind, at, param: 3 });

describe("your own table", () => {
  test("trouble that arrives after its tick gives the same game as trouble known in time", () => {
    const input = player(5);
    const early = new LocalTable(TABLE, RULES, 1);
    const late = new LocalTable(TABLE, RULES, 1);
    const trs = [trouble(1, T_BRICK, 900), trouble(2, T_SWAP, 1500)];
    for (const tr of trs) early.addTrouble(tr);
    early.advance(2000, () => input(early.play.tick));
    // The late table hears of each a little after it should have landed.
    late.advance(960, () => input(late.play.tick));
    expect(late.addTrouble(trs[0])).toBe(true);
    late.advance(1580, () => input(late.play.tick));
    expect(late.addTrouble(trs[1])).toBe(true);
    late.advance(2000, () => input(late.play.tick));
    expect(playHash(late.play)).toBe(playHash(early.play));
  });

  test("trouble too late to go back for asks for the room's game", () => {
    const input = player(6);
    const t = new LocalTable(TABLE, RULES, 1);
    t.advance(1500, () => input(t.play.tick));
    expect(t.addTrouble(trouble(1, T_BRICK, 200))).toBe(false);
  });

  test("taking the room's game plays it on with our own inputs", () => {
    const input = player(8);
    const ours = new LocalTable(TABLE, RULES, 1);
    ours.advance(600, () => input(ours.play.tick));
    const room = playNumbers(ours.play);
    ours.advance(1200, () => input(ours.play.tick));
    const want = playHash(ours.play);
    // Something went wrong here; the room sends where it had us at 600.
    ours.play.score += 999;
    ours.adopt(room, input(600));
    expect(ours.play.tick).toBe(1200);
    expect(playHash(ours.play)).toBe(want);
  });

  test("a message restates the input where the last one left off, and every change since", () => {
    const t = new LocalTable(TABLE, RULES, 1);
    t.advance(10, () => 0);
    t.advance(20, () => IN_LEFT);
    const first = t.message();
    expect(first.ev).toEqual([
      [0, 0],
      [10, IN_LEFT],
    ]);
    t.sent(first);
    t.advance(30, () => IN_LEFT);
    expect(t.message().ev).toEqual([[20, IN_LEFT]]);
  });
});
