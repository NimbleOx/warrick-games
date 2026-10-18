import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { WORLD_W } from "../src/shared/constants";
import type { PlayerState } from "../src/shared/protocol";
import { launchFor } from "../src/shared/sim";
import type { Inventory } from "../src/shared/weapons";
import { worldFromState } from "../src/shared/world-state";
import { chooseCpuShot } from "../src/worker/ai";
import { Game, newGameState } from "../src/worker/game";

/** A hard CPU at `cpuX` and one other tank at `otherX`, on the given ground, with no wind. */
function board(heights: number[], cpuX: number, otherX: number, inventory: Inventory) {
  const s = newGameState("ABCDE", 1_000_000);
  const game = new Game(s, { now: () => 1_000_000, isConnected: () => true });
  const host = game.addHuman("Host");
  game.addCpu(host.id, "hard");
  game.updateSettings(host.id, { startCash: 0, maxWind: 0 });
  game.start(host.id);
  s.terrain = heights;
  const cpu = s.players.find((p) => p.cpu)!;
  const other = s.players.find((p) => !p.cpu)!;
  const place = (p: PlayerState, x: number) => (p.tank = { x, y: heights[x], health: 100, alive: true, shield: 0 });
  place(cpu, cpuX);
  place(other, otherX);
  cpu.inventory = inventory;
  return { s, cpu, other };
}

/** Play the CPU's choice through and return the damage done to each tank. */
function play(b: ReturnType<typeof board>) {
  const aim = chooseCpuShot(b.s, b.cpu, "hard", mulberry32(1));
  const w = worldFromState(b.s);
  w.fire({ shooterId: b.cpu.id, weapon: aim.weapon, seed: 1, ...launchFor(b.cpu.tank!, aim.angle, aim.power) });
  w.runToEnd();
  const hurt = (id: string) => w.events.reduce((n, e) => n + (e.type === "damage" && e.id === id ? e.amount : 0), 0);
  return { aim, self: hurt(b.cpu.id), other: hurt(b.other.id) };
}

const flat = () => new Array(WORLD_W).fill(200);
/** Ground shaped like a V, lowest at x = 600. */
const valley = () => Array.from({ length: WORLD_W }, (_, x) => 100 + Math.floor(Math.abs(x - 600) / 2));

describe("CPU players", () => {
  it("point a laser straight at a tank level with them", () => {
    const { aim, other } = play(board(flat(), 300, 700, { laser: 3 }));
    expect(aim.weapon).toBe("laser");
    expect(aim.angle).toBeLessThanOrEqual(1);
    expect(other).toBe(50);
  });

  it("don't fire a laser at a tank below them, which it can't reach", () => {
    const { aim } = play(board(valley(), 300, 600, { laser: 3 }));
    expect(aim.weapon).toBe("baby_missile");
  });

  it("pour napalm down into a valley, but not up a slope it would run back down", () => {
    const down = play(board(valley(), 720, 600, { napalm: 3 }));
    expect(down.aim.weapon).toBe("napalm");
    expect(down.self).toBe(0);
    expect(down.other).toBeGreaterThan(0);

    const up = play(board(valley(), 600, 720, { napalm: 3 }));
    expect(up.aim.weapon).toBe("baby_missile");
  });

  it("send a sandhog through a hill at a tank hiding behind it", () => {
    const hill = Array.from({ length: WORLD_W }, (_, x) => 200 + Math.max(0, 120 - Math.abs(x - 600)));
    const { aim, self, other } = play(board(hill, 400, 700, { sandhog: 3 }));
    expect(aim.weapon).toBe("sandhog");
    expect(self).toBe(0);
    expect(other).toBeGreaterThan(0);
  });
});
