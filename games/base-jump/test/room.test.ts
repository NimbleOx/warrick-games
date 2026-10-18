// The room around the game: the kit's Room and this game's GameRoom, run with fake sockets and
// storage. Covers what only shows up across a restart (every deploy is one) or hibernation: a
// round in turns carries on, and one in real time starts over.
import { internals, openRoom, type FakeSocket, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_MS, TURN_TICKS } from "../src/shared/constants";
import type { Frame } from "../src/shared/battle";
import type { GameState, LogEntry, Mode, Snapshot } from "../src/shared/protocol";
import type { Live } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

/** The kit's test room, plus this game's state and round. */
async function open(r?: TestRoom<GameRoom>) {
  const room = r ?? (await openRoom(GameRoom));
  const s = () => internals<GameState, Live>(room.room).state!;
  return { ...room, s, live: () => internals<GameState, Live>(room.room).live };
}

/** Ann and an easy CPU, a round started in one mode or the other. */
async function begin(mode: Mode) {
  const r = await open();
  const ann = await r.connect("Ann");
  await r.say(ann, { t: "addCpu", level: "easy" });
  await r.say(ann, { t: "settings", settings: { mode } });
  await r.say(ann, { t: "start" });
  expect(r.s().phase).toBe("playing");
  return { ...r, ann };
}

/** Ann is done planning, and the turn plays out. */
async function playTurn(r: Awaited<ReturnType<typeof open>>, ann: FakeSocket) {
  await r.say(ann, { t: "done", done: true });
  await vi.advanceTimersByTimeAsync(TURN_TICKS * TICK_MS + 50);
}

const events = (ws: FakeSocket) => ws.all("log").flatMap((m) => (m as unknown as { entries: LogEntry[] }).entries);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Ann's first order: half her start base to a neighbour. Always possible on turn 1. */
function firstOrder(live: Live) {
  const home = live.battle.seat[0];
  return { t: "send", from: [home], to: live.battle.map.adj[home][0], pct: 50 };
}

const frames = (ws: FakeSocket) => ws.all("f") as unknown as Frame[];

describe("a round in turns", () => {
  it("plays a turn cut off by a restart again from its start, with the same orders", async () => {
    const r = await begin("turns");
    const atPlan = JSON.parse(JSON.stringify(r.live()!.battle.snapshot())) as Snapshot;
    await r.say(r.ann, firstOrder(r.live()!));
    await r.say(r.ann, { t: "done", done: true });
    await vi.advanceTimersByTimeAsync(20 * TICK_MS);
    const [first] = frames(r.ann);
    expect(first.c?.length).toBeGreaterThan(0);
    expect(r.live()!.battle.n).toBeGreaterThan(10);

    const after = await open(await r.restart());
    const ann = await after.connect("Ann");
    const welcome = ann.last("welcome") as unknown as { state: GameState; snap: Snapshot };
    expect(welcome.state.turn).toMatchObject({ n: 1, stage: "run", tick: 0 });
    expect(welcome.snap).toEqual(atPlan);
    await vi.advanceTimersByTimeAsync(TURN_TICKS * TICK_MS + 50);
    expect(frames(ann)[0]).toEqual(first);
    expect(events(ann).some((e) => e.text?.includes("turn 1 plays again from the start"))).toBe(true);
    expect(after.s().turn).toMatchObject({ n: 2, stage: "plan", tick: TURN_TICKS });
  });

  it("carries on planning after a restart, plans and all", async () => {
    const r = await begin("turns");
    await playTurn(r, r.ann);
    const turn = r.s().turn!;
    expect(turn).toMatchObject({ n: 2, stage: "plan", tick: TURN_TICKS });
    const atPlan = JSON.parse(JSON.stringify(r.live()!.battle.snapshot())) as Snapshot;
    expect(r.storage.data.get("saved")).toMatchObject({ round: 1, turn: 2, snap: { n: TURN_TICKS } });
    const cpuPlan = r.live()!.plans[1];
    const home = atPlan.seat[0];
    const order = { t: "send", from: [home], to: atPlan.map.adj[home][0], pct: 25 };
    await r.say(r.ann, order);
    expect(r.ann.last("error")).toBeUndefined();

    const after = await open(await r.restart());
    expect(after.live()).toBeNull();
    const ann = await after.connect("Ann");
    const welcome = ann.last("welcome") as unknown as { state: GameState; snap: Snapshot };
    expect(welcome.state.turn).toMatchObject({ n: 2, stage: "plan", tick: TURN_TICKS, deadline: turn.deadline });
    expect(welcome.snap).toEqual(atPlan);
    expect(ann.last("plan")).toEqual({ t: "plan", n: 2, c: [["s", 0, order.from, order.to, 25]] });
    expect(after.live()!.plans[1]).toEqual(cpuPlan);

    // And the round plays on.
    await playTurn(after, ann);
    expect(after.s().turn).toMatchObject({ n: 3, stage: "plan", tick: 2 * TURN_TICKS });
    expect(after.storage.data.get("saved")).toMatchObject({ round: 1, turn: 3 });
  });

  it("carries on planning after the room hibernates, with the same sockets", async () => {
    const r = await begin("turns");
    const order = firstOrder(r.live()!);
    await r.say(r.ann, order);
    const woke = await open(await r.wake());
    expect(woke.live()).toBeNull();
    await woke.say(r.ann, { ...order, pct: 25 });
    expect(r.ann.last("error")).toBeUndefined();
    expect((r.ann.last("plan") as { c: unknown[] }).c).toHaveLength(2);
    await playTurn(woke, r.ann);
    expect(woke.s().turn).toMatchObject({ n: 2, stage: "plan" });
  });

  it("forgets what it saved once the round is over", async () => {
    const r = await begin("turns");
    expect(r.storage.data.get("saved")).toMatchObject({ round: 1, turn: 1 });
    // Ann leaving leaves the CPU on its own: the round is over.
    await r.say(r.ann, { t: "leave" });
    expect(r.s().phase).toBe("results");
    expect(r.storage.data.get("saved")).toBeNull();
    expect(r.storage.data.get("plans")).toBeNull();
  });
});

describe("a round in real time", () => {
  it("starts over after a restart", async () => {
    const r = await begin("live");
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.live()!.battle.n).toBeGreaterThan(10);
    expect(r.storage.data.get("saved") ?? null).toBeNull();

    const after = await open(await r.restart());
    const ann = await after.connect("Ann");
    expect((ann.last("welcome") as unknown as { snap: Snapshot }).snap.n).toBe(0);
    expect(events(ann).some((e) => e.text?.includes("round 1 starts over"))).toBe(true);
  });
});
