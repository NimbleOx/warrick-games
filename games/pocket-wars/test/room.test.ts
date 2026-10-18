// The real GameRoom, through the kit's test harness: reloads and second tabs on your own turn,
// everyone away, restarts, a stand-in handing a seat back, a start that fails, and the state
// each event carries.
import { type FakeSocket, type Json, type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_MS } from "../src/shared/constants";
import { MAPS } from "../src/shared/maps";
import type { GameState } from "../src/shared/protocol";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;

type R = TestRoom<GameRoom>;

const state = (r: R) => internals<GameState>(r.room).state!;
const turnName = (r: R) => {
  const s = state(r);
  return s.players.find((p) => p.id === s.order[s.turn])!.name;
};

/** Move the clock to `at`, running each alarm that comes due on the way. */
async function advanceTo(r: R, at: number) {
  for (let i = 0; i < 1000; i++) {
    const alarm = r.storage.alarm();
    if (alarm === null || alarm > at) break;
    vi.setSystemTime(Math.max(alarm, Date.now()));
    await r.room.alarm();
  }
  vi.setSystemTime(Math.max(at, Date.now()));
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: R) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

/** Ann (the host) and Bo playing Pocket Duel, with `turnSeconds` on the clock. `me` is whoever's turn it is. */
async function playing(turnSeconds: number) {
  const r = await openRoom(GameRoom);
  const tabs: Record<string, FakeSocket> = { Ann: await r.connect("Ann"), Bo: await r.connect("Bo") };
  await r.say(tabs.Ann, { t: "settings", settings: { map: "pocket-duel", turnSeconds } });
  await r.say(tabs.Ann, { t: "start" });
  const me = turnName(r);
  const other = me === "Ann" ? "Bo" : "Ann";
  expect(state(r).turnDeadline).toBe(turnSeconds ? T0 + turnSeconds * 1000 : null);
  return { r, tabs, me, other };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

for (const turnSeconds of [0, 60]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, ${turnSeconds ? `${turnSeconds} seconds a turn` : "with no time limit"}`, () => {
    it("can't be kept going by reloading on your own turn", async () => {
      const { r, tabs, me, other } = await playing(turnSeconds);
      let tab = tabs[me];
      for (let t = T0 + 3000; turnName(r) === me && t < T0 + 300_000; t += 3000) {
        await advanceTo(r, t);
        if (turnName(r) !== me) break;
        await r.drop(tab);
        await advanceTo(r, t + 500);
        tab = await r.connect(me);
      }
      if (limit === null) {
        // No limit: reloading leaves the turn theirs, with no deadline.
        expect(turnName(r)).toBe(me);
        expect(state(r).turnDeadline).toBeNull();
      } else {
        // The clock they started with, and one top-up of 5 seconds at most.
        expect(turnName(r)).toBe(other);
        expect(Date.now()).toBeLessThanOrEqual(limit + 5000 + 3000);
      }
    });

    it("doesn't change for a second tab, or when it closes", async () => {
      const { r, me } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 57_000);
      const puts = r.storage.puts();
      const second = await r.connect(me);
      expect(state(r).turnDeadline).toBe(limit);
      expect(state(r).clockTopUp).toBe(false);
      expect(r.storage.puts()).toBe(puts);
      await r.drop(second);
      expect(state(r).turnDeadline).toBe(limit);
      expect(state(r).players.find((p) => p.name === me)!.connected).toBe(true);
    });

    it("gives the player whose turn it is time to come back, when everyone was away past the deadline", async () => {
      const { r, tabs, me, other } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 2000);
      await r.drop(tabs.Ann);
      await r.drop(tabs.Bo);
      // Two hours later the other player is back, and the overdue timer fires.
      const later = T0 + 7_200_000;
      vi.setSystemTime(later);
      await r.connect(other);
      await fireAlarm(r);
      expect(turnName(r)).toBe(me);
      expect(state(r).turnDeadline).toBe(later + 10 + AWAY_MS);
      // They're back in time: their clock ran out long ago, so they get the top-up (no limit: no deadline).
      vi.setSystemTime(later + 3000);
      await r.connect(me);
      expect(state(r).turnDeadline).toBe(limit === null ? null : later + 3000 + 5000);
      expect(turnName(r)).toBe(me);
    });

    it("moves on from the player whose turn it is if they don't come back after a restart", async () => {
      const first = await playing(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await first.r.restart();
      await r.connect(first.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + AWAY_MS);
      expect(state(r).turnDeadline).toBe(deadline);
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r);
      expect(turnName(r)).toBe(first.other);
    });

    it("gives a seat back mid-turn, with the whole clock, to a player a CPU stood in for", async () => {
      const { r, tabs, me, other } = await playing(turnSeconds);
      await r.drop(tabs[me]);
      await r.say(tabs[other], { t: "takeover", id: state(r).order[state(r).turn] });
      expect(state(r).timer?.kind).toBe("cpu");
      // The CPU builds, and isn't done.
      await fireAlarm(r);
      expect(tabs[other].all("build")).toHaveLength(1);
      expect(state(r).timer?.kind).toBe("cpu");

      vi.setSystemTime(Date.now() + 200);
      const back = await r.connect(me);
      const p = state(r).players.find((x) => x.name === me)!;
      expect(p).toMatchObject({ cpu: null, standIn: false, connected: true });
      expect(turnName(r)).toBe(me);
      expect(state(r).turnDeadline).toBe(turnSeconds ? Date.now() + turnSeconds * 1000 : null);
      expect(state(r).timer).toEqual(turnSeconds ? { kind: "turn", at: Date.now() + turnSeconds * 1000 } : null);
      // The turn is theirs to play.
      await r.say(back, { t: "end" });
      expect(back.all("error")).toEqual([]);
      expect(turnName(r)).toBe(other);
    });
  });
}

describe("starting", () => {
  it("leaves the lobby as it was when the chosen map doesn't fit", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.connect("Bo");
    await r.connect("Cy");
    const dee = await r.connect("Dee");
    await r.drop(dee);
    await r.say(ann, { t: "settings", settings: { map: "four-corners" } });
    const before = structuredClone(state(r));
    const puts = r.storage.puts();
    await r.say(ann, { t: "start" });
    expect(ann.last("error")).toEqual({ t: "error", message: "Four Corners is a 4-player map and there are 3 players. Pick another map, or Auto." });
    expect(state(r)).toEqual(before);
    expect(r.storage.puts()).toBe(puts);

    // Dee is back: the four of them can play it.
    await r.connect("Dee");
    await r.say(ann, { t: "start" });
    expect(state(r)).toMatchObject({ phase: "playing", mapId: "four-corners" });
    expect(state(r).order).toHaveLength(4);
  });
});

describe("events", () => {
  it("each carry the state right after them, and the last one the state at the end", async () => {
    const r = await openRoom(GameRoom);
    const tabs: Record<string, FakeSocket> = {};
    for (const name of ["Ann", "Bo", "Cy"]) tabs[name] = await r.connect(name);
    await r.say(tabs.Ann, { t: "settings", settings: { map: "three-crowns", turnSeconds: 60 } });
    await r.say(tabs.Ann, { t: "start" });
    const s = state(r);
    const name = (seat: number) => s.players.find((p) => p.id === s.order[seat])!.name;
    // The second seat has no army yet, and the first parks a unit on its only factory: it's out
    // when its turn comes.
    const m = MAPS["three-crowns"];
    const factory = m.buildings.find((bd, i) => bd.kind === "factory" && s.board!.owners[i] === 1)!;
    s.board!.units.push({ id: s.board!.nextId++, type: "infantry", seat: 0, x: factory.x, y: factory.y, hp: 10, done: true });

    const watcher = tabs[name(2)];
    const seen = watcher.received.length;
    await r.say(tabs[name(0)], { t: "end" });
    const msgs = watcher.received.slice(seen).filter((msg) => msg.t !== "log");
    expect(msgs.map((msg) => msg.t)).toEqual(["turn", "turn"]);
    const [out, next] = msgs as (Json & { state: GameState; ev: Json })[];
    // The second seat is knocked out as its turn starts: that event's state is still on its turn.
    expect(out.ev).toMatchObject({ seat: 1, out: true });
    expect(out.state.turn).toBe(1);
    expect(out.state.players.find((p) => p.seat === 1)!.outDay).toBe(1);
    expect(out.state.turnDeadline).toBeNull();
    // Then the third seat's turn, with its clock: the state at the end of the action.
    expect(next.ev).toMatchObject({ seat: 2 });
    expect(next.state.turn).toBe(2);
    expect(next.state.turnDeadline).toBe(T0 + 60_000);
    expect(next.state).toEqual(JSON.parse(JSON.stringify(state(r))));
  });

  it("a CPU's step carries its next step's timer", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "settings", settings: { map: "pocket-duel" } });
    await r.say(ann, { t: "addCpu", level: "normal" });
    await r.say(ann, { t: "start" });
    if (turnName(r) === "Ann") await r.say(ann, { t: "end" });
    await fireAlarm(r);
    const step = ann.received.at(-1)!;
    expect(step.t).toBe("build");
    expect((step.state as GameState).timer).toEqual(state(r).timer);
    expect(state(r).timer?.kind).toBe("cpu");
  });
});
