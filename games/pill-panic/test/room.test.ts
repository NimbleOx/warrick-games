// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: a round
// keeps its clock when someone arrives, picks up where it stopped for the first one back to an
// empty room, and starts over after a restart.
import { internals, openRoom, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../src/shared/protocol";
import { Game, type Live } from "../src/worker/game";
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

describe("inputs", () => {
  it("takes 100 a second from one socket and drops the rest", async () => {
    const { r, ann } = await playing();
    const feed = vi.spyOn(Game.prototype, "feed");
    const input = { t: "in", e: 0, n: 0, k: [], g: [] };
    // A browser's usual 20 a second all go through.
    for (let i = 0; i < 60; i++) {
      await r.say(ann, input);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(feed).toHaveBeenCalledTimes(60);
    // A flood is cut off at 100 in the second, and the next second takes them again.
    feed.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 500; i++) await r.say(ann, input);
    expect(feed).toHaveBeenCalledTimes(100);
    await vi.advanceTimersByTimeAsync(1000);
    await r.say(ann, input);
    expect(feed).toHaveBeenCalledTimes(101);
    feed.mockRestore();
  });
});

describe("a solo run", () => {
  it("starts with one player, keeps arrivals watching, and starts the level over after a restart", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "start" });
    expect(state(r)).toMatchObject({ phase: "playing", solo: true });
    expect(live(r)!.round.live).toHaveLength(1);
    const welcome = ann.last("welcome") as { snap: unknown };
    expect(welcome.snap).toBeNull();
    expect((ann.last("snap") as { snap: { lanes: unknown[] } }).snap.lanes).toHaveLength(1);
    const bo = await r.connect("Bo");
    expect(state(r).players.find((p) => p.id === bo.you)!.spectator).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    const after = await r.restart();
    await after.connect("Ann");
    expect(state(after)).toMatchObject({ phase: "playing", solo: true });
    expect(state(after).round!.n).toBe(1);
    expect(live(after)!.round.live).toHaveLength(1);
    expect(logged(after, "starts over")).toBe(true);
  });

  it("ends the run when the player tops out, with a watcher there to see it", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "settings", settings: { level: 0, speed: "hi" } });
    await r.say(ann, { t: "start" });
    const bo = await r.connect("Bo");
    // Ann's tab closes. Bo keeps the room's loop running, and Ann's capsules drop by themselves.
    await r.drop(ann);
    for (let i = 0; i < 600 && state(r).phase === "playing"; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(state(r).phase).toBe("results");
    const seen = (bo.last("state") as { state: GameState }).state;
    expect(seen.results).toMatchObject({ solo: true, winnerId: null, level: 0, rounds: 1 });
    expect(seen.results!.standings.map((x) => x.name)).toEqual(["Ann"]);
  });
});
