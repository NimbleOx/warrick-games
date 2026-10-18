import { describe, expect, it } from "vitest";
import { MONOMINO, PIECE_IDS } from "../src/shared/pieces";
import { COLORS, positionOf, seated, type GameState } from "../src/shared/protocol";
import { EMPTY, isFirstMove, legalMoves, moveCells, placementError, scoreFor } from "../src/shared/rules";
import { AWAY_LIMIT, AWAY_MS, CPU_MS, Game, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s: GameState = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io);
  return {
    s,
    game,
    connected,
    get now() {
      return now;
    },
    human(name: string) {
      const p = game().addHuman(name);
      connected.add(p.id);
      return p;
    },
    advance(ms: number) {
      now += ms;
    },
    /** Fire the pending timer (a CPU move, a turn clock), up to `max` times. */
    runTimers(max = 5000) {
      for (let i = 0; i < max && s.timer && s.phase === "playing"; i++) {
        now = Math.max(now, s.timer.at);
        game().onTimer();
      }
    },
    current() {
      return s.players.find((p) => p.id === s.turnPlayerId)!;
    },
  };
}

/** The current player places their first legal move. */
function playAny(t: ReturnType<typeof setup>): void {
  const p = t.current();
  t.game().place(p.id, legalMoves(positionOf(t.s), p.seat)[0]);
}

describe("game flow", () => {
  it("plays a full game against CPUs to the final scores", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().updateSettings(host.id, { turnSeconds: 30 });
    t.game().addCpu(host.id, "easy");
    t.game().addCpu(host.id, "normal");
    t.game().addCpu(host.id, "hard");
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("The game is full (4 players)");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.size).toBe(20);
    expect(t.s.seats).toHaveLength(4);
    expect(new Set(t.s.players.map((p) => p.seat))).toEqual(new Set([0, 1, 2, 3]));
    expect(t.s.players.every((p) => p.tray.length === 21 && p.score === -89)).toBe(true);
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("Wait for the round to end");

    // The host plays a legal move whenever it's their turn; the CPUs play on their timers.
    let guard = 0;
    while (t.s.phase === "playing" && guard++ < 500) {
      if (t.s.turnPlayerId === host.id) playAny(t);
      else {
        expect(t.s.timer).toMatchObject({ kind: "cpu", at: t.now + CPU_MS });
        t.runTimers(1);
      }
    }
    expect(t.s.phase).toBe("gameover");
    const players = seated(t.s);
    expect(players.every((p) => p.out === "stuck" || p.out === "done")).toBe(true);
    // The board matches the moves, and each seat placed exactly the pieces gone from its tray.
    expect(t.s.board.filter((c) => c !== EMPTY)).toHaveLength(t.s.moves.reduce((n, m) => n + m.cells.length, 0));
    for (const p of players) {
      const placed = t.s.moves.filter((m) => m.seat === p.seat).map((m) => m.piece);
      expect([...placed, ...p.tray].sort()).toEqual([...PIECE_IDS].sort());
      expect(p.score).toBe(scoreFor(p.tray, p.lastPiece));
    }
    const top = Math.max(...players.map((p) => p.score));
    expect(t.s.winners).toEqual(players.filter((p) => p.score === top).map((p) => p.id));
    expect(t.s.timer).toBeNull();
    expect(t.s.turnPlayerId).toBeNull();

    // Back to the lobby: the board and the trays reset for the next game.
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.board).toEqual([]);
    expect(t.s.players.every((p) => p.seat === -1 && p.tray.length === 0 && !p.out)).toBe(true);
  });

  it("uses the small board for two players and leaves a corner empty for three", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "normal");
    t.game().start(host.id);
    expect(t.s.size).toBe(14);
    expect(t.s.starts).toEqual([4 * 14 + 4, 9 * 14 + 9]);

    const u = setup();
    const h = u.human("Host");
    u.game().addCpu(h.id, "easy");
    u.game().addCpu(h.id, "easy");
    u.game().start(h.id);
    expect(u.s.size).toBe(20);
    expect(u.s.starts).toEqual([0, 19, 399]);
  });

  it("only lets the current player place, and only legal moves", () => {
    const t = setup();
    const a = t.human("A");
    const b = t.human("B");
    t.game().start(a.id);
    const current = t.current();
    const other = current.id === a.id ? b : a;
    const move = legalMoves(positionOf(t.s), current.seat)[0];
    expect(() => t.game().place(other.id, move)).toThrow("It's not your turn");
    expect(() => t.game().place(current.id, { ...move, x: move.x + 3 })).toThrow("Your first piece must cover your starting square");
    expect(() => t.game().place(current.id, { piece: "Q", orient: 0, x: 0, y: 0 } as never)).toThrow("That isn't a piece");
    expect(() => t.game().place(current.id, { ...move, x: 1.5 })).toThrow("That isn't a piece");
    t.game().place(current.id, move);
    expect(t.s.turnPlayerId).toBe(other.id);
    expect(t.s.moves).toEqual([{ seat: current.seat, piece: move.piece, cells: expect.any(Array) }]);
    expect(current.tray).not.toContain(move.piece);
    expect(current.score).toBe(-89 + t.s.moves[0].cells.length);
  });

  it("passes a player who runs out of time, without knocking them out", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 30 });
    t.game().start(a.id);
    const first = t.current();
    expect(t.s.timer).toEqual({ kind: "turn", at: t.now + 30_000 });
    expect(t.s.turnDeadline).toBe(t.now + 30_000);
    t.advance(29_000);
    t.game().onTimer(); // too early: nothing happens
    expect(t.s.turnPlayerId).toBe(first.id);
    t.advance(1_000);
    t.game().onTimer();
    expect(t.s.turnPlayerId).not.toBe(first.id);
    expect(first.out).toBeNull();
    playAny(t);
    expect(t.s.turnPlayerId).toBe(first.id);
  });

  it("has no clock with the timer off", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 0 });
    t.game().start(a.id);
    expect(t.s.timer).toBeNull();
    expect(t.s.turnDeadline).toBeNull();
  });

  it("passes players with no move automatically and ends when nobody can move", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 30 });
    t.game().start(a.id);
    const stuck = t.current();
    const other = t.s.players.find((p) => p !== stuck)!;
    // Fill the board but for the second player's start: the first player can't start anywhere.
    t.s.board = t.s.board.map((_, i) => (i === t.s.starts[other.seat] ? EMPTY : 3));
    t.advance(30_000);
    t.game().onTimer();
    expect(t.current()).toBe(other);
    t.game().place(other.id, { piece: MONOMINO, orient: 0, x: t.s.starts[other.seat] % 14, y: Math.floor(t.s.starts[other.seat] / 14) });
    // Now neither can move: both are passed, and the game is over.
    expect(stuck.out).toBe("stuck");
    expect(other.out).toBe("stuck");
    expect(t.s.phase).toBe("gameover");
    expect(stuck.score).toBe(-89);
    expect(other.score).toBe(-88);
    expect(t.s.winners).toEqual([other.id]);
  });

  it("scores the whole tray placed, with the monomino bonus", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().start(a.id);
    const p = t.current();
    // Down to the last piece: the monomino, on the start.
    p.tray = [MONOMINO];
    const start = t.s.starts[p.seat];
    t.s.board[start + 15] = p.seat; // a piece of theirs diagonal to the start
    t.game().place(p.id, { piece: MONOMINO, orient: 0, x: start % 14, y: Math.floor(start / 14) });
    expect(p.out).toBe("done");
    expect(p.score).toBe(20);
  });

  it("passes away players, and puts them out after missing too many turns", () => {
    const t = setup();
    const a = t.human("A");
    const b = t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 0 });
    t.game().start(a.id);
    t.connected.delete(b.id);
    t.game().setConnected(b.id, false);
    for (let i = 0; i < AWAY_LIMIT; i++) {
      if (t.s.turnPlayerId === a.id) playAny(t);
      expect(t.s.turnPlayerId).toBe(b.id);
      expect(t.s.timer).toEqual({ kind: "away", at: t.now + AWAY_MS });
      t.runTimers(1);
    }
    expect(b.out).toBe("away");
    expect(b.missed).toBe(AWAY_LIMIT);
    // A plays on alone.
    expect(t.s.turnPlayerId).toBe(a.id);
    playAny(t);
    expect(t.s.turnPlayerId).toBe(a.id);
  });

  it("gives a player who comes back the clock they had, not a new one", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 60 });
    t.game().start(a.id);
    const p = t.current();
    const end = t.now + 60_000;
    const away = (gone: boolean) => {
      if (gone) t.connected.delete(p.id);
      else t.connected.add(p.id);
      t.game().setConnected(p.id, !gone);
    };
    away(true);
    expect(t.s.timer).toEqual({ kind: "away", at: t.now + AWAY_MS });
    t.advance(2000);
    away(false);
    expect(t.s.timer).toEqual({ kind: "turn", at: end });

    // Reloading with a second left: once a turn, 5 seconds to find the piece again. No more.
    t.advance(57_000);
    away(true);
    expect(t.s.timer).toEqual({ kind: "away", at: end });
    away(false);
    expect(t.s.timer).toEqual({ kind: "turn", at: t.now + 5000 });
    t.advance(3000);
    away(true);
    away(false);
    expect(t.s.timer).toEqual({ kind: "turn", at: end });
    t.game().onTimer();
    expect(t.s.turnPlayerId).not.toBe(p.id);
    expect(p.missed).toBe(0);
  });

  it("only counts missed turns in a row: a turn they're here for starts the count again", () => {
    const t = setup();
    const a = t.human("A");
    const b = t.human("B");
    t.game().updateSettings(a.id, { turnSeconds: 30 });
    t.game().start(a.id);
    const setHere = (here: boolean) => {
      if (here) t.connected.add(b.id);
      else t.connected.delete(b.id);
      t.game().setConnected(b.id, here);
    };
    setHere(false);
    // B misses two turns while away.
    for (let i = 0; i < AWAY_LIMIT - 1; i++) {
      if (t.s.turnPlayerId === a.id) playAny(t);
      expect(t.s.timer).toMatchObject({ kind: "away" });
      t.runTimers(1);
    }
    expect(b.missed).toBe(AWAY_LIMIT - 1);
    // B is back before their next turn, then lets the clock run out.
    setHere(true);
    expect(b.missed).toBe(AWAY_LIMIT - 1);
    playAny(t);
    expect(t.s.turnPlayerId).toBe(b.id);
    expect(b.missed).toBe(0);
    t.runTimers(1);
    expect(t.s.turnPlayerId).toBe(a.id);
    // Away again: one missed turn, not the third in a row.
    setHere(false);
    playAny(t);
    t.runTimers(1);
    expect(b.missed).toBe(1);
    expect(b.out).toBeNull();
  });

  it("frees the start of a player who goes out before their first piece", () => {
    const t = setup();
    const a = t.human("A");
    const b = t.human("B");
    t.game().start(a.id);
    if (t.s.turnPlayerId === b.id) playAny(t);
    // A leaves before placing anything. B plays on alone.
    t.game().leave(a.id);
    expect(a.out).toBe("left");
    if (isFirstMove(positionOf(t.s), b.seat)) playAny(t);
    expect(t.s.turnPlayerId).toBe(b.id);
    // A piece of B's diagonal to A's start (as if B had worked its way over there).
    const start = t.s.starts[a.seat];
    t.s.board[start + t.s.size + 1] = b.seat;
    const pos = positionOf(t.s);
    expect(pos.out).toEqual(t.s.seats.map((id) => id === a.id));
    const cover = legalMoves(pos, b.seat).find((m) => moveCells(t.s.size, m)!.includes(start))!;
    expect(cover).toBeDefined();
    // While A was still in, that was A's square.
    expect(placementError({ ...pos, out: undefined }, b.seat, cover)).toBe("That's another player's starting square");
    t.game().place(b.id, cover);
    expect(t.s.board[start]).toBe(b.seat);
  });

  it("gives every seat a colour of its own", () => {
    const t = setup();
    const names = ["A", "B", "C", "D", "E", "F", "G"];
    const [a, b, c, d, , , g] = names.map((n) => t.human(n));
    // Six colours: the seventh person shares A's.
    expect(g.color).toBe(a.color);
    // Three seats come free, and the watchers take them at the start, colours and all.
    for (const p of [b, c, d]) t.game().leave(p.id);
    t.game().start(a.id);
    const seats = seated(t.s);
    expect(seats.map((p) => p.name).sort()).toEqual(["A", "E", "F", "G"]);
    expect(new Set(seats.map((p) => p.color)).size).toBe(4);
    expect(a.color).toBe(COLORS[0]);
    expect(g.color).not.toBe(COLORS[0]);
  });

  it("puts a player who leaves mid-game out, and moves the turn on", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.game().addCpu(a.id, "easy");
    t.game().start(a.id);
    while (t.current().cpu) t.runTimers(1);
    const leaver = t.current();
    t.game().leave(leaver.id);
    expect(leaver.out).toBe("left");
    expect(leaver.connected).toBe(false);
    expect(t.s.players).toContain(leaver); // still in the results
    expect(t.s.turnPlayerId).not.toBe(leaver.id);
  });

  it("seats at most four, and anyone joining mid-game watches", () => {
    const t = setup();
    const a = t.human("A");
    t.human("B");
    t.human("C");
    t.human("D");
    expect(t.human("E").spectator).toBe(true);
    t.game().start(a.id);
    expect(t.s.seats).toHaveLength(4);
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
    expect(late.seat).toBe(-1);
  });
});
