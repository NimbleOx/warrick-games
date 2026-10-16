// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: the turn
// clock through reloads, second tabs, empty rooms and restarts, and the shop and the lobby as
// browsers use them.
import { type FakeSocket, type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../src/shared/protocol";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;
/** How long whoever drops on their turn has to come back. */
const AWAY_MS = 8000;
/** What someone back on their turn with less than this left gets, once a turn. */
const BACK_MIN_MS = 5000;

type Names = "Ann" | "Bo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The room's state, and a player by name. */
function peek(r: TestRoom<GameRoom>) {
  const s = () => internals<GameState>(r.room).state!;
  return { s, byName: (name: string) => s().players.find((p) => p.name === name)! };
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: TestRoom<GameRoom>) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

/** Ann and Bo in round 1 (no cash, so no shop), `turnSeconds` a turn. `holder` is whoever is to fire. */
async function playing(turnSeconds: number) {
  const r = await openRoom(GameRoom);
  const ws: Record<Names, FakeSocket> = { Ann: await r.connect("Ann"), Bo: await r.connect("Bo") };
  await r.say(ws.Ann, { t: "settings", settings: { startCash: 0, turnSeconds } });
  await r.say(ws.Ann, { t: "start" });
  const { s, byName } = peek(r);
  expect(s().phase).toBe("playing");
  const holder: Names = byName("Ann").id === s().turnPlayerId ? "Ann" : "Bo";
  const other: Names = holder === "Ann" ? "Bo" : "Ann";
  return { r, ws, s, byName, holder, other };
}

for (const turnSeconds of [0, 30]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, with ${turnSeconds ? `${turnSeconds} seconds a turn` : "no time limit"}`, () => {
    it("doesn't start over when you reload on your own turn", async () => {
      const { r, ws, s, holder } = await playing(turnSeconds);
      expect(s().turnDeadline).toBe(limit);
      vi.setSystemTime(T0 + 20_000);
      await r.drop(ws[holder]);
      expect(s().turnDeadline).toBe(Math.min(limit ?? Infinity, T0 + 20_000 + AWAY_MS));
      vi.setSystemTime(T0 + 21_000);
      await r.connect(holder);
      expect(s().turnDeadline).toBe(limit);
      expect(s().timer).toEqual(limit === null ? null : { kind: "turn", at: limit });
    });

    it("doesn't change for a second tab", async () => {
      const { r, s, holder } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 27_000);
      const puts = r.storage.puts();
      await r.connect(holder);
      expect(s().turnDeadline).toBe(limit);
      expect(s().clockTopUp).toBe(false);
      expect(r.storage.puts()).toBe(puts);
    });

    it("gives the player whose turn it is time to come back, when everyone was away past the deadline", async () => {
      const { r, ws, s, byName, holder, other } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 5_000);
      await r.drop(ws[holder]);
      await r.drop(ws[other]);
      // An hour later the other player is back, and the overdue timer fires.
      const later = T0 + 3_600_000;
      vi.setSystemTime(later);
      await r.connect(other);
      await fireAlarm(r);
      expect(s().turnPlayerId).toBe(byName(holder).id);
      expect(s().turnDeadline).toBe(later + 10 + AWAY_MS);
      // Back in time: their clock ran out long ago, so they get the top-up (with no limit, no deadline).
      vi.setSystemTime(later + 3_000);
      await r.connect(holder);
      expect(s().turnDeadline).toBe(limit === null ? null : later + 3_000 + BACK_MIN_MS);
      expect(s().turnPlayerId).toBe(byName(holder).id);
    });

    it("moves on from the player whose turn it is if they don't come back after a restart", async () => {
      const first = await playing(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await first.r.restart();
      const { s, byName } = peek(r);
      await r.connect(first.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + AWAY_MS);
      expect(s().turnDeadline).toBe(deadline);
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r);
      expect(s().turnPlayerId).toBe(byName(first.other).id);
    });
  });
}

describe("the turn clock", () => {
  it("can't be stretched by reloading again and again", async () => {
    const { r, ws, s, byName, holder } = await playing(30);
    let tab = ws[holder];
    for (let t = 25_000; s().turnPlayerId === byName(holder).id && t < 120_000; t += 1000) {
      vi.setSystemTime(T0 + t);
      if (Date.now() >= r.storage.alarm()!) await r.room.alarm();
      if (s().turnPlayerId !== byName(holder).id) break;
      await r.drop(tab);
      tab = await r.connect(holder);
    }
    expect(s().turnPlayerId).not.toBe(byName(holder).id);
    // The whole clock, and the one top-up.
    expect(Date.now()).toBeLessThanOrEqual(T0 + 30_000 + BACK_MIN_MS);
  });

  it("keeps the deadline of a game saved before it had a clock of its own", async () => {
    const first = await playing(30);
    const saved = first.r.storage.data.get("state") as GameState;
    delete saved.clockEnd;
    delete saved.clockTopUp;
    vi.setSystemTime(T0 + 10_000);
    const r = await first.r.restart();
    const { s } = peek(r);
    const tab = await r.connect(first.holder);
    await r.connect(first.other);
    expect(s().turnDeadline).toBe(T0 + 30_000);
    vi.setSystemTime(T0 + 15_000);
    await r.drop(tab);
    expect(s().turnDeadline).toBe(T0 + 15_000 + AWAY_MS);
    await r.connect(first.holder);
    expect(s().turnDeadline).toBe(T0 + 30_000);
  });
});

describe("the shop", () => {
  it("stays open when the only player in it reloads", async () => {
    const r = await openRoom(GameRoom);
    const { s, byName } = peek(r);
    let ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "easy" });
    await r.say(ann, { t: "addCpu", level: "hard" });
    await r.say(ann, { t: "start" });
    expect(s().phase).toBe("shop");
    await r.drop(ann);
    expect(s().phase).toBe("shop");
    vi.setSystemTime(T0 + 2_000);
    ann = await r.connect("Ann");
    expect(s().phase).toBe("shop");
    await r.say(ann, { t: "buy", item: "missile", qty: 1 });
    expect(byName("Ann").inventory.missile).toBeGreaterThan(0);
    expect(byName("Ann").money).toBeLessThan(10_000);
  });

  it("waits a moment for someone who drops while the others are ready, and no longer", async () => {
    const r = await openRoom(GameRoom);
    const { s } = peek(r);
    const ann = await r.connect("Ann");
    let bo = await r.connect("Bo");
    await r.say(ann, { t: "start" });
    await r.say(ann, { t: "ready", ready: true });
    expect(s().phase).toBe("shop");
    const end = s().phaseDeadline!;

    // A reload: back in time, Bo keeps shopping until the shop's own time is up.
    vi.setSystemTime(T0 + 1_000);
    await r.drop(bo);
    expect(s().phase).toBe("shop");
    expect(s().timer).toEqual({ kind: "shop", at: T0 + 1_000 + AWAY_MS });
    vi.setSystemTime(T0 + 3_000);
    bo = await r.connect("Bo");
    expect(s().timer).toEqual({ kind: "shop", at: end });

    // Gone for good: the round starts once Bo has had as long as a dropped turn gets.
    vi.setSystemTime(T0 + 10_000);
    await r.drop(bo);
    expect(r.storage.alarm()).toBe(T0 + 10_000 + AWAY_MS);
    await fireAlarm(r);
    expect(s().phase).toBe("playing");
    expect(s().round).toBe(1);
  });
});

describe("messages", () => {
  it("only take weapon and item ids that are strings", async () => {
    const r = await openRoom(GameRoom);
    const { s, byName } = peek(r);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "addCpu", level: "easy" });
    await r.say(ann, { t: "start" });
    // ["missile"] reads as "missile" when it's made a string.
    await r.say(ann, { t: "buy", item: ["missile"], qty: 1 });
    expect(ann.last("error")).toEqual({ t: "error", message: "Can't buy that" });
    expect(byName("Ann").inventory).toEqual({});
    expect(byName("Ann").money).toBe(10_000);

    await r.say(ann, { t: "buy", item: "missile", qty: 1 });
    await r.say(ann, { t: "ready", ready: true });
    expect(s().phase).toBe("playing");
    // Wait out the CPU's turn if it's first.
    while (s().turnPlayerId !== byName("Ann").id) await fireAlarm(r);
    const aim = { ...byName("Ann").aim };
    await r.say(ann, { t: "aim", aim: { angle: 45, power: 400, weapon: ["missile"] } });
    expect(byName("Ann").aim).toEqual(aim);
    await r.say(ann, { t: "fire", aim: { angle: 45, power: 400, weapon: ["missile"] } });
    expect(ann.last("error")).toEqual({ t: "error", message: "You don't have that weapon" });
    expect(s().resolving).toBe(false);
  });

  it("start gives a watcher a seat that has come free", async () => {
    const r = await openRoom(GameRoom);
    const { s, byName } = peek(r);
    const ann = await r.connect("Ann");
    for (let i = 0; i < 7; i++) await r.say(ann, { t: "addCpu", level: "easy" });
    await r.connect("Late");
    expect(byName("Late").spectator).toBe(true);
    await r.say(ann, { t: "kick", id: s().players.find((p) => p.cpu)!.id });
    await r.say(ann, { t: "start" });
    expect(s().phase).toBe("shop");
    expect(byName("Late").spectator).toBe(false);
    expect(s().players.filter((p) => !p.spectator)).toHaveLength(8);
  });
});
