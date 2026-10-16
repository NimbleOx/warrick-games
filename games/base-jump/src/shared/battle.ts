import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import {
  BUILD_RATE,
  CAP,
  CHECKSUM_EVERY,
  DECAY_EVERY,
  DECAY_SHARE,
  HELI,
  MAX_LEVEL,
  SEND_PCTS,
  TANK,
  TANK_WORTH,
  UPGRADE_COST,
  type SendPct,
  type UnitKind,
} from "./constants";
import { distance, travelTicks, type GameMap } from "./map";

/** A base as the battle sees it. Its position and kind are in the map. */
export interface Base {
  /** Board slot, or -1 for neutral. */
  owner: number;
  level: number;
  /** Tanks and helicopters in the garrison. */
  t: number;
  h: number;
  /** Progress to the next unit, in thousandths. */
  prog: number;
}

/** Units on the move. */
export interface Group {
  id: number;
  owner: number;
  kind: UnitKind;
  n: number;
  /** The bases it goes through, from where it left to where it's going. Helicopters fly straight: two. */
  path: number[];
  /** The tick it reaches each base on its path; at[0] is when it left. */
  at: number[];
  /** Index in `path` of the next base it reaches. */
  leg: number;
}

/** What players (and CPUs) do: send units, or upgrade a base. */
export type Cmd = ["s", number, number[], number, SendPct] | ["u", number, number];

/** Things that happened during a tick, for sounds and the feed. Both sides work them out. */
export type BattleEvent =
  | { e: "take"; b: number; by: number; from: number }
  | { e: "hold"; b: number; by: number; owner: number }
  | { e: "out"; slot: number };

/** One tick, as the server broadcasts it: the commands applied before it, and now and then a checksum. */
export interface Frame {
  t: "f";
  n: number;
  c?: Cmd[];
  ck?: number;
}

export interface Snapshot {
  map: GameMap;
  /** Seats in play, by slot: the start each one got, or -1. */
  seat: number[];
  n: number;
  go: number;
  /** The tick the time limit runs out, or 0 for none. */
  end: number;
  /** [owner, level, tanks, helicopters, progress] per base. */
  bases: number[][];
  /** [id, owner, kind, units, leg, ...path, ...at] per group; path and at are the same length. */
  groups: number[][];
  nextId: number;
  /** By slot: the tick each player was knocked out, -1 while in, -2 if not in the round. */
  out: number[];
  /** By slot: bases taken and most bases held. */
  taken: number[];
  best: number[];
  over: boolean;
}

export interface BattleOptions {
  /** The slot sitting in each of the map's starts, in order. */
  slots: number[];
  /** Ticks of countdown before anything moves. */
  countdown: number;
  /** Ticks of play after the countdown, or 0 for no time limit. */
  limit: number;
}

/**
 * The battle: who holds which base, what's in each garrison, and what's on the move. Changed only
 * by `apply` (commands) and `step` (one tick), both deterministic and integer-only, so a client
 * that runs the server's frames on a snapshot stays in step with it.
 */
export class Battle {
  n = 0;
  go = 0;
  end = 0;
  bases: Base[] = [];
  groups: Group[] = [];
  nextId = 1;
  /** By slot: the start base, or -1 if the slot isn't in the round. */
  seat: number[] = new Array(MAX_PLAYERS).fill(-1);
  out: number[] = new Array(MAX_PLAYERS).fill(-2);
  taken: number[] = new Array(MAX_PLAYERS).fill(0);
  best: number[] = new Array(MAX_PLAYERS).fill(0);
  over = false;

  constructor(
    readonly map: GameMap,
    opts?: BattleOptions,
  ) {
    if (!opts) return;
    this.go = opts.countdown;
    this.end = opts.limit > 0 ? opts.countdown + opts.limit : 0;
    const owner = new Map<number, number>();
    opts.slots.forEach((slot, i) => {
      const b = map.starts[i];
      this.seat[slot] = b;
      this.out[slot] = -1;
      this.best[slot] = 1;
      owner.set(b, slot);
    });
    this.bases = map.x.map((_, b) => ({
      owner: owner.get(b) ?? -1,
      level: map.level[b],
      t: map.garrison[b],
      h: 0,
      prog: 0,
    }));
  }

  // ---------------------------------------------------------------- queries

  get playing(): boolean {
    return this.n >= this.go && !this.over;
  }

  inRound(slot: number): boolean {
    return slot >= 0 && slot < MAX_PLAYERS && this.out[slot] !== -2;
  }

  alive(slot: number): boolean {
    return this.inRound(slot) && this.out[slot] === -1;
  }

  /** Slots still in, in slot order. */
  aliveSlots(): number[] {
    const out: number[] = [];
    for (let s = 0; s < MAX_PLAYERS; s++) if (this.alive(s)) out.push(s);
    return out;
  }

  basesOf(slot: number): number {
    let c = 0;
    for (const b of this.bases) if (b.owner === slot) c++;
    return c;
  }

  /** Units in a player's garrisons and on the move. */
  unitsOf(slot: number): number {
    let c = 0;
    for (const b of this.bases) if (b.owner === slot) c += b.t + b.h;
    for (const g of this.groups) if (g.owner === slot) c += g.n;
    return c;
  }

  /** Slots in the round, best first: those still in by bases then units, then the rest by how long they lasted. */
  ranking(): number[] {
    const slots: number[] = [];
    for (let s = 0; s < MAX_PLAYERS; s++) if (this.inRound(s)) slots.push(s);
    const key = (s: number) => (this.alive(s) ? Infinity : this.out[s]);
    return slots.sort(
      (a, b) => key(b) - key(a) || this.basesOf(b) - this.basesOf(a) || this.unitsOf(b) - this.unitsOf(a) || a - b,
    );
  }

  /** The units of each kind a send of `pct` takes from a garrison of `have`. */
  static portion(have: number, pct: SendPct): number {
    if (have <= 0) return 0;
    return pct >= 100 ? have : Math.min(have, Math.ceil((have * pct) / 100));
  }

  /**
   * The quickest road route for tanks from one base to another, through bases the player holds.
   * Ties go to the lower-numbered base, so both sides pick the same route.
   */
  route(slot: number, from: number, to: number): { path: number[]; ticks: number[] } | null {
    if (from === to) return null;
    const { dist, prev } = this.roads(slot, from, to);
    if (dist[to] === Infinity) return null;
    const path = [to];
    while (path[0] !== from) path.unshift(prev[path[0]]);
    return { path, ticks: path.map((b) => dist[b]) };
  }

  /** Ticks for tanks to drive from a base to every other base, through the player's bases (Infinity: no route). */
  reach(slot: number, from: number): number[] {
    return this.roads(slot, from, -1).dist;
  }

  /** Dijkstra over the roads in tank ticks, expanding only from `from` and the player's own bases; stops at `to`. */
  private roads(slot: number, from: number, to: number): { dist: number[]; prev: number[] } {
    const m = this.map;
    const count = m.x.length;
    const dist = new Array<number>(count).fill(Infinity);
    const prev = new Array<number>(count).fill(-1);
    const done = new Array<boolean>(count).fill(false);
    dist[from] = 0;
    for (;;) {
      let b = -1;
      for (let i = 0; i < count; i++) if (!done[i] && dist[i] < Infinity && (b < 0 || dist[i] < dist[b])) b = i;
      if (b < 0 || b === to) break;
      done[b] = true;
      // Convoys only pass through their own bases.
      if (b !== from && this.bases[b].owner !== slot) continue;
      for (const nb of m.adj[b]) {
        const d = dist[b] + travelTicks(distance(m, b, nb), TANK);
        if (d < dist[nb]) {
          dist[nb] = d;
          prev[nb] = b;
        }
      }
    }
    return { dist, prev };
  }

  /** Why a command can't be carried out now, or null if it can. Changes nothing. */
  check(cmd: Cmd): string | null {
    if (this.over) return "The round is over";
    if (this.n < this.go) return "Wait for GO";
    if (cmd[0] === "u") {
      const [, slot, b] = cmd;
      const base = this.bases[b];
      if (!this.alive(slot) || !base || base.owner !== slot) return "That isn't your base";
      if (base.level >= MAX_LEVEL) return "That base is already level 3";
      const cost = UPGRADE_COST[base.level + 1];
      if (base.t + base.h < cost) return `Upgrading needs ${cost} units in the base (it has ${base.t + base.h})`;
      return null;
    }
    const [, slot, from, to, pct] = cmd;
    if (!this.alive(slot)) return "You're out of this round";
    if (!SEND_PCTS.includes(pct)) return "Pick 25%, 50% or all";
    if (!Number.isInteger(to) || !this.bases[to]) return "No such base";
    if (!Array.isArray(from) || !from.length || from.length > this.bases.length) return "Pick a base to send from";
    let mine = 0;
    let units = 0;
    let stuck = 0;
    for (const b of from) {
      const base = this.bases[b];
      if (!Number.isInteger(b) || !base || base.owner !== slot || b === to) continue;
      mine++;
      units += base.t + base.h;
      if (base.h > 0) return null;
      if (base.t > 0) {
        if (this.route(slot, b, to)) return null;
        stuck++;
      }
    }
    if (!mine) return "Pick one of your bases to send from";
    if (!units) return "No units there to send yet";
    if (stuck) return "No road there through your bases. Only helicopters can fly that far";
    return "Nothing to send";
  }

  // ---------------------------------------------------------------- changes

  /** Carry out a command. Returns false (and changes nothing) if `check` says it can't be done. */
  apply(cmd: Cmd): boolean {
    if (this.check(cmd)) return false;
    if (cmd[0] === "u") {
      const base = this.bases[cmd[2]];
      let cost = UPGRADE_COST[base.level + 1];
      const own = this.map.kind[cmd[2]] === TANK ? "t" : "h";
      const other = own === "t" ? "h" : "t";
      const fromOwn = Math.min(cost, base[own]);
      base[own] -= fromOwn;
      cost -= fromOwn;
      base[other] -= cost;
      base.level++;
      return true;
    }
    const [, slot, from, to, pct] = cmd;
    const seen = new Set<number>();
    for (const b of from) {
      const base = this.bases[b];
      if (seen.has(b) || !Number.isInteger(b) || !base || base.owner !== slot || b === to) continue;
      seen.add(b);
      const route = base.t > 0 ? this.route(slot, b, to) : null;
      if (route) {
        const n = Battle.portion(base.t, pct);
        base.t -= n;
        this.launch(slot, TANK, n, route.path, route.ticks);
      }
      if (base.h > 0) {
        const n = Battle.portion(base.h, pct);
        base.h -= n;
        this.launch(slot, HELI, n, [b, to], [0, travelTicks(distance(this.map, b, to), HELI)]);
      }
    }
    return true;
  }

  private launch(owner: number, kind: UnitKind, n: number, path: number[], ticks: number[]): void {
    this.groups.push({ id: this.nextId++, owner, kind, n, path, at: ticks.map((t) => this.n + t), leg: 1 });
  }

  /** One tick: production, units over the cap wasting away, arrivals and fights, knockouts and the end of the round. */
  step(): BattleEvent[] {
    const events: BattleEvent[] = [];
    if (this.over) return events;
    this.n++;
    if (this.n <= this.go) return events;

    this.bases.forEach((base, b) => {
      if (base.owner < 0 || base.t + base.h >= CAP[base.level]) return;
      base.prog += BUILD_RATE[base.level];
      if (base.prog < 1000) return;
      base.prog -= 1000;
      if (this.map.kind[b] === TANK) base.t++;
      else base.h++;
    });
    if (this.n % DECAY_EVERY === 0) {
      for (const base of this.bases) {
        const over = base.t + base.h - CAP[base.level];
        if (base.owner < 0 || over <= 0) continue;
        // From whichever kind there's more of.
        let lose = Math.ceil(over / DECAY_SHARE);
        const first = base.t >= base.h ? "t" : "h";
        const fromFirst = Math.min(lose, base[first]);
        base[first] -= fromFirst;
        lose -= fromFirst;
        base[first === "t" ? "h" : "t"] -= lose;
      }
    }

    const moving: Group[] = [];
    for (const g of this.groups) {
      if (g.at[g.leg] !== this.n) {
        moving.push(g);
        continue;
      }
      const b = g.path[g.leg];
      if (g.leg < g.path.length - 1 && this.bases[b].owner === g.owner) {
        g.leg++;
        moving.push(g);
        continue;
      }
      this.arrive(g, b, events);
    }
    this.groups = moving;

    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (!this.alive(s)) continue;
      const held = this.basesOf(s);
      this.best[s] = Math.max(this.best[s], held);
      if (!held && !this.groups.some((g) => g.owner === s)) {
        this.out[s] = this.n;
        events.push({ e: "out", slot: s });
      }
    }
    if (this.aliveSlots().length <= 1 || (this.end && this.n >= this.end)) this.over = true;
    return events;
  }

  private arrive(g: Group, b: number, events: BattleEvent[]): void {
    const base = this.bases[b];
    if (base.owner === g.owner) {
      if (g.kind === TANK) base.t += g.n;
      else base.h += g.n;
      return;
    }
    const { t, h, left } = clash(base.t, base.h, g.kind, g.n);
    base.t = t;
    base.h = h;
    if (left > 0) {
      const from = base.owner;
      base.owner = g.owner;
      base.prog = 0;
      if (g.kind === TANK) base.t = left;
      else base.h = left;
      this.taken[g.owner]++;
      events.push({ e: "take", b, by: g.owner, from });
    } else {
      events.push({ e: "hold", b, by: g.owner, owner: base.owner });
    }
  }

  /** A player left: their bases go neutral (garrisons and all), their units on the move are gone. */
  leave(slot: number): void {
    if (!this.inRound(slot)) return;
    for (const base of this.bases) {
      if (base.owner !== slot) continue;
      base.owner = -1;
      base.prog = 0;
    }
    this.groups = this.groups.filter((g) => g.owner !== slot);
    if (this.out[slot] === -1) this.out[slot] = this.n;
    if (this.aliveSlots().length <= 1 && this.n >= this.go) this.over = true;
  }

  // ---------------------------------------------------------------- sync

  snapshot(): Snapshot {
    return {
      map: this.map,
      seat: [...this.seat],
      n: this.n,
      go: this.go,
      end: this.end,
      bases: this.bases.map((b) => [b.owner, b.level, b.t, b.h, b.prog]),
      groups: this.groups.map((g) => [g.id, g.owner, g.kind, g.n, g.leg, ...g.path, ...g.at]),
      nextId: this.nextId,
      out: [...this.out],
      taken: [...this.taken],
      best: [...this.best],
      over: this.over,
    };
  }

  static fromSnapshot(s: Snapshot): Battle {
    const battle = new Battle(s.map);
    battle.n = s.n;
    battle.go = s.go;
    battle.end = s.end;
    battle.seat = [...s.seat];
    battle.bases = s.bases.map(([owner, level, t, h, prog]) => ({ owner, level, t, h, prog }));
    battle.groups = s.groups.map((row) => {
      const [id, owner, kind, n, leg, ...rest] = row;
      const half = rest.length / 2;
      return { id, owner, kind: kind as UnitKind, n, leg, path: rest.slice(0, half), at: rest.slice(half) };
    });
    battle.nextId = s.nextId;
    battle.out = [...s.out];
    battle.taken = [...s.taken];
    battle.best = [...s.best];
    battle.over = s.over;
    return battle;
  }

  /** A hash of everything that changes, to spot a client that has drifted from the server. */
  checksum(): number {
    let h = 0x811c9dc5 ^ this.n;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
    };
    for (const b of this.bases) {
      mix(b.owner);
      mix(b.level);
      mix(b.t);
      mix(b.h);
      mix(b.prog);
    }
    for (const g of this.groups) {
      mix(g.id);
      mix(g.n);
      mix(g.leg);
    }
    return h >>> 0;
  }
}

/**
 * A fight at a base: `n` attackers of one kind against a garrison of `t` tanks and `h`
 * helicopters. Like fights like first, then the rest, with one tank worth two helicopters.
 * Rounding favours the defender. Returns what's left of the garrison and of the attackers.
 */
export function clash(t: number, h: number, kind: UnitKind, n: number): { t: number; h: number; left: number } {
  let left = n;
  if (kind === TANK) {
    const k = Math.min(left, t);
    left -= k;
    t -= k;
    if (left > 0 && h > 0) {
      const killed = Math.min(h, left * TANK_WORTH);
      h -= killed;
      left -= Math.ceil(killed / TANK_WORTH);
    }
  } else {
    const k = Math.min(left, h);
    left -= k;
    h -= k;
    if (left > 0 && t > 0) {
      const killed = Math.min(t, Math.floor(left / TANK_WORTH));
      t -= killed;
      left -= killed * TANK_WORTH;
      // What's left can't take on a whole tank.
      if (t > 0) left = 0;
    }
  }
  return { t, h, left };
}

/** Run a server frame on a client's copy. Returns the tick's events, or null if it doesn't follow on. */
export function applyFrame(battle: Battle, f: Frame): BattleEvent[] | null {
  if (f.n !== battle.n + 1) return null;
  for (const cmd of f.c ?? []) battle.apply(cmd);
  return battle.step();
}

export function wantsChecksum(n: number): boolean {
  return n % CHECKSUM_EVERY === 0;
}
