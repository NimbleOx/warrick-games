import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import { MAP_IDS } from "./maps";
import type { Act, ActEvent, Board, BuildEvent, TurnStart } from "./rules";
import type { UnitType } from "./units";

export type Phase = "lobby" | "playing" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export interface Settings {
  /** A map id, or "auto" for a random map for however many players there are. */
  map: string;
  /** Per turn, in seconds; 0 = no limit. */
  turnSeconds: number;
  /** CPUs move without pausing for everyone to follow. */
  fastCpus: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  map: "auto",
  turnSeconds: 120,
  fastCpus: false,
};

export const SETTING_CHOICES = {
  map: ["auto", ...MAP_IDS],
  turnSeconds: [0, 60, 120, 180],
  fastCpus: [false, true],
};

export interface Stats {
  built: number;
  kills: number;
  lost: number;
  captured: number;
}

export interface PlayerState extends BasePlayer {
  /** Place in the turn order, and the army's seat on the map; -1 if not in this game. */
  seat: number;
  /** The day they were knocked out, or null while they're in. */
  outDay: number | null;
  resigned: boolean;
  /** A human whose seat the host handed to a CPU. They take it back when they return. */
  standIn: boolean;
  stats: Stats;
}

export interface Timer {
  at: number;
  /** turn: the turn clock (or an away player's minute); cpu: a CPU's next step; finish: the winner's banner. */
  kind: "turn" | "cpu" | "finish";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /** The map being played; null in the lobby. */
  mapId: string | null;
  board: Board | null;
  /** Player ids by seat. */
  order: string[];
  /** The seat whose turn it is; -1 outside a game. */
  turn: number;
  day: number;
  turnNo: number;
  /** Counts every action, so clients can tell states apart. */
  actionNo: number;
  /**
   * The kit's turn clock (`@warrick/kit/worker/turns`). When the current turn ends by itself, as
   * the clock shows it: the turn clock, or sooner while the player is away.
   */
  turnDeadline: number | null;
  /** The thinking clock of the human whose turn it is, kept while they're away. */
  clockEnd: number | null;
  /** This turn's 5 seconds for coming back with the clock nearly out have been used. */
  clockTopUp?: boolean;
  timer: Timer | null;
  /** Player ids in the order they were knocked out. */
  knockedOut: string[];
  winnerId: string | null;
}

/** A turn starting: funds, repairs, and maybe a knockout. */
export interface TurnEvent extends TurnStart {
  day: number;
}

export type ClientMsg =
  | LobbyMsg
  | ({ t: "act" } & Act)
  | { t: "build"; at: number; unit: UnitType }
  | { t: "end" }
  | { t: "resign" }
  | { t: "takeover"; id: string }
  | { t: "fast"; on: boolean };

/**
 * Game events carry the state after them (each its own copy), so clients can animate and then
 * snap to it. An event stands in for the room's state message, so the last one of an action
 * carries the state at the end of it.
 */
export type ServerMsg =
  | RoomMsg<GameState>
  | { t: "act"; ev: ActEvent; state: GameState; now: number }
  | { t: "build"; ev: BuildEvent; state: GameState; now: number }
  | { t: "turn"; ev: TurnEvent; state: GameState; now: number };

/** Final standings: the winner, then whoever lasted longest, then by army and buildings. */
export function standings(s: GameState): PlayerState[] {
  const playing = s.players.filter((p) => p.seat >= 0);
  const lasted = (p: PlayerState) => (p.id === s.winnerId ? Infinity : p.outDay === null ? 1e9 : s.knockedOut.indexOf(p.id));
  const strength = (p: PlayerState) => {
    const b = s.board;
    if (!b) return 0;
    return b.owners.filter((o) => o === p.seat).length * 1000 + b.units.filter((u) => u.seat === p.seat).length;
  };
  return playing.sort((a, b) => lasted(b) - lasted(a) || strength(b) - strength(a));
}
