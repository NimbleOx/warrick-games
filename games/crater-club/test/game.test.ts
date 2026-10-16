import { describe, expect, it } from "vitest";
import { CASH_SURVIVE, DRAW_TURNS_EACH, SUDDEN_DEATH_TURNS_EACH, WORLD_W } from "../src/shared/constants";
import type { PlayerState, ShotMessage } from "../src/shared/protocol";
import { maxPowerFor } from "../src/shared/sim";
import { Game, newGameState } from "../src/worker/game";

function setup() {
  let now = 1_000_000;
  const connected = new Set<string>();
  const s = newGameState("ABCDE", now);
  const io = { now: () => now, isConnected: (id: string) => connected.has(id) };
  const games: Game[] = [];
  const game = () => {
    const g = new Game(s, io);
    games.push(g);
    return g;
  };
  return {
    s,
    game,
    connected,
    /** The battle log so far, and every shot fired. */
    events: () => games.flatMap((g) => g.logs.map((l) => l.text)),
    shots: () => games.flatMap((g) => g.outbox.flatMap((m) => (m.t === "shot" ? [m.shot] : []))),
    /** Run the timer that's due next. */
    runTimer() {
      now = Math.max(now, s.timer!.at);
      game().onTimer();
    },
    advance(ms: number) {
      now += ms;
    },
    runTimers(max = 2000) {
      for (let i = 0; i < max && s.timer; i++) {
        now = Math.max(now, s.timer.at);
        game().onTimer();
        if (s.phase === "shop") {
          for (const p of s.players) if (!p.cpu) game().setReady(p.id, true);
        }
        if (s.phase === "gameover") return;
      }
    },
  };
}

describe("game flow", () => {
  it("plays a full CPU match to game over", () => {
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().updateSettings(host.id, { rounds: 2, turnSeconds: 30 });
    t.game().addCpu(host.id, "hard");
    t.game().addCpu(host.id, "easy");
    t.game().start(host.id);
    // Starting cash means a shopping trip before round 1; CPUs spend theirs.
    expect(t.s.phase).toBe("shop");
    expect(t.s.round).toBe(0);
    expect(t.s.players.filter((p) => p.cpu).some((p) => Object.keys(p.inventory).length > 0)).toBe(true);
    t.game().setReady(host.id, true);
    expect(t.s.phase).toBe("playing");
    expect(t.s.round).toBe(1);
    expect(t.s.terrain).toHaveLength(1200);
    // The lobby is closed while the game is on.
    expect(() => t.game().addCpu(host.id, "easy")).toThrow("Wait for the round to end");

    // The human never fires, so their turns time out; the CPUs fight it out.
    t.runTimers();
    expect(t.s.phase).toBe("gameover");
    expect(t.s.round).toBe(2);
    expect(t.s.shotCount).toBeGreaterThan(0);

    // Back to the lobby: the board and the money reset for the next game.
    t.game().backToLobby(host.id);
    expect(t.s.phase).toBe("lobby");
    expect(t.s.round).toBe(0);
    expect(t.s.terrain).toEqual([]);
    expect(t.s.timer).toBeNull();
    expect(t.s.players.every((p) => p.tank === null && p.money === t.s.settings.startCash)).toBe(true);
    expect(() => t.game().backToLobby(host.id)).toThrow("Not right now");
  });

  it("only lets the current player fire", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().updateSettings(a.id, { startCash: 0 });
    t.game().start(a.id);
    expect(t.s.phase).toBe("playing"); // no cash, no pre-game shop
    const current = t.s.turnPlayerId!;
    const other = current === a.id ? b.id : a.id;
    expect(() => t.game().fire(other, { angle: 45, power: 500, weapon: "baby_missile" })).toThrow();
    const g = t.game();
    g.fire(current, { angle: 45, power: 500, weapon: "baby_missile" });
    expect(g.outbox[0].t).toBe("shot");
    expect(t.s.resolving).toBe(true);
  });

  it("a nearly dead tank can still fire a real distance", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    const b = t.game().addHuman("B");
    t.connected.add(a.id).add(b.id);
    t.game().updateSettings(a.id, { startCash: 0 });
    t.game().start(a.id);
    const shooter = t.s.players.find((p) => p.id === t.s.turnPlayerId)!;
    shooter.tank!.health = 2;
    const g = t.game();
    g.fire(shooter.id, { angle: 45, power: 1000, weapon: "baby_missile" });
    const shot = g.outbox[0] as { t: "shot"; shot: { power: number } };
    expect(shot.shot.power).toBe(412);
  });

  it("joining mid-game makes you a spectator", () => {
    const t = setup();
    const a = t.game().addHuman("A");
    t.connected.add(a.id);
    t.game().addCpu(a.id, "normal");
    t.game().start(a.id);
    const late = t.game().addHuman("Late");
    expect(late.spectator).toBe(true);
    expect(late.tank).toBeNull();
  });
});

/** Put a tank on flat ground at `x`. */
function place(t: ReturnType<typeof setup>, p: PlayerState, x: number, health = 100) {
  p.tank = { x, y: t.s.terrain[x], health, alive: true, shield: 0 };
}

/** Two players at either end of flat ground with no wind, round 1 under way. */
function duel(turnSeconds = 0) {
  const t = setup();
  const a = t.game().addHuman("A");
  const b = t.game().addHuman("B");
  t.connected.add(a.id).add(b.id);
  t.game().updateSettings(a.id, { startCash: 0, maxWind: 0, turnSeconds });
  t.game().start(a.id);
  t.s.terrain = new Array(WORLD_W).fill(100);
  place(t, a, 100);
  place(t, b, 1100);
  const turn = () => t.s.players.find((p) => p.id === t.s.turnPlayerId)!;
  return {
    ...t,
    a,
    b,
    turn,
    /** The player whose turn it is fires off the map at the near wall, and the shot plays out. */
    fireAway(power = 1000) {
      const p = turn();
      t.game().fire(p.id, { angle: p.tank!.x < WORLD_W / 2 ? 175 : 5, power, weapon: "baby_missile" });
      t.runTimer();
    },
  };
}

describe("stalemates", () => {
  it("bring on sudden death when nobody is hurt for a while, then end the round in a draw", () => {
    const d = duel();
    // A is badly damaged, so can't fire hard.
    d.a.tank!.health = 21;
    const quiet = 2 * SUDDEN_DEATH_TURNS_EACH;
    for (let i = 1; i < quiet; i++) d.fireAway();
    expect(d.s.quietTurns).toBe(quiet - 1);
    expect(d.s.suddenDeath).toBe(false);
    expect(
      d
        .shots()
        .filter((sh) => sh.shooterId === d.a.id)
        .every((sh) => sh.power === maxPowerFor(21)),
    ).toBe(true);

    d.fireAway();
    expect(d.s.suddenDeath).toBe(true);
    expect(d.s.quietTurns).toBe(0);
    expect(d.events().some((e) => e.startsWith("💀 Sudden death!"))).toBe(true);
    expect(d.s.phase).toBe("playing");

    // Sudden death: A fires at full power now.
    if (d.turn() !== d.a) d.fireAway();
    d.fireAway(1000);
    expect((d.shots().at(-1) as ShotMessage).power).toBe(1000);

    // Still nobody hurt: the round is a draw, and both survivors get paid for surviving.
    const money = d.s.players.map((p) => p.money);
    while (d.s.phase === "playing" && d.s.quietTurns! < 2 * DRAW_TURNS_EACH - 1) d.fireAway();
    expect(d.s.phase).toBe("playing");
    d.fireAway();
    expect(d.s.phase).toBe("roundover");
    expect(d.s.roundWinnerId).toBeNull();
    expect(d.s.players.every((p) => p.tank!.alive)).toBe(true);
    expect(d.s.players.map((p) => p.money)).toEqual(money.map((m) => m + CASH_SURVIVE));
    expect(d.events()).toContain(`Round 1 is a draw — nobody was hurt in ${DRAW_TURNS_EACH} turns each of sudden death`);

    // The next round starts afresh.
    d.runTimer();
    d.runTimer();
    expect(d.s.phase).toBe("playing");
    expect(d.s.round).toBe(2);
    expect(d.s.suddenDeath).toBe(false);
    expect(d.s.quietTurns).toBe(0);
  });

  it("count from the last time anyone was hurt, shields and self-inflicted damage included", () => {
    const d = duel();
    d.fireAway();
    d.fireAway();
    expect(d.s.quietTurns).toBe(2);
    // Straight up, and back down on yourself.
    d.game().fire(d.turn().id, { angle: 90, power: 600, weapon: "baby_missile" });
    d.runTimer();
    expect(d.s.quietTurns).toBe(0);

    d.fireAway();
    expect(d.s.quietTurns).toBe(1);
    const shooter = d.turn();
    const health = shooter.tank!.health;
    shooter.tank!.shield = 60;
    d.game().fire(shooter.id, { angle: 90, power: 600, weapon: "baby_missile" });
    d.runTimer();
    expect(shooter.tank!.shield).toBeLessThan(60);
    expect(shooter.tank!.health).toBe(health);
    expect(d.s.quietTurns).toBe(0);
  });

  it("count turns that run out, and cope with a game saved before they were counted", () => {
    const d = duel(30);
    delete d.s.quietTurns;
    delete d.s.suddenDeath;
    d.fireAway();
    expect(d.s.quietTurns).toBe(1);
    // From here on nobody fires, and every turn runs out.
    const quiet = 2 * SUDDEN_DEATH_TURNS_EACH;
    for (let i = 2; i < quiet; i++) d.runTimer();
    expect(d.s.quietTurns).toBe(quiet - 1);
    expect(d.s.suddenDeath).toBeFalsy();
    d.runTimer();
    expect(d.events().filter((e) => e.includes("ran out of time"))).toHaveLength(quiet - 1);
    expect(d.s.suddenDeath).toBe(true);
  });

  it("let a damaged CPU that can't reach anyone fire at full power, so the round ends", () => {
    // A hard CPU with 21 health (max power 526) facing a wind of 10, 655 px from the only other
    // tank, can't reach it. Its human opponent never fires.
    const t = setup();
    const host = t.game().addHuman("Host");
    t.connected.add(host.id);
    t.game().updateSettings(host.id, { startCash: 0, turnSeconds: 30, rounds: 1 });
    t.game().addCpu(host.id, "hard");
    t.game().start(host.id);
    t.s.terrain = new Array(WORLD_W).fill(100);
    t.s.wind = 10;
    const cpu = t.s.players.find((p) => p.cpu)!;
    place(t, host, 192);
    place(t, cpu, 847, 21);
    const cap = maxPowerFor(21);

    // Whoever wins, or if nobody does, the round ends.
    for (let i = 0; i < 400 && t.s.phase === "playing"; i++) t.runTimer();
    expect(t.s.phase).not.toBe("playing");
    const shots = t.shots();
    expect(shots.slice(0, SUDDEN_DEATH_TURNS_EACH).every((sh) => sh.power <= cap)).toBe(true);
    expect(t.events().some((e) => e.startsWith("💀 Sudden death!"))).toBe(true);
    // In sudden death it fires harder than it could before.
    expect(shots.some((sh) => sh.power > cap)).toBe(true);
  });
});
