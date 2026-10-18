import { describe, expect, it } from "vitest";
import { type ClockRules, type TurnClock, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "../src/worker/turns";

const RULES: ClockRules = { awayMs: 10_000 };
const T = 1_000_000;
const fresh = (): TurnClock => ({ clockEnd: null, turnDeadline: null });

describe("turn clock", () => {
  it("starts with the whole clock, or none", () => {
    const c = fresh();
    expect(startTurnClock(c, RULES, T, 60_000, true)).toBe(T + 60_000);
    expect(c).toEqual({ clockEnd: T + 60_000, turnDeadline: T + 60_000, clockTopUp: false });
    expect(startTurnClock(c, RULES, T, null, true)).toBeNull();
    expect(startTurnClock(c, RULES, T, 0, true)).toBeNull();
  });

  it("gives an absent player awayMs, or the clock if that's sooner", () => {
    const c = fresh();
    expect(startTurnClock(c, RULES, T, 60_000, false)).toBe(T + 10_000);
    expect(startTurnClock(c, RULES, T, 5_000, false)).toBe(T + 5_000);
    expect(startTurnClock(c, RULES, T, null, false)).toBe(T + 10_000);
    expect(c.clockEnd).toBeNull();
  });

  it("never gives time back for reloading: back, you have the clock you had", () => {
    const c = fresh();
    startTurnClock(c, RULES, T, 60_000, true);
    expect(turnHolderLeft(c, RULES, T + 20_000)).toBe(T + 30_000);
    expect(turnHolderBack(c, RULES, T + 21_000)).toBe(T + 60_000);
    // However often.
    for (let t = T + 22_000; t < T + 50_000; t += 3_000) {
      turnHolderLeft(c, RULES, t);
      expect(turnHolderBack(c, RULES, t + 1_000)).toBe(T + 60_000);
    }
  });

  it("tops up someone back with almost no time left, once a turn", () => {
    const c = fresh();
    startTurnClock(c, RULES, T, 60_000, true);
    turnHolderLeft(c, RULES, T + 50_000);
    expect(turnHolderBack(c, RULES, T + 58_000)).toBe(T + 63_000);
    turnHolderLeft(c, RULES, T + 59_000);
    expect(turnHolderLeft(c, RULES, T + 59_000)).toBe(T + 60_000);
    expect(turnHolderBack(c, RULES, T + 59_500)).toBe(T + 60_000);
    // The next turn has its own.
    startTurnClock(c, RULES, T + 70_000, 60_000, true);
    turnHolderLeft(c, RULES, T + 128_000);
    expect(turnHolderBack(c, RULES, T + 129_000)).toBe(T + 134_000);
  });

  it("with no time limit, being back clears the deadline", () => {
    const c = fresh();
    startTurnClock(c, { ...RULES, backMinMs: 3_000 }, T, null, true);
    expect(turnHolderLeft(c, RULES, T + 1_000)).toBe(T + 11_000);
    expect(turnHolderBack(c, RULES, T + 2_000)).toBeNull();
  });

  it("ends the turn at the deadline, but not before", () => {
    const c = fresh();
    startTurnClock(c, RULES, T, 30_000, true);
    expect(turnTimeUp(c, RULES, T + 29_000)).toBe(false);
    expect(turnTimeUp(c, RULES, T + 29_990)).toBe(true);
    expect(turnTimeUp(c, RULES, T + 31_000)).toBe(true);
    expect(c.turnDeadline).toBe(T + 30_000);
    expect(turnTimeUp(fresh(), RULES, T)).toBe(false);
  });

  it("starts a deadline nobody was there to see over at awayMs", () => {
    const c = fresh();
    startTurnClock(c, RULES, T, 30_000, true);
    turnHolderLeft(c, RULES, T + 5_000);
    // Everyone was gone; someone is back an hour later and the timer fires.
    const later = T + 3_600_000;
    expect(turnTimeUp(c, RULES, later)).toBe(false);
    expect(c.turnDeadline).toBe(later + 10_000);
    expect(turnTimeUp(c, RULES, later + 10_000)).toBe(true);
  });

  it("works with a game saved before it had a clockEnd", () => {
    const c: TurnClock = { turnDeadline: T + 40_000 };
    expect(turnHolderLeft(c, RULES, T)).toBe(T + 10_000);
    expect(turnHolderBack(c, RULES, T + 1_000)).toBe(T + 40_000);
    expect(c.clockEnd).toBe(T + 40_000);
  });
});
