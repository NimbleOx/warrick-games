import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { ArenaConfig, ArenaSnapshot, Dir, Frame, WallMode } from "./arena";
import { ARENA_SIZES, BOOST_SECONDS, SHRINK_SECONDS, SPEEDS, type ArenaSize, type Speed } from "./constants";

export type { CpuLevel, LogEntry } from "@warrick/kit/shared/protocol";

export type Phase = "lobby" | "countdown" | "playing" | "roundover" | "gameover";

export interface Settings {
  rounds: number;
  arena: ArenaSize;
  speed: Speed;
  /** Boosts per cycle per round; 0 = off. */
  boosts: number;
  walls: WallMode;
  /** Seconds into a round before the walls start closing in; 0 = never. */
  suddenDeath: number;
}

export const DEFAULT_SETTINGS: Settings = {
  rounds: 5,
  arena: "medium",
  speed: "classic",
  boosts: 3,
  walls: "solid",
  suddenDeath: 60,
};

export const SETTING_CHOICES = {
  rounds: [1, 3, 5, 7, 10],
  arena: ["small", "medium", "large"] as ArenaSize[],
  speed: ["chill", "classic", "hyper"] as Speed[],
  boosts: [0, 3, 5],
  walls: ["solid", "wrap"] as WallMode[],
  suddenDeath: [0, 30, 60, 120],
};

export function arenaConfig(s: Settings): ArenaConfig {
  const { w, h } = ARENA_SIZES[s.arena];
  const tps = SPEEDS[s.speed];
  return {
    w,
    h,
    walls: s.walls,
    boosts: s.boosts,
    boostTicks: Math.round(BOOST_SECONDS * tps),
    suddenDeathAt: s.suddenDeath * tps,
    shrinkEvery: Math.max(1, Math.round(SHRINK_SECONDS * tps)),
  };
}

export interface PlayerState extends BasePlayer {
  score: number;
  wins: number;
  kills: number;
}

export interface Timer {
  at: number;
  kind: "countdown" | "roundover";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  theme: number;
  roundWinnerId: string | null;
  phaseDeadline: number | null;
  timer: Timer | null;
  /** Each player's [score, kills] when the round in progress began, so a replayed round doesn't pay twice. */
  roundBase: Record<string, [score: number, kills: number]> | null;
}

export type ClientMsg = LobbyMsg | { t: "turn"; dir: Dir } | { t: "boost" };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; arena: ArenaSnapshot | null; log: LogEntry[]; now: number }
  /** A round's starting grid (or the grid it resumes from). */
  | { t: "arena"; arena: ArenaSnapshot }
  /** One tick of the round. */
  | { t: "frame"; f: Frame };

/** Final standings order. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return b.score - a.score || b.wins - a.wins || b.kills - a.kills;
}
