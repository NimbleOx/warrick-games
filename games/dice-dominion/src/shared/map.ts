import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import { LAND_SHARE, MIN_CELLS, TARGET_CELLS } from "./constants";
import { cellCenter, neighbours } from "./hex";

/** A game's map. It never changes during a game, so it's sent once (see protocol.ts). */
export interface HexMap {
  /** The seed it was made from. Clients use it to tell whether they have the current map. */
  id: number;
  w: number;
  h: number;
  /** The territory of each cell, row by row; -1 is sea. */
  cells: number[];
  /** Each territory's neighbours: the territories it shares a border with (sea doesn't count). */
  adj: number[][];
  /** The cell each territory's dice stand on: the one farthest from its edge. */
  anchor: number[];
}

/** Grid size for a map: about TARGET_CELLS per territory, LAND_SHARE of it land, square in pixels. */
export function gridSize(territories: number): { w: number; h: number } {
  const cells = (territories * TARGET_CELLS) / LAND_SHARE;
  // Rows are 1.5 radii apart and columns √3, so a square map has ~1.15 rows per column.
  const w = Math.max(8, Math.round(Math.sqrt(cells / 1.155)));
  return { w, h: Math.max(8, Math.round(cells / w)) };
}

/**
 * A new random map with exactly `territories` territories, the same for the same seed. Maps
 * whose territories aren't all connected, or that have a tiny territory, are thrown away.
 */
export function generateMap(seed: number, territories: number): HexMap {
  const rng = mulberry32(seed);
  const { w, h } = gridSize(territories);
  for (let attempt = 0; attempt < 500; attempt++) {
    const cells = tryMap(rng, w, h, territories);
    if (!cells) continue;
    const adj = adjacency(w, h, cells, territories);
    if (!isConnected(adj)) continue;
    return { id: seed, w, h, cells, adj, anchor: anchors(w, h, cells, territories) };
  }
  throw new Error(`Couldn't make a map with ${territories} territories`);
}

/**
 * One try: grow a continent from the middle of the grid, plant one seed per territory spread
 * across it, and grow the seeds over the land with a randomized flood fill.
 */
function tryMap(rng: Rng, w: number, h: number, territories: number): number[] | null {
  const n = w * h;
  const near = Array.from({ length: n }, (_, i) => neighbours(w, h, i));
  const land = growLand(rng, w, h, near, territories * TARGET_CELLS);
  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (land[i]) landCells.push(i);
  if (landCells.length < territories * MIN_CELLS) return null;

  const cells = new Array<number>(n).fill(-1);
  const seeds = spreadSeeds(rng, near, land, landCells, territories);
  const size = new Array<number>(territories).fill(1);
  seeds.forEach((cell, t) => (cells[cell] = t));

  // Grow the smallest territory that still can, one cell at a time, preferring the frontier
  // cell with the most neighbours already in it (so territories stay compact).
  let left = landCells.length - territories;
  const stuck = new Array<boolean>(territories).fill(false);
  const members: number[][] = seeds.map((c) => [c]);
  while (left > 0) {
    let t = -1;
    for (let i = 0; i < territories; i++) {
      if (stuck[i]) continue;
      if (t < 0 || size[i] < size[t] || (size[i] === size[t] && rng() < 0.5)) t = i;
    }
    if (t < 0) return null; // land nobody can reach: can't happen on one continent, but be safe
    let best = -1;
    let bestScore = -1;
    for (const cell of members[t]) {
      for (const nb of near[cell]) {
        if (nb < 0 || !land[nb] || cells[nb] !== -1) continue;
        let own = 0;
        for (const x of near[nb]) if (x >= 0 && cells[x] === t) own++;
        const score = own + rng() * 0.9;
        if (score > bestScore) {
          bestScore = score;
          best = nb;
        }
      }
    }
    if (best < 0) {
      stuck[t] = true;
      continue;
    }
    cells[best] = t;
    members[t].push(best);
    size[t]++;
    left--;
  }
  if (size.some((s) => s < MIN_CELLS)) return null;
  return cells;
}

/**
 * The continent: a flood fill from the middle that takes the frontier cell with the lowest
 * priority next. Priority is smoothed noise plus distance from the middle, so the land comes
 * out roughly round with bays, inlets and the odd lake. Small enclosed pockets of sea are
 * filled in afterwards.
 */
function growLand(rng: Rng, w: number, h: number, near: number[][], target: number): boolean[] {
  const n = w * h;
  let noise = Array.from({ length: n }, () => rng());
  for (let pass = 0; pass < 2; pass++) {
    noise = noise.map((v, i) => {
      let sum = v * 2;
      let count = 2;
      for (const nb of near[i]) {
        if (nb < 0) continue;
        sum += noise[nb];
        count++;
      }
      return sum / count;
    });
  }
  const start = Math.floor(h / 2) * w + Math.floor(w / 2);
  const mid = cellCenter(w, start);
  const priority = noise.map((v, i) => {
    const p = cellCenter(w, i);
    return v * 1.6 + Math.hypot((p.x - mid.x) / mid.x, (p.y - mid.y) / mid.y);
  });

  const land = new Array<boolean>(n).fill(false);
  const queued = new Array<boolean>(n).fill(false);
  const frontier = [start];
  queued[start] = true;
  let count = 0;
  while (count < target && frontier.length) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (priority[frontier[i]] < priority[frontier[bi]]) bi = i;
    const cell = frontier[bi];
    frontier[bi] = frontier[frontier.length - 1];
    frontier.pop();
    land[cell] = true;
    count++;
    for (const nb of near[cell]) {
      if (nb >= 0 && !queued[nb]) {
        queued[nb] = true;
        frontier.push(nb);
      }
    }
  }
  fillPockets(w, h, near, land);
  return land;
}

/** Turn enclosed patches of sea smaller than a few cells into land: they read as holes, not lakes. */
function fillPockets(w: number, h: number, near: number[][], land: boolean[]): void {
  const seen = new Array<boolean>(w * h).fill(false);
  for (let i = 0; i < w * h; i++) {
    if (land[i] || seen[i]) continue;
    const patch = [i];
    seen[i] = true;
    let open = false;
    for (let k = 0; k < patch.length; k++) {
      for (const nb of near[patch[k]]) {
        if (nb < 0) open = true;
        else if (!land[nb] && !seen[nb]) {
          seen[nb] = true;
          patch.push(nb);
        }
      }
    }
    if (!open && patch.length < 5) for (const c of patch) land[c] = true;
  }
}

/** Farthest-point sampling over the land, with a little jitter so it isn't a lattice. */
function spreadSeeds(rng: Rng, near: number[][], land: boolean[], landCells: number[], count: number): number[] {
  const n = land.length;
  const dist = new Array<number>(n).fill(Infinity);
  const seeds: number[] = [];
  let next = landCells[Math.floor(rng() * landCells.length)];
  while (seeds.length < count) {
    seeds.push(next);
    // Breadth-first over land from the new seed, keeping each cell's distance to its nearest seed.
    dist[next] = 0;
    const queue = [next];
    for (let k = 0; k < queue.length; k++) {
      const c = queue[k];
      for (const nb of near[c]) {
        if (nb < 0 || !land[nb] || dist[nb] <= dist[c] + 1) continue;
        dist[nb] = dist[c] + 1;
        queue.push(nb);
      }
    }
    let best = -1;
    let bestScore = -1;
    for (const c of landCells) {
      if (dist[c] === 0) continue;
      const score = dist[c] + rng() * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0) break;
    next = best;
  }
  return seeds;
}

/** Each territory's neighbours, sorted. */
export function adjacency(w: number, h: number, cells: number[], territories: number): number[][] {
  const sets = Array.from({ length: territories }, () => new Set<number>());
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (t < 0) continue;
    for (const nb of neighbours(w, h, i)) {
      const u = nb < 0 ? -1 : cells[nb];
      if (u >= 0 && u !== t) sets[t].add(u);
    }
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

export function isConnected(adj: number[][]): boolean {
  if (!adj.length) return false;
  const seen = new Set([0]);
  const queue = [0];
  for (let k = 0; k < queue.length; k++) {
    for (const u of adj[queue[k]]) {
      if (!seen.has(u)) {
        seen.add(u);
        queue.push(u);
      }
    }
  }
  return seen.size === adj.length;
}

/**
 * For each territory, the cell farthest from its edge (ties go to the one nearest its middle),
 * so the dice stack doesn't cover a border.
 */
function anchors(w: number, h: number, cells: number[], territories: number): number[] {
  const depth = new Array<number>(cells.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] < 0) continue;
    if (neighbours(w, h, i).some((nb) => nb < 0 || cells[nb] !== cells[i])) {
      depth[i] = 0;
      queue.push(i);
    }
  }
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    for (const nb of neighbours(w, h, c)) {
      if (nb < 0 || depth[nb] >= 0 || cells[nb] !== cells[c]) continue;
      depth[nb] = depth[c] + 1;
      queue.push(nb);
    }
  }
  const sum = Array.from({ length: territories }, () => ({ x: 0, y: 0, n: 0 }));
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (t < 0) continue;
    const p = cellCenter(w, i);
    sum[t].x += p.x;
    sum[t].y += p.y;
    sum[t].n++;
  }
  const best = new Array<number>(territories).fill(-1);
  const bestScore = new Array<number>(territories).fill(-Infinity);
  for (let i = 0; i < cells.length; i++) {
    const t = cells[i];
    if (t < 0) continue;
    const p = cellCenter(w, i);
    const off = Math.hypot(p.x - sum[t].x / sum[t].n, p.y - sum[t].y / sum[t].n);
    const score = depth[i] * 100 - off;
    if (score > bestScore[t]) {
      bestScore[t] = score;
      best[t] = i;
    }
  }
  return best;
}

/** How many cells each territory has. */
export function territorySizes(map: HexMap): number[] {
  const size = new Array<number>(map.adj.length).fill(0);
  for (const t of map.cells) if (t >= 0) size[t]++;
  return size;
}
