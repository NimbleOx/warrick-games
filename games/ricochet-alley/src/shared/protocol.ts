import type { CpuLevel } from "./ai";
import type { MazeSize } from "./constants";
import type { Maze } from "./maze";
import type { WorldSnapshot } from "./sim";

export type { CpuLevel };

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

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  /** When a human's last connection dropped (null while connected). */
  awaySince: number | null;
  /** Watching, not playing: joined mid-match and waiting for the next round, or the game was full. */
  spectator: boolean;
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

export interface GameState {
  code: string;
  createdAt: number;
  lastActive: number;
  phase: Phase;
  hostId: string;
  settings: Settings;
  players: PlayerState[];
  round: number;
  setup: RoundSetup | null;
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
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  /** Held input bits changed (s = sequence number), and/or fire was pressed (f). */
  | { t: "in"; s: number; b: number; f?: 1 }
  | { t: "chat"; text: string }
  | { t: "lobby" }
  | { t: "leave" }
  | { t: "ping" };

export type ServerMsg =
  | { t: "welcome"; you: string; state: GameState; world: WorldSnapshot | null; log: LogEntry[]; now: number }
  | { t: "state"; state: GameState; now: number }
  /** A fresh round's starting world (also sent when a round restarts). */
  | { t: "round"; world: WorldSnapshot }
  | Frame
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.kills - a.kills || a.selfHits - b.selfHits;
}

export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_KICKED = 4403;
