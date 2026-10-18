import { mulberry32 } from "@warrick/kit/shared/rng";
import { describe, expect, it } from "vitest";
import { applyFrame, Battle, clash, type Cmd, type Frame } from "../src/shared/battle";
import { BUILD_RATE, CAP, HELI, TANK, UPGRADE_COST } from "../src/shared/constants";
import { generateMap } from "../src/shared/map";
import { lineBattle, steps, tinyMap } from "./helpers";

describe("clash", () => {
  it("trades tanks for tanks and helicopters for helicopters one for one", () => {
    expect(clash(5, 0, TANK, 8)).toEqual({ t: 0, h: 0, left: 3 });
    expect(clash(0, 5, HELI, 8)).toEqual({ t: 0, h: 0, left: 3 });
    expect(clash(8, 0, TANK, 5)).toEqual({ t: 3, h: 0, left: 0 });
  });

  it("counts a tank as two helicopters", () => {
    // 4 tanks against 5 helicopters: 3 tanks for the 5, one left.
    expect(clash(0, 5, TANK, 4)).toEqual({ t: 0, h: 0, left: 1 });
    // 7 helicopters against 3 tanks: 6 for the 3, one left.
    expect(clash(3, 0, HELI, 7)).toEqual({ t: 0, h: 0, left: 1 });
    // 5 helicopters against 3 tanks: 4 take out 2, the last one can't beat a tank.
    expect(clash(3, 0, HELI, 5)).toEqual({ t: 1, h: 0, left: 0 });
  });

  it("fights like with like first", () => {
    // Tanks meet the tanks, then the helicopters.
    expect(clash(2, 4, TANK, 5)).toEqual({ t: 0, h: 0, left: 1 });
    // Helicopters meet the helicopters, then the tanks.
    expect(clash(2, 4, HELI, 7)).toEqual({ t: 1, h: 0, left: 0 });
  });

  it("leaves an even fight with the defender", () => {
    expect(clash(5, 0, TANK, 5)).toEqual({ t: 0, h: 0, left: 0 });
    // 3 tanks against 5 helicopters is 6 against 5, but half a tank doesn't count.
    expect(clash(0, 5, TANK, 3)).toEqual({ t: 0, h: 0, left: 0 });
  });
});

describe("battle", () => {
  it("builds units in held bases up to the cap, and none in neutral ones", () => {
    const b = lineBattle([0, 3, 0, 0]);
    const perUnit = Math.ceil(1000 / BUILD_RATE[1]);
    steps(b, perUnit);
    expect(b.bases[0].t).toBe(1);
    expect(b.bases[1].t).toBe(3);
    b.bases[0].t = CAP[1] - 1;
    steps(b, perUnit * 3);
    expect(b.bases[0].t).toBe(CAP[1]);
  });

  it("wastes away units over the cap, a twentieth of the excess a second", () => {
    const b = lineBattle([0, 0, 0, 0]);
    b.bases[0].t = CAP[1] + 40;
    b.bases[0].h = 2;
    steps(b, 9);
    expect(b.bases[0].t).toBe(CAP[1] + 40);
    b.step();
    expect(b.bases[0]).toMatchObject({ t: CAP[1] + 37, h: 2 });
    steps(b, 600);
    expect(b.bases[0].t + b.bases[0].h).toBe(CAP[1]);
  });

  it("waits out the countdown", () => {
    const map = lineBattle().map;
    const b = new Battle(map, { slots: [0, 1], countdown: 30, limit: 0 });
    expect(b.check(["s", 0, [0], 1, 50])).toBe("Wait for GO");
    steps(b, 30);
    expect(b.check(["s", 0, [0], 1, 50])).toBeNull();
    expect(b.bases[0].t).toBe(10);
  });

  it("drives tanks along the road and takes a neutral base", () => {
    const b = lineBattle([10, 3, 0, 10]);
    expect(b.apply(["s", 0, [0], 1, 50])).toBe(true);
    expect(b.bases[0].t).toBe(5);
    const [g] = b.groups;
    expect(g).toMatchObject({ owner: 0, kind: TANK, n: 5, path: [0, 1], at: [0, 20] });
    steps(b, 19);
    expect(b.bases[1].owner).toBe(-1);
    const events = b.step();
    expect(events).toEqual([{ e: "take", b: 1, by: 0, from: -1 }]);
    expect(b.bases[1]).toMatchObject({ owner: 0, t: 2 });
    expect(b.groups).toEqual([]);
  });

  it("routes convoys through the player's own bases, and not through anyone else's", () => {
    const b = lineBattle([10, 0, 0, 10]);
    expect(b.route(0, 0, 2)).toBeNull();
    b.bases[1].owner = 0;
    expect(b.route(0, 0, 2)).toEqual({ path: [0, 1, 2], ticks: [0, 20, 40] });
    expect(b.route(0, 0, 3)?.path).toBeUndefined();
    b.bases[2].owner = 0;
    expect(b.route(0, 0, 3)?.path).toEqual([0, 1, 2, 3]);
  });

  it("stops a convoy at a base on its route that changed hands, and fights there", () => {
    const b = lineBattle([10, 0, 0, 10]);
    b.bases[1].owner = 0;
    b.bases[2].owner = 0;
    b.apply(["s", 0, [0], 3, 100]);
    steps(b, 25);
    expect(b.groups[0].leg).toBe(2);
    // Player 1 takes base 2 before the convoy gets there.
    b.bases[2] = { owner: 1, level: 1, t: 4, h: 0, prog: 0 };
    steps(b, 15);
    expect(b.groups).toEqual([]);
    expect(b.bases[2]).toMatchObject({ owner: 0, t: 6 });
    expect(b.bases[3].owner).toBe(1);
  });

  it("flies helicopters straight to any base, faster", () => {
    const b = lineBattle([0, 0, 0, 5]);
    b.bases[0].h = 8;
    expect(b.check(["s", 0, [0], 3, 100])).toBeNull();
    b.apply(["s", 0, [0], 3, 100]);
    expect(b.groups[0]).toMatchObject({ kind: HELI, n: 8, path: [0, 3], at: [0, 35] });
    steps(b, 35);
    // The base built a sixth tank on the way; 8 helicopters only take out 4.
    expect(b.bases[3]).toMatchObject({ owner: 1, t: 2 });
  });

  it("says why tanks can't go somewhere", () => {
    const b = lineBattle([10, 0, 0, 10]);
    expect(b.check(["s", 0, [0], 3, 50])).toMatch(/Only helicopters/);
    expect(b.check(["s", 0, [3], 2, 50])).toMatch(/your bases/);
    expect(b.check(["s", 0, [1], 2, 50])).toMatch(/your bases/);
    b.bases[0].t = 0;
    expect(b.check(["s", 0, [0], 1, 50])).toMatch(/No units/);
  });

  it("sends tanks by road and helicopters by air from the same base", () => {
    const b = lineBattle([10, 0, 0, 10]);
    b.bases[0].h = 4;
    b.apply(["s", 0, [0], 1, 50]);
    expect(b.groups.map((g) => [g.kind, g.n, g.at[1]])).toEqual([
      [TANK, 5, 20],
      [HELI, 2, 12],
    ]);
    // Out of road range, only the helicopters go.
    b.apply(["s", 0, [0], 3, 100]);
    expect(b.groups.slice(2).map((g) => [g.kind, g.n])).toEqual([[HELI, 2]]);
    expect(b.bases[0]).toMatchObject({ t: 5, h: 0 });
  });

  it("sends from several bases at once, rounding sends up", () => {
    const b = lineBattle([3, 1, 0, 10]);
    b.bases[1].owner = 0;
    b.apply(["s", 0, [0, 1, 1], 2, 25]);
    expect(b.groups.map((g) => [g.path[0], g.n])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("joins units arriving at a friendly base to its garrison", () => {
    const b = lineBattle([10, 0, 0, 10]);
    b.bases[1].owner = 0;
    b.apply(["s", 0, [0], 1, 100]);
    steps(b, 20);
    // The 10 that arrived, and one the base built while they drove.
    expect(b.bases[1].t).toBe(11);
  });

  it("upgrades a base with its own units", () => {
    const b = lineBattle([20, 0, 0, 10]);
    b.bases[0].h = 3;
    expect(b.check(["u", 0, 0])).toBeNull();
    b.apply(["u", 0, 0]);
    expect(b.bases[0]).toMatchObject({ level: 2, t: 20 - UPGRADE_COST[2], h: 3 });
    expect(b.check(["u", 0, 0])).toMatch(/needs 30 units/);
    b.bases[0].t = 40;
    b.apply(["u", 0, 0]);
    expect(b.check(["u", 0, 0])).toMatch(/already level 3/);
    expect(b.check(["u", 0, 3])).toMatch(/isn't your base/);
  });

  it("knocks out a player with no bases and nothing moving, and ends with one left", () => {
    const b = lineBattle([30, 0, 0, 2]);
    b.bases[1].owner = 0;
    b.bases[2].owner = 0;
    b.apply(["s", 0, [0], 3, 100]);
    let out: unknown[] = [];
    for (let i = 0; i < 80 && !b.over; i++) out = out.concat(b.step().filter((e) => e.e === "out"));
    expect(out).toEqual([{ e: "out", slot: 1 }]);
    expect(b.over).toBe(true);
    expect(b.ranking()).toEqual([0, 1]);
  });

  it("keeps a player in while their units are on the move", () => {
    const b = lineBattle([10, 0, 0, 5]);
    b.apply(["s", 1, [3], 2, 100]);
    b.bases[3] = { owner: 0, level: 1, t: 1, h: 0, prog: 0 };
    b.step();
    expect(b.alive(1)).toBe(true);
    steps(b, 20);
    expect(b.bases[2].owner).toBe(1);
    expect(b.alive(1)).toBe(true);
  });

  it("ends on the clock", () => {
    const map = lineBattle().map;
    const b = new Battle(map, { slots: [0, 1], countdown: 5, limit: 20 });
    steps(b, 24);
    expect(b.over).toBe(false);
    b.step();
    expect(b.over).toBe(true);
  });

  it("makes a leaving player's bases neutral and recalls their units", () => {
    const map = tinyMap(
      [
        [50, 50],
        [160, 50],
        [270, 50],
      ],
      [
        [0, 1],
        [1, 2],
      ],
      { starts: [0, 1, 2], garrison: [10, 10, 10] },
    );
    const b = new Battle(map, { slots: [0, 1, 2], countdown: 0, limit: 0 });
    b.apply(["s", 1, [1], 2, 50]);
    b.leave(1);
    expect(b.bases[1]).toMatchObject({ owner: -1, t: 5 });
    expect(b.groups).toEqual([]);
    expect(b.alive(1)).toBe(false);
    expect(b.over).toBe(false);
    b.leave(2);
    expect(b.over).toBe(true);
  });
});

describe("sync", () => {
  it("round-trips a snapshot", () => {
    const b = lineBattle([10, 0, 0, 10]);
    b.bases[0].h = 3;
    b.apply(["s", 0, [0], 1, 50]);
    steps(b, 7);
    const copy = Battle.fromSnapshot(JSON.parse(JSON.stringify(b.snapshot())));
    expect(copy.checksum()).toBe(b.checksum());
    steps(b, 30);
    steps(copy, 30);
    expect(copy.snapshot()).toEqual(b.snapshot());
  });

  it("keeps a client that replays the frames in step with the server", () => {
    const map = generateMap(99, 4, "medium");
    const server = new Battle(map, { slots: [0, 1, 2, 3], countdown: 10, limit: 0 });
    const client = Battle.fromSnapshot(JSON.parse(JSON.stringify(server.snapshot())));
    const rng = mulberry32(5);
    for (let i = 0; i < 1500; i++) {
      const applied: Cmd[] = [];
      for (let k = 0; k < 3; k++) {
        const slot = Math.floor(rng() * 4);
        const mine = server.bases.map((x, j) => (x.owner === slot ? j : -1)).filter((j) => j >= 0);
        if (!mine.length) continue;
        const cmd: Cmd =
          rng() < 0.1
            ? ["u", slot, mine[0]]
            : ["s", slot, [mine[Math.floor(rng() * mine.length)]], Math.floor(rng() * map.x.length), ([25, 50, 100] as const)[k]];
        if (server.apply(cmd)) applied.push(cmd);
      }
      server.step();
      const f: Frame = { t: "f", n: server.n, c: applied };
      expect(applyFrame(client, JSON.parse(JSON.stringify(f)))).not.toBeNull();
      if (i % 100 === 0) expect(client.checksum()).toBe(server.checksum());
    }
    expect(client.snapshot()).toEqual(server.snapshot());
  });

  it("refuses a frame that doesn't follow on", () => {
    const b = lineBattle();
    expect(applyFrame(b, { t: "f", n: 3 })).toBeNull();
    expect(applyFrame(b, { t: "f", n: 1 })).toEqual([]);
  });
});
