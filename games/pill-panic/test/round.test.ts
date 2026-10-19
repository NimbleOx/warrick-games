import { describe, expect, it } from "vitest";
import { newBrain, think, type Brain, type CpuLevel } from "../src/shared/ai";
import { BLUE, Bottle, RED, type Garbage } from "../src/shared/bottle";
import type { DropEntry, Frame, KeyEntry, LaneSnap } from "../src/shared/protocol";
import { mulberry32 } from "@warrick/kit/shared/rng";
import { MAX_LEAD_TICKS } from "../src/shared/constants";
import { Mirror, Round, type Seat } from "../src/shared/round";

function makeRound(seats: (CpuLevel | null)[], opts: { level?: number; aim?: "leader" | "random" | "all" } = {}) {
  const s: Seat[] = seats.map((cpu, slot) => ({ slot, cpu }));
  return new Round({ seed: 4242, level: opts.level ?? 2, speed: "hi", aim: opts.aim ?? "leader", seats: s }, mulberry32(9));
}

/** A player's browser: runs its own bottle ahead of the server and reports its inputs. */
class Browser {
  b!: Bottle;
  e = 0;
  mask = 0;
  keys: KeyEntry[] = [];
  drops: DropEntry[] = [];
  taken = new Set<number>();
  fixes = 0;

  constructor(
    readonly slot: number,
    lane: LaneSnap,
    private brain: Brain,
  ) {
    this.adopt(lane);
  }

  adopt(lane: LaneSnap): void {
    this.b = Bottle.restore(lane.b);
    this.e = lane.e;
    this.mask = this.b.prevMask;
    this.keys = [];
    this.drops = [];
    this.taken.clear();
    for (const g of lane.due) this.take(g);
  }

  take(g: Garbage): void {
    if (this.taken.has(g.id)) return;
    this.taken.add(g.id);
    this.b.addGarbage(g);
    this.drops.push([this.b.tick, g.id]);
  }

  play(to: number): void {
    while (this.b.tick < to) {
      const m = think(this.b, this.brain);
      if (m !== this.mask) {
        this.mask = m;
        this.keys.push([this.b.tick, m]);
      }
      this.b.step(m);
      this.b.events = [];
    }
  }

  send(round: Round, wall: number): void {
    round.feed(this.slot, this.e, this.b.tick, this.keys, this.drops, wall);
    this.keys = [];
    this.drops = [];
  }

  receive(f: Frame): void {
    for (const fx of f.fx ?? []) {
      if (fx.s === this.slot && fx.e !== this.e) {
        this.fixes++;
        this.adopt(fx);
      }
    }
    for (const a of f.a ?? []) if (a.to === this.slot) this.take({ id: a.id, p: a.p });
  }
}

/** Everyone else's view: mirrors of every bottle, fed by the frames. */
class Watcher {
  mirrors = new Map<number, Mirror>();
  garbage = new Map<number, Garbage>();

  constructor(lanes: LaneSnap[]) {
    for (const l of lanes) this.mirrors.set(l.s, new Mirror(l));
  }

  receive(f: Frame): void {
    for (const a of f.a ?? []) this.garbage.set(a.id, { id: a.id, p: a.p });
    for (const seg of f.s) expect(this.mirrors.get(seg.s)!.push(seg)).toBe(true);
    for (const m of this.mirrors.values()) expect(m.advance(Infinity, (id) => this.garbage.get(id))).toBe(true);
  }
}

describe("a round", () => {
  it("plays CPUs to an outcome, and a watcher's mirrors replay every bottle exactly", () => {
    const round = makeRound(["hard", "normal", "easy"], { level: 3 });
    const watcher = new Watcher(round.snapshot(1).lanes);
    let wall = 0;
    for (let i = 0; i < 6000 && !round.outcome; i++) {
      wall += 3;
      round.step(wall, () => true);
      const f = round.collect();
      if (f) watcher.receive(f);
    }
    const f = round.collect();
    if (f) watcher.receive(f);
    expect(round.outcome).not.toBeNull();
    for (const [slot, m] of watcher.mirrors) expect(m.bottle.snapshot()).toEqual(round.bottle(slot)!.snapshot());
  });

  it("replays a player's own inputs, attacks included, to the same bottle", () => {
    const round = makeRound([null, "hard", null], { level: 2, aim: "all" });
    const snap = round.snapshot(1);
    const ann = new Browser(0, snap.lanes[0], newBrain("hard", 1));
    const bob = new Browser(2, snap.lanes[2], newBrain("normal", 2));
    const watcher = new Watcher(snap.lanes);
    let wall = 0;
    let attacks = 0;
    for (let i = 0; i < 20000 && !round.outcome; i++) {
      wall += 3;
      for (const p of [ann, bob]) {
        p.play(wall);
        p.send(round, wall);
      }
      round.step(wall, () => true);
      const f = round.collect();
      if (!f) continue;
      attacks += f.a?.length ?? 0;
      ann.receive(f);
      bob.receive(f);
      watcher.receive(f);
    }
    expect(round.outcome).not.toBeNull();
    expect(attacks).toBeGreaterThan(0);
    expect(ann.fixes + bob.fixes).toBe(0);
    for (const p of [ann, bob]) {
      const server = round.bottle(p.slot)!;
      if (!server.done) {
        expect(server.tick).toBe(p.b.tick);
        expect(server.checksum()).toBe(p.b.checksum());
      }
    }
  });

  it("takes over a browser that stops sending, which picks up again from the fix", () => {
    const round = makeRound([null, "hard"], { level: 12 });
    const ann = new Browser(0, round.snapshot(1).lanes[0], newBrain("normal", 3));
    let wall = 0;
    // A background tab: it hears the server but stops playing, until a fix wakes it up.
    let asleep = false;
    for (let i = 0; i < 400 && !round.outcome; i++) {
      wall += 3;
      if (i === 100) asleep = true;
      if (!asleep) {
        ann.play(wall);
        ann.send(round, wall);
      }
      round.step(wall, () => true);
      const f = round.collect();
      if (!f) continue;
      const before = ann.fixes;
      ann.receive(f);
      if (ann.fixes > before) {
        asleep = false;
        expect(round.bottle(0)!.tick).toBeLessThan(wall);
      }
    }
    expect(ann.fixes).toBe(1);
    const server = round.bottle(0)!;
    if (!round.outcome) expect(server.checksum()).toBe(ann.b.checksum());
  });

  it("keeps a disconnected player's bottle going, and starts them over from it when they're back", () => {
    const round = makeRound([null, "hard"], { level: 12 });
    const ann = new Browser(0, round.snapshot(1).lanes[0], newBrain("normal", 3));
    let wall = 0;
    let online = true;
    const loop = (n: number) => {
      for (let i = 0; i < n && !round.outcome; i++) {
        wall += 3;
        if (online) {
          ann.play(wall);
          ann.send(round, wall);
        }
        round.step(wall, () => online);
        const f = round.collect();
        if (f && online) ann.receive(f);
      }
    };
    loop(100);
    const epoch = ann.e;
    online = false;
    loop(100);
    // The server kept it moving, a few ticks behind the clock.
    expect(round.bottle(0)!.tick).toBeGreaterThan(wall - 20);
    online = true;
    round.rejoin(0);
    ann.adopt(round.snapshot(1).lanes[0]);
    // Once when the server took over, once when they came back.
    expect(ann.e).toBe(epoch + 2);
    loop(200);
    expect(ann.fixes).toBe(0);
    const server = round.bottle(0)!;
    if (!round.outcome) expect(server.checksum()).toBe(ann.b.checksum());
  });

  it("drops an attack in for a browser that never takes it", () => {
    const round = makeRound([null, "easy"], { level: 10 });
    const ann = new Browser(0, round.snapshot(1).lanes[0], newBrain("normal", 3));
    let wall = 0;
    let injected = false;
    const start = ann.e;
    (round as unknown as { attack(from: unknown, colors: number[]): void }).attack(round.lanes[1], [RED, BLUE]);
    for (let i = 0; i < 100; i++) {
      wall += 3;
      ann.play(wall);
      ann.drops = []; // ignore the attack
      ann.send(round, wall);
      round.step(wall, () => true);
      const f = round.collect();
      if (f?.s.some((s) => s.s === 0 && s.g.length)) injected = true;
      if (f) for (const fx of f.fx ?? []) if (fx.s === 0) ann.adopt(fx);
    }
    expect(injected).toBe(true);
    // The browser was overruled once, and picked up the server's copy.
    expect(ann.e).toBe(start + 1);
    expect(round.bottle(0)!.pending.length + round.bottle(0)!.count).toBeGreaterThan(0);
  });

  it("lands attacks a browser claims to take at the end of time", () => {
    // The browser takes each attack on a tick it hasn't reached, or (when it has one to take)
    // claims to have reached that far tick too.
    for (const claim of ["drop", "both"] as const) {
      const round = makeRound([null, "hard"], { level: 10 });
      const ann = new Browser(0, round.snapshot(1).lanes[0], newBrain("normal", 3));
      const sentAt = new Map<number, number>();
      const landed = new Set<number>();
      const far = Number.MAX_SAFE_INTEGER;
      let wall = 0;
      for (let i = 0; i < 300; i++) {
        if (i % 40 === 0 && i < 240)
          (round as unknown as { attack(from: unknown, colors: number[]): void }).attack(round.lanes[1], [RED, BLUE]);
        wall += 3;
        ann.play(wall);
        ann.drops = ann.drops.map(([, id]) => [far, id]);
        const n = claim === "both" && ann.drops.length ? far : ann.b.tick;
        round.feed(ann.slot, ann.e, n, ann.keys, ann.drops, wall);
        ann.keys = [];
        ann.drops = [];
        round.step(wall, () => true);
        const f = round.collect();
        if (!f) continue;
        for (const a of f.a ?? []) if (a.to === 0) sentAt.set(a.id, wall);
        for (const seg of f.s) if (seg.s === 0) for (const [, id] of seg.g) landed.add(id);
        ann.receive(f);
      }
      // Every attack landed on the server's copy of the bottle, two seconds after it was sent at most.
      for (const id of sentAt.keys()) expect(landed.has(id), `attack ${id} (${claim})`).toBe(true);
      expect(sentAt.size).toBeGreaterThanOrEqual(6);
      expect(round.outcome).toBeNull();
    }
  });

  it("waits for a browser a little ahead of the clock, and takes over one far ahead", () => {
    const round = makeRound([null, "hard"], { level: 10 });
    const ann = new Browser(0, round.snapshot(1).lanes[0], newBrain("normal", 3));
    const queued = () => round.lanes[0]!.lane.keys.length;
    let wall = 60;
    ann.play(wall);
    ann.send(round, wall);
    round.step(wall, () => true);
    round.collect();
    // A second and a half ahead: replayed up to a second past the clock, the rest kept for later.
    ann.play(wall + 90);
    ann.send(round, wall);
    expect(round.bottle(0)!.tick).toBe(wall + MAX_LEAD_TICKS);
    expect(round.collect()!.fx).toBeUndefined();
    // Ten seconds ahead (a modified browser, say) can't be replayed: the server takes over.
    const epoch = ann.e;
    ann.play(wall + 600);
    ann.send(round, wall);
    expect(queued()).toBe(0);
    expect(round.bottle(0)!.tick).toBe(wall + MAX_LEAD_TICKS);
    ann.receive(round.collect()!);
    expect(ann.e).toBe(epoch + 1);
    expect(ann.b.checksum()).toBe(round.bottle(0)!.checksum());

    // Every input on its own tick, or one tick could hold any number of them.
    wall += 120;
    round.step(wall, () => true);
    ann.play(wall);
    ann.send(round, wall);
    ann.receive(round.collect()!);
    expect(ann.e).toBe(epoch + 1);
    const t = ann.b.tick;
    const flood = Array.from({ length: 600 }, () => [t, 1]);
    round.feed(0, ann.e, t, flood, [], wall);
    expect(queued()).toBe(0);
    ann.receive(round.collect()!);
    expect(ann.e).toBe(epoch + 2);
  });

  it("aims attacks at whoever has the fewest viruses left", () => {
    const round = makeRound([null, null, null, null], { aim: "leader" });
    round.bottle(0)!.viruses = 9;
    round.bottle(1)!.viruses = 3;
    round.bottle(2)!.viruses = 7;
    round.bottle(3)!.viruses = 1;
    (round as unknown as { attack(from: unknown, colors: number[]): void }).attack(round.lanes[3], [RED, BLUE, RED]);
    const f = round.collect()!;
    expect(f.a).toHaveLength(1);
    expect(f.a![0]).toMatchObject({ from: 3, to: 1 });
    expect(f.a![0].p.map(([x]) => x)).toSatisfy((xs: number[]) => xs[1] - xs[0] === 3 && xs[2] - xs[1] === 3);
  });

  it("waits for every bottle to reach a tick before deciding by it", () => {
    const round = makeRound([null, null]);
    round.quit(0);
    round.step(0, () => true);
    // Bob's bottle hasn't been replayed past the tick Ann left on yet.
    expect(round.outcome).toBeNull();
    round.feed(1, round.snapshot(1).lanes[1].e, 5, [], [], 5);
    round.step(5, () => true);
    expect(round.outcome).toMatchObject({ winners: [1], how: "survived" });
  });
});
