import { describe, expect, it } from "vitest";
import {
  actProblem,
  applyAct,
  applyBuild,
  buildProblem,
  damage,
  endTurn,
  forecast,
  knockOut,
  startTurn,
  unitTile,
  winnerSeat,
} from "../src/shared/rules";
import { CAPTURE_POINTS } from "../src/shared/terrain";
import { DAMAGE, UNITS } from "../src/shared/units";
import { at, boardWith, testMap, unitAt } from "./helpers";

// 8 × 5 with plains, a forest, a mountain, a city, and each side's HQ and factory.
const M = testMap(["H1. . . . . . . ", ". . . . . . . . ", ". . T . ^ C-. . ", ". . . . . . . . ", "F1. . . . . F2H2"]);
const CITY = M.buildingAt[at(M, 5, 2)];

describe("damage", () => {
  it("comes from the table, scaled by the attacker's HP and cut by the defender's cover", () => {
    expect(DAMAGE.infantry.infantry).toBe(55);
    // 55% × 10/10 × (100 − 1 star × 10 HP)% = 4.95 HP on plains.
    expect(damage("infantry", 10, "infantry", 10, 1)).toBe(5);
    expect(damage("tank", 10, "infantry", 10, 0)).toBe(8);
    expect(damage("tank", 5, "infantry", 10, 1)).toBe(3);
    expect(damage("tank", 10, "infantry", 10, 2)).toBe(6);
    expect(damage("tank", 10, "infantry", 10, 4)).toBe(5);
    // A weaker defender gets less out of its cover.
    expect(damage("tank", 10, "infantry", 3, 4)).toBe(3);
    // Never more than the defender has, never less than nothing.
    expect(damage("heavy", 10, "infantry", 4, 0)).toBe(4);
    expect(damage("infantry", 10, "heavy", 10, 0)).toBe(0);
  });

  it("forecasts both ways, and the defender hits back with what it has left", () => {
    const b = boardWith(M, [
      ["infantry", 0, 1, 1],
      ["infantry", 1, 3, 1],
    ]);
    const [a, d] = b.units;
    const f = forecast(M, a, at(M, 2, 1), d);
    expect(f).toEqual({ dealt: 5, taken: damage("infantry", 5, "infantry", 10, 1), kills: false, dies: false, counter: true });
    expect(f.taken).toBe(2);
    const ev = applyAct(M, b, 0, { unit: a.id, to: at(M, 2, 1), action: "attack", target: d.id });
    expect(ev).toMatchObject({ dealt: 5, taken: 2, killed: false, lost: false, path: [at(M, 1, 1), at(M, 2, 1)] });
    expect(a.hp).toBe(8);
    expect(d.hp).toBe(5);
    expect(a.done).toBe(true);
  });

  it("gets no counterattack from a destroyed defender", () => {
    const b = boardWith(M, [
      ["heavy", 0, 1, 1],
      ["infantry", 1, 2, 1, 3],
    ]);
    const ev = applyAct(M, b, 0, { unit: b.units[0].id, to: at(M, 1, 1), action: "attack", target: b.units[1].id });
    expect(ev).toMatchObject({ dealt: 3, taken: 0, killed: true });
    expect(b.units).toHaveLength(1);
  });

  it("can destroy the attacker with the counterattack", () => {
    const b = boardWith(M, [
      ["infantry", 0, 1, 1, 1],
      ["tank", 1, 2, 1],
    ]);
    const ev = applyAct(M, b, 0, { unit: b.units[0].id, to: at(M, 1, 1), action: "attack", target: b.units[1].id });
    expect(ev).toMatchObject({ dealt: 0, lost: true });
    expect(b.units.map((u) => u.type)).toEqual(["tank"]);
  });

  it("only attacks enemies in range", () => {
    const b = boardWith(M, [
      ["tank", 0, 1, 1],
      ["infantry", 1, 5, 1],
      ["infantry", 0, 1, 3],
    ]);
    expect(actProblem(M, b, 0, { unit: 1, to: at(M, 2, 1), action: "attack", target: 2 })).toBe("That target is out of range");
    expect(actProblem(M, b, 0, { unit: 1, to: at(M, 1, 2), action: "attack", target: 3 })).toBe("That's one of yours");
    expect(actProblem(M, b, 0, { unit: 1, to: at(M, 4, 1), action: "attack", target: 2 })).toBeNull();
  });
});

describe("artillery", () => {
  const setup = () =>
    boardWith(M, [
      ["artillery", 0, 1, 1],
      ["tank", 1, 3, 1],
      ["infantry", 1, 2, 1],
      ["infantry", 1, 5, 1],
    ]);

  it("fires at range 2–3 only", () => {
    const b = setup();
    const art = b.units[0];
    expect(actProblem(M, b, 0, { unit: art.id, to: unitTile(M, art), action: "attack", target: 2 })).toBeNull();
    expect(actProblem(M, b, 0, { unit: art.id, to: unitTile(M, art), action: "attack", target: 3 })).toBe(
      "That target is out of range",
    );
    expect(actProblem(M, b, 0, { unit: art.id, to: unitTile(M, art), action: "attack", target: 4 })).toBe(
      "That target is out of range",
    );
  });

  it("can't move and fire in the same turn", () => {
    const b = setup();
    const art = b.units[0];
    expect(actProblem(M, b, 0, { unit: art.id, to: at(M, 1, 2), action: "attack", target: 2 })).toBe(
      "Artillery can't move and fire in the same turn",
    );
    // Moving and waiting is fine.
    expect(actProblem(M, b, 0, { unit: art.id, to: at(M, 1, 2), action: "wait" })).toBeNull();
  });

  it("never takes a counterattack when it fires", () => {
    const b = setup();
    const ev = applyAct(M, b, 0, { unit: 1, to: at(M, 1, 1), action: "attack", target: 2 });
    expect(ev.taken).toBe(0);
    expect(ev.dealt).toBe(damage("artillery", 10, "tank", 10, 1));
    expect(b.units[0].hp).toBe(10);
  });

  it("never hits back when it's attacked", () => {
    const b = setup();
    const ev = applyAct(M, b, 1, { unit: 3, to: at(M, 2, 1), action: "attack", target: 1 });
    expect(ev.dealt).toBeGreaterThan(0);
    expect(ev.taken).toBe(0);
    expect(forecast(M, b.units[2], at(M, 2, 1), b.units[0]).counter).toBe(false);
  });
});

describe("capturing", () => {
  it("takes the unit's HP off the building's 20 points each turn, then flips it", () => {
    const b = boardWith(M, [["infantry", 0, 4, 1]]);
    const inf = b.units[0];
    const ev = applyAct(M, b, 0, { unit: inf.id, to: at(M, 5, 2), action: "capture" });
    expect(ev).toMatchObject({ building: CITY, left: 10 });
    expect(ev.captured).toBeUndefined();
    expect(b.owners[CITY]).toBe(-1);
    endTurn(b, 0);
    const ev2 = applyAct(M, b, 0, { unit: inf.id, to: at(M, 5, 2), action: "capture" });
    expect(ev2).toMatchObject({ captured: true, left: CAPTURE_POINTS });
    expect(b.owners[CITY]).toBe(0);
  });

  it("goes slower with a damaged unit", () => {
    const b = boardWith(M, [["bazooka", 0, 5, 2, 4]]);
    applyAct(M, b, 0, { unit: 1, to: at(M, 5, 2), action: "capture" });
    expect(b.capture[CITY]).toBe(16);
  });

  it("starts over when the capturing unit moves away", () => {
    const b = boardWith(M, [["infantry", 0, 5, 2]]);
    applyAct(M, b, 0, { unit: 1, to: at(M, 5, 2), action: "capture" });
    expect(b.capture[CITY]).toBe(10);
    endTurn(b, 0);
    // Waiting on the building keeps the progress; leaving it doesn't.
    applyAct(M, b, 0, { unit: 1, to: at(M, 5, 2), action: "wait" });
    expect(b.capture[CITY]).toBe(10);
    endTurn(b, 0);
    applyAct(M, b, 0, { unit: 1, to: at(M, 6, 2), action: "wait" });
    expect(b.capture[CITY]).toBe(CAPTURE_POINTS);
  });

  it("starts over when the capturing unit is destroyed", () => {
    const b = boardWith(M, [
      ["infantry", 0, 5, 2, 2],
      ["heavy", 1, 6, 2],
    ]);
    applyAct(M, b, 0, { unit: 1, to: at(M, 5, 2), action: "capture" });
    expect(b.capture[CITY]).toBe(18);
    applyAct(M, b, 1, { unit: 2, to: at(M, 6, 2), action: "attack", target: 1 });
    expect(b.capture[CITY]).toBe(CAPTURE_POINTS);
  });

  it("is for infantry and bazookas, on buildings you don't own", () => {
    const b = boardWith(M, [
      ["tank", 0, 5, 1],
      ["infantry", 0, 1, 0],
    ]);
    expect(actProblem(M, b, 0, { unit: 1, to: at(M, 5, 2), action: "capture" })).toMatch(/can't capture/);
    expect(actProblem(M, b, 0, { unit: 2, to: at(M, 0, 0), action: "capture" })).toBe("You already own that building");
    expect(actProblem(M, b, 0, { unit: 2, to: at(M, 2, 0), action: "capture" })).toBe("There's no building there");
  });

  it("knocks a player out by taking their HQ: their army goes and their buildings turn neutral", () => {
    const b = boardWith(M, [
      ["infantry", 0, 7, 3],
      ["tank", 1, 3, 3],
    ]);
    b.owners[CITY] = 1;
    const hq2 = M.hq[1];
    b.capture[hq2] = 10;
    const ev = applyAct(M, b, 0, { unit: 1, to: at(M, 7, 4), action: "capture" });
    expect(ev).toMatchObject({ captured: true, out: [1] });
    expect(b.out).toEqual([false, true]);
    expect(b.owners[hq2]).toBe(0);
    expect(b.owners[CITY]).toBe(-1);
    expect(b.owners[M.buildingAt[at(M, 6, 4)]]).toBe(-1);
    expect(b.units.map((u) => u.seat)).toEqual([0]);
    expect(winnerSeat(b)).toBe(0);
  });
});

describe("funds and building", () => {
  it("pays 1,000 per building at the start of the turn", () => {
    const b = boardWith(M, [], [500, 0]);
    b.owners[CITY] = 0;
    const t = startTurn(M, b, 0);
    expect(t.income).toBe(3000);
    expect(b.funds[0]).toBe(3500);
    expect(b.funds[1]).toBe(0);
  });

  it("repairs units on their own buildings, if it can pay", () => {
    const b = boardWith(
      M,
      [
        ["tank", 0, 0, 0, 5],
        ["infantry", 0, 5, 2, 9],
        ["infantry", 0, 3, 3, 4],
      ],
      [0, 0],
    );
    b.owners[CITY] = 0;
    // Income 3,000 (HQ, factory, city): a tank's 2 HP cost 1,400, the infantry's 1 HP 100.
    const t = startTurn(M, b, 0);
    expect(t.repairs).toEqual([
      { unit: 1, hp: 7 },
      { unit: 2, hp: 10 },
    ]);
    expect(t.repairCost).toBe(1500);
    expect(b.funds[0]).toBe(1500);
    expect(b.units[2].hp).toBe(4);
    // Not enough for two HP: one.
    const b2 = boardWith(M, [["tank", 0, 0, 0, 5]]);
    b2.owners[M.buildingAt[at(M, 0, 4)]] = -1;
    startTurn(M, b2, 0);
    expect(b2.units[0].hp).toBe(6);
    expect(b2.funds[0]).toBe(300);
  });

  it("builds at a free factory you own, if you can pay; the unit waits for next turn", () => {
    const f1 = at(M, 0, 4);
    const b = boardWith(M, [], [4000, 0]);
    expect(buildProblem(M, b, 0, f1, "tank")).toMatch(/^Not enough funds/);
    expect(buildProblem(M, b, 0, at(M, 6, 4), "infantry")).toBe("That factory isn't yours");
    expect(buildProblem(M, b, 0, at(M, 0, 0), "infantry")).toBe("Units are built at factories");
    expect(buildProblem(M, b, 0, f1, "spaceship")).toBe("Unknown unit");
    expect(buildProblem(M, b, 0, f1, "recon")).toBeNull();
    const ev = applyBuild(M, b, 0, f1, "recon");
    expect(b.funds[0]).toBe(4000 - UNITS.recon.cost);
    expect(ev.unit).toMatchObject({ type: "recon", seat: 0, x: 0, y: 4, hp: 10, done: true });
    expect(buildProblem(M, b, 0, f1, "infantry")).toBe("Something is standing on that factory");
    expect(actProblem(M, b, 0, { unit: ev.unit.id, to: f1, action: "wait" })).toMatch(/already moved/);
    endTurn(b, 0);
    expect(actProblem(M, b, 0, { unit: ev.unit.id, to: at(M, 1, 4), action: "wait" })).toBeNull();
  });
});

describe("knockouts", () => {
  it("knocks out a player with no units and no factory straight away", () => {
    const b = boardWith(M, [
      ["tank", 0, 1, 1],
      ["infantry", 1, 2, 1, 1],
    ]);
    b.owners[M.buildingAt[at(M, 6, 4)]] = -1;
    const ev = applyAct(M, b, 0, { unit: 1, to: at(M, 1, 1), action: "attack", target: 2 });
    expect(ev.out).toEqual([1]);
    expect(b.out[1]).toBe(true);
    expect(winnerSeat(b)).toBe(0);
  });

  it("knocks out a player with no units who can't build at the start of their turn", () => {
    const b = boardWith(M, [["tank", 0, 6, 4]], [0, 0]);
    // Seat 2's factory is blocked by an enemy tank, so it can't build even with funds.
    const t = startTurn(M, b, 1);
    expect(t.out).toBe(true);
    expect(b.out[1]).toBe(true);
    // With a free factory and enough to pay, it carries on.
    const b2 = boardWith(M, [], [0, 0]);
    expect(startTurn(M, b2, 1).out).toBe(false);
  });

  it("turns a resigning player's buildings neutral and removes their army", () => {
    const b = boardWith(M, [
      ["tank", 0, 1, 1],
      ["infantry", 1, 5, 2],
    ]);
    applyAct(M, b, 1, { unit: 2, to: at(M, 5, 2), action: "capture" });
    knockOut(M, b, 1);
    expect(b.units.map((u) => u.id)).toEqual([1]);
    expect(b.owners.filter((o) => o === 1)).toEqual([]);
    expect(b.owners[M.hq[1]]).toBe(-1);
    expect(b.capture[CITY]).toBe(CAPTURE_POINTS);
    expect(winnerSeat(b)).toBe(0);
    expect(unitAt(M, b, 5, 2)).toBeUndefined();
  });
});
