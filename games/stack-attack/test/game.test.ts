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

/** Send garbage from one slot to another, as if they'd cleared lines just now. */
function attack(t: ReturnType<typeof setup>, from: number, to: number, lines: number): void {
  const round = t.live!.round as unknown as { attack(from: number, to: unknown, lines: number, now: number): void };
  round.attack(from, t.live!.round.seat(to), lines, t.now);
}

/**
 * A player's browser: its own lane, taking in garbage and fixes the way the client does, and
 * sending every piece it locks. `report` picks the garbage id each lock claims to have seen.
 */
function browser(t: ReturnType<typeof setup>, pid: string, report?: (lane: Lane) => number) {
  const snap = t.act((g) => g.snapshot())!;
  const slot = snap.who.indexOf(pid);
  let lane = Lane.fromSnap(snap.seats[slot]!);
  let known = snap.seats[slot]!.g;
  let epoch = snap.seats[slot]!.e;
  let sent = t.sent.length;
  let direct = t.direct.length;
  const rng = mulberry32(5);
  return {
    slot,
    get lane() {
      return lane;
    },
    read() {
      for (const d of t.direct.slice(direct)) {
        if (d.pid !== pid || d.msg.t !== "fix") continue;
        lane = Lane.fromSnap(d.msg.seat);
        epoch = d.msg.seat.e;
        known = d.msg.seat.g;
      }
      direct = t.direct.length;
      for (const op of ops(t.sent.slice(sent))) {
        if (op.k === "g" && op.to === slot && op.id > known) {
          lane.queue.push({ id: op.id, lines: op.lines, hole: op.hole, from: op.from });
          known = op.id;
        }
      }
      sent = t.sent.length;
    },
    lock() {
      this.read();
      const g = report ? report(lane) : known;
      const pl = choose(lane, "hard", rng, g);
      if (!pl) return null;
      const k = lane.pc;
      const res = lane.lock(pl, g);
      t.act((game) => game.lock(pid, { e: epoch, k, pl, g, ck: lane.checksum() }));
      return res;
    },
  };
}

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

  it("replays a player's locks and routes their garbage, both ways", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const me = browser(t, host.id);
    let rose = 0;
    // Well inside the first 90 seconds, so garbage goes out unmultiplied.
    for (let i = 0; i < 160 && t.state.phase === "playing"; i++) {
      if (i % 10 === 5) attack(t, 1, me.slot, 1);
      const res = me.lock();
      if (!res) break;
      rose += res.inserted;
      t.advance(250);
      t.act((g) => g.tick());
    }
    expect(t.direct).toHaveLength(0); // never overruled
    // Garbage reached us too, and rose in where the browser said it would.
    expect(rose).toBeGreaterThan(0);
    if (t.live) expect(t.live.round.seat(me.slot)!.lane.checksum()).toBe(me.lane.checksum());
    const all = ops(t.sent);
    const sentTo = all.filter((o) => o.k === "g" && o.from === me.slot);
    expect(sentTo.reduce((n, o) => n + (o.k === "g" ? o.lines : 0), 0)).toBe(me.lane.sent);
  });

  it("lands garbage on a browser that never reports it", () => {
    const t = setup();
    const ann = t.act((g) => g.addHuman("Ann"));
    const bo = t.act((g) => g.addHuman("Bo"));
    t.connect(ann.id);
    t.connect(bo.id);
    t.act((g) => g.start(ann.id));
    t.advance(COUNTDOWN_MS);
    // Ann's browser ignores incoming garbage and claims the oldest id the server will take.
    const me = browser(t, ann.id, (lane) => lane.ack);
    const round = t.live!.round;
    const boSlot = 1 - me.slot;
    let rose = 0;
    let seen = 0;
    for (let i = 0; i < 64 && t.state.phase === "playing"; i++) {
      if (i % 8 === 0) attack(t, boSlot, me.slot, 2);
      if (!me.lock()) break;
      for (const op of ops(t.sent.slice(seen))) if (op.k === "l" && op.s === me.slot) rose += op.ins;
      seen = t.sent.length;
      t.advance(500);
    }
    // It rose in (or clears cancelled it). Unless Ann topped out, only the last attack or so is
    // still on its way.
    const lane = round.seat(me.slot)!.lane;
    expect(rose).toBeGreaterThan(0);
    expect(lane.out || lane.pending() <= 4).toBe(true);
    expect(t.direct.some((d) => d.pid === ann.id)).toBe(true);
  });

  it("overrules a browser that locks pieces faster than anyone could", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const me = browser(t, host.id);
    // Thirty pieces in the same instant.
    for (let i = 0; i < 30; i++) me.lock();
    expect(t.direct.length).toBeGreaterThan(0);
    expect(t.live!.round.seat(0)!.lane.pc).toBeLessThan(30);
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

  it("doesn't overrule a lock that garbage crossed on its way in", () => {
    const t = setup();
    const ann = t.act((g) => g.addHuman("Ann"));
    const bo = t.act((g) => g.addHuman("Bo"));
    t.connect(ann.id);
    t.connect(bo.id);
    t.act((g) => g.start(ann.id));
    t.advance(COUNTDOWN_MS);
    const snap = t.act((g) => g.snapshot())!;
    const annSlot = snap.who.indexOf(ann.id);
    const mine = Lane.fromSnap(snap.seats[annSlot]!);
    const bos = Lane.fromSnap(snap.seats[snap.who.indexOf(bo.id)]!);
    // Ann's browser locks a piece, knowing of no garbage yet.
    const pl = choose(mine, "easy", mulberry32(1), 0)!;
    mine.lock(pl, 0);
    const first = { e: 0, k: 0, pl, g: 0, ck: mine.checksum() };
    // Before that lock reaches the server, Bo clears lines and the garbage is queued for Ann.
    const rng = mulberry32(5);
    const toAnn = () => ops(t.sent).find((o) => o.k === "g" && o.to === annSlot);
    for (let k = 0; !toAnn(); k++) {
      expect(k).toBeLessThan(200);
      const bpl = choose(bos, "hard", rng, 0)!;
      bos.lock(bpl, 0);
      t.act((g) => g.lock(bo.id, { e: 0, k, pl: bpl, g: 0, ck: bos.checksum() }));
      t.advance(150);
    }
    t.act((g) => g.lock(ann.id, first));
    expect(t.direct).toHaveLength(0);
    // The garbage reaches Ann's browser, and her next lock agrees with the server too.
    const op = toAnn()!;
    if (op.k !== "g") throw new Error("not garbage");
    mine.queue.push({ id: op.id, lines: op.lines, hole: op.hole, from: op.from });
    const next = choose(mine, "easy", mulberry32(2), op.id)!;
    mine.lock(next, op.id);
    t.act((g) => g.lock(ann.id, { e: 0, k: 1, pl: next, g: op.id, ck: mine.checksum() }));
    expect(t.direct).toHaveLength(0);
    expect(t.live!.round.seat(annSlot)!.lane.checksum()).toBe(mine.checksum());
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
