import type { CPU_LEVELS } from "./constants";

export type CpuLevel = (typeof CPU_LEVELS)[number];

/** What every game keeps about a player. Games add their own fields. */
export interface BasePlayer {
  id: string;
  name: string;
  color: string;
  cpu: CpuLevel | null;
  connected: boolean;
  /** Watching: they arrived mid-game, or every seat was taken. */
  spectator: boolean;
}

/** What every game keeps about a room. Games add their own fields. */
export interface BaseState<P extends BasePlayer = BasePlayer, S extends object = object> {
  code: string;
  createdAt: number;
  lastActive: number;
  /** "lobby" while players gather; the rest of the phases are the game's own. */
  phase: string;
  hostId: string;
  settings: S;
  players: P[];
  nextPlayerNum: number;
}

export interface LogEntry {
  at: number;
  kind: "chat" | "event";
  from?: string;
  color?: string;
  text: string;
}

/** What `GET /<game>/api/games/CODE` answers. */
export interface RoomInfo {
  code: string;
  phase: string;
  players: number;
}

/** Messages every game's client sends: joining, the lobby, chat. Games add their own. */
export type LobbyMsg =
  | { t: "hello"; token: string; name: string }
  | { t: "color"; color: string }
  | { t: "settings"; settings: Record<string, unknown> }
  | { t: "addCpu"; level: CpuLevel }
  | { t: "kick"; id: string }
  | { t: "start" }
  | { t: "lobby" }
  | { t: "chat"; text: string }
  | { t: "leave" }
  | { t: "ping" };

/** Messages every room sends. `welcome` can carry more fields (a game's snapshot, say). */
export type RoomMsg<S> =
  | { t: "welcome"; you: string; state: S; log: LogEntry[]; now: number }
  | { t: "state"; state: S; now: number }
  | { t: "log"; entries: LogEntry[] }
  | { t: "error"; message: string }
  | { t: "kicked" }
  | { t: "pong"; now: number };
