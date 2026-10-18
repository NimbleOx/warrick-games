import { describe, expect, it } from "vitest";
import { choose } from "../src/shared/ai";
import { COUNTDOWN_MS, TICK_MS } from "../src/shared/constants";
import { Lane } from "../src/shared/engine";
import { attackScale, gravityMs, levelAt, type Frame, type GameState, type Op, type ServerMsg } from "../src/shared/protocol";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { Game, GameError, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const state: GameState = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  let live: Game["live"] = null;
  const sent: ServerMsg[] = [];
  const direct: { pid: string; msg: ServerMsg }[] = [];
  const act = <T>(fn: (g: Game) => T): T => {
    const g = new Game(state, io, live);
    const out = fn(g);
    live = g.live;
    sent.push(...g.outbox);
    direct.push(...g.direct);
    return out;
  };
  return {
    state,
    act,
    sent,
    direct,
    connect: (id: string) => connected.add(id),
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
    get live() {
      return live;
    },
  };
}

const ops = (msgs: ServerMsg[]): Op[] => msgs.filter((m): m is Frame => m.t === "f").flatMap((m) => m.o);

describe("speed", () => {
  it("speeds up, then multiplies garbage", () => {
    expect(levelAt("normal", 0)).toBe(3);
    expect(levelAt("normal", 61_000)).toBe(5);
    expect(levelAt("normal", 3_600_000)).toBe(15);
    expect(gravityMs(1)).toBe(1000);
    expect(gravityMs(15)).toBeLessThan(10);
    expect(attackScale("normal", 89_000)).toBe(1);
    expect(attackScale("normal", 90_000)).toBe(1.5);
    expect(attackScale("normal", 121_000)).toBe(2);
    expect(attackScale("normal", 3_600_000)).toBe(4);
  });
});

describe("lobby", () => {
  it("needs two players to start", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    expect(() => t.act((g) => g.start(host.id))).toThrow(GameError);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    expect(t.state.phase).toBe("playing");
    expect(t.sent.some((m) => m.t === "snap")).toBe(true);
  });

  it("makes anyone arriving mid-round a spectator", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    const late = t.act((g) => g.addHuman("Bo"));
    expect(late.spectator).toBe(true);
    expect(late.slot).toBe(-1);
  });
});

describe("rounds", () => {
  it("CPUs play a round to the end and someone wins", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.addCpu(host.id, "normal"));
    t.act((g) => g.start(host.id));
    // The host just sits there: their pieces get dropped for them once they hang too long.
    for (let i = 0; i < 20000 && t.state.phase === "playing"; i++) {
      t.advance(TICK_MS * 4);
      t.act((g) => g.tick());
    }
    expect(t.state.phase).toBe("results");
    const r = t.state.results!;
    expect(r.standings).toHaveLength(4);
    expect(r.standings.map((s) => s.place).sort()).toEqual([1, 2, 3, 4]);
    expect(r.winnerId).toBe(r.standings[0].id);
    const all = ops(t.sent);
    expect(all.some((o) => o.k === "g")).toBe(true);
    expect(all.filter((o) => o.k === "ko")).toHaveLength(3);
  });

  it("replays a player's locks and routes their garbage", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const snap = t.live!.round.snapshot(1, []);
    const mine = Lane.fromSnap(snap.seats[0]!);
    const rng = mulberry32(5);
    for (let i = 0; i < 40; i++) {
      const pl = choose(mine, "hard", rng, 0)!;
      mine.lock(pl, 0);
      t.act((g) => g.lock(host.id, { e: 0, k: i, pl, g: 0, ck: mine.checksum() }));
      t.advance(100);
    }
    expect(t.direct).toHaveLength(0); // never overruled
    expect(t.live!.round.seat(0)!.lane.checksum()).toBe(mine.checksum());
    const sentTo = ops(t.sent).filter((o) => o.k === "g" && o.from === 0);
    expect(sentTo.reduce((n, o) => n + (o.k === "g" ? o.lines : 0), 0)).toBe(mine.sent);
  });

  it("overrules an impossible placement and ignores locks from before", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const piece = t.live!.round.seat(0)!.lane.current;
    // Floating in mid-air.
    t.act((g) => g.lock(host.id, { e: 0, k: 0, pl: { piece, r: 0, x: 3, y: 10, hold: false, spin: 0 }, g: 0, ck: 0 }));
    expect(t.direct).toHaveLength(1);
    expect(t.direct[0].msg.t).toBe("fix");
    expect(t.live!.round.seat(0)!.e).toBe(1);
    expect(t.live!.round.seat(0)!.lane.pc).toBe(0);
    // A lock still on the old epoch is dropped without another correction.
    const lane = t.live!.round.seat(0)!.lane;
    const pl = choose(lane, "easy", mulberry32(1), 0)!;
    t.act((g) => g.lock(host.id, { e: 0, k: 0, pl, g: 0, ck: 0 }));
    expect(t.direct).toHaveLength(1);
    expect(lane.pc).toBe(0);
  });

  it("refuses garbage the player can't have seen yet", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const lane = t.live!.round.seat(0)!.lane.clone();
    const pl = choose(lane, "easy", mulberry32(1), 0)!;
    lane.lock(pl, 5);
    t.act((g) => g.lock(host.id, { e: 0, k: 0, pl, g: 5, ck: lane.checksum() }));
    expect(t.direct.map((d) => d.msg.t)).toEqual(["fix"]);
  });

  it("a player leaving mid-round can end it", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    const bo = t.act((g) => g.addHuman("Bo"));
    t.connect(host.id);
    t.connect(bo.id);
    t.act((g) => g.start(host.id));
    t.act((g) => g.leave(bo.id));
    expect(t.state.phase).toBe("results");
    expect(t.state.results!.winnerId).toBe(host.id);
  });
});
