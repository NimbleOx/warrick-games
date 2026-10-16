import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { describe, expect, it } from "vitest";
import { TICK_MS } from "../src/shared/constants";
import { EV_FIRE, type Frame } from "../src/shared/protocol";
import { IN_UP } from "../src/shared/sim";
import { COUNTDOWN_MS, Game, GameError, newGameState, newLive } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const live = newLive();
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io, live);
  const t = {
    s,
    live,
    game,
    connected,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    /** Human joins and connects, as the room's hello does. */
    join(name: string) {
      const p = game().addHuman(name);
      connected.add(p.id);
      game().resetInput(p.id);
      return p;
    },
    /** Fire due timers and step the round, like the room's alarm and tick loop. Returns frames sent. */
    run(maxTicks = 30 * 600, until: () => boolean = () => s.phase === "gameover") {
      const frames: Frame[] = [];
      for (let i = 0; i < maxTicks && !until(); i++) {
        if (s.phase === "playing") {
          now += TICK_MS;
          const g = game();
          g.tick();
          for (const m of g.outbox) if (m.t === "f") frames.push(m);
          if (s.timer && now >= s.timer.at) game().onTimer();
        } else if (s.timer) {
          now = Math.max(now, s.timer.at);
          game().onTimer();
        } else {
          break;
        }
      }
      return frames;
    },
  };
  return t;
}

describe("lobby", () => {
  it("needs two tanks to start", () => {
    const t = setup();
    const host = t.join("Host");
    expect(() => t.game().start(host.id)).toThrow(GameError);
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    expect(t.s.phase).toBe("countdown");
    expect(t.s.round).toBe(1);
    expect(t.s.setup?.tanks).toHaveLength(2);
    expect(t.live.round?.world.tanks.every((x) => x.alive)).toBe(true);
  });

  it("only lets the host change settings, and only to listed values", () => {
    const t = setup();
    const host = t.join("Host");
    const guest = t.join("Guest");
    expect(() => t.game().updateSettings(guest.id, { target: 3 })).toThrow(GameError);
    t.game().updateSettings(host.id, { target: 3, maze: "large" });
    expect(t.s.settings).toEqual({ target: 3, maze: "large" });
    t.game().updateSettings(host.id, { target: 7 });
    expect(t.s.settings.target).toBe(3);
  });

  it("caps the game at eight tanks", () => {
    const t = setup();
    const host = t.join("Host");
    for (let i = 1; i < MAX_PLAYERS; i++) t.game().addCpu(host.id, "easy");
    expect(() => t.game().addCpu(host.id, "easy")).toThrow(/full/);
    expect(t.join("Late").spectator).toBe(true);
  });
});

describe("match", () => {
  it("plays CPUs to the target score and back to the lobby", () => {
    const t = setup();
    const host = t.join("Host");
    t.game().updateSettings(host.id, { target: 3 });
    t.game().addCpu(host.id, "hard");
    t.game().addCpu(host.id, "normal");
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    t.run();
    expect(t.s.phase).toBe("gameover");
    const top = Math.max(...t.s.players.map((p) => p.score));
    expect(top).toBe(3);
    expect(t.s.round).toBeGreaterThanOrEqual(3);
    expect(t.s.players.reduce((n, p) => n + p.kills + p.selfHits, 0)).toBeGreaterThan(0);
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.live.round).toBeNull();
  });

  it("counts down before a round and doesn't move anything until it's over", () => {
    const t = setup();
    const host = t.join("Host");
    t.game().addCpu(host.id, "hard");
    t.game().start(host.id);
    const before = JSON.stringify(t.live.round!.world.tanks);
    t.game().tick();
    expect(JSON.stringify(t.live.round!.world.tanks)).toBe(before);
    t.advance(COUNTDOWN_MS);
    t.game().onTimer();
    expect(t.s.phase).toBe("playing");
  });

  it("drives your tank with your input and reports which input it applied", () => {
    const t = setup();
    const a = t.join("A");
    t.join("B");
    t.game().start(a.id);
    t.run(1, () => t.s.phase === "playing");
    const i = t.s.setup!.tanks.indexOf(a.id);
    const start = { ...t.live.round!.world.tanks[i] };
    t.game().input(a.id, 1, IN_UP, true);
    const frames = t.run(3, () => false);
    const tank = t.live.round!.world.tanks[i];
    expect(Math.hypot(tank.x - start.x, tank.y - start.y)).toBeGreaterThan(0);
    const k = frames[2].k[i] as number[];
    expect(k.slice(4)).toEqual([1, 3]); // input #1, applied for 3 ticks
    expect(frames[0].e?.some((e) => e[0] === EV_FIRE && e[2] === i)).toBe(true);
  });

  it("ignores stale input and fire outside a round", () => {
    const t = setup();
    const a = t.join("A");
    t.join("B");
    t.game().start(a.id);
    t.game().input(a.id, 2, IN_UP, true); // during the countdown: held bits count, the shot doesn't
    t.game().input(a.id, 1, 0, false); // older than what we have
    expect(t.live.inputs.get(a.id)).toMatchObject({ seq: 2, bits: IN_UP });
    expect(t.live.round!.world.tanks.some((x) => x.fire)).toBe(false);
  });

  it("brings mid-match joiners in at the next round", () => {
    const t = setup();
    const host = t.join("Host");
    t.game().addCpu(host.id, "hard");
    t.game().start(host.id);
    const late = t.join("Late");
    expect(late.spectator).toBe(true);
    expect(t.s.setup!.tanks).not.toContain(late.id);
    t.run(30 * 600, () => t.s.round === 2);
    expect(t.s.players.find((p) => p.id === late.id)?.spectator).toBe(false);
    expect(t.s.setup!.tanks).toContain(late.id);
  });

  it("removes a tank whose player leaves, which can end the round", () => {
    const t = setup();
    const a = t.join("A");
    const b = t.join("B");
    t.game().start(a.id);
    t.run(1, () => t.s.phase === "playing");
    t.game().leave(b.id);
    expect(t.s.players.map((p) => p.id)).toEqual([a.id]);
    t.run(30 * 10, () => t.s.phase === "roundover");
    expect(t.s.roundWinnerId).toBe(a.id);
    t.run();
    // Only one tank left: the match can't go on.
    expect(t.s.phase).toBe("gameover");
  });

  it("stops a dropped player's tank and keeps them in if they come back soon", () => {
    const t = setup();
    const a = t.join("A");
    const b = t.join("B");
    t.game().addCpu(a.id, "easy");
    t.game().start(a.id);
    t.game().input(b.id, 1, IN_UP, false);
    t.connected.delete(b.id);
    t.game().setConnected(b.id, false);
    expect(t.live.inputs.get(b.id)?.bits).toBe(0);
    // End the round quickly: everyone but A is out.
    t.run(1, () => t.s.phase === "playing");
    t.live.round!.world.tanks.forEach((k) => (k.alive = k.id === a.id));
    // Away less than the grace period: still gets a tank next round.
    t.run(30 * 60, () => t.s.round === 2);
    expect(t.s.setup!.tanks).toContain(b.id);
    // Away for longer: sits the next one out.
    t.advance(30_000);
    t.live.round!.world.tanks.forEach((k) => (k.alive = k.id === a.id));
    t.run(1, () => t.s.phase === "playing");
    t.run(30 * 60, () => t.s.round === 3);
    expect(t.s.setup!.tanks).not.toContain(b.id);
    expect(t.s.setup!.tanks).toHaveLength(2);
  });

  it("restarts the round after the room loses its memory", () => {
    const t = setup();
    const a = t.join("A");
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    t.run(40, () => false);
    const start = t.s.setup!.start;
    // A deploy: the in-memory round is gone, the saved state says "playing".
    t.live.round = null;
    t.game().recover();
    expect(t.s.phase).toBe("countdown");
    expect(t.live.round!.world.snapshot()).toEqual(start);
  });

  it("keeps players' tanks for a while after a restart, until they come back", () => {
    const t = setup();
    const a = t.join("A");
    const b = t.join("B");
    t.game().addCpu(a.id, "easy");
    t.game().start(a.id);
    t.run(1, () => t.s.phase === "playing");
    // A deploy: the round is gone, and the room finds B's socket gone too.
    t.live.round = null;
    t.s.players.find((p) => p.id === b.id)!.connected = false;
    t.connected.delete(b.id);
    t.game().wake(false);
    expect(t.s.phase).toBe("countdown");
    // A wins the round; B is still in the next one, within the grace period.
    t.run(1, () => t.s.phase === "playing");
    t.live.round!.world.tanks.forEach((k) => (k.alive = k.id === a.id));
    t.run(30 * 60, () => t.s.round === 2);
    expect(t.s.setup!.tanks).toContain(b.id);
  });

  it("resumes a paused round where it was", () => {
    const t = setup();
    const a = t.join("A");
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    t.run(40, () => false);
    const tick = t.live.round!.world.tick;
    const g = t.game();
    g.resume();
    expect(t.s.phase).toBe("countdown");
    expect(t.live.round!.world.tick).toBe(tick);
    expect(g.outbox.some((m) => m.t === "round")).toBe(true);
  });
});
