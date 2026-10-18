// Hidden dice must stay hidden. This runs the real room (the kit's Room and this game's
// GameRoom) with fake sockets and storage: humans, CPUs, a latecomer who watches, a reload, a
// restart (a deploy) and players being knocked out. Every message every socket receives is then
// checked: the only dice in it may be the player's own cup, or a round that a call has revealed.
import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState, Hands } from "../src/shared/protocol";
import { legalBids } from "../src/shared/rules";
import { GameRoom } from "../src/worker/room";

type Json = Record<string, unknown>;

interface Received {
  msg: Json;
  /** The server's view when it was sent. */
  live: Hands | null;
  phase: string;
  round: number;
}

interface Env {
  room: GameRoom;
  sockets: FakeSocket[];
  storage: ReturnType<typeof fakeStorage>;
}

const internals = (room: GameRoom) => room as unknown as { state: GameState | null; live: Hands | null };

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  private attachment: unknown = null;
  received: Received[] = [];
  constructor(private env: Env) {}
  serializeAttachment(a: unknown) {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(raw: string) {
    const { state, live } = internals(this.env.room);
    this.received.push({ msg: JSON.parse(raw), live: structuredClone(live), phase: state?.phase ?? "", round: state?.round ?? 0 });
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
}

/** Durable Object storage in a Map, copying values in and out like the real thing. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    alarm: () => alarm,
    async get(keys: string | string[]) {
      if (Array.isArray(keys)) return new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      return structuredClone(data.get(keys));
    },
    async put(a: string | Json, v?: unknown) {
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

/** A room over `storage`: a fresh one, or the same game after a restart. */
async function openRoom(storage: ReturnType<typeof fakeStorage>): Promise<Env> {
  const pending: Promise<void>[] = [];
  const env = { sockets: [] as FakeSocket[], storage } as Env;
  const ctx = {
    setWebSocketAutoResponse: () => {},
    blockConcurrencyWhile: (fn: () => Promise<void>) => pending.push(fn()),
    storage,
    getWebSockets: () => env.sockets,
  };
  env.room = new GameRoom(ctx as never, {});
  await Promise.all(pending);
  return env;
}

class Client {
  pid = "";
  sockets: FakeSocket[] = [];
  constructor(
    readonly name: string,
    readonly token: string,
  ) {}
  get ws(): FakeSocket {
    return this.sockets.at(-1)!;
  }
  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  async connect(env: Env): Promise<void> {
    const ws = new FakeSocket(env);
    this.sockets.push(ws);
    env.sockets.push(ws);
    await this.say(env, { t: "hello", token: this.token, name: this.name });
    const welcome = ws.received.find((r) => r.msg.t === "welcome");
    this.pid = String(welcome?.msg.you ?? "");
  }
  async say(env: Env, msg: Json): Promise<void> {
    await env.room.webSocketMessage(this.ws as never, JSON.stringify(msg));
  }
  async drop(env: Env): Promise<void> {
    this.ws.readyState = WebSocket.CLOSED;
    await env.room.webSocketClose(this.ws as never);
  }
  /** The last cup this player was sent, on any socket. */
  lastHand(): { round: number; dice: number[] } | null {
    const all = this.sockets.flatMap((s) => s.received).filter((r) => r.msg.t === "hand");
    const h = all.at(-1)?.msg as { round: number; dice: number[] } | undefined;
    return h ?? null;
  }
  received(): Received[] {
    return this.sockets.flatMap((s) => s.received);
  }
}

/** Every place a dice array or a set of hands may appear: inside a reveal. */
const ALLOWED = /^state\.reveal\.hands(\.\d+(\.dice|\.id)?)?$/;

function walk(value: unknown, path: string, visit: (key: string, path: string, value: unknown) => void): void {
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    visit(k, p, v);
    walk(v, p, visit);
  }
}

/** Check one message a player received. */
function checkMessage(pid: string, r: Received): void {
  const { msg, live } = r;
  if (msg.t === "hand") {
    // Your own cup, exactly, for the round in play.
    expect(r.phase).toBe("playing");
    expect(live?.round).toBe(msg.round);
    expect(msg.dice).toEqual(live?.dice[pid]);
    return;
  }

  // Structure: no dice arrays or hands anywhere but a reveal.
  walk(msg, "", (key, path, value) => {
    if (key === "hands" || key === "live" || (key === "dice" && Array.isArray(value))) expect(path).toMatch(ALLOWED);
  });

  // A reveal of the round in play only exists once that round's call has been made.
  const state = msg.state as GameState | undefined;
  if (state?.reveal) {
    const open = state.reveal.round === state.round && state.phase === "playing";
    expect(open).toBe(false);
  }

  // Values: while a round is in play, nobody else's cup shows up anywhere in what you're sent.
  if (r.phase !== "playing" || !live) return;
  const copy = structuredClone(msg) as Json & { state?: GameState };
  if (copy.state?.reveal && copy.state.reveal.round < live.round) copy.state.reveal = null; // an earlier round, public
  const text = JSON.stringify(copy);
  for (const [id, dice] of Object.entries(live.dice)) {
    if (id !== pid) expect(text.includes(JSON.stringify(dice)), `${pid} saw ${id}'s cup`).toBe(false);
  }
}

describe("hidden dice", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const [wild, spotOn] of [
    [true, true],
    [false, false],
  ]) {
    it(`never reach another seat until a call reveals them (wild ${wild}, spot on ${spotOn})`, async () => {
      const storage = fakeStorage();
      let env = await openRoom(storage);
      await env.room.init("ABCDE");
      const ann = new Client("Ann", "token-ann-0001");
      const bob = new Client("Bob", "token-bob-0002");
      const cat = new Client("Cat", "token-cat-0003");
      const dan = new Client("Dan", "token-dan-0004");
      const clients = [ann, bob, cat, dan];
      for (const c of [ann, bob, cat]) await c.connect(env);
      await ann.say(env, { t: "settings", settings: { wild, spotOn, turnSeconds: 15 } });
      await ann.say(env, { t: "addCpu", level: "normal" });
      await ann.say(env, { t: "addCpu", level: "hard" });
      await ann.say(env, { t: "start" });
      const s = () => internals(env.room).state!;
      expect(s().phase).toBe("playing");

      const rng = mulberry32(wild ? 1 : 2);
      let reloaded = false;
      let restarted = false;
      for (let step = 0; step < 3000 && s().phase !== "gameover"; step++) {
        const st = s();
        if (step === 6) await dan.connect(env); // arrives mid-game: watches

        // Bob reloads mid-round: same seat, same dice.
        if (!reloaded && step > 12 && st.phase === "playing" && st.bids.length > 0 && st.turnId !== bob.pid && !st.players.find((p) => p.id === bob.pid)?.out) {
          reloaded = true;
          const before = bob.lastHand();
          await bob.drop(env);
          await bob.connect(env);
          expect(bob.ws.received.map((r) => r.msg.t)).toContain("hand");
          expect(bob.lastHand()).toEqual(before);
        }

        // A deploy mid-round: the object restarts and every socket drops. Everyone comes back to the same dice.
        if (!restarted && step > 40 && st.phase === "playing" && st.bids.length > 0) {
          restarted = true;
          const before = new Map(clients.map((c) => [c, c.lastHand()]));
          for (const ws of env.sockets) ws.readyState = WebSocket.CLOSED;
          env = await openRoom(storage);
          expect(internals(env.room).state!.round).toBe(st.round);
          for (const c of clients) await c.connect(env);
          for (const c of clients) {
            const had = before.get(c);
            if (had?.round === st.round && !st.players.find((p) => p.id === c.pid)?.out) expect(c.lastHand()).toEqual(had);
          }
          continue;
        }

        const me = clients.find((c) => c.pid === st.turnId && c.online);
        if (st.phase === "playing" && me) {
          const last = st.bids.at(-1) ?? null;
          const total = st.players.reduce((n, p) => n + p.dice, 0);
          const options = legalBids(last, { wild }, total);
          if (last && (rng() < 0.3 || options.length === 0)) await me.say(env, { t: spotOn && rng() < 0.3 ? "spot" : "liar" });
          else {
            const bid = options[randInt(rng, 0, options.length - 1)];
            await me.say(env, { t: "bid", qty: Math.min(total, bid.qty + randInt(rng, 0, 1)), face: bid.face });
          }
        } else {
          // Somebody else's move (a CPU, or a timer): run the room's alarm.
          vi.setSystemTime(Math.max(Date.now(), storage.alarm() ?? Date.now()) + 1);
          await env.room.alarm();
        }
      }
      expect(s().phase).toBe("gameover");
      expect(reloaded && restarted).toBe(true);
      // Someone was knocked out and kept watching; Dan watched all along.
      expect(s().players.filter((p) => p.out).length).toBe(4);
      expect(dan.received().some((r) => r.msg.t === "state")).toBe(true);
      expect(dan.received().some((r) => r.msg.t === "hand")).toBe(false);

      let checked = 0;
      for (const c of clients) {
        for (const r of c.received()) {
          checkMessage(c.pid, r);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(200);

      // Each human got their own cup every round they had one.
      for (const c of [ann, bob, cat]) {
        const rounds = new Set(c.received().filter((r) => r.msg.t === "hand").map((r) => r.msg.round));
        const p = s().players.find((x) => x.id === c.pid)!;
        const lastRound = p.outRound ?? s().round;
        for (let round = 1; round <= lastRound; round++) expect(rounds.has(round), `${c.name} round ${round}`).toBe(true);
      }
    });
  }

  it("catches a leak: a state that carried the dice would fail the check", () => {
    const live: Hands = { round: 3, dice: { p1: [2, 2, 5], p2: [1, 3, 6, 6] } };
    const leaky = { t: "state", state: { round: 3, phase: "playing", reveal: null, cups: { p2: [1, 3, 6, 6] } } };
    expect(() => checkMessage("p1", { msg: leaky, live, phase: "playing", round: 3 })).toThrow();
    const early = { t: "state", state: { round: 3, phase: "playing", reveal: { round: 3, hands: [{ id: "p2", dice: [1, 3, 6, 6] }] } } };
    expect(() => checkMessage("p1", { msg: early, live, phase: "playing", round: 3 })).toThrow();
    const other = { t: "hand", round: 3, dice: [1, 3, 6, 6] };
    expect(() => checkMessage("p1", { msg: other, live, phase: "playing", round: 3 })).toThrow();
    const fine = { t: "state", state: { round: 3, phase: "playing", reveal: { round: 2, hands: [{ id: "p2", dice: [4] }] } } };
    expect(() => checkMessage("p1", { msg: fine, live, phase: "playing", round: 3 })).not.toThrow();
  });
});
