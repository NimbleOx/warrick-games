// The room's connection lifecycle: hellos, watchers, restarts, hibernation, the alarm and rate
// limits. It runs the kit's Room with fake sockets and storage, and a small turn-based game
// whose away timer works like Liar's Dice's: no turn timer, but a player who is away on their
// turn is skipped after a grace.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_FULL, MAX_PLAYERS, MAX_SPECTATORS } from "../src/shared/constants";
import type { BasePlayer, BaseState, LogEntry } from "../src/shared/protocol";
import { Lobby, baseState, type GameIO } from "../src/worker/lobby";
import { Room, type RateLimit } from "../src/worker/room";

type Json = Record<string, unknown>;
interface State extends BaseState<BasePlayer> {
  turn: string | null;
  timer: number | null;
}

const AWAY_MS = 5000;
const GC_MS = 12 * 60 * 60 * 1000;
const T0 = 1_000_000_000_000;

/** Every `setConnected` the game was told about, in order. */
let heard: string[] = [];
let timersRun = 0;
/** Make `onTimer` do nothing, like a game with a bug. */
let stuck = false;

class TurnGame extends Lobby<State> {
  protected readonly choices = {};
  protected createPlayer(base: BasePlayer): BasePlayer {
    return base;
  }
  start(byId: string): void {
    this.beginStart(byId);
    this.s.phase = "playing";
    this.s.turn = this.participants[0].id;
    this.touch();
  }
  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    heard.push(`${p.name} ${connected ? "back" : "gone"}`);
    super.setConnected(id, connected);
    if (this.s.phase === "playing" && this.s.turn === id) this.s.timer = connected ? null : this.io.now() + AWAY_MS;
  }
  onTimer(): void {
    timersRun++;
    if (stuck) return;
    const ids = this.participants.map((p) => p.id);
    this.s.turn = ids[(ids.indexOf(this.s.turn!) + 1) % ids.length];
    this.s.timer = this.io.isConnected(this.s.turn) ? null : this.io.now() + AWAY_MS;
    this.touch();
  }
}

class TurnRoom extends Room<State, TurnGame> {
  protected newState(code: string, now: number): State {
    return { ...baseState(code, now, {}), turn: null, timer: null };
  }
  protected makeGame(state: State, io: GameIO): TurnGame {
    return new TurnGame(state, io);
  }
  protected timerAt(state: State): number | null {
    return state.timer;
  }
}

/** The same room with a tight limit on everything, to see the limit work. */
class TightRoom extends TurnRoom {
  protected readonly rateLimits: { any: RateLimit; lobby: RateLimit } = {
    any: { burst: 5, perSec: 5 },
    lobby: { burst: 10, perSec: 2 },
  };
}

/** Like Ricochet Alley's room: its own cache of each socket's player, which it clears after a hello. */
class CachingRoom extends TurnRoom {
  private cached = new WeakMap<WebSocket, string | null>();
  protected connectedIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      if (!this.cached.has(ws)) this.cached.set(ws, (ws.deserializeAttachment() as { pid: string | null } | null)?.pid ?? null);
      const pid = this.cached.get(ws);
      if (pid) ids.add(pid);
    }
    return ids;
  }
  protected afterHello(): void {
    this.cached = new WeakMap();
  }
}

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  closedWith: number | null = null;
  received: Json[] = [];
  /** How often the room read the attachment. */
  reads = 0;
  private attachment: unknown = null;
  serializeAttachment(a: unknown) {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment() {
    this.reads++;
    return this.attachment;
  }
  send(raw: string) {
    this.received.push(JSON.parse(raw));
  }
  close(code = 1000) {
    if (this.readyState === WebSocket.OPEN) this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }
  last(t: string): Json | undefined {
    return this.received.filter((m) => m.t === t).at(-1);
  }
}

/** Durable Object storage in a Map, copying values in and out like the real thing. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  let puts = 0;
  return {
    data,
    alarm: () => alarm,
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

type Storage = ReturnType<typeof fakeStorage>;
const internals = (room: Room<State, TurnGame>) => room as unknown as { state: State; tokens: Record<string, string>; log: LogEntry[] };

/**
 * A room over `storage`: a new game, the same game after a restart (no sockets), or after
 * hibernation (pass the sockets, which survive it).
 */
async function openRoom(storage: Storage = fakeStorage(), sockets: FakeSocket[] = [], Kind = TurnRoom) {
  const pending: Promise<void>[] = [];
  const ctx = {
    setWebSocketAutoResponse: () => {},
    // The runtime holds every event until the constructor's loading is done; so does this.
    blockConcurrencyWhile: (fn: () => Promise<void>) => pending.push(fn()),
    storage,
    getWebSockets: () => sockets,
  };
  const room = new Kind(ctx as never, {});
  await Promise.all(pending);
  if (!storage.data.has("state")) await room.init("ABCDE");

  const say = (ws: FakeSocket, msg: Json) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const connect = async (name: string, token = `token-${name}`) => {
    const ws = new FakeSocket();
    sockets.push(ws);
    await say(ws, { t: "hello", token, name });
    return ws;
  };
  const drop = async (ws: FakeSocket) => {
    ws.readyState = WebSocket.CLOSED;
    await room.webSocketClose(ws as never);
  };
  const s = () => internals(room).state;
  const id = (name: string) => s().players.find((p) => p.name === name)!.id;
  return { room, storage, sockets, say, connect, drop, s, id };
}

/** Ann and Bo in a game, with Ann to play. */
async function midGame() {
  const r = await openRoom();
  const ann = await r.connect("Ann");
  const bo = await r.connect("Bo");
  await r.say(ann, { t: "start" });
  expect(r.s().turn).toBe(r.id("Ann"));
  expect(r.s().timer).toBeNull();
  heard = [];
  return { ...r, ann, bo };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
  heard = [];
  timersRun = 0;
  stuck = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hello", () => {
  it("only counts once per socket: another hello can't leave a ghost behind", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    for (let i = 0; i < 50; i++) await r.say(ann, { t: "hello", token: `fresh-token-${i}`, name: `Ghost ${i}` });
    expect(r.s().players.map((p) => p.name)).toEqual(["Ann"]);
    await r.drop(ann);
    expect(r.s().players.filter((p) => p.connected)).toEqual([]);
  });

  it("caps watchers: gone ones make space, and past that the socket is turned away", async () => {
    const r = await openRoom();
    for (let i = 0; i < MAX_PLAYERS + MAX_SPECTATORS; i++) await r.connect(`P${i}`);
    expect(r.s().players.filter((p) => p.spectator)).toHaveLength(MAX_SPECTATORS);

    const late = await r.connect("Late");
    expect(late.closedWith).toBe(CLOSE_FULL);
    expect(r.s().players).toHaveLength(MAX_PLAYERS + MAX_SPECTATORS);

    // A watcher leaves: they're forgotten (and so is their token) to make space for the next.
    const gone = r.id(`P${MAX_PLAYERS}`);
    await r.drop(r.sockets[MAX_PLAYERS]);
    const next = await r.connect("Next");
    expect(next.closedWith).toBeNull();
    expect(r.s().players.some((p) => p.id === gone)).toBe(false);
    expect(Object.values(internals(r.room).tokens)).not.toContain(gone);
    expect(r.s().players).toHaveLength(MAX_PLAYERS + MAX_SPECTATORS);
  });

  it("reads each socket's player from its attachment once", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    const [reads, before] = [ann.reads, ann.received.length];
    for (let i = 0; i < 5; i++) await r.say(ann, { t: "chat", text: `hi ${i}` });
    expect(ann.received.slice(before).filter((m) => m.t === "log")).toHaveLength(5);
    expect(ann.reads).toBe(reads);
  });
});

describe("after a restart", () => {
  it("tells the game who went, so an away timer starts for whoever was to play", async () => {
    const { storage } = await midGame();
    // A deploy: a new instance over the same storage, and every socket gone.
    const r = await openRoom(storage);
    await r.connect("Bo");
    // Bo is back before the game hears about the others, so Bo was never away.
    expect(heard).toEqual(["Ann gone"]);
    expect(r.s().timer).toBe(T0 + AWAY_MS);
    expect(storage.alarm()).toBe(T0 + AWAY_MS);
    expect(r.s().players.find((p) => p.name === "Bo")?.connected).toBe(true);

    vi.setSystemTime(T0 + AWAY_MS);
    await r.room.alarm();
    expect(r.s().turn).toBe(r.id("Bo"));
  });

  it("also when the alarm comes first, without counting it as activity", async () => {
    const { storage, s } = await midGame();
    const lastActive = s().lastActive;
    vi.setSystemTime(T0 + 60_000);
    const r = await openRoom(storage);
    await r.room.alarm();
    expect(heard).toEqual(["Ann gone", "Bo gone"]);
    expect(r.s().timer).toBe(T0 + 60_000 + AWAY_MS);
    expect(r.s().lastActive).toBe(lastActive);
    // Nobody is here, so timers wait.
    expect(timersRun).toBe(0);
    expect(storage.alarm()).toBe(lastActive + GC_MS);
    await r.connect("Bo");
    expect(storage.alarm()).toBe(T0 + 60_000 + AWAY_MS);
  });

  it("counts whoever says hello as back, even if the game's own socket cache hasn't caught up", async () => {
    const { storage } = await midGame();
    const sockets: FakeSocket[] = [];
    const r = await openRoom(storage, sockets, CachingRoom);
    // Bo's new socket is seen before Bo says hello (by a broadcast, say), so the cache has no player for it.
    const bo = new FakeSocket();
    sockets.push(bo);
    (r.room as unknown as { connectedIds(): Set<string> }).connectedIds();
    await r.say(bo, { t: "hello", token: "token-Bo", name: "Bo" });
    expect(heard).toEqual(["Ann gone"]);
    expect(r.s().players.find((p) => p.name === "Bo")?.connected).toBe(true);
  });

  it("only tells the game once", async () => {
    const { storage } = await midGame();
    const r = await openRoom(storage);
    const bo = await r.connect("Bo");
    await r.say(bo, { t: "chat", text: "anyone?" });
    await r.room.alarm();
    expect(heard).toEqual(["Ann gone"]);
  });
});

describe("waking from hibernation", () => {
  it("tells the game about a socket that closed while it slept", async () => {
    const { storage, sockets, ann } = await midGame();
    // Hibernation keeps the sockets; the instance is new. Ann's socket closing wakes it, so it's
    // already closed while the instance loads.
    ann.readyState = WebSocket.CLOSED;
    const r = await openRoom(storage, sockets);
    await r.room.webSocketClose(ann as never);
    expect(heard).toEqual(["Ann gone"]);
    expect(r.s().timer).toBe(T0 + AWAY_MS);
  });
});

describe("alarm", () => {
  it("doesn't run the game's timer early", async () => {
    const { room, storage, drop, ann } = await midGame();
    await drop(ann);
    expect(storage.alarm()).toBe(T0 + AWAY_MS);
    // An alarm left from before (or one that fires early) arrives before the timer is due.
    await room.alarm();
    expect(timersRun).toBe(0);
    expect(storage.alarm()).toBe(T0 + AWAY_MS);
  });

  it("tries a timer the game left due again in a second, instead of straight away", async () => {
    const { room, storage, drop, ann } = await midGame();
    await drop(ann);
    stuck = true;
    vi.setSystemTime(T0 + AWAY_MS);
    await room.alarm();
    expect(timersRun).toBe(1);
    expect(storage.alarm()).toBe(T0 + AWAY_MS + 1000);
  });
});

describe("rate limits", () => {
  it("limits each socket's chat, and says so", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    const bo = await r.connect("Bo");
    for (let i = 0; i < 30; i++) await r.say(ann, { t: "chat", text: `spam ${i}` });
    const chats = () => internals(r.room).log.filter((e) => e.kind === "chat").length;
    expect(chats()).toBe(10);
    expect(ann.last("error")).toEqual({ t: "error", message: "Slow down a little" });
    // Someone else can still talk, and so can Ann after a moment.
    await r.say(bo, { t: "chat", text: "hello" });
    vi.setSystemTime(T0 + 1000);
    await r.say(ann, { t: "chat", text: "sorry" });
    await r.say(ann, { t: "chat", text: "really" });
    await r.say(ann, { t: "chat", text: "too soon" });
    expect(chats()).toBe(13);
  });

  it("drops a socket's messages past its limit", async () => {
    const r = await openRoom(fakeStorage(), [], TightRoom);
    const ann = await r.connect("Ann");
    for (let i = 0; i < 10; i++) await r.say(ann, { t: "ping" });
    // The hello took one.
    expect(ann.received.filter((m) => m.t === "pong")).toHaveLength(4);
  });

  it("leaves plenty of room for real-time input by default", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    // 100 messages a second, for five seconds.
    for (let i = 0; i < 500; i++) {
      vi.setSystemTime(T0 + i * 10);
      await r.say(ann, { t: "ping" });
    }
    expect(ann.received.filter((m) => m.t === "pong")).toHaveLength(500);
  });

  it("picking the colour you have saves and sends nothing", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    const color = r.s().players[0].color;
    const [puts, states] = [r.storage.puts(), ann.received.length];
    await r.say(ann, { t: "color", color });
    expect(r.storage.puts()).toBe(puts);
    expect(ann.received.length).toBe(states);
  });
});

describe("host", () => {
  it("tells everyone about a new host, even if what they did then fails", async () => {
    const r = await openRoom();
    const ann = await r.connect("Ann");
    const bo = await r.connect("Bo");
    await r.drop(ann);
    await r.say(bo, { t: "addCpu", level: "impossible" });
    expect(bo.last("error")).toEqual({ t: "error", message: "Unknown CPU level" });
    expect((bo.last("state")?.state as State).hostId).toBe(r.id("Bo"));
  });
});
