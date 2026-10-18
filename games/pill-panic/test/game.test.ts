import { describe, expect, it } from "vitest";
import { newBrain, think } from "../src/shared/ai";
import { Bottle } from "../src/shared/bottle";
import { COUNTDOWN_MS, INTERMISSION_MS, LOOP_MS, TICK_MS, virusCount } from "../src/shared/constants";
import type { Frame, KeyEntry, RoundSnap, ServerMsg } from "../src/shared/protocol";
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
  it("makes the first human the host, who starts a match with a CPU", () => {
    const t = setup();
    const host = t.human("Ann");
    expect(t.s.hostId).toBe(host.id);
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toMatchObject({ n: 1, level: 5, over: null });
    const snap = snaps(t.sent).at(-1)!.snap;
    expect(snap.who.slice(0, 2)).toEqual([host.id, t.s.players[1].id]);
    expect(snap.goAt).toBe(t.s.round!.goAt);
    expect(snap.lanes).toHaveLength(2);
    expect(t.s.solo).toBe(false);
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

/** A player's browser: plays its own bottle with a hard CPU's brain and sends the server its inputs, like the client. */
function browser(t: ReturnType<typeof setup>, pid: string) {
  const brain = newBrain("hard", 7);
  let b: Bottle;
  let e = 0;
  let mask = 0;
  let keys: KeyEntry[] = [];
  let seen = 0;
  const adopt = () => {
    const snap = snaps(t.sent).at(-1)!.snap;
    const lane = snap.lanes.find((l) => snap.who[l.s] === pid)!;
    b = Bottle.restore(lane.b);
    e = lane.e;
    mask = b.prevMask;
    keys = [];
    seen = t.sent.length;
  };
  adopt();
  return {
    adopt,
    get bottle() {
      return b;
    },
    /** Catch up with the clock and tell the server, then let the room's loop run. */
    step() {
      for (const m of t.sent.slice(seen)) {
        for (const fx of m.t === "f" ? ((m as Frame).fx ?? []) : [])
          if (t.s.players.find((p) => p.id === pid)?.slot === fx.s) {
            b = Bottle.restore(fx.b);
            e = fx.e;
            mask = b.prevMask;
            keys = [];
          }
      }
      seen = t.sent.length;
      const wall = Math.floor((t.now - t.s.round!.goAt) / TICK_MS);
      while (b.tick < wall && !b.done) {
        const m = think(b, brain);
        if (m !== mask) keys.push([b.tick, (mask = m)]);
        b.step(m);
        b.events = [];
      }
      t.act((g) => g.feed(pid, { t: "in", e, n: b.tick, k: keys }));
      keys = [];
      t.run(LOOP_MS);
    },
  };
}

describe("solo", () => {
  it("goes up a level each time the bottle is cleared, until the player tops out", () => {
    const t = setup();
    const ann = t.human("Ann");
    t.act((g) => g.updateSettings(ann.id, { level: 0, speed: "hi", wins: 1 }));
    t.act((g) => g.start(ann.id));
    expect(t.s.solo).toBe(true);
    expect(t.s.round).toMatchObject({ n: 1, level: 0 });
    expect(snaps(t.sent).at(-1)!.snap.lanes).toHaveLength(1);

    // Level 0: four germs. Clearing them is the round, but not the run (whatever "first to" says).
    const me = browser(t, ann.id);
    for (let i = 0; i < 4000 && !t.s.round!.over; i++) me.step();
    expect(t.s.round!.over).toMatchObject({ winners: [ann.id], how: "cleared" });
    expect(t.s.phase).toBe("playing");
    expect(t.s.round!.nextAt).not.toBeNull();
    const p = () => t.s.players.find((x) => x.id === ann.id)!;
    expect(p()).toMatchObject({ wins: 1, cleared: virusCount(0), trophies: 0 });
    expect(p().score).toBeGreaterThanOrEqual(virusCount(0) * 300);
    expect(p().score).toBe(me.bottle.score);
    const firstScore = p().score!;

    // Then level 1, with eight.
    t.run(INTERMISSION_MS + LOOP_MS);
    expect(t.s.round).toMatchObject({ n: 2, level: 1, over: null });
    me.adopt();
    expect(me.bottle.viruses).toBe(virusCount(1));
    for (let i = 0; i < 6000 && !t.s.round!.over; i++) me.step();
    expect(t.s.round!.over?.winners).toEqual([ann.id]);
    t.run(INTERMISSION_MS + LOOP_MS);
    expect(t.s.round).toMatchObject({ n: 3, level: 2 });

    // Someone arriving now watches the run, and doesn't get a bottle at the next level.
    const cat = t.human("Cat");
    expect(cat.spectator).toBe(true);

    // Ann's browser goes quiet: her capsules drop by themselves and she tops out.
    t.connected.delete(ann.id);
    t.run(10 * 60_000, () => t.s.phase === "results");
    expect(t.s.phase).toBe("results");
    const r = t.s.results!;
    expect(r).toMatchObject({ solo: true, winnerId: null, level: 2, rounds: 3 });
    expect(r.standings).toHaveLength(1);
    expect(r.standings[0]).toMatchObject({ id: ann.id, wins: 2, cleared: virusCount(0) + virusCount(1) });
    expect(r.standings[0].score).toBe(p().score);
    expect(p().score).toBeGreaterThan(firstScore);
    expect(p().trophies).toBe(0);
    expect(t.s.players.find((x) => x.id === cat.id)!.slot).toBe(-1);
    expect(t.live).toBeNull();

    // Back in the lobby it's not solo any more, and the watcher gets a seat.
    t.act((g) => g.backToLobby(ann.id));
    expect(t.s.solo).toBe(false);
    expect(t.s.players.find((x) => x.id === cat.id)!.spectator).toBe(false);
  });

  it("ends the run when the solo player leaves", () => {
    const t = setup();
    const ann = t.human("Ann");
    const cat = t.human("Cat");
    t.act((g) => g.kick(ann.id, cat.id));
    t.act((g) => g.start(ann.id));
    expect(t.s.solo).toBe(true);
    const bo = t.human("Bo");
    expect(bo.spectator).toBe(true);
    t.run(COUNTDOWN_MS + 500);
    t.act((g) => g.leave(ann.id));
    t.run(2000, () => t.s.phase === "results");
    expect(t.s.results).toMatchObject({ solo: true, winnerId: null, standings: [] });
  });
});
