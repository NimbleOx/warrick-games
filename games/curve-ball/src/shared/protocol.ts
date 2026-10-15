import { SPEEDS, type Speed } from "./constants";
import type { Input, RoundConfig, Steer } from "./sim";

export type Phase = "lobby" | "countdown" | "playing" | "roundover" | "gameover";
export type CpuLevel = "easy" | "normal" | "hard";

export interface Settings {
  /** Points to win; 0 = auto, 10 × (players − 1). */
  target: number;
  speed: Speed;
}

export const DEFAULT_SETTINGS: Settings = {
  target: 0,
  speed: "classic",
};

export const SETTING_CHOICES = {
  target: [0, 5, 10, 20, 30, 50, 80],
  speed: Object.keys(SPEEDS) as Speed[],
};

export function autoTarget(players: number): number {
  return 10 * Math.max(1, players - 1);
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  spectator: boolean;
  /** Match points, updated at the end of each round. */
  score: number;
  /** Rounds survived to the end. */
  wins: number;
}

export interface Timer {
  at: number;
  kind: "countdown" | "roundover";
}

export interface GameState {
  code: string;
  createdAt: number;
  lastActive: number;
  phase: Phase;
  hostId: string;
  settings: Settings;
  players: PlayerState[];
  round: number;
  /** The match's target score, fixed when it starts. */
  target: number;
  roundWinnerId: string | null;
  winnerId: string | null;
  /** When the countdown or the round-over pause ends. */
  phaseDeadline: number | null;
  timer: Timer | null;
  nextPlayerNum: number;
}

export interface LogEntry {
  at: number;
  kind: "chat" | "event";
  from?: string;
  color?: string;
  text: string;
}

/** Everything a client needs to rebuild the round in progress. */
export interface RoundSnapshot {
  num: number;
  seed: number;
  ids: string[];
  cfg: RoundConfig;
  /** Ticks stepped so far. */
  tick: number;
  /** Every steering change so far, in order. */
  inputs: Input[];
}

/** One tick of the round. */
export interface FrameMsg {
  t: "f";
  /** The tick number. */
  n: number;
  /** Steering changes applied at the start of this tick: [slot, steer]. */
  i?: [number, Steer][];
  /** Slots that died during this tick. */
  d?: number[];
  /** Round checksum after this tick, sent every CHECKSUM_EVERY ticks. */
  c?: number;
}

export const CHECKSUM_EVERY = 30;

export type ClientMsg =
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  | { t: "steer"; s: Steer }
  | { t: "resync" }
  | { t: "chat"; text: string }
  | { t: "lobby" }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; round: RoundSnapshot | null; log: LogEntry[]; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "round"; round: RoundSnapshot }
  | FrameMsg
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.wins - a.wins;
}

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
