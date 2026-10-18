// World is measured in logical pixels with y pointing UP (0 = bottom of the map).
export const WORLD_W = 1200;
export const WORLD_H = 675;

export const TICKS_PER_SEC = 60;
export const TICK_MS = 1000 / TICKS_PER_SEC;

// Physics, in px/tick and px/tick².
export const GRAVITY = 0.1;
export const MAX_SPEED = 14;
export const WIND_ACCEL = 0.0012;
export const MAX_POWER = 1000;

// Tank geometry.
export const TANK_HALF_W = 10;
export const TANK_H = 9;
export const TURRET_Y = 8;
export const BARREL_LEN = 14;

export const START_HEALTH = 100;
export const SHIELD_HP = 60;

// Economy and scoring.
export const CASH_PER_DAMAGE = 40;
export const CASH_PER_KILL = 3000;
export const CASH_SURVIVE = 2000;
export const CASH_WIN = 4000;
export const SCORE_PER_KILL = 100;
export const SCORE_PER_WIN = 250;

/** Number of sky/terrain palettes the client knows how to draw. */
export const THEME_COUNT = 6;
