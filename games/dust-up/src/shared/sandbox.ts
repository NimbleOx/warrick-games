/**
 * The hand-made course for milestone 1, for tuning the bike: one of each kind of obstacle, with a
 * checkpoint on the flat before each, far enough back to get up to speed again after a respawn.
 * Courses come from the generator from milestone 2.
 */

import { Ground, PathBuilder, easeOut, kick, smooth } from "./ground";
import type { Course } from "./ride";

/** The flat before each obstacle, and how far before the obstacle its checkpoint is. */
const RUN_UP = 20;
const CP_BACK = 15;

export function sandboxCourse(): Course {
  const p = new PathBuilder(-12, 8).face(0);
  const cp: number[] = [0];
  const next = () => {
    p.flat(RUN_UP);
    cp.push(p.x - CP_BACK);
  };

  // Whoops: a row of round bumps, 10 m after the gate.
  p.flat(22);
  p.bumps(6, 3, 0.45);

  // A kicker: a ramp that gets steeper, then straight down to a flat landing.
  next();
  p.curve(5, 1.4, kick, 10).face(0).flat(10);

  // A tabletop: up, a flat top, and a long ramp down to land on.
  next();
  p.curve(5, 2, smooth, 10).flat(9).curve(8, -2, smooth, 12);

  // A gap: a take-off ramp, a pit, and a landing ramp on the far side.
  next();
  p.curve(5, 1.6, kick, 10).face(-2.5).flat(7).face(1.2).curve(9, -1.2, smooth, 12);

  // A step-up: a kicker onto a higher plateau, past a short ditch.
  next();
  p.curve(4, 1.2, kick, 8).face(0.4).flat(2.5).face(2.4).flat(10);

  // A drop: off the end of the plateau, onto a downslope.
  cp.push(p.x - 6);
  p.flat(8).face(-0.6).curve(7, -2, easeOut, 10);

  // A steep hill, up and over.
  next();
  p.curve(9, 4.5, smooth, 14).flat(3).curve(10, -4.5, smooth, 14);

  // Fast whoops, then the finish.
  next();
  p.bumps(10, 2, 0.3, 8).flat(16);
  const finishX = p.x - 8;
  p.flat(20).face(8);

  return { ground: new Ground(p.points), checkpoints: cp, finishX };
}
