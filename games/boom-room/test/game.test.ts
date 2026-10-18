import { describe, expect, it } from "vitest";
import { applyDelta, type ArenaSnap } from "../src/shared/arena";
import { TICK_MS } from "../src/shared/constants";
import { Game, newGameState, type GameIO, type Live } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io: GameIO = { now: () => now, isConnected: (id) => connected.has(id) };
  /** The round in play, kept between actions the way the room keeps it; and whether every page takes deltas. */
  const room = { live: null as Live | null, deltas: false };
  const game = () => {
    const g = new Game(s, io, room.live, () => room.deltas);
    Object.defineProperty(g, "live", { get: () => room.live, set: (m: Live | null) => (room.live = m) });
    return g;
  };
  return {
    s,
    room,
    game,
    connected,
    advance(ms: number) {
      now += ms;
    },
    /** Play rounds the way the room does: tick the arena, then fire the between-round timer. */
    play(maxMs = 30 * 60 * 1000) {
      for (let t = 0; t < maxMs && s.phase !== "gameover"; t += TICK_MS) {
        now += TICK_MS;
        if (s.phase === "playing" && room.live) game().tick();
        else if (s.timer && now >= s.timer.at) game().onTimer();
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
    expect(t.room.live?.arena.players).toHaveLength(3);
    expect(t.room.live?.arena.cols).toBe(15);

    // The human never moves; the CPUs fight it out (and blow the human up).
    t.play();
    expect(t.s.phase).toBe("gameover");
    const best = Math.max(...t.s.players.map((p) => p.wins));
    expect(best).toBe(2);
    expect(t.s.players.reduce((n, p) => n + p.deaths, 0)).toBeGreaterThan(0);
    expect(t.room.live).toBeNull();
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
    expect(t.room.live?.arena.cols).toBe(19);
    expect(t.room.live?.arena.players).toHaveLength(7);
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
    expect(t.room.live?.arena.player(late.id)).toBeUndefined();

    t.game().setConnected(b.id, false);
    t.connected.delete(b.id);
    t.room.live!.arena.result = { winner: a.id };
    t.game().roundOver();
    expect(t.s.phase).toBe("roundover");
    expect(t.s.players.find((p) => p.id === a.id)!.wins).toBe(1);
    t.advance(10_000);
    t.game().onTimer();
    expect(t.s.phase).toBe("playing");
    expect(t.room.live?.arena.player(b.id)).toBeUndefined();
    expect(t.room.live?.arena.players).toHaveLength(2);
  });

  it("deals the round again if the room forgot it (object restarted)", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    t.room.live = null;
    const g = t.game();
    g.restartRound();
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(1);
    expect((t.room.live as Live | null)?.arena.players).toHaveLength(2);
    expect(g.logs.some((l) => l.text.includes("interrupted"))).toBe(true);
  });

  it("deals the lost round to everyone who was in it, though nobody has reconnected yet", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().addCpu(a.id, "easy");
    t.game().start(a.id);
    // The object restarted: the arena is gone, and the room marks every human offline until they say hello.
    t.room.live = null;
    t.connected.clear();
    for (const p of t.s.players) if (!p.cpu) p.connected = false;
    t.connected.add(a.id);
    const g = t.game();
    g.setConnected(a.id, true);
    g.restartRound();
    expect((t.room.live as Live | null)?.arena.players.map((p) => p.id).sort()).toEqual([a.id, b.id, "p3"].sort());
    expect(t.s.players.every((p) => p.inRound)).toBe(true);
  });

  it("sends a new round's state, then its first frame", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().addCpu(host.id, "easy");
    const g = t.game();
    g.start(host.id);
    expect(g.outbox.map((m) => m.t)).toEqual(["state", "frame"]);
    const [state, frame] = g.outbox;
    expect(state.t === "state" && state.state).toBe(t.s);
    expect(frame.t === "frame" && frame.f.time).toBe(0);

    const tick = t.game();
    tick.tick();
    expect(tick.outbox.map((m) => m.t)).toEqual(["frame"]);
  });

  it("seats someone who came to a full lobby at the start, if a seat has come free", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    const b = t.game().addHuman("B");
    t.connected.add(host.id).add(b.id);
    for (let i = 0; i < 6; i++) t.game().addCpu(host.id, "easy");
    const late = t.game().addHuman("Late");
    t.connected.add(late.id);
    expect(late.spectator).toBe(true);
    t.game().leave(b.id);
    t.connected.delete(b.id);
    t.game().start(host.id);
    const seated = t.s.players.find((p) => p.id === late.id)!;
    expect(seated.spectator).toBe(false);
    expect(seated.inRound).toBe(true);
    expect(t.room.live?.arena.player(late.id)).toBeDefined();
    expect(t.room.live?.arena.players).toHaveLength(8);
  });

  it("sends ticks as deltas only while every page takes them", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().addCpu(host.id, "easy");
    const start = t.game();
    start.start(host.id);
    const first = start.outbox.find((m) => m.t === "frame");
    let seen = first?.t === "frame" ? first.f : null;
    const frames: string[] = [];
    for (let n = 0; n < 200; n++) {
      t.room.deltas = n >= 50 && n < 150;
      const g = t.game();
      g.tick();
      const [msg] = g.outbox;
      frames.push(msg.t);
      if (msg.t === "frame") seen = msg.f;
      if (msg.t === "delta") seen = applyDelta(seen!, msg.f);
      // The snapshot is the arena now, without the tick's events.
      expect({ ...seen!, ev: [] }).toEqual(t.room.live!.arena.snapshot(false));
    }
    expect(frames.slice(0, 50).every((f) => f === "frame")).toBe(true);
    expect(frames.slice(50, 150).every((f) => f === "delta")).toBe(true);
    expect(frames.slice(150).every((f) => f === "frame")).toBe(true);
  });

  it("sends the whole arena to a page that lost track, and the next delta fits it", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    const b = t.game().addHuman("B");
    t.connected.add(host.id).add(b.id);
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    t.room.deltas = true;
    for (let n = 0; n < 100; n++) t.game().tick();
    const g = t.game();
    g.sync(b.id);
    expect(g.direct).toHaveLength(1);
    const { pid, msg } = g.direct[0];
    expect(pid).toBe(b.id);
    expect(msg.t).toBe("frame");
    const tick = t.game();
    tick.tick();
    const [next] = tick.outbox;
    expect(next.t).toBe("delta");
    const caughtUp = applyDelta((msg as { f: ArenaSnap }).f, (next as { f: ArenaSnap }).f);
    // The delta also brings that tick's events (a CPU's bomb, say), which a snapshot that doesn't
    // drain them leaves out. Everything else is the arena as it now stands.
    expect({ ...caughtUp, ev: [] }).toEqual(t.room.live!.arena.snapshot(false));
  });

  it("keeps a player who leaves mid-game in the standings, and drops them from the next round", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    t.game().leave(b.id);
    t.connected.delete(b.id);
    const left = t.s.players.find((p) => p.id === b.id)!;
    expect(left.connected).toBe(false);
    expect(left.inRound).toBe(true);

    t.room.live!.arena.result = { winner: a.id };
    t.game().roundOver();
    t.advance(10_000);
    t.game().onTimer();
    expect(t.s.players.find((p) => p.id === b.id)?.inRound).toBe(false);
    expect(t.room.live?.arena.player(b.id)).toBeUndefined();
  });

  it("goes back to the lobby only from game over, clearing the game", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().updateSettings(host.id, { wins: 1 });
    t.game().addCpu(host.id, "hard");
    t.game().start(host.id);
    expect(() => t.game().backToLobby(host.id)).toThrow();
    t.play();
    expect(t.s.phase).toBe("gameover");
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.round).toBe(0);
    expect(t.s.timer).toBeNull();
    expect(t.room.live).toBeNull();
    expect(t.s.players.some((p) => p.inRound)).toBe(false);
  });
});
