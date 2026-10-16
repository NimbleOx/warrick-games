// The client's reconnecting socket, with a fake WebSocket and fake timers. A dead socket here is
// one that says it's open but never hears anything again, and never fires `onclose` either.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_FULL, CLOSE_STALE } from "../src/shared/constants";
import type { reloadOnce as ReloadOnce } from "../src/client/dom";
import type { ClockSync as ClockSyncType, Connection as ConnectionType, NetHandlers, NetStatus } from "../src/client/net";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  /** Like the room's auto-response: every "ping" gets a "pong". */
  answering = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
    if (data === "ping" && this.answering) queueMicrotask(() => this.hear("pong"));
  }
  /** The client giving up on it. A dead socket never gets as far as `onclose`. */
  close() {
    this.readyState = FakeWebSocket.CLOSING;
  }
  // The server's side.
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  hear(data: string) {
    this.onmessage?.({ data });
  }
  shut(code: number) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

let Connection: typeof ConnectionType;
let ClockSync: typeof ClockSyncType;
let reloadOnce: typeof ReloadOnce;
const reloads = { n: 0 };

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", protocol: "http:", host: "localhost", reload: () => reloads.n++ });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  ({ Connection, ClockSync } = await import("../src/client/net"));
  ({ reloadOnce } = await import("../src/client/dom"));
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function connect(extra: Partial<NetHandlers<{ t: string }, { t: string }>> = {}) {
  const statuses: NetStatus[] = [];
  const messages: unknown[] = [];
  const fatal: string[] = [];
  const conn = new Connection("ABCDE", {
    hello: () => ({ t: "hello" }),
    message: (m) => messages.push(m),
    status: (s) => statuses.push(s),
    fatal: (r) => fatal.push(r),
    ...extra,
  });
  const socket = (i: number) => FakeWebSocket.all[i];
  return { conn, statuses, messages, fatal, socket };
}

describe("connection", () => {
  it("gives up on an open socket that stops answering, and reconnects", async () => {
    const { socket, statuses } = connect();
    socket(0).accept();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket(0).sent).toContain("ping");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(statuses.at(-1)).toBe("closed");
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(statuses.at(-1)).toBe("connecting");
  });

  it("keeps a socket that answers", async () => {
    const { conn, socket, statuses } = connect();
    socket(0).accept();
    socket(0).answering = true;
    conn.nudge();
    conn.heartbeat(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe("open");
  });

  it("checks an open socket when nudged (the tab is back, or the network changed)", async () => {
    const { conn, socket } = connect();
    socket(0).accept();
    await vi.advanceTimersByTimeAsync(3_000);
    conn.nudge();
    expect(socket(0).sent.at(-1)).toBe("ping");
    await vi.advanceTimersByTimeAsync(8_500);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("checks often while a game is live", async () => {
    const { conn, socket } = connect();
    socket(0).accept();
    conn.heartbeat(true);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("ignores a socket it gave up on, if it turns out to be alive after all", async () => {
    const { conn, socket, messages } = connect();
    socket(0).accept();
    conn.nudge();
    await vi.advanceTimersByTimeAsync(8_500);
    socket(1).accept();
    socket(0).hear(JSON.stringify({ t: "state" }));
    socket(0).shut(1006);
    expect(messages).toEqual([]);
    // The new socket's own checks carry on.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket(1).sent).toContain("ping");
  });

  it("gives up on a socket that never opens", async () => {
    const { socket } = connect();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket(0).readyState).toBe(FakeWebSocket.CLOSING);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("stops for good when the game is full", async () => {
    const { socket, fatal } = connect();
    socket(0).accept();
    socket(0).shut(CLOSE_FULL);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fatal).toEqual(["That game is full."]);
    expect(FakeWebSocket.all).toHaveLength(1);
  });
});

describe("a new version", () => {
  it("hands a stale page to the shell, and stops", async () => {
    let stale = 0;
    const { socket, fatal } = connect({ stale: () => stale++ });
    socket(0).accept();
    socket(0).shut(CLOSE_STALE);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stale).toBe(1);
    expect(fatal).toEqual([]);
    expect(FakeWebSocket.all).toHaveLength(1);
  });

  it("is fatal without a handler", async () => {
    const { socket, fatal } = connect();
    socket(0).accept();
    socket(0).shut(CLOSE_STALE);
    expect(fatal).toEqual(["This game has been updated. Reload the page to keep playing."]);
  });

  it("reloads a tab once, not again straight after", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
    reloads.n = 0;
    expect(reloadOnce("x.reloadedAt")).toBe(true);
    expect(reloadOnce("x.reloadedAt")).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(reloadOnce("x.reloadedAt")).toBe(true);
    expect(reloads.n).toBe(2);
  });

  it("doesn't reload at all without session storage to stop a loop", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    reloads.n = 0;
    expect(reloadOnce("x.reloadedAt")).toBe(false);
    expect(reloads.n).toBe(0);
  });
});

describe("clock sync", () => {
  it("pings with our clock while a game is live", async () => {
    const { conn, socket } = connect();
    socket(0).accept();
    socket(0).answering = true;
    conn.heartbeat(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket(0).sent.map((m) => (m === "ping" ? m : JSON.parse(m)))).toContainEqual({ t: "ping", c: Date.now() });
  });

  it("takes the server's clock from the quickest round trip", () => {
    vi.setSystemTime(1_000_000);
    const clock = new ClockSync();
    // Before any pong: the newest message, off by however long it took.
    clock.message(1_005_000);
    expect(clock.skew).toBe(5_000);
    // A slow round trip (400 ms), then a quick one (40 ms): the server is 5 s ahead.
    vi.setSystemTime(1_000_400);
    clock.pong(1_005_200, 1_000_000);
    expect(clock.skew).toBe(5_000);
    vi.setSystemTime(1_001_040);
    clock.pong(1_006_020, 1_001_000);
    expect(clock.skew).toBe(5_000);
    // A message no longer moves it; a jittery pong doesn't either.
    clock.message(1_009_000);
    vi.setSystemTime(1_002_500);
    clock.pong(1_007_400, 1_002_000);
    expect(clock.skew).toBe(5_000);
    // Starting over, messages count again until a ping is back.
    clock.reset();
    clock.message(1_002_500);
    expect(clock.skew).toBe(0);
  });
});
