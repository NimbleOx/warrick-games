// The turn clock through the real room, the way browsers use it: reloads, second tabs, everyone
// gone, and deploys. The room reads Date.now(), so the clock is faked; alarms fire when a test
// says so.
import { type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../src/shared/protocol";
import { AWAY_MS } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function peek(r: TestRoom<GameRoom>) {
  const s = () => internals<GameState>(r.room).state!;
  return { s, holder: () => s().players.find((p) => p.id === s().seats[s().turn])! };
}

/** Ann and Bo playing, with `turnSeconds` a turn. Returns whose turn it is and who's waiting. */
async function playing(turnSeconds: number) {
  const r = await openRoom(GameRoom);
  const ann = await r.connect("Ann");
  const bo = await r.connect("Bo");
  await r.say(ann, { t: "settings", settings: { turnSeconds } });
  await r.say(ann, { t: "start" });
  const { s, holder } = peek(r);
  expect(s().phase).toBe("playing");
  const first = holder().name;
  return { r, s, holder, first, other: first === "Ann" ? "Bo" : "Ann", socket: { Ann: ann, Bo: bo } as Record<string, typeof ann> };
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: TestRoom<GameRoom>) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

for (const turnSeconds of [0, 30]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, ${turnSeconds ? `${turnSeconds} seconds a line` : "with the timer off"}`, () => {
    it("doesn't start over when you reload on your own turn", async () => {
      const { r, s, first, socket } = await playing(turnSeconds);
      expect(s().turnDeadline).toBe(limit);
      vi.setSystemTime(T0 + 20_000);
      await r.drop(socket[first]);
      expect(s().turnDeadline).toBe(Math.min(limit ?? Infinity, T0 + 20_000 + AWAY_MS));
      expect(s().timer?.kind).toBe("away");
      vi.setSystemTime(T0 + 21_000);
      await r.connect(first);
      expect(s().turnDeadline).toBe(limit);
      expect(s().timer).toEqual(limit === null ? null : { kind: "turn", at: limit });
    });

    it("doesn't change for a second tab", async () => {
      const { r, s, first } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 27_000);
      await r.connect(first);
      expect(s().turnDeadline).toBe(limit);
      expect(s().clockTopUp).toBe(false);
      expect(s().players.find((p) => p.name === first)!.connected).toBe(true);
    });

    it("gives the player to move time to come back, when everyone was away past the deadline", async () => {
      const { r, s, holder, first, other, socket } = await playing(turnSeconds);
      vi.setSystemTime(T0 + 5_000);
      await r.drop(socket.Ann);
      await r.drop(socket.Bo);
      // An hour later the other player is back, and the overdue alarm fires.
      const later = T0 + 3_600_000;
      vi.setSystemTime(later);
      await r.connect(other);
      await fireAlarm(r);
      expect(holder().name).toBe(first);
      expect(s().order).toEqual([]);
      expect(s().turnDeadline).toBe(later + 10 + AWAY_MS);
      expect(s().timer?.kind).toBe("away");
      // Back in time: their clock ran out long ago, so they get the 5 second top-up (or, with no
      // limit, all the time they want).
      vi.setSystemTime(later + 3_000);
      await r.connect(first);
      expect(holder().name).toBe(first);
      expect(s().turnDeadline).toBe(limit === null ? null : later + 3_000 + 5_000);
    });

    it("plays for the player to move if they don't come back after a deploy", async () => {
      const start = await playing(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await start.r.restart();
      const { s, holder } = peek(r);
      await r.connect(start.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + AWAY_MS);
      expect(s().turnDeadline).toBe(deadline);
      expect(s().timer).toEqual({ kind: "away", at: deadline });
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r);
      // A line was drawn for them (an empty board: no boxes, so the turn passes).
      expect(s().order).toHaveLength(1);
      expect(holder().name).toBe(start.other);
    });
  });
}

describe("reloading for time", () => {
  it("can't keep buying a fresh clock", async () => {
    const { r, s, holder, first, socket } = await playing(30);
    // Reload with a second left, again and again.
    let ws = socket[first];
    vi.setSystemTime(T0 + 29_000);
    await r.drop(ws);
    ws = await r.connect(first);
    expect(s().turnDeadline).toBe(T0 + 29_000 + 5_000);
    for (const at of [31_000, 33_000]) {
      vi.setSystemTime(T0 + at);
      await r.drop(ws);
      ws = await r.connect(first);
      expect(s().turnDeadline).toBeLessThanOrEqual(T0 + 34_000);
    }
    await fireAlarm(r);
    expect(holder().name).not.toBe(first);
    expect(s().order).toHaveLength(1);
    expect(Date.now()).toBeLessThanOrEqual(T0 + 34_000);
  });
});
