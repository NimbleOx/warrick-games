import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { Frame, Snapshot } from "./battle";
import type { SendPct } from "./constants";
import type { MapSize } from "./map";

export type { CpuLevel, Frame, LogEntry, MapSize, Snapshot };

export type Phase = "lobby" | "playing" | "results";

export interface Settings {
  /** Time limit in minutes, or 0 for none. */
  minutes: number;
  map: MapSize;
}

export const DEFAULT_SETTINGS: Settings = {
  minutes: 10,
  map: "medium",
};

export const SETTING_CHOICES = {
  minutes: [5, 10, 15, 0],
  map: ["small", "medium", "large"] as MapSize[],
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
  /** Why it ended: one player left standing, or the clock. */
  how: "conquest" | "time";
  standings: Standing[];
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  results: RoundResult | null;
}

export type ClientMsg =
  | LobbyMsg
  /** Send units from your bases to a base. */
  | { t: "send"; from: number[]; to: number; pct: SendPct }
  /** Upgrade one of your bases. */
  | { t: "up"; b: number }
  /** The battle drifted or a frame went missing: send a fresh snapshot. */
  | { t: "resync" };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: Snapshot | null; now: number }
  | { t: "snap"; snap: Snapshot }
  | Frame;
