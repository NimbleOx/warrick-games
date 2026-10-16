// The real GameRoom, through the kit's test harness: reloads and second tabs on your own turn,
// everyone away, restarts, a stand-in handing a seat back, and where the map is kept and sent.
import { type FakeSocket, type Json, type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HexMap } from "../src/shared/map";
import type { GameState } from "../src/shared/protocol";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;
const AWAY_MS = 5000;

type R = TestRoom<GameRoom>;

const state = (r: R) => internals<GameState, HexMap>(r.room).state!;
const map = (r: R) => internals<GameState, HexMap>(r.room).live!;
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

/** Ann (the host) and Bo playing, with `turnSeconds` on the clock. `me` is whoever's turn it is. */
async function playing(turnSeconds: number) {
  const r = await openRoom(GameRoom);
  const tabs: Record<string, FakeSocket> = { Ann: await r.connect("Ann"), Bo: await r.connect("Bo") };
  await r.say(tabs.Ann, { t: "settings", settings: { turnSeconds } });
  await r.say(tabs.Ann, { t: "start" });
  const me = turnName(r);
  const other = me === "Ann" ? "Bo" : "Ann";
  expect(state(r).turnDeadline).toBe(turnSeconds ? T0 + turnSeconds * 1000 : null);
  return { r, tabs, me, other };
}

/** Give the seat whose turn it is an attack the CPUs would make: 8 dice next to an enemy. */
function armAttack(r: R): [number, number] {
  const s = state(r);
  const adj = map(r).adj;
  for (let t = 0; t < s.owner.length; t++) {
    if (s.owner[t] !== s.turn) continue;
    const enemy = adj[t].find((u) => s.owner[u] !== s.turn);
    if (enemy === undefined) continue;
    s.dice[t] = 8;
    s.dice[enemy] = 1;
    return [t, enemy];
  }
  throw new Error("no attack");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

for (const turnSeconds of [0, 15]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, ${turnSeconds ? `${turnSeconds} seconds a turn` : "with no time limit"}`, () => {
    it("can't be kept going by reloading on your own turn", async () => {
      const { r, tabs, me, other } = await playing(turnSeconds);
      let tab = tabs[me];
      for (let t = T0 + 3000; turnName(r) === me && t < T0 + 120_000; t += 3000) {
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
        expect(turnName(r)).not.toBe(me);
        expect(turnName(r)).toBe(other);
        expect(Date.now()).toBeLessThanOrEqual(limit + 5000 + 3000);
      }
    });

    it("doesn't change for a second tab, or when it closes", async () => {
      const { r, me } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 12_000);
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
      // An hour later the other player is back, and the overdue timer fires.
      const later = T0 + 3_600_000;
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
      vi.setSystemTime(T0 + 5000);
      const r = await first.r.restart();
      await r.connect(first.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 5000 + AWAY_MS);
      expect(state(r).turnDeadline).toBe(deadline);
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r); // their turn ends: the dice drop
      await fireAlarm(r); // the next turn
      expect(turnName(r)).toBe(first.other);
    });

    it("gives a seat back mid-turn, with the whole clock, to a player a CPU stood in for", async () => {
      const { r, tabs, me, other } = await playing(turnSeconds);
      await r.drop(tabs[me]);
      await r.say(tabs[other], { t: "takeover", id: state(r).order[state(r).turn] });
      expect(state(r).timer?.kind).toBe("cpu");
      // The CPU attacks once, and isn't done.
      armAttack(r);
      await fireAlarm(r);
      expect(tabs[other].all("attack")).toHaveLength(1);
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
      expect(state(r).timer?.kind).toBe("drop");
    });
  });
}

describe("the map", () => {
  /** Every write's keys, in order. */
  function watchPuts(r: R): string[][] {
    const keys: string[][] = [];
    const put = r.storage.put.bind(r.storage);
    r.storage.put = async (a: string | Json, v?: unknown) => {
      keys.push(typeof a === "string" ? [a] : Object.keys(a));
      return put(a, v);
    };
    return keys;
  }

  it("is saved under its own key when a game starts, and not with every state", async () => {
    const r = await openRoom(GameRoom);
    const puts = watchPuts(r);
    const ann = await r.connect("Ann");
    const bo = await r.connect("Bo");
    await r.say(ann, { t: "start" });
    expect(puts.filter((k) => k.includes("map"))).toHaveLength(1);
    const saved = r.storage.data.get("map") as HexMap;
    expect(saved.id).toBe(state(r).mapId);
    expect(saved.adj.length).toBeGreaterThan(0);
    expect(r.storage.data.get("state")).not.toHaveProperty("map");

    // Attacks, turn ends and alarms write the state, but not the map.
    const before = puts.length;
    const tab = turnName(r) === "Ann" ? ann : bo;
    const [from, to] = armAttack(r);
    await r.say(tab, { t: "attack", from, to });
    await r.say(tab, { t: "end" });
    await fireAlarm(r);
    expect(puts.length).toBeGreaterThan(before + 2);
    expect(puts.slice(before).some((k) => k.includes("map"))).toBe(false);
  });

  it("comes in the welcome and with the start, and never in a state message", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    expect(ann.last("welcome")!.map).toBeNull();
    const bo = await r.connect("Bo");
    await r.say(ann, { t: "start" });
    const id = state(r).mapId;
    // The map, then the state that starts the game.
    const order = bo.received.map((m) => m.t);
    expect(order.lastIndexOf("map")).toBeLessThan(order.lastIndexOf("state"));
    expect((bo.last("map")!.map as HexMap).id).toBe(id);
    const cy = await r.connect("Cy");
    expect((cy.last("welcome")!.map as HexMap).id).toBe(id);
    expect((cy.last("welcome")!.state as Json).map).toBeUndefined();

    const tab = turnName(r) === "Ann" ? ann : bo;
    const [from, to] = armAttack(r);
    await r.say(tab, { t: "attack", from, to });
    for (const ws of [ann, bo, cy]) for (const m of ws.all("state")) expect(m.state).not.toHaveProperty("map");

    // A client that's missing it asks.
    await r.say(cy, { t: "sync" });
    expect((cy.last("map")!.map as HexMap).id).toBe(id);
  });

  it("survives a restart, and the game goes on", async () => {
    const first = await playing(30);
    const id = state(first.r).mapId;
    const r = await first.r.restart();
    const me = await r.connect(first.me);
    expect((me.last("welcome")!.map as HexMap).id).toBe(id);
    expect(map(r).id).toBe(id);
    const [from, to] = armAttack(r);
    await r.say(me, { t: "attack", from, to });
    expect(me.all("error")).toEqual([]);
    expect(me.last("attack")).toMatchObject({ attack: { from, to } });
  });

  it("moves out of a game saved with the map in its state", async () => {
    const first = await playing(30);
    const id = state(first.r).mapId;
    // The way games were saved before the map had its own key.
    const storage = first.r.storage;
    storage.data.set("state", { ...(storage.data.get("state") as object), map: storage.data.get("map") });
    storage.data.delete("map");
    const r = await first.r.restart();
    const me = await r.connect(first.me);
    expect((me.last("welcome")!.map as HexMap).id).toBe(id);
    expect((me.last("welcome")!.state as Json).map).toBeUndefined();
    expect((r.storage.data.get("map") as HexMap).id).toBe(id);
    expect(r.storage.data.get("state")).not.toHaveProperty("map");
    const [from, to] = armAttack(r);
    await r.say(me, { t: "attack", from, to });
    expect(me.all("error")).toEqual([]);
  });

  it("is cleared back in the lobby", async () => {
    const { r, tabs } = await playing(30);
    state(r).phase = "gameover";
    await r.say(tabs.Ann, { t: "lobby" });
    expect(state(r).phase).toBe("lobby");
    expect(r.storage.data.get("map")).toBeNull();
    const cy = await r.connect("Cy");
    expect(cy.last("welcome")!.map).toBeNull();
  });
});
