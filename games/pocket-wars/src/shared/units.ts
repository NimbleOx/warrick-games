// Units: every stat in one table, plus the damage table.
import type { MoveType } from "./terrain";

export const UNIT_TYPES = ["infantry", "bazooka", "recon", "tank", "heavy", "artillery"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export interface UnitDef {
  name: string;
  /** For tight spaces: the build menu on phones, the log. */
  short: string;
  cost: number;
  move: number;
  moveType: MoveType;
  /** Attack range in Manhattan distance. A unit with maxRange > 1 fires indirectly. */
  minRange: number;
  maxRange: number;
  captures: boolean;
  blurb: string;
}

export const UNITS: Record<UnitType, UnitDef> = {
  infantry: {
    name: "Infantry", short: "Inf", cost: 1000, move: 3, moveType: "foot", minRange: 1, maxRange: 1, captures: true,
    blurb: "Cheap. Captures buildings and crosses mountains and rivers.",
  },
  bazooka: {
    name: "Bazooka", short: "Baz", cost: 3000, move: 2, moveType: "boots", minRange: 1, maxRange: 1, captures: true,
    blurb: "Anti-tank infantry. Slow, but hits tanks hard and captures.",
  },
  recon: {
    name: "Recon", short: "Rcn", cost: 4000, move: 8, moveType: "wheels", minRange: 1, maxRange: 1, captures: false,
    blurb: "Fast on roads, light armour. Good against infantry.",
  },
  tank: {
    name: "Tank", short: "Tnk", cost: 7000, move: 6, moveType: "treads", minRange: 1, maxRange: 1, captures: false,
    blurb: "The all-rounder.",
  },
  heavy: {
    name: "Heavy Tank", short: "Hvy", cost: 16000, move: 5, moveType: "treads", minRange: 1, maxRange: 1, captures: false,
    blurb: "Expensive and very tough. Beats anything up close.",
  },
  artillery: {
    name: "Artillery", short: "Art", cost: 6000, move: 5, moveType: "treads", minRange: 2, maxRange: 3, captures: false,
    blurb: "Fires 2–3 tiles away, but not after moving. Never hits back.",
  },
};

/**
 * Base damage: the percentage of a 10-HP defender a 10-HP attacker destroys on a 0-star tile.
 * DAMAGE[attacker][defender].
 */
export const DAMAGE: Record<UnitType, Record<UnitType, number>> = {
  infantry: { infantry: 55, bazooka: 45, recon: 12, tank: 5, heavy: 1, artillery: 15 },
  bazooka: { infantry: 65, bazooka: 55, recon: 85, tank: 55, heavy: 15, artillery: 70 },
  recon: { infantry: 70, bazooka: 65, recon: 35, tank: 6, heavy: 1, artillery: 45 },
  tank: { infantry: 75, bazooka: 70, recon: 85, tank: 55, heavy: 15, artillery: 70 },
  heavy: { infantry: 105, bazooka: 95, recon: 105, tank: 85, heavy: 55, artillery: 105 },
  artillery: { infantry: 90, bazooka: 85, recon: 80, tank: 70, heavy: 45, artillery: 75 },
};

export const MAX_HP = 10;
/** Units on their owner's buildings get this much back at the start of the turn. */
export const REPAIR_HP = 2;

export function isUnitType(v: unknown): v is UnitType {
  return typeof v === "string" && (UNIT_TYPES as readonly string[]).includes(v);
}

export function isIndirect(t: UnitType): boolean {
  return UNITS[t].maxRange > 1;
}

export const CHEAPEST_UNIT = Math.min(...UNIT_TYPES.map((t) => UNITS[t].cost));
