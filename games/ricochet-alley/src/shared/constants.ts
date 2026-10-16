// World units: a maze cell is CELL units square, and y points DOWN (0 = top edge).
export const CELL = 100;
/** Walls are drawn and collided as rectangles this thick, centered on the grid lines. */
export const WALL_T = 6;

export const MAZE_SIZES = {
  small: { cols: 7, rows: 5 },
  medium: { cols: 9, rows: 6 },
  large: { cols: 12, rows: 8 },
} as const;
export type MazeSize = keyof typeof MAZE_SIZES;
/** Share of the walls left after carving the maze that get knocked out, to make loops. */
export const MAZE_LOOPINESS = 0.3;

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

// Tanks. Speeds are in units per tick.
export const TANK_R = 18;
export const TANK_SPEED = 5;
export const TANK_REVERSE = 3.5;
/**
 * Heading steps (of 0.5°) turned on the 1st, 2nd, … tick of holding a turn key, then the last one from then on:
 * full speed is 14 steps = 7° a tick, 210° a second. Tapping turns just 2°, so you can line up bank shots.
 */
export const TURN_RAMP = [4, 6, 9, 12, 14] as const;
/** Bullets leave from this far in front of the tank's center. */
export const MUZZLE = 24;

// Bullets.
export const BULLET_R = 4;
export const BULLET_SPEED = 10;
/** Ticks a bullet lives: about 6 seconds. */
export const BULLET_LIFE = 6 * TICK_HZ;
export const MAX_BULLETS = 5;
export const REFIRE_TICKS = 5;

/** Once one tank (or none) is left, the round runs on this long so bullets still in flight count. */
export const HANG_TICKS = 2 * TICK_HZ;

/** Number of floor/wall palettes the client knows how to draw. */
export const THEME_COUNT = 5;
