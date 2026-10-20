import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { Pilot } from "../shared/ai";
import type { InputEvent, MatchSnapshot, Trouble } from "../shared/protocol";
import { playNumbers, startPlay, type Play, type Rules } from "../shared/sim";

/** One player's table in the room: the game, and the inputs (or the pilot) that play it. */
export class Seat {
  readonly play: Play;
  /** The input bits in effect. */
  bits = 0;
  /** A human's inputs that haven't been reached yet, by tick. */
  pending: InputEvent[] = [];
  /** How far the player's own screen has played (humans). */
  upTo = 0;
  /** Trouble still to land on this table, by tick. */
  troubles: Trouble[] = [];
  /** The latest hash of the game, and its tick (humans: they check it against their own). */
  hashTick = -1;
  hash = 0;
  /** The room is playing the table for them. */
  away = false;
  /** When the room last sent them their game, so it doesn't every tick. */
  syncedAt = -Infinity;
  /** Plays a dropped human's table until they're back. */
  autopilot: Pilot | null = null;

  constructor(
    readonly id: string,
    readonly pilot: Pilot | null,
    rules: Rules,
  ) {
    this.play = startPlay(rules);
  }
}

/**
 * The match being played: the kit's `live`, in memory only (every table changes 120 times a
 * second, far too often to save). A restart loses it, and the match starts again.
 */
export class Match {
  readonly seats: Seat[];
  /** Every trouble sent this match, for snapshots. */
  readonly troubles: Trouble[] = [];
  /** The match clock's tick when the room last stepped it. */
  clock = 0;

  constructor(
    readonly rules: Rules,
    readonly run: number,
    players: { id: string; cpu: CpuLevel | null }[],
  ) {
    this.seats = players.map(
      (p, i) => new Seat(p.id, p.cpu ? new Pilot(p.cpu, (rules.seed ^ Math.imul(i + 1, 7919)) >>> 0) : null, rules),
    );
  }

  seat(id: string): Seat | undefined {
    return this.seats.find((s) => s.id === id);
  }

  remove(id: string): void {
    const i = this.seats.findIndex((s) => s.id === id);
    if (i >= 0) this.seats.splice(i, 1);
  }

  snapshot(): MatchSnapshot {
    return {
      run: this.run,
      rules: this.rules,
      seats: this.seats.map((s) => s.id),
      plays: this.seats.map((s) => playNumbers(s.play)),
      inputs: this.seats.map((s) => s.bits),
      troubles: this.troubles,
    };
  }
}
