import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { FRAME_MS, MAX_BEHIND, TICK_HZ, TROUBLE_LEAD } from "../src/shared/constants";
import type { ServerMsg, Trouble } from "../src/shared/protocol";
import { POWER_MAX } from "../src/shared/sim";
import { Game, newGameState } from "../src/worker/game";
import type { Match } from "../src/worker/match";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const rng = mulberry32(7);
  // Like the room: the match outlives each Game wrapper.
  let match: Match | null = null;
  const sent: { to: string | null; msg: ServerMsg }[] = [];
  const act = (fn: (g: Game) => void) => {
    const g = new Game(s, io, match, rng);
    fn(g);
    match = g.match;
    for (const msg of g.outbox) sent.push({ to: null, msg });
    for (const d of g.direct) sent.push({ to: d.pid, msg: d.msg });
    return g;
  };
  const join = (name: string) => {
    const p = act((g) => g.addHuman(name)).s.players.at(-1)!;
    connected.add(p.id);
    return p.id;
  };
  return {
    s,
    act,
    join,
    connected,
    sent,
    get match() {
      return match;
    },
    advance(ms: number) {
      now += ms;
    },
    /** Through the countdown: the balls are in. */
    go() {
      now = Math.max(now, s.timer!.at);
      act((g) => g.onTimer());
      expect(s.phase).toBe("playing");
    },
    /** The room's tick loop for `ms`. */
    tick(ms: number) {
      for (let t = 0; t < ms; t += FRAME_MS) {
        now += FRAME_MS;
        act((g) => g.tick());
      }
    },
    troubles: () => sent.filter((x) => x.msg.t === "trouble").map((x) => (x.msg as { tr: Trouble }).tr),
  };
}

describe("starting", () => {
  it("one player can play solo; the match has their table", () => {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.start(ann));
    expect(t.s.phase).toBe("countdown");
    expect(t.s.seats).toEqual([ann]);
    expect(t.match!.rules.mode).toBe("timed");
    expect(t.match!.rules.endTick).toBe(3 * 60 * TICK_HZ);
  });

  it("the settings pick the mode, the time and the balls", () => {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.updateSettings(ann, { mode: "balls", balls: 5, minutes: 99 }));
    expect(t.s.settings).toMatchObject({ mode: "balls", balls: 5, minutes: 3 });
    t.act((g) => g.start(ann));
    expect(t.match!.rules.balls).toBe(5);
  });

  it("someone arriving mid-match gets a seat and plays the next one", () => {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.addCpu(ann, "easy"));
    t.act((g) => g.start(ann));
    const bo = t.join("Bo");
    expect(t.s.players.find((p) => p.id === bo)!.spectator).toBe(false);
    expect(t.s.seats).not.toContain(bo);
  });
});

describe("trouble", () => {
  function charged(aim: "random" | "leader" | "off") {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.updateSettings(ann, { trouble: aim }));
    t.act((g) => g.addCpu(ann, "easy"));
    t.act((g) => g.addCpu(ann, "easy"));
    t.act((g) => g.start(ann));
    t.go();
    const [a, b, c] = t.match!.seats;
    b.play.score = 50_000;
    c.play.score = 10_000;
    // Ann's power is one short; her next lane sends it.
    a.play.power = POWER_MAX - 1;
    a.play.lanes = 3;
    const ball = a.play.balls[0];
    ball.st = 1;
    ball.x = 405;
    ball.y = 145;
    ball.vx = 0;
    ball.vy = 200;
    a.upTo = 20;
    t.tick(200);
    return { t, ann, b, c };
  }

  it("goes to a rival, landing a second after the room hears of it", () => {
    const { t, ann } = charged("random");
    const [tr] = t.troubles();
    expect(tr.from).toBe(ann);
    expect(tr.to).not.toBe(ann);
    expect(tr.at).toBeGreaterThanOrEqual(TROUBLE_LEAD);
    // It lands on the rival's table at its tick.
    const target = t.match!.seat(tr.to)!;
    t.tick(1500);
    expect(target.play.trouble[tr.kind]).toBeGreaterThan(0);
  });

  it("goes to whoever's winning, with that setting", () => {
    const { t, b } = charged("leader");
    expect(t.troubles()[0].to).toBe(b.id);
  });

  it("goes nowhere when it's off", () => {
    const { t } = charged("off");
    expect(t.troubles()).toEqual([]);
  });
});

describe("playing and the results", () => {
  it("plays on for a player who's gone quiet, and tells them where their table is when they're back", () => {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.addCpu(ann, "easy"));
    t.act((g) => g.start(ann));
    t.go();
    t.tick(3000);
    const seat = t.match!.seat(ann)!;
    expect(seat.away).toBe(true);
    expect(seat.play.tick).toBeGreaterThan(3 * TICK_HZ - MAX_BEHIND - 10);
    t.act((g) => g.play(ann, { t: "play", run: t.s.run, ev: [[0, 0]], upTo: 5 }));
    expect(t.sent.some((x) => x.to === ann && x.msg.t === "sync")).toBe(true);
  });

  it("ranks by score, ties sharing a place, and counts the win", () => {
    const t = setup();
    const ann = t.join("Ann");
    const bo = t.join("Bo");
    t.act((g) => g.addCpu(ann, "easy"));
    t.act((g) => g.updateSettings(ann, { mode: "timed", minutes: 2 }));
    t.act((g) => g.start(ann));
    t.go();
    const seats = t.match!.seats;
    seats[0].play.score = 9000;
    seats[1].play.score = 9000;
    seats[2].play.score = 100;
    for (const seat of seats) seat.play.over = 1;
    t.tick(FRAME_MS);
    expect(t.s.phase).toBe("results");
    const rows = t.s.results!.rows;
    expect(rows.map((r) => r.place)).toEqual([1, 1, 3]);
    expect(t.s.players.find((p) => p.id === ann)!.wins).toBe(1);
    expect(t.s.players.find((p) => p.id === bo)!.wins).toBe(1);
  });

  it("a solo match counts no wins", () => {
    const t = setup();
    const ann = t.join("Ann");
    t.act((g) => g.start(ann));
    t.go();
    t.match!.seats[0].play.over = 1;
    t.tick(FRAME_MS);
    expect(t.s.results!.solo).toBe(true);
    expect(t.s.players[0].wins).toBe(0);
  });

  it("leaving mid-match takes your table out, and the match ends when nobody's left", () => {
    const t = setup();
    const ann = t.join("Ann");
    const bo = t.join("Bo");
    t.act((g) => g.start(ann));
    t.go();
    t.act((g) => g.leave(bo));
    expect(t.match!.seats.map((x) => x.id)).toEqual([ann]);
    t.act((g) => g.leave(ann));
    expect(t.s.phase).toBe("lobby");
  });
});
