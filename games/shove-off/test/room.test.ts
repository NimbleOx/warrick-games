// The game through the real room, the way browsers use it: reloads, second tabs, everyone gone,
// and deploys. The room reads Date.now(), so the clock is faked; alarms fire when a test says so.
import { type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellNamed } from "../src/shared/hex";
import type { GameState } from "../src/shared/protocol";
import { AWAY_MS, CPU_MS } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

const T0 = 1_000_000_000_000;
const CLEANUP = 12 * 3600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function peek(r: TestRoom<GameRoom>) {
  const s = () => internals<GameState>(r.room).state!;
  return { s, holder: () => s().players.find((p) => p.id === s().turnPlayerId)! };
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
  return {
    r,
    s,
    holder,
    first,
    other: first === "Ann" ? "Bo" : "Ann",
    socket: { Ann: ann, Bo: bo } as Record<string, typeof ann>,
  };
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: TestRoom<GameRoom>) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

/** C3 C4 C5 up a row: seat 0's first move in the classic layout. */
const OPENING = { marbles: ["C3", "C4", "C5"].map(cellNamed), dir: 2 };

for (const turnSeconds of [0, 30]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, ${turnSeconds ? `${turnSeconds} seconds a turn` : "with the timer off"}`, () => {
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
      expect(r.storage.alarm()).toBe(limit ?? T0 + 21_000 + CLEANUP);
    });

    it("moves on from the player to move if they don't come back after a deploy", async () => {
      const start = await playing(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await start.r.restart();
      const { s, holder } = peek(r);
      await r.connect(start.other);
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + AWAY_MS);
      expect(s().turnDeadline).toBe(deadline);
      expect(s().timer).toEqual({ kind: "away", at: deadline });
      await fireAlarm(r);
      expect(holder().name).toBe(start.other);
      expect(s().players.find((p) => p.name === start.first)!.missed).toBe(1);
    });
  });
}

describe("moves through the room", () => {
  it("sends the move to everyone, with the last move to slide the marbles", async () => {
    const { r, s, first, other, socket } = await playing(0);
    await r.say(socket[other], { t: "move", move: OPENING });
    expect(socket[other].last("error")).toEqual({ t: "error", message: "It's not your turn" });
    await r.say(socket[first], { t: "move", move: { marbles: [cellNamed("A1")], dir: 4 } });
    expect(socket[first].last("error")).toEqual({ t: "error", message: "You can't push your own marbles off the board" });
    await r.say(socket[first], { t: "move", move: OPENING });
    const seen = (socket[other].last("state") as { state: GameState }).state;
    expect(seen).toMatchObject({ moves: 1, turns: 1, last: { seat: 0, dir: 2, off: -1 } });
    expect(seen.turnPlayerId).toBe(s().players.find((p) => p.name === other)!.id);
  });

  it("resigns, then the host starts the next game with the other player moving first", async () => {
    const { r, s, first, other, socket } = await playing(0);
    await r.say(socket[first], { t: "resign" });
    expect(s()).toMatchObject({ phase: "gameover", ending: "resigned" });
    await r.say(socket.Ann, { t: "lobby" });
    await r.say(socket.Ann, { t: "start" });
    expect(s().phase).toBe("playing");
    expect(peek(r).holder().name).toBe(other);
  });
});

describe("against the CPU", () => {
  it("plays its moves off the alarm, through a deploy, and waits for its player", async () => {
    const r = await openRoom(GameRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "settings", settings: { turnSeconds: 30 } });
    await r.say(ann, { t: "start" });
    const { s, holder } = peek(r);
    expect(s().players.map((p) => p.cpu)).toEqual([null, "normal"]);
    if (holder().cpu) {
      expect(r.storage.alarm()).toBe(T0 + CPU_MS);
      await fireAlarm(r);
    }
    expect(holder().name).toBe("Ann");
    // No clock against a CPU: only the room's clean-up alarm is set.
    expect(s()).toMatchObject({ turnDeadline: null, timer: null });
    const moved = s().moves;
    await r.say(ann, {
      t: "move",
      move: s().seats[0] === s().turnPlayerId ? OPENING : { marbles: ["G5", "G6", "G7"].map(cellNamed), dir: 5 },
    });
    expect(ann.all("error")).toHaveLength(0);
    expect(s().moves).toBe(moved + 1);
    expect(s().timer?.kind).toBe("cpu");

    // A deploy before the CPU moves: Ann's page reconnects, and the CPU still moves.
    const after = await r.restart();
    const again = await after.connect("Ann");
    await fireAlarm(after);
    const { s: s2, holder: h2 } = peek(after);
    expect(s2().moves).toBe(moved + 2);
    expect(h2().name).toBe("Ann");
    // Ann's gone for an hour: nothing passes.
    await after.drop(again);
    vi.setSystemTime(Date.now() + 3_600_000);
    const back = await after.connect("Ann");
    expect(h2().name).toBe("Ann");
    expect(s2()).toMatchObject({ phase: "playing", timer: null });
    expect(back.all("error")).toHaveLength(0);
  });
});
