import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { ShotInput, WallMode } from "./sim";
import type { Inventory, ShopId, WeaponId } from "./weapons";

export type Phase = "lobby" | "playing" | "roundover" | "shop" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

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

export interface PlayerState extends BasePlayer {
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

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
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
}

export interface ShotMessage extends ShotInput {
  angle: number;
  power: number;
}

export type ClientMsg =
  | LobbyMsg
  | { t: "aim"; aim: Aim }
  | { t: "fire"; aim: Aim }
  | { t: "buy"; item: ShopId; qty: 1 | -1 }
  | { t: "ready"; ready: boolean };

export type ServerMsg =
  | RoomMsg<GameState>
  | { t: "aim"; id: string; aim: Aim }
  /** A shot and the state after it: it stands in for a state message. */
  | { t: "shot"; shot: ShotMessage; state: GameState; now: number };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.wins - a.wins || b.kills - a.kills;
}
