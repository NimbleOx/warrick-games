import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { PieceId } from "./pieces";
import type { Move, Position } from "./rules";

export type Phase = "lobby" | "playing" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export interface Settings {
  /** 0 = no limit. */
  turnSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = { turnSeconds: 60 };

export const SETTING_CHOICES = {
  turnSeconds: [0, 30, 60, 90],
};

export const MAX_SEATS = 4;

/** Blokus's blue, yellow, red and green first, then two spares. */
export const COLORS = ["#4da6ff", "#ffd23f", "#ff5c5c", "#5ce65c", "#c08cff", "#ff9a3c"] as const;

/** Why a player stopped taking turns. */
export type OutReason = "stuck" | "done" | "away" | "left";

export interface PlayerState extends BasePlayer {
  /** Corner (and turn) order in this game; −1 when not playing. */
  seat: number;
  tray: PieceId[];
  lastPiece: PieceId | null;
  out: OutReason | null;
  /** Turns passed in a row while away. */
  missed: number;
  score: number;
}

/** A piece on the board. */
export interface Placed {
  seat: number;
  piece: PieceId;
  cells: number[];
}

export interface Timer {
  at: number;
  kind: "turn" | "cpu" | "away";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /** Games started in this room, so the client knows a new one from the last. */
  game: number;
  size: number;
  /** size × size: the seat covering each square, or −1. */
  board: number[];
  starts: number[];
  /** Player ids by seat. Turns go in seat order. */
  seats: string[];
  turnPlayerId: string | null;
  turnDeadline: number | null;
  timer: Timer | null;
  moves: Placed[];
  winners: string[];
}

export type ClientMsg = LobbyMsg | { t: "place"; move: Move };

export type ServerMsg = RoomMsg<GameState>;

/** The rules' view of the game: the board and every seat's tray. */
export function positionOf(s: GameState): Position {
  return {
    size: s.size,
    cells: Int8Array.from(s.board),
    starts: s.starts,
    trays: s.seats.map((id) => s.players.find((p) => p.id === id)?.tray ?? []),
  };
}

/** Seated players in seat order. */
export function seated(s: GameState): PlayerState[] {
  return s.seats.map((id) => s.players.find((p) => p.id === id)).filter((p): p is PlayerState => !!p);
}

/** Final standings order. Ties share a place. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || a.seat - b.seat;
}
