import { describe, expect, it } from "vitest";
import type { Match } from "../src/shared/ai";
import { TICK_MS } from "../src/shared/constants";
import { Game, newGameState, type GameIO } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io: GameIO = { now: () => now, isConnected: (id) => connected.has(id), match: null as Match | null };
  const game = () => new Game(s, io);
  return {
    s,
    io,
    game,
    connected,
    advance(ms: number) {
      now += ms;
    },
    /** Play rounds the way the room does: tick the arena, then fire the between-round timer. */
    play(maxMs = 30 * 60 * 1000) {
      for (let t = 0; t < maxMs && s.phase !== "gameover"; t += TICK_MS) {
        now += TICK_MS;
        if (s.phase === "playing" && io.match) {
          io.match.step(TICK_MS);
          const g = game();
          g.onArenaEvents(io.match.arena.snapshot(true).ev);
          if (io.match.arena.result) g.roundOver();
        } else if (s.timer && now >= s.timer.at) {
          game().onTimer();
        }
      }
    },
  };
}

describe("game flow", () => {
  it("plays a CPU match to game over", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().updateSettings(host.id, { wins: 2, hurrySeconds: 60 });
    t.game().addCpu(host.id, "hard");
    t.game().addCpu(host.id, "normal");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(1);
    expect(t.io.match?.arena.players).toHaveLength(3);
    expect(t.io.match?.arena.cols).toBe(15);

    // The human never moves; the CPUs fight it out (and blow the human up).
    t.play();
    expect(t.s.phase).toBe("gameover");
    const best = Math.max(...t.s.players.map((p) => p.wins));
    expect(best).toBe(2);
    expect(t.s.players.reduce((n, p) => n + p.deaths, 0)).toBeGreaterThan(0);
    expect(t.io.match).toBeNull();
  });

  it("needs two bombers to start", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    expect(() => t.game().start(host.id)).toThrow();
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
  });

  it("only the host changes settings, and only to allowed values", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    expect(() => t.game().updateSettings(b.id, { wins: 5 })).toThrow();
    t.game().updateSettings(a.id, { wins: 4, crates: "packed" });
    expect(t.s.settings.wins).toBe(3);
    expect(t.s.settings.crates).toBe("packed");
  });

  it("bigger games get a bigger arena", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    for (let i = 0; i < 6; i++) t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    expect(t.io.match?.arena.cols).toBe(19);
    expect(t.io.match?.arena.players).toHaveLength(7);
  });

  it("joining mid-game makes you a spectator, and disconnected players sit rounds out", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    const late = t.game().addHuman("Late");
    expect(late.spectator).toBe(true);
    expect(t.io.match?.arena.player(late.id)).toBeUndefined();

    t.game().setConnected(b.id, false);
    t.connected.delete(b.id);
    t.io.match!.arena.result = { winner: a.id };
    t.game().roundOver();
    expect(t.s.phase).toBe("roundover");
    expect(t.s.players.find((p) => p.id === a.id)!.wins).toBe(1);
    t.advance(10_000);
    t.game().onTimer();
    expect(t.s.phase).toBe("playing");
    expect(t.io.match?.arena.player(b.id)).toBeUndefined();
    expect(t.io.match?.arena.players).toHaveLength(2);
  });

  it("deals the round again if the room forgot it (object restarted)", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    t.io.match = null;
    const g = t.game();
    g.restartRound();
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(1);
    expect((t.io.match as Match | null)?.arena.players).toHaveLength(2);
    expect(g.logs.some((l) => l.text.includes("interrupted"))).toBe(true);
  });
});
