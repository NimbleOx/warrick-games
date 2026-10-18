// CPU players. A CPU's turn is a series of steps, and each step is chosen fresh from the board
// as it is: the best-scoring action for one unit, then builds once no unit has anything better
// to do than stay put, then End turn. Every step goes through the same checks a human's does.
//
// Scores are in funds, so they compare: damage dealt and taken is HP × unit cost / 10, and a
// turn's worth of progress toward a unit's goal is worth a slice of what the unit cost.
import type { CpuLevel } from "@warrick/kit/shared/protocol";
import type { Rng } from "@warrick/kit/shared/rng";
import type { MapDef } from "./maps";
import {
  distanceField,
  forecast,
  manhattan,
  occupancy,
  optionsFor,
  reach,
  threatTiles,
  damage,
  defenseAt,
  tileOf,
  unitTile,
  type Act,
  type Board,
  type Unit,
} from "./rules";
import { CAPTURE_POINTS, type MoveType } from "./terrain";
import { DAMAGE, UNITS, UNIT_TYPES, isIndirect, type UnitType } from "./units";

export type CpuMove = { kind: "act"; act: Act } | { kind: "build"; at: number; unit: UnitType } | { kind: "end" };

/** The CPU's next step. `day` is the game day (early days lean on infantry). */
export function cpuNext(level: CpuLevel, m: MapDef, b: Board, seat: number, rng: Rng, day = 1): CpuMove {
  if (b.out[seat]) return { kind: "end" };
  const p = new Planner(level, m, b, seat, rng, day);
  return p.unitMove() ?? p.buildMove() ?? { kind: "end" };
}

/** Distance fields from each building, per movement type. They depend only on the map. */
const buildingFields = new Map<string, Float64Array[]>();

function buildingField(m: MapDef, bi: number, mt: MoveType): Float64Array {
  const key = `${m.id}:${mt}`;
  let arr = buildingFields.get(key);
  if (!arr) buildingFields.set(key, (arr = []));
  if (!arr[bi]) {
    const bd = m.buildings[bi];
    arr[bi] = distanceField(m, mt, [tileOf(m, bd.x, bd.y)]);
  }
  return arr[bi];
}

const PROGRESS = 0.12;
/** Random slack on every score, in funds, so CPUs aren't predictable (and easy blunders more). */
const NOISE: Record<CpuLevel, number> = { easy: 400, normal: 120, hard: 60 };

class Planner {
  readonly occ: (Unit | undefined)[];
  readonly mine: Unit[];
  readonly enemies: Unit[];
  readonly hqTile: number;
  private fields = new Map<string, Float64Array>();
  private threats: { e: Unit; tiles: Set<number> }[] | null = null;
  private assigned: Map<number, number> | null = null;
  private hqDanger: Set<number> | null = null;
  /**
   * 0 until day 25, rising to 1 by day 50: long games stall when both sides sit behind their
   * artillery, so later on CPUs push harder and mind the threats less.
   */
  private readonly urgency: number;

  constructor(
    readonly level: CpuLevel,
    readonly m: MapDef,
    readonly b: Board,
    readonly seat: number,
    readonly rng: Rng,
    readonly day: number,
  ) {
    this.occ = occupancy(m, b);
    this.mine = b.units.filter((u) => u.seat === seat);
    this.enemies = b.units.filter((u) => u.seat !== seat);
    const hq = m.buildings[m.hq[seat]];
    this.hqTile = tileOf(m, hq.x, hq.y);
    this.urgency = Math.min(1, Math.max(0, (day - 25) / 25));
  }

  // ---------------------------------------------------------------- units

  unitMove(): CpuMove | null {
    let best: Act | null = null;
    let bestGain = 0;
    for (const u of this.mine) {
      if (u.done) continue;
      const r = reach(this.m, this.b, u, this.occ);
      const opts = optionsFor(this.m, this.b, u, this.occ, r);
      let stay = 0;
      let top: Act | null = null;
      let topScore = -Infinity;
      for (const o of opts) {
        const s = this.score(u, o);
        if (s === null) continue;
        if (o.to === r.origin && o.action === "wait") stay = s;
        const noisy = s + this.rng() * NOISE[this.level];
        if (noisy > topScore) {
          topScore = noisy;
          top = o;
        }
      }
      if (!top || (top.to === r.origin && top.action === "wait")) continue;
      const gain = topScore - stay;
      if (gain > bestGain) {
        bestGain = gain;
        best = top;
      }
    }
    return best ? { kind: "act", act: best } : null;
  }

  private score(u: Unit, o: Act): number | null {
    const action = this.actionScore(u, o);
    if (action === null) return null;
    return this.positionScore(u, o.to) + action;
  }

  private actionScore(u: Unit, o: Act): number | null {
    const { m, b } = this;
    if (o.action === "wait") return 0;
    if (o.action === "capture") {
      const bi = m.buildingAt[o.to];
      const kind = m.buildings[bi].kind;
      const left = b.capture[bi] - u.hp;
      const completes = left <= 0;
      let s = 600 + (completes ? 1200 : 0) + ((CAPTURE_POINTS - Math.max(0, left)) / CAPTURE_POINTS) * 300;
      if (kind === "factory") s += 500;
      if (b.owners[bi] >= 0) s += 300;
      if (kind === "hq" && m.hq.indexOf(bi) >= 0) s += 1000 + (completes ? 50000 : 0);
      return s;
    }
    const t = this.enemies.find((e) => e.id === o.target);
    if (!t) return null;
    const f = forecast(m, u, o.to, t);
    if (f.dealt <= 0) return null;
    const dealt = (f.dealt * UNITS[t.type].cost) / 10;
    const taken = (f.taken * UNITS[u.type].cost) / 10;
    if (this.level === "easy") return 5000 + dealt;
    let net = dealt - taken;
    const tTile = unitTile(m, t);
    const bi = m.buildingAt[tTile];
    let bonus = 0;
    if (UNITS[t.type].captures && bi >= 0 && b.owners[bi] === this.seat) bonus += m.buildings[bi].kind === "hq" ? 4000 : 600;
    if (this.level === "hard") {
      if (f.kills) net += 0.6 * ((UNITS[t.type].cost * t.hp) / 10) + 400;
      if (f.dies) net -= 0.5 * ((UNITS[u.type].cost * u.hp) / 10);
      if (this.dangerToHq().has(t.id)) bonus += 1500;
    }
    // Late on, trades that come out a little behind are fine if they break a stalemate.
    if (net + bonus <= -this.urgency * 300) return null;
    return 250 + net + bonus;
  }

  private positionScore(u: Unit, to: number): number {
    const { m, b, level } = this;
    const def = UNITS[u.type];
    const C = def.cost;
    const V = (C * u.hp) / 10;
    const origin = unitTile(m, u);
    let s = 0;

    const field = this.goalField(u);
    if (field) {
      if (isIndirect(u.type) && level !== "easy") {
        // Artillery wants to sit about its range away from the enemy, not on top of it.
        const want = def.maxRange;
        const fit = (t: number) => (Number.isFinite(field[t]) ? -Math.abs(field[t] - want) : -50);
        s += ((fit(to) - fit(origin)) / def.move) * C * PROGRESS * (1 + this.urgency);
      } else {
        const d0 = field[origin];
        const d1 = field[to];
        if (Number.isFinite(d0) && Number.isFinite(d1)) s += ((d0 - d1) / def.move) * C * PROGRESS * (1 + this.urgency);
      }
    }

    const bi = m.buildingAt[to];
    const ownBuilding = bi >= 0 && b.owners[bi] === this.seat;
    if (ownBuilding && m.buildings[bi].kind === "factory") s -= C * 0.2 + 600;

    if (level === "easy") return s;

    s += defenseAt(m, to) * C * 0.015;
    if (u.hp <= (level === "hard" ? 5 : 4) && ownBuilding && m.buildings[bi].kind !== "factory") s += C * 0.35;
    if (isIndirect(u.type) && this.directThreat(to)) s -= 0.6 * V * (1 - 0.5 * this.urgency);

    if (level === "hard") {
      s -= 0.15 * (1 - 0.7 * this.urgency) * Math.min(V, this.expectedLoss(u, to));
      if (this.dangerToHq().size) {
        if (to === this.hqTile) s += 2500;
        else if (manhattan(m, to, this.hqTile) === 1) s += 200;
      }
    }
    return s;
  }

  /** Where this unit is headed: a distance field to its goal, or null if it has none. */
  private goalField(u: Unit): Float64Array | null {
    const { m, b, level } = this;
    const mt = UNITS[u.type].moveType;
    if (level === "easy") {
      const goals = this.enemies.map((e) => unitTile(m, e));
      m.buildings.forEach((bd, i) => b.owners[i] !== this.seat && goals.push(tileOf(m, bd.x, bd.y)));
      return this.field(`easy:${mt}`, mt, goals);
    }
    if (u.hp <= 3) {
      const homes: number[] = [];
      m.buildings.forEach((bd, i) => b.owners[i] === this.seat && bd.kind !== "factory" && homes.push(tileOf(m, bd.x, bd.y)));
      if (homes.length) return this.field(`home:${mt}`, mt, homes);
    }
    if (UNITS[u.type].captures) {
      const bi = this.assignments().get(u.id);
      if (bi !== undefined) return buildingField(m, bi, mt);
    }
    if (this.enemies.length) return this.field(`enemy:${mt}`, mt, this.enemies.map((e) => unitTile(m, e)), true);
    const theirs: number[] = [];
    m.buildings.forEach((bd, i) => b.owners[i] !== this.seat && theirs.push(tileOf(m, bd.x, bd.y)));
    return theirs.length ? this.field(`theirs:${mt}`, mt, theirs) : null;
  }

  private field(key: string, mt: MoveType, goals: number[], approach = false): Float64Array {
    let f = this.fields.get(key);
    if (!f) this.fields.set(key, (f = distanceField(this.m, mt, goals, approach)));
    return f;
  }

  /**
   * Capturers matched to buildings they don't own, nearest pairs first, so each heads somewhere
   * different. A capturer already on such a building keeps it. Hard looks at the travel time in
   * turns and prefers factories and enemy HQs; normal just takes the nearest.
   */
  private assignments(): Map<number, number> {
    if (this.assigned) return this.assigned;
    const { m, b } = this;
    const out = new Map<number, number>();
    const free = new Set<number>();
    m.buildings.forEach((_, i) => b.owners[i] !== this.seat && free.add(i));
    const capturers = this.mine.filter((u) => UNITS[u.type].captures && u.hp > 3);
    const left: Unit[] = [];
    for (const u of capturers) {
      const bi = m.buildingAt[unitTile(m, u)];
      if (bi >= 0 && free.has(bi)) {
        out.set(u.id, bi);
        free.delete(bi);
      } else left.push(u);
    }
    const pairs: { u: Unit; bi: number; cost: number }[] = [];
    for (const u of left) {
      const def = UNITS[u.type];
      for (const bi of free) {
        const d = buildingField(m, bi, def.moveType)[unitTile(m, u)];
        if (!Number.isFinite(d)) continue;
        let cost = d / def.move;
        if (this.level === "hard") {
          cost = Math.ceil(cost);
          if (m.buildings[bi].kind === "factory") cost -= 0.7;
          if (m.hq.indexOf(bi) >= 0 && b.owners[bi] >= 0) cost -= 1;
        }
        pairs.push({ u, bi, cost });
      }
    }
    pairs.sort((a, c) => a.cost - c.cost || a.u.id - c.u.id || a.bi - c.bi);
    for (const pr of pairs) {
      if (out.has(pr.u.id) || !free.has(pr.bi)) continue;
      out.set(pr.u.id, pr.bi);
      free.delete(pr.bi);
    }
    this.assigned = out;
    return out;
  }

  /**
   * Where each enemy could attack next turn. My units don't block them here: the unit being
   * planned is about to leave its tile, and the rest may move too, so this errs on the safe side.
   */
  private threatList(): { e: Unit; tiles: Set<number> }[] {
    if (!this.threats) {
      const occ: (Unit | undefined)[] = new Array(this.m.w * this.m.h);
      for (const e of this.enemies) occ[unitTile(this.m, e)] = e;
      this.threats = this.enemies.map((e) => ({ e, tiles: threatTiles(this.m, this.b, e, occ) }));
    }
    return this.threats;
  }

  /** Could an enemy direct-fire unit hit this tile next turn? */
  private directThreat(t: number): boolean {
    return this.threatList().some(({ e, tiles }) => !isIndirect(e.type) && tiles.has(t));
  }

  /**
   * What standing on `t` could cost this unit next turn. The strongest attacker counts in full
   * and each extra one less, since they have other targets too.
   */
  private expectedLoss(u: Unit, t: number): number {
    const stars = defenseAt(this.m, t);
    const hits: number[] = [];
    for (const { e, tiles } of this.threatList()) if (tiles.has(t)) hits.push(damage(e.type, e.hp, u.type, u.hp, stars));
    hits.sort((a, c) => c - a);
    const hp = hits.reduce((sum, h, i) => sum + h / (i + 1), 0);
    return (Math.min(hp, u.hp) * UNITS[u.type].cost) / 10;
  }

  /** Enemy capturers that could reach this CPU's HQ within two turns. */
  private dangerToHq(): Set<number> {
    if (this.hqDanger) return this.hqDanger;
    const out = new Set<number>();
    for (const e of this.enemies) {
      if (!UNITS[e.type].captures) continue;
      const d = buildingField(this.m, this.m.hq[this.seat], UNITS[e.type].moveType)[unitTile(this.m, e)];
      if (d <= UNITS[e.type].move * 2) out.add(e.id);
    }
    this.hqDanger = out;
    return out;
  }

  // ---------------------------------------------------------------- builds

  buildMove(): CpuMove | null {
    const { m, b } = this;
    const funds = b.funds[this.seat];
    const factories = m.buildings
      .map((bd, i) => ({ bd, i, t: tileOf(m, bd.x, bd.y) }))
      .filter(({ bd, i, t }) => bd.kind === "factory" && b.owners[i] === this.seat && !this.occ[t]);
    if (!factories.length) return null;
    const affordable = UNIT_TYPES.filter((t) => UNITS[t].cost <= funds);
    if (!affordable.length) return null;
    // Build nearest the enemy first.
    const front = this.enemies.length ? this.field("front:treads", "treads", this.enemies.map((e) => unitTile(m, e)), true) : null;
    factories.sort((a, c) => (front ? front[a.t] - front[c.t] : 0) || a.i - c.i);
    const at = factories[0].t;
    if (this.level === "easy") return { kind: "build", at, unit: affordable[Math.floor(this.rng() * affordable.length)] };
    const unit = this.chooseBuild(affordable, funds, factories.length);
    return unit ? { kind: "build", at, unit } : null;
  }

  /** Counters to what the enemy fields, and enough capturers to keep taking buildings. */
  private chooseBuild(affordable: UnitType[], funds: number, freeFactories: number): UnitType | null {
    const { b } = this;
    const capturers = this.mine.filter((u) => UNITS[u.type].captures).length;
    const capturable = b.owners.filter((o) => o !== this.seat).length;
    const wantCapturers = Math.min(this.level === "hard" ? 6 : 5, Math.ceil(capturable / 3) + 1);
    const needCapturers = capturers < wantCapturers;
    // Infantry for the first days and while capturers are short, but not while funds pile up.
    if (affordable.includes("infantry") && needCapturers && (this.day <= 3 || freeFactories > 1 || funds < 4000)) {
      return "infantry";
    }

    // Enemy army by value; before anyone has built, assume the usual opening.
    const army: { type: UnitType; w: number }[] = this.enemies.length
      ? this.enemies.map((e) => ({ type: e.type, w: e.hp / 10 }))
      : [
          { type: "infantry", w: 3 },
          { type: "tank", w: 1 },
        ];
    const mineByType = new Map<UnitType, number>();
    for (const u of this.mine) mineByType.set(u.type, (mineByType.get(u.type) ?? 0) + 1);
    const direct = this.mine.filter((u) => !isIndirect(u.type) && !UNITS[u.type].captures).length;
    // Leave enough for infantry at the other free factories.
    const reserve = needCapturers ? (freeFactories - 1) * UNITS.infantry.cost : 0;
    let best: UnitType | null = null;
    let bestScore = -Infinity;
    for (const t of affordable) {
      const cost = UNITS[t].cost;
      if (cost > funds - reserve && t !== "infantry") continue;
      let eff = 0;
      for (const { type: e, w } of army) {
        const mine = DAMAGE[t][e] * UNITS[e].cost;
        const theirs = DAMAGE[e][t] * cost * (isIndirect(t) ? 0.6 : 1);
        eff += (w * (mine - theirs)) / 100 / cost;
      }
      eff /= army.reduce((a, x) => a + x.w, 0) || 1;
      if (t === "artillery" && (mineByType.get("artillery") ?? 0) * 2 > direct) eff -= 0.4;
      if (t === "recon" && (mineByType.get("recon") ?? 0) >= 2) eff -= 0.3;
      // A factory builds one unit a turn, so a slot is worth what its unit wins over its life:
      // efficiency × cost. A unit that loses its trades is bought only if nothing else wins any.
      const score = (eff > 0 ? eff * cost : eff) * (0.85 + 0.3 * this.rng());
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best ?? (affordable.includes("infantry") ? "infantry" : null);
  }
}
