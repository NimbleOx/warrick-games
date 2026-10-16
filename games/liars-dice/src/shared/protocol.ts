import type { BasePlayer, BaseState, LobbyMsg, LogEntry, RoomMsg } from "@warrick/kit/shared/protocol";

export type Phase = "lobby" | "playing" | "reveal" | "gameover";
export type { CpuLevel } from "@warrick/kit/shared/protocol";
export type { LogEntry };

export interface Settings {
  /** Ones count as every face. */
  wild: boolean;
  /** Players may call Spot on. */
  spotOn: boolean;
  /** 0 = no limit. */
  turnSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  wild: true,
  spotOn: false,
  turnSeconds: 30,
};

export const SETTING_CHOICES = {
  wild: [true, false],
  spotOn: [false, true],
  turnSeconds: [0, 15, 30, 45],
};

/** "At least `qty` dice showing `face`", counted over every cup on the table. */
export interface Bid {
  qty: number;
  face: number;
}

export interface BidEntry extends Bid {
  by: string;
}

export interface PlayerState extends BasePlayer {
  /** Dice in this player's cup this round (public; the faces never are). 0 if they have no cup. */
  dice: number;
  /** Lost every die, or left mid-game. */
  out: boolean;
  /** Finishing place: 1 for the winner, set when a player goes out. */
  place: number | null;
  outRound: number | null;
  /** Liar! calls made and won. */
  calls: number;
  callsWon: number;
  /** Spot on calls made and won. */
  spots: number;
  spotsWon: number;
}

/** A call and what it showed. Every cup comes up, so it's public from the moment it's made. */
export interface Reveal {
  round: number;
  kind: "liar" | "spot";
  callerId: string;
  bidderId: string;
  bid: Bid;
  wild: boolean;
  /** Every cup this round, in seat order. */
  hands: { id: string; dice: number[] }[];
  /** Dice that count toward the bid, wild ones included. */
  count: number;
  /** Who loses a die (none when a Spot on is right). */
  loserId: string | null;
  /** Who gets a die back (a right Spot on, if they had fewer than the most). */
  gainerId: string | null;
  /** The loser lost their last die. */
  outId: string | null;
  /** Server time of the call; the reveal animation runs from here. */
  at: number;
}

export interface Timer {
  at: number;
  kind: "turn" | "cpu" | "reveal";
}

export interface GameState extends BaseState<PlayerState, Settings> {
  phase: Phase;
  round: number;
  /** Seats, clockwise. Fixed when the game starts. */
  order: string[];
  turnId: string | null;
  /** The turn clock players see (null: no limit). The timer can fire sooner for a missing player. */
  turnDeadline: number | null;
  /** This round's bids, oldest first. */
  bids: BidEntry[];
  /** The last call. Kept into the next round so players can look back at it. */
  reveal: Reveal | null;
  timer: Timer | null;
  winnerId: string | null;
}

/**
 * The current round's dice, by player. This is the game's hidden information: it lives in the
 * room's `live` slot and its own storage key, never in `GameState`, and each player is only
 * ever sent their own cup.
 */
export interface Hands {
  round: number;
  dice: Record<string, number[]>;
}

export type ClientMsg = LobbyMsg | { t: "bid"; qty: number; face: number } | { t: "liar" } | { t: "spot" };

export type ServerMsg =
  | RoomMsg<GameState>
  /** Your own cup for a round. Sent only to you. */
  | { t: "hand"; round: number; dice: number[] };

/** Final standings order: by place, the winner first. */
export function rankPlayers(a: PlayerState, b: PlayerState): number {
  return (a.place ?? 99) - (b.place ?? 99) || b.dice - a.dice;
}
