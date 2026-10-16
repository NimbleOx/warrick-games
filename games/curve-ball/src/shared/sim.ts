import {
  ARENA_H,
  ARENA_W,
  GAP_EVERY_SECONDS,
  GAP_PX,
  HEADINGS,
  LINE_RADIUS,
  SPEEDS,
  SUBSTEPS,
  TICKS_PER_SEC,
  type Speed,
} from "./constants";
import { COS, SIN, wrapHeading } from "./headings";
import { mulberry32, randInt, rngStep, type Rng } from "@warrick/kit/shared/rng";

/** −1 turns left (counter-clockwise on screen), 1 turns right, 0 goes straight. */
export type Steer = -1 | 0 | 1;

export function isSteer(v: unknown): v is Steer {
  return v === -1 || v === 0 || v === 1;
}

export interface RoundConfig {
  w: number;
  h: number;
  /** px per tick. */
  speed: number;
  /** Heading units per sub-step while steering. */
  turn: number;
  /** Half the trail's width, in px. */
  radius: number;
  /** Ticks of painting between gaps, inclusive range. */
  gapMin: number;
  gapMax: number;
  /** Ticks a gap lasts. */
  gapTicks: number;
}

export function configFor(speed: Speed): RoundConfig {
  const s = SPEEDS[speed];
  return {
    w: ARENA_W,
    h: ARENA_H,
    speed: s.speed,
    turn: s.turn,
    radius: LINE_RADIUS,
    gapMin: Math.round(GAP_EVERY_SECONDS[0] * TICKS_PER_SEC),
    gapMax: Math.round(GAP_EVERY_SECONDS[1] * TICKS_PER_SEC),
    gapTicks: Math.max(1, Math.ceil(GAP_PX / s.speed)),
  };
}

/** What a round is built from. Add the input log and it can be rebuilt at any tick. */
export interface RoundSetup {
  cfg: RoundConfig;
  seed: number;
  /** Player ids in slot order. */
  ids: string[];
}

/** At the start of `tick`, head `slot` starts steering `steer`. */
export type Input = [tick: number, slot: number, steer: Steer];

export interface Head {
  id: string;
  x: number;
  y: number;
  /** 0 … HEADINGS − 1; 0 points right. */
  heading: number;
  steer: Steer;
  alive: boolean;
  /** Tick it died on, or -1. */
  diedAt: number;
  /** Ticks left in the current gap; 0 while painting. */
  gap: number;
  /** Ticks of painting until the next gap. */
  nextGap: number;
  /** State of this head's gap generator. */
  rng: number;
  // Movement, copied from the config at spawn. Power-ups can change these per head.
  speed: number;
  turn: number;
  radius: number;
  /** Points this round: one for each head that died while this one was still alive. */
  points: number;
}

export interface Death {
  slot: number;
  /** The slot whose trail or head was hit (its own slot for its own trail), or -1 for the wall. */
  by: number;
  /** Two heads ran into each other; both die. */
  headOn: boolean;
  tick: number;
}

/**
 * One round of Curve Ball. The server calls `step()` once per tick; clients
 * rebuild the same round from its setup and input log, then step it with the
 * server's frames. Every operation is deterministic, so all copies agree.
 *
 * Trails live in an occupancy bitmap with one cell per px. A head dies when its
 * disc leaves the arena or covers a painted cell, except cells it painted
 * itself within the last few sub-steps (the ones right behind it).
 */
export class Round {
  readonly cfg: RoundConfig;
  readonly seed: number;
  readonly heads: Head[];
  /** Ticks stepped so far; also the number of the next tick to step. */
  tick = 0;
  /** 0 = empty, otherwise 1 + the slot that painted the cell. */
  readonly grid: Uint8Array;
  /** The sub-step each cell was painted on (1-based, so 0 means never). */
  readonly stamp: Uint32Array;
  readonly deaths: Death[] = [];
  /** Where each head was at the start of the last step, and whether it painted during it. */
  readonly prevX: Float64Array;
  readonly prevY: Float64Array;
  readonly painted: boolean[];

  constructor(setup: RoundSetup) {
    const { cfg, seed, ids } = setup;
    this.cfg = cfg;
    this.seed = seed;
    this.grid = new Uint8Array(cfg.w * cfg.h);
    this.stamp = new Uint32Array(cfg.w * cfg.h);
    const spots = spawnPoints(cfg, ids.length, mulberry32(seed));
    this.heads = ids.map((id, i) => {
      const h: Head = {
        id,
        ...spots[i],
        steer: 0,
        alive: true,
        diedAt: -1,
        gap: 0,
        nextGap: 0,
        rng: (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0,
        speed: cfg.speed,
        turn: cfg.turn,
        radius: cfg.radius,
        points: 0,
      };
      rollGap(h, cfg);
      return h;
    });
    this.prevX = Float64Array.from(this.heads, (h) => h.x);
    this.prevY = Float64Array.from(this.heads, (h) => h.y);
    this.painted = this.heads.map(() => false);
  }

  /**
   * Rebuild a round as it stood after `tick` ticks, with the inputs for that tick already applied.
   * `onStep` runs after every step (clients draw the trails with it).
   */
  static replay(setup: RoundSetup, inputs: readonly Input[], tick: number, onStep?: (round: Round) => void): Round {
    const round = new Round(setup);
    let k = 0;
    for (;;) {
      while (k < inputs.length && inputs[k][0] <= round.tick) {
        round.setSteer(inputs[k][1], inputs[k][2]);
        k++;
      }
      if (round.tick >= tick || round.over) return round;
      round.step();
      onStep?.(round);
    }
  }

  index(id: string): number {
    return this.heads.findIndex((h) => h.id === id);
  }

  get aliveCount(): number {
    let n = 0;
    for (const h of this.heads) if (h.alive) n++;
    return n;
  }

  /** The round ends when one head is left (or none, in a round that started with one). */
  get over(): boolean {
    return this.aliveCount <= (this.heads.length > 1 ? 1 : 0);
  }

  /** Returns false if nothing changed (dead head, bad slot, same steer). */
  setSteer(slot: number, steer: Steer): boolean {
    const h = this.heads[slot];
    if (!h?.alive || h.steer === steer) return false;
    h.steer = steer;
    return true;
  }

  /** Advance one tick. Returns the heads that died during it. */
  step(): Death[] {
    const { heads, cfg } = this;
    const n = heads.length;
    const t = this.tick;
    const deaths: Death[] = [];
    const safeX = new Float64Array(n);
    const safeY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const h = heads[i];
      this.prevX[i] = h.x;
      this.prevY[i] = h.y;
      this.painted[i] = h.alive && h.gap === 0;
    }

    for (let sub = 0; sub < SUBSTEPS; sub++) {
      const now = t * SUBSTEPS + sub + 1;

      // Everyone moves, then everyone is tested, then everyone paints, so slot order never matters.
      for (let i = 0; i < n; i++) {
        const h = heads[i];
        if (!h.alive) continue;
        safeX[i] = h.x;
        safeY[i] = h.y;
        moveSubstep(h);
      }

      const hit: (Death | null)[] = heads.map((h, i) => {
        if (!h.alive) return null;
        const by = this.hitAt(i, now);
        return by === null ? null : { slot: i, by, headOn: false, tick: t };
      });
      for (let i = 0; i < n; i++) {
        const a = heads[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < n; j++) {
          const b = heads[j];
          if (!b.alive) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const rr = a.radius + b.radius;
          if (dx * dx + dy * dy >= rr * rr) continue;
          hit[i] ??= { slot: i, by: j, headOn: true, tick: t };
          hit[j] ??= { slot: j, by: i, headOn: true, tick: t };
        }
      }

      for (const d of hit) {
        if (!d) continue;
        const h = heads[d.slot];
        h.alive = false;
        h.diedAt = t;
        // Stop at the last spot that was clear, touching whatever it hit.
        h.x = safeX[d.slot];
        h.y = safeY[d.slot];
        deaths.push(d);
      }

      for (let i = 0; i < n; i++) {
        const h = heads[i];
        if (h.alive && h.gap === 0) this.paint(i, now);
      }
    }

    for (const h of heads) {
      if (!h.alive) continue;
      if (deaths.length) h.points += deaths.length;
      advanceGap(h, cfg);
    }

    this.deaths.push(...deaths);
    this.tick++;
    return deaths;
  }

  /**
   * Is a disc of radius r at (x, y) blocked for head `slot` at sub-step `now`?
   * Returns the slot it would hit, -1 for the wall, or null if it's clear.
   */
  blockedAt(slot: number, x: number, y: number, r: number, now: number): number | null {
    const { w, h } = this.cfg;
    if (x - r < 0 || y - r < 0 || x + r > w || y + r > h) return -1;
    const head = this.heads[slot];
    const own = slot + 1;
    const recent = now - graceSubsteps(head);
    const r2 = r * r;
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(h - 1, Math.floor(y + r));
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(w - 1, Math.floor(x + r));
    for (let cy = y0; cy <= y1; cy++) {
      const dy = cy + 0.5 - y;
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx + 0.5 - x;
        if (dx * dx + dy * dy > r2) continue;
        const idx = cy * w + cx;
        const o = this.grid[idx];
        if (o === 0 || (o === own && this.stamp[idx] > recent)) continue;
        return o - 1;
      }
    }
    return null;
  }

  /** The sub-step counter as of the end of the last tick. */
  get now(): number {
    return this.tick * SUBSTEPS;
  }

  /** A fingerprint of every head, for spotting a client that has drifted from the server. */
  checksum(): number {
    let x = 0x811c9dc5;
    const mix = (v: number) => {
      x = Math.imul(x ^ (v | 0), 0x01000193);
    };
    for (const h of this.heads) {
      mix(Math.round(h.x * 64));
      mix(Math.round(h.y * 64));
      mix(h.heading);
      mix(h.alive ? 1 : 0);
      mix(h.gap);
    }
    return x >>> 0;
  }

  private hitAt(i: number, now: number): number | null {
    const h = this.heads[i];
    return this.blockedAt(i, h.x, h.y, h.radius, now);
  }

  private paint(i: number, now: number): void {
    const head = this.heads[i];
    const { w } = this.cfg;
    const { x, y, radius: r } = head;
    const r2 = r * r;
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      const dy = cy + 0.5 - y;
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const dx = cx + 0.5 - x;
        if (dx * dx + dy * dy > r2 || cx < 0 || cy < 0 || cx >= w || cy >= this.cfg.h) continue;
        const idx = cy * w + cx;
        this.grid[idx] = i + 1;
        this.stamp[idx] = now;
      }
    }
  }
}

/** Move a head one sub-step along its heading. */
function moveSubstep(h: Head): void {
  h.heading = wrapHeading(h.heading + h.steer * h.turn);
  h.x += (COS[h.heading] * h.speed) / SUBSTEPS;
  h.y += (SIN[h.heading] * h.speed) / SUBSTEPS;
}

/** End-of-tick gap bookkeeping: count down the current gap, or towards the next one. */
function advanceGap(h: Head, cfg: RoundConfig): void {
  if (h.gap > 0) {
    if (--h.gap === 0) rollGap(h, cfg);
  } else if (--h.nextGap <= 0) {
    h.gap = cfg.gapTicks;
  }
}

/**
 * Move a lone head one tick with no collisions, exactly as `Round.step` would.
 * Clients use it on a copy of their own head to draw it ahead of the server.
 * Returns whether it painted during the tick.
 */
export function coast(h: Head, cfg: RoundConfig): boolean {
  const painted = h.gap === 0;
  for (let sub = 0; sub < SUBSTEPS; sub++) moveSubstep(h);
  advanceGap(h, cfg);
  return painted;
}

/**
 * How many sub-steps back a head ignores its own paint. Long enough to cover
 * every cell its disc overlapped on the way here, with a little to spare.
 */
export function graceSubsteps(h: Pick<Head, "radius" | "speed">): number {
  return Math.ceil((2 * h.radius + 2) / (h.speed / SUBSTEPS)) + 2;
}

function rollGap(h: Head, cfg: RoundConfig): void {
  const r = rngStep(h.rng);
  h.rng = r.state;
  h.nextGap = cfg.gapMin + Math.floor(r.value * (cfg.gapMax - cfg.gapMin + 1));
}

const SPAWN_MARGIN = 80;
const SPAWN_SPACING = 110;
/** Try to face at least this much open floor at the start. */
const SPAWN_CLEAR = 180;

/** Random, spread-out starting spots, each facing away from the nearest walls. */
export function spawnPoints(cfg: RoundConfig, count: number, rng: Rng): { x: number; y: number; heading: number }[] {
  const out: { x: number; y: number; heading: number }[] = [];
  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      x = SPAWN_MARGIN + rng() * (cfg.w - 2 * SPAWN_MARGIN);
      y = SPAWN_MARGIN + rng() * (cfg.h - 2 * SPAWN_MARGIN);
      // Relax the spacing if the arena is crowded.
      const spacing = SPAWN_SPACING * (1 - attempt / 200);
      // Plain × rather than **, which isn't guaranteed to round the same in every engine.
      if (out.every((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) >= spacing * spacing)) break;
    }
    let heading = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      heading = randInt(rng, 0, HEADINGS - 1);
      if (wallDistance(cfg, x, y, heading) >= SPAWN_CLEAR) break;
    }
    out.push({ x, y, heading });
  }
  return out;
}

/** Distance from (x, y) to the arena edge, travelling straight along `heading`. */
export function wallDistance(cfg: RoundConfig, x: number, y: number, heading: number): number {
  const dx = COS[heading];
  const dy = SIN[heading];
  let d = Infinity;
  if (dx > 0) d = Math.min(d, (cfg.w - x) / dx);
  if (dx < 0) d = Math.min(d, -x / dx);
  if (dy > 0) d = Math.min(d, (cfg.h - y) / dy);
  if (dy < 0) d = Math.min(d, -y / dy);
  return d;
}
