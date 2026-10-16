// Terrain: what each tile is, what it costs each movement type to enter, and its defence.

export const MOVE_TYPES = ["foot", "boots", "wheels", "treads"] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const TERRAINS = ["plains", "road", "bridge", "forest", "mountain", "river", "sea", "city", "factory", "hq"] as const;
export type Terrain = (typeof TERRAINS)[number];

export type BuildingKind = "city" | "factory" | "hq";

/** Can't enter. */
export const NO = 99;

export interface TerrainDef {
  name: string;
  /** Defence stars: each one takes 10% × the defender's HP off the damage it takes. */
  defense: number;
  cost: Record<MoveType, number>;
}

const ANY = { foot: 1, boots: 1, wheels: 1, treads: 1 };

export const TERRAIN: Record<Terrain, TerrainDef> = {
  plains: { name: "Plains", defense: 1, cost: { foot: 1, boots: 1, wheels: 2, treads: 1 } },
  road: { name: "Road", defense: 0, cost: ANY },
  bridge: { name: "Bridge", defense: 0, cost: ANY },
  forest: { name: "Forest", defense: 2, cost: { foot: 1, boots: 1, wheels: 3, treads: 2 } },
  mountain: { name: "Mountain", defense: 4, cost: { foot: 2, boots: 1, wheels: NO, treads: NO } },
  river: { name: "River", defense: 0, cost: { foot: 2, boots: 1, wheels: NO, treads: NO } },
  sea: { name: "Sea", defense: 0, cost: { foot: NO, boots: NO, wheels: NO, treads: NO } },
  city: { name: "City", defense: 3, cost: ANY },
  factory: { name: "Factory", defense: 3, cost: ANY },
  hq: { name: "HQ", defense: 4, cost: ANY },
};

export function isBuilding(t: Terrain): t is BuildingKind {
  return t === "city" || t === "factory" || t === "hq";
}

/** Every building pays this at the start of its owner's turn. */
export const INCOME_PER_BUILDING = 1000;
/** Capture points a building starts with (and goes back to). */
export const CAPTURE_POINTS = 20;
