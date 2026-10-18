// The room around the game: the kit's Room and this game's GameRoom, run with fake sockets and
// storage. Covers what only shows up with the real order of things in a hello, and resyncs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESYNC_MS } from "../src/shared/constants";
import type { GameState, Snapshot } from "../src/shared/protocol";
import type { Live } from "../src/worker/game";
import { GameRoom } from "../src/worker/room";

type Json = Record<string, unknown>;

const internals = (room: GameRoom) => room as unknown as { state: GameState | null; live: Live | null };

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  received: Json[] = [];
  private attachment: unknown = null;
  serializeAttachment(a: unknown) {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(raw: string) {
    this.received.push(JSON.parse(raw));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
  count(t: string): number {
    return this.received.filter((m) => m.t === t).length;
  }
}

/** Durable Object storage in a Map, copying values in and out like the real thing. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys: string | string[]) {
      if (Array.isArray(keys)) return new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      return structuredClone(data.get(keys));
    },
    async put(a: string | Json, v?: unknown) {
      if (typeof a === "string") data.set(a, structuredClone(v));
      else for (const [k, val] of Object.entries(a)) data.set(k, structuredClone(val));
    },
    async setAlarm() {},
    async deleteAlarm() {},
    async deleteAll() {
      data.clear();
    },
  };
}

/** A room over `storage`: a new game, or the same game after a restart (no sockets, no round in memory). */
async function openRoom(storage = fakeStorage()) {
  const pending: Promise<void>[] = [];
  const sockets: FakeSocket[] = [];
  const ctx = {
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn: () => Promise<void>) => pending.push(fn()),
    storage,
    getWebSockets: () => sockets,
  };
  const room = new GameRoom(ctx as never, {});
  await Promise.all(pending);
  if (!storage.data.has("state")) await room.init("ABCDE");
  const say = (ws: FakeSocket, msg: Json) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const connect = async (name: string) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await say(ws, { t: "hello", token: `token-${name}`, name });
    return ws;
  };
  const s = () => internals(room).state!;
  return { room, storage, say, connect, s, live: () => internals(room).live };
}

/** Ann and a CPU, a little way into a round. */
async function midRound() {
  const r = await openRoom();
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
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the room", () => {
  it("seats a newcomer whose hello is the first thing after a restart", async () => {
    const { storage, s } = await midRound();
    expect(s().players.map((p) => p.slot)).toEqual([0, 1]);

    // A deploy: the same storage, no sockets, and the round's board gone.
    const after = await openRoom(storage);
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
    const snaps = (ws: FakeSocket) => ws.count("snap");
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
