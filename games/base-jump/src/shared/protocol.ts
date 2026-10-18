import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { Cmd, Frame, Snapshot } from "./battle";
import type { SendPct } from "./constants";
import type { MapSize } from "./map";

export type { CpuLevel, Frame, LogEntry, MapSize, Snapshot };

export type Phase = "lobby" | "playing" | "results";

/** Real-time, or simultaneous turns: everyone plans at once, then the battle plays a few seconds. */
export type Mode = "live" | "turns";

export interface Settings {
  mode: Mode;
  /** Real-time: the time limit in minutes, or 0 for none. */
  minutes: number;
  /** Turns: the turn limit, or 0 for none. */
  turns: number;
  /** Turns: seconds to plan each turn, or 0 for no limit. */
  plan: number;
  map: MapSize;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "live",
  minutes: 10,
  turns: 40,
  plan: 30,
  map: "medium",
};

export const SETTING_CHOICES = {
  mode: ["live", "turns"] as Mode[],
  minutes: [5, 10, 15, 0],
  turns: [25, 40, 60, 0],
  plan: [15, 30, 60, 0],
  map: ["small", "medium", "large"] as MapSize[],
};

/** Turns: where the round is. */
export interface TurnState {
  /** Turn number, from 1. */
  n: number;
  /** Everyone planning their orders, or the battle playing them out. */
  stage: "plan" | "run";
  /** The battle tick the plan is made at; the run starts from it. */
  tick: number;
  /** When time to plan runs out (server ms), or null: no limit, or not planning. */
  end: number | null;
  /**
   * When the turn runs by itself: `end`, or sooner once everyone still planning has dropped out
   * (they get a few seconds to come back). Null: it doesn't, or it's running.
   */
  deadline: number | null;
  /** Players who have finished planning this turn. */
  done: string[];
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
  /** Bases and units held at the end. */
  bases: number;
  units: number;
  /** Bases taken, and most held at once. */
  taken: number;
  best: number;
  /** Still in at the end. */
  alive: boolean;
}

export interface RoundResult {
  round: number;
  /** Bases on the map. */
  total: number;
  winnerId: string | null;
  /** Why it ended: one player left standing, or the clock (or the turn limit). */
  how: "conquest" | "time";
  /** Turns: how many were played. */
  turns?: number;
  standings: Standing[];
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  /** The turn, while a round in turns is on; null otherwise. */
  turn: TurnState | null;
  results: RoundResult | null;
}

export type ClientMsg =
  | LobbyMsg
  /** Send units from your bases to a base (turns: add it to your plan). */
  | { t: "send"; from: number[]; to: number; pct: SendPct }
  /** Upgrade one of your bases (turns: add it to your plan). */
  | { t: "up"; b: number }
  /** Turns: take back your last order. */
  | { t: "undo" }
  /** Turns: finished planning, or not after all. */
  | { t: "done"; done: boolean }
  /** The battle drifted or a frame went missing: send a fresh snapshot. */
  | { t: "resync" };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: Snapshot | null; now: number }
  | { t: "snap"; snap: Snapshot }
  /** Turns, to one player: their plan for turn `n` so far. */
  | { t: "plan"; n: number; c: Cmd[] }
  | Frame;
