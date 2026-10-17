import type { CpuLevel } from "./ai";
import type { Dir, Frame } from "./board";
import type { Snapshot } from "./sim";

export type { CpuLevel, Frame, Snapshot };

export type Phase = "lobby" | "playing" | "results";
export type BoardSize = "small" | "medium" | "large";

export interface Settings {
  roundSeconds: number;
  board: BoardSize;
}

export const DEFAULT_SETTINGS: Settings = {
  roundSeconds: 180,
  board: "medium",
};

export const SETTING_CHOICES = {
  roundSeconds: [60, 120, 180, 300],
  board: ["small", "medium", "large"] as BoardSize[],
};

export const BOARD_SIZES: Record<BoardSize, { w: number; h: number }> = {
  small: { w: 80, h: 56 },
  medium: { w: 100, h: 70 },
  large: { w: 130, h: 90 },
};

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  /** Watching: all eight seats were taken when they arrived. */
  spectator: boolean;
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
  /** Cells held when time ran out. */
  cells: number;
  /** Most cells held at any point. */
  best: number;
  kills: number;
  deaths: number;
}

export interface RoundResult {
  round: number;
  /** Cells on the board, for percentages. */
  cells: number;
  winnerId: string | null;
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
  round: number;
  results: RoundResult | null;
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
  | { t: "lobby" }
  | { t: "dir"; d: Dir }
  | { t: "resync" }
  | { t: "chat"; text: string }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: Snapshot | null; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "snap"; snap: Snapshot }
  | Frame
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };

export function percent(cells: number, total: number): string {
  if (!total) return "0%";
  const p = (cells / total) * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
