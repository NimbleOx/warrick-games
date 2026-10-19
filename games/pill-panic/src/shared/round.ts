import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { newBrain, think, type Brain, type CpuLevel } from "./ai";
import { B_QUIT, Bottle, PLAYER_BUTTONS, virusLayout, type BottleEvent, type Garbage } from "./bottle";
import { COLS, GARBAGE_GRACE_TICKS, MAX_LAG_OFFLINE, MAX_LAG_TICKS, MAX_LEAD_TICKS, START_SPEED } from "./constants";
import type { Aim, Attack, DropEntry, Frame, KeyEntry, LaneSnap, RoundSnap, Segment, Speed } from "./protocol";
import { randInt, shuffle, type Rng } from "@warrick/kit/shared/rng";

export interface LaneHooks {
  key?(tick: number, mask: number): void;
  drop?(tick: number, id: number): void;
  events?(events: BottleEvent[], tick: number): void;
}

/**
 * A bottle plus the inputs queued for it. The server replays each player's inputs through one;
 * browsers replay everyone else's bottle the same way from the server's segments.
 */
export class Lane {
  keys: KeyEntry[] = [];
  drops: DropEntry[] = [];

  constructor(public bottle: Bottle) {}

  /** Step to tick `to`, applying queued inputs on their ticks. Attacks land before that tick's step. */
  advance(to: number, garbage: (id: number) => Garbage | undefined, hooks: LaneHooks = {}): void {
    const b = this.bottle;
    let mask = b.prevMask;
    while (b.tick < to) {
      while (this.keys.length && this.keys[0][0] <= b.tick) {
        mask = this.keys.shift()![1];
        hooks.key?.(b.tick, mask);
      }
      while (this.drops.length && this.drops[0][0] <= b.tick) {
        const id = this.drops.shift()![1];
        const g = garbage(id);
        if (g) b.addGarbage(g);
        hooks.drop?.(b.tick, id);
      }
      b.step(mask);
      if (b.events.length) {
        hooks.events?.(b.events, b.tick);
        b.events = [];
      }
    }
  }
}

/** A browser's copy of someone else's bottle, kept in step by the server's segments. */
export class Mirror {
  lane: Lane;
  /** The tick the server's segments reach. */
  known: number;
  private checks: [number, number][] = [];

  constructor(snap: LaneSnap) {
    this.lane = new Lane(Bottle.restore(snap.b));
    this.known = snap.b.tick;
  }

  get bottle(): Bottle {
    return this.lane.bottle;
  }

  /** Queue a segment. Returns false if segments went missing in between. */
  push(seg: Segment): boolean {
    if (seg.t <= this.known) return true;
    if (seg.f > this.known) return false;
    // A snapshot can land in the middle of a segment; its early inputs are already in the bottle.
    for (const k of seg.k) if (k[0] >= this.known) this.lane.keys.push(k);
    for (const g of seg.g) if (g[0] >= this.known) this.lane.drops.push(g);
    this.known = seg.t;
    this.checks.push([seg.t, seg.c]);
    return true;
  }

  /** Replay up to `to` (no further than the server has said). Returns false if the bottle drifted. */
  advance(to: number, garbage: (id: number) => Garbage | undefined, hooks?: LaneHooks): boolean {
    const b = this.lane.bottle;
    to = Math.min(to, this.known);
    while (b.tick < to) {
      while (this.checks.length && this.checks[0][0] < b.tick) this.checks.shift();
      const stop = this.checks.length ? Math.min(to, this.checks[0][0]) : to;
      this.lane.advance(stop, garbage, hooks);
      if (this.checks.length && this.checks[0][0] === b.tick) {
        const [, c] = this.checks.shift()!;
        if (b.checksum() !== c) return false;
      }
    }
    return true;
  }
}

// ------------------------------------------------------------------ the server's round

export interface Seat {
  slot: number;
  cpu: CpuLevel | null;
}

export interface RoundConfig {
  seed: number;
  level: number;
  speed: Speed;
  aim: Aim;
  seats: Seat[];
}

interface ServerLane {
  slot: number;
  lane: Lane;
  /** Bumped whenever the server overrules the browser. Inputs from an older epoch are ignored. */
  epoch: number;
  brain: Brain | null;
  /** What the bottle did since the last broadcast. */
  seg: Segment;
  /** Attacks sent to the player's browser, waiting for it to say which tick they arrived on. */
  due: { g: Garbage; by: number }[];
  /** The server is driving this bottle until the browser picks it up again. */
  held: boolean;
  /** Don't take over again before this tick: give the browser time to catch up after a fix. */
  graceUntil: number;
  /** Send the owner a fix with the next broadcast. */
  fix: boolean;
  /** The tick the bottle cleared its viruses or topped out. */
  doneAt: number | null;
  sent: number;
}

export interface Outcome {
  /** Slots. Empty for a draw. */
  winners: number[];
  how: "cleared" | "survived" | "draw";
}

/**
 * One round on the server. CPU bottles step with the clock; players' bottles step as their
 * inputs arrive, which the browser sends tagged with ticks. Every bottle's history goes out as
 * segments, so each browser can replay everyone else's. Attacks are aimed here, and the round
 * is decided here, in tick order, once every bottle still playing has reached that tick.
 */
export class Round {
  readonly lanes: (ServerLane | null)[] = Array(MAX_PLAYERS).fill(null);
  readonly garbage = new Map<number, Garbage>();
  outcome: Outcome | null = null;
  private attacks: Attack[] = [];
  private nextId = 1;
  /** The latest clock tick seen. */
  private wall = 0;

  constructor(
    readonly cfg: RoundConfig,
    private rng: Rng,
  ) {
    const cells = virusLayout(cfg.seed, cfg.level);
    for (const { slot, cpu } of cfg.seats) {
      const bottle = new Bottle(cfg.seed, START_SPEED[cfg.speed], cells.slice());
      this.lanes[slot] = {
        slot,
        lane: new Lane(bottle),
        // Random, so inputs still on their way from the last round can't pass for this one's.
        epoch: Math.floor(rng() * 1e9),
        brain: cpu ? newBrain(cpu, Math.floor(rng() * 0xffffffff)) : null,
        seg: { s: slot, f: 0, t: 0, k: [], g: [], c: 0 },
        due: [],
        held: false,
        graceUntil: 0,
        fix: false,
        doneAt: null,
        sent: 0,
      };
    }
  }

  get live(): ServerLane[] {
    return this.lanes.filter((l): l is ServerLane => !!l);
  }

  bottle(slot: number): Bottle | null {
    return this.lanes[slot]?.lane.bottle ?? null;
  }

  /** The furthest any bottle has got. */
  maxTick(): number {
    return Math.max(0, ...this.live.map((l) => l.lane.bottle.tick));
  }

  /** A player's inputs up to tick `n`, as their browser played them. */
  feed(slot: number, epoch: number, n: unknown, keys: unknown, drops: unknown, wall: number): void {
    const L = this.lanes[slot];
    this.wall = wall;
    if (!L || L.brain || this.outcome || L.doneAt !== null || epoch !== L.epoch) return;
    const b = L.lane.bottle;
    const k = parseEntries(keys);
    const g = parseEntries(drops);
    let ok = Number.isInteger(n) && (n as number) >= b.tick && !!k && !!g;
    // Every input falls between the last one we have and the tick the browser says it reached.
    let last = L.lane.keys.at(-1)?.[0] ?? b.tick;
    for (const [t] of k ?? []) {
      if (t < last || t > (n as number)) ok = false;
      last = t;
    }
    // And an attack lands no later than it's due, or a browser could put it off forever.
    last = L.lane.drops.at(-1)?.[0] ?? b.tick;
    const ids = new Set<number>();
    for (const [t, id] of g ?? []) {
      const due = L.due.find((d) => d.g.id === id);
      if (t < last || t > (n as number) || !due || t > due.by || ids.has(id)) ok = false;
      ids.add(id);
      last = t;
    }
    L.held = false;
    // Inputs we can't replay: start the browser over from our copy.
    if (!ok) return this.takeOver(L);
    for (const [t, mask] of k!) L.lane.keys.push([t, mask & PLAYER_BUTTONS]);
    for (const [t, id] of g!) {
      L.lane.drops.push([t, id]);
      L.due = L.due.filter((d) => d.g.id !== id);
    }
    this.run(L, Math.min(n as number, wall + MAX_LEAD_TICKS));
  }

  /**
   * Called on every loop: step CPU bottles to the clock, take over from browsers that fell too
   * far behind or haven't taken an attack, and decide the round if it can be.
   */
  step(wall: number, online: (slot: number) => boolean): void {
    this.wall = wall;
    if (this.outcome || wall < 0) return;
    for (const L of this.live) {
      if (L.doneAt !== null) continue;
      if (L.brain) {
        this.runCpu(L, wall);
        continue;
      }
      const b = L.lane.bottle;
      const lag = online(L.slot) ? MAX_LAG_TICKS : MAX_LAG_OFFLINE;
      const late = L.due.filter((d) => d.by <= wall);
      if (late.length) {
        this.takeOver(L);
        L.due = L.due.filter((d) => d.by > wall);
        for (const d of late) this.inject(L, d.g);
      }
      if (wall - b.tick > lag && wall >= L.graceUntil) {
        this.takeOver(L);
        // Let go of every button while the server holds the bottle.
        if (b.prevMask && !L.lane.keys.length) L.lane.keys.push([b.tick, 0]);
        this.run(L, wall - lag);
      }
    }
    this.decide();
  }

  /** A player left mid-round: their bottle tops out. */
  quit(slot: number): void {
    const L = this.lanes[slot];
    if (!L || L.doneAt !== null || this.outcome) return;
    this.takeOver(L);
    L.due = [];
    L.lane.keys = [[L.lane.bottle.tick, B_QUIT]];
    this.run(L, L.lane.bottle.tick + 1);
    this.decide();
  }

  /** A player's browser (re)connected: it starts over from the server's copy of their bottle. */
  rejoin(slot: number): void {
    const L = this.lanes[slot];
    if (!L || L.brain) return;
    L.held = false;
    this.takeOver(L);
    L.fix = false; // the welcome carries the bottle
    L.graceUntil = this.wall + MAX_LAG_TICKS;
  }

  /** The player's browser says its bottle drifted from ours. */
  resync(slot: number): void {
    const L = this.lanes[slot];
    if (!L || L.brain) return;
    L.held = false;
    this.takeOver(L);
  }

  /** Everything since the last call, for the broadcast. Null if nothing happened. */
  collect(): Frame | null {
    const s: Segment[] = [];
    const fx: LaneSnap[] = [];
    for (const L of this.live) {
      const b = L.lane.bottle;
      const seg = L.seg;
      if (b.tick > seg.f || seg.k.length || seg.g.length) {
        s.push({ ...seg, t: b.tick, c: b.checksum() });
        L.seg = { s: L.slot, f: b.tick, t: b.tick, k: [], g: [], c: 0 };
      }
      if (L.fix) {
        L.fix = false;
        fx.push(this.laneSnap(L));
      }
    }
    const a = this.attacks;
    this.attacks = [];
    if (!s.length && !fx.length && !a.length) return null;
    const frame: Frame = { t: "f", s };
    if (a.length) frame.a = a;
    if (fx.length) frame.fx = fx;
    return frame;
  }

  snapshot(round: number, goAt = 0, who: (string | null)[] = []): RoundSnap {
    return { round, goAt, who, lanes: this.live.map((L) => this.laneSnap(L)) };
  }

  stats(slot: number): { cleared: number; left: number; sent: number; bestChain: number; score: number; out: boolean } | null {
    const L = this.lanes[slot];
    if (!L) return null;
    const b = L.lane.bottle;
    return { cleared: b.cleared, left: b.viruses, sent: L.sent, bestChain: b.bestChain, score: b.score, out: b.phase === "dead" };
  }

  // ---------------------------------------------------------------- internals

  private laneSnap(L: ServerLane): LaneSnap {
    return { s: L.slot, e: L.epoch, b: L.lane.bottle.snapshot(), due: L.due.map((d) => d.g) };
  }

  private hooks(L: ServerLane): LaneHooks {
    return {
      key: (t, mask) => L.seg.k.push([t, mask]),
      drop: (t, id) => L.seg.g.push([t, id]),
      events: (events, tick) => this.onEvents(L, events, tick),
    };
  }

  private run(L: ServerLane, to: number): void {
    L.lane.advance(to, (id) => this.garbage.get(id), this.hooks(L));
  }

  private runCpu(L: ServerLane, to: number): void {
    const b = L.lane.bottle;
    while (b.tick < to && L.doneAt === null) {
      const mask = think(b, L.brain!);
      if (mask !== b.prevMask) L.seg.k.push([b.tick, mask]);
      b.step(mask);
      if (b.events.length) {
        this.onEvents(L, b.events, b.tick);
        b.events = [];
      }
    }
  }

  /** The server drives the bottle from here, until the browser picks it up from a fix. */
  private takeOver(L: ServerLane): void {
    if (L.held) return;
    L.held = true;
    L.epoch++;
    L.fix = true;
    L.graceUntil = this.wall + MAX_LAG_TICKS;
    // The browser starts over from our copy, holding what the bottle last held.
    L.lane.keys = [];
    // Attacks the browser took but we haven't replayed yet: it gets them again with the fix.
    for (const [, id] of L.lane.drops) {
      const g = this.garbage.get(id);
      if (g) L.due.push({ g, by: this.wall + GARBAGE_GRACE_TICKS });
    }
    L.lane.drops = [];
  }

  private inject(L: ServerLane, g: Garbage): void {
    L.lane.bottle.addGarbage(g);
    L.seg.g.push([L.lane.bottle.tick, g.id]);
  }

  private onEvents(L: ServerLane, events: BottleEvent[], tick: number): void {
    for (const ev of events) {
      if (ev.k === "attack") this.attack(L, ev.colors);
      else if (ev.k === "won" || ev.k === "dead") L.doneAt = tick;
    }
  }

  private attack(from: ServerLane, colors: number[]): void {
    for (const to of this.targets(from)) {
      const g: Garbage = { id: this.nextId++, p: this.pieces(colors) };
      this.garbage.set(g.id, g);
      this.attacks.push({ id: g.id, from: from.slot, to: to.slot, p: g.p });
      from.sent += g.p.length;
      if (to.brain) this.inject(to, g);
      else to.due.push({ g, by: this.wall + GARBAGE_GRACE_TICKS });
    }
  }

  private targets(from: ServerLane): ServerLane[] {
    const others = this.live.filter((L) => L !== from && L.doneAt === null);
    if (!others.length) return [];
    switch (this.cfg.aim) {
      case "all":
        return others;
      case "random":
        return [others[Math.floor(this.rng() * others.length)]];
      default: {
        // Whoever is closest to clearing their bottle.
        const fewest = Math.min(...others.map((L) => L.lane.bottle.viruses));
        const leaders = others.filter((L) => L.lane.bottle.viruses === fewest);
        return [leaders[Math.floor(this.rng() * leaders.length)]];
      }
    }
  }

  /** Spread an attack's halves evenly across the bottle, starting from a random column. */
  private pieces(colors: number[]): [number, number][] {
    const n = colors.length;
    const gap = n === 2 ? 4 : n === 3 ? 3 : 2;
    const first = randInt(this.rng, 0, COLS - 1 - gap * (n - 1));
    const mixed = shuffle(this.rng, [...colors]);
    return mixed.map((c, i) => [first + i * gap, c]);
  }

  /**
   * Settle what's certain. Bottles finish at different times in different browsers, so events
   * are taken in tick order, and only up to the tick every bottle still playing has reached.
   */
  private decide(): void {
    if (this.outcome) return;
    const lanes = this.live;
    const playing = lanes.filter((L) => L.doneAt === null);
    const horizon = playing.length ? Math.min(...playing.map((L) => L.lane.bottle.tick)) : Infinity;
    const done = lanes.filter((L) => L.doneAt !== null && L.doneAt <= horizon).sort((a, b) => a.doneAt! - b.doneAt!);
    const out = new Set<ServerLane>();
    for (let i = 0; i < done.length;) {
      const tick = done[i].doneAt!;
      const group: ServerLane[] = [];
      while (i < done.length && done[i].doneAt === tick) group.push(done[i++]);
      const won = group.filter((L) => L.lane.bottle.phase === "won");
      if (won.length) {
        this.outcome = { winners: won.map((L) => L.slot), how: "cleared" };
        return;
      }
      for (const L of group) out.add(L);
      const standing = lanes.filter((L) => !out.has(L));
      if (standing.length === 1) {
        this.outcome = { winners: [standing[0].slot], how: "survived" };
        return;
      }
      if (!standing.length) {
        this.outcome = { winners: [], how: "draw" };
        return;
      }
    }
  }
}

function parseEntries(raw: unknown): [number, number][] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 600) return null;
  const out: [number, number][] = [];
  for (const e of raw) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || !Number.isInteger(e[1]) || e[0] < 0 || e[1] < 0) return null;
    out.push([e[0], e[1]]);
  }
  return out;
}
