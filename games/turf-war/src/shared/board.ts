import { MAX_PLAYERS } from "@warrick/kit/shared/constants";
import { fnv1a, rleDecode, rleEncode } from "./codec";

/** 0 up, 1 right, 2 down, 3 left. */
export type Dir = 0 | 1 | 2 | 3;
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

export function isDir(v: unknown): v is Dir {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

export function reverse(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

export type DeathCause = "wall" | "trail" | "self" | "headon" | "squeeze" | "left";

/**
 * One change to the board. The server changes its board only by applying ops,
 * and sends every op it applied in that tick's frame; clients apply the same
 * ops with the same code, so every copy of the board stays identical.
 */
export type Op =
  /** Head moves, one cell index per slot (-1 = didn't move). A head off its own land lays trail. */
  | ["m", ...number[]]
  /** Claim: the slot's trail becomes land, then it takes these [start, length, …] runs of cells. */
  | ["c", number, ...number[]]
  /** Death: [slot, killer or -1, slot that takes the trail as land or -1, cause, respawn tick or -1]. */
  | ["d", number, number, number, DeathCause, number]
  /** Spawn: [slot, center cell, facing]. A fresh 3 × 3 home patch. */
  | ["s", number, number, Dir];

/** Everything that happened in one tick. */
export interface Frame {
  t: "f";
  n: number;
  o: Op[];
  /** Board checksum after this tick, sent every CHECKSUM_EVERY ticks. */
  ck?: number;
}

export interface Head {
  /** -1 while the slot has no head on the board. */
  cell: number;
  /** The way it last moved (or faces, right after spawning). */
  dir: Dir;
  alive: boolean;
  /** Hasn't moved since spawning, so it may set off in any direction. */
  fresh: boolean;
  /** Tick a dead player comes back on, or -1. */
  respawnAt: number;
}

/** [cell, dir, alive, fresh, respawnAt] */
export type HeadSnap = [number, Dir, 0 | 1, 0 | 1, number];

export interface BoardSnap {
  w: number;
  h: number;
  /** rleEncode of the owner grid. */
  owner: number[];
  /** rleEncode of the trail grid. */
  trail: number[];
  heads: HeadSnap[];
}

function newHead(): Head {
  return { cell: -1, dir: 1, alive: false, fresh: false, respawnAt: -1 };
}

/**
 * The grid: who owns each cell and whose trail lies on it. In both grids 0 is
 * nobody and slot + 1 is a player. Land and trail counts are kept in step with
 * the grids, which is what the scoreboard reads.
 */
export class Board {
  readonly size: number;
  readonly owner: Uint8Array;
  readonly trail: Uint8Array;
  /** Cells each slot owns. */
  readonly land = new Int32Array(MAX_PLAYERS);
  /** Each slot's trail cells. */
  readonly trails: number[][] = Array.from({ length: MAX_PLAYERS }, () => []);
  readonly heads: Head[] = Array.from({ length: MAX_PLAYERS }, newHead);

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.size = w * h;
    this.owner = new Uint8Array(this.size);
    this.trail = new Uint8Array(this.size);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  /** The neighbouring cell in direction d, or -1 off the edge. */
  neighbor(c: number, d: Dir): number {
    const x = (c % this.w) + DX[d];
    const y = Math.floor(c / this.w) + DY[d];
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  apply(op: Op): void {
    switch (op[0]) {
      case "m":
        for (let i = 1; i < op.length; i++) {
          const c = op[i] as number;
          if (c >= 0) this.moveHead(i - 1, c);
        }
        return;
      case "c": {
        const slot = op[1];
        this.clearTrail(slot, slot + 1);
        for (let i = 2; i + 1 < op.length; i += 2) {
          const end = (op[i] as number) + (op[i + 1] as number);
          for (let c = op[i] as number; c < end; c++) this.setOwner(c, slot + 1);
        }
        return;
      }
      case "d": {
        const [, slot, , to, , respawnAt] = op;
        this.clearTrail(slot, to >= 0 ? to + 1 : -1);
        if (this.land[slot] > 0) {
          const v = slot + 1;
          for (let c = 0; c < this.size; c++) if (this.owner[c] === v) this.setOwner(c, 0);
        }
        const h = this.heads[slot];
        h.cell = -1;
        h.alive = false;
        h.fresh = false;
        h.respawnAt = respawnAt;
        return;
      }
      case "s": {
        const [, slot, cell, dir] = op;
        const cx = cell % this.w;
        const cy = Math.floor(cell / this.w);
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (let x = cx - 1; x <= cx + 1; x++) {
            if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.setOwner(this.idx(x, y), slot + 1);
          }
        }
        Object.assign(this.heads[slot], { cell, dir, alive: true, fresh: true, respawnAt: -1 });
        return;
      }
    }
  }

  setOwner(c: number, v: number): void {
    const old = this.owner[c];
    if (old === v) return;
    if (old) this.land[old - 1]--;
    if (v) this.land[v - 1]++;
    this.owner[c] = v;
  }

  checksum(): number {
    return fnv1a(this.owner, this.trail);
  }

  snapshot(): BoardSnap {
    return {
      w: this.w,
      h: this.h,
      owner: rleEncode(this.owner),
      trail: rleEncode(this.trail),
      heads: this.heads.map((h) => [h.cell, h.dir, h.alive ? 1 : 0, h.fresh ? 1 : 0, h.respawnAt]),
    };
  }

  /** Rebuild a board from a snapshot. Returns null if the snapshot is malformed. */
  static fromSnapshot(s: BoardSnap): Board | null {
    if (!(s.w > 0 && s.h > 0 && s.w * s.h <= 1 << 20)) return null;
    const b = new Board(s.w, s.h);
    if (!rleDecode(s.owner, b.owner) || !rleDecode(s.trail, b.trail)) return null;
    for (let c = 0; c < b.size; c++) {
      const o = b.owner[c];
      const t = b.trail[c];
      if (o > MAX_PLAYERS || t > MAX_PLAYERS) return null;
      if (o) b.land[o - 1]++;
      if (t) b.trails[t - 1].push(c);
    }
    s.heads.slice(0, MAX_PLAYERS).forEach(([cell, dir, alive, fresh, respawnAt], i) => {
      Object.assign(b.heads[i], { cell, dir, alive: !!alive, fresh: !!fresh, respawnAt });
    });
    return b;
  }

  private moveHead(slot: number, c: number): void {
    const h = this.heads[slot];
    if (h.cell >= 0) {
      const delta = c - h.cell;
      h.dir = delta === 1 ? 1 : delta === -1 ? 3 : delta > 0 ? 2 : 0;
    }
    h.cell = c;
    h.fresh = false;
    const v = slot + 1;
    if (this.owner[c] === v || this.trail[c] === v) return;
    const other = this.trail[c];
    if (other) {
      // Can't happen in a real game: crossing a trail kills its owner first.
      const list = this.trails[other - 1];
      list.splice(list.indexOf(c), 1);
    }
    this.trail[c] = v;
    this.trails[slot].push(c);
  }

  /** Remove a slot's trail; with `toOwner` > 0 its cells become that player's land. */
  private clearTrail(slot: number, toOwner: number): void {
    const list = this.trails[slot];
    for (const c of list) {
      this.trail[c] = 0;
      if (toOwner > 0) this.setOwner(c, toOwner);
    }
    list.length = 0;
  }
}
