/**
 * Courses, generated from a seed: a strip of pieces laid left to right, each after a flat run-up,
 * with a checkpoint on the run-up every so often. The client and the worker both build a course
 * from its spec, so this keeps to the sim's deterministic arithmetic (see bike.ts): rng values,
 * + - * / and the polynomial shapes in ground.ts.
 *
 * Pieces scale with a difficulty value `d` from 0 to 1, drawn from the difficulty's band for
 * each piece, so an easy course is small bumps and short gaps and a hard one has big jumps. The
 * tests (test/course.test.ts and the CPU measurements in test/ai.test.ts) check that every piece
 * is rideable across its whole range, so the generator doesn't need to try a course out.
 */

import { mulberry32, type Rng } from "@warrick/kit/shared/rng";
import { TICK_HZ } from "./constants";
import { Ground, PathBuilder, bump, easeOut, kick, smooth } from "./ground";
import type { Course, Pit } from "./ride";

export const COURSE_LENGTHS = ["short", "medium", "long"] as const;
export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type CourseLength = (typeof COURSE_LENGTHS)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface CourseSpec {
  seed: number;
  length: CourseLength;
  difficulty: Difficulty;
}

/** How far it is from the gate to the finish, in metres. */
export const COURSE_METRES: Record<CourseLength, number> = { short: 330, medium: 660, long: 1000 };

/** Each difficulty's range of piece difficulty `d`. */
const BANDS: Record<Difficulty, [number, number]> = { easy: [0, 0.4], normal: [0.3, 0.7], hard: [0.6, 1] };

/**
 * The hard CPU's average speed over a course of each difficulty (m/s), measured over hundreds
 * of courses (see test/ai.test.ts). It sets par, and par sets the hard cap.
 */
const PAR_SPEED: Record<Difficulty, number> = { easy: 14, normal: 13.5, hard: 12.5 };

/** A course ends at the latest after this many times its par. */
const CAP_PARS = 3;

/** How far before an obstacle its checkpoint is, and the least ground between checkpoints. */
export const CP_BACK = 15;
const CP_SPACING = 75;
/** Where the ground starts: a wall behind the gate. */
const START_X = -14;
/** Keep the course within this band of heights, so it doesn't wander off into the sky. */
const HIGH = 24;
const LOW = -12;

export interface Piece {
  kind: PieceKind;
  /** Where the piece starts (after its run-up) and ends. */
  x0: number;
  x1: number;
  d: number;
}

export interface GeneratedCourse extends Course {
  spec: CourseSpec;
  /** Personal bests and ghosts are kept by this. */
  id: string;
  pieces: Piece[];
  /** About how long the hard CPU takes, in ticks; the course ends at the latest at capTicks. */
  parTicks: number;
  capTicks: number;
}

export function courseId(spec: CourseSpec): string {
  return `${(spec.seed >>> 0).toString(36)}-${spec.length[0]}${spec.difficulty[0]}`;
}

type PieceKind =
  | "whoops"
  | "kicker"
  | "tabletop"
  | "gap"
  | "double"
  | "stepUp"
  | "drop"
  | "hill"
  | "climb"
  | "descent"
  | "log"
  | "rocks";

interface PieceDef {
  /** How often it comes up, on each difficulty. */
  weight: Record<Difficulty, number>;
  /** Up (1) or down (-1) on balance, so the course can keep within its band of heights. */
  rise: number;
  /** The flat it needs before it, to be ridden at speed: [at d = 0, at d = 1]. */
  runUp: [number, number];
  build(p: PathBuilder, rng: Rng, d: number, pits: Pit[]): void;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/**
 * A `smooth` curve is steepest in the middle, at 1.5 times its average slope: a run of at least
 * this many times its rise keeps it under about 35°.
 */
const MIN_RUN = 2.2;
/** A value from lo to hi, a little random. */
const vary = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

const PIECES: Record<PieceKind, PieceDef> = {
  // A row of round bumps.
  whoops: {
    weight: { easy: 3, normal: 3, hard: 2 },
    rise: 0,
    runUp: [6, 10],
    build(p, rng, d) {
      const n = 4 + Math.floor(rng() * (3 + 4 * d));
      const width = lerp(3.4, 2.2, d) + vary(rng, -0.2, 0.2);
      p.bumps(n, width, lerp(0.25, 0.55, d), 10);
    },
  },
  // A ramp that gets steeper, then straight down to a flat landing.
  kicker: {
    weight: { easy: 2, normal: 3, hard: 3 },
    rise: 0,
    runUp: [12, 16],
    build(p, rng, d) {
      const base = p.y;
      p.curve(vary(rng, 4.5, 5.5), lerp(0.7, 1.7, d), kick, 10)
        .face(base)
        .flat(lerp(8, 12, d));
    },
  },
  // Up, a flat top, and a long ramp down to land on.
  tabletop: {
    weight: { easy: 2, normal: 3, hard: 3 },
    rise: 0,
    runUp: [10, 16],
    build(p, rng, d) {
      const h = lerp(1, 2.6, d);
      p.curve(lerp(4, 5.5, d), h, kick, 10)
        .flat(lerp(3, 11, d) + vary(rng, 0, 2))
        .curve(lerp(6, 9, d), -h, smooth, 12);
    },
  },
  // A take-off ramp, a pit, and a landing ramp on the far side. Falling in is a crash.
  gap: {
    weight: { easy: 1, normal: 2, hard: 3 },
    rise: 0,
    runUp: [14, 18],
    build(p, rng, d, pits) {
      const base = p.y;
      const h = lerp(1.1, 1.7, d);
      const width = lerp(2.5, 8, d) + vary(rng, -0.3, 0.3);
      const land = h - 0.4;
      p.curve(5, h, kick, 10);
      const x0 = p.x;
      p.face(base - 3).flat(width);
      const x1 = p.x;
      p.face(base + land).curve(lerp(10, 9, d), -land, smooth, 12);
      pits.push({ x0, x1, y: base - 0.4 });
    },
  },
  // Two jumps: clear the dip between them and land on the back of the second.
  double: {
    weight: { easy: 1, normal: 2, hard: 2 },
    rise: 0,
    runUp: [12, 16],
    build(p, rng, d) {
      const h = lerp(0.9, 1.6, d);
      p.curve(4, h, kick, 8)
        .curve(2.5, -h * 0.8, easeOut, 6)
        .flat(lerp(0.5, 4, d) + vary(rng, 0, 1))
        .curve(3.5, h * 0.8, smooth, 8)
        .curve(lerp(7, 9, d), -h, easeOut, 12);
    },
  },
  // A kicker onto a higher shelf, over a ditch. Come up short and you hit the shelf's face.
  stepUp: {
    weight: { easy: 1, normal: 2, hard: 2 },
    rise: 1,
    runUp: [12, 16],
    build(p, rng, d) {
      const base = p.y;
      const shelf = lerp(0.9, 2.3, d);
      p.curve(4, lerp(0.8, 1.3, d), kick, 8)
        .face(base + 0.3)
        .flat(lerp(0.3, 2.5, d) + vary(rng, 0, 0.4))
        .face(base + shelf)
        .flat(8);
    },
  },
  // Off the end of a ledge, onto a downslope (or the flat, when it's hard).
  drop: {
    weight: { easy: 1, normal: 2, hard: 2 },
    rise: -1,
    runUp: [6, 10],
    build(p, rng, d) {
      p.face(p.y - lerp(0.6, 2.4, d));
      if (rng() < d * 0.5) p.flat(8);
      else p.curve(vary(rng, 6, 9), -lerp(1, 2.5, d), easeOut, 10).flat(4);
    },
  },
  // Up and over.
  hill: {
    weight: { easy: 2, normal: 2, hard: 1 },
    rise: 0,
    runUp: [4, 8],
    build(p, rng, d) {
      const h = lerp(2, 5, d) + vary(rng, 0, 1);
      // A net rise or fall now and then, so hills change the course's height too.
      const end = h * vary(rng, -0.4, 0.4);
      // No steeper than about 35°.
      const up = Math.max(vary(rng, 8, 12), MIN_RUN * h);
      const down = Math.max(vary(rng, 8, 12), MIN_RUN * (h - end));
      p.curve(up, h, smooth, 14)
        .flat(vary(rng, 1, 4))
        .curve(down, end - h, smooth, 14);
    },
  },
  // A long climb.
  climb: {
    weight: { easy: 1, normal: 1, hard: 1 },
    rise: 1,
    runUp: [4, 8],
    build(p, rng, d) {
      const h = lerp(3, 7, d);
      p.curve(Math.max(vary(rng, 12, 18), MIN_RUN * h), h, smooth, 16).flat(4);
    },
  },
  // A long way down.
  descent: {
    weight: { easy: 1, normal: 1, hard: 1 },
    rise: -1,
    runUp: [4, 8],
    build(p, rng, d) {
      const h = lerp(3, 7, d);
      p.curve(Math.max(vary(rng, 12, 18), MIN_RUN * h), -h, smooth, 16).flat(4);
    },
  },
  // A log across the track.
  log: {
    weight: { easy: 1, normal: 1, hard: 1 },
    rise: 0,
    runUp: [5, 8],
    build(p, rng, d) {
      p.curve(lerp(0.9, 0.7, d), lerp(0.22, 0.42, d), bump, 8).flat(vary(rng, 1, 3));
    },
  },
  // A scatter of rocks.
  rocks: {
    weight: { easy: 1, normal: 2, hard: 2 },
    rise: 0,
    runUp: [5, 8],
    build(p, rng, d) {
      const n = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        p.curve(vary(rng, 0.6, 1.4), vary(rng, 0.1, lerp(0.25, 0.45, d)), bump, 6).flat(vary(rng, 0.2, 1.2));
      }
    },
  },
};

const KINDS = Object.keys(PIECES) as PieceKind[];

/** Builds the course a spec describes: the same one, bit for bit, everywhere. */
export function generateCourse(spec: CourseSpec): GeneratedCourse {
  const rng = mulberry32(spec.seed ^ hashText(`${spec.length}/${spec.difficulty}`));
  const [lo, hi] = BANDS[spec.difficulty];
  const target = COURSE_METRES[spec.length];
  const p = new PathBuilder(START_X, 8).face(0);
  const checkpoints = [0];
  const pits: Pit[] = [];
  const pieces: Piece[] = [];
  let last: PieceKind | null = null;

  // A run-up from the gate.
  p.flat(18);
  while (p.x < target) {
    const kind = pick(rng, spec.difficulty, p.y, last);
    const def = PIECES[kind];
    const d = lo + (hi - lo) * rng();
    let runUp = lerp(def.runUp[0], def.runUp[1], d) + vary(rng, 0, 4);
    const lastCp = checkpoints[checkpoints.length - 1];
    const cp = p.x + runUp - CP_BACK >= lastCp + CP_SPACING;
    if (cp) runUp = Math.max(runUp, CP_BACK + 3);
    p.flat(runUp);
    if (cp) checkpoints.push(p.x - CP_BACK);
    const x0 = p.x;
    def.build(p, rng, d, pits);
    pieces.push({ kind, x0, x1: p.x, d });
    last = kind;
  }

  // The finish on the flat, then a run-out uphill to slow down on, and a wall.
  p.flat(30);
  const finishX = p.x - 10;
  p.flat(10)
    .curve(24, 5, kick, 12)
    .flat(8)
    .face(p.y + 8);

  const metres = finishX;
  const parTicks = Math.round((metres / PAR_SPEED[spec.difficulty]) * TICK_HZ);
  return {
    ground: new Ground(p.points),
    checkpoints,
    finishX,
    pits,
    spec: { ...spec },
    id: courseId(spec),
    pieces,
    parTicks,
    capTicks: parTicks * CAP_PARS,
  };
}

/** The next piece: by weight, not the same as the last, leaning up or down to stay in the band. */
function pick(rng: Rng, difficulty: Difficulty, y: number, last: PieceKind | null): PieceKind {
  const weights = KINDS.map((k) => {
    const def = PIECES[k];
    let w = k === last ? 0 : def.weight[difficulty];
    if (y > HIGH && def.rise > 0) w = 0;
    if (y < LOW && def.rise < 0) w = 0;
    if (y > HIGH && def.rise < 0) w *= 4;
    if (y < LOW && def.rise > 0) w *= 4;
    return w;
  });
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < KINDS.length; i++) {
    r -= weights[i];
    if (r < 0) return KINDS[i];
  }
  return KINDS[KINDS.length - 1];
}

/** A small string hash (FNV-1a), to give each length and difficulty its own courses for a seed. */
function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** How far along the course x is, from 0 at the gate to 1 at the finish. */
export function progressOf(course: Course, x: number): number {
  return Math.max(0, Math.min(1, x / course.finishX));
}
