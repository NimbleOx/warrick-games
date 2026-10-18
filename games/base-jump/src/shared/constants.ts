// Distances are in map units: the map is laid out landscape, roughly 1000–2000 units across.
// Times are in ticks.

/** Server simulation rate. */
export const TICKS_PER_SEC = 10;
export const TICK_MS = 1000 / TICKS_PER_SEC;

/** Frozen "3, 2, 1" at the start of a round. */
export const COUNTDOWN_TICKS = 3 * TICKS_PER_SEC;
/** Every this many ticks a frame carries a checksum of the battle, so clients can spot drift. */
export const CHECKSUM_EVERY = 50;

export const TANK = 0;
export const HELI = 1;
export type UnitKind = typeof TANK | typeof HELI;

/** Map units per tick. Helicopters fly nearly twice as fast as tanks drive. */
export const SPEED: Record<UnitKind, number> = { [TANK]: 5.5, [HELI]: 9.5 };

/** In a fight, one tank is worth this many helicopters (attacking or defending). */
export const TANK_WORTH = 2;

export const MAX_LEVEL = 3;
/** By level (index 0 unused): thousandths of a unit built per tick, the cap, and the base's radius. */
export const BUILD_RATE = [0, 55, 80, 110];
export const CAP = [0, 30, 50, 75];
export const RADIUS = [0, 22, 27, 32];
/** A base holding more than its cap loses a twentieth of the excess (at least one unit) this often. */
export const DECAY_EVERY = TICKS_PER_SEC;
export const DECAY_SHARE = 20;
/** Units spent to reach each level from the one below. */
export const UPGRADE_COST = [0, 0, 15, 30];

/** Everyone starts with one depot of this level holding this many tanks. */
export const START_LEVEL = 2;
export const START_TANKS = 15;
/** Neutral garrisons by level: [min, max] tanks. */
export const NEUTRAL_GARRISON: [number, number][] = [
  [0, 0],
  [4, 9],
  [10, 16],
  [18, 26],
];

/** The send sizes players pick from, in percent of each base's units. */
export const SEND_PCTS = [25, 50, 100] as const;
export type SendPct = (typeof SEND_PCTS)[number];

/** Base Jump's player colours: the usual ones, with violet in place of white (neutral bases are grey). */
export const PLAYER_COLORS = [
  "#ff4d4d", // red
  "#4da6ff", // blue
  "#5ce65c", // green
  "#ffd23f", // yellow
  "#ff6bd6", // pink
  "#3ff0e0", // cyan
  "#ff9a3c", // orange
  "#b48cff", // violet
] as const;
