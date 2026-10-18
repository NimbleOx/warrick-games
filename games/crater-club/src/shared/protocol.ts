import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { DRAW_TURNS_EACH, MAX_POWER, SUDDEN_DEATH_TURNS_EACH } from "./constants";
import { maxPowerFor, type ShotInput, type WallMode } from "./sim";
import { ROUGHNESS, type Roughness } from "./terrain";
import type { Inventory, ShopId, WeaponId } from "./weapons";

export type Phase = "lobby" | "playing" | "roundover" | "shop" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export interface Settings {
  rounds: number;
  startCash: number;
  maxWind: number;
  walls: WallMode;
  /** How rough each round's ground is. A game saved before it was a setting gets the default. */
  roughness: Roughness;
  /** 0 = no limit. */
  turnSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rounds: 5,
  startCash: 10000,
  maxWind: 10,
  walls: "open",
  roughness: "rough",
  turnSeconds: 60,
};

export const SETTING_CHOICES = {
  rounds: [1, 2, 3, 5, 7, 10],
  startCash: [0, 10000, 25000, 50000, 100000],
  maxWind: [0, 5, 10, 20],
  walls: ["open", "bounce", "wrap"] as WallMode[],
  roughness: ROUGHNESS,
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
  /**
   * An easy CPU's last shot this round: whom it aimed at, their health and shield then, and how
   * many shots in a row at them had missed before it. Missing from games saved before it.
   */
  lastShot?: { target: string; life: number; misses: number } | null;
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
  /** The turn's clock (null: no limit). A game saved before it had one gets it from `turnDeadline`. */
  clockEnd?: number | null;
  /** When the turn ends by itself: the clock, or sooner while the player whose turn it is is away. */
  turnDeadline: number | null;
  /** This turn's top-up (time to come back to a clock that has nearly run out, once a turn) is used. */
  clockTopUp?: boolean;
  resolving: boolean;
  roundWinnerId: string | null;
  phaseDeadline: number | null;
  timer: Timer | null;
  shotCount: number;
  /** Turns in a row that ended with nobody hurt (shields count). Missing from games saved before it. */
  quietTurns?: number;
  /** Sudden death: nobody was hurt for too long, so no tank's power is capped until the round ends. */
  suddenDeath?: boolean;
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

/** The most power a tank can fire with: less when it's damaged, except in sudden death. */
export function powerCap(s: GameState, tank: TankState): number {
  return s.suddenDeath ? MAX_POWER : maxPowerFor(tank.health);
}

/** How many turns each with nobody hurt bring on sudden death or, in sudden death, end the round. */
export function quietTurnsEach(s: GameState): number {
  return s.suddenDeath ? DRAW_TURNS_EACH : SUDDEN_DEATH_TURNS_EACH;
}

/** The same, in turns: that many for every tank still in the round. */
export function quietLimit(s: GameState): number {
  const tanks = s.players.filter((p) => !p.spectator && p.tank?.alive).length;
  return quietTurnsEach(s) * Math.max(1, tanks);
}

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.wins - a.wins || b.kills - a.kills;
}
