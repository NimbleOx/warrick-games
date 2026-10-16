import { describe, expect, it } from "vitest";
import { actProblem, pathTo, reach, unitTile } from "../src/shared/rules";
import { at, boardWith, testMap } from "./helpers";

// 9 × 5: plains, a road along the middle, a mountain column, a river column and a forest.
const M = testMap([
  "H1. . . ^ . . . . ",
  ". . . . ^ . . . . ",
  "= = = = = = = = = ",
  ". . . T ~ . . . . ",
  "F1. . . ~ . . . H2",
]);

const reachable = (r: ReturnType<typeof reach>) => new Set(r.ends);

describe("movement", () => {
  it("spends move points on terrain costs: infantry walks 3 plains", () => {
    const b = boardWith(M, [["infantry", 0, 1, 1]]);
    const r = reach(M, b, b.units[0]);
    expect(r.cost[at(M, 1, 1)]).toBe(0);
    expect(r.cost[at(M, 3, 1)]).toBe(2);
    // The mountain costs foot 2: 1 + 1 + 2 is more than 3.
    expect(r.cost[at(M, 4, 1)]).toBe(-1);
    expect(r.cost[at(M, 1, 4)]).toBe(3);
  });

  it("charges each movement type differently", () => {
    // Boots climb mountains for 1; foot pays 2.
    const b = boardWith(M, [
      ["bazooka", 0, 3, 0],
      ["infantry", 0, 3, 1],
    ]);
    const baz = reach(M, b, b.units[0]);
    expect(baz.cost[at(M, 4, 0)]).toBe(1);
    const inf = reach(M, b, b.units[1]);
    expect(inf.cost[at(M, 4, 1)]).toBe(2);
    // Down to the road and along (2), then the river (2): 4 is too far.
    expect(inf.cost[at(M, 4, 3)]).toBe(-1);
  });

  it("keeps treads off mountains and rivers, and charges them 2 in forest", () => {
    const b = boardWith(M, [["tank", 0, 3, 2]]);
    const r = reach(M, b, b.units[0]);
    expect(r.cost[at(M, 4, 1)]).toBe(-1);
    expect(r.cost[at(M, 4, 3)]).toBe(-1);
    expect(r.cost[at(M, 3, 3)]).toBe(2);
    // Along the road it goes the full 6.
    expect(r.cost[at(M, 8, 2)]).toBe(5);
  });

  it("makes wheels fast on roads and slow on plains", () => {
    const b = boardWith(M, [["recon", 0, 0, 2]]);
    const r = reach(M, b, b.units[0]);
    expect(r.cost[at(M, 8, 2)]).toBe(8);
    expect(r.cost[at(M, 0, 1)]).toBe(2);
    expect(r.cost[at(M, 3, 3)]).toBe(6); // 3 road + forest 3
  });

  it("is blocked by enemy units", () => {
    // A tank on the road with an enemy two tiles ahead and mountains/river around.
    const b = boardWith(M, [
      ["tank", 0, 2, 2],
      ["infantry", 1, 4, 2],
    ]);
    const r = reach(M, b, b.units[0]);
    // (4,2) is the only way across the mountain/river column for treads: the enemy stops it.
    expect(r.cost[at(M, 4, 2)]).toBe(-1);
    expect(r.cost[at(M, 5, 2)]).toBe(-1);
    expect(actProblem(M, b, 0, { unit: b.units[0].id, to: at(M, 5, 2), action: "wait" })).toBe("It can't get there this turn");
  });

  it("passes through its own side's units but can't stop on them", () => {
    const b = boardWith(M, [
      ["tank", 0, 2, 2],
      ["infantry", 0, 4, 2],
    ]);
    const tank = b.units[0];
    const r = reach(M, b, tank);
    expect(r.cost[at(M, 4, 2)]).toBe(2);
    expect(r.cost[at(M, 6, 2)]).toBe(4);
    expect(reachable(r).has(at(M, 4, 2))).toBe(false);
    expect(reachable(r).has(at(M, 6, 2))).toBe(true);
    expect(pathTo(r, at(M, 6, 2))).toEqual([at(M, 2, 2), at(M, 3, 2), at(M, 4, 2), at(M, 5, 2), at(M, 6, 2)]);
    expect(actProblem(M, b, 0, { unit: tank.id, to: at(M, 4, 2), action: "wait" })).toBe("Something is already there");
    // Staying put is fine.
    expect(reachable(r).has(unitTile(M, tank))).toBe(true);
    expect(actProblem(M, b, 0, { unit: tank.id, to: unitTile(M, tank), action: "wait" })).toBeNull();
  });

  it("checks whose unit it is and that it hasn't moved", () => {
    const b = boardWith(M, [
      ["infantry", 0, 1, 1],
      ["infantry", 1, 7, 3],
    ]);
    expect(actProblem(M, b, 0, { unit: b.units[1].id, to: at(M, 7, 3), action: "wait" })).toBe("That's not your unit");
    b.units[0].done = true;
    expect(actProblem(M, b, 0, { unit: b.units[0].id, to: at(M, 1, 1), action: "wait" })).toMatch(/already moved/);
    expect(actProblem(M, b, 0, { unit: 99, to: 0, action: "wait" })).toBe("That unit isn't on the map");
  });
});
