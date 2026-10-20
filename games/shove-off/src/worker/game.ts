import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { type ClockRules, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "@warrick/kit/worker/turns";
import { chooseMove } from "../shared/ai";
import {
  COLORS,
  DEFAULT_SETTINGS,
  MAX_SEATS,
  SETTING_CHOICES,
  seated,
  turnLimit,
  type Ending,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { LAYOUT_NAMES, MAX_LINE, TO_WIN, hasLegalMove, newBoard, play, shove, type Move, type Shove } from "../shared/rules";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Pebble", "Bumper", "Nudge", "Shunt", "Rocky", "Jostle", "Boulder", "Agate", "Bowler", "Clink"];
/** CPU thinking time, so everyone can follow the moves. */
export const CPU_MS = 900;
/** A player who isn't connected has this long before their turn passes. */
export const AWAY_MS = 10_000;
/** Turns passed in a row while away before a player loses. */
export const AWAY_LIMIT = 3;
/** The CPU a player on their own in the lobby plays. */
export const SOLO_CPU = "normal";
/** The kit's turn clock: reloading gives back the clock you had, not a new one. */
const CLOCK: ClockRules = { awayMs: AWAY_MS };

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    game: 0,
    board: [],
    seats: [],
    turnPlayerId: null,
    turnDeadline: null,
    clockEnd: null,
    clockTopUp: false,
    timer: null,
    turns: 0,
    moves: 0,
    last: null,
    winners: [],
    ending: null,
    firstId: null,
  };
}

/**
 * Shove Off's rules on top of the kit's lobby: two seats, turns, moves, pushing marbles off, and
 * the ways a game ends. The lobby is only open in the "lobby" phase; a finished game sits in
 * "gameover" until the host takes everyone back (or straight into the next game).
 */
export class Game extends Lobby<GameState, ServerMsg> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly colors = COLORS;
  protected readonly cpuNames = CPU_NAMES;
  protected readonly maxPlayers = MAX_SEATS;
  protected readonly finishedPhase = "gameover";

  protected betweenRounds(): boolean {
    return this.s.phase === "lobby";
  }

  protected createPlayer(base: BasePlayer): PlayerState {
    return { ...base, seat: -1, pushed: 0, out: null, missed: 0 };
  }

  /** Only one person is playing (against a CPU): nobody is kept waiting, so there's no clock. */
  private get unwatched(): boolean {
    return seated(this.s).filter((p) => !p.cpu).length <= 1;
  }

  private opponent(p: PlayerState): PlayerState {
    return this.player(this.s.seats[1 - p.seat])!;
  }

  // ---------------------------------------------------------------- players

  /** Leaving mid-game loses it. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
      return;
    }
    this.setConnected(id, false);
    if (this.s.phase === "playing" && p.seat >= 0) this.forfeit(p, "left");
    else this.event(`${p.name} left`);
  }

  resign(id: string): void {
    const p = this.player(id);
    if (this.s.phase !== "playing" || !p || p.seat < 0) throw new GameError("You're not playing");
    this.forfeit(p, "resigned");
  }

  /**
   * The player whose turn it is: gone, their turn passes in AWAY_MS (or when their clock runs out);
   * back, they get the clock they had, never a new one.
   */
  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    super.setConnected(id, connected);
    const s = this.s;
    // A game against a CPU waits for its player, however long they're gone.
    if (s.phase !== "playing" || s.turnPlayerId !== id || this.unwatched) return;
    const now = this.io.now();
    if (connected) p.missed = 0;
    this.armTurn(connected ? turnHolderBack(s, CLOCK, now) : turnHolderLeft(s, CLOCK, now), connected);
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId, 1);
    // On your own: you play a CPU.
    if (this.participants.length === 1) this.addCpu(byId, SOLO_CPU);
    const s = this.s;
    const ids = this.participants.map((p) => p.id);
    // Whoever didn't move first last time does now; between new opponents, a coin toss.
    const first = s.firstId && ids.includes(s.firstId) ? ids.find((id) => id !== s.firstId)! : ids[randomSeed() % 2];
    s.seats = [first, ids.find((id) => id !== first)!];
    s.firstId = first;
    s.board = newBoard(s.settings.layout);
    s.turns = 0;
    s.moves = 0;
    s.last = null;
    s.winners = [];
    s.ending = null;
    s.game++;
    s.phase = "playing";
    for (const p of s.players) {
      p.seat = s.seats.indexOf(p.id);
      p.pushed = 0;
      p.out = null;
      p.missed = 0;
    }
    this.uniqueSeatColors();
    const [a, b] = seated(s);
    this.event(`Game on! ${a.name} against ${b.name}, from the ${LAYOUT_NAMES[s.settings.layout].toLowerCase()} start.`);
    this.event(`${a.name} moves first. Push ${TO_WIN} of the other's marbles off to win.`);
    s.turnPlayerId = null;
    this.beginTurn(a);
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.board = [];
    s.seats = [];
    s.turns = 0;
    s.moves = 0;
    s.last = null;
    s.winners = [];
    s.ending = null;
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.clockEnd = null;
    s.timer = null;
    for (const p of s.players) {
      p.seat = -1;
      p.pushed = 0;
      p.out = null;
      p.missed = 0;
    }
  }

  move(id: string, raw: unknown): void {
    const s = this.s;
    if (s.phase !== "playing") throw new GameError("The game isn't on");
    if (s.turnPlayerId !== id) throw new GameError("It's not your turn");
    const p = this.player(id)!;
    const move = cleanMove(raw);
    if (!move) throw new GameError("That isn't a move");
    const sh = shove(s.board, p.seat, move);
    if (typeof sh === "string") throw new GameError(sh);
    this.apply(p, sh);
  }

  private apply(p: PlayerState, sh: Shove): void {
    const s = this.s;
    play(s.board, p.seat, sh);
    s.last = { seat: p.seat, dir: sh.dir, marbles: sh.marbles, pushed: sh.pushed, off: sh.off };
    s.moves++;
    p.missed = 0;
    this.touch();
    if (sh.off >= 0) {
      p.pushed++;
      const left = TO_WIN - p.pushed;
      this.event(
        `💥 ${p.name} pushes one of ${this.opponent(p).name}'s marbles off: ${p.pushed} down${left ? `, ${left} to go` : ""}`,
      );
      if (p.pushed >= TO_WIN) {
        s.turns++;
        return this.finish(p.seat, "six");
      }
    }
    this.endTurn();
  }

  /** A turn is over, moved or passed: on to the other player, unless that was the last turn. */
  private endTurn(): void {
    const s = this.s;
    s.turns++;
    const limit = turnLimit(s);
    if (limit !== null && s.turns >= limit) return this.finishOnPoints();
    const next = seated(s).find((p) => p.id !== s.turnPlayerId)!;
    if (!hasLegalMove(s.board, next.seat)) {
      // Never seen in a real game, but possible: every marble boxed in.
      this.event(`${next.name} has no legal move and passes`);
      s.turnPlayerId = next.id;
      if (!hasLegalMove(s.board, 1 - next.seat)) return this.finishOnPoints();
      return this.endTurn();
    }
    this.beginTurn(next);
  }

  private beginTurn(p: PlayerState): void {
    const s = this.s;
    const now = this.io.now();
    s.turnPlayerId = p.id;
    if (p.cpu) {
      startTurnClock(s, CLOCK, now, null, true);
      s.timer = { kind: "cpu", at: now + CPU_MS };
    } else if (this.unwatched) {
      this.armTurn(startTurnClock(s, CLOCK, now, null, true), true);
    } else {
      const here = this.io.isConnected(p.id);
      // Here for a turn of their own: whatever they missed before wasn't in a row.
      if (here) p.missed = 0;
      this.armTurn(startTurnClock(s, CLOCK, now, s.settings.turnSeconds * 1000, here), here);
    }
    this.touch();
  }

  /** Arm the timer for the turn's deadline: running out of time if they're here, a missed turn if not. */
  private armTurn(at: number | null, here: boolean): void {
    this.s.timer = at === null ? null : { kind: here ? "turn" : "away", at };
    this.touch();
  }

  /**
   * Both seats get colours of their own. They can clash: a watcher who takes a seat keeps theirs.
   * Whoever joined first keeps it.
   */
  private uniqueSeatColors(): void {
    const players = this.s.players;
    const [a, b] = seated(this.s).sort((x, y) => players.indexOf(x) - players.indexOf(y));
    if (a.color !== b.color) return;
    const free = COLORS.filter((c) => c !== a.color);
    // Rather one that nobody watching has either.
    b.color = free.find((c) => !players.some((o) => o.color === c)) ?? free[0];
  }

  private forfeit(p: PlayerState, reason: "resigned" | "left" | "away"): void {
    p.out = reason;
    this.finish(1 - p.seat, reason);
  }

  /** The move limit (or nobody able to move): whoever pushed more off wins, and equal is a draw. */
  private finishOnPoints(): void {
    const [a, b] = seated(this.s);
    this.finish(a.pushed === b.pushed ? null : a.pushed > b.pushed ? 0 : 1, "limit");
  }

  private finish(winner: number | null, ending: Ending): void {
    const s = this.s;
    s.phase = "gameover";
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.clockEnd = null;
    s.timer = null;
    s.ending = ending;
    s.winners = winner === null ? [] : [s.seats[winner]];
    const w = winner === null ? null : this.player(s.seats[winner])!;
    const l = winner === null ? null : this.player(s.seats[1 - winner])!;
    const [a] = seated(s);
    switch (ending) {
      case "six":
        this.event(`🏆 ${w!.name} pushes ${TO_WIN} off and wins!`);
        break;
      case "limit":
        this.event(
          w
            ? `🏁 That's the move limit: ${w.name} wins, ${w.pushed} pushed off to ${l!.pushed}`
            : `🏁 That's the move limit: a draw, ${a.pushed} pushed off each`,
        );
        break;
      case "resigned":
        this.event(`🏳️ ${l!.name} resigns. ${w!.name} wins!`);
        break;
      case "left":
        this.event(`${l!.name} left the game. ${w!.name} wins!`);
        break;
      case "away":
        this.event(`${l!.name} has been away for ${AWAY_LIMIT} turns. ${w!.name} wins!`);
        break;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- timers

  onTimer(): void {
    const s = this.s;
    const t = s.timer;
    if (!t) return;
    const now = this.io.now();
    if (t.kind === "cpu") {
      if (now < t.at - 25) return;
    } else if (!turnTimeUp(s, CLOCK, now)) {
      // Not yet; or it passed long ago while nobody was here to notice, and they get AWAY_MS more.
      if (s.turnDeadline !== t.at) this.armTurn(s.turnDeadline, this.io.isConnected(s.turnPlayerId ?? ""));
      return;
    }
    s.timer = null;
    const p = this.player(s.turnPlayerId ?? "");
    if (s.phase !== "playing" || !p) return;
    this.touch();
    switch (t.kind) {
      case "cpu": {
        if (!p.cpu) return this.endTurn();
        const move = chooseMove(s.board, p.seat, p.cpu, mulberry32(randomSeed()));
        const sh = move && shove(s.board, p.seat, move);
        if (sh && typeof sh !== "string") return this.apply(p, sh);
        this.event(`${p.name} passes`);
        return this.endTurn();
      }
      case "turn":
        this.event(`⏱ ${p.name} ran out of time and passes`);
        return this.endTurn();
      case "away":
        p.missed++;
        if (p.missed >= AWAY_LIMIT) return this.forfeit(p, "away");
        this.event(`${p.name} is away and passes`);
        return this.endTurn();
    }
  }
}

/** A move from the wire, with only the fields and types a move has. */
function cleanMove(raw: unknown): Move | null {
  const m = raw as Partial<Move> | null;
  if (!m || !Array.isArray(m.marbles) || m.marbles.length < 1 || m.marbles.length > MAX_LINE) return null;
  if (!m.marbles.every((c) => typeof c === "number" && Number.isInteger(c))) return null;
  if (typeof m.dir !== "number" || !Number.isInteger(m.dir)) return null;
  return { marbles: [...m.marbles], dir: m.dir };
}
