import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { LAYOUT_IDS, type Layout, type Move } from "./rules";

export type Phase = "lobby" | "playing" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export interface Settings {
  layout: Layout;
  /** 0 = no limit. */
  turnSeconds: number;
  /** Turns each; 0 = no limit. */
  moveLimit: number;
}

export const DEFAULT_SETTINGS: Settings = { layout: "standard", turnSeconds: 60, moveLimit: 100 };

export const SETTING_CHOICES = {
  layout: LAYOUT_IDS,
  turnSeconds: [0, 30, 60, 120],
  moveLimit: [0, 50, 100, 150],
};

export const MAX_SEATS = 2;

/** Marble colours: pearl and onyx first, as in the box, then four more. */
export const COLORS = ["#f1ede4", "#2a2c36", "#e5484d", "#3d8bfd", "#2fbf71", "#f5a524"] as const;

/** Why a player stopped playing before the end. */
export type OutReason = "resigned" | "left" | "away";

export interface PlayerState extends BasePlayer {
  /** 0 moves first; −1 when not playing. */
  seat: number;
  /** The other player's marbles this one has pushed off. */
  pushed: number;
  out: OutReason | null;
  /** Turns passed in a row while away. */
  missed: number;
}

/** The last move, for the client to slide the marbles and mark where they came from. */
export interface LastMove {
  seat: number;
  dir: number;
  /** The mover's marbles, front first, where they were. */
  marbles: number[];
  /** The other player's marbles it pushed, nearest first, where they were. */
  pushed: number[];
  /** The hole of the marble pushed off, or −1. */
  off: number;
}

/** How the game ended. */
export type Ending = "six" | "limit" | OutReason;

export interface Timer {
  at: number;
  kind: "turn" | "cpu" | "away";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /** Games started in this room, so the client knows a new one from the last. */
  game: number;
  /** 61 holes (see hex.ts): the seat whose marble is there, or −1. */
  board: number[];
  /** Player ids by seat: seat 0 moves first. */
  seats: string[];
  turnPlayerId: string | null;
  /** When the turn ends by itself (the kit's turn clock): its clock, or sooner while the player is away. */
  turnDeadline: number | null;
  /** When the turn's clock runs out (null: no limit). */
  clockEnd?: number | null;
  /** This turn's top-up, for someone back with almost no time left, has been used. */
  clockTopUp?: boolean;
  timer: Timer | null;
  /** Turns over, moves and passes both: the move limit counts these. */
  turns: number;
  /** Moves made, so the client can tell a new one from one it has seen. */
  moves: number;
  last: LastMove | null;
  winners: string[];
  ending: Ending | null;
  /** Who moved first in the last game: the other one does in the next. */
  firstId: string | null;
}

export type ClientMsg = LobbyMsg | { t: "move"; move: Move } | { t: "resign" };

export type ServerMsg = RoomMsg<GameState>;

/** Seated players in seat order. */
export function seated(s: GameState): PlayerState[] {
  return s.seats.map((id) => s.players.find((p) => p.id === id)).filter((p): p is PlayerState => !!p);
}

/** Turns in the whole game before it ends on the move limit, or null with no limit. */
export function turnLimit(s: { settings: Settings }): number | null {
  return s.settings.moveLimit ? s.settings.moveLimit * 2 : null;
}
