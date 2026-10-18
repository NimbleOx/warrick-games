// Run a game's real Room in Node, with fake sockets and storage, to test it the way browsers use
// it: hellos, messages, closes, alarms, restarts and hibernation.
//
// The game's vitest config needs the Workers runtime module swapped for the kit's stub:
//   resolve: { alias: { "cloudflare:workers": "@warrick/kit/testing/cloudflare-workers" } }
// To move the clock, use fake timers (vi.useFakeTimers() and vi.setSystemTime()): the room reads
// Date.now(). Alarms don't fire by themselves; call `room.alarm()` once the clock reaches
// `storage.alarm()`.
import type { BaseState, LogEntry } from "../shared/protocol";
import type { Room } from "../worker/room";

export type Json = Record<string, unknown>;

type AnyRoom = Room<any, any, any>;
type RoomClass<R extends AnyRoom> = new (ctx: DurableObjectState, env: unknown) => R;

/** A server-side WebSocket: what the room sends it, how it was closed, and its attachment. */
export class FakeSocket {
  readyState: number = WebSocket.OPEN;
  /** Every message the room sent, parsed. */
  received: Json[] = [];
  /** The code the room closed it with, if it did. */
  closedWith: number | null = null;
  /** The player id from this socket's welcome. */
  you = "";
  /** How often the room read the attachment. */
  reads = 0;
  /** Runs for each message the room sends, as it's sent (to record what the room knew then, say). */
  onSend: ((msg: Json) => void) | null = null;
  private attachment: unknown = null;

  serializeAttachment(a: unknown): void {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment(): unknown {
    this.reads++;
    return this.attachment;
  }
  send(raw: string): void {
    const msg = JSON.parse(raw) as Json;
    if (msg.t === "welcome" && typeof msg.you === "string") this.you = msg.you;
    this.received.push(msg);
    this.onSend?.(msg);
  }
  close(code = 1000): void {
    if (this.readyState === WebSocket.OPEN) this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }
  /** The messages of one type. */
  all(t: string): Json[] {
    return this.received.filter((m) => m.t === t);
  }
  /** The last message of one type. */
  last(t: string): Json | undefined {
    return this.all(t).at(-1);
  }
}

/** Durable Object storage in a Map, copying values in and out like the real thing. */
export function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  let puts = 0;
  return {
    data,
    /** When the alarm is set for, or null. */
    alarm: () => alarm,
    /** How many writes there have been. */
    puts: () => puts,
    async get(keys: string | string[]) {
      if (Array.isArray(keys)) return new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      return structuredClone(data.get(keys));
    },
    async put(a: string | Json, v?: unknown) {
      puts++;
      if (typeof a === "string") data.set(a, structuredClone(v));
      else for (const [k, val] of Object.entries(a)) data.set(k, structuredClone(val));
    },
    async delete(k: string) {
      return data.delete(k);
    },
    async setAlarm(at: number) {
      alarm = at;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async deleteAll() {
      data.clear();
    },
  };
}

export type FakeStorage = ReturnType<typeof fakeStorage>;

/** What a room keeps that a test may want to look at. */
export function internals<S extends BaseState = BaseState, L = unknown>(room: AnyRoom) {
  return room as unknown as { state: S | null; live: L | null; tokens: Record<string, string>; log: LogEntry[] };
}

export interface TestRoom<R extends AnyRoom> {
  room: R;
  storage: FakeStorage;
  /** Every socket the room has (closed ones too, until a restart). */
  sockets: FakeSocket[];
  /** A new browser tab says hello: `token` stands for the browser (default: one per name). */
  connect(name: string, token?: string): Promise<FakeSocket>;
  /** A socket sends a message. */
  say(ws: FakeSocket, msg: Json): Promise<void>;
  /** A socket closes (a tab closed, a network gone). */
  drop(ws: FakeSocket): Promise<void>;
  /** A deploy: every socket closes, and a new instance of the room loads the same storage. */
  restart(): Promise<TestRoom<R>>;
  /** The room hibernates and wakes: a new instance over the same storage and the same sockets. */
  wake(): Promise<TestRoom<R>>;
}

/**
 * A room of class `Kind`: a new game with code `code`, or, given the `storage` (and `sockets`) of
 * one, the same game loaded again.
 */
export async function openRoom<R extends AnyRoom>(
  Kind: RoomClass<R>,
  opts: { storage?: FakeStorage; sockets?: FakeSocket[]; code?: string } = {},
): Promise<TestRoom<R>> {
  const storage = opts.storage ?? fakeStorage();
  const sockets = opts.sockets ?? [];
  const g = globalThis as { WebSocketRequestResponsePair?: unknown };
  g.WebSocketRequestResponsePair ??= class {};
  const pending: Promise<void>[] = [];
  const ctx = {
    setWebSocketAutoResponse: () => {},
    // The runtime holds every event until the constructors' loading is done; so does this.
    blockConcurrencyWhile: (fn: () => Promise<void>) => pending.push(fn()),
    storage,
    getWebSockets: () => sockets,
  };
  const room = new Kind(ctx as unknown as DurableObjectState, {});
  await Promise.all(pending);
  if (!storage.data.has("state")) await room.init(opts.code ?? "ABCDE");

  const say = (ws: FakeSocket, msg: Json) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
  return {
    room,
    storage,
    sockets,
    say,
    async connect(name, token = `token-${name.toLowerCase().replace(/\W/g, "")}-0000`) {
      const ws = new FakeSocket();
      sockets.push(ws);
      await say(ws, { t: "hello", token, name });
      return ws;
    },
    async drop(ws) {
      ws.readyState = WebSocket.CLOSED;
      await room.webSocketClose(ws as unknown as WebSocket);
    },
    async restart() {
      for (const ws of sockets) ws.readyState = WebSocket.CLOSED;
      return openRoom(Kind, { storage });
    },
    async wake() {
      return openRoom(Kind, { storage, sockets });
    },
  };
}
