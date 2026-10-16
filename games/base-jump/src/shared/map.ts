import { mulberry32, randInt, shuffle, type Rng } from "@warrick/kit/shared/rng";
import { HELI, NEUTRAL_GARRISON, SPEED, START_LEVEL, START_TANKS, TANK, type UnitKind } from "./constants";

/** A round's map. It never changes during the round, so it's sent once, in the snapshot. */
export interface GameMap {
  /** The seed it was made from. */
  id: number;
  w: number;
  h: number;
  /** Base positions, in whole map units. */
  x: number[];
  y: number[];
  /** What each base builds. */
  kind: UnitKind[];
  roads: [number, number][];
  /** Each base's road neighbours, in index order. */
  adj: number[][];
  /** The starting base of each seat, in seat order. */
  starts: number[];
  /** Each base's level and garrison (tanks) at the start of the round. */
  level: number[];
  garrison: number[];
}

export type MapSize = "small" | "medium" | "large";

/** Bases per player for each map size; every map has a couple more on top. */
export const BASES_PER_PLAYER: Record<MapSize, number> = { small: 4, medium: 6, large: 8 };
const EXTRA_BASES = 2;
/** Target distance between neighbouring bases, map units. */
const SPACING = 170;
/** Landscape, 16:10. */
const ASPECT = 1.6;
/** Keeps whole bases (and their labels) inside the map. */
const MARGIN = 50;
/** A road can't pass closer than this to a base it doesn't join. */
const CLEARANCE = 46;
/** Share of the optional roads (Gabriel-graph edges the minimal network leaves out) that get built. */
const EXTRA_ROADS = 0.45;
/** Maps made per call; the fairest is kept. */
const CANDIDATES = 24;

export function baseCount(players: number, size: MapSize): number {
  return players * BASES_PER_PLAYER[size] + EXTRA_BASES;
}

export function distance(m: GameMap, a: number, b: number): number {
  const dx = m.x[a] - m.x[b];
  const dy = m.y[a] - m.y[b];
  return Math.sqrt(dx * dx + dy * dy);
}

/** Ticks for a unit of this kind to cover a distance: whole ticks, at least one. */
export function travelTicks(dist: number, kind: UnitKind): number {
  return Math.max(1, Math.ceil(dist / SPEED[kind]));
}

/**
 * A new map for `players` seats, the same for the same seed. It makes several candidates and
 * keeps the one whose starting positions are the most even.
 */
export function generateMap(seed: number, players: number, size: MapSize): GameMap {
  const rng = mulberry32(seed);
  const n = baseCount(players, size);
  let best: GameMap | null = null;
  let bestScore = Infinity;
  for (let made = 0, attempt = 0; made < CANDIDATES && attempt < CANDIDATES * 20; attempt++) {
    const m = tryMap(rng, seed, n, players);
    if (!m) continue;
    made++;
    const score = unfairness(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (!best) throw new Error(`Couldn't make a map for ${players} players`);
  return best;
}

function tryMap(rng: Rng, id: number, n: number, players: number): GameMap | null {
  const inner = Math.sqrt(n * SPACING * SPACING * ASPECT);
  const w = Math.round(inner + MARGIN * 2);
  const h = Math.round(inner / ASPECT + MARGIN * 2);
  const { x, y } = scatter(rng, n, w, h);
  const roads = buildRoads(rng, x, y);
  if (!roads) return null;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of roads) {
    adj[a].push(b);
    adj[b].push(a);
  }
  for (const list of adj) list.sort((a, b) => a - b);
  const m: GameMap = {
    id,
    w,
    h,
    x,
    y,
    kind: new Array<UnitKind>(n).fill(TANK),
    roads,
    adj,
    starts: [],
    level: new Array<number>(n).fill(1),
    garrison: new Array<number>(n).fill(0),
  };
  if (!connected(m)) return null;
  const roadDist = allRoadDistances(m);
  m.starts = pickStarts(roadDist, players);
  if (m.starts.length < players) return null;
  stockBases(rng, m, roadDist);
  return m;
}

/**
 * Best-candidate sampling: each new base is the one of several random spots that's farthest
 * from the bases already placed. Spread out, but not on a grid.
 */
function scatter(rng: Rng, n: number, w: number, h: number): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  const spot = () => [randInt(rng, MARGIN, w - MARGIN), randInt(rng, MARGIN, h - MARGIN)];
  for (let i = 0; i < n; i++) {
    let bx = 0;
    let by = 0;
    let bestD = -1;
    for (let k = 0; k < 12; k++) {
      const [cx, cy] = spot();
      let d = Infinity;
      for (let j = 0; j < i; j++) d = Math.min(d, (cx - x[j]) ** 2 + (cy - y[j]) ** 2);
      if (d > bestD) {
        bestD = d;
        bx = cx;
        by = cy;
      }
    }
    x.push(bx);
    y.push(by);
  }
  return { x, y };
}

/**
 * The relative neighbourhood graph (two bases get a road unless some third base is closer to
 * both of them), which is connected and never crosses itself, plus some of the extra edges of the
 * Gabriel graph, which add loops without crossings. Roads that pass too close to another base
 * are dropped. Returns null if that leaves the map in pieces.
 */
function buildRoads(rng: Rng, x: number[], y: number[]): [number, number][] | null {
  const n = x.length;
  const d2 = (a: number, b: number) => (x[a] - x[b]) ** 2 + (y[a] - y[b]) ** 2;
  const minimal: [number, number][] = [];
  const optional: [number, number][] = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const ab = d2(a, b);
      let rng_ = true;
      let gabriel = true;
      for (let k = 0; k < n && gabriel; k++) {
        if (k === a || k === b) continue;
        const ak = d2(a, k);
        const bk = d2(b, k);
        if (Math.max(ak, bk) < ab) rng_ = false;
        if (ak + bk < ab) gabriel = false;
      }
      if (!gabriel || tooClose(x, y, a, b)) continue;
      (rng_ ? minimal : optional).push([a, b]);
    }
  }
  const lengths = minimal.map(([a, b]) => Math.sqrt(d2(a, b))).sort((p, q) => p - q);
  const longest = (lengths[Math.floor(lengths.length / 2)] ?? SPACING) * 1.6;
  const roads = [...minimal];
  for (const r of optional) {
    if (Math.sqrt(d2(r[0], r[1])) <= longest && rng() < EXTRA_ROADS) roads.push(r);
  }
  return roads.length >= n - 1 ? roads : null;
}

function tooClose(x: number[], y: number[], a: number, b: number): boolean {
  const dx = x[b] - x[a];
  const dy = y[b] - y[a];
  const len2 = dx * dx + dy * dy;
  for (let k = 0; k < x.length; k++) {
    if (k === a || k === b) continue;
    const t = Math.max(0, Math.min(1, ((x[k] - x[a]) * dx + (y[k] - y[a]) * dy) / len2));
    const px = x[a] + t * dx - x[k];
    const py = y[a] + t * dy - y[k];
    if (px * px + py * py < CLEARANCE * CLEARANCE) return true;
  }
  return false;
}

function connected(m: GameMap): boolean {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const b = queue.pop()!;
    for (const nb of m.adj[b]) {
      if (!seen.has(nb)) {
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return seen.size === m.x.length;
}

/** Shortest road distance between every pair of bases. */
function allRoadDistances(m: GameMap): number[][] {
  const n = m.x.length;
  return Array.from({ length: n }, (_, src) => {
    const dist = new Array<number>(n).fill(Infinity);
    const done = new Array<boolean>(n).fill(false);
    dist[src] = 0;
    for (;;) {
      let b = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (b < 0 || dist[i] < dist[b])) b = i;
      if (b < 0) break;
      done[b] = true;
      for (const nb of m.adj[b]) dist[nb] = Math.min(dist[nb], dist[b] + distance(m, b, nb));
    }
    return dist;
  });
}

/**
 * Farthest-point sampling over road distance, tried from every base as the first pick; keeps the
 * set whose closest two starts are farthest apart.
 */
function pickStarts(roadDist: number[][], players: number): number[] {
  const n = roadDist.length;
  let best: number[] = [];
  let bestGap = -1;
  for (let first = 0; first < n; first++) {
    const picks = [first];
    while (picks.length < players) {
      let far = -1;
      let farD = -1;
      for (let b = 0; b < n; b++) {
        if (picks.includes(b)) continue;
        const d = Math.min(...picks.map((p) => roadDist[p][b]));
        if (d > farD) {
          farD = d;
          far = b;
        }
      }
      if (far < 0) break;
      picks.push(far);
    }
    let gap = Infinity;
    for (let i = 0; i < picks.length; i++)
      for (let j = i + 1; j < picks.length; j++) gap = Math.min(gap, roadDist[picks[i]][picks[j]]);
    if (picks.length === players && gap > bestGap) {
      bestGap = gap;
      best = picks;
    }
  }
  return best;
}

/**
 * Starting depots, then the neutrals: mostly level 1, some 2 and 3, about a quarter of them
 * airfields (never fewer than one per player, or a fifth of the neutrals). Every start's nearest
 * neighbour by road is the same easy level-1 depot, so everyone has the same first move.
 */
function stockBases(rng: Rng, m: GameMap, roadDist: number[][]): void {
  const n = m.x.length;
  const isStart = new Set(m.starts);
  for (let b = 0; b < n; b++) {
    if (isStart.has(b)) {
      m.kind[b] = TANK;
      m.level[b] = START_LEVEL;
      m.garrison[b] = START_TANKS;
      continue;
    }
    const roll = rng();
    m.level[b] = roll < 0.6 ? 1 : roll < 0.9 ? 2 : 3;
    m.kind[b] = rng() < 0.25 ? HELI : TANK;
    const [lo, hi] = NEUTRAL_GARRISON[m.level[b]];
    m.garrison[b] = randInt(rng, lo, hi);
  }
  const easy = new Set<number>();
  for (const s of m.starts) {
    const nearest = m.adj[s].filter((b) => !isStart.has(b)).sort((a, b) => roadDist[s][a] - roadDist[s][b] || a - b)[0];
    if (nearest === undefined) continue;
    const closestStart = m.starts.reduce((p, q) => (roadDist[q][nearest] < roadDist[p][nearest] ? q : p));
    if (closestStart !== s) continue;
    m.kind[nearest] = TANK;
    m.level[nearest] = 1;
    m.garrison[nearest] = 5;
    easy.add(nearest);
  }
  const want = Math.max(m.starts.length, Math.round((n - m.starts.length) / 5));
  let have = m.kind.filter((k) => k === HELI).length;
  const pool = shuffle(
    rng,
    m.kind.map((k, b) => (k === TANK && !isStart.has(b) && !easy.has(b) ? b : -1)).filter((b) => b >= 0),
  );
  while (have < want && pool.length) {
    m.kind[pool.pop()!] = HELI;
    have++;
  }
}

/**
 * How uneven the starts are: the spread (relative to the mean) of what's closest to each start
 * (the bases nearer to it than to any other start, weighted by level and kind, cheaper ones
 * counting more), of how far each start is from its nearest neutral, and of how far each start
 * is from its nearest rival. Lower is fairer.
 */
export function unfairness(m: GameMap): number {
  const roadDist = allRoadDistances(m);
  const n = m.x.length;
  const p = m.starts.length;
  const value = new Array<number>(p).fill(0);
  const nearestNeutral = new Array<number>(p).fill(Infinity);
  const nearestRival = new Array<number>(p).fill(Infinity);
  const isStart = new Set(m.starts);
  for (let b = 0; b < n; b++) {
    if (isStart.has(b)) continue;
    let owner = -1;
    let d = Infinity;
    let tie = false;
    m.starts.forEach((s, i) => {
      const sd = roadDist[s][b];
      nearestNeutral[i] = Math.min(nearestNeutral[i], sd);
      if (sd < d - 1) {
        d = sd;
        owner = i;
        tie = false;
      } else if (Math.abs(sd - d) <= 1) {
        tie = true;
      }
    });
    if (owner >= 0 && !tie) value[owner] += (m.level[b] + (m.kind[b] === HELI ? 0.5 : 0)) / (1 + m.garrison[b] / 12);
  }
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) if (i !== j) nearestRival[i] = Math.min(nearestRival[i], roadDist[m.starts[i]][m.starts[j]]);
  }
  return spread(value) + spread(nearestNeutral) + spread(nearestRival);
}

function spread(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!mean || !Number.isFinite(mean)) return 0;
  return (Math.max(...xs) - Math.min(...xs)) / mean;
}
