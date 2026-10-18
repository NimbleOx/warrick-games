import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import { Battle, clash, type Cmd } from "./battle";
import { BUILD_RATE, CAP, HELI, MAX_LEVEL, SEND_PCTS, TANK, UPGRADE_COST, type SendPct } from "./constants";
import { distance, travelTicks } from "./map";

export type { CpuLevel };

/** A CPU player's memory between thoughts. */
export interface Brain {
  level: CpuLevel;
  /** The tick it next looks at the map. */
  next: number;
}

/** How a CPU level plays. Easy has its own simple way and only uses `think`. */
export interface Style {
  /** Ticks between looks at the map, [min, max]. */
  think: [number, number];
  /** Units an attack should have left over by its estimate: a few, plus a share of what it's up against. */
  margin: [number, number];
  /** Share of the enemy forces near a base that it keeps at home when it attacks. */
  reserve: number;
  /** Attacks it can start in one look. */
  attacks: number;
  /** Sends several bases at once at a target none could take alone. */
  gang: boolean;
  /** Share of the bases next to a target it expects the owner to send in. */
  foresee: number;
  /** The chance it upgrades a base that could, and the units it keeps there after. */
  upgrade: [number, number];
  /** Extra value for taking bases from whoever holds the most. */
  leader: number;
  /** Sends everything from a front-line base when that's what it takes (otherwise only from bases behind the front). */
  allIn: boolean;
}

/**
 * Tuned in CPU-against-CPU games (README): against normal, hard wins about 4 duels in 5.
 * Caution doesn't pay in this game: bigger margins, bigger reserves and expecting the defender
 * to reinforce all made a CPU weaker. Hitting with everything, and soon, made it stronger.
 */
export const STYLES: Record<CpuLevel, Style> = {
  easy: { think: [26, 44], margin: [0, 0], reserve: 0, attacks: 1, gang: false, foresee: 0, upgrade: [0.3, 6], leader: 0, allIn: false },
  normal: { think: [11, 17], margin: [2, 0.15], reserve: 0.3, attacks: 1, gang: false, foresee: 0, upgrade: [0.5, 6], leader: 0, allIn: false },
  hard: { think: [5, 9], margin: [1, 0], reserve: 0.15, attacks: 1, gang: true, foresee: 0, upgrade: [0.5, 6], leader: 3, allIn: true },
};

/** How far ahead (ticks) it looks for attacks on its own bases. */
const HORIZON = 80;
/** Enemy bases this close (map units) count as a threat to a base. */
const THREAT_RANGE = 330;

export function newBrain(level: CpuLevel, first = 0): Brain {
  return { level, next: first };
}

/**
 * One CPU player's turn to look at the map. Most ticks it does nothing; every so often it
 * decides on a few commands and carries each out at once through `act`, so later decisions see
 * the earlier ones.
 */
export function think(b: Battle, slot: number, brain: Brain, rng: Rng, act: (cmd: Cmd) => boolean): void {
  if (!b.playing || !b.alive(slot) || b.n < brain.next) return;
  const style = STYLES[brain.level];
  const [lo, hi] = style.think;
  brain.next = b.n + lo + Math.floor(rng() * (hi - lo + 1));
  const mind = new Mind(b, slot, style, rng, act);
  if (brain.level === "easy") return mind.easy();
  mind.defend();
  mind.attack();
  if (style.gang) mind.gang();
  mind.upgrade();
  mind.reinforce();
}

/** What a CPU works out about the map for one look at it. */
class Mind {
  /** Bases that already sent something this look. */
  private used = new Set<number>();
  private mine: number[] = [];
  /** By base: hops along the roads to the nearest base that isn't ours. */
  private front: number[];
  /** By base: units (in tank terms) needed there to hold off what's coming, if it would fall. */
  private danger: number[];
  /** By base: enemy units (in tank terms) close enough to strike it, halved: they won't all come. */
  private threat: number[];
  private leader = -1;
  private reachCache = new Map<number, number[]>();

  constructor(
    private b: Battle,
    private slot: number,
    private style: Style,
    private rng: Rng,
    private act: (cmd: Cmd) => boolean,
  ) {
    b.bases.forEach((base, i) => base.owner === slot && this.mine.push(i));
    this.front = this.frontDistance();
    this.danger = b.bases.map((_, i) => (b.bases[i].owner === slot ? this.shortfall(i) : 0));
    this.threat = b.bases.map((base, i) => {
      if (base.owner !== slot) return 0;
      let sum = 0;
      b.bases.forEach((e, j) => {
        if (e.owner >= 0 && e.owner !== slot && distance(b.map, i, j) <= THREAT_RANGE) sum += e.t + e.h / 2;
      });
      return sum / 2;
    });
    const others = b.aliveSlots().filter((s) => s !== slot);
    if (others.length > 1) this.leader = others.reduce((p, q) => (b.basesOf(q) > b.basesOf(p) ? q : p));
  }

  /** Easy: now and then, hit the weakest neighbour if it looks beatable. */
  easy(): void {
    if (this.rng() < 0.35) return;
    const sources = this.mine.filter((i) => this.units(i) >= 6);
    if (!sources.length) return this.upgrade();
    const src = sources[Math.floor(this.rng() * sources.length)];
    const base = this.b.bases[src];
    let target = -1;
    let weakest = Infinity;
    for (const nb of this.b.map.adj[src]) {
      const t = this.b.bases[nb];
      if (t.owner === this.slot) continue;
      const g = t.t + t.h;
      if (g < weakest) {
        weakest = g;
        target = nb;
      }
    }
    if (target >= 0 && base.t + base.h > weakest + 1) this.send([src], target, 100);
    else if (base.t + base.h >= CAP[base.level]) this.upgrade();
  }

  /** Send help to bases that would fall to what's on its way. */
  defend(): void {
    for (const target of this.mine) {
      const need = this.danger[target];
      if (!need) continue;
      const helpers = this.mine
        .filter((s) => s !== target && !this.used.has(s) && !this.danger[s] && this.units(s) >= 3)
        .map((s) => ({ s, eta: this.eta(s, target) }))
        .filter((x) => x.eta < HORIZON)
        .sort((p, q) => p.eta - q.eta);
      let sent = 0;
      for (const { s } of helpers) {
        if (sent >= need) break;
        const pct: SendPct = this.front[s] <= 1 ? 50 : 100;
        const base = this.b.bases[s];
        const worth = Battle.portion(base.t, pct) + Math.floor(Battle.portion(base.h, pct) / 2);
        if (this.send([s], target, pct)) sent += worth;
      }
    }
  }

  /** The best single-base attacks: value against cost and travel time. */
  attack(): void {
    for (let k = 0; k < this.style.attacks; k++) {
      let best: { src: number; target: number; pct: SendPct; score: number } | null = null;
      for (const src of this.mine) {
        if (this.used.has(src) || this.danger[src] || this.units(src) < 3) continue;
        const roads = this.roads(src);
        const base = this.b.bases[src];
        for (let target = 0; target < this.b.bases.length; target++) {
          if (this.b.bases[target].owner === this.slot) continue;
          const byRoad = roads[target] < Infinity && base.t > 0;
          if (!byRoad && !base.h) continue;
          const eta = byRoad ? roads[target] : travelTicks(distance(this.b.map, src, target), HELI);
          const pct = this.enough(src, target, eta, byRoad);
          if (!pct) continue;
          const sent = Battle.portion(byRoad ? base.t : 0, pct) + Battle.portion(base.h, pct);
          const score = this.value(target) / (sent + eta / 8 + 4);
          if (!best || score > best.score) best = { src, target, pct, score };
        }
      }
      if (!best) return;
      this.send([best.src], best.target, best.pct);
    }
  }

  /** When no one base can take a good target, several close ones go together. */
  gang(): void {
    let best: { srcs: number[]; target: number; score: number } | null = null;
    for (let target = 0; target < this.b.bases.length; target++) {
      if (this.b.bases[target].owner === this.slot) continue;
      const srcs = this.mine
        .filter((s) => !this.used.has(s) && !this.danger[s] && this.b.bases[s].t >= 4)
        .map((s) => ({ s, eta: this.roads(s)[target] }))
        .filter((x) => x.eta < 70)
        .sort((p, q) => p.eta - q.eta)
        .slice(0, 3);
      if (srcs.length < 2) continue;
      const eta = srcs[srcs.length - 1].eta;
      const hold = this.holdAt(target, eta);
      const force = srcs.reduce((sum, { s }) => sum + Battle.portion(this.b.bases[s].t, 50), 0);
      if (clash(hold.t, hold.h, TANK, force).left <= this.margin(hold) + 1) continue;
      const score = this.value(target) / (force + eta / 8 + 4);
      if (!best || score > best.score) best = { srcs: srcs.map((x) => x.s), target, score };
    }
    if (best && best.score > 0.25) this.send(best.srcs, best.target, 50);
  }

  /** Upgrade a base that's safe and has units to spare. */
  upgrade(): void {
    const [odds, reserve] = this.style.upgrade;
    for (const i of this.mine) {
      const base = this.b.bases[i];
      if (base.level >= MAX_LEVEL || this.danger[i] || this.used.has(i)) continue;
      const cost = UPGRADE_COST[base.level + 1];
      const full = base.t + base.h >= CAP[base.level] * 0.8;
      if (base.t + base.h < cost + reserve || (this.front[i] <= 1 && !full)) continue;
      if (this.rng() < odds && this.act(["u", this.slot, i])) {
        this.used.add(i);
        return;
      }
    }
  }

  /** Move units from bases far from the fighting toward the front. */
  reinforce(): void {
    for (const src of this.mine) {
      const base = this.b.bases[src];
      if (this.used.has(src) || this.front[src] < 2 || base.t + base.h < Math.max(8, CAP[base.level] * 0.5)) continue;
      let to = -1;
      for (const nb of this.b.map.adj[src]) {
        if (this.b.bases[nb].owner === this.slot && (to < 0 || this.front[nb] < this.front[to])) to = nb;
      }
      if (to >= 0 && this.front[to] < this.front[src]) this.send([src], to, 50);
    }
  }

  // ---------------------------------------------------------------- helpers

  private send(from: number[], to: number, pct: SendPct): boolean {
    if (!this.act(["s", this.slot, from, to, pct])) return false;
    for (const s of from) this.used.add(s);
    return true;
  }

  /** Tank ticks from a base to every other (routes don't change within one look: bases only change hands on a tick). */
  private roads(src: number): number[] {
    let r = this.reachCache.get(src);
    if (!r) {
      r = this.b.reach(this.slot, src);
      this.reachCache.set(src, r);
    }
    return r;
  }

  private units(i: number): number {
    const base = this.b.bases[i];
    return base.t + base.h;
  }

  /** Quickest way for what's at `src` to reach `target`: by road if its tanks can, else by air. */
  private eta(src: number, target: number): number {
    const road = this.roads(src)[target];
    if (road < Infinity && this.b.bases[src].t > 0) return road;
    return this.b.bases[src].h > 0 ? travelTicks(distance(this.b.map, src, target), HELI) : Infinity;
  }

  /** How valuable a base is to take. */
  private value(i: number): number {
    const base = this.b.bases[i];
    let v = base.level * 3 + (this.b.map.kind[i] === HELI ? 2 : 0);
    if (base.owner >= 0) v += 3;
    if (base.owner === this.leader) v += this.style.leader;
    // Taking a base next to ours keeps the front short.
    if (this.b.map.adj[i].some((nb) => this.b.bases[nb].owner === this.slot)) v += 1;
    return v;
  }

  private margin(hold: { t: number; h: number }): number {
    const [few, share] = this.style.margin;
    return few + share * (hold.t + hold.h / 2);
  }

  /**
   * The smallest send from `src` that should take `target` and still leave enough at home, or
   * null if none would.
   */
  private enough(src: number, target: number, eta: number, byRoad: boolean): SendPct | null {
    const base = this.b.bases[src];
    const hold = this.holdAt(target, eta);
    const margin = this.margin(hold);
    // A full base builds nothing, so holding units back there costs more than it saves.
    const full = base.t + base.h >= CAP[base.level];
    const keep = full ? 0 : this.style.reserve * this.threat[src];
    const allowAll = this.style.allIn || this.front[src] >= 2 || full;
    for (const pct of SEND_PCTS) {
      if (pct === 100 && !allowAll) continue;
      const tanks = byRoad ? Battle.portion(base.t, pct) : 0;
      const helis = Battle.portion(base.h, pct);
      // Bigger sends only leave less behind.
      if (base.t - tanks + (base.h - helis) / 2 < keep) return null;
      // Helicopters get there first.
      const air = clash(hold.t, hold.h, HELI, helis);
      if (air.left > margin) return pct;
      if (!tanks) continue;
      if (clash(air.t, air.h, TANK, tanks).left > margin) return pct;
    }
    return null;
  }

  /**
   * What will be holding a base when units sent now get there at tick `eta`, expecting the owner
   * to send in some of what's next door (as much as the style foresees).
   */
  private holdAt(i: number, eta: number): { t: number; h: number } {
    const b = this.b;
    const base = b.bases[i];
    let { t, h } = base;
    const foresee = this.style.foresee;
    if (foresee && base.owner >= 0 && base.owner !== this.slot) {
      for (const nb of b.map.adj[i]) {
        const e = b.bases[nb];
        if (e.owner !== base.owner) continue;
        t += Math.floor(e.t * foresee);
        h += Math.floor(e.h * foresee);
      }
    }
    if (base.owner >= 0) {
      const built = Math.floor((base.prog + BUILD_RATE[base.level] * Math.max(0, eta - b.n)) / 1000);
      const add = Math.min(built, Math.max(0, CAP[base.level] - t - h));
      if (b.map.kind[i] === TANK) t += add;
      else h += add;
    }
    for (const g of b.groups) {
      if (g.path[g.path.length - 1] !== i || g.at[g.at.length - 1] > eta) continue;
      if (g.owner === base.owner) {
        if (g.kind === TANK) t += g.n;
        else h += g.n;
      } else if (g.owner === this.slot) {
        ({ t, h } = clash(t, h, g.kind, g.n));
      }
    }
    return { t, h };
  }

  /** For one of our bases: how many more units (in tank terms) it needs to survive what's coming. */
  private shortfall(i: number): number {
    const b = this.b;
    const coming = b.groups.filter(
      (g) => g.owner !== this.slot && g.path[g.path.length - 1] === i && g.at[g.at.length - 1] - b.n <= HORIZON,
    );
    if (!coming.length) return 0;
    const last = Math.max(...coming.map((g) => g.at[g.at.length - 1]));
    let { t, h } = this.holdAt(i, last);
    let worst = 0;
    for (const g of coming.sort((p, q) => p.at[p.at.length - 1] - q.at[q.at.length - 1])) {
      const r = clash(t, h, g.kind, g.n);
      ({ t, h } = r);
      if (r.left > 0) {
        worst += g.kind === TANK ? r.left : Math.ceil(r.left / 2);
        t = h = 0;
      }
    }
    return worst ? worst + 2 : 0;
  }

  /** Hops along the roads from each base to the nearest base that isn't ours. */
  private frontDistance(): number[] {
    const b = this.b;
    const hops = b.bases.map((base) => (base.owner === this.slot ? Infinity : 0));
    const queue = hops.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
    for (let q = 0; q < queue.length; q++) {
      const at = queue[q];
      for (const nb of b.map.adj[at]) {
        if (hops[nb] > hops[at] + 1) {
          hops[nb] = hops[at] + 1;
          queue.push(nb);
        }
      }
    }
    return hops;
  }
}
