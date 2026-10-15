import type { ArenaConfig, ArenaSnapshot, Dir, Frame, WallMode } from "./arena";
import { ARENA_SIZES, BOOST_SECONDS, SHRINK_SECONDS, SPEEDS, type ArenaSize, type Speed } from "./constants";

export type Phase = "lobby" | "countdown" | "playing" | "roundover" | "gameover";
export type CpuLevel = "easy" | "normal" | "hard";

export interface Settings {
  rounds: number;
  arena: ArenaSize;
  speed: Speed;
  /** Boosts per cycle per round; 0 = off. */
  boosts: number;
  walls: WallMode;
  /** Seconds into a round before the walls start closing in; 0 = never. */
  suddenDeath: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rounds: 5,
  arena: "medium",
  speed: "classic",
  boosts: 3,
  walls: "solid",
  suddenDeath: 60,
};

export const SETTING_CHOICES = {
  rounds: [1, 3, 5, 7, 10],
  arena: ["small", "medium", "large"] as ArenaSize[],
  speed: ["chill", "classic", "hyper"] as Speed[],
  boosts: [0, 3, 5],
  walls: ["solid", "wrap"] as WallMode[],
  suddenDeath: [0, 30, 60, 120],
};

export function arenaConfig(s: Settings): ArenaConfig {
  const { w, h } = ARENA_SIZES[s.arena];
  const tps = SPEEDS[s.speed];
  return {
    w,
    h,
    walls: s.walls,
    boosts: s.boosts,
    boostTicks: Math.round(BOOST_SECONDS * tps),
    suddenDeathAt: s.suddenDeath * tps,
    shrinkEvery: Math.max(1, Math.round(SHRINK_SECONDS * tps)),
  };
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  spectator: boolean;
  score: number;
  wins: number;
  kills: number;
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
  theme: number;
  roundWinnerId: string | null;
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

export type ClientMsg =
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  | { t: "turn"; dir: Dir }
  | { t: "boost" }
  | { t: "chat"; text: string }
  | { t: "lobby" }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; arena: ArenaSnapshot | null; log: LogEntry[]; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "arena"; arena: ArenaSnapshot }
  | { t: "frame"; f: Frame }
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.wins - a.wins || b.kills - a.kills;
}

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
