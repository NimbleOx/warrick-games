// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a round
// keeps going when someone arrives, and picks back up for the first one back to an empty room, or
// after a restart.
import { internals, openRoom, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../src/shared/protocol";
import type { Live } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (r: TestRoom<GameRoom>) => internals<GameState, Live>(r.room).state!;
const round = (r: TestRoom<GameRoom>) => internals<GameState, Live>(r.room).live?.round ?? null;
const logged = (r: TestRoom<GameRoom>, text: string) => internals(r.room).log.some((e) => e.text.includes(text));

/** Ann and a CPU, half a second into round 1. */
async function playing() {
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
  it("carries on when someone arrives", async () => {
    const { r } = await playing();
    const before = round(r)!;
    const tick = before.world.tick;
    await r.connect("Bo");
    expect(state(r).phase).toBe("playing");
    await vi.advanceTimersByTimeAsync(300);
    expect(round(r)).toBe(before);
    expect(before.world.tick).toBeGreaterThan(tick);
  });

  it("counts down again for the first one back after everyone went", async () => {
    const { r, ann } = await playing();
    await r.drop(ann);
    const tick = round(r)!.world.tick;
    await vi.advanceTimersByTimeAsync(5000);
    expect(round(r)!.world.tick).toBe(tick);
    await r.connect("Ann");
    expect(state(r).phase).toBe("countdown");
    expect(logged(r, "Round 1 resumes")).toBe(true);
    expect(round(r)!.world.tick).toBe(tick);
  });

  it("starts the round over after a restart", async () => {
    const { r } = await playing();
    const after = await r.restart();
    await after.connect("Ann");
    expect(state(after).phase).toBe("countdown");
    expect(state(after).round).toBe(1);
    expect(round(after)!.world.tick).toBe(0);
    expect(logged(after, "Round 1 restarted")).toBe(true);
  });
});
