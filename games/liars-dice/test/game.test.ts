import type { CpuLevel } from "@warrick/kit/shared/protocol";
import { describe, expect, it } from "vitest";
import { AWAY_MS, revealMs } from "../src/shared/constants";
import type { Hands, PlayerState } from "../src/shared/protocol";
import { Game, newGameState } from "../src/worker/game";

/** A game driven like the room drives it: a fresh Game per action, `live` carried between them. */
function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  let live: Hands | null = null;
  const run = <T>(fn: (g: Game) => T): { result: T; game: Game } => {
    const game = new Game(s, io, live);
    const result = fn(game);
    live = game.live;
    return { result, game };
  };
  const t = {
    s,
    connected,
    get live() {
      return live;
    },
    set live(h: Hands | null) {
      live = h;
    },
    do: <T>(fn: (g: Game) => T) => run(fn).result,
    game: (fn: (g: Game) => void) => run(fn).game,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    /** Fire the pending timer. */
    fire() {
      now = Math.max(now, s.timer!.at);
      run((g) => g.onTimer());
    },
    /** Run timers until the game is over (humans who never move time out). */
    runOut(max = 5000) {
      for (let i = 0; i < max && s.timer && s.phase !== "gameover"; i++) t.fire();
    },
    human(name: string) {
      const p = t.do((g) => g.addHuman(name));
      connected.add(p.id);
      return p;
    },
    p: (id: string) => s.players.find((p) => p.id === id)!,
    /** Give these players these exact dice for the current round. */
    setHands(dice: Record<string, number[]>) {
      live = { round: s.round, dice };
      for (const [id, d] of Object.entries(dice)) t.p(id).dice = d.length;
    },
  };
  return t;
}

/** Two humans, seated a then b, with a to start. */
function headsUp(settings: Record<string, unknown> = {}) {
  const t = setup();
  const a = t.human("Ann");
  const b = t.human("Bob");
  t.do((g) => g.updateSettings(a.id, { turnSeconds: 0, ...settings }));
  t.do((g) => g.start(a.id));
  t.s.order = [a.id, b.id];
  t.s.turnId = a.id;
  return { t, a, b };
}

describe("a game", () => {
  for (const level of ["easy", "normal", "hard"] as CpuLevel[]) {
    for (const [wild, spotOn] of [
      [true, false],
      [true, true],
      [false, false],
      [false, true],
    ]) {
      it(`plays to a winner against ${level} CPUs (wild ${wild}, spot on ${spotOn})`, () => {
        const t = setup();
        const host = t.human("Host");
        t.do((g) => g.updateSettings(host.id, { wild, spotOn, turnSeconds: 15 }));
        for (let i = 0; i < 3; i++) t.do((g) => g.addCpu(host.id, level));
        t.do((g) => g.start(host.id));
        expect(t.s.phase).toBe("playing");
        expect(t.s.round).toBe(1);
        expect(t.s.players.every((p) => p.dice === 5)).toBe(true);
        expect(Object.values(t.live!.dice).every((d) => d.length === 5)).toBe(true);
        // The lobby is closed while the game is on.
        expect(() => t.do((g) => g.addCpu(host.id, "easy"))).toThrow("Wait for the round to end");

        // The host never moves, so their turns time out and the game plays a normal CPU's move for them.
        t.runOut();
        expect(t.s.phase).toBe("gameover");
        const winner = t.p(t.s.winnerId!);
        expect(winner.place).toBe(1);
        expect(winner.out).toBe(false);
        expect(t.s.players.filter((p) => !p.out)).toHaveLength(1);
        expect(t.s.players.map((p) => p.place).sort()).toEqual([1, 2, 3, 4]);
        expect(t.s.round).toBeGreaterThan(10);

        // Back to the lobby: everything resets for the next game.
        t.do((g) => g.backToLobby(host.id));
        expect(t.s.phase).toBe("lobby");
        expect(t.s.round).toBe(0);
        expect(t.s.timer).toBeNull();
        expect(t.live).toBeNull();
        expect(t.s.players.every((p) => p.dice === 0 && !p.out && p.place === null)).toBe(true);
      });
    }
  }

  it("sends each player only their own cup when a round starts", () => {
    const t = setup();
    const a = t.human("Ann");
    const b = t.human("Bob");
    t.do((g) => g.addCpu(a.id, "normal"));
    const game = t.game((g) => g.start(a.id));
    const hands = game.direct.filter((d) => d.msg.t === "hand");
    expect(hands.map((h) => h.pid).sort()).toEqual([a.id, b.id].sort());
    for (const h of hands) expect(h.msg).toEqual({ t: "hand", round: 1, dice: t.live!.dice[h.pid] });
    // Reconnecting (every hello) sends it again.
    t.connected.delete(b.id);
    t.do((g) => g.setConnected(b.id, false));
    const back = t.game((g) => g.setConnected(b.id, true));
    expect(back.direct).toEqual([{ pid: b.id, msg: { t: "hand", round: 1, dice: t.live!.dice[b.id] } }]);
  });
});

describe("bidding", () => {
  it("only lets the player whose turn it is move, with legal bids", () => {
    const { t, a, b } = headsUp();
    expect(() => t.do((g) => g.bid(b.id, 2, 3))).toThrow("It's not your turn");
    expect(() => t.do((g) => g.liar(a.id))).toThrow("Nothing to call yet");
    expect(() => t.do((g) => g.bid(a.id, 1, 1))).toThrow("can't open on ones");
    expect(() => t.do((g) => g.bid(a.id, 11, 3))).toThrow("only 10 dice");
    expect(() => t.do((g) => g.spot(a.id))).toThrow("Spot on is off");
    t.do((g) => g.bid(a.id, 3, 4));
    expect(t.s.bids).toEqual([{ by: a.id, qty: 3, face: 4 }]);
    expect(t.s.turnId).toBe(b.id);
    expect(() => t.do((g) => g.bid(b.id, 3, 3))).toThrow("doesn't raise three 4s");
    expect(() => t.do((g) => g.bid(b.id, 1, 1))).toThrow("Switching to ones needs at least 2");
    t.do((g) => g.bid(b.id, 2, 1));
    expect(() => t.do((g) => g.bid(a.id, 4, 6))).toThrow("Switching from ones needs at least 5");
    t.do((g) => g.bid(a.id, 5, 2));
    expect(t.s.bids).toHaveLength(3);
  });

  it("restarts the turn clock for each player and moves for them when it runs out", () => {
    const { t, a, b } = headsUp({ turnSeconds: 15 });
    t.do((g) => g.bid(a.id, 2, 3));
    expect(t.s.turnDeadline).toBe(t.now() + 15000);
    t.fire();
    // Bob's clock ran out: the game made his move.
    expect(t.s.bids.length === 2 || t.s.phase === "reveal").toBe(true);
    if (t.s.phase === "playing") expect(t.s.turnId).toBe(a.id);
    void b;
  });

  it("moves for a missing player after a short grace, and gives the clock back when they return", () => {
    const { t, a, b } = headsUp({ turnSeconds: 45 });
    t.connected.delete(b.id);
    t.do((g) => g.setConnected(b.id, false));
    t.do((g) => g.bid(a.id, 2, 3));
    expect(t.s.turnId).toBe(b.id);
    expect(t.s.timer!.at).toBe(t.now() + AWAY_MS);
    t.connected.add(b.id);
    t.do((g) => g.setConnected(b.id, true));
    expect(t.s.timer!.at).toBe(t.s.turnDeadline);
    t.connected.delete(b.id);
    t.do((g) => g.setConnected(b.id, false));
    t.fire();
    expect(t.s.bids.length === 2 || t.s.phase === "reveal").toBe(true);
  });
});

describe("calls", () => {
  it("Liar! on a bid that's short costs the bidder, who starts the next round", () => {
    const { t, a, b } = headsUp();
    t.setHands({ [a.id]: [1, 2, 4, 4, 6], [b.id]: [3, 3, 4, 5, 5] });
    t.do((g) => g.bid(a.id, 5, 4));
    t.do((g) => g.liar(b.id));
    // Three 4s and a wild one: 4, short of 5.
    const r = t.s.reveal!;
    expect(t.s.phase).toBe("reveal");
    expect(r).toMatchObject({
      kind: "liar",
      callerId: b.id,
      bidderId: a.id,
      count: 4,
      loserId: a.id,
      gainerId: null,
      outId: null,
    });
    expect(r.hands).toEqual([
      { id: a.id, dice: [1, 2, 4, 4, 6] },
      { id: b.id, dice: [3, 3, 4, 5, 5] },
    ]);
    expect(t.p(a.id).dice).toBe(4);
    expect(t.p(b.id)).toMatchObject({ dice: 5, calls: 1, callsWon: 1 });
    expect(t.s.timer).toEqual({ kind: "reveal", at: t.now() + revealMs(4) });
    t.fire();
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(2);
    expect(t.s.turnId).toBe(a.id);
    expect(t.s.bids).toEqual([]);
    expect(t.live!.dice[a.id]).toHaveLength(4);
  });

  it("Liar! on a bid that's met costs the caller", () => {
    const { t, a, b } = headsUp();
    t.setHands({ [a.id]: [1, 2, 4, 4, 6], [b.id]: [3, 3, 4, 5, 5] });
    t.do((g) => g.bid(a.id, 4, 4));
    t.do((g) => g.liar(b.id));
    expect(t.s.reveal).toMatchObject({ count: 4, loserId: b.id });
    expect(t.p(b.id)).toMatchObject({ dice: 4, calls: 1, callsWon: 0 });
    t.fire();
    expect(t.s.turnId).toBe(b.id);
  });

  it("counts ones only as themselves with wilds off", () => {
    const { t, a, b } = headsUp({ wild: false });
    t.setHands({ [a.id]: [1, 2, 4, 4, 6], [b.id]: [1, 3, 4, 5, 5] });
    t.do((g) => g.bid(a.id, 4, 4));
    t.do((g) => g.liar(b.id));
    expect(t.s.reveal).toMatchObject({ count: 3, wild: false, loserId: a.id });
  });

  it("Spot on: right gets a die back (up to 5), wrong loses one, and the caller starts next", () => {
    const { t, a, b } = headsUp({ spotOn: true });
    // Right, at 5 dice: nothing to gain.
    t.setHands({ [a.id]: [1, 2, 4, 4, 6], [b.id]: [3, 3, 4, 5, 5] });
    t.do((g) => g.bid(a.id, 4, 4));
    t.do((g) => g.spot(b.id));
    expect(t.s.reveal).toMatchObject({ kind: "spot", count: 4, loserId: null, gainerId: null });
    expect(t.p(b.id)).toMatchObject({ dice: 5, spots: 1, spotsWon: 1 });
    expect(t.p(a.id).dice).toBe(5);
    t.fire();
    expect(t.s.turnId).toBe(b.id);

    // Wrong: the caller loses a die.
    t.setHands({ [a.id]: [1, 2, 2, 2, 3], [b.id]: [3, 4, 5, 6, 6] });
    t.do((g) => g.bid(b.id, 3, 2));
    t.do((g) => g.spot(a.id));
    expect(t.s.reveal).toMatchObject({ count: 4, loserId: a.id, gainerId: null });
    expect(t.p(a.id).dice).toBe(4);
    t.fire();
    expect(t.s.turnId).toBe(a.id);

    // Right with room for it: a die back.
    t.setHands({ [a.id]: [1, 6, 6, 6], [b.id]: [2, 3, 4, 5, 6] });
    t.do((g) => g.bid(a.id, 5, 6));
    t.do((g) => g.spot(b.id));
    t.fire();
    t.setHands({ [a.id]: [1, 6, 6, 6], [b.id]: [2, 3, 4, 5, 6] });
    t.do((g) => g.bid(b.id, 5, 6));
    t.do((g) => g.spot(a.id));
    expect(t.s.reveal).toMatchObject({ count: 5, loserId: null, gainerId: a.id });
    expect(t.p(a.id).dice).toBe(5);
  });
});

describe("going out", () => {
  it("knocks out a player with no dice; the last one with dice wins", () => {
    const t = setup();
    const a = t.human("Ann");
    const b = t.human("Bob");
    const c = t.human("Cat");
    t.do((g) => g.updateSettings(a.id, { turnSeconds: 0 }));
    t.do((g) => g.start(a.id));
    t.s.order = [a.id, b.id, c.id];
    t.s.turnId = a.id;
    // Bob is down to his last die and bids on it.
    t.setHands({ [a.id]: [2, 2], [b.id]: [5], [c.id]: [3, 3, 3] });
    t.do((g) => g.bid(a.id, 2, 2));
    t.do((g) => g.bid(b.id, 3, 5));
    t.do((g) => g.liar(c.id));
    expect(t.s.reveal).toMatchObject({ count: 1, loserId: b.id, outId: b.id });
    expect(t.p(b.id)).toMatchObject({ dice: 0, out: true, place: 3, outRound: 1 });
    t.fire();
    // Bob lost, but he's out, so the next player clockwise starts. He gets no cup.
    expect(t.s.turnId).toBe(c.id);
    expect(t.live!.dice[b.id]).toBeUndefined();
    expect(Object.keys(t.live!.dice).sort()).toEqual([a.id, c.id].sort());

    // Cat bids, Ann calls and is wrong... on her last die.
    t.setHands({ [a.id]: [6], [c.id]: [3, 3, 3] });
    t.do((g) => g.bid(c.id, 3, 3));
    t.do((g) => g.liar(a.id));
    expect(t.p(a.id)).toMatchObject({ out: true, place: 2 });
    expect(t.s.phase).toBe("reveal");
    t.fire();
    expect(t.s.phase).toBe("gameover");
    expect(t.s.winnerId).toBe(c.id);
    expect(t.p(c.id).place).toBe(1);
    expect(() => t.do((g) => g.bid(c.id, 1, 2))).toThrow();
  });

  it("leaving mid-game counts as going out, but your dice stay in this round", () => {
    const t = setup();
    const a = t.human("Ann");
    const b = t.human("Bob");
    const c = t.human("Cat");
    t.do((g) => g.updateSettings(a.id, { turnSeconds: 0 }));
    t.do((g) => g.start(a.id));
    t.s.order = [a.id, b.id, c.id];
    t.s.turnId = b.id;
    t.setHands({ [a.id]: [4, 4, 4, 4, 4], [b.id]: [2, 3, 5, 6, 6], [c.id]: [2, 3, 5, 6, 6] });
    t.do((g) => g.leave(a.id));
    expect(t.p(a.id)).toMatchObject({ out: true, place: 3, dice: 5 });
    // Ann's 4s still count this round.
    t.do((g) => g.bid(b.id, 5, 4));
    expect(t.s.turnId).toBe(c.id);
    t.do((g) => g.liar(c.id));
    expect(t.s.reveal).toMatchObject({ count: 5, loserId: c.id });
    t.fire();
    expect(t.live!.dice[a.id]).toBeUndefined();
    expect(t.p(a.id).dice).toBe(0);
    // Down to one player: the game is over.
    t.do((g) => g.leave(c.id));
    expect(t.s.phase).toBe("gameover");
    expect(t.s.winnerId).toBe(b.id);
  });

  it("seats latecomers as watchers, with no dice", () => {
    const t = setup();
    const a = t.human("Ann");
    t.do((g) => g.addCpu(a.id, "easy"));
    t.do((g) => g.start(a.id));
    const late = t.human("Late");
    expect(late.spectator).toBe(true);
    expect((t.p(late.id) as PlayerState).dice).toBe(0);
    expect(t.live!.dice[late.id]).toBeUndefined();
    const hello = t.game((g) => g.setConnected(late.id, true));
    expect(hello.direct).toEqual([]);
  });
});

describe("after a restart", () => {
  it("rolls the round again if its dice were lost", () => {
    const { t, a, b } = headsUp();
    t.do((g) => g.bid(a.id, 2, 3));
    t.live = null;
    const g = t.game((g) => g.setConnected(b.id, true));
    expect(t.live!.round).toBe(t.s.round);
    expect(t.s.bids).toEqual([]);
    expect(g.direct.map((d) => d.pid).sort()).toEqual([a.id, b.id].sort());
  });
});
