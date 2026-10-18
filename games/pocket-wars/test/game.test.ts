import { describe, expect, it } from "vitest";
import { AWAY_MS, FINISH_MS } from "../src/shared/constants";
import { MAPS } from "../src/shared/maps";
import { standings } from "../src/shared/protocol";
import { tileOf } from "../src/shared/rules";
import { Game, GameError, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const game = () => new Game(s, io);
  const human = (name: string) => {
    const p = game().addHuman(name);
    connected.add(p.id);
    game().setConnected(p.id, true);
    return p;
  };
  /** Run the alarm until `until` says stop (or the timers run out). */
  const runTimers = (until: () => boolean = () => false, max = 20000) => {
    for (let i = 0; i < max && s.timer && !until(); i++) {
      now = Math.max(now, s.timer.at);
      game().onTimer();
    }
  };
  return {
    s,
    game,
    human,
    connected,
    runTimers,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

/** The factory of whoever's turn it is. */
function myFactory(s: ReturnType<typeof setup>["s"]): number {
  const m = MAPS[s.mapId!];
  const f = m.buildings.find((b, i) => b.kind === "factory" && s.board!.owners[i] === s.turn)!;
  return tileOf(m, f.x, f.y);
}

describe("game flow", () => {
  it("plays a game against a CPU to the end, then goes back to the lobby", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().updateSettings(host.id, { map: "pocket-duel", turnSeconds: 60, fastCpus: true });
    t.game().addCpu(host.id, "hard");
    t.game().start(host.id);
    expect(t.s.phase).toBe("playing");
    expect(t.s.mapId).toBe("pocket-duel");
    expect(t.s.day).toBe(1);
    // The lobby is closed while the game is on.
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("Wait for the round to end");

    // The host never moves, so their turns time out; the CPU takes their HQ or their factory.
    t.runTimers(() => t.s.phase === "gameover");
    expect(t.s.phase).toBe("gameover");
    const cpu = t.s.players.find((p) => p.cpu)!;
    expect(t.s.winnerId).toBe(cpu.id);
    expect(t.s.players.find((p) => p.id === host.id)!.outDay).not.toBeNull();
    expect(t.s.knockedOut).toEqual([host.id]);
    expect(cpu.stats.built).toBeGreaterThan(0);
    expect(standings(t.s).map((p) => p.id)).toEqual([cpu.id, host.id]);

    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.board).toBeNull();
    expect(t.s.timer).toBeNull();
    expect(t.s.players.every((p) => p.seat === -1 && p.stats.built === 0)).toBe(true);
  });

  it("checks whose turn it is and what they're allowed to do", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    t.game().updateSettings(host.id, { map: "pocket-duel" });
    t.game().start(host.id);
    const first = t.s.players.find((p) => p.id === t.s.order[0])!;
    const second = t.s.players.find((p) => p.id === t.s.order[1])!;
    expect([first.id, second.id].sort()).toEqual([host.id, guest.id].sort());
    // Seat 1 collected 2,000 (HQ and factory); seat 2 starts with its bonus.
    expect(t.s.board!.funds).toEqual([2000, 4000]);

    expect(() => t.game().endTurn(second.id)).toThrow(`It's ${first.name}'s turn`);
    expect(() => t.game().build(first.id, myFactory(t.s), "tank")).toThrow(/Not enough funds/);
    const g = t.game();
    g.build(first.id, myFactory(t.s), "infantry");
    expect(t.s.board!.funds[0]).toBe(1000);
    expect(g.outbox.map((m) => m.t)).toEqual(["build"]);
    expect(g.dirty).toBe(true);
    const inf = t.s.board!.units[0];
    expect(() => t.game().act(first.id, { unit: inf.id, to: myFactory(t.s), action: "wait" })).toThrow(/already moved/);

    t.game().endTurn(first.id);
    expect(t.s.turn).toBe(1);
    expect(t.s.day).toBe(1);
    expect(t.s.board!.funds[1]).toBe(6000);
    expect(() => t.game().act(second.id, { unit: inf.id, to: myFactory(t.s), action: "wait" })).toThrow("That's not your unit");

    t.game().endTurn(second.id);
    expect(t.s.turn).toBe(0);
    expect(t.s.day).toBe(2);
    // Day 2: the infantry can move; one action each.
    const m = MAPS["pocket-duel"];
    const g2 = t.game();
    g2.act(first.id, { unit: inf.id, to: tileOf(m, inf.x + 1, inf.y), action: "wait" });
    expect(g2.outbox[0]).toMatchObject({ t: "act", ev: { action: "wait", path: [tileOf(m, 1, 2), tileOf(m, 2, 2)] } });
    expect(() => t.game().act(first.id, { unit: inf.id, to: tileOf(m, 2, 2), action: "wait" })).toThrow(GameError);
  });

  it("ends the turn when the clock runs out, and the units just wait", () => {
    const t = setup();
    const host = t.human("Host");
    t.human("Guest");
    t.game().updateSettings(host.id, { map: "pocket-duel", turnSeconds: 60 });
    t.game().start(host.id);
    const first = t.s.order[0];
    expect(t.s.turnDeadline).toBe(t.now + 60_000);
    t.game().build(first, myFactory(t.s), "infantry");
    t.advance(59_000);
    t.game().onTimer();
    expect(t.s.turn).toBe(0);
    t.advance(1000);
    t.game().onTimer();
    expect(t.s.turn).toBe(1);
    // The new infantry never moved, and it's ready again for its owner's next turn.
    expect(t.s.board!.units).toHaveLength(1);
    expect(t.s.board!.units.every((u) => !u.done)).toBe(true);
  });

  it("ends an away player's turn after a minute; the host can hand their seat to a CPU", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    t.game().updateSettings(host.id, { map: "pocket-duel", turnSeconds: 0 });
    t.game().start(host.id);
    // Make it the guest's turn.
    if (t.s.order[t.s.turn] !== guest.id) t.game().endTurn(host.id);
    expect(t.s.order[t.s.turn]).toBe(guest.id);
    expect(t.s.timer).toBeNull(); // no turn timer

    t.connected.delete(guest.id);
    t.game().setConnected(guest.id, false);
    expect(t.s.timer).toEqual({ kind: "turn", at: t.now + AWAY_MS });
    expect(() => t.game().takeover(guest.id, host.id)).toThrow("Only the host can do that");
    expect(() => t.game().takeover(host.id, host.id)).toThrow("Host is still here");

    t.game().takeover(host.id, guest.id);
    const g = t.s.players.find((p) => p.id === guest.id)!;
    expect(g).toMatchObject({ cpu: "normal", standIn: true });
    expect(t.s.timer?.kind).toBe("cpu");
    t.runTimers(() => t.s.order[t.s.turn] !== guest.id);
    expect(g.stats.built).toBe(1);

    // Back again: the seat is theirs.
    t.connected.add(guest.id);
    t.game().setConnected(guest.id, true);
    expect(g).toMatchObject({ cpu: null, standIn: false, connected: true });
  });

  it("lets anyone resign; the last army standing wins", () => {
    const t = setup();
    const host = t.human("Host");
    const guest = t.human("Guest");
    t.game().updateSettings(host.id, { map: "three-crowns" });
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    const cpu = t.s.players.find((p) => p.cpu)!;
    const guestP = t.s.players.find((p) => p.id === guest.id)!;
    const turnBefore = t.s.turn;

    t.game().resign(guest.id);
    expect(guestP).toMatchObject({ resigned: true, outDay: 1 });
    expect(t.s.board!.out[guestP.seat]).toBe(true);
    expect(t.s.board!.owners.includes(guestP.seat)).toBe(false);
    expect(t.s.winnerId).toBeNull();
    if (t.s.order[turnBefore] !== guest.id) expect(t.s.turn).toBe(turnBefore);
    expect(() => t.game().resign(guest.id)).toThrow("You're already out");

    t.game().resign(host.id);
    expect(t.s.winnerId).toBe(cpu.id);
    expect(t.s.timer).toEqual({ kind: "finish", at: t.now + FINISH_MS });
    expect(() => t.game().endTurn(cpu.id)).toThrow("The game is over");
    t.advance(FINISH_MS);
    t.game().onTimer();
    expect(t.s.phase).toBe("gameover");
    expect(standings(t.s).map((p) => p.id)).toEqual([cpu.id, host.id, guest.id]);
  });
});

describe("lobby", () => {
  it("holds four armies; anyone after that watches", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "easy");
    t.game().addCpu(host.id, "normal");
    t.game().addCpu(host.id, "hard");
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("The game is full (4 players)");
    expect(t.human("Late").spectator).toBe(true);
  });

  it("picks a map for the player count, or says the chosen one doesn't fit", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "easy");
    t.game().updateSettings(host.id, { map: "four-corners" });
    expect(() => t.game().start(host.id)).toThrow("Four Corners is a 4-player map and there are 2 players. Pick another map, or Auto.");
    t.game().addCpu(host.id, "easy");
    t.game().updateSettings(host.id, { map: "auto" });
    t.game().start(host.id);
    expect(t.s.mapId).toBe("three-crowns");
    expect(t.s.order).toHaveLength(3);
    expect(t.s.board!.funds.slice(1)).toEqual([2000, 2000]);
  });

  it("seats people who join mid-game as watchers", () => {
    const t = setup();
    const host = t.human("Host");
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    const late = t.human("Late");
    expect(late).toMatchObject({ spectator: true, seat: -1 });
    expect(() => t.game().endTurn(late.id)).toThrow("You're not in this game");
  });
});
