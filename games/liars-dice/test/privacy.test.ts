// Hidden dice must stay hidden. This runs the real room (the kit's Room and this game's
// GameRoom) with fake sockets and storage: humans, CPUs, a latecomer who watches, a reload, a
// restart (a deploy) and players being knocked out. Every message every socket receives is then
// checked: the only dice in it may be the player's own cup, or a round that a call has revealed.
import { mulberry32, randInt } from "@warrick/kit/shared/rng";
import { FakeSocket, type Json, type TestRoom, internals, openRoom } from "@warrick/kit/testing/room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState, Hands } from "../src/shared/protocol";
import { legalBids } from "../src/shared/rules";
import { GameRoom } from "../src/worker/room";

type Env = TestRoom<GameRoom>;

interface Received {
  msg: Json;
  /** The server's view when it was sent. */
  live: Hands | null;
  phase: string;
  round: number;
}

class Client {
  pid = "";
  sockets: FakeSocket[] = [];
  /** Every message this player was sent, on any socket, with what the server knew then. */
  seen: Received[] = [];
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
    const ws = new FakeSocket();
    ws.onSend = (msg) => {
      const { state, live } = internals<GameState, Hands>(env.room);
      this.seen.push({ msg, live: structuredClone(live), phase: state?.phase ?? "", round: state?.round ?? 0 });
    };
    this.sockets.push(ws);
    env.sockets.push(ws);
    await env.say(ws, { t: "hello", token: this.token, name: this.name });
    this.pid = ws.you;
  }
  async say(env: Env, msg: Json): Promise<void> {
    await env.say(this.ws, msg);
  }
  async drop(env: Env): Promise<void> {
    await env.drop(this.ws);
  }
  /** The last cup this player was sent, on any socket. */
  lastHand(): { round: number; dice: number[] } | null {
    const h = this.seen.filter((r) => r.msg.t === "hand").at(-1)?.msg as { round: number; dice: number[] } | undefined;
    return h ?? null;
  }
  received(): Received[] {
    return this.seen;
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
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [wild, spotOn] of [
    [true, true],
    [false, false],
  ]) {
    it(`never reach another seat until a call reveals them (wild ${wild}, spot on ${spotOn})`, async () => {
      let env = await openRoom(GameRoom);
      const storage = env.storage;
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
      const s = () => internals<GameState>(env.room).state!;
      expect(s().phase).toBe("playing");

      const rng = mulberry32(wild ? 1 : 2);
      let reloaded = false;
      let restarted = false;
      for (let step = 0; step < 3000 && s().phase !== "gameover"; step++) {
        const st = s();
        if (step === 6) await dan.connect(env); // arrives mid-game: watches

        // Bob reloads mid-round: same seat, same dice.
        if (
          !reloaded &&
          step > 12 &&
          st.phase === "playing" &&
          st.bids.length > 0 &&
          st.turnId !== bob.pid &&
          !st.players.find((p) => p.id === bob.pid)?.out
        ) {
          reloaded = true;
          const before = bob.lastHand();
          await bob.drop(env);
          await bob.connect(env);
          expect(bob.ws.received.map((m) => m.t)).toContain("hand");
          expect(bob.lastHand()).toEqual(before);
        }

        // A deploy mid-round: the object restarts and every socket drops. Everyone comes back to the same dice.
        if (!restarted && step > 40 && st.phase === "playing" && st.bids.length > 0) {
          restarted = true;
          const before = new Map(clients.map((c) => [c, c.lastHand()]));
          env = await env.restart();
          expect(internals<GameState>(env.room).state!.round).toBe(st.round);
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
        const rounds = new Set(
          c
            .received()
            .filter((r) => r.msg.t === "hand")
            .map((r) => r.msg.round),
        );
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
    const early = {
      t: "state",
      state: { round: 3, phase: "playing", reveal: { round: 3, hands: [{ id: "p2", dice: [1, 3, 6, 6] }] } },
    };
    expect(() => checkMessage("p1", { msg: early, live, phase: "playing", round: 3 })).toThrow();
    const other = { t: "hand", round: 3, dice: [1, 3, 6, 6] };
    expect(() => checkMessage("p1", { msg: other, live, phase: "playing", round: 3 })).toThrow();
    const fine = { t: "state", state: { round: 3, phase: "playing", reveal: { round: 2, hands: [{ id: "p2", dice: [4] }] } } };
    expect(() => checkMessage("p1", { msg: fine, live, phase: "playing", round: 3 })).not.toThrow();
  });
});
