// The rules, as pure functions over a Board. The server, the CPUs, the client's previews and
// the home-screen demo all use these, so they always agree.
import type { MapDef } from "./maps";
import { CAPTURE_POINTS, INCOME_PER_BUILDING, NO, TERRAIN, type MoveType } from "./terrain";
import { CHEAPEST_UNIT, DAMAGE, MAX_HP, REPAIR_HP, UNITS, isIndirect, isUnitType, type UnitType } from "./units";

export interface Unit {
  id: number;
  type: UnitType;
  seat: number;
  x: number;
  y: number;
  hp: number;
  /** Has acted this turn. Cleared when its owner's turn ends. */
  done: boolean;
}

export interface Board {
  units: Unit[];
  /** Each building's owner (by the map's building index): a seat, or -1 for neutral. */
  owners: number[];
  /** Capture points left on each building. */
  capture: number[];
  /** Funds by seat. */
  funds: number[];
  /** Seats that are out of the game. */
  out: boolean[];
  nextId: number;
}

export type Action = "wait" | "capture" | "attack";

/** One unit's move and the action that ends it. */
export interface Act {
  unit: number;
  /** Destination tile index; the unit's own tile to stay put. */
  to: number;
  action: Action;
  /** The unit attacked. */
  target?: number;
}

/** What an action did, for clients to animate. */
export interface ActEvent {
  seat: number;
  unit: number;
  type: UnitType;
  /** Tiles from where the unit started to where it stopped. */
  path: number[];
  action: Action;
  target?: number;
  targetType?: UnitType;
  targetSeat?: number;
  dealt?: number;
  taken?: number;
  /** The target was destroyed. */
  killed?: boolean;
  /** The attacker was destroyed by the counterattack. */
  lost?: boolean;
  /** Capturing: the building, the points left on it, and whether it changed hands. */
  building?: number;
  left?: number;
  captured?: boolean;
  /** Seats knocked out by this action. */
  out?: number[];
}

export interface BuildEvent {
  seat: number;
  unit: Unit;
  at: number;
}

export interface TurnStart {
  seat: number;
  income: number;
  repairs: { unit: number; hp: number }[];
  repairCost: number;
  /** Knocked out at the start of the turn: no units, and nothing they can build. */
  out: boolean;
}

export interface Forecast {
  dealt: number;
  /** Counter-damage the attacker takes. */
  taken: number;
  kills: boolean;
  dies: boolean;
  counter: boolean;
}

export interface Reach {
  origin: number;
  /** Movement spent to reach each tile, or -1. */
  cost: Int16Array;
  /** The previous tile on the cheapest path, or -1. */
  prev: Int16Array;
  /** Tiles the unit can stop on: reachable and empty, plus where it is now. */
  ends: number[];
}

// ------------------------------------------------------------------ board

export function newBoard(m: MapDef, startFunds: readonly number[] = []): Board {
  return {
    units: [],
    owners: m.buildings.map((b) => b.owner),
    capture: m.buildings.map(() => CAPTURE_POINTS),
    funds: Array.from({ length: m.players }, (_, i) => startFunds[i] ?? 0),
    out: Array.from({ length: m.players }, () => false),
    nextId: 1,
  };
}

export function cloneBoard(b: Board): Board {
  return {
    units: b.units.map((u) => ({ ...u })),
    owners: [...b.owners],
    capture: [...b.capture],
    funds: [...b.funds],
    out: [...b.out],
    nextId: b.nextId,
  };
}

export const tileOf = (m: MapDef, x: number, y: number) => y * m.w + x;
export const tileX = (m: MapDef, t: number) => t % m.w;
export const tileY = (m: MapDef, t: number) => Math.floor(t / m.w);
export const unitTile = (m: MapDef, u: Unit) => u.y * m.w + u.x;

export function manhattan(m: MapDef, a: number, b: number): number {
  return Math.abs(tileX(m, a) - tileX(m, b)) + Math.abs(tileY(m, a) - tileY(m, b));
}

export function neighbours(m: MapDef, t: number): number[] {
  const x = t % m.w;
  const out: number[] = [];
  if (x > 0) out.push(t - 1);
  if (x < m.w - 1) out.push(t + 1);
  if (t >= m.w) out.push(t - m.w);
  if (t < m.w * (m.h - 1)) out.push(t + m.w);
  return out;
}

/** Each tile's unit, or undefined. */
export function occupancy(m: MapDef, b: Board): (Unit | undefined)[] {
  const occ: (Unit | undefined)[] = new Array(m.w * m.h);
  for (const u of b.units) occ[unitTile(m, u)] = u;
  return occ;
}

export function unitById(b: Board, id: number): Unit | undefined {
  return b.units.find((u) => u.id === id);
}

export function unitAtTile(m: MapDef, b: Board, t: number): Unit | undefined {
  return b.units.find((u) => unitTile(m, u) === t);
}

export function defenseAt(m: MapDef, t: number): number {
  return TERRAIN[m.tiles[t]].defense;
}

export function buildingsOf(b: Board, seat: number): number[] {
  const out: number[] = [];
  b.owners.forEach((o, i) => o === seat && out.push(i));
  return out;
}

export function unitsOf(b: Board, seat: number): Unit[] {
  return b.units.filter((u) => u.seat === seat);
}

export function incomeOf(b: Board, seat: number): number {
  return buildingsOf(b, seat).length * INCOME_PER_BUILDING;
}

/** The seats still in the game. */
export function seatsIn(b: Board): number[] {
  const out: number[] = [];
  b.out.forEach((o, i) => !o && out.push(i));
  return out;
}

/** The last seat standing, if there is one. */
export function winnerSeat(b: Board): number | null {
  const left = seatsIn(b);
  return left.length === 1 ? left[0] : null;
}

// ------------------------------------------------------------------ movement

/**
 * Where a unit can move: Dijkstra over its movement type's terrain costs, with its move points
 * as the budget. Enemy units block; the unit's own side's units can be passed through but not
 * stopped on. Costs are small integers, so a bucket queue does the job.
 */
export function reach(m: MapDef, b: Board, u: Unit, occ = occupancy(m, b), budget = UNITS[u.type].move): Reach {
  const n = m.w * m.h;
  const cost = new Int16Array(n).fill(-1);
  const prev = new Int16Array(n).fill(-1);
  const mt = UNITS[u.type].moveType;
  const origin = unitTile(m, u);
  const buckets: number[][] = [[origin]];
  cost[origin] = 0;
  for (let c = 0; c < buckets.length; c++) {
    const bucket = buckets[c];
    if (!bucket) continue;
    for (const t of bucket) {
      if (cost[t] !== c) continue;
      for (const nt of neighbours(m, t)) {
        const k = TERRAIN[m.tiles[nt]].cost[mt];
        if (k >= NO) continue;
        const nc = c + k;
        if (nc > budget) continue;
        const o = occ[nt];
        if (o && o.seat !== u.seat) continue;
        if (cost[nt] === -1 || nc < cost[nt]) {
          cost[nt] = nc;
          prev[nt] = t;
          (buckets[nc] ??= []).push(nt);
        }
      }
    }
  }
  const ends: number[] = [];
  for (let t = 0; t < n; t++) if (cost[t] >= 0 && (!occ[t] || t === origin)) ends.push(t);
  return { origin, cost, prev, ends };
}

export function pathTo(r: Reach, to: number): number[] {
  if (r.cost[to] < 0) return [];
  const path = [to];
  while (path[0] !== r.origin) path.unshift(r.prev[path[0]]);
  return path;
}

/**
 * Movement cost from every tile to the nearest of `goals` for a movement type, ignoring units:
 * how many move points a unit needs to get there over several turns. Infinity where it can't.
 * With `approach`, getting next to a goal is enough (to attack it), so a goal on terrain the
 * unit can't enter still counts.
 */
export function distanceField(m: MapDef, moveType: MoveType, goals: number[], approach = false): Float64Array {
  const n = m.w * m.h;
  const d = new Float64Array(n).fill(Infinity);
  // Costs are paid entering a tile, so walk backwards: the cost from t to its neighbour nt is nt's.
  const buckets: number[][] = [];
  for (const g of goals) {
    d[g] = 0;
    (buckets[0] ??= []).push(g);
  }
  const isGoal = approach ? new Set(goals) : null;
  for (let c = 0; c < buckets.length; c++) {
    const bucket = buckets[c];
    if (!bucket) continue;
    for (const t of bucket) {
      if (d[t] !== c) continue;
      const k = isGoal?.has(t) ? 0 : TERRAIN[m.tiles[t]].cost[moveType];
      if (k >= NO) continue;
      for (const nt of neighbours(m, t)) {
        if (TERRAIN[m.tiles[nt]].cost[moveType] >= NO) continue;
        const nc = c + k;
        if (nc < d[nt]) {
          d[nt] = nc;
          (buckets[nc] ??= []).push(nt);
        }
      }
    }
  }
  return d;
}

// ------------------------------------------------------------------ combat

/** Damage in HP: the table's base, scaled by the attacker's HP and cut by the defender's cover. */
export function damage(att: UnitType, attHp: number, def: UnitType, defHp: number, defStars: number): number {
  const num = DAMAGE[att][def] * attHp * (100 - defStars * defHp);
  return Math.max(0, Math.min(defHp, Math.floor((num + 5000) / 10000)));
}

export function inRange(m: MapDef, type: UnitType, from: number, to: number): boolean {
  const d = manhattan(m, from, to);
  return d >= UNITS[type].minRange && d <= UNITS[type].maxRange;
}

/** Whether a unit could attack from `from` this turn: indirect units only from where they started. */
export function canFireFrom(m: MapDef, u: Unit, from: number): boolean {
  return !isIndirect(u.type) || from === unitTile(m, u);
}

/** The enemies a unit could attack after moving to `from`. */
export function targetsFrom(m: MapDef, b: Board, u: Unit, from: number): Unit[] {
  if (!canFireFrom(m, u, from)) return [];
  return b.units.filter((t) => t.seat !== u.seat && inRange(m, u.type, from, unitTile(m, t)));
}

/** The attack's result both ways, with the attacker standing on `from`. */
export function forecast(m: MapDef, att: Unit, from: number, def: Unit): Forecast {
  const defTile = unitTile(m, def);
  const dealt = damage(att.type, att.hp, def.type, def.hp, defenseAt(m, defTile));
  const left = def.hp - dealt;
  const counter = left > 0 && !isIndirect(def.type) && inRange(m, def.type, defTile, from);
  const taken = counter ? damage(def.type, left, att.type, att.hp, defenseAt(m, from)) : 0;
  return { dealt, taken, kills: left <= 0, dies: taken >= att.hp, counter };
}

// ------------------------------------------------------------------ actions

function owns(b: Board, seat: number): boolean {
  return seat >= 0 && seat < b.out.length && !b.out[seat];
}

/** Why an action isn't allowed, in words for the player; null if it is. */
export function actProblem(m: MapDef, b: Board, seat: number, act: Act): string | null {
  if (!owns(b, seat)) return "You're out of this game";
  if (!act || typeof act !== "object") return "That's not a move";
  const u = unitById(b, Number(act.unit));
  if (!u) return "That unit isn't on the map";
  if (u.seat !== seat) return "That's not your unit";
  if (u.done) return `This ${UNITS[u.type].name} has already moved this turn`;
  const to = Number(act.to);
  if (!Number.isInteger(to) || to < 0 || to >= m.w * m.h) return "That's off the map";
  const occ = occupancy(m, b);
  const r = reach(m, b, u, occ);
  if (r.cost[to] < 0) return "It can't get there this turn";
  if (occ[to] && occ[to] !== u) return "Something is already there";
  switch (act.action) {
    case "wait":
      return null;
    case "capture": {
      if (!UNITS[u.type].captures) return `A ${UNITS[u.type].name} can't capture — only Infantry and Bazookas can`;
      const bi = m.buildingAt[to];
      if (bi < 0) return "There's no building there";
      if (b.owners[bi] === seat) return "You already own that building";
      return null;
    }
    case "attack": {
      if (isIndirect(u.type) && to !== r.origin) return `${UNITS[u.type].name} can't move and fire in the same turn`;
      const target = unitById(b, Number(act.target));
      if (!target) return "There's nothing to attack there";
      if (target.seat === seat) return "That's one of yours";
      if (!inRange(m, u.type, to, unitTile(m, target))) return "That target is out of range";
      return null;
    }
    default:
      return "Pick Attack, Capture or Wait";
  }
}

/** Carry out a legal action (check it with actProblem first). */
export function applyAct(m: MapDef, b: Board, seat: number, act: Act): ActEvent {
  const u = unitById(b, act.unit)!;
  const r = reach(m, b, u);
  const path = pathTo(r, act.to);
  const from = r.origin;
  const ev: ActEvent = { seat, unit: u.id, type: u.type, path, action: act.action };

  if (act.to !== from) resetCapture(m, b, from);
  u.x = tileX(m, act.to);
  u.y = tileY(m, act.to);
  u.done = true;

  if (act.action === "attack") {
    const target = unitById(b, act.target!)!;
    const f = forecast(m, u, act.to, target);
    target.hp -= f.dealt;
    u.hp -= f.taken;
    Object.assign(ev, {
      target: target.id,
      targetType: target.type,
      targetSeat: target.seat,
      dealt: f.dealt,
      taken: f.taken,
      killed: target.hp <= 0,
      lost: u.hp <= 0,
    });
    if (target.hp <= 0) removeUnit(m, b, target);
    if (u.hp <= 0) removeUnit(m, b, u);
  } else if (act.action === "capture") {
    const bi = m.buildingAt[act.to];
    b.capture[bi] -= u.hp;
    ev.building = bi;
    if (b.capture[bi] <= 0) {
      const prevOwner = b.owners[bi];
      b.owners[bi] = seat;
      b.capture[bi] = CAPTURE_POINTS;
      ev.captured = true;
      const home = m.hq.indexOf(bi);
      if (home >= 0 && prevOwner === home && !b.out[home]) {
        knockOut(m, b, home);
        (ev.out ??= []).push(home);
      }
    }
    ev.left = b.capture[bi];
  }

  for (const s of strandedSeats(m, b)) {
    knockOut(m, b, s);
    (ev.out ??= []).push(s);
  }
  return ev;
}

export function buildProblem(m: MapDef, b: Board, seat: number, at: number, type: unknown): string | null {
  if (!owns(b, seat)) return "You're out of this game";
  if (!isUnitType(type)) return "Unknown unit";
  const bi = m.buildingAt[Number(at)] ?? -1;
  if (bi < 0 || m.buildings[bi].kind !== "factory") return "Units are built at factories";
  if (b.owners[bi] !== seat) return "That factory isn't yours";
  if (unitAtTile(m, b, at)) return "Something is standing on that factory";
  if (b.funds[seat] < UNITS[type].cost)
    return `Not enough funds: a ${UNITS[type].name} costs ${UNITS[type].cost.toLocaleString("en-US")}`;
  return null;
}

/** Build a unit (check it with buildProblem first). It can't act until its owner's next turn. */
export function applyBuild(m: MapDef, b: Board, seat: number, at: number, type: UnitType): BuildEvent {
  b.funds[seat] -= UNITS[type].cost;
  const unit: Unit = { id: b.nextId++, type, seat, x: tileX(m, at), y: tileY(m, at), hp: MAX_HP, done: true };
  b.units.push(unit);
  return { seat, unit: { ...unit }, at };
}

/** The start of a seat's turn: funds from every building, then repairs. Can knock the seat out. */
export function startTurn(m: MapDef, b: Board, seat: number): TurnStart {
  for (const u of b.units) if (u.seat === seat) u.done = false;
  const income = incomeOf(b, seat);
  b.funds[seat] += income;
  const repairs: TurnStart["repairs"] = [];
  let repairCost = 0;
  const sorted = unitsOf(b, seat).sort((a, c) => a.id - c.id);
  for (const u of sorted) {
    const bi = m.buildingAt[unitTile(m, u)];
    if (bi < 0 || b.owners[bi] !== seat || u.hp >= MAX_HP) continue;
    const perHp = UNITS[u.type].cost / 10;
    const heal = Math.min(REPAIR_HP, MAX_HP - u.hp, Math.floor(b.funds[seat] / perHp));
    if (heal <= 0) continue;
    u.hp += heal;
    b.funds[seat] -= heal * perHp;
    repairCost += heal * perHp;
    repairs.push({ unit: u.id, hp: u.hp });
  }
  let out = false;
  if (unitsOf(b, seat).length === 0 && !canBuildAnything(m, b, seat)) {
    knockOut(m, b, seat);
    out = true;
  }
  return { seat, income, repairs, repairCost, out };
}

/** The end of a seat's turn: its units are ready again for next time. */
export function endTurn(b: Board, seat: number): void {
  for (const u of b.units) if (u.seat === seat) u.done = false;
}

/** Out of the game: units gone, buildings neutral (an HQ just captured stays with its captor). */
export function knockOut(m: MapDef, b: Board, seat: number): void {
  b.out[seat] = true;
  for (const u of unitsOf(b, seat)) removeUnit(m, b, u);
  b.owners.forEach((o, i) => {
    if (o === seat) b.owners[i] = -1;
  });
}

/** Seats that are still in but have no units and no factory, so can never act again. */
export function strandedSeats(m: MapDef, b: Board): number[] {
  return seatsIn(b).filter(
    (s) => !b.units.some((u) => u.seat === s) && !m.buildings.some((bd, i) => bd.kind === "factory" && b.owners[i] === s),
  );
}

export function canBuildAnything(m: MapDef, b: Board, seat: number): boolean {
  if (b.funds[seat] < CHEAPEST_UNIT) return false;
  const occ = occupancy(m, b);
  return m.buildings.some((bd, i) => bd.kind === "factory" && b.owners[i] === seat && !occ[tileOf(m, bd.x, bd.y)]);
}

function removeUnit(m: MapDef, b: Board, u: Unit): void {
  b.units = b.units.filter((o) => o !== u);
  resetCapture(m, b, unitTile(m, u));
}

/** The unit on this tile is leaving or gone, so any capture in progress there starts over. */
function resetCapture(m: MapDef, b: Board, t: number): void {
  const bi = m.buildingAt[t];
  if (bi >= 0) b.capture[bi] = CAPTURE_POINTS;
}

// ------------------------------------------------------------------ for the UI and the CPUs

/** Every action a unit could take this turn. */
export function optionsFor(m: MapDef, b: Board, u: Unit, occ = occupancy(m, b), r = reach(m, b, u, occ)): Act[] {
  const acts: Act[] = [];
  for (const to of r.ends) {
    acts.push({ unit: u.id, to, action: "wait" });
    const bi = m.buildingAt[to];
    if (UNITS[u.type].captures && bi >= 0 && b.owners[bi] !== u.seat) acts.push({ unit: u.id, to, action: "capture" });
    for (const t of targetsFrom(m, b, u, to)) acts.push({ unit: u.id, to, action: "attack", target: t.id });
  }
  return acts;
}

/** Tiles a unit could attack next turn: everywhere it can reach (or stand, if indirect), plus its range. */
export function threatTiles(m: MapDef, b: Board, u: Unit, occ = occupancy(m, b)): Set<number> {
  const out = new Set<number>();
  const def = UNITS[u.type];
  const froms = isIndirect(u.type) ? [unitTile(m, u)] : reach(m, b, u, occ).ends;
  for (const from of froms) {
    const fx = tileX(m, from);
    const fy = tileY(m, from);
    for (let dy = -def.maxRange; dy <= def.maxRange; dy++) {
      for (let dx = -def.maxRange; dx <= def.maxRange; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < def.minRange || d > def.maxRange) continue;
        const x = fx + dx;
        const y = fy + dy;
        if (x >= 0 && y >= 0 && x < m.w && y < m.h) out.add(tileOf(m, x, y));
      }
    }
  }
  return out;
}
