import { parseMap, type MapDef } from "../src/shared/maps";
import { newBoard, tileOf, type Board, type Unit } from "../src/shared/rules";
import type { UnitType } from "../src/shared/units";

let n = 0;

/** A test map from ASCII rows, in the same format as src/shared/maps.ts. */
export function testMap(rows: string[], players = 2): MapDef {
  return parseMap({ id: `test-${n++}`, name: "Test", players, blurb: "", rows });
}

/** A fresh board with these units on it (all ready to act). */
export function boardWith(m: MapDef, units: [UnitType, number, number, number, number?][], funds: number[] = []): Board {
  const b = newBoard(m, funds);
  for (const [type, seat, x, y, hp] of units) {
    b.units.push({ id: b.nextId++, type, seat, x, y, hp: hp ?? 10, done: false });
  }
  return b;
}

export function unitAt(m: MapDef, b: Board, x: number, y: number): Unit | undefined {
  return b.units.find((u) => u.x === x && u.y === y);
}

export const at = (m: MapDef, x: number, y: number) => tileOf(m, x, y);
