import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { Garbage, LaneSnap, Placement } from "./engine";

export type { CpuLevel, Garbage, LaneSnap, LogEntry, Placement };

export type Phase = "lobby" | "playing" | "results";
export type Speed = "relaxed" | "normal" | "frantic";
/** Who a player's garbage goes to. */
export type Aim = "random" | "strongest" | "weakest";

export interface Settings {
  speed: Speed;
  aim: Aim;
}

export const DEFAULT_SETTINGS: Settings = {
  speed: "normal",
  aim: "random",
};

export const SETTING_CHOICES = {
  speed: ["relaxed", "normal", "frantic"] as Speed[],
  aim: ["random", "strongest", "weakest"] as Aim[],
};

/**
 * Gravity level at the start, how many seconds until it goes up a level and where it stops;
 * and when garbage starts getting multiplied, so long rounds come to an end.
 */
export const SPEEDS: Record<Speed, { start: number; every: number; cap: number; margin: number }> = {
  relaxed: { start: 1, every: 45, cap: 10, margin: 150 },
  normal: { start: 3, every: 30, cap: 15, margin: 90 },
  frantic: { start: 8, every: 20, cap: 19, margin: 60 },
};

export function levelAt(speed: Speed, msSinceGo: number): number {
  const s = SPEEDS[speed];
  return Math.min(s.cap, s.start + Math.floor(Math.max(0, msSinceGo) / 1000 / s.every));
}

/** Garbage multiplier: 1 until the margin time, then up by half every 30 seconds, to at most 4. */
export function attackScale(speed: Speed, msSinceGo: number): number {
  const over = msSinceGo / 1000 - SPEEDS[speed].margin;
  return over < 0 ? 1 : Math.min(4, 1.5 + Math.floor(over / 30) * 0.5);
}

/** Milliseconds for a piece to fall one row, by level (the usual guideline curve). */
export function gravityMs(level: number): number {
  return Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
}

export interface PlayerState extends BasePlayer {
  /** Board slot in the current round, or -1. */
  slot: number;
  /** Rounds won in this room. */
  wins: number;
}

export interface Standing {
  id: string;
  name: string;
  color: string;
  cpu: boolean;
  /** 1 for the winner. */
  place: number;
  kos: number;
  sent: number;
  lines: number;
  pieces: number;
  /** Points scored, and the level they reached. */
  score: number;
  level: number;
  /** How long they lasted, in seconds. */
  secs: number;
}

export interface RoundResult {
  round: number;
  /** Nobody wins a solo round (one player on their own): it's their score that counts. */
  winnerId: string | null;
  /** One player on their own. Missing in results from before solo play. */
  solo?: boolean;
  standings: Standing[];
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  results: RoundResult | null;
}

/** One player's board as the server has it. */
export interface SeatSnap extends LaneSnap {
  /** Bumped whenever the server overrules the player's browser, so stale locks can be told apart. */
  e: number;
  /** The newest garbage id sent to this board. */
  g: number;
  kos: number;
  /** Garbage actually sent, after the multiplier. */
  atk: number;
  /** Points scored. */
  sc: number;
  /** Finishing place once they're out (1 is the winner), otherwise 0. */
  place: number;
}

export interface RoundSnap {
  round: number;
  seed: number;
  /** Server time the first piece drops. */
  goAt: number;
  speed: Speed;
  /** Player id by slot. */
  who: (string | null)[];
  seats: (SeatSnap | null)[];
  over: boolean;
  /** One player on their own: no garbage, and the round goes on until they top out. */
  solo: boolean;
}

/** What happened in a round since the last frame. */
export type Op =
  /** A piece locked. `b` is the board after it, `q` the garbage still waiting. */
  | {
      k: "l";
      s: number;
      b: string;
      n: number;
      hold: number;
      pc: number;
      combo: number;
      b2b: boolean;
      q: number;
      lines: number;
      /** Garbage this player has sent in all, after the multiplier. */
      atk: number;
      /** Points this player has scored in all. */
      sc: number;
      /** Rows this lock cleared, the T-spin kind, the garbage it was worth and whether it was a perfect clear. */
      c: number;
      sp: number;
      a: number;
      pcl: boolean;
      /** Garbage that rose into the board. */
      ins: number;
    }
  /** Garbage sent from one board to another. */
  | { k: "g"; id: number; from: number; to: number; lines: number; hole: number }
  /** A player topped out (or left). `by` gets the KO, or -1. */
  | { k: "ko"; s: number; by: number; place: number };

export interface Frame {
  t: "f";
  o: Op[];
}

export type ClientMsg =
  | LobbyMsg
  /** A piece locked: `k` is how many pieces came before it, `g` the newest garbage seen, `ck` the board's checksum after. */
  | { t: "lock"; e: number; k: number; pl: Placement; g: number; ck: number };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: RoundSnap | null; now: number }
  | { t: "snap"; snap: RoundSnap; now: number }
  | Frame
  /** The server overruled this player's browser: here's their board as it really is. */
  | { t: "fix"; s: number; seat: SeatSnap };
