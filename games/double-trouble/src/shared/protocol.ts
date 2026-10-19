import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";
import type { CpuLevel } from "./ai";
import type { Dir, Garbage, LaneSnap } from "./engine";

export type { CpuLevel, Dir, Garbage, LaneSnap, LogEntry };

export type Phase = "lobby" | "playing" | "results";
/** Make this tile first to win (0: last one standing only). */
export type Goal = 0 | 256 | 512 | 1024;
/** Board sizes the host can pick: 4 × 4 like the original, or a roomier 5 × 5. */
export type Size = 4 | 5;
/** Who a player's rocks go to. */
export type Aim = "random" | "leader" | "weakest";

export interface Settings {
  goal: Goal;
  size: Size;
  aim: Aim;
}

export const DEFAULT_SETTINGS: Settings = {
  goal: 512,
  size: 4,
  aim: "random",
};

export const SETTING_CHOICES = {
  goal: [0, 256, 512, 1024] as Goal[],
  size: [4, 5] as Size[],
  aim: ["random", "leader", "weakest"] as Aim[],
};

/** Make this tile on your own and you've won, and can keep going. */
export const SOLO_GOAL = 2048;

/** Rocks start getting multiplied this long into a round, so rounds come to an end. */
export const MARGIN_S = 120;

/** Rock multiplier: 1 until the margin, then 1.5, up by half every 30 seconds, to at most 4. */
export function attackScale(msSinceGo: number): number {
  const over = msSinceGo / 1000 - MARGIN_S;
  return over < 0 ? 1 : Math.min(4, 1.5 + Math.floor(over / 30) * 0.5);
}

export interface PlayerState extends BasePlayer {
  /** Board slot in the current round, or -1. */
  slot: number;
  /** Rounds won in this room. */
  wins: number;
}

export interface Standing {
  id: string;
  name: string;
  color: string;
  cpu: boolean;
  /** 1 for the winner. */
  place: number;
  /** Biggest tile's exponent. */
  best: number;
  score: number;
  /** Rocks sent, after the multiplier. */
  sent: number;
  /** Rocks smashed on their own board. */
  smashed: number;
  kos: number;
  moves: number;
  /** How long they lasted, in seconds. */
  secs: number;
}

export interface RoundResult {
  round: number;
  /** Nobody wins a solo round (one player on their own): it's their board that counts. */
  winnerId: string | null;
  /** One player on their own. Missing in results from before solo play. */
  solo?: boolean;
  /** Won by making the goal tile, or by outlasting everyone. */
  how: "goal" | "last" | null;
  /** The goal tile that round (0: none). */
  goal: Goal;
  standings: Standing[];
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  results: RoundResult | null;
}

/** One player's board as the server has it. */
export interface SeatSnap extends LaneSnap {
  /** Bumped whenever the server overrules the player's browser, so stale moves can be told apart. */
  e: number;
  /** The newest garbage id sent to this board. */
  g: number;
  kos: number;
  /** Rocks actually sent, after the multiplier. */
  atk: number;
  /** Finishing place once the round is decided for them (1 is the winner), otherwise 0. */
  place: number;
  /** Made SOLO_GOAL in a solo round. */
  won: boolean;
}

export interface RoundSnap {
  round: number;
  seed: number;
  /** Server time the round starts. */
  goAt: number;
  size: Size;
  goal: Goal;
  /** Player id by slot. */
  who: (string | null)[];
  seats: (SeatSnap | null)[];
  over: boolean;
  /** One player on their own: no rocks, SOLO_GOAL to make, and on until they run out of moves. */
  solo: boolean;
}

/** What happened in a round since the last frame. */
export type Op =
  /** A board changed: a move (`d`), or rocks the server dropped on an idle player (`d` -1). `b` is the board after it. */
  | {
      k: "m";
      s: number;
      d: Dir | -1;
      b: string;
      n: number;
      score: number;
      charge: number;
      /** Rocks still on their way. */
      q: number;
      /** Rocks this player has sent in all, after the multiplier. */
      atk: number;
      smashed: number;
      /** This move's merges, the rocks they were worth, the rocks that landed and those smashed. */
      c: number;
      a: number;
      ins: number;
      sm: number;
    }
  /** Rocks sent from one board to another. */
  | { k: "g"; id: number; from: number; to: number; rocks: number }
  /** A player filled up (or left). `by` gets the KO, or -1. */
  | { k: "ko"; s: number; by: number; place: number }
  /** A player made the goal tile and won. Solo, they made SOLO_GOAL and play on. */
  | { k: "goal"; s: number };

export interface Frame {
  t: "f";
  o: Op[];
}

export type ClientMsg =
  | LobbyMsg
  /** A move: `k` is how many moves came before it, `g` the newest garbage seen, `ck` the board's checksum after. */
  | { t: "mv"; e: number; k: number; d: Dir; g: number; ck: number };

export type ServerMsg =
  | Exclude<RoomMsg<GameState>, { t: "welcome" }>
  | { t: "welcome"; you: string; state: GameState; log: LogEntry[]; snap: RoundSnap | null; now: number }
  | { t: "snap"; snap: RoundSnap; now: number }
  | Frame
  /** The server overruled this player's browser: here's their board as it really is. */
  | { t: "fix"; s: number; seat: SeatSnap };
