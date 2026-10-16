// The room's connection lifecycle: hellos, watchers, restarts, hibernation, the alarm, rate
// limits, the turn clock and the hooks games build on. It runs the kit's Room through the kit's
// own test harness (src/testing/room.ts), with small games: one whose away timer works like
// Liar's Dice's (no turn timer, but a player who is away on their turn is skipped after a
// grace), and one on the kit's turn clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_FULL, CLOSE_STALE, MAX_PLAYERS, MAX_SPECTATORS } from "../src/shared/constants";
import type { BasePlayer, BaseState } from "../src/shared/protocol";
import { FakeSocket, type TestRoom, fakeStorage, internals, openRoom } from "../src/testing/room";
import { Lobby, baseState, type GameIO } from "../src/worker/lobby";
import { Room, type RateLimit } from "../src/worker/room";
import { type ClockRules, type TurnClock, startTurnClock, turnHolderBack, turnHolderLeft, turnTimeUp } from "../src/worker/turns";

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

/** The room's state, and a player's id by name. */
function peek<S extends BaseState = State>(r: { room: Parameters<typeof internals>[0] }) {
  const s = () => internals<S>(r.room).state!;
  return { s, id: (name: string) => s().players.find((p) => p.name === name)!.id };
}

/** Ann and Bo in a game, with Ann to play. */
async function midGame() {
  const r = await openRoom(TurnRoom);
  const ann = await r.connect("Ann");
  const bo = await r.connect("Bo");
  await r.say(ann, { t: "start" });
  const { s, id } = peek(r);
  expect(s().turn).toBe(id("Ann"));
  expect(s().timer).toBeNull();
  heard = [];
  return { ...r, ann, bo, s, id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
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
    const r = await openRoom(TurnRoom);
    const { s } = peek(r);
    const ann = await r.connect("Ann");
    for (let i = 0; i < 50; i++) await r.say(ann, { t: "hello", token: `fresh-token-${i}`, name: `Ghost ${i}` });
    expect(s().players.map((p) => p.name)).toEqual(["Ann"]);
    await r.drop(ann);
    expect(s().players.filter((p) => p.connected)).toEqual([]);
  });

  it("caps watchers: gone ones make space, and past that the socket is turned away", async () => {
    const r = await openRoom(TurnRoom);
    const { s, id } = peek(r);
    for (let i = 0; i < MAX_PLAYERS + MAX_SPECTATORS; i++) await r.connect(`P${i}`);
    expect(s().players.filter((p) => p.spectator)).toHaveLength(MAX_SPECTATORS);

    const late = await r.connect("Late");
    expect(late.closedWith).toBe(CLOSE_FULL);
    expect(s().players).toHaveLength(MAX_PLAYERS + MAX_SPECTATORS);

    // A watcher leaves: they're forgotten (and so is their token) to make space for the next.
    const gone = id(`P${MAX_PLAYERS}`);
    await r.drop(r.sockets[MAX_PLAYERS]);
    const next = await r.connect("Next");
    expect(next.closedWith).toBeNull();
    expect(s().players.some((p) => p.id === gone)).toBe(false);
    expect(Object.values(internals(r.room).tokens)).not.toContain(gone);
    expect(s().players).toHaveLength(MAX_PLAYERS + MAX_SPECTATORS);
  });

  it("reads each socket's player from its attachment once", async () => {
    const r = await openRoom(TurnRoom);
    const ann = await r.connect("Ann");
    const [reads, before] = [ann.reads, ann.received.length];
    for (let i = 0; i < 5; i++) await r.say(ann, { t: "chat", text: `hi ${i}` });
    expect(ann.received.slice(before).filter((m) => m.t === "log")).toHaveLength(5);
    expect(ann.reads).toBe(reads);
  });
});

describe("after a restart", () => {
  it("tells the game who went, so an away timer starts for whoever was to play", async () => {
    const first = await midGame();
    // A deploy: a new instance over the same storage, and every socket gone.
    const r = await first.restart();
    const { s, id } = peek(r);
    await r.connect("Bo");
    // Bo is back before the game hears about the others, so Bo was never away.
    expect(heard).toEqual(["Ann gone"]);
    expect(s().timer).toBe(T0 + AWAY_MS);
    expect(r.storage.alarm()).toBe(T0 + AWAY_MS);
    expect(s().players.find((p) => p.name === "Bo")?.connected).toBe(true);

    vi.setSystemTime(T0 + AWAY_MS);
    await r.room.alarm();
    expect(s().turn).toBe(id("Bo"));
  });

  it("also when the alarm comes first, without counting it as activity", async () => {
    const first = await midGame();
    const lastActive = first.s().lastActive;
    vi.setSystemTime(T0 + 60_000);
    const r = await first.restart();
    const { s } = peek(r);
    await r.room.alarm();
    expect(heard).toEqual(["Ann gone", "Bo gone"]);
    expect(s().timer).toBe(T0 + 60_000 + AWAY_MS);
    expect(s().lastActive).toBe(lastActive);
    // Nobody is here, so timers wait.
    expect(timersRun).toBe(0);
    expect(r.storage.alarm()).toBe(lastActive + GC_MS);
    await r.connect("Bo");
    expect(r.storage.alarm()).toBe(T0 + 60_000 + AWAY_MS);
  });

  it("counts whoever says hello as back, even if the game's own socket cache hasn't caught up", async () => {
    const { storage } = await midGame();
    const r = await openRoom(CachingRoom, { storage });
    // Bo's new socket is seen before Bo says hello (by a broadcast, say), so the cache has no player for it.
    const bo = new FakeSocket();
    r.sockets.push(bo);
    (r.room as unknown as { connectedIds(): Set<string> }).connectedIds();
    await r.say(bo, { t: "hello", token: "token-bo-0000", name: "Bo" });
    expect(heard).toEqual(["Ann gone"]);
    expect(peek(r).s().players.find((p) => p.name === "Bo")?.connected).toBe(true);
  });

  it("only tells the game once", async () => {
    const first = await midGame();
    const r = await first.restart();
    const bo = await r.connect("Bo");
    await r.say(bo, { t: "chat", text: "anyone?" });
    await r.room.alarm();
    expect(heard).toEqual(["Ann gone"]);
  });
});

describe("waking from hibernation", () => {
  it("tells the game about a socket that closed while it slept", async () => {
    const first = await midGame();
    // Hibernation keeps the sockets; the instance is new. Ann's socket closing wakes it, so it's
    // already closed while the instance loads.
    first.ann.readyState = WebSocket.CLOSED;
    const r = await first.wake();
    await r.room.webSocketClose(first.ann as never);
    expect(heard).toEqual(["Ann gone"]);
    expect(peek(r).s().timer).toBe(T0 + AWAY_MS);
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
    const r = await openRoom(TurnRoom);
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
    const r = await openRoom(TightRoom);
    const ann = await r.connect("Ann");
    for (let i = 0; i < 10; i++) await r.say(ann, { t: "ping" });
    // The hello took one.
    expect(ann.all("pong")).toHaveLength(4);
  });

  it("leaves plenty of room for real-time input by default", async () => {
    const r = await openRoom(TurnRoom);
    const ann = await r.connect("Ann");
    // 100 messages a second, for five seconds.
    for (let i = 0; i < 500; i++) {
      vi.setSystemTime(T0 + i * 10);
      await r.say(ann, { t: "ping" });
    }
    expect(ann.all("pong")).toHaveLength(500);
  });

  it("picking the colour you have saves and sends nothing", async () => {
    const r = await openRoom(TurnRoom);
    const ann = await r.connect("Ann");
    const color = peek(r).s().players[0].color;
    const [puts, states] = [r.storage.puts(), ann.received.length];
    await r.say(ann, { t: "color", color });
    expect(r.storage.puts()).toBe(puts);
    expect(ann.received.length).toBe(states);
  });
});

describe("host", () => {
  it("tells everyone about a new host, even if what they did then fails", async () => {
    const r = await openRoom(TurnRoom);
    const ann = await r.connect("Ann");
    const bo = await r.connect("Bo");
    await r.drop(ann);
    await r.say(bo, { t: "addCpu", level: "impossible" });
    expect(bo.last("error")).toEqual({ t: "error", message: "Unknown CPU level" });
    expect((bo.last("state")?.state as State).hostId).toBe(peek(r).id("Bo"));
  });
});

// ---------------------------------------------------------------- the turn clock, through the room

interface ClockState extends BaseState<BasePlayer, { turnSeconds: number }>, TurnClock {
  turn: string | null;
}

const CLOCK: ClockRules = { awayMs: 10_000 };

/** A turn-based game on the kit's turn clock: no moves, the turn just passes when time is up. */
class ClockGame extends Lobby<ClockState> {
  protected readonly choices = { turnSeconds: [0, 30] };
  protected createPlayer(base: BasePlayer): BasePlayer {
    return base;
  }
  start(byId: string): void {
    this.beginStart(byId);
    this.s.phase = "playing";
    this.beginTurn(this.participants[0].id);
  }
  setConnected(id: string, connected: boolean): void {
    const p = this.player(id);
    if (!p || p.cpu || p.connected === connected) return;
    super.setConnected(id, connected);
    if (this.s.phase !== "playing" || this.s.turn !== id) return;
    if (connected) turnHolderBack(this.s, CLOCK, this.io.now());
    else turnHolderLeft(this.s, CLOCK, this.io.now());
    this.touch();
  }
  onTimer(): void {
    const before = this.s.turnDeadline;
    if (!turnTimeUp(this.s, CLOCK, this.io.now())) {
      if (this.s.turnDeadline !== before) this.touch();
      return;
    }
    const ids = this.participants.map((p) => p.id);
    this.beginTurn(ids[(ids.indexOf(this.s.turn!) + 1) % ids.length]);
  }
  private beginTurn(id: string): void {
    this.s.turn = id;
    startTurnClock(this.s, CLOCK, this.io.now(), this.s.settings.turnSeconds * 1000, this.io.isConnected(id));
    this.touch();
  }
}

class ClockRoom extends Room<ClockState, ClockGame> {
  protected newState(code: string, now: number): ClockState {
    return { ...baseState(code, now, { turnSeconds: 0 }), turn: null, clockEnd: null, turnDeadline: null };
  }
  protected makeGame(state: ClockState, io: GameIO): ClockGame {
    return new ClockGame(state, io);
  }
  protected timerAt(state: ClockState): number | null {
    return state.phase === "playing" ? state.turnDeadline : null;
  }
}

/** Ann and Bo playing, Ann's turn, the clock at `turnSeconds`. */
async function clockGame(turnSeconds: number) {
  const r = await openRoom(ClockRoom);
  const ann = await r.connect("Ann");
  const bo = await r.connect("Bo");
  await r.say(ann, { t: "settings", settings: { turnSeconds } });
  await r.say(ann, { t: "start" });
  const { s, id } = peek<ClockState>(r);
  expect(s().turn).toBe(id("Ann"));
  return { r, ann, bo, s, id };
}

/** Let the clock reach the room's alarm, and run it. */
async function fireAlarm(r: TestRoom<Room<ClockState, ClockGame>>) {
  const at = r.storage.alarm()!;
  if (Date.now() < at) vi.setSystemTime(at);
  await r.room.alarm();
}

for (const turnSeconds of [0, 30]) {
  const limit = turnSeconds ? T0 + turnSeconds * 1000 : null;
  describe(`the turn clock, with ${turnSeconds ? `${turnSeconds} seconds a turn` : "no time limit"}`, () => {
    it("doesn't start over when you reload on your own turn", async () => {
      const { r, ann, s } = await clockGame(turnSeconds);
      vi.setSystemTime(T0 + 20_000);
      await r.drop(ann);
      expect(s().turnDeadline).toBe(Math.min(limit ?? Infinity, T0 + 30_000));
      vi.setSystemTime(T0 + 21_000);
      await r.connect("Ann");
      expect(s().turnDeadline).toBe(limit);
    });

    it("doesn't change for a second tab", async () => {
      const { r, s } = await clockGame(turnSeconds);
      vi.setSystemTime(T0 + 27_000);
      const puts = r.storage.puts();
      await r.connect("Ann");
      expect(s().turnDeadline).toBe(limit);
      expect(s().clockTopUp).toBe(false);
      expect(r.storage.puts()).toBe(puts);
    });

    it("gives the player whose turn it is time to come back, when everyone was away past the deadline", async () => {
      const { r, ann, bo, s, id } = await clockGame(turnSeconds);
      vi.setSystemTime(T0 + 5_000);
      await r.drop(ann);
      await r.drop(bo);
      // An hour later Bo is back, and the overdue timer fires.
      const later = T0 + 3_600_000;
      vi.setSystemTime(later);
      await r.connect("Bo");
      await fireAlarm(r);
      expect(s().turn).toBe(id("Ann"));
      expect(s().turnDeadline).toBe(later + 10 + CLOCK.awayMs);
      // Ann is back in time: her clock ran out long ago, so she gets the top-up (with no limit, no deadline).
      vi.setSystemTime(later + 3_000);
      await r.connect("Ann");
      expect(s().turnDeadline).toBe(limit === null ? null : later + 3_000 + 5_000);
    });

    it("moves on from the player whose turn it is if they don't come back after a restart", async () => {
      const first = await clockGame(turnSeconds);
      vi.setSystemTime(T0 + 25_000);
      const r = await first.r.restart();
      const { s, id } = peek<ClockState>(r);
      await r.connect("Bo");
      const deadline = Math.min(limit ?? Infinity, T0 + 25_000 + CLOCK.awayMs);
      expect(s().turnDeadline).toBe(deadline);
      expect(r.storage.alarm()).toBe(deadline);
      await fireAlarm(r);
      expect(s().turn).toBe(id("Bo"));
    });
  });
}

// ---------------------------------------------------------------- hooks

/** Records what the room tells it. */
class HookRoom extends TurnRoom {
  protected readonly tickMs = 50;
  hellos: { pid: string; looping: boolean }[] = [];
  /** Kept under its own key, saved with the state. */
  notes: string[] = [];
  private notesSaved = 0;
  protected wantsLoop(state: State): boolean {
    return state.phase === "playing";
  }
  protected afterHello(_game: TurnGame, pid: string): void {
    this.hellos.push({ pid, looping: this.looping });
  }
  protected changedKeys(): Record<string, unknown> | null {
    if (this.notes.length === this.notesSaved) return null;
    this.notesSaved = this.notes.length;
    return { notes: [...this.notes] };
  }
}

describe("room hooks", () => {
  it("afterHello gets the player's id, and knows whether the tick loop was already running", async () => {
    const r = await openRoom(HookRoom);
    const ann = await r.connect("Ann");
    await r.connect("Bo");
    await r.say(ann, { t: "start" });
    await r.connect("Cy");
    const { id } = peek(r);
    expect(r.room.hellos).toEqual([
      { pid: id("Ann"), looping: false },
      { pid: id("Bo"), looping: false },
      { pid: id("Cy"), looping: true },
    ]);
  });

  it("saves the room's own keys in the same write as the state, only when they changed", async () => {
    const r = await openRoom(HookRoom);
    const ann = await r.connect("Ann");
    r.room.notes.push("first");
    let puts = r.storage.puts();
    await r.say(ann, { t: "chat", text: "hi" });
    expect(r.storage.puts()).toBe(puts + 1);
    expect(r.storage.data.get("notes")).toEqual(["first"]);

    // Nothing else changed: still saved.
    r.room.notes.push("second");
    puts = r.storage.puts();
    await r.say(ann, { t: "ping" });
    expect(r.storage.puts()).toBe(puts + 1);
    expect(r.storage.data.get("notes")).toEqual(["first", "second"]);

    // Nothing at all changed: no write.
    puts = r.storage.puts();
    await r.say(ann, { t: "ping" });
    expect(r.storage.puts()).toBe(puts);
  });

  it("sends the sender's clock back with the pong", async () => {
    const r = await openRoom(TurnRoom);
    const ann = await r.connect("Ann");
    await r.say(ann, { t: "ping", c: 12345 });
    expect(ann.last("pong")).toEqual({ t: "pong", now: T0, c: 12345 });
    await r.say(ann, { t: "ping" });
    expect(ann.last("pong")).toEqual({ t: "pong", now: T0 });
  });
});

describe("builds", () => {
  it("tells a page running other code (or too old to say) to reload", async () => {
    vi.stubGlobal("__WARRICK_BUILD__", "new");
    const r = await openRoom(TurnRoom);
    for (const build of ["old", undefined]) {
      const ws = new FakeSocket();
      r.sockets.push(ws);
      await r.say(ws, { t: "hello", token: "token-ann-0000", name: "Ann", build });
      expect(ws.closedWith).toBe(CLOSE_STALE);
      expect(ws.last("error")?.message).toMatch(/Reload the page/);
    }
    expect(peek(r).s().players).toEqual([]);
    const ws = new FakeSocket();
    r.sockets.push(ws);
    await r.say(ws, { t: "hello", token: "token-ann-0000", name: "Ann", build: "new" });
    expect(ws.closedWith).toBeNull();
    expect(ws.last("welcome")).toBeDefined();
  });

  it("lets everyone in when the room has no build id (tests, or an older room)", async () => {
    const r = await openRoom(TurnRoom, { storage: fakeStorage() });
    const ann = await r.connect("Ann");
    expect(ann.you).toBe(peek(r).id("Ann"));
  });
});
