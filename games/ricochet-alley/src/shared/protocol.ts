import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { MazeSize } from "./constants";
import type { Maze } from "./maze";
import type { WorldSnapshot } from "./sim";

export type { CpuLevel, LogEntry };

export type Phase = "lobby" | "countdown" | "playing" | "roundover" | "gameover";
export type MazeChoice = "auto" | MazeSize;

export interface Settings {
  /** Points to win the match. */
  target: number;
  maze: MazeChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  target: 10,
  maze: "auto",
};

export const SETTING_CHOICES = {
  target: [3, 5, 10, 15, 20],
  maze: ["auto", "small", "medium", "large"] as MazeChoice[],
};

/** "Auto" maze size by number of tanks. */
export function mazeSizeFor(choice: MazeChoice, tanks: number): MazeSize {
  if (choice !== "auto") return choice;
  return tanks <= 3 ? "small" : tanks <= 5 ? "medium" : "large";
}

export interface PlayerState extends BasePlayer {
  /** When a human's last connection dropped (null while connected). */
  awaySince: number | null;
  /** Rounds won. */
  score: number;
  kills: number;
  /** Times killed by their own bullet. */
  selfHits: number;
}

export interface Timer {
  at: number;
  kind: "countdown" | "roundover";
}

/** What's fixed for a round: the maze, its look, and which player drives which tank. */
export interface RoundSetup {
  maze: Maze;
  theme: number;
  /** Player ids in tank order; tank i belongs to tanks[i]. */
  tanks: string[];
  /** Where each tank starts, so a round interrupted by a restart can begin again identically. */
  start: WorldSnapshot;
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  setup: RoundSetup | null;
  roundWinnerId: string | null;
  phaseDeadline: number | null;
  timer: Timer | null;
}

/**
 * One tank in a frame: [x·64, y·64, heading, turnTicks] for a CPU, plus [inputSeq, inputAge] for a human
 * (the last input change the server has applied, and for how many ticks). 0 means the tank is dead.
 */
export type FrameTank = number[] | 0;

/**
 * Frame events, as flat number arrays:
 * - [EV_FIRE, id, owner, x, y, vx, vy]: a new bullet, in its exact state; every client flies it from there.
 * - [EV_HIT, bulletId, owner, victim, x, y]: a bullet hit a tank.
 */
export type FrameEvent = number[];
export const EV_FIRE = 0;
export const EV_HIT = 1;

export interface Frame {
  t: "f";
  /** Server tick. */
  n: number;
  k: FrameTank[];
  e?: FrameEvent[];
}

export type ClientMsg =
  | LobbyMsg
  /** Held input bits changed (s = sequence number), and/or fire was pressed (f). */
  | { t: "in"; s: number; b: number; f?: 1 };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; world: WorldSnapshot | null; log: LogEntry[]; now: number }
  /** A fresh round's starting world (also sent when a round restarts). */
  | { t: "round"; world: WorldSnapshot }
  | Frame;

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.kills - a.kills || a.selfHits - b.selfHits;
}
