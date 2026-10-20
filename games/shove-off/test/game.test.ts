import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { CELLS, cellNamed } from "../src/shared/hex";
import { COLORS, seated, type GameState } from "../src/shared/protocol";
import { EMPTY, MARBLES, count, legalShoves, newBoard } from "../src/shared/rules";
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
    log(g: Game) {
      return g.logs.map((e) => e.text);
    },
  };
}

type T = ReturnType<typeof setup>;

/** The current player makes a legal move: one that pushes a marble off if there is one. */
function playAny(t: T, rng: Rng): void {
  const p = t.current();
  const moves = legalShoves(t.s.board, p.seat);
  const off = moves.filter((m) => m.off >= 0);
  const m = off.length ? off[0] : moves[Math.floor(rng() * moves.length)];
  t.game().move(p.id, { marbles: m.marbles, dir: m.dir });
}

/** Two humans in a game. Returns them by seat. */
function twoPlayers(settings: Record<string, unknown> = {}) {
  const t = setup();
  const ann = t.human("Ann");
  const bo = t.human("Bo");
  t.game().updateSettings(ann.id, settings);
  t.game().start(ann.id);
  const [first, second] = seated(t.s);
  return { t, ann, bo, first, second };
}

/** A board with the named holes filled: `x` for seat 0, `o` for seat 1. */
function board(x: string, o: string): number[] {
  const b = new Array<number>(CELLS).fill(EMPTY);
  for (const n of x.split(" ").filter(Boolean)) b[cellNamed(n)] = 0;
  for (const n of o.split(" ").filter(Boolean)) b[cellNamed(n)] = 1;
  return b;
}

describe("game flow", () => {
  it("plays a whole game against a CPU, to six pushed off", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "easy");
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("The game is full (2 players)");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.board).toEqual(newBoard("standard"));
    expect(t.s.seats).toHaveLength(2);
    expect(t.s.turnPlayerId).toBe(t.s.seats[0]);
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("Wait for the round to end");

    const rng = mulberry32(3);
    let guard = 0;
    while (t.s.phase === "playing" && guard++ < 400) {
      if (t.s.turnPlayerId === host.id) playAny(t, rng);
      else {
        expect(t.s.timer).toMatchObject({ kind: "cpu", at: t.now + CPU_MS });
        t.runTimers(1);
      }
    }
    expect(t.s.phase).toBe("gameover");
    const [a, b] = seated(t.s);
    // Every marble is on the board or counted as pushed off.
    expect(count(t.s.board, 0) + b.pushed).toBe(MARBLES);
    expect(count(t.s.board, 1) + a.pushed).toBe(MARBLES);
    if (t.s.ending === "six") expect(t.s.winners).toEqual([[a, b].find((p) => p.pushed === 6)!.id]);
    else expect(t.s.ending).toBe("limit");
    expect(t.s.turns).toBeGreaterThan(10);
    expect(t.s.moves).toBe(t.s.turns);
  });

  it("gives a player on their own a normal CPU to play, with no clock", () => {
    const t = setup();
    const ann = t.human("Ann");
    t.game().updateSettings(ann.id, { turnSeconds: 30 });
    t.game().start(ann.id);
    const cpu = t.s.players.find((p) => p.cpu)!;
    expect(cpu).toMatchObject({ cpu: "normal", spectator: false });
    expect(t.s.seats.sort()).toEqual([ann.id, cpu.id].sort());
    t.runTimers(1);
    expect(t.s.turnPlayerId).toBe(ann.id);
    expect(t.s).toMatchObject({ turnDeadline: null, timer: null });
    // Nothing passes while Ann is gone.
    t.connected.delete(ann.id);
    t.game().setConnected(ann.id, false);
    expect(t.s.timer).toBeNull();
    t.advance(3_600_000);
    t.runTimers();
    expect(t.s.turnPlayerId).toBe(ann.id);
  });

  it("takes turns at moving first, game by game", () => {
    const { t, ann, first } = twoPlayers();
    const firsts = [first.id];
    for (let g = 0; g < 3; g++) {
      t.game().resign(t.current().id);
      expect(t.s.phase).toBe("gameover");
      t.game().backToLobby(ann.id);
      t.game().start(ann.id);
      firsts.push(t.s.seats[0]);
    }
    expect(firsts[1]).not.toBe(firsts[0]);
    expect(firsts[2]).toBe(firsts[0]);
    expect(firsts[3]).toBe(firsts[1]);
  });

  it("gives the two seats different colours", () => {
    const t = setup();
    const ann = t.human("Ann");
    // Past the six colours, the lobby hands them out again: the seventh is Ann's.
    const others = Array.from({ length: 6 }, (_, i) => t.human(`P${i}`));
    const late = others[5];
    expect(late.color).toBe(ann.color);
    for (const p of others.slice(0, 5)) t.game().leave(p.id);
    t.game().start(ann.id);
    const [a, b] = seated(t.s);
    expect([a.id, b.id].sort()).toEqual([ann.id, late.id].sort());
    expect(a.color).not.toBe(b.color);
    expect(ann.color).toBe(COLORS[0]);
  });
});

describe("moves", () => {
  it("only takes legal moves, on your own turn", () => {
    const { t, first, second } = twoPlayers();
    expect(() => t.game().move(second.id, { marbles: [cellNamed("G5")], dir: 4 })).toThrow("It's not your turn");
    expect(() => t.game().move(first.id, { marbles: [cellNamed("I5")], dir: 0 })).toThrow("Those aren't all your marbles");
    expect(() => t.game().move(first.id, { marbles: [cellNamed("A1")], dir: 4 })).toThrow(
      "You can't push your own marbles off the board",
    );
    expect(() => t.game().move(first.id, { marbles: "A1", dir: 1 })).toThrow("That isn't a move");
    expect(() => t.game().move(first.id, { marbles: [1.5], dir: 1 })).toThrow("That isn't a move");
    expect(() => t.game().move(first.id, null)).toThrow("That isn't a move");
    // C3 C4 C5 up one row.
    t.game().move(first.id, { marbles: [cellNamed("C3"), cellNamed("C4"), cellNamed("C5")], dir: 2 });
    expect(t.s.turnPlayerId).toBe(second.id);
    expect(t.s.last).toMatchObject({ seat: 0, dir: 2, pushed: [], off: -1 });
    expect(t.s.board[cellNamed("D3")]).toBe(0);
    expect(t.s.board[cellNamed("C3")]).toBe(EMPTY);
    expect(t.s.moves).toBe(1);
  });

  it("counts marbles pushed off, and wins on the sixth", () => {
    const { t, first, second } = twoPlayers();
    first.pushed = 5;
    t.s.board = board("E6 E7 E8", "E9 A1");
    const g = t.game();
    g.move(first.id, { marbles: [cellNamed("E6"), cellNamed("E7"), cellNamed("E8")], dir: 0 });
    expect(first.pushed).toBe(6);
    expect(t.s).toMatchObject({ phase: "gameover", ending: "six", winners: [first.id], turnPlayerId: null, timer: null });
    expect(t.log(g)).toEqual([
      `💥 ${first.name} pushes one of ${second.name}'s marbles off: 6 down`,
      `🏆 ${first.name} pushes 6 off and wins!`,
    ]);
    expect(() => t.game().move(second.id, { marbles: [cellNamed("A1")], dir: 0 })).toThrow("The game isn't on");
  });

  it("ends on the move limit: most pushed off wins, and equal is a draw", () => {
    for (const lead of [true, false]) {
      const { t, first, second } = twoPlayers({ moveLimit: 50 });
      if (lead) second.pushed = 2;
      const rng = mulberry32(5);
      // Quiet moves only, so nothing more is pushed off.
      for (let i = 0; i < 100; i++) {
        expect(t.s.phase).toBe("playing");
        const p = t.current();
        const quiet = legalShoves(t.s.board, p.seat).filter((m) => !m.pushed.length);
        const m = quiet[Math.floor(rng() * quiet.length)];
        t.game().move(p.id, { marbles: m.marbles, dir: m.dir });
      }
      expect(t.s).toMatchObject({ phase: "gameover", ending: "limit", turns: 100 });
      expect(t.s.winners).toEqual(lead ? [second.id] : []);
      void first;
    }
  });
});

describe("leaving, resigning and the clock", () => {
  it("loses the game to a resign or a leave", () => {
    const one = twoPlayers();
    one.t.game().resign(one.second.id);
    expect(one.t.s).toMatchObject({ phase: "gameover", ending: "resigned", winners: [one.first.id] });
    expect(one.second.out).toBe("resigned");
    expect(() => one.t.game().resign(one.first.id)).toThrow("You're not playing");

    const two = twoPlayers();
    two.t.game().leave(two.first.id);
    expect(two.t.s).toMatchObject({ phase: "gameover", ending: "left", winners: [two.second.id] });
    // They stay in the results.
    expect(two.t.s.players).toHaveLength(2);
  });

  it("passes a turn that runs out of time", () => {
    const { t, first, second } = twoPlayers({ turnSeconds: 30 });
    expect(t.s.timer).toEqual({ kind: "turn", at: t.now + 30_000 });
    t.advance(30_000);
    const g = t.game();
    g.onTimer();
    expect(t.log(g)).toEqual([`⏱ ${first.name} ran out of time and passes`]);
    expect(t.s.turnPlayerId).toBe(second.id);
    expect(t.s.turns).toBe(1);
    expect(t.s.moves).toBe(0);
  });

  it("passes for a player who's away, and they lose after missing three turns in a row", () => {
    const { t, first, second } = twoPlayers({ turnSeconds: 0 });
    t.connected.delete(first.id);
    t.game().setConnected(first.id, false);
    expect(t.s.timer).toEqual({ kind: "away", at: t.now + AWAY_MS });
    const rng = mulberry32(1);
    for (let i = 1; i <= AWAY_LIMIT; i++) {
      t.runTimers(1);
      if (i < AWAY_LIMIT) {
        expect(first.missed).toBe(i);
        expect(t.s.turnPlayerId).toBe(second.id);
        playAny(t, rng);
        // Away at the start of their turn: the clock is the away one.
        expect(t.s.timer).toEqual({ kind: "away", at: t.now + AWAY_MS });
      }
    }
    expect(t.s).toMatchObject({ phase: "gameover", ending: "away", winners: [second.id] });
  });
});
