// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a round
// keeps its clock when someone arrives, picks up where it stopped for the first one back to an
// empty room, and starts over after a restart.
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
const live = (r: TestRoom<GameRoom>) => internals<GameState, Live>(r.room).live;
const logged = (r: TestRoom<GameRoom>, text: string) => internals(r.room).log.some((e) => e.text.includes(text));

/** Ann and a CPU, a few seconds into round 1. */
async function playing() {
  const r = await openRoom(GameRoom);
  const ann = await r.connect("Ann");
  await r.say(ann, { t: "addCpu", level: "easy" });
  await r.say(ann, { t: "start" });
  expect(state(r).phase).toBe("playing");
  await vi.advanceTimersByTimeAsync(Math.max(0, state(r).round!.goAt - Date.now()) + 1000);
  return { r, ann };
}

describe("a round in progress", () => {
  it("keeps its clock when someone arrives", async () => {
    const { r } = await playing();
    const before = live(r);
    const goAt = state(r).round!.goAt;
    await r.connect("Bo");
    await vi.advanceTimersByTimeAsync(300);
    expect(live(r)).toBe(before);
    expect(state(r).round!.goAt).toBe(goAt);
  });

  it("picks up where it stopped for the first one back after everyone went", async () => {
    const { r, ann } = await playing();
    await r.drop(ann);
    const goAt = state(r).round!.goAt;
    const before = live(r);
    await vi.advanceTimersByTimeAsync(10_000);
    await r.connect("Ann");
    expect(live(r)).toBe(before);
    // The round's clock moves on by the time nobody was here, less a moment.
    expect(state(r).round!.goAt).toBeGreaterThan(goAt + 9000);
  });

  it("starts the round over after a restart", async () => {
    const { r } = await playing();
    const after = await r.restart();
    await after.connect("Ann");
    expect(state(after).phase).toBe("playing");
    expect(state(after).round!.n).toBe(1);
    expect(live(after)).not.toBeNull();
    expect(logged(after, "starts over")).toBe(true);
  });
});
