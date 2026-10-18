// The real room (the kit's Room and this game's GameRoom) with fake sockets and storage: the turn
// clock through reloads, second tabs, empty rooms and restarts, and how the hidden hands are
// saved and recovered.
import { type FakeSocket, type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_MS } from "../src/shared/constants";
import type { GameState, Hands } from "../src/shared/protocol";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;
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

/** The room's state and hands, and a player by name. */
function peek(r: TestRoom<GameRoom>) {
  const s = () => internals<GameState, Hands>(r.room).state!;
  const live = () => internals<GameState, Hands>(r.room).live;
  return { s, live, byName: (name: string) => s().players.find((p) => p.name === name)! };
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: TestRoom<GameRoom>) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

/** Ann and Bo in round 1, `turnSeconds` a turn. `holder` is whoever is to bid. */
async function playing(turnSeconds: number) {
  const r = await openRoom(GameRoom);
  const ws: Record<Names, FakeSocket> = { Ann: await r.connect("Ann"), Bo: await r.connect("Bo") };
  await r.say(ws.Ann, { t: "settings", settings: { turnSeconds } });
  await r.say(ws.Ann, { t: "start" });
  const { s, live, byName } = peek(r);
  expect(s().phase).toBe("playing");
  const holder: Names = byName("Ann").id === s().turnId ? "Ann" : "Bo";
  const other: Names = holder === "Ann" ? "Bo" : "Ann";
  return { r, ws, s, live, byName, holder, other };
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
      const back = await r.connect(holder);
      expect(s().turnDeadline).toBe(limit);
      expect(s().timer).toEqual(limit === null ? null : { kind: "turn", at: limit });
      // Back in their seat, with their cup.
      expect(back.last("hand")).toBeDefined();
    });

    it("doesn't change for a second tab", async () => {
      const { r, s, holder } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 27_000);
      const puts = r.storage.puts();
      const tab = await r.connect(holder);
      expect(tab.last("hand")).toBeDefined();
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
      expect(s().turnId).toBe(byName(holder).id);
      expect(s().bids).toEqual([]);
      expect(s().turnDeadline).toBe(later + 10 + AWAY_MS);
      // Back in time: their clock ran out long ago, so they get the top-up (with no limit, no deadline).
      vi.setSystemTime(later + 3_000);
      await r.connect(holder);
      expect(s().turnDeadline).toBe(limit === null ? null : later + 3_000 + BACK_MIN_MS);
      expect(s().turnId).toBe(byName(holder).id);
    });

    it("doesn't move for the player whose turn it is the moment they're back, when they're first back", async () => {
      // Everyone's phone was asleep for two minutes.
      const { r, ws, s, byName, holder, other } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 1_000);
      await r.drop(ws[holder]);
      await r.drop(ws[other]);
      const later = T0 + 121_000;
      vi.setSystemTime(later);
      await r.connect(holder);
      vi.setSystemTime(later + 10);
      await r.room.alarm();
      expect(s().turnId).toBe(byName(holder).id);
      expect(s().bids).toEqual([]);
      expect(s().turnDeadline).toBe(limit === null ? null : later + BACK_MIN_MS);
    });

    it("moves for the player whose turn it is if they don't come back after a restart", async () => {
      const first = await playing(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await first.r.restart();
      const { s, byName } = peek(r);
      await r.connect(first.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + AWAY_MS);
      expect(s().turnDeadline).toBe(deadline);
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r);
      expect(s().bids).toEqual([expect.objectContaining({ by: byName(first.holder).id })]);
      expect(s().turnId).toBe(byName(first.other).id);
    });

    it("keeps the clock and the real deadline of a game saved before it had both", async () => {
      const first = await playing(turnSeconds);
      vi.setSystemTime(T0 + 5_000);
      await first.r.drop(first.ws[first.holder]);
      // Saved as it was: `turnDeadline` was the clock, and the timer when the turn really ends.
      const saved = first.r.storage.data.get("state") as GameState;
      expect(saved.timer).toEqual({ kind: "turn", at: T0 + 5_000 + AWAY_MS });
      saved.turnDeadline = saved.clockEnd!;
      delete saved.clockEnd;
      delete saved.clockTopUp;
      const r = await first.r.restart();
      const { s, byName } = peek(r);
      await r.connect(first.other);
      expect(s().turnDeadline).toBe(T0 + 5_000 + AWAY_MS);
      expect(s().clockEnd).toBe(limit);
      await fireAlarm(r);
      expect(s().turnId).toBe(byName(first.other).id);
    });
  });
}

describe("the hands", () => {
  it("are saved in the same write as the state, and only when they change", async () => {
    const r = await openRoom(GameRoom);
    const { s, live, byName } = peek(r);
    const ann = await r.connect("Ann");
    const bo = await r.connect("Bo");
    await r.say(ann, { t: "settings", settings: { turnSeconds: 0 } });
    const put = vi.spyOn(r.storage, "put");
    const written = () => put.mock.calls.map(([keys]) => Object.keys(keys as object).sort());

    await r.say(ann, { t: "start" });
    expect(written()).toEqual([["hands", "log", "state", "tokens"]]);
    expect(r.storage.data.get("hands")).toEqual(live());
    expect((r.storage.data.get("state") as GameState).round).toBe(1);

    // A bid and a call change the state, not the dice.
    put.mockClear();
    const ws = { [byName("Ann").id]: ann, [byName("Bo").id]: bo };
    await r.say(ws[s().turnId!], { t: "bid", qty: 1, face: 2 });
    await r.say(ws[s().turnId!], { t: "liar" });
    expect(s().phase).toBe("reveal");
    expect(written()).toEqual([
      ["log", "state", "tokens"],
      ["log", "state", "tokens"],
    ]);

    // The next round's dice go with the state that starts it.
    put.mockClear();
    await fireAlarm(r);
    expect(s().round).toBe(2);
    expect(written()).toEqual([["hands", "log", "state", "tokens"]]);
    expect((r.storage.data.get("hands") as Hands).round).toBe(2);
  });

  it("lost to a restart, are rolled again before a call is judged", async () => {
    const { r, ws, s, byName, holder, other } = await playing(0);
    await r.say(ws[holder], { t: "bid", qty: 2, face: 3 });
    expect(s().turnId).toBe(byName(other).id);
    // The object hibernates, and wakes without the hands (saved by a version that wrote them apart).
    r.storage.data.delete("hands");
    const woken = await r.wake();
    const now = peek(woken);
    await woken.say(ws[other], { t: "liar" });
    // The bid was on dice nobody has any more: the round starts again, and there's nothing to call.
    expect(ws[other].last("error")).toEqual({ t: "error", message: "Nothing to call yet: make the first bid" });
    expect(now.s().phase).toBe("playing");
    expect(now.s().bids).toEqual([]);
    expect(now.s().reveal).toBeNull();
    expect(now.live()?.round).toBe(1);
    expect(ws[holder].last("hand")).toEqual({ t: "hand", round: 1, dice: now.live()!.dice[byName(holder).id] });
    expect(ws[other].last("hand")).toEqual({ t: "hand", round: 1, dice: now.live()!.dice[byName(other).id] });
    expect(woken.storage.data.get("hands")).toEqual(now.live());
  });
});
