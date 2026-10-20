// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a match
// keeps going when someone arrives, goes on for the first one back to an empty room, starts
// again after a restart, routes trouble, and plays through to the results on its own.
import { internals, openRoom, type FakeSocket, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_HZ } from "../src/shared/constants";
import { LocalTable } from "../src/shared/local";
import type { GameState, MatchSnapshot, TableFrame, Trouble } from "../src/shared/protocol";
import { IN_LEFT, IN_PLUNGE, IN_RIGHT } from "../src/shared/sim";
import { TABLE } from "../src/shared/table";
import type { Match } from "../src/worker/match";
import { GameRoom } from "../src/worker/room";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (r: TestRoom<GameRoom>) => internals<GameState, Match>(r.room).state!;
const match = (r: TestRoom<GameRoom>) => internals<GameState, Match>(r.room).live;
const logged = (r: TestRoom<GameRoom>, text: string) => internals(r.room).log.some((e) => e.text.includes(text));
const clockTick = (s: GameState) => Math.floor(((Date.now() - s.startAt!) * TICK_HZ) / 1000);

/** Starts the match and runs the countdown off the alarm. */
async function go(r: TestRoom<GameRoom>, host: FakeSocket) {
  await r.say(host, { t: "start" });
  vi.setSystemTime(r.storage.alarm()!);
  await r.room.alarm();
  expect(state(r).phase).toBe("playing");
}

/** A player's screen: plays its own table to the match clock and sends its inputs every 100 ms. */
function screen(r: TestRoom<GameRoom>, ws: FakeSocket) {
  const welcome = ws.last("match") ?? ws.last("welcome");
  const snap = (welcome as { match: MatchSnapshot }).match;
  const i = snap.seats.indexOf(ws.you);
  const local = new LocalTable(TABLE, snap.rules, snap.run, { play: snap.plays[i], bits: snap.inputs[i] }, snap.troubles);
  ws.onSend = (msg) => {
    if (msg.t === "trouble" && (msg.tr as Trouble).to === ws.you) local.addTrouble(msg.tr as Trouble);
  };
  return {
    local,
    /** Plays `ms`, flipping now and then and plunging, sending every 100 ms. */
    async run(ms: number) {
      for (let t = 0; t < ms; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        const s = state(r);
        local.advance(clockTick(s), () => {
          const k = local.play.tick;
          return (k % 90 < 40 ? IN_PLUNGE : 0) | (k % 50 < 8 ? IN_LEFT : 0) | (k % 70 < 8 ? IN_RIGHT : 0);
        });
        const msg = local.message();
        await r.say(ws, msg as unknown as Record<string, unknown>);
        local.sent(msg);
      }
    },
  };
}

describe("a match in progress", () => {
  it("steps your table from your inputs, the same as your screen does", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "hard" });
    await go(r, ann);
    const me = screen(r, ann);
    await me.run(8000);
    expect(ann.all("frame").length).toBeGreaterThan(100);
    // Every hash the room sent for Ann's table matches her own.
    const frames = ann.all("frame") as { r: TableFrame[] }[];
    let checked = 0;
    for (const f of frames) {
      const row = f.r.find((x) => x[0] === ann.you)!;
      if (row[20] > 0) {
        expect(me.local.check(row[20], row[21])).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    // Once the room has stepped as far as Ann's last message, it has her game exactly.
    await vi.advanceTimersByTimeAsync(60);
    const seat = match(r)!.seat(ann.you)!;
    expect(seat.play.tick).toBe(me.local.play.tick);
    expect(seat.play.score).toBe(me.local.play.score);
  });

  it("sends frames, and plays on when someone arrives", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "normal" });
    await go(r, ann);
    await screen(r, ann).run(1000);
    const before = match(r)!;
    const bo = await r.connect("Bo");
    // Bo sees every table as it is, and watches until the next match.
    const welcome = bo.last("welcome") as { match: MatchSnapshot };
    expect(welcome.match.plays.length).toBe(2);
    expect(state(r).seats).not.toContain(bo.you);
    await vi.advanceTimersByTimeAsync(500);
    expect(match(r)).toBe(before);
  });

  it("counts down again for the first one back after everyone went", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "easy" });
    await go(r, ann);
    await screen(r, ann).run(1000);
    await r.drop(ann);
    const clock = match(r)!.clock;
    await vi.advanceTimersByTimeAsync(5000);
    expect(match(r)!.clock).toBe(clock);
    await r.connect("Ann");
    expect(state(r).phase).toBe("countdown");
    expect(logged(r, "Going on with the match")).toBe(true);
    vi.setSystemTime(r.storage.alarm()!);
    await r.room.alarm();
    await vi.advanceTimersByTimeAsync(100);
    expect(match(r)!.clock).toBeGreaterThanOrEqual(clock);
    expect(match(r)!.clock).toBeLessThan(clock + 30);
  });

  it("starts the match again after a restart", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "easy" });
    await go(r, ann);
    const run = state(r).run;
    const after = await r.restart();
    const ann2 = await after.connect("Ann");
    expect(state(after).phase).toBe("countdown");
    expect(state(after).run).toBe(run + 1);
    expect(match(after)!.seats.every((s) => s.play.tick === 0)).toBe(true);
    expect(logged(after, "The match was interrupted")).toBe(true);
    expect((ann2.last("welcome") as { match: MatchSnapshot }).match.run).toBe(run + 1);
  });

  it("routes trouble to a rival, landing a second later", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    for (let i = 0; i < 3; i++) await r.say(ann, { t: "addCpu", level: "hard" });
    await go(r, ann);
    const me = screen(r, ann);
    for (let i = 0; i < 60 && !ann.all("trouble").length; i++) await me.run(1000);
    const sent = ann.all("trouble") as { tr: Trouble }[];
    expect(sent.length).toBeGreaterThan(0);
    const tr = sent[0].tr;
    expect(tr.from).not.toBe(tr.to);
    expect(tr.at).toBeGreaterThan(0);
  });

  it("plays a timed match to the results on its own, with a CPU and a player who sends nothing", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "settings", settings: { mode: "timed", minutes: 2 } });
    await r.say(ann, { t: "addCpu", level: "normal" });
    await go(r, ann);
    for (let i = 0; i < 200 && state(r).phase === "playing"; i++) await vi.advanceTimersByTimeAsync(1000);
    const s = state(r);
    expect(s.phase).toBe("results");
    expect(s.results!.rows.length).toBe(2);
    expect(s.results!.rows[0].score).toBeGreaterThan(0);
    // The host can go again straight from the results.
    await r.say(ann, { t: "start" });
    expect(state(r).phase).toBe("countdown");
  });
});
