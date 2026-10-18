import { describe, expect, it } from "vitest";
import type { GameState, ServerMsg } from "../src/shared/protocol";
import { largestGroup, seatBonus, sum, territoryCount } from "../src/shared/rules";
import { Game, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io);
  return {
    s,
    game,
    connected,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    /** Fire timers until the game is over (or there are none left). */
    runTimers(max = 50_000) {
      let n = 0;
      for (; n < max && s.timer && s.phase === "playing"; n++) {
        now = Math.max(now, s.timer.at);
        game().onTimer();
      }
      return n;
    },
    /** Fire the next timer and return what it sent. */
    tick(): ServerMsg[] {
      now = Math.max(now, s.timer!.at);
      const g = game();
      g.onTimer();
      return wire(g.outbox);
    },
  };
}

/** Messages as clients get them. */
function wire(outbox: ServerMsg[]): ServerMsg[] {
  return JSON.parse(JSON.stringify(outbox));
}

function humans(t: ReturnType<typeof setup>, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = t.game().addHuman(`P${i + 1}`);
    t.connected.add(p.id);
    ids.push(p.id);
  }
  return ids;
}

const turnId = (s: GameState) => s.order[s.turn];
const seatOf = (s: GameState, id: string) => s.order.indexOf(id);

/** Give `id` an attack it can make: its first territory with an enemy neighbour gets 8 dice. */
function armAttack(s: GameState, id: string): [number, number] {
  const seat = seatOf(s, id);
  for (let t = 0; t < s.owner.length; t++) {
    if (s.owner[t] !== seat) continue;
    const enemy = s.map!.adj[t].find((u) => s.owner[u] !== seat);
    if (enemy === undefined) continue;
    s.dice[t] = 8;
    return [t, enemy];
  }
  throw new Error("no attack");
}

describe("starting", () => {
  it("deals the map out evenly with the starting dice", () => {
    const t = setup();
    const [a] = humans(t, 1);
    t.game().updateSettings(a, { size: 4 });
    t.game().addCpu(a, "easy");
    t.game().addCpu(a, "hard");
    const g = t.game();
    g.start(a);
    const s = t.s;
    expect(s.phase).toBe("playing");
    expect(s.owner).toHaveLength(12);
    expect(s.order).toHaveLength(3);
    // 1 die a territory, twice the size in extra dice, and a bit more for later seats.
    const bonus = seatBonus(3, 4);
    expect(bonus).toEqual([0, 1, 2]);
    for (let seat = 0; seat < 3; seat++) {
      expect(territoryCount(s.owner, seat)).toBe(4);
      expect(sum(s.dice.filter((_, i) => s.owner[i] === seat))).toBe(4 + 8 + bonus[seat]);
    }
    // The state that starts the game carries the map; the lobby is closed.
    const msgs = wire(g.outbox);
    const state = msgs.find((m) => m.t === "state") as Extract<ServerMsg, { t: "state" }>;
    expect(state.state.map?.adj).toHaveLength(12);
    expect(state.state.mapId).toBe(s.mapId);
    expect(() => t.game().addCpu(a, "easy")).toThrow("Wait for the round to end");
  });

  it("joining mid-game makes you a spectator", () => {
    const t = setup();
    const [a] = humans(t, 1);
    t.game().addCpu(a, "normal");
    t.game().start(a);
    const late = t.game().addHuman("Late");
    expect(late.spectator).toBe(true);
    expect(late.seat).toBe(-1);
  });
});

describe("turns", () => {
  it("only lets the player whose turn it is attack, and only legally", () => {
    const t = setup();
    const [a, b] = humans(t, 2);
    t.game().start(a);
    const s = t.s;
    const me = turnId(s);
    const other = me === a ? b : a;
    const [from, to] = armAttack(s, me);
    expect(() => t.game().attack(other, from, to)).toThrow(/turn/);
    const mine = s.owner.findIndex((o, i) => o === seatOf(s, me) && i !== from);
    s.dice[mine] = 1;
    expect(() => t.game().attack(me, mine, to)).toThrow("A territory needs 2 or more dice to attack");
    expect(() => t.game().attack(me, from, from)).toThrow("You can't attack your own territory");
    const far = s.owner.findIndex((o, i) => o !== seatOf(s, me) && !s.map!.adj[from].includes(i));
    if (far >= 0) expect(() => t.game().attack(me, from, far)).toThrow("You can only attack a neighbouring territory");

    const g = t.game();
    g.attack(me, from, to);
    const msgs = wire(g.outbox);
    expect(msgs[0].t).toBe("attack");
    const ev = (msgs[0] as Extract<ServerMsg, { t: "attack" }>).attack;
    expect(ev.att).toHaveLength(8);
    expect(ev.def.length).toBeGreaterThanOrEqual(1);
    expect(s.dice[from]).toBe(1);
    expect(s.owner[to]).toBe(ev.won ? seatOf(s, me) : seatOf(s, other));
    // The state after it comes next, without the map.
    expect(msgs[1].t).toBe("state");
    expect((msgs[1] as Extract<ServerMsg, { t: "state" }>).state.map).toBeNull();
  });

  it("the clock restarts after each attack, and running out ends the turn with dice", () => {
    const t = setup();
    const [a, b] = humans(t, 2);
    t.game().updateSettings(a, { turnSeconds: 15 });
    t.game().start(a);
    const s = t.s;
    const me = turnId(s);
    expect(s.turnDeadline).toBe(t.now() + 15_000);
    t.advance(10_000);
    const [from, to] = armAttack(s, me);
    t.game().attack(me, from, to);
    expect(s.turnDeadline).toBe(t.now() + 15_000);

    const seat = seatOf(s, me);
    const before = sum(s.dice.filter((_, i) => s.owner[i] === seat));
    const gain = largestGroup(s.map!.adj, s.owner, seat);
    const msgs = t.tick();
    const drop = msgs.find((m) => m.t === "drop") as Extract<ServerMsg, { t: "drop" }>;
    expect(drop.drop.gain).toBe(gain);
    expect(drop.drop.placed.length + drop.drop.reserve).toBe(gain);
    expect(sum(s.dice.filter((_, i) => s.owner[i] === seat))).toBe(before + drop.drop.placed.length);
    // The dice land, then it's the other player's turn.
    expect(s.timer?.kind).toBe("drop");
    expect(() => t.game().attack(me, from, to)).toThrow("Your turn is over");
    t.tick();
    expect(turnId(s)).toBe(me === a ? b : a);
  });

  it("End turn hands over to the next player and counts rounds", () => {
    const t = setup();
    const [a, b] = humans(t, 2);
    t.game().start(a);
    const s = t.s;
    const first = turnId(s);
    t.game().endTurn(first);
    t.tick();
    const second = turnId(s);
    expect(second).not.toBe(first);
    expect(s.round).toBe(1);
    t.game().endTurn(second);
    t.tick();
    expect(turnId(s)).toBe(first);
    expect(s.round).toBe(2);
    expect([a, b]).toContain(second);
  });

  it("dice that don't fit go to the reserve and come out first next time", () => {
    const t = setup();
    const [a] = humans(t, 1);
    t.game().addCpu(a, "easy");
    t.game().start(a);
    const s = t.s;
    while (turnId(s) !== a) t.tick();
    const seat = seatOf(s, a);
    s.owner.forEach((o, i) => o === seat && (s.dice[i] = 8));
    const gain = largestGroup(s.map!.adj, s.owner, seat);
    t.game().endTurn(a);
    const me = s.players.find((p) => p.id === a)!;
    expect(me.reserve).toBe(gain);
    // Next time round there's room on one territory: the reserve goes there first.
    t.tick();
    while (turnId(s) !== a) t.tick();
    const spot = s.owner.findIndex((o) => o === seat);
    s.owner.forEach((o, i) => o === seat && (s.dice[i] = 8));
    s.dice[spot] = 1;
    me.reserve = 10;
    const gain2 = largestGroup(s.map!.adj, s.owner, seat);
    const g = t.game();
    g.endTurn(a);
    const drop = (wire(g.outbox).find((m) => m.t === "drop") as Extract<ServerMsg, { t: "drop" }>).drop;
    expect(drop.placed).toEqual(Array(7).fill(spot));
    expect(me.reserve).toBe(10 + gain2 - 7);
  });

  it("a player who isn't connected loses their turn after 5 seconds", () => {
    const t = setup();
    const [a, b] = humans(t, 2);
    t.game().updateSettings(a, { turnSeconds: 60 });
    t.game().start(a);
    const s = t.s;
    const me = turnId(s);
    t.connected.delete(me);
    t.game().setConnected(me, false);
    expect(s.turnDeadline).toBe(t.now() + 5000);
    const msgs = t.tick();
    expect(msgs.some((m) => m.t === "drop")).toBe(true);
    t.tick();
    expect(turnId(s)).toBe(me === a ? b : a);
  });

  it("coming back mid-turn keeps the clock", () => {
    const t = setup();
    const [a] = humans(t, 2);
    t.game().updateSettings(a, { turnSeconds: 30 });
    t.game().start(a);
    const s = t.s;
    const me = turnId(s);
    t.advance(10_000);
    t.connected.delete(me);
    t.game().setConnected(me, false);
    t.advance(2000);
    t.connected.add(me);
    t.game().setConnected(me, true);
    expect(s.turnDeadline).toBe(t.now() + 18_000);
  });

  it("the host can hand a missing player's seat to a CPU, and they take it back on return", () => {
    const t = setup();
    const [a, b] = humans(t, 2);
    t.game().start(a);
    const s = t.s;
    t.connected.delete(b);
    t.game().setConnected(b, false);
    expect(() => t.game().takeover(b, a)).toThrow("Only the host can do that");
    expect(() => t.game().takeover(a, a)).toThrow(/still here/);
    t.game().takeover(a, b);
    const pb = s.players.find((p) => p.id === b)!;
    expect(pb.cpu).toBe("normal");
    if (turnId(s) === b) expect(s.timer?.kind).toBe("cpu");
    t.connected.add(b);
    t.game().setConnected(b, true);
    expect(pb.cpu).toBeNull();
    expect(pb.connected).toBe(true);
  });
});

describe("a whole game", () => {
  it("CPUs at every level play to a winner; the rest are ranked by when they went out", () => {
    const t = setup();
    const [host] = humans(t, 1);
    t.game().updateSettings(host, { size: 4, fastCpus: true });
    t.game().addCpu(host, "easy");
    t.game().addCpu(host, "normal");
    t.game().addCpu(host, "hard");
    t.game().start(host);
    // The human never moves, so their turns run out; the CPUs fight it out.
    t.runTimers();
    const s = t.s;
    expect(s.phase).toBe("gameover");
    expect(s.winnerId).not.toBeNull();
    expect(s.knockedOut).toHaveLength(3);
    expect(new Set(s.owner)).toEqual(new Set([seatOf(s, s.winnerId!)]));
    expect(s.players.filter((p) => p.outRound !== null)).toHaveLength(3);
    expect(s.attackNo).toBeGreaterThan(10);

    // Back to the lobby: the board is cleared for the next game.
    t.game().backToLobby(host);
    expect(s.phase).toBe("lobby");
    expect(s.map).toBeNull();
    expect(s.timer).toBeNull();
    expect(s.players.every((p) => p.seat === -1 && p.reserve === 0)).toBe(true);
  });

  it("a client without the map can ask for it", () => {
    const t = setup();
    const [a] = humans(t, 1);
    t.game().addCpu(a, "easy");
    t.game().start(a);
    const g = t.game();
    g.sync(a);
    const msg = wire(g.direct.map((d) => d.msg))[0] as Extract<ServerMsg, { t: "state" }>;
    expect(msg.state.map?.id).toBe(t.s.mapId);
  });
});
