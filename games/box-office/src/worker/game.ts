import type { BasePlayer, CpuLevel } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
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
    // Coming back on your turn gives you a fresh clock; dropping out shortens it.
    const s = this.s;
    if (s.phase !== "playing" || s.seats[s.turn] !== id) return;
    const now = this.io.now();
    if (connected) {
      s.turnDeadline = s.settings.turnSeconds ? now + s.settings.turnSeconds * 1000 : null;
      s.timer = s.turnDeadline ? { kind: "turn", at: s.turnDeadline } : null;
    } else {
      const at = Math.min(s.turnDeadline ?? Infinity, now + AWAY_MS);
      s.turnDeadline = at;
      s.timer = { kind: "away", at };
    }
    this.touch();
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    const rng = mulberry32(randomSeed());
    const { w, h } = boardSize(s.settings.size, this.participants.length);
    Object.assign(s, newBoard(w, h));
    s.seats = shuffle(rng, this.participants.map((p) => p.id));
    s.order = [];
    s.phase = "playing";
    s.game++;
    this.event(`Game on! ${w} × ${h} boxes, ${s.seats.length} players.`);
    this.beginTurn(0, true);
  }

  protected resetForLobby(): void {
    Object.assign(this.s, { w: 0, h: 0, lines: [], boxes: [], seats: [], turn: -1, order: [], turnDeadline: null, timer: null });
  }

  /** `fresh` is a new turn; otherwise the same seat goes again after a capture. */
  private beginTurn(seat: number, fresh: boolean): void {
    const s = this.s;
    const p = this.player(s.seats[seat]);
    const now = this.io.now();
    s.turn = seat;
    if (p?.cpu) {
      s.turnDeadline = null;
      s.timer = { kind: "cpu", at: now + (fresh ? CPU_THINK_MS : CPU_RUN_MS) };
    } else if (!p || !this.io.isConnected(p.id)) {
      s.turnDeadline = now + AWAY_MS;
      s.timer = { kind: "away", at: s.turnDeadline };
    } else if (s.settings.turnSeconds) {
      s.turnDeadline = now + s.settings.turnSeconds * 1000;
      s.timer = { kind: "turn", at: s.turnDeadline };
    } else {
      s.turnDeadline = null;
      s.timer = null;
    }
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
    if (!t || this.io.now() < t.at - 25) return;
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
