import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/shared/rng";
import { Game, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const rng = mulberry32(7);
  // Like the room: the arena outlives each Game wrapper.
  let arena: Game["arena"] = null;
  const game = () => new Game(s, io, arena, rng);
  const act = (fn: (g: Game) => void) => {
    const g = game();
    fn(g);
    arena = g.arena;
    return g;
  };
  return {
    s, act, connected,
    get arena() { return arena; },
    advance(ms: number) { now += ms; },
    /** Run timers and ticks until the game is over (or `until` says stop). */
    run(until: () => boolean = () => s.phase === "gameover", max = 100_000) {
      for (let i = 0; i < max && !until(); i++) {
        if (s.phase === "playing") {
          now += 70;
          act((g) => g.tick());
        } else if (s.timer) {
          now = Math.max(now, s.timer.at);
          act((g) => g.onTimer());
        } else {
          return;
        }
      }
    },
  };
}

describe("game flow", () => {
  it("plays a full CPU match to game over", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Host")).s.players[0];
    t.connected.add(host.id);
    t.act((g) => g.updateSettings(host.id, { rounds: 3, arena: "small" }));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.addCpu(host.id, "easy"));
    const g = t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("countdown");
    expect(t.s.round).toBe(1);
    expect(g.outbox[0].t).toBe("arena");
    expect(t.arena?.cycles).toHaveLength(4);

    // The human never steers, so they ride into a wall; the CPUs fight it out.
    t.run();
    expect(t.s.phase).toBe("gameover");
    expect(t.s.round).toBe(3);
    const total = t.s.players.reduce((n, p) => n + p.wins, 0);
    expect(total).toBeLessThanOrEqual(3);
    expect(t.s.players.some((p) => p.score > 0)).toBe(true);
  });

  it("only counts turns from riders in the round", () => {
    const t = setup();
    const a = t.act((g) => g.addHuman("A")).s.players[0];
    const b = t.act((g) => g.addHuman("B")).s.players[1];
    t.connected.add(a.id).add(b.id);
    t.act((g) => g.start(a.id));
    const late = t.act((g) => g.addHuman("Late")).s.players[2];
    expect(late.spectator).toBe(true);
    const i = t.arena!.index(a.id);
    const before = t.arena!.cycles[i].dir;
    const turn = ((before + 1) % 4) as 0 | 1 | 2 | 3;
    t.act((g) => g.turn(late.id, turn));
    t.act((g) => g.turn(a.id, turn));
    t.run(() => t.s.phase === "playing");
    t.act((g) => g.tick());
    expect(t.arena!.cycles[i].dir).toBe(turn);
    expect(t.arena!.index(late.id)).toBe(-1);
  });

  it("scores kills, outlasting and the round win", () => {
    const t = setup();
    const a = t.act((g) => g.addHuman("A")).s.players[0];
    const b = t.act((g) => g.addHuman("B")).s.players[1];
    t.connected.add(a.id).add(b.id);
    t.act((g) => g.updateSettings(a.id, { rounds: 1 }));
    t.act((g) => g.start(a.id));
    t.run(() => t.s.phase === "playing");
    // Nobody steers: the first into a wall loses, unless they meet head-on.
    t.run(() => t.s.phase !== "playing");
    expect(t.s.phase).toBe("roundover");
    const winner = t.s.players.find((p) => p.id === t.s.roundWinnerId);
    if (winner) expect(winner.score).toBeGreaterThanOrEqual(3 + 1);
    t.run();
    expect(t.s.phase).toBe("gameover");
  });

  it("sits out riders who have gone away, unless that leaves too few", () => {
    const t = setup();
    const a = t.act((g) => g.addHuman("A")).s.players[0];
    const b = t.act((g) => g.addHuman("B")).s.players[1];
    t.connected.add(a.id).add(b.id);
    t.act((g) => g.addCpu(a.id, "normal"));
    t.act((g) => g.start(a.id));
    expect(t.arena!.cycles).toHaveLength(3);

    t.connected.delete(b.id);
    t.act((g) => g.setConnected(b.id, false));
    t.run(() => t.s.round === 2);
    expect(t.arena!.cycles.map((c) => c.id).sort()).toEqual([a.id, t.s.players[2].id].sort());

    // With A gone too there'd be only the CPU, so everyone rides.
    t.connected.delete(a.id);
    t.run(() => t.s.round === 3);
    expect(t.arena!.cycles).toHaveLength(3);
  });

  it("restarts a round whose arena was lost, and resumes a paused one", () => {
    const t = setup();
    const a = t.act((g) => g.addHuman("A")).s.players[0];
    t.connected.add(a.id);
    t.act((g) => g.addCpu(a.id, "normal"));
    t.act((g) => g.start(a.id));
    t.run(() => t.s.phase === "playing");
    t.act((g) => g.tick());

    // Paused with the arena still in memory: count down, then carry on from the same tick.
    const tick = t.arena!.tick;
    t.act((g) => g.recover());
    expect(t.s.phase).toBe("countdown");
    expect(t.arena!.tick).toBe(tick);

    // The room restarted and the arena is gone: replay the round from scratch.
    const fresh = (() => {
      const g = new Game(t.s, { now: () => Date.now(), isConnected: () => true }, null);
      g.recover();
      return g;
    })();
    expect(t.s.round).toBe(1);
    expect(fresh.arena?.tick).toBe(0);
    expect(fresh.outbox.some((m) => m.t === "arena")).toBe(true);
  });
});
