import type { CpuLevel } from "./ai";
import type { BottleSnap, Garbage } from "./bottle";

export type { CpuLevel };

export type Phase = "lobby" | "playing" | "results";
export type Speed = "low" | "med" | "hi";
/** Who an attack goes to. */
export type Aim = "leader" | "random" | "all";

export interface Settings {
  /** Virus level, 0–20: (level + 1) × 4 viruses. */
  level: number;
  speed: Speed;
  /** Round wins that take the match. */
  wins: number;
  aim: Aim;
}

export const DEFAULT_SETTINGS: Settings = {
  level: 5,
  speed: "med",
  wins: 3,
  aim: "leader",
};

export const SETTING_CHOICES = {
  level: Array.from({ length: 21 }, (_, i) => i),
  speed: ["low", "med", "hi"] as Speed[],
  wins: [1, 2, 3, 5],
  aim: ["leader", "random", "all"] as Aim[],
};

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  /** Watching: all eight seats were taken when they arrived. */
  spectator: boolean;
  /** Bottle slot in the current round, or -1 (between matches, or sitting a round out). */
  slot: number;
  /** Rounds won in the current match. */
  wins: number;
  /** Viruses cleared and attack halves sent in the current match. */
  cleared: number;
  sent: number;
  /** Matches won in this room. */
  trophies: number;
}

export interface RoundStat {
  id: string;
  /** Viruses cleared this round, and left in the bottle. */
  cleared: number;
  left: number;
  sent: number;
  bestChain: number;
  out: boolean;
}

export interface RoundOutcome {
  /** Player ids. Empty for a draw. */
  winners: string[];
  how: "cleared" | "survived" | "draw";
  stats: RoundStat[];
}

/** The round being played. Bottles live in memory; this is the part worth saving. */
export interface RoundInfo {
  /** Round number within the match. */
  n: number;
  seed: number;
  /** Server time of tick 0. Everyone's bottle runs on this clock. */
  goAt: number;
  level: number;
  speed: Speed;
  over: RoundOutcome | null;
  /** When the next round starts, once this one is over. */
  nextAt: number | null;
}

export interface Standing {
  id: string;
  name: string;
  color: string;
  cpu: boolean;
  wins: number;
  cleared: number;
  sent: number;
}

export interface MatchResult {
  match: number;
  winnerId: string | null;
  rounds: number;
  /** Why it ended early, if it did. */
  note: string;
  standings: Standing[];
}

export interface GameState {
  code: string;
  createdAt: number;
  lastActive: number;
  phase: Phase;
  hostId: string;
  settings: Settings;
  players: PlayerState[];
  match: number;
  round: RoundInfo | null;
  results: MatchResult | null;
  nextPlayerNum: number;
}

export interface LogEntry {
  at: number;
  kind: "chat" | "event";
  from?: string;
  color?: string;
  text: string;
}

/** [tick, buttons]: from this tick on, these buttons are held. */
export type KeyEntry = [number, number];
/** [tick, attack id]: the attack reached the bottle before this tick's step. */
export type DropEntry = [number, number];

/** What one bottle did between two ticks, as the server replayed it. */
export interface Segment {
  s: number;
  f: number;
  t: number;
  k: KeyEntry[];
  g: DropEntry[];
  /** The bottle's checksum at tick `t`. */
  c: number;
}

export interface Attack {
  id: number;
  from: number;
  to: number;
  p: [number, number][];
}

export interface LaneSnap {
  s: number;
  /** Bumped whenever the server overrules the player's browser, so stale inputs can be told apart. */
  e: number;
  b: BottleSnap;
  /** Attacks on their way to this bottle that it hasn't taken delivery of yet. */
  due: Garbage[];
}

export interface RoundSnap {
  round: number;
  /** Server time of tick 0. */
  goAt: number;
  /** Player id by bottle slot. */
  who: (string | null)[];
  lanes: LaneSnap[];
}

export interface Frame {
  t: "f";
  s: Segment[];
  a?: Attack[];
  /** Bottles the server overruled. Only their owners use these. */
  fx?: LaneSnap[];
}

export type ClientMsg =
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  | { t: "lobby" }
  | { t: "in"; e: number; n: number; k?: KeyEntry[]; g?: DropEntry[] }
  | { t: "resync"; own?: boolean }
  | { t: "chat"; text: string }
  | { t: "leave" }
  | { t: "ping"; c?: number };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: RoundSnap | null; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "snap"; snap: RoundSnap }
  | Frame
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number; c?: number };

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
