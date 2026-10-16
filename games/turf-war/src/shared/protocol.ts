import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { Dir, Frame } from "./board";
import type { Snapshot } from "./sim";

export type { CpuLevel, Frame, LogEntry, Snapshot };

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
  /** Nobody wins a solo round (one player on their own): it's their share that counts. */
  winnerId: string | null;
  /** One player on their own when time ran out. Missing in results from before solo play. */
  solo?: boolean;
  standings: Standing[];
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  results: RoundResult | null;
}

export type ClientMsg =
  | LobbyMsg
  /** Turn. Only real changes are sent: no repeats, no straight reversals. */
  | { t: "dir"; d: Dir }
  /** The board drifted or a frame went missing: send a fresh snapshot. */
  | { t: "resync" };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: Snapshot | null; now: number }
  | { t: "snap"; snap: Snapshot }
  | Frame;

export function percent(cells: number, total: number): string {
  if (!total) return "0%";
  const p = (cells / total) * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}
