// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a course
// keeps going when someone arrives, goes on for the first one back to an empty room, starts again
// after a restart, and a page that says hello mid-course gets every bike.
import { internals, openRoom, type FakeSocket, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState, RaceSnapshot } from "../src/shared/protocol";
import type { Race } from "../src/worker/race";
import { GameRoom } from "../src/worker/room";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (r: TestRoom<GameRoom>) => internals<GameState, Race>(r.room).state!;
const race = (r: TestRoom<GameRoom>) => internals<GameState, Race>(r.room).live;
const logged = (r: TestRoom<GameRoom>, text: string) => internals(r.room).log.some((e) => e.text.includes(text));

/** Ann and a CPU, a second into course 1. Ann holds the gas. */
async function riding() {
  const r = await openRoom(GameRoom);
  const ann = await r.connect("Ann");
  await r.say(ann, { t: "addCpu", level: "hard" });
  await r.say(ann, { t: "start" });
  // The countdown runs off the alarm.
  vi.setSystemTime(r.storage.alarm()!);
  await r.room.alarm();
  expect(state(r).phase).toBe("riding");
  await gas(r, ann, 1000);
  return { r, ann };
}

/** Ann's screen sends "gas" every 100 ms for `ms`, as far as the course clock. */
async function gas(r: TestRoom<GameRoom>, ws: FakeSocket, ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await vi.advanceTimersByTimeAsync(100);
    const s = state(r);
    const upTo = Math.floor(((Date.now() - s.startAt!) * 120) / 1000);
    await r.say(ws, { t: "ride", run: s.run, ev: [[0, 1, 0]], upTo });
  }
}

describe("a course in progress", () => {
  it("sends frames, and rides on when someone arrives", async () => {
    const { r, ann } = await riding();
    expect(ann.all("frame").length).toBeGreaterThan(5);
    const before = race(r)!;
    const x = before.riders[0].ride.bike.x;
    expect(x).toBeGreaterThan(1);
    const bo = await r.connect("Bo");
    // Bo sees every bike as it is, and watches until the next course.
    const welcome = bo.last("welcome") as { race: RaceSnapshot };
    expect(welcome.race.rides.length).toBe(2);
    expect(state(r).riders).not.toContain(bo.you);
    await gas(r, ann, 300);
    expect(race(r)).toBe(before);
    expect(before.riders[0].ride.bike.x).toBeGreaterThan(x);
  });

  it("counts down again for the first one back after everyone went", async () => {
    const { r, ann } = await riding();
    await r.drop(ann);
    const clock = race(r)!.clock;
    await vi.advanceTimersByTimeAsync(5000);
    expect(race(r)!.clock).toBe(clock);
    await r.connect("Ann");
    expect(state(r).phase).toBe("countdown");
    expect(logged(r, "Going on with course 1")).toBe(true);
    // The clock goes on from where it stopped when the countdown ends.
    vi.setSystemTime(r.storage.alarm()!);
    await r.room.alarm();
    expect(state(r).phase).toBe("riding");
    await vi.advanceTimersByTimeAsync(100);
    expect(race(r)!.clock).toBeGreaterThanOrEqual(clock);
    expect(race(r)!.clock).toBeLessThan(clock + 30);
  });

  it("starts the course again after a restart", async () => {
    const { r } = await riding();
    const run = state(r).run;
    const after = await r.restart();
    const ann = await after.connect("Ann");
    expect(state(after).phase).toBe("countdown");
    expect(state(after).course).toBe(1);
    expect(state(after).run).toBe(run + 1);
    expect(race(after)!.riders.every((rd) => rd.ride.tick === 0)).toBe(true);
    expect(logged(after, "Course 1 was interrupted")).toBe(true);
    const welcome = ann.last("welcome") as { race: RaceSnapshot };
    expect(welcome.race.run).toBe(run + 1);
  });

  it("goes from the start to the results on its own, with a CPU and a rider", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "settings", settings: { courses: 1, difficulty: "easy", window: 15 } });
    await r.say(ann, { t: "addCpu", level: "hard" });
    await r.say(ann, { t: "start" });
    vi.setSystemTime(r.storage.alarm()!);
    await r.room.alarm();
    // Ann sends nothing: the room rides her bike on with nothing pressed, and she doesn't finish.
    for (let i = 0; i < 200 && state(r).phase === "riding"; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(state(r).phase).toBe("results");
    expect(state(r).results![0].ticks).not.toBeNull();
    expect(state(r).results![1].ticks).toBeNull();
    vi.setSystemTime(r.storage.alarm()!);
    await r.room.alarm();
    expect(state(r).phase).toBe("gameover");
  });
});
