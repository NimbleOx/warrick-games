import { describe, expect, it } from "vitest";
import { Game, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io);
  return {
    s, game, connected,
    advance(ms: number) { now += ms; },
    runTimers(max = 2000) {
      for (let i = 0; i < max && s.timer; i++) {
        now = Math.max(now, s.timer.at);
        game().onTimer();
        if (s.phase === "shop") {
          for (const p of s.players) if (!p.cpu) game().setReady(p.id, true);
        }
        if (s.phase === "gameover") return;
      }
    },
  };
}

describe("game flow", () => {
  it("plays a full CPU match to game over", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().updateSettings(host.id, { rounds: 2, turnSeconds: 30 });
    t.game().addCpu(host.id, "hard");
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    // Starting cash means a shopping trip before round 1; CPUs spend theirs.
    expect(t.s.phase).toBe("shop");
    expect(t.s.round).toBe(0);
    expect(t.s.players.filter((p) => p.cpu).some((p) => Object.keys(p.inventory).length > 0)).toBe(true);
    t.game().setReady(host.id, true);
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(1);
    expect(t.s.terrain).toHaveLength(1200);

    // The human never fires, so their turns time out; the CPUs fight it out.
    t.runTimers();
    expect(t.s.phase).toBe("gameover");
    expect(t.s.round).toBe(2);
    expect(t.s.shotCount).toBeGreaterThan(0);
  });

  it("only lets the current player fire", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().updateSettings(a.id, { startCash: 0 });
    t.game().start(a.id);
    expect(t.s.phase).toBe("playing"); // no cash, no pre-game shop
    const current = t.s.turnPlayerId!;
    const other = current === a.id ? b.id : a.id;
    expect(() => t.game().fire(other, { angle: 45, power: 500, weapon: "baby_missile" })).toThrow();
    const g = t.game();
    g.fire(current, { angle: 45, power: 500, weapon: "baby_missile" });
    expect(g.outbox[0].t).toBe("shot");
    expect(t.s.resolving).toBe(true);
  });

  it("a nearly dead tank can still fire a real distance", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().updateSettings(a.id, { startCash: 0 });
    t.game().start(a.id);
    const shooter = t.s.players.find((p) => p.id === t.s.turnPlayerId)!;
    shooter.tank!.health = 2;
    const g = t.game();
    g.fire(shooter.id, { angle: 45, power: 1000, weapon: "baby_missile" });
    const shot = g.outbox[0] as { t: "shot"; shot: { power: number } };
    expect(shot.shot.power).toBe(412);
  });

  it("joining mid-game makes you a spectator", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    t.connected.add(a.id);
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    const late = t.game().addHuman("Late");
    expect(late.spectator).toBe(true);
    expect(late.tank).toBeNull();
  });
});
