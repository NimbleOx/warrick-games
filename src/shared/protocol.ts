import type { ShotInput, WallMode } from "./sim";
import type { Inventory, ShopId, WeaponId } from "./weapons";

export type Phase = "lobby" | "playing" | "roundover" | "shop" | "gameover";
export type CpuLevel = "easy" | "normal" | "hard";

export interface Settings {
  rounds: number;
  startCash: number;
  maxWind: number;
  walls: WallMode;
  /** 0 = no limit. */
  turnSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rounds: 5,
  startCash: 10000,
  maxWind: 10,
  walls: "open",
  turnSeconds: 60,
};

export const SETTING_CHOICES = {
  rounds: [1, 2, 3, 5, 7, 10],
  startCash: [0, 10000, 25000, 50000, 100000],
  maxWind: [0, 5, 10, 20],
  walls: ["open", "bounce", "wrap"] as WallMode[],
  turnSeconds: [0, 30, 60, 90],
};

export interface Aim {
  angle: number;
  power: number;
  weapon: WeaponId;
}

export interface TankState {
  x: number;
  y: number;
  health: number;
  alive: boolean;
  shield: number;
}

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  spectator: boolean;
  money: number;
  inventory: Inventory;
  kills: number;
  wins: number;
  damage: number;
  score: number;
  ready: boolean;
  tank: TankState | null;
  aim: Aim;
}

export interface Timer {
  at: number;
  kind: "turn" | "cpu" | "resolve" | "roundover" | "shop";
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
  terrain: number[];
  theme: number;
  wind: number;
  turnOrder: string[];
  turnPlayerId: string | null;
  turnDeadline: number | null;
  resolving: boolean;
  roundWinnerId: string | null;
  phaseDeadline: number | null;
  timer: Timer | null;
  shotCount: number;
  nextPlayerNum: number;
}

export interface LogEntry {
  at: number;
  kind: "chat" | "event";
  from?: string;
  color?: string;
  text: string;
}

export interface ShotMessage extends ShotInput {
  angle: number;
  power: number;
}

export type ClientMsg =
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  | { t: "aim"; aim: Aim }
  | { t: "fire"; aim: Aim }
  | { t: "buy"; item: ShopId; qty: 1 | -1 }
  | { t: "ready"; ready: boolean }
  | { t: "chat"; text: string }
  | { t: "lobby" }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; now: number }
  | { t: "state"; state: GameState; now: number }
  | { t: "aim"; id: string; aim: Aim }
  | { t: "shot"; shot: ShotMessage; state: GameState; now: number }
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
