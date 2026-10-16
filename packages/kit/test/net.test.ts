// The client's reconnecting socket, with a fake WebSocket and fake timers. A dead socket here is
// one that says it's open but never hears anything again, and never fires `onclose` either.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_FULL } from "../src/shared/constants";
import type { Connection as ConnectionType, NetStatus } from "../src/client/net";

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

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", protocol: "http:", host: "localhost" });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  ({ Connection } = await import("../src/client/net"));
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function connect() {
  const statuses: NetStatus[] = [];
  const messages: unknown[] = [];
  const fatal: string[] = [];
  const conn = new Connection("ABCDE", {
    hello: () => ({ t: "hello" }),
    message: (m) => messages.push(m),
    status: (s) => statuses.push(s),
    fatal: (r) => fatal.push(r),
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
