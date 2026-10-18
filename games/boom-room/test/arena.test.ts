import { describe, expect, it } from "vitest";
import { Match } from "../src/shared/ai";
import { Arena, applyDelta, type ArenaOpts, type ArenaSnap } from "../src/shared/arena";
import { BUDGET_BANK_SECS, BUDGET_BANK_TILES, COUNTDOWN_MS, FLAME_MS, FUSE_MS, TICK_MS } from "../src/shared/constants";
import { moveActor, type Dir } from "../src/shared/movement";
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

function burn(a: Arena, x: number, y: number, owner: string): void {
  a.flames.set(a.idx(x, y), { mask: 0, born: a.time, until: a.time + FLAME_MS, owner });
}

/**
 * A browser walking `route` (tile centers, round and round) at `pace` times its bomber's speed,
 * 60 frames a second, and reporting where it is the way the client does. Each report reaches the
 * server `delay()` ms after it's sent, in order, like a socket; the server ticks in between. A
 * snap-back reaches the browser at once, the kindest case for a cheat. Returns how many reports
 * the server turned down, and how far it let the bomber go.
 */
function walk(a: Arena, id: string, ms: number, route: [number, number][], pace = 1, delay = () => 0) {
  const p = a.player(id)!;
  const me = { x: p.x, y: p.y };
  let leg = 0;
  let fix = p.fix;
  const sent = { x: me.x, y: me.y, d: 0 as Dir, at: -Infinity };
  const wire: { at: number; x: number; y: number; d: Dir }[] = [];
  let arrives = -Infinity;
  let rejected = 0;
  let travelled = 0;
  const frameMs = 1000 / 60;
  const end = a.time + ms;
  for (let now = a.time; now < end; now += frameMs) {
    // The server: the reports and ticks due by now, in order.
    for (;;) {
      const msg = wire[0];
      const tickAt = a.time + TICK_MS;
      if (msg && msg.at <= now && msg.at <= tickAt) {
        wire.shift();
        const was = { x: p.x, y: p.y };
        if (a.clientMove(id, msg.x, msg.y, msg.d)) travelled += Math.abs(p.x - was.x) + Math.abs(p.y - was.y);
        else rejected++;
      } else if (tickAt <= now) {
        a.step(TICK_MS);
      } else {
        break;
      }
    }
    if (p.fix !== fix) {
      fix = p.fix;
      me.x = p.x;
      me.y = p.y;
    }
    // The browser: one animation frame along the route.
    let dist = (a.speedOf(p) * pace * frameMs) / 1000;
    let dir: Dir = 0;
    while (dist > 1e-9) {
      const [tx, ty] = route[leg];
      if (me.x === tx && me.y === ty) {
        leg = (leg + 1) % route.length;
        continue;
      }
      dir = me.x !== tx ? (tx > me.x ? 2 : 4) : ty > me.y ? 3 : 1;
      const left = me.x !== tx ? Math.abs(tx - me.x) : Math.abs(ty - me.y);
      const moved = moveActor(me, dir, Math.min(dist, left), a.blockedFor(me));
      if (moved <= 0) break;
      dist -= moved;
    }
    const moved = me.x !== sent.x || me.y !== sent.y;
    if ((moved && now - sent.at >= 33) || dir !== sent.d) {
      arrives = Math.max(arrives, now + delay());
      wire.push({ at: arrives, x: Math.round(me.x * 1000) / 1000, y: Math.round(me.y * 1000) / 1000, d: dir });
      Object.assign(sent, { x: me.x, y: me.y, d: dir, at: now });
    }
  }
  return { rejected, travelled };
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

  it("can't hop over fire", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    p.budget = 3;
    burn(a, 2, 1, "b");
    const fix = p.fix;
    expect(a.clientMove("a", 3, 1, 2)).toBe(false);
    // It ends where it would have if every step had been seen: in the fire.
    expect(p).toMatchObject({ alive: false, killedBy: "b", x: 2, y: 1, fix: fix + 1 });
    expect(a.events).toContainEqual({ e: "die", id: "a", by: "b", c: a.idx(2, 1) });
    expect(a.player("b")!.kills).toBe(1);
  });

  it("burn whoever walks into fire, even if they'd walk out before the tick", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    burn(a, 2, 1, "b");
    expect(a.clientMove("a", 1.6, 1, 2)).toBe(false);
    expect(p).toMatchObject({ alive: false, x: 2, y: 1 });
  });

  it("accept a way round the fire when there is one", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    p.budget = 5;
    burn(a, 2, 1, "b");
    // (1,1) to (3,3) can go down and round, through (1,3).
    expect(a.clientMove("a", 3, 3, 2)).toBe(true);
    expect(p).toMatchObject({ alive: true, x: 3, y: 3 });
  });

  it("don't let standing still bank a dash", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    run(a, 10_000);
    const bank = a.speedOf(p) * BUDGET_BANK_SECS + BUDGET_BANK_TILES;
    expect(p.budget).toBeCloseTo(bank);
    expect(bank).toBeLessThan(2);
    expect(a.clientMove("a", 3, 1, 2)).toBe(false);
    expect(p).toMatchObject({ x: 1, y: 1 });
    expect(a.clientMove("a", 2.5, 1, 2)).toBe(true);
  });

  it("don't let a bomber outrun its speed for long", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const speed = a.speedOf(a.player("a")!);
    const bank = speed * BUDGET_BANK_SECS + BUDGET_BANK_TILES;
    const row: [number, number][] = [
      [13, 1],
      [1, 1],
    ];
    const { rejected, travelled } = walk(a, "a", 10_000, row, 1.29);
    expect(rejected).toBeGreaterThan(0);
    expect(travelled).toBeLessThanOrEqual(speed * 10 + bank + 0.1);
  });

  it("don't let rounding slack add up over many small reports", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const p = a.player("a")!;
    p.budget = 0;
    for (let i = 1; i <= 40; i++) a.clientMove("a", 1 + i * 0.07, 1, 2);
    expect(p.x - 1).toBeLessThanOrEqual(0.08);
  });

  it("keep up with an honest browser on a slow, jittery link", () => {
    const a = arena();
    place(a, "a", 1, 1);
    const rng = mulberry32(7);
    // 75 ms on the way, give or take 60, and now and then a 350 ms hold-up.
    const delay = () => 75 + rng() * 60 + (rng() < 0.03 ? 350 : 0);
    // Round the pillar at (2,2) and along the top row: turns, corners and straights.
    const loop: [number, number][] = [
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
      [9, 1],
      [1, 1],
    ];
    const { rejected, travelled } = walk(a, "a", 30_000, loop, 1, delay);
    expect(rejected).toBe(0);
    expect(travelled).toBeGreaterThan(a.speedOf(a.player("a")!) * 29);
  });
});

describe("frames", () => {
  it("deltas rebuild every tick, for clients there all along and ones that join between ticks", () => {
    let fullBytes = 0;
    let deltaBytes = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const rng = mulberry32(seed);
      const ids = ["a", "b", "c", "d", "h"];
      const a = new Arena(rng, ids, { ...OPEN, cols: 17, crates: 0.72, items: 0.4, skulls: true, hurryMs: 20_000 });
      const m = new Match(
        a,
        ids.slice(0, 4).map((id) => ({ id, level: "hard" as const })),
        rng,
      );
      // What a browser does with a frame: it comes as JSON.
      const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
      let early: ArenaSnap = wire(a.frame(false).full);
      let late: ArenaSnap | null = null;
      for (let n = 0; n < 6000 && !a.result; n++) {
        m.step(TICK_MS);
        const h = a.player("h")!;
        // A human moving and bombing between ticks, the way reports arrive.
        if (h.alive) a.clientMove("h", h.x + (n % 40 < 20 ? 0.1 : -0.1), h.y, 2);
        if (n % 50 === 0) a.placeBomb("h");
        if (n === 400) late = wire(a.catchUp());
        const { full, delta } = a.frame(true);
        early = applyDelta(early, wire(delta));
        expect(early).toEqual(full);
        if (late) {
          late = applyDelta(late, wire(delta));
          expect(late).toEqual(full);
        }
        fullBytes += JSON.stringify(full).length;
        deltaBytes += JSON.stringify(delta).length;
      }
      expect(a.result).not.toBeNull();
    }
    expect(deltaBytes).toBeLessThan(fullBytes / 3);
  });

  it("the delta after a catch-up fits it, even when what changed in between changes back", () => {
    const a = arena();
    place(a, "a", 1, 1);
    let early = a.frame(true).full;
    // Two reports in one tick: someone joins between them.
    a.clientMove("a", 1.2, 1, 2);
    const late = a.catchUp();
    a.clientMove("a", 1, 1, 4);
    a.step(TICK_MS);
    const { full, delta } = a.frame(true);
    early = applyDelta(early, delta);
    expect(early).toEqual(full);
    expect(applyDelta(late, delta)).toEqual(full);
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
      const m = new Match(
        a,
        ids.map((id, i) => ({ id, level: levels[i] })),
        rng,
      );
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
