// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a round
// keeps riding when someone arrives, and picks back up for the first one back to an empty room, or
// after a restart.
import { internals, openRoom, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Arena } from "../src/shared/arena";
import type { GameState } from "../src/shared/protocol";
import { GameRoom } from "../src/worker/room";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (r: TestRoom<GameRoom>) => internals<GameState, Arena>(r.room).state!;
const arena = (r: TestRoom<GameRoom>) => internals<GameState, Arena>(r.room).live;
const logged = (r: TestRoom<GameRoom>, text: string) => internals(r.room).log.some((e) => e.text.includes(text));

/** Ann and a CPU, half a second into round 1. */
async function riding() {
  const r = await openRoom(GameRoom);
  const ann = await r.connect("Ann");
  await r.say(ann, { t: "addCpu", level: "easy" });
  await r.say(ann, { t: "start" });
  // The countdown runs off the alarm.
  vi.setSystemTime(r.storage.alarm()!);
  await r.room.alarm();
  expect(state(r).phase).toBe("playing");
  await vi.advanceTimersByTimeAsync(500);
  return { r, ann };
}

describe("a round in progress", () => {
  it("rides on when someone arrives", async () => {
    const { r } = await riding();
    const before = arena(r)!;
    const tick = before.tick;
    await r.connect("Bo");
    expect(state(r).phase).toBe("playing");
    await vi.advanceTimersByTimeAsync(300);
    expect(arena(r)).toBe(before);
    expect(before.tick).toBeGreaterThan(tick);
  });

  it("counts down again for the first one back after everyone went", async () => {
    const { r, ann } = await riding();
    await r.drop(ann);
    const tick = arena(r)!.tick;
    await vi.advanceTimersByTimeAsync(5000);
    expect(arena(r)!.tick).toBe(tick);
    await r.connect("Ann");
    expect(state(r).phase).toBe("countdown");
    expect(logged(r, "Resuming round 1")).toBe(true);
    expect(arena(r)!.tick).toBe(tick);
  });

  it("starts the round over after a restart", async () => {
    const { r } = await riding();
    const after = await r.restart();
    await after.connect("Ann");
    expect(state(after).phase).toBe("countdown");
    expect(state(after).round).toBe(1);
    expect(arena(after)!.tick).toBe(0);
    expect(logged(after, "Round 1 was interrupted")).toBe(true);
  });
});
