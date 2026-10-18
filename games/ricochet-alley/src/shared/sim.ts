import {
  BULLET_LIFE,
  BULLET_R,
  BULLET_SPEED,
  MAX_BULLETS,
  MUZZLE,
  REFIRE_TICKS,
  TANK_R,
  TANK_REVERSE,
  TANK_SPEED,
  TURN_RAMP,
} from "./constants";
import { castPath, inflate, pushApart, pushOutOfRect, segmentHitsCircle, type Path, type Vec } from "./geom";
import { COS, HEADINGS, SIN } from "./headings";
import { wallRects, type Maze, type Rect } from "./maze";

// Input bits. Clients send these whenever they change; the server holds them until the next change.
export const IN_UP = 1;
export const IN_DOWN = 2;
export const IN_LEFT = 4;
export const IN_RIGHT = 8;
export const IN_MASK = 15;

export interface Tank {
  id: string;
  x: number;
  y: number;
  /** Heading in steps of 360/HEADINGS degrees; see headings.ts. */
  h: number;
  /** Ticks the current turn key has been held: + right, − left, 0 not turning. Drives TURN_RAMP. */
  tt: number;
  alive: boolean;
  /** Ticks until it can fire again. */
  cd: number;
  /** A fire press waiting for the cooldown to run out. */
  fire: boolean;
}

export interface Bullet {
  id: number;
  /** Index of the tank that fired it. */
  o: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Ticks it has moved. It expires when this reaches BULLET_LIFE. */
  age: number;
}

export type SimEvent =
  | { k: "fire"; b: Bullet }
  | { k: "hit"; b: number; o: number; t: number; x: number; y: number }
  | { k: "expire"; b: number }
  /** A fire press refused because all of this tank's bullets are in flight. */
  | { k: "empty"; t: number };

export interface WorldSnapshot {
  tick: number;
  nextId: number;
  tanks: Tank[];
  bullets: Bullet[];
}

/** Tank positions live on a 1/64 grid, so they survive the trip to clients as integers, exactly. */
export const POS_SCALE = 64;
export const quantize = (v: number) => Math.round(v * POS_SCALE) / POS_SCALE;

/** The walls in the two forms the sim needs: as drawn (for tanks) and grown by the bullet radius (for bullets). */
export interface Walls {
  tank: Rect[];
  bullet: Rect[];
}

export function wallsFor(maze: Maze): Walls {
  const tank = wallRects(maze);
  return { tank, bullet: inflate(tank, BULLET_R) };
}

/**
 * One tick of driving: turn, move, then slide out of walls and other tanks. `others` are treated as fixed,
 * so tanks block each other rather than push. Shared by the server and by the client predicting its own tank.
 */
export function moveTank(t: Vec & { h: number; tt: number }, bits: number, walls: Rect[], others: readonly Vec[]): void {
  const turn = (bits & IN_RIGHT ? 1 : 0) - (bits & IN_LEFT ? 1 : 0);
  if (turn === 0) {
    t.tt = 0;
  } else {
    t.tt = Math.sign(t.tt) === turn ? t.tt + turn : turn;
    const held = Math.min(Math.abs(t.tt), TURN_RAMP.length) - 1;
    t.h = (t.h + turn * TURN_RAMP[held] + HEADINGS) % HEADINGS;
  }
  const speed = (bits & IN_UP ? TANK_SPEED : 0) - (bits & IN_DOWN ? TANK_REVERSE : 0);
  if (speed) {
    t.x += speed * COS[t.h];
    t.y += speed * SIN[t.h];
  }
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const w of walls) moved = pushOutOfRect(t, TANK_R, w) || moved;
    for (const o of others) moved = pushApart(t, o, TANK_R * 2) || moved;
    if (!moved) break;
  }
  for (const w of walls) pushOutOfRect(t, TANK_R, w);
  t.x = quantize(t.x);
  t.y = quantize(t.y);
}

/**
 * Move a bullet one tick against the (bullet-grown) walls. Returns its path for hit tests, or null if it has
 * run out of life and should go. Clients run this too, so bullets fly identically everywhere.
 */
export function moveBullet(b: Bullet, walls: Rect[]): Path | null {
  if (b.age >= BULLET_LIFE) return null;
  const p = castPath(walls, b.x, b.y, b.vx, b.vy);
  b.x = p.x;
  b.y = p.y;
  b.vx = p.vx;
  b.vy = p.vy;
  b.age++;
  return p;
}

/** A fresh bullet leaving tank `t` (index `o`), already moved out to the muzzle (bouncing if a wall is closer). */
export function spawnBullet(id: number, o: number, t: Tank, walls: Rect[]): Bullet {
  const vx = BULLET_SPEED * COS[t.h];
  const vy = BULLET_SPEED * SIN[t.h];
  const p = castPath(walls, t.x, t.y, vx, vy, MUZZLE / BULLET_SPEED);
  return { id, o, x: p.x, y: p.y, vx: p.vx, vy: p.vy, age: 0 };
}

/** The authoritative round: tanks and bullets in one maze. The server steps it; clients only borrow parts. */
export class World {
  tick: number;
  nextId: number;
  tanks: Tank[];
  bullets: Bullet[];
  readonly walls: Walls;

  constructor(
    readonly maze: Maze,
    snap: WorldSnapshot,
  ) {
    this.walls = wallsFor(maze);
    this.tick = snap.tick;
    this.nextId = snap.nextId;
    this.tanks = snap.tanks.map((t) => ({ ...t }));
    this.bullets = snap.bullets.map((b) => ({ ...b }));
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      nextId: this.nextId,
      tanks: this.tanks.map((t) => ({ ...t })),
      bullets: this.bullets.map((b) => ({ ...b })),
    };
  }

  get aliveCount(): number {
    let n = 0;
    for (const t of this.tanks) if (t.alive) n++;
    return n;
  }

  bulletsOf(o: number): number {
    let n = 0;
    for (const b of this.bullets) if (b.o === o) n++;
    return n;
  }

  requestFire(i: number): void {
    const t = this.tanks[i];
    if (t?.alive) t.fire = true;
  }

  /**
   * Advance one tick. Bullets move first, against tanks where they stood, then tanks drive, then new shots
   * leave the muzzles. That order means a bullet always pulls away from the tank that fired it.
   */
  step(inputs: ArrayLike<number>): SimEvent[] {
    const events: SimEvent[] = [];
    this.tick++;

    for (let i = 0; i < this.bullets.length;) {
      const b = this.bullets[i];
      const path = moveBullet(b, this.walls.bullet);
      if (!path) {
        events.push({ k: "expire", b: b.id });
        this.bullets.splice(i, 1);
        continue;
      }
      const hit = this.firstTankOnPath(path.pts);
      if (hit) {
        this.tanks[hit.t].alive = false;
        this.tanks[hit.t].fire = false;
        this.tanks[hit.t].tt = 0;
        events.push({ k: "hit", b: b.id, o: b.o, t: hit.t, x: hit.x, y: hit.y });
        this.bullets.splice(i, 1);
        continue;
      }
      i++;
    }

    const others: Vec[] = [];
    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i];
      if (!t.alive) continue;
      others.length = 0;
      for (const o of this.tanks) if (o !== t && o.alive) others.push(o);
      moveTank(t, (inputs[i] ?? 0) & IN_MASK, this.walls.tank, others);
    }

    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i];
      if (t.cd > 0) t.cd--;
      if (!t.alive || !t.fire || t.cd > 0) continue;
      t.fire = false;
      if (this.bulletsOf(i) >= MAX_BULLETS) {
        events.push({ k: "empty", t: i });
        continue;
      }
      const b = spawnBullet(this.nextId++, i, t, this.walls.bullet);
      this.bullets.push(b);
      t.cd = REFIRE_TICKS;
      events.push({ k: "fire", b: { ...b } });
    }
    return events;
  }

  /** The first live tank a bullet path touches, and where. */
  firstTankOnPath(pts: number[]): { t: number; x: number; y: number } | null {
    const reach = TANK_R + BULLET_R;
    for (let p = 0; p + 3 < pts.length; p += 2) {
      const ax = pts[p];
      const ay = pts[p + 1];
      const bx = pts[p + 2];
      const by = pts[p + 3];
      let best = Infinity;
      let who = -1;
      for (let i = 0; i < this.tanks.length; i++) {
        const t = this.tanks[i];
        if (!t.alive) continue;
        const u = segmentHitsCircle(ax, ay, bx, by, t.x, t.y, reach);
        if (u >= 0 && u < best) {
          best = u;
          who = i;
        }
      }
      if (who >= 0) return { t: who, x: ax + (bx - ax) * best, y: ay + (by - ay) * best };
    }
    return null;
  }
}

/** Tanks for a new round, one per spawn point, facing the open side they were given. */
export function startingTanks(ids: string[], spawns: { x: number; y: number; dir: number }[]): Tank[] {
  return ids.map((id, i) => ({
    id,
    x: quantize(spawns[i].x),
    y: quantize(spawns[i].y),
    h: (spawns[i].dir * HEADINGS) / 4,
    tt: 0,
    alive: true,
    cd: 0,
    fire: false,
  }));
}
