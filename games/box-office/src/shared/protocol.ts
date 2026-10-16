import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { boxCounts, type Board, type BoardSize } from "./board";

export type Phase = "lobby" | "playing" | "results";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { BoardSize, LogEntry };

export interface Settings {
  size: BoardSize;
  /** 0 = no limit. */
  turnSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = { size: "medium", turnSeconds: 20 };

export const SETTING_CHOICES = {
  size: ["small", "medium", "large"] as BoardSize[],
  turnSeconds: [0, 10, 20, 30],
};

export type PlayerState = BasePlayer;

export interface Timer {
  at: number;
  /** A human's turn clock, an absent player's short wait, or a CPU's thinking time. */
  kind: "turn" | "away" | "cpu";
}

/** The room's state. The board fields (w, h, lines, boxes) are the board itself. */
export interface GameState extends BaseState<PlayerState, Settings>, Board {
  phase: Phase;
  /** Player ids in turn order. A line's or box's owner is an index into this. */
  seats: string[];
  /** The seat to move, or -1. */
  turn: number;
  /** Every line drawn this game, in order. */
  order: number[];
  turnDeadline: number | null;
  timer: Timer | null;
  /** Counts games in this room, so clients know a new board isn't the old one. */
  game: number;
}

export type ClientMsg = LobbyMsg | { t: "line"; edge: number } | { t: "takeAll" };

export type ServerMsg = RoomMsg<GameState>;

export interface Standing {
  player: PlayerState | undefined;
  id: string;
  seat: number;
  boxes: number;
  /** 1 for the winners; tied players share a place. */
  place: number;
}

/** Everyone who played, most boxes first. */
export function standings(s: GameState): Standing[] {
  const counts = boxCounts(s, s.seats.length);
  const rows = s.seats
    .map((id, seat) => ({ player: s.players.find((p) => p.id === id), id, seat, boxes: counts[seat], place: 0 }))
    .sort((a, b) => b.boxes - a.boxes || a.seat - b.seat);
  rows.forEach((r, i) => (r.place = i > 0 && rows[i - 1].boxes === r.boxes ? rows[i - 1].place : i + 1));
  return rows;
}
