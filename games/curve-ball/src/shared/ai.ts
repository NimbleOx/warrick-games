import { HEADINGS, SUBSTEPS } from "./constants";
import { COS, SIN, wrapHeading } from "./headings";
import type { CpuLevel } from "./protocol";
import type { Rng } from "./rng";
import type { Round, Steer } from "./sim";

interface Style {
  /** How far ahead it looks, in px. */
  look: number;
  /** Decides every this many ticks; holds its steering in between. */
  every: number;
  /** Chance per decision of picking a different open direction, so it wanders. */
  wander: number;
}

const STYLES: Record<CpuLevel, Style> = {
  easy: { look: 80, every: 4, wander: 0.25 },
  normal: { look: 160, every: 2, wander: 0.1 },
  hard: { look: 280, every: 1, wander: 0.03 },
};

/** A path to try: steer `steer` for `ticks` ticks, then go straight. */
interface Probe {
  steer: Steer;
  ticks: number;
}

const QUARTER_TURN_TICKS = (cfgTurn: number) => Math.round(HEADINGS / 4 / (cfgTurn * SUBSTEPS));

/**
 * CPU steering. Casts a few paths ahead (straight, and turning left or right
 * by different amounts) and heads for whichever runs longest before hitting
 * something. Returns null when it isn't deciding this tick.
 */
export function cpuSteer(round: Round, slot: number, level: CpuLevel, rng: Rng): Steer | null {
  const style = STYLES[level];
  const head = round.heads[slot];
  if (!head?.alive || (round.tick + slot) % style.every !== 0) return null;

  const quarter = QUARTER_TURN_TICKS(head.turn);
  const probes: Probe[] = [{ steer: 0, ticks: 0 }];
  for (const steer of [-1, 1] as const) {
    probes.push({ steer, ticks: Math.round(quarter / 3) }, { steer, ticks: quarter }, { steer, ticks: quarter * 3 });
  }

  let best = -1;
  const scores = probes.map((p) => probe(round, slot, p, style.look));
  for (const s of scores) best = Math.max(best, s);

  // Every probe that's (nearly) as good as the best is a fine choice.
  const good = new Set<Steer>();
  probes.forEach((p, i) => {
    if (scores[i] >= best - 2) good.add(p.steer);
  });
  // Finish a turn it started, but not forever: endless turning loops it into its own trail.
  if (head.steer !== 0 && good.has(head.steer) && rng() < 0.7) return head.steer;
  // Otherwise go straight when that's safe, with the odd wiggle so it doesn't look robotic.
  if (good.has(0) && rng() >= style.wander) return 0;
  const options = [...good];
  return options[Math.floor(rng() * options.length)];
}

/**
 * How far a head could get along this path before hitting something, up to
 * `look` px. A path that ends somewhere too tight to turn around in counts
 * for half, so CPUs don't drive into dead-end pockets.
 */
function probe(round: Round, slot: number, p: Probe, look: number): number {
  const end = walk(round, slot, round.heads[slot], p, look);
  if (end.dist < look) return end.dist;
  const half = Math.round(HEADINGS / 2 / (round.heads[slot].turn * SUBSTEPS));
  const uturn = Math.PI * round.cfg.speed * half;
  const canTurn = ([-1, 1] as const).some((steer) => walk(round, slot, end, { steer, ticks: half }, uturn).dist >= uturn);
  return canTurn ? look : look / 2;
}

function walk(
  round: Round,
  slot: number,
  from: { x: number; y: number; heading: number },
  p: Probe,
  look: number,
): { x: number; y: number; heading: number; dist: number } {
  const head = round.heads[slot];
  const now = round.now;
  const step = head.speed;
  let { x, y, heading } = from;
  let dist = 0;
  for (let tick = 0; dist < look; tick++) {
    if (tick < p.ticks) heading = wrapHeading(heading + p.steer * head.turn * SUBSTEPS);
    x += COS[heading] * step;
    y += SIN[heading] * step;
    // A touch wider than the head, so it doesn't graze trails.
    if (round.blockedAt(slot, x, y, head.radius + 1, now) !== null) break;
    dist += step;
  }
  return { x, y, heading, dist: Math.min(dist, look) };
}
