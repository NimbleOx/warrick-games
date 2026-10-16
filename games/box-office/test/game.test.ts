import { describe, expect, it } from "vitest";
import { playLine } from "../src/shared/board";
import { capturable, isSafe, lastSide } from "../src/shared/chains";
import { standings, type GameState } from "../src/shared/protocol";
import { AWAY_MS, CPU_RUN_MS, CPU_THINK_MS, Game, newGameState } from "../src/worker/game";
import { hEdge, vEdge } from "./helpers";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io);
  return {
    s,
    game,
    connected,
    advance(ms: number) {
      now += ms;
    },
    human(name: string) {
      const p = game().addHuman(name);
      connected.add(p.id);
      return p;
    },
    /** Fire timers until the game ends (or nothing is pending). */
    runTimers(max = 5000) {
      for (let i = 0; i < max && s.timer && s.phase === "playing"; i++) {
        now = Math.max(now, s.timer.at);
        game().onTimer();
      }
    },
  };
}

/** Two humans on a fresh board; `first` and `second` are the seats in turn order. */
function twoHumans(turnSeconds = 20) {
  const t = setup();
  const a = t.human("Ann");
  t.human("Bo");
  t.game().updateSettings(a.id, { size: "small", turnSeconds });
  t.game().start(a.id);
  const first = t.s.seats[0];
  const second = t.s.seats[1];
  return { ...t, host: a.id, first, second };
}

const seatOf = (s: GameState, id: string) => s.seats.indexOf(id);

describe("turns", () => {
  it("starts a game sized for the players, in a random but fixed order", () => {
    const t = twoHumans();
    expect(t.s.phase).toBe("playing");
    expect([t.s.w, t.s.h]).toEqual([4, 4]);
    expect(t.s.lines).toHaveLength(40);
    expect(t.s.boxes).toHaveLength(16);
    expect(t.s.seats).toHaveLength(2);
    expect(t.s.turn).toBe(0);
    expect(t.s.turnDeadline).toBeGreaterThan(0);
    // The lobby is closed while the game is on.
    expect(() => t.game().addCpu(t.host, "easy")).toThrow("Wait for the round to end");
  });

  it("passes the turn after a line that completes nothing", () => {
    const t = twoHumans();
    expect(() => t.game().line(t.second, 0)).toThrow("turn");
    t.game().line(t.first, 0);
    expect(t.s.turn).toBe(1);
    expect(t.s.lines[0]).toBe(0);
    expect(t.s.order).toEqual([0]);
    expect(() => t.game().line(t.second, 0)).toThrow("already drawn");
    expect(() => t.game().line(t.second, 999)).toThrow("not a line");
  });

  it("gives another move after completing a box", () => {
    const t = twoHumans();
    // Three sides of the top-left box, then the fourth.
    t.game().line(t.first, hEdge(t.s, 0, 0));
    t.game().line(t.second, vEdge(t.s, 0, 0));
    t.game().line(t.first, hEdge(t.s, 1, 0));
    expect(t.s.turn).toBe(1);
    t.game().line(t.second, vEdge(t.s, 0, 1));
    expect(t.s.boxes[0]).toBe(1);
    expect(t.s.turn).toBe(1);
    t.game().line(t.second, hEdge(t.s, 4, 3));
    expect(t.s.turn).toBe(0);
  });

  it("completes two boxes with one line and still moves again", () => {
    const t = twoHumans();
    // Two side-by-side boxes with everything but the line between them drawn.
    for (const e of [hEdge(t.s, 0, 0), hEdge(t.s, 0, 1), hEdge(t.s, 1, 0), hEdge(t.s, 1, 1), vEdge(t.s, 0, 0), vEdge(t.s, 0, 2)]) {
      playLine(t.s, e, 0);
    }
    t.game().line(t.first, vEdge(t.s, 0, 1));
    expect([t.s.boxes[0], t.s.boxes[1]]).toEqual([0, 0]);
    expect(t.s.turn).toBe(0);
  });

  it("takes every box on offer in one go", () => {
    const t = twoHumans();
    // A chain of three along the top, opened at the left.
    for (let c = 0; c < 3; c++) {
      playLine(t.s, hEdge(t.s, 0, c), 0);
      playLine(t.s, hEdge(t.s, 1, c), 0);
    }
    playLine(t.s, vEdge(t.s, 0, 3), 0);
    playLine(t.s, vEdge(t.s, 0, 0), 0);
    expect(() => t.game().takeAll(t.second)).toThrow("turn");
    t.game().takeAll(t.first);
    expect(t.s.boxes.slice(0, 3)).toEqual([0, 0, 0]);
    expect(t.s.turn).toBe(0);
    expect(() => t.game().takeAll(t.first)).toThrow("no boxes");
  });
});

describe("the end", () => {
  it("ends when every box is claimed and ranks everyone", () => {
    const t = twoHumans();
    const g = t.game();
    // Fill the board line by line, always as whoever's turn it is.
    while (t.s.phase === "playing") {
      const e = t.s.lines.indexOf(-1);
      g.line(t.s.seats[t.s.turn], e);
    }
    expect(t.s.phase).toBe("results");
    expect(t.s.turn).toBe(-1);
    expect(t.s.timer).toBeNull();
    const rows = standings(t.s);
    expect(rows[0].boxes + rows[1].boxes).toBe(16);
    expect(rows[0].boxes).toBeGreaterThanOrEqual(rows[1].boxes);
    expect(g.logs.at(-1)?.text).toMatch(/🏆/);
    expect(() => t.game().line(t.first, 0)).toThrow("Not right now");
  });

  it("lets tied players share the win", () => {
    const s = newGameState("ABCDE", 0);
    Object.assign(s, { seats: ["a", "b", "c"], w: 2, h: 2, boxes: [0, 1, 0, 1], lines: [] });
    s.players = ["a", "b", "c"].map((id) => ({ id, name: id, color: "", cpu: null, connected: true, spectator: false }));
    expect(standings(s).map((r) => [r.id, r.boxes, r.place])).toEqual([
      ["a", 2, 1],
      ["b", 2, 1],
      ["c", 0, 3],
    ]);
  });

  it("plays a full game of eight seats against CPUs at every level, then goes again", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().updateSettings(host.id, { size: "large", turnSeconds: 10 });
    for (const level of ["easy", "normal", "hard", "easy", "normal", "hard", "hard"] as const) t.game().addCpu(host.id, level);
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("full");
    t.game().start(host.id);
    expect([t.s.w, t.s.h]).toEqual([11, 8]);
    // The host never moves, so their turns time out and the game plays them.
    t.runTimers();
    expect(t.s.phase).toBe("results");
    expect(standings(t.s).reduce((n, r) => n + r.boxes, 0)).toBe(88);
    expect(t.s.order).toHaveLength(t.s.lines.length);

    // Play again straight from the results, then back to the lobby.
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.game).toBe(2);
    expect(t.s.order).toEqual([]);
    t.runTimers();
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.lines).toEqual([]);
    expect(t.s.seats).toEqual([]);
  });
});

describe("timers", () => {
  it("paces CPU turns: a think, then quick captures", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "normal");
    t.game().start(host.id);
    const cpu = t.s.players.find((p) => p.cpu)!.id;
    if (t.s.seats[t.s.turn] !== cpu) t.game().line(host.id, 0);
    expect(t.s.timer?.kind).toBe("cpu");
    const started = t.s.timer!.at;
    expect(t.s.timer!.at - 1_000_000).toBeGreaterThanOrEqual(CPU_THINK_MS - 1);
    // Leave a box for the CPU, then let it move: it takes the box and goes again quickly.
    t.s.turn = seatOf(t.s, cpu);
    for (const e of [hEdge(t.s, 0, 0), vEdge(t.s, 0, 0), hEdge(t.s, 1, 0)]) if (t.s.lines[e] === -1) playLine(t.s, e, 0);
    t.advance(started - 1_000_000);
    t.game().onTimer();
    expect(t.s.boxes[0]).toBe(seatOf(t.s, cpu));
    expect(t.s.timer?.kind).toBe("cpu");
    expect(t.s.timer!.at - started).toBe(CPU_RUN_MS);
  });

  it("finishes the turn of a player who runs out of time", () => {
    const t = twoHumans(10);
    // Leave the first player a box, with safe lines elsewhere.
    for (const e of [hEdge(t.s, 0, 0), vEdge(t.s, 0, 0), hEdge(t.s, 1, 0)]) playLine(t.s, e, 1);
    expect(capturable(t.s)).toEqual([0]);
    expect(t.s.timer).toEqual({ kind: "turn", at: t.s.turnDeadline });
    t.advance(9_000);
    t.game().onTimer();
    expect(t.s.boxes[0]).toBe(-1); // not yet
    t.advance(1_000);
    const g = t.game();
    g.onTimer();
    // It took the box, then drew one safe line, and the turn passed.
    expect(t.s.boxes[0]).toBe(0);
    expect(t.s.order).toHaveLength(2);
    expect(t.s.order[0]).toBe(vEdge(t.s, 0, 1));
    const safeLine = t.s.order[1];
    t.s.lines[safeLine] = -1;
    expect(isSafe(t.s, safeLine)).toBe(true);
    t.s.lines[safeLine] = 0;
    expect(t.s.turn).toBe(1);
    expect(g.logs.some((l) => l.text.includes("ran out of time"))).toBe(true);
  });

  it("has no clock with the timer off, but still plays for an absent player", () => {
    const t = twoHumans(0);
    expect(t.s.timer).toBeNull();
    t.game().line(t.first, 0);
    expect(t.s.timer).toBeNull();
    // The second player drops: their turn is played after a short wait.
    t.connected.delete(t.second);
    t.game().setConnected(t.second, false);
    expect(t.s.timer?.kind).toBe("away");
    t.advance(AWAY_MS);
    t.game().onTimer();
    expect(t.s.order).toHaveLength(2);
    expect(t.s.turn).toBe(0);
    // Back on their next turn: no clock again.
    t.game().line(t.first, t.s.lines.indexOf(-1));
    expect(t.s.timer?.kind).toBe("away");
    t.connected.add(t.second);
    t.game().setConnected(t.second, true);
    expect(t.s.timer).toBeNull();
  });

  it("keeps a leaver's seat and boxes, and plays their turns", () => {
    const t = twoHumans();
    t.game().line(t.first, 0);
    t.connected.delete(t.second);
    t.game().leave(t.second);
    expect(t.s.seats).toContain(t.second);
    expect(t.s.players.find((p) => p.id === t.second)?.connected).toBe(false);
    expect(t.s.timer?.kind).toBe("away");
    // Starting the next game drops them.
    t.runTimers();
    expect(t.s.phase).toBe("results");
    // Whoever is still here can start the next one (the host may be the one who left).
    t.game().addCpu(t.first, "easy");
    t.game().start(t.first);
    expect(t.s.seats).not.toContain(t.second);
  });

  it("seats a late arrival as a spectator", () => {
    const t = twoHumans();
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
    expect(() => t.game().line(late.id, lastSide(t.s, 0))).toThrow("watching");
  });
});
