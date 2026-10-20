import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { BALLS_CAP_MIN, TICK_HZ } from "./constants";
import { B_OFF, B_PLUNGER, T_BRICK, T_FOG, T_SHRINK, T_SWAP, TUNE, type Mode, type Play, type Rules } from "./sim";

export type { CpuLevel, LogEntry } from "@warrick/kit/shared/protocol";

/**
 * lobby → countdown → playing → results → (countdown → playing → results)… A match that stopped
 * (everyone went) or was lost (the room restarted) goes back to a countdown.
 */
export type Phase = "lobby" | "countdown" | "playing" | "results";

/** Who trouble goes to: a random rival, whoever's winning (or second, if that's you), or nobody. */
export type Aim = "random" | "leader" | "off";

export interface Settings {
  mode: Mode;
  /** Timed: how long, in minutes. */
  minutes: number;
  /** Balls: how many each. */
  balls: number;
  trouble: Aim;
}

export const DEFAULT_SETTINGS: Settings = { mode: "timed", minutes: 3, balls: 3, trouble: "random" };

export const SETTING_CHOICES = {
  mode: ["timed", "balls"] as Mode[],
  minutes: [2, 3, 5],
  balls: [3, 5],
  trouble: ["random", "leader", "off"] as Aim[],
};

/** The rules a match is played to, from the settings and its seed. */
export function rulesFor(settings: Settings, seed: number): Rules {
  const minutes = settings.mode === "timed" ? settings.minutes : BALLS_CAP_MIN;
  return { mode: settings.mode, endTick: minutes * 60 * TICK_HZ, balls: settings.balls, seed };
}

export interface PlayerState extends BasePlayer {
  /** Matches won in this room. */
  wins: number;
}

/** One player's line in a match's results. */
export interface ResultRow {
  id: string;
  score: number;
  /** 1 is first; equal scores share a place. */
  place: number;
  /** Trouble they sent. */
  sent: number;
  jackpots: number;
  drains: number;
}

export interface MatchResult {
  /** Best first. */
  rows: ResultRow[];
  mode: Mode;
  /** One player on their own: nobody wins, it's the score that counts. */
  solo: boolean;
}

export interface Timer {
  at: number;
  kind: "countdown";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /** Counts every start of a match (restarts too), so stale inputs can be told apart. */
  run: number;
  /** Matches started in this room. */
  match: number;
  /** When the balls go in (tick 0 of the match clock), on the server's clock. */
  startAt: number | null;
  /** Who's playing this match, in the order frames list them. */
  seats: string[];
  results: MatchResult | null;
  phaseDeadline: number | null;
  timer: Timer | null;
}

// ---------------------------------------------------------------------------------------------
// Trouble.

/** Trouble on its way: `kind` lands on `to`'s table at tick `at` (the match clock). */
export interface Trouble {
  id: number;
  from: string;
  to: string;
  kind: number;
  at: number;
  /** Where a brick lands (an index into the table's spots). */
  param: number;
}

export const TROUBLE_NAMES = ["Brick", "Shrink", "Fog", "Swap"];
export const TROUBLE_HELP = [
  "a block drops onto your table",
  "your flippers shrink",
  "the top of your table goes dark",
  "your flipper buttons swap",
];

// ---------------------------------------------------------------------------------------------
// Messages.

/** An input change: the tick it starts at, and the bits held from then (see IN_LEFT…). */
export type InputEvent = [tick: number, bits: number];

/**
 * A player's inputs, every SEND_MS. `ev` restates the input in effect at its first tick, then
 * every change after it; the room replaces whatever it had queued from that tick on. `upTo` is
 * the tick the player's own screen has played up to.
 */
export interface PlayMsg {
  t: "play";
  run: number;
  ev: InputEvent[];
  upTo: number;
}

export type ClientMsg =
  | LobbyMsg
  | PlayMsg
  /** My table doesn't match the room's (a hash in a frame): send me where it is. */
  | { t: "resync"; run: number };

/**
 * The match being played and every table as the room has it: a game snapshot and the input in
 * effect, in `seats` order, and the trouble sent so far. It carries its own rules and seats: it
 * can arrive just before the state that goes with it.
 */
export interface MatchSnapshot {
  run: number;
  rules: Rules;
  seats: string[];
  plays: number[][];
  inputs: number[];
  troubles: Trouble[];
}

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; match: MatchSnapshot | null; log: LogEntry[]; now: number }
  /** A match is starting (or going on after a pause): every table as it is. */
  | { t: "match"; match: MatchSnapshot }
  /** Every table, every FRAME_MS. `k` is the match clock's tick. */
  | { t: "frame"; run: number; k: number; r: TableFrame[] }
  /** Your table as the room has it: take it, and play on from there. */
  | { t: "sync"; run: number; play: number[]; bits: number }
  /** Trouble is on its way to someone. */
  | { t: "trouble"; run: number; tr: Trouble };

// ---------------------------------------------------------------------------------------------
// Frames: a table as other players' screens draw it, small enough to send twenty times a second.

/**
 * One table in a frame: id, its tick, flags, score, ball number, balls left, multiplier, power,
 * lights, three balls (x, y in table units, -1 when not in play), the flippers (milliradians),
 * the plunger's pull (0–100), the brick (x, y), and the latest hash of the game and its tick.
 */
export type TableFrame = [
  id: string,
  tick: number,
  flags: number,
  score: number,
  ball: number,
  left: number,
  mult: number,
  power: number,
  lights: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fl: number,
  fr: number,
  pull: number,
  brickX: number,
  brickY: number,
  hashTick: number,
  hash: number,
];

export const F_OVER = 1;
/** The room is playing their table for them (they've gone, or their page stalled). */
export const F_AWAY = 2;
export const F_TILT = 4;
export const F_SHRINK = 8;
export const F_FOG = 16;
export const F_SWAP = 32;
export const F_BRICK = 64;
export const F_MULTI = 128;
export const F_SAVE = 256;
/** A ball waits on the plunger. */
export const F_PLUNGER = 512;

/** What a table shows: enough to draw it, from your own game or from a rival's frame. */
export interface View {
  /** Balls in play (x, y), up to three. */
  balls: { x: number; y: number }[];
  flip: [number, number];
  /** Plunger pull, 0 to 1. */
  pull: number;
  lanes: number;
  drops: number;
  targets: number;
  lockLit: number;
  locks: number;
  jackpot: number;
  /** The skill shot's lane, or -1. */
  skill: number;
  flags: number;
  brickX: number;
  brickY: number;
  score: number;
  ball: number;
  left: number;
  mult: number;
  power: number;
}

export function emptyView(): View {
  return {
    balls: [],
    flip: [0, 0],
    pull: 0,
    lanes: 0,
    drops: 0,
    targets: 0,
    lockLit: 0,
    locks: 0,
    jackpot: 0,
    skill: -1,
    flags: 0,
    brickX: 0,
    brickY: 0,
    score: 0,
    ball: 1,
    left: 0,
    mult: 1,
    power: 0,
  };
}

/** A game's flags, as frames carry them. */
export function playFlags(p: Play): number {
  let f = 0;
  if (p.over) f |= F_OVER;
  if (p.tilted) f |= F_TILT;
  if (p.trouble[T_SHRINK] > 0) f |= F_SHRINK;
  if (p.trouble[T_FOG] > 0) f |= F_FOG;
  if (p.trouble[T_SWAP] > 0) f |= F_SWAP;
  if (p.trouble[T_BRICK] > 0) f |= F_BRICK;
  if (p.multi) f |= F_MULTI;
  if (p.save > 0) f |= F_SAVE;
  for (const b of p.balls) if (b.st === B_PLUNGER) f |= F_PLUNGER;
  return f;
}

function lights(p: Play): number {
  return (
    p.lanes |
    (p.drops << 3) |
    (p.targets << 6) |
    (p.lockLit << 9) |
    (Math.min(3, p.locks) << 10) |
    (p.jackpot << 12) |
    ((p.skill + 1) << 13)
  );
}

export function encodeTable(id: string, p: Play, flags: number, hashTick: number, hash: number): TableFrame {
  const xy = (i: number): [number, number] => {
    const b = p.balls[i];
    return b.st === B_OFF ? [-1, -1] : [Math.round(b.x), Math.round(b.y)];
  };
  const [x0, y0] = xy(0);
  const [x1, y1] = xy(1);
  const [x2, y2] = xy(2);
  return [
    id,
    p.tick,
    flags | playFlags(p),
    p.score,
    p.ball,
    p.left,
    p.mult,
    p.power,
    lights(p),
    x0,
    y0,
    x1,
    y1,
    x2,
    y2,
    Math.round(p.flip[0] * 1000),
    Math.round(p.flip[1] * 1000),
    Math.round((p.pull * 100) / TUNE.pullTicks),
    Math.round(p.brickX),
    Math.round(p.brickY),
    hashTick,
    hash,
  ];
}

/** A frame's table as a view (balls where the frame has them). */
export function decodeTable(f: TableFrame, into = emptyView()): View {
  into.balls.length = 0;
  if (f[9] >= 0) into.balls.push({ x: f[9], y: f[10] });
  if (f[11] >= 0) into.balls.push({ x: f[11], y: f[12] });
  if (f[13] >= 0) into.balls.push({ x: f[13], y: f[14] });
  into.flip[0] = f[15] / 1000;
  into.flip[1] = f[16] / 1000;
  into.pull = f[17] / 100;
  const l = f[8];
  into.lanes = l & 7;
  into.drops = (l >> 3) & 7;
  into.targets = (l >> 6) & 7;
  into.lockLit = (l >> 9) & 1;
  into.locks = (l >> 10) & 3;
  into.jackpot = (l >> 12) & 1;
  into.skill = ((l >> 13) & 3) - 1;
  into.flags = f[2];
  into.brickX = f[18];
  into.brickY = f[19];
  into.score = f[3];
  into.ball = f[4];
  into.left = f[5];
  into.mult = f[6];
  into.power = f[7];
  return into;
}

/** Your own game as a view. */
export function viewOf(p: Play, into = emptyView()): View {
  into.balls.length = 0;
  for (const b of p.balls) if (b.st !== B_OFF) into.balls.push({ x: b.x, y: b.y });
  into.flip[0] = p.flip[0];
  into.flip[1] = p.flip[1];
  into.pull = p.pull / TUNE.pullTicks;
  into.lanes = p.lanes;
  into.drops = p.drops;
  into.targets = p.targets;
  into.lockLit = p.lockLit;
  into.locks = p.locks;
  into.jackpot = p.jackpot;
  into.skill = p.skill;
  into.flags = playFlags(p);
  into.brickX = p.brickX;
  into.brickY = p.brickY;
  into.score = p.score;
  into.ball = p.ball;
  into.left = p.left;
  into.mult = p.mult;
  into.power = p.power;
  return into;
}

/** Final standings: most wins. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.wins - a.wins;
}

/** 12,345 */
export function formatScore(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
