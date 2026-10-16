import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { ArenaDelta, ArenaSnap } from "./arena";
import type { Dir } from "./movement";

export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export type Phase = "lobby" | "playing" | "roundover" | "gameover";
export type Density = "sparse" | "normal" | "packed";
export type Richness = "few" | "normal" | "lots";

export interface Settings {
  /** Round wins needed to take the game. */
  wins: number;
  /** Seconds before the walls start closing in; 0 = never. */
  hurrySeconds: number;
  crates: Density;
  items: Richness;
  skulls: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  wins: 3,
  hurrySeconds: 120,
  crates: "normal",
  items: "normal",
  skulls: true,
};

export const SETTING_CHOICES = {
  wins: [1, 2, 3, 5, 7],
  hurrySeconds: [60, 90, 120, 180, 0],
  crates: ["sparse", "normal", "packed"] as Density[],
  items: ["few", "normal", "lots"] as Richness[],
  skulls: [true, false],
};

export const CRATE_DENSITY: Record<Density, number> = { sparse: 0.5, normal: 0.72, packed: 0.9 };
export const ITEM_RATE: Record<Richness, number> = { few: 0.25, normal: 0.4, lots: 0.6 };

export interface PlayerState extends BasePlayer {
  wins: number;
  kills: number;
  deaths: number;
  items: number;
  /** Has a bomber in the current round. */
  inRound: boolean;
}

export interface Timer {
  at: number;
  kind: "roundover";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  roundWinnerId: string | null;
  phaseDeadline: number | null;
  timer: Timer | null;
}

export type ClientMsg =
  | LobbyMsg
  | { t: "move"; x: number; y: number; d: Dir }
  | { t: "bomb"; x: number; y: number; d: Dir }
  /** This page takes ticks as deltas. Sent with each new arena, since the room can forget. */
  | { t: "deltas" }
  /** This page lost track of the arena: send all of it. */
  | { t: "sync" };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; frame: ArenaSnap | null; now: number }
  | { t: "frame"; f: ArenaSnap }
  /** A tick, for pages that said they take deltas: lay it over the last frame. */
  | { t: "delta"; f: ArenaDelta };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths;
}
