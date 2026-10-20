/**
 * One player's game on the table: the balls, the flippers, the plunger, scoring and the rules
 * (lanes, drop targets, the scoop, multiball, ball save, tilt), and the trouble rivals send.
 *
 * It's deterministic across browsers, bit for bit: the player's screen and the room step the
 * same game from the same inputs (see CLAUDE.md). Only + − × ÷, `Math.sqrt`, `abs`, `min`,
 * `max`, `floor`, `round` and `imul`, and `dsin`/`dcos` from dmath.ts; never `Math.sin`,
 * `cos`, `atan2`, `hypot`, `pow`, `exp` or `**`. A test reads the source and checks.
 */

import { dcos, dsin } from "./dmath";
import { DT, SUBSTEPS, TICK_HZ } from "./constants";
import {
  BALL_R,
  BRICK_HH,
  BRICK_HW,
  BUMPER,
  DROP,
  FLIP_REST,
  FLIP_UP,
  GATE,
  MID_X,
  SLING,
  S_INLANE_L,
  S_INLANE_R,
  S_LANE,
  S_ORBIT,
  S_OUTLANE_L,
  S_OUTLANE_R,
  S_SHOOTER,
  TARGET,
  type Table,
} from "./table";

/** Tuning: the feel of the table. Changing it changes every hash (test/fixtures). */
export const TUNE = {
  /** Down the table, in units a second squared. */
  gravity: 1500,
  maxSpeed: 4200,
  /** How fast a flipper swings up and falls back, in radians a second. */
  flipUp: 28,
  flipDown: 15,
  flipE: 0.3,
  /** Slower than this into anything and the ball doesn't bounce: it settles. */
  restSpeed: 40,
  /** What a pop bumper and a slingshot add to the ball. */
  bumperKick: 950,
  slingKick: 800,
  /** A slingshot fires only when hit this hard. */
  slingMin: 90,
  /** A standup target counts only when hit this hard. */
  targetMin: 60,
  /** The plunger: the launch speed at no pull and at full pull, and the ticks to pull it all the way. */
  plungeMin: 1500,
  plungeMax: 1850,
  pullTicks: 120,
  /** A nudge: a shove towards the middle and up the table. */
  nudgeX: 170,
  nudgeY: 130,
};

// ---------------------------------------------------------------------------------------------
// Rules and their numbers.

/** Timed: everyone plays for the same time, with as many balls as it takes. Balls: so many each. */
export type Mode = "timed" | "balls";

export interface Rules {
  mode: Mode;
  /** The tick the game ends at: the time limit, or for balls the cap. */
  endTick: number;
  /** Balls each (balls mode). */
  balls: number;
  /** The game's luck (which lane the skill shot lights), the same for everyone in a match. */
  seed: number;
}

export const POWER_MAX = 8;
const SEC = TICK_HZ;
/** Ball save after a launch, and after multiball starts. */
const SAVE_TICKS = 6 * SEC;
const MULTIBALL_SAVE = 10 * SEC;
/** A ball left on the plunger launches itself after this long. */
export const AUTO_TICKS = 10 * SEC;
/** A saved ball launches itself this soon. */
const SAVED_LAUNCH = Math.round(0.5 * SEC);
/** From a drain to the next ball on the plunger. */
const SERVE_TICKS = Math.round(1.5 * SEC);
/** How long the scoop holds the ball. */
const SCOOP_HOLD = SEC;
const COMBO_TICKS = 4 * SEC;
/** The skill shot counts if the first lane the ball rolls through within this long is the lit one. */
const SKILL_TICKS = 3 * SEC;
const DROP_RESET = Math.round(1.5 * SEC);
/** Each nudge raises the danger; three and it's a tilt. One comes off every this many ticks. */
export const DANGER_TICKS = 2 * SEC;
export const TILT_AT = 3;
const MULTIBALL_EVERY = Math.round(0.8 * SEC);
/** A ball barely moving for this long, away from the flippers, gets a kick. */
const STUCK_TICKS = 3 * SEC;

// Trouble: what a rival can send you, and how long each lasts.
export const T_BRICK = 0;
export const T_SHRINK = 1;
export const T_FOG = 2;
export const T_SWAP = 3;
export const TROUBLES = [T_BRICK, T_SHRINK, T_FOG, T_SWAP] as const;
export const TROUBLE_TICKS = [12 * SEC, 10 * SEC, 8 * SEC, 6 * SEC];
/** A shrunk flipper's length, as a share of the full one. */
export const SHRINK = 0.62;

// Input bits.
export const IN_LEFT = 1;
export const IN_RIGHT = 2;
export const IN_PLUNGE = 4;
export const IN_NUDGE = 8;

// Ball states.
export const B_OFF = 0;
export const B_FREE = 1;
/** Waiting on the plunger. */
export const B_PLUNGER = 2;
/** Held in the scoop. */
export const B_SCOOP = 3;
export const MAX_BALLS = 3;

// Events: what happened on a tick, for sounds, popups and the room (which routes `EV_SEND`).
export const EV_FLIP = 0;
export const EV_BUMPER = 1;
export const EV_SLING = 2;
export const EV_DROP = 3;
export const EV_BANK = 4;
export const EV_TARGET = 5;
export const EV_TARGETS = 6;
export const EV_LANE = 7;
export const EV_LANES = 8;
export const EV_ORBIT = 9;
export const EV_SCOOP = 10;
export const EV_LOCK = 11;
export const EV_MULTIBALL = 12;
export const EV_JACKPOT = 13;
export const EV_SKILL = 14;
export const EV_LAUNCH = 15;
export const EV_SAVED = 16;
export const EV_DRAIN = 17;
export const EV_LOST = 18;
export const EV_BONUS = 19;
export const EV_OVER = 20;
export const EV_SEND = 21;
export const EV_NUDGE = 22;
export const EV_WARN = 23;
export const EV_TILT = 24;
export const EV_OUTLANE = 26;
export const EV_INLANE = 27;
export const EV_SERVE = 28;
export const EV_KICK = 29;
export const EV_HIT = 30;
/** The scoop kicks the ball out. */
export const EV_EJECT = 31;

export interface Ev {
  k: number;
  /** Which one (a bumper's id, a trouble's kind…), or how many (a combo). */
  i: number;
  /** Points scored, for a popup. */
  pts: number;
  x: number;
  y: number;
}

export class Ball {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  st = B_OFF;
  /** Ticks in this state (on the plunger, in the scoop). */
  t = 0;
  /** Ticks barely moving. */
  still = 0;

  copyFrom(o: Ball): this {
    this.x = o.x;
    this.y = o.y;
    this.vx = o.vx;
    this.vy = o.vy;
    this.st = o.st;
    this.t = o.t;
    this.still = o.still;
    return this;
  }
}

/** One player's game. Everything here is state (and so in `playNumbers` and the hash) except `events`. */
export class Play {
  tick = 0;
  readonly balls: Ball[] = [new Ball(), new Ball(), new Ball()];
  /** The flippers' angles (see FLIP_REST), left and right. */
  readonly flip = [FLIP_REST, FLIP_REST];
  /** The input bits last tick, as pressed (before a swap): presses are the bits that weren't. */
  bits = 0;
  /** How far the plunger is pulled, in ticks (to TUNE.pullTicks). */
  pull = 0;
  score = 0;
  /** Bonus this ball, paid times the multiplier when it drains. */
  bonus = 0;
  mult = 1;
  /** Which ball this is, from 1. */
  ball = 1;
  /** Balls left after this one (balls mode). */
  left = 0;
  /** The game is over for this player. */
  over = 0;
  /** 1 in balls mode: the game ends when the last ball drains. */
  limited = 0;
  /** The top lanes rolled over (bits). */
  lanes = 0;
  /** The skill shot's lane (-1: none), and ticks left to make it once the ball is out. */
  skill = -1;
  skillT = 0;
  /** Drop targets down (bits), and ticks until the bank comes back up (0: it isn't due). */
  drops = 0;
  dropT = 0;
  /** Standup targets hit (bits). */
  targets = 0;
  /** The scoop locks a ball, multiball, its jackpot. */
  lockLit = 0;
  locks = 0;
  multi = 0;
  jackpot = 0;
  /** Balls still to come out for multiball, and ticks until the next one. */
  mbQueue = 0;
  mbT = 0;
  /** Ball save, in ticks left. A new ball's save starts when it leaves the shooter lane. */
  save = 0;
  saveArm = 0;
  /** Power: full, and trouble goes to a rival. */
  power = 0;
  sent = 0;
  combo = 0;
  comboT = 0;
  /** Tilt: nudges lately, the ticks until one comes off, and whether this ball is tilted. */
  danger = 0;
  dangerT = 0;
  tilted = 0;
  /** Ticks until the next ball is on the plunger (0: none due). */
  serveT = 0;
  /** Bumpers 0–2, slingshots 3–4 and standups 5–7: ticks before each can fire again. */
  readonly cool = [0, 0, 0, 0, 0, 0, 0, 0];
  /** Trouble: ticks left of each kind (see TROUBLES), and where the brick is. */
  readonly trouble = [0, 0, 0, 0];
  brickX = 0;
  brickY = 0;
  rng = 0;
  jackpots = 0;
  drains = 0;
  /** What happened on the last tick. Not state. */
  events: Ev[] = [];

  copyFrom(o: Play): this {
    playFromNumbers(playNumbers(o), this);
    return this;
  }
}

// ---------------------------------------------------------------------------------------------
// Starting, and snapshots.

export function startPlay(rules: Rules): Play {
  const p = new Play();
  p.rng = rules.seed >>> 0;
  p.limited = rules.mode === "balls" ? 1 : 0;
  p.left = p.limited ? rules.balls - 1 : 0;
  serve(p);
  return p;
}

/** Every number in a game's state, in a fixed order: for snapshots sent over the wire and hashes. */
export function playNumbers(p: Play): number[] {
  const out = [
    p.tick,
    p.flip[0],
    p.flip[1],
    p.bits,
    p.pull,
    p.score,
    p.bonus,
    p.mult,
    p.ball,
    p.left,
    p.over,
    p.limited,
    p.lanes,
    p.skill,
    p.skillT,
    p.drops,
    p.dropT,
    p.targets,
    p.lockLit,
    p.locks,
    p.multi,
    p.jackpot,
    p.mbQueue,
    p.mbT,
    p.save,
    p.saveArm,
    p.power,
    p.sent,
    p.combo,
    p.comboT,
    p.danger,
    p.dangerT,
    p.tilted,
    p.serveT,
    p.brickX,
    p.brickY,
    p.rng,
    p.jackpots,
    p.drains,
    ...p.cool,
    ...p.trouble,
  ];
  for (const b of p.balls) out.push(b.x, b.y, b.vx, b.vy, b.st, b.t, b.still);
  return out;
}

/** The game a snapshot from `playNumbers` describes, bit for bit (JSON keeps every double exactly). */
export function playFromNumbers(nums: readonly number[], into = new Play()): Play {
  let i = 0;
  const n = () => nums[i++];
  into.tick = n();
  into.flip[0] = n();
  into.flip[1] = n();
  into.bits = n();
  into.pull = n();
  into.score = n();
  into.bonus = n();
  into.mult = n();
  into.ball = n();
  into.left = n();
  into.over = n();
  into.limited = n();
  into.lanes = n();
  into.skill = n();
  into.skillT = n();
  into.drops = n();
  into.dropT = n();
  into.targets = n();
  into.lockLit = n();
  into.locks = n();
  into.multi = n();
  into.jackpot = n();
  into.mbQueue = n();
  into.mbT = n();
  into.save = n();
  into.saveArm = n();
  into.power = n();
  into.sent = n();
  into.combo = n();
  into.comboT = n();
  into.danger = n();
  into.dangerT = n();
  into.tilted = n();
  into.serveT = n();
  into.brickX = n();
  into.brickY = n();
  into.rng = n();
  into.jackpots = n();
  into.drains = n();
  for (let k = 0; k < into.cool.length; k++) into.cool[k] = n();
  for (let k = 0; k < into.trouble.length; k++) into.trouble[k] = n();
  for (const b of into.balls) {
    b.x = n();
    b.y = n();
    b.vx = n();
    b.vy = n();
    b.st = n();
    b.t = n();
    b.still = n();
  }
  into.events = [];
  return into;
}

/** FNV-1a over the bits of every number in the game. */
export function playHash32(p: Play): number {
  const bytes = new Uint8Array(new Float64Array(playNumbers(p)).buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

export function playHash(p: Play): string {
  return playHash32(p).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------
// Small helpers.

/** The next random number from the game's own generator (mulberry32 on `p.rng`), in [0, 1). */
function rand(p: Play): number {
  const a = (p.rng + 0x6d2b79f5) >>> 0;
  p.rng = a;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function ev(p: Play, k: number, i = 0, pts = 0, x = 0, y = 0): void {
  p.events.push({ k, i, pts, x, y });
}

function award(p: Play, pts: number, bonus: number, k: number, i: number, x: number, y: number): void {
  p.score += pts;
  p.bonus += bonus;
  ev(p, k, i, pts, x, y);
}

function addPower(p: Play, n: number): void {
  p.power += n;
  while (p.power >= POWER_MAX) {
    p.power -= POWER_MAX;
    p.sent++;
    ev(p, EV_SEND, p.sent);
  }
}

/** Balls in play: on the table, in the scoop or on the plunger. */
export function ballsInPlay(p: Play): number {
  let n = 0;
  for (const b of p.balls) if (b.st !== B_OFF) n++;
  return n;
}

function freeSlot(p: Play): Ball | null {
  for (const b of p.balls) if (b.st === B_OFF) return b;
  return null;
}

/** Whether a ball is in the shooter lane. */
function laneBusy(p: Play): boolean {
  for (const b of p.balls) if (b.st === B_PLUNGER || (b.st === B_FREE && b.x > 486 && b.y > 330)) return true;
  return false;
}

/** A ball onto the plunger. `auto`: it launches itself in a moment (a saved ball, multiball). */
function onPlunger(p: Play, auto: boolean): boolean {
  const b = freeSlot(p);
  if (!b || laneBusy(p)) return false;
  b.st = B_PLUNGER;
  b.x = TABLE_PLUNGER_X;
  b.y = TABLE_PLUNGER_Y;
  b.vx = b.vy = 0;
  b.t = auto ? AUTO_TICKS - SAVED_LAUNCH : 0;
  b.still = 0;
  return true;
}

// The plunger's place, the same on every table (the rest of the table comes in with each step).
const TABLE_PLUNGER_X = 503;
const TABLE_PLUNGER_Y = 966 - BALL_R - 0.5;

/** A new ball: on the plunger, with a skill shot lit and ball save armed. */
function serve(p: Play): void {
  onPlunger(p, false);
  p.skill = Math.floor(rand(p) * 3);
  p.skillT = 0;
  p.saveArm = 1;
  p.serveT = 0;
  ev(p, EV_SERVE, p.ball);
}

function launch(p: Play, b: Ball, pull: number): void {
  const k = pull / TUNE.pullTicks;
  b.st = B_FREE;
  b.vx = 0;
  b.vy = -(TUNE.plungeMin + (TUNE.plungeMax - TUNE.plungeMin) * k);
  b.t = 0;
  ev(p, EV_LAUNCH, 0, 0, b.x, b.y);
}

// ---------------------------------------------------------------------------------------------
// Trouble.

/** Trouble from a rival lands on this game: `kind` from TROUBLES, `param` where a brick goes. */
export function applyTrouble(p: Play, kind: number, param: number, table: Table): void {
  if (p.over || kind < 0 || kind >= TROUBLES.length) return;
  p.trouble[kind] = TROUBLE_TICKS[kind];
  if (kind === T_BRICK) {
    const spot = table.brickSpots[((param % table.brickSpots.length) + table.brickSpots.length) % table.brickSpots.length];
    p.brickX = spot.x;
    p.brickY = spot.y;
  }
}

// ---------------------------------------------------------------------------------------------
// One tick.

/**
 * One tick of a game with the input bits held (IN_LEFT, IN_RIGHT, IN_PLUNGE, IN_NUDGE). Events
 * for the tick are in `p.events` afterwards.
 */
export function stepPlay(p: Play, input: number, table: Table, rules: Rules): void {
  p.events.length = 0;
  if (p.over) {
    p.tick++;
    return;
  }
  const raw = input & 15;
  let held = raw;
  let pressed = raw & ~p.bits;
  p.bits = raw;
  if (p.trouble[T_SWAP] > 0) {
    held = swapFlippers(held);
    pressed = swapFlippers(pressed);
  }
  if (p.tilted) {
    held &= ~(IN_LEFT | IN_RIGHT);
    pressed &= ~(IN_LEFT | IN_RIGHT | IN_NUDGE);
  }

  // A flipper press moves the lit top lanes along (lane change).
  if (pressed & IN_LEFT) {
    p.lanes = ((p.lanes << 2) | (p.lanes >> 1)) & 7;
    ev(p, EV_FLIP, 0);
  }
  if (pressed & IN_RIGHT) {
    p.lanes = ((p.lanes << 1) | (p.lanes >> 2)) & 7;
    ev(p, EV_FLIP, 1);
  }
  if (pressed & IN_NUDGE) nudge(p);
  plunger(p, held);

  for (let s = 0; s < SUBSTEPS; s++) substep(p, held, table);
  timers(p, table);

  p.tick++;
  if (p.tick >= rules.endTick && !p.over) finish(p);
}

function swapFlippers(bits: number): number {
  return (bits & ~3) | ((bits & 1) << 1) | ((bits >> 1) & 1);
}

function nudge(p: Play): void {
  let any = false;
  for (const b of p.balls) {
    if (b.st !== B_FREE) continue;
    b.vx += b.x < MID_X ? TUNE.nudgeX : -TUNE.nudgeX;
    b.vy -= TUNE.nudgeY;
    any = true;
  }
  if (!any) return;
  p.danger++;
  p.dangerT = DANGER_TICKS;
  ev(p, EV_NUDGE);
  if (p.danger >= TILT_AT) {
    p.tilted = 1;
    p.bonus = 0;
    ev(p, EV_TILT);
  } else if (p.danger === TILT_AT - 1) ev(p, EV_WARN);
}

function plunger(p: Play, held: number): void {
  let ball: Ball | null = null;
  for (const b of p.balls) if (b.st === B_PLUNGER) ball = b;
  if (held & IN_PLUNGE) {
    if (p.pull < TUNE.pullTicks) p.pull++;
    if (ball) ball.t = 0;
    return;
  }
  if (p.pull > 0) {
    if (ball) launch(p, ball, p.pull);
    p.pull = 0;
    return;
  }
  // Left on the plunger too long (or saved): it goes by itself.
  if (ball && ++ball.t >= AUTO_TICKS) launch(p, ball, Math.round(TUNE.pullTicks * 0.72));
}

const H = DT / SUBSTEPS;

function substep(p: Play, held: number, table: Table): void {
  // The flippers swing first, so the ball meets them where they are now.
  const fw0 = moveFlipper(p, 0, held & IN_LEFT);
  const fw1 = moveFlipper(p, 1, held & IN_RIGHT);
  const g = TUNE.gravity * H;
  for (const b of p.balls) {
    if (b.st !== B_FREE) continue;
    const x0 = b.x;
    const y0 = b.y;
    b.vy += g;
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 > TUNE.maxSpeed * TUNE.maxSpeed) {
      const k = TUNE.maxSpeed / Math.sqrt(v2);
      b.vx *= k;
      b.vy *= k;
    }
    b.x += b.vx * H;
    b.y += b.vy * H;
    collideTable(p, b, table);
    if (b.y > 800) {
      collideFlipper(p, b, table, 0, fw0);
      collideFlipper(p, b, table, 1, fw1);
    }
    if (p.trouble[T_BRICK] > 0) collideBrick(p, b);
    sensors(p, b, x0, y0, table);
    scoop(p, b, table);
    if (b.y > table.drainY) drain(p, b);
  }
  // Balls knock each other about (multiball).
  for (let i = 0; i < MAX_BALLS; i++) {
    const a = p.balls[i];
    if (a.st !== B_FREE) continue;
    for (let j = i + 1; j < MAX_BALLS; j++) {
      const c = p.balls[j];
      if (c.st === B_FREE) collideBalls(a, c);
    }
  }
}

/** Moves flipper `f` a substep towards up (pressed) or rest; returns its angular speed. */
function moveFlipper(p: Play, f: number, up: number): number {
  const a = p.flip[f];
  let next = a;
  if (up && a > FLIP_UP) next = Math.max(FLIP_UP, a - TUNE.flipUp * H);
  else if (!up && a < FLIP_REST) next = Math.min(FLIP_REST, a + TUNE.flipDown * H);
  p.flip[f] = next;
  return (next - a) / H;
}

/**
 * The ball against something at (cx, cy) of radius `rr` moving at (svx, svy): pushes it out and
 * bounces it. Returns how fast it hit (0: it didn't).
 */
function contact(b: Ball, cx: number, cy: number, rr: number, svx: number, svy: number, e: number): number {
  const dx = b.x - cx;
  const dy = b.y - cy;
  const r = BALL_R + rr;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return 0;
  const d = Math.sqrt(d2);
  const nx = d > 1e-9 ? dx / d : 0;
  const ny = d > 1e-9 ? dy / d : -1;
  b.x = cx + nx * r;
  b.y = cy + ny * r;
  const vn = (b.vx - svx) * nx + (b.vy - svy) * ny;
  if (vn >= 0) return 0;
  const k = vn > -TUNE.restSpeed ? 1 : 1 + e;
  b.vx -= k * vn * nx;
  b.vy -= k * vn * ny;
  return -vn;
}

/** Adds speed straight out from a kicker, so the ball leaves at least `kick` fast. */
function kick(b: Ball, cx: number, cy: number, kick: number): void {
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  const out = b.vx * nx + b.vy * ny;
  if (out < kick) {
    b.vx += (kick - out) * nx;
    b.vy += (kick - out) * ny;
  }
}

function collideTable(p: Play, b: Ball, table: Table): void {
  const grid = table.grid;
  const col = Math.floor(b.x / grid.cell);
  const row = Math.floor(b.y / grid.cell);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return;
  const cell = row * grid.cols + col;
  const segs = grid.segs[cell];
  for (let i = 0; i < segs.length; i++) {
    const s = table.segs[segs[i]];
    if (s.kind === DROP && p.drops & (1 << s.id)) continue;
    if (s.kind === GATE) {
      gate(b, s);
      continue;
    }
    let t = (b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy;
    t = t < 0 ? 0 : t > s.len ? s.len : t;
    const cx = s.ax + s.dx * t;
    const cy = s.ay + s.dy * t;
    const hit = contact(b, cx, cy, 0, 0, 0, s.e);
    if (hit > 0) hitSeg(p, b, s.kind, s.id, hit, cx, cy);
  }
  const circles = grid.circles[cell];
  for (let i = 0; i < circles.length; i++) {
    const c = table.circles[circles[i]];
    const hit = contact(b, c.x, c.y, c.r, 0, 0, c.e);
    if (hit > 0 && c.kind === BUMPER) bumper(p, b, c.id, c.x, c.y);
  }
}

/** A one-way gate: it only stops a ball on its normal's side. */
function gate(b: Ball, s: Table["segs"][number]): void {
  const t = (b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy;
  if (t < 0 || t > s.len) return;
  const d = (b.x - s.ax) * s.nx + (b.y - s.ay) * s.ny;
  if (d < 0 || d >= BALL_R) return;
  // A ball on its way through, out of the gate's way.
  const vn = b.vx * s.nx + b.vy * s.ny;
  if (vn > 0) return;
  b.x += s.nx * (BALL_R - d);
  b.y += s.ny * (BALL_R - d);
  const k = vn > -TUNE.restSpeed ? 1 : 1 + s.e;
  b.vx -= k * vn * s.nx;
  b.vy -= k * vn * s.ny;
}

function hitSeg(p: Play, b: Ball, kind: number, id: number, hit: number, cx: number, cy: number): void {
  if (kind === SLING) {
    if (hit < TUNE.slingMin || p.cool[3 + id] > 0 || p.tilted) return;
    p.cool[3 + id] = 10;
    kick(b, cx, cy, TUNE.slingKick);
    award(p, 10, 0, EV_SLING, id, b.x, b.y);
  } else if (kind === DROP) {
    p.drops |= 1 << id;
    award(p, 500, 500, EV_DROP, id, cx, cy);
    if (p.drops === 7) {
      p.dropT = DROP_RESET;
      award(p, 5000, 2000, EV_BANK, 0, cx, cy);
      if (!p.multi) p.lockLit = 1;
      addPower(p, 3);
    }
  } else if (kind === TARGET) {
    if (hit < TUNE.targetMin || p.cool[5 + id] > 0) return;
    p.cool[5 + id] = 20;
    p.targets |= 1 << id;
    award(p, 250, 250, EV_TARGET, id, cx, cy);
    if (p.targets === 7) {
      p.targets = 0;
      award(p, 3000, 1000, EV_TARGETS, 0, cx, cy);
      addPower(p, 3);
    }
  } else if (hit > 300) ev(p, EV_HIT, 0, 0, cx, cy);
}

function bumper(p: Play, b: Ball, id: number, x: number, y: number): void {
  if (p.cool[id] > 0 || p.tilted) return;
  p.cool[id] = 8;
  kick(b, x, y, TUNE.bumperKick);
  award(p, 100, 10, EV_BUMPER, id, x, y);
}

function collideFlipper(p: Play, b: Ball, table: Table, f: number, w: number): void {
  const spec = table.flippers[f];
  const len = spec.len * (p.trouble[T_SHRINK] > 0 ? SHRINK : 1);
  const a = p.flip[f];
  const dx = dcos(a) * spec.side;
  const dy = dsin(a);
  let t = (b.x - spec.px) * dx + (b.y - spec.py) * dy;
  t = t < 0 ? 0 : t > len ? len : t;
  const cx = spec.px + dx * t;
  const cy = spec.py + dy * t;
  const rr = spec.r0 + ((spec.r1 - spec.r0) * t) / len;
  // The surface moves with the flipper: its angular speed on the table is w turned the flipper's way.
  const om = w * spec.side;
  const ox = b.x - spec.px;
  const oy = b.y - spec.py;
  const hit = contact(b, cx, cy, rr, -om * oy, om * ox, TUNE.flipE);
  if (hit > 0) b.still = 0;
}

function collideBrick(p: Play, b: Ball): void {
  const x0 = p.brickX - BRICK_HW;
  const x1 = p.brickX + BRICK_HW;
  const y0 = p.brickY - BRICK_HH;
  const y1 = p.brickY + BRICK_HH;
  const cx = b.x < x0 ? x0 : b.x > x1 ? x1 : b.x;
  const cy = b.y < y0 ? y0 : b.y > y1 ? y1 : b.y;
  if (cx === b.x && cy === b.y) {
    // Inside it (it landed on the ball): out the nearest side.
    const l = b.x - x0;
    const r = x1 - b.x;
    const u = b.y - y0;
    const d = y1 - b.y;
    const m = Math.min(l, r, u, d);
    if (m === u) b.y = y0 - BALL_R;
    else if (m === d) b.y = y1 + BALL_R;
    else if (m === l) b.x = x0 - BALL_R;
    else b.x = x1 + BALL_R;
    return;
  }
  const hit = contact(b, cx, cy, 0, 0, 0, 0.5);
  if (hit > 300) ev(p, EV_HIT, 1, 0, cx, cy);
}

function collideBalls(a: Ball, c: Ball): void {
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const d2 = dx * dx + dy * dy;
  const r = BALL_R * 2;
  if (d2 >= r * r || d2 < 1e-12) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const push = (r - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  c.x += nx * push;
  c.y += ny * push;
  const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
  if (vn >= 0) return;
  const j = (-(1 + 0.9) * vn) / 2;
  a.vx -= j * nx;
  a.vy -= j * ny;
  c.vx += j * nx;
  c.vy += j * ny;
}

function sensors(p: Play, b: Ball, x0: number, y0: number, table: Table): void {
  for (const s of table.sensors) {
    const d0 = (x0 - s.ax) * s.nx + (y0 - s.ay) * s.ny;
    const d1 = (b.x - s.ax) * s.nx + (b.y - s.ay) * s.ny;
    if (d0 < 0 === d1 < 0) continue;
    const f = d0 / (d0 - d1);
    const cx = x0 + (b.x - x0) * f;
    const cy = y0 + (b.y - y0) * f;
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const u = ((cx - s.ax) * ex + (cy - s.ay) * ey) / (ex * ex + ey * ey);
    if (u < 0 || u > 1) continue;
    sensor(p, b, s.id, d1 > d0, cx, cy);
  }
}

function sensor(p: Play, b: Ball, id: number, forward: boolean, x: number, y: number): void {
  if (id <= S_LANE + 2) {
    if (!forward) return;
    const lane = id - S_LANE;
    if (p.skillT > 0) {
      const made = lane === p.skill;
      p.skillT = 0;
      p.skill = -1;
      if (made) {
        award(p, 10000, 2000, EV_SKILL, lane, x, y);
        addPower(p, 2);
      }
    }
    const bit = 1 << lane;
    if (p.lanes & bit) award(p, 100, 0, EV_LANE, lane, x, y);
    else {
      p.lanes |= bit;
      award(p, 500, 500, EV_LANE, lane, x, y);
      if (p.lanes === 7) {
        p.lanes = 0;
        p.mult = Math.min(5, p.mult + 1);
        award(p, 2000, 0, EV_LANES, p.mult, x, y);
        addPower(p, 2);
      }
    }
  } else if (id === S_INLANE_L || id === S_INLANE_R) {
    if (forward) award(p, 100, 100, EV_INLANE, id - S_INLANE_L, x, y);
  } else if (id === S_OUTLANE_L || id === S_OUTLANE_R) {
    if (forward) award(p, 1000, 0, EV_OUTLANE, id - S_OUTLANE_L, x, y);
  } else if (id === S_ORBIT) {
    if (!forward) return;
    p.combo = p.comboT > 0 ? p.combo + 1 : 1;
    p.comboT = COMBO_TICKS;
    award(p, 1000 * p.combo, 1000, EV_ORBIT, p.combo, x, y);
    addPower(p, p.combo >= 2 ? 2 : 1);
    if (p.multi && !p.jackpot) p.jackpot = 1;
  } else if (id === S_SHOOTER) {
    if (!forward || !p.saveArm) return;
    p.saveArm = 0;
    p.save = Math.max(p.save, SAVE_TICKS);
    if (p.skill >= 0) p.skillT = SKILL_TICKS;
  }
}

function scoop(p: Play, b: Ball, table: Table): void {
  const sc = table.scoop;
  const dx = b.x - sc.x;
  const dy = b.y - sc.y;
  if (dx * dx + dy * dy > sc.r * sc.r) return;
  // Not a ball on its way out.
  if (b.vx * sc.vx + b.vy * sc.vy > 0) return;
  for (const o of p.balls) if (o.st === B_SCOOP) return;
  b.st = B_SCOOP;
  b.x = sc.x;
  b.y = sc.y;
  b.vx = b.vy = 0;
  b.t = 0;
  if (p.multi && p.jackpot) {
    p.jackpot = 0;
    p.jackpots++;
    award(p, 25000, 5000, EV_JACKPOT, p.jackpots, sc.x, sc.y);
    addPower(p, 3);
  } else if (p.lockLit) {
    p.lockLit = 0;
    p.locks++;
    if (p.locks >= 2) {
      p.locks = 0;
      p.multi = 1;
      p.jackpot = 1;
      p.mbQueue = 2;
      p.mbT = MULTIBALL_EVERY;
      p.save = Math.max(p.save, MULTIBALL_SAVE);
      award(p, 10000, 2000, EV_MULTIBALL, 0, sc.x, sc.y);
      addPower(p, 2);
    } else award(p, 5000, 1000, EV_LOCK, p.locks, sc.x, sc.y);
  } else award(p, 1500, 500, EV_SCOOP, 0, sc.x, sc.y);
}

function drain(p: Play, b: Ball): void {
  b.st = B_OFF;
  b.vx = b.vy = 0;
  if (p.save > 0 && !p.tilted) {
    // Ball save: it's back on the plunger, and goes again by itself.
    if (!onPlunger(p, true)) p.mbQueue++;
    ev(p, EV_SAVED, 0, 0, b.x, b.y);
    return;
  }
  const left = ballsInPlay(p) + p.mbQueue;
  if (left > 0) {
    if (left === 1 && p.multi) {
      p.multi = 0;
      p.jackpot = 0;
    }
    ev(p, EV_LOST, 0, 0, b.x, b.y);
    return;
  }
  p.drains++;
  p.multi = 0;
  p.jackpot = 0;
  ev(p, EV_DRAIN, p.ball, 0, b.x, b.y);
  endOfBall(p);
}

/** The ball is over: its bonus times the multiplier (none if it tilted), then the next ball or the end. */
function endOfBall(p: Play): void {
  if (!p.tilted && p.bonus > 0) {
    const pts = p.bonus * p.mult;
    p.score += pts;
    ev(p, EV_BONUS, p.mult, pts);
  }
  p.bonus = 0;
  p.mult = 1;
  p.tilted = 0;
  p.danger = 0;
  p.dangerT = 0;
  p.save = 0;
  p.saveArm = 0;
  p.skillT = 0;
  p.skill = -1;
  p.combo = 0;
  p.comboT = 0;
  if (p.limited && p.left <= 0) {
    p.over = 1;
    ev(p, EV_OVER);
    return;
  }
  if (p.limited) p.left--;
  p.ball++;
  p.serveT = SERVE_TICKS;
}

function timers(p: Play, table: Table): void {
  for (let i = 0; i < p.cool.length; i++) if (p.cool[i] > 0) p.cool[i]--;
  for (let i = 0; i < p.trouble.length; i++) if (p.trouble[i] > 0) p.trouble[i]--;
  if (p.save > 0) p.save--;
  if (p.skillT > 0 && --p.skillT === 0) p.skill = -1;
  if (p.comboT > 0 && --p.comboT === 0) p.combo = 0;
  if (p.dangerT > 0 && --p.dangerT === 0 && p.danger > 0 && --p.danger > 0) p.dangerT = DANGER_TICKS;
  // The drop targets come back up, once no ball is in their way.
  if (p.dropT > 0 && --p.dropT === 0) {
    if (dropsBlocked(p, table)) p.dropT = 10;
    else p.drops = 0;
  }
  for (const b of p.balls) {
    if (b.st === B_SCOOP && ++b.t >= SCOOP_HOLD) {
      b.st = B_FREE;
      b.vx = table.scoop.vx;
      b.vy = table.scoop.vy;
      b.t = 0;
      b.still = 0;
      ev(p, EV_EJECT, 0, 0, b.x, b.y);
    }
    if (b.st !== B_FREE) continue;
    // A ball that rolled back down the shooter lane waits on the plunger again.
    if (b.x > 486 && b.y >= TABLE_PLUNGER_Y - 1 && b.vy > -60 && b.vy < 60) {
      b.st = B_PLUNGER;
      b.x = TABLE_PLUNGER_X;
      b.y = TABLE_PLUNGER_Y;
      b.vx = b.vy = 0;
      b.t = 0;
      continue;
    }
    // Stuck somewhere: a kick to free it (a ball held on a flipper is the player's own doing).
    b.still = b.vx * b.vx + b.vy * b.vy < 25 * 25 ? b.still + 1 : 0;
    if (b.still >= STUCK_TICKS && !(b.y > 840 && b.x > 110 && b.x < MID_X * 2 - 110)) {
      b.vy = -650;
      b.vx = rand(p) < 0.5 ? -260 : 260;
      b.still = 0;
      ev(p, EV_KICK, 0, 0, b.x, b.y);
    }
  }
  // Multiball (and a saved ball with the shooter lane busy): the next ball onto the plunger,
  // where it launches itself.
  if (p.mbQueue > 0 && --p.mbT <= 0) {
    if (onPlunger(p, true)) p.mbQueue--;
    p.mbT = MULTIBALL_EVERY;
  }
  if (p.serveT > 0 && --p.serveT === 0) serve(p);
}

/** Whether a ball is where the drop targets would come up. */
function dropsBlocked(p: Play, table: Table): boolean {
  for (const s of table.segs) {
    if (s.kind !== DROP) continue;
    for (const b of p.balls) {
      if (b.st === B_OFF) continue;
      let t = (b.x - s.ax) * s.dx + (b.y - s.ay) * s.dy;
      t = t < 0 ? 0 : t > s.len ? s.len : t;
      const dx = b.x - (s.ax + s.dx * t);
      const dy = b.y - (s.ay + s.dy * t);
      if (dx * dx + dy * dy < (BALL_R + 2) * (BALL_R + 2)) return true;
    }
  }
  return false;
}

/** Time's up: the balls in play pay their bonus, and the game is over. */
function finish(p: Play): void {
  if (ballsInPlay(p) > 0 && !p.tilted && p.bonus > 0) {
    const pts = p.bonus * p.mult;
    p.score += pts;
    ev(p, EV_BONUS, p.mult, pts);
  }
  p.bonus = 0;
  p.over = 1;
  ev(p, EV_OVER);
}
