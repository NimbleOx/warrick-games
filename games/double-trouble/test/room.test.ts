// The room around the game: the kit's Room and this game's GameRoom, run with fake sockets and
// storage, the way a browser plays a solo round through it.
import { internals, openRoom, type FakeSocket, type TestRoom } from "@warrick/kit/testing/room";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { choose } from "../src/shared/ai";
import { COUNTDOWN_MS } from "../src/shared/constants";
import { Lane } from "../src/shared/engine";
import type { GameState, RoundSnap } from "../src/shared/protocol";
import type { Live } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

async function open(r?: TestRoom<GameRoom>) {
  const room = r ?? (await openRoom(GameRoom));
  const s = () => internals<GameState, Live>(room.room).state!;
  return { ...room, s, live: () => internals<GameState, Live>(room.room).live };
}

/** The round as the newest message that carries one has it. */
function lastSnap(ws: FakeSocket): RoundSnap {
  const m = ws.received.filter((x) => x.t === "snap" || x.t === "welcome").at(-1) as { snap: RoundSnap };
  return m.snap;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a solo round", () => {
  it("starts with one player and ends when their board is stuck", async () => {
    const r = await open();
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "start" });
    expect(r.s().phase).toBe("playing");
    const snap = lastSnap(ann);
    expect(snap.solo).toBe(true);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);

    // Ann's browser plays its own board and sends each move.
    const lane = Lane.fromSnap(snap.seats[0]!);
    const rng = mulberry32(3);
    for (let i = 0; i < 5000 && !lane.out; i++) {
      const d = choose(lane, "normal", rng);
      if (d === null) break;
      const k = lane.n;
      lane.move(d, 0);
      await r.say(ann, { t: "mv", e: 0, k, d, g: 0, ck: lane.checksum() });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(lane.out).toBe(true);
    expect(ann.all("fix")).toHaveLength(0);
    const state = (ann.last("state") as { state: GameState }).state;
    expect(state.phase).toBe("results");
    expect(state.results).toMatchObject({ solo: true, winnerId: null });
    expect(state.results!.standings[0]).toMatchObject({ id: ann.you, score: lane.score, best: lane.best, moves: lane.n });
    expect(r.live()).toBeNull();
  });

  it("starts the round over, still solo, after a deploy", async () => {
    const r = await open();
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "start" });
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS + 2000);
    const after = await open(await r.restart());
    expect(after.live()).toBeNull();
    const back = await after.connect("Ann");
    expect(back.you).toBe(ann.you);
    expect(after.s().phase).toBe("playing");
    const snap = lastSnap(back);
    expect(snap.solo).toBe(true);
    expect(snap.seats[0]!.n).toBe(0);
  });
});
