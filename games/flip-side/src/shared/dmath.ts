/**
 * Sine and cosine that give the same bits in every JavaScript engine. `Math.sin` and `Math.cos`
 * aren't specified to the last bit, so the sim and the table never use them (see CLAUDE.md):
 * these are polynomials over + − × ÷ and `Math.round`, which IEEE rounds the same everywhere.
 * They're good to about 1e-15.
 */

export const PI = 3.141592653589793;
const HALF_PI = PI / 2;

/** sin x for |x| ≤ π/4: its Taylor series to x^15. */
function sinCore(x: number): number {
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))))
  );
}

/** cos x for |x| ≤ π/4: its Taylor series to x^16. */
function cosCore(x: number): number {
  const x2 = x * x;
  return (
    1 +
    x2 *
      (-1 / 2 +
        x2 *
          (1 / 24 +
            x2 *
              (-1 / 720 +
                x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 / 20922789888000)))))))
  );
}

export function dsin(a: number): number {
  const k = Math.round(a / HALF_PI);
  const r = a - k * HALF_PI;
  switch (((k % 4) + 4) % 4) {
    case 0:
      return sinCore(r);
    case 1:
      return cosCore(r);
    case 2:
      return -sinCore(r);
    default:
      return -cosCore(r);
  }
}

export function dcos(a: number): number {
  const k = Math.round(a / HALF_PI);
  const r = a - k * HALF_PI;
  switch (((k % 4) + 4) % 4) {
    case 0:
      return cosCore(r);
    case 1:
      return -sinCore(r);
    case 2:
      return -cosCore(r);
    default:
      return sinCore(r);
  }
}

/** Degrees to radians. */
export const deg = (d: number): number => (d * PI) / 180;
