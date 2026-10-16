import { describe, expect, it } from "vitest";
import { applyFrame, Battle, type Frame } from "../src/shared/battle";
import { COUNTDOWN_TICKS } from "../src/shared/constants";
import type { ServerMsg, Snapshot } from "../src/shared/protocol";
import { Game, GameError, newGameState, type Live } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  let live: Live | null = null;
  const sent: ServerMsg[] = [];
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  /** Like the Durable Object: a fresh Game per action, with the live round carried over. */
  const act = <T>(fn: (g: Game) => T): T => {
    const g = new Game(s, io, live);
    const out = fn(g);
    live = g.live;
    sent.push(...g.outbox);
    return out;
  };
  const human = (name: string) => {
    const p = act((g) => g.addHuman(name));
    connected.add(p.id);
    return p;
  };
  return {
    s,
    act,
    human,
    sent,
    get live() {
      return live;
    },
    forget() {
      live = null;
    },
    advance(ms: number) {
      now += ms;
    },
    tick(n = 1) {
      for (let i = 0; i < n && s.phase === "playing"; i++) act((g) => g.tick());
    },
  };
}

const frames = (sent: ServerMsg[]) => sent.filter((m): m is Frame => m.t === "f");

describe("a round", () => {
  it("needs two players, then starts with a fresh map and a snapshot", () => {
    const t = setup();
    const host = t.human("Ann");
    expect(() => t.act((g) => g.start(host.id))).toThrow(GameError);
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("playing");
    const snap = t.sent.find((m) => m.t === "snap");
    expect(snap).toBeTruthy();
    expect(t.live!.battle.bases.filter((b) => b.owner >= 0).length).toBe(2);
  });

  it("checks a send when it arrives, and carries it out on the next tick", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    const battle = t.live!.battle;
    const mine = battle.seat[t.s.players[0].slot];
    expect(() => t.act((g) => g.send(host.id, [mine], battle.map.adj[mine][0], 50))).toThrow("Wait for GO");
    t.tick(COUNTDOWN_TICKS);
    expect(() => t.act((g) => g.send(host.id, [mine], mine, 50))).toThrow(GameError);
    expect(() => t.act((g) => g.send(host.id, [mine], battle.map.adj[mine][0], 33))).toThrow("not a move");
    t.act((g) => g.send(host.id, [mine], battle.map.adj[mine][0], 50));
    expect(battle.groups.length).toBe(0);
    t.tick();
    expect(battle.groups.some((g) => g.owner === 0)).toBe(true);
    const last = frames(t.sent).at(-1)!;
    expect(last.c?.[0]).toEqual(["s", 0, [mine], battle.map.adj[mine][0], 50]);
  });

  it("only lets players in the round give orders", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
    expect(() => t.act((g) => g.send(late.id, [0], 1, 50))).toThrow("not in this round");
  });

  it("keeps a client that follows the frames in step, CPU orders and all", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    const snap = (t.sent.find((m) => m.t === "snap") as { snap: Snapshot }).snap;
    const client = Battle.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    const seen = t.sent.length;
    t.tick(600);
    for (const f of frames(t.sent.slice(seen))) {
      expect(applyFrame(client, JSON.parse(JSON.stringify(f)))).not.toBeNull();
      if (f.ck !== undefined) expect(client.checksum()).toBe(f.ck);
    }
    expect(frames(t.sent).some((f) => f.c?.length)).toBe(true);
    expect(client.checksum()).toBe(t.live!.battle.checksum());
  });

  it("plays to a result, with standings, a winner and a win", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.updateSettings(host.id, { minutes: 5, map: "small" }));
    t.act((g) => g.start(host.id));
    // Ann does nothing; the CPUs fight it out.
    t.tick(5 * 60 * 10 + COUNTDOWN_TICKS + 5);
    expect(t.s.phase).toBe("results");
    const r = t.s.results!;
    expect(r.standings.length).toBe(3);
    expect(r.standings.map((x) => x.name)).toContain("Ann");
    if (r.winnerId) expect(t.s.players.find((p) => p.id === r.winnerId)!.wins).toBe(1);
    expect(t.s.players.every((p) => p.slot === -1)).toBe(true);
    expect(t.live).toBeNull();
    t.act((g) => g.backToLobby(host.id));
    expect(t.s.phase).toBe("lobby");
    expect(t.s.results).toBeNull();
  });

  it("makes a leaving player's bases neutral", () => {
    const t = setup();
    const host = t.human("Ann");
    const bo = t.human("Bo");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    const slot = t.s.players.find((p) => p.id === bo.id)!.slot;
    const base = t.live!.battle.seat[slot];
    t.act((g) => g.leave(bo.id));
    expect(t.live!.battle.bases[base].owner).toBe(-1);
    expect(t.s.phase).toBe("playing");
  });

  it("starts the round over if the battle was lost to a restart", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.forget();
    t.act((g) => g.recover());
    expect(t.live).not.toBeNull();
    expect(t.live!.battle.n).toBe(0);
  });
});
