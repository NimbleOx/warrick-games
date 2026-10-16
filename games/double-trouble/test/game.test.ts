import { describe, expect, it } from "vitest";
import { choose } from "../src/shared/ai";
import { COUNTDOWN_MS, IDLE_DROP_MS, TICK_MS } from "../src/shared/constants";
import { DIRS, Lane, type Dir } from "../src/shared/engine";
import { attackScale, type Frame, type GameState, type Op, type ServerMsg } from "../src/shared/protocol";
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

/** A host and a CPU, started, at the moment the round begins. */
function started(level: "easy" | "normal" | "hard" = "easy", goal: 0 | 512 = 512) {
  const t = setup();
  const host = t.act((g) => g.addHuman("Ann"));
  t.connect(host.id);
  t.act((g) => g.addCpu(host.id, level));
  t.act((g) => g.updateSettings(host.id, { goal }));
  t.act((g) => g.start(host.id));
  t.advance(COUNTDOWN_MS);
  return { t, host };
}

/**
 * Play moves from a browser's point of view: our own lane, taking in rocks and fixes and sending
 * each move as the client does. `report` picks the rock id each move claims to have seen.
 */
function browser(t: ReturnType<typeof setup>, pid: string, slot: number, report?: (lane: Lane) => number) {
  const snap = t.act((g) => g.snapshot())!;
  let lane = Lane.fromSnap(snap.seats[slot]!);
  const rng = mulberry32(5);
  let known = snap.seats[slot]!.g;
  let epoch = snap.seats[slot]!.e;
  let seen = t.sent.length;
  let direct = t.direct.length;
  return {
    get lane() {
      return lane;
    },
    get epoch() {
      return epoch;
    },
    /** Take in whatever the server sent since last time, like the client does. */
    read() {
      for (const d of t.direct.slice(direct)) {
        if (d.pid !== pid || d.msg.t !== "fix") continue;
        lane = Lane.fromSnap(d.msg.seat);
        epoch = d.msg.seat.e;
        known = Math.max(known, d.msg.seat.g);
      }
      direct = t.direct.length;
      for (const op of ops(t.sent.slice(seen))) {
        if (op.k === "g" && op.to === slot && op.id > known) {
          lane.queue.push({ id: op.id, rocks: op.rocks, from: op.from, at: -1 });
          known = op.id;
        }
      }
      seen = t.sent.length;
    },
    move(dir?: Dir) {
      this.read();
      const d = dir ?? choose(lane, "normal", rng);
      if (d === null || d === undefined) return null;
      const k = lane.n;
      const g = report ? report(lane) : known;
      const res = lane.move(d, g);
      if (!res) return null;
      t.act((game) => game.move(pid, { e: epoch, k, d, g, ck: lane.checksum() }));
      return res;
    },
  };
}

/** Send rocks from one slot to another, as if they'd just made the power for them. */
function attack(t: ReturnType<typeof setup>, from: number, to: number, rocks: number): void {
  const round = t.live!.round as unknown as { attack(from: number, to: unknown, rocks: number, now: number): void };
  round.attack(from, t.live!.round.seat(to), rocks, t.now);
}

describe("rock multiplier", () => {
  it("starts after two minutes and climbs to four", () => {
    expect(attackScale(119_000)).toBe(1);
    expect(attackScale(120_000)).toBe(1.5);
    expect(attackScale(151_000)).toBe(2);
    expect(attackScale(3_600_000)).toBe(4);
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
    const snap = t.sent.find((m) => m.t === "snap");
    expect(snap && snap.t === "snap" && snap.snap.goal).toBe(512);
  });

  it("only takes the settings it knows", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.updateSettings(host.id, { goal: 1024, size: 5, aim: "leader" }));
    t.act((g) => g.updateSettings(host.id, { goal: 4096, size: 6, aim: "me" }));
    expect(t.state.settings).toEqual({ goal: 1024, size: 5, aim: "leader" });
  });

  it("makes anyone arriving mid-round a spectator", () => {
    const { t } = started();
    const late = t.act((g) => g.addHuman("Bo"));
    expect(late.spectator).toBe(true);
    expect(late.slot).toBe(-1);
  });
});

describe("rounds", () => {
  it("replays a browser's moves without overruling it, rocks and all", () => {
    const { t, host } = started("hard", 0);
    const me = browser(t, host.id, 0);
    let handled = 0;
    for (let i = 0; i < 400 && t.state.phase === "playing"; i++) {
      const res = me.move();
      if (!res) break;
      handled += res.landed.length + res.cancelled;
      t.advance(300);
      t.act((g) => g.tick());
    }
    // The CPU's rocks reached us and landed (or we smashed them), and the server never had to correct our board.
    expect(ops(t.sent).some((o) => o.k === "g" && o.to === 0)).toBe(true);
    expect(handled).toBeGreaterThan(0);
    expect(t.direct.filter((d) => d.msg.t === "fix")).toEqual([]);
  });

  it("doesn't overrule a move that crossed rocks on their way to us", () => {
    const { t, host } = started();
    const me = browser(t, host.id, 0);
    const round = t.live!.round;
    // We make a move; before it reaches the server, the CPU's rocks are queued for us.
    const d = DIRS.find((x) => me.lane.canSlide(x))!;
    const k = me.lane.n;
    me.lane.move(d, 0);
    const ck = me.lane.checksum();
    const cpu = round.seat(1)!;
    cpu.lane.board.cells.fill(0);
    cpu.lane.board.cells[0] = 9;
    cpu.lane.board.cells[1] = 9;
    cpu.lane.charge = 7;
    cpu.lane.move(3, 0);
    attack(t, 1, 0, 2);
    t.act((g) => g.move(host.id, { e: 0, k, d, g: 0, ck }));
    expect(t.direct.filter((x) => x.msg.t === "fix")).toEqual([]);
    expect(round.seat(0)!.lane.pending()).toBe(2);
  });

  it("overrules a move it can't match, then ignores the stale ones", () => {
    const { t, host } = started();
    const me = browser(t, host.id, 0);
    const d = DIRS.find((x) => me.lane.canSlide(x))!;
    const k = me.lane.n;
    me.lane.move(d, 0);
    t.act((g) => g.move(host.id, { e: 0, k, d, g: 0, ck: me.lane.checksum() ^ 1 }));
    const fix = t.direct.find((x) => x.msg.t === "fix");
    expect(fix?.pid).toBe(host.id);
    expect(fix?.msg.t === "fix" && fix.msg.seat.e).toBe(1);
    // A move still on the old epoch is dropped quietly.
    const before = t.direct.length;
    t.act((g) => g.move(host.id, { e: 0, k: k + 1, d, g: 0, ck: 0 }));
    expect(t.direct.length).toBe(before);
  });

  it("lands rocks on a browser that never reports them", () => {
    const { t, host } = started("easy", 0);
    // Our browser keeps moving, but claims the oldest rock id the server will take.
    const me = browser(t, host.id, 0, (lane) => lane.ack);
    let landed = 0;
    let read = t.sent.length;
    for (let i = 0; i < 60 && t.state.phase === "playing"; i++) {
      if (i % 8 === 0) attack(t, 1, 0, 1);
      if (!me.move()) break;
      for (const op of ops(t.sent.slice(read))) if (op.k === "m" && op.s === 0) landed += op.ins;
      read = t.sent.length;
      // Not still long enough for an idle drop.
      t.advance(1000);
    }
    // The rocks landed (or our merges smashed them), all but the last one or two.
    const lane = t.live?.round.seat(0)!.lane;
    expect(landed).toBeGreaterThan(0);
    expect(!lane || lane.out || lane.pending() <= 2).toBe(true);
    expect(t.direct.some((d) => d.pid === host.id && d.msg.t === "fix")).toBe(true);
  });

  it("overrules a browser that moves faster than anyone could", () => {
    const { t, host } = started("easy", 0);
    const me = browser(t, host.id, 0);
    // Forty moves in the same instant.
    for (let i = 0; i < 40; i++) if (!me.move()) break;
    expect(t.direct.some((d) => d.pid === host.id && d.msg.t === "fix")).toBe(true);
    expect(t.live!.round.seat(0)!.lane.n).toBeLessThanOrEqual(20);
  });

  it("won't take moves before the countdown ends", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.start(host.id));
    const lane = Lane.fromSnap(t.act((g) => g.snapshot())!.seats[0]!);
    const d = DIRS.find((x) => lane.canSlide(x))!;
    lane.move(d, 0);
    t.act((g) => g.move(host.id, { e: 0, k: 0, d, g: 0, ck: lane.checksum() }));
    expect(t.direct.some((x) => x.msg.t === "fix")).toBe(true);
  });

  it("drops rocks on a player who sits still, until they're out", () => {
    const { t, host } = started("hard", 0);
    let fixes = 0;
    for (let i = 0; i < 20_000 && t.state.phase === "playing"; i++) {
      t.advance(TICK_MS);
      t.act((g) => g.tick());
      fixes = t.direct.filter((d) => d.pid === host.id && d.msg.t === "fix").length;
    }
    expect(fixes).toBeGreaterThan(0);
    expect(t.state.phase).toBe("results");
    const r = t.state.results!;
    expect(r.how).toBe("last");
    expect(r.standings[0].cpu).toBe(true);
    expect(r.standings[1].id).toBe(host.id);
    expect(r.standings[1].place).toBe(2);
    expect(r.standings[0].kos).toBe(1);
    // Dropped in batches, not before the player had been still a while.
    const drops = ops(t.sent).filter((o) => o.k === "m" && o.s === 0 && o.d === -1);
    expect(drops.length).toBeGreaterThan(0);
    expect(IDLE_DROP_MS).toBeGreaterThan(1000);
  });

  it("ends the round when someone makes the goal tile", () => {
    const { t, host } = started();
    const round = t.live!.round;
    const seat = round.seat(0)!;
    // Two 256s side by side, with the goal at 512.
    seat.lane.board.cells.fill(0);
    seat.lane.board.cells[0] = 8;
    seat.lane.board.cells[1] = 8;
    const lane = Lane.fromSnap(round.seatSnap(seat));
    lane.move(3, 0);
    t.act((g) => g.move(host.id, { e: 0, k: 0, d: 3, g: 0, ck: lane.checksum() }));
    expect(ops(t.sent).some((o) => o.k === "goal" && o.s === 0)).toBe(true);
    expect(t.state.phase).toBe("results");
    expect(t.state.results!.how).toBe("goal");
    expect(t.state.results!.winnerId).toBe(host.id);
    expect(t.state.players.find((p) => p.id === host.id)!.wins).toBe(1);
  });

  it("ends the round when the only other player leaves", () => {
    const t = setup();
    const a = t.act((g) => g.addHuman("Ann"));
    const b = t.act((g) => g.addHuman("Bo"));
    t.connect(a.id);
    t.connect(b.id);
    t.act((g) => g.start(a.id));
    t.advance(COUNTDOWN_MS);
    t.act((g) => g.leave(b.id));
    expect(t.state.phase).toBe("results");
    expect(t.state.results!.winnerId).toBe(a.id);
  });

  it("starts the round over if the server lost it", () => {
    const { t } = started();
    const g = new Game(t.state, { now: () => t.now, isConnected: () => true }, null);
    g.recover();
    expect(g.live).not.toBeNull();
    expect(g.outbox.some((m) => m.t === "snap")).toBe(true);
  });

  it("sends rocks to whoever's in the lead when asked", () => {
    const t = setup();
    const host = t.act((g) => g.addHuman("Ann"));
    t.connect(host.id);
    t.act((g) => g.addCpu(host.id, "hard"));
    t.act((g) => g.addCpu(host.id, "easy"));
    t.act((g) => g.updateSettings(host.id, { aim: "leader", goal: 0 }));
    t.act((g) => g.start(host.id));
    t.advance(COUNTDOWN_MS);
    const round = t.live!.round;
    // Make the easy CPU the leader by far.
    round.seat(2)!.lane.board.cells[15] = 9;
    for (let i = 0; i < 2000 && !ops(t.sent).some((o) => o.k === "g" && o.from === 1); i++) {
      t.advance(TICK_MS);
      t.act((g) => g.tick());
    }
    const hit = ops(t.sent).find((o) => o.k === "g" && o.from === 1);
    expect(hit && hit.k === "g" && hit.to).toBe(2);
  });
});
