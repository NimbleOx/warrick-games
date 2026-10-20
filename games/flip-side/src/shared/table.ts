/**
 * The table: every wall, post, bumper, slingshot, target, gate, lane and the flippers, in table
 * units (about a millimetre: the ball is 26 across, the table 540 × 1000), with y pointing down
 * the table towards the drain. Built once, the same on every device: arcs come from `dsin` and
 * `dcos`, never `Math.sin` (see CLAUDE.md).
 */

import { dcos, deg, dsin } from "./dmath";

export const TABLE_W = 540;
export const TABLE_H = 1000;
export const BALL_R = 13;

// What a collider is. Walls and posts only bounce the ball; the rest also score.
export const WALL = 0;
/** Rubber: livelier than a wall. */
export const RUBBER = 1;
/** The kicking face of a slingshot (`id` 0 left, 1 right). */
export const SLING = 2;
/** A pop bumper (`id` 0–2). */
export const BUMPER = 3;
/** A drop target (`id` 0–2): only there while it's up. */
export const DROP = 4;
/** A standup target (`id` 0–2). */
export const TARGET = 5;
/** A one-way gate: it stops a ball only on the side its normal points to. */
export const GATE = 6;

// Switches the ball rolls over (sensors), by id.
export const S_LANE = 0; // 0, 1, 2: the top lanes
export const S_INLANE_L = 3;
export const S_INLANE_R = 4;
export const S_OUTLANE_L = 5;
export const S_OUTLANE_R = 6;
/** Past the orbit's gate, going round. */
export const S_ORBIT = 7;
/** Out of the shooter lane into the table: ball save starts. */
export const S_SHOOTER = 8;

export interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit direction from a to b, and the length. */
  dx: number;
  dy: number;
  len: number;
  /** Unit normal, to the left of a → b (on screen, with y down: clockwise from the direction). */
  nx: number;
  ny: number;
  kind: number;
  id: number;
  /** Bounciness: the share of the speed into it that comes back out. */
  e: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
  kind: number;
  id: number;
  e: number;
}

/** A switch the ball rolls over: crossing it towards its normal is going forwards. */
export interface Sensor {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
  id: number;
}

export interface FlipperSpec {
  /** The pivot. */
  px: number;
  py: number;
  /** Pivot to tip, between the centres of its ends. */
  len: number;
  /** Radius at the pivot and at the tip. */
  r0: number;
  r1: number;
  /** 1 for the left flipper, -1 for the right: the right one is the left one mirrored. */
  side: 1 | -1;
}

/**
 * A flipper's angle, as the left flipper has it: 0 points across the table, positive turns it
 * down. At rest it hangs at `REST`; pressed, it swings up to `UP`.
 */
export const FLIP_REST = deg(30);
export const FLIP_UP = deg(-28);

export interface Table {
  segs: Seg[];
  circles: Circle[];
  sensors: Sensor[];
  flippers: [FlipperSpec, FlipperSpec];
  /** Where a ball waits on the plunger. */
  plungerX: number;
  plungerY: number;
  /** The scoop: the ball is caught within `r` of its centre, held, and kicked out at (vx, vy). */
  scoop: { x: number; y: number; r: number; vx: number; vy: number };
  /** A ball whose centre passes this line has drained. */
  drainY: number;
  /** Where a brick can land (trouble): its centre. */
  brickSpots: readonly { x: number; y: number }[];
  /** Colliders near each grid cell, so a ball checks only those around it. */
  grid: Grid;
  /** For drawing only. */
  art: Art;
}

/** What the screen draws beyond the walls: filled shapes and where the lights are. */
export interface Art {
  /** Blocks, drawn filled. */
  blocks: Pt[][];
  /** The slingshots, drawn filled. */
  slings: Pt[][];
  /** The lights: the top lanes, in front of each drop target and standup, the multipliers ×2–×5. */
  lanes: Pt[];
  drops: Pt[];
  targets: Pt[];
  mults: Pt[];
  /** Arrows pointing up the scoop lane and the orbit. */
  lock: Pt;
  orbit: Pt;
  /** Up the scoop lane. */
  scoopDir: Pt;
}

export interface Grid {
  cell: number;
  cols: number;
  rows: number;
  segs: number[][];
  circles: number[][];
}

/** Half the size of a brick. */
export const BRICK_HW = 32;
export const BRICK_HH = 11;

export type Pt = [number, number];

/** Points along an arc, from angle a0 to a1 (degrees: 0 is +x, 90 is down the table). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = deg(a0 + ((a1 - a0) * i) / steps);
    pts.push([cx + r * dcos(a), cy + r * dsin(a)]);
  }
  return pts;
}

class Builder {
  segs: Seg[] = [];
  circles: Circle[] = [];
  sensors: Sensor[] = [];

  seg(a: Pt, b: Pt, kind = WALL, id = 0, e = 0.45): Seg {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const s: Seg = {
      ax: a[0],
      ay: a[1],
      bx: b[0],
      by: b[1],
      dx: dx / len,
      dy: dy / len,
      len,
      nx: dy / len,
      ny: -dx / len,
      kind,
      id,
      e,
    };
    this.segs.push(s);
    return s;
  }

  /** A chain of walls through the points. Points on top of each other (where an arc meets a line) make no wall. */
  wall(pts: Pt[], kind = WALL, e = 0.45): void {
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = pts[i + 1][0] - pts[i][0];
      const dy = pts[i + 1][1] - pts[i][1];
      if (dx * dx + dy * dy > 1e-6) this.seg(pts[i], pts[i + 1], kind, 0, e);
    }
  }

  /** A closed shape: the chain back to its first point. */
  block(pts: Pt[], kind = WALL, e = 0.45): void {
    this.wall([...pts, pts[0]], kind, e);
  }

  circle(x: number, y: number, r: number, kind = WALL, id = 0, e = 0.5): void {
    this.circles.push({ x, y, r, kind, id, e });
  }

  /** A one-way gate from a to b: balls on the side of `toward` can't cross back. */
  gate(a: Pt, b: Pt, toward: Pt): void {
    const s = this.seg(a, b, GATE, 0, 0.3);
    if (s.nx * (toward[0] - a[0]) + s.ny * (toward[1] - a[1]) < 0) {
      s.nx = -s.nx;
      s.ny = -s.ny;
    }
  }

  /** A switch from a to b; crossing it towards `toward` is forwards. */
  sensor(a: Pt, b: Pt, id: number, toward: Pt): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    let nx = dy / len;
    let ny = -dx / len;
    if (nx * (toward[0] - a[0]) + ny * (toward[1] - a[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    this.sensors.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], nx, ny, id });
  }
}

/** The playfield's centre line, between the left wall and the shooter lane. */
export const MID_X = 253;

function build(): Table {
  const t = new Builder();

  // The cabinet: the left wall, the arch over the top, a straight roof down to the right, and a
  // curve from it into the right wall beside the shooter lane. A plunged ball comes off the
  // curve and flies over the top lanes: how hard it was plunged says which lane it drops into.
  t.wall([[20, 1040], [20, 280], ...arc(270, 280, 250, 180, 300, 40), ...arc(440, 181.9, 80, 300, 360, 16), [520, 1040]]);

  // The shooter lane: the plunger at the bottom, and a gate at the top that lets the ball out
  // but not back in.
  t.wall([
    [486, 1040],
    [486, 334],
  ]);
  t.circle(486, 334, 3);
  t.seg([486, 966], [520, 966]);
  t.gate([520, 290], [487, 333], [486, 280]);
  t.sensor([487, 380], [519, 380], S_SHOOTER, [503, 300]);

  // The top lanes, under the arch.
  for (const x of [290, 336, 382, 428]) {
    t.wall(
      [
        [x, 132],
        [x, 168],
      ],
      RUBBER,
      0.15,
    );
  }
  for (let i = 0; i < 3; i++) t.sensor([292 + i * 46, 160], [334 + i * 46, 160], S_LANE + i, [313 + i * 46, 200]);

  // Pop bumpers.
  t.circle(318, 232, 24, BUMPER, 0, 0.6);
  t.circle(404, 226, 24, BUMPER, 1, 0.6);
  t.circle(360, 304, 24, BUMPER, 2, 0.6);

  // The left orbit: a lane up the left side and round under the arch, with a gate at the top
  // so a ball coming the other way round the arch bounces back into the table.
  t.wall([[122, 586], [84, 474], [84, 280], ...arc(270, 280, 188, 180, 234, 10)]);
  const gate = (a: number, r0: number, r1: number): [Pt, Pt] => [
    [270 + r0 * dcos(deg(a)), 280 + r0 * dsin(deg(a))],
    [270 + r1 * dcos(deg(a)), 280 + r1 * dsin(deg(a))],
  ];
  const [g0, g1] = gate(234, 249, 188);
  t.gate(g0, g1, [270 + 220 * dcos(deg(244)), 280 + 220 * dsin(deg(244))]);
  const [o0, o1] = gate(220, 249, 189);
  t.sensor(o0, o1, S_ORBIT, [270 + 220 * dcos(deg(230)), 280 + 220 * dsin(deg(230))]);

  // Drop targets, in front of a block on the left, facing the right flipper.
  const bank: Pt[] = [
    [136, 424],
    [226, 396],
  ];
  const bdx = (bank[1][0] - bank[0][0]) / 3;
  const bdy = (bank[1][1] - bank[0][1]) / 3;
  for (let i = 0; i < 3; i++) {
    t.seg(
      [bank[0][0] + bdx * i + bdx * 0.08, bank[0][1] + bdy * i + bdy * 0.08],
      [bank[0][0] + bdx * (i + 1) - bdx * 0.08, bank[0][1] + bdy * (i + 1) - bdy * 0.08],
      DROP,
      i,
      0.35,
    );
  }
  t.block([
    [bank[0][0] - 4, bank[0][1] - 12],
    [bank[1][0] - 4, bank[1][1] - 12],
    [bank[1][0] + 2, bank[1][1] - 2],
    [bank[0][0] + 2, bank[0][1] - 2],
  ]);

  // The scoop, at the end of a short lane up the right, aimed at the left flipper. A block fills
  // the space between the lane and the shooter lane, so nothing lodges there.
  const ul = Math.sqrt(0.434 * 0.434 + 0.901 * 0.901);
  const ux = 0.434 / ul;
  const uy = -0.901 / ul;
  const sx = 446;
  const sy = 398;
  const px = -uy;
  const py = ux;
  const w = 26;
  const lane = (side: number, along: number): Pt => [sx + px * w * side + ux * along, sy + py * w * side + uy * along];
  const roof = lane(-1, 22);
  const foot = lane(1, -84);
  t.wall([lane(-1, -104), lane(-1, 0), roof, lane(1, 22), lane(1, 0), foot, [486, foot[1] + 4]]);
  t.wall([[486, 336], roof]);

  // Standup targets on the right.
  for (let i = 0; i < 3; i++) {
    const y = 560 + i * 46;
    t.seg([472, y], [472, y + 32], TARGET, i, 0.4);
  }
  t.wall([
    [486, 536],
    [478, 548],
    [478, 694],
    [486, 706],
  ]);

  // Slingshots above the flippers: the face towards the middle kicks.
  const slingL: Pt[] = [
    [100, 708],
    [100, 804],
    [150, 834],
  ];
  t.seg(slingL[0], slingL[2], SLING, 0, 0.5);
  t.wall([slingL[0], slingL[1], slingL[2]], RUBBER, 0.6);
  const mirror = (p: Pt): Pt => [MID_X * 2 - p[0], p[1]];
  const slingR = slingL.map(mirror);
  t.seg(slingR[2], slingR[0], SLING, 1, 0.5);
  t.wall([slingR[0], slingR[1], slingR[2]], RUBBER, 0.6);

  // Inlane guides down to the flippers, in line with the flippers' tops so the ball rolls
  // straight on, and the posts between the inlanes and the outlanes.
  const guideL: Pt[] = [
    [56, 738],
    [56, 824],
    [155, 881],
  ];
  t.wall(guideL);
  t.circle(56, 736, 5, RUBBER, 0, 0.6);
  t.wall(guideL.map(mirror));
  t.circle(MID_X * 2 - 56, 736, 5, RUBBER, 0, 0.6);
  t.sensor([22, 760], [54, 760], S_OUTLANE_L, [38, 800]);
  t.sensor([MID_X * 2 - 54, 760], [484, 760], S_OUTLANE_R, [468, 800]);
  t.sensor([58, 790], [94, 790], S_INLANE_L, [76, 830]);
  t.sensor([MID_X * 2 - 94, 790], [MID_X * 2 - 58, 790], S_INLANE_R, [430, 830]);

  const flipL: FlipperSpec = { px: 165, py: 902, len: 72, r0: 13, r1: 6.5, side: 1 };
  const flipR: FlipperSpec = { ...flipL, px: MID_X * 2 - 165, side: -1 };

  const dropNx = -bdy / Math.sqrt(bdx * bdx + bdy * bdy);
  const dropNy = bdx / Math.sqrt(bdx * bdx + bdy * bdy);
  const art: Art = {
    blocks: [
      [
        [bank[0][0] - 4, bank[0][1] - 12],
        [bank[1][0] - 4, bank[1][1] - 12],
        [bank[1][0] + 2, bank[1][1] - 2],
        [bank[0][0] + 2, bank[0][1] - 2],
      ],
      [roof, [486, 336], [486, foot[1] + 4], foot, lane(1, 0), lane(1, 22)],
      [
        [486, 536],
        [478, 548],
        [478, 694],
        [486, 706],
      ],
    ],
    slings: [slingL, slingR],
    lanes: [0, 1, 2].map((i): Pt => [313 + i * 46, 190]),
    drops: [0, 1, 2].map((i): Pt => [bank[0][0] + bdx * (i + 0.5) + dropNx * 26, bank[0][1] + bdy * (i + 0.5) + dropNy * 26]),
    targets: [0, 1, 2].map((i): Pt => [452, 576 + i * 46]),
    mults: [
      [196, 744],
      [232, 732],
      [274, 732],
      [310, 744],
    ],
    lock: [sx - ux * 136, sy - uy * 136],
    orbit: [62, 612],
    scoopDir: [ux, uy],
  };

  const table: Table = {
    art,
    segs: t.segs,
    circles: t.circles,
    sensors: t.sensors,
    flippers: [flipL, flipR],
    plungerX: 503,
    plungerY: 966 - BALL_R - 0.5,
    scoop: { x: sx, y: sy, r: 14, vx: -ux * 900, vy: -uy * 900 },
    drainY: 1020,
    brickSpots: [
      { x: 200, y: 560 },
      { x: 306, y: 560 },
      { x: 253, y: 640 },
      { x: 170, y: 700 },
      { x: 336, y: 700 },
      { x: 253, y: 470 },
    ],
    grid: { cell: 40, cols: 0, rows: 0, segs: [], circles: [] },
  };
  table.grid = buildGrid(table);
  return table;
}

function buildGrid(t: Table): Grid {
  const cell = 40;
  const cols = Math.floor(TABLE_W / cell) + 2;
  const rows = Math.floor((TABLE_H + 60) / cell) + 2;
  const segs: number[][] = [];
  const circles: number[][] = [];
  for (let i = 0; i < cols * rows; i++) {
    segs.push([]);
    circles.push([]);
  }
  const pad = BALL_R + 4;
  const add = (lists: number[][], idx: number, x0: number, y0: number, x1: number, y1: number) => {
    const c0 = Math.max(0, Math.floor((x0 - pad) / cell));
    const c1 = Math.min(cols - 1, Math.floor((x1 + pad) / cell));
    const r0 = Math.max(0, Math.floor((y0 - pad) / cell));
    const r1 = Math.min(rows - 1, Math.floor((y1 + pad) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) lists[r * cols + c].push(idx);
  };
  t.segs.forEach((s, i) => add(segs, i, Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by)));
  t.circles.forEach((c, i) => add(circles, i, c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r));
  return { cell, cols, rows, segs, circles };
}

/** The one table there is (v1). */
export const TABLE: Table = build();
