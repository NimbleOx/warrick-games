import type { ArenaSnap } from "./arena";
import type { Dir } from "./movement";

export type Phase = "lobby" | "playing" | "roundover" | "gameover";
export type CpuLevel = "easy" | "normal" | "hard";
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

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  spectator: boolean;
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

export interface GameState {
  code: string;
  createdAt: number;
  lastActive: number;
  phase: Phase;
  hostId: string;
  settings: Settings;
  players: PlayerState[];
  round: number;
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
  | { t: "move"; x: number; y: number; d: Dir }
  | { t: "bomb"; x: number; y: number; d: Dir }
  | { t: "chat"; text: string }
  | { t: "lobby" }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; frame: ArenaSnap | null; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "frame"; f: ArenaSnap }
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths;
}

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
