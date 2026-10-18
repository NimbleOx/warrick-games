import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasePlayer, BaseState } from "../src/shared/protocol";
import { Lobby, baseState, type GameIO } from "../src/worker/lobby";
import { Room } from "../src/worker/room";

type State = BaseState<BasePlayer>;

let ticks = 0;

class TickGame extends Lobby<State> {
  protected readonly choices = {};
  protected createPlayer(base: BasePlayer): BasePlayer {
    return base;
  }
  start(byId: string): void {
    this.beginStart(byId);
    this.s.phase = "playing";
    this.touch();
  }
  tick(): void {
    ticks++;
    // A tick takes a little while to run.
    vi.setSystemTime(Date.now() + 5);
  }
}

class TickRoom extends Room<State, TickGame> {
  protected readonly tickMs = 50;
  protected newState(code: string, now: number): State {
    return baseState(code, now, {});
  }
  protected makeGame(state: State, io: GameIO): TickGame {
    return new TickGame(state, io);
  }
  protected wantsLoop(state: State): boolean {
    return state.phase === "playing";
  }
}

function fakeSocket() {
  let attachment: unknown = null;
  return {
    readyState: WebSocket.OPEN,
    serializeAttachment: (a: unknown) => (attachment = a),
    deserializeAttachment: () => attachment,
    send: () => {},
    close: () => {},
  };
}

async function openRoom() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  // The runtime holds every event until the constructor's load finishes; so does this.
  let loaded: Promise<void> = Promise.resolve();
  const ctx = {
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn: () => Promise<void>) => (loaded = fn()),
    storage: {
      get: async () => new Map(),
      put: async () => {},
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => {},
    },
    getWebSockets: () => sockets,
  };
  const room = new TickRoom(ctx as never, {});
  await loaded;
  await room.init("ABCDE");
  const ws = fakeSocket();
  sockets.push(ws);
  const say = (msg: object) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  await say({ t: "hello", token: "token-12345678", name: "Ann" });
  return { say, sockets };
}

describe("room tick loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    ticks = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps time: ticks land on schedule even though each one takes a while", async () => {
    const { say } = await openRoom();
    await say({ t: "addCpu", level: "easy" });
    await say({ t: "start" });
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(2000);
    // One tick per 50 ms of clock time, work included. Restarting the schedule after every tick
    // would make it one per 55 ms (50 ms after the last tick finished).
    const expected = (Date.now() - t0) / 50;
    expect(Math.abs(ticks - expected)).toBeLessThanOrEqual(1.5);
  });

  it("stops when nobody is connected", async () => {
    const { say, sockets } = await openRoom();
    await say({ t: "addCpu", level: "easy" });
    await say({ t: "start" });
    await vi.advanceTimersByTimeAsync(500);
    const before = ticks;
    sockets[0].readyState = WebSocket.CLOSED;
    await vi.advanceTimersByTimeAsync(500);
    expect(ticks - before).toBeLessThanOrEqual(1);
  });
});
