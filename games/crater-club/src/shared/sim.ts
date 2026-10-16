import {
  BARREL_LEN,
  GRAVITY,
  MAX_POWER,
  MAX_SPEED,
  TANK_H,
  TANK_HALF_W,
  TICKS_PER_SEC,
  TURRET_Y,
  WIND_ACCEL,
  WORLD_H,
  WORLD_W,
} from "./constants";
import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import { addDirt, carveCrater, cutColumn, supportHeight } from "./terrain";
import { WEAPONS, type WeaponDef, type WeaponId, type WeaponKind } from "./weapons";

// The shot simulation. Server and clients run this same code on the same inputs:
// the server to get the authoritative result, clients to animate it. Launch
// velocities are computed once (with trig) by the server and passed in, so the
// stepping itself only uses + - * / sqrt and a seeded PRNG, all of which are
// bit-identical across JS engines.

export type WallMode = "open" | "bounce" | "wrap";

export interface SimTankInit {
  id: string;
  x: number;
  y: number;
  health: number;
  alive: boolean;
  shield: number;
  parachutes: number;
}

export interface SimTank extends SimTankInit {
  falling: boolean;
  fallStart: number;
  fallVy: number;
  chute: boolean;
  /** Ticks until the tank blows up; -1 when not dying. */
  dyingIn: number;
  lastHitBy: string | null;
  /** Napalm burn not yet taken off its health. */
  heat: number;
}

export interface ShotInput {
  shooterId: string;
  weapon: WeaponId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  seed: number;
}

export interface Projectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: WeaponKind;
  def: WeaponDef;
  radius: number;
  damage: number;
  rolling: boolean;
  dir: number;
  canSplit: boolean;
  bouncesLeft: number;
  age: number;
  /** Ticks during which this projectile passes through tanks (spawned inside a blast). */
  tankGrace: number;
  /** Sandhog: digging sideways through the dirt. */
  burrowing: boolean;
  /** Laser and burrowing sandhog: how much further it goes, in px. */
  range: number;
  /** Laser: the tanks it has burned, which it doesn't burn twice. */
  hits: string[];
}

/** A blob of burning napalm. Blobs run downhill and pile up into pools. */
export interface Flame {
  id: number;
  x: number;
  /** The middle of the blob: on the ground, or on the blobs under it. */
  y: number;
  dir: number;
  /** Ticks until it burns out. */
  life: number;
  /** Health per tick it burns off a tank it touches (up to ENGULF blobs' worth). */
  burn: number;
}

export interface Explosion {
  id: number;
  x: number;
  y: number;
  r: number;
  damage: number;
  owner: string;
  age: number;
  peak: number;
  life: number;
  dirt: boolean;
  death: boolean;
  applied: boolean;
  children: Projectile[];
}

export type SimEvent =
  | { type: "fire"; x: number; y: number; weapon: WeaponId }
  | { type: "explode"; x: number; y: number; r: number; dirt: boolean; death: boolean }
  | { type: "damage"; id: string; amount: number; by: string }
  | { type: "shield"; id: string }
  | { type: "kill"; id: string; by: string }
  | { type: "split"; x: number; y: number }
  | { type: "chute"; id: string }
  | { type: "land"; id: string; dist: number }
  | { type: "puff"; x: number; y: number }
  | { type: "napalm"; x: number; y: number }
  | { type: "burrow"; x: number; y: number }
  | { type: "zap"; x: number; y: number };

export interface WorldInit {
  heights: number[];
  tanks: SimTankInit[];
  wind: number;
  walls: WallMode;
}

export interface Impact {
  x: number;
  y: number;
  tankId: string | null;
  offMap: boolean;
}

const MAX_FLIGHT_TICKS = 60 * 30;
const MAX_SHOT_TICKS = 60 * 120;
const DEATH_DELAY = 18;
const FALL_SAFE = 10;
const FALL_DAMAGE_PER_PX = 0.5;
/** The laser's speed, in px per tick, and the radius of the groove it cuts. */
const LASER_SPEED = 20;
const LASER_CUT = 4;
/** A sandhog stays at least this deep, digs this many px a tick, and cuts a tunnel this high. */
const BURROW_DEPTH = 10;
const BURROW_SPEED = 3;
const BURROW_CUT = 4;
/** How far above a sandhog a tank can be for it to go off underneath. */
const BURROW_SENSE = 80;
/**
 * How much a blob of napalm raises its pool, how many columns it can run in a tick, and how far
 * along it looks for lower ground (so it runs down gentle slopes, which are steps of flat columns).
 */
const FLAME_H = 2;
const FLAME_RUN = 2;
const FLAME_LOOK = 4;
/** A tank touched by this many blobs burns at the napalm's full rate. Burns land every BURN_EVERY ticks. */
const ENGULF = 12;
const BURN_EVERY = 20;

export function launchFor(tank: { x: number; y: number }, angleDeg: number, power: number) {
  const rad = (angleDeg * Math.PI) / 180;
  const speed = (power / MAX_POWER) * MAX_SPEED;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: tank.x + c * BARREL_LEN,
    y: tank.y + TURRET_Y + s * BARREL_LEN,
    vx: c * speed,
    vy: s * speed,
  };
}

/**
 * Damaged tanks can't fire as hard, as in the original — but a nearly dead
 * tank can still lob a shell a few hundred pixels instead of at its own feet.
 */
export function maxPowerFor(health: number): number {
  return Math.min(MAX_POWER, Math.round(400 + 6 * Math.max(0, health)));
}

export class World {
  heights: number[];
  tanks: SimTank[];
  wind: number;
  walls: WallMode;
  projectiles: Projectile[] = [];
  explosions: Explosion[] = [];
  flames: Flame[] = [];
  events: SimEvent[] = [];
  tick = 0;
  terrainVersion = 0;
  shooterId = "";
  private rng: Rng = mulberry32(1);
  private nextId = 1;
  private lastImpact: Impact | null = null;
  /** Napalm blobs in each column. */
  private pool: number[] | null = null;

  constructor(init: WorldInit) {
    this.heights = init.heights.slice();
    this.wind = init.wind;
    this.walls = init.walls;
    this.tanks = init.tanks.map((t) => ({
      ...t,
      falling: false,
      fallStart: t.y,
      fallVy: 0,
      chute: false,
      dyingIn: -1,
      lastHitBy: null,
      heat: 0,
    }));
  }

  get done(): boolean {
    return (
      this.projectiles.length === 0 &&
      this.explosions.length === 0 &&
      this.flames.length === 0 &&
      this.tanks.every((t) => !t.falling && t.dyingIn < 0)
    );
  }

  get timedOut(): boolean {
    return this.tick >= MAX_SHOT_TICKS;
  }

  fire(shot: ShotInput): void {
    this.shooterId = shot.shooterId;
    this.rng = mulberry32(shot.seed);
    const def = WEAPONS[shot.weapon];
    this.projectiles.push(this.makeProjectile(def, shot.x, shot.y, shot.vx, shot.vy));
    this.events.push({ type: "fire", x: shot.x, y: shot.y, weapon: shot.weapon });
  }

  runToEnd(): void {
    while (!this.done && !this.timedOut) this.step();
  }

  step(): void {
    this.tick++;

    const flying = this.projectiles;
    this.projectiles = [];
    for (const p of flying) {
      if (this.updateProjectile(p)) this.projectiles.push(p);
    }

    const blasts = this.explosions;
    this.explosions = [];
    for (const e of blasts) {
      e.age++;
      if (!e.applied && e.age >= e.peak) this.applyExplosion(e);
      if (e.age < e.life) this.explosions.push(e);
    }

    if (this.flames.length > 0) this.updateFlames();

    for (const t of this.tanks) {
      if (t.dyingIn > 0 && --t.dyingIn === 0) this.destroy(t);
    }

    for (const t of this.tanks) this.updateFalling(t);
  }

  /** Where would a shot first land? Used by the CPU players; leaves the world untouched. */
  traceImpact(launch: { x: number; y: number; vx: number; vy: number }): Impact {
    const nEvents = this.events.length;
    const p = this.makeProjectile(WEAPONS.tracer, launch.x, launch.y, launch.vx, launch.vy);
    this.lastImpact = null;
    while (this.updateProjectile(p)) {
      /* keep flying */
    }
    this.events.length = nEvents;
    return this.lastImpact ?? { x: p.x, y: p.y, tankId: null, offMap: true };
  }

  private makeProjectile(def: WeaponDef, x: number, y: number, vx: number, vy: number): Projectile {
    let range = 0;
    if (def.kind === "laser") {
      // The beam always goes at the same speed; power only sets how far.
      const speed = Math.sqrt(vx * vx + vy * vy);
      range = (def.reach ?? 0) * Math.min(1, speed / MAX_SPEED);
      vx = speed > 0 ? (vx / speed) * LASER_SPEED : 0;
      vy = speed > 0 ? (vy / speed) * LASER_SPEED : 0;
    }
    return {
      id: this.nextId++,
      x,
      y,
      vx,
      vy,
      kind: def.kind,
      def,
      radius: def.radius,
      damage: def.damage,
      rolling: false,
      dir: 1,
      canSplit: def.kind === "mirv",
      bouncesLeft: def.bounces ?? 0,
      age: 0,
      tankGrace: 0,
      burrowing: false,
      range,
      hits: [],
    };
  }

  /** Advance one projectile by a tick. Returns false once it is gone. */
  private updateProjectile(p: Projectile): boolean {
    p.age++;
    if (p.age > MAX_FLIGHT_TICKS) {
      if (p.rolling || p.burrowing) this.explode(p.x, p.y, p.radius, p.damage);
      return false;
    }
    if (p.rolling) return this.rollStep(p);
    if (p.burrowing) return this.burrowStep(p);
    if (p.kind === "laser") return this.beamStep(p);

    p.vx += this.wind * WIND_ACCEL;
    p.vy -= GRAVITY;

    if (p.canSplit && p.vy <= 0) {
      this.split(p);
      return false;
    }

    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const n = Math.max(1, Math.ceil(speed / 1.5));
    let sx = p.vx / n;
    const sy = p.vy / n;
    for (let i = 0; i < n; i++) {
      p.x += sx;
      p.y += sy;
      if (p.x < 0 || p.x >= WORLD_W) {
        if (this.walls === "open") {
          this.lastImpact = { x: p.x, y: p.y, tankId: null, offMap: true };
          return false;
        }
        if (this.walls === "wrap") {
          p.x = p.x < 0 ? p.x + WORLD_W : p.x - WORLD_W;
        } else {
          p.x = p.x < 0 ? -p.x : 2 * WORLD_W - p.x;
          if (p.x >= WORLD_W) p.x = WORLD_W - 0.01;
          p.vx = -p.vx;
          sx = -sx;
        }
      }
      if (p.y <= 0) {
        this.impact(p, p.x, 0, null);
        return p.rolling || p.burrowing;
      }
      if (p.tankGrace <= 0) {
        const t = this.tankAt(p.x, p.y);
        if (t) {
          this.impact(p, p.x, p.y, t);
          return p.rolling || p.burrowing;
        }
      }
      if (p.y <= this.heights[Math.floor(p.x)]) {
        this.impact(p, p.x, p.y, null);
        return p.rolling || p.burrowing;
      }
    }
    if (p.tankGrace > 0) p.tankGrace--;
    return true;
  }

  private rollStep(p: Projectile): boolean {
    for (let s = 0; s < 2; s++) {
      const c = p.x;
      let nx = c + p.dir;
      if (nx < 0 || nx >= WORLD_W) {
        if (this.walls === "bounce") {
          p.dir = -p.dir;
          continue;
        }
        if (this.walls === "wrap") {
          nx = (nx + WORLD_W) % WORLD_W;
        } else {
          this.explode(c, this.heights[c], p.radius, p.damage);
          return false;
        }
      }
      for (const t of this.tanks) {
        if (t.alive && Math.abs(nx - t.x) <= TANK_HALF_W && p.y >= t.y - 6 && p.y <= t.y + TANK_H) {
          this.explode(nx, Math.max(p.y, t.y + 3), p.radius, p.damage);
          return false;
        }
      }
      const nh = this.heights[nx];
      if (nh > this.heights[c] + 1) {
        this.explode(c, this.heights[c], p.radius, p.damage);
        return false;
      }
      p.x = nx;
      p.y = nh;
    }
    return true;
  }

  /** A laser goes dead straight, cutting through dirt and every tank in its way, until its range runs out. */
  private beamStep(p: Projectile): boolean {
    const n = 10;
    let sx = p.vx / n;
    const sy = p.vy / n;
    const len = LASER_SPEED / n;
    let cut = false;
    let going = true;
    for (let i = 0; i < n && going; i++) {
      p.x += sx;
      p.y += sy;
      p.range -= len;
      if (p.x < 0 || p.x >= WORLD_W) {
        if (this.walls === "open") break;
        if (this.walls === "wrap") {
          p.x = p.x < 0 ? p.x + WORLD_W : p.x - WORLD_W;
        } else {
          p.x = p.x < 0 ? -p.x : 2 * WORLD_W - p.x;
          if (p.x >= WORLD_W) p.x = WORLD_W - 0.01;
          p.vx = -p.vx;
          sx = -sx;
        }
      }
      const t = this.tankAt(p.x, p.y);
      if (t && t.health > 0 && !p.hits.includes(t.id)) {
        p.hits.push(t.id);
        this.events.push({ type: "zap", x: p.x, y: p.y });
        this.hurt(t, p.damage, this.shooterId, true);
      }
      if (carveCrater(this.heights, p.x, p.y, LASER_CUT)) cut = true;
      going = p.range > 0 && p.y <= WORLD_H;
    }
    if (cut) this.terrainVersion++;
    return going && p.x >= 0 && p.x < WORLD_W;
  }

  /**
   * A sandhog digs sideways: level through hills, and down to stay underground where the ground
   * drops away. It goes off under the first tank it reaches, at a wall, or when it has dug its reach.
   */
  private burrowStep(p: Projectile): boolean {
    let cut = false;
    let going = true;
    for (let i = 0; i < BURROW_SPEED && going; i++) {
      const nx = this.nextColumn(p.x, p.dir);
      const under = this.tanks.some(
        (t) => t.alive && Math.abs(p.x - t.x) <= TANK_HALF_W - 3 && t.y >= p.y && t.y - p.y <= BURROW_SENSE,
      );
      if (nx < 0 || under || --p.range <= 0) {
        p.burrowing = false;
        this.explode(p.x, p.y, p.radius, p.damage);
        going = false;
        break;
      }
      p.x = nx;
      p.y = Math.max(4, Math.min(p.y, this.heights[nx] - BURROW_DEPTH));
      if (cutColumn(this.heights, nx, p.y - BURROW_CUT, p.y + BURROW_CUT)) cut = true;
    }
    if (cut) this.terrainVersion++;
    return going;
  }

  private tankAt(x: number, y: number): SimTank | null {
    for (const t of this.tanks) {
      if (t.alive && Math.abs(x - t.x) <= TANK_HALF_W && y >= t.y - 1 && y <= t.y + TANK_H + 4) return t;
    }
    return null;
  }

  private impact(p: Projectile, x: number, y: number, tank: SimTank | null): void {
    this.lastImpact = { x, y, tankId: tank?.id ?? null, offMap: false };
    switch (p.kind) {
      case "tracer":
        this.events.push({ type: "puff", x, y });
        return;
      case "dirt":
        this.explode(x, y, p.radius, 0, { dirt: true });
        return;
      case "napalm":
        this.spill(p.def, x, y);
        return;
      case "sandhog":
        if (tank) {
          this.explode(x, y, p.radius, p.damage);
          return;
        }
        // Dig in under where it landed and set off sideways, the way it was going.
        p.burrowing = true;
        p.x = Math.min(WORLD_W - 1, Math.max(0, Math.round(x)));
        p.y = Math.max(4, Math.min(y, this.heights[p.x]) - BURROW_DEPTH);
        p.dir = p.vx >= 0 ? 1 : -1;
        p.range = p.def.reach ?? 0;
        this.events.push({ type: "burrow", x, y });
        return;
      case "roller": {
        if (!tank && !p.rolling) {
          const c = Math.min(WORLD_W - 1, Math.max(0, Math.round(x)));
          const l = this.heights[Math.max(0, c - 4)];
          const r = this.heights[Math.min(WORLD_W - 1, c + 4)];
          p.rolling = true;
          p.x = c;
          p.y = this.heights[c];
          p.dir = l < r ? -1 : r < l ? 1 : p.vx >= 0 ? 1 : -1;
          return;
        }
        p.rolling = false;
        this.explode(x, y, p.radius, p.damage);
        return;
      }
      case "funky": {
        const children: Projectile[] = [];
        const def = p.def;
        for (let i = 0; i < (def.bomblets ?? 0); i++) {
          const vx = (this.rng() * 2 - 1) * 4.5;
          const vy = 2.5 + this.rng() * 5;
          const child = this.makeProjectile(WEAPONS.baby_missile, x, y + 2, vx, vy);
          child.radius = def.bombletRadius ?? 20;
          child.damage = def.bombletDamage ?? 30;
          child.tankGrace = 6;
          children.push(child);
        }
        this.explode(x, y, p.radius, p.damage, { children });
        return;
      }
      case "leapfrog": {
        const children: Projectile[] = [];
        if (p.bouncesLeft > 0) {
          const hop = this.makeProjectile(p.def, x, y + 2, p.vx * 0.85, Math.max(2.5, Math.abs(p.vy) * 0.55));
          hop.bouncesLeft = p.bouncesLeft - 1;
          hop.radius = p.radius - 4;
          hop.damage = p.damage - 5;
          hop.tankGrace = 6;
          children.push(hop);
        }
        this.explode(x, y, p.radius, p.damage, { children });
        return;
      }
      default:
        this.explode(x, y, p.radius, p.damage);
    }
  }

  /** Napalm splashes burning fuel around where it lands. */
  private spill(def: WeaponDef, x: number, y: number): void {
    const pool = (this.pool ??= new Array<number>(WORLD_W).fill(0));
    const cx = Math.min(WORLD_W - 1, Math.max(0, Math.round(x)));
    const fuel = def.fuel ?? 0;
    const spread = 2 + fuel / 6;
    const life = (def.burnSecs ?? 4) * TICKS_PER_SEC;
    const burn = (def.burn ?? 0) / TICKS_PER_SEC / ENGULF;
    for (let i = 0; i < fuel; i++) {
      const fx = Math.min(WORLD_W - 1, Math.max(0, Math.round(cx + (this.rng() * 2 - 1) * spread)));
      const dir = this.rng() < 0.5 ? -1 : 1;
      this.flames.push({ id: this.nextId++, x: fx, y: 0, dir, life: Math.round(life * (0.6 + 0.4 * this.rng())), burn });
      pool[fx]++;
    }
    this.stackFlames();
    this.events.push({ type: "napalm", x: cx, y });
  }

  /** Napalm burns out, runs downhill and burns the tanks it touches. */
  private updateFlames(): void {
    const pool = this.pool!;
    const lit: Flame[] = [];
    for (const f of this.flames) {
      if (--f.life > 0) lit.push(f);
      else pool[f.x]--;
    }
    this.flames = lit;

    // A blob runs towards the nearer of the columns, either side, where the top of the pool is
    // below where it sits, unless the pool rises above it on the way.
    const downhill = (x: number, dir: number, at: number): number => {
      for (let j = 1, c = x; j <= FLAME_LOOK; j++) {
        c = this.nextColumn(c, dir);
        if (c < 0) return 0;
        const top = this.heights[c] + pool[c] * FLAME_H;
        if (top > at) return 0;
        if (top < at) return j;
      }
      return 0;
    };
    for (let run = 0; run < FLAME_RUN; run++) {
      for (const f of this.flames) {
        const at = this.heights[f.x] + (pool[f.x] - 1) * FLAME_H;
        const l = downhill(f.x, -1, at);
        const r = downhill(f.x, 1, at);
        if (!l && !r) continue;
        const dir = !r || (l && l < r) ? -1 : !l || r < l ? 1 : f.dir;
        const to = this.nextColumn(f.x, dir);
        pool[f.x]--;
        pool[to]++;
        f.x = to;
        f.dir = dir;
      }
    }
    this.stackFlames();

    for (const t of this.tanks) {
      if (!t.alive || t.health <= 0) continue;
      let heat = 0;
      let hottest = 0;
      for (const f of this.flames) {
        if (Math.abs(f.x - t.x) > TANK_HALF_W || f.y < t.y - 6 || f.y > t.y + TANK_H + 4) continue;
        heat += f.burn;
        if (f.burn > hottest) hottest = f.burn;
      }
      t.heat += Math.min(heat, hottest * ENGULF);
    }
    // Burns land a few times a second, and what's left when the fire goes out.
    const out = this.flames.length === 0;
    if (!out && this.tick % BURN_EVERY !== 0) return;
    for (const t of this.tanks) {
      const dmg = out ? Math.round(t.heat) : Math.floor(t.heat);
      t.heat = out ? 0 : t.heat - dmg;
      if (dmg > 0 && t.alive && t.health > 0) this.hurt(t, dmg, this.shooterId, true);
    }
  }

  /** The column next to x, or -1 for a wall. */
  private nextColumn(x: number, dir: number): number {
    const n = x + dir;
    if (n >= 0 && n < WORLD_W) return n;
    return this.walls === "wrap" ? (n + WORLD_W) % WORLD_W : -1;
  }

  /** Put each blob of napalm on the ground, or on top of the blobs already in its column. */
  private stackFlames(): void {
    const level = new Map<number, number>();
    for (const f of this.flames) {
      const k = level.get(f.x) ?? 0;
      level.set(f.x, k + 1);
      f.y = this.heights[f.x] + k * FLAME_H + FLAME_H / 2;
    }
  }

  private split(p: Projectile): void {
    const n = p.def.warheads ?? 5;
    const spread = p.def.spread ?? 0.7;
    for (let i = 0; i < n; i++) {
      const head = this.makeProjectile(WEAPONS.baby_missile, p.x, p.y, p.vx + (i - (n - 1) / 2) * spread, p.vy);
      head.radius = p.radius;
      head.damage = p.damage;
      this.projectiles.push(head);
    }
    this.events.push({ type: "split", x: p.x, y: p.y });
  }

  private explode(
    x: number,
    y: number,
    r: number,
    damage: number,
    opts: { dirt?: boolean; death?: boolean; owner?: string; children?: Projectile[] } = {},
  ): void {
    const peak = 6 + Math.floor(r / 5);
    this.explosions.push({
      id: this.nextId++,
      x,
      y,
      r,
      damage,
      owner: opts.owner ?? this.shooterId,
      age: 0,
      peak,
      life: peak + 14 + Math.floor(r / 8),
      dirt: !!opts.dirt,
      death: !!opts.death,
      applied: false,
      children: opts.children ?? [],
    });
    this.events.push({ type: "explode", x, y, r, dirt: !!opts.dirt, death: !!opts.death });
  }

  private applyExplosion(e: Explosion): void {
    e.applied = true;
    if (e.dirt) addDirt(this.heights, e.x, e.y, e.r);
    else carveCrater(this.heights, e.x, e.y, e.r);
    this.terrainVersion++;

    if (e.damage > 0) {
      const reach = e.r + TANK_HALF_W;
      for (const t of this.tanks) {
        if (!t.alive || t.health <= 0) continue;
        const dx = t.x - e.x;
        const dy = t.y + TANK_H / 2 - e.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= reach) continue;
        const dmg = Math.round(e.damage * (1 - d / reach));
        if (dmg > 0) this.hurt(t, dmg, e.owner, true);
      }
    }
    for (const c of e.children) this.projectiles.push(c);
  }

  private hurt(t: SimTank, dmg: number, by: string, shieldable: boolean): void {
    if (shieldable && t.shield > 0) {
      const absorbed = Math.min(t.shield, dmg);
      t.shield -= absorbed;
      dmg -= absorbed;
      this.events.push({ type: "shield", id: t.id });
    }
    if (dmg <= 0) return;
    const real = Math.min(dmg, t.health);
    t.health -= real;
    t.lastHitBy = by;
    this.events.push({ type: "damage", id: t.id, amount: real, by });
    if (t.health <= 0 && t.dyingIn < 0) t.dyingIn = DEATH_DELAY;
  }

  private destroy(t: SimTank): void {
    t.dyingIn = -1;
    t.alive = false;
    t.health = 0;
    t.shield = 0;
    const by = t.lastHitBy ?? this.shooterId;
    this.events.push({ type: "kill", id: t.id, by });
    this.explode(t.x, t.y + 4, 32, 35, { death: true, owner: by });
  }

  private updateFalling(t: SimTank): void {
    const support = supportHeight(this.heights, t.x);
    if (!t.falling) {
      if (t.y <= support) return;
      t.falling = true;
      t.fallStart = t.y;
      t.fallVy = 0;
    }
    if (!t.chute && t.alive && t.parachutes > 0 && t.fallStart - t.y > 4) {
      t.chute = true;
      t.parachutes--;
      this.events.push({ type: "chute", id: t.id });
    }
    if (t.chute) {
      t.y -= 1;
    } else {
      t.fallVy = Math.min(t.fallVy + 0.2, 8);
      t.y -= t.fallVy;
    }
    if (t.y <= support) {
      t.y = support;
      t.falling = false;
      const dist = t.fallStart - t.y;
      this.events.push({ type: "land", id: t.id, dist });
      if (!t.chute && t.alive && dist > FALL_SAFE) {
        this.hurt(t, Math.round((dist - FALL_SAFE) * FALL_DAMAGE_PER_PX), this.shooterId, false);
      }
      t.chute = false;
    }
  }
}
