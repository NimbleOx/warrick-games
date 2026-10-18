/**
 * Roll `n` dice, sorted. Only the server rolls, from the runtime's cryptographic random source,
 * with rejection sampling so every face is equally likely (252 is the largest multiple of 6 below 256).
 */
export function rollDice(n: number): number[] {
  const out: number[] = [];
  const bytes = new Uint8Array(Math.max(8, n * 2));
  while (out.length < n) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 252 && out.length < n) out.push((b % 6) + 1);
    }
  }
  return out.sort((a, b) => a - b);
}
