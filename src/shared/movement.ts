/** 0 = none, then clockwise from up. */
export type Dir = 0 | 1 | 2 | 3 | 4;
export const DX = [0, 0, 1, 0, -1] as const;
export const DY = [0, -1, 0, 1, 0] as const;
export const OPPOSITE: readonly Dir[] = [0, 3, 4, 1, 2];
/** Bit for each side of a tile, used for flame shapes. Indexed by Dir. */
export const SIDE_BIT = [0, 1, 2, 4, 8] as const;

const EPS = 1e-6;
/** How far off a lane you can be and still get nudged into it when turning. */
const ASSIST = 0.72;

/** Is the tile at (cx, cy) closed to this mover? */
export type BlockedFn = (cx: number, cy: number) => boolean;

export interface Mover {
  x: number;
  y: number;
}

export function isDir(v: unknown): v is Dir {
  return v === 0 || v === 1 || v === 2 || v === 3 || v === 4;
}

/** Do two tile-sized boxes overlap? */
export function overlaps(x: number, y: number, cx: number, cy: number): boolean {
  return Math.abs(x - cx) < 1 - EPS && Math.abs(y - cy) < 1 - EPS;
}

/** Snap values within a hair of a tile center onto it, so float noise doesn't knock you off a lane. */
export function snapCoord(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-4 ? r : v;
}

/**
 * Move up to `dist` tiles in `dir`, Bomberman style: you travel along rows and
 * columns, you can't pass the middle of a tile when the next one is blocked,
 * and you get nudged around corners when you turn a little early or late.
 * Mutates `m` and returns the distance travelled.
 */
export function moveActor(m: Mover, dir: Dir, dist: number, blocked: BlockedFn): number {
  if (!dir || !(dist > 0)) return 0;
  const horiz = DX[dir] !== 0;
  const s = horiz ? DX[dir] : DY[dir];
  let along = horiz ? m.x : m.y;
  let across = horiz ? m.y : m.x;
  const closed = (a: number, c: number) => (horiz ? blocked(a, c) : blocked(c, a));
  let moved = 0;

  const write = () => {
    if (horiz) {
      m.x = snapCoord(along);
      m.y = snapCoord(across);
    } else {
      m.y = snapCoord(along);
      m.x = snapCoord(across);
    }
    return moved;
  };

  // 1. Get onto a lane first: a row when moving sideways, a column when moving up or down.
  const nearest = Math.round(across);
  if (Math.abs(across - nearest) > EPS) {
    // Off-lane on one axis means centered on the other, so `along` is a tile center here.
    const here = Math.round(along);
    const other = nearest + (across > nearest ? 1 : -1);
    let lane: number | null = null;
    for (const l of [nearest, other]) {
      if (Math.abs(across - l) <= ASSIST && !closed(here + s, l)) {
        lane = l;
        break;
      }
    }
    if (lane === null) return 0;
    const step = Math.min(dist, Math.abs(lane - across));
    across += Math.sign(lane - across) * step;
    if (Math.abs(across - lane) < EPS) across = lane;
    dist -= step;
    moved += step;
    if (across !== lane) return write();
  }

  // 2. Travel along the lane, stopping at the middle of the last open tile.
  const lane = Math.round(across);
  while (dist > EPS) {
    const next = s > 0 ? Math.floor(along + EPS) + 1 : Math.ceil(along - EPS) - 1;
    if (closed(next, lane)) {
      const mid = next - s;
      const room = (mid - along) * s;
      if (room > EPS) {
        const step = Math.min(dist, room);
        along += s * step;
        moved += step;
      }
      break;
    }
    const step = Math.min(dist, (next - along) * s);
    along += s * step;
    dist -= step;
    moved += step;
    if (Math.abs(along - Math.round(along)) < EPS) along = Math.round(along);
  }
  return write();
}
