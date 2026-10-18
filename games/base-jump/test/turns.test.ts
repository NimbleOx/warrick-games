import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { planTurn, type CpuLevel } from "../src/shared/ai";
import { applyFrame, Battle, planned, type Frame } from "../src/shared/battle";
import { TURN_TICKS } from "../src/shared/constants";
import { generateMap, type MapSize } from "../src/shared/map";
import type { ServerMsg, Snapshot } from "../src/shared/protocol";
import { AWAY_MS, GameError, restore } from "../src/worker/game";
import { gameSetup, lineBattle } from "./helpers";

const frames = (sent: ServerMsg[]) => sent.filter((m): m is Frame => m.t === "f");

/** A round in turns: Ann (and Bo, if asked for) against CPUs (one easy one by default), 30 seconds to plan. */
function turnRound(opts: { bo?: boolean; cpus?: CpuLevel[]; turns?: number; plan?: number } = {}) {
  const t = gameSetup();
  const ann = t.human("Ann");
  const bo = opts.bo ? t.human("Bo") : null;
  for (const level of opts.cpus ?? ["easy"]) t.act((g) => g.addCpu(ann.id, level));
  t.act((g) => g.updateSettings(ann.id, { mode: "turns", turns: opts.turns ?? 40, plan: opts.plan ?? 30, map: "small" }));
  t.act((g) => g.start(ann.id));
  const battle = t.live!.battle;
  const home = battle.seat[t.s.players[0].slot];
  return { t, ann, bo, battle, home, next: battle.map.adj[home][0] };
}

describe("turns", () => {
  it("start with everyone planning turn 1, and nothing moving until they're done", () => {
    const { t, battle } = turnRound();
    expect(t.s.turn).toMatchObject({
      n: 1,
      stage: "plan",
      tick: 0,
      end: 1_000_000 + 30_000,
      deadline: 1_000_000 + 30_000,
      done: [],
    });
    expect(battle.go).toBe(0);
    t.tick(20);
    expect(battle.n).toBe(0);
    expect(frames(t.sent)).toEqual([]);
  });

  it("add orders to the player's plan, checked against what the plan leaves", () => {
    const { t, ann, battle, home, next } = turnRound();
    t.act((g) => g.send(ann.id, [home], next, 100));
    // Nothing has left yet: the order is in the plan, and only Ann hears about it.
    expect(battle.groups).toEqual([]);
    expect(battle.bases[home].t).toBe(15);
    expect(t.direct.at(-1)).toEqual({ pid: ann.id, msg: { t: "plan", n: 1, c: [["s", 0, [home], next, 100]] } });
    expect(t.sent.some((m) => m.t === "plan")).toBe(false);
    // Everything is already going: there's nothing left to send.
    expect(() => t.act((g) => g.send(ann.id, [home], next, 50))).toThrow("No units");
    t.act((g) => g.undo(ann.id));
    expect(t.direct.at(-1)!.msg).toEqual({ t: "plan", n: 1, c: [] });
    expect(() => t.act((g) => g.undo(ann.id))).toThrow("no orders");
    t.act((g) => g.send(ann.id, [home], next, 50));
    t.act((g) => g.send(ann.id, [home], next, 50));
    // Half of 15 is 8 (sends round up), then half of the 7 left is 4.
    expect(planned(battle, t.live!.plans[0]).bases[home].t).toBe(3);
  });

  it("run once everyone is done: every plan goes out on the first tick, then everyone plans again", () => {
    const { t, ann, battle, home, next } = turnRound();
    t.act((g) => g.send(ann.id, [home], next, 50));
    // Whatever the CPU planned (an easy one sometimes plans nothing).
    const cpuPlan = t.live!.plans[1];
    t.act((g) => g.done(ann.id, true));
    expect(t.s.turn).toMatchObject({ n: 1, stage: "run", deadline: null });
    t.tick();
    const [first] = frames(t.sent);
    // Turn 1 starts with the first seat's orders.
    expect(first.c).toEqual([["s", 0, [home], next, 50], ...cpuPlan]);
    expect(battle.groups.some((g) => g.owner === 0)).toBe(true);
    t.tick(TURN_TICKS - 2);
    expect(t.s.turn!.stage).toBe("run");
    t.tick();
    expect(battle.n).toBe(TURN_TICKS);
    expect(t.s.turn).toMatchObject({ n: 2, stage: "plan", tick: TURN_TICKS, done: [] });
    // Turn 2 starts with the next seat's orders.
    t.act((g) => g.send(ann.id, [home], next, 25));
    t.act((g) => g.done(ann.id, true));
    t.tick();
    const second = frames(t.sent).at(-1)!;
    expect(second.c?.at(-1)).toEqual(["s", 0, [home], next, 25]);
  });

  it("let a player take back being done, and changing the plan does too", () => {
    const { t, ann, bo, home, next } = turnRound({ bo: true });
    t.act((g) => g.done(ann.id, true));
    expect(t.s.turn!.done).toEqual([ann.id]);
    t.act((g) => g.done(ann.id, false));
    expect(t.s.turn!.done).toEqual([]);
    t.act((g) => g.done(ann.id, true));
    t.act((g) => g.send(ann.id, [home], next, 50));
    expect(t.s.turn!.done).toEqual([]);
    t.act((g) => g.done(bo!.id, true));
    expect(t.s.turn!.stage).toBe("plan");
    t.act((g) => g.done(ann.id, true));
    expect(t.s.turn!.stage).toBe("run");
  });

  it("refuse orders while the turn plays out, and from players who aren't in", () => {
    const { t, ann, home, next } = turnRound();
    t.act((g) => g.done(ann.id, true));
    expect(() => t.act((g) => g.send(ann.id, [home], next, 50))).toThrow("Wait for this turn");
    expect(() => t.act((g) => g.done(ann.id, false))).toThrow("Wait for this turn");
    const late = t.human("Late");
    expect(() => t.act((g) => g.done(late.id, true))).toThrow(GameError);
  });

  it("run when time to plan is up, unless nobody was here to see it", () => {
    const { t } = turnRound({ plan: 15 });
    t.advance(10_000);
    t.act((g) => g.onTimer());
    expect(t.s.turn!.stage).toBe("plan");
    t.advance(5_000);
    t.act((g) => g.onTimer());
    expect(t.s.turn!.stage).toBe("run");
    t.tick(TURN_TICKS);
    expect(t.s.turn).toMatchObject({ n: 2, stage: "plan", deadline: 1_015_000 + 15_000 });
    // The deadline passed a minute ago, with nobody here: the turn starts its clock again.
    t.advance(75_000);
    t.act((g) => g.onTimer());
    expect(t.s.turn).toMatchObject({ n: 2, stage: "plan", end: 1_090_000 + 15_000, deadline: 1_090_000 + 15_000 });
  });

  it("have no deadline with no time limit to plan", () => {
    const { t } = turnRound({ plan: 0 });
    expect(t.s.turn!.deadline).toBeNull();
    t.advance(10 * 60_000);
    t.act((g) => g.onTimer());
    expect(t.s.turn!.stage).toBe("plan");
  });

  it("give a player who has gone a moment to come back, then run without them", () => {
    const { t, ann, bo } = turnRound({ bo: true });
    const end = t.s.turn!.end;
    t.act((g) => g.done(ann.id, true));
    t.act((g) => g.setConnected(bo!.id, false));
    expect(t.s.turn).toMatchObject({ stage: "plan", end, deadline: 1_000_000 + AWAY_MS });
    // Back in time: the whole time to plan again.
    t.advance(5_000);
    t.act((g) => g.setConnected(bo!.id, true));
    expect(t.s.turn).toMatchObject({ stage: "plan", deadline: end });
    // Gone again: the time away starts over.
    t.act((g) => g.setConnected(bo!.id, false));
    expect(t.s.turn!.deadline).toBe(1_005_000 + AWAY_MS);
    t.advance(AWAY_MS);
    t.act((g) => g.onTimer());
    expect(t.s.turn!.stage).toBe("run");
  });

  it("don't wait for a player who left", () => {
    const { t, ann, bo } = turnRound({ bo: true });
    t.act((g) => g.done(ann.id, true));
    expect(t.s.turn!.stage).toBe("plan");
    t.act((g) => g.leave(bo!.id));
    expect(t.s.turn!.stage).toBe("run");
    // Everyone's copy of the battle hears about it.
    expect(t.sent.at(-1)?.t).toBe("snap");
  });

  it("keep a client that follows the frames in step", () => {
    const { t, ann, battle } = turnRound({ cpus: ["hard", "normal"] });
    const snap = (t.sent.find((m) => m.t === "snap") as { snap: Snapshot }).snap;
    const client = Battle.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    const seen = t.sent.length;
    for (let turn = 0; turn < 12 && t.s.phase === "playing"; turn++) {
      if (battle.alive(0)) t.act((g) => g.done(ann.id, true));
      t.tick(TURN_TICKS);
    }
    const run = frames(t.sent.slice(seen));
    expect(run.length).toBeGreaterThanOrEqual(TURN_TICKS * 2);
    expect(run.some((f) => f.c?.length)).toBe(true);
    for (const f of run) {
      expect(applyFrame(client, JSON.parse(JSON.stringify(f)))).not.toBeNull();
      if (f.ck !== undefined) expect(client.checksum()).toBe(f.ck);
    }
    expect(client.checksum()).toBe(battle.checksum());
  });

  it("end at the turn limit, with the turns in the results", () => {
    const { t, ann, battle } = turnRound({ turns: 25, cpus: ["normal", "normal"] });
    for (let turn = 0; turn < 25 && t.s.phase === "playing"; turn++) {
      if (battle.alive(0)) t.act((g) => g.done(ann.id, true));
      t.tick(TURN_TICKS);
    }
    expect(t.s.phase).toBe("results");
    expect(t.s.turn).toBeNull();
    const r = t.s.results!;
    expect(r.turns).toBeLessThanOrEqual(25);
    if (r.how === "time") expect(r.turns).toBe(25);
  });

  it("end the round when a player leaves the last one in", () => {
    const { t, ann } = turnRound();
    t.act((g) => g.leave(ann.id));
    expect(t.s.phase).toBe("results");
    expect(t.s.results!.standings.map((x) => x.name)).toEqual(["CPU Rex"]);
  });

  it("play on without waiting once only CPUs are in", () => {
    const { t, ann, battle } = turnRound({ cpus: ["hard", "hard"] });
    t.act((g) => g.leave(ann.id));
    expect(t.s.turn!.stage).toBe("run");
    t.tick(TURN_TICKS);
    // Straight on to the next run: nobody to wait for.
    expect(t.s.turn).toMatchObject({ n: 2, stage: "run" });
    expect(battle.n).toBe(TURN_TICKS);
  });

  it("come back from what the room saved, without anyone who left since", () => {
    const { t, ann, bo, battle, home, next } = turnRound({ bo: true });
    t.act((g) => g.send(ann.id, [home], next, 50));
    const slot = t.s.players.find((p) => p.id === bo!.id)!.slot;
    const saved = { round: t.s.round, turn: 1, snap: battle.snapshot() };
    const plans = JSON.parse(JSON.stringify(t.live!.plans));
    t.act((g) => g.leave(bo!.id));
    const live = restore(t.s, saved, plans)!;
    expect(live.battle).not.toBe(battle);
    expect(live.battle.map.id).toBe(battle.map.id);
    expect(live.battle.alive(slot)).toBe(false);
    expect(live.battle.bases[battle.seat[slot]].owner).toBe(-1);
    expect(live.plans[0]).toEqual([["s", 0, [home], next, 50]]);
    expect(live.queue).toEqual([]);
    expect(live.replay).toBeFalsy();
  });

  it("come back mid-run with the turn's orders, to play it again from its start", () => {
    const { t, ann, battle, home, next } = turnRound();
    t.act((g) => g.send(ann.id, [home], next, 50));
    const saved = { round: t.s.round, turn: 1, snap: battle.snapshot() };
    const plans = JSON.parse(JSON.stringify(t.live!.plans));
    t.act((g) => g.done(ann.id, true));
    const queue = [...t.live!.queue];
    t.tick(10);
    const live = restore(t.s, saved, plans)!;
    expect(live.battle.n).toBe(0);
    expect(live.queue).toEqual(queue);
    expect(live.replay).toBe(true);
  });

  it("have nothing to come back from for another turn or round, and start over then", () => {
    const { t, battle } = turnRound();
    const snap = battle.snapshot();
    expect(restore(t.s, { round: t.s.round, turn: 2, snap }, null)).toBeNull();
    expect(restore(t.s, { round: t.s.round - 1, turn: 1, snap }, null)).toBeNull();
    t.forget();
    t.act((g) => g.recover());
    expect(t.live!.battle.map.id).not.toBe(battle.map.id);
    expect(t.s.turn).toMatchObject({ n: 1, stage: "plan" });
  });

  it("keep real time as it was: no turn, and orders on the next tick", () => {
    const t = gameSetup();
    const ann = t.human("Ann");
    t.act((g) => g.addCpu(ann.id, "easy"));
    t.act((g) => g.start(ann.id));
    expect(t.s.settings.mode).toBe("live");
    expect(t.s.turn).toBeNull();
    expect(() => t.act((g) => g.done(ann.id, true))).toThrow("real time");
  });

  it("fill in the new settings for a game saved before turns", () => {
    const t = gameSetup();
    const ann = t.human("Ann");
    const old = t.s as unknown as { settings: Record<string, unknown>; turn?: unknown };
    old.settings = { minutes: 5, map: "large" };
    delete old.turn;
    t.act((g) => g.addCpu(ann.id, "easy"));
    expect(t.s.settings).toEqual({ mode: "live", minutes: 5, turns: 40, plan: 30, map: "large" });
    expect(t.s.turn).toBeNull();
  });
});

describe("CPU plans", () => {
  it("leave the battle as it was", () => {
    const b = generateMap(7, 3, "medium");
    const battle = new Battle(b, { slots: [0, 1, 2], countdown: 0, limit: 0 });
    const before = JSON.stringify(battle.snapshot());
    const plan = planTurn(battle, 0, "hard", mulberry32(1));
    expect(plan.length).toBeGreaterThan(0);
    expect(JSON.stringify(battle.snapshot())).toBe(before);
    expect(plan.every((cmd) => cmd[1] === 0)).toBe(true);
  });

  it("are empty for a player who's out", () => {
    const b = lineBattle();
    b.leave(1);
    expect(planTurn(b, 1, "hard", mulberry32(1))).toEqual([]);
  });

  /** CPUs play a whole round in turns. Returns the winner. */
  function playTurns(seed: number, levels: CpuLevel[], size: MapSize): number {
    const map = generateMap(seed, levels.length, size);
    const b = new Battle(map, { slots: levels.map((_, i) => i), countdown: 0, limit: 200 * TURN_TICKS });
    const rng = mulberry32(seed);
    for (let turn = 0; !b.over; turn++) {
      const alive = b.aliveSlots();
      const plans = alive.map((s) => planTurn(b, s, levels[s], rng));
      const k = turn % alive.length;
      for (const cmd of [...plans.slice(k), ...plans.slice(0, k)].flat()) b.apply(cmd);
      for (let i = 0; i < TURN_TICKS && !b.over; i++) b.step();
    }
    return b.ranking()[0];
  }

  it("let hard beat normal and normal beat easy, most of the time", () => {
    // Over 160 games (see the README) hard beats normal about 80% of the time, and normal beats easy every time.
    const duels = (strong: CpuLevel, weak: CpuLevel) => {
      let wins = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const swap = seed % 2 === 0;
        const winner = playTurns(seed * 7919, swap ? [weak, strong] : [strong, weak], seed % 4 < 2 ? "small" : "medium");
        if (winner === (swap ? 1 : 0)) wins++;
      }
      return wins;
    };
    expect(duels("hard", "normal")).toBeGreaterThanOrEqual(13);
    expect(duels("normal", "easy")).toBeGreaterThanOrEqual(18);
  });
});
