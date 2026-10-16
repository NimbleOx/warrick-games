import type { BasePlayer } from "@warrick/kit/shared/protocol";
import { mulberry32, randomSeed, shuffle } from "@warrick/kit/shared/rng";
import { GameError, Lobby, baseState } from "@warrick/kit/worker/lobby";
import { type ClockRules, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "@warrick/kit/worker/turns";
import { chooseMove } from "../shared/ai";
import { MONOMINO, PIECE_COUNT, PIECE_IDS, isPieceId } from "../shared/pieces";
import {
  COLORS,
  DEFAULT_SETTINGS,
  MAX_SEATS,
  SETTING_CHOICES,
  positionOf,
  seated,
  type GameState,
  type OutReason,
  type PlayerState,
  type ServerMsg,
} from "../shared/protocol";
import { EMPTY, hasLegalMove, layoutFor, moveCells, placementError, scoreFor, type Move } from "../shared/rules";

export { GameError, type GameIO } from "@warrick/kit/worker/lobby";

const CPU_NAMES = ["Penny", "Barcode", "Till", "Biscuit", "Clerk", "Ledger", "Pickles", "Docket", "Nibbles", "Tally"];
/** CPU thinking time, so everyone can follow the moves. */
export const CPU_MS = 800;
/** A player who isn't connected has this long before their turn passes. */
export const AWAY_MS = 10_000;
/** Turns passed in a row while away before a player is out. */
export const AWAY_LIMIT = 3;
/** The kit's turn clock: reloading gives back the clock you had, not a new one. */
const CLOCK: ClockRules = { awayMs: AWAY_MS };

export function newGameState(code: string, now: number): GameState {
  return {
    ...baseState(code, now, DEFAULT_SETTINGS),
    game: 0,
    size: 0,
    board: [],
    starts: [],
    seats: [],
    turnPlayerId: null,
    turnDeadline: null,
    clockEnd: null,
    clockTopUp: false,
    timer: null,
    moves: [],
    winners: [],
  };
}

/**
 * Corner Shop's rules on top of the kit's lobby: seats, turns, placing pieces, passing players
 * who can't move, and the final scores. The lobby is only open in the "lobby" phase; a finished
 * game sits in "gameover" until the host takes everyone back.
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
    return { ...base, seat: -1, tray: [], lastPiece: null, out: null, missed: 0, score: 0 };
  }

  // ---------------------------------------------------------------- players

  /** Leaving mid-game puts you out; your pieces stay and your score counts. */
  leave(id: string): void {
    const p = this.player(id);
    if (!p) return;
    if (this.s.phase === "lobby" || p.spectator) {
      this.removePlayer(id);
      this.event(`${p.name} left`);
      return;
    }
    this.setConnected(id, false);
    if (this.s.phase === "playing" && p.seat >= 0 && !p.out) {
      this.markOut(p, "left");
      if (this.s.turnPlayerId === id) this.nextTurn();
    } else {
      this.event(`${p.name} left`);
    }
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
    if (s.phase !== "playing" || s.turnPlayerId !== id) return;
    const now = this.io.now();
    if (connected) p.missed = 0;
    this.armTurn(connected ? turnHolderBack(s, CLOCK, now) : turnHolderLeft(s, CLOCK, now), connected);
  }

  // ---------------------------------------------------------------- game flow

  start(byId: string): void {
    this.beginStart(byId);
    const s = this.s;
    const rng = mulberry32(randomSeed());
    const order = shuffle(rng, this.participants.map((p) => p.id));
    const layout = layoutFor(order.length);
    s.size = layout.size;
    s.starts = layout.starts;
    s.board = new Array(layout.size * layout.size).fill(EMPTY);
    s.seats = order;
    s.moves = [];
    s.winners = [];
    s.game++;
    s.phase = "playing";
    for (const p of s.players) {
      const seat = order.indexOf(p.id);
      p.seat = seat;
      p.tray = seat >= 0 ? [...PIECE_IDS] : [];
      p.lastPiece = null;
      p.out = null;
      p.missed = 0;
      p.score = seat >= 0 ? scoreFor(p.tray, null) : 0;
    }
    this.uniqueSeatColors();
    this.event(`Game on! ${order.length} players on a ${layout.size}×${layout.size} board.`);
    s.turnPlayerId = null;
    this.nextTurn();
  }

  protected resetForLobby(): void {
    const s = this.s;
    s.size = 0;
    s.board = [];
    s.starts = [];
    s.seats = [];
    s.moves = [];
    s.winners = [];
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.clockEnd = null;
    s.timer = null;
    for (const p of s.players) {
      p.seat = -1;
      p.tray = [];
      p.lastPiece = null;
      p.out = null;
      p.missed = 0;
      p.score = 0;
    }
  }

  place(id: string, raw: Move): void {
    const s = this.s;
    if (s.phase !== "playing") throw new GameError("The game isn't on");
    if (s.turnPlayerId !== id) throw new GameError("It's not your turn");
    const p = this.player(id)!;
    const move = cleanMove(raw);
    if (!move) throw new GameError("That isn't a piece");
    const err = placementError(positionOf(s), p.seat, move);
    if (err) throw new GameError(err);
    this.apply(p, move);
    this.nextTurn();
  }

  private apply(p: PlayerState, move: Move): void {
    const s = this.s;
    const cells = moveCells(s.size, move)!;
    for (const i of cells) s.board[i] = p.seat;
    s.moves.push({ seat: p.seat, piece: move.piece, cells });
    p.tray = p.tray.filter((x) => x !== move.piece);
    p.lastPiece = move.piece;
    p.missed = 0;
    p.score = scoreFor(p.tray, p.lastPiece);
    if (!p.tray.length) this.markOut(p, "done");
    this.touch();
  }

  /** Hand the turn to the next seat that can move, passing anyone who can't. */
  private nextTurn(): void {
    const s = this.s;
    const players = seated(s);
    const at = players.findIndex((p) => p.id === s.turnPlayerId);
    const pos = positionOf(s);
    for (let i = 1; i <= players.length; i++) {
      const p = players[(at + i) % players.length];
      if (p.out) continue;
      if (!hasLegalMove(pos, p.seat)) {
        this.markOut(p, "stuck");
        continue;
      }
      return this.beginTurn(p);
    }
    this.finish();
  }

  private beginTurn(p: PlayerState): void {
    const s = this.s;
    const now = this.io.now();
    s.turnPlayerId = p.id;
    if (p.cpu) {
      startTurnClock(s, CLOCK, now, null, true);
      s.timer = { kind: "cpu", at: now + CPU_MS };
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
   * Every seat gets a colour of its own. They can clash: past the palette the lobby hands out
   * colours again, and a watcher who takes a seat keeps theirs. Whoever joined first keeps it.
   */
  private uniqueSeatColors(): void {
    const players = this.s.players;
    const taken = new Set<string>();
    const clashing: PlayerState[] = [];
    for (const p of players) {
      if (p.seat < 0) continue;
      if (taken.has(p.color)) clashing.push(p);
      else taken.add(p.color);
    }
    for (const p of clashing) {
      const free = COLORS.filter((c) => !taken.has(c));
      // Rather one that nobody watching has either.
      p.color = free.find((c) => !players.some((o) => o.color === c)) ?? free[0];
      taken.add(p.color);
    }
  }

  private markOut(p: PlayerState, reason: OutReason): void {
    if (p.out) return;
    p.out = reason;
    const left = PIECE_COUNT - p.tray.length;
    switch (reason) {
      case "done":
        this.event(`🎉 ${p.name} placed all 21 pieces${p.lastPiece === MONOMINO ? ", monomino last!" : "!"}`);
        break;
      case "stuck":
        this.event(`🚧 ${p.name} has no moves left, with ${p.tray.length} piece${p.tray.length === 1 ? "" : "s"} in the tray`);
        break;
      case "away":
        this.event(`${p.name} has been away for ${AWAY_LIMIT} turns and is out`);
        break;
      case "left":
        this.event(`${p.name} left the game after ${left} piece${left === 1 ? "" : "s"}`);
        break;
    }
    this.touch();
  }

  private finish(): void {
    const s = this.s;
    s.phase = "gameover";
    s.turnPlayerId = null;
    s.turnDeadline = null;
    s.clockEnd = null;
    s.timer = null;
    const players = seated(s);
    for (const p of players) p.score = scoreFor(p.tray, p.lastPiece);
    const top = Math.max(...players.map((p) => p.score));
    const winners = players.filter((p) => p.score === top);
    s.winners = winners.map((p) => p.id);
    const pts = `${top} point${Math.abs(top) === 1 ? "" : "s"}`;
    this.event(
      winners.length === 1
        ? `🏆 ${winners[0].name} wins with ${pts}`
        : `🏆 ${joinNames(winners.map((p) => p.name))} share the win with ${pts}`,
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
      if (s.turnDeadline !== t.at) this.armTurn(s.turnDeadline, this.io.isConnected(s.turnPlayerId ?? ""));
      return;
    }
    s.timer = null;
    const p = this.player(s.turnPlayerId ?? "");
    if (s.phase !== "playing" || !p) return;
    switch (t.kind) {
      case "cpu": {
        if (!p.cpu) break;
        const order = seated(s).filter((o) => !o.out).map((o) => o.seat);
        const move = chooseMove(positionOf(s), p.seat, p.cpu, mulberry32(randomSeed()), order);
        if (move) this.apply(p, move);
        else this.markOut(p, "stuck");
        break;
      }
      case "turn":
        this.event(`⏱ ${p.name} ran out of time and passes`);
        break;
      case "away":
        p.missed++;
        if (p.missed >= AWAY_LIMIT) this.markOut(p, "away");
        else this.event(`${p.name} is away and passes`);
        break;
    }
    this.nextTurn();
    this.touch();
  }
}

/** A move from the wire, with only the fields and types a move has. */
function cleanMove(raw: unknown): Move | null {
  const m = raw as Partial<Move> | null;
  if (!m || !isPieceId(m.piece)) return null;
  const nums = [m.orient, m.x, m.y];
  if (!nums.every((n) => typeof n === "number" && Number.isInteger(n))) return null;
  return { piece: m.piece, orient: m.orient!, x: m.x!, y: m.y! };
}

function joinNames(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
