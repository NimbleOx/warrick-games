import { describe, expect, it } from "vitest";
import { COUNTDOWN_MS, MAX_PLAYERS, ROUNDOVER_MS } from "../src/shared/constants";
import type { FrameMsg, RoundSnapshot } from "../src/shared/protocol";
import { mulberry32 } from "../src/shared/rng";
import { Round } from "../src/shared/sim";
import { Game, GameError, newGameState, snapshot, type Live } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const rng = mulberry32(42);
  let live: Live | null = null;
  /** Everything the game broadcast, in order. */
  const sent: Game["outbox"] = [];
  const logs: string[] = [];
  const act = <T>(fn: (g: Game) => T): T => {
    const g = new Game(s, io, live, rng);
    const out = fn(g);
    live = g.live;
    sent.push(...g.outbox);
    logs.push(...g.logs.map((l) => l.text));
    return out;
  };
  const t = {
    s,
    connected,
    sent,
    logs,
    act,
    get live() {
      return live;
    },
    human(name: string) {
      const p = act((g) => g.addHuman(name));
      connected.add(p.id);
      return p;
    },
    advance(ms: number) {
      now += ms;
    },
    /** Fire the pending timer, if any. */
    timer() {
      if (!s.timer) return false;
      now = Math.max(now, s.timer.at);
      act((g) => g.onTimer());
      return true;
    },
    /** Tick until the round ends (or `max` ticks). */
    ride(max = 100_000) {
      for (let i = 0; i < max && s.phase === "playing"; i++) act((g) => g.tick());
    },
    /** Play rounds until the match is over. */
    playMatch(maxRounds = 500) {
      for (let r = 0; r < maxRounds && s.phase !== "gameover"; r++) {
        if (s.phase === "countdown" || s.phase === "roundover") t.timer();
        if (s.phase === "playing") t.ride();
      }
    },
  };
  return t;
}

describe("lobby", () => {
  it("makes the first player host and lets the host add CPUs and change settings", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    expect(t.s.hostId).toBe(host.id);
    t.act((g) => g.addCpu(host.id, "hard"));
    expect(t.s.players).toHaveLength(3);
    expect(() => t.act((g) => g.addCpu(guest.id, "easy"))).toThrow(GameError);
    t.act((g) => g.updateSettings(host.id, { target: 20, speed: "fast" }));
    expect(t.s.settings).toEqual({ target: 20, speed: "fast" });
    // Values that aren't on the menu are ignored.
    t.act((g) => g.updateSettings(host.id, { target: 7, speed: "warp" as never }));
    expect(t.s.settings).toEqual({ target: 20, speed: "fast" });
  });

  it("caps the game at 8 players and seats the rest as spectators", () => {
    const t = setup();
    const host = t.human("Host");
    for (let i = 1; i < MAX_PLAYERS; i++) t.act((g) => g.addCpu(host.id, "easy"));
    expect(() => t.act((g) => g.addCpu(host.id, "easy"))).toThrow(/full/);
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
  });

  it("needs two players to start", () => {
    const t = setup();
    const host = t.human("Host");
    expect(() => t.act((g) => g.start(host.id))).toThrow(/two players/);
  });

  it("lets someone else take over if the host drops", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    t.connected.delete(host.id);
    t.act((g) => g.addCpu(guest.id, "normal"));
    expect(t.s.hostId).toBe(guest.id);
  });
});

describe("rounds", () => {
  it("counts down, then plays, sending a frame every tick", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("countdown");
    expect(t.s.round).toBe(1);
    expect(t.s.target).toBe(10);
    expect(t.s.phaseDeadline! - 1_000_000).toBe(COUNTDOWN_MS);
    const snap = t.sent.find((m) => m.t === "round") as { round: RoundSnapshot };
    expect(snap.round.ids.sort()).toEqual(t.s.players.map((p) => p.id).sort());

    // Steering during the countdown is held for tick 0.
    t.act((g) => g.steer(host.id, -1));
    t.act((g) => g.tick());
    expect(t.sent.filter((m) => m.t === "f")).toHaveLength(0);
    t.timer();
    expect(t.s.phase).toBe("playing");
    t.act((g) => g.tick());
    const slot = t.live!.round.index(host.id);
    const frames = t.sent.filter((m): m is FrameMsg => m.t === "f");
    expect(frames).toHaveLength(1);
    expect(frames[0].n).toBe(0);
    expect(frames[0].i).toContainEqual([slot, -1]);
  });

  it("ignores bad steering and steering from spectators", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    const watcher = t.human("Watcher");
    t.act((g) => g.steer(host.id, 5));
    t.act((g) => g.steer(host.id, "left"));
    t.act((g) => g.steer(watcher.id, 1));
    expect(t.live!.inputs).toEqual([]);
  });

  it("keeps one input per head per tick", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    t.act((g) => g.steer(host.id, -1));
    t.act((g) => g.steer(host.id, 1));
    t.act((g) => g.steer(host.id, -1));
    expect(t.live!.inputs).toEqual([[0, t.live!.round.index(host.id), -1]]);
  });

  it("lets clients rebuild the round exactly from the snapshot and frames", () => {
    const t = setup();
    const host = t.human("Host");
    for (const level of ["easy", "normal", "hard"] as const) t.act((g) => g.addCpu(host.id, level));
    t.act((g) => g.start(host.id));
    t.timer();
    for (let i = 0; i < 300 && t.s.phase === "playing"; i++) {
      if (i % 7 === 0) t.act((g) => g.steer(host.id, ((i / 7) % 3) - 1));
      t.act((g) => g.tick());
    }
    // A client that joined at the start, stepping with every frame.
    const snap = (t.sent.find((m) => m.t === "round") as { round: RoundSnapshot }).round;
    const client = Round.replay(snap, snap.inputs, snap.tick);
    for (const m of t.sent) {
      if (m.t !== "f") continue;
      expect(m.n).toBe(client.tick);
      for (const [slot, s] of m.i ?? []) client.setSteer(slot, s);
      const deaths = client.step();
      expect(deaths.map((d) => d.slot)).toEqual(m.d ?? []);
      if (m.c !== undefined) expect(client.checksum()).toBe(m.c);
    }
    // A client that joins now, from a fresh snapshot.
    const late = snapshot(t.live!);
    const rebuilt = Round.replay(late, late.inputs, late.tick);
    expect(rebuilt.checksum()).toBe(t.live!.round.checksum());
    expect(client.checksum()).toBe(t.live!.round.checksum());
  });
});

describe("scoring", () => {
  it("gives every survivor a point per death and ends at the target with a 2-point lead", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.updateSettings(host.id, { target: 5 }));
    t.act((g) => g.start(host.id));
    expect(t.s.target).toBe(5);

    // One round: the human never steers and goes out first.
    t.timer();
    const heads = t.live!.round.heads;
    t.ride();
    expect(t.s.phase).toBe("roundover");
    const winner = heads.find((h) => h.alive);
    expect(t.s.roundWinnerId).toBe(winner?.id ?? null);
    // In a 3-player round a lone survivor outlasted two others.
    if (winner) expect(t.s.players.find((p) => p.id === winner.id)!.score).toBe(2);
    expect(t.s.players.reduce((sum, p) => sum + p.score, 0)).toBe(heads.reduce((sum, h) => sum + h.points, 0));
    expect(Math.max(...t.s.players.map((p) => p.score))).toBeGreaterThan(0);

    t.playMatch();
    expect(t.s.phase).toBe("gameover");
    const ranked = [...t.s.players].sort((a, b) => b.score - a.score);
    expect(ranked[0].id).toBe(t.s.winnerId);
    expect(ranked[0].score).toBeGreaterThanOrEqual(5);
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(2);
    expect(t.logs.some((l) => l.includes("wins the match"))).toBe(true);
  });

  it("keeps playing at the target until someone leads by 2", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.start(host.id));
    const cpu = t.s.players.find((p) => p.cpu)!;
    // Rig the scores: 10–9 after a round is not enough.
    t.s.players.find((p) => p.id === host.id)!.score = 9;
    cpu.score = 9;
    t.timer();
    t.ride();
    const [a, b] = [...t.s.players].sort((x, y) => y.score - x.score);
    expect(a.score).toBe(10);
    expect(b.score).toBe(9);
    expect(t.s.winnerId).toBeNull();
    expect(t.logs.some((l) => l.includes("Match point"))).toBe(true);
    t.advance(ROUNDOVER_MS);
    t.timer();
    expect(t.s.phase).toBe("countdown");
    expect(t.s.round).toBe(2);
  });

  it("sets the default target from the number of players", () => {
    const t = setup();
    const host = t.human("Host");
    for (let i = 0; i < 3; i++) t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    expect(t.s.target).toBe(30);
  });
});

describe("dropping out and coming back", () => {
  it("releases a player's steering when they disconnect", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    t.timer();
    t.act((g) => g.steer(host.id, 1));
    t.connected.delete(host.id);
    t.act((g) => g.setConnected(host.id, false));
    expect(t.live!.round.heads[t.live!.round.index(host.id)].steer).toBe(0);
  });

  it("resumes a paused round with a countdown", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    t.timer();
    for (let i = 0; i < 10; i++) t.act((g) => g.tick());
    const tick = t.live!.round.tick;
    t.act((g) => g.recover());
    expect(t.s.phase).toBe("countdown");
    expect(t.live!.round.tick).toBe(tick);
    expect(t.logs.at(-1)).toMatch(/Resuming round 1/);
  });

  it("doesn't count down again for a round only CPUs are left in", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.start(host.id));
    t.timer();
    const me = t.live!.round.heads[t.live!.round.index(host.id)];
    me.alive = false;
    expect(t.act((g) => g.onlyCpusLeft)).toBe(true);
    t.act((g) => g.recover());
    expect(t.s.phase).toBe("playing");
  });

  it("restarts a round that was lost when the room restarted, without changing scores", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    t.timer();
    t.ride();
    t.timer(); // round 2 countdown
    t.timer(); // round 2 playing
    const scores = t.s.players.map((p) => p.score);
    // The room restarts: stored state is kept, the live round is gone.
    const g = new Game(t.s, { now: () => 2_000_000, isConnected: () => true }, null, mulberry32(1));
    g.recover();
    expect(t.s.phase).toBe("countdown");
    expect(t.s.round).toBe(2);
    expect(g.live?.round.tick).toBe(0);
    expect(t.s.players.map((p) => p.score)).toEqual(scores);
    expect(g.logs.map((l) => l.text)).toContain("Round 2 was interrupted. Restarting it.");
  });

  it("sits out players who aren't connected when a round starts", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    t.connected.delete(guest.id);
    t.act((g) => g.setConnected(guest.id, false));
    t.timer();
    t.ride();
    t.timer();
    expect(t.live!.round.index(guest.id)).toBe(-1);
    expect(t.live!.round.heads).toHaveLength(2);
  });

  it("goes back to the lobby after the match and seats spectators", () => {
    const t = setup();
    const host = t.human("Host");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.updateSettings(host.id, { target: 5 }));
    t.act((g) => g.start(host.id));
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
    t.playMatch();
    expect(t.s.phase).toBe("gameover");
    t.act((g) => g.backToLobby(host.id));
    expect(t.s.phase).toBe("lobby");
    expect(t.live).toBeNull();
    expect(t.s.players.find((p) => p.id === late.id)!.spectator).toBe(false);
  });
});
