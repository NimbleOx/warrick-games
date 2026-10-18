import { describe, expect, it } from "vitest";
import { COUNTDOWN_MS, INTERMISSION_MS, LOOP_MS } from "../src/shared/constants";
import type { RoundSnap, ServerMsg } from "../src/shared/protocol";
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
  /** Run the room's loop for a while. */
  const run = (ms: number, until: () => boolean = () => false) => {
    for (let t = 0; t < ms && !until(); t += LOOP_MS) {
      now += LOOP_MS;
      act((g) => g.tick());
    }
  };
  return {
    s,
    act,
    human,
    run,
    connected,
    sent,
    get live() {
      return live;
    },
    forget() {
      live = null;
    },
    get now() {
      return now;
    },
  };
}

const snaps = (sent: ServerMsg[]) => sent.filter((m): m is { t: "snap"; snap: RoundSnap } => m.t === "snap");

describe("lobby", () => {
  it("makes the first human the host and needs two players to start", () => {
    const t = setup();
    const host = t.human("Ann");
    expect(t.s.hostId).toBe(host.id);
    expect(() => t.act((g) => g.start(host.id))).toThrow(GameError);
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toMatchObject({ n: 1, level: 5, over: null });
    const snap = snaps(t.sent).at(-1)!.snap;
    expect(snap.who.slice(0, 2)).toEqual([host.id, t.s.players[1].id]);
    expect(snap.goAt).toBe(t.s.round!.goAt);
    expect(snap.lanes).toHaveLength(2);
  });

  it("only lets the host change settings, and only to listed values", () => {
    const t = setup();
    const host = t.human("Ann");
    const bob = t.human("Bob");
    expect(() => t.act((g) => g.updateSettings(bob.id, { level: 3 }))).toThrow(GameError);
    t.act((g) => g.updateSettings(host.id, { level: 99, speed: "hi", wins: 2, aim: "all" }));
    expect(t.s.settings).toEqual({ level: 5, speed: "hi", wins: 2, aim: "all" });
  });

  it("caps the game at eight players and seats the rest as spectators", () => {
    const t = setup();
    const host = t.human("Ann");
    for (let i = 0; i < 7; i++) t.act((g) => g.addCpu(host.id, "easy"));
    expect(() => t.act((g) => g.addCpu(host.id, "easy"))).toThrow(GameError);
    expect(t.human("Late").spectator).toBe(true);
  });
});

describe("a match", () => {
  it("plays rounds until someone reaches the target, then shows results", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.updateSettings(host.id, { level: 0, speed: "hi", wins: 2 }));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    // Ann's browser goes quiet: the server drops her capsules for her and she tops out.
    t.connected.delete(host.id);
    t.run(15 * 60_000, () => t.s.phase === "results");
    expect(t.s.phase).toBe("results");
    const r = t.s.results!;
    const winner = t.s.players.find((p) => p.id === r.winnerId)!;
    expect(winner.cpu).not.toBeNull();
    expect(winner.wins).toBe(2);
    expect(winner.trophies).toBe(1);
    expect(r.standings[0].id).toBe(winner.id);
    expect(r.rounds).toBeGreaterThanOrEqual(2);
    // Every round started with a countdown and its own seed.
    const seeds = new Set(snaps(t.sent).map((m) => m.snap.lanes[0].b.seed));
    expect(seeds.size).toBe(r.rounds);
    expect(t.live).toBeNull();
  });

  it("waits between rounds, then starts the next one", () => {
    const t = setup();
    const host = t.human("Ann");
    t.act((g) => g.updateSettings(host.id, { level: 0, wins: 3 }));
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.start(host.id));
    t.connected.delete(host.id);
    t.run(10 * 60_000, () => !!t.s.round?.over);
    const r = t.s.round!;
    expect(r.over).not.toBeNull();
    expect(r.nextAt).toBe(t.now + INTERMISSION_MS);
    t.connected.add(host.id);
    t.run(INTERMISSION_MS - LOOP_MS);
    expect(t.s.round!.n).toBe(1);
    t.run(LOOP_MS * 2);
    expect(t.s.round).toMatchObject({ n: 2, over: null });
    expect(t.s.round!.goAt).toBeGreaterThan(t.now + COUNTDOWN_MS - 200);
  });

  it("gives the round to the other player when one leaves", () => {
    const t = setup();
    const ann = t.human("Ann");
    const bob = t.human("Bob");
    t.act((g) => g.start(ann.id));
    t.run(COUNTDOWN_MS + 500);
    t.act((g) => g.leave(bob.id));
    t.run(3000, () => !!t.s.round?.over);
    expect(t.s.round!.over).toMatchObject({ winners: [ann.id], how: "survived" });
  });

  it("starts the round over if the room restarted and lost it", () => {
    const t = setup();
    const ann = t.human("Ann");
    t.act((g) => g.addCpu(ann.id, "easy"));
    t.act((g) => g.start(ann.id));
    t.run(COUNTDOWN_MS + 2000);
    t.forget();
    const before = snaps(t.sent).length;
    t.act((g) => g.recover());
    expect(t.s.round!.n).toBe(1);
    expect(snaps(t.sent).length).toBe(before + 1);
    expect(t.live).not.toBeNull();
  });

  it("seats players who join mid-match from the next round", () => {
    const t = setup();
    const ann = t.human("Ann");
    t.act((g) => g.updateSettings(ann.id, { level: 0, wins: 3 }));
    t.act((g) => g.addCpu(ann.id, "hard"));
    t.act((g) => g.start(ann.id));
    const cat = t.human("Cat");
    expect(cat.slot).toBe(-1);
    expect(cat.spectator).toBe(false);
    t.connected.delete(ann.id);
    t.act((g) => g.setConnected(ann.id, false));
    t.run(10 * 60_000, () => (t.s.round?.n ?? 0) >= 2);
    expect(t.s.players.find((p) => p.id === cat.id)!.slot).toBeGreaterThanOrEqual(0);
    // Ann is offline, so she sits this one out.
    expect(t.s.players.find((p) => p.id === ann.id)!.slot).toBe(-1);
  });

  it("doesn't change settings or players during a match", () => {
    const t = setup();
    const ann = t.human("Ann");
    const bob = t.human("Bob");
    t.act((g) => g.start(ann.id));
    expect(() => t.act((g) => g.updateSettings(ann.id, { level: 1 }))).toThrow(GameError);
    expect(() => t.act((g) => g.kick(ann.id, bob.id))).toThrow(GameError);
    expect(() => t.act((g) => g.addCpu(ann.id, "easy"))).toThrow(GameError);
  });
});
