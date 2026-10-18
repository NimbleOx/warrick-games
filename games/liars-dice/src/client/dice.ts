// Dice faces as inline SVG, so they stay sharp at any size and pick up colours from CSS.
const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [
    [28, 28],
    [72, 72],
  ],
  3: [
    [28, 28],
    [50, 50],
    [72, 72],
  ],
  4: [
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ],
  5: [
    [28, 28],
    [72, 28],
    [50, 50],
    [28, 72],
    [72, 72],
  ],
  6: [
    [28, 25],
    [72, 25],
    [28, 50],
    [72, 50],
    [28, 75],
    [72, 75],
  ],
};

/** One die showing `face`. */
export function dieSvg(face: number, cls = "", attrs = ""): string {
  const pips = (PIPS[face] ?? []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${face === 1 ? 12 : 9}"/>`).join("");
  return `<svg class="die f${face} ${cls}" viewBox="0 0 100 100" role="img" aria-label="${face}" ${attrs}><rect x="5" y="5" width="90" height="90" rx="20"/>${pips}</svg>`;
}

/** A die still under its cup. */
export function hiddenDie(cls = ""): string {
  return `<span class="die die-hidden ${cls}" aria-hidden="true"></span>`;
}

/** Draw a die on a canvas, centred on (x, y), `size` pixels across, turned by `angle`. */
export function drawDie(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  angle: number,
  face: number,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  const h = size / 2;
  ctx.fillStyle = "#1a1206";
  ctx.fillRect(-h + 1, -h + 2, size, size);
  ctx.fillStyle = "#f4ead8";
  ctx.fillRect(-h, -h, size, size);
  ctx.fillStyle = face === 1 ? "#d23a4e" : "#1a1206";
  const r = Math.max(1, Math.round(size / 9));
  for (const [px, py] of PIPS[face])
    ctx.fillRect(Math.round(-h + (px / 100) * size - r / 2), Math.round(-h + (py / 100) * size - r / 2), r, r);
  ctx.restore();
}
