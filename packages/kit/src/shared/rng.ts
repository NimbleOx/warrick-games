// Small seeded PRNG (mulberry32). Integer-only ops, so it produces the same
// sequence in every JS engine: seeded tests, CPU games and client-side replays depend on that.
export type Rng = () => number;

// Browsers, Workers and Node all have it; this is for checking the kit without the DOM's types.
declare const crypto: { getRandomValues<T extends Uint32Array>(array: T): T };

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * A seed nobody can guess. Anyone who knows a seed knows everything mulberry32 makes from it,
 * so it comes from the platform's secure random numbers, not Math.random.
 */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * One mulberry32 step on an explicit state, for generators that have to live
 * in plain data (each head's gap timer). Returns the new state and a value in [0, 1).
 */
export function rngStep(state: number): { state: number; value: number } {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}
