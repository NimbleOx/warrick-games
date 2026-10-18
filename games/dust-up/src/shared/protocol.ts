import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { Bike } from "./bike";
import { COURSE_LENGTHS, DIFFICULTIES, type CourseLength, type CourseSpec, type Difficulty } from "./course";
import { POINTS, TICK_HZ } from "./constants";
import type { InputEvent, Ride } from "./ride";

export type { CpuLevel, LogEntry } from "@warrick/kit/shared/protocol";

/**
 * lobby → countdown → riding → results → (countdown → riding → results)… → gameover. A course
 * that stopped (everyone went) or was lost (the room restarted) goes back to a countdown.
 */
export type Phase = "lobby" | "countdown" | "riding" | "results" | "gameover";

export interface Settings {
  /** How many courses in a series. */
  courses: number;
  length: CourseLength;
  difficulty: Difficulty;
  /** Seconds after the first rider finishes before the course ends. */
  window: number;
}

export const DEFAULT_SETTINGS: Settings = { courses: 5, length: "short", difficulty: "normal", window: 30 };

export const SETTING_CHOICES = {
  courses: [1, 3, 5, 7],
  length: [...COURSE_LENGTHS],
  difficulty: [...DIFFICULTIES],
  window: [15, 30, 60],
};

export interface PlayerState extends BasePlayer {
  /** Points this series. */
  points: number;
  /** Courses won this series. */
  wins: number;
}

/** One rider's result on a course. */
export interface CourseResult {
  id: string;
  /** Their time in ticks, or null for a DNF. */
  ticks: number | null;
  /** 1 is first; riders who tie share a place. DNFs come after, by how far they got. */
  place: number;
  points: number;
  /** How far along the course they got, 0 to 1 (1 if they finished). */
  progress: number;
}

export interface Timer {
  at: number;
  kind: "countdown" | "results";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /** The course being ridden (or just ridden), from 1; 0 before the first. */
  course: number;
  /** The series' seed: each course's comes from it (see `courseSpec`). */
  seed: number;
  /** Counts every start of a course (restarts and rides again too), so stale inputs can be told apart. */
  run: number;
  /** When the gate drops (tick 0 of the course clock), on the server's clock. */
  startAt: number | null;
  /** Who's riding the course, in the order frames list them. */
  riders: string[];
  /** Riders who have finished the course: their time in ticks. */
  finishes: Record<string, number>;
  /** The tick the course ends at: the first finish plus the window, or the hard cap. */
  endTick: number | null;
  /** The last course's results, best first. */
  results: CourseResult[] | null;
  /** The course was ridden by one player alone: they can ride it again, and go on when they like. */
  solo: boolean;
  phaseDeadline: number | null;
  timer: Timer | null;
}

/** The course a state is on: the same spec, and so the same course, on every device. */
export function courseSpec(s: Pick<GameState, "seed" | "course" | "settings">): CourseSpec {
  return {
    seed: (s.seed + Math.imul(s.course, 0x9e3779b1)) >>> 0,
    length: s.settings.length,
    difficulty: s.settings.difficulty,
  };
}

export function pointsFor(place: number): number {
  return POINTS[place - 1] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Messages.

/**
 * A rider's inputs, every SEND_MS. `ev` restates the input in effect at its first tick, then
 * every change after it; the room replaces whatever it had queued from that tick on. `upTo` is
 * the tick the rider's own screen has ridden up to.
 */
export interface RideMsg {
  t: "ride";
  run: number;
  ev: InputEvent[];
  upTo: number;
}

export type ClientMsg =
  | LobbyMsg
  | RideMsg
  /** My bike doesn't match the room's (a hash in a frame): send me where it is. */
  | { t: "resync"; run: number }
  /** Solo, after a course: ride it again, or go on to the next. */
  | { t: "again" }
  | { t: "next" };

/**
 * The course being ridden and every bike on it as the room has it: a ride snapshot and the input
 * in effect, in `riders` order. It carries its own course and riders: it can arrive just before
 * the state that goes with it.
 */
export interface RaceSnapshot {
  run: number;
  spec: CourseSpec;
  riders: string[];
  rides: number[][];
  inputs: [bits: number, lean: number][];
}

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; race: RaceSnapshot | null; log: LogEntry[]; now: number }
  /** A course is starting (or going on after a pause): every bike as it is. */
  | { t: "race"; race: RaceSnapshot }
  /** Where every bike is, every FRAME_MS. `k` is the course clock's tick. */
  | { t: "frame"; run: number; k: number; r: RiderFrame[] }
  /** Your bike as the room has it: take it, and ride on from there. */
  | { t: "sync"; run: number; ride: number[]; input: [bits: number, lean: number] };

// ---------------------------------------------------------------------------------------------
// Poses: a bike as other riders' screens draw it, small enough to send ten times a second.

/**
 * One rider in a frame: id, the tick the room has their bike at, the chassis (x, y in cm, angle
 * in milliradians), the wheels (x, y in cm, spin in centiradians), lean (×100), flags, the last
 * checkpoint and the tick they reached it, and the latest hash of their bike and its tick.
 */
export type RiderFrame = [
  id: string,
  tick: number,
  x: number,
  y: number,
  angle: number,
  rx: number,
  ry: number,
  fx: number,
  fy: number,
  ra: number,
  fa: number,
  lean: number,
  flags: number,
  cp: number,
  cpAt: number,
  hashTick: number,
  hash: number,
];

export const F_CRASHED = 1;
export const F_FINISHED = 2;
/** Holding R at the checkpoint. */
export const F_HELD = 4;
/** The room is stepping their bike without them (they've gone, or their page stalled). */
export const F_AWAY = 8;

const cm = (v: number) => Math.round(v * 100);

export function encodeRider(id: string, ride: Ride, flags: number, cpAt: number, hashTick: number, hash: number): RiderFrame {
  const b = ride.bike;
  return [
    id,
    ride.tick,
    cm(b.x),
    cm(b.y),
    Math.round(Math.atan2(b.s, b.c) * 1000),
    cm(b.rear.x),
    cm(b.rear.y),
    cm(b.front.x),
    cm(b.front.y),
    cm(b.rear.a),
    cm(b.front.a),
    cm(b.lean),
    flags,
    ride.checkpoint,
    cpAt,
    hashTick,
    hash,
  ];
}

/** A frame's pose, as a bike to draw (only the fields drawing uses). */
export function decodePose(f: RiderFrame, into = new Bike()): Bike {
  const a = f[4] / 1000;
  into.x = f[2] / 100;
  into.y = f[3] / 100;
  into.c = Math.cos(a);
  into.s = Math.sin(a);
  into.rear.x = f[5] / 100;
  into.rear.y = f[6] / 100;
  into.front.x = f[7] / 100;
  into.front.y = f[8] / 100;
  into.rear.a = f[9] / 100;
  into.front.a = f[10] / 100;
  into.lean = f[11] / 100;
  into.crashed = f[12] & F_CRASHED ? 1 : 0;
  return into;
}

/** Final standings: most points, then most wins. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.points - a.points || b.wins - a.wins;
}

/** A time in ticks as m:ss.cc. */
export function formatTicks(ticks: number): string {
  const cs = Math.floor((ticks * 100) / TICK_HZ);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor(cs / 100) % 60;
  return `${m}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
