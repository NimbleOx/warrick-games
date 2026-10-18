import { describe, expect, it } from "vitest";
import { Match } from "../src/shared/ai";
import { Arena, type ArenaOpts } from "../src/shared/arena";
import { COUNTDOWN_MS, FLAME_MS, FUSE_MS, TICK_MS } from "../src/shared/constants";
import { moveActor } from "../src/shared/movement";
import { mulberry32 } from "@warrick/kit/shared/rng";

const OPEN: ArenaOpts = { cols: 15, rows: 13, crates: 0, items: 0, skulls: false, hurryMs: null, theme: 0 };

function arena(ids = ["a", "b"], opts: Partial<ArenaOpts> = {}, seed = 1): Arena {
  const a = new Arena(mulberry32(seed), ids, { ...OPEN, ...opts });
  run(a, COUNTDOWN_MS);
  return a;
}

function run(a: Arena, ms: number): void {
  for (let t = 0; t < ms; t += TICK_MS) a.step(TICK_MS);
}

function place(a: Arena, id: string, x: number, y: number): void {
  const p = a.player(id)!;
  p.x = x;
  p.y = y;
}

describe("movement", () => {
  const walls = (x: number, y: number) => x <= 0 || y <= 0 || x >= 14 || y >= 12 || (x % 2 === 0 && y % 2 === 0);

  it("walks along open rows and stops in the middle of the last open tile", () => {
    const m = { x: 1, y: 1 };
    moveActor(m, 2, 2.5, walls);
    expect(m).toEqual({ x: 3.5, y: 1 });
    moveActor(m, 4, 10, walls);
    expect(m).toEqual({ x: 1, y: 1 });
  });

  it("can't walk into a pillar", () => {
    const m = { x: 1, y: 1 };
    moveActor(m, 3, 1, walls); // (1,2) is open
    expect(m).toEqual({ x: 1, y: 2 });
    moveActor(m, 2, 1, walls); // (2,2) is a pillar
    expect(m).toEqual({ x: 1, y: 2 });
  });

  it("nudges you around corners when you turn a little late", () => {
    const m = { x: 3.3, y: 1 };
    moveActor(m, 3, 1, walls); // column 3 is open going down
    expect(m.x).toBe(3);
    expect(m.y).toBeCloseTo(1.7);
  });

  it("nudges into the next lane when the nearest one is blocked", () => {
    const m = { x: 1.6, y: 1 };
    moveActor(m, 3, 0.5, walls); // column 2 is a pillar below, so slide back toward column 1
    expect(m.x).toBeCloseTo(1.1);
    expect(m.y).toBe(1);
  });
});

describe("bombs", () => {
  it("explode in a cross that stops at walls and crates", () => {
    const a = arena();
    place(a, "a", 2, 1);
    place(a, "b", 13, 11);
    const crate = a.idx(3, 1);
    a.grid[crate] = 2;
    expect(a.placeBomb("a")).toBe(true);
    expect(a.placeBomb("a")).toBe(false); // only one bomb to start with
    place(a, "a", 1, 5);
    run(a, FUSE_MS);
    expect(a.bombs).toHaveLength(0);
    expect(a.isCrate(crate)).toBe(false);
    const burning = [...a.flames.keys()];
    expect(burning).toContain(a.idx(2, 1));
    expect(burning).toContain(a.idx(3, 1));
    expect(burning).toContain(a.idx(1, 1));
    expect(burning).not.toContain(a.idx(2, 2)); // pillar
    expect(burning).not.toContain(a.idx(4, 1)); // behind the crate
    run(a, FLAME_MS + 50);
    expect(a.flames.size).toBe(0);
  });

  it("set each other off", () => {
    const a = arena();
    a.player("a")!.bombs = 2;
    place(a, "a", 1, 1);
    a.placeBomb("a");
    run(a, 1000);
    place(a, "a", 3, 1);
    a.placeBomb("a");
    place(a, "a", 13, 1);
    run(a, FUSE_MS - 1000 + 50);
    // The first bomb's blast reached the second, so both are gone at once.
    expect(a.bombs).toHaveLength(0);
    expect(a.flames.has(a.idx(5, 1))).toBe(true);
  });

  it("kill whoever is standing in the blast, and credit the bomber", () => {
    const a = arena(["a", "b", "c"]);
    place(a, "a", 3, 1);
    place(a, "b", 5, 1);
    place(a, "c", 13, 11);
    a.placeBomb("a");
    place(a, "a", 1, 3);
    run(a, FUSE_MS + 50);
    expect(a.player("b")!.alive).toBe(false);
    expect(a.player("b")!.killedBy).toBe("a");
    expect(a.player("a")!.kills).toBe(1);
    expect(a.player("a")!.alive).toBe(true);
  });

  it("block whoever isn't already standing on them", () => {
    const a = arena();
    place(a, "a", 3, 1);
    place(a, "b", 5, 1);
    a.placeBomb("a");
    // a stands on its bomb and can walk off it, but b can't walk onto it.
    const pa = a.player("a")!;
    moveActor(pa, 2, 0.6, a.blockedFor(pa));
    expect(pa.x).toBeCloseTo(3.6);
    const pb = a.player("b")!;
    moveActor(pb, 4, 2, a.blockedFor(pb));
    expect(pb.x).toBe(4); // stops in the middle of the tile next to the bomb
  });
});

describe("client moves", () => {
  it("accept reachable positions and reject walking through walls", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    p.budget = 1;
    expect(a.clientMove("a", 1.5, 1, 2)).toBe(true);
    const fix = p.fix;
    expect(a.clientMove("a", 2, 2, 3)).toBe(false); // into a pillar
    expect(p.fix).toBe(fix + 1);
    expect(p).toMatchObject({ x: 1.5, y: 1 });
    p.budget = 0.2;
    expect(a.clientMove("a", 3, 1, 2)).toBe(false); // too far, too fast
  });
});

describe("power-ups", () => {
  it("come out of crates after the fire dies down", () => {
    const a = arena();
    place(a, "a", 3, 1);
    place(a, "b", 13, 11);
    const c = a.idx(4, 1);
    a.grid[c] = 2;
    a.hidden.set(c, "fire");
    a.placeBomb("a");
    place(a, "a", 1, 3);
    run(a, FUSE_MS + 50);
    expect(a.items.has(c)).toBe(false);
    run(a, FLAME_MS);
    expect(a.items.get(c)).toBe("fire");
    place(a, "a", 4, 1);
    run(a, 50);
    expect(a.player("a")!.fire).toBe(3);
    expect(a.items.has(c)).toBe(false);
  });
});

describe("rounds", () => {
  it("end with a winner when one bomber is left", () => {
    const a = arena();
    place(a, "a", 3, 1);
    place(a, "b", 4, 1);
    a.placeBomb("a");
    place(a, "a", 1, 3);
    run(a, FUSE_MS + 2000);
    expect(a.result).toEqual({ winner: "a" });
  });

  it("sudden death fills the arena; whoever it reaches last wins", () => {
    const a = arena(["a", "b"], { hurryMs: 1000 });
    const corner = a.players.find((p) => p.x === 1 && p.y === 1)!;
    run(a, 60_000);
    // The spiral starts top-left, so the bomber in that corner goes first.
    expect(a.result?.winner).not.toBe(corner.id);
    expect(a.result?.winner).toBeTruthy();
  });

  it("CPU bombers fight it out to a result", () => {
    let finished = 0;
    let suicides = 0;
    let deaths = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed);
      const ids = ["a", "b", "c", "d"];
      const a = new Arena(rng, ids, { ...OPEN, crates: 0.72, items: 0.4, skulls: true, hurryMs: 90_000 });
      const levels = ["hard", "normal", "hard", "normal"] as const;
      const m = new Match(a, ids.map((id, i) => ({ id, level: levels[i] })), rng);
      for (let t = 0; t < 200_000 && !a.result; t += TICK_MS) m.step(TICK_MS);
      if (a.result) finished++;
      for (const p of a.players) {
        if (!p.alive) deaths++;
        if (!p.alive && p.killedBy === p.id) suicides++;
      }
    }
    expect(finished).toBe(12);
    // They should mostly be blowing each other up (or getting crushed), not themselves.
    expect(suicides).toBeLessThan(deaths * 0.4);
  });
});
