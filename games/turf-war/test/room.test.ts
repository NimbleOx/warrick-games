// The room around the game: the kit's Room and this game's GameRoom, run with fake sockets and
// storage. Covers what only shows up with the real order of things in a hello, and resyncs.
import { internals, openRoom, type FakeSocket, type TestRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESYNC_MS } from "../src/shared/constants";
import type { GameState, Snapshot } from "../src/shared/protocol";
import type { Live } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

/** The kit's test room, plus this game's state and round. */
async function open(r?: TestRoom<GameRoom>) {
  const room = r ?? (await openRoom(GameRoom));
  const s = () => internals<GameState, Live>(room.room).state!;
  return { ...room, s, live: () => internals<GameState, Live>(room.room).live };
}

/** Ann and a CPU, a little way into a round. */
async function midRound() {
  const r = await open();
  const ann = await r.connect("Ann");
  await r.say(ann, { t: "addCpu", level: "easy" });
  await r.say(ann, { t: "start" });
  expect(r.s().phase).toBe("playing");
  await vi.advanceTimersByTimeAsync(2000);
  expect(r.live()!.round.n).toBeGreaterThan(10);
  return { ...r, ann };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the room", () => {
  it("seats a newcomer whose hello is the first thing after a restart", async () => {
    const r = await midRound();
    expect(r.s().players.map((p) => p.slot)).toEqual([0, 1]);

    // A deploy: the same storage, no sockets, and the round's board gone.
    const after = await open(await r.restart());
    expect(after.live()).toBeNull();
    const cy = await after.connect("Cy");
    const welcome = cy.received.find((m) => m.t === "welcome") as { you: string; state: GameState; snap: Snapshot };
    const me = welcome.state.players.find((p) => p.id === welcome.you)!;
    expect(me).toMatchObject({ name: "Cy", spectator: false, slot: 2 });
    expect(welcome.snap.n).toBe(0);
    expect(welcome.snap.heads[2][2]).toBe(1); // alive
    expect(after.live()!.round.inRound.slice(0, 3)).toEqual([true, true, true]);
  });

  it("answers each socket's resyncs once a second at most", async () => {
    const { say, connect, ann } = await midRound();
    const bo = await connect("Bo");
    const snaps = (ws: FakeSocket) => ws.all("snap").length;
    const before = snaps(ann);

    await say(ann, { t: "resync" });
    expect(snaps(ann)).toBe(before + 1);
    for (let i = 0; i < 20; i++) await say(ann, { t: "resync" });
    expect(snaps(ann)).toBe(before + 1);

    // Another socket has its own allowance.
    await say(bo, { t: "resync" });
    expect(snaps(bo)).toBe(1);

    // A client whose ask was dropped asks again on its next gap, and gets its snapshot.
    vi.setSystemTime(Date.now() + RESYNC_MS - 1);
    await say(ann, { t: "resync" });
    expect(snaps(ann)).toBe(before + 1);
    vi.setSystemTime(Date.now() + 1);
    await say(ann, { t: "resync" });
    expect(snaps(ann)).toBe(before + 2);
  });
});
