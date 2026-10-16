import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { HexMap } from "./map";

export type Phase = "lobby" | "playing" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { HexMap, LogEntry };

export interface Settings {
  /** Territories per player. */
  size: number;
  /** Thinking time per attack, in seconds; 0 = no limit. */
  turnSeconds: number;
  /** CPUs attack without pausing for everyone to follow. */
  fastCpus: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  size: 6,
  turnSeconds: 30,
  fastCpus: false,
};

export const SETTING_CHOICES = {
  size: [4, 6, 8],
  turnSeconds: [0, 15, 30, 60],
  fastCpus: [false, true],
};

export interface PlayerState extends BasePlayer {
  /** Place in the turn order, which is also the value in `GameState.owner`; -1 if not in this game. */
  seat: number;
  /** Dice that didn't fit at the end of a turn; they're placed first next time. */
  reserve: number;
  /** The round they were knocked out in, or null while they still hold territory. */
  outRound: number | null;
  /** A human whose seat the host handed to a CPU. They take it back when they return. */
  standIn: boolean;
  /** Territories captured, attacks made, attacks won, and the most territories held at once. */
  captures: number;
  attacks: number;
  wins: number;
  peak: number;
}

export interface Timer {
  at: number;
  /**
   * turn: the turn clock (or 5 seconds for a player who isn't here); cpu: a CPU's next attack;
   * drop: the end-of-turn dice are landing, then the next turn starts; finish: the winner's banner.
   */
  kind: "turn" | "cpu" | "drop" | "finish";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  /**
   * The map never changes during a game, so state messages leave it out (null). It comes in
   * the welcome and with the state that starts the game; `mapId` says which map is current.
   */
  map: HexMap | null;
  mapId: number;
  /** Each territory's owner (a seat) and dice. */
  owner: number[];
  dice: number[];
  /** Player ids by seat: the turn order, random and fixed for the game. */
  order: string[];
  /** The seat whose turn it is; -1 outside a game. */
  turn: number;
  round: number;
  turnNo: number;
  attackNo: number;
  /** Territories taken this turn, for the turn's line in the log. */
  turnCaptures: number;
  /** When the current turn ends by itself, as shown on the clock. */
  turnDeadline: number | null;
  /** The thinking clock of the human whose turn it is, kept while they're away. */
  clockEnd: number | null;
  timer: Timer | null;
  /** Player ids in the order they were knocked out. */
  knockedOut: string[];
  winnerId: string | null;
}

export interface AttackEvent {
  seat: number;
  from: number;
  to: number;
  /** Both sides' rolls, one number per die. */
  att: number[];
  def: number[];
  won: boolean;
}

export interface DropEvent {
  seat: number;
  /** The largest group's size: the new dice. */
  gain: number;
  /** Where each die landed, in order (reserve dice first). */
  placed: number[];
  /** What's left in the reserve. */
  reserve: number;
}

export type ClientMsg =
  | LobbyMsg
  | { t: "attack"; from: number; to: number }
  | { t: "end" }
  | { t: "takeover"; id: string }
  | { t: "fast"; on: boolean }
  /** "I don't have this game's map": the server answers with the full state. */
  | { t: "sync" };

export type ServerMsg =
  | RoomMsg<GameState>
  /** An attack's rolls and result. The state after it follows in the next state message. */
  | { t: "attack"; attack: AttackEvent; now: number }
  /** Where a player's end-of-turn dice landed. The state after it follows. */
  | { t: "drop"; drop: DropEvent; now: number };

/** Final standings: the winner, then whoever lasted longest. */
export function standings(s: GameState): PlayerState[] {
  const playing = s.players.filter((p) => p.seat >= 0);
  const outAt = (p: PlayerState) => (p.id === s.winnerId ? Infinity : p.outRound === null ? 1e9 : s.knockedOut.indexOf(p.id));
  return playing.sort((a, b) => outAt(b) - outAt(a) || b.peak - a.peak);
}
