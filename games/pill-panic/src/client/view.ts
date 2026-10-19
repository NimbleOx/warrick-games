import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { Bottle, type BottleEvent, type Garbage } from "../shared/bottle";
import { TICK_MS } from "../shared/constants";
import type { Attack, ClientMsg, DropEntry, Frame, KeyEntry, LaneSnap, RoundInfo, RoundSnap } from "../shared/protocol";
import { Mirror } from "../shared/round";

export interface ViewHooks {
  send(msg: ClientMsg): boolean;
  /** What a bottle just did, for sounds and effects. */
  events(slot: number, events: BottleEvent[]): void;
  attack(a: Attack): void;
}

/** The player's own bottle, run here without waiting for the server. */
interface Own {
  b: Bottle;
  /** The server's epoch for this bottle; it bumps it whenever it overrules us. */
  e: number;
  mask: number;
  keys: KeyEntry[];
  drops: DropEntry[];
  /** Attacks already in the bottle, so a fix and a frame can't drop the same one twice. */
  taken: Set<number>;
  /** Our checksum at each recent tick, to compare with the server's. */
  history: Map<number, number>;
  sentTick: number;
  /** We asked the server for a fix in this epoch. */
  askedFix: boolean;
}

const HISTORY_TICKS = 900;

/**
 * This browser's copy of the round. Our own bottle steps with the clock and our keys, and we
 * tell the server what we pressed on which tick. Everyone else's bottle is a mirror, replayed
 * from the server's segments a moment behind.
 */
export class RoundView {
  /** The round's seed: tells this round apart from the last one. */
  readonly seed: number;
  /** Server time of tick 0. The server moves it if the round was paused. */
  goAt: number;
  who: (string | null)[];
  mine = -1;
  own: Own | null = null;
  mirrors: (Mirror | null)[] = Array(MAX_PLAYERS).fill(null);
  /** Every attack this round, by id. */
  garbage = new Map<number, Garbage>();
  /** Attacks on their way to each bottle that it hasn't taken yet. */
  inbound: Map<number, Garbage>[] = Array.from({ length: MAX_PLAYERS }, () => new Map());
  /** The round is decided: stop our bottle where it is. */
  over = false;
  private resyncing = false;

  constructor(
    snap: RoundSnap,
    me: string,
    private hooks: ViewHooks,
  ) {
    this.seed = snap.lanes[0]?.b.seed ?? 0;
    this.goAt = snap.goAt;
    this.who = snap.who;
    this.mine = snap.who.indexOf(me);
    this.applySnap(snap);
  }

  bottle(slot: number): Bottle | null {
    if (slot === this.mine && this.own) return this.own.b;
    return this.mirrors[slot]?.bottle ?? null;
  }

  slots(): number[] {
    const out: number[] = [];
    for (let s = 0; s < MAX_PLAYERS; s++) if (this.bottle(s)) out.push(s);
    return out;
  }

  /** Attack halves waiting to drop into a bottle, in the order they'll come. */
  incoming(slot: number): Garbage[] {
    const b = this.bottle(slot);
    return [...(b?.pending ?? []), ...this.inbound[slot].values()];
  }

  /**
   * Take the clock and the result from the game state, if it's about this round. A new round's
   * snapshot arrives before its state, so the state can still be describing the last round.
   */
  syncState(r: RoundInfo | null | undefined): void {
    if (!r || r.seed !== this.seed) return;
    this.goAt = r.goAt;
    if (r.over) this.over = true;
  }

  /** The clock tick, given the server's time. */
  wall(serverNow: number): number {
    return Math.floor((serverNow - this.goAt) / TICK_MS);
  }

  /** A full snapshot: rebuild everyone else's bottle, and ours if the server overruled it. */
  applySnap(snap: RoundSnap): void {
    this.resyncing = false;
    this.who = snap.who;
    for (const lane of snap.lanes) {
      for (const g of lane.due) this.garbage.set(g.id, g);
      for (const g of lane.b.pending) this.garbage.set(g.id, g);
      if (lane.s === this.mine) {
        if (!this.own || this.own.e !== lane.e) this.adopt(lane);
      } else {
        this.mirrors[lane.s] = new Mirror(lane);
        this.inbound[lane.s] = new Map(lane.due.map((g) => [g.id, g]));
      }
    }
  }

  frame(f: Frame): void {
    for (const fx of f.fx ?? []) {
      if (fx.s === this.mine && this.own && fx.e !== this.own.e) this.adopt(fx);
    }
    for (const a of f.a ?? []) {
      const g: Garbage = { id: a.id, p: a.p };
      this.garbage.set(a.id, g);
      if (a.to === this.mine && this.own) this.take(g);
      else this.inbound[a.to]?.set(a.id, g);
      this.hooks.attack(a);
    }
    for (const seg of f.s) {
      if (seg.s === this.mine) {
        const own = this.own;
        const ours = own?.history.get(seg.t);
        if (own && ours !== undefined && ours !== seg.c && !own.askedFix) {
          console.warn(`Our bottle drifted from the server's at tick ${seg.t}; asking for a fix`);
          own.askedFix = this.hooks.send({ t: "resync", own: true });
        }
        continue;
      }
      const m = this.mirrors[seg.s];
      if (m && !m.push(seg)) this.resync();
    }
  }

  /** Step our bottle up to the clock, with the buttons `sample` says are held. */
  stepOwn(wall: number, sample: () => number): void {
    const own = this.own;
    if (!own || this.over) return;
    const b = own.b;
    // A long way behind (a sleeping tab): catch up in chunks.
    const to = Math.min(wall, b.tick + 600);
    while (b.tick < to) {
      const mask = sample();
      if (mask !== own.mask) {
        own.mask = mask;
        own.keys.push([b.tick, mask]);
      }
      b.step(mask);
      own.history.set(b.tick, b.checksum());
      own.history.delete(b.tick - HISTORY_TICKS);
      if (b.events.length) {
        this.hooks.events(this.mine, b.events);
        b.events = [];
      }
    }
    if (b.tick - own.sentTick >= 3 || (own.drops.length && b.tick >= own.sentTick)) this.flush();
  }

  /** Replay everyone else, a little behind the server so their bottles move smoothly. */
  advanceMirrors(ticks: number): void {
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const m = this.mirrors[slot];
      if (!m) continue;
      const behind = m.known - m.bottle.tick;
      const to = m.bottle.tick + Math.ceil(ticks * 1.15) + Math.max(0, behind - 9);
      const ok = m.advance(to, (id) => this.garbage.get(id), {
        drop: (_t, id) => this.inbound[slot].delete(id),
        events: (events) => this.hooks.events(slot, events),
      });
      if (!ok) {
        console.warn(`Bottle ${slot} drifted from the server's; resyncing`);
        this.resync();
      }
    }
  }

  private flush(): void {
    const own = this.own!;
    this.hooks.send({ t: "in", e: own.e, n: own.b.tick, k: own.keys, g: own.drops });
    own.keys = [];
    own.drops = [];
    own.sentTick = own.b.tick;
  }

  private take(g: Garbage): void {
    const own = this.own!;
    if (own.taken.has(g.id)) return;
    own.taken.add(g.id);
    own.b.addGarbage(g);
    own.drops.push([own.b.tick, g.id]);
  }

  private adopt(lane: LaneSnap): void {
    const b = Bottle.restore(lane.b);
    this.own = {
      b,
      e: lane.e,
      mask: b.prevMask,
      keys: [],
      drops: [],
      taken: new Set(b.pending.map((g) => g.id)),
      history: new Map([[b.tick, b.checksum()]]),
      sentTick: b.tick,
      askedFix: false,
    };
    for (const g of lane.due) this.take(g);
    this.inbound[lane.s].clear();
  }

  private resync(): void {
    if (this.resyncing) return;
    this.resyncing = this.hooks.send({ t: "resync" });
  }
}
