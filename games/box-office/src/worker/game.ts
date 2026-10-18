import type { BasePlayer, CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { type ClockRules, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "@warrick/kit/worker/turns";
import { cpuMove, timeoutMove } from "../shared/ai";
import { boardSize, isLine, isOver, newBoard, playLine } from "../shared/board";
import { capturable, lastSide } from "../shared/chains";
import {
  DEFAULT_SETTINGS,
  SETTING_CHOICES,
  standings,
  type GameState,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Popcorn", "Usher", "Reel", "Matinee", "Encore", "Velvet", "Stub", "Cameo", "Trailer", "Balcony"];
/** A CPU's pause before the first line of its turn, and between the lines of a capture run. */
export const CPU_THINK_MS = 800;
export const CPU_RUN_MS = 250;
/** How long an absent player's turn waits before the game plays it for them. */
export const AWAY_MS = 5000;
/** The kit's turn clock: reloading gives back the clock you had, not a new one. */
const CLOCK: ClockRules = { awayMs: AWAY_MS };

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    w: 0,
    h: 0,
    lines: [],
    boxes: [],
    seats: [],
    turn: -1,
    order: [],
    turnDeadline: null,
    clockEnd: null,
    clockTopUp: false,
    timer: null,
    game: 0,
  };
}

/**
 * Box Office's rules on top of the kit's lobby: dealing seats, drawing lines, extra turns,
 * the turn clock, CPU turns and the results. The state's board fields are the board the
 * shared rules work on.
 */
export class Game extends Lobby<GameState, ServerMsg> {
  protected readonly choices = SETTING_CHOICES;
  protected readonly cpuNames = CPU_NAMES;

  protected createPlayer(base: BasePlayer): PlayerState {
    return base;
  }

  private seatOf(id: string): number {
    return this.s.seats.indexOf(id);
  }

  private seatName(seat: number): string {
    return this.player(this.s.seats[seat] ?? "")?.name ?? "Someone";
  }

  // ---------------------------------------------------------------- players

  /** A player who leaves mid-game keeps their seat and their boxes; their turns are played for them. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase !== "lobby" && this.seatOf(id) >= 0) {
      this.event(`${p.name} left the game`);
      this.setConnected(id, false);
    } else {
      super.leave(id);
    }
  }

  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    super.setConnected(id, connected);
    // Dropping out on your turn shortens the clock; coming back gives you what you had, never more.
    const s = this.s;
    if (s.phase !== "playing" || s.seats[s.turn] !== id) return;
    const now = this.io.now();
    this.armTurn(connected ? turnHolderBack(s, CLOCK, now) : turnHolderLeft(s, CLOCK, now), connected);
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    const rng = mulberry32(randomSeed());
    const { w, h } = boardSize(s.settings.size, this.participants.length);
    Object.assign(s, newBoard(w, h));
    s.seats = shuffle(
      rng,
      this.participants.map((p) => p.id),
    );
    this.uniqueSeatColors();
    s.order = [];
    s.phase = "playing";
    s.game++;
    this.event(`Game on! ${w} × ${h} boxes, ${s.seats.length} players.`);
    this.beginTurn(0, true);
  }

  protected resetForLobby(): void {
    Object.assign(this.s, {
      w: 0,
      h: 0,
      lines: [],
      boxes: [],
      seats: [],
      turn: -1,
      order: [],
      turnDeadline: null,
      clockEnd: null,
      timer: null,
    });
  }

  /** `fresh` is a new turn; otherwise the same seat goes again after a capture. */
  private beginTurn(seat: number, fresh: boolean): void {
    const s = this.s;
    const p = this.player(s.seats[seat]);
    const now = this.io.now();
    s.turn = seat;
    if (p?.cpu) {
      startTurnClock(s, CLOCK, now, null, true);
      s.timer = { kind: "cpu", at: now + (fresh ? CPU_THINK_MS : CPU_RUN_MS) };
    } else {
      // The clock starts again with every line, captures included.
      const here = !!p && this.io.isConnected(p.id);
      this.armTurn(startTurnClock(s, CLOCK, now, s.settings.turnSeconds * 1000, here), here);
    }
    this.touch();
  }

  /**
   * Every seat gets a colour of its own: lines and boxes are told apart by colour. They can
   * clash: past the palette the lobby hands out colours again, and a watcher who takes a seat
   * keeps theirs. Whoever joined first keeps it.
   */
  private uniqueSeatColors(): void {
    const players = this.s.players;
    const taken = new Set<string>();
    const clashing: PlayerState[] = [];
    for (const p of players) {
      if (this.seatOf(p.id) < 0) continue;
      if (taken.has(p.color)) clashing.push(p);
      else taken.add(p.color);
    }
    for (const p of clashing) {
      const free = this.colors.filter((c) => !taken.has(c));
      // Rather one that nobody watching has either.
      p.color = free.find((c) => !players.some((o) => o.color === c)) ?? free[0];
      taken.add(p.color);
    }
  }

  /** Arm the timer for the turn's deadline: the clock if they're here, the short wait if not. */
  private armTurn(at: number | null, here: boolean): void {
    this.s.timer = at === null ? null : { kind: here ? "turn" : "away", at };
    this.touch();
  }

  /** The player `id` draws a line. */
  line(id: string, edge: unknown): void {
    const seat = this.requireTurn(id);
    if (!isLine(this.s, edge)) throw new GameError("That's not a line");
    if (this.s.lines[edge] !== -1) throw new GameError("That line is already drawn");
    this.play(seat, edge);
  }

  /** The player `id` takes every box they can complete. */
  takeAll(id: string): void {
    const seat = this.requireTurn(id);
    if (!capturable(this.s).length) throw new GameError("There are no boxes to take");
    while (this.s.phase === "playing" && this.s.turn === seat) {
      const box = capturable(this.s)[0];
      if (box === undefined) break;
      this.play(seat, lastSide(this.s, box));
    }
  }

  private requireTurn(id: string): number {
    this.requirePhase("playing");
    const seat = this.seatOf(id);
    if (seat < 0) throw new GameError("You're watching this game");
    if (seat !== this.s.turn) throw new GameError(`It's ${this.seatName(this.s.turn)}'s turn`);
    return seat;
  }

  private play(seat: number, edge: number): void {
    const s = this.s;
    const done = playLine(s, edge, seat);
    s.order.push(edge);
    if (isOver(s)) return this.finish();
    if (done.length) this.beginTurn(seat, false);
    else this.beginTurn((seat + 1) % s.seats.length, true);
  }

  /** Play out the rest of a turn for someone who ran out of time or isn't here. */
  private playFor(seat: number): void {
    const rng = mulberry32(randomSeed());
    for (let guard = 0; guard < this.s.lines.length && this.s.phase === "playing" && this.s.turn === seat; guard++) {
      this.play(seat, timeoutMove(this.s, rng));
    }
  }

  private finish(): void {
    const s = this.s;
    s.phase = "results";
    s.turn = -1;
    s.turnDeadline = null;
    s.clockEnd = null;
    s.timer = null;
    const rows = standings(s);
    const winners = rows.filter((r) => r.place === 1).map((r) => r.player?.name ?? "?");
    const n = rows[0]?.boxes ?? 0;
    const boxes = `${n} box${n === 1 ? "" : "es"}`;
    this.event(
      winners.length === 1
        ? `🏆 ${winners[0]} wins with ${boxes}`
        : `🏆 ${winners.slice(0, -1).join(", ")} and ${winners.at(-1)} share the win with ${boxes} each`,
    );
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
      if (s.turnDeadline !== t.at) this.armTurn(s.turnDeadline, this.io.isConnected(s.seats[s.turn] ?? ""));
      return;
    }
    s.timer = null;
    if (s.phase !== "playing") return this.touch();
    const seat = s.turn;
    const p = this.player(s.seats[seat]);
    if (t.kind === "cpu" && p?.cpu) {
      this.play(seat, cpuMove(s, s.seats.length, seat, p.cpu as CpuLevel, mulberry32(randomSeed())));
    } else {
      if (t.kind === "turn" && p) this.event(`⏱ ${p.name} ran out of time`);
      this.playFor(seat);
    }
    this.touch();
  }
}
