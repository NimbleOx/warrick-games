import { describe, expect, it } from "vitest";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { Pilot } from "../src/shared/ai";
import { FRAME_MS, MAX_BEHIND, SEND_MS, TICK_HZ } from "../src/shared/constants";
import { generateCourse } from "../src/shared/course";
import { LocalRider } from "../src/shared/local";
import { courseSpec, type GameState, type ServerMsg } from "../src/shared/protocol";
import { rideHash, type RideInput } from "../src/shared/ride";
import { Game, newGameState, rankRiders } from "../src/worker/game";
import { Race } from "../src/worker/race";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const rng = mulberry32(7);
  // Like the room: the race outlives each Game wrapper.
  let race: Race | null = null;
  const sent: { to: string | null; msg: ServerMsg }[] = [];
  const act = (fn: (g: Game) => void) => {
    const g = new Game(s, io, race, rng);
    fn(g);
    race = g.race;
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
    get race() {
      return race;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    /** The course clock's tick now. */
    clock() {
      return Math.floor(((now - s.startAt!) * TICK_HZ) / 1000);
    },
    /** Run the timer if it's due (or skip to it). */
    timer() {
      if (!s.timer) return;
      now = Math.max(now, s.timer.at);
      act((g) => g.onTimer());
    },
  };
}

type T = ReturnType<typeof setup>;

/** A player's screen: their own bike, ridden by a pilot in place of their hands, sending what it sends. */
function screen(t: T, id: string, level: "easy" | "normal" | "hard" = "hard") {
  const course = generateCourse(courseSpec(t.s));
  const i = t.s.riders.indexOf(id);
  const snap = t.race!.snapshot();
  let local = new LocalRider(course, t.s.run, { ride: snap.rides[i], input: snap.inputs[i] });
  const pilot = new Pilot(level, 42);
  const read = (into: RideInput) => pilot.decide(local.ride, course, into);
  return {
    get local() {
      return local;
    },
    /** Ride up to the clock and send. */
    ride() {
      local.advance(Math.max(0, t.clock()), read);
      const msg = local.message();
      local.sent(msg);
      t.act((g) => g.ride(id, msg));
    },
    /** What a screen does with the room's messages: check its bike against frames, and take syncs. */
    hear(msgs: { to: string | null; msg: ServerMsg }[]) {
      for (const { to, msg } of msgs) {
        if (msg.t === "frame") {
          const r = msg.r.find((r) => r[0] === id);
          if (r && !local.check(r[15], r[16])) t.act((g) => g.resync(id, t.s.run));
        } else if (msg.t === "sync" && to === id) local.adopt(msg.ride, msg.input);
      }
    },
    read,
  };
}

/** Ride until `until` (or the course ends): screens send every SEND_MS, the room ticks every FRAME_MS. */
function race(t: T, screens: Screen[], until = () => t.s.phase !== "riding", maxMs = 300_000) {
  let seen = t.sent.length;
  const hear = () => {
    // Hearing can send (a resync), which can answer (a sync): go until it's quiet.
    while (seen < t.sent.length) {
      const msgs = t.sent.slice(seen);
      seen = t.sent.length;
      for (const sc of screens) sc.hear(msgs);
    }
  };
  for (let ms = 0; ms < maxMs && !until(); ms += SEND_MS) {
    t.advance(SEND_MS);
    for (const sc of screens) sc.ride();
    hear();
    if (ms % FRAME_MS === 0) t.act((g) => g.tick());
    hear();
  }
}

type Screen = Pick<ReturnType<typeof screen>, "ride" | "hear">;

/** Host and settings, started, through the countdown. */
function started(t: T, settings: Partial<GameState["settings"]> = {}, cpus: ("easy" | "normal" | "hard")[] = []) {
  const host = t.join("Ann");
  t.act((g) => g.updateSettings(host, { courses: 3, length: "short", difficulty: "easy", ...settings }));
  for (const level of cpus) t.act((g) => g.addCpu(host, level));
  t.act((g) => g.start(host));
  return host;
}

describe("a course", () => {
  it("counts down, then rides, and the room's bike matches the rider's bit for bit", () => {
    const t = setup();
    const ann = started(t);
    expect(t.s.phase).toBe("countdown");
    expect(t.s.course).toBe(1);
    expect(t.sent.some((m) => m.msg.t === "race")).toBe(true);
    // The gate drops when the countdown ends.
    expect(t.s.startAt).toBe(t.s.phaseDeadline);
    const sc = screen(t, ann);
    t.timer();
    expect(t.s.phase).toBe("riding");
    race(t, [sc]);
    expect(t.s.phase).toBe("results");
    const server = t.race!.rider(ann)!.ride;
    const local = sc.local.ride;
    expect(server.finishTick).toBeGreaterThan(0);
    expect(local.finishTick).toBe(server.finishTick);
    expect(t.s.finishes[ann]).toBe(server.finishTick);
    // Step the screen to where the room stopped, and compare.
    expect(local.tick).toBeGreaterThanOrEqual(server.tick);
  });

  it("checks the rider's bike with hashes in its frames", () => {
    const t = setup();
    const ann = started(t);
    const sc = screen(t, ann);
    t.timer();
    race(t, [sc], () => t.clock() > 5 * TICK_HZ);
    const frames = t.sent.filter((m) => m.msg.t === "frame").map((m) => m.msg as Extract<ServerMsg, { t: "frame" }>);
    const mine = frames.map((f) => f.r.find((r) => r[0] === ann)!).filter((r) => r[15] > 0);
    expect(mine.length).toBeGreaterThan(5);
    for (const r of mine) expect(sc.local.check(r[15], r[16])).toBe(true);
  });

  it("puts a rider whose bike drifted from the room's right with a sync", () => {
    const t = setup();
    const ann = started(t);
    const sc = screen(t, ann);
    t.timer();
    race(t, [sc], () => t.clock() > 3 * TICK_HZ);
    // Something went wrong on the screen: its bike is a little off.
    sc.local.ride.bike.x += 0.01;
    const before = t.sent.filter((m) => m.to === ann && m.msg.t === "sync").length;
    race(t, [sc], () => t.clock() > 4 * TICK_HZ);
    // The screen noticed at the next hash, and took the room's bike.
    expect(t.sent.filter((m) => m.to === ann && m.msg.t === "sync").length).toBe(before + 1);
    race(t, [sc]);
    expect(sc.local.ride.finishTick).toBe(t.race!.rider(ann)!.ride.finishTick);
  });

  it("rides a rider who stops sending on with nothing pressed, and sends them their bike", () => {
    const t = setup();
    const ann = started(t);
    const sc = screen(t, ann);
    t.timer();
    race(t, [sc], () => t.clock() > 3 * TICK_HZ);
    // Ann's page stalls for two seconds; the room keeps ticking.
    for (let i = 0; i < 20; i++) {
      t.advance(FRAME_MS);
      t.act((g) => g.tick());
    }
    const r = t.race!.rider(ann)!;
    expect(r.away).toBe(true);
    expect(r.ride.tick).toBe(t.clock() - MAX_BEHIND);
    const sync = t.sent.filter((m) => m.to === ann && m.msg.t === "sync").at(-1)?.msg as Extract<ServerMsg, { t: "sync" }>;
    expect(sync).toBeTruthy();
    // The page wakes up and rides on: the room sends it its bike, and it's in step with the room again.
    race(t, [sc]);
    expect(r.away).toBe(false);
    expect(sc.local.ride.finishTick).toBe(r.ride.finishTick);
    expect(rideHash(sc.local.ride)).not.toBe("");
  });

  it("ignores inputs for another run, and junk", () => {
    const t = setup();
    const ann = started(t);
    t.timer();
    const r = t.race!.rider(ann)!;
    t.act((g) => g.ride(ann, { t: "ride", run: t.s.run + 1, ev: [[0, 1, 0]], upTo: 50 }));
    expect(r.upTo).toBe(0);
    for (const ev of [
      [[0, 9, 0]],
      [
        [5, 1, 0],
        [2, 1, 0],
      ],
      [[0.5, 1, 0]],
      "x",
      [[0, 1]],
    ]) {
      t.act((g) => g.ride(ann, { t: "ride", run: t.s.run, ev: ev as never, upTo: 50 }));
    }
    expect(r.upTo).toBe(0);
    expect(r.pending).toEqual([]);
    // Lean is clamped.
    t.act((g) => g.ride(ann, { t: "ride", run: t.s.run, ev: [[0, 1, 99]], upTo: 50 }));
    expect(r.pending).toEqual([[0, 1, 8]]);
  });
});

describe("results and the series", () => {
  it("ends the course a window after the first finish, and ranks everyone", () => {
    const t = setup();
    const ann = started(t, { window: 15, difficulty: "easy" }, ["hard", "easy"]);
    t.timer();
    // Ann sits at the gate; the CPUs ride.
    const sc = screen(t, ann);
    const idle = { ride: () => void t.act((g) => g.ride(ann, sc.local.message())), hear: () => {} };
    // (Ann's screen never rides: her messages say she's at the gate, so the room rides her bike on without her.)
    race(t, [idle], () => Object.keys(t.s.finishes).length > 0);
    const first = Object.values(t.s.finishes)[0];
    expect(t.s.endTick).toBe(first + 15 * TICK_HZ);
    race(t, [idle]);
    expect(t.s.phase).toBe("results");
    expect(t.clock()).toBeGreaterThanOrEqual(t.s.endTick! + MAX_BEHIND);
    const res = t.s.results!;
    expect(res.map((r) => r.id).at(-1)).toBe(ann);
    expect(res.at(-1)!.ticks).toBeNull();
    expect(res.at(-1)!.points).toBe(0);
    expect(res[0].place).toBe(1);
    expect(res[0].points).toBe(10);
    expect(t.s.solo).toBe(false);
    // On to the next course after the pause.
    t.timer();
    expect(t.s.phase).toBe("countdown");
    expect(t.s.course).toBe(2);
  });

  it("plays a whole series of CPUs and a rider to the final standings", () => {
    const t = setup();
    const ann = started(t, { courses: 3, difficulty: "easy" }, ["easy", "normal"]);
    for (let c = 1; c <= 3; c++) {
      expect(t.s.course).toBe(c);
      const sc = screen(t, ann, "hard");
      t.timer();
      race(t, [sc]);
      expect(t.s.phase).toBe("results");
      t.timer();
    }
    expect(t.s.phase).toBe("gameover");
    const total = t.s.players.reduce((a, p) => a + p.points, 0);
    expect(total).toBeGreaterThan(0);
    t.act((g) => g.backToLobby(ann));
    expect(t.s.phase).toBe("lobby");
    expect(t.race).toBeNull();
  });

  it("ties share a place and its points", () => {
    const course = generateCourse({ seed: 1, length: "short", difficulty: "easy" });
    const race = new Race(course, 1, [
      { id: "a", cpu: null },
      { id: "b", cpu: null },
      { id: "c", cpu: null },
      { id: "d", cpu: null },
    ]);
    race.riders[0].ride.finishTick = 900;
    race.riders[1].ride.finishTick = 800;
    race.riders[2].ride.finishTick = 900;
    race.riders[3].ride.bike.x = 100;
    const res = rankRiders(race);
    expect(res.map((r) => [r.id, r.place, r.points])).toEqual([
      ["b", 1, 10],
      ["a", 2, 8],
      ["c", 2, 8],
      ["d", 4, 0],
    ]);
  });
});

describe("solo", () => {
  it("waits after each course: ride it again, or go on", () => {
    const t = setup();
    const ann = started(t, { courses: 3 });
    const seed = courseSpec(t.s).seed;
    t.timer();
    race(t, [screen(t, ann)]);
    expect(t.s.phase).toBe("results");
    expect(t.s.solo).toBe(true);
    expect(t.s.timer).toBeNull();
    const run = t.s.run;
    t.act((g) => g.again(ann));
    expect(t.s.phase).toBe("countdown");
    expect(t.s.course).toBe(1);
    expect(courseSpec(t.s).seed).toBe(seed);
    expect(t.s.run).toBe(run + 1);
    t.timer();
    race(t, [screen(t, ann)]);
    t.act((g) => g.next(ann));
    expect(t.s.course).toBe(2);
    expect(courseSpec(t.s).seed).not.toBe(seed);
  });

  it("ends a one-course series after its course", () => {
    const t = setup();
    const ann = started(t, { courses: 1 });
    t.timer();
    race(t, [screen(t, ann)]);
    t.act((g) => g.next(ann));
    expect(t.s.phase).toBe("gameover");
  });

  it("can't ride a course again in a match", () => {
    const t = setup();
    const ann = started(t, {}, ["easy"]);
    t.timer();
    race(t, [screen(t, ann)]);
    expect(() => t.act((g) => g.again(ann))).toThrow("Not right now");
  });
});

describe("players coming and going", () => {
  it("seats someone who arrives mid-course for the next one", () => {
    const t = setup();
    const ann = started(t, {}, ["hard"]);
    t.timer();
    const bo = t.join("Bo");
    expect(t.s.players.find((p) => p.id === bo)!.spectator).toBe(false);
    expect(t.s.riders).not.toContain(bo);
    race(t, [screen(t, ann)]);
    t.timer();
    expect(t.s.course).toBe(2);
    expect(t.s.riders).toContain(bo);
  });

  it("takes a bike off the course when its rider leaves", () => {
    const t = setup();
    const ann = started(t, {}, ["hard"]);
    const bo = t.join("Bo");
    t.timer();
    expect(t.s.riders).not.toContain(bo);
    t.act((g) => g.leave(ann));
    expect(t.s.riders).toEqual([t.s.players[0].id]);
    expect(t.race!.riders.map((r) => r.id)).toEqual(t.s.riders);
  });

  it("goes on with a paused course from where every bike was", () => {
    const t = setup();
    const ann = started(t);
    const sc = screen(t, ann);
    t.timer();
    race(t, [sc], () => t.clock() > 4 * TICK_HZ);
    const x = t.race!.rider(ann)!.ride.bike.x;
    const clock = t.race!.clock;
    // Everyone went; a minute later Ann is back.
    t.advance(60_000);
    t.act((g) => g.recover());
    expect(t.s.phase).toBe("countdown");
    expect(t.race!.rider(ann)!.ride.bike.x).toBe(x);
    // When the countdown ends, the course clock is where it stopped.
    t.timer();
    expect(t.clock()).toBe(clock);
  });

  it("starts a lost course again from the gate", () => {
    const t = setup();
    const ann = started(t);
    t.timer();
    const run = t.s.run;
    const g = new Game(t.s, { now: () => t.now, isConnected: () => true }, null);
    g.recover();
    expect(t.s.phase).toBe("countdown");
    expect(t.s.course).toBe(1);
    expect(t.s.run).toBe(run + 1);
    expect(g.race!.rider(ann)!.ride.tick).toBe(0);
  });
});
